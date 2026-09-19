# ADR 0024: Deterministic selection, the semantic index and the Ask pipeline

Date: 2026-09-18
Status: Accepted
Node: `current-state-selector-semantic-index-and-ask-pipeline` of
goal-b2cc3b54-1876-401e-a6a2-527f99b679bc (design v1, sealed graph
3a910def2655f69aa3feb9855e481cbda6d643a7325e83e4844b56bd2351c494).
Criteria: CRT-RD-03-A, CRT-RD-04-A, CRT-RD-12-A, CRT-REG-04-A.

Recorded before the implementing change, per PRD §0.7 and §46.

## 1. Selection is a pure function over rows, and its reason is data

PRD §23.4 and FR-062 require that current-state selection be deterministic code
and that it return the selected state *and the reason for it*. ADR 0022 §8 left a
list of rule names on the packet; nothing yet decided which value a slot holds.

`selectSlotState` (`packages/context/src/selector.ts`) is a pure function. The
broker loads, for every slot of every frame in the packet, the slot, its
propositions, every recorded-time version of their assessments, their claims, the
claim relations that target those claims, and the owner overlay deltas; the
function then applies the rules in the order PRD §23.4 states them and records,
for each rule, which propositions it kept and which it excluded with a reason
code. The outcome is one of `SELECTED`, `CONTESTED`, `NO_CURRENT_VALUE`,
`EXCLUDED` or `WITHHELD`, and a closing reason code says why.

Nothing in the function reads a clock, a random source, a model or the network;
every list it returns is sorted by id; every instant is the request's world or
knowledge time, never the wall clock. The packet carries `selectionsDigest`, the
SHA-256 of the canonical JSON of the selections, so two runs are comparable by
one value (CRT-RD-03-A).

Rules, in order:

0. `APPLY_READ_POLICY` — a proposition withheld by the read policy (above the
   ceiling, or redacted as an object) or outside the requested life-category view
   is not a candidate. A slot with a withheld proposition is `WITHHELD`: selecting
   among the values the request *may* see, as though the withheld one did not
   exist, would present a partial slot as a settled one.
1. `FILTER_VALID_TIME` — some recorded version's half-open valid interval must
   contain the world time.
2. `FILTER_KNOWLEDGE_TIME` — that version must be live at the knowledge time:
   `recorded_at <= K < superseded_recorded_at`. Claims and claim relations
   recorded after K do not exist for the selection.
3. `APPLY_CONTEXT_AND_MODALITY` — the slot must be in the BASE context and carry a
   modality the answer type asks about (ACTUAL for state questions; the future
   modalities for commitment and plan questions; PREDICTED and EXPECTED with
   ACTUAL for prediction review).
4. `REQUIRE_REGISTERED_CONTRACT` — see §4.
5. `APPLY_BELIEF_LIFECYCLE` — ACCEPTED and CONTESTED stay; PROVISIONAL stays only
   when the request asked for it; everything else, and a RETIRED proposition,
   goes.
6. `APPLY_CORRECTION_AND_SUPERSESSION` — a proposition every one of whose claims
   is the target of a `CORRECTS` from a surviving proposition of the same slot, of
   a `SUPERSEDES` whose period has begun at the world time, or of a `RETRACTS`, is
   excluded. One claim nobody corrected keeps it alive.
7. `INCLUDE_UNRESOLVED_CONFLICTS` — one ACCEPTED survivor is selected; a CONTESTED
   survivor or two ACCEPTED ones make the slot `CONTESTED` with **no** selected
   value; unaccepted competitors are listed beside a selection, never dropped.
8. `INCLUDE_APPLICABLE_OVERLAY_DELTAS` — pending owner deltas on the slot or its
   propositions are listed and flag `ownerAssertionPending`; they do not replace
   the canonical value, because PRD §21 distinguishes the owner's assertion from
   its verification.

The existing belief retrieval's knowledge-time filter read only the *live*
assessment row, which answers "what is believed now" even when a past knowledge
time was requested. It now reads the version live at the knowledge time, which is
what PRD §12.3's historical belief state means.

Rejected: letting the language model, or the order of rows, pick "the latest".
That is the failure FR-062 names.

## 2. The embedding model is local, lexical and pinned

The design leaves the embedding model open and requires it be pinned and
recorded so regeneration is reproducible. V0 uses `unai-hashed-lexical`, version
`hashed-lexical-256-0.1.0`: unigram, bigram and character-trigram features of the
normalized text, hashed with SHA-256 into 256 signed dimensions and L2-normalized.

It is chosen because the acceptance criteria require semantic retrieval to hold
its boundaries with the LLM gateway disabled, because a network embedding
provider would put private text on the wire for an *index*, and because a hashed
embedding is regenerable bit-for-bit from the canonical objects. Its recall is
lexical: it matches shared words and word fragments, not paraphrase. The
`Embedder` interface in `@unai/memory` is the seam a neural model replaces it
through; a new model is a new `embedding_version`, written beside the old rows,
never over them.

