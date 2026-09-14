import {createHash,randomBytes} from 'node:crypto';
import {AsyncLocalStorage} from 'node:async_hooks';
import type {FastifyInstance,FastifyRequest,FastifyReply} from 'fastify';
import type {OwnerTransaction} from '@unai/postgres';
import {evidenceInputSchema,publicEvidenceSchema,dataPurposeSchema,sensitivitySchema,type EvidenceInput} from '@unai/domain';
import {createEncryptedS3Store,type StorageConfiguration} from '../../storage/src/index.js';
import {uuidV7} from '../../../src/kernel/identities.js';

export interface EvidenceObjects {
  put(tx:OwnerTransaction,id:string,bytes:Uint8Array):Promise<void>;
  get(tx:OwnerTransaction,id:string):Promise<Uint8Array>;
}
export async function createEvidenceObjects(config:StorageConfiguration){
  const transactions=new AsyncLocalStorage<OwnerTransaction>();
  const store=await createEncryptedS3Store(config,async(context,id,operation)=>{
    const tx=transactions.getStore();
    if(!tx||JSON.stringify(tx.context)!==JSON.stringify(context))return null;
    if(operation==='WRITE'&&context.purpose!=='evidence.ingest')return null;
    const row=(await tx.query('SELECT raw_object_ref,submitted_by_user_id FROM source_items WHERE raw_object_id=$1 AND owner_scope_id=$2',[id,context.ownerScopeId])).rows[0];
    if(!row||(operation==='WRITE'&&row.submitted_by_user_id!==context.actorId))return null;
    return row.raw_object_ref as string;
  });
  return {
    async put(tx:OwnerTransaction,id:string,bytes:Uint8Array){await transactions.run(tx,()=>store.put(tx.context,id,bytes));},
    async get(tx:OwnerTransaction,id:string){return transactions.run(tx,()=>store.get(tx.context,id));},
    close(){store.close();},
  };
}

function canonical(value:unknown):string{
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
  if(value!==null&&typeof value==='object')return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical((value as Record<string,unknown>)[key])).join(',')+'}';
  return JSON.stringify(value);
}
function publicRow(row:Record<string,any>){
  return publicEvidenceSchema.parse({evidenceId:row.id,ownerScopeId:row.owner_scope_id,connectorId:row.connector_id,
    sourceType:row.source_type,externalId:row.external_id,parentExternalId:row.parent_external_id,actorRef:row.actor_ref,
    occurredAt:row.occurred_at?.toISOString()??null,observedAt:row.observed_at.toISOString(),rawObjectRef:row.raw_object_id,
    contentHash:row.content_hash,sensitivity:row.sensitivity,allowedPurposes:row.allowed_purposes,
    ingestionVersion:row.ingestion_version,deterministicMetadata:row.deterministic_metadata,ingestionStatus:'STORED'});
}
const ranks={NORMAL:0,PRIVATE:1,RESTRICTED:2};
class Refusal extends Error{constructor(readonly status:number,readonly code:string){super(code);}}
type Work=(request:FastifyRequest,run:(tx:OwnerTransaction,sessionId:string)=>Promise<unknown>)=>Promise<unknown>;

