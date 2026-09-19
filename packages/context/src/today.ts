import {
  briefingPacketManifestSchema, todayBriefingSchema, PARTIAL_OUTCOME_CODES,
  type BriefingDomain, type BriefingItem, type ContextPacket, type ContextSelection, type MemoryLabel,
  type PublicOverlayDelta, type TodayBriefing, type WhyRef,
} from '@unai/domain';
import { canonicalJson, type MemoryTransaction } from '@unai/memory';
import { dueInstant, readTimeValue } from '@unai/capabilities';
import { uuidV7 } from '../../../src/kernel/identities.js';
import { ContextBrokerError, readContextPacket, type ContextBrokerOptions, type ContextRunner } from './broker.js';
import { readPersistedPacket, suppliedContextOf } from './manifests.js';
import {
  RANKING_VERSION, REPEAT_SUPPRESSION_DAYS, BriefingTimeError, assertTimeZone, ownerLocalDate, rankBriefing,
  shiftLocalDate, utcOffset, type BriefingCandidate, type RankedItem, type ShownBefore,
} from './ranking.js';
import { describeValue } from './wording.js';

/**
 * The Today briefing (PRD §7.1, §26; design GET /v1/today, screen "Today
 * briefing"; entities `briefing_editions` and `briefing_items`; CRT-UX-01-A,
 * CRT-UX-01-B, CRT-UX-02-A). ADR 0027.
 *
 * No product surface reads memory except through the Context Broker (design
 * "Open decisions"), so the briefing is built in three steps:
 *
 *  1. The broker assembles and persists a purpose-bound packet over the owner's
 *     commitment, obligation and event frames, under the request's data purpose
 *     and sensitivity ceiling. Its two transactions record the read decision.
 *  2. In a third transaction, the packet is read back as persisted (and its hash
 *     checked). Candidates, values, outcomes and uncertainty come from that
 *     authorized packet. Previous editions of the last
 *     `REPEAT_SUPPRESSION_DAYS` owner-local dates are read for repeat suppression.
 *  3. `rankBriefing` (pure) decides what is current, how it ranks and what is
 *     suppressed; the edition, every ranked item and the packet manifest are
 *     written in that same transaction.
 *
 * A frame or assertion the packet did not supply cannot influence the briefing
 * through a second, owner-wide projection read.
 */

export const TODAY_FRAME_TYPES = Object.freeze(['shared.commitment', 'shared.obligation', 'shared.event_occurrence']);
const TODAY_MODALITIES: Readonly<Record<string, string>> = Object.freeze({
  'shared.commitment': 'COMMITTED', 'shared.obligation': 'ACTUAL', 'shared.event_occurrence': 'SCHEDULED',
});
/** An owner assertion not yet attached to anything is surfaced for this long. */
export const PENDING_ASSERTION_DAYS = 7;
const PENDING_LIFECYCLES = new Set(['RECEIVED', 'USER_ASSERTED', 'AWAITING_INSTANCE_RESOLUTION', 'CANONICALIZATION_PENDING']);
const MODEL_ORIGINS = new Set(['MODEL_EXTRACTION', 'MODEL_INFERENCE', 'MODEL_RECOMMENDATION', 'MODEL_PREDICTION']);
const OWNER_OR_AUTHORITY = new Set(['USER_STATEMENT', 'USER_CONFIRMATION', 'USER_CORRECTION',
  'STRUCTURED_CONNECTOR_OBSERVATION', 'TOOL_EXECUTION_RECEIPT']);

export interface TodayInput {
  readonly ownerScopeId: string;
  /** Null: the timezone of the owner's most recent edition. */
  readonly timeZone: string | null;
  /** The owner-local date the caller believes it is, when it said. */
  readonly date: string | null;
  readonly dataPurpose: string;
  readonly maximumSensitivity: 'NORMAL' | 'PRIVATE' | 'RESTRICTED';
}

export interface TodayOptions extends ContextBrokerOptions {
  /** The session's actor. It is never read from the request. */
  readonly requestingActorId: string;
}

