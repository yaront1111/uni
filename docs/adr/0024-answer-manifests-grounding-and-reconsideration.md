# ADR 0024: Answer manifests, the grounding validator and reconsideration

Date: 2026-09-19
Status: Accepted
Node: `answer-manifests-grounding-validator-and-reconsideration` of
goal-b2cc3b54-1876-401e-a6a2-527f99b679bc (design v1, sealed graph
3a910def2655f69aa3feb9855e481cbda6d643a7325e83e4844b56bd2351c494).
Criteria: CRT-AI-01-A, CRT-RD-06-A, CRT-RD-07-A, CRT-RD-08-A, CRT-RD-11-A,
CRT-RYW-05-A.

Recorded before the implementing change, per PRD §0.7 and §46. It builds on the
Ask pipeline of ADR 0023, which this node's dependency delivered; the delivered
commit (`f0c307b`) was verified by the daemon and is the base of this work.

## 1. A manifest is derived from the persisted packet, never from memory

PRD §23.6 lists what a manifest records and says it is "an over-approximate
manifest of what was supplied to the model". CRT-RD-06-A asks that its belief,
claim and overlay delta ids *equal* the set in the persisted packet.

So the manifest is computed by one pure function, `suppliedContextOf(packet)`,
over the packet read back from `context_packets` — the stored JSON, checked
against its stored `packet_hash` — and never from the in-memory object the Ask
pipeline happened to hold, and never from a second retrieval. Its sets are:

- **belief ids**: every proposition id the packet states a value or a verdict
  about — current, historical and future beliefs, conflict positions, the
  selector's selected and competing propositions, and semantic matches;
- **claim ids**: the claims listed on beliefs and the claims semantic matches
  point at;
- **evidence ids**: the evidence references and every evidence id carried on a
  belief, future claim, conflict position, selection, semantic match or overlay
  delta;
- **overlay delta ids**: the owner overlay deltas and those a selection names.

What the packet names only to say it was *not* supplied stays out of every set:
its redactions and unknowns, an object it withheld whole, and the propositions
the selector's `APPLY_READ_POLICY` step excluded (withheld by the read policy or
outside the requested life-category view), which the packet names without a
value. Counting those would make an answer given under another purpose a
reconsideration candidate for a belief it was never shown.

Each set is sorted and de-duplicated. Beside them the manifest records the
packet id and hash, the packet's projection versions and watermarks, the
registry release (label and id), and the model and prompt version the packet
was supplied to.

## 2. Every field says "supplied", none says "used"

CRT-RD-07-A forbids any field or label asserting which item the model used. The
public manifest therefore nests the sets under `contextSupplied`, carries a
constant `recordKind: CONTEXT_SUPPLIED_TO_MODEL` and a fixed sentence stating
that it records what was supplied and not what was used, and has no field
anywhere whose name speaks of use, reliance or attribution. A test walks every
key of the DTO and the Answer provenance screen's markup against that list.

## 3. The answer is phrased by a model only behind the grounding validator

ADR 0023 composed answers deterministically and left model phrasing to this
node. An `AnswerPhraser` (an interface in `@unai/context`, which still depends on
no gateway) may be supplied; the API's implementation goes through the LLM
gateway, so every call is schema-validated and recorded in
`model_call_records`. Its output is a *candidate*: labelled statements naming
the packet objects they rest on, the evidence they cite and the sensitivity
scope they draw from.

The validator (`validateGrounding`, pure) checks each candidate statement
against the packet, applying PRD §24.6:

| Rule | Detected when | Action |
| --- | --- | --- |
| `UNGROUNDED_PERSONAL_FACT` | an asserting statement names no packet object, names one the packet does not hold, or states a number no named object carries | `REGENERATE` |
| `SCHEDULED_WORDED_AS_OCCURRED` | a statement about a future-modality object with no accepted occurrence resolution is labelled as settled fact or uses occurrence wording (unnegated) | `DOWNGRADE` |
| `CONTESTED_WORDED_AS_CERTAIN` | a statement about a contested or conflicting proposition is not labelled conflicting, or uses certainty wording | `DOWNGRADE` |
| `INFERENCE_PRESENTED_AS_EVIDENCE` | a statement cites assistant conversation evidence, or labels a value resting only on model-origin claims as confirmed or reported | `DOWNGRADE` |
| `SENSITIVITY_SCOPE_LEAK` | a statement names or cites an object the packet lists as withheld, or declares a sensitivity scope above the request's ceiling or absent from the packet's evidence | `BLOCK` |

A downgrade rewrites the statement from the packet (the same wording the
deterministic composer uses for that object: "Scheduled, not yet happened",
"Contested: … neither is settled", "Inferred, not stated in a source") and
removes citations it may not make. A regeneration asks the phraser once more
with the violations, and falls back to the deterministic composer, which is
grounded by construction; the fallback is validated too. A block replaces the
answer with one statement that says the answer was withheld, and names no
content. The strongest action wins: block, then regenerate, then downgrade.

