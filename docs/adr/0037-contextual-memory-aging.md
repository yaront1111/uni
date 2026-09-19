# ADR 0037: Contextual memory aging and immutable provenance

Date: 2026-09-19
Status: Accepted for implementation.

Authority: PRD 12.7–12.10, 23.4, 42 and 44.21–44.23, and the owner's
clarification that old information can remain correct while some information
becomes unsuitable for current use within a day.

## Decision

Freshness is a pure assessment of current applicability under a pinned semantic
policy. It does not change historical confidence, retention, truth, or outcomes.
Query relevance is a separate caller input: it can trigger verification or raise
the prominence of old history, but cannot rewrite the assertion's original time.

Seven policy kinds are supported: STABLE, BOUNDED, LAST_KNOWN, PREFERENCE,
UNRESOLVED, DECISION_HISTORY and INCIDENTAL. There is no universal decay score
or lifetime. Bounded episodes use their stated half-open valid interval; its end
does not assert recovery or the opposite condition. Last-known values and
preferences can require verification under explicit review defaults. Unfinished
commitments remain unfinished until outcome evidence. Decision rationale stays
retrievable when relevant. Incidental information may lose default prominence
without being deleted or converted into a durable personal fact.

An optional `agingPolicy` is attached to a registered predicate in new release
0.3.0. The mapping repeats the frame and predicate IDs and lint verifies them.
Legacy releases remain byte-identical and yield UNKNOWN when no policy exists.
No birthdate, salary, employer, preference or illness contract is invented by
this change. Tests may exercise these policy semantics without writing fictitious
canonical contracts into the product.

Review intervals are versioned product defaults expressed in elapsed 24-hour
days. They are prompts for uncertainty/verification, never evidence of change.
The owner can inspect the policy explanation and review interval through the
assessment's pinned policy. A later policy produces a new assessment; an earlier
answer retains its original policy version and result.

## Evidence time

Only an original assertion, explicit confirmation or direct observation about
the same fact qualifies to advance its freshness basis. Evidence arrays provided
to the evaluator have already passed source authority. Each item carries its
original asserted time, precision, recording time and exact claim/evidence IDs.
Restatements, summaries, re-extractions and quotations must name a qualifying
original with its original references and time; otherwise they establish no
freshness basis. Supporting inputs of a computation are not automatically new
assertions about the output. Both the new record and its original must be known
at the requested knowledge time.

Import, processing, retry, retrieval and summary times are not accepted as
fallback source times. Unknown source time remains UNKNOWN. Coarse time precision
is carried honestly; an ambiguous review boundary cannot become an exact expiry.
Valid time and recorded time remain separate. The evaluator consumes already
resolved source-local valid instants; it does not re-resolve relative language
against its own clock.

## Runtime boundary and persistence

The runtime does not import the registry tooling or read release files. Add a
narrow `unai_private.aging_policy(release_id, predicate)` reader under authorized
owner memory read/inspect purposes. It returns only the pinned predicate policy
and immutable release identity, version and content hash. The reader opens the
release table before contracts, preserving the snapshot publication lock order.
No direct snapshot-table grants or registry write capability are introduced.

Policy JSON is already covered by immutable contract snapshots and release
hashes. Context packets and answer manifests preserve the full freshness result,
including policy/release/evaluator versions, evaluation/world/knowledge times,
source basis and precision, interval, qualifying references and reason. Reads
write no canonical belief, source time, retention decision or outcome.

## Verification

Fixed-clock tests contrast decades-old stable information with a bounded episode
that ceased to apply yesterday; test all seven policies, unknown time, source-local
intervals, late imports, repeated processing, explicit original quotation lineage,
new confirmations excluded by historical knowledge time, independent relevance,
and policy-version reproducibility. Registry tests reject mismapped/incoherent
policies while retaining byte-identical legacy releases. Database tests exercise
the narrow reader under actual owner/purpose authority.