/** The support label of one frame, from what the packet says about it (PRD
 * §24.5). The order matters: a disputed value is contested before anything else,
 * and the owner's unverified word is never promoted to "confirmed". */
export function frameLabel(input: {
  kind: BriefingCandidate['kind']; resolved: boolean; conflict: boolean; pending: boolean;
  selections: readonly ContextSelection[];
}): MemoryLabel {
  if (input.conflict) return 'CONTESTED';
  if (input.resolved) return 'RESOLVED';
  if (input.pending) return 'PENDING_OWNER_ASSERTION';
  if (input.kind === 'SCHEDULED_EVENT') return 'SCHEDULED';
  const selected = input.selections.filter(selection => selection.outcome === 'SELECTED');
  const origins = selected.flatMap(selection => selection.claimOrigins);
  if (origins.length > 0 && origins.every(origin => MODEL_ORIGINS.has(origin))) return 'INFERRED';
  if (selected.length === 0 || selected.some(selection => selection.certainty !== 'ACCEPTED')) return 'REPORTED';
  return origins.some(origin => OWNER_OR_AUTHORITY.has(origin)) ? 'CONFIRMED' : 'REPORTED';
}

function text(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const described = describeValue(value).trim();
  return described.length > 0 ? described.slice(0, 300) : null;
}

/** What one frame looks like in the packet: its supplied values by predicate, the
 * selections over it, its conflicts, resolutions and pending owner deltas. */
function frameView(packet: ContextPacket, frameInstanceId: string) {
  const beliefs = [...packet.currentBeliefs, ...packet.futureClaims].filter(entry => entry.frameInstanceId === frameInstanceId
    && entry.modality === TODAY_MODALITIES[entry.frameTypeId]);
  const selections = packet.selections.filter(selection => selection.frameInstanceId === frameInstanceId
    && selection.modality === TODAY_MODALITIES[selection.frameTypeId]);
  const slotIds = new Set(selections.map(selection => selection.beliefSlotId));
  const conflicts = packet.conflicts.filter(conflict => conflict.frameInstanceId === frameInstanceId && slotIds.has(conflict.beliefSlotId));
  const resolutions = packet.resolutionAssertions.filter(resolution =>
    resolution.sourceFrameInstanceId === frameInstanceId || resolution.targetFrameInstanceId === frameInstanceId);
  const pendingDeltas = packet.ownerOverlayDeltas.filter(delta => delta.attachedFrameInstanceId === frameInstanceId
    && PENDING_LIFECYCLES.has(delta.lifecycle));
  const contestedDeltas = packet.ownerOverlayDeltas.filter(delta => delta.attachedFrameInstanceId === frameInstanceId
    && delta.lifecycle === 'CONTESTED');
  /** The selected value of a predicate, or the supplied one when nothing was
   * selected (a slot whose value is contested has no selection). */
  const value = (predicateId: string): { propositionId: string; value: string } | null => {
    const selection = selections.find(entry => entry.predicateId === predicateId && entry.outcome === 'SELECTED');
    if (selection && selection.selectedPropositionId && 'selectedValue' in selection) {
      const described = text(selection.selectedValue);
      if (described) return { propositionId: selection.selectedPropositionId, value: described };
    }
    const belief = beliefs.find(entry => entry.predicateId === predicateId && 'normalizedValue' in entry);
    const described = belief ? text(belief.normalizedValue) : null;
    return belief && described ? { propositionId: belief.propositionId, value: described } : null;
  };
  /** A displayed deadline needs an applicable selected value. A supplied claim
   * alone may be contested, withheld in part, or not valid at the briefing time;
   * none of those permits a fallback to the projection's cached timestamp. */
  const time = (predicateId: string, boundary: 'due' | 'start'): string | null => {
    const selection = selections.find(entry => entry.predicateId === predicateId && entry.outcome === 'SELECTED');
    if (!selection || !('selectedValue' in selection)) return null;
    const instant = boundary === 'due' ? dueInstant(selection.selectedValue) : readTimeValue(selection.selectedValue)?.start;
    return instant?.toISOString() ?? null;
  };
  const evidenceIds = [...new Set([...beliefs.flatMap(entry => entry.evidenceIds ?? []),
    ...selections.flatMap(selection => selection.evidenceIds ?? [])])].sort();
  return { beliefs, selections, conflicts, resolutions, pendingDeltas, contestedDeltas, value, time, evidenceIds };
}