export function registerEvidenceRoutes(app:FastifyInstance,work:Work,objects:EvidenceObjects|undefined){
  async function scoped(request:FastifyRequest,reply:FastifyReply,run:(tx:OwnerTransaction,purpose:string,maximum:keyof typeof ranks)=>Promise<unknown>){
    const purpose=dataPurposeSchema.safeParse(request.headers['x-data-purpose']);
    const maximum=sensitivitySchema.safeParse(request.headers['x-maximum-sensitivity']);
    if(!purpose.success||!maximum.success){
      await work(request,tx=>tx.audit({policyDecision:'DENY',codeVersion:'0.1.0',result:'REFUSED',objects:[]}));
      return reply.code(400).send({code:'EVIDENCE_CONTEXT_REQUIRED',correlationId:request.ownerContext!.correlationId});
    }
    try{return await work(request,async tx=>{
      await tx.query("SELECT set_config('unai.data_purpose',$1,true),set_config('unai.maximum_sensitivity',$2,true)",[purpose.data,maximum.data]);
      return run(tx,purpose.data,maximum.data);
    });}catch(error){
      const refusal=error instanceof Refusal?error:new Refusal(503,'EVIDENCE_UNAVAILABLE');
      // Failure audit is a separate transaction because material work was rolled back.
      await work(request,async tx=>tx.audit({policyDecision:refusal.status<500?'DENY':'ALLOW',codeVersion:'0.1.0',result:refusal.status<500?'REFUSED':'FAILURE',objects:[]}));
      return reply.code(refusal.status).send({code:refusal.code,correlationId:request.ownerContext!.correlationId});
    }
  }
  app.post('/v1/evidence',async(request,reply)=>scoped(request,reply,async(tx,purpose,maximum)=>{
    const parsed=evidenceInputSchema.safeParse(request.body);
    if(!parsed.success)throw new Refusal(400,'EVIDENCE_INPUT_INVALID');
    const input=parsed.data;
    if(input.ownerScopeId!==tx.context.ownerScopeId||(input.actorRef.type==='USER'&&input.actorRef.id!==tx.context.actorId))throw new Refusal(403,'EVIDENCE_ACTOR_REFUSED');
    if(input.idempotencyKey!==request.headers['idempotency-key'])throw new Refusal(400,'IDEMPOTENCY_KEY_MISMATCH');
    if(!input.allowedPurposes.includes(purpose)||ranks[input.sensitivity]>ranks[maximum])throw new Refusal(403,'EVIDENCE_POLICY_REFUSED');
    if(input.connectorId){
      const connector=(await tx.query("SELECT id FROM connectors WHERE id=$1 AND owner_scope_id=$2 AND status='ACTIVE'",[input.connectorId,tx.context.ownerScopeId])).rows[0];
      if(!connector)throw new Refusal(403,'CONNECTOR_REFUSED');
    }
    if(!objects)throw new Refusal(503,'STORAGE_UNAVAILABLE');
    return ingest(tx,input,objects);
  }));
  app.get<{Params:{id:string}}>('/v1/evidence/:id',async(request,reply)=>scoped(request,reply,async(tx,purpose,maximum)=>{
    if(!publicEvidenceSchema.shape.evidenceId.safeParse(request.params.id).success)throw new Refusal(400,'EVIDENCE_ID_INVALID');
    const row=(await tx.query('SELECT * FROM source_items WHERE id=$1 AND owner_scope_id=$2',[request.params.id,tx.context.ownerScopeId])).rows[0];
    if(!row||!row.allowed_purposes.includes(purpose)||ranks[row.sensitivity as keyof typeof ranks]>ranks[maximum])throw new Refusal(404,'EVIDENCE_NOT_FOUND');
    await tx.audit({policyDecision:'ALLOW',codeVersion:'0.1.0',result:'SUCCESS',objects:[{type:'source_items',id:row.id,fields:metadataFields}]});
    return publicRow(row);
  }));
  app.get<{Params:{id:string}}>('/v1/connectors/:id',async(request,reply)=>scoped(request,reply,async(tx,purpose,maximum)=>{
    if(!publicEvidenceSchema.shape.evidenceId.safeParse(request.params.id).success)throw new Refusal(400,'CONNECTOR_ID_INVALID');
    const row=(await tx.query('SELECT id,connector_type,status FROM connectors WHERE id=$1 AND owner_scope_id=$2',[request.params.id,tx.context.ownerScopeId])).rows[0];
    if(!row)throw new Refusal(404,'CONNECTOR_NOT_FOUND');
    const rows=(await tx.query("SELECT * FROM source_items WHERE connector_id=$1 AND owner_scope_id=$2 AND $3=ANY(allowed_purposes) AND array_position(ARRAY['NORMAL','PRIVATE','RESTRICTED'],sensitivity)<=$4 AND deleted_at IS NULL ORDER BY observed_at DESC,id DESC LIMIT 50",[row.id,tx.context.ownerScopeId,purpose,ranks[maximum]+1])).rows;
    await tx.audit({policyDecision:'ALLOW',codeVersion:'0.1.0',result:'SUCCESS',objects:[{type:'connectors',id:row.id,fields:['connector_type','status']},...rows.map(r=>({type:'source_items',id:r.id,fields:metadataFields}))]});
    return {connectorId:row.id,connectorType:row.connector_type,status:row.status,evidence:rows.map(publicRow)};
  }));
}
const metadataFields=['owner_scope_id','source_type','connector_id','external_id','actor_ref','occurred_at','observed_at','raw_object_id','content_hash','sensitivity','allowed_purposes','ingestion_version','parent_external_id','deterministic_metadata'];
async function ingest(tx:OwnerTransaction,input:EvidenceInput,objects:EvidenceObjects){
  const bytes=Buffer.from(canonical(input.content));
  const hash=createHash('sha256').update(bytes).digest('hex');
  const identity=[tx.context.ownerScopeId,input.connectorId,input.sourceType,input.externalId,hash];
  // Serialize retries sharing a transport key even when their content differs.
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[tx.context.ownerScopeId+':'+input.idempotencyKey]);
  const prior=(await tx.query('SELECT s.* FROM source_items s JOIN evidence_ingestion_receipts r ON r.owner_scope_id=s.owner_scope_id AND r.source_item_id=s.id WHERE r.owner_scope_id=$1 AND r.idempotency_key=$2',[tx.context.ownerScopeId,input.idempotencyKey])).rows[0];
  if(prior&&(prior.connector_id!==input.connectorId||prior.source_type!==input.sourceType||prior.external_id!==input.externalId||prior.content_hash!==hash))throw new Refusal(409,'IDEMPOTENCY_CONFLICT');
  const id=uuidV7(),objectId=uuidV7();
  const inserted=await tx.query(`INSERT INTO source_items(id,owner_scope_id,connector_id,source_type,external_id,content_hash,parent_external_id,actor_ref,submitted_by_user_id,occurred_at,raw_object_id,raw_object_ref,deterministic_metadata,sensitivity,allowed_purposes,ingestion_version,idempotency_key)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'evidence-json-v1',$16)
    ON CONFLICT DO NOTHING RETURNING *`,[id,...identity,input.parentExternalId,JSON.stringify(input.actorRef),tx.context.actorId,input.occurredAt,objectId,'raw/'+randomBytes(32).toString('hex'),JSON.stringify(input.deterministicMetadata),input.sensitivity,input.allowedPurposes,input.idempotencyKey]);
  const row=inserted.rows[0]??(await tx.query('SELECT * FROM source_items WHERE owner_scope_id=$1 AND connector_id IS NOT DISTINCT FROM $2::uuid AND source_type=$3 AND external_id=$4 AND content_hash=$5',identity)).rows[0];
  if(!row)throw new Refusal(409,'EVIDENCE_CONFLICT');
  await tx.query('INSERT INTO evidence_ingestion_receipts(owner_scope_id,idempotency_key,source_item_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[tx.context.ownerScopeId,input.idempotencyKey,row.id]);
  const receipt=(await tx.query('SELECT source_item_id FROM evidence_ingestion_receipts WHERE owner_scope_id=$1 AND idempotency_key=$2',[tx.context.ownerScopeId,input.idempotencyKey])).rows[0];
  if(receipt?.source_item_id!==row.id)throw new Refusal(409,'IDEMPOTENCY_CONFLICT');
  if(inserted.rowCount===1)await objects.put(tx,row.raw_object_id,bytes);
  await tx.audit({policyDecision:'ALLOW',codeVersion:'0.1.0',result:'SUCCESS',objects:[{type:'source_items',id:row.id,fields:metadataFields}]});
  return {evidenceId:row.id,ingestionStatus:'STORED'};
}
