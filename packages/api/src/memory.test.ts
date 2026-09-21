import { Pool } from 'pg';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { randomUUID, randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { runMigrations,withOwnerTransaction } from '@unai/postgres';
import {ConversationService} from '@unai/control';
import {commitBeliefTransaction,type BeliefTransactionRunner} from '@unai/belief';
import { postgresAdapter, SESSION_COOKIE } from '@unai/auth';
import type { BeliefOperation } from '@unai/domain';
import { createPlatformApi } from './platform.js';

/** The governed memory write surface over the real boundary: TLS, session,
 * owner scope, purpose, correlation id and idempotency key, then the governor. */

if (!process.env.UNAI_TEST_DATABASE_URL) throw new Error('Run pnpm test for the required PostgreSQL harness');
const admin = new Pool({ connectionString: process.env.UNAI_TEST_DATABASE_URL });
const url = new URL(process.env.UNAI_TEST_DATABASE_URL); url.username = 'memory_route_test_app'; url.password = 'test-only';
const appPool = new Pool({ connectionString: url.href });

let owner = '', actorId='', token = '', anchorId = '', sourceItemId = '', entityId = '', contextSpaceId = '';

beforeAll(async () => {
  await runMigrations(admin, resolve('migrations'));
  await admin.query("DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='memory_route_test_app') THEN CREATE ROLE memory_route_test_app LOGIN PASSWORD 'test-only'; END IF; END $$; GRANT unai_app TO memory_route_test_app");
  const adapter = postgresAdapter(admin);
  const user = await adapter.createUser!({ name: 'Governor', email: 'governor@example.test', emailVerified: null });
  actorId=user.id;
  token = randomBytes(32).toString('base64url');
  await adapter.createSession!({ userId: user.id, sessionToken: token, expires: new Date(Date.now() + 604800000) });
  owner = (user as unknown as { ownerScopeId: string }).ownerScopeId;
  contextSpaceId = (await admin.query("SELECT id FROM context_spaces WHERE owner_scope_id=$1 AND context_kind='BASE'", [owner])).rows[0].id;
  entityId = randomUUID();
  await admin.query("INSERT INTO entities(id,owner_scope_id,entity_kind,canonical_label) VALUES($1,$2,'PERSON','Daniel')", [entityId, owner]);
  const connectorId = randomUUID(); sourceItemId = randomUUID(); anchorId = randomUUID();
  await admin.query("INSERT INTO connectors(id,owner_scope_id,connector_type,external_account_ref,permission_manifest,status) VALUES($1,$2,'CONVERSATION',$3,'{}','ACTIVE')", [connectorId, owner, owner]);
  await admin.query(`INSERT INTO source_items(id,owner_scope_id,connector_id,source_type,external_id,actor_ref,submitted_by_user_id,
    raw_object_ref,content_hash,sensitivity,allowed_purposes,ingestion_version,idempotency_key)
    VALUES($1,$2,$3,'CONVERSATION','route-message-1',$4,$5,$6,$7,'PRIVATE',ARRAY['PERSONAL_ASSISTANCE'],'evidence-json-v1',$8)`,
    [sourceItemId, owner, connectorId, JSON.stringify({ type: 'EXTERNAL', id: entityId }), user.id, randomUUID(), 'd'.repeat(64), randomUUID()]);
  await admin.query("INSERT INTO source_anchors(id,owner_scope_id,source_item_id,anchor_kind,anchor) VALUES($1,$2,$3,'MESSAGE_SPAN','{\"start\":0,\"end\":12}')",
    [anchorId, owner, sourceItemId]);
});
afterAll(async () => { await appPool.end(); await admin.end(); });

function api() {
  const stored=new Map<string,Uint8Array>();
  const app = createPlatformApi({ authPool: admin, appPool,registryReleaseId:randomUUID(),evidenceObjects:{encryptionKeyRef:'kms:test',
    async put(_tx,id,bytes){stored.set(id,bytes);},async get(_tx,id){return stored.get(id)!;}} });
  app.addHook('onRequest', async request => { Object.defineProperty(request.raw.socket, 'encrypted', { value: true }); });
  return app;
}
function headers(idempotencyKey: string) {
  return {
    cookie: SESSION_COOKIE + '=' + token, 'x-owner-scope-id': owner, 'x-purpose': 'memory.govern',
    'x-correlation-id': randomUUID(), 'idempotency-key': idempotencyKey,
    'x-data-purpose': 'PERSONAL_ASSISTANCE', 'x-maximum-sensitivity': 'RESTRICTED',
  };
}
function operations(): BeliefOperation[] {
  return [
    { kind: 'CREATE_FRAME_INSTANCE', operationRef: '#instance', frameTypeId: 'shared.obligation', contextSpaceId },
    { kind: 'CREATE_SLOT', operationRef: '#slot', frameInstance: '#instance', predicateId: 'shared.obligation.principal_amount',
      contextSpaceId, modality: 'ACTUAL', qualifiers: {} },
    { kind: 'CREATE_PROPOSITION', operationRef: '#proposition', beliefSlot: '#slot', normalizedValue: { amount: '50.00', currency: 'ILS' } },
    { kind: 'ADD_CLAIM', operationRef: '#claim', sourceAnchorId: anchorId, proposition: '#proposition', assertedByEntityId: entityId,
      claimOrigin: 'USER_STATEMENT', lifecycle: 'PROVISIONAL' },
    { kind: 'ADD_SUPPORT', proposition: '#proposition', claim: '#claim', supportKind: 'DIRECT_ASSERTION' },
    { kind: 'SET_BELIEF_ASSESSMENT', proposition: '#proposition', assessmentStatus: 'PROVISIONAL' },
  ];
}

it('proposes, validates and commits a governed memory write, and answers a repeated commit with the same receipt', async () => {
  const app = api();
  const key = randomUUID().replaceAll('-', '');
  const body = { transactionKind: 'CANONICALIZE', registryReleaseId: randomUUID(), risk: 'LOW',
    sourceEvidenceIds: [sourceItemId], operations: operations() };
  try {
    const proposed = await app.inject({ method: 'POST', url: '/v1/memory/transactions/propose', headers: headers(key), payload: body });
    expect(proposed.statusCode).toBe(201);
    const transactionId = proposed.json().transactionId as string;
    expect(proposed.json()).toMatchObject({ status: 'PROPOSED' });

    // A caller may propose only: nothing canonical exists yet.
    expect((await admin.query('SELECT count(*)::int n FROM belief_assessments WHERE transaction_id=$1', [transactionId])).rows[0].n).toBe(0);

    const validated = await app.inject({ method: 'POST', url: '/v1/memory/transactions/' + transactionId + '/validate', headers: headers(key), payload: {} });
    expect(validated.statusCode).toBe(200);
    expect(validated.json()).toMatchObject({ transactionId, decision: 'COMMITTABLE', validationVersion: 'belief-validation-0.1.0' });

    const committed = await app.inject({ method: 'POST', url: '/v1/memory/transactions/' + transactionId + '/commit', headers: headers(key), payload: {} });
    expect(committed.statusCode).toBe(200);
    expect(committed.json()).toMatchObject({ transactionId, idempotencyKey: key });
    const again = await app.inject({ method: 'POST', url: '/v1/memory/transactions/' + transactionId + '/commit', headers: headers(key), payload: {} });
    expect(again.body).toBe(committed.body);
    expect((await admin.query('SELECT count(*)::int n FROM belief_assessments WHERE transaction_id=$1', [transactionId])).rows[0].n).toBe(1);

    // A repeated proposal under the same key finds the same transaction.
    const repeated = await app.inject({ method: 'POST', url: '/v1/memory/transactions/propose', headers: headers(key), payload: body });
    expect(repeated.statusCode).toBe(200);
    expect(repeated.json().transactionId).toBe(transactionId);

    // No response carries a session token, a digest or a private object key.
    for (const response of [proposed, validated, committed]) expect(response.body).not.toMatch(/token|token_hash|object_store_key/i);
  } finally { await app.close(); }
});

it('refuses a governed write without a purpose, without the evidence context, or with an invalid change set', async () => {
  const app = api();
  const key = randomUUID().replaceAll('-', '');
  try {
    const wrongPurpose = await app.inject({ method: 'POST', url: '/v1/memory/transactions/propose',
      headers: { ...headers(key), 'x-purpose': 'evidence.read' }, payload: { transactionKind: 'CANONICALIZE', registryReleaseId: randomUUID(), risk: 'LOW', operations: operations() } });
    expect(wrongPurpose.statusCode).toBe(403);

    const noEvidenceContext = { ...headers(key) } as Record<string, string>;
    delete noEvidenceContext['x-data-purpose'];
    const refused = await app.inject({ method: 'POST', url: '/v1/memory/transactions/propose', headers: noEvidenceContext,
      payload: { transactionKind: 'CANONICALIZE', registryReleaseId: randomUUID(), risk: 'LOW', operations: operations() } });
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({ code: 'MEMORY_CONTEXT_REQUIRED' });

    const invalid = await app.inject({ method: 'POST', url: '/v1/memory/transactions/propose', headers: headers(key),
      payload: { transactionKind: 'NOT_A_KIND', registryReleaseId: randomUUID(), risk: 'LOW', operations: [] } });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ code: 'MEMORY_TRANSACTION_INPUT_INVALID' });

    // An operation kind another node owns is named, not half-applied.
    const notDelivered = await app.inject({ method: 'POST', url: '/v1/memory/transactions/propose', headers: headers(key),
      payload: { transactionKind: 'ARCHIVE', registryReleaseId: randomUUID(), risk: 'LOW',
        operations: [{ kind: 'ARCHIVE', target: randomUUID(), targetObjectType: 'proposition' }] } });
    expect(notDelivered.statusCode).toBe(400);
    expect(notDelivered.json()).toMatchObject({ code: 'BELIEF_OPERATION_NOT_DELIVERED' });

    const missing = await app.inject({ method: 'POST', url: '/v1/memory/transactions/' + randomUUID() + '/commit', headers: headers(key), payload: {} });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ code: 'BELIEF_TRANSACTION_NOT_FOUND' });
  } finally { await app.close(); }
});

