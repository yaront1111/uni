import { Pool } from 'pg';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { runMigrations, withOwnerTransaction, type OwnerTransaction } from '@unai/postgres';
import { loadRegistryRelease, publishRegistryRelease } from '@unai/registry';
import { indexClaimEmbeddings } from '@unai/memory';
import type { PolicyVerdict, QuestionType } from '@unai/domain';
import { createLocalPolicyAdapters, type PolicyPorts } from '@unai/belief';
import { uuidV7 } from '../../../src/kernel/identities.js';
import { answerQuestion, readContextPacket, type ContextRunner } from './index.js';

/**
 * Deterministic selection and the Ask pipeline over real PostgreSQL, the real
 * owner boundary and the real pinned registry release 0.1.0.
 *
 * One pinned fixture holds a superseded value, a corrected value, a contested
 * value, a pending owner overlay delta, a value in a QUOTED context, a value under
 * an unregistered predicate, a commitment and a prediction. Nothing here
 * constructs an LLM gateway, and the tests assert that no model call was recorded.
 *
 * Covers CRT-RD-03-A and CRT-RD-12-A, and the read side of CRT-REG-04-A.
 */

if (!process.env.UNAI_TEST_DATABASE_URL) throw new Error('Run pnpm test for the required PostgreSQL harness');
const admin = new Pool({ connectionString: process.env.UNAI_TEST_DATABASE_URL });
const appUrl = new URL(process.env.UNAI_TEST_DATABASE_URL); appUrl.username = 'answering_test_app'; appUrl.password = 'test-only';
const appPool = new Pool({ connectionString: appUrl.href });

const owner = randomUUID(), actor = randomUUID();
const FINANCE = 'PERSONAL_FINANCE';
const NOW = new Date('2026-03-02T09:00:00.000Z');
const T = (day: string) => new Date(day + 'T09:00:00.000Z');
let registryReleaseId = '', transactionId = '', baseContext = '', quotedContext = '', danielEntity = '';
const evidence: Record<'conversation' | 'document' | 'calendar', { evidenceId: string; anchorId: string }> = {
  conversation: { evidenceId: '', anchorId: '' }, document: { evidenceId: '', anchorId: '' }, calendar: { evidenceId: '', anchorId: '' },
};
/** The fixture's propositions, by the role each plays. */
const p = {
  principal50: '', principal60: '', due10: '', due20: '', descriptionCar: '', descriptionRent: '', quoted: '',
  surfaceNote: '', commitment: '', prediction: '',
};
const slots = { principal: '', due: '', description: '', quoted: '', surface: '', commitment: '', prediction: '' };
let obligationFrame = '', overlayDelta = '';
const claimIds: string[] = [];

function git(repository: string, ...args: string[]) {
  const result = spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'user.name=Registry Test', '-c', 'user.email=registry@test.invalid', ...args],
    { cwd: repository, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_DATE: '2024-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2024-01-01T00:00:00Z' } });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}
/** The immutable 0.1.0 snapshot, published by whichever suite gets there first. */
async function pinnedRegistryRelease(): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const existing = (await admin.query("SELECT id FROM registry_releases WHERE semantic_version='0.1.0'")).rows[0];
    if (existing) return existing.id as string;
    await sleep(250);
  }
  const repository = await mkdtemp(join(tmpdir(), 'unai-answering-registry-'));
  try {
    await cp(resolve('registry'), join(repository, 'registry'), { recursive: true });
    git(repository, 'init', '--quiet'); git(repository, 'add', 'registry');
    git(repository, 'commit', '--quiet', '-m', 'release'); git(repository, 'tag', 'registry-v0.1.0');
    const release = await loadRegistryRelease({ repository, version: '0.1.0' });
    return (await publishRegistryRelease(admin, release, randomUUID())).releaseId;
  } finally { await rm(repository, { recursive: true, force: true }); }
}

