import {createHash,randomBytes} from 'node:crypto';
import {AsyncLocalStorage} from 'node:async_hooks';
import type {FastifyInstance,FastifyRequest,FastifyReply} from 'fastify';
import type {OwnerTransaction} from '@unai/postgres';
import {evidenceInputSchema,publicEvidenceSchema,dataPurposeSchema,sensitivitySchema,parseSourcePayload,
  type EvidenceInput,type ParsedSourceAnchor,type ParsedSourceItem} from '@unai/domain';
import {recordTriageDecision,readTriageDecision,publicTriage} from '@unai/extraction';
import {createEncryptedS3Store,type StorageConfiguration} from '../../storage/src/index.js';
import {uuidV7} from '../../../src/kernel/identities.js';

// `answer.record` stores an assistant's own answer as conversation evidence and
// nothing else: migration 0021 admits it to ASSISTANT_CONVERSATION items only.
const OBJECT_WRITE_PURPOSES=new Set(['evidence.ingest','memory.correct','connector.sync','answer.record']);
/** The purposes that may store evidence through `importSource`: the direct
 * ingest route and a connector sync, which migration 0018 admits alongside it. */
const IMPORT_PURPOSES=new Set(['evidence.ingest','connector.sync']);

export interface EvidenceObjects {
  put(tx:OwnerTransaction,id:string,bytes:Uint8Array):Promise<void>;
  get(tx:OwnerTransaction,id:string):Promise<Uint8Array>;
  /** Recorded on the item's evidence_object_keys row so a later cryptographic
   * deletion knows which key protected these bytes. Never a key value. */
  readonly encryptionKeyRef:string;
}
export async function createEvidenceObjects(config:StorageConfiguration){
  const transactions=new AsyncLocalStorage<OwnerTransaction>();
  const store=await createEncryptedS3Store(config,async(context,id,operation)=>{
    const tx=transactions.getStore();
    if(!tx||JSON.stringify(tx.context)!==JSON.stringify(context))return null;
    // The purposes that create evidence: the ingest route, the owner's own
    // correction controls, which store what the owner said before anything
    // canonical is proposed (migration 0014, CRT-RYW-06-A), and the recording of
    // an assistant's answer as conversation evidence (migration 0021).
    if(operation==='WRITE'&&!OBJECT_WRITE_PURPOSES.has(context.purpose))return null;
    const row=(await tx.query(`SELECT k.object_store_key,s.submitted_by_user_id FROM source_items s
      JOIN evidence_object_keys k ON k.owner_scope_id=s.owner_scope_id AND k.source_item_id=s.id
      WHERE s.raw_object_ref=$1 AND s.owner_scope_id=$2`,[id,context.ownerScopeId])).rows[0];
    if(!row||(operation==='WRITE'&&row.submitted_by_user_id!==context.actorId))return null;
    return row.object_store_key as string;
  });
  return {
    encryptionKeyRef:'kms:'+config.kmsKeyId,
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
function publicRow(row:Record<string,any>,anchors?:ParsedSourceAnchor[],triage?:ReturnType<typeof publicTriage>){
  return publicEvidenceSchema.parse({evidenceId:row.id,ownerScopeId:row.owner_scope_id,connectorId:row.connector_id,
    sourceType:row.source_type,externalId:row.external_id,parentExternalId:row.parent_external_id,actorRef:row.actor_ref,
    occurredAt:row.occurred_at?.toISOString()??null,observedAt:row.observed_at.toISOString(),rawObjectRef:row.raw_object_ref,
    contentHash:row.content_hash,sensitivity:row.sensitivity,allowedPurposes:row.allowed_purposes,
    ingestionVersion:row.ingestion_version,deterministicMetadata:row.deterministic_metadata,ingestionStatus:'STORED',
    // The triage route and its reason, null when nothing has routed the item
    // yet: evidence must stay readable when later processing has not run or has
    // failed (PRD §11.1, §35.1). The list read carries metadata only.
    ...(anchors?{anchors}:{}),...(triage===undefined?{}:{triage})});
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
    // Whether this call or an earlier one wrote the row is internal: the response is
    // identical for both, so a retry cannot be told apart from the first submission.
    const {evidenceId,ingestionStatus}=await ingest(tx,input,objects);
    return {evidenceId,ingestionStatus};
  }));
  app.get<{Params:{id:string}}>('/v1/evidence/:id',async(request,reply)=>scoped(request,reply,async(tx,purpose,maximum)=>{
    if(!publicEvidenceSchema.shape.evidenceId.safeParse(request.params.id).success)throw new Refusal(400,'EVIDENCE_ID_INVALID');
    const row=(await tx.query('SELECT * FROM source_items WHERE id=$1 AND owner_scope_id=$2',[request.params.id,tx.context.ownerScopeId])).rows[0];
    if(!row||!row.allowed_purposes.includes(purpose)||ranks[row.sensitivity as keyof typeof ranks]>ranks[maximum])throw new Refusal(404,'EVIDENCE_NOT_FOUND');
    const anchors=await readAnchors(tx,row.id);
    // Left join in effect: a missing triage row yields null rather than hiding
    // the evidence, so a failed or not-yet-run extraction never makes an
    // ingested item unreadable.
    const triage=publicTriage(await readTriageDecision(tx,{ownerScopeId:tx.context.ownerScopeId,sourceItemId:row.id}));
    await tx.audit({policyDecision:'ALLOW',codeVersion:'0.1.0',result:'SUCCESS',objects:[{type:'source_items',id:row.id,fields:metadataFields}]});
    return publicRow(row,anchors,triage);
  }));
  app.get<{Params:{id:string}}>('/v1/connectors/:id',async(request,reply)=>scoped(request,reply,async(tx,purpose,maximum)=>{
    if(!publicEvidenceSchema.shape.evidenceId.safeParse(request.params.id).success)throw new Refusal(400,'CONNECTOR_ID_INVALID');
    const row=(await tx.query('SELECT id,connector_type,status FROM connectors WHERE id=$1 AND owner_scope_id=$2',[request.params.id,tx.context.ownerScopeId])).rows[0];
    if(!row)throw new Refusal(404,'CONNECTOR_NOT_FOUND');
    const rows=(await tx.query("SELECT * FROM source_items WHERE connector_id=$1 AND owner_scope_id=$2 AND $3=ANY(allowed_purposes) AND array_position(ARRAY['NORMAL','PRIVATE','RESTRICTED'],sensitivity)<=$4 AND deleted_at IS NULL ORDER BY observed_at DESC,id DESC LIMIT 50",[row.id,tx.context.ownerScopeId,purpose,ranks[maximum]+1])).rows;
    await tx.audit({policyDecision:'ALLOW',codeVersion:'0.1.0',result:'SUCCESS',objects:[{type:'connectors',id:row.id,fields:['connector_type','status']},...rows.map(r=>({type:'source_items',id:r.id,fields:metadataFields}))]});
    return {connectorId:row.id,connectorType:row.connector_type,status:row.status,evidence:rows.map(item=>publicRow(item))};
  }));
}
const metadataFields=['owner_scope_id','source_type','connector_id','external_id','actor_ref','occurred_at','observed_at','raw_object_ref','content_hash','sensitivity','allowed_purposes','ingestion_version','parent_external_id','deterministic_metadata'];
async function ingest(tx:OwnerTransaction,input:EvidenceInput,objects:EvidenceObjects){
  const bytes=Buffer.from(canonical(input.content));
  const hash=createHash('sha256').update(bytes).digest('hex');
  const identity=[tx.context.ownerScopeId,input.connectorId,input.sourceType,input.externalId,hash];
  // Serialize retries sharing a transport key even when their content differs.
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[tx.context.ownerScopeId+':'+input.idempotencyKey]);
  const prior=(await tx.query('SELECT s.* FROM source_items s JOIN evidence_ingestion_receipts r ON r.owner_scope_id=s.owner_scope_id AND r.source_item_id=s.id WHERE r.owner_scope_id=$1 AND r.idempotency_key=$2',[tx.context.ownerScopeId,input.idempotencyKey])).rows[0];
  if(prior&&(prior.connector_id!==input.connectorId||prior.source_type!==input.sourceType||prior.external_id!==input.externalId||prior.content_hash!==hash))throw new Refusal(409,'IDEMPOTENCY_CONFLICT');
  const id=uuidV7(),objectId=uuidV7();
  const inserted=await tx.query(`INSERT INTO source_items(id,owner_scope_id,connector_id,source_type,external_id,content_hash,parent_external_id,actor_ref,submitted_by_user_id,occurred_at,raw_object_ref,deterministic_metadata,sensitivity,allowed_purposes,ingestion_version,idempotency_key)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'evidence-json-v1',$15)
    ON CONFLICT DO NOTHING RETURNING *`,[id,...identity,input.parentExternalId,JSON.stringify(input.actorRef),tx.context.actorId,input.occurredAt,objectId,JSON.stringify(input.deterministicMetadata),input.sensitivity,input.allowedPurposes,input.idempotencyKey]);
  const row=inserted.rows[0]??(await tx.query('SELECT * FROM source_items WHERE owner_scope_id=$1 AND connector_id IS NOT DISTINCT FROM $2::uuid AND source_type=$3 AND external_id=$4 AND content_hash=$5',identity)).rows[0];
  if(!row)throw new Refusal(409,'EVIDENCE_CONFLICT');
  await tx.query('INSERT INTO evidence_ingestion_receipts(owner_scope_id,idempotency_key,source_item_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[tx.context.ownerScopeId,input.idempotencyKey,row.id]);
  const receipt=(await tx.query('SELECT source_item_id FROM evidence_ingestion_receipts WHERE owner_scope_id=$1 AND idempotency_key=$2',[tx.context.ownerScopeId,input.idempotencyKey])).rows[0];
  if(receipt?.source_item_id!==row.id)throw new Refusal(409,'IDEMPOTENCY_CONFLICT');
  if(inserted.rowCount===1){
    // The private location is written before the bytes: the storage resolver reads
    // it back through this same transaction to authorize the write.
    await tx.query(`INSERT INTO evidence_object_keys(id,owner_scope_id,source_item_id,object_store_key,encryption_key_ref)
      VALUES($1,$2,$3,$4,$5)`,[uuidV7(),tx.context.ownerScopeId,row.id,'raw/'+randomBytes(32).toString('hex'),objects.encryptionKeyRef]);
    await objects.put(tx,row.raw_object_ref,bytes);
  }
  // Tier-0 parsing and Tier-1 routing are deterministic and model-free, so the
  // route is recorded in this transaction and every ingested item has one
  // (ADR 0016 §2, CRT-WRT-07-A). Deep extraction is not done here: it runs on
  // the durable queue, and evidence is acknowledged before it (PRD §35.1).
  await recordTriageDecision(tx,{ownerScopeId:tx.context.ownerScopeId,sourceItemId:row.id,
    sourceType:row.source_type,externalId:row.external_id,parentExternalId:row.parent_external_id,
    actorRef:input.actorRef,occurredAt:input.occurredAt,content:input.content,
    deterministicMetadata:input.deterministicMetadata});
  await tx.audit({policyDecision:'ALLOW',codeVersion:'0.1.0',result:'SUCCESS',objects:[{type:'source_items',id:row.id,fields:metadataFields}]});
  return {evidenceId:row.id,ingestionStatus:'STORED',stored:inserted.rowCount===1};
}

