import {
  postponementEpisodeSchema,
  type ContextPacket, type PostponementEpisode, type ReviewGround,
} from '@unai/domain';
import { addLocalDays, ownerLocalDate } from './time.js';

/**
 * Repeated postponement and the behavioral observation it may support (PRD §39;
 * design entity `behavioral_observations`; ADR 0029 §8; CRT-UX-06-A).
 *
 * "Behavioral observations require multiple supporting episodes, counterexample
 * search, observation window, confidence, and a review or expiry date. A single
 * event cannot create a stable personality claim." Pure: a packet and a window
 * in, episodes and at most one observation out.
 */

export const OBSERVATION_WINDOW_DAYS = 28;
export const OBSERVATION_REVIEW_AFTER_DAYS = 28;
/** More than one: a single episode never produces an observation. */
export const MINIMUM_SUPPORTING_EPISODES = 2;

const DUE_TIME = 'shared.commitment.due_time';

function instantOf(value: unknown): Date | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const raw = record['time'] ?? record['start'] ?? record['end'];
  if (typeof raw !== 'string') return null;
  const time = new Date(raw);
  return Number.isNaN(time.getTime()) ? null : time;
}

interface DueStatement { readonly propositionId: string; readonly frameInstanceId: string; readonly due: Date; readonly statedAt: Date }

/** Every stated due time of every commitment in the packet, in the order it was
 * stated (valid time), per commitment. */
function dueHistories(packet: ContextPacket): Map<string, DueStatement[]> {
  const histories = new Map<string, DueStatement[]>();
  const items = [...packet.futureClaims, ...packet.currentBeliefs, ...packet.historicalBeliefs]
    .filter(item => item.predicateId === DUE_TIME);
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.propositionId)) continue;
    seen.add(item.propositionId);
    const due = instantOf(item.normalizedValue);
    const statedAt = item.validFrom ? new Date(item.validFrom) : null;
    if (due === null || statedAt === null) continue;
    histories.set(item.frameInstanceId, [...(histories.get(item.frameInstanceId) ?? []),
      { propositionId: item.propositionId, frameInstanceId: item.frameInstanceId, due, statedAt }]);
  }
  for (const history of histories.values()) {
    history.sort((left, right) => left.statedAt.getTime() - right.statedAt.getTime() || left.propositionId.localeCompare(right.propositionId));
  }
  return histories;
}

/** A postponement episode: one commitment's due time restated later than the
 * value it replaced, restated inside the window. */
export function postponementEpisodes(packet: ContextPacket, window: { from: Date; to: Date }): PostponementEpisode[] {
  const episodes: PostponementEpisode[] = [];
  for (const history of dueHistories(packet).values()) {
    for (let index = 1; index < history.length; index += 1) {
      const previous = history[index - 1]!, next = history[index]!;
      if (next.due.getTime() <= previous.due.getTime()) continue;
      if (next.statedAt.getTime() < window.from.getTime() || next.statedAt.getTime() >= window.to.getTime()) continue;
      episodes.push(postponementEpisodeSchema.parse({
        episodeId: next.propositionId, frameInstanceId: next.frameInstanceId, previousPropositionId: previous.propositionId,
        previousDueAt: previous.due.toISOString(), newDueAt: next.due.toISOString(), restatedAt: next.statedAt.toISOString(),
      }));
    }
  }
  return episodes.sort((left, right) => left.restatedAt.localeCompare(right.restatedAt) || left.episodeId.localeCompare(right.episodeId));
}

/** Commitments due inside the window whose due time was never restated later:
 * the cases that would contradict "due dates keep moving". */
export function postponementCounterexamples(packet: ContextPacket, window: { from: Date; to: Date },
  episodes: readonly PostponementEpisode[]): string[] {
  const postponed = new Set(episodes.map(episode => episode.frameInstanceId));
  const found: string[] = [];
  for (const [frameInstanceId, history] of dueHistories(packet)) {
    if (postponed.has(frameInstanceId)) continue;
    if (history.some((statement, index) => index > 0 && statement.due.getTime() > history[index - 1]!.due.getTime())) continue;
    const current = history.at(-1)!;
    if (current.due.getTime() >= window.from.getTime() && current.due.getTime() < window.to.getTime()) found.push(frameInstanceId);
  }
  return found.sort();
}

export interface ObservationDraft {
  readonly statement: string;
  readonly supportingEpisodes: readonly PostponementEpisode[];
  readonly counterexampleSearch: { searched: string; counterexamplesFound: number; counterexampleIds: string[] };
  readonly observationWindow: { from: string; to: string };
  readonly confidence: number;
  readonly reviewOrExpiryDate: string;
  readonly grounds: readonly ReviewGround[];
}

/**
 * At most one observation, and only from more than one episode. The statement
 * reports counts over a named window and the counterexamples found; it says
 * nothing about the owner's character (PRD §37.7).
 */
export function repeatedPostponementObservation(packet: ContextPacket, input: {
  window: { from: Date; to: Date }; timeZone: string;
}): { episodes: PostponementEpisode[]; observation: ObservationDraft | null } {
  const episodes = postponementEpisodes(packet, input.window);
  if (episodes.length < MINIMUM_SUPPORTING_EPISODES) return { episodes, observation: null };
  const counterexamples = postponementCounterexamples(packet, input.window, episodes);
  const commitments = new Set(episodes.map(episode => episode.frameInstanceId)).size;
  const lastDay = ownerLocalDate(new Date(input.window.to.getTime() - 1), input.timeZone);
  const firstDay = ownerLocalDate(input.window.from, input.timeZone);
  const confidence = Math.round((episodes.length / (episodes.length + counterexamples.length)) * 100) / 100;
  const statement = 'Between ' + firstDay + ' and ' + lastDay + ', due dates were moved later ' + episodes.length
    + ' times across ' + commitments + (commitments === 1 ? ' commitment' : ' commitments') + '; '
    + counterexamples.length + (counterexamples.length === 1 ? ' commitment' : ' commitments')
    + ' due in the same period kept ' + (counterexamples.length === 1 ? 'its' : 'their') + ' original date.';
  const grounds: ReviewGround[] = [];
  for (const episode of episodes) {
    grounds.push({ objectType: 'proposition', objectId: episode.episodeId },
      { objectType: 'proposition', objectId: episode.previousPropositionId });
  }
  for (const frameInstanceId of counterexamples) grounds.push({ objectType: 'frame_instance', objectId: frameInstanceId });
  return {
    episodes,
    observation: {
      statement,
      supportingEpisodes: episodes,
      counterexampleSearch: {
        searched: 'Commitments with a due time inside the observation window whose due time was never restated later.',
        counterexamplesFound: counterexamples.length, counterexampleIds: counterexamples,
      },
      observationWindow: { from: input.window.from.toISOString(), to: input.window.to.toISOString() },
      confidence,
      reviewOrExpiryDate: addLocalDays(lastDay, OBSERVATION_REVIEW_AFTER_DAYS),
      grounds: grounds.filter((ground, index) => grounds.findIndex(other => other.objectId === ground.objectId) === index),
    },
  };
}
