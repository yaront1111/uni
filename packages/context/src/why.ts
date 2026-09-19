import {
  whySourcesSchema,
  type MemoryLabel, type WhyRef, type WhySources,
} from '@unai/domain';
import { readOwnerOverlay, type MemoryTransaction } from '@unai/memory';
import { ContextBrokerError } from './broker.js';
import { explainProposition } from './explain.js';
import { describeContract, describeValue } from './wording.js';
import { readPropositionAuthority } from './support-authority.js';

/**
 * The Why? / Sources panel (design screen "Why? / Sources panel"; PRD §24.5,
 * §37.1; CRT-UX-11-A). ADR 0027.
 *
 * Activating Why?/Sources on a material statement -- a Today item or an Ask
 * statement -- opens the object the statement rests on: a belief, the owner's
 * own assertion, or the resolution assertion that settled an outcome. For each
 * the panel answers, in words, who claimed it, what the source says (the
 * anchored excerpt), when it holds, how confident the recorded claims are,
 * whether anything disputes it, and -- for an inferred statement -- how it was
 * derived.
 *
 * It is a read over rows that already exist, like the explanation it builds on
 * (`explain.ts`): nothing is re-derived and nothing is written. The source
 * excerpt is read through the evidence row policies, so a source above the
 * request's ceiling or outside its data purpose is listed as a redaction instead
 * of being shown.
 */

export const WHY_PANEL_VERSION = 'why-sources-0.4.0';
const EXCERPT_LENGTH = 600;
const MODEL_ORIGINS = new Set(['MODEL_EXTRACTION', 'MODEL_INFERENCE', 'MODEL_RECOMMENDATION', 'MODEL_PREDICTION']);
const OWNER_OR_AUTHORITY = new Set(['USER_STATEMENT', 'USER_CONFIRMATION', 'USER_CORRECTION',
  'STRUCTURED_CONNECTOR_OBSERVATION', 'TOOL_EXECUTION_RECEIPT']);
const PENDING_LIFECYCLES = new Set(['RECEIVED', 'USER_ASSERTED', 'AWAITING_INSTANCE_RESOLUTION', 'CANONICALIZATION_PENDING']);
const SOURCE_WITHHELD = 'SOURCE_NOT_READABLE_FOR_THIS_REQUEST';

/** A hidden source cannot become readable through the statement describing it. */
function withheldPanel(subject: WhyRef, subjectKind: WhySources['subjectKind'], readAt: Date): WhySources {
  return whySourcesSchema.parse({
    subject, subjectKind, label: 'UNKNOWN', statement: 'This statement is withheld because its source is not readable for this request.',
    modality: null, assessmentStatus: null, effectiveTime: { from: null, to: null, recordedAt: null },
    confidence: { extraction: null, entityResolution: null, temporalResolution: null, instanceResolution: null, assessmentStatus: null },
    claims: [], claimingActors: [], sources: [], redactions: [{ claimId: null, reason: SOURCE_WITHHELD }],
    conflict: { status: 'NO_CONFLICT', competing: [], relations: [] },
    derivation: { isInferred: false, steps: [], modelClaims: [] }, resolutions: [], explainPath: null,
    panelVersion: WHY_PANEL_VERSION, readAt: readAt.toISOString(),
  });
}

