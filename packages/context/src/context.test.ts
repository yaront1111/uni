import { Pool } from 'pg';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { runMigrations, withOwnerTransaction, type OwnerTransaction } from '@unai/postgres';
import type { PolicyVerdict, RequestContext } from '@unai/domain';
import { createLocalPolicyAdapters, type PolicyPorts } from '@unai/belief';
import { uuidV7 } from '../../../src/kernel/identities.js';
import {
  ContextBrokerError, assembleContextPacket, addThreadMember, createMemoryThread, classifyAnswerType,
  deriveLifeCategories, explainProposition, missingContextFields, readContextPacket, readMemoryThread,
  readWhySources,
} from './index.js';

/**
 * The Context Broker, the belief explanation and the memory threads over real
 * PostgreSQL, through the real owner boundary.
 *
 * Every call under test runs inside `withOwnerTransaction` as the low-privilege
 * application role, so migration 0017's policies are part of what is exercised:
 * `memory.read` reads canonical memory and writes only the packet record,
 * `memory.inspect` reads the explanation, and `memory.thread` attaches a
 * membership and can reach nothing else.
 *
 * Covers CRT-RD-02-A, CRT-RD-05-A, CRT-RD-09-A, CRT-RD-10-A, CRT-RYW-03-A,
 * CRT-SEC-02-A, CRT-SEC-09-A, CRT-WRT-03-B and CRT-MEM-02-A.
 */

if (!process.env.UNAI_TEST_DATABASE_URL) throw new Error('Run pnpm test for the required PostgreSQL harness');
const admin = new Pool({ connectionString: process.env.UNAI_TEST_DATABASE_URL });
const appUrl = new URL(process.env.UNAI_TEST_DATABASE_URL); appUrl.username = 'context_test_app'; appUrl.password = 'test-only';
const appPool = new Pool({ connectionString: appUrl.href });

const owner = randomUUID(), actor = randomUUID();
/** A pinned instant, so nothing in the packet depends on the day the suite runs. */
const NOW = new Date('2026-03-02T09:00:00.000Z');
/** When the fixture's claims and assessments were recorded: before NOW, so the
 * knowledge-time filter admits them. */
const RECORDED_AT = new Date('2026-02-01T09:00:00.000Z');

/** The one evidence row that is relevant to finance *and* to family, which is
 * what CRT-MEM-02-A is about. */
const FINANCE_PURPOSE = 'PERSONAL_FINANCE';
const FAMILY_PURPOSE = 'FAMILY_COORDINATION';

let baseContext = '', sharedEvidence = '', restrictedEvidence = '', secondEvidence = '';
let obligationFrame = '', commitmentFrame = '', principalSlot = '', dueSlot = '';
let acceptedProposition = '', competingProposition = '', dueProposition = '', restrictedProposition = '';
let danielEntity = '', financeThread = '', familyThread = '', transactionId = '';
let acceptedClaim = '', extractionRunId = '', registryReleaseId = '';
const unattached: Record<'entity' | 'thread' | 'anchor' | 'frameType', string> = {
  entity: '', thread: '', anchor: '', frameType: '',
};
const DISCOURSE_ANCHOR = 'gmail-thread-123';

function context(purpose: string): RequestContext {
  return { actorId: actor, ownerScopeId: owner, purpose, correlationId: randomUUID() };
}
const as = <T,>(purpose: string, run: (tx: OwnerTransaction) => Promise<T>) => withOwnerTransaction(appPool, context(purpose), run);
const read = <T,>(run: (tx: OwnerTransaction) => Promise<T>) => as('memory.read', run);
/** The broker's own runner: one transaction per call, exactly as the route gives
 * it, so the verdict commits before a denial is raised. */
const readRunner = <T,>(run: (tx: OwnerTransaction) => Promise<T>) => read(run);
const inspect = <T,>(run: (tx: OwnerTransaction) => Promise<T>) => as('memory.inspect', run);
const thread = <T,>(run: (tx: OwnerTransaction) => Promise<T>) => as('memory.thread', run);

/** The declarations of PRD §23.1, complete. Each test removes or changes exactly
 * the one thing it is about. */
function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ownerScopeId: owner, requestingActorId: actor, purpose: FINANCE_PURPOSE,
    query: 'Do I still owe Daniel?', worldTime: 'NOW', knowledgeTime: 'LATEST',
    maximumSensitivity: 'PRIVATE', actionRisk: 'MEDIUM', ...overrides,
  };
}

async function evidence(input: { sensitivity: string; allowedPurposes: string[]; externalId: string }): Promise<{ evidenceId: string; anchorId: string }> {
  const evidenceId = randomUUID(), anchorId = randomUUID(), connectorId = randomUUID();
  await admin.query("INSERT INTO connectors(id,owner_scope_id,connector_type,external_account_ref,permission_manifest,status) VALUES($1,$2,'CONVERSATION',$3,'{}','ACTIVE')",
    [connectorId, owner, input.externalId]);
  await admin.query(`INSERT INTO source_items(id,owner_scope_id,connector_id,source_type,external_id,actor_ref,
    submitted_by_user_id,raw_object_ref,content_hash,sensitivity,allowed_purposes,ingestion_version,idempotency_key,occurred_at)
    VALUES($1,$2,$3,'CONVERSATION',$4,$5,$6,$7,$8,$9,$10,'evidence-json-v1',$11,$12)`,
    [evidenceId, owner, connectorId, input.externalId, JSON.stringify({ type: 'USER', id: actor }), actor,
      randomUUID(), randomUUID().replaceAll('-', '').padEnd(64, 'a').slice(0, 64), input.sensitivity,
      input.allowedPurposes, randomUUID(), new Date('2026-02-01T08:00:00.000Z')]);
  await admin.query(`INSERT INTO source_anchors(id,owner_scope_id,source_item_id,anchor_kind,anchor,normalized_text)
    VALUES($1,$2,$3,'MESSAGE_SPAN','{"start":0,"end":40}',$4)`, [anchorId, owner, evidenceId, input.externalId]);
  return { evidenceId, anchorId };
}

async function proposition(input: {
  frameInstanceId: string; beliefSlotId: string; value: unknown; anchorId: string; assessment?: string | null;
  claimOrigin?: string; extractionRunId?: string | null; recordedAt?: Date; validFrom?: Date;
}): Promise<{ propositionId: string; claimId: string }> {
  const propositionId = uuidV7(), claimId = uuidV7();
  await admin.query('INSERT INTO propositions(id,owner_scope_id,belief_slot_id,normalized_value) VALUES($1,$2,$3,$4)',
    [propositionId, owner, input.beliefSlotId, JSON.stringify(input.value)]);
  await admin.query(`INSERT INTO proposition_fingerprints(id,owner_scope_id,proposition_id,registry_release_id,
    normalization_version,fingerprint,descriptor) VALUES($1,$2,$3,$4,'normalization-1',$5,'{}')`,
    [randomUUID(), owner, propositionId, registryReleaseId, randomUUID().replaceAll('-', '').padEnd(64, 'b').slice(0, 64)]);
  // `recorded_at` is explicit throughout the fixture: the knowledge time under
  // test is pinned to NOW, and a row recorded after it is correctly invisible, so
  // leaving the column to default to the wall clock would test nothing.
  await admin.query(`INSERT INTO claims(id,owner_scope_id,source_anchor_id,proposition_id,claim_origin,lifecycle,
    extraction_run_id,valid_from,recorded_at) VALUES($1,$2,$3,$4,$5,'PROVISIONAL',$6,$7,$8)`,
    [claimId, owner, input.anchorId, propositionId, input.claimOrigin ?? 'USER_STATEMENT',
      input.extractionRunId ?? null, input.validFrom ?? new Date('2026-02-01T08:00:00.000Z'), input.recordedAt ?? RECORDED_AT]);
  if (input.assessment) {
    await admin.query(`INSERT INTO belief_assessments(id,owner_scope_id,proposition_id,assessment_status,policy_version,
      transaction_id,decision_reason,recorded_at) VALUES($1,$2,$3,$4,'local-policy-0.1.0',$5,'{"code":"FIXTURE"}',$6)`,
      [randomUUID(), owner, propositionId, input.assessment, transactionId, RECORDED_AT]);
    await admin.query(`INSERT INTO belief_support(id,owner_scope_id,proposition_id,claim_id,support_kind,
      independence_group,created_by_transaction_id) VALUES($1,$2,$3,$4,'DIRECT_ASSERTION',$5,$6)`,
      [randomUUID(), owner, propositionId, claimId, 'source:' + input.anchorId.slice(0, 8), transactionId]);
  }
  return { propositionId, claimId };
}

async function slot(frameInstanceId: string, predicateId: string, modality = 'ACTUAL'): Promise<string> {
  const id = uuidV7();
  await admin.query(`INSERT INTO belief_slots(id,owner_scope_id,frame_instance_id,predicate_id,context_space_id,modality)
    VALUES($1,$2,$3,$4,$5,$6)`, [id, owner, frameInstanceId, predicateId, baseContext, modality]);
  return id;
}

async function frame(frameTypeId: string): Promise<string> {
  const id = uuidV7();
  await admin.query('INSERT INTO frame_instances(id,owner_scope_id,frame_type_id,context_space_id) VALUES($1,$2,$3,$4)',
    [id, owner, frameTypeId, baseContext]);
  return id;
}

