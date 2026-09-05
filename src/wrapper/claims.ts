// Wrapper claim ledger — the durable record of who holds which work item.
//
// A claim here is a WORK-ITEM LEASE held by a wrapper session. It is a
// different thing from the Uai semantic `Claim` in ../kernel/identities.ts
// (a source assertion about a proposition); the two never mix.
//
// The rule this slice exists for: a claim is only meaningful while the session
// that holds it is live. A session dies without releasing its claims (crash,
// kill, machine reboot), so the ledger would otherwise keep handing back a
// holder that no longer exists and the work item would be stranded forever.
// Boot is where that is repaired: the wrapper walks the store, tests the
// liveness of every holder session, and releases the claims whose holder is
// not live. After boot, a read of such a work item shows no holder.
//
// Liveness is decided by the store's own session records, never by the claim:
// a claim cannot vouch for its own holder. That is also why the claim's own
// lease horizon (`ClaimRecord.expiresAt`) is inert at boot: it is recorded for
// the holder's benefit, but only the holder SESSION decides whether the claim
// survives. A live holder keeps its work item untouched — same holder, same
// expiry, same version — however old the claim itself looks.

// ---------------------------------------------------------------------------
// Identifiers and records
// ---------------------------------------------------------------------------

export type SessionId = string;
export type WorkItemId = string;

/** A session is OPEN until it is closed; closing is not required to die. */
export type SessionStatus = "OPEN" | "CLOSED";

export interface SessionRecord {
  readonly sessionId: SessionId;
  readonly status: SessionStatus;
  /** ISO instant. A session past its lease horizon is not live either way. */
  readonly expiresAt: string;
}

/** The holder side of a work item: one session, one lease. */
export interface ClaimRecord {
  readonly workItemId: WorkItemId;
  readonly holderSessionId: SessionId;
  /** ISO instant the claim was taken. */
  readonly claimedAt: string;
  /**
   * ISO instant the claim lease lapses. Boot never reads it — see the module
   * note: liveness is the holder session's, not the claim's.
   */
  readonly expiresAt: string;
}

export interface WorkItemRecord {
  readonly workItemId: WorkItemId;
  /** Bumped on every claim and every release. */
  readonly version: number;
  /** null means: no holder. */
  readonly holder: ClaimRecord | null;
}

/** Why a claim stopped being held. Stable codes — read them, don't parse text. */
export const RELEASE_REASONS = [
  "HOLDER_SESSION_NOT_LIVE",
  "RELEASED_BY_HOLDER",
] as const;
export type ReleaseReason = (typeof RELEASE_REASONS)[number];

/** Append-only audit of releases, so a boot can be explained after the fact. */
export interface ReleaseRecord {
  readonly workItemId: WorkItemId;
  readonly holderSessionId: SessionId;
  readonly releasedAt: string;
  readonly reason: ReleaseReason;
}

/** Everything the ledger keeps. This is the shape that must survive a restart. */
export interface StoreState {
  readonly sessions: readonly SessionRecord[];
  readonly workItems: readonly WorkItemRecord[];
  readonly releases: readonly ReleaseRecord[];
}

// ---------------------------------------------------------------------------
// Backing store
// ---------------------------------------------------------------------------

/**
 * The durable side of the ledger. Whatever implements this (sqlite, a file, a
 * test double) is the thing that outlives a process, so every mutation the
 * store makes is written straight through.
 */
export interface ClaimStoreBackend {
  read(): StoreState;
  write(state: StoreState): void;
}

export const EMPTY_STORE_STATE: StoreState = Object.freeze({
  sessions: Object.freeze([]),
  workItems: Object.freeze([]),
  releases: Object.freeze([]),
});

function sealSession(session: SessionRecord): SessionRecord {
  return Object.freeze({
    sessionId: session.sessionId,
    status: session.status,
    expiresAt: session.expiresAt,
  });
}

function sealClaim(claim: ClaimRecord): ClaimRecord {
  return Object.freeze({
    workItemId: claim.workItemId,
    holderSessionId: claim.holderSessionId,
    claimedAt: claim.claimedAt,
    expiresAt: claim.expiresAt,
  });
}

