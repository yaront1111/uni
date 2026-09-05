import { describe, expect, it } from "vitest";
import {
  bootWrapper,
  ClaimConflictError,
  createMemoryBackend,
  openClaimStore,
  type ClaimStoreBackend,
  type SessionRecord,
  type StoreState,
  type WorkItemId,
  type WorkItemRecord,
} from "./claims.ts";

const NOW = new Date("2026-09-05T12:00:00.000Z");
const clock = () => NOW;

const WORK_ITEM = "node.deliver@boot-releases-a-dead-held-claim";
const DEAD_SESSION = "sess-wrap-dead";
const LIVE_SESSION = "sess-wrap-live";

/**
 * A held work item. The claim's own lease is deliberately already lapsed at
 * NOW: boot must not read it, so this fixture serves the dead-holder cases and
 * the live-holder cases alike.
 */
function heldWorkItem(holderSessionId: string): WorkItemRecord {
  return {
    workItemId: WORK_ITEM,
    version: 1,
    holder: {
      workItemId: WORK_ITEM,
      holderSessionId,
      claimedAt: "2026-09-05T11:00:00.000Z",
      expiresAt: "2026-09-05T11:30:00.000Z",
    },
  };
}

/**
 * A held work item under its own id. `heldWorkItem` spread over a new
 * `workItemId` would leave `holder.workItemId` pointing back at the fixture's
 * item; a whole-store sweep is about many distinct items, so those get records
 * that are internally consistent.
 */
function heldItem(workItemId: string, holderSessionId: string): WorkItemRecord {
  return {
    workItemId,
    version: 1,
    holder: {
      workItemId,
      holderSessionId,
      claimedAt: "2026-09-05T11:00:00.000Z",
      expiresAt: "2026-09-05T11:30:00.000Z",
    },
  };
}

function liveSession(sessionId = LIVE_SESSION): SessionRecord {
  return { sessionId, status: "OPEN", expiresAt: "2026-09-05T13:00:00.000Z" };
}

/** Closed before it could release: dead, however recent. */
const CLOSED_SESSION = "sess-wrap-closed";
/** Never closed, just stopped existing and let its lease lapse. */
const LAPSED_SESSION = "sess-wrap-lapsed";

/**
 * The three shapes a dead holder comes in. `DEAD_SESSION` is deliberately not
 * among them: an unrecorded session is dead by absence, so it needs no record.
 */
const DEAD_SESSION_RECORDS: readonly SessionRecord[] = [
  {
    sessionId: CLOSED_SESSION,
    status: "CLOSED",
    expiresAt: "2026-09-05T13:00:00.000Z",
  },
  {
    sessionId: LAPSED_SESSION,
    status: "OPEN",
    expiresAt: "2026-09-05T11:59:59.999Z",
  },
];

/** Every work item the store still hands back a holder for. */
function stillHeld(store: ReturnType<typeof openClaimStore>): WorkItemId[] {
  return store
    .listWorkItems()
    .filter((item) => item.holder !== null)
    .map((item) => item.workItemId);
}

/** A store already holding a claim, before the wrapper has booted over it. */
function storeHoldingClaim(
  state: Partial<StoreState>,
): { backend: ClaimStoreBackend; store: ReturnType<typeof openClaimStore> } {
  const backend = createMemoryBackend(state);
  return { backend, store: openClaimStore(backend, { clock }) };
}

