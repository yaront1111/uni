import { z } from 'zod';
import { claimOriginSchema, claimLifecycleSchema, modalitySchema, temporalInterpretationSchema,
  type SlotDescriptor } from '@unai/domain';
import { recordClaim } from './claims.js';
import { applyInstanceDecision, matchFrameInstance, recordInstanceDecision,
  type InstanceMatch, type InstanceMatchRequest, type RoleFiller, type UpdateMateriality } from './instances.js';
import { resolveBeliefSlot, resolveProposition, type PropositionLookup, type SlotLookup } from './slots.js';
import { MemoryStoreError, type MemoryTransaction } from './transaction.js';

/** Canonicalization: from extractor output to a claim in a governed slot
 * (PRD §11.6, §44.16; CRT-REG-06-A).
 *
 * The rule this module exists to enforce is PRD §11.6: canonicalization defaults
 * to `BASE`, extractors MUST NOT choose the context kind, `QUOTED` is created
 * only by an explicit registry rule or capability decision, and ordinary reported
 * speech is handled by *source attribution* instead.
 *
 * So "Daniel says I owe ILS 50" and "Daniel believes I owe ILS 50" reach the same
 * BASE slot as "I owe Daniel ILS 50" would. What differs between them is who
 * asserted the claim and how they phrased it -- recorded on the claim as
 * `asserted_by_entity_id` and an attribution record -- not which world the
 * proposition lives in. Splitting slots by phrasing would leave the same
 * obligation with two disconnected amounts, and nothing would ever contradict
 * anything.
 *
 * An extractor that names a context kind or a context space is refused with
 * `EXTRACTOR_CONTEXT_SELECTION_REFUSED` rather than quietly obeyed, because a
 * silent ignore makes the rule invisible in the logs of the one run where the
 * extractor tried.
 */

export const CANONICALIZATION_VERSION = 'canonicalization-0.1.0';

type Modality = z.infer<typeof modalitySchema>;

export type ContextKind = 'BASE' | 'QUOTED' | 'TEST';

/** The only thing that may create a non-BASE context (PRD §11.6 rule 4). It comes
 * from the pinned registry release's `contextPolicy` or from a capability
 * decision; release 0.1.0 states that no rule in it creates QUOTED. */
export interface ContextRule {
  readonly contextKind: Exclude<ContextKind, 'BASE'>;
  readonly ruleId: string;
  readonly source: 'REGISTRY_RULE' | 'CAPABILITY_DECISION';
}

export interface ContextDecision {
  readonly contextSpaceId: string;
  readonly contextKind: ContextKind;
  readonly reason: Readonly<{ code: string; ruleId?: string; source?: string; canonicalizationVersion: string }>;
}

/** What the extractor said about context. Every field here is refused; the type
 * exists so the refusal is explicit and typed rather than an unknown-key error. */
export interface ExtractorContextSelection {
  readonly contextKind?: string;
  readonly contextSpaceId?: string;
}

/**
 * The context space a claim canonicalizes into.
 *
 * BASE unless an explicit rule says otherwise, and never what the extractor
 * asked for. A rule that asks for QUOTED must find an existing active QUOTED
 * context space: nothing in the delivered system creates one, so a rule cannot
 * conjure a quoted world as a side effect of canonicalizing a sentence.
 */
export async function resolveCanonicalContext(tx: MemoryTransaction, input: {
  ownerScopeId: string; frameTypeId?: string; predicateId?: string;
  contextRule?: ContextRule | null; extractorContext?: ExtractorContextSelection | null;
}): Promise<ContextDecision> {
  if (input.extractorContext && (input.extractorContext.contextKind !== undefined || input.extractorContext.contextSpaceId !== undefined)) {
    throw new MemoryStoreError('EXTRACTOR_CONTEXT_SELECTION_REFUSED');
  }
  if (input.contextRule) {
    const row = (await tx.query(
      `SELECT id FROM context_spaces WHERE owner_scope_id=$1 AND context_kind=$2 AND lifecycle='ACTIVE'
       ORDER BY created_at LIMIT 1`, [input.ownerScopeId, input.contextRule.contextKind])).rows[0];
    if (!row) throw new MemoryStoreError('QUOTED_CONTEXT_SPACE_UNAVAILABLE');
    return Object.freeze({
      contextSpaceId: row['id'] as string, contextKind: input.contextRule.contextKind,
      reason: Object.freeze({ code: 'EXPLICIT_CONTEXT_RULE', ruleId: input.contextRule.ruleId,
        source: input.contextRule.source, canonicalizationVersion: CANONICALIZATION_VERSION }),
    });
  }
  const row = (await tx.query(
    `SELECT id FROM context_spaces WHERE owner_scope_id=$1 AND context_kind='BASE' AND lifecycle='ACTIVE'`,
    [input.ownerScopeId])).rows[0];
  if (!row) throw new MemoryStoreError('BASE_CONTEXT_SPACE_MISSING');
  return Object.freeze({
    contextSpaceId: row['id'] as string, contextKind: 'BASE' as const,
    reason: Object.freeze({ code: 'DEFAULT_BASE_CONTEXT', canonicalizationVersion: CANONICALIZATION_VERSION }),
  });
}