it('refuses a commit whose idempotency key is not the proposal key and records the refusal', async () => {
  const app = api();
  const key = randomUUID().replaceAll('-', ''), other = randomUUID().replaceAll('-', '');
  try {
    const proposed = await app.inject({ method: 'POST', url: '/v1/memory/transactions/propose', headers: headers(key),
      payload: { transactionKind: 'CANONICALIZE', registryReleaseId: randomUUID(), risk: 'LOW', sourceEvidenceIds: [sourceItemId], operations: operations() } });
    const transactionId = proposed.json().transactionId as string;
    const refusalHeaders = headers(other);
    const refused = await app.inject({ method: 'POST', url: '/v1/memory/transactions/' + transactionId + '/commit', headers: refusalHeaders, payload: {} });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ code: 'BELIEF_TRANSACTION_IDEMPOTENCY_KEY_MISMATCH' });
    expect((await admin.query('SELECT status FROM belief_transactions WHERE id=$1', [transactionId])).rows[0].status).toBe('PROPOSED');
    // The refusal is audited in its own transaction, after the rollback.
    expect((await admin.query('SELECT result FROM audit_events WHERE correlation_id=$1', [refusalHeaders['x-correlation-id']])).rows
      .map((row: { result: string }) => row.result)).toContain('REFUSED');
  } finally { await app.close(); }
});