export interface OwnerStatementRequest {
  /** The owner's own words. Stored verbatim as the evidence content and anchored
   * as one message span, so a claim made from it can point at the text. */
  readonly text:string;
  readonly externalId:string;
  readonly idempotencyKey:string;
  readonly sensitivity:EvidenceInput['sensitivity'];
  readonly allowedPurposes:readonly string[];
  readonly deterministicMetadata?:Record<string,unknown>;
  /** Parts of the text that are each one stated value, anchored as spans of their
   * own beside the whole text, so a claim made from one part points at exactly
   * those words (a recorded decision, ADR 0029 §3). Answered in the same order. */
  readonly spans?:ReadonlyArray<{start:number;end:number}>;
}
/** Store one owner statement as evidence and answer its anchor.
 *
 * The correction write paths create a new evidence row rather than editing an
 * existing one (CRT-RYW-06-A), and they create it through the same `ingest` the
 * HTTP route uses: the same content hash, the same idempotency receipt, the same
 * durable object and the same recorded triage route. The only difference is the
 * purpose the transaction runs under, which migration 0014 admits alongside
 * `evidence.ingest`.
 */
export async function ingestOwnerStatement(tx:OwnerTransaction,objects:EvidenceObjects,request:OwnerStatementRequest):
  Promise<{evidenceId:string;sourceAnchorId:string;stored:boolean;spanAnchorIds:string[]}>{
  // An assistant's answer is never recorded as the owner's own statement.
  if(!OBJECT_WRITE_PURPOSES.has(tx.context.purpose)||tx.context.purpose==='answer.record')throw new Refusal(403,'EVIDENCE_POLICY_REFUSED');
  const input=evidenceInputSchema.parse({
    ownerScopeId:tx.context.ownerScopeId,connectorId:null,sourceType:'CONVERSATION',externalId:request.externalId,
    // `body` is the field Tier 0 reads for a source type it has no structure
    // for, so the owner's words are routed like any other message rather than
    // landing as an empty parse.
    actorRef:{type:'USER',id:tx.context.actorId},occurredAt:null,content:{body:request.text},
    deterministicMetadata:request.deterministicMetadata??{},
    sensitivity:request.sensitivity,allowedPurposes:[...request.allowedPurposes],idempotencyKey:request.idempotencyKey,
  });
  const result=await ingest(tx,input,objects);
  const spans=request.spans??[];
  if(spans.some(span=>!Number.isInteger(span.start)||!Number.isInteger(span.end)||span.start<0||span.end<=span.start
    ||span.end>request.text.length||(span.start===0&&span.end===request.text.length)))throw new Refusal(400,'EVIDENCE_SPAN_INVALID');
  await writeAnchors(tx,result.evidenceId,[{start:0,end:request.text.length},...spans].map(span=>
    ({kind:'MESSAGE_SPAN',anchor:{start:span.start,end:span.end},normalizedText:request.text.slice(span.start,span.end)})));
  // Each anchor is found by its own span: the whole text first, then the parts.
  const anchorOf=async(span:{start:number;end:number})=>(await tx.query(
    `SELECT id FROM source_anchors WHERE owner_scope_id=$1 AND source_item_id=$2 AND anchor_kind='MESSAGE_SPAN' AND anchor=$3::jsonb`,
    [tx.context.ownerScopeId,result.evidenceId,JSON.stringify({start:span.start,end:span.end})])).rows[0]?.id as string|undefined;
  const anchor=await anchorOf({start:0,end:request.text.length});
  if(!anchor)throw new Refusal(503,'EVIDENCE_UNAVAILABLE');
  const spanAnchorIds:string[]=[];
  for(const span of spans){
    const id=await anchorOf(span);
    if(!id)throw new Refusal(503,'EVIDENCE_UNAVAILABLE');
    spanAnchorIds.push(id);
  }
  return {evidenceId:result.evidenceId,sourceAnchorId:anchor,stored:result.stored,spanAnchorIds};
}