export type AttributionKind = 'DIRECT_STATEMENT' | 'REPORTED_SPEECH' | 'REPORTED_BELIEF';

export interface SourceAttribution {
  readonly attributionKind: AttributionKind;
  readonly reportingVerb: string | null;
  /** Always false in this release: reported speech is attribution, not a quoted
   * world (PRD §11.6 rule 3, §44.16). */
  readonly createsQuotedContext: boolean;
  readonly contextKind: ContextKind;
  readonly statement: string | null;
}

const REPORTED_SPEECH = /\b(says?|said|tells? me|told me|claims?|claimed|mentioned|wrote)\b/i;
const REPORTED_BELIEF = /\b(believes?|believed|thinks?|thought|assumes?|reckons?|is sure)\b/i;

/** Read the reporting frame of an utterance. "Daniel says X" and "Daniel
 * believes X" differ here and nowhere else: both answer `BASE` and both refuse to
 * create a quoted context. */
export function classifySourceAttribution(statement?: string | null): SourceAttribution {
  const text = statement ?? null;
  const belief = text ? REPORTED_BELIEF.exec(text) : null;
  const speech = text ? REPORTED_SPEECH.exec(text) : null;
  const attributionKind: AttributionKind = belief ? 'REPORTED_BELIEF' : speech ? 'REPORTED_SPEECH' : 'DIRECT_STATEMENT';
  return Object.freeze({
    attributionKind,
    reportingVerb: (belief?.[0] ?? speech?.[0] ?? null)?.toLowerCase() ?? null,
    createsQuotedContext: false,
    contextKind: 'BASE' as const,
    statement: text,
  });
}

const confidence = z.number().min(0).max(1);
const registryId = z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/);

export interface CanonicalizationRequest {
  readonly ownerScopeId: string;
  readonly frameTypeId: string;
  readonly predicateId: string;
  readonly modality: Modality;
  readonly qualifiers?: SlotDescriptor['qualifiers'];
  readonly normalizedValue: unknown;
  readonly polarity?: 'POSITIVE' | 'NEGATIVE';
  readonly roles?: readonly RoleFiller[];
  readonly identityAnchorRoles?: readonly string[];
  readonly externalIdentifierRoles?: readonly string[];
  /** The discourse, document and connector signals of PRD §13.4. */
  readonly instanceSignals?: Omit<InstanceMatchRequest, 'ownerScopeId' | 'frameTypeId' | 'contextSpaceId' | 'roles' | 'identityAnchorRoles' | 'externalIdentifierRoles'>;
  readonly materiality?: UpdateMateriality;
  readonly sourceAnchorId: string;
  readonly claimOrigin: z.input<typeof claimOriginSchema>;
  readonly lifecycle?: z.input<typeof claimLifecycleSchema>;
  readonly extractionRunId?: string | null;
  /** Who asserted it. "Daniel says I owe ILS 50" attributes the claim to Daniel;
   * the proposition still lives in BASE. */
  readonly assertedByEntityId?: string | null;
  readonly statement?: string | null;
  readonly validFrom?: Date | null;
  readonly validTo?: Date | null;
  readonly temporalInterpretation?: z.input<typeof temporalInterpretationSchema> | null;
  readonly extractionConfidence?: number | null;
  readonly entityResolutionConfidence?: number | null;
  readonly temporalResolutionConfidence?: number | null;
  readonly instanceResolutionConfidence?: number | null;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly registryReleaseId?: string | null;
  readonly normalizationVersion?: string;
  readonly contextRule?: ContextRule | null;
  /** Refused, always. */
  readonly extractorContext?: ExtractorContextSelection | null;
  readonly contextKind?: string;
  readonly contextSpaceId?: string;
}

export interface CanonicalizedClaim {
  readonly context: ContextDecision;
  readonly attribution: SourceAttribution;
  readonly frameInstanceId: string;
  readonly instanceCreated: boolean;
  readonly instanceMatch: InstanceMatch;
  readonly reusedExistingInstance: boolean;
  readonly recordedCandidateIds: readonly string[];
  readonly beliefSlotId: string;
  readonly slotLookup: SlotLookup;
  readonly propositionId: string;
  readonly propositionLookup: PropositionLookup;
  readonly claimId: string;
  readonly descriptor: SlotDescriptor;
}

