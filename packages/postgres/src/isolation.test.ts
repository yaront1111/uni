import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { withOwnerTransaction, assertOwnershipCoverage, runMigrations, OWNER_SCOPED_TABLES } from './index.js';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';

/** Every owner-scoped table this suite queries without an application filter.
 * The final test compares it with the ownership classification, so a new owner
 * table cannot reach migration exit without its own cross-owner fixture. */
const unfiltered=new Set<string>();
function readUnfiltered(client:import('pg').PoolClient,table:string){
  unfiltered.add(table);
  return client.query('SELECT * FROM '+table);
}

if (!process.env.UNAI_TEST_DATABASE_URL) throw new Error('Run pnpm test for the required PostgreSQL harness');
describe('real PostgreSQL owner isolation', () => {
  const pool = new Pool({ connectionString: process.env.UNAI_TEST_DATABASE_URL });
  const appUrl=new URL(process.env.UNAI_TEST_DATABASE_URL!); appUrl.username='unai_test_app'; appUrl.password='unai-test-only';
  const appPool=new Pool({connectionString:appUrl.href,max:1});
  const a = randomUUID(), b = randomUUID(), alice = randomUUID(), bob = randomUUID();
  beforeAll(async () => {
    await runMigrations(pool, resolve('migrations'));
    // Roles are cluster-global, so a server a previous suite run already used still
    // carries this fixture role: create it only when it is absent.
    await pool.query("DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='unai_test_app') THEN CREATE ROLE unai_test_app LOGIN PASSWORD 'unai-test-only'; END IF; END $$; GRANT unai_app TO unai_test_app");
    await pool.query('INSERT INTO users (id, display_name) VALUES ($1,$2),($3,$4)', [alice,'Alice',bob,'Bob']);
    await pool.query('INSERT INTO owner_scopes (id, scope_kind, display_name, created_by_user_id) VALUES ($1,$2,$3,$4),($5,$2,$6,$7)', [a,'PERSONAL','A',alice,b,'B',bob]);
    await pool.query('INSERT INTO owner_scope_members (owner_scope_id,user_id,role) VALUES ($1,$2,$3),($4,$5,$3)', [a,alice,'OWNER',b,bob]);
    await pool.query('INSERT INTO devices (id,owner_scope_id,user_id,display_name) VALUES ($1,$2,$3,$4),($5,$6,$7,$8)', [randomUUID(),a,alice,'Desktop',randomUUID(),b,bob,'Phone']);
    for (const [owner,actor] of [[a,alice],[b,bob]]) {
      const connector=randomUUID(),source=randomUUID();
      const retry=randomUUID();
      await pool.query("INSERT INTO connectors(id,owner_scope_id,connector_type,external_account_ref,permission_manifest,status) VALUES($1,$2,'DOCUMENT',$3,'{}','ACTIVE')",[connector,owner,owner]);
      // One grant row per discrete manifest capability: an upload capability the
      // owner granted, and a read capability they did not (CRT-CON-07-A).
      await pool.query(`INSERT INTO connector_capability_grants(id,owner_scope_id,connector_id,capability_id,risk_class,access_kind,granted,granted_at)
        VALUES($1,$2,$3,'documents.upload','LOW','READ',true,now()),($4,$2,$3,'documents.read','LOW','READ',false,NULL)`,
        [randomUUID(),owner,connector,randomUUID()]);
      await pool.query("INSERT INTO source_items(id,owner_scope_id,connector_id,source_type,external_id,actor_ref,submitted_by_user_id,raw_object_ref,content_hash,sensitivity,allowed_purposes,ingestion_version,idempotency_key) VALUES($1,$2,$3,'DOCUMENT','fixture',$4,$5,$6,$7,'PRIVATE',ARRAY['PERSONAL_ASSISTANCE'],'evidence-json-v1',$8)",[source,owner,connector,JSON.stringify({type:'USER',id:actor}),actor,randomUUID(),'a'.repeat(64),randomUUID()]);
      await pool.query("INSERT INTO evidence_object_keys(id,owner_scope_id,source_item_id,object_store_key,encryption_key_ref) VALUES($1,$2,$3,$4,'kms:test')",[randomUUID(),owner,source,'raw/'+randomUUID()]);
      await pool.query("INSERT INTO source_anchors(id,owner_scope_id,source_item_id,anchor_kind,anchor) VALUES($1,$2,$3,'CONNECTOR_JSON_PATH','{\"path\":\"$.text\"}')",[randomUUID(),owner,source]);
      await pool.query('INSERT INTO evidence_ingestion_receipts(owner_scope_id,idempotency_key,source_item_id) VALUES($1,$2,$3)',[owner,retry,source]);
      await pool.query("INSERT INTO auth_identities(owner_scope_id,user_id,issuer,subject) VALUES($1,$2,'https://accounts.google.com',$3)",[owner,actor,actor]);
      await pool.query("INSERT INTO auth_sessions(owner_scope_id,user_id,token_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 day')",[owner,actor,actor!.replaceAll('-','').repeat(2)]);
      await pool.query("INSERT INTO audit_events (owner_scope_id,actor,purpose,objects_and_fields_accessed,policy_decision,model_or_code_version,result,correlation_id) VALUES ($1,$2,'test','[]','ALLOW','test','SUCCESS',$3)",[owner,actor,randomUUID()]);
      await pool.query("INSERT INTO jobs(id,owner_scope_id,job_kind,payload,idempotency_key) VALUES($1,$2,'evidence.extract',$3,$4)",
        [randomUUID(),owner,JSON.stringify({ownerScopeId:owner}),randomUUID().replaceAll('-','')+'fixture']);
      // Canonical identity: one row per owner in every identity table, so the
      // cross-owner sweep below covers them the same way it covers evidence.
      const anchor=(await pool.query('SELECT id FROM source_anchors WHERE owner_scope_id=$1 LIMIT 1',[owner])).rows[0].id;
      const context=(await pool.query('SELECT id FROM context_spaces WHERE owner_scope_id=$1',[owner])).rows[0].id;
      const entity=randomUUID(),merged=randomUUID(),instance=randomUUID(),slot=randomUUID(),proposition=randomUUID(),claim=randomUUID();
      await pool.query("INSERT INTO entities(id,owner_scope_id,entity_kind,canonical_label) VALUES($1,$2,'PERSON','Daniel'),($3,$2,'PERSON','Daniel')",[entity,owner,merged]);
      await pool.query("UPDATE entities SET lifecycle='MERGED',retired_at=now() WHERE id=$1",[merged]);
      await pool.query("INSERT INTO entity_aliases(id,owner_scope_id,entity_id,alias_type,alias_value,normalized_value,source_item_id) VALUES($1,$2,$3,'DISPLAY_NAME','Daniel','daniel',$4)",[randomUUID(),owner,entity,source]);
      await pool.query("INSERT INTO entity_lineage(id,owner_scope_id,from_entity_id,to_entity_id,lineage_kind) VALUES($1,$2,$3,$4,'MERGED_INTO')",[randomUUID(),owner,merged,entity]);
      await pool.query("INSERT INTO frame_instances(id,owner_scope_id,frame_type_id,context_space_id) VALUES($1,$2,'shared.obligation',$3)",[instance,owner,context]);
      await pool.query("INSERT INTO belief_slots(id,owner_scope_id,frame_instance_id,predicate_id,context_space_id,modality) VALUES($1,$2,$3,'shared.obligation.principal_amount',$4,'ACTUAL')",[slot,owner,instance,context]);
      await pool.query("INSERT INTO slot_fingerprints(id,owner_scope_id,belief_slot_id,normalization_version,fingerprint,descriptor) VALUES($1,$2,$3,'normalization-1',$4,'{}')",[randomUUID(),owner,slot,'b'.repeat(64)]);
      await pool.query(`INSERT INTO propositions(id,owner_scope_id,belief_slot_id,normalized_value) VALUES($1,$2,$3,'{"amount":"50.00","currency":"ILS"}')`,[proposition,owner,slot]);
      await pool.query("INSERT INTO proposition_fingerprints(id,owner_scope_id,proposition_id,normalization_version,fingerprint,descriptor) VALUES($1,$2,$3,'normalization-1',$4,'{}')",[randomUUID(),owner,proposition,'c'.repeat(64)]);
      await pool.query("INSERT INTO claims(id,owner_scope_id,source_anchor_id,proposition_id,claim_origin,lifecycle) VALUES($1,$2,$3,$4,'USER_STATEMENT','PROVISIONAL')",[claim,owner,anchor,proposition]);
      await pool.query("INSERT INTO frame_instance_roles(id,owner_scope_id,frame_instance_id,role_id,entity_id,claim_id) VALUES($1,$2,$3,'creditor',$4,$5)",[randomUUID(),owner,instance,entity,claim]);
      // The model path: one routed item, one run over it, one accounted call.
      const triage=randomUUID(),run=randomUUID();
      await pool.query(`INSERT INTO triage_decisions(id,owner_scope_id,source_item_id,tier0_parsed,tier1_route,routing_reason,cost_budget_microunits)
        VALUES($1,$2,$3,'{"parserVersion":"tier0-deterministic-0.1.0"}','FULL_EXTRACTION','{"code":"MEMORY_WORTHY_SIGNALS","routerVersion":"tier1-rules-0.1.0"}',20000)`,[triage,owner,source]);
      await pool.query(`INSERT INTO extraction_runs(id,owner_scope_id,source_item_id,triage_decision_id,run_kind,
        registry_release_id,normalization_version,entity_resolver_version,temporal_resolver_version,status,
        model_provider,model_id,prompt_version,cost_microunits,latency_ms,completed_at)
        VALUES($1,$2,$3,$4,'FULL',$5,'normalization-1','entity-resolver-1','temporal-resolver-1','SUCCEEDED',
        'anthropic','test-model','surface-frames-0.1.0',1200,340,now())`,[run,owner,source,triage,randomUUID()]);
      await pool.query(`INSERT INTO model_call_records(id,owner_scope_id,purpose,model_provider,model_id,prompt_version,
        extraction_run_id,cost_microunits,latency_ms,correlation_id,outcome)
        VALUES($1,$2,'memory.canonicalize','anthropic','test-model','surface-frames-0.1.0',$3,1200,340,$4,'SUCCEEDED')`,
        [randomUUID(),owner,run,randomUUID()]);
      // The write governor: one committed transaction with one operation, the
      // verdict it recorded, the support it rests on, a derivation over it and the
      // policy decision that admitted it.
      const transaction=randomUUID(),decision=randomUUID();
      await pool.query(`INSERT INTO belief_transactions(id,owner_scope_id,transaction_kind,requested_by_actor_id,
        source_evidence_ids,registry_release_id,status,risk,idempotency_key,commit_receipt,committed_at)
        VALUES($1,$2,'CANONICALIZE',$3,ARRAY[$4::uuid],$5,'COMMITTED','LOW',$6,'{}',now())`,
        [transaction,owner,actor,source,randomUUID(),randomUUID().replaceAll('-','')]);
      await pool.query(`INSERT INTO belief_transaction_operations(id,owner_scope_id,belief_transaction_id,operation_order,
        operation_kind,payload) VALUES($1,$2,$3,0,'SET_BELIEF_ASSESSMENT','{"kind":"SET_BELIEF_ASSESSMENT"}')`,
        [randomUUID(),owner,transaction]);
      await pool.query(`INSERT INTO belief_assessments(id,owner_scope_id,proposition_id,assessment_status,policy_version,transaction_id)
        VALUES($1,$2,$3,'ACCEPTED','local-policy-0.1.0',$4)`,[randomUUID(),owner,proposition,transaction]);
      await pool.query(`INSERT INTO belief_support(id,owner_scope_id,proposition_id,claim_id,support_kind,
        independence_group,created_by_transaction_id) VALUES($1,$2,$3,$4,'DIRECT_ASSERTION','entity:fixture',$5)`,
        [randomUUID(),owner,proposition,claim,transaction]);
      await pool.query(`INSERT INTO derived_proposition_dependencies(id,owner_scope_id,derived_proposition_id,input_claim_ids,
        evaluator_id,model_or_code_version,registry_release_id,calculation_inputs,created_by_transaction_id)
        VALUES($1,$2,$3,ARRAY[$4::uuid],'finance.obligation_total','obligation-total-0.1.0',$5,'{}',$6)`,
        [randomUUID(),owner,proposition,claim,randomUUID(),transaction]);
      await pool.query(`INSERT INTO policy_decisions(id,owner_scope_id,port,request,outcome,reason,policy_version,
        subject_transaction_id,correlation_id) VALUES($1,$2,'EvaluateMemoryWrite','{}','ALLOW','WRITE_WITHIN_LOCAL_POLICY',
        'local-policy-0.1.0',$3,$4)`,[randomUUID(),owner,transaction,randomUUID()]);
      // Canonicalization and bitemporal state: the instance the matcher considered
      // and declined to join, and the correcting claim that speaks about the same
      // valid interval as the first one.
      const correction=randomUUID();
      await pool.query("INSERT INTO claims(id,owner_scope_id,source_anchor_id,proposition_id,claim_origin,lifecycle) VALUES($1,$2,$3,$4,'USER_CORRECTION','PROVISIONAL')",[correction,owner,anchor,proposition]);
      await pool.query(`INSERT INTO instance_match_candidates(id,owner_scope_id,claim_id,frame_type_id,
        candidate_frame_instance_id,resolved_frame_instance_id,match_outcome,materiality,score,score_components,
        decision_reason,matcher_version) VALUES($1,$2,$3,'shared.obligation',$4,$4,'CONFIRMED_DISTINCT',
        'MATERIAL_ACCEPTED_UPDATE',0.5,'{}','{"code":"EXPLICIT_DISTINCT_REFERENCE"}','instance-matcher-0.1.0')`,
        [randomUUID(),owner,correction,instance]);
      await pool.query(`INSERT INTO claim_relations(id,owner_scope_id,from_claim_id,to_claim_id,relation_kind,
        temporal_effect,created_by_transaction_id) VALUES($1,$2,$3,$4,'CORRECTS','SAME_VALID_INTERVAL',$5)`,
        [randomUUID(),owner,correction,claim,transaction]);
      // Outcomes: the target-less settlement of PRD §44.4 and the RESOLVES link
      // that carries it. Nothing about the obligation above is touched by either.
      const resolution=randomUUID(),link=randomUUID();
      await pool.query(`INSERT INTO memory_links(id,owner_scope_id,from_object_type,from_object_id,to_object_type,
        to_object_id,link_kind,lifecycle,transition_contract_id) VALUES($1,$2,'resolution_assertion',$3,
        'frame_instance',$4,'RESOLVES','PROPOSED','shared.obligation.resolution')`,[link,owner,resolution,instance]);
      await pool.query(`INSERT INTO resolution_assertions(id,owner_scope_id,source_frame_instance_id,outcome_code,
        effective_at,asserted_by_entity_id,claim_id,transition_contract_id,lifecycle,resolution_link_id)
        VALUES($1,$2,$3,'FULFILLED',now(),$4,$5,'shared.obligation.resolution','PROPOSED',$6)`,
        [resolution,owner,instance,entity,claim,link]);
      // Owner read-your-writes: the allocated sequence, the delta every device of
      // this owner reads, and the correction control that produced it.
      const delta=randomUUID();
      await pool.query('INSERT INTO owner_sequences(owner_scope_id,last_sequence) VALUES($1,1)',[owner]);
      await pool.query(`INSERT INTO owner_overlay_deltas(id,owner_scope_id,owner_sequence,source_evidence_id,raw_text,
        delta_kind,lifecycle,target_object_type,target_object_id) VALUES($1,$2,1,$3,'Actually it was ILS 60',
        'USER_CORRECTION','USER_ASSERTED','proposition',$4)`,[delta,owner,source,proposition]);
      await pool.query(`INSERT INTO memory_operations(id,owner_scope_id,operation_kind,target_object_type,target_object_id,
        overlay_delta_id,evidence_id,transaction_id,requested_by_actor_id) VALUES($1,$2,'CORRECT','proposition',$3,$4,$5,$6,$7)`,
        [randomUUID(),owner,proposition,delta,source,transaction,actor]);
      // The typed projections over that obligation, and the receipt of the run
      // that built them. Every one of the nine PRD §33.12 columns is supplied
      // here, because every one of them is NOT NULL.
      const projectionVersion=randomUUID();
      await pool.query(`INSERT INTO open_commitments_projection(owner_scope_id,commitment_frame_instance_id,
        promisor_entity_id,action_description,due_time,outcome_state,overdue,due_soon,source_strength,conflict_flag,
        overlay_complete,last_material_update,projection_version,canonical_transaction_watermark,
        owner_overlay_watermark,reducer_version,is_complete,source_manifest,updated_at)
        VALUES($1,$2,$3,'send the report',now(),'UNRESOLVED',false,false,'OWNER_STATEMENT',false,true,now(),$4,now(),1,
        'projection-reducers-0.1.0',true,'{}',now())`,[owner,instance,entity,projectionVersion]);
      await pool.query(`INSERT INTO obligations_projection(owner_scope_id,obligation_frame_instance_id,
        debtor_entity_id,creditor_entity_id,principal_amount,currency,total_canonical_allocation,
        remaining_amount_capability_derived,outcome_state,conflict_flag,overlay_complete,projection_version,
        canonical_transaction_watermark,owner_overlay_watermark,reducer_version,is_complete,source_manifest,updated_at)
        VALUES($1,$2,$3,$3,50.00,'ILS',0,50.00,'UNRESOLVED',false,true,$4,now(),1,'projection-reducers-0.1.0',true,'{}',now())`,
        [owner,instance,entity,projectionVersion]);
      await pool.query(`INSERT INTO schedule_projection(owner_scope_id,scheduled_frame_instance_id,start_time,end_time,
        participants,projection_version,canonical_transaction_watermark,owner_overlay_watermark,reducer_version,
        is_complete,source_manifest,updated_at)
        VALUES($1,$2,now(),now()+interval '1 hour',ARRAY[$3::uuid],$4,now(),1,'projection-reducers-0.1.0',true,'{}',now())`,
        [owner,instance,entity,projectionVersion]);
      await pool.query(`INSERT INTO projection_rebuild_receipts(id,owner_scope_id,projection_name,trigger,
        transaction_id,rows_rebuilt,equals_incremental,projection_version,reducer_version)
        VALUES($1,$2,'obligations_projection','MANUAL_REPLAY',$3,1,true,$4,'projection-reducers-0.1.0')`,
        [randomUUID(),owner,transaction,projectionVersion]);
      // Memory threads: the same frame instance in two worldlines, which is the
      // storage shape CRT-RD-10-A and CRT-MEM-02-A rest on, plus the packet the
      // Context Broker recorded over them.
      const finance=randomUUID(),family=randomUUID();
      await pool.query(`INSERT INTO memory_threads(id,owner_scope_id,display_title) VALUES($1,$2,'Daniel loan'),($3,$2,'Family')`,
        [finance,owner,family]);
      await pool.query(`INSERT INTO memory_thread_members(owner_scope_id,memory_thread_id,object_type,object_id,membership_kind)
        VALUES($1,$2,'frame_instance',$4,'SUBJECT'),($1,$3,'frame_instance',$4,'RELATED')`,[owner,finance,family,instance]);
      const packet=randomUUID();
      await pool.query(`INSERT INTO context_packets(id,owner_scope_id,purpose,requesting_actor_id,
        answer_type_classification,request,packet,packet_hash,selection_reason)
        VALUES($1,$2,'PERSONAL_ASSISTANCE',$3,'CURRENT_VALUE','{}','{}',$4,'{}')`,
        [packet,owner,actor,'e'.repeat(64)]);
      // Answer provenance: the manifest of the context that packet supplied, and
      // the reconsideration candidate a later change to its belief derives.
      const manifest=randomUUID();
      await pool.query(`INSERT INTO answer_manifests(id,owner_scope_id,context_packet_id,packet_hash,conversation_message_id,
        requesting_actor_id,model_provider,model_id,prompt_version,composer_version,belief_ids,claim_ids,evidence_ids,
        overlay_delta_ids,projection_versions,watermarks,registry_release,registry_release_id,grounding_validator_result,manifest_version)
        VALUES($1,$2,$3,$4,$5,$6,'unai-deterministic','ask-composer-0.1.0','composer-templates-0.1.0','ask-composer-0.1.0',
        ARRAY[$7::uuid],ARRAY[$8::uuid],ARRAY[$5::uuid],'{}','{}','{}',NULL,NULL,'{"action":"PASSED"}','answer-manifest-0.1.0')`,
        [manifest,owner,packet,'e'.repeat(64),source,actor,proposition,claim]);
      await pool.query(`INSERT INTO reconsideration_candidates(id,owner_scope_id,changed_object_type,changed_object_id,
        answer_manifest_id,change_kind,change_ref) VALUES($1,$2,'proposition',$3,$4,'BELIEF_ASSESSMENT_CHANGED',$5)`,
        [randomUUID(),owner,proposition,manifest,randomUUID()]);
      // Merge lineage: an older instance and proposition merged into the ones
      // above. Lineage is accepted only from a MERGE or SPLIT transaction that is
      // committing in the same database transaction, so the fixture does what the
      // governor does: COMMITTING, the marker, the rows, then COMMITTED.
      const mergedInstance=randomUUID(),mergedProposition=randomUUID(),merge=randomUUID();
      const client=await pool.connect();
      try{
        await client.query('BEGIN');
        await client.query("INSERT INTO frame_instances(id,owner_scope_id,frame_type_id,context_space_id,lifecycle,retired_at) VALUES($1,$2,'shared.obligation',$3,'MERGED',now())",[mergedInstance,owner,context]);
        await client.query(`INSERT INTO propositions(id,owner_scope_id,belief_slot_id,normalized_value,lifecycle,retired_at) VALUES($1,$2,$3,'{"amount":"50.00","currency":"ILS"}','MERGED',now())`,[mergedProposition,owner,slot]);
        await client.query(`INSERT INTO belief_transactions(id,owner_scope_id,transaction_kind,requested_by_actor_id,
          registry_release_id,status,risk,idempotency_key) VALUES($1,$2,'MERGE',$3,$4,'COMMITTING','MEDIUM',$5)`,
          [merge,owner,actor,randomUUID(),randomUUID().replaceAll('-','')]);
        await client.query("SELECT set_config('unai.belief_transaction_id',$1,true)",[merge]);
        await client.query(`INSERT INTO frame_instance_lineage(id,owner_scope_id,from_frame_instance_id,to_frame_instance_id,
          lineage_kind,transaction_id) VALUES($1,$2,$3,$4,'MERGED_INTO',$5)`,[randomUUID(),owner,mergedInstance,instance,merge]);
        await client.query(`INSERT INTO proposition_lineage(id,owner_scope_id,from_proposition_id,to_proposition_id,
          lineage_kind,transaction_id) VALUES($1,$2,$3,$4,'MERGED_INTO',$5)`,[randomUUID(),owner,mergedProposition,proposition,merge]);
        await client.query("UPDATE belief_transactions SET status='COMMITTED',committed_at=now(),commit_receipt='{}' WHERE id=$1",[merge]);
        await client.query('COMMIT');
      }catch(error){await client.query('ROLLBACK');throw error;}
      finally{client.release();}
      // The semantic index: one embedding of the claim above, carrying the
      // evidence's purposes and sensitivity as its own hard-filter columns.
      await pool.query(`INSERT INTO memory_embeddings(id,owner_scope_id,object_type,object_id,proposition_id,predicate_id,
        embedding_model,embedding_version,vector,security_scope,allowed_purposes,source_item_ids,source_types,recorded_at,content_hash)
        VALUES($1,$2,'claim',$3,$4,'shared.obligation.principal_amount','unai-hashed-lexical','hashed-lexical-256-0.1.0',
        $5,'PRIVATE',ARRAY['PERSONAL_ASSISTANCE'],ARRAY[$6::uuid],ARRAY['DOCUMENT'],now(),$7)`,
        [randomUUID(),owner,claim,proposition,'['+Array.from({length:256},(_,i)=>i===0?1:0).join(',')+']',source,'f'.repeat(64)]);
    }
  });
  afterAll(async()=>{await appPool.end();await pool.end();});

  async function asOwner(owner: string, actor: string, run: (client: import('pg').PoolClient)=>Promise<void>, purpose='evidence.read') {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE unai_app');
      await client.query("SELECT set_config('unai.owner_scope_id',$1,true), set_config('unai.actor_id',$2,true)",[owner,actor]);
      await client.query("SELECT set_config('unai.purpose',$1,true),set_config('unai.data_purpose','PERSONAL_ASSISTANCE',true),set_config('unai.maximum_sensitivity','RESTRICTED',true)",[purpose]);
      await run(client);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  }

  it('hides B from unfiltered owner A queries on every owner table', async()=>{
    await asOwner(a,alice,async c=>{
      for (const table of ['owner_scopes','owner_scope_members','devices','audit_events','connectors','source_items','source_anchors','evidence_object_keys','evidence_ingestion_receipts','context_spaces']) {
        const key=table==='owner_scopes'?'id':'owner_scope_id';
        const rows=(await readUnfiltered(c,table)).rows;
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.every(row=>row[key]===a)).toBe(true);
      }
      unfiltered.add('users');
      expect((await c.query('SELECT id FROM users')).rows).toEqual([{id:alice}]);
      for(const table of ['auth_sessions','auth_identities']){
        unfiltered.add(table);
        const rows=(await c.query('SELECT owner_scope_id,user_id FROM '+table)).rows;
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.every(row=>row.owner_scope_id===a&&row.user_id===alice)).toBe(true);
      }
    });
  });
  it('CRT-SEC-01-A: hides B from unfiltered owner A queue queries and refuses queue rows under another purpose',async()=>{
    await asOwner(a,alice,async c=>{
      const rows=(await readUnfiltered(c,'jobs')).rows;
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every(row=>row.owner_scope_id===a)).toBe(true);
    },'ops.jobs.read');
    await asOwner(a,alice,async c=>{
      expect((await c.query('SELECT * FROM jobs')).rows).toEqual([]);
    });
    await asOwner(b,alice,async c=>{
      expect((await c.query('SELECT * FROM jobs')).rows).toEqual([]);
    },'ops.jobs.read');
    for(const sql of ['DELETE FROM jobs','TRUNCATE jobs']){
      await expect(asOwner(a,alice,c=>c.query(sql).then(()=>{}),'ops.jobs.read')).rejects.toMatchObject({code:'42501'});
    }
  });
  it('CRT-SEC-01-A: hides B from unfiltered owner A canonical identity queries and refuses them under another purpose',async()=>{
    const memoryTables=['entities','entity_aliases','entity_lineage','frame_instances','frame_instance_roles',
      'belief_slots','slot_fingerprints','propositions','proposition_fingerprints','claims'];
    await asOwner(a,alice,async c=>{
      for(const table of memoryTables){
        const rows=(await readUnfiltered(c,table)).rows;
        expect(rows.length,table).toBeGreaterThan(0);
        expect(rows.every(row=>row.owner_scope_id===a),table).toBe(true);
      }
    },'memory.inspect');
    // Canonical identity is purpose-bound like evidence: an owner session holding
    // an unrelated product purpose sees none of it.
    await asOwner(a,alice,async c=>{
      for(const table of memoryTables) expect((await c.query('SELECT * FROM '+table)).rows,table).toEqual([]);
    });
    await asOwner(b,alice,async c=>{
      for(const table of memoryTables) expect((await c.query('SELECT * FROM '+table)).rows,table).toEqual([]);
    },'memory.inspect');
    // Reading never authorizes writing, and no identity row may be removed.
    for(const table of memoryTables){
      await expect(asOwner(a,alice,c=>c.query('DELETE FROM '+table).then(()=>{}),'memory.canonicalize'),table).rejects.toMatchObject({code:'42501'});
    }
    // A claim is one source assertion. Migration 0012 delivered the handoff
    // 0010 recorded: a claim moves through its lifecycle only under the governing
    // purpose, so canonicalization still changes no claim, and what the claim
    // actually said stays immutable for every principal.
    await asOwner(a,alice,async c=>{
      expect((await c.query("UPDATE claims SET lifecycle='ACCEPTED'")).rowCount).toBe(0);
    },'memory.canonicalize');
    expect((await pool.query("SELECT DISTINCT lifecycle FROM claims WHERE owner_scope_id=$1",[a])).rows).toEqual([{lifecycle:'PROVISIONAL'}]);
    await expect(asOwner(a,alice,c=>c.query("UPDATE claims SET claim_origin='USER_CONFIRMATION'").then(()=>{}),'memory.govern'))
      .rejects.toMatchObject({code:'42501'});
    await expect(pool.query("UPDATE claims SET source_anchor_id=id WHERE owner_scope_id=$1",[a])).rejects.toThrow('CLAIM_ASSERTION_IMMUTABLE');
    // A proposition may be retired under a governed transaction; its value never moves.
    await expect(pool.query(`UPDATE propositions SET normalized_value='{"amount":"99.00"}' WHERE owner_scope_id=$1`,[a]))
      .rejects.toThrow('PROPOSITION_VALUE_IMMUTABLE');
    // A fingerprint may only be closed; its index columns are immutable even for
    // the privileged principal, so recomputation can never rewrite what an
    // earlier fingerprint said (CRT-MEM-04-A).
    await expect(asOwner(a,alice,c=>c.query("UPDATE slot_fingerprints SET fingerprint=$1",['d'.repeat(64)]).then(()=>{}),'memory.canonicalize'))
      .rejects.toMatchObject({code:'42501'});
    await expect(pool.query("UPDATE slot_fingerprints SET normalization_version='normalization-2' WHERE owner_scope_id=$1",[a]))
      .rejects.toThrow('FINGERPRINT_IMMUTABLE');
    await expect(pool.query('UPDATE entities SET id=gen_random_uuid() WHERE owner_scope_id=$1',[a]))
      .rejects.toThrow('CANONICAL_IDENTITY_IMMUTABLE');
  });
  it('CRT-SEC-01-A: hides B from unfiltered owner A triage, extraction and model-call queries',async()=>{
    const modelPathTables=['triage_decisions','extraction_runs','model_call_records'];
    await asOwner(a,alice,async c=>{
      for(const table of modelPathTables){
        const rows=(await readUnfiltered(c,table)).rows;
        expect(rows.length,table).toBeGreaterThan(0);
        expect(rows.every(row=>row.owner_scope_id===a),table).toBe(true);
      }
    },'memory.extract');
    await asOwner(b,alice,async c=>{
      for(const table of modelPathTables) expect((await c.query('SELECT * FROM '+table)).rows,table).toEqual([]);
    },'memory.extract');
    // Purpose-bound like the rest: an unrelated product purpose reads none of it,
    // and the evidence read sees the route without seeing runs or model calls.
    await asOwner(a,alice,async c=>{
      for(const table of ['extraction_runs','model_call_records']) expect((await c.query('SELECT * FROM '+table)).rows,table).toEqual([]);
      expect((await c.query('SELECT owner_scope_id FROM triage_decisions')).rows.length).toBeGreaterThan(0);
    },'evidence.read');
    for(const table of modelPathTables){
      await expect(asOwner(a,alice,c=>c.query('DELETE FROM '+table).then(()=>{}),'memory.canonicalize'),table).rejects.toMatchObject({code:'42501'});
    }
    // A decision and a call record are statements about a moment: neither takes
    // an update grant, and a closed run may not be reopened or re-versioned.
    await expect(asOwner(a,alice,c=>c.query("UPDATE triage_decisions SET tier1_route='SOURCE_ONLY'").then(()=>{}),'memory.canonicalize'))
      .rejects.toMatchObject({code:'42501'});
    await expect(asOwner(a,alice,c=>c.query('UPDATE model_call_records SET cost_microunits=0').then(()=>{}),'memory.canonicalize'))
      .rejects.toMatchObject({code:'42501'});
    await expect(pool.query("UPDATE extraction_runs SET normalization_version='normalization-2' WHERE owner_scope_id=$1",[a]))
      .rejects.toThrow('EXTRACTION_RUN_IMMUTABLE');
    await expect(pool.query("UPDATE extraction_runs SET status='FAILED',error_code='X' WHERE owner_scope_id=$1",[a]))
      .rejects.toThrow('EXTRACTION_RUN_ALREADY_CLOSED');
  });
  it('CRT-SEC-01-A: hides B from unfiltered owner A governor queries and refuses them under another purpose',async()=>{
    const governorTables=['belief_transactions','belief_transaction_operations','belief_assessments','belief_support',
      'derived_proposition_dependencies','policy_decisions'];
    await asOwner(a,alice,async c=>{
      for(const table of governorTables){
        const rows=(await readUnfiltered(c,table)).rows;
        expect(rows.length,table).toBeGreaterThan(0);
        expect(rows.every(row=>row.owner_scope_id===a),table).toBe(true);
      }
    },'memory.govern');
    await asOwner(b,alice,async c=>{
      for(const table of governorTables) expect((await c.query('SELECT * FROM '+table)).rows,table).toEqual([]);
    },'memory.govern');
    // Purpose-bound like the rest: an unrelated product purpose reads none of it.
    await asOwner(a,alice,async c=>{
      for(const table of governorTables) expect((await c.query('SELECT * FROM '+table)).rows,table).toEqual([]);
    });
    // No governor table takes a DELETE grant, and the three record tables take no
    // update at all: a verdict, its support and a policy decision are statements
    // about a moment.
    for(const table of governorTables){
      await expect(asOwner(a,alice,c=>c.query('DELETE FROM '+table).then(()=>{}),'memory.govern'),table).rejects.toMatchObject({code:'42501'});
    }
    for(const sql of ["UPDATE belief_support SET support_kind='CORROBORATION'",
      "UPDATE derived_proposition_dependencies SET evaluator_id='x.y'","UPDATE policy_decisions SET outcome='DENY'",
      "UPDATE belief_assessments SET assessment_status='REJECTED'"]){
      await expect(asOwner(a,alice,c=>c.query(sql).then(()=>{}),'memory.govern'),sql).rejects.toMatchObject({code:'42501'});
    }
    // Even for the privileged principal, an assessment is append-only, a settled
    // transaction never reopens and its receipt never changes.
    await expect(pool.query("UPDATE belief_assessments SET assessment_status='REJECTED' WHERE owner_scope_id=$1",[a]))
      .rejects.toThrow('BELIEF_ASSESSMENT_APPEND_ONLY');
    await expect(pool.query("UPDATE belief_transactions SET status='PROPOSED' WHERE owner_scope_id=$1",[a]))
      .rejects.toThrow('BELIEF_TRANSACTION_ALREADY_SETTLED');
    await expect(pool.query(`UPDATE belief_transactions SET commit_receipt='{"forged":true}' WHERE owner_scope_id=$1`,[a]))
      .rejects.toThrow('BELIEF_TRANSACTION_RECEIPT_IMMUTABLE');
    await expect(pool.query("UPDATE belief_support SET independence_group='forged' WHERE owner_scope_id=$1",[a]))
      .rejects.toThrow('BELIEF_RECORD_IMMUTABLE');
    // CRT-REG-06-B: a context move outside a governed transaction is refused
    // whatever principal attempts it.
    await expect(pool.query(`UPDATE belief_slots SET context_space_id=gen_random_uuid() WHERE owner_scope_id=$1`,[a]))
      .rejects.toThrow('CONTEXT_MOVE_REQUIRES_TRANSACTION');
    // The registry snapshot stays unreadable; the reviewed reader answers one boolean.
    await asOwner(a,alice,async c=>{
      expect((await c.query('SELECT unai_private.registry_contract_present(gen_random_uuid(),$1,$2) AS present',
        ['shared.obligation','FRAME'])).rows[0].present).toBe(false);
    },'memory.govern');
  });
  it('CRT-SEC-01-A: hides B from unfiltered owner A canonicalization queries and keeps both records immutable',async()=>{
    const canonicalizationTables=['instance_match_candidates','claim_relations'];
    await asOwner(a,alice,async c=>{
      for(const table of canonicalizationTables){
        const rows=(await readUnfiltered(c,table)).rows;
        expect(rows.length,table).toBeGreaterThan(0);
        expect(rows.every(row=>row.owner_scope_id===a),table).toBe(true);
      }
    },'memory.canonicalize');
    await asOwner(b,alice,async c=>{
      for(const table of canonicalizationTables) expect((await c.query('SELECT * FROM '+table)).rows,table).toEqual([]);
    },'memory.canonicalize');
    await asOwner(a,alice,async c=>{
      for(const table of canonicalizationTables) expect((await c.query('SELECT * FROM '+table)).rows,table).toEqual([]);
    });
    for(const table of canonicalizationTables){
      await expect(asOwner(a,alice,c=>c.query('DELETE FROM '+table).then(()=>{}),'memory.canonicalize'),table).rejects.toMatchObject({code:'42501'});
      await expect(asOwner(a,alice,c=>c.query('UPDATE '+table+' SET owner_scope_id=owner_scope_id').then(()=>{}),'memory.canonicalize'),table)
        .rejects.toMatchObject({code:'42501'});
      await expect(pool.query('UPDATE '+table+' SET owner_scope_id=owner_scope_id WHERE owner_scope_id=$1',[a]),table)
        .rejects.toThrow('CANONICALIZATION_RECORD_IMMUTABLE');
    }
    // CRT-MEM-11-C in the schema: no principal may record a reuse of an existing
    // instance for a material accepted update behind anything but CONFIRMED_MATCH.
    const instance=(await pool.query('SELECT id,frame_type_id FROM frame_instances WHERE owner_scope_id=$1 LIMIT 1',[a])).rows[0];
    for(const outcome of ['PROBABLE_MATCH','POSSIBLE_MATCH']){
      await expect(pool.query(`INSERT INTO instance_match_candidates(id,owner_scope_id,frame_type_id,
        candidate_frame_instance_id,resolved_frame_instance_id,match_outcome,materiality,reused_existing_instance,
        matcher_version) VALUES($1,$2,$3,$4,$4,$5,'MATERIAL_ACCEPTED_UPDATE',true,'instance-matcher-0.1.0')`,
        [randomUUID(),a,instance.frame_type_id,instance.id,outcome]),outcome).rejects.toMatchObject({code:'23514'});
    }
    // CRT-MEM-09-A in the schema: a correction cannot claim a new valid period and
    // a change cannot claim the interval the earlier claim already covered.
    const claims=(await pool.query('SELECT id FROM claims WHERE owner_scope_id=$1 ORDER BY id LIMIT 2',[a])).rows;
    for(const [kind,effect] of [['CORRECTS','NEW_VALID_PERIOD'],['SUPERSEDES','SAME_VALID_INTERVAL']]){
      await expect(pool.query(`INSERT INTO claim_relations(id,owner_scope_id,from_claim_id,to_claim_id,relation_kind,
        temporal_effect,valid_from) VALUES($1,$2,$3,$4,$5,$6,now())`,
        [randomUUID(),a,claims[0].id,claims[1].id,kind,effect]),kind).rejects.toMatchObject({code:'23514'});
    }
  });
  it('CRT-SEC-01-A: hides B from unfiltered owner A outcome queries and keeps every recorded outcome immutable',async()=>{
    const outcomeTables=['memory_links','resolution_assertions'];
    await asOwner(a,alice,async c=>{
      for(const table of outcomeTables){
        const rows=(await readUnfiltered(c,table)).rows;
        expect(rows.length,table).toBeGreaterThan(0);
        expect(rows.every(row=>row.owner_scope_id===a),table).toBe(true);
      }
    },'memory.inspect');
    await asOwner(b,alice,async c=>{
      for(const table of outcomeTables) expect((await c.query('SELECT * FROM '+table)).rows,table).toEqual([]);
    },'memory.inspect');
    await asOwner(a,alice,async c=>{
      for(const table of outcomeTables) expect((await c.query('SELECT * FROM '+table)).rows,table).toEqual([]);
    });
    for(const table of outcomeTables){
      await expect(asOwner(a,alice,c=>c.query('DELETE FROM '+table).then(()=>{}),'memory.govern'),table).rejects.toMatchObject({code:'42501'});
    }
    // Canonicalizing a sentence may propose an outcome; accepting one is a
    // governed decision or the owner's own correction (PRD §19.1, FR-040).
    await asOwner(a,alice,async c=>{
      expect((await c.query("UPDATE resolution_assertions SET lifecycle='ACCEPTED'")).rowCount).toBe(0);
    },'memory.canonicalize');
    expect((await pool.query('SELECT DISTINCT lifecycle FROM resolution_assertions WHERE owner_scope_id=$1',[a])).rows)
      .toEqual([{lifecycle:'PROPOSED'}]);
    // CRT-OUT-03-A and CRT-OUT-05-A in the schema: what a resolution said, which
    // frame it resolved and which claim asserted it never move, for any principal.
    await expect(pool.query("UPDATE resolution_assertions SET outcome_code='CANCELLED' WHERE owner_scope_id=$1",[a]))
      .rejects.toThrow('RESOLUTION_ASSERTION_IMMUTABLE');
    await expect(pool.query("UPDATE resolution_assertions SET transition_contract_id='shared.commitment.resolution' WHERE owner_scope_id=$1",[a]))
      .rejects.toThrow('RESOLUTION_ASSERTION_IMMUTABLE');
    await expect(pool.query("UPDATE memory_links SET link_kind='REALIZES' WHERE owner_scope_id=$1",[a]))
      .rejects.toThrow('MEMORY_LINK_IMMUTABLE');
    // CRT-OUT-04-A in the schema: a REALIZES or RESOLVES link with no transition
    // contract, and an outcome code outside PRD §16.5, are both unrepresentable.
    const instance=(await pool.query('SELECT id FROM frame_instances WHERE owner_scope_id=$1 LIMIT 1',[a])).rows[0].id;
    const claim=(await pool.query('SELECT id FROM claims WHERE owner_scope_id=$1 ORDER BY id LIMIT 1',[a])).rows[0].id;
    const entity=(await pool.query("SELECT id FROM entities WHERE owner_scope_id=$1 AND lifecycle='ACTIVE' LIMIT 1",[a])).rows[0].id;
    await expect(pool.query(`INSERT INTO memory_links(id,owner_scope_id,from_object_type,from_object_id,to_object_type,
      to_object_id,link_kind) VALUES($1,$2,'claim',$3,'frame_instance',$4,'RESOLVES')`,[randomUUID(),a,claim,instance]))
      .rejects.toMatchObject({code:'23514'});
    await expect(pool.query(`INSERT INTO resolution_assertions(id,owner_scope_id,source_frame_instance_id,outcome_code,
      effective_at,asserted_by_entity_id,claim_id,transition_contract_id) VALUES($1,$2,$3,'SORTED_OUT',now(),$4,$5,
      'shared.obligation.resolution')`,[randomUUID(),a,instance,entity,claim])).rejects.toMatchObject({code:'23514'});
    await expect(pool.query(`INSERT INTO resolution_assertions(id,owner_scope_id,source_frame_instance_id,outcome_code,
      effective_at,asserted_by_entity_id,claim_id) VALUES($1,$2,$3,'FULFILLED',now(),$4,$5)`,
      [randomUUID(),a,instance,entity,claim])).rejects.toMatchObject({code:'23502'});
  });
  it('CRT-SEC-01-A: hides B from unfiltered owner A overlay queries and keeps the owner sequence unique',async()=>{
    const overlayTables=['owner_sequences','owner_overlay_deltas','memory_operations'];
    await asOwner(a,alice,async c=>{
      for(const table of overlayTables){
        const rows=(await readUnfiltered(c,table)).rows;
        expect(rows.length,table).toBeGreaterThan(0);
        expect(rows.every(row=>row.owner_scope_id===a),table).toBe(true);
      }
    },'memory.correct');
    await asOwner(b,alice,async c=>{
      for(const table of overlayTables) expect((await c.query('SELECT * FROM '+table)).rows,table).toEqual([]);
    },'memory.correct');
    await asOwner(a,alice,async c=>{
      for(const table of overlayTables) expect((await c.query('SELECT * FROM '+table)).rows,table).toEqual([]);
    });
    for(const table of overlayTables){
      await expect(asOwner(a,alice,c=>c.query('DELETE FROM '+table).then(()=>{}),'memory.correct'),table).rejects.toMatchObject({code:'42501'});
    }
    // CRT-RYW-01-A in the schema: the owner and its sequence are unique together,
    // so a caller that invents a number instead of allocating one is rejected.
    await expect(pool.query(`INSERT INTO owner_overlay_deltas(id,owner_scope_id,owner_sequence,source_evidence_id,
      raw_text,delta_kind) SELECT $1,owner_scope_id,owner_sequence,source_evidence_id,raw_text,delta_kind
      FROM owner_overlay_deltas WHERE owner_scope_id=$2`,[randomUUID(),a])).rejects.toMatchObject({code:'23505'});
    // An operation record is a statement about a moment, for every principal.
    await expect(pool.query("UPDATE memory_operations SET operation_kind='DELETE' WHERE owner_scope_id=$1",[a]))
      .rejects.toThrow('CANONICALIZATION_RECORD_IMMUTABLE');
    // CRT-MEM-15-A in the schema: a re-extraction may contest a delta and no
    // more. Only the owner's own correction purpose settles one, and the trigger
    // binds the privileged principal too.
    await expect(pool.query("UPDATE owner_overlay_deltas SET raw_text='rewritten' WHERE owner_scope_id=$1",[a]))
      .rejects.toThrow('OVERLAY_DELTA_IMMUTABLE');
    await expect(pool.query("UPDATE owner_overlay_deltas SET lifecycle='SUPERSEDED' WHERE owner_scope_id=$1",[a]))
      .rejects.toThrow('OVERLAY_DELTA_NEEDS_USER_ACTION');
    await expect(asOwner(a,alice,c=>c.query(`UPDATE owner_overlay_deltas SET lifecycle='REJECTED_AS_INTERPRETATION'`).then(()=>{}),'memory.govern'))
      .rejects.toThrow('OVERLAY_DELTA_NEEDS_USER_ACTION');
    await asOwner(a,alice,async c=>{
      await c.query(`UPDATE owner_overlay_deltas SET lifecycle='CONTESTED',contested_reason='{"failureReason":"RE_EXTRACTION_CONFLICT"}'`);
      expect((await c.query('SELECT lifecycle FROM owner_overlay_deltas')).rows).toEqual([{lifecycle:'CONTESTED'}]);
    },'memory.govern');
  });
  it('CRT-SEC-01-A and CRT-PRJ-03-A: hides B from unfiltered owner A projection queries and keeps every projection row complete',async()=>{
    const projectionTables=['open_commitments_projection','obligations_projection','schedule_projection','projection_rebuild_receipts'];
    await asOwner(a,alice,async c=>{
      for(const table of projectionTables){
        const rows=(await readUnfiltered(c,table)).rows;
        expect(rows.length,table).toBeGreaterThan(0);
        expect(rows.every(row=>row.owner_scope_id===a),table).toBe(true);
      }
    },'projection.read');
    await asOwner(b,alice,async c=>{
      for(const table of projectionTables) expect((await c.query('SELECT * FROM '+table)).rows,table).toEqual([]);
    },'projection.read');
    // A purpose outside the projection read set sees nothing, the same way every
    // other memory table fails closed.
    await asOwner(a,alice,async c=>{
      for(const table of projectionTables) expect((await c.query('SELECT * FROM '+table)).rows,table).toEqual([]);
    });
    // A projection row is a derived cache and may be rebuilt; a rebuild receipt
    // is a statement about a run that happened and may not be restated or
    // removed, exactly as an audit event may not.
    await expect(asOwner(a,alice,c=>c.query('DELETE FROM projection_rebuild_receipts').then(()=>{}),'memory.project'))
      .rejects.toMatchObject({code:'42501'});
    await expect(asOwner(a,alice,c=>c.query('UPDATE projection_rebuild_receipts SET rows_rebuilt=99').then(()=>{}),'memory.project'))
      .rejects.toMatchObject({code:'42501'});
    // Re-pointing a projection row at another situation would make its manifest a
    // lie; the trigger binds the privileged principal too.
    await expect(pool.query('UPDATE obligations_projection SET obligation_frame_instance_id=$1 WHERE owner_scope_id=$2',
      [randomUUID(),a])).rejects.toThrow('PROJECTION_IDENTITY_IMMUTABLE');
    // CRT-PRJ-03-A in the schema: each of the nine required columns is NOT NULL,
    // so a row that omitted one could not be stored at all.
    for(const [table,column] of [
      ['open_commitments_projection','projection_version'],['open_commitments_projection','source_manifest'],
      ['obligations_projection','canonical_transaction_watermark'],['obligations_projection','owner_overlay_watermark'],
      ['obligations_projection','is_complete'],['schedule_projection','reducer_version'],
      ['schedule_projection','updated_at'],['schedule_projection','source_manifest'],
    ] as const){
      await expect(pool.query('UPDATE '+table+' SET '+column+'=NULL WHERE owner_scope_id=$1',[a]),table+'.'+column)
        .rejects.toMatchObject({code:'23502'});
    }
    // CRT-PRJ-01-A in the catalog: amount, currency, due time and start/end are
    // typed columns and not JSONB.
    const typed=(await pool.query(`SELECT table_name,column_name,data_type FROM information_schema.columns
      WHERE table_schema='public' AND (table_name,column_name) IN (
        ('obligations_projection','principal_amount'),('obligations_projection','currency'),
        ('obligations_projection','due_time'),('obligations_projection','total_canonical_allocation'),
        ('obligations_projection','remaining_amount_capability_derived'),
        ('open_commitments_projection','due_time'),('schedule_projection','start_time'),('schedule_projection','end_time'))
      ORDER BY table_name,column_name`)).rows;
    expect(Object.fromEntries(typed.map((row:{table_name:string;column_name:string;data_type:string})=>
      [row.table_name+'.'+row.column_name,row.data_type]))).toEqual({
      'obligations_projection.currency':'text',
      'obligations_projection.due_time':'timestamp with time zone',
      'obligations_projection.principal_amount':'numeric',
      'obligations_projection.remaining_amount_capability_derived':'numeric',
      'obligations_projection.total_canonical_allocation':'numeric',
      'open_commitments_projection.due_time':'timestamp with time zone',
      'schedule_projection.end_time':'timestamp with time zone',
      'schedule_projection.start_time':'timestamp with time zone',
    });
  });
  it('CRT-SEC-01-A and CRT-MEM-10-A: hides B from unfiltered owner A lineage queries and keeps lineage governed and append-only',async()=>{
    const lineageTables=['frame_instance_lineage','proposition_lineage'];
    await asOwner(a,alice,async c=>{
      for(const table of lineageTables){
        const rows=(await readUnfiltered(c,table)).rows;
        expect(rows.length,table).toBeGreaterThan(0);
        expect(rows.every(row=>row.owner_scope_id===a),table).toBe(true);
      }
    },'memory.inspect');
    await asOwner(b,alice,async c=>{
      for(const table of lineageTables) expect((await c.query('SELECT * FROM '+table)).rows,table).toEqual([]);
    },'memory.inspect');
    // Purpose-bound: an unrelated product purpose reads no lineage.
    await asOwner(a,alice,async c=>{
      for(const table of lineageTables) expect((await c.query('SELECT * FROM '+table)).rows,table).toEqual([]);
    });
    // Lineage is history: no grant removes or edits it, and the privileged
    // principal is refused by the trigger.
    for(const table of lineageTables){
      await expect(asOwner(a,alice,c=>c.query('DELETE FROM '+table).then(()=>{}),'memory.govern'),table).rejects.toMatchObject({code:'42501'});
      await expect(asOwner(a,alice,c=>c.query("UPDATE "+table+" SET lineage_kind='MERGED_INTO'").then(()=>{}),'memory.govern'),table)
        .rejects.toMatchObject({code:'42501'});
      await expect(pool.query("UPDATE "+table+" SET reason='{\"forged\":true}' WHERE owner_scope_id=$1",[a]),table)
        .rejects.toThrow('LINEAGE_IMMUTABLE');
    }
    await expect(pool.query("UPDATE entity_lineage SET lineage_kind='ALIAS_OF' WHERE owner_scope_id=$1",[a])).rejects.toThrow('LINEAGE_IMMUTABLE');
    // Merge and split are belief transactions, not database shortcuts (PRD §14):
    // a lineage row outside a committing MERGE or SPLIT is refused for every principal.
    const [from,to]=(await pool.query('SELECT id FROM frame_instances WHERE owner_scope_id=$1 ORDER BY created_at LIMIT 2',[a])).rows.map(row=>row.id);
    const settled=(await pool.query("SELECT id FROM belief_transactions WHERE owner_scope_id=$1 AND transaction_kind='MERGE'",[a])).rows[0].id;
    await expect(pool.query(`INSERT INTO frame_instance_lineage(id,owner_scope_id,from_frame_instance_id,to_frame_instance_id,lineage_kind,transaction_id)
      VALUES(gen_random_uuid(),$1,$2,$3,'MERGED_INTO',$4)`,[a,to,from,settled])).rejects.toThrow('LINEAGE_REQUIRES_GOVERNED_TRANSACTION');
    // Retiring an instance is governed the same way, and its identity never moves.
    await expect(pool.query("UPDATE frame_instances SET lifecycle='MERGED',retired_at=now() WHERE owner_scope_id=$1 AND lifecycle='ACTIVE'",[a]))
      .rejects.toThrow('FRAME_RETIREMENT_REQUIRES_TRANSACTION');
    await expect(pool.query("UPDATE frame_instances SET lifecycle='ACTIVE',retired_at=NULL WHERE owner_scope_id=$1 AND lifecycle='MERGED'",[a]))
      .rejects.toThrow('FRAME_INSTANCE_ALREADY_RETIRED');
    await expect(pool.query("UPDATE frame_instances SET frame_type_id='shared.commitment' WHERE owner_scope_id=$1",[a]))
      .rejects.toThrow('CANONICAL_IDENTITY_IMMUTABLE');
    await asOwner(a,alice,async c=>{
      expect((await c.query("UPDATE frame_instances SET lifecycle='RETIRED',retired_at=now()")).rowCount).toBe(0);
    },'memory.canonicalize');
    await expect(asOwner(a,alice,c=>c.query("UPDATE frame_instances SET lifecycle='MERGED',retired_at=now() WHERE lifecycle='ACTIVE'").then(()=>{}),'memory.govern'))
      .rejects.toThrow('FRAME_RETIREMENT_REQUIRES_TRANSACTION');
  });
  it('holds exactly one active BASE context space per owner scope and keeps it permanent',async()=>{
    // Created with the owner scope, so no scope exists without a context to
    // assert a belief in, and the owner sees only its own.
    for(const owner of [a,b]){
      expect((await pool.query("SELECT context_kind,lifecycle,parent_context_space_id FROM context_spaces WHERE owner_scope_id=$1",[owner])).rows)
        .toEqual([{context_kind:'BASE',lifecycle:'ACTIVE',parent_context_space_id:null}]);
    }
    await asOwner(a,alice,async c=>{
      const rows=(await c.query('SELECT owner_scope_id,context_kind FROM context_spaces')).rows;
      expect(rows).toEqual([{owner_scope_id:a,context_kind:'BASE'}]);
    });
    // A second active BASE is impossible, and the existing one cannot be retired
    // or re-kinded away, so "at most one" is also "exactly one".
    await expect(pool.query("INSERT INTO context_spaces(id,owner_scope_id,context_kind) VALUES($1,$2,'BASE')",[randomUUID(),a]))
      .rejects.toMatchObject({code:'23505'});
    await expect(pool.query("UPDATE context_spaces SET lifecycle='RETIRED',retired_at=now() WHERE owner_scope_id=$1",[a]))
      .rejects.toThrow('BASE_CONTEXT_SPACE_PERMANENT');
    await expect(pool.query("UPDATE context_spaces SET context_kind='TEST' WHERE owner_scope_id=$1",[a]))
      .rejects.toThrow('CONTEXT_SPACE_IDENTITY_IMMUTABLE');
    await expect(pool.query('DELETE FROM context_spaces WHERE owner_scope_id=$1',[a]))
      .rejects.toThrow('BASE_CONTEXT_SPACE_PERMANENT');
    // A derived context is scoped to a parent in the same owner scope; the
    // application role may read contexts and write none.
    const base=(await pool.query("SELECT id FROM context_spaces WHERE owner_scope_id=$1",[a])).rows[0].id;
    await expect(pool.query("INSERT INTO context_spaces(id,owner_scope_id,context_kind,parent_context_space_id) VALUES($1,$2,'QUOTED',$3)",[randomUUID(),b,base]))
      .rejects.toMatchObject({code:'23503'});
    await expect(pool.query("INSERT INTO context_spaces(id,owner_scope_id,context_kind) VALUES($1,$2,'QUOTED')",[randomUUID(),a]))
      .rejects.toMatchObject({code:'23514'});
    for(const sql of ["INSERT INTO context_spaces(id,owner_scope_id,context_kind,parent_context_space_id) VALUES(gen_random_uuid(),'"+a+"','TEST','"+base+"')",
      'UPDATE context_spaces SET creation_transaction_id=NULL','DELETE FROM context_spaces','TRUNCATE context_spaces']){
      await expect(asOwner(a,alice,c=>c.query(sql).then(()=>{}))).rejects.toMatchObject({code:'42501'});
    }
  });
  it('does not expose session digests to the application role',async()=>{
    await expect(asOwner(a,alice,c=>c.query('SELECT token_hash FROM auth_sessions').then(()=>{}))).rejects.toMatchObject({code:'42501'});
    await expect(appPool.query('SELECT unai_private.auth_session($1)',['a'.repeat(64)])).rejects.toMatchObject({code:'42501'});
  });
  it('refuses cross-owner inserts',async()=>{
    await expect(asOwner(a,alice,c=>c.query('INSERT INTO devices (id,owner_scope_id,user_id,display_name) VALUES ($1,$2,$3,$4)',[randomUUID(),b,bob,'Forged']).then(()=>{}))).rejects.toMatchObject({code:'42501'});
  });
  it('enforces evidence purpose and sensitivity in unfiltered SQL and refuses metadata mutation',async()=>{
    await asOwner(a,alice,async c=>{
      await c.query("SELECT set_config('unai.data_purpose','ADVERTISING',true)");
      expect((await c.query('SELECT * FROM source_items')).rows).toEqual([]);
      expect((await c.query('SELECT * FROM source_anchors')).rows).toEqual([]);
      // The private object-store location follows the evidence row's own decision.
      expect((await c.query('SELECT * FROM evidence_object_keys')).rows).toEqual([]);
      await c.query("SELECT set_config('unai.data_purpose','PERSONAL_ASSISTANCE',true),set_config('unai.maximum_sensitivity','NORMAL',true)");
      expect((await c.query('SELECT * FROM source_items')).rows).toEqual([]);
    });
    for(const table of ['source_items','source_anchors','evidence_object_keys']){
      await expect(asOwner(a,alice,c=>c.query('UPDATE '+table+' SET id=id').then(()=>{}))).rejects.toMatchObject({code:'42501'});
      await expect(asOwner(a,alice,c=>c.query('DELETE FROM '+table).then(()=>{}))).rejects.toMatchObject({code:'42501'});
    }
  });
  it('refuses audit mutation and truncation',async()=>{
    for(const sql of ['UPDATE audit_events SET result=\'FAILURE\'','DELETE FROM audit_events','TRUNCATE audit_events']){
      await expect(asOwner(a,alice,c=>c.query(sql).then(()=>{}))).rejects.toMatchObject({code:'42501'});
    }
  });
  it('does not grant owner access to a non-member actor',async()=>{
    await asOwner(b,alice,async c=>{
      expect((await c.query('SELECT * FROM devices')).rows).toEqual([]);
      expect((await c.query('SELECT * FROM audit_events')).rows).toEqual([]);
    });
  });
  it('fails closed with no request context',async()=>{
    const c=await pool.connect();
    try{
      await c.query('BEGIN'); await c.query('SET LOCAL ROLE unai_app');
      expect((await c.query('SELECT * FROM devices')).rows).toEqual([]);
    } finally{await c.query('ROLLBACK');c.release();}
  });
  it('forces RLS on all application tables',async()=>{
    const rows=(await pool.query("SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON c.relnamespace=n.oid WHERE n.nspname='public' AND c.relkind='r'")).rows;
    expect(rows.length).toBe(55);
    expect(rows.every(r=>r.relrowsecurity&&r.relforcerowsecurity)).toBe(true);
    const role=(await pool.query("SELECT rolbypassrls,rolsuper FROM pg_roles WHERE rolname='unai_app'")).rows[0];
    expect(role).toEqual({rolbypassrls:false,rolsuper:false});
  });

  it('persists a scoped audit event through a real low-privilege connection',async()=>{
    const context={actorId:alice,ownerScopeId:a,purpose:'device.register',correlationId:randomUUID()};
    const id=await withOwnerTransaction(appPool,context,async tx=>{
      return tx.audit({policyDecision:'ALLOW',codeVersion:'0.1.0',result:'SUCCESS',objects:[{type:'devices',id:alice,fields:['display_name']}]});
    });
    const row=(await pool.query('SELECT owner_scope_id,actor,correlation_id FROM audit_events WHERE id=$1',[id])).rows[0];
    expect(row).toEqual({owner_scope_id:a,actor:alice,correlation_id:context.correlationId});
  });
  it('rejects invalid membership before running application work',async()=>{
    let ran=false;
    await expect(withOwnerTransaction(appPool,{actorId:alice,ownerScopeId:b,purpose:'test',correlationId:randomUUID()},async()=>{ran=true;})).rejects.toThrow('OWNER_ACCESS_DENIED');
    expect(ran).toBe(false);
  });
  it('rolls back audit and device work together on failure',async()=>{
    const correlationId=randomUUID();
    await expect(withOwnerTransaction(appPool,{actorId:alice,ownerScopeId:a,purpose:'test',correlationId},async tx=>{
      await tx.audit({policyDecision:'ALLOW',codeVersion:'0.1.0',result:'SUCCESS',objects:[]});
      throw new Error('operation failed');
    })).rejects.toThrow('operation failed');
    expect((await pool.query('SELECT * FROM audit_events WHERE correlation_id=$1',[correlationId])).rows).toEqual([]);
  });
  it('clears transaction context on a reused application connection',async()=>{
    await withOwnerTransaction(appPool,{actorId:alice,ownerScopeId:a,purpose:'test',correlationId:randomUUID()},async()=>{});
    expect((await appPool.query('SELECT * FROM devices')).rows).toEqual([]);
    await withOwnerTransaction(appPool,{actorId:bob,ownerScopeId:b,purpose:'test',correlationId:randomUUID()},async tx=>{
      expect((await tx.query('SELECT owner_scope_id FROM devices')).rows).toEqual([{owner_scope_id:b}]);
    });
  });
  it('CRT-SEC-01-A: hides B from unfiltered owner A capability-grant queries and keeps grant identity immutable',async()=>{
    await asOwner(a,alice,async c=>{
      const rows=(await readUnfiltered(c,'connector_capability_grants')).rows;
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every(row=>row.owner_scope_id===a)).toBe(true);
      // The grant set is per capability, and the two rows disagree: one granted,
      // one not. Nothing in the schema lets one stand for the other.
      expect(rows.filter(row=>row.granted).map(row=>row.capability_id)).toEqual(['documents.upload']);
    },'connector.read');
    await asOwner(b,alice,async c=>{
      expect((await c.query('SELECT * FROM connector_capability_grants')).rows).toEqual([]);
    },'connector.read');
    // Purpose-bound: a read purpose that is not a connector purpose sees none of it.
    await asOwner(a,alice,async c=>{
      expect((await c.query('SELECT * FROM connector_capability_grants')).rows).toEqual([]);
    });
    // Consent is the only path that may change a grant, and it may move only the
    // grant flag: a denied capability cannot become a granted one by renaming.
    // A sync's own purpose matches no row of the UPDATE policy, so the statement
    // changes nothing rather than widening the grant it runs under.
    await asOwner(a,alice,async c=>{
      const changed=await c.query("UPDATE connector_capability_grants SET granted=true WHERE capability_id='documents.read'");
      expect(changed.rowCount).toBe(0);
    },'connector.sync');
    await asOwner(a,alice,async c=>{
      expect((await c.query("SELECT granted FROM connector_capability_grants WHERE capability_id='documents.read'")).rows)
        .toEqual([{granted:false}]);
    },'connector.read');
    await expect(pool.query("UPDATE connector_capability_grants SET capability_id='documents.upload' WHERE owner_scope_id=$1 AND capability_id='documents.read'",[a]))
      .rejects.toThrow('CONNECTOR_GRANT_IDENTITY_IMMUTABLE');
    // V0 is read-only: a granted write capability is unrepresentable.
    await expect(pool.query(`INSERT INTO connector_capability_grants(id,owner_scope_id,connector_id,capability_id,risk_class,access_kind,granted,granted_at)
      SELECT $1,owner_scope_id,connector_id,'gmail.send','HIGH','WRITE',true,now() FROM connector_capability_grants WHERE owner_scope_id=$2 LIMIT 1`,[randomUUID(),a]))
      .rejects.toMatchObject({constraint:'connector_capability_grants_read_only'});
    // A connector's identity never moves, and a disconnected connector ingests
    // nothing: both are refused by the schema, not only by the service.
    await expect(pool.query("UPDATE connectors SET connector_type='GMAIL' WHERE owner_scope_id=$1",[a]))
      .rejects.toThrow('CONNECTOR_IDENTITY_IMMUTABLE');
    const connector=(await pool.query('SELECT id FROM connectors WHERE owner_scope_id=$1',[a])).rows[0].id;
    await pool.query("UPDATE connectors SET status='DISCONNECTED',disconnected_at=now(),secret_ref=NULL WHERE id=$1",[connector]);
    try{
      await expect(pool.query(`INSERT INTO source_items(id,owner_scope_id,connector_id,source_type,external_id,actor_ref,submitted_by_user_id,raw_object_ref,content_hash,sensitivity,allowed_purposes,ingestion_version,idempotency_key)
        VALUES($1,$2,$3,'DOCUMENT','after-disconnect',$4,$5,$6,$7,'PRIVATE',ARRAY['PERSONAL_ASSISTANCE'],'evidence-json-v1',$8)`,
        [randomUUID(),a,connector,JSON.stringify({type:'USER',id:alice}),alice,randomUUID(),'d'.repeat(64),randomUUID()]))
        .rejects.toThrow('CONNECTOR_INGESTION_STOPPED');
    }finally{
      await pool.query("UPDATE connectors SET status='ACTIVE',disconnected_at=NULL WHERE id=$1",[connector]);
    }
  });

  it('refuses success when a caught SQL error causes COMMIT to roll back',async()=>{
    const correlationId=randomUUID();
    await expect(withOwnerTransaction(appPool,{actorId:alice,ownerScopeId:a,purpose:'test',correlationId},async tx=>{
      await tx.audit({policyDecision:'ALLOW',codeVersion:'0.1.0',result:'SUCCESS',objects:[]});
      await expect(tx.query('SELECT 1/0')).rejects.toMatchObject({code:'22012'});
      return 'material operation succeeded';
    })).rejects.toThrow('TRANSACTION_NOT_COMMITTED');
    expect((await pool.query('SELECT id FROM audit_events WHERE correlation_id=$1',[correlationId])).rows).toEqual([]);
    await withOwnerTransaction(appPool,{actorId:bob,ownerScopeId:b,purpose:'test',correlationId:randomUUID()},async tx=>{
      expect((await tx.query('SELECT owner_scope_id FROM devices')).rows).toEqual([{owner_scope_id:b}]);
    });
  });
  it('CRT-SEC-01-A: hides B from unfiltered owner A context and thread queries and keeps both records immutable',async()=>{
    const brokerTables=['memory_threads','memory_thread_members','context_packets'];
    await asOwner(a,alice,async c=>{
      for(const table of brokerTables){
        const rows=(await readUnfiltered(c,table)).rows;
        expect(rows.length,table).toBeGreaterThan(0);
        expect(rows.every(row=>row.owner_scope_id===a),table).toBe(true);
      }
      // One frame instance, two threads: the membership rows are the only thing
      // that repeats, and no second evidence row exists behind them (CRT-RD-10-A).
      const members=(await c.query('SELECT memory_thread_id,object_id FROM memory_thread_members')).rows;
      expect(members.length).toBe(2);
      expect(new Set(members.map(row=>row.object_id)).size).toBe(1);
      expect(new Set(members.map(row=>row.memory_thread_id)).size).toBe(2);
      expect((await c.query('SELECT count(*)::int AS n FROM source_items')).rows[0].n).toBe(1);
    },'memory.read');
    await asOwner(b,alice,async c=>{
      for(const table of brokerTables) expect((await c.query('SELECT * FROM '+table)).rows,table).toEqual([]);
    },'memory.read');
    // Purpose-bound like the rest: an unrelated product purpose reads none of it.
    await asOwner(a,alice,async c=>{
      for(const table of brokerTables) expect((await c.query('SELECT * FROM '+table)).rows,table).toEqual([]);
    });
    // The model and plugin read path is a read. It holds no grant that could
    // write a thread, a membership, an overlay delta or any canonical row, and no
    // table here takes a DELETE grant at all (PRD §23, FR-060).
    for(const table of [...brokerTables,'propositions','claims','frame_instances','owner_overlay_deltas']){
      await expect(asOwner(a,alice,c=>c.query('DELETE FROM '+table).then(()=>{}),'memory.read'),table).rejects.toMatchObject({code:'42501'});
    }
    for(const sql of ["INSERT INTO memory_threads(id,owner_scope_id) VALUES(gen_random_uuid(),$1)",
      "INSERT INTO memory_thread_members(owner_scope_id,memory_thread_id,object_type,object_id,membership_kind) SELECT $1,id,'entity',id,'RELATED' FROM memory_threads"]){
      await expect(asOwner(a,alice,c=>c.query(sql,[a]).then(()=>{}),'memory.read'),sql).rejects.toMatchObject({code:'42501'});
    }
    // A packet and a membership are statements about a moment; a thread keeps its
    // identity even when its title moves.
    await expect(asOwner(a,alice,c=>c.query("UPDATE context_packets SET purpose='OTHER'").then(()=>{}),'memory.read'))
      .rejects.toMatchObject({code:'42501'});
    await expect(pool.query("UPDATE context_packets SET packet='{\"forged\":true}' WHERE owner_scope_id=$1",[a]))
      .rejects.toThrow('CANONICALIZATION_RECORD_IMMUTABLE');
    await expect(pool.query("UPDATE memory_thread_members SET membership_kind='SUBJECT' WHERE owner_scope_id=$1",[a]))
      .rejects.toThrow('CANONICALIZATION_RECORD_IMMUTABLE');
    await expect(pool.query('UPDATE memory_threads SET id=gen_random_uuid() WHERE owner_scope_id=$1',[a]))
      .rejects.toThrow('MEMORY_THREAD_IDENTITY_IMMUTABLE');
    // CRT-SEC-09-A in the schema: the classification of the owner's own evidence
    // is answerable above the request ceiling, and it is a label and nothing more.
    await asOwner(a,alice,async c=>{
      const labels=(await c.query('SELECT * FROM unai_private.evidence_labels($1)',[a])).rows;
      expect(labels.length).toBe(1);
      expect(Object.keys(labels[0]!).sort()).toEqual(['allowed_purposes','sensitivity','source_item_id']);
    },'memory.read');
    // It answers for this owner only, and only under a memory read purpose.
    await asOwner(a,alice,async c=>{
      expect((await c.query('SELECT * FROM unai_private.evidence_labels($1)',[b])).rows).toEqual([]);
    },'memory.read');
    await asOwner(a,alice,async c=>{
      expect((await c.query('SELECT * FROM unai_private.evidence_labels($1)',[a])).rows).toEqual([]);
    },'memory.govern');
  });
  it('CRT-SEC-01-A: hides B from unfiltered owner A answer-provenance queries and keeps both records immutable',async()=>{
    const provenance=['answer_manifests','reconsideration_candidates'];
    for(const purpose of ['memory.inspect','memory.read']){
      await asOwner(a,alice,async c=>{
        for(const table of provenance){
          const rows=(await readUnfiltered(c,table)).rows;
          expect(rows.length,table).toBeGreaterThan(0);
          expect(rows.every(row=>row.owner_scope_id===a),table).toBe(true);
        }
      },purpose);
      await asOwner(b,alice,async c=>{
        for(const table of provenance) expect((await c.query('SELECT * FROM '+table)).rows,table).toEqual([]);
      },purpose);
    }
    // Purpose-bound: an unrelated product purpose reads none of it.
    await asOwner(a,alice,async c=>{
      for(const table of provenance) expect((await c.query('SELECT * FROM '+table)).rows,table).toEqual([]);
    });
    // Only the recording purpose writes a manifest, nobody deletes one, and the
    // derived candidates have no application writer at all.
    await expect(asOwner(a,alice,c=>c.query(`INSERT INTO answer_manifests SELECT gen_random_uuid(),owner_scope_id,context_packet_id,
      packet_hash,conversation_message_id,requesting_actor_id,model_provider,model_id,prompt_version,composer_version,belief_ids,
      claim_ids,evidence_ids,overlay_delta_ids,projection_versions,watermarks,registry_release,registry_release_id,
      grounding_validator_result,manifest_version,created_at FROM answer_manifests`).then(()=>{}),'memory.read'))
      .rejects.toMatchObject({code:'42501'});
    for(const table of provenance){
      await expect(asOwner(a,alice,c=>c.query('DELETE FROM '+table).then(()=>{}),'answer.record'),table).rejects.toMatchObject({code:'42501'});
    }
    await expect(asOwner(a,alice,c=>c.query(`INSERT INTO reconsideration_candidates(id,owner_scope_id,changed_object_type,
      changed_object_id,answer_manifest_id,change_kind,change_ref) SELECT gen_random_uuid(),owner_scope_id,changed_object_type,
      changed_object_id,answer_manifest_id,change_kind,gen_random_uuid() FROM reconsideration_candidates`).then(()=>{}),'answer.record'))
      .rejects.toMatchObject({code:'42501'});
    // A manifest is a statement about one moment: not even the migration
    // principal rewrites the context it says was supplied.
    await expect(pool.query("UPDATE answer_manifests SET belief_ids='{}' WHERE owner_scope_id=$1",[a]))
      .rejects.toThrow('CANONICALIZATION_RECORD_IMMUTABLE');
    await expect(pool.query("UPDATE reconsideration_candidates SET change_kind='CLAIM_CORRECTED' WHERE owner_scope_id=$1",[a]))
      .rejects.toThrow('CANONICALIZATION_RECORD_IMMUTABLE');
  });
  it('CRT-SEC-01-A and CRT-RD-04-A: hides B from unfiltered owner A semantic-index queries and applies the evidence gate to every row',async()=>{
    await asOwner(a,alice,async c=>{
      const rows=(await readUnfiltered(c,'memory_embeddings')).rows;
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every(row=>row.owner_scope_id===a)).toBe(true);
    },'memory.read');
    await asOwner(b,alice,async c=>{
      expect((await c.query('SELECT * FROM memory_embeddings')).rows).toEqual([]);
    },'memory.read');
    // An unrelated product purpose reads nothing, and neither does the model read
    // purpose under a ceiling below the row's security scope or a data purpose
    // the evidence behind it never admitted -- even with no application filter.
    await asOwner(a,alice,async c=>{
      expect((await c.query('SELECT * FROM memory_embeddings')).rows).toEqual([]);
    });
    for(const [dataPurpose,ceiling] of [['PERSONAL_ASSISTANCE','NORMAL'],['ADVERTISING','RESTRICTED']]){
      await asOwner(a,alice,async c=>{
        await c.query("SELECT set_config('unai.data_purpose',$1,true),set_config('unai.maximum_sensitivity',$2,true)",[dataPurpose,ceiling]);
        expect((await c.query('SELECT * FROM memory_embeddings')).rows,dataPurpose+' '+ceiling).toEqual([]);
      },'memory.read');
    }
    // The read path cannot write the index, and nobody can rewrite a row of it.
    await expect(asOwner(a,alice,c=>c.query(`INSERT INTO memory_embeddings(id,owner_scope_id,object_type,object_id,
      embedding_model,embedding_version,vector,security_scope,allowed_purposes,source_item_ids,source_types,recorded_at,content_hash)
      SELECT gen_random_uuid(),owner_scope_id,'claim',object_id,embedding_model,'other-version',vector,security_scope,
      allowed_purposes,source_item_ids,source_types,recorded_at,content_hash FROM memory_embeddings`).then(()=>{}),'memory.read'))
      .rejects.toMatchObject({code:'42501'});
    await expect(asOwner(a,alice,c=>c.query('DELETE FROM memory_embeddings').then(()=>{}),'memory.read'))
      .rejects.toMatchObject({code:'42501'});
    await expect(pool.query("UPDATE memory_embeddings SET security_scope='NORMAL' WHERE owner_scope_id=$1",[a]))
      .rejects.toThrow('CANONICALIZATION_RECORD_IMMUTABLE');
    // The indexer's evidence reader answers labels only, for this owner, and only
    // under the governed purpose that indexes.
    await asOwner(a,alice,async c=>{
      const anchors=(await c.query('SELECT id FROM source_anchors')).rows.map(row=>row.id);
      const scope=(await c.query('SELECT * FROM unai_private.anchor_evidence_scope($1,$2)',[a,anchors])).rows;
      expect(anchors.length).toBeGreaterThan(0);
      expect(scope.length).toBe(anchors.length);
      expect(Object.keys(scope[0]!).sort()).toEqual(['allowed_purposes','occurred_at','sensitivity','source_anchor_id',
        'source_item_id','source_type']);
      expect((await c.query('SELECT * FROM unai_private.anchor_evidence_scope($1,$2)',[b,anchors])).rows).toEqual([]);
    },'memory.govern');
    await asOwner(a,alice,async c=>{
      const anchors=(await pool.query('SELECT id FROM source_anchors WHERE owner_scope_id=$1',[a])).rows.map(row=>row.id);
      expect((await c.query('SELECT * FROM unai_private.anchor_evidence_scope($1,$2)',[a,anchors])).rows).toEqual([]);
    },'memory.read');
  });
  it('refuses an elevated application database connection',async()=>{
    await expect(withOwnerTransaction(pool,{actorId:alice,ownerScopeId:a,purpose:'test',correlationId:randomUUID()},async()=>{})).rejects.toThrow('DATABASE_ROLE_UNSAFE');
  });
  it('detects future tables without an ownership classification',async()=>{
    await assertOwnershipCoverage(pool);
    await pool.query('CREATE TABLE future_unscoped (id uuid)');
    try {await expect(assertOwnershipCoverage(pool)).rejects.toThrow('OWNERSHIP_COVERAGE_INVALID');}
    finally {await pool.query('DROP TABLE future_unscoped');}
  });

  it('keeps the global registry snapshot inaccessible to the application', async () => {
    await expect(appPool.query('SELECT * FROM registry_releases')).rejects.toMatchObject({code:'42501'});
    await expect(appPool.query('SELECT * FROM registry_contracts')).rejects.toMatchObject({code:'42501'});
    // Uncommitted on one connection, so parallel test files never observe the weakened grants.
    const client=await pool.connect();
    const coverage=()=>assertOwnershipCoverage({query:(sql:string)=>client.query(sql)} as unknown as Pool);
    try{
      for(const weaken of ['GRANT SELECT ON registry_contracts TO unai_app','ALTER TABLE registry_releases NO FORCE ROW LEVEL SECURITY',
        'CREATE POLICY registry_read ON registry_releases TO unai_app USING (true)']){
        await client.query('BEGIN');
        await client.query(weaken);
        await expect(coverage(),weaken).rejects.toThrow('OWNERSHIP_COVERAGE_INVALID');
        await client.query('ROLLBACK');
      }
    } finally {await client.query('ROLLBACK');client.release();}
  });

  it('keeps deployment ledger inaccessible to the application', async () => {
    await expect(appPool.query('SELECT * FROM unai_migrations.applied')).rejects.toMatchObject({code:'42501'});
    await pool.query('GRANT USAGE ON SCHEMA unai_migrations TO unai_app');
    try { await expect(assertOwnershipCoverage(pool)).rejects.toThrow('OWNERSHIP_COVERAGE_INVALID'); }
    finally { await pool.query('REVOKE USAGE ON SCHEMA unai_migrations FROM unai_app'); }
  });


  it('does not allow an audit capability to outlive its transaction',async()=>{
    let saved: import('./index.js').OwnerTransaction | undefined;
    await withOwnerTransaction(appPool,{actorId:alice,ownerScopeId:a,purpose:'test',correlationId:randomUUID()},async tx=>{saved=tx;});
    await expect(saved!.audit({policyDecision:'ALLOW',codeVersion:'0.1.0',result:'SUCCESS',objects:[]})).rejects.toThrow('TRANSACTION_CLOSED');
  });
  it('invalidates access when membership ends',async()=>{
    await pool.query("UPDATE owner_scope_members SET valid_to=now()+interval '1 millisecond' WHERE owner_scope_id=$1",[a]);
    await pool.query("SELECT pg_sleep(0.01)");
    try{
      await asOwner(a,alice,async c=>{expect((await c.query('SELECT * FROM devices')).rows).toEqual([]);});
    }finally{await pool.query('UPDATE owner_scope_members SET valid_to=NULL WHERE owner_scope_id=$1',[a]);}
  });


  it('refuses a retained query capability after transaction completion',async()=>{
    let saved: import('./index.js').OwnerTransaction | undefined;
    await withOwnerTransaction(appPool,{actorId:alice,ownerScopeId:a,purpose:'test',correlationId:randomUUID()},async tx=>{saved=tx;});
    await expect(saved!.query('SELECT * FROM devices')).rejects.toThrow('TRANSACTION_CLOSED');
  });


  it('CRT-SEC-01-A: covers every classified owner-scoped table with an unfiltered cross-owner query',async()=>{
    // Read the classification from the database rather than trusting the export:
    // every table an owner session can read at all, including the auth tables the
    // application may only read column by column.
    const live=(await pool.query(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind='r' AND EXISTS(
        SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
        AND has_column_privilege('unai_app',c.oid,a.attnum,'SELECT'))`)).rows.map(row=>row.relname as string);
    expect([...live].sort()).toEqual([...OWNER_SCOPED_TABLES].sort());
    expect([...unfiltered].sort()).toEqual([...OWNER_SCOPED_TABLES].sort());
  });

  it('rejects TLS downgrade options and plaintext database transport',async()=>{
    const {createDatabasePool}=await import('./index.js');
    expect(()=>createDatabasePool(process.env.UNAI_TEST_DATABASE_URL!+'?sslmode=disable','test-ca')).toThrow('DATABASE_TLS_CONFIG_INVALID');
    expect(()=>createDatabasePool(process.env.UNAI_TEST_DATABASE_URL!,'')).toThrow('DATABASE_TLS_CONFIG_INVALID');
    // A pool built on an unpinnable CA must never reach the database, and the transport is
    // what has to refuse it. Both refusals are correct and which one arrives is a property of
    // the server, not of this code: a server without TLS answers "does not support SSL
    // connections", while one serving a certificate this CA cannot validate answers a
    // certificate error. Asserting either wording alone passes only on the server that
    // happens to be in front of it, so match the transport refusal itself and prove no row
    // was ever returned.
    const tlsPool=createDatabasePool(process.env.UNAI_TEST_DATABASE_URL!,'test-ca');
    try{await expect(tlsPool.query('SELECT 1')).rejects.toThrow(/SSL|certificate/i);}
    finally{await tlsPool.end();}
  });

});
