import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { PublicConnector } from '@unai/domain';
import { withOwnerTransaction } from '@unai/postgres';
import { JOB_PURPOSES } from '@unai/jobs';
import { CONNECTOR_READ_PURPOSE, listConnectors } from '@unai/connectors';
import { enqueueConnectorSync } from './connector-sync-job.js';

/**
 * Connector sync scheduling (PRD §8.5 maintained understanding, §41 Reliability):
 * the processing worker enqueues one INCREMENTAL `connector.sync` job per eligible
 * connector per window, so new mail, events and issues arrive without the owner
 * pressing "Sync". BACKFILL stays an explicit owner action and is never scheduled.
 *
 * A window is `floor(now / max(intervalMs, minimum for the type))`. The job's
 * idempotency key (`connector_sync_<id>_INCREMENTAL_<window>`) is what guarantees
 * one row per connector and window. `alreadyQueued` is process-local: @unai/api
 * runs no queue SQL and enqueueJob answers a new and an existing job alike, so
 * after a restart (or in a fresh `--once` process) the first pass re-submits and
 * counts `enqueued` while the key keeps a single row.
 *
 * One owner scope per process: the listing runs under the worker's own owner
 * scope, which @unai/connectors filters on and row-level security backs. Only
 * counts and status words leave this file.
 */

/** The polled connector types and the shortest window each may have. A type
 * without an entry is never scheduled: DOCUMENT and CONVERSATION have no sync
 * client, and a sync of one would record SYNC_FAILED and block its uploads.
 * OMI: ADR 0041 D7 allows 25 transcript lists per hour per key, shared with
 * manual syncs and the live suite; one page per 15-minute window with up to 3
 * attempts is at most 4 × 3 = 12 lists per hour. */
export const MINIMUM_INTERVAL_BY_TYPE: Readonly<Record<string, number>> = Object.freeze({
  GMAIL: 300_000, GOOGLE_CALENDAR: 300_000, GITHUB: 300_000, OMI: 900_000,
});

export type ScheduledConnector = Pick<PublicConnector, 'connectorId' | 'connectorType' | 'status' | 'grantedCapabilities'>;
export interface ConnectorSyncTick { readonly enqueued: number; readonly alreadyQueued: number; readonly skipped: number }
export interface DueConnectorSync { readonly connectorId: string; readonly window: string }

export interface ConnectorSyncSchedulerOptions {
  /** Milliseconds since the epoch. */
  readonly clock: () => number;
  /** A validated interval (processing-config.ts): 0 disables scheduling. */
  readonly intervalMs: number;
  readonly minimumIntervalByType?: Readonly<Record<string, number>>;
  readonly listConnectors: () => Promise<readonly ScheduledConnector[]>;
  readonly enqueue: (due: readonly DueConnectorSync[]) => Promise<void>;
}

const SCHEDULED_STATUSES: ReadonlySet<string> = new Set(['ACTIVE', 'SYNC_FAILED']);
const log = (line: Record<string, unknown>) => console.info(JSON.stringify({ event: 'connector.scheduler', ...line }));

/** A connector's interval, or null when it must not be scheduled: not ACTIVE or
 * SYNC_FAILED, no granted capability (it would dead-letter every window), or a
 * type without a sync client. */
function intervalOf(connector: ScheduledConnector, intervalMs: number, minimums: Readonly<Record<string, number>>): number | null {
  const minimum = Object.hasOwn(minimums, connector.connectorType) ? minimums[connector.connectorType] : undefined;
  if (minimum === undefined || !SCHEDULED_STATUSES.has(connector.status) || connector.grantedCapabilities.length === 0) return null;
  return Math.max(intervalMs, minimum);
}

export function createConnectorSyncScheduler(options: ConnectorSyncSchedulerOptions) {
  const { clock, intervalMs, minimumIntervalByType: minimums = MINIMUM_INTERVAL_BY_TYPE } = options;
  const disabled = intervalMs === 0;
  if (disabled) log({ status: 'CONNECTOR_SCHEDULER_DISABLED' });
  const intervals = [intervalMs, ...Object.values(minimums).map(minimum => Math.max(intervalMs, minimum))];
  /** Connector id → the last window this instance enqueued for it. */
  let queued = new Map<string, string>();
  let nextTickAt = 0;

  async function pass(now: number): Promise<ConnectorSyncTick> {
    const windows = new Map<string, string>();
    const due: DueConnectorSync[] = [];
    let alreadyQueued = 0, skipped = 0;
    for (const connector of await options.listConnectors()) {
      const interval = intervalOf(connector, intervalMs, minimums);
      if (interval === null) { skipped++; continue; }
      const window = String(Math.floor(now / interval));
      windows.set(connector.connectorId, window);
      if (queued.get(connector.connectorId) === window) alreadyQueued++;
      else due.push({ connectorId: connector.connectorId, window });
    }
    if (due.length > 0) await options.enqueue(due);
    // Rebuilt every pass, so it never outgrows the connector list; untouched on failure.
    queued = windows;
    const tick = { enqueued: due.length, alreadyQueued, skipped };
    log(tick);
    return tick;
  }

  return {
    /** One scheduling pass now (`--once`). */
    tick: async (): Promise<ConnectorSyncTick | null> => disabled ? null : pass(clock()),
    /** The worker loop's call: one pass per window boundary, not per poll turn. The
     * next boundary is fixed before the pass, so a failed pass waits for it. */
    tickIfDue: async (): Promise<ConnectorSyncTick | null> => {
      const now = clock();
      if (disabled || now < nextTickAt) return null;
      nextTickAt = Math.min(...intervals.map(interval => (Math.floor(now / interval) + 1) * interval));
      return pass(now);
    },
  };
}

/** The real ports: each call is its own owner transaction with a fresh correlation id. */
export function connectorSyncSchedulerPorts(options: { readonly appPool: Pool; readonly ownerScopeId: string; readonly actorId: string }) {
  const context = (purpose: string) => ({
    ownerScopeId: options.ownerScopeId, actorId: options.actorId, purpose, correlationId: randomUUID() });
  return {
    listConnectors: (): Promise<readonly ScheduledConnector[]> =>
      withOwnerTransaction(options.appPool, context(CONNECTOR_READ_PURPOSE), tx => listConnectors(tx)),
    // enqueueJob admits only `jobs.enqueue`. maxPages stays the default (1): the same
    // window with another maxPages would be JOB_IDEMPOTENCY_CONFLICT.
    enqueue: (due: readonly DueConnectorSync[]): Promise<void> =>
      withOwnerTransaction(options.appPool, context(JOB_PURPOSES.enqueue), async tx => {
        for (const { connectorId, window } of due) await enqueueConnectorSync(tx, { connectorId, mode: 'INCREMENTAL', window });
      }),
  };
}