it('verify-d2-inbox: owner-scoped pending transactions support rejection without belief mutation', async () => {
  const app = api(), key = randomUUID().replaceAll('-', '');
  try {
    const proposed = await app.inject({method:'POST',url:'/v1/memory/transactions/propose',headers:headers(key),payload:{transactionKind:'CANONICALIZE',registryReleaseId:randomUUID(),risk:'LOW',sourceEvidenceIds:[sourceItemId],operations:operations()}});
    const id = proposed.json().transactionId;
    const list = await app.inject({method:'GET',url:'/v1/memory/transactions',headers:headers(key)});
    expect(list.statusCode).toBe(200);
    expect(list.json().proposals).toEqual(expect.arrayContaining([expect.objectContaining({transactionId:id,status:'PROPOSED',idempotencyKey:key})]));
    const adapter=postgresAdapter(admin),stranger=await adapter.createUser!({name:'Other owner',email:'memory-stranger@example.test',emailVerified:null});
    const strangerToken=randomBytes(32).toString('base64url');
    await adapter.createSession!({userId:stranger.id,sessionToken:strangerToken,expires:new Date(Date.now()+604800000)});
    const strangerHeaders={...headers(key),cookie:SESSION_COOKIE+'='+strangerToken,'x-owner-scope-id':(stranger as unknown as {ownerScopeId:string}).ownerScopeId};
    const isolated=await app.inject({method:'GET',url:'/v1/memory/transactions',headers:strangerHeaders});
    expect(isolated.statusCode).toBe(200);expect(isolated.json().proposals).toEqual([]);
    const crossOwner=await app.inject({method:'POST',url:'/v1/memory/transactions/'+id+'/reject',headers:strangerHeaders,payload:{}});
    expect(crossOwner.statusCode).toBe(404);
    expect((await admin.query('SELECT status FROM belief_transactions WHERE id=$1',[id])).rows[0].status).toBe('PROPOSED');
    const denied = await app.inject({method:'POST',url:'/v1/memory/transactions/'+id+'/reject',headers:{...headers(key),'x-owner-scope-id':randomUUID()},payload:{}});
    expect(denied.statusCode).toBe(403);
    const rejected = await app.inject({method:'POST',url:'/v1/memory/transactions/'+id+'/reject',headers:headers(key),payload:{}});
    expect(rejected.statusCode).toBe(200);
    expect(rejected.json()).toMatchObject({transactionId:id,status:'REJECTED'});
    const again = await app.inject({method:'POST',url:'/v1/memory/transactions/'+id+'/reject',headers:headers(key),payload:{}});
    expect(again.json()).toEqual(rejected.json());
    const commit = await app.inject({method:'POST',url:'/v1/memory/transactions/'+id+'/commit',headers:headers(key),payload:{}});
    expect(commit.statusCode).toBe(409);
    expect((await admin.query('SELECT count(*)::int n FROM belief_assessments WHERE transaction_id=$1',[id])).rows[0].n).toBe(0);
    const committed = await app.inject({method:'POST',url:'/v1/memory/transactions/'+id+'/reject',headers:headers(randomUUID()),payload:{}});
    expect(committed.statusCode).toBe(409);
  } finally { await app.close(); }
});

