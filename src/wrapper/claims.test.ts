import { describe, expect, it } from "vitest";
import {
  bootWrapper,
  ClaimConflictError,
  createMemoryBackend,
  openClaimStore,
  type ClaimStoreBackend,
  type SessionRecord,
  type StoreState,
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

function liveSession(sessionId = LIVE_SESSION): SessionRecord {
  return { sessionId, status: "OPEN", expiresAt: "2026-09-05T13:00:00.000Z" };
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
