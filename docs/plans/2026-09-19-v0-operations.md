# V0 operations implementation plan

**Goal:** deliver the Operations runbooks screen, executable CI stages and evidence-driven release checks for the six assigned criteria.
**Architecture:** retain the existing PostgreSQL/S3 test harness and full acceptance gate. Publish bounded, schema-validated operations reports; the authenticated web page renders procedures and evidence without performing administrative writes. Release checks fail when evidence is absent.
**Tech Stack:** TypeScript, Zod, React/Next.js, Vitest, PostgreSQL, GitHub Actions.

1. Add release report schemas and evaluator tests in `packages/domain/src/operations.test.ts`. Cover missing evidence, skipped tests, non-main runs, incomplete restore comparisons, unreviewed deviation inventories, and open critical defects. Run the focused test before implementation.
2. Implement the evaluator in `packages/domain/src/operations.ts`, export it, and add an operations CLI under `src/operations/` to publish a metadata-only report and reject incomplete releases.
3. Add component tests, then the Operations runbooks component and authenticated `/ops/runbooks` page. Show all six procedures, individual execution states, restore parity, ADR index, and defect status. Missing or malformed reports cannot show a pass.
4. Publish six procedures in `docs/operations`, with prerequisites, commands, verification, recovery and evidence retention. Exercise existing deletion, migration, replay and revocation test paths, and document the limits of simulated providers.
5. Add explicit named CI test stages using the existing disposable harness. Preserve `pnpm test` and all existing workflow checks. Verify local-only policy dependencies and archive the evidence.
6. Rehearse a real PostgreSQL backup and restore into an empty database; distinguish database round-trip evidence from the stronger requirement to answer all twenty acceptance fixtures identically after restoring the complete environment.
7. Run `pnpm test` and useful targeted checks. Record unresolved historical ADR coverage, hosted main pipeline evidence, restore gaps or defects honestly in the report and durable review. Do not backdate ADRs or invent execution receipts.
