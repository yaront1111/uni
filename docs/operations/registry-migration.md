# Registry migration

Operate from the pinned Git checkout with the migration principal and verified
database TLS; configure UNAI_MIGRATION_DATABASE_URL and UNAI_DATABASE_CA_PATH as
described in docs/registry.md. Rehearse against a disposable test database first.

1. Record the current release/tag/hash and a coordinated backup. Review an ADR
   before any implementing MUST/SHOULD deviation; never backdate the ADR.
2. Create the candidate immutable release and migration manifest. Include change
   class, shadow diff, projection replay output, pinned tests and rollback plan
   for identity-affecting, transition-affecting or breaking changes.
3. Run `pnpm validate:registry --report registry-lint-report.json` and
   `pnpm uai registry test --report registry-test-report.json`.
4. Run `pnpm uai registry shadow-diff --baseline <old> --candidate <new> --sample owner --owner-scope <owner> --actor <actor> --report shadow-diff-report.json`.
   Review instance-match, slot, proposition, belief, resolution, projection and
   cost/latency diffs. Verify production tables are unchanged by shadow evaluation.
5. Run `pnpm uai registry projection-replay --owner-scope <owner> --actor <actor> --registry-version <new> --report projection-replay-report.json`.
   After reviewed merge, tag the landing commit once, run `pnpm db:migrate`, then
   `pnpm uai registry publish --version <new>`. Verify the immutable release and
   migration manifest rows. Never move a published tag.
6. On failure stop rollout. Use the recorded rollback plan and coordinated backup
   in an isolated target; do not rewrite accepted history or the registry snapshot.

Test execution: `pnpm test` runs packages/registry/src/evaluation-db.test.ts. Its
CRT-REG-05-A case publishes a migrating release and checks its persisted manifest
and required predecessor; its CLI cases exercise verified TLS and replay.
