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

function heldWorkItem(holderSessionId: string): WorkItemRecord {
  return {
    workItemId: WORK_ITEM,
    version: 1,
    holder: {
      workItemId: WORK_ITEM,
      holderSessionId,
      claimedAt: "2026-09-05T11:00:00.000Z",
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

describe("boot leaves live holders alone", () => {
  it("a claim held by a live session survives boot", () => {
    const { store } = storeHoldingClaim({
      sessions: [liveSession()],
      workItems: [heldWorkItem(LIVE_SESSION)],
    });

    const report = bootWrapper(store);

    expect(report.releasedWorkItemIds).toEqual([]);
    expect(store.readWorkItem(WORK_ITEM).holder?.holderSessionId).toBe(
      LIVE_SESSION,
    );
    expect(store.listReleases()).toEqual([]);
  });

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
    });
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
