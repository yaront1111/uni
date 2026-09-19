import { behavioralObservationSchema, weeklyReviewSchema, type ReviewManifest, type WeeklyReview } from '@unai/domain';
import type { MemoryTransaction } from '@unai/memory';
import { uuidV7 } from '../../../src/kernel/identities.js';
import {
  WEEKLY_REVIEW_VERSION, statementsOf, ungroundedStatements, type ComposedWeeklyReview, type ReviewWeek,
} from './weekly.js';

/**
 * Recording a weekly review (design entities `weekly_reviews` and
 * `behavioral_observations`; ADR 0028 §7, §8).
 *
 * Runs inside a `review.weekly` transaction. The grounds check happens here, at
 * the last point before anything is stored: a statement naming an object the
 * persisted packet did not supply refuses the whole review rather than storing
 * an unsupported sentence beside supported ones.
 */

export const WEEKLY_REVIEW_PURPOSE = 'review.weekly';

export class WeeklyReviewError extends Error {
  readonly detail: Record<string, unknown>;
  constructor(code: string, detail: Record<string, unknown> = {}) {
    super(code); this.name = 'WeeklyReviewError'; this.detail = detail;
  }
}

export async function recordWeeklyReview(tx: MemoryTransaction, input: {
  ownerScopeId: string; week: ReviewWeek; review: ComposedWeeklyReview; manifest: ReviewManifest; now: Date;
}): Promise<WeeklyReview> {
  const statements = statementsOf(input.review);
  const ungrounded = ungroundedStatements(statements, input.manifest);
  if (ungrounded.length > 0) {
    throw new WeeklyReviewError('WEEKLY_REVIEW_UNGROUNDED', { statementIds: [...new Set(ungrounded.map(entry => entry.statementId))] });
  }
  const observations = [];
  for (const draft of input.review.observations) {
    const id = uuidV7();
    await tx.query(
      `INSERT INTO behavioral_observations(id,owner_scope_id,pattern_kind,statement,supporting_episode_ids,supporting_episodes,
         counterexample_search,observation_window_start,observation_window_end,confidence,review_or_expiry_date,context_packet_id,created_at)
       VALUES($1,$2,'REPEATED_POSTPONEMENT',$3,$4,$5,$6,$7,$8,$9,$10::date,$11,$12)`,
      [id, input.ownerScopeId, draft.statement, draft.supportingEpisodes.map(episode => episode.episodeId),
        JSON.stringify(draft.supportingEpisodes), JSON.stringify(draft.counterexampleSearch),
        new Date(draft.observationWindow.from), new Date(draft.observationWindow.to), draft.confidence, draft.reviewOrExpiryDate,
        input.manifest.packetId, input.now]);
    observations.push(behavioralObservationSchema.parse({
      behavioralObservationId: id, patternKind: 'REPEATED_POSTPONEMENT', statement: draft.statement,
      supportingEpisodeIds: draft.supportingEpisodes.map(episode => episode.episodeId), supportingEpisodes: draft.supportingEpisodes,
      counterexampleSearch: draft.counterexampleSearch, observationWindow: draft.observationWindow, confidence: draft.confidence,
      reviewOrExpiryDate: draft.reviewOrExpiryDate, grounds: draft.grounds,
    }));
  }
  const id = uuidV7();
  const { priorityVersusCalendar, commitmentsVersusResolutions, decisionsVersusOutcomes, plannedVersusObservedSpending,
    materialChanges, repeatedPostponement } = input.review;
  await tx.query(
    `INSERT INTO weekly_reviews(id,owner_scope_id,week_start,week_end,time_zone,priority_versus_calendar,commitments_versus_resolutions,
       decisions_versus_outcomes,planned_versus_observed_spending,material_changes,repeated_postponement,behavioral_observation_ids,
       context_packet_id,packet_hash,manifest,statement_count,review_version,created_at)
     VALUES($1,$2,$3::date,$4::date,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
    [id, input.ownerScopeId, input.week.weekStart, input.week.weekEnd, input.week.timeZone,
      JSON.stringify(priorityVersusCalendar), JSON.stringify(commitmentsVersusResolutions), JSON.stringify(decisionsVersusOutcomes),
      JSON.stringify(plannedVersusObservedSpending), JSON.stringify(materialChanges), JSON.stringify(repeatedPostponement),
      observations.map(observation => observation.behavioralObservationId), input.manifest.packetId, input.manifest.packetHash,
      JSON.stringify(input.manifest), statements.length, WEEKLY_REVIEW_VERSION, input.now]);
  return weeklyReviewSchema.parse({
    weeklyReviewId: id, weekStart: input.week.weekStart, weekEnd: input.week.weekEnd, timeZone: input.week.timeZone,
    priorityVersusCalendar, commitmentsVersusResolutions, decisionsVersusOutcomes, plannedVersusObservedSpending,
    materialChanges, repeatedPostponement, behavioralObservations: observations,
    contextPacketId: input.manifest.packetId, packetHash: input.manifest.packetHash, manifest: input.manifest,
    statementCount: statements.length, reviewVersion: WEEKLY_REVIEW_VERSION, createdAt: input.now.toISOString(),
  });
}