it('verify-a7-remember verify-r04-proposal: selected owner turn is explicitly proposed with exact source provenance and confirmed before claims exist',async()=>{
  const actor=actorId;
  const context={ownerScopeId:owner,actorId:actor,purpose:'conversation.write',correlationId:randomUUID()};
  const selected=await withOwnerTransaction(appPool,context,async tx=>{
    const service=new ConversationService(tx),conversation=await service.create({title:'Remember draft'});
    const turn=await service.appendTurn(conversation.id,{speaker:'owner',text:'I prefer tea in the morning.',status:'accepted'});
    const assistant=await service.appendTurn(conversation.id,{speaker:'assistant',text:'An unsupported assistant assertion.',status:'accepted'});
    return {conversation,turn,assistant};
  });
  const count=async(table:string)=>(await admin.query('SELECT count(*)::int n FROM '+table+' WHERE owner_scope_id=$1',[owner])).rows[0].n;
  const before={claims:await count('claims'),sources:await count('source_items'),proposals:await count('belief_transactions')};
  const app=api(),key=randomUUID().replaceAll('-','');
  try{
    // Merely reading or selecting the conversation creates no evidence/proposal.
    await app.inject({method:'GET',url:'/v1/conversations/'+selected.conversation.id,headers:{...headers(key),'x-purpose':'conversation.read'}});
    expect(await count('source_items')).toBe(before.sources);expect(await count('belief_transactions')).toBe(before.proposals);
    const propose=async(turnId:string,k:string)=>app.inject({method:'POST',url:'/v1/memory/transactions/propose',headers:headers(k),payload:{selectedTurn:{conversationId:selected.conversation.id,turnId}}});
    const unsupported=await propose(selected.assistant.id,randomUUID().replaceAll('-',''));
    expect(unsupported.statusCode).toBe(400);expect(await count('source_items')).toBe(before.sources);
    const proposed=await propose(selected.turn.id,key);
    expect(proposed.statusCode).toBe(201);
    expect(await count('claims')).toBe(before.claims);
    const id=proposed.json().transactionId;
    const operation=(await admin.query('SELECT payload FROM belief_transaction_operations WHERE belief_transaction_id=$1',[id])).rows[0].payload;
    expect(operation).toMatchObject({kind:'ADD_CLAIM',claimOrigin:'USER_STATEMENT',lifecycle:'CANDIDATE'});
    expect(operation.sourceAnchorId).not.toBe(selected.turn.id);
    const source=(await admin.query(`SELECT a.normalized_text,s.actor_ref,s.deterministic_metadata,s.id FROM source_anchors a
      JOIN source_items s ON s.owner_scope_id=a.owner_scope_id AND s.id=a.source_item_id WHERE a.id=$1`,[operation.sourceAnchorId])).rows[0];
    expect(source.normalized_text).toBe(selected.turn.text);expect(source.actor_ref).toEqual({type:'USER',id:actor});
    expect(source.deterministic_metadata).toMatchObject({conversationId:selected.conversation.id,turnId:selected.turn.id});
    expect((await admin.query('SELECT 1 FROM evidence_processing WHERE source_item_id=$1',[source.id])).rowCount).toBe(0);
    const repeated=await propose(selected.turn.id,key);expect(repeated.json().transactionId).toBe(id);
    expect(await count('claims')).toBe(before.claims);
    const committed=await app.inject({method:'POST',url:'/v1/memory/transactions/'+id+'/commit',headers:headers(key),payload:{}});
    expect(committed.statusCode).toBe(200);expect(await count('claims')).toBe(before.claims+1);
    expect((await admin.query('SELECT lifecycle,proposition_id FROM claims WHERE source_anchor_id=$1',[operation.sourceAnchorId])).rows).toEqual([{lifecycle:'CANDIDATE',proposition_id:null}]);
    const rejectedKey=randomUUID().replaceAll('-',''),pending=await propose(selected.turn.id,rejectedKey);
    const rejected=await app.inject({method:'POST',url:'/v1/memory/transactions/'+pending.json().transactionId+'/reject',headers:headers(rejectedKey),payload:{}});
    expect(rejected.statusCode).toBe(200);expect(await count('claims')).toBe(before.claims+1);
  }finally{await app.close();}
});

