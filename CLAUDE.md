# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Uai: a private, evidence-grounded personal memory system ("memory kernel"). `PRD.md` (~4,500 lines) is the product authority; its §0 rules bind the implementer: build in phase order, no mocks outside tests, raw evidence stays durable even when later processing fails, and any deviation from the PRD needs an ADR in `docs/adr/` **before** the code. §42 lists the non-negotiable invariants (hashes are indexes never identities, evidence is not belief, registry releases are immutable, past state is never rewritten). §28 is the reference stack.

The repo is built slice by slice by moe-next agents (`.moe-next/README.md`); the daemon accepts a delivery only when `pnpm test` passes. `docs/*.md` are per-node delivery reports: they record what each node does and explicitly does *not* claim, so check them before assuming a feature exists.

## Commands

Prerequisites: Node 24, pnpm 11.0.8, Docker, OpenSSL (Git for Windows' bundled binary is found automatically).

```
pnpm install --frozen-lockfile
pnpm typecheck            # root tsc (src + packages) then apps/web tsc
pnpm test                 # full suite behind the harness (see below)
pnpm build                # Next.js production build of apps/web
pnpm validate:registry    # = pnpm uai registry lint (also the registry migration-evidence gate)
pnpm uai registry test | shadow-diff | projection-replay   # the other three PRD §35.14 commands
pnpm uai corpus import | annotate | run | verify | status   # the gold corpus (corpus/README.md)
pnpm check:phase-exit     # typecheck + test + validate:registry + registry test + corpus run + corpus verify
pnpm hooks:install        # core.hooksPath=.githooks (also run by `prepare`): blocks commits under corpus/private-local/
pnpm db:migrate           # needs UNAI_MIGRATION_DATABASE_URL + UNAI_DATABASE_CA_PATH
pnpm start:api            # Fastify API over TLS, default port 3443
pnpm dev:web              # Next.js via apps/web/server.ts (TLS listener)
```

CI (`.github/workflows/foundation.yml`) runs typecheck, test, build, validate:registry, `uai registry test`, a corpus-sample `uai registry shadow-diff`, a guard that nothing under `corpus/private-local/` is tracked, and `uai corpus run --corpus synthetic` against `corpus/expected/identity-thresholds.json`. `uai corpus verify` (real-corpus results) runs only in `check:phase-exit`: it fails until the owner records results over at least ten real Gmail threads.

### Test harness

`pnpm test` runs `scripts/test.mjs`, not vitest directly. It starts a disposable pgvector container (or uses a delivered server from `UNAI_TEST_DATABASE_URL`/`DATABASE_URL`, creating and dropping a scratch database on it), applies `migrations/`, starts TLS + KMS object storage (delivered `UNAI_TEST_S3_*` bucket, else MinIO, else the in-process `scripts/s3-object-server.mjs`), then spawns `vitest run` with those env vars. Failures are named by step (`DATABASE_PROVISIONING_FAILED`, `MIGRATION_FAILED`, `STORAGE_PROVISIONING_FAILED`), so a harness failure is not a product failure. The suite creates and drops databases, roles and objects: never point it at a real database or bucket.

The harness forwards no arguments, so a single test goes through vitest:

```
pnpm exec vitest run src/kernel/clock.test.ts          # pure tests: src/, domain, registry lint, secrets, web components
pnpm exec vitest run packages/registry/src/lint.test.ts   # name the file: a bare packages/registry path imports snapshot.test.ts, which throws without a database even under -t
```

Database-backed tests (`packages/postgres`, `auth`, `api`, `jobs`, `registry/src/snapshot.test.ts`) fail without `UNAI_TEST_DATABASE_URL`: some throw "Run pnpm test for the required PostgreSQL harness", while the `auth` and `api` suites have no guard and die with an invalid-URL or connection error instead. The evidence tests also need `UNAI_TEST_S3_*`. To run one alone, export `UNAI_TEST_DATABASE_URL` for a throwaway, already-migrated pgvector server first; otherwise run the full `pnpm test`.

## Architecture

pnpm workspace (`apps/*`, `packages/*`), ESM, TypeScript executed by `tsx` with no emit step. `packages/` import with `.js` specifiers, root `src/` with `.ts` specifiers. tsconfig is strict plus `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.

Most folders carry their own `CLAUDE.md` with local invariants, change checklists and traps (`packages/*`, `apps/web`, `src`, `migrations`, `registry`, `scripts`); read the one for the folder being changed.

Two code lanes, joined only by `uuidV7` (imported from `src/kernel/identities` by `packages/api`, `jobs` and `registry` through a relative path):

- `src/kernel`, `src/wrapper`: the original in-memory memory-kernel slices (UUIDv7 identities, evidence ledger, provenance, redaction, clock, claims), pure TypeScript with no I/O.
- `packages/` + `apps/web`: the reference-stack product (Fastify, Next.js Pages Router, PostgreSQL/pgvector, S3, OpenTelemetry).

Package layering:

- `@unai/domain`: Zod schemas and types only (`RequestContext`, audit events, devices, evidence, jobs, source parsers). `src/architecture.test.ts` fails if it imports anything except `zod` and local `./` files, or uses dynamic `import`/`require`.
- `@unai/postgres`: `createDatabasePool` (TLS-verified only), `withOwnerTransaction`, `runMigrations`, `assertOwnershipCoverage`.
- `@unai/auth`: Auth.js Google OIDC adapter, 7-day absolute PostgreSQL sessions, `resolveSession`/`revokeSessions`.
- `@unai/storage`: encrypted S3 adapter that verifies bucket settings and every read/write encryption receipt.
- `@unai/secrets`: `secret://<provider>/<name>[#field]` handles; runtime services refuse to start when a credential variable holds a literal (ADR 0013).
- `@unai/jobs`: PostgreSQL-backed durable queue (leases, bounded attempts, dead letter). `runJobAttempt` uses three separate transactions for claim, handler and outcome. No broker, no Redis.
- `@unai/registry`: Git-file semantic registry (`registry/releases/<version>/*.yaml`) with lint, release hashing and an immutable database snapshot, exposed through the CLI `pnpm uai registry lint|test|shadow-diff|projection-replay|publish`. Release files are byte-exact (`.gitattributes -text`). Procedure: `docs/registry.md`. It is also the evaluation tooling package (never deployed): the migration-evidence gate (`migration.ts`, a release's `migration.yaml`), the contract test battery (`contract-tests.ts`), the shadow evaluation engine and owner-sample reader (`shadow.ts`, `shadow-store.ts`) and the gold corpus (`corpus.ts`, CLI group `pnpm uai corpus`). Report: `docs/evaluation-and-boundaries.md`, ADR 0031.
- `@unai/memory`: canonical identity — the entity service with its under-merge default, the temporal resolver, the belief-slot/proposition store with versioned lookup fingerprints, and the claim store. Pure functions over an `OwnerTransaction` the caller opened; no route, job or projection. Report: `docs/canonical-identity.md`. It also holds canonicalization and bitemporal state: the BASE-context default with source attribution, frame-instance matching with its five outcomes, the claim relations that tell a correction from a change, and the three query modes of PRD §12.3. Report: `docs/canonicalization-and-bitemporal.md`. It also holds owner read-your-writes (`overlay.ts`): the owner-sequence allocator, the overlay deltas every device of one owner reads at once, and the ten correction operation kinds. Report: `docs/owner-overlay-and-corrections.md`. It also holds outcomes (`resolutions.ts`): the resolution assertions that are the sole outcome authority, the ten protocol link kinds with registry transition-contract validation, and the outcome projection derived on read. Report: `docs/resolutions-and-outcomes.md`. It also holds the semantic index (`embeddings.ts`): a pinned local lexical embedder, the claim indexer the belief governor calls inside every commit, and a search that applies the owner, permission, sensitivity, time, source and entity filters before ranking. Report: `docs/semantic-index-and-ask.md`. It also holds lineage (`lineage.ts`): the frame-instance, proposition and entity lineage writers, governed retirement, slot rehoming, and the resolvers every reader uses to follow a merged or split id. The governed MERGE and SPLIT operations themselves are `@unai/belief`'s (`lineage.ts`), applied inside a belief transaction commit. Report: `docs/merge-split-lineage.md`.
- `@unai/model`: the provider-independent LLM gateway. One `invoke` that validates
  provider output against the caller's Zod schema before returning it, records
  `model_call_records` for every call (succeeded, rejected or failed) in its own
  `model.call` transaction, and enforces a cost ceiling. Adapters for the
  configured provider live here and nowhere else. Report: `docs/model-path-and-extraction.md`.
- `@unai/extraction`: triage and bounded extraction. Tier-0 parsing and Tier-1
  routing are pure and run inside the evidence ingest transaction, so every item
  has a recorded route; `runExtraction` produces span-anchored claims through the
  gateway and records an `extraction_runs` row pinned to every version it used.
  It starts no worker: `createExtractionJobHandler` is the handler for job kind
  `evidence.extract`.
- `@unai/capabilities`: the commitment, obligation and schedule capabilities and the typed projections they maintain. It exists so that "the Memory Kernel performs no financial arithmetic" is checkable: `money.ts` is the only exact-decimal arithmetic in the repo (scaled `BigInt`, no rounding, no currency conversion), and `src/architecture.test.ts` fails on arithmetic over a money-named operand anywhere in `@unai/memory` or `src/kernel`. One reducer serves both `applyProjectionDelta` and `replayProjection`, so incremental state and full replay cannot drift. Report: `docs/typed-projections.md`.
- `@unai/context`: the Context Broker, the belief explanation and the memory threads — the only memory read path for models and plugins. `memory.read` appears in no write policy anywhere, so this package can traverse an owner's memory and change none of it; the only rows it writes are its own `context_packets` record and a thread membership. Life categories are derived on read (`categories.ts`), never stored. `readContextPacket` deliberately uses two transactions so a denied read is still a recorded one. Report: `docs/context-broker.md`. It also holds deterministic current-state selection (`selector.ts`, a pure function whose output digest is identical run after run), the eight-type question classifier (`question.ts`) and the Ask pipeline (`ask.ts`), which composes labelled, source-linked statements from a packet without calling a model. Report: `docs/semantic-index-and-ask.md`. It also holds answer provenance: the grounding validator (`grounding.ts`, pure) that blocks, downgrades or regenerates every candidate answer before it is presented, an optional `AnswerPhraser` port a model fills, and the answer manifests (`manifests.ts`) derived from the persisted packet and recorded under the `answer.record` purpose, which no request can declare. Every answer is stored as ASSISTANT conversation evidence, routed `SOURCE_ONLY` and never support. Report: `docs/answer-provenance.md`. It also holds the Today briefing (`today.ts` builds an edition from one broker packet and the projection rows of the frames that packet supplied; `ranking.ts` is the pure selection, ranking and repeat suppression) and the Why? / Sources panel read (`why.ts`). Report: `docs/today-and-ask.md`. It also holds the inspection reads behind the memory screens (`inspector.ts`): `inspectMemory`, which resolves any surfaced object (proposition, claim, frame, resolution, overlay delta) to its belief and adds asserting actors, anchor text, inferences, threads, access history (audit rows and answer manifests naming it) and memory operations to the explanation, and `readRelatedFrames` for the Commitments and Obligations rows. Report: `docs/memory-screens-and-correction-controls.md`.
- `@unai/connectors`: the required V0 connectors and their permission model — the
  manifests with their discrete capabilities, the one-row-per-capability grant
  store, the read-only Gmail/Calendar/GitHub clients, the cursor-resuming sync,
  disconnect with token revocation, document upload with its four full-extraction
  triggers, and the least-context plugin bundle. It produces evidence only: no
  belief path, no object store, no queue — those are ports the API supplies.
  Report: `docs/connectors.md`.
- `@unai/control`: governed action and the data-control surface — drafts that exist only under a recorded `EvaluateMemoryAction` ALLOW, recommendations stored `RECOMMENDED`, the append-only six-stage action history, plugin capability grants (no external write is grantable), the owner's settings, export, the deletion cascade (`unai_private.erase_evidence`, the one path that deletes canonical or evidence rows) and semantic-index regeneration. Report: `docs/governed-action-and-data-control.md`.
- `@unai/review`: proactive clarification and the weekly review -- clarification cards grouped by situation, the attention budget and interruption policy with logged inputs, learned approval rules, and the weekly review with its behavioral observations. It reads memory only through a Context Broker packet the caller supplies; answering a card is written by the API through the correction path. Report: `docs/memory-inbox-and-weekly-review.md`.
- `@unai/api`: `createApiBoundary` (`index.ts`) is the generic Fastify boundary; `createPlatformApi` (`platform.ts`) is the production composition with device, evidence (`evidence.ts`), governed memory write (`memory.ts`), correction control (`corrections.ts`), typed projection read (`projections.ts`), Context Broker and inspection (`context.ts`), question answering (`ask.ts`, `POST /v1/ask` under `memory.read`), answer provenance (`answers.ts`, the answer recorder and `GET /v1/answers/{id}/manifest` and `/v1/answers/reconsideration-candidates` under `memory.inspect`), connector, sync and document (`connectors.ts`), governed merge and split (`lineage.ts`), the Today briefing and the Why? / Sources panel (`today.ts`, `GET /v1/today` under `memory.read` and `GET /v1/memory/why/{type}/{id}` under `memory.inspect`), the memory inbox, learned approval rules, attention budgets and weekly review (`review.ts`), governed action and data control (`control.ts`: drafts, actions, recommendations, permissions, export, deletion, regeneration), goals, decisions, prediction review and the mentor (`decisions.ts`), ops (`ops.ts`) and metrics and shadow-run (`metrics.ts`: `GET /v1/ops/metrics` under `ops.metrics.read`, `GET /v1/ops/shadow-evaluations` under `ops.shadow.read`) routes; `server.ts` is the entry point.
- `apps/web`: Next.js Pages Router. The product screens (Today, Ask, Memory Inbox, Learned approval rules, Weekly Review, Action history, Draft approval, Recommendation detail, Permissions and integrations, Export and delete my data) sit in the accessible shell (`components/Shell.tsx`) or the shared screen chrome and label every statement with the grayscale-safe uncertainty labels (`components/Labels.tsx`); Today and Ask read through `lib/screens.ts`. `pages/api/platform/[...path].ts` is a same-origin proxy: it derives owner scope from the verified session, refuses cross-origin writes, maps path to purpose, and calls the API over verified TLS. The browser never talks to the API directly.

### The owner boundary (the central pattern)

Every API request needs: a TLS socket (else 426), the `__Host-unai.session` cookie, `x-owner-scope-id`, `x-purpose`, a UUID `x-correlation-id`, and on writes an `idempotency-key` (16–128 chars). Evidence routes add `x-data-purpose` and `x-maximum-sensitivity`. `actorId` comes only from the session, never from a header or body.

All data access goes through `withOwnerTransaction(appPool, context, run)`. It refuses a superuser, BYPASSRLS or table-owning role (`DATABASE_ROLE_UNSAFE`), sets `unai.owner_scope_id`/`actor_id`/`purpose`/`correlation_id` as transaction-local settings that the RLS policies read, checks live membership, and verifies the `COMMIT` command tag (PostgreSQL answers `ROLLBACK` after a caught statement error). Successful work and its `tx.audit(...)` row commit atomically; refusals and failures are audited in a separate transaction after rollback.

Database roles: `unai_app` (no ownership, no BYPASSRLS, forced RLS on every table), `unai_auth` (only EXECUTE on fixed functions), and a privileged migration owner that must never be used as a runtime login.

Adding a route: add its purpose string to the `purposes` set **and** the URL-to-purpose chain in `platform.ts`, to the web proxy mapping if the browser calls it, and to the SQL policy when the table gates on purpose (as `jobs` does).

Adding a table: a new `NNNN_snake_case.sql` migration with forced RLS, `unai_private.has_owner_access(owner_scope_id)` policies and composite owner foreign keys; classify it in `packages/postgres/src/ownership.ts` (`assertOwnershipCoverage` fails on any unclassified table); add an unfiltered cross-owner fixture in `packages/postgres/src/isolation.test.ts`, which is driven from `OWNER_SCOPED_TABLES`.

Migrations: applied files are immutable. The ledger stores SHA-256 digests, and editing an applied file yields `MIGRATION_HISTORY_MISMATCH`, so always add a new file. Four-digit sequences are unique and files contain no embedded transaction control. Roles are cluster-global, so migrations create them only when absent and then assert their attributes.

### Error and telemetry discipline

Errors are stable UPPER_SNAKE codes (`OWNER_ACCESS_DENIED`, `PURPOSE_REFUSED`, `REGISTRY_*`). Raw database and provider error text is never returned, logged or recorded on spans, because it can carry private values. Logs and spans use a fixed allowlist: correlation id, owner scope, purpose, status, duration. Public DTOs go through `public*Schema` and never expose session tokens or digests, private object keys, or job payloads.

### Package boundaries

`src/boundaries.test.ts` builds one TypeScript program of the workspace and walks what code *reaches* (identifier to declaration, transitively), not only what it imports. It fails when a connector package reaches the belief commit path, when the model gateway or the plugin runtime (`@unai/connectors`) holds a database credential, imports a repository package or reaches memory except through `packages/context`, when extraction or the gateway reaches an assessment writer, or when any package imports `apps/web`. In-memory probe files prove each rule fails. A new memory read for a model or plugin belongs in `@unai/context`; a call through an injected port (an interface member) ends the walk. Definitions: ADR 0031 §1.

## Repo hygiene

`.moe-next/trees/` holds about 70 git worktrees (full repo copies on `moe/node-*` branches), and `.moe/`, `.moe-next/` and `store.sqlite*` are excluded through `.git/info/exclude`. Scope searches to `src`, `packages`, `apps`, `migrations`, `docs` and `scripts` to avoid duplicate hits, and leave those worktrees, branches and store files alone.