/** The source type every assistant answer is stored under (ADR 0026 §4). */
export const ASSISTANT_CONVERSATION='ASSISTANT_CONVERSATION';
export interface AssistantMessageRequest {
  /** The words the assistant produced, stored verbatim and anchored as one span. */
  readonly text:string;
  /** The answer's own structure: its statements, labels and the packet it came from. */
  readonly structure:Record<string,unknown>;
  readonly externalId:string;
  readonly parentExternalId:string|null;
  readonly idempotencyKey:string;
  /** Which assistant produced it: the composer or the model it was supplied to. */
  readonly assistantId:string;
  readonly sensitivity:EvidenceInput['sensitivity'];
  readonly allowedPurposes:readonly string[];
}
/** Store one assistant message as conversation evidence (PRD §24.1-24.2,
 * CRT-AI-01-A; ADR 0026 §4).
 *
 * It goes through the same `ingest` as every other item, so it gets the same
 * content hash, receipt, durable object and recorded triage route -- which, for
 * an ASSISTANT actor, is SOURCE_ONLY: nothing is ever extracted from it. Only the
 * `answer.record` purpose may call this, and migration 0021 lets that purpose
 * write this one kind of item and no other. */
export async function ingestAssistantMessage(tx:OwnerTransaction,objects:EvidenceObjects,request:AssistantMessageRequest):
  Promise<{evidenceId:string;sourceAnchorId:string}>{
  if(tx.context.purpose!=='answer.record')throw new Refusal(403,'EVIDENCE_POLICY_REFUSED');
  const input=evidenceInputSchema.parse({
    ownerScopeId:tx.context.ownerScopeId,connectorId:null,sourceType:ASSISTANT_CONVERSATION,externalId:request.externalId,
    parentExternalId:request.parentExternalId,actorRef:{type:'ASSISTANT',id:request.assistantId},occurredAt:null,
    content:{body:request.text,...request.structure},deterministicMetadata:{},
    sensitivity:request.sensitivity,allowedPurposes:[...request.allowedPurposes],idempotencyKey:request.idempotencyKey,
  });
  const result=await ingest(tx,input,objects);
  await writeAnchors(tx,result.evidenceId,[{kind:'MESSAGE_SPAN',anchor:{start:0,end:request.text.length},normalizedText:request.text}]);
  const anchor=(await tx.query(
    `SELECT id FROM source_anchors WHERE owner_scope_id=$1 AND source_item_id=$2 AND anchor_kind='MESSAGE_SPAN' ORDER BY id LIMIT 1`,
    [tx.context.ownerScopeId,result.evidenceId])).rows[0];
  if(!anchor)throw new Refusal(503,'EVIDENCE_UNAVAILABLE');
  return {evidenceId:result.evidenceId,sourceAnchorId:anchor.id as string};
}