/**
 * Canonicalize one extracted assertion (PRD §11.6, §13.4, §13.5, §13.6).
 *
 * Order matters and is fixed: context, then instance, then slot, then
 * proposition, then claim, then the match decision the claim belongs to. Nothing
 * here accepts a belief -- the claim is recorded as evidence of an assertion and
 * the write governor decides what to believe about it.
 */
export async function canonicalizeClaim(tx: MemoryTransaction, request: CanonicalizationRequest): Promise<CanonicalizedClaim> {
  if (request.contextKind !== undefined || request.contextSpaceId !== undefined) {
    throw new MemoryStoreError('EXTRACTOR_CONTEXT_SELECTION_REFUSED');
  }
  const context = await resolveCanonicalContext(tx, {
    ownerScopeId: request.ownerScopeId, frameTypeId: request.frameTypeId, predicateId: request.predicateId,
    contextRule: request.contextRule ?? null, extractorContext: request.extractorContext ?? null,
  });
  const attribution = classifySourceAttribution(request.statement ?? null);
  const materiality: UpdateMateriality = request.materiality ?? 'NON_MATERIAL';

  const matchRequest: InstanceMatchRequest = {
    ...(request.instanceSignals ?? {}),
    ownerScopeId: request.ownerScopeId, frameTypeId: registryId.parse(request.frameTypeId),
    contextSpaceId: context.contextSpaceId,
    roles: request.roles ?? [],
    identityAnchorRoles: request.identityAnchorRoles ?? [],
    externalIdentifierRoles: request.externalIdentifierRoles ?? [],
  };
  const match = await matchFrameInstance(tx, matchRequest);
  const applied = await applyInstanceDecision(tx, matchRequest, match, materiality);

  const descriptor: SlotDescriptor = {
    frameInstanceId: applied.frameInstanceId, predicateId: registryId.parse(request.predicateId),
    contextSpaceId: context.contextSpaceId, modality: modalitySchema.parse(request.modality),
    qualifiers: { ...(request.qualifiers ?? {}) },
  };
  const slotLookup = await resolveBeliefSlot(tx, {
    ownerScopeId: request.ownerScopeId, descriptor,
    ...(request.normalizationVersion ? { normalizationVersion: request.normalizationVersion } : {}),
    registryReleaseId: request.registryReleaseId ?? null,
  });
  const propositionLookup = await resolveProposition(tx, {
    ownerScopeId: request.ownerScopeId, beliefSlotId: slotLookup.beliefSlotId, normalizedValue: request.normalizedValue,
    ...(request.polarity ? { polarity: request.polarity } : {}),
    ...(request.normalizationVersion ? { normalizationVersion: request.normalizationVersion } : {}),
    registryReleaseId: request.registryReleaseId ?? null,
  });

  const claimId = await recordClaim(tx, {
    ownerScopeId: request.ownerScopeId, sourceAnchorId: request.sourceAnchorId,
    claimOrigin: request.claimOrigin, lifecycle: request.lifecycle ?? 'CANDIDATE',
    propositionId: propositionLookup.propositionId,
    extractionRunId: request.extractionRunId ?? null,
    assertedByEntityId: request.assertedByEntityId ?? null,
    candidateFrameTypeId: request.frameTypeId,
    validFrom: request.validFrom ?? null, validTo: request.validTo ?? null,
    extractionConfidence: request.extractionConfidence ?? null,
    entityResolutionConfidence: request.entityResolutionConfidence ?? null,
    temporalResolutionConfidence: request.temporalResolutionConfidence ?? null,
    instanceResolutionConfidence: request.instanceResolutionConfidence ?? null,
    temporalInterpretation: request.temporalInterpretation ?? null,
    metadata: {
      ...(request.metadata ?? {}),
      canonicalizationVersion: CANONICALIZATION_VERSION,
      // The attribution that made a quoted context unnecessary, kept with the
      // claim so the Memory inspector can show why the slot is BASE.
      sourceAttribution: {
        attributionKind: attribution.attributionKind, reportingVerb: attribution.reportingVerb,
        createsQuotedContext: attribution.createsQuotedContext,
      },
      contextDecision: context.reason,
      instanceMatchOutcome: match.outcome,
    },
  });
  const recordedCandidateIds = await recordInstanceDecision(tx, matchRequest, match, applied, materiality, {
    claimId, extractionRunId: request.extractionRunId ?? null,
  });
  // A reused instance keeps the roles it already carries (PRD §11.5:
  // participants never key an instance), so nothing is rewritten here.
  return Object.freeze({
    context, attribution, frameInstanceId: applied.frameInstanceId, instanceCreated: !applied.reusedExistingInstance,
    instanceMatch: match, reusedExistingInstance: applied.reusedExistingInstance,
    recordedCandidateIds: Object.freeze(recordedCandidateIds),
    beliefSlotId: slotLookup.beliefSlotId, slotLookup, propositionId: propositionLookup.propositionId,
    propositionLookup, claimId, descriptor,
  });
}