describe("crit-dead-held-claim-released-at-boot", () => {
  it("releases a claim whose holder session was never recorded: the read shows no holder", () => {
    // The shape a crash leaves behind: the claim outlived every trace of its
    // holder, so the store cannot even find the session to test.
    const { store } = storeHoldingClaim({
      workItems: [heldWorkItem(DEAD_SESSION)],
    });
    expect(store.readWorkItem(WORK_ITEM).holder).not.toBeNull();

    bootWrapper(store);

    expect(store.readWorkItem(WORK_ITEM).holder).toBeNull();
  });

  it("releases a claim whose holder session is closed: the read shows no holder", () => {
    const { store } = storeHoldingClaim({
      sessions: [
        {
          sessionId: DEAD_SESSION,
          status: "CLOSED",
          expiresAt: "2026-09-05T13:00:00.000Z",
        },
      ],
      workItems: [heldWorkItem(DEAD_SESSION)],
    });

    bootWrapper(store);

    expect(store.readWorkItem(WORK_ITEM).holder).toBeNull();
  });

  it("releases a claim whose holder session is still OPEN but past its lease", () => {
    // Never closed, just stopped existing. An unexpired-looking status is not
    // liveness; the lease horizon decides.
    const { store } = storeHoldingClaim({
      sessions: [
        {
          sessionId: DEAD_SESSION,
          status: "OPEN",
          expiresAt: "2026-09-05T11:59:59.999Z",
        },
      ],
      workItems: [heldWorkItem(DEAD_SESSION)],
    });

    bootWrapper(store);

    expect(store.readWorkItem(WORK_ITEM).holder).toBeNull();
  });

  it("reports the released work item and bumps its version", () => {
    const { store } = storeHoldingClaim({
      workItems: [heldWorkItem(DEAD_SESSION)],
    });

    const report = bootWrapper(store);

    expect(report.releasedWorkItemIds).toEqual([WORK_ITEM]);
    expect(report.retainedWorkItemIds).toEqual([]);
    expect(store.readWorkItem(WORK_ITEM).version).toBe(2);
  });

  it("records why the claim was released, naming the dead holder", () => {
    const { store } = storeHoldingClaim({
      workItems: [heldWorkItem(DEAD_SESSION)],
    });

    bootWrapper(store);

    expect(store.listReleases()).toEqual([
      {
        workItemId: WORK_ITEM,
        holderSessionId: DEAD_SESSION,
        releasedAt: NOW.toISOString(),
        reason: "HOLDER_SESSION_NOT_LIVE",
      },
    ]);
  });

  it("keeps the release after a restart: a store reopened over the same backing shows no holder", () => {
    const { backend, store } = storeHoldingClaim({
      workItems: [heldWorkItem(DEAD_SESSION)],
    });

    bootWrapper(store);
    const reopened = openClaimStore(backend, { clock });

    expect(reopened.readWorkItem(WORK_ITEM).holder).toBeNull();
  });

  it("releases every dead-held claim in one boot, and only those", () => {
    const { store } = storeHoldingClaim({
      sessions: [liveSession()],
      workItems: [
        { ...heldWorkItem(DEAD_SESSION), workItemId: "wi-dead-1" },
        { ...heldWorkItem(LIVE_SESSION), workItemId: "wi-live" },
        { ...heldWorkItem(DEAD_SESSION), workItemId: "wi-dead-2" },
        { workItemId: "wi-unheld", version: 3, holder: null },
      ],
    });

    const report = bootWrapper(store);

    expect(report.releasedWorkItemIds).toEqual(["wi-dead-1", "wi-dead-2"]);
    expect(report.retainedWorkItemIds).toEqual(["wi-live"]);
    expect(store.readWorkItem("wi-dead-1").holder).toBeNull();
    expect(store.readWorkItem("wi-dead-2").holder).toBeNull();
    expect(store.readWorkItem("wi-unheld").version).toBe(3);
  });
});