type FrameView = ReturnType<typeof frameView>;

/** The same outcome fold as the memory kernel, over only the assertions this
 * packet authorized. Partial progress does not settle a frame; two distinct
 * settling outcomes conflict. A resolution of another frame cannot settle its
 * target just because this frame appears at the other end of the relation. */
function outcomeOf(view: FrameView, frameInstanceId: string): BriefingCandidate['outcomeState'] {
  const accepted = view.resolutions.filter(resolution => resolution.sourceFrameInstanceId === frameInstanceId
    && resolution.lifecycle === 'ACCEPTED');
  const settling = new Set(accepted.map(resolution => resolution.outcomeCode).filter(code => !PARTIAL_OUTCOME_CODES.includes(code)));
  return accepted.length === 0 ? 'UNRESOLVED' : settling.size > 1 ? 'CONTESTED'
    : settling.size === 1 ? 'RESOLVED' : 'PARTIALLY_RESOLVED';
}

/** What a Why? / Sources action opens for this frame, primary first: the owner's
 * pending word when that is what the label says, the disputed values when it is
 * contested, the settling resolution when it is resolved, else the values the
 * headline states. */
function sourceRefsOf(view: FrameView, label: MemoryLabel, keyPropositions: readonly string[]): WhyRef[] {
  const deltas = [...view.pendingDeltas, ...view.contestedDeltas]
    .map(delta => ({ objectType: 'owner_overlay_deltas' as const, objectId: delta.overlayDeltaId }));
  const disputed = view.conflicts.flatMap(conflict => conflict.positions.map(position =>
    ({ objectType: 'propositions' as const, objectId: position.propositionId })));
  const resolutions = view.resolutions.map(resolution =>
    ({ objectType: 'resolution_assertions' as const, objectId: resolution.resolutionAssertionId }));
  const values = [...keyPropositions, ...view.selections.filter(selection => selection.outcome === 'SELECTED')
    .map(selection => selection.selectedPropositionId!), ...view.beliefs.map(belief => belief.propositionId)]
    .map(objectId => ({ objectType: 'propositions' as const, objectId }));
  const ordered = label === 'PENDING_OWNER_ASSERTION' ? [...deltas, ...values, ...disputed, ...resolutions]
    : label === 'CONTESTED' ? [...disputed, ...values, ...deltas, ...resolutions]
      : label === 'RESOLVED' ? [...resolutions, ...values, ...disputed, ...deltas]
        : [...values, ...disputed, ...deltas, ...resolutions];
  const seen = new Set<string>();
  return ordered.filter(ref => !seen.has(ref.objectType + ref.objectId) && seen.add(ref.objectType + ref.objectId)).slice(0, 16);
}

function domainOf(view: FrameView, kind: BriefingCandidate['kind']): BriefingDomain {
  const categories = new Set(view.beliefs.flatMap(belief => belief.lifeCategories));
  if (kind === 'OBLIGATION' || categories.has('FINANCE')) return 'FINANCE';
  if (categories.has('WORK')) return 'WORK';
  return 'PERSONAL';
}

/** A frame id is not authority for its participants or their preferred names.
 * Read a role only through a claim/value supplied by this packet, and name it
 * with an alias whose own evidence was supplied too. Unsourced canonical labels
 * and roles are deliberately not a fallback. */