The text embedded for a claim is canonical memory only: frame type, predicate
(including an unregistered surface predicate), the normalized value, the claim's
own metadata and the labels of the entities in the frame. Raw evidence text is
not embedded here, because the indexer would then embed whatever its own data
purpose could read, and the index would depend on who happened to commit.

## 3. `memory_embeddings`, and hard filters before ranking

The design entity carries object reference, owner, model and version, vector,
security scope and content hash. This node adds the columns the hard filters of
PRD §23.2 step 10 need, so none of them is computed after ranking: the evidence
items behind the object (`source_item_ids`), their source types, the allowed
purposes the evidence admits, the entities of the frame, the object's time span,
and its recorded time. `security_scope` is the sensitivity of that evidence.

The search runs the filters for owner, permission (data purpose), sensitivity,
knowledge time, time window, source and entity inside a `MATERIALIZED` common
table expression, and ranks by cosine distance only over what that expression
returned. No approximate index is used, so no index recall can reintroduce a
filtered row, and the nearest match can never be one the filters excluded
(CRT-RD-04-A). Three further layers hold the same line:

- the row policy on `memory_embeddings` applies `evidence_access` to the row's own
  allowed purposes and security scope for every read purpose, so an unfiltered
  query under another purpose or a lower ceiling reads nothing. The governed write
  purpose that writes the index is bound to the owner but not to the gate: it
  already reads the canonical memory an embedding is made from without one, and
  `INSERT ... ON CONFLICT` checks the read policy against the inserted row, so a
  gate there would make a commit depend on the committer's declared data purpose;
- each evidence item behind a match must still be readable under the
  `source_items` policy at query time, so a deleted item or a narrowed purpose
  removes the match without a re-index;
- a claim that is REJECTED or SUPPRESSED is not returned.

The indexer writes under `memory.govern` and reads the evidence classification
through `unai_private.anchor_evidence_scope`, a definer function that answers id,
sensitivity, allowed purposes, source type and time for anchors of one owner and
nothing else. The belief governor indexes every claim a commit creates, in the
commit's own transaction, so a committed claim is searchable the moment it is
visible, and a rolled-back commit leaves no index row.

Rejected: a vector database, or an HNSW index queried first and filtered after.
The first contradicts §28; the second is exactly "semantic search before hard
filters".

## 4. An unregistered surface predicate is evidence, never authority

PRD §17.5 lets an unknown predicate be preserved, indexed and attached to a
thread, and forbids it to supersede an accepted belief, resolve a conflict,
become an authoritative current value or trigger a high-risk action
(CRT-REG-04-A). ADR 0017 refused only the ACCEPTED assessment.

Validation now determines every contract a transaction *touches* — a slot, a
proposition, a claim, a support row, an assessment or a derivation under a
predicate or frame absent from the pinned release — and, when it touches one,
refuses the transaction if it also:

- places SUPERSEDED or REJECTED over a proposition whose live verdict is ACCEPTED
  (`SUPERSEDE_ACCEPTED_BELIEF`);
- changes the verdict of a CONTESTED proposition, or of one in a slot holding two
  or more live propositions (`RESOLVE_CONFLICT`);
- places ACCEPTED over the unregistered proposition (`SET_CURRENT_VALUE`);
- is declared HIGH risk (`AUTHORIZE_HIGH_RISK_ACTION`).

The report lists each use under `unregisteredPredicateUses` and the decision is
REJECTED. The read side holds the same rule: the selector never selects a value
under an unregistered contract (rule 4 above) and fails closed when no release is
pinned, and `EvaluateMemoryAction` denies a HIGH-risk action whose supporting
memory includes one (`UNREGISTERED_PREDICATE_MAY_NOT_AUTHORIZE_HIGH_RISK_ACTION`).
`registry_contract_present` gains `memory.read` so the broker can ask; it still
answers one boolean.

## 5. `POST /v1/ask` classifies into the eight §8.2 types without a model

`classifyQuestion` is an ordered list of word-boundary rules over the question,
first match wins, and the matched rule is returned. It answers one of the eight
§8.2 types and maps it to one of the thirteen §23.3 query modes the broker plans
under; the context request now carries that mode as `answerType`, so the packet
is planned for the question Ask classified rather than re-classified from text.
A historical-belief question ("what did Uai believe then") pins the knowledge
time to the world time when the caller left it at LATEST, which is PRD §12.3's
definition of the mode.

The answer is composed deterministically from the packet: every statement names
the packet objects it rests on, carries one of the ten §24.5 labels, and links
the evidence items behind it. A contested value is worded as contested, a future
modality as not having happened, a pending owner assertion as the owner's and not
verified, and a slot with nothing selected as unknown. No model is called, so the
same question over the same memory yields the same statements.

The route runs under the `memory.read` purpose, because it is a broker read and
the packet it records is the broker's. It takes the actor from the session and
refuses a body naming another owner scope.

Not here: the answer manifest (FR-065) and the grounding validator (§24.6) belong
to `answer-manifests-grounding-validator-and-reconsideration`, which depends on
this node, and model phrasing of the answer belongs with them. The response
therefore carries no `answerManifestId` and no validator action, rather than
placeholders that could be read as a manifest or a validation that never
happened.