describe("crit-live-held-claim-unchanged", () => {
  it("leaves the whole record identical: holder, expiry and version", () => {
    // The criterion read literally: take the record before boot, take it
    // after, and demand they are the same record. Any difference falsifies it.
    const { store } = storeHoldingClaim({
      sessions: [liveSession()],
      workItems: [heldWorkItem(LIVE_SESSION)],
    });
    const before = store.readWorkItem(WORK_ITEM);

    bootWrapper(store);
    const after = store.readWorkItem(WORK_ITEM);

    expect(after).toEqual(before);
    expect(after.holder?.holderSessionId).toBe(LIVE_SESSION);
    expect(after.holder?.expiresAt).toBe("2026-09-05T11:30:00.000Z");
    expect(after.holder?.claimedAt).toBe("2026-09-05T11:00:00.000Z");
    expect(after.version).toBe(1);
  });

  it("does not touch the claim even though the claim's own lease has lapsed", () => {
    // The fixture's claim expired at 11:30 and it is now 12:00. Only the holder
    // SESSION decides: it is live, so boot has nothing to do here.
    const { store } = storeHoldingClaim({
      sessions: [liveSession()],
      workItems: [heldWorkItem(LIVE_SESSION)],
    });
    expect(
      Date.parse(store.readWorkItem(WORK_ITEM).holder!.expiresAt),
    ).toBeLessThan(NOW.getTime());

    const report = bootWrapper(store);

    expect(report.releasedWorkItemIds).toEqual([]);
    expect(report.retainedWorkItemIds).toEqual([WORK_ITEM]);
    expect(store.readWorkItem(WORK_ITEM).holder?.holderSessionId).toBe(
      LIVE_SESSION,
    );
  });

  it("writes no release audit for a live holder", () => {
    const { store } = storeHoldingClaim({
      sessions: [liveSession()],
      workItems: [heldWorkItem(LIVE_SESSION)],
    });

    bootWrapper(store);

    expect(store.listReleases()).toEqual([]);
  });

  it("stays unchanged across repeated boots", () => {
    // Nothing accumulates: a second boot must not bump the version either.
    const { store } = storeHoldingClaim({
      sessions: [liveSession()],
      workItems: [heldWorkItem(LIVE_SESSION)],
    });
    const before = store.readWorkItem(WORK_ITEM);

    bootWrapper(store);
    bootWrapper(store);

    expect(store.readWorkItem(WORK_ITEM)).toEqual(before);
    expect(store.listReleases()).toEqual([]);
  });

  it("stays unchanged after a restart over the same backing store", () => {
    const { backend, store } = storeHoldingClaim({
      sessions: [liveSession()],
      workItems: [heldWorkItem(LIVE_SESSION)],
    });
    const before = store.readWorkItem(WORK_ITEM);

    bootWrapper(store);
    const reopened = openClaimStore(backend, { clock });

    expect(reopened.readWorkItem(WORK_ITEM)).toEqual(before);
  });

  it("spares the live-held claim in the same boot that releases dead ones", () => {
    // Discriminating, not indiscriminate: releasing a neighbour must not cost
    // the live holder its claim.
    const { store } = storeHoldingClaim({
      sessions: [liveSession()],
      workItems: [
        { ...heldWorkItem(DEAD_SESSION), workItemId: "wi-dead" },
        { ...heldWorkItem(LIVE_SESSION), workItemId: "wi-live" },
      ],
    });
    const before = store.readWorkItem("wi-live");

    bootWrapper(store);

    expect(store.readWorkItem("wi-dead").holder).toBeNull();
    expect(store.readWorkItem("wi-live")).toEqual(before);
  });

  it("the retained claim is still the store's answer to a competing claimant", () => {
    // Unchanged means the claim still does its job: a rival is refused.
    const { store } = storeHoldingClaim({
      sessions: [liveSession()],
      workItems: [heldWorkItem(LIVE_SESSION)],
    });

    bootWrapper(store);

    expect(() => store.claim(WORK_ITEM, "sess-other")).toThrow(
      ClaimConflictError,
    );
    expect(store.readWorkItem(WORK_ITEM).holder?.holderSessionId).toBe(
      LIVE_SESSION,
    );
  });
});

