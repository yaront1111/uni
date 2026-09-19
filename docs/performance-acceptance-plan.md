# Performance, tracing and acceptance implementation plan

**Goal:** Verify CRT-NFR-01-A, CRT-NFR-05-A, CRT-PRJ-05-A and CRT-QA-04-A.
**Architecture:** Record owner-scoped load results from the actual API and storage paths, expose them through the existing metrics response, and instrument service boundaries without recording content. Reuse executable journey tests where they already assert the approved scenarios.
**Tech Stack:** TypeScript, Vitest, PostgreSQL RLS, Fastify, React and OpenTelemetry.

1. Extend `apps/web/components/Metrics.test.ts` with recorded, failed-target and empty performance states. Run the component test before implementing the domain response and panel.
2. Add `packages/api/src/performance.test.ts` to exercise ingestion acknowledgement, typed projection reads and packet assembly against PostgreSQL and encrypted object storage. Measure monotonic elapsed time at bounded concurrency; record all samples and nearest-rank P95 in `performance_measurements`. Assert strict targets, persistence and owner isolation.
3. Add the measurement migration, ownership classification and replay/isolation fixtures. Read recorded results through `packages/api/src/metrics.ts`; never manufacture a measurement for an empty window.
4. Test metadata-only tracing across a real ingestion-to-answer flow. Add instrumentation at actual service boundaries and retain errors without recording their text.
5. Map §44.1–§44.20 to behavioral tests. Extend Daniel's sequence and any scenario gaps. Keep the full suite in CI and preserve existing checks.
6. Run `pnpm test`, inspect the diff and document exact coverage and any remaining findings before durable submission.
