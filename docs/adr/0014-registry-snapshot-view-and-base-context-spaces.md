# ADR 0014: Read-only registry snapshot view, lint report artifact and BASE context spaces

Date: 2026-09-18
Status: Accepted. Implementation choices recorded before code.

Authority: goal-b2cc3b54-1876-401e-a6a2-527f99b679bc design v1 — API surface
`GET /v1/ops/registry-snapshot`, screen "Registry release and migration"
(loaded-release and lint-failure states), entities `registry_releases`,
`registry_contracts` and `context_spaces`; contract-uai-v0/rev-uai-v0-001
CRT-OUT-01-A, CRT-REG-01-A, CRT-REG-01-B, CRT-REG-03-A, CRT-REG-07-A;
PRD §11.6, §17.2, §33.3, §35.14, §36.6. Extends ADR 0011, which left the
runtime reader for the release that needs it.

## The read-only snapshot view is not a registry service (CRT-REG-01-B)

The design draws one registry-shaped route: a read-only view of the snapshot
that migration 0006 already materializes, "serving no registry logic, accepting
no registry mutation". Everything that *is* registry logic — loading a release,
hashing it, linting it, publishing it — stays in the CLI and the `@unai/registry`
library, which no deployed package imports.

Decision: `GET /v1/ops/registry-snapshot` returns the loaded release (semantic
version, Git tag, content hash, Git commit, released-at) and its contract list
(contract id, kind, version, per-contract hash). It returns no contract body:
contract text lives in Git, and the view exists to prove which immutable release
the runtime is pinned to. There is no POST, PATCH or DELETE under that path, no
lint or publish route, and no web proxy write mapping. `registry-boundary.test.ts`
now asserts exactly that shape — the single GET path, no mutation verb, no
`@unai/registry` import anywhere in `packages/api`, `packages/auth`,
`packages/domain`, `packages/storage` or `apps/web` — instead of forbidding the
substring "registry" outright, which would forbid the view the design draws.

## The snapshot reader is a definer function, not a table grant

ADR 0011 left `registry_releases` and `registry_contracts` forced-RLS with no
policy and no `unai_app` privilege "until a reviewed runtime reader needs them".
That reader is now needed, and granting `unai_app` SELECT on the tables would
widen the application role for every future purpose and weaken the ownership
coverage check.

Decision: a single `SECURITY DEFINER`, `STABLE`, fixed-`search_path` function
`unai_private.registry_snapshot()` returns the view as JSON, and `unai_app`
receives `EXECUTE` on it alone. The function refuses unless the transaction
carries an owner context and the purpose `ops.registry.read`, so an authenticated
session under any other purpose reads nothing. Table privileges stay revoked,
the tables keep forced RLS with no policy, and the update/delete/truncate
triggers are untouched: the snapshot is still immutable and still invisible to a
direct application query. `assertOwnershipCoverage` and the isolation suite keep
asserting the table-level refusal unchanged.

The view reads the highest semantic version with lifecycle `RELEASED`, ordered
by numeric version components, so ordering never depends on text collation or on
wall-clock publication order.

## Lint failure is a CLI and CI state, displayed from a recorded report

Serving lint over HTTP would make the deployment a registry service, so the
screen's lint-failure states cannot be produced by a request. `uai registry lint`
already exits non-zero with stable issue codes and paths; it now also accepts
`--report <path>` and writes that same bounded JSON (version, result, issue code,
contract file and field path, checked-at) for CI to keep as an artifact.

Decision: the operations screen renders a lint report it is *given*, never one it
computes. `apps/web/pages/ops/registry.tsx` reads the report file named by
`UNAI_REGISTRY_LINT_REPORT_FILE` when the deployment configures one, validates it
against a domain schema, and renders the lint-failure state; with no configured
report the screen shows only the loaded release. The web process runs no registry
code, reads no release file and reaches no registry endpoint.

## Exactly one active BASE context space per owner scope

`context_spaces` (PRD §11.6, §17.2) holds the context a frame instance or belief
slot is asserted in. BASE is the default context; QUOTED exists only by a registry
rule and release 0.1.0 defines none; TEST is for evaluation.

Decision: the invariant is enforced by the database, not by application code.
A partial unique index over `(owner_scope_id)` where `context_kind='BASE' AND
lifecycle='ACTIVE'` makes a second active BASE impossible; a trigger on
`owner_scopes` creates the BASE row with the scope, so a scope can never exist
without one; a trigger refuses retiring or re-kinding a BASE row, so the row
cannot be removed. Together these give *exactly* one, not merely at most one.
BASE rows carry no parent; QUOTED and TEST rows must name a parent in the same
owner scope through a composite foreign key.

`unai_app` receives SELECT only, under the ordinary owner policy. No product path
creates a QUOTED or TEST context yet, and a write grant with no writer would be
privilege without a purpose; the node that first needs one adds the policy with
its purpose. Cross-owner isolation is covered by an unfiltered fixture in
`isolation.test.ts`, driven from the ownership classification.

## Consequences

- The runtime can name its pinned release without Git access, and the operator
  sees the Git tag and content hash the deployment is actually running.
- Lint output stays a build-time artifact; no deployment can be talked into
  linting or publishing.
- A later capability that writes QUOTED contexts needs a new policy and purpose,
  which is a reviewed change rather than an existing grant.