type Row = Record<string, unknown>;
const iso = (value: unknown): string | null => value instanceof Date ? value.toISOString() : null;
const unit = (value: unknown): number | null => {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

/** A withheld name does not change who asserted the claim. Use the recorded
 * actor kind without a name; only claims with no actor fall back to origin. */
function claimingActor(row: Row, sourceType: string | null) {
  const entityId = (row['asserted_by_entity_id'] as string | null) ?? null;
  const label = (row['entity_label'] as string | null) ?? null;
  const kind = (row['entity_kind'] as string | null) ?? null;
  if (entityId) {
    if (kind === 'PERSON') return { kind: 'PERSON' as const, label: label ?? 'A person', entityId };
    if (kind === 'ORGANIZATION') return { kind: 'ORGANIZATION' as const, label: label ?? 'An organization', entityId };
    if (kind === 'DOCUMENT') return { kind: 'DOCUMENT' as const, label: label ?? 'A document', entityId };
    return { kind: 'UNKNOWN' as const, label: label ?? 'Not recorded', entityId };
  }
  const origin = row['claim_origin'] as string;
  if (origin.startsWith('USER_')) return { kind: 'OWNER' as const, label: 'You', entityId };
  if (origin === 'STRUCTURED_CONNECTOR_OBSERVATION') {
    return { kind: 'CONNECTED_SOURCE' as const, label: 'A connected source' + (sourceType ? ' (' + sourceType.toLowerCase().replaceAll('_', ' ') + ')' : ''), entityId };
  }
  if (origin === 'DOCUMENT_ASSERTION') return { kind: 'DOCUMENT' as const, label: 'A document', entityId };
  if (MODEL_ORIGINS.has(origin)) return { kind: 'MODEL' as const, label: 'Uai (a model reading, not a person)', entityId };
  if (origin === 'TOOL_EXECUTION_RECEIPT') return { kind: 'TOOL' as const, label: 'A tool receipt', entityId };
  if (origin === 'EXTERNAL_PERSON_ASSERTION') return { kind: 'PERSON' as const, label: 'Another person, not yet identified', entityId };
  return { kind: 'UNKNOWN' as const, label: 'Not recorded', entityId };
}

/** The anchored words of the given anchors, as far as this request may read them.
 * The anchor rows are read through their own policy, which applies the evidence
 * item's purposes and the ceiling; an anchor that does not come back is withheld. */
async function readAnchors(tx: MemoryTransaction, ownerScopeId: string, anchorIds: readonly string[]) {
  if (anchorIds.length === 0) return new Map<string, Row>();
  const rows = (await tx.query(
    `SELECT a.id,a.anchor_kind,a.normalized_text,a.source_item_id,s.source_type,s.occurred_at
     FROM source_anchors a JOIN source_items s ON s.owner_scope_id=a.owner_scope_id AND s.id=a.source_item_id
     WHERE a.owner_scope_id=$1 AND a.id=ANY($2::uuid[]) AND s.deleted_at IS NULL`,
    [ownerScopeId, [...new Set(anchorIds)]])).rows;
  return new Map(rows.map(row => [row['id'] as string, row]));
}

function excerptOf(anchor: Row) {
  const words = (anchor['normalized_text'] as string | null) ?? null;
  return {
    evidenceId: anchor['source_item_id'] as string, sourceType: anchor['source_type'] as string,
    occurredAt: iso(anchor['occurred_at']), anchorKind: anchor['anchor_kind'] as string,
    excerpt: words === null ? null : words.length > EXCERPT_LENGTH ? words.slice(0, EXCERPT_LENGTH - 1) + '…' : words,
  };
}

/** Claims with a sourced, readable name for the asserting entity. Canonical
 * labels have no provenance of their own and cannot authorize a displayed name. */
async function readClaims(tx: MemoryTransaction, ownerScopeId: string,
  where: { propositionId?: string; claimIds?: readonly string[] }, readAt: Date) {
  const rows = (await tx.query(
    `SELECT c.id,c.claim_origin,c.asserted_by_entity_id,c.recorded_at,c.valid_from,c.valid_to,c.source_anchor_id,
       c.extraction_run_id,c.extraction_confidence,c.entity_resolution_confidence,c.temporal_resolution_confidence,
       c.instance_resolution_confidence,e.entity_kind,
       (SELECT a.alias_value FROM entity_aliases a
          JOIN source_items s ON s.owner_scope_id=a.owner_scope_id AND s.id=a.source_item_id
          WHERE a.owner_scope_id=c.owner_scope_id AND a.entity_id=c.asserted_by_entity_id
            AND a.alias_type IN ('DISPLAY_NAME','FULL_NAME','GIVEN_NAME','NICKNAME') AND a.created_at<=$4
            AND (a.valid_from IS NULL OR a.valid_from<=$4) AND (a.valid_to IS NULL OR a.valid_to>$4)
          ORDER BY a.alias_type,a.id LIMIT 1) AS entity_label,
       r.model_id,r.prompt_version
     FROM claims c
     LEFT JOIN entities e ON e.owner_scope_id=c.owner_scope_id AND e.id=c.asserted_by_entity_id
     LEFT JOIN extraction_runs r ON r.owner_scope_id=c.owner_scope_id AND r.id=c.extraction_run_id
     WHERE c.owner_scope_id=$1 AND (c.proposition_id=$2 OR c.id=ANY($3::uuid[]))
       AND ((unai_private.object_state_at(c.owner_scope_id,'claims',c.id,$4)->>'proposition_id')::uuid=$2 OR c.id=ANY($3::uuid[]))
       AND c.recorded_at<=$4 AND unai_private.object_state_at(c.owner_scope_id,'claims',c.id,$4) IS NOT NULL
     ORDER BY c.recorded_at,c.id`,
    [ownerScopeId, where.propositionId ?? null, [...(where.claimIds ?? [])], readAt])).rows;
  const anchors = await readAnchors(tx, ownerScopeId, rows.map(row => row['source_anchor_id'] as string));
  const redactions: Array<{ claimId: string | null; reason: string }> = [];
  const claims = rows.flatMap(row => {
    const anchor = anchors.get(row['source_anchor_id'] as string) ?? null;
    if (!anchor) {
      redactions.push({ claimId: row['id'] as string, reason: SOURCE_WITHHELD });
      return [];
    }
    return [{
      row,
      value: {
        claimId: row['id'] as string, claimOrigin: row['claim_origin'] as string,
        claimingActor: claimingActor(row, anchor['source_type'] as string),
        recordedAt: iso(row['recorded_at'])!, validFrom: iso(row['valid_from']), validTo: iso(row['valid_to']),
        confidence: {
          extraction: unit(row['extraction_confidence']), entityResolution: unit(row['entity_resolution_confidence']),
          temporalResolution: unit(row['temporal_resolution_confidence']), instanceResolution: unit(row['instance_resolution_confidence']),
        },
        source: excerptOf(anchor),
      },
    }];
  });
  return { claims, redactions };
}

/** The weakest recorded confidence of each kind. A panel that averaged them would
 * present a claim as surer than its least certain step. */
function weakest(claims: ReadonlyArray<{ value: { confidence: Record<string, number | null> } }>) {
  const lowest = (key: string) => {
    const values = claims.map(claim => claim.value.confidence[key]).filter((value): value is number => value !== null && value !== undefined);
    return values.length === 0 ? null : Math.min(...values);
  };
  return { extraction: lowest('extraction'), entityResolution: lowest('entityResolution'),
    temporalResolution: lowest('temporalResolution'), instanceResolution: lowest('instanceResolution') };
}

function distinctActors<T extends { label: string; kind: string; entityId: string | null }>(actors: readonly T[]): T[] {
  const seen = new Set<string>();
  return actors.filter(actor => { const key = actor.kind + (actor.entityId ?? actor.label); return !seen.has(key) && !!seen.add(key); });
}

function distinctSources<T extends { evidenceId: string; anchorKind: string; excerpt: string | null }>(sources: readonly (T | null)[]): T[] {
  const seen = new Set<string>();
  return sources.filter((source): source is T => source !== null)
    .filter(source => { const key = source.evidenceId + source.anchorKind + (source.excerpt ?? ''); return !seen.has(key) && !!seen.add(key); });
}

async function propositionStatement(tx: MemoryTransaction, ownerScopeId: string, ids: readonly string[], readAt: Date): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const authority = await readPropositionAuthority(tx, { ownerScopeId, propositionIds: ids, knowledgeTime: readAt });
  const readable = [...new Set(ids)].filter(id => authority.get(id)?.readable);
  const rows = (await tx.query(
    `SELECT p.id,p.normalized_value,s.predicate_id,f.frame_type_id FROM propositions p
     JOIN belief_slots s ON s.owner_scope_id=p.owner_scope_id AND s.id=p.belief_slot_id
     JOIN frame_instances f ON f.owner_scope_id=s.owner_scope_id AND f.id=s.frame_instance_id
     WHERE p.owner_scope_id=$1 AND p.id=ANY($2::uuid[])`, [ownerScopeId, readable])).rows;
  return new Map(rows.map(row => [row['id'] as string,
    describeContract(row['frame_type_id'] as string, row['predicate_id'] as string) + ': ' + describeValue(row['normalized_value'])]));
}