it('verify-d2-inbox: a rejection between commit validation and material commit wins without memory mutation',async()=>{
  const app=api(),key=randomUUID().replaceAll('-','');
  try{
    const proposed=await app.inject({method:'POST',url:'/v1/memory/transactions/propose',headers:headers(key),payload:{transactionKind:'CANONICALIZE',registryReleaseId:randomUUID(),risk:'LOW',sourceEvidenceIds:[sourceItemId],operations:operations()}});
    const id=proposed.json().transactionId;
    const actor=(await admin.query('SELECT requested_by_actor_id FROM belief_transactions WHERE id=$1',[id])).rows[0].requested_by_actor_id;
    let transactions=0;
    const runner:BeliefTransactionRunner=async(purpose,run)=>{
      if(++transactions===2){
        const rejected=await app.inject({method:'POST',url:'/v1/memory/transactions/'+id+'/reject',headers:headers(key),payload:{}});
        expect(rejected.statusCode).toBe(200);
      }
      return withOwnerTransaction(appPool,{ownerScopeId:owner,actorId:actor,purpose,correlationId:randomUUID()},run);
    };
    await expect(commitBeliefTransaction(runner,{ownerScopeId:owner,actorId:actor,correlationId:randomUUID(),dataPurpose:'PERSONAL_ASSISTANCE',maximumSensitivity:'RESTRICTED'},
      {transactionId:id,idempotencyKey:key})).rejects.toThrow('BELIEF_TRANSACTION_REJECTED');
    expect((await admin.query('SELECT count(*)::int n FROM belief_assessments WHERE transaction_id=$1',[id])).rows[0].n).toBe(0);
    const validated=await app.inject({method:'POST',url:'/v1/memory/transactions/'+id+'/validate',headers:headers(key),payload:{}});
    expect(validated.statusCode).toBe(409);expect(validated.json().code).toBe('BELIEF_TRANSACTION_REJECTED');
  }finally{await app.close();}
});

it('verify-d2-inbox: rejection cannot alter a committed transaction or its beliefs', async () => {
  const app=api(),key=randomUUID().replaceAll('-','');
  try {
    const proposed=await app.inject({method:'POST',url:'/v1/memory/transactions/propose',headers:headers(key),payload:{transactionKind:'CANONICALIZE',registryReleaseId:randomUUID(),risk:'LOW',sourceEvidenceIds:[sourceItemId],operations:operations()}});
    const id=proposed.json().transactionId;
    const committed=await app.inject({method:'POST',url:'/v1/memory/transactions/'+id+'/commit',headers:headers(key),payload:{}});
    expect(committed.statusCode).toBe(200);
    const rejected=await app.inject({method:'POST',url:'/v1/memory/transactions/'+id+'/reject',headers:headers(key),payload:{}});
    expect(rejected.statusCode).toBe(409);
    expect((await admin.query('SELECT status,commit_receipt FROM belief_transactions WHERE id=$1',[id])).rows[0]).toMatchObject({status:'COMMITTED',commit_receipt:committed.json()});
  } finally {await app.close();}
});