describe("crit-every-dead-held-claim-released", () => {
  it("releases all of them in one boot, whatever shape each death took", () => {
    // One store, three ways of being dead: never recorded, closed, lapsed.
    // The criterion is falsified by any dead-held claim that still has a
    // holder afterwards, so that is what is asserted — over the whole store,
    // not over a list the boot itself chose.
    const { store } = storeHoldingClaim({
      sessions: DEAD_SESSION_RECORDS,
      workItems: [
        heldItem("wi-unknown-holder", DEAD_SESSION),
        heldItem("wi-closed-holder", CLOSED_SESSION),
        heldItem("wi-lapsed-holder", LAPSED_SESSION),
      ],
    });
    expect(stillHeld(store)).toHaveLength(3);

    const report = bootWrapper(store);

    expect(stillHeld(store)).toEqual([]);
    expect(report.releasedWorkItemIds).toEqual([
      "wi-unknown-holder",
      "wi-closed-holder",
      "wi-lapsed-holder",
    ]);
    expect(report.retainedWorkItemIds).toEqual([]);
  });

  it("leaves no dead-held claim behind in a store full of them", () => {
    // Scale, in case a sweep only ever reaches the first item or stops at the
    // first release: eight claims, all dead-held, one boot.
    const workItems = Array.from({ length: 8 }, (_, i) =>
      heldItem(`wi-dead-${i}`, DEAD_SESSION),
    );
    const { store } = storeHoldingClaim({ workItems });

    const report = bootWrapper(store);

    expect(stillHeld(store)).toEqual([]);
    expect(report.releasedWorkItemIds).toHaveLength(8);
    for (const item of workItems) {
      expect(store.readWorkItem(item.workItemId).holder).toBeNull();
    }
  });

  it("audits every release separately, naming each work item and its dead holder", () => {
    const { store } = storeHoldingClaim({
      sessions: DEAD_SESSION_RECORDS,
      workItems: [
        heldItem("wi-a", DEAD_SESSION),
        heldItem("wi-b", CLOSED_SESSION),
        heldItem("wi-c", LAPSED_SESSION),
      ],
    });

    bootWrapper(store);

    expect(store.listReleases()).toEqual([
      {
        workItemId: "wi-a",
        holderSessionId: DEAD_SESSION,
        releasedAt: NOW.toISOString(),
        reason: "HOLDER_SESSION_NOT_LIVE",
      },
      {
        workItemId: "wi-b",
        holderSessionId: CLOSED_SESSION,
        releasedAt: NOW.toISOString(),
        reason: "HOLDER_SESSION_NOT_LIVE",
      },
      {
        workItemId: "wi-c",
        holderSessionId: LAPSED_SESSION,
        releasedAt: NOW.toISOString(),
        reason: "HOLDER_SESSION_NOT_LIVE",
      },
    ]);
  });

  it("bumps the version of every claim it releases, and of nothing else", () => {
    const { store } = storeHoldingClaim({
      workItems: [
        heldItem("wi-dead-1", DEAD_SESSION),
        heldItem("wi-dead-2", DEAD_SESSION),
        { workItemId: "wi-unheld", version: 7, holder: null },
      ],
    });

    bootWrapper(store);

    expect(store.readWorkItem("wi-dead-1").version).toBe(2);
    expect(store.readWorkItem("wi-dead-2").version).toBe(2);
    expect(store.readWorkItem("wi-unheld").version).toBe(7);
  });

  it("finishes the store in that one boot: a second boot has nothing left to do", () => {
    // "A single boot releases all of them" read as a completeness claim — if
    // the first boot had left work behind, the second would find it.
    const { store } = storeHoldingClaim({
      sessions: DEAD_SESSION_RECORDS,
      workItems: [
        heldItem("wi-dead-1", DEAD_SESSION),
        heldItem("wi-dead-2", CLOSED_SESSION),
        heldItem("wi-dead-3", LAPSED_SESSION),
      ],
    });

    bootWrapper(store);
    const second = bootWrapper(store);

    expect(second).toEqual({ releasedWorkItemIds: [], retainedWorkItemIds: [] });
    expect(store.listReleases()).toHaveLength(3);
  });

  it("keeps the whole sweep across a restart over the same backing store", () => {
    const { backend, store } = storeHoldingClaim({
      workItems: [
        heldItem("wi-dead-1", DEAD_SESSION),
        heldItem("wi-dead-2", DEAD_SESSION),
      ],
    });

    bootWrapper(store);
    const reopened = openClaimStore(backend, { clock });

    expect(stillHeld(reopened)).toEqual([]);
  });
});