async function whyProposition(tx: MemoryTransaction, input: { ownerScopeId: string; propositionId: string; readAt: Date }): Promise<WhySources> {
  let explanation: Awaited<ReturnType<typeof explainProposition>>;
  try {
    explanation = await explainProposition(tx, { ownerScopeId: input.ownerScopeId, propositionId: input.propositionId, readAt: input.readAt });
  } catch (error) {
    if (error instanceof ContextBrokerError && error.message === 'PROPOSITION_HISTORY_UNAVAILABLE') {
      return whySourcesSchema.parse({ ...withheldPanel({ objectType: 'propositions', objectId: input.propositionId }, 'BELIEF', input.readAt),
        statement: 'The historical state of this belief was not recorded.', redactions: [] });
    }
    if (error instanceof ContextBrokerError && error.message === 'PROPOSITION_SOURCE_WITHHELD') {
      return withheldPanel({ objectType: 'propositions', objectId: input.propositionId }, 'BELIEF', input.readAt);
    }
    throw error;
  }
  const { claims, redactions } = await readClaims(tx, input.ownerScopeId, { propositionId: input.propositionId }, input.readAt);
  const supportingAnchors = await readAnchors(tx, input.ownerScopeId, explanation.evidenceAnchors.map(anchor => anchor.sourceAnchorId));
  const origins = claims.map(claim => claim.value.claimOrigin);

  // The derivation path: the recorded dependencies of a derived value, and any
  // proposition that lends it DERIVATION support (PRD §16.4).
  const dependencyCandidates = (await tx.query(
    `SELECT evaluator_id,model_or_code_version,input_claim_ids,input_proposition_ids FROM derived_proposition_dependencies
     WHERE owner_scope_id=$1 AND derived_proposition_id=$2 AND created_at<=$3 ORDER BY created_at,id`,
    [input.ownerScopeId, input.propositionId, input.readAt])).rows;
  const derivedSupport = explanation.supportGraph.filter(support => support.supportKind === 'DERIVATION' && support.supportingPropositionId);
  const inputClaimIds = dependencyCandidates.flatMap(row => row['input_claim_ids'] as string[]);
  const inputClaimRows = inputClaimIds.length === 0 ? [] : (await tx.query(
    `SELECT c.id,c.proposition_id,c.claim_origin FROM claims c
     JOIN source_anchors a ON a.owner_scope_id=c.owner_scope_id AND a.id=c.source_anchor_id
     WHERE c.owner_scope_id=$1 AND c.id=ANY($2::uuid[]) AND c.recorded_at<=$3`,
    [input.ownerScopeId, [...new Set(inputClaimIds)], input.readAt])).rows;
  const inputAuthority = await readPropositionAuthority(tx, { ownerScopeId: input.ownerScopeId, knowledgeTime: input.readAt,
    propositionIds: dependencyCandidates.flatMap(row => row['input_proposition_ids'] as string[]) });
  const readableClaimIds = new Set(inputClaimRows.map(row => row['id'] as string));
  const dependencies = dependencyCandidates.filter(row => (row['input_claim_ids'] as string[]).every(id => readableClaimIds.has(id))
    && (row['input_proposition_ids'] as string[]).every(id => inputAuthority.get(id)?.readable));
  const statements = await propositionStatement(tx, input.ownerScopeId, [
    ...dependencies.flatMap(row => row['input_proposition_ids'] as string[]),
    ...inputClaimRows.map(row => row['proposition_id'] as string | null).filter((id): id is string => id !== null),
    ...derivedSupport.map(support => support.supportingPropositionId!),
    ...explanation.contradictions.filter(entry => entry.kind === 'COMPETING_PROPOSITION').map(entry => entry.objectId),
  ], input.readAt);
  const claimStatement = (claimId: string) => {
    const row = inputClaimRows.find(entry => entry.id === claimId);
    const proposition = row?.['proposition_id'] as string | null | undefined;
    return (proposition ? statements.get(proposition) : undefined) ?? 'A recorded claim (' + String(row?.['claim_origin'] ?? 'origin not readable').toLowerCase().replaceAll('_', ' ') + ')';
  };
  const steps = [
    ...dependencies.map(row => ({
      evaluatorId: row['evaluator_id'] as string, version: row['model_or_code_version'] as string,
      inputs: [
        ...(row['input_claim_ids'] as string[]).map(objectId => ({ objectType: 'claims' as const, objectId, statement: claimStatement(objectId) })),
        ...(row['input_proposition_ids'] as string[]).map(objectId => ({ objectType: 'propositions' as const, objectId,
          statement: statements.get(objectId) ?? 'A recorded value that this request cannot read' })),
      ],
    })),
    ...(derivedSupport.length === 0 ? [] : [{
      evaluatorId: 'belief_support.derivation', version: 'recorded',
      inputs: derivedSupport.map(support => ({ objectType: 'propositions' as const, objectId: support.supportingPropositionId!,
        statement: statements.get(support.supportingPropositionId!) ?? 'A recorded value that this request cannot read' })),
    }]),
  ];
  const modelClaims = claims.filter(claim => MODEL_ORIGINS.has(claim.value.claimOrigin)).map(claim => ({
    claimId: claim.value.claimId, claimOrigin: claim.value.claimOrigin,
    modelId: (claim.row['model_id'] as string | null) ?? null, promptVersion: (claim.row['prompt_version'] as string | null) ?? null,
  }));
  const isInferred = steps.length > 0 || (origins.length > 0 && origins.every(origin => MODEL_ORIGINS.has(origin)));

  const competing = explanation.contradictions.filter(entry => entry.kind === 'COMPETING_PROPOSITION');
  const competingStatus = competing.length === 0 ? [] : (await tx.query(
    `SELECT p.id,(SELECT b.assessment_status FROM belief_assessments b WHERE b.owner_scope_id=p.owner_scope_id
       AND b.proposition_id=p.id AND b.recorded_at<=$3 AND (b.superseded_recorded_at IS NULL OR b.superseded_recorded_at>$3)
       ORDER BY b.recorded_at DESC,b.id DESC LIMIT 1) AS status
     FROM propositions p WHERE p.owner_scope_id=$1 AND p.id=ANY($2::uuid[])`,
    [input.ownerScopeId, competing.map(entry => entry.objectId), input.readAt])).rows;
  const status = explanation.currentAssessment.assessmentStatus;
  const contested = competing.length > 0 || status === 'CONTESTED'
    || explanation.contradictions.some(entry => entry.kind === 'CONTESTED_OVERLAY_DELTA' || entry.kind === 'MEMORY_LINK');
  const corrected = explanation.contradictions.some(entry => entry.kind === 'CLAIM_RELATION');
  const resolutionIds = explanation.resolutionLinks.filter(link => link.objectType === 'resolution_assertion').map(link => link.objectId);
  const readableResolutionIds = new Set((await tx.query(
    `SELECT r.id FROM resolution_assertions r
     JOIN claims c ON c.owner_scope_id=r.owner_scope_id AND c.id=r.claim_id
     JOIN source_anchors a ON a.owner_scope_id=c.owner_scope_id AND a.id=c.source_anchor_id
     WHERE r.owner_scope_id=$1 AND r.id=ANY($2::uuid[])`, [input.ownerScopeId, resolutionIds])).rows.map(row => row['id'] as string));
  const resolutions = explanation.resolutionLinks.filter(link => link.objectType === 'resolution_assertion'
    && readableResolutionIds.has(link.objectId) && link.outcomeCode && link.effectiveAt)
    .map(link => ({ resolutionAssertionId: link.objectId, outcomeCode: link.outcomeCode!, effectiveAt: link.effectiveAt!, lifecycle: link.lifecycle }));
  const readableEvidenceIds = new Set((await tx.query('SELECT id FROM source_items WHERE owner_scope_id=$1',
    [input.ownerScopeId])).rows.map(row => row['id'] as string));
  const pending = explanation.ownerOverlayDeltas.some(delta => readableEvidenceIds.has(delta.sourceEvidenceId)
    && PENDING_LIFECYCLES.has(delta.lifecycle));

  const label: MemoryLabel = contested ? 'CONTESTED'
    : resolutions.some(resolution => resolution.lifecycle === 'ACCEPTED' && resolution.effectiveAt <= input.readAt.toISOString()) ? 'RESOLVED'
      : pending ? 'PENDING_OWNER_ASSERTION'
        : explanation.modality === 'SCHEDULED' ? 'SCHEDULED'
          : isInferred ? 'INFERRED'
            : status === 'ACCEPTED' && origins.some(origin => OWNER_OR_AUTHORITY.has(origin)) ? 'CONFIRMED' : 'REPORTED';
  const live = explanation.temporalHistory.filter(entry => entry.supersededRecordedAt === null).at(-1) ?? null;
  const from = live?.validFrom ?? claims.map(claim => claim.value.validFrom).filter((value): value is string => value !== null).sort()[0] ?? null;
  const to = live?.validTo ?? null;

  return whySourcesSchema.parse({
    subject: { objectType: 'propositions', objectId: input.propositionId }, subjectKind: 'BELIEF', label,
    statement: describeContract(explanation.frameTypeId, explanation.predicateId) + ': ' + describeValue(explanation.normalizedValue),
    modality: explanation.modality, assessmentStatus: status,
    effectiveTime: { from, to, recordedAt: explanation.currentAssessment.recordedAt },
    confidence: { ...weakest(claims), assessmentStatus: status },
    claims: claims.map(claim => claim.value),
    claimingActors: distinctActors(claims.map(claim => claim.value.claimingActor)),
    sources: distinctSources([...claims.map(claim => claim.value.source), ...[...supportingAnchors.values()].map(excerptOf)]),
    redactions,
    conflict: {
      status: contested ? 'CONTESTED' : corrected ? 'CORRECTED_OR_SUPERSEDED' : 'NO_CONFLICT',
      competing: competing.map(entry => ({
        propositionId: entry.objectId, statement: statements.get(entry.objectId) ?? 'A competing value this request cannot read',
        assessmentStatus: (competingStatus.find(row => row['id'] === entry.objectId)?.['status'] as string | null) ?? null,
      })),
      relations: explanation.contradictions.map(entry => ({ kind: entry.kind, relation: entry.relation })),
    },
    derivation: { isInferred, steps, modelClaims },
    resolutions,
    explainPath: '/v1/memory/propositions/' + input.propositionId + '/explain',
    panelVersion: WHY_PANEL_VERSION, readAt: input.readAt.toISOString(),
  });
}