The result — action, every violation with its rule, statement and action, each
attempt's source and model — is stored on the manifest
(`grounding_validator_result`) and returned on the answer.

Rejected: letting the model self-report groundedness; free-text entity matching
for personal facts. The first is the failure the validator exists for; the
second would block every paraphrase. Numbers are checked because an invented
amount or date is the costly hallucination, and they are cheap to check exactly.

## 4. Every answer, and every model candidate, is assistant conversation evidence

PRD §24.1–24.2: a normal answer is conversation evidence only, and an AI
statement is never independent evidence for itself (CRT-AI-01-A). After
validation, the presented answer — and each model candidate, including one the
validator regenerated or blocked — is ingested through the same `ingest` path as
any other item, as a `source_items` row of source type `ASSISTANT_CONVERSATION`
with actor `ASSISTANT`, the request's data purpose and its sensitivity ceiling.
The manifest's `conversation_message_id` names the presented answer's item.

Three rules keep that evidence from ever becoming support:

- Tier-1 triage routes an `ASSISTANT`-authored item `SOURCE_ONLY` with reason
  `ASSISTANT_AUTHORED`, so no extraction run is ever scheduled over it. The
  router version stays `tier1-rules-0.1.0`: no assistant-authored item was
  ingested by any delivered path before this node, so no recorded decision
  changes meaning.
- The belief governor counts a claim anchored in assistant-authored evidence as
  model-authored whatever origin it declares, so the local write policy's
  `MODEL_PATH_MAY_NOT_ACCEPT_BELIEF` refuses an accepted belief resting on it.
- The validator downgrades any statement citing it (§3), and the composer never
  links it, so a later answer never cites it as a source.

The recording runs in its own transaction under a dedicated purpose,
`answer.record`, which the migration admits to exactly what recording needs:
inserting an `ASSISTANT` / `ASSISTANT_CONVERSATION` source item (and its object
key, receipt, anchor and triage row), reading the packet it records, and
inserting the manifest. It is never a request purpose, so no client can declare
it; `memory.read` stays a read (ADR 0022 §1).

## 5. Reconsideration candidates are recorded when a belief changes, by the database

CRT-RD-11-A: after a belief contained in earlier packets changes materially, a
query returns exactly the answers whose manifests contained it. Changes reach a
belief through several writers (the governor, bitemporal state changes, claim
relations, the owner's overlay), so the detection is a trigger rather than a
call each writer must remember:

- a new `belief_assessments` version whose status or valid interval differs
  from the version it closes (or that is the first one);
- a `CORRECTS`, `SUPERSEDES`, `RETRACTS` or `CONTRADICTS` claim relation onto a
  claim of the proposition;
- an owner overlay delta whose lifecycle moves.

Each inserts one `reconsideration_candidates` row per answer manifest that
contained the changed belief (or delta) and was created before the change. The
trigger function is `SECURITY DEFINER`, filters by the changed row's own owner
scope, and writes only this derived table; the change that fired it is audited
by its own writer. `GET /v1/answers/reconsideration-candidates?beliefId=` (or
`overlayDeltaId=`) returns the manifests with candidate rows for that object —
exactly the earlier answers that contained it — and never rewrites an answer
(PRD §23.7).

A manifest created after the change already saw the new state and is not a
candidate. An object that never changed has none.

## 6. A pending delta that later evidence contradicts becomes CONTESTED, with its record

CRT-RYW-05-A. `contestOverlayDelta` (ADR 0019) already moves a delta to
CONTESTED and no further. This node adds the detection and the record:

- `contestDeltasConflictingWithClaims` runs inside the governor's commit, over
  the claims the commit created. A pending delta (RECEIVED, USER_ASSERTED,
  AWAITING_INSTANCE_RESOLUTION or CANONICALIZATION_PENDING) conflicts with a new
  claim from *other* evidence, recorded after the delta, when the delta corrects
  or rejects the claim's proposition (the evidence re-asserts what the owner
  corrected), or when the delta asserts or confirms one proposition and the
  claim asserts a different value in the same slot.
- The record lists the failure reason, the conflicting evidence ids, the
  affected projections (every typed projection holding a row for the delta's
  frame, and the one the frame's contract feeds), the ids of the answer
  manifests that contained the delta, and whether user attention is required.

The row is updated, never deleted; its raw text, kind, evidence and target stay
as the owner wrote them.

## 7. HTTP surface and screen

- `POST /v1/ask` (unchanged purpose `memory.read`) now returns
  `answerManifestId` and `grounding`.
- `GET /v1/answers/{id}/manifest` and `GET /v1/answers/reconsideration-candidates`
  run under `memory.inspect`.
- The **Answer provenance** screen (`/answers/{id}`) renders the three designed
  states: the listing of context supplied to the model, the explicit statement
  that it is not a record of what the model used, and the reconsideration badge.
  The Ask screen itself belongs to `web-shell-labels-today-briefing-and-ask-surface`.
