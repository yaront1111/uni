# ADR 0047: Unresolved candidate claims on the Source page

Date: 2026-11-06

Status: Accepted. Amends ADR 0027 §6 (the Why? / Sources panel opens three
object types; this record adds a fourth) and adds one list read beside the
inspection routes of ADR 0028 §1. Recorded before the code (PRD §0 rule 7).
Source of truth: the owner's decision of 2026-11-06 (REPL; recorded as
comment-d1bc1451 on task-732c9d9a). Implemented by task-e11c766b (the API read)
and task-732c9d9a (the Source page).

## Context

- ADR 0041 D4 and D10(d) give no Omi claim an asserting entity, so
  `canonicalizeProcessingClaims` (`packages/api/src/processing-canonicalization.ts`)
  leaves every OMI claim unresolved: `proposition_id` null, lifecycle
  `CANDIDATE`. An owner-spoken commitment therefore reaches extraction and then
  has no surface at all.
- Why? / Sources opens only `propositions`, `owner_overlay_deltas` and
  `resolution_assertions` (ADR 0027 §6; `whyObjectTypeSchema`,
  `packages/domain/src/today.ts`).
- The Memory inspector is belief-centred and answers 404
  `INSPECTOR_TARGET_NOT_FOUND` for a claim with no proposition (ADR 0028 §1;
  `packages/context/src/inspector.ts`).
- Claims are readable only under the `memory.*` purposes (the `claims`
  `owner_read` policy, `migrations/0017_context_broker_and_memory_threads.sql`),
  so `GET /v1/evidence/{id}` (`evidence.read`) cannot list them.
- `unai_private.evidence_access` admits `memory.inspect`
  (`migrations/0021_answer_manifests_and_reconsideration.sql`), so a
  `memory.inspect` read can quote anchors once the request declares its data
  purpose and ceiling.
- The Why excerpt carried no anchor JSON, so even a belief's panel could not
  name a transcript segment or its speaker.
- PRD §7.6 (the inspector lists claims and asserting actors), §15.2 (a claim may
  exist without a proposition) and §37.1 (Why opens the accepted belief or the
  overlay assertion; this record extends it to an unresolved claim).

## Decision

### D1. Surface

- `claims` becomes a Why object type: `GET /v1/memory/why/claims/{id}`, under
  `memory.inspect`, through the existing Why route.
- One list read: `GET /v1/memory/evidence/{id}/claims`, also under
  `memory.inspect` (`packages/api/src/inspection.ts`, `INSPECTION_URLS`). It
  requires `x-data-purpose` and `x-maximum-sensitivity`, as the inspector does.
- The Source detail page lists a source's candidates, each with the existing
  Why? / Sources disclosure (task-732c9d9a).
- No migration and no RLS change. `evidence.read` still cannot see claims.

### D2. What counts as an unresolved candidate

At the read's knowledge time, read through `unai_private.object_state_at`
(migration 0030 journals a claim as `{lifecycle, proposition_id}`), a claim is an
unresolved candidate when it has no `proposition_id` and its lifecycle is
`CANDIDATE` or `AWAITING_INSTANCE_RESOLUTION`.

- A claim a belief took up opens that belief's panel: Why answers what a
  statement rests on, and the belief is that statement. The proposition decides
  before the lifecycle does: a captured commitment's or decision's claim keeps
  lifecycle `CANDIDATE` with a `proposition_id` (`packages/capabilities`), and it
  is neither a candidate panel nor listed.
- Any other claim, including an unattached `REJECTED` or `SUPPRESSED` one, is
  `WHY_OBJECT_NOT_FOUND` and is not listed.
- A claim recorded after the read time is neither opened nor listed.

### D3. Label

The panel's label is `REPORTED`, with `subjectKind` `CANDIDATE_CLAIM`. The
display vocabulary of PRD §24.5 and §37.2 is unchanged.

### D4. The statement is built by code from the exact quote

The statement is built from the claim anchor's `normalized_text`, the exact
span the extractor quoted and `resolveExtractedSpan` verified. It is never
`claims.metadata.statement`, which is the model's paraphrase (PRD §24.1, §24.6;
connector content is untrusted data, §27.4). The wording:

