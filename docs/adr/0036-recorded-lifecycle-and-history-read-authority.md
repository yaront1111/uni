# 0036: Recorded lifecycle and history read authority

Status: Accepted

The assessment ledger preserves verdicts, but graph lifecycle, claim attachment,
overlay attachment and resolution lifecycle were mutable columns. A later
retirement, merge, contest or withdrawal could change an earlier knowledge-time
answer. Owner-scoped caches also retained private questions and thread titles
without proving the current request could read their sources.

Migration 0030 records lifecycle and structural IDs in an append-only journal.
Initial records use the object's recorded/creation instant; subsequent changes
use database wall time after obtaining the object's write lock. Ties are ordered
by journal sequence. Existing records receive a migration checkpoint: earlier
state is unknown. Readers must never substitute today's mutable state for a
missing checkpoint. Canonical values, raw assertion text, names and opaque
rationales are not copied into the journal. Deleting an object deletes its
journal entries through the same transaction, so erasure cannot reconstruct it.

The owner-and-purpose-gated `object_state_at` lookup returns one metadata state
or null. Temporal selectors and provenance traversal consume recorded bindings;
lineage traversal considers only edges recorded by the requested knowledge time.
World time still applies separately to assessment validity and outcome effective
dates. Historical access never overrides present source permissions or present
suppression/deletion. Projection completeness and watermarks remain explicitly
current operational metadata, not reconstructed historical projection snapshots.

Saved packets and answer manifests revalidate the saved request's purpose and
sensitivity boundary, cited sources and present removal controls. They fail
closed instead of returning a partial historical packet with its original hash.
Manifest reads require explicit declarations and return a precise source-withheld
refusal; missing IDs retain their existing not-found behavior. Reconsideration
lists include only manifests the same request can read.

Free-form thread titles and unprovenanced matcher text are not source authority.
Public thread reads omit titles until a source-bound title representation exists.
History read routes require source declarations, and displayed names require a
readable source-backed alias. Old raw questions, control text or names cannot be
returned merely because their owning rows share an owner scope.

Outcome citations include their direct claim and evidence IDs. Saved legacy
outcomes recheck source authority through an owner- and purpose-gated boolean
lookup when replayed; this returns no outcome values or source text. Independent
verification and goal-link citations also belong to the saved provenance set.
Historical inspector details, thread memberships, outcome states and claim
bindings use the same knowledge cutoff as their subject.
