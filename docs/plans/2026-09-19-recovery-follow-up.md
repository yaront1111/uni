# Recovery follow-up, 2026-09-19

This attempt must add a default-suite restored-read regression, execute the six
procedures, and inventory historical ADR deviations without backdating.

The existing acceptance suites mix persisted S3 evidence with in-memory evidence
ports. Recovery evidence must identify that distinction, and must not count a
row-only copy or a replay of test assertions as regenerated Today/Ask parity.