async function roleLabels(tx: MemoryTransaction, packet: ContextPacket): Promise<Map<string, string>> {
  const values = [...packet.currentBeliefs, ...packet.futureClaims]
    .filter(entry => entry.modality === TODAY_MODALITIES[entry.frameTypeId]
      && 'normalizedValue' in entry && (entry.evidenceIds?.length ?? 0) > 0);
  if (values.length === 0) return new Map();
  const propositions = [...new Set(values.map(entry => entry.propositionId))];
  const evidence = [...new Set(values.flatMap(entry => entry.evidenceIds ?? []))];
  const rows = (await tx.query(
    `SELECT r.id,r.frame_instance_id,r.role_id,r.entity_id,a.id AS alias_id,a.alias_value
     FROM frame_instance_roles r
     JOIN claims c ON c.owner_scope_id=r.owner_scope_id AND c.id=r.claim_id
     JOIN propositions p ON p.owner_scope_id=c.owner_scope_id AND p.id=c.proposition_id
     JOIN belief_slots b ON b.owner_scope_id=p.owner_scope_id AND b.id=p.belief_slot_id
       AND b.frame_instance_id=r.frame_instance_id
     JOIN source_anchors s ON s.owner_scope_id=c.owner_scope_id AND s.id=c.source_anchor_id
     JOIN source_items role_source ON role_source.owner_scope_id=s.owner_scope_id AND role_source.id=s.source_item_id
     JOIN entity_aliases a ON a.owner_scope_id=r.owner_scope_id AND a.entity_id=r.entity_id
     JOIN source_items alias_source ON alias_source.owner_scope_id=a.owner_scope_id AND alias_source.id=a.source_item_id
     WHERE r.owner_scope_id=$1 AND c.proposition_id=ANY($2::uuid[])
       AND s.source_item_id=ANY($3::uuid[]) AND a.source_item_id=ANY($3::uuid[])
       AND r.role_id IN ('promisee','creditor','debtor')
       AND a.alias_type IN ('DISPLAY_NAME','FULL_NAME','GIVEN_NAME','NICKNAME')
       AND c.lifecycle NOT IN ('REJECTED','SUPPRESSED')
       AND c.recorded_at<=$4 AND r.created_at<=$4 AND a.created_at<=$4
       AND role_source.observed_at<=$4 AND alias_source.observed_at<=$4
       AND (c.valid_from IS NULL OR c.valid_from<=$5) AND (c.valid_to IS NULL OR c.valid_to>$5)
       AND (r.valid_from IS NULL OR r.valid_from<=$5) AND (r.valid_to IS NULL OR r.valid_to>$5)
       AND (a.valid_from IS NULL OR a.valid_from<=$5) AND (a.valid_to IS NULL OR a.valid_to>$5)
     ORDER BY r.frame_instance_id,r.role_id,a.alias_type,a.id,r.id`,
    [packet.ownerScopeId, propositions, evidence, packet.knowledgeTime, packet.worldTime])).rows;
  const withheld = new Set(packet.redactions.map(entry => entry.objectId));
  const labels = new Map<string, string>();
  for (const row of rows) {
    if ([row['id'], row['alias_id'], row['entity_id']].some(id => withheld.has(id as string))) continue;
    const key = row['frame_instance_id'] + ':' + row['role_id'];
    if (!labels.has(key)) labels.set(key, row['alias_value'] as string);
  }
  return labels;
}

/** Everything shown on the previous `REPEAT_SUPPRESSION_DAYS` owner-local dates. */
async function shownBefore(tx: MemoryTransaction, ownerScopeId: string, localDate: string): Promise<ShownBefore[]> {
  const rows = (await tx.query(
    `SELECT i.item_object_type,i.item_object_id,i.material_fingerprint,to_char(e.owner_local_date,'YYYY-MM-DD') AS owner_local_date
     FROM briefing_items i
     JOIN briefing_editions e ON e.owner_scope_id=i.owner_scope_id AND e.id=i.briefing_edition_id
     WHERE i.owner_scope_id=$1 AND i.rank_position IS NOT NULL
       AND e.owner_local_date>=$2::date AND e.owner_local_date<$3::date
     ORDER BY e.owner_local_date,i.id`,
    [ownerScopeId, shiftLocalDate(localDate, -REPEAT_SUPPRESSION_DAYS), localDate])).rows;
  return rows.map(row => ({
    itemObjectType: row['item_object_type'] as string, itemObjectId: row['item_object_id'] as string,
    materialFingerprint: row['material_fingerprint'] as string, ownerLocalDate: row['owner_local_date'] as string,
  }));
}