describe("crit-mixed-store-only-dead-claims-move", () => {
  it("releases the dead-held claim and leaves the live-held one holding", () => {
    const { store } = storeHoldingClaim({
      sessions: [liveSession()],
      workItems: [
        heldItem("wi-dead", DEAD_SESSION),
        heldItem("wi-live", LIVE_SESSION),
      ],
    });
    const liveBefore = store.readWorkItem("wi-live");

    const report = bootWrapper(store);

    expect(store.readWorkItem("wi-dead").holder).toBeNull();
    expect(store.readWorkItem("wi-live")).toEqual(liveBefore);
    expect(report.releasedWorkItemIds).toEqual(["wi-dead"]);
    expect(report.retainedWorkItemIds).toEqual(["wi-live"]);
  });

  it("moves the same one whichever order the store holds them in", () => {
    // Position must not decide the outcome: a sweep that released whatever it
    // met first, or stopped once it had spared someone, would part these two.
    for (const workItems of [
      [heldItem("wi-dead", DEAD_SESSION), heldItem("wi-live", LIVE_SESSION)],
      [heldItem("wi-live", LIVE_SESSION), heldItem("wi-dead", DEAD_SESSION)],
    ]) {
      const { store } = storeHoldingClaim({
        sessions: [liveSession()],
        workItems,
      });

      bootWrapper(store);

      expect(stillHeld(store)).toEqual(["wi-live"]);
      expect(store.readWorkItem("wi-live").holder?.holderSessionId).toBe(
        LIVE_SESSION,
      );
    }
  });

  it("records exactly one release, and it is the dead-held claim's", () => {
    const { store } = storeHoldingClaim({
      sessions: [liveSession()],
      workItems: [
        heldItem("wi-live", LIVE_SESSION),
        heldItem("wi-dead", DEAD_SESSION),
      ],
    });

    bootWrapper(store);

    expect(store.listReleases()).toEqual([
      {
        workItemId: "wi-dead",
        holderSessionId: DEAD_SESSION,
        releasedAt: NOW.toISOString(),
        reason: "HOLDER_SESSION_NOT_LIVE",
      },
    ]);
  });

  it("sorts a crowd: every dead-held claim moves, every live-held one stays", () => {
    // Two live holders, two dead ones, interleaved — the mixed store at the
    // size where a sweep that confuses the two would show it.
    const OTHER_LIVE = "sess-wrap-live-2";
    const { store } = storeHoldingClaim({
      sessions: [liveSession(), liveSession(OTHER_LIVE), ...DEAD_SESSION_RECORDS],
      workItems: [
        heldItem("wi-live-1", LIVE_SESSION),
        heldItem("wi-dead-1", CLOSED_SESSION),
        heldItem("wi-live-2", OTHER_LIVE),
        heldItem("wi-dead-2", LAPSED_SESSION),
      ],
    });
    const before = [
      store.readWorkItem("wi-live-1"),
      store.readWorkItem("wi-live-2"),
    ];

    const report = bootWrapper(store);

    expect(stillHeld(store)).toEqual(["wi-live-1", "wi-live-2"]);
    expect(report.releasedWorkItemIds).toEqual(["wi-dead-1", "wi-dead-2"]);
    expect(report.retainedWorkItemIds).toEqual(["wi-live-1", "wi-live-2"]);
    expect(store.readWorkItem("wi-live-1")).toEqual(before[0]);
    expect(store.readWorkItem("wi-live-2")).toEqual(before[1]);
  });

  it("the spared claim still refuses a rival, and the released one is free to take", () => {
    // What "moves" and "stays" mean to a claimant afterwards.
    const { store } = storeHoldingClaim({
      sessions: [liveSession()],
      workItems: [
        heldItem("wi-dead", DEAD_SESSION),
        heldItem("wi-live", LIVE_SESSION),
      ],
    });

    bootWrapper(store);

    expect(() => store.claim("wi-live", "sess-other")).toThrow(
      ClaimConflictError,
    );
    expect(store.claim("wi-dead", LIVE_SESSION).holder?.holderSessionId).toBe(
      LIVE_SESSION,
    );
  });

  it("keeps both outcomes across a restart over the same backing store", () => {
    const { backend, store } = storeHoldingClaim({
      sessions: [liveSession()],
      workItems: [
        heldItem("wi-dead", DEAD_SESSION),
        heldItem("wi-live", LIVE_SESSION),
      ],
    });
    const liveBefore = store.readWorkItem("wi-live");

    bootWrapper(store);
    const reopened = openClaimStore(backend, { clock });

    expect(reopened.readWorkItem("wi-dead").holder).toBeNull();
    expect(reopened.readWorkItem("wi-live")).toEqual(liveBefore);
  });
});

describe("boot leaves live holders alone", () => {
  it("booting twice releases nothing the second time", () => {
    const { store } = storeHoldingClaim({
      workItems: [heldWorkItem(DEAD_SESSION)],
    });

    bootWrapper(store);
    const second = bootWrapper(store);

    expect(second.releasedWorkItemIds).toEqual([]);
    expect(store.listReleases()).toHaveLength(1);
    expect(store.readWorkItem(WORK_ITEM).version).toBe(2);
  });

  it("an empty store boots without inventing work items", () => {
    const { store } = storeHoldingClaim({});

    const report = bootWrapper(store);

    expect(report).toEqual({ releasedWorkItemIds: [], retainedWorkItemIds: [] });
    expect(store.listWorkItems()).toEqual([]);
  });
});

describe("session liveness", () => {
  it("is false for an unknown session", () => {
    const { store } = storeHoldingClaim({});
    expect(store.isSessionLive(DEAD_SESSION)).toBe(false);
    expect(store.readSession(DEAD_SESSION)).toBeNull();
  });

  it("is false for a closed session and for an expired lease", () => {
    const { store } = storeHoldingClaim({});
    store.putSession({
      sessionId: "sess-closed",
      status: "CLOSED",
      expiresAt: "2026-09-05T13:00:00.000Z",
    });
    store.putSession({
      sessionId: "sess-expired",
      status: "OPEN",
      expiresAt: "2026-09-05T11:00:00.000Z",
    });

    expect(store.isSessionLive("sess-closed")).toBe(false);
    expect(store.isSessionLive("sess-expired")).toBe(false);
  });

  it("is true only for an open session inside its lease", () => {
    const { store } = storeHoldingClaim({});
    store.putSession(liveSession());
    expect(store.isSessionLive(LIVE_SESSION)).toBe(true);
  });

  it("expires exactly at the lease horizon", () => {
    const { store } = storeHoldingClaim({});
    store.putSession({
      sessionId: "sess-edge",
      status: "OPEN",
      expiresAt: NOW.toISOString(),
    });
    expect(store.isSessionLive("sess-edge")).toBe(false);
  });
});