async function item(externalId: string, sourceType: string): Promise<{ evidenceId: string; anchorId: string }> {
  const evidenceId = randomUUID(), anchorId = randomUUID(), connectorId = randomUUID();
  await admin.query("INSERT INTO connectors(id,owner_scope_id,connector_type,external_account_ref,permission_manifest,status) VALUES($1,$2,'CONVERSATION',$3,'{}','ACTIVE')",
    [connectorId, owner, externalId]);
  await admin.query(`INSERT INTO source_items(id,owner_scope_id,connector_id,source_type,external_id,actor_ref,submitted_by_user_id,
    raw_object_ref,content_hash,sensitivity,allowed_purposes,ingestion_version,idempotency_key,occurred_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'PRIVATE',ARRAY[$10],'evidence-json-v1',$11,$12)`,
    [evidenceId, owner, connectorId, sourceType, externalId, JSON.stringify({ type: 'USER', id: actor }), actor, randomUUID(),
      randomUUID().replaceAll('-', '').padEnd(64, 'a').slice(0, 64), FINANCE, randomUUID(), T('2026-01-20')]);
  await admin.query(`INSERT INTO source_anchors(id,owner_scope_id,source_item_id,anchor_kind,anchor)
    VALUES($1,$2,$3,'MESSAGE_SPAN','{"start":0,"end":40}')`, [anchorId, owner, evidenceId]);
  return { evidenceId, anchorId };
}

async function frame(frameTypeId: string, contextSpaceId = baseContext): Promise<string> {
  const id = uuidV7();
  await admin.query('INSERT INTO frame_instances(id,owner_scope_id,frame_type_id,context_space_id) VALUES($1,$2,$3,$4)',
    [id, owner, frameTypeId, contextSpaceId]);
  await admin.query("INSERT INTO frame_instance_roles(id,owner_scope_id,frame_instance_id,role_id,entity_id) VALUES($1,$2,$3,'creditor',$4)",
    [randomUUID(), owner, id, danielEntity]);
  return id;
}
async function slot(frameInstanceId: string, predicateId: string, modality = 'ACTUAL', contextSpaceId = baseContext): Promise<string> {
  const id = uuidV7();
  await admin.query(`INSERT INTO belief_slots(id,owner_scope_id,frame_instance_id,predicate_id,context_space_id,modality)
    VALUES($1,$2,$3,$4,$5,$6)`, [id, owner, frameInstanceId, predicateId, contextSpaceId, modality]);
  return id;
}
interface Version { status: string; validFrom?: Date | null; validTo?: Date | null; recordedAt: Date; supersededAt?: Date | null }
/** A proposition, one claim behind it, and every recorded-time version of its
 * verdict -- written explicitly, because the fixture is a history. */