let nextSequence = 0;
async function delta(input: {
  lifecycle: string; deltaKind?: string; rawText: string; evidenceId: string;
  candidateEntityRefs?: string[]; candidateWorldlineRefs?: string[]; candidateFrameTypes?: string[];
  discourseAnchor?: string | null; attachedFrameInstanceId?: string | null; createdAt?: Date;
}): Promise<string> {
  const id = uuidV7();
  nextSequence += 1;
  await admin.query(`INSERT INTO owner_overlay_deltas(id,owner_scope_id,owner_sequence,source_evidence_id,raw_text,
    delta_kind,lifecycle,candidate_entity_refs,candidate_worldline_refs,candidate_frame_types,discourse_anchor,
    attached_frame_instance_id,created_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [id, owner, nextSequence, input.evidenceId, input.rawText, input.deltaKind ?? 'USER_ASSERTION', input.lifecycle,
      input.candidateEntityRefs ?? [], input.candidateWorldlineRefs ?? [], input.candidateFrameTypes ?? [],
      input.discourseAnchor ?? null, input.attachedFrameInstanceId ?? null, input.createdAt ?? RECORDED_AT]);
  return id;
}

beforeAll(async () => {
  await runMigrations(admin, resolve('migrations'));
  await admin.query("DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='context_test_app') THEN CREATE ROLE context_test_app LOGIN PASSWORD 'test-only'; END IF; END $$; GRANT unai_app TO context_test_app");
  await admin.query('INSERT INTO users(id,display_name) VALUES($1,$2)', [actor, 'Context owner']);
  await admin.query("INSERT INTO owner_scopes(id,scope_kind,display_name,created_by_user_id) VALUES($1,'PERSONAL','Context',$2)", [owner, actor]);
  await admin.query("INSERT INTO owner_scope_members(owner_scope_id,user_id,role) VALUES($1,$2,'OWNER')", [owner, actor]);
  baseContext = (await admin.query('SELECT id FROM context_spaces WHERE owner_scope_id=$1', [owner])).rows[0].id;
  registryReleaseId = randomUUID();

  transactionId = randomUUID();
  await admin.query(`INSERT INTO belief_transactions(id,owner_scope_id,transaction_kind,requested_by_actor_id,
    source_evidence_ids,registry_release_id,status,risk,idempotency_key,commit_receipt,committed_at)
    VALUES($1,$2,'CANONICALIZE',$3,'{}',$4,'COMMITTED','LOW',$5,'{}',$6)`,
    [transactionId, owner, actor, registryReleaseId, randomUUID().replaceAll('-', ''), new Date('2026-02-01T09:00:00.000Z')]);

  // One evidence row, relevant to finance *and* to family: the same item admits
  // both data purposes and is stored once (CRT-MEM-02-A).
  const shared = await evidence({ sensitivity: 'PRIVATE', allowedPurposes: [FINANCE_PURPOSE, FAMILY_PURPOSE], externalId: 'shared-item' });
  sharedEvidence = shared.evidenceId;
  const second = await evidence({ sensitivity: 'PRIVATE', allowedPurposes: [FINANCE_PURPOSE], externalId: 'second-item' });
  secondEvidence = second.evidenceId;
  const restricted = await evidence({ sensitivity: 'RESTRICTED', allowedPurposes: [FINANCE_PURPOSE], externalId: 'restricted-item' });
  restrictedEvidence = restricted.evidenceId;

  const triageId = randomUUID(); extractionRunId = randomUUID();
  await admin.query(`INSERT INTO triage_decisions(id,owner_scope_id,source_item_id,tier0_parsed,tier1_route,routing_reason,
    cost_budget_microunits) VALUES($1,$2,$3,'{"parserVersion":"tier0-deterministic-0.1.0"}','FULL_EXTRACTION',
    '{"code":"MEMORY_WORTHY_SIGNALS","routerVersion":"tier1-rules-0.1.0"}',20000)`, [triageId, owner, sharedEvidence]);
  await admin.query(`INSERT INTO extraction_runs(id,owner_scope_id,source_item_id,triage_decision_id,run_kind,
    registry_release_id,normalization_version,entity_resolver_version,temporal_resolver_version,status,
    model_provider,model_id,prompt_version,cost_microunits,latency_ms,completed_at)
    VALUES($1,$2,$3,$4,'FULL',$5,'normalization-1','entity-resolver-1','temporal-resolver-1','SUCCEEDED',
    'anthropic','test-model','surface-frames-0.1.0',1200,340,now())`,
    [extractionRunId, owner, sharedEvidence, triageId, registryReleaseId]);

  danielEntity = uuidV7();
  await admin.query("INSERT INTO entities(id,owner_scope_id,entity_kind,canonical_label) VALUES($1,$2,'PERSON','Daniel')",
    [danielEntity, owner]);
  await admin.query(`INSERT INTO entity_aliases(id,owner_scope_id,entity_id,alias_type,alias_value,normalized_value,
    source_item_id,created_at) VALUES($1,$2,$3,'DISPLAY_NAME','Daniel','daniel',$4,$5)`, [randomUUID(), owner, danielEntity, sharedEvidence, RECORDED_AT]);

  obligationFrame = await frame('shared.obligation');
  commitmentFrame = await frame('shared.commitment');

  principalSlot = await slot(obligationFrame, 'shared.obligation.principal_amount');
  dueSlot = await slot(obligationFrame, 'shared.obligation.due_time');
  const restrictedSlot = await slot(commitmentFrame, 'shared.commitment.due_time');

  // Two live values in one slot: the conflict the packet reports and never
  // resolves (CRT-MEM-08-A is the capability's; this is the packet's view of it).
  const accepted = await proposition({
    frameInstanceId: obligationFrame, beliefSlotId: principalSlot, value: { amount: '50.00', currency: 'ILS' },
    anchorId: shared.anchorId, assessment: 'ACCEPTED', extractionRunId,
  });
  acceptedProposition = accepted.propositionId; acceptedClaim = accepted.claimId;
  await admin.query(`INSERT INTO frame_instance_roles(id,owner_scope_id,frame_instance_id,role_id,entity_id,claim_id,created_at)
    VALUES($1,$2,$3,'creditor',$4,$5,$6)`, [randomUUID(), owner, obligationFrame, danielEntity, acceptedClaim, RECORDED_AT]);
  competingProposition = (await proposition({
    frameInstanceId: obligationFrame, beliefSlotId: principalSlot, value: { amount: '60.00', currency: 'ILS' },
    anchorId: second.anchorId, assessment: 'PROVISIONAL', claimOrigin: 'DOCUMENT_ASSERTION',
  })).propositionId;
  // A slot with no accepted value at all: the packet's `unknowns` entry.
  dueProposition = (await proposition({
    frameInstanceId: obligationFrame, beliefSlotId: dueSlot, value: { time: '2026-03-01T00:00:00.000Z' },
    anchorId: shared.anchorId,
  })).propositionId;
  // A value whose only support is RESTRICTED: withheld from a PRIVATE request.
  restrictedProposition = (await proposition({
    frameInstanceId: commitmentFrame, beliefSlotId: restrictedSlot, value: { time: '2026-04-01T00:00:00.000Z' },
    anchorId: restricted.anchorId, assessment: 'ACCEPTED',
  })).propositionId;

  // The contradiction the explanation reports beside the competing proposition.
  await admin.query(`INSERT INTO claim_relations(id,owner_scope_id,from_claim_id,to_claim_id,relation_kind,
    temporal_effect,created_by_transaction_id)
    SELECT $1,$2,c.id,$3,'CORRECTS','SAME_VALID_INTERVAL',$4 FROM claims c WHERE c.owner_scope_id=$2
      AND c.proposition_id=$5`, [randomUUID(), owner, acceptedClaim, transactionId, competingProposition]);

  // The accepted outcome authority over the obligation, and the link that carries it.
  const resolutionId = uuidV7(), linkId = uuidV7();
  await admin.query(`INSERT INTO memory_links(id,owner_scope_id,from_object_type,from_object_id,to_object_type,
    to_object_id,link_kind,lifecycle,transition_contract_id,transaction_id)
    VALUES($1,$2,'resolution_assertion',$3,'frame_instance',$4,'RESOLVES','ACTIVE','shared.obligation.resolution',$5)`,
    [linkId, owner, resolutionId, obligationFrame, transactionId]);
  await admin.query(`INSERT INTO resolution_assertions(id,owner_scope_id,source_frame_instance_id,outcome_code,
    effective_at,asserted_by_entity_id,claim_id,transition_contract_id,lifecycle,resolution_link_id,
    creation_transaction_id,recorded_at)
    VALUES($1,$2,$3,'PARTIALLY_FULFILLED',$4,$5,$6,'shared.obligation.resolution','ACCEPTED',$7,$8,$4)`,
    [resolutionId, owner, obligationFrame, new Date('2026-02-20T10:00:00.000Z'), danielEntity, acceptedClaim,
      linkId, transactionId]);

  // The typed projection over that obligation.
  await admin.query(`INSERT INTO obligations_projection(owner_scope_id,obligation_frame_instance_id,debtor_entity_id,
    creditor_entity_id,principal_amount,currency,total_canonical_allocation,remaining_amount_capability_derived,
    outcome_state,conflict_flag,overlay_complete,projection_version,canonical_transaction_watermark,
    owner_overlay_watermark,reducer_version,is_complete,source_manifest,updated_at)
    VALUES($1,$2,$3,$3,50.00,'ILS',0,50.00,'PARTIALLY_RESOLVED',true,true,$4,$5,0,'projection-reducers-0.1.0',true,'{}',$5)`,
    [owner, obligationFrame, danielEntity, uuidV7(), new Date('2026-02-20T10:00:00.000Z')]);

  financeThread = await thread(tx => createMemoryThread(tx, { ownerScopeId: owner, displayTitle: 'Daniel loan' }));
  familyThread = await thread(tx => createMemoryThread(tx, { ownerScopeId: owner, displayTitle: 'Family money' }));

  // Four unattached owner assertions, each reachable through exactly one of the
  // four intersections of PRD §21.4 (CRT-RYW-03-A).
  unattached.entity = await delta({ lifecycle: 'AWAITING_INSTANCE_RESOLUTION', rawText: 'I paid him back',
    evidenceId: sharedEvidence, candidateEntityRefs: [danielEntity] });
  unattached.thread = await delta({ lifecycle: 'AWAITING_INSTANCE_RESOLUTION', rawText: 'That is settled now',
    evidenceId: sharedEvidence, candidateWorldlineRefs: [financeThread] });
  unattached.anchor = await delta({ lifecycle: 'AWAITING_INSTANCE_RESOLUTION', rawText: 'Sorted in this thread',
    evidenceId: sharedEvidence, discourseAnchor: DISCOURSE_ANCHOR });
  unattached.frameType = await delta({ lifecycle: 'AWAITING_INSTANCE_RESOLUTION', rawText: 'The debt is closed',
    evidenceId: sharedEvidence, candidateFrameTypes: ['shared.obligation'] });
});
afterAll(async () => { await appPool.end(); await admin.end(); });

const brokerOptions = (overrides: Record<string, unknown> = {}) => ({
  correlationId: randomUUID(), now: NOW, registryReleaseId, registryRelease: '0.1.0', ...overrides,
});

it('CRT-RD-02-A: refuses a context request missing any required declaration before retrieval', async () => {
  // The check is a pure function over the raw body, so the route can refuse
  // before it opens a transaction. Each field is removed on its own.
  for (const field of ['purpose', 'requestingActorId', 'ownerScopeId', 'worldTime', 'knowledgeTime',
    'maximumSensitivity', 'actionRisk'] as const) {
    const body = request();
    delete body[field];
    expect(missingContextFields(body), field).toEqual([field]);
  }
  expect(missingContextFields(request())).toEqual([]);
  expect(missingContextFields(undefined).sort()).toEqual([...['actionRisk', 'knowledgeTime', 'maximumSensitivity',
    'ownerScopeId', 'purpose', 'requestingActorId', 'worldTime']]);

  // And the broker refuses too, so a caller that reaches it directly cannot skip
  // the declaration: no packet row is written and nothing was retrieved.
  const before = (await admin.query('SELECT count(*)::int AS n FROM context_packets WHERE owner_scope_id=$1', [owner])).rows[0].n;
  const body = request(); delete body['actionRisk'];
  await expect(read(tx => assembleContextPacket(tx, body, brokerOptions())))
    .rejects.toMatchObject({ message: 'CONTEXT_REQUEST_INCOMPLETE', detail: { missing: ['actionRisk'] } });
  expect((await admin.query('SELECT count(*)::int AS n FROM context_packets WHERE owner_scope_id=$1', [owner])).rows[0].n).toBe(before);
});

it('CRT-SEC-02-A: denies a purpose that is not in the evidence allowed purposes', async () => {
  await expect(readContextPacket(readRunner, request({ purpose: 'ADVERTISING' }), brokerOptions()))
    .rejects.toMatchObject({ message: 'CONTEXT_READ_DENIED', detail: { reason: 'PURPOSE_NOT_IN_ALLOWED_PURPOSES' } });
  // The denial is persisted like every other port decision: the verdict commits
  // in its own transaction before the refusal is raised, so a refused read is
  // still a recorded one. And no packet exists.
  const decision = (await admin.query(
    `SELECT outcome,reason,port FROM policy_decisions WHERE owner_scope_id=$1 AND port='EvaluateMemoryRead'
       AND reason='PURPOSE_NOT_IN_ALLOWED_PURPOSES' ORDER BY created_at DESC LIMIT 1`, [owner])).rows[0];
  expect(decision).toMatchObject({ outcome: 'DENY', reason: 'PURPOSE_NOT_IN_ALLOWED_PURPOSES' });
  expect((await admin.query("SELECT count(*)::int AS n FROM context_packets WHERE owner_scope_id=$1 AND purpose='ADVERTISING'", [owner])).rows[0].n).toBe(0);
  // A purpose the evidence does admit is not denied, through either entry point.
  const allowed = await readContextPacket(readRunner, request(), brokerOptions());
  expect(allowed.purpose).toBe(FINANCE_PURPOSE);
  expect(allowed.policy.policyDecisionId).toMatch(/^[0-9a-f-]{36}$/);
  expect((await read(tx => assembleContextPacket(tx, request(), brokerOptions()))).purpose).toBe(FINANCE_PURPOSE);
  // A denial reaching the single-transaction entry point still refuses; what it
  // cannot do is keep the record, which is why the route uses the runner.
  await expect(read(tx => assembleContextPacket(tx, request({ purpose: 'ADVERTISING' }), brokerOptions())))
    .rejects.toMatchObject({ message: 'CONTEXT_READ_DENIED' });

  // The action half of the criterion. An action request declaring no action
  // purpose is denied by the port outright, and so is one whose purpose the
  // evidence behind the supporting memory never admitted.
  const ports = createLocalPolicyAdapters();
  const base = { actorId: actor, ownerScopeId: owner, sensitivity: 'PRIVATE' as const, risk: 'MEDIUM' as const,
    evidenceRefs: [sharedEvidence], actionKind: 'DRAFT' as const, capabilityGranted: true,
    supportingAssessment: 'ACCEPTED' as const, projectionComplete: true };
  expect(await ports.evaluateMemoryAction({ ...base, purpose: '', allowedPurposes: ['memory.act'] }))
    .toMatchObject({ outcome: 'DENY', reason: 'PURPOSE_NOT_PERMITTED_FOR_ACTION' });
  expect(await ports.evaluateMemoryAction({ ...base, purpose: 'ADVERTISING', allowedPurposes: ['memory.act'] }))
    .toMatchObject({ outcome: 'DENY', reason: 'PURPOSE_NOT_PERMITTED_FOR_ACTION' });
  expect(await ports.evaluateMemoryAction({ ...base, purpose: 'memory.act', allowedPurposes: [] }))
    .toMatchObject({ outcome: 'DENY', reason: 'PURPOSE_NOT_IN_ALLOWED_PURPOSES' });
  expect(allowed.allowedActions).not.toContain('DRAFT');
  expect(allowed.actionDecision).toBeNull();

  // And the gate sits on this node's own surface, because the broker is the only
  // memory read path a model or a plugin has. This packet rests on two evidence
  // rows; only one of them admits FAMILY_COORDINATION, so the action declaring it
  // is denied -- an action founded on memory is bound by every item behind it.
  const packetsBefore = (await admin.query('SELECT count(*)::int AS n FROM context_packets WHERE owner_scope_id=$1', [owner])).rows[0].n;
  await expect(readContextPacket(readRunner, request({
    intendedAction: { actionKind: 'DRAFT', actionPurpose: FAMILY_PURPOSE, capabilityGranted: true },
  }), brokerOptions())).rejects.toMatchObject({
    message: 'CONTEXT_ACTION_DENIED', detail: { reason: 'PURPOSE_NOT_IN_ALLOWED_PURPOSES', actionKind: 'DRAFT' },
  });
  // The verdict is durable and the packet is not: a refused action is a recorded
  // refusal, and the memory it wanted to act on was never handed over.
  const actionDenial = (await admin.query(
    `SELECT outcome,reason,request FROM policy_decisions WHERE owner_scope_id=$1 AND port='EvaluateMemoryAction'
       ORDER BY created_at DESC,id DESC LIMIT 1`, [owner])).rows[0];
  expect(actionDenial).toMatchObject({ outcome: 'DENY', reason: 'PURPOSE_NOT_IN_ALLOWED_PURPOSES' });
  expect(actionDenial.request).toMatchObject({ actionKind: 'DRAFT', actionPurpose: FAMILY_PURPOSE,
    evidenceConsidered: 2, evidenceAdmittingActionPurpose: 1 });
  expect((await admin.query('SELECT count(*)::int AS n FROM context_packets WHERE owner_scope_id=$1', [owner])).rows[0].n)
    .toBe(packetsBefore);

  // The same action, with a purpose every evidence item behind that memory
  // admits, is decided on its merits instead of refused on its purpose. It is
  // still not permitted outright here, because the memory is contested and the
  // projection incomplete -- which is a different rule, and a different reason.
  const acting = await readContextPacket(readRunner, request({
    intendedAction: { actionKind: 'DRAFT', actionPurpose: FINANCE_PURPOSE, capabilityGranted: true },
  }), brokerOptions());
  expect(acting.actionDecision).toMatchObject({
    actionKind: 'DRAFT', actionPurpose: FINANCE_PURPOSE, outcome: 'REQUIRE_CONFIRMATION',
    reason: 'ACTION_ON_UNSETTLED_MEMORY', evidenceConsidered: 2,
  });
  expect(acting.allowedActions).not.toContain('DRAFT');
});

it('CRT-SEC-09-A: a PRIVATE request receives no RESTRICTED object and lists it only as a redaction', async () => {
  const packet = await read(tx => assembleContextPacket(tx, request({ maximumSensitivity: 'PRIVATE' }), brokerOptions()));
  expect(packet.policy.outcome).toBe('REDACT');
  const supplied = [...packet.currentBeliefs, ...packet.historicalBeliefs].map(belief => belief.propositionId);
  expect(supplied).not.toContain(restrictedProposition);
  expect(packet.evidenceRefs.map(reference => reference.evidenceId)).not.toContain(restrictedEvidence);
  expect(packet.evidenceRefs.every(reference => reference.sensitivity !== 'RESTRICTED')).toBe(true);
  // ...and it is listed. Both the item and the value it supported are named, with
  // no field of either carried.
  expect(packet.redactions).toContainEqual({
    objectType: 'source_items', objectId: restrictedEvidence, fields: [], reason: 'ABOVE_MAXIMUM_SENSITIVITY',
  });
  expect(packet.redactions).toContainEqual({
    objectType: 'propositions', objectId: restrictedProposition, fields: [], reason: 'SUPPORTING_EVIDENCE_WITHHELD',
  });
  expect(packet.unknowns).toContainEqual({
    kind: 'EVIDENCE_WITHHELD', objectType: 'source_items', objectId: restrictedEvidence,
    detail: 'ABOVE_MAXIMUM_SENSITIVITY',
  });
  expect(JSON.stringify(packet)).not.toContain('2026-04-01T00:00:00.000Z');

  // The same request at the RESTRICTED ceiling receives it, which is what makes
  // the refusal above a decision rather than an absence.
  const full = await read(tx => assembleContextPacket(tx, request({ maximumSensitivity: 'RESTRICTED' }), brokerOptions()));
  expect(full.policy.outcome).toBe('ALLOW');
  expect([...full.currentBeliefs, ...full.historicalBeliefs].map(belief => belief.propositionId)).toContain(restrictedProposition);
});

it('CRT-WRT-03-B: an EvaluateMemoryRead REDACT removes the named fields and lists them', async () => {
  // The port is the authority. This one answers REDACT over two named fields of
  // one belief -- the shape a Cordum adapter returns (PRD §29.3, §29.4) -- and
  // the broker has to honour it without being told which object it was about.
  const redacting: PolicyPorts = {
    ...createLocalPolicyAdapters(),
    async evaluateMemoryRead(): Promise<PolicyVerdict> {
      return {
        outcome: 'REDACT', requiredConfirmation: false, obligations: [], expiry: null,
        reason: 'FIELD_LEVEL_REDACTION_REQUIRED', policyVersion: 'test-policy-0.1.0',
        redactions: [{ objectType: 'propositions', objectId: acceptedProposition,
          fields: ['normalizedValue', 'evidenceIds'], reason: 'FIELD_WITHHELD_BY_POLICY' }],
      };
    },
  };
  const packet = await read(tx => assembleContextPacket(tx, request({ maximumSensitivity: 'RESTRICTED' }),
    brokerOptions({ ports: redacting })));
  const belief = [...packet.currentBeliefs, ...packet.historicalBeliefs]
    .find(entry => entry.propositionId === acceptedProposition);
  expect(belief).toBeDefined();
  // Removed, not emptied: the keys are absent from the packet.
  expect(Object.keys(belief!)).not.toContain('normalizedValue');
  expect(Object.keys(belief!)).not.toContain('evidenceIds');
  expect(belief!.certainty).toBe('ACCEPTED');
  expect(packet.redactions).toContainEqual({
    objectType: 'propositions', objectId: acceptedProposition,
    fields: ['normalizedValue', 'evidenceIds'], reason: 'FIELD_WITHHELD_BY_POLICY',
  });
  expect(JSON.stringify(packet.currentBeliefs)).not.toContain('50.00');
  // The conflict states the same value a second time, so the redaction reaches it
  // too: the position is still a side of the disagreement, without the field.
  const position = packet.conflicts.flatMap(entry => entry.positions)
    .find(entry => entry.propositionId === acceptedProposition);
  expect(position).toBeDefined();
  expect(Object.keys(position!)).not.toContain('normalizedValue');
  expect(Object.keys(position!)).not.toContain('evidenceIds');
  expect(position!.assessmentStatus).toBe('ACCEPTED');
  // Nowhere in the packet at all, which is the whole of what a redaction means.
  expect(JSON.stringify(packet)).not.toContain('50.00');
  // The stored packet says the same thing as the answer.
  const stored = (await admin.query('SELECT packet FROM context_packets WHERE id=$1', [packet.packetId])).rows[0].packet;
  expect(JSON.stringify(stored)).not.toContain('50.00');
});

it('CRT-RD-05-A: the packet carries conflicts, unknowns, overlay deltas, projection completeness and watermarks', async () => {
  const packet = await read(tx => assembleContextPacket(tx, request({
    maximumSensitivity: 'RESTRICTED', entityHints: [danielEntity], frameTypeHints: ['shared.obligation'],
    worldlineHints: [financeThread], discourseAnchors: [DISCOURSE_ANCHOR],
  }), brokerOptions()));

  // A conflict: two live values in one slot, both retained, neither chosen.
  expect(packet.conflicts.length).toBeGreaterThan(0);
  const conflict = packet.conflicts.find(entry => entry.beliefSlotId === principalSlot);
  expect(conflict?.positions.map(position => position.propositionId).sort())
    .toEqual([acceptedProposition, competingProposition].sort());
  expect(conflict?.reason).toBe('COMPETING_LIVE_PROPOSITIONS_IN_ONE_SLOT');

  // An unknown: a slot with no accepted value, plus the unattached assertions and
  // the incomplete projection.
  expect(packet.unknowns.length).toBeGreaterThan(0);
  expect(packet.unknowns).toContainEqual({ kind: 'NO_ACCEPTED_VALUE', objectType: 'belief_slots',
    objectId: dueSlot, detail: 'NO_ACCEPTED_ASSESSMENT' });
  expect(packet.unknowns.some(unknown => unknown.kind === 'UNATTACHED_OWNER_ASSERTION')).toBe(true);
  expect(packet.unknowns.some(unknown => unknown.kind === 'PROJECTION_INCOMPLETE')).toBe(true);

  // A pending overlay.
  expect(packet.ownerOverlayDeltas.length).toBeGreaterThan(0);
  expect(packet.ownerOverlayDeltas.every(entry => entry.assertionKind === 'USER_ASSERTION')).toBe(true);

  // Projection completeness, per projection, with its reducer version.
  expect(packet.projectionFragments.length).toBe(3);
  const obligations = packet.projectionFragments.find(fragment => fragment.projectionName === 'obligations_projection');
  expect(obligations?.frameInstanceIds).toContain(obligationFrame);
  expect(obligations?.isComplete).toBe(false);
  expect(obligations?.pendingAssertions.length).toBeGreaterThan(0);
  expect(obligations?.highRiskActionsBlocked).toBe(true);

  // Watermarks, and the deterministic reason the state was selected.
  expect(packet.watermarks.ownerOverlayWatermark).toBeGreaterThan(0);
  expect(packet.watermarks.knowledgeTime).toBe(NOW.toISOString());
  expect(packet.watermarks.registryRelease).toBe('0.1.0');
  expect(Object.keys(packet.watermarks.projectionVersions).sort())
    .toEqual(['obligations_projection', 'open_commitments_projection', 'schedule_projection']);
  expect(packet.selectionReason.appliedRules).toContain('FILTER_VALID_TIME');
  expect(packet.selectionReason.selectorVersion).toMatch(/^deterministic-selector/);
  expect(packet.answerType).toBe('OPEN_COMMITMENTS');
  // A packet that carries a conflict and an incomplete projection offers no draft.
  expect(packet.allowedActions).toEqual(['ANSWER_WITH_CITATIONS']);

  // The packet is persisted with its hash, under the request that produced it.
  const stored = (await admin.query('SELECT packet_hash,answer_type_classification,purpose,registry_release_id FROM context_packets WHERE id=$1',
    [packet.packetId])).rows[0];
  expect(stored).toMatchObject({ packet_hash: packet.packetHash, answer_type_classification: 'OPEN_COMMITMENTS',
    purpose: FINANCE_PURPOSE, registry_release_id: registryReleaseId });
});

it('CRT-RYW-03-A: an unattached AWAITING_INSTANCE_RESOLUTION delta is returned by each intersection on its own', async () => {
  const intersections = [
    ['candidate entity', { entityHints: [danielEntity] }, unattached.entity],
    ['candidate memory thread', { worldlineHints: [financeThread] }, unattached.thread],
    ['discourse anchor', { discourseAnchors: [DISCOURSE_ANCHOR] }, unattached.anchor],
    ['candidate frame type', { frameTypeHints: ['shared.obligation'] }, unattached.frameType],
  ] as const;
  for (const [name, hint, expected] of intersections) {
    const packet = await read(tx => assembleContextPacket(tx, request({ maximumSensitivity: 'RESTRICTED', ...hint }),
      brokerOptions()));
    const returned = packet.ownerOverlayDeltas.map(entry => entry.overlayDeltaId);
    expect(returned, name).toContain(expected);
    // Only the one this query intersects: the other three are not swept in.
    for (const other of Object.values(unattached).filter(id => id !== expected)) {
      expect(returned, name + ' excludes the others').not.toContain(other);
    }
    const delta = packet.ownerOverlayDeltas.find(entry => entry.overlayDeltaId === expected)!;
    expect(delta.lifecycle, name).toBe('AWAITING_INSTANCE_RESOLUTION');
    expect(delta.attachedFrameInstanceId, name).toBeNull();
    expect(packet.unknowns, name).toContainEqual({ kind: 'UNATTACHED_OWNER_ASSERTION',
      objectType: 'owner_overlay_deltas', objectId: expected, detail: 'AWAITING_INSTANCE_RESOLUTION' });
  }
});

it('CRT-MEM-02-A: one evidence row and one set of semantic objects appear in the finance and the family view', async () => {
  const rows = (await admin.query('SELECT count(*)::int AS n FROM source_items WHERE owner_scope_id=$1 AND external_id=$2',
    [owner, 'shared-item'])).rows[0].n;
  expect(rows).toBe(1);

  const finance = await read(tx => assembleContextPacket(tx, request({
    purpose: FINANCE_PURPOSE, lifeCategory: 'FINANCE', maximumSensitivity: 'RESTRICTED',
  }), brokerOptions()));
  const family = await read(tx => assembleContextPacket(tx, request({
    purpose: FAMILY_PURPOSE, lifeCategory: 'FAMILY', maximumSensitivity: 'RESTRICTED',
  }), brokerOptions()));

  const inFinance = finance.currentBeliefs.find(belief => belief.propositionId === acceptedProposition);
  const inFamily = family.currentBeliefs.find(belief => belief.propositionId === acceptedProposition);
  expect(inFinance, 'finance view').toBeDefined();
  expect(inFamily, 'family view').toBeDefined();
  // The same object, from the same evidence row, in both views.
  expect(inFinance!.evidenceIds).toEqual([sharedEvidence]);
  expect(inFamily!.evidenceIds).toEqual([sharedEvidence]);
  expect(inFinance!.lifeCategories).toContain('FINANCE');
  expect(inFamily!.lifeCategories).toContain('FAMILY');
  expect(finance.evidenceRefs.find(reference => reference.evidenceId === sharedEvidence)?.lifeCategories.sort())
    .toEqual(['FAMILY', 'FINANCE']);

  // Nothing was duplicated by being viewed twice.
  expect((await admin.query('SELECT count(*)::int AS n FROM source_items WHERE owner_scope_id=$1', [owner])).rows[0].n).toBe(3);
  expect((await admin.query('SELECT count(*)::int AS n FROM propositions WHERE owner_scope_id=$1 AND belief_slot_id=$2',
    [owner, principalSlot])).rows[0].n).toBe(2);

  // A value whose evidence admits only the finance purpose is not in the family
  // view: the view is derived, and it is derived from what was actually declared.
  expect(family.currentBeliefs.map(belief => belief.propositionId)).not.toContain(competingProposition);
  expect(finance.currentBeliefs.map(belief => belief.propositionId)).toContain(competingProposition);

  // The catalog itself is a declared rule, not a heuristic over text.
  expect(deriveLifeCategories({ frameTypeId: 'finance.payment_allocation' })).toContain('FINANCE');
  expect(deriveLifeCategories({ allowedPurposes: [FAMILY_PURPOSE, FINANCE_PURPOSE] }).sort())
    .toEqual(['FAMILY', 'FINANCE']);
  expect(classifyAnswerType('Why did I decide that?')).toBe('CAUSAL_EXPLANATION');
});

it('CRT-RD-09-A: explain returns the assessment, claims, anchors, support, contradictions, history, resolutions, versions and consumers', async () => {
  const explanation = await inspect(async tx => {
    await tx.query("SELECT set_config('unai.data_purpose',$1,true),set_config('unai.maximum_sensitivity','RESTRICTED',true)",
      [FINANCE_PURPOSE]);
    return explainProposition(tx, { ownerScopeId: owner, propositionId: acceptedProposition, readAt: NOW, registryRelease: '0.1.0' });
  });

  expect(explanation.currentAssessment.assessmentStatus).toBe('ACCEPTED');
  expect(explanation.currentAssessment.policyVersion).toBe('local-policy-0.1.0');
  expect(explanation.claims.map(claim => claim.claimId)).toContain(acceptedClaim);
  expect(explanation.claims[0]?.claimOrigin).toBe('USER_STATEMENT');
  expect(explanation.evidenceAnchors.map(anchor => anchor.evidenceId)).toContain(sharedEvidence);
  expect(explanation.evidenceAnchors[0]?.claimIds).toContain(acceptedClaim);
  expect(explanation.supportGraph.length).toBeGreaterThan(0);
  expect(explanation.supportGraph[0]?.supportKind).toBe('DIRECT_ASSERTION');
  expect(explanation.independenceGroups.length).toBeGreaterThan(0);
  // Both a competing proposition and the recorded claim relation are reported.
  expect(explanation.contradictions.map(entry => entry.kind)).toContain('COMPETING_PROPOSITION');
  expect(explanation.contradictions.map(entry => entry.kind)).toContain('CLAIM_RELATION');
  expect(explanation.contradictions.find(entry => entry.kind === 'COMPETING_PROPOSITION')?.objectId)
    .toBe(competingProposition);
  expect(explanation.temporalHistory.length).toBeGreaterThan(0);
  expect(explanation.temporalHistory[0]).toMatchObject({ assessmentStatus: 'ACCEPTED', supersededRecordedAt: null });
  expect(explanation.resolutionLinks.some(link => link.objectType === 'resolution_assertion'
    && link.outcomeCode === 'PARTIALLY_FULFILLED')).toBe(true);
  expect(explanation.resolutionLinks.some(link => link.objectType === 'memory_link')).toBe(true);
  expect(explanation.registryVersions).toMatchObject({
    registryReleaseId, registryRelease: '0.1.0', normalizationVersion: 'normalization-1',
  });
  expect(explanation.extractorVersions).toContainEqual(expect.objectContaining({
    extractionRunId, promptVersion: 'surface-frames-0.1.0', entityResolverVersion: 'entity-resolver-1',
  }));
  expect(explanation.projectionConsumers.map(consumer => consumer.projectionName)).toContain('obligations_projection');
  expect(explanation.projectionConsumers[0]?.frameInstanceId).toBe(obligationFrame);
  expect(explanation.explanationVersion).toMatch(/^belief-explanation/);

  await expect(inspect(tx => explainProposition(tx, {
    ownerScopeId: owner, propositionId: randomUUID(), readAt: NOW,
  }))).rejects.toMatchObject({ message: 'PROPOSITION_NOT_FOUND' });
});

it('CRT-RD-10-A: one evidence-backed object joins two threads and appears in both without a second evidence row', async () => {
  const before = (await admin.query('SELECT count(*)::int AS n FROM source_items WHERE owner_scope_id=$1', [owner])).rows[0].n;
  const beforeClaims = (await admin.query('SELECT count(*)::int AS n FROM claims WHERE owner_scope_id=$1', [owner])).rows[0].n;

  const first = await thread(tx => addThreadMember(tx, {
    ownerScopeId: owner, memoryThreadId: financeThread,
    member: { objectType: 'frame_instance', objectId: obligationFrame, membershipKind: 'SUBJECT', confidence: null, transactionId: null },
  }));
  const second = await thread(tx => addThreadMember(tx, {
    ownerScopeId: owner, memoryThreadId: familyThread,
    member: { objectType: 'frame_instance', objectId: obligationFrame, membershipKind: 'RELATED', confidence: 0.8, transactionId: null },
  }));
  expect(first.created).toBe(true);
  expect(second.created).toBe(true);
  // Repeating the attach is the same single membership row.
  expect((await thread(tx => addThreadMember(tx, {
    ownerScopeId: owner, memoryThreadId: familyThread,
    member: { objectType: 'frame_instance', objectId: obligationFrame, membershipKind: 'RELATED', confidence: 0.8, transactionId: null },
  }))).created).toBe(false);

  const financeView = await inspect(async tx => {
    await tx.query("SELECT set_config('unai.data_purpose',$1,true),set_config('unai.maximum_sensitivity','RESTRICTED',true)", [FINANCE_PURPOSE]);
    return readMemoryThread(tx, { ownerScopeId: owner, memoryThreadId: financeThread, readAt: NOW });
  });
  const familyView = await inspect(async tx => {
    await tx.query("SELECT set_config('unai.data_purpose',$1,true),set_config('unai.maximum_sensitivity','RESTRICTED',true)", [FINANCE_PURPOSE]);
    return readMemoryThread(tx, { ownerScopeId: owner, memoryThreadId: familyThread, readAt: NOW });
  });

  expect(financeView.members.map(member => member.objectId)).toContain(obligationFrame);
  expect(familyView.members.map(member => member.objectId)).toContain(obligationFrame);
  // The same evidence, read from the object's own claims, reported by both.
  expect(financeView.evidenceIds.sort()).toEqual(familyView.evidenceIds.sort());
  expect(financeView.evidenceIds).toContain(sharedEvidence);
  // And nothing was created by the second membership.
  expect((await admin.query('SELECT count(*)::int AS n FROM source_items WHERE owner_scope_id=$1', [owner])).rows[0].n).toBe(before);
  expect((await admin.query('SELECT count(*)::int AS n FROM claims WHERE owner_scope_id=$1', [owner])).rows[0].n).toBe(beforeClaims);
  expect((await admin.query(`SELECT count(*)::int AS n FROM memory_thread_members WHERE owner_scope_id=$1
    AND object_id=$2`, [owner, obligationFrame])).rows[0].n).toBe(2);

  // The thread view is the situation, computed from memory and storing none of it.
  expect(financeView.currentProjection.map(fragment => fragment.projectionName)).toContain('obligations_projection');
  expect(financeView.actualEvents.map(event => event.propositionId)).toContain(acceptedProposition);
  expect(financeView.resolutionLinks.some(link => link.outcomeCode === 'PARTIALLY_FULFILLED')).toBe(true);
  expect(financeView.openUncertainties.some(unknown => unknown.objectId === dueProposition)).toBe(true);
  expect(financeView.relatedPeople.map(person => person.entityId)).toContain(danielEntity);
  expect(financeView.timeline.some(entry => entry.kind === 'EVIDENCE')).toBe(true);
  expect(financeView.timeline.some(entry => entry.kind === 'RESOLUTION')).toBe(true);

  // A thread that does not exist, and an object that does not, are refusals.
  await expect(thread(tx => addThreadMember(tx, {
    ownerScopeId: owner, memoryThreadId: randomUUID(),
    member: { objectType: 'frame_instance', objectId: obligationFrame, membershipKind: 'SUBJECT', confidence: null, transactionId: null },
  }))).rejects.toMatchObject({ message: 'MEMORY_THREAD_NOT_FOUND' });
  await expect(thread(tx => addThreadMember(tx, {
    ownerScopeId: owner, memoryThreadId: financeThread,
    member: { objectType: 'proposition', objectId: randomUUID(), membershipKind: 'RELATED', confidence: null, transactionId: null },
  }))).rejects.toMatchObject({ message: 'MEMORY_THREAD_OBJECT_NOT_FOUND' });
  await expect(inspect(tx => readMemoryThread(tx, {
    ownerScopeId: owner, memoryThreadId: randomUUID(), readAt: NOW,
  }))).rejects.toMatchObject({ message: 'MEMORY_THREAD_NOT_FOUND' });
});

it('writes nothing canonical: the broker holds a read purpose and only records its packet', async () => {
  const propositions = (await admin.query('SELECT count(*)::int AS n FROM propositions WHERE owner_scope_id=$1', [owner])).rows[0].n;
  const deltas = (await admin.query('SELECT count(*)::int AS n FROM owner_overlay_deltas WHERE owner_scope_id=$1', [owner])).rows[0].n;
  await read(tx => assembleContextPacket(tx, request({ maximumSensitivity: 'RESTRICTED' }), brokerOptions()));
  expect((await admin.query('SELECT count(*)::int AS n FROM propositions WHERE owner_scope_id=$1', [owner])).rows[0].n).toBe(propositions);
  expect((await admin.query('SELECT count(*)::int AS n FROM owner_overlay_deltas WHERE owner_scope_id=$1', [owner])).rows[0].n).toBe(deltas);
  // The read purpose cannot write memory even when asked directly.
  await expect(read(tx => tx.query(
    "INSERT INTO propositions(id,owner_scope_id,belief_slot_id,normalized_value) VALUES($1,$2,$3,'{}')",
    [uuidV7(), owner, principalSlot]))).rejects.toMatchObject({ code: '42501' });
  const error = await read(tx => assembleContextPacket(tx, request(), brokerOptions()))
    .then(() => null).catch((caught: unknown) => caught);
  expect(error === null || error instanceof ContextBrokerError).toBe(true);
});

async function packetSurfaces(packet: { packetId: string }): Promise<string[]> {
  const stored = (await admin.query('SELECT packet FROM context_packets WHERE id=$1', [packet.packetId])).rows[0].packet;
  return [JSON.stringify(packet), JSON.stringify(stored)];
}

it('withholds attached and unattached owner assertion text when their source exceeds the sensitivity ceiling', async () => {
  const attachedMarker = 'restricted-attached-assertion-marker';
  const unattachedMarker = 'restricted-unattached-assertion-marker';
  await delta({ lifecycle: 'CANONICALIZATION_PENDING', rawText: attachedMarker,
    evidenceId: restrictedEvidence, attachedFrameInstanceId: obligationFrame });
  await delta({ lifecycle: 'AWAITING_INSTANCE_RESOLUTION', rawText: unattachedMarker,
    evidenceId: restrictedEvidence, candidateEntityRefs: [danielEntity] });

  const packet = await read(tx => assembleContextPacket(tx, request({ entityHints: [danielEntity] }), brokerOptions()));
  expect(packet.currentBeliefs.some(belief => belief.propositionId === acceptedProposition)).toBe(true);
  for (const surface of await packetSurfaces(packet)) {
    expect(surface).not.toContain(attachedMarker);
    expect(surface).not.toContain(unattachedMarker);
  }
  const permitted = await read(tx => assembleContextPacket(tx,
    request({ entityHints: [danielEntity], maximumSensitivity: 'RESTRICTED' }), brokerOptions()));
  for (const surface of await packetSurfaces(permitted)) {
    expect(surface).toContain(attachedMarker);
    expect(surface).toContain(unattachedMarker);
  }
});

it('withholds an owner assertion with a forbidden data purpose while still retrieving permitted control context', async () => {
  const marker = 'family-only-owner-assertion-marker';
  const source = await evidence({ sensitivity: 'PRIVATE', allowedPurposes: [FAMILY_PURPOSE], externalId: 'family-only-control' });
  await delta({ lifecycle: 'CANONICALIZATION_PENDING', rawText: marker,
    evidenceId: source.evidenceId, attachedFrameInstanceId: obligationFrame });
  const packet = await read(tx => assembleContextPacket(tx, request(), brokerOptions()));
  expect(packet.currentBeliefs.some(belief => belief.propositionId === acceptedProposition)).toBe(true);
  for (const surface of await packetSurfaces(packet)) expect(surface).not.toContain(marker);
  const permitted = await read(tx => assembleContextPacket(tx, request({ purpose: FAMILY_PURPOSE }), brokerOptions()));
  for (const surface of await packetSurfaces(permitted)) expect(surface).toContain(marker);
});

it.each(['ACTUAL', 'COMMITTED'])('excludes a later-recorded %s value from the whole historical packet', async modality => {
  const marker = 'knowledge-future-value-' + modality;
  const futureRecordedAt = new Date('2026-04-01T09:00:00.000Z');
  const source = await evidence({ sensitivity: 'PRIVATE', allowedPurposes: [FINANCE_PURPOSE], externalId: 'late-source-' + modality });
  const futureSlot = await slot(commitmentFrame, 'shared.commitment.action_description', modality);
  const value = await proposition({ frameInstanceId: commitmentFrame, beliefSlotId: futureSlot,
    value: { text: marker }, anchorId: source.anchorId, recordedAt: futureRecordedAt });
  const packet = await read(tx => assembleContextPacket(tx, request({
    answerType: 'HISTORICAL_BELIEF_STATE', knowledgeTime: NOW.toISOString(), lifeCategory: 'PERSONAL',
    requiredCertainty: ['ACCEPTED', 'PROVISIONAL', 'CONTESTED', 'OWNER_OVERLAY'],
  }), brokerOptions()));
  expect(packet.currentBeliefs.some(belief => belief.propositionId === acceptedProposition)).toBe(true);
  for (const surface of await packetSurfaces(packet)) expect(surface).not.toContain(marker);
  const corrected = await read(tx => assembleContextPacket(tx, request({
    answerType: 'CORRECTED_HISTORICAL_VALUE', worldTime: NOW.toISOString(), knowledgeTime: 'LATEST', lifeCategory: 'PERSONAL',
    requiredCertainty: ['ACCEPTED', 'PROVISIONAL', 'CONTESTED', 'OWNER_OVERLAY'],
  }), brokerOptions({ now: new Date('2026-04-02T09:00:00.000Z') })));
  expect([...corrected.currentBeliefs, ...corrected.historicalBeliefs, ...corrected.futureClaims]
    .some(belief => belief.propositionId === value.propositionId)).toBe(true);
  for (const surface of await packetSurfaces(corrected)) expect(surface).toContain(marker);
});

it('excludes later owner assertions from historical packets and their projection pending text', async () => {
  const marker = 'knowledge-future-owner-assertion-marker';
  await delta({ lifecycle: 'CANONICALIZATION_PENDING', rawText: marker, evidenceId: sharedEvidence,
    attachedFrameInstanceId: obligationFrame, createdAt: new Date('2026-04-01T09:00:00.000Z') });
  const packet = await read(tx => assembleContextPacket(tx, request({
    answerType: 'HISTORICAL_BELIEF_STATE', knowledgeTime: NOW.toISOString(),
  }), brokerOptions()));
  for (const surface of await packetSurfaces(packet)) expect(surface).not.toContain(marker);
  const later = await read(tx => assembleContextPacket(tx, request(),
    brokerOptions({ now: new Date('2026-04-02T09:00:00.000Z') })));
  expect(later.ownerOverlayDeltas.some(delta => delta.rawText === marker)).toBe(true);
});

it('does not present a known but not-yet-effective actual value as current', async () => {
  const marker = 'not-yet-effective-current-value-marker';
  const futureSlot = await slot(commitmentFrame, 'shared.commitment.action_description');
  const source = await evidence({ sensitivity: 'PRIVATE', allowedPurposes: [FINANCE_PURPOSE], externalId: 'future-effective-source' });
  const value = await proposition({ frameInstanceId: commitmentFrame, beliefSlotId: futureSlot,
    value: { text: marker }, anchorId: source.anchorId, validFrom: new Date('2026-04-01T09:00:00.000Z') });
  const current = await read(tx => assembleContextPacket(tx, request(), brokerOptions()));
  expect(current.currentBeliefs.map(belief => belief.propositionId)).not.toContain(value.propositionId);
  expect(current.historicalBeliefs.map(belief => belief.propositionId)).not.toContain(value.propositionId);
  const applicable = await read(tx => assembleContextPacket(tx, request({ worldTime: '2026-04-02T09:00:00.000Z' }), brokerOptions()));
  expect(applicable.currentBeliefs.map(belief => belief.propositionId)).toContain(value.propositionId);
});

it('excludes a late-recorded resolution from historical context while preserving corrected history', async () => {
  const resolutionId = uuidV7(), linkId = uuidV7();
  await admin.query(`INSERT INTO memory_links(id,owner_scope_id,from_object_type,from_object_id,to_object_type,
    to_object_id,link_kind,lifecycle,transition_contract_id,transaction_id)
    VALUES($1,$2,'resolution_assertion',$3,'frame_instance',$4,'RESOLVES','ACTIVE','shared.obligation.resolution',$5)`,
    [linkId, owner, resolutionId, obligationFrame, transactionId]);
  await admin.query(`INSERT INTO resolution_assertions(id,owner_scope_id,source_frame_instance_id,outcome_code,
    effective_at,asserted_by_entity_id,claim_id,transition_contract_id,lifecycle,resolution_link_id,
    creation_transaction_id,recorded_at)
    VALUES($1,$2,$3,'FULFILLED',$4,$5,$6,'shared.obligation.resolution','ACCEPTED',$7,$8,$9)`,
    [resolutionId, owner, obligationFrame, new Date('2026-02-25T10:00:00.000Z'), danielEntity, acceptedClaim,
      linkId, transactionId, new Date('2026-04-01T09:00:00.000Z')]);
  const historical = await read(tx => assembleContextPacket(tx, request({
    answerType: 'HISTORICAL_BELIEF_STATE', knowledgeTime: NOW.toISOString(),
  }), brokerOptions()));
  expect(historical.resolutionAssertions.map(resolution => resolution.resolutionAssertionId)).not.toContain(resolutionId);
  expect(historical.resolutionAssertions.some(resolution => resolution.outcomeCode === 'PARTIALLY_FULFILLED')).toBe(true);
  const corrected = await read(tx => assembleContextPacket(tx, request({ worldTime: NOW.toISOString() }),
    brokerOptions({ now: new Date('2026-04-02T09:00:00.000Z') })));
  expect(corrected.resolutionAssertions.map(resolution => resolution.resolutionAssertionId)).toContain(resolutionId);
});

it.each(['sensitivity', 'purpose'])('Why withholds owner assertion text denied by source %s', async boundary => {
  const marker = 'why-protected-owner-assertion-' + boundary;
  const controlMarker = 'why-readable-owner-assertion-' + boundary;
  const hiddenSource = boundary === 'sensitivity' ? restrictedEvidence
    : (await evidence({ sensitivity: 'PRIVATE', allowedPurposes: [FAMILY_PURPOSE], externalId: 'why-family-only' })).evidenceId;
  const protectedDelta = await delta({ lifecycle: 'USER_ASSERTED', rawText: marker,
    evidenceId: hiddenSource, attachedFrameInstanceId: obligationFrame });
  const controlDelta = await delta({ lifecycle: 'USER_ASSERTED', rawText: controlMarker,
    evidenceId: sharedEvidence, attachedFrameInstanceId: obligationFrame });
  const panel = (overlayDeltaId: string, purpose: string, ceiling: string) => inspect(async tx => {
    await tx.query("SELECT set_config('unai.data_purpose',$1,true),set_config('unai.maximum_sensitivity',$2,true)", [purpose, ceiling]);
    return readWhySources(tx, { ownerScopeId: owner, ref: { objectType: 'owner_overlay_deltas', objectId: overlayDeltaId }, readAt: NOW });
  });
  const denied = await panel(protectedDelta, FINANCE_PURPOSE, 'PRIVATE');
  expect(denied.sources).toEqual([]);
  expect(denied.redactions).toContainEqual({ claimId: null, reason: 'SOURCE_NOT_READABLE_FOR_THIS_REQUEST' });
  expect(JSON.stringify(denied)).not.toContain(marker);
  expect((await panel(controlDelta, FINANCE_PURPOSE, 'PRIVATE')).statement).toContain(controlMarker);
  expect((await panel(protectedDelta, boundary === 'purpose' ? FAMILY_PURPOSE : FINANCE_PURPOSE, 'RESTRICTED')).statement)
    .toContain(marker);
});

it.each(['sensitivity', 'purpose'])('thread projection fragments withhold pending assertion text denied by source %s', async boundary => {
  const marker = 'thread-protected-pending-assertion-' + boundary;
  const controlMarker = 'thread-readable-pending-assertion-' + boundary;
  const hiddenSource = boundary === 'sensitivity' ? restrictedEvidence
    : (await evidence({ sensitivity: 'PRIVATE', allowedPurposes: [FAMILY_PURPOSE], externalId: 'thread-family-only' })).evidenceId;
  await delta({ lifecycle: 'CANONICALIZATION_PENDING', rawText: marker,
    evidenceId: hiddenSource, attachedFrameInstanceId: obligationFrame });
  await delta({ lifecycle: 'CANONICALIZATION_PENDING', rawText: controlMarker,
    evidenceId: sharedEvidence, attachedFrameInstanceId: obligationFrame });
  await thread(tx => addThreadMember(tx, { ownerScopeId: owner, memoryThreadId: financeThread,
    member: { objectType: 'frame_instance', objectId: obligationFrame, membershipKind: 'SUBJECT', confidence: null, transactionId: null } }));
  const view = (purpose: string, ceiling: string) => inspect(async tx => {
    await tx.query("SELECT set_config('unai.data_purpose',$1,true),set_config('unai.maximum_sensitivity',$2,true)", [purpose, ceiling]);
    return readMemoryThread(tx, { ownerScopeId: owner, memoryThreadId: financeThread, readAt: NOW });
  });
  const denied = await view(FINANCE_PURPOSE, 'PRIVATE');
  expect(JSON.stringify(denied.currentProjection)).toContain(controlMarker);
  expect(JSON.stringify(denied)).not.toContain(marker);
  const allowed = await view(boundary === 'purpose' ? FAMILY_PURPOSE : FINANCE_PURPOSE, 'RESTRICTED');
  expect(JSON.stringify(allowed.currentProjection)).toContain(marker);
  expect(JSON.stringify(allowed.currentProjection)).toContain(controlMarker);
});

it.each(['sensitivity', 'purpose'])('Why withholds canonical and resolution details denied by source %s', async boundary => {
  const marker = 'why-protected-canonical-description-' + boundary;
  const source = await evidence({ sensitivity: boundary === 'sensitivity' ? 'RESTRICTED' : 'PRIVATE',
    allowedPurposes: [boundary === 'purpose' ? FAMILY_PURPOSE : FINANCE_PURPOSE], externalId: marker });
  const hiddenSlot = await slot(obligationFrame, 'shared.obligation.description');
  const value = await proposition({ frameInstanceId: obligationFrame, beliefSlotId: hiddenSlot,
    value: { text: marker }, anchorId: source.anchorId, assessment: 'ACCEPTED' });
  const resolutionId = uuidV7(), linkId = uuidV7();
  const effectiveAt = new Date('2026-02-23T11:22:33.000Z');
  await admin.query(`INSERT INTO memory_links(id,owner_scope_id,from_object_type,from_object_id,to_object_type,
    to_object_id,link_kind,lifecycle,transition_contract_id,transaction_id)
    VALUES($1,$2,'resolution_assertion',$3,'frame_instance',$4,'RESOLVES','ACTIVE','shared.obligation.resolution',$5)`,
    [linkId, owner, resolutionId, obligationFrame, transactionId]);
  await admin.query(`INSERT INTO resolution_assertions(id,owner_scope_id,source_frame_instance_id,outcome_code,
    effective_at,asserted_by_entity_id,claim_id,transition_contract_id,lifecycle,resolution_link_id,
    creation_transaction_id,recorded_at)
    VALUES($1,$2,$3,'WAIVED',$4,$5,$6,'shared.obligation.resolution','ACCEPTED',$7,$8,$4)`,
    [resolutionId, owner, obligationFrame, effectiveAt, danielEntity, value.claimId, linkId, transactionId]);
  const panel = (objectType: 'propositions' | 'resolution_assertions', objectId: string, purpose: string, ceiling: string) => inspect(async tx => {
    await tx.query("SELECT set_config('unai.data_purpose',$1,true),set_config('unai.maximum_sensitivity',$2,true)", [purpose, ceiling]);
    return readWhySources(tx, { ownerScopeId: owner, ref: { objectType, objectId }, readAt: NOW });
  });
  const denied = await panel('propositions', value.propositionId, FINANCE_PURPOSE, 'PRIVATE');
  expect(denied.sources).toEqual([]);
  expect(denied.redactions.length).toBeGreaterThan(0);
  expect(JSON.stringify(denied)).not.toContain(marker);
  const outcomeDenied = await panel('resolution_assertions', resolutionId, FINANCE_PURPOSE, 'PRIVATE');
  expect(outcomeDenied.sources).toEqual([]);
  expect(outcomeDenied.resolutions).toEqual([]);
  expect(outcomeDenied.statement).not.toContain('waived');
  expect(JSON.stringify(outcomeDenied)).not.toContain(effectiveAt.toISOString());
  expect((await panel('propositions', acceptedProposition, FINANCE_PURPOSE, 'PRIVATE')).statement).toContain('50.00');
  const authorizedPurpose = boundary === 'purpose' ? FAMILY_PURPOSE : FINANCE_PURPOSE;
  expect((await panel('propositions', value.propositionId, authorizedPurpose, 'RESTRICTED')).statement).toContain(marker);
  expect((await panel('resolution_assertions', resolutionId, authorizedPurpose, 'RESTRICTED')).resolutions)
    .toContainEqual({ resolutionAssertionId: resolutionId, outcomeCode: 'WAIVED', effectiveAt: effectiveAt.toISOString(), lifecycle: 'ACCEPTED' });
});

it.each(['sensitivity', 'purpose'])('thread values and outcomes require support readable for source %s', async boundary => {
  const marker = 'thread-protected-canonical-description-' + boundary;
  const source = await evidence({ sensitivity: boundary === 'sensitivity' ? 'RESTRICTED' : 'PRIVATE',
    allowedPurposes: [boundary === 'purpose' ? FAMILY_PURPOSE : FINANCE_PURPOSE], externalId: marker });
  const hiddenSlot = await slot(obligationFrame, 'shared.obligation.description');
  const value = await proposition({ frameInstanceId: obligationFrame, beliefSlotId: hiddenSlot,
    value: { text: marker }, anchorId: source.anchorId, assessment: 'ACCEPTED' });
  const resolutionId = uuidV7(), linkId = uuidV7();
  await admin.query(`INSERT INTO memory_links(id,owner_scope_id,from_object_type,from_object_id,to_object_type,
    to_object_id,link_kind,lifecycle,transition_contract_id,transaction_id)
    VALUES($1,$2,'resolution_assertion',$3,'frame_instance',$4,'RESOLVES','ACTIVE','shared.obligation.resolution',$5)`,
    [linkId, owner, resolutionId, obligationFrame, transactionId]);
  await admin.query(`INSERT INTO resolution_assertions(id,owner_scope_id,source_frame_instance_id,outcome_code,
    effective_at,asserted_by_entity_id,claim_id,transition_contract_id,lifecycle,resolution_link_id,
    creation_transaction_id,recorded_at)
    VALUES($1,$2,$3,'WAIVED',$4,$5,$6,'shared.obligation.resolution','ACCEPTED',$7,$8,$4)`,
    [resolutionId, owner, obligationFrame, new Date('2026-02-24T11:22:33.000Z'), danielEntity, value.claimId, linkId, transactionId]);
  await thread(tx => addThreadMember(tx, { ownerScopeId: owner, memoryThreadId: financeThread,
    member: { objectType: 'frame_instance', objectId: obligationFrame, membershipKind: 'SUBJECT', confidence: null, transactionId: null } }));
  const view = (purpose: string, ceiling: string) => inspect(async tx => {
    await tx.query("SELECT set_config('unai.data_purpose',$1,true),set_config('unai.maximum_sensitivity',$2,true)", [purpose, ceiling]);
    return readMemoryThread(tx, { ownerScopeId: owner, memoryThreadId: financeThread, readAt: NOW });
  });
  const denied = await view(FINANCE_PURPOSE, 'PRIVATE');
  expect(denied.actualEvents.map(event => event.propositionId)).toContain(acceptedProposition);
  expect(JSON.stringify(denied)).not.toContain(marker);
  expect(denied.resolutionLinks.map(resolution => resolution.resolutionAssertionId)).not.toContain(resolutionId);
  const allowed = await view(boundary === 'purpose' ? FAMILY_PURPOSE : FINANCE_PURPOSE, 'RESTRICTED');
  expect(JSON.stringify(allowed.actualEvents)).toContain(marker);
  expect(allowed.actualEvents.map(event => event.propositionId)).toContain(acceptedProposition);
  expect(allowed.resolutionLinks.map(resolution => resolution.resolutionAssertionId)).toContain(resolutionId);
});

it.each(['sensitivity', 'purpose'])('thread names require readable role and alias sources for %s', async boundary => {
  const source = await evidence({ sensitivity: boundary === 'sensitivity' ? 'RESTRICTED' : 'PRIVATE',
    allowedPurposes: [boundary === 'purpose' ? FAMILY_PURPOSE : FINANCE_PURPOSE], externalId: 'thread-names-' + boundary });
  const hiddenSlot = await slot(obligationFrame, 'shared.obligation.description');
  const value = await proposition({ frameInstanceId: obligationFrame, beliefSlotId: hiddenSlot,
    value: { text: 'source-scoped participant' }, anchorId: source.anchorId, assessment: 'ACCEPTED' });
  const aliases: string[] = [], canonicalLabels: string[] = [];
  for (const protectedPart of ['role', 'alias'] as const) {
    const entityId = uuidV7(), canonicalLabel = 'unsourced-canonical-name-' + boundary + '-' + protectedPart;
    const alias = 'protected-sourced-name-' + boundary + '-' + protectedPart;
    canonicalLabels.push(canonicalLabel); aliases.push(alias);
    await admin.query("INSERT INTO entities(id,owner_scope_id,entity_kind,canonical_label) VALUES($1,$2,'PERSON',$3)",
      [entityId, owner, canonicalLabel]);
    await admin.query(`INSERT INTO entity_aliases(id,owner_scope_id,entity_id,alias_type,alias_value,normalized_value,source_item_id,created_at)
      VALUES($1,$2,$3,'DISPLAY_NAME',$4,$4,$5,$6)`,
      [uuidV7(), owner, entityId, alias, protectedPart === 'alias' ? source.evidenceId : sharedEvidence, RECORDED_AT]);
    await admin.query(`INSERT INTO frame_instance_roles(id,owner_scope_id,frame_instance_id,role_id,entity_id,claim_id,created_at)
      VALUES($1,$2,$3,'creditor',$4,$5,$6)`,
      [uuidV7(), owner, obligationFrame, entityId, protectedPart === 'role' ? value.claimId : acceptedClaim, RECORDED_AT]);
  }
  await thread(tx => addThreadMember(tx, { ownerScopeId: owner, memoryThreadId: financeThread,
    member: { objectType: 'frame_instance', objectId: obligationFrame, membershipKind: 'SUBJECT', confidence: null, transactionId: null } }));
  const view = (purpose: string, ceiling: string) => inspect(async tx => {
    await tx.query("SELECT set_config('unai.data_purpose',$1,true),set_config('unai.maximum_sensitivity',$2,true)", [purpose, ceiling]);
    return readMemoryThread(tx, { ownerScopeId: owner, memoryThreadId: financeThread, readAt: NOW });
  });
  const denied = await view(FINANCE_PURPOSE, 'PRIVATE');
  expect(denied.relatedPeople).toContainEqual({ entityId: danielEntity, entityKind: 'PERSON', canonicalLabel: 'Daniel' });
  for (const marker of [...aliases, ...canonicalLabels]) expect(JSON.stringify(denied)).not.toContain(marker);
  const allowed = await view(boundary === 'purpose' ? FAMILY_PURPOSE : FINANCE_PURPOSE, 'RESTRICTED');
  for (const alias of aliases) expect(JSON.stringify(allowed.relatedPeople)).toContain(alias);
  for (const canonicalLabel of canonicalLabels) expect(JSON.stringify(allowed)).not.toContain(canonicalLabel);
});

it.each(['sensitivity', 'purpose'])('Why actor names require readable alias sources for %s', async boundary => {
  const hiddenSource = await evidence({ sensitivity: boundary === 'sensitivity' ? 'RESTRICTED' : 'PRIVATE',
    allowedPurposes: [boundary === 'purpose' ? FAMILY_PURPOSE : FINANCE_PURPOSE], externalId: 'why-actor-name-' + boundary });
  const readableSource = await evidence({ sensitivity: 'PRIVATE', allowedPurposes: [FINANCE_PURPOSE, FAMILY_PURPOSE],
    externalId: 'why-readable-actor-claim-' + boundary });
  const entityId = uuidV7(), canonicalLabel = 'unsourced-why-actor-' + boundary, alias = 'protected-why-actor-' + boundary;
  await admin.query("INSERT INTO entities(id,owner_scope_id,entity_kind,canonical_label) VALUES($1,$2,'PERSON',$3)",
    [entityId, owner, canonicalLabel]);
  await admin.query(`INSERT INTO entity_aliases(id,owner_scope_id,entity_id,alias_type,alias_value,normalized_value,source_item_id,created_at)
    VALUES($1,$2,$3,'DISPLAY_NAME',$4,$4,$5,$6)`,
    [uuidV7(), owner, entityId, alias, hiddenSource.evidenceId, RECORDED_AT]);
  const beliefSlotId = await slot(obligationFrame, 'shared.obligation.description');
  const value = await proposition({ frameInstanceId: obligationFrame, beliefSlotId, value: { text: 'An authorized statement' },
    anchorId: readableSource.anchorId, assessment: 'ACCEPTED' });
  for (const claimingEntity of [entityId, danielEntity]) {
    await admin.query(`INSERT INTO claims(id,owner_scope_id,source_anchor_id,proposition_id,claim_origin,lifecycle,
      asserted_by_entity_id,recorded_at) VALUES($1,$2,$3,$4,'USER_STATEMENT','PROVISIONAL',$5,$6)`,
      [uuidV7(), owner, readableSource.anchorId, value.propositionId, claimingEntity, RECORDED_AT]);
  }
  const panel = (purpose: string, ceiling: string) => inspect(async tx => {
    await tx.query("SELECT set_config('unai.data_purpose',$1,true),set_config('unai.maximum_sensitivity',$2,true)", [purpose, ceiling]);
    return readWhySources(tx, { ownerScopeId: owner, ref: { objectType: 'propositions', objectId: value.propositionId }, readAt: NOW });
  });
  const denied = await panel(FINANCE_PURPOSE, 'PRIVATE');
  expect(denied.statement).toContain('An authorized statement');
  expect(denied.claimingActors).toContainEqual({ kind: 'PERSON', label: 'Daniel', entityId: danielEntity });
  expect(denied.claimingActors).toContainEqual({ kind: 'PERSON', label: 'A person', entityId });
  expect(JSON.stringify(denied)).not.toContain(canonicalLabel);
  expect(JSON.stringify(denied)).not.toContain(alias);
  const allowed = await panel(boundary === 'purpose' ? FAMILY_PURPOSE : FINANCE_PURPOSE, 'RESTRICTED');
  expect(allowed.claimingActors).toContainEqual({ kind: 'PERSON', label: alias, entityId });
  expect(JSON.stringify(allowed)).not.toContain(canonicalLabel);
});