/** The owner's timezone when the request did not name one: the zone of their most
 * recent edition. A first briefing has to be told. */
async function rememberedTimeZone(runner: ContextRunner, ownerScopeId: string): Promise<string | null> {
  return runner(async tx => {
    const row = (await tx.query(
      'SELECT timezone FROM briefing_editions WHERE owner_scope_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1',
      [ownerScopeId])).rows[0];
    return (row?.['timezone'] as string | undefined) ?? null;
  });
}

/** One candidate per authorized frame in the modality its capability owns, plus
 * recent unattached owner assertions. Owner controls have already removed their
 * targets from the packet; cached projection state must not revive or hide them. */
async function candidatesOf(tx: MemoryTransaction, packet: ContextPacket, now: Date): Promise<BriefingCandidate[]> {
  const frames = new Map([...packet.currentBeliefs, ...packet.futureClaims]
    .filter(entry => entry.modality === TODAY_MODALITIES[entry.frameTypeId])
    .map(entry => [entry.frameInstanceId, entry.frameTypeId]));
  const labels = await roleLabels(tx, packet);
  const name = (frameInstanceId: string, roleId: string) => labels.get(frameInstanceId + ':' + roleId) ?? null;

  const candidates: BriefingCandidate[] = [];
  const add = (frameInstanceId: string, kind: BriefingCandidate['kind'], row: {
    targetTime: string | null; subject: string; counterpart: string; amount: string | null; keyPredicates: readonly string[];
    statedPriority: string | null;
  }) => {
    const view = frameView(packet, frameInstanceId);
    const outcomeState = outcomeOf(view, frameInstanceId);
    const resolved = outcomeState === 'RESOLVED';
    const conflict = outcomeState === 'CONTESTED' || view.conflicts.length > 0 || view.contestedDeltas.length > 0;
    const pending = view.pendingDeltas.length > 0
      || view.selections.some(selection => selection.ownerAssertionPending);
    const projectionName = kind === 'COMMITMENT' ? 'open_commitments_projection'
      : kind === 'OBLIGATION' ? 'obligations_projection' : 'schedule_projection';
    const projection = packet.projectionFragments.find(fragment => fragment.projectionName === projectionName);
    const label = frameLabel({ kind, resolved, conflict, pending, selections: view.selections });
    const keyPropositions = row.keyPredicates.map(predicate => view.value(predicate)?.propositionId)
      .filter((id): id is string => id !== undefined);
    const selected = view.selections.filter(selection => selection.outcome === 'SELECTED');
    candidates.push({
      itemObjectType: 'frame_instance', itemObjectId: frameInstanceId, kind, domainSection: domainOf(view, kind), label,
      outcomeState,
      targetTime: row.targetTime ? new Date(row.targetTime) : null,
      subject: row.subject, counterpart: row.counterpart, amount: row.amount, statedPriority: row.statedPriority,
      decisionAffectingConflict: conflict, ownerAssertionPending: pending, projectionComplete: projection?.isComplete === true,
      supportAccepted: selected.length > 0 && selected.every(selection => selection.certainty === 'ACCEPTED'),
      sourceRefs: sourceRefsOf(view, label, keyPropositions), evidenceIds: view.evidenceIds.slice(0, 64),
      materialValues: selected.map(selection => selection.selectedPropositionId + ':'
        + canonicalJson('selectedValue' in selection ? selection.selectedValue ?? null : null)),
    });
  };

  for (const [frameInstanceId, frameTypeId] of frames) {
    const view = frameView(packet, frameInstanceId);
    if (frameTypeId === 'shared.commitment') {
      // Only the promisee is named: which entity is the owner is not something the
      // briefing may guess, so "from <promisor>" could name the owner to themself.
      const promisee = name(frameInstanceId, 'promisee');
      add(frameInstanceId, 'COMMITMENT', {
        targetTime: view.time('shared.commitment.due_time', 'due'),
        subject: view.value('shared.commitment.action_description')?.value ?? 'a commitment',
        counterpart: promisee ? 'to ' + promisee : '',
        amount: null, statedPriority: view.value('shared.commitment.priority')?.value ?? null,
        keyPredicates: ['shared.commitment.action_description', 'shared.commitment.due_time'],
      });
    } else if (frameTypeId === 'shared.obligation') {
      const creditor = name(frameInstanceId, 'creditor'), debtor = name(frameInstanceId, 'debtor');
      // A disputed principal is stated as the dispute, never as one of its sides.
      const disputed = view.conflicts.find(conflict => conflict.predicateId === 'shared.obligation.principal_amount');
      const disputedAmounts = disputed?.positions.map(position => 'normalizedValue' in position ? text(position.normalizedValue) : null)
        .filter((amount): amount is string => amount !== null) ?? [];
      add(frameInstanceId, 'OBLIGATION', {
        targetTime: view.time('shared.obligation.due_time', 'due'),
        subject: view.value('shared.obligation.description')?.value ?? 'an obligation',
        counterpart: creditor ? 'to ' + creditor : debtor ? 'from ' + debtor : '',
        // State only the principal supplied by the packet. The owner-wide
        // projection may include a principal above this request's authority.
        amount: disputed ? (disputedAmounts.length > 0 ? disputedAmounts.join(' or ') + ', sources disagree' : 'amount disputed')
          : view.value('shared.obligation.principal_amount')?.value ?? null,
        statedPriority: null,
        keyPredicates: ['shared.obligation.description', 'shared.obligation.principal_amount', 'shared.obligation.due_time'],
      });
    } else if (frameTypeId === 'shared.event_occurrence') {
      // A calendar event stays SCHEDULED until a resolution assertion says
      // otherwise; a realization link alone does not make it "happened".
      add(frameInstanceId, 'SCHEDULED_EVENT', {
        targetTime: view.time('shared.event_occurrence.occurrence_time', 'start'),
        subject: view.value('shared.event_occurrence.description')?.value ?? 'an event',
        counterpart: '',
        amount: null, statedPriority: null,
        keyPredicates: ['shared.event_occurrence.description', 'shared.event_occurrence.occurrence_time'],
      });
    }
  }

  // The owner's own recent words that no frame holds yet: surfaced as pending,
  // never as a fact (CRT-RYW-03-A's unattached deltas, as the packet carries them).
  const recent = now.getTime() - PENDING_ASSERTION_DAYS * 86_400_000;
  for (const delta of packet.ownerOverlayDeltas.filter((entry: PublicOverlayDelta) => entry.attachedFrameInstanceId === null
    && PENDING_LIFECYCLES.has(entry.lifecycle) && Date.parse(entry.createdAt) >= recent && Date.parse(entry.createdAt) <= now.getTime())) {
    candidates.push({
      itemObjectType: 'owner_overlay_delta', itemObjectId: delta.overlayDeltaId, kind: 'OWNER_ASSERTION', domainSection: 'PERSONAL',
      label: 'PENDING_OWNER_ASSERTION', outcomeState: 'PENDING', targetTime: null,
      subject: delta.rawText.trim().slice(0, 300) || 'a statement', counterpart: '', amount: null, statedPriority: null,
      decisionAffectingConflict: false, ownerAssertionPending: true, projectionComplete: true, supportAccepted: false,
      sourceRefs: [{ objectType: 'owner_overlay_deltas', objectId: delta.overlayDeltaId }],
      evidenceIds: [delta.sourceEvidenceId], materialValues: [delta.lifecycle],
    });
  }
  return candidates;
}