async function readAnchors(tx:OwnerTransaction,sourceItemId:string):Promise<ParsedSourceAnchor[]>{
  const rows=(await tx.query('SELECT anchor_kind,anchor,normalized_text FROM source_anchors WHERE owner_scope_id=$1 AND source_item_id=$2 ORDER BY anchor_kind,id',
    [tx.context.ownerScopeId,sourceItemId])).rows;
  return rows.map(row=>({kind:row.anchor_kind,anchor:row.anchor,normalizedText:row.normalized_text}));
}
async function writeAnchors(tx:OwnerTransaction,sourceItemId:string,anchors:readonly ParsedSourceAnchor[]){
  for(const anchor of anchors){
    // Re-importing the same bytes re-derives the same anchors; the identity index
    // makes the second write a no-op instead of a duplicate row.
    await tx.query(`INSERT INTO source_anchors(id,owner_scope_id,source_item_id,anchor_kind,anchor,normalized_text)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
      [uuidV7(),tx.context.ownerScopeId,sourceItemId,anchor.kind,JSON.stringify(anchor.anchor),anchor.normalizedText]);
  }
}

export interface SourceImportRequest {
  sourceType:string;
  connectorId:string|null;
  payload:unknown;
  sensitivity:EvidenceInput['sensitivity'];
  allowedPurposes:readonly string[];
}
export interface ImportedSourceItem {
  evidenceId:string;
  ingestionStatus:string;
  stored:boolean;
  externalId:string;
  parentExternalId:string|null;
  anchorKinds:string[];
}
/** The connector ingestion path: parse one raw payload deterministically, then
 * persist every item and anchor it determines through the same durable ingest the
 * HTTP route uses. The idempotency key is derived from the parsed identity rather
 * than supplied, so re-importing identical bytes adds no evidence row. */
export async function importSource(tx:OwnerTransaction,objects:EvidenceObjects,request:SourceImportRequest):Promise<ImportedSourceItem[]>{
  if(!IMPORT_PURPOSES.has(tx.context.purpose))throw new Refusal(403,'EVIDENCE_POLICY_REFUSED');
  if(request.connectorId){
    const connector=(await tx.query("SELECT id FROM connectors WHERE id=$1 AND owner_scope_id=$2 AND status='ACTIVE'",[request.connectorId,tx.context.ownerScopeId])).rows[0];
    if(!connector)throw new Refusal(403,'CONNECTOR_REFUSED');
  }
  const parsed:ParsedSourceItem[]=parseSourcePayload(request.sourceType,request.payload);
  const imported:ImportedSourceItem[]=[];
  for(const item of parsed){
    const hash=createHash('sha256').update(Buffer.from(canonical(item.content))).digest('hex');
    const input=evidenceInputSchema.parse({
      ownerScopeId:tx.context.ownerScopeId,connectorId:request.connectorId,
      sourceType:item.sourceType,externalId:item.externalId,parentExternalId:item.parentExternalId,
      actorRef:item.actorRef??{type:'USER',id:tx.context.actorId},
      occurredAt:item.occurredAt,content:item.content,deterministicMetadata:item.deterministicMetadata,
      sensitivity:request.sensitivity,allowedPurposes:[...request.allowedPurposes],
      idempotencyKey:importKey(tx.context.ownerScopeId,request.connectorId,item.sourceType,item.externalId,hash),
    });
    const result=await ingest(tx,input,objects);
    await writeAnchors(tx,result.evidenceId,item.anchors);
    imported.push({...result,externalId:item.externalId,parentExternalId:item.parentExternalId,
      anchorKinds:item.anchors.map(anchor=>anchor.kind)});
  }
  return imported;
}
/** A retry key the import derives rather than invents, so the same fixture always
 * resolves to the same receipt. Identity still lives in the source_items constraint. */
function importKey(ownerScopeId:string,connectorId:string|null,sourceType:string,externalId:string,contentHash:string){
  return createHash('sha256').update(canonical([ownerScopeId,connectorId,sourceType,externalId,contentHash])).digest('hex');
}
