# ADR 0001: Phase 0 reference stack

Date: 2026-09-14
Status: Accepted by approved Product Contract and design v1

Authority: contract-uai-v0, revision rev-uai-v0-001, digest
22027aaaeea527eb7b1d2ae3dab70bfabda8ff13c660bf0e0839356f91fe1339;
design goal-2cf9472a-d972-4e97-88cf-1734639d9700@v1.

Use a TypeScript monorepo, Next.js web shell, Fastify API, shared Zod runtime
schemas, PostgreSQL with pgvector, Git-versioned SQL migrations, encrypted
S3-compatible object storage, and OpenTelemetry-compatible observability.
There is no graph database or separate vector database. Domain packages must
not import providers or UI; application composition supplies provider adapters.

This records the reference stack without introducing a deviation. Existing
memory-kernel sources and unrelated workspace changes must be preserved.

Authentication method and session model require a separate product decision.
Design v1 also leaves responsive web delivery on phones unspecified. Neither
native-mobile scope nor authentication semantics may be invented. The product
decision was requested before implementation; those flows remain blocked until
it is answered. This ADR does not approve either unresolved choice.
