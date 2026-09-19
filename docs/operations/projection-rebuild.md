# Projection rebuild

Prerequisites: migration/replay principal, owner and actor UUIDs, the pinned
registry release, a backup, and an isolated test database. Stop writers during
comparison so the canonical and overlay watermarks cannot move underneath it.

1. Record projection content, reducer/release versions, completeness flags and
   owner watermarks. In the test environment, drop only the disposable projection
   tables under test; never drop canonical evidence, beliefs or audit events.
2. Run the checked-in migrations to recreate missing projection tables, then
   `pnpm uai registry projection-replay --owner-scope <owner> --actor <actor> --registry-version <version> --report projection-replay-report.json`.
3. Compare rebuilt content with the incrementally maintained source snapshot,
   including outcome arithmetic, conflicts and incompleteness. Check the rebuild
   receipt, reducer version and both watermarks. Replay a second time and verify
   identical semantic rows. Persist the receipt and comparison report.
4. On mismatch keep high-risk actions blocked and the projection marked incomplete;
   investigate the canonical input/reducer version and replay again. Restoring a
   stale projection without its matching canonical state is not a rollback.

Test execution: `node scripts/test.mjs --stage property` or `pnpm test` runs
packages/capabilities/src/projection-replay.test.ts's CRT-PRJ-02-B case in a
database of its own: drop, recreate and replay really execute. The generated
transaction sequences in projections.test.ts compare incremental and full replay.
