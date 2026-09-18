import { z } from 'zod';
import { claimOriginSchema, claimLifecycleSchema, temporalInterpretationSchema, storedClaimSchema,
  type StoredClaim, type TemporalInterpretation } from '@unai/domain';
import { uuidV7 } from '../../../src/kernel/identities.js';
import { MemoryStoreError, type MemoryTransaction } from './transaction.js';

/** Frame instances, their roles, and the claim store (PRD §11.5, §11.10, §15;
 * CRT-MEM-05-A, CRT-MEM-07-A, CRT-MEM-14-A).
 *
 * A claim is one source assertion. Two people saying "ILS 50" are two claims
 * behind one proposition, and re-reading the same message appends another claim
 * rather than editing the one already recorded. Confidence is never one number:
 * extraction, entity resolution, temporal resolution and instance resolution are
 * stored and read back apart, because a bank feed can be exact about an amount
 * and weak about which human it names (PRD §15.3).
 *
 * A claim also carries the temporal interpretation it was read with, so the
 * Memory inspector can show that "last month" was a month, not an instant.
 */

const registryId = z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/);
const confidence = z.number().min(0).max(1);

const claimInputSchema = z.strictObject({
  ownerScopeId: z.uuid(),
  sourceAnchorId: z.uuid(),
  assertedByEntityId: z.uuid().nullable().default(null),
  propositionId: z.uuid().nullable().default(null),
  candidateFrameTypeId: registryId.nullable().default(null),
  claimOrigin: claimOriginSchema,
  lifecycle: claimLifecycleSchema.default('CANDIDATE'),
  validFrom: z.date().nullable().default(null),
  validTo: z.date().nullable().default(null),
  extractionConfidence: confidence.nullable().default(null),
  entityResolutionConfidence: confidence.nullable().default(null),
  temporalResolutionConfidence: confidence.nullable().default(null),
  instanceResolutionConfidence: confidence.nullable().default(null),
  temporalInterpretation: temporalInterpretationSchema.nullable().default(null),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type ClaimInput = z.input<typeof claimInputSchema>;

export async function createFrameInstance(tx: MemoryTransaction, input: {
  ownerScopeId: string; frameTypeId: string; contextSpaceId: string;
}): Promise<string> {
  const frameInstanceId = uuidV7();
  await tx.query('INSERT INTO frame_instances(id,owner_scope_id,frame_type_id,context_space_id) VALUES($1,$2,$3,$4)',
    [frameInstanceId, input.ownerScopeId, registryId.parse(input.frameTypeId), input.contextSpaceId]);
  return frameInstanceId;
}

/** Fill one registry role of an instance, with either a resolved entity or a
 * typed value. Roles describe a situation; they never key it (PRD §11.5). */
export async function recordFrameInstanceRole(tx: MemoryTransaction, input: {
  ownerScopeId: string; frameInstanceId: string; roleId: string;
  entityId?: string | null; typedValue?: unknown; claimId?: string | null;
  validFrom?: Date | null; validTo?: Date | null;
}): Promise<string> {
  const hasEntity = input.entityId !== undefined && input.entityId !== null;
  const hasValue = input.typedValue !== undefined && input.typedValue !== null;
  if (hasEntity === hasValue) throw new MemoryStoreError('FRAME_ROLE_FILLER_REQUIRED');
  const id = uuidV7();
  await tx.query(`INSERT INTO frame_instance_roles(id,owner_scope_id,frame_instance_id,role_id,entity_id,typed_value,
    claim_id,valid_from,valid_to) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [id, input.ownerScopeId, input.frameInstanceId, input.roleId, hasEntity ? input.entityId : null,
      hasValue ? JSON.stringify(input.typedValue) : null, input.claimId ?? null, input.validFrom ?? null, input.validTo ?? null]);
  return id;
}

/** Record one source assertion. A claim awaiting instance resolution is recorded
 * with no proposition at all rather than attached to a guessed one (PRD §15.2). */
export async function recordClaim(tx: MemoryTransaction, input: ClaimInput): Promise<string> {
  const claim = claimInputSchema.parse(input);
  if (claim.propositionId === null && !['CANDIDATE', 'AWAITING_INSTANCE_RESOLUTION', 'REJECTED', 'SUPPRESSED'].includes(claim.lifecycle)) {
    throw new MemoryStoreError('CLAIM_PROPOSITION_REQUIRED');
  }
  const claimId = uuidV7();
  await tx.query(`INSERT INTO claims(id,owner_scope_id,source_anchor_id,asserted_by_entity_id,proposition_id,
    candidate_frame_type_id,claim_origin,lifecycle,valid_from,valid_to,extraction_confidence,entity_resolution_confidence,
    temporal_resolution_confidence,instance_resolution_confidence,temporal_interpretation,metadata)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [claimId, claim.ownerScopeId, claim.sourceAnchorId, claim.assertedByEntityId, claim.propositionId,
      claim.candidateFrameTypeId, claim.claimOrigin, claim.lifecycle, claim.validFrom, claim.validTo,
      claim.extractionConfidence, claim.entityResolutionConfidence, claim.temporalResolutionConfidence,
      claim.instanceResolutionConfidence,
      claim.temporalInterpretation === null ? null : JSON.stringify(claim.temporalInterpretation),
      JSON.stringify(claim.metadata)]);
  return claimId;
}

function toStoredClaim(row: Record<string, unknown>): StoredClaim {
  const asNumber = (value: unknown) => value === null || value === undefined ? null : Number(value);
  const asTime = (value: unknown) => value === null || value === undefined ? null : (value as Date).toISOString();
  return storedClaimSchema.parse({
    claimId: row.id,
    sourceAnchorId: row.source_anchor_id,
    extractionRunId: row.extraction_run_id ?? null,
    assertedByEntityId: row.asserted_by_entity_id ?? null,
    propositionId: row.proposition_id ?? null,
    candidateFrameTypeId: row.candidate_frame_type_id ?? null,
    claimOrigin: row.claim_origin,
    lifecycle: row.lifecycle,
    validFrom: asTime(row.valid_from),
    validTo: asTime(row.valid_to),
    recordedAt: (row.recorded_at as Date).toISOString(),
    // numeric arrives as a string from pg: four separate confidences, each kept
    // as its own value and never folded into one.
    extractionConfidence: asNumber(row.extraction_confidence),
    entityResolutionConfidence: asNumber(row.entity_resolution_confidence),
    temporalResolutionConfidence: asNumber(row.temporal_resolution_confidence),
    instanceResolutionConfidence: asNumber(row.instance_resolution_confidence),
    temporalInterpretation: row.temporal_interpretation ?? null,
    metadata: row.metadata,
  });
}

export async function readClaim(tx: MemoryTransaction, input: { ownerScopeId: string; claimId: string }): Promise<StoredClaim | null> {
  const row = (await tx.query('SELECT * FROM claims WHERE owner_scope_id=$1 AND id=$2', [input.ownerScopeId, input.claimId])).rows[0];
  return row ? toStoredClaim(row) : null;
}

/** Claims supporting one proposition, oldest first. Distinct claim ids behind one
 * proposition id is the shape CRT-MEM-05-A asks for. */
export async function listClaimsForProposition(tx: MemoryTransaction, input: {
  ownerScopeId: string; propositionId: string;
}): Promise<StoredClaim[]> {
  const rows = (await tx.query('SELECT * FROM claims WHERE owner_scope_id=$1 AND proposition_id=$2 ORDER BY recorded_at,id',
    [input.ownerScopeId, input.propositionId])).rows;
  return rows.map(toStoredClaim);
}

/** The temporal interpretation of a stored claim, if it carried one. */
export function claimTemporalInterpretation(claim: StoredClaim): TemporalInterpretation | null {
  return claim.temporalInterpretation;
}