function itemOf(item: RankedItem, briefingItemId: string): BriefingItem {
  const { candidate } = item;
  return {
    briefingItemId, itemObjectType: candidate.itemObjectType, itemObjectId: candidate.itemObjectId, kind: candidate.kind,
    domainSection: candidate.domainSection, headline: item.headline, whySurfaced: item.whySurfaced,
    certaintyLabel: candidate.label, outcomeState: candidate.outcomeState,
    targetTime: candidate.targetTime ? candidate.targetTime.toISOString() : null, targetLocal: item.targetLocal,
    pastTarget: item.pastTarget, decisionAffectingConflict: candidate.decisionAffectingConflict, priority: item.priority,
    rankScore: item.score, rankComponents: item.components, rankPosition: item.rankPosition,
    sourceRefs: [...candidate.sourceRefs], evidenceIds: [...candidate.evidenceIds],
  };
}

/**
 * Build, persist and return today's briefing for one owner.
 *
 * Refused before any retrieval with `TODAY_TIME_ZONE_REQUIRED` when no timezone
 * was given and none is remembered, `TODAY_TIME_ZONE_INVALID` for a zone `Intl`
 * does not know, and `TODAY_DATE_NOT_CURRENT` when the caller's date is not the
 * owner's current local date in that zone.
 */
