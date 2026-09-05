import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createBeliefSlot,
  createClaim,
  createFrameInstance,
  createFrameType,
  createProposition,
  mintBeliefSlotId,
  mintClaimId,
  mintFrameInstanceId,
  mintFrameTypeId,
  mintPropositionId,
  slotKeyOf,
  type BeliefSlot,
  type FrameInstance,
  type FrameType,
} from "./identities.ts";

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function obligationFrameType(): FrameType {
  return createFrameType({
    name: "shared.obligation",
    roles: ["debtor", "creditor"],
    identityStrategy: { kind: "SURROGATE_ONLY" },
    allowedPredicates: ["principal_amount", "due_date", "settled"],
    temporalBehavior: "INTERVAL",
    validModalityTransitions: [
      { from: "COMMITTED", to: "ACTUAL" },
      { from: "EXPECTED", to: "ACTUAL" },
    ],
    mergeSplitPolicy: { mergeable: true, splittable: true },
  });
}

describe("frame instances", () => {
  it("two frame instances with identical participants and amount are distinct", () => {
    const frameType = obligationFrameType();
    const participants = {
      debtor: "person:yaron",
      creditor: "person:daniel",
      amount: "50 ILS",
    };
    const o1 = createFrameInstance({ frameTypeId: frameType.frameTypeId, participants });
    const o2 = createFrameInstance({ frameTypeId: frameType.frameTypeId, participants });

    // Same people, same amount — still two separate real-world situations.
    expect(o1.participants).toEqual(o2.participants);
    expect(o1.frameTypeId).toBe(o2.frameTypeId);
    expect(o1.frameInstanceId).not.toBe(o2.frameInstanceId);
  });
});

describe("belief slots and propositions", () => {
  function slotFor(instance: FrameInstance): BeliefSlot {
    return createBeliefSlot({
      frameInstanceId: instance.frameInstanceId,
      predicate: "principal_amount",
      contextSpaceId: "ctx:base-world",
      modality: "ACTUAL",
      qualifiers: {},
    });
  }

  it("two propositions with different values in one slot share the slot key", () => {
    const frameType = obligationFrameType();
    const o1 = createFrameInstance({
      frameTypeId: frameType.frameTypeId,
      participants: { debtor: "person:yaron", creditor: "person:daniel" },
    });
    const slot = slotFor(o1);

    const fifty = createProposition({ beliefSlotId: slot.beliefSlotId, value: "50 ILS" });
    const sixty = createProposition({ beliefSlotId: slot.beliefSlotId, value: "60 ILS" });

    // Competing values occupy the same slot (the slot excludes the value)…
    expect(fifty.beliefSlotId).toBe(sixty.beliefSlotId);
    expect(fifty.value).not.toBe(sixty.value);
    // …and remain distinct propositions.
    expect(fifty.propositionId).not.toBe(sixty.propositionId);
  });

  it("the slot key is a lookup index over slot dimensions, not the identity", () => {
    const frameType = obligationFrameType();
    const o1 = createFrameInstance({
      frameTypeId: frameType.frameTypeId,
      participants: { debtor: "person:yaron", creditor: "person:daniel" },
    });
    const a = slotFor(o1);
    const b = slotFor(o1);

    // Same governed location -> same lookup key…
    expect(slotKeyOf(a)).toBe(slotKeyOf(b));
    // …but authoritative identity stays surrogate, never the key.
    expect(a.beliefSlotId).not.toBe(slotKeyOf(a));
  });
});

describe("claims", () => {
  it("two claims about one proposition keep distinct claim ids", () => {
    const slotId = mintBeliefSlotId();
    const proposition = createProposition({ beliefSlotId: slotId, value: "50 ILS" });

    const yaron = createClaim({
      propositionId: proposition.propositionId,
      stance: "SUPPORTS",
      sourceRef: "utterance:yaron:2026-08-30",
    });
    const daniel = createClaim({
      propositionId: proposition.propositionId,
      stance: "CONTRADICTS",
      sourceRef: "utterance:daniel:2026-08-30",
    });

    expect(yaron.propositionId).toBe(daniel.propositionId);
    expect(yaron.claimId).not.toBe(daniel.claimId);
  });
});

describe("identity is never a hash (section 3)", () => {
  it("minting functions take no content input at all", () => {
    for (const mint of [
      mintFrameTypeId,
      mintFrameInstanceId,
      mintBeliefSlotId,
      mintPropositionId,
      mintClaimId,
    ]) {
      expect(mint.length).toBe(0);
    }
  });

  it("mints opaque UUIDv7 surrogate ids", () => {
    expect(mintFrameInstanceId()).toMatch(UUID_V7);
    expect(mintClaimId()).toMatch(UUID_V7);
  });

  it("a surrogate id cannot be re-derived from the object's fields", () => {
    const frameType = obligationFrameType();
    const fields = {
      frameTypeId: frameType.frameTypeId,
      participants: { debtor: "person:yaron", creditor: "person:daniel", amount: "50 ILS" },
    };

    // Constructing twice from byte-identical fields yields different ids, so
    // no deterministic function of the fields can reproduce the id.
    const first = createFrameInstance(fields);
    const second = createFrameInstance(fields);
    expect(first.frameInstanceId).not.toBe(second.frameInstanceId);

    // And explicitly: a content hash of the fields is not the identity.
    const contentHash = createHash("sha256")
      .update(JSON.stringify(fields))
      .digest("hex");
    expect(first.frameInstanceId).not.toBe(contentHash);
    expect(second.frameInstanceId).not.toBe(contentHash);
  });
});