describe("claiming", () => {
  it("a read of an unclaimed work item shows no holder and does not create it", () => {
    const { store } = storeHoldingClaim({});

    const read = store.readWorkItem("wi-never-touched");

    expect(read).toEqual({
      workItemId: "wi-never-touched",
      version: 0,
      holder: null,
    });
    expect(store.listWorkItems()).toEqual([]);
  });

  it("records the holder when a work item is claimed", () => {
    const { store } = storeHoldingClaim({ sessions: [liveSession()] });

    store.claim(WORK_ITEM, LIVE_SESSION);

    expect(store.readWorkItem(WORK_ITEM).holder).toEqual({
      workItemId: WORK_ITEM,
      holderSessionId: LIVE_SESSION,
      claimedAt: NOW.toISOString(),
      expiresAt: "2026-09-05T12:15:00.000Z",
    });
  });

  it("honours an explicit lease horizon on the claim", () => {
    const { store } = storeHoldingClaim({ sessions: [liveSession()] });

    store.claim(WORK_ITEM, LIVE_SESSION, {
      expiresAt: "2026-09-05T12:05:00.000Z",
    });

    expect(store.readWorkItem(WORK_ITEM).holder?.expiresAt).toBe(
      "2026-09-05T12:05:00.000Z",
    );
  });

  it("refuses a work item already held by a live session", () => {
    const { store } = storeHoldingClaim({
      sessions: [liveSession()],
      workItems: [heldWorkItem(LIVE_SESSION)],
    });

    expect(() => store.claim(WORK_ITEM, "sess-other")).toThrow(
      ClaimConflictError,
    );
    expect(store.readWorkItem(WORK_ITEM).holder?.holderSessionId).toBe(
      LIVE_SESSION,
    );
  });

  it("takes over a work item held by a dead session, auditing the release", () => {
    const { store } = storeHoldingClaim({
      sessions: [liveSession()],
      workItems: [heldWorkItem(DEAD_SESSION)],
    });

    store.claim(WORK_ITEM, LIVE_SESSION);

    expect(store.readWorkItem(WORK_ITEM).holder?.holderSessionId).toBe(
      LIVE_SESSION,
    );
    expect(store.listReleases()).toEqual([
      {
        workItemId: WORK_ITEM,
        holderSessionId: DEAD_SESSION,
        releasedAt: NOW.toISOString(),
        reason: "HOLDER_SESSION_NOT_LIVE",
      },
    ]);
  });

  it("releasing an unheld work item is a no-op that records nothing", () => {
    const { store } = storeHoldingClaim({
      workItems: [{ workItemId: WORK_ITEM, version: 4, holder: null }],
    });

    const released = store.release(WORK_ITEM);

    expect(released.version).toBe(4);
    expect(store.listReleases()).toEqual([]);
  });
});

describe("records handed back are sealed", () => {
  it("a caller cannot mutate a work item read back out of the store", () => {
    const { store } = storeHoldingClaim({
      workItems: [heldWorkItem(DEAD_SESSION)],
    });

    const read = store.readWorkItem(WORK_ITEM) as {
      holder: { holderSessionId: string } | null;
    };
    expect(() => {
      read.holder = null;
    }).toThrow(TypeError);
    expect(() => {
      (read.holder as { holderSessionId: string }).holderSessionId = "sess-x";
    }).toThrow(TypeError);

    expect(store.readWorkItem(WORK_ITEM).holder?.holderSessionId).toBe(
      DEAD_SESSION,
    );
  });

  it("mutating the state passed in at construction cannot reach the store", () => {
    const seed = heldWorkItem(DEAD_SESSION);
    const workItems = [seed];
    const backend = createMemoryBackend({ workItems });
    const store = openClaimStore(backend, { clock });

    workItems.length = 0;

    expect(store.readWorkItem(WORK_ITEM).holder?.holderSessionId).toBe(
      DEAD_SESSION,
    );
  });
});