async function whyOverlayDelta(tx: MemoryTransaction, input: { ownerScopeId: string; overlayDeltaId: string; readAt: Date }): Promise<WhySources> {
  const overlay = await readOwnerOverlay(tx, { ownerScopeId: input.ownerScopeId, knowledgeTime: input.readAt });
  const delta = overlay.deltas.find(entry => entry.overlayDeltaId === input.overlayDeltaId);
  if (!delta) throw new ContextBrokerError('WHY_OBJECT_NOT_FOUND');
  // The owner's words are stored as evidence before anything else happens
  // (CRT-RYW-06-A), so a statement with no readable anchor is one this request
  // may not read, not one without a source.
  const anchorRows = (await tx.query(
    `SELECT a.id FROM source_anchors a WHERE a.owner_scope_id=$1 AND a.source_item_id=$2 ORDER BY a.id LIMIT 5`,
    [input.ownerScopeId, delta.sourceEvidenceId])).rows;
  const anchors = await readAnchors(tx, input.ownerScopeId, anchorRows.map(row => row['id'] as string));
  const sources = [...anchors.values()].map(excerptOf);
  if (sources.length === 0) {
    return withheldPanel({ objectType: 'owner_overlay_deltas', objectId: input.overlayDeltaId }, 'OWNER_ASSERTION', input.readAt);
  }
  const owner = { kind: 'OWNER' as const, label: 'You', entityId: null };
  const contested = delta.lifecycle === 'CONTESTED';
  const reason = contested && typeof delta.contestedReason?.['code'] === 'string' ? delta.contestedReason['code'] as string
    : contested ? 'OWNER_ASSERTION_CONTESTED' : null;
  return whySourcesSchema.parse({
    subject: { objectType: 'owner_overlay_deltas', objectId: delta.overlayDeltaId }, subjectKind: 'OWNER_ASSERTION',
    label: contested ? 'CONTESTED' : PENDING_LIFECYCLES.has(delta.lifecycle) ? 'PENDING_OWNER_ASSERTION'
      : delta.lifecycle === 'COMMITTED' ? 'CONFIRMED' : 'REPORTED',
    statement: 'You said: “' + delta.rawText.slice(0, 900) + '”'
      + (PENDING_LIFECYCLES.has(delta.lifecycle) ? ' This is your assertion and is not yet independently verified.' : ''),
    modality: null, assessmentStatus: null,
    effectiveTime: { from: delta.createdAt, to: null, recordedAt: delta.createdAt },
    confidence: { extraction: null, entityResolution: null, temporalResolution: null, instanceResolution: null, assessmentStatus: null },
    claims: [], claimingActors: [owner], sources,
    redactions: sources.length === 0 ? [{ claimId: null, reason: SOURCE_WITHHELD }] : [],
    conflict: { status: contested ? 'CONTESTED' : 'NO_CONFLICT', competing: [],
      relations: reason ? [{ kind: 'CONTESTED_OVERLAY_DELTA', relation: reason.slice(0, 64) }] : [] },
    derivation: { isInferred: false, steps: [], modelClaims: [] },
    resolutions: [], explainPath: null, panelVersion: WHY_PANEL_VERSION, readAt: input.readAt.toISOString(),
  });
}

