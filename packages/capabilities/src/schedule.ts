import type { MemoryTransaction } from '@unai/memory';
import { readRealizations, readResolutions, readRoles, readSlotValues, selectSlotValue, type RealizationRow,
  type ResolutionRow, type RoleFill, type SlotValue } from './canonical.js';

/**
 * The schedule capability (PRD §25.3, §44.7; design entity `schedule_projection`).
 *
 * The rule it exists to hold is a negative one: a calendar event stays scheduled
 * until a resolution assertion says otherwise. `realizationLinkId` is null until
 * an actual occurrence REALIZES the event, and `outcomeResolutionId` is null
 * until an accepted resolution exists. An event whose date has passed with
 * neither still reads as scheduled, because leaving it on the calendar proves
 * nothing about whether anybody went (CRT-OUT-03-A, PRD §12.6).
 */

export const SCHEDULE_CAPABILITY_VERSION = 'capability-schedule-0.1.0';
export const SCHEDULE_FRAME_TYPE = 'shared.event_occurrence';
export const OCCURRENCE_TIME_PREDICATE = 'shared.event_occurrence.occurrence_time';
export const PARTICIPANTS_PREDICATE = 'shared.event_occurrence.participants';
export const OCCURRENCE_REFERENCE_PREDICATE = 'shared.event_occurrence.external_occurrence_reference';

export interface ScheduleCanonicalState {
  readonly occurrenceTimes: readonly SlotValue[];
  readonly participantValues: readonly SlotValue[];
  readonly referenceValues: readonly SlotValue[];
  readonly roles: readonly RoleFill[];
  readonly realizations: readonly RealizationRow[];
  readonly resolutions: readonly ResolutionRow[];
}

/** Everything the schedule reducer reads, for a batch of scheduled frames.
 *
 * Only `SCHEDULED` slots are read. An `ACTUAL` occurrence_time on the same frame
 * would be a different modality carrying a different meaning, and mixing the two
 * is how a plan quietly becomes a record of something that happened
 * (PRD §11.7). */
export async function readScheduleState(tx: MemoryTransaction, input: {
  ownerScopeId: string; frameInstanceIds: readonly string[];
}): Promise<ScheduleCanonicalState> {
  const frameInstanceIds = [...input.frameInstanceIds];
  return Object.freeze({
    occurrenceTimes: await readSlotValues(tx, { ownerScopeId: input.ownerScopeId, frameInstanceIds,
      predicateId: OCCURRENCE_TIME_PREDICATE, modality: 'SCHEDULED' }),
    participantValues: await readSlotValues(tx, { ownerScopeId: input.ownerScopeId, frameInstanceIds,
      predicateId: PARTICIPANTS_PREDICATE, modality: 'SCHEDULED' }),
    referenceValues: await readSlotValues(tx, { ownerScopeId: input.ownerScopeId, frameInstanceIds,
      predicateId: OCCURRENCE_REFERENCE_PREDICATE, modality: 'SCHEDULED' }),
    roles: await readRoles(tx, { ownerScopeId: input.ownerScopeId, frameInstanceIds }),
    realizations: await readRealizations(tx, { ownerScopeId: input.ownerScopeId, frameInstanceIds }),
    resolutions: await readResolutions(tx, { ownerScopeId: input.ownerScopeId, frameInstanceIds }),
  });
}

/** The frames of `shared.event_occurrence` that carry a SCHEDULED slot at all.
 *
 * An actual occurrence is the same frame type with ACTUAL slots and belongs in no
 * schedule: it is the thing that realized one. */
export async function listScheduledFrameInstanceIds(tx: MemoryTransaction, input: {
  ownerScopeId: string; frameInstanceIds?: readonly string[] | undefined;
}): Promise<string[]> {
  const only = input.frameInstanceIds ? [...input.frameInstanceIds] : null;
  const rows = (await tx.query(
    `SELECT DISTINCT f.id, f.created_at FROM frame_instances f
     JOIN belief_slots s ON s.owner_scope_id=f.owner_scope_id AND s.frame_instance_id=f.id
       AND s.modality='SCHEDULED' AND s.lifecycle='ACTIVE'
     WHERE f.owner_scope_id=$1 AND f.frame_type_id=$2 AND f.lifecycle='ACTIVE'
       AND ($3::uuid[] IS NULL OR f.id=ANY($3::uuid[]))
     ORDER BY f.created_at,f.id`, [input.ownerScopeId, SCHEDULE_FRAME_TYPE, only])).rows;
  return rows.map(row => row['id'] as string);
}

/** The accepted resolution of a scheduled frame, when there is one. Proposed
 * resolutions move nothing: accepting is a governed decision (PRD §19.1). */
export function acceptedResolutionId(resolutions: readonly ResolutionRow[], frameInstanceId: string): string | null {
  const accepted = resolutions.filter(resolution =>
    resolution.sourceFrameInstanceId === frameInstanceId && resolution.lifecycle === 'ACCEPTED');
  return accepted[accepted.length - 1]?.resolutionAssertionId ?? null;
}

export { selectSlotValue };
