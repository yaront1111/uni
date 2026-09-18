# Registry runtime view and BASE context spaces: implementation and limits

Authority: contract-uai-v0 / rev-uai-v0-001, digest
22027aaaeea527eb7b1d2ae3dab70bfabda8ff13c660bf0e0839356f91fe1339;
design goal-b2cc3b54-1876-401e-a6a2-527f99b679bc@v1, read page by page with its
version and content-hash pins. Decisions are recorded in ADR 0014, which extends
ADR 0011. The Git release, loader, lint rules and publish path themselves are
documented in `docs/registry.md`.

## Delivered surface and entities

Design entities implemented here: `registry_releases` and `registry_contracts`
(materialized by the loader in `migrations/0006_registry_snapshot.sql`, exposed
read-only by `migrations/0009_context_spaces_and_registry_reader.sql`), and
`context_spaces` (`migrations/0009_context_spaces_and_registry_reader.sql`).

The designed screen "Registry release and migration" is implemented at
`/ops/registry` (`apps/web/pages/ops/registry.tsx`,
`apps/web/components/Registry.tsx`) with the states this node owns:

- Loaded release shown read-only from the runtime snapshot with its Git tag and
  content hash, and the statement that no network-reachable registry service
  endpoint exists in the deployment.
- Load refused because the content hash differs from the recorded hash for that
  version (rendered from the recorded refusal code; the refusal itself is the
  loader's, covered in `packages/registry/src/release.test.ts`).
- Lint failure on a contract missing a required frame or predicate field.
- Lint failure on an outcome status predicate or a cardinality outside
  FUNCTIONAL, SET and EVENT.

Not claimed here: the shadow-diff report state and the CI block for a missing
migration manifest, shadow diff, projection replay or rollback plan. Those are
CRT-REG-02-A and CRT-REG-05-A, owned by another node, with the
`registry_migration_manifests` entity. No other screen is added.

## The read-only snapshot view

`GET /v1/ops/registry-snapshot` (`packages/api/src/ops.ts`) answers the loaded
release — semantic version, Git tag, Git commit, content hash, released-at — and
its contract list with per-contract kind, version and hash. No contract body is
returned; contract text lives in Git.

The route is the only registry-shaped path in the deployed system, it is
GET-only, and it is bound to the single purpose `ops.registry.read`. Reading it
goes through `withOwnerTransaction`, so it carries the ordinary owner boundary
and appends an audit event. `packages/api/src/registry-boundary.test.ts` asserts
the whole route tree contains exactly that one path with no mutation verb, that
no deployed package imports the registry library or reads a release file, and
that no deployed manifest depends on it.

The snapshot tables keep forced RLS, no policy and no application privilege. The
application reaches them only through `unai_private.registry_snapshot()`, a
`SECURITY DEFINER` function with a fixed search path that refuses any
transaction without an owner context under that purpose (ADR 0014). A direct
`SELECT` by the application role is still refused with `42501`, and update,
delete and truncate are still refused by trigger.

## Context spaces

`context_spaces` holds BASE, QUOTED and TEST contexts per owner scope. Exactly
one active BASE per owner scope is a database invariant: a partial unique index
forbids a second one, an `owner_scopes` insert trigger creates it with the scope,
and update and delete triggers refuse to retire, re-kind or remove it. A derived
context must name a parent in the same owner scope; a BASE context has none.

`unai_app` receives SELECT only. No delivered capability creates a QUOTED or TEST
context — release 0.1.0 defines no QUOTED rule — so no write policy exists yet;
the node that first needs one adds it with its own purpose. Cross-owner
isolation, the exactly-one invariant and the write refusals are covered in
`packages/postgres/src/isolation.test.ts`, driven from the ownership
classification in `packages/postgres/src/ownership.ts`.

## Verification

`pnpm test` (the required gate) covers: the four release 0.1.0 frame contracts
and their transitions passing lint with monetary-only obligation principal; lint
rejecting an outcome status predicate and every cardinality outside FUNCTIONAL,
SET and EVENT; the loader refusing a tag or checkout whose content hash differs
from the recorded hash; the CLI report artifact for each designed lint failure;
the snapshot route and reader; the screen states; and the context-space
invariant. `pnpm validate:registry` and `pnpm build` also pass.

Not verified here: that a production deployment sets
`UNAI_REGISTRY_LINT_REPORT_FILE`; with no report configured the screen states
that lint runs in the CLI and CI, which is the accurate deployment fact.