export async function buildTodayBriefing(runner: ContextRunner, input: TodayInput, options: TodayOptions): Promise<TodayBriefing> {
  const now = options.now ?? new Date();
  const timeZone = input.timeZone ?? await rememberedTimeZone(runner, input.ownerScopeId);
  if (!timeZone) throw new ContextBrokerError('TODAY_TIME_ZONE_REQUIRED');
  try { assertTimeZone(timeZone); }
  catch (error) { if (error instanceof BriefingTimeError) throw new ContextBrokerError(error.message); throw error; }
  const localDate = ownerLocalDate(now, timeZone);
  if (input.date !== null && input.date !== localDate) {
    throw new ContextBrokerError('TODAY_DATE_NOT_CURRENT', { ownerLocalDate: localDate, timeZone });
  }

  // Step 1: the only memory read, through the broker (two transactions).
  const assembled = await readContextPacket(runner, {
    ownerScopeId: input.ownerScopeId, requestingActorId: options.requestingActorId, purpose: input.dataPurpose,
    query: 'Today briefing for ' + localDate + ': open commitments, obligations and scheduled events',
    frameTypeHints: [...TODAY_FRAME_TYPES], worldTime: now.toISOString(), knowledgeTime: 'LATEST',
    maximumSensitivity: input.maximumSensitivity, actionRisk: 'LOW', answerType: 'OPEN_COMMITMENTS',
    requiredCertainty: ['ACCEPTED', 'CONTESTED', 'OWNER_OVERLAY'], includeEvidence: 'WHEN_NEEDED',
  }, { ...options, now });

  // Steps 2 and 3, in one transaction: what was shown before, what is material
  // now, and the record of this edition.
  return runner(async tx => {
    await tx.query("SELECT set_config('unai.data_purpose',$1,true),set_config('unai.maximum_sensitivity',$2,true)",
      [input.dataPurpose, input.maximumSensitivity]);
    // The manifest describes the packet as it was persisted, hash checked.
    const { packet, registryReleaseId } = await readPersistedPacket(tx, { ownerScopeId: input.ownerScopeId, packetId: assembled.packetId });
    const supplied = suppliedContextOf(packet, { registryReleaseId });
    const manifest = briefingPacketManifestSchema.parse({
      contextPacketId: packet.packetId, packetHash: packet.packetHash, beliefIds: supplied.beliefIds,
      claimIds: supplied.claimIds, evidenceIds: supplied.evidenceIds, overlayDeltaIds: supplied.overlayDeltaIds,
      resolutionAssertionIds: [...new Set(packet.resolutionAssertions.map(entry => entry.resolutionAssertionId))].sort(),
      frameInstanceIds: [...new Set([...packet.currentBeliefs, ...packet.futureClaims].map(entry => entry.frameInstanceId))].sort(),
      projectionVersions: packet.watermarks.projectionVersions, watermarks: packet.watermarks,
    });

    const candidates = await candidatesOf(tx, packet, now);
    const ranked = rankBriefing(candidates, {
      now, timeZone, localDate, shownBefore: await shownBefore(tx, input.ownerScopeId, localDate),
    });

    const editionId = uuidV7();
    const projectionCompleteness = packet.projectionFragments.map(fragment => ({
      projectionName: fragment.projectionName, isComplete: fragment.isComplete, pendingAssertions: fragment.pendingAssertions,
    }));
    const recommendations = ranked.recommendations.map(entry => ({ label: 'RECOMMENDED' as const, ...entry }));
    await tx.query(
      `INSERT INTO briefing_editions(id,owner_scope_id,requesting_actor_id,owner_local_date,timezone,utc_offset,generated_at,
         context_packet_id,packet_hash,packet_manifest,recommendations,withheld_recommendations,projection_completeness,ranking_version)
       VALUES($1,$2,$3,$4::date,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [editionId, input.ownerScopeId, options.requestingActorId, localDate, timeZone, utcOffset(now, timeZone), now,
        packet.packetId, packet.packetHash, JSON.stringify(manifest), JSON.stringify(recommendations),
        JSON.stringify(ranked.withheldRecommendations), JSON.stringify(projectionCompleteness), RANKING_VERSION]);

    const items = ranked.items.map(item => ({ item, id: uuidV7() }));
    for (const { item, id } of items) {
      const { candidate } = item;
      await tx.query(
        `INSERT INTO briefing_items(id,owner_scope_id,briefing_edition_id,item_object_type,item_object_id,domain_section,headline,
           why_surfaced,rank_components,rank_score,priority,certainty_label,target_time,past_target,outcome_state,
           material_fingerprint,source_refs,suppressed_as_unchanged,deferred_by_attention_budget,rank_position)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
        [id, input.ownerScopeId, editionId, candidate.itemObjectType, candidate.itemObjectId, candidate.domainSection,
          item.headline, item.whySurfaced, JSON.stringify(item.components), item.score, item.priority, candidate.label,
          candidate.targetTime, item.pastTarget, candidate.outcomeState, item.materialFingerprint,
          JSON.stringify(candidate.sourceRefs), item.presentation === 'SUPPRESSED_UNCHANGED',
          item.presentation === 'DEFERRED_BY_ATTENTION_BUDGET', item.rankPosition]);
    }

    const shown = items.filter(({ item }) => item.presentation === 'SHOWN');
    const sections: Array<{ domain: BriefingDomain; items: BriefingItem[] }> = [];
    for (const { item, id } of shown) {
      const section = sections.find(entry => entry.domain === item.candidate.domainSection);
      if (section) section.items.push(itemOf(item, id));
      else sections.push({ domain: item.candidate.domainSection, items: [itemOf(item, id)] });
    }
    return todayBriefingSchema.parse({
      briefingEditionId: editionId, ownerLocalDate: localDate, timeZone, utcOffset: utcOffset(now, timeZone),
      generatedAt: now.toISOString(), isEmpty: shown.length === 0, sections,
      recommendations, withheldRecommendations: ranked.withheldRecommendations,
      suppressedRepeats: items.filter(({ item }) => item.presentation === 'SUPPRESSED_UNCHANGED').map(({ item, id }) => ({
        briefingItemId: id, itemObjectType: item.candidate.itemObjectType, itemObjectId: item.candidate.itemObjectId,
        headline: item.headline, lastShownOn: item.lastShownOn!,
      })),
      deferredByAttentionBudget: items.filter(({ item }) => item.presentation === 'DEFERRED_BY_ATTENTION_BUDGET').length,
      projectionCompleteness, packetManifest: manifest, rankingVersion: RANKING_VERSION,
    });
  });
}