function sealWorkItem(item: WorkItemRecord): WorkItemRecord {
  return Object.freeze({
    workItemId: item.workItemId,
    version: item.version,
    holder: item.holder === null ? null : sealClaim(item.holder),
  });
}

function sealRelease(release: ReleaseRecord): ReleaseRecord {
  return Object.freeze({
    workItemId: release.workItemId,
    holderSessionId: release.holderSessionId,
    releasedAt: release.releasedAt,
    reason: release.reason,
  });
}

/** Deep copy + freeze: nothing a caller holds can reach back into the store. */
function sealState(state: StoreState): StoreState {
  return Object.freeze({
    sessions: Object.freeze(state.sessions.map(sealSession)),
    workItems: Object.freeze(state.workItems.map(sealWorkItem)),
    releases: Object.freeze(state.releases.map(sealRelease)),
  });
}

/**
 * An in-process backend. It holds a sealed snapshot, so two stores opened over
 * the same backend see the same durable state — that is how a restart is
 * modelled without a real database.
 */
export function createMemoryBackend(
  initial: Partial<StoreState> = {},
): ClaimStoreBackend {
  let state = sealState({
    sessions: initial.sessions ?? [],
    workItems: initial.workItems ?? [],
    releases: initial.releases ?? [],
  });
  return {
    read: () => state,
    write: (next) => {
      state = sealState(next);
    },
  };
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

/** How long a freshly taken claim lease runs when the caller names no horizon. */
export const DEFAULT_CLAIM_LEASE_MS = 15 * 60 * 1000;

export interface ClaimStoreOptions {
  /** Injectable so liveness and timestamps are testable without waiting. */
  readonly clock?: () => Date;
  /** Lease length for claims taken without an explicit `expiresAt`. */
  readonly claimLeaseMs?: number;
}

export interface ClaimStore {
  /** Records (or replaces) a session. */
  putSession(session: SessionRecord): SessionRecord;
  readSession(sessionId: SessionId): SessionRecord | null;
  /**
   * The liveness test. A session is live only if the store knows it, it has
   * not been closed, and its lease has not expired. An unknown session — the
   * common shape after a crash — is not live.
   */
  isSessionLive(sessionId: SessionId): boolean;

  /** Takes the claim. Refuses if a live session already holds the item. */
  claim(
    workItemId: WorkItemId,
    holderSessionId: SessionId,
    options?: { readonly expiresAt?: string },
  ): WorkItemRecord;
  /** Drops the holder. A work item with no holder is left as it is. */
  release(workItemId: WorkItemId, reason?: ReleaseReason): WorkItemRecord;

  /** A read of a work item. `holder === null` means: no holder. */
  readWorkItem(workItemId: WorkItemId): WorkItemRecord;
  listWorkItems(): readonly WorkItemRecord[];
  listReleases(): readonly ReleaseRecord[];
}

export class ClaimConflictError extends Error {
  readonly code = "WORK_ITEM_HELD_BY_LIVE_SESSION";
  constructor(
    readonly workItemId: WorkItemId,
    readonly holderSessionId: SessionId,
  ) {
    super(
      `work item ${workItemId} is held by live session ${holderSessionId}`,
    );
    this.name = "ClaimConflictError";
  }
}

export function openClaimStore(
  backend: ClaimStoreBackend,
  options: ClaimStoreOptions = {},
): ClaimStore {
  const clock = options.clock ?? (() => new Date());
  const claimLeaseMs = options.claimLeaseMs ?? DEFAULT_CLAIM_LEASE_MS;
  const now = () => clock().toISOString();
  const leaseHorizon = () =>
    new Date(clock().getTime() + claimLeaseMs).toISOString();

  const commit = (next: StoreState): void => backend.write(next);

  const findWorkItem = (workItemId: WorkItemId): WorkItemRecord => {
    const found = backend
      .read()
      .workItems.find((item) => item.workItemId === workItemId);
    // A work item nobody has ever claimed reads as an unheld work item; the
    // read does not bring it into being.
    return found ?? sealWorkItem({ workItemId, version: 0, holder: null });
  };

  const upsertWorkItem = (item: WorkItemRecord): WorkItemRecord => {
    const state = backend.read();
    const sealed = sealWorkItem(item);
    const exists = state.workItems.some((w) => w.workItemId === item.workItemId);
    commit({
      ...state,
      workItems: exists
        ? state.workItems.map((w) =>
            w.workItemId === item.workItemId ? sealed : w,
          )
        : [...state.workItems, sealed],
    });
    return sealed;
  };

  const store: ClaimStore = {
    putSession(session) {
      const state = backend.read();
      const sealed = sealSession(session);
      const exists = state.sessions.some(
        (s) => s.sessionId === session.sessionId,
      );
      commit({
        ...state,
        sessions: exists
          ? state.sessions.map((s) =>
              s.sessionId === session.sessionId ? sealed : s,
            )
          : [...state.sessions, sealed],
      });
      return sealed;
    },

    readSession(sessionId) {
      return (
        backend.read().sessions.find((s) => s.sessionId === sessionId) ?? null
      );
    },

    isSessionLive(sessionId) {
      const session = store.readSession(sessionId);
      if (session === null) return false;
      if (session.status !== "OPEN") return false;
      return Date.parse(session.expiresAt) > clock().getTime();
    },

    claim(workItemId, holderSessionId, claimOptions = {}) {
      const current = findWorkItem(workItemId);
      if (
        current.holder !== null &&
        store.isSessionLive(current.holder.holderSessionId)
      ) {
        throw new ClaimConflictError(
          workItemId,
          current.holder.holderSessionId,
        );
      }
      if (current.holder !== null) {
        // Held by a session that is not live: the claim is stale, take it over
        // through the same release path so the audit stays complete.
        store.release(workItemId, "HOLDER_SESSION_NOT_LIVE");
      }
      const taken = findWorkItem(workItemId);
      return upsertWorkItem({
        workItemId,
        version: taken.version + 1,
        holder: {
          workItemId,
          holderSessionId,
          claimedAt: now(),
          expiresAt: claimOptions.expiresAt ?? leaseHorizon(),
        },
      });
    },

    release(workItemId, reason = "RELEASED_BY_HOLDER") {
      const current = findWorkItem(workItemId);
      if (current.holder === null) return current;
      const released = sealWorkItem({
        workItemId,
        version: current.version + 1,
        holder: null,
      });
      const state = backend.read();
      const exists = state.workItems.some((w) => w.workItemId === workItemId);
      commit({
        ...state,
        workItems: exists
          ? state.workItems.map((w) =>
              w.workItemId === workItemId ? released : w,
            )
          : [...state.workItems, released],
        releases: [
          ...state.releases,
          sealRelease({
            workItemId,
            holderSessionId: current.holder.holderSessionId,
            releasedAt: now(),
            reason,
          }),
        ],
      });
      return released;
    },

    readWorkItem(workItemId) {
      return findWorkItem(workItemId);
    },

    listWorkItems() {
      return backend.read().workItems;
    },

    listReleases() {
      return backend.read().releases;
    },
  };

  return store;
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

export interface BootReport {
  /** Work items whose holder was not live and is now released. */
  readonly releasedWorkItemIds: readonly WorkItemId[];
  /** Work items left held, because their holder session is live. */
  readonly retainedWorkItemIds: readonly WorkItemId[];
}

/**
 * Boots the wrapper against a store. Every held work item is checked against
 * the liveness of its holder session; a claim whose holder is not live is
 * released, and a read of that work item afterwards shows no holder.
 *
 * Releasing is all boot does to a claim — a live holder keeps its work item.
 * Running boot twice in a row is safe: the second run finds nothing to release.
 */
export function bootWrapper(store: ClaimStore): BootReport {
  const released: WorkItemId[] = [];
  const retained: WorkItemId[] = [];

  for (const item of store.listWorkItems()) {
    if (item.holder === null) continue;
    if (store.isSessionLive(item.holder.holderSessionId)) {
      retained.push(item.workItemId);
      continue;
    }
    store.release(item.workItemId, "HOLDER_SESSION_NOT_LIVE");
    released.push(item.workItemId);
  }

  return Object.freeze({
    releasedWorkItemIds: Object.freeze(released),
    retainedWorkItemIds: Object.freeze(retained),
  });
}