async function whyResolution(tx: MemoryTransaction, input: { ownerScopeId: string; resolutionAssertionId: string; readAt: Date }): Promise<WhySources> {
  const row = (await tx.query(
    `SELECT id,outcome_code,effective_at,unai_private.object_state_at(owner_scope_id,'resolution_assertions',id,$3)->>'lifecycle' AS lifecycle,
       claim_id,recorded_at,source_frame_instance_id FROM resolution_assertions
     WHERE owner_scope_id=$1 AND id=$2 AND recorded_at<=$3`, [input.ownerScopeId, input.resolutionAssertionId, input.readAt])).rows[0];
  if (!row) throw new ContextBrokerError('WHY_OBJECT_NOT_FOUND');
  const { claims, redactions } = await readClaims(tx, input.ownerScopeId, { claimIds: [row['claim_id'] as string] }, input.readAt);
  if (claims.length === 0) {
    return withheldPanel({ objectType: 'resolution_assertions', objectId: input.resolutionAssertionId }, 'RESOLUTION', input.readAt);
  }
  if (!row['lifecycle']) return whySourcesSchema.parse({ ...withheldPanel({ objectType: 'resolution_assertions', objectId: input.resolutionAssertionId }, 'RESOLUTION', input.readAt),
    statement: 'The historical state of this outcome was not recorded.', redactions: [] });
  const accepted = row['lifecycle'] === 'ACCEPTED' && (row['effective_at'] as Date) <= input.readAt;
  const outcome = (row['outcome_code'] as string).toLowerCase().replaceAll('_', ' ');
  const effectiveAt = iso(row['effective_at'])!;
  return whySourcesSchema.parse({
    subject: { objectType: 'resolution_assertions', objectId: row['id'] }, subjectKind: 'RESOLUTION',
    label: accepted ? 'RESOLVED' : 'REPORTED',
    statement: 'Outcome recorded: ' + outcome + ', effective ' + effectiveAt.slice(0, 10) + (accepted ? '.' : row['lifecycle'] === 'ACCEPTED' ? ' (takes effect later).' : ' (not yet accepted).'),
    modality: null, assessmentStatus: null,
    effectiveTime: { from: effectiveAt, to: null, recordedAt: iso(row['recorded_at']) },
    confidence: { ...weakest(claims), assessmentStatus: null },
    claims: claims.map(claim => claim.value),
    claimingActors: distinctActors(claims.map(claim => claim.value.claimingActor)),
    sources: distinctSources(claims.map(claim => claim.value.source)), redactions,
    conflict: { status: 'NO_CONFLICT', competing: [], relations: [] },
    derivation: { isInferred: false, steps: [], modelClaims: [] },
    resolutions: [{ resolutionAssertionId: row['id'], outcomeCode: row['outcome_code'], effectiveAt, lifecycle: row['lifecycle'] }],
    explainPath: null, panelVersion: WHY_PANEL_VERSION, readAt: input.readAt.toISOString(),
  });
}

/** Open the Why? / Sources panel for one object. */
export async function readWhySources(tx: MemoryTransaction, input: { ownerScopeId: string; ref: WhyRef; readAt: Date }): Promise<WhySources> {
  switch (input.ref.objectType) {
    case 'propositions':
      try { return await whyProposition(tx, { ownerScopeId: input.ownerScopeId, propositionId: input.ref.objectId, readAt: input.readAt }); }
      catch (error) {
        if (error instanceof ContextBrokerError && error.message === 'PROPOSITION_NOT_FOUND') throw new ContextBrokerError('WHY_OBJECT_NOT_FOUND');
        throw error;
      }
    case 'owner_overlay_deltas':
      return whyOverlayDelta(tx, { ownerScopeId: input.ownerScopeId, overlayDeltaId: input.ref.objectId, readAt: input.readAt });
    case 'resolution_assertions':
      return whyResolution(tx, { ownerScopeId: input.ownerScopeId, resolutionAssertionId: input.ref.objectId, readAt: input.readAt });
  }
}