| Anchor | Statement |
|---|---|
| `TRANSCRIPT_SEGMENT`, role `OWNER`, OMI source | `You said (as Omi identified the speaker): “<quote>”` |
| `TRANSCRIPT_SEGMENT`, role `OWNER`, another source | `You said (as the transcript identified the speaker): “<quote>”` |
| `TRANSCRIPT_SEGMENT`, role `OTHER` or `UNKNOWN`, with a label | `<speakerLabel> said: “<quote>”` |
| `TRANSCRIPT_SEGMENT`, no usable label | `An unidentified speaker said: “<quote>”` |
| any other anchor kind | `The source says: “<quote>”` |

An anchor with no text reads `This source records a position but no words for
this statement.` The quote is the excerpt (at most 600 characters), so the
statement stays within the panel's 1000-character bound.

### D5. The transcript segment on every excerpt

Every Why excerpt on a `TRANSCRIPT_SEGMENT` anchor carries
`transcriptSegment {conversationExternalId, segmentIndex, speakerLabel,
speakerRole, startSeconds, endSeconds}`, for belief, resolution and candidate
panels alike.

- `speakerLabel` is Omi's `speakerName` trimmed, internal whitespace collapsed
  and at most 80 characters. It is null when empty or when it reads `you`
  (case-insensitive), so a label can never make a bystander read as the owner.
- The role comes only from the anchor's `speakerRole` (ADR 0041 D4), never from
  the label.
- An anchor whose JSON does not parse into that shape carries no
  `transcriptSegment` and reads as "the source says": a malformed anchor
  degrades, it never fails the read.

### D6. The claiming actor is unchanged

An entity-less `MODEL_EXTRACTION` claim reads as the model (`Uai (a model
reading, not a person)`). A speaker is never an asserting entity (ADR 0041
D10(d)), and bystander speech stays third-party data (PRD §30.8).

### D7. Bounds and audit

- A list holds at most 50 statements, ordered by `recorded_at`, then the
  anchor's numeric `segmentIndex` (none last), then id, with a `truncated` flag.
- An unknown, deleted or unreadable item answers 404 `WHY_OBJECT_NOT_FOUND`;
  whether an above-ceiling item exists is never revealed.
- The list writes its audit row in the read's own transaction, naming the
  source item and each listed claim. The Why route audits a claim as it audits
  every Why object: in a second transaction after the read, naming the object
  and each quoted source item (`packages/api/src/today.ts`).
- A candidate whose anchor the request may not read is a withheld panel
  (`UNKNOWN`, redaction `SOURCE_NOT_READABLE_FOR_THIS_REQUEST`), never quoted.

## Rejected alternatives

- **The inspector for a claim.** ADR 0028 stays belief-centred
  (`memoryInspectorSchema` is built around a belief explanation), and its 404
  for an unresolved claim stands.
- **Claims on `GET /v1/evidence/{id}`.** It would widen the claims RLS read to
  `evidence.read`.
- **Memory Inbox cards.** Broker packets carry only beliefs, and cards need
  correction paths: that is an epic.
- **A new "Not yet in memory" label.** It would change the display vocabulary,
  `Labels.tsx`, its CSS and tests for one surface.
- **`INFERRED`.** False for a quoted speaker: nothing was inferred.

## Consequences

- `WHY_PANEL_VERSION` becomes `why-sources-0.5.0`.
- `today.test.ts`'s `why/claims` 400 pin changes to an unknown type.
- `omi-pipeline.test.ts`'s inspector 404 pin is replaced by the two reads.
- task-732c9d9a retires the `docs/omi-connector.md` non-claim about unresolved
  claims having no surface.

## Proof

- `packages/context/src/why.test.ts`: the wording matrix, the label
  sanitization and the malformed-anchor degradation (pure).
- `packages/api/src/today.test.ts`: a non-transcript candidate, an
  `AWAITING_INSTANCE_RESOLUTION` candidate, delegation of a taken-up claim
  (`PROVISIONAL`, and `CANDIDATE` with a proposition, which is also not
  listed), 404 for a rejected, unknown or missing object, the ceiling, the
  declarations, the purpose, the list order (recorded time, then the numeric
  segment index with none last, then id) and the 50-item bound.
- `packages/api/src/omi-pipeline.test.ts` cases 1 and 2: the owner's and a
  bystander's claim through both reads, and Omi's structured summary listing
  no statement.
- `packages/api/src/transport.test.ts`: the GET sweep covers the new route.