async function value(input: { slotId: string; value: unknown; source: keyof typeof evidence; origin?: string;
  claimRecordedAt: Date; claimValidFrom?: Date | null; versions: Version[] }): Promise<{ propositionId: string; claimId: string }> {
  const propositionId = uuidV7(), claimId = uuidV7();
  await admin.query('INSERT INTO propositions(id,owner_scope_id,belief_slot_id,normalized_value) VALUES($1,$2,$3,$4)',
    [propositionId, owner, input.slotId, JSON.stringify(input.value)]);
  await admin.query(`INSERT INTO claims(id,owner_scope_id,source_anchor_id,proposition_id,claim_origin,lifecycle,valid_from,recorded_at)
    VALUES($1,$2,$3,$4,$5,'PROVISIONAL',$6,$7)`, [claimId, owner, evidence[input.source].anchorId, propositionId,
    input.origin ?? 'USER_STATEMENT', input.claimValidFrom ?? T('2026-01-01'), input.claimRecordedAt]);
  for (const version of input.versions) {
    await admin.query(`INSERT INTO belief_assessments(id,owner_scope_id,proposition_id,assessment_status,valid_from,valid_to,
      recorded_at,superseded_recorded_at,policy_version,decision_reason,transaction_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,'local-policy-0.1.0','{"code":"FIXTURE"}',$9)`,
      [uuidV7(), owner, propositionId, version.status, version.validFrom ?? null, version.validTo ?? null, version.recordedAt,
        version.supersededAt ?? null, transactionId]);
  }
  claimIds.push(claimId);
  return { propositionId, claimId };
}
async function relation(from: string, to: string, kind: 'CORRECTS' | 'SUPERSEDES', validFrom: Date, createdAt: Date) {
  await admin.query(`INSERT INTO claim_relations(id,owner_scope_id,from_claim_id,to_claim_id,relation_kind,temporal_effect,
    valid_from,created_by_transaction_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [randomUUID(), owner, from, to, kind, kind === 'CORRECTS' ? 'SAME_VALID_INTERVAL' : 'NEW_VALID_PERIOD', validFrom, transactionId, createdAt]);
}

beforeAll(async () => {
  await runMigrations(admin, resolve('migrations'));
  await admin.query("DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='answering_test_app') THEN CREATE ROLE answering_test_app LOGIN PASSWORD 'test-only'; END IF; END $$; GRANT unai_app TO answering_test_app");
  await admin.query('INSERT INTO users(id,display_name) VALUES($1,$2)', [actor, 'Answering owner']);
  await admin.query("INSERT INTO owner_scopes(id,scope_kind,display_name,created_by_user_id) VALUES($1,'PERSONAL','Answering',$2)", [owner, actor]);
  await admin.query("INSERT INTO owner_scope_members(owner_scope_id,user_id,role) VALUES($1,$2,'OWNER')", [owner, actor]);
  baseContext = (await admin.query("SELECT id FROM context_spaces WHERE owner_scope_id=$1 AND context_kind='BASE'", [owner])).rows[0].id;
  // No application capability creates a QUOTED context (migration 0009), so the
  // fixture's one is written by the migration principal.
  quotedContext = randomUUID();
  await admin.query("INSERT INTO context_spaces(id,owner_scope_id,context_kind,parent_context_space_id) VALUES($1,$2,'QUOTED',$3)",
    [quotedContext, owner, baseContext]);
  registryReleaseId = await pinnedRegistryRelease();
  transactionId = randomUUID();
  await admin.query(`INSERT INTO belief_transactions(id,owner_scope_id,transaction_kind,requested_by_actor_id,
    source_evidence_ids,registry_release_id,status,risk,idempotency_key,commit_receipt,committed_at)
    VALUES($1,$2,'CANONICALIZE',$3,'{}',$4,'COMMITTED','LOW',$5,'{}',$6)`,
    [transactionId, owner, actor, registryReleaseId, randomUUID().replaceAll('-', ''), T('2026-02-01')]);
  danielEntity = uuidV7();
  await admin.query("INSERT INTO entities(id,owner_scope_id,entity_kind,canonical_label) VALUES($1,$2,'PERSON','Daniel')", [danielEntity, owner]);
  evidence.conversation = await item('owner-chat-1', 'CONVERSATION');
  evidence.document = await item('loan-agreement.pdf', 'DOCUMENT');
  evidence.calendar = await item('calendar-handover', 'CALENDAR_EVENT');

  obligationFrame = await frame('shared.obligation');
  slots.principal = await slot(obligationFrame, 'shared.obligation.principal_amount');
  slots.due = await slot(obligationFrame, 'shared.obligation.due_time');
  slots.description = await slot(obligationFrame, 'shared.obligation.description');
  slots.surface = await slot(obligationFrame, 'shared.obligation.informal_note');
  slots.quoted = await slot(await frame('shared.obligation', quotedContext), 'shared.obligation.principal_amount', 'ACTUAL', quotedContext);
  slots.commitment = await slot(await frame('shared.commitment'), 'shared.commitment.action_description', 'COMMITTED');
  slots.prediction = await slot(await frame('shared.event_occurrence'), 'shared.event_occurrence.occurrence_time', 'PREDICTED');

  // Corrected: ILS 50 accepted on Feb 1; "actually it was 60" on Feb 10, over the
  // same valid interval. The 50 is SUPERSEDED from Feb 10 on and the claim
  // relation says it was a correction.
  const fifty = await value({ slotId: slots.principal, value: { amount: '50.00', currency: 'ILS' }, source: 'conversation',
    claimRecordedAt: T('2026-02-01'), versions: [
      { status: 'ACCEPTED', validFrom: T('2026-01-01'), recordedAt: T('2026-02-01'), supersededAt: T('2026-02-10') },
      { status: 'SUPERSEDED', validFrom: T('2026-01-01'), recordedAt: T('2026-02-10') }] });
  const sixty = await value({ slotId: slots.principal, value: { amount: '60.00', currency: 'ILS' }, source: 'document',
    origin: 'USER_CORRECTION', claimRecordedAt: T('2026-02-10'), versions: [
      { status: 'ACCEPTED', validFrom: T('2026-01-01'), recordedAt: T('2026-02-10') }] });
  await relation(sixty.claimId, fifty.claimId, 'CORRECTS', T('2026-01-01'), T('2026-02-10'));
  p.principal50 = fifty.propositionId; p.principal60 = sixty.propositionId;

  // Superseded by a later period: due on March 10 until Feb 15, when it moved to
  // March 20. The first stays true for the period that ended.
  const due10 = await value({ slotId: slots.due, value: { time: '2026-03-10T00:00:00.000Z' }, source: 'conversation',
    claimRecordedAt: T('2026-02-01'), versions: [
      { status: 'ACCEPTED', validFrom: T('2026-01-01'), recordedAt: T('2026-02-01'), supersededAt: T('2026-02-15') },
      { status: 'ACCEPTED', validFrom: T('2026-01-01'), validTo: T('2026-02-15'), recordedAt: T('2026-02-15') }] });
  const due20 = await value({ slotId: slots.due, value: { time: '2026-03-20T00:00:00.000Z' }, source: 'document',
    claimRecordedAt: T('2026-02-15'), claimValidFrom: T('2026-02-15'), versions: [
      { status: 'ACCEPTED', validFrom: T('2026-02-15'), recordedAt: T('2026-02-15') }] });
  await relation(due20.claimId, due10.claimId, 'SUPERSEDES', T('2026-02-15'), T('2026-02-15'));
  p.due10 = due10.propositionId; p.due20 = due20.propositionId;

  // Contested: two sources disagree about what the loan was for.
  p.descriptionCar = (await value({ slotId: slots.description, value: { text: 'loan to repair the car' }, source: 'conversation',
    claimRecordedAt: T('2026-02-01'), versions: [{ status: 'CONTESTED', recordedAt: T('2026-02-03') }] })).propositionId;
  p.descriptionRent = (await value({ slotId: slots.description, value: { text: 'loan to cover the rent' }, source: 'document',
    origin: 'DOCUMENT_ASSERTION', claimRecordedAt: T('2026-02-02'), versions: [{ status: 'CONTESTED', recordedAt: T('2026-02-03') }] })).propositionId;

  // A value stated inside a quotation, and a value under a surface predicate the
  // release does not hold -- accepted by a legacy row no current transaction
  // could write, so the read side has to hold the line on its own.
  p.quoted = (await value({ slotId: slots.quoted, value: { amount: '999.00', currency: 'ILS' }, source: 'conversation',
    claimRecordedAt: T('2026-02-01'), versions: [{ status: 'ACCEPTED', recordedAt: T('2026-02-01') }] })).propositionId;
  p.surfaceNote = (await value({ slotId: slots.surface, value: { text: 'Daniel said there is no rush to repay' }, source: 'conversation',
    claimRecordedAt: T('2026-02-01'), versions: [{ status: 'ACCEPTED', recordedAt: T('2026-02-01') }] })).propositionId;

  // A commitment and a prediction.
  p.commitment = (await value({ slotId: slots.commitment, value: { text: 'send Daniel the signed agreement' }, source: 'calendar',
    claimRecordedAt: T('2026-02-01'), versions: [{ status: 'ACCEPTED', recordedAt: T('2026-02-01') }] })).propositionId;
  p.prediction = (await value({ slotId: slots.prediction, value: { time: '2026-04-01T00:00:00.000Z' }, source: 'document',
    origin: 'MODEL_PREDICTION', claimRecordedAt: T('2026-02-01'), versions: [{ status: 'PROVISIONAL', recordedAt: T('2026-02-01') }] })).propositionId;

  // The owner's pending "actually it was 65", on the corrected value, on Feb 20.
  overlayDelta = uuidV7();
  await admin.query(`INSERT INTO owner_overlay_deltas(id,owner_scope_id,owner_sequence,source_evidence_id,raw_text,delta_kind,
    lifecycle,target_object_type,target_object_id,created_at)
    VALUES($1,$2,1,$3,'Actually it was 65','USER_CORRECTION','USER_ASSERTED','proposition',$4,$5)`,
    [overlayDelta, owner, evidence.conversation.evidenceId, p.principal60, T('2026-02-20')]);

  // The accepted outcome authority over the obligation.
  const resolutionId = uuidV7(), linkId = uuidV7();
  await admin.query(`INSERT INTO memory_links(id,owner_scope_id,from_object_type,from_object_id,to_object_type,to_object_id,
    link_kind,lifecycle,transition_contract_id,transaction_id)
    VALUES($1,$2,'resolution_assertion',$3,'frame_instance',$4,'RESOLVES','ACTIVE','shared.obligation.resolution',$5)`,
    [linkId, owner, resolutionId, obligationFrame, transactionId]);
  await admin.query(`INSERT INTO resolution_assertions(id,owner_scope_id,source_frame_instance_id,outcome_code,effective_at,
    asserted_by_entity_id,claim_id,transition_contract_id,lifecycle,resolution_link_id,creation_transaction_id)
    VALUES($1,$2,$3,'PARTIALLY_FULFILLED',$4,$5,$6,'shared.obligation.resolution','ACCEPTED',$7,$8)`,
    [resolutionId, owner, obligationFrame, T('2026-02-25'), danielEntity, fifty.claimId, linkId, transactionId]);

  // The semantic index over every claim, written the way a governed commit writes it.
  await withOwnerTransaction(appPool, { actorId: actor, ownerScopeId: owner, purpose: 'memory.govern', correlationId: randomUUID() },
    tx => indexClaimEmbeddings(tx, { ownerScopeId: owner, claimIds }));
});
afterAll(async () => { await appPool.end(); await admin.end(); });

const runner: ContextRunner = run => withOwnerTransaction(appPool,
  { actorId: actor, ownerScopeId: owner, purpose: 'memory.read', correlationId: randomUUID() }, tx => run(tx as OwnerTransaction));
const options = () => ({ correlationId: randomUUID(), now: NOW, registryReleaseId, registryRelease: '0.1.0' });
const request = (over: Record<string, unknown> = {}) => ({
  ownerScopeId: owner, requestingActorId: actor, purpose: FINANCE, query: 'Do I still owe Daniel?', worldTime: 'NOW',
  knowledgeTime: 'LATEST', maximumSensitivity: 'PRIVATE', actionRisk: 'MEDIUM', answerType: 'CURRENT_VALUE', ...over,
});
const modelCalls = async () => (await admin.query('SELECT count(*)::int AS n FROM model_call_records WHERE owner_scope_id=$1', [owner])).rows[0].n;

it('CRT-RD-03-A: the broker returns the same selected current state and selection reason on repeated runs with the LLM gateway disabled', async () => {
  const callsBefore = await modelCalls();
  const runs = [];
  for (let run = 0; run < 3; run++) runs.push(await readContextPacket(runner, request(), options()));
  // A pinned instant instead of NOW/LATEST selects the same.
  runs.push(await readContextPacket(runner, request({ worldTime: NOW.toISOString(), knowledgeTime: NOW.toISOString() }), options()));

  const [first] = runs;
  for (const packet of runs) {
    expect(packet.selections).toEqual(first!.selections);
    expect(JSON.stringify(packet.selections)).toBe(JSON.stringify(first!.selections));
    expect(packet.selectionReason.selectionsDigest).toBe(first!.selectionReason.selectionsDigest);
  }
  // Four packets, four records -- and not one model call among them.
  expect(new Set(runs.map(packet => packet.packetId)).size).toBe(4);
  expect(await modelCalls()).toBe(callsBefore);

  const of = (slotId: string) => first!.selections.find(selection => selection.beliefSlotId === slotId)!;
  // Corrected: the correction, with the owner's pending delta shown beside it.
  expect(of(slots.principal)).toMatchObject({
    outcome: 'SELECTED', selectedPropositionId: p.principal60, reason: 'SELECTED_AFTER_CORRECTION', certainty: 'ACCEPTED',
    selectedValue: { amount: '60.00', currency: 'ILS' }, evidenceIds: [evidence.document.evidenceId],
    appliedRelations: [{ relationKind: 'CORRECTS', fromPropositionId: p.principal60, toPropositionId: p.principal50 }],
    overlayDeltaIds: [overlayDelta], ownerAssertionPending: true,
  });
  expect(of(slots.principal).steps.find(step => step.rule === 'APPLY_BELIEF_LIFECYCLE')!.excluded)
    .toEqual([{ objectId: p.principal50, reason: 'ASSESSMENT_SUPERSEDED' }]);
  // Superseded by a later period.
  expect(of(slots.due)).toMatchObject({ outcome: 'SELECTED', selectedPropositionId: p.due20, reason: 'SELECTED_AFTER_SUPERSESSION' });
  expect(of(slots.due).steps.find(step => step.rule === 'FILTER_VALID_TIME')!.excluded)
    .toEqual([{ objectId: p.due10, reason: 'VALID_TIME_EXCLUDES_WORLD_TIME' }]);
  // Contested: reported, never chosen.
  expect(of(slots.description)).toMatchObject({ outcome: 'CONTESTED', selectedPropositionId: null, reason: 'UNRESOLVED_CONFLICT',
    competingPropositionIds: [p.descriptionCar, p.descriptionRent].sort() });
  expect(first!.conflicts.map(conflict => conflict.beliefSlotId)).toContain(slots.description);
  // Context, modality and registration exclude whole slots.
  expect(of(slots.quoted)).toMatchObject({ outcome: 'EXCLUDED', reason: 'CONTEXT_NOT_BASE', contextKind: 'QUOTED' });
  expect(of(slots.commitment)).toMatchObject({ outcome: 'EXCLUDED', reason: 'MODALITY_NOT_REQUESTED' });
  expect(of(slots.surface)).toMatchObject({ outcome: 'EXCLUDED', reason: 'UNREGISTERED_PREDICATE_NOT_AUTHORITATIVE',
    predicateRegistered: false, selectedPropositionId: null });
  expect(of(slots.principal).predicateRegistered).toBe(true);
  // The selection reason travels with the packet and the stored record.
  expect(first!.selectionReason).toMatchObject({ selectorVersion: 'deterministic-selector-0.2.0' });
  const stored = (await admin.query('SELECT selection_reason,packet FROM context_packets WHERE id=$1', [first!.packetId])).rows[0];
  expect(stored.selection_reason.selectionsDigest).toBe(first!.selectionReason.selectionsDigest);
  expect(stored.packet.selections).toEqual(JSON.parse(JSON.stringify(first!.selections)));
});

it('CRT-RD-03-A: historical selection uses the knowledge and world time asked for, not the latest', async () => {
  const feb5 = '2026-02-05T00:00:00.000Z';
  // What Uai believed on Feb 5, from what it knew on Feb 5: the uncorrected 50 and
  // the original due date, and no trace of the later correction or delta.
  const believed = await readContextPacket(runner, request({ worldTime: feb5, knowledgeTime: feb5, answerType: 'HISTORICAL_BELIEF_STATE' }), options());
  const at = (packet: typeof believed, slotId: string) => packet.selections.find(selection => selection.beliefSlotId === slotId)!;
  expect(at(believed, slots.principal)).toMatchObject({ selectedPropositionId: p.principal50, reason: 'ONLY_ACCEPTED_VALUE',
    overlayDeltaIds: [], appliedRelations: [] });
  expect(at(believed, slots.due)).toMatchObject({ selectedPropositionId: p.due10 });
  // What is now believed to have held on Feb 5: the corrected 60, and still the
  // original due date, because the change began on Feb 15.
  const corrected = await readContextPacket(runner, request({ worldTime: feb5, answerType: 'CORRECTED_HISTORICAL_VALUE' }), options());
  expect(at(corrected, slots.principal)).toMatchObject({ selectedPropositionId: p.principal60, reason: 'SELECTED_AFTER_CORRECTION' });
  expect(at(corrected, slots.due)).toMatchObject({ selectedPropositionId: p.due10 });
});

it('CRT-RD-03-A: a field-level REDACT over the selected value removes it from the selection too', async () => {
  const redacting: PolicyPorts = {
    ...createLocalPolicyAdapters(),
    async evaluateMemoryRead(): Promise<PolicyVerdict> {
      return { outcome: 'REDACT', requiredConfirmation: false, obligations: [], expiry: null,
        reason: 'FIELD_LEVEL_REDACTION_REQUIRED', policyVersion: 'test-policy-0.1.0',
        redactions: [{ objectType: 'propositions', objectId: p.principal60, fields: ['normalizedValue', 'assessmentStatus'],
          reason: 'FIELD_WITHHELD_BY_POLICY' }] };
    },
  };
  const packet = await readContextPacket(runner, request(), { ...options(), ports: redacting });
  const selection = packet.selections.find(entry => entry.beliefSlotId === slots.principal)!;
  // Still the same selection, for the same reason -- without the withheld fields.
  expect(selection).toMatchObject({ outcome: 'SELECTED', selectedPropositionId: p.principal60, reason: 'SELECTED_AFTER_CORRECTION' });
  expect(Object.keys(selection)).not.toContain('selectedValue');
  expect(Object.keys(selection)).not.toContain('assessmentStatus');
  expect(JSON.stringify(packet.selections)).not.toContain('60.00');
});

it('CRT-REG-04-A: memory under an unregistered predicate never becomes current and never authorizes a high-risk action', async () => {
  // Recalled -- it is stored and indexed -- but as a source, not a value.
  const packet = await readContextPacket(runner, request({ query: 'Daniel said no rush to repay' }), options());
  const recalled = packet.semanticSearch!.matches.find(match => match.propositionId === p.surfaceNote);
  expect(recalled).toMatchObject({ predicateRegistered: false, authority: 'NON_AUTHORITATIVE_UNREGISTERED_PREDICATE' });
  expect(packet.selections.find(selection => selection.beliefSlotId === slots.surface)).toMatchObject({ outcome: 'EXCLUDED',
    selectedPropositionId: null });
  // A high-risk action founded on a packet that rests on it is denied for that
  // reason, and the denial is recorded; the same action at medium risk is decided
  // on its other merits.
  await expect(readContextPacket(runner, request({ actionRisk: 'HIGH',
    intendedAction: { actionKind: 'DRAFT', actionPurpose: FINANCE, capabilityGranted: true } }), options()))
    .rejects.toMatchObject({ message: 'CONTEXT_ACTION_DENIED', detail: { reason: 'UNREGISTERED_PREDICATE_MAY_NOT_AUTHORIZE_HIGH_RISK_ACTION' } });
  const decision = (await admin.query(`SELECT outcome,reason,request FROM policy_decisions WHERE owner_scope_id=$1
    AND port='EvaluateMemoryAction' ORDER BY created_at DESC,id DESC LIMIT 1`, [owner])).rows[0];
  expect(decision).toMatchObject({ outcome: 'DENY', reason: 'UNREGISTERED_PREDICATE_MAY_NOT_AUTHORIZE_HIGH_RISK_ACTION' });
  expect(decision.request.unregisteredPredicateSupport).toBe(true);
  const medium = await readContextPacket(runner, request({
    intendedAction: { actionKind: 'DRAFT', actionPurpose: FINANCE, capabilityGranted: true } }), options());
  expect(medium.actionDecision?.reason).not.toBe('UNREGISTERED_PREDICATE_MAY_NOT_AUTHORIZE_HIGH_RISK_ACTION');
});

/** One fixture question per §8.2 answer type, answered end to end. */
const QUESTIONS: Array<[QuestionType, string, Record<string, unknown>]> = [
  ['CURRENT_STATE', 'Do I still owe Daniel?', {}],
  ['HISTORICAL_STATE', 'What did Uai believe at that time about the loan?', { worldTime: '2026-02-05T00:00:00.000Z' }],
  ['EPISODE_RECALL', 'What happened when Daniel lent me money to repair the car?', {}],
  ['CAUSAL_EXPLANATION', 'Why did I agree to borrow from Daniel?', {}],
  ['FUTURE_COMMITMENT', 'What did I promise Daniel?', {}],
  ['PREDICTION_REVIEW', 'Did my prediction about the handover come true?', {}],
  ['AGGREGATION', 'How many loans do I have with Daniel in total?', {}],
  ['CONTRADICTION_CHECK', 'Does anything I recorded about the loan contradict itself?', {}],
];

it('CRT-RD-12-A: each of the eight answer types is classified correctly and answered with source links', async () => {
  const callsBefore = await modelCalls();
  const ask = (question: string, over: Record<string, unknown>) => answerQuestion(runner, {
    ownerScopeId: owner, question, purpose: FINANCE, worldTime: 'NOW', knowledgeTime: 'LATEST', maximumSensitivity: 'PRIVATE', ...over,
  }, { ...options(), requestingActorId: actor });
  const evidenceIds = Object.values(evidence).map(entry => entry.evidenceId);

  for (const [answerType, question, over] of QUESTIONS) {
    const answer = await ask(question, over);
    expect(answer.answerType, question).toBe(answerType);
    // Source links: present, pointing at the fixture's own evidence through the
    // evidence route, and every statement's links are among them.
    expect(answer.sourceLinks.length, question).toBeGreaterThan(0);
    for (const link of answer.sourceLinks) {
      expect(evidenceIds, question).toContain(link.evidenceId);
      expect(link.href, question).toBe('/v1/evidence/' + link.evidenceId);
    }
    const linked = new Set(answer.sourceLinks.map(link => link.evidenceId));
    for (const statement of answer.statements) {
      for (const evidenceId of statement.sourceEvidenceIds) expect(linked.has(evidenceId), question).toBe(true);
    }
    expect(answer.composer).toEqual({ kind: 'DETERMINISTIC_COMPOSER', version: 'ask-composer-0.1.0', modelCalled: false });
    // The same question over the same memory is the same answer.
    const again = await ask(question, over);
    expect(again.statements, question).toEqual(answer.statements);
    expect(again.selectionsDigest, question).toBe(answer.selectionsDigest);
  }
  expect(await modelCalls()).toBe(callsBefore);

  // The labels follow the support, and the wording follows the labels.
  const current = await ask('Do I still owe Daniel?', {});
  const principal = current.statements.find(statement => statement.objectRefs.some(ref => ref.objectId === p.principal60))!;
  expect(principal).toMatchObject({ kind: 'SELECTED_STATE', label: 'CONFIRMED', sourceEvidenceIds: [evidence.document.evidenceId],
    explainPath: '/v1/memory/propositions/' + p.principal60 + '/explain' });
  expect(principal.text).toContain('ILS 60.00');
  expect(principal.text).toContain('pending correction');
  const contested = current.statements.find(statement => statement.kind === 'CONTESTED_STATE')!;
  expect(contested.label).toBe('CONFLICTING');
  expect(contested.text).toContain('neither is settled');
  // The owner's pending word is said, as theirs and as unverified.
  const pending = current.statements.find(statement => statement.kind === 'OWNER_ASSERTION_PENDING')!;
  expect(pending).toMatchObject({ label: 'REPORTED', objectRefs: [{ objectType: 'owner_overlay_deltas', objectId: overlayDelta }] });
  expect(pending.text).toContain('not yet independently verified');
  // The unregistered note and the quoted amount are never stated as values.
  const texts = current.statements.map(statement => statement.text).join('\n');
  expect(texts).not.toContain('no rush');
  expect(texts).not.toContain('999');

  const historical = await ask('What did Uai believe at that time about the loan?', { worldTime: '2026-02-05T00:00:00.000Z' });
  expect(historical).toMatchObject({ historicalMode: 'HISTORICAL_BELIEF_STATE', knowledgeTime: '2026-02-05T00:00:00.000Z' });
  expect(historical.statements.find(statement => statement.objectRefs.some(ref => ref.objectId === p.principal50))?.text)
    .toContain('ILS 50.00');

  const promised = await ask('What did I promise Daniel?', {});
  expect(promised.statements.find(statement => statement.objectRefs.some(ref => ref.objectId === p.commitment)))
    .toMatchObject({ label: 'COMMITTED', sourceEvidenceIds: [evidence.calendar.evidenceId] });
  expect(promised.statements.find(statement => statement.objectRefs.some(ref => ref.objectId === p.commitment))!.text)
    .toMatch(/^Committed, not yet fulfilled/);

  const prediction = await ask('Did my prediction about the handover come true?', {});
  expect(prediction.statements.find(statement => statement.kind === 'FUTURE_CLAIM'))
    .toMatchObject({ label: 'PREDICTED', sourceEvidenceIds: [evidence.document.evidenceId] });
  expect(prediction.statements.some(statement => statement.label === 'UNKNOWN' && statement.text.startsWith('No confirmed outcome'))).toBe(true);

  const contradiction = await ask('Does anything I recorded about the loan contradict itself?', {});
  expect(contradiction.statements.find(statement => statement.kind === 'CONFLICT')).toMatchObject({
    label: 'CONFLICTING', sourceEvidenceIds: [evidence.conversation.evidenceId, evidence.document.evidenceId].sort() });
  expect(contradiction.queryMode).toBe('CONTRADICTION_DETECTION');

  const episode = await ask('What happened when Daniel lent me money to repair the car?', {});
  expect(episode.statements.some(statement => statement.kind === 'SEMANTIC_RECALL' && statement.label === 'REPORTED')).toBe(true);

  // The packet each answer rests on is the broker's record, planned for the mode
  // the question was classified into.
  const stored = (await admin.query('SELECT answer_type_classification FROM context_packets WHERE id=$1', [promised.packetId])).rows[0];
  expect(stored.answer_type_classification).toBe('OPEN_COMMITMENTS');
});

it('CRT-RD-12-A: an Ask request missing a declaration, or declaring a purpose the evidence refuses, is refused', async () => {
  for (const field of ['question', 'purpose', 'worldTime', 'knowledgeTime', 'maximumSensitivity', 'ownerScopeId']) {
    const body: Record<string, unknown> = { ownerScopeId: owner, question: 'Do I still owe Daniel?', purpose: FINANCE,
      worldTime: 'NOW', knowledgeTime: 'LATEST', maximumSensitivity: 'PRIVATE' };
    delete body[field];
    await expect(answerQuestion(runner, body, { ...options(), requestingActorId: actor }), field)
      .rejects.toMatchObject({ message: 'ASK_REQUEST_INCOMPLETE', detail: { missing: [field] } });
  }
  await expect(answerQuestion(runner, { ownerScopeId: owner, question: 'Do I still owe Daniel?', purpose: 'ADVERTISING',
    worldTime: 'NOW', knowledgeTime: 'LATEST', maximumSensitivity: 'PRIVATE' }, { ...options(), requestingActorId: actor }))
    .rejects.toMatchObject({ message: 'CONTEXT_READ_DENIED', detail: { reason: 'PURPOSE_NOT_IN_ALLOWED_PURPOSES' } });
});
