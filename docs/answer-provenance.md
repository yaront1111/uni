# Answer provenance: manifests, the grounding validator and reconsideration

Authority: goal-b2cc3b54-1876-401e-a6a2-527f99b679bc design v1, sealed graph
3a910def2655f69aa3feb9855e481cbda6d643a7325e83e4844b56bd2351c494, node key
`answer-manifests-grounding-validator-and-reconsideration`. This node owns
CRT-AI-01-A, CRT-RD-06-A, CRT-RD-07-A, CRT-RD-08-A, CRT-RD-11-A and
CRT-RYW-05-A. ADR 0026 records its decisions; ADRs 0001–0025 and every
delivered slice before it were inspected and retained.

## Design entities implemented here

**`answer_manifests`** and **`reconsideration_candidates`**, added by
`migrations/0021_answer_manifests_and_reconsideration.sql` with forced RLS,
purpose-gated policies, composite owner foreign keys and immutability triggers.
A manifest references the persisted `context_packets` row it was derived from,
the `source_items` row the answer was stored as, and the requesting member.
`reconsideration_candidates` has no INSERT grant: its only writer is the
`SECURITY DEFINER` derivation the triggers on `belief_assessments`,
`claim_relations` and `owner_overlay_deltas` call. There are now 52 application
tables, 50 of them owner-scoped and classified in
`packages/postgres/src/ownership.ts`.

The migration adds one purpose, `answer.record`, which no request can declare.
It may insert an `ASSISTANT` / `ASSISTANT_CONVERSATION` source item with its
object key, receipt, anchor and triage row, read the packet it records and
insert the manifest — nothing canonical.

No other design entity is implemented here.

## Design screen this node draws

**Answer provenance** (`apps/web/pages/answers/[id].tsx`,
`apps/web/components/AnswerProvenance.tsx`), in its three designed states:

| State | What renders it |
| --- | --- |
| Listing of the context supplied to the model | "Context supplied to the model": packet id and hash, registry release, model, prompt version, the belief, claim, evidence and pending-statement id sets, projection versions and watermarks |
| Explicit statement that it is not a record of which item the model used | `SUPPLIED_CONTEXT_STATEMENT`, the fixed sentence every manifest carries |
| Reconsideration badge after a belief in the packet changed materially | "Reconsider: context in this answer has changed", with each change in words |

It is reached from an answer rather than from the navigation. The Ask screen
itself belongs to `web-shell-labels-today-briefing-and-ask-surface`.

## HTTP surface

| Route | Purpose | Answer |
| --- | --- | --- |
| `POST /v1/ask` | `memory.read` | unchanged route; the answer now carries `grounding` and `answerManifestId`, and `503 ANSWER_RECORDING_UNAVAILABLE` where no answer could be recorded |
| `GET /v1/answers/{id}/manifest` | `memory.inspect` | `200` manifest; `400 ANSWER_MANIFEST_ID_INVALID`; `404 ANSWER_MANIFEST_NOT_FOUND` |
| `GET /v1/answers/reconsideration-candidates?beliefId=` or `?overlayDeltaId=` | `memory.inspect` | `200` the answers whose manifests contained the object and were given before it changed; `400 RECONSIDERATION_QUERY_INVALID` |

## How each acceptance criterion is met

`packages/api/src/answers.test.ts` runs every criterion end to end over the real
boundary, the real owner transaction, the pinned registry release 0.1.0 and the
real governor.

- **CRT-RD-06-A** — `suppliedContextOf` (`packages/context/src/manifests.ts`)
  derives the sets from the packet read back from `context_packets` and checked
  against its stored hash. The last test walks every answer the suite generated
  (at least twelve, deterministic, model-phrased, regenerated, downgraded and
  blocked) and compares each manifest's sets with an independent oracle over the
  stored packet JSON, plus the packet hash, projection versions, watermarks,
  registry release, model and prompt version; no Ask packet is left without a
  manifest. A gateway-phrased answer records the model and prompt it was supplied
  to, and the gateway records the call.
- **CRT-RD-07-A** — the manifest DTO nests the sets under `contextSupplied`,
  carries `recordKind: CONTEXT_SUPPLIED_TO_MODEL` and the fixed statement, and the
  test walks every key for words of use, reliance, attribution or ranking. The
  screen's test does the same over its markup.
- **CRT-RD-08-A** — `validateGrounding` (`packages/context/src/grounding.ts`), a
  pure function of packet and candidate. The tests script a phrasing model per
  failure: an invented amount and a statement naming no packet object are
  regenerated (and the composer answers when the model cannot ground it); a
  SCHEDULED meeting worded as having happened and a CONTESTED value worded as
  certain are downgraded; a model-inferred value labelled CONFIRMED is downgraded
  to INFERRED; a withheld RESTRICTED object, a declared scope the packet lacks and
  a citation of withheld evidence are each blocked.
- **CRT-AI-01-A** — every presented answer and every model candidate is ingested
  as ASSISTANT conversation evidence, routed `SOURCE_ONLY` (`ASSISTANT_AUTHORED`),
  so nothing is extracted; the governor counts a claim anchored in it as a
  model's and rejects an accepted belief on it (`MODEL_PATH_MAY_NOT_ACCEPT_BELIEF`,
  `ASSISTANT_EVIDENCE_IS_NOT_SUPPORT`); a later question about the invented fact
  links, cites and supplies no assistant message.
- **CRT-RD-11-A** — the triggers record one candidate per earlier manifest that
  held the changed belief. The test answers under two purposes, commits a governed
  change to one belief, and shows the query returns exactly the manifests that
  held it — not the other purpose's answer, not the answer given afterwards —
  and nothing for an unchanged belief; the old manifest is unchanged.
- **CRT-RYW-05-A** — `contestDeltasConflictingWithClaims`
  (`packages/belief/src/delta-conflicts.ts`) runs inside the governor's commit.
  The same test's commit re-asserts the value the owner's pending correction
  corrected: the delta is CONTESTED, its row and raw text remain, and its record
  lists the failure reason, the conflicting evidence, the affected projections,
  the manifests that contained it and that the owner's attention is required.

## Changes to delivered slices

- `@unai/context`: the Ask pipeline takes an optional `AnswerPhraser` and an
  `AnswerRecorder`; every candidate goes through the validator before anything
  is presented. The wording helpers moved to `wording.ts` so the validator's
  downgrade reads like the composer.
- `@unai/domain`: `certaintyLabelSchema` moved to `labels.ts`; the Ask answer's
  `composer` gains `modelId` and `promptVersion`, and the answer gains
  `grounding` and `answerManifestId`.
- `@unai/extraction`: Tier 1 routes ASSISTANT-authored items `SOURCE_ONLY`.
- `@unai/belief`: validation treats assistant-anchored claims as model origin;
  the commit contests pending deltas that new claims contradict.
- Tests of earlier nodes adapted to the new schema, never weakened: the Ask route
  test supplies the evidence store production always has; the composer
  expectation names the two new null fields; the RLS table count is 52; the
  projection replay drops and expects migration 0021.

## What this node does not claim

- **No production model configured.** `createGatewayAnswerPhraser` exists and is
  tested over a fake provider; `server.ts` passes no phraser, so production
  answers come from the deterministic composer through the same validator.
- **Personal facts are checked by object and by number.** Free text naming an
  entity is not matched against the packet (ADR 0026 §3).
- **No rewrite of old answers.** Reconsideration marks; it never regenerates.
- **The Ask screen and the link from it to this screen** belong to the web-shell
  node.
