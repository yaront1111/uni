# Semantic registry: Git release, lint and snapshot

Authority: ADR 0011; contract-uai-v0/rev-uai-v0-001 CRT-OUT-01-A, CRT-REG-01-A,
CRT-REG-01-B, CRT-REG-03-A, CRT-REG-07-A; design
goal-aa27afc9-5409-408d-961d-b9c20954d16c@v1, screen "CLI/CI: registry and
projection replay" (loader, lint and release portion), entities
registry_releases and registry_contracts.

Extended for goal-b2cc3b54-1876-401e-a6a2-527f99b679bc@v1 (screen "Registry
release and migration", route `GET /v1/ops/registry-snapshot`) by ADR 0014; see
`docs/registry-snapshot-and-contexts.md`.

Registry logic — loading, hashing, linting, publishing — runs only in the
`@unai/registry` library and its CLI. The deployment holds one registry-shaped
path: the read-only snapshot view at `GET /v1/ops/registry-snapshot`, rendered
at `/ops/registry`. It serves rows the CLI already materialized, accepts no
mutation and imports no registry code, so no network-reachable registry service
endpoint exists (CRT-REG-01-B). There is no editing UI.

## Layout

```
registry/releases.yaml                 recorded version -> tag -> content hash
registry/releases/0.1.0/manifest.yaml  contract id, kind and file list
registry/releases/0.1.0/*.yaml         frame and transition contracts
```

Release 0.1.0 contains frames `shared.obligation` (monetary only),
`shared.commitment`, `shared.event_occurrence` and `finance.payment_allocation`,
and the transitions `shared.obligation.resolution`,
`shared.commitment.resolution`, `shared.event_occurrence.resolution` and
`shared.event_occurrence.realization`. No contract defines an outcome status
predicate. Outcomes are resolution assertions under these transitions.

## Commands

```
pnpm uai registry lint [--version 0.1.0] [--report <path>]
pnpm uai registry test [--report <path>]
pnpm uai registry shadow-diff --baseline <v> --candidate <v> [--sample corpus:synthetic|corpus:private|owner]
    [--owner-scope <uuid> --actor <uuid> --limit <n> --as-of <iso>] [--run-kind registry|extractor
    --baseline-extractor <model@prompt> --candidate-extractor <model@prompt>] [--report <path>]
pnpm uai registry projection-replay --owner-scope <uuid> --actor <uuid> [--registry-version <v>] [--report <path>]
pnpm uai registry publish --version 0.1.0 [--correlation-id <uuid>]
pnpm validate:registry        # same as registry lint; runs in CI
```

All four PRD §35.14 commands run in CI: `lint`, `test` and a corpus-sample
`shadow-diff` as workflow steps, and the database-backed `shadow-diff` over an
owner sample and `projection-replay` as real CLI processes over TLS inside
`pnpm test` (`packages/registry/src/evaluation-db.test.ts`). `test` exercises
every frame contract through the ten areas of PRD §43.3; `shadow-diff` writes the
seven diffs of PRD §43.5 and, for an owner sample, records a
`shadow_evaluation_runs` row without changing a production table (ADR 0027 §4).
`--registry-version` pins a replay report to the release a migration manifest
names.

`--report <path>` writes the same bounded result as JSON (result, checked-at,
refusal code, linted releases, issue codes with contract file and field path)
for both a pass and a failure. CI keeps it as the `registry-lint-report`
artifact, and a deployment that sets `UNAI_REGISTRY_LINT_REPORT_FILE` to such a
file shows it on `/ops/registry`. Nothing in the deployment lints.

`lint` checks every recorded release in the checkout: recorded content hash,
manifest completeness, every §17.3 frame field and §17.4 predicate field,
closed sets (cardinality FUNCTIONAL/SET/EVENT, context kinds, modalities,
outcome codes, value types), references, outcome status predicates and the
monetary obligation rule. It also refuses release directories that are not
recorded. Success prints one JSON line with version, tag, content hash and
contract count. Failure exits 1 with a stable code and issue codes/paths, never
contract text.

`publish` loads the release from the Git tag `registry-v<version>` (Git objects,
not the working tree), verifies the recorded hash and inserts the immutable
database snapshot atomically. It requires `UNAI_MIGRATION_DATABASE_URL` and
`UNAI_DATABASE_CA_PATH` (the trusted migration principal over verified TLS; see
docs/foundation.md). Re-running for the same tag and commit reports
`ALREADY_PUBLISHED`; a different hash or commit for a published version is
refused with `REGISTRY_RELEASE_CONFLICT`. Output includes the UUIDv7 release ID,
commit, content hash and correlation ID.

## Release procedure

1. Add `registry/releases/<version>/` and its manifest in a pull request.
   `lint` computes the change class against the previous release (ADR 0027 §5).
   An identity-, transition-affecting or breaking release must also carry
   `migration.yaml` in its directory (kind, from, to, changeClass, description,
   shadowDiff, projectionReplay, rollbackPlan, pinnedTests), with the named
   evidence under `registry/evidence/<version>/`: the report of
   `shadow-diff --baseline <from> --candidate <version> --report ...` and the
   report of `projection-replay --registry-version <version> --report ...`.
   CI refuses the release otherwise (CRT-REG-05-A).
2. Record the version, tag and content hash in `registry/releases.yaml`. The
   hash is SHA-256 over sorted `<file>\n<sha256(file)>\n` lines;
   `releaseContentHash` computes it and `lint` prints it.
3. Obtain registry review and record its decisions in the ADR. Release 0.1.0
   review is recorded: `shared.obligation.description` is SET (ADR 0011).
4. After merge, tag the landing commit: `git tag registry-v<version>` and
   push the tag. Never move or delete a release tag; a moved tag with changed
   content is refused by the hash check.
5. Run migrations (`pnpm db:migrate`), then `pnpm uai registry publish`.

`.gitattributes` keeps release files byte-exact (`-text`), so Windows checkouts
hash identically to Git objects.

## Refusal codes

`REGISTRY_VERSION_INVALID`, `REGISTRY_RELEASE_NOT_RECORDED`, `REGISTRY_INDEX_INVALID`,
`REGISTRY_TAG_MISSING`, `REGISTRY_RELEASE_MISSING`, `REGISTRY_FILE_INVALID`,
`REGISTRY_CONTENT_HASH_MISMATCH`, `REGISTRY_MANIFEST_INVALID`, `REGISTRY_LINT_FAILED`
(issues: `REGISTRY_FIELD_REQUIRED`, `REGISTRY_FIELD_UNKNOWN`, `REGISTRY_FIELD_INVALID`,
`REGISTRY_CARDINALITY_INVALID`, `OUTCOME_STATUS_PREDICATE_FORBIDDEN`,
`OBLIGATION_PRINCIPAL_NOT_MONETARY`, `REGISTRY_ID_DUPLICATE`, `REGISTRY_VERSION_MISMATCH`,
`REGISTRY_PREDICATE_FRAME_MISMATCH`, `REGISTRY_MODALITY_NOT_ALLOWED`,
`REGISTRY_PREDICATE_UNKNOWN`, `REGISTRY_TRANSITION_UNKNOWN`,
`REGISTRY_TRANSITION_FRAME_MISMATCH`, `REGISTRY_FRAME_UNKNOWN`,
`REGISTRY_TRANSITION_OUTCOMES_INVALID`, `REGISTRY_TRANSITION_TARGET_INVALID`,
`REGISTRY_REQUIRED_CONTRACT_MISSING`, `REGISTRY_MANIFEST_MISMATCH`, `REGISTRY_YAML_INVALID`),
`REGISTRY_MIGRATION_EVIDENCE_REQUIRED` (issues: `REGISTRY_MIGRATION_MANIFEST_REQUIRED`,
`REGISTRY_MIGRATION_MANIFEST_INVALID`, `REGISTRY_MIGRATION_CLASS_UNDERSTATED`,
`REGISTRY_MIGRATION_SHADOW_DIFF_REQUIRED`, `REGISTRY_MIGRATION_SHADOW_DIFF_INVALID`,
`REGISTRY_MIGRATION_PROJECTION_REPLAY_REQUIRED`, `REGISTRY_MIGRATION_PROJECTION_REPLAY_INVALID`,
`REGISTRY_MIGRATION_ROLLBACK_PLAN_REQUIRED`), `REGISTRY_MIGRATION_BASE_NOT_PUBLISHED`,
`REGISTRY_CONTRACT_TEST_FAILED`, `SHADOW_SAMPLE_INVALID`, `SHADOW_RUN_KIND_INVALID`,
`SHADOW_LIMIT_INVALID`, `SHADOW_OWNER_SAMPLE_CONFIGURATION_REQUIRED`, `SHADOW_EXTRACTOR_VERSIONS_REQUIRED`,
`SHADOW_EXTRACTOR_NEEDS_OWNER_SAMPLE`, `SHADOW_AS_OF_INVALID`, `SHADOW_PRODUCTION_CHANGED`,
`PROJECTION_REPLAY_CONFIGURATION_REQUIRED`, `PROJECTION_REPLAY_AS_OF_INVALID`, `PROJECTION_REPLAY_DIVERGED`,
`REGISTRY_KIND_INVALID`, `REGISTRY_LOAD_FAILED`, `REGISTRY_COMMAND_FAILED`,
`REGISTRY_TAG_SOURCE_REQUIRED`, `REGISTRY_CORRELATION_ID_INVALID`,
`REGISTRY_RELEASE_CONFLICT`, `REGISTRY_PUBLISH_FAILED`,
`REGISTRY_PUBLISH_CONFIGURATION_REQUIRED`, `REGISTRY_COMMAND_UNKNOWN`.
`validatePredicateValue` refuses with `REGISTRY_PREDICATE_UNKNOWN` or
`REGISTRY_VALUE_INVALID` (for example any non-monetary obligation principal).

## Security and observability

The snapshot tables are global deployment reference data: forced RLS, no
policy and no privileges for `unai_app`; update, delete and truncate are refused
by triggers. The ownership coverage check fails if the application role gains
access. Publication audit is the immutable release row (tag, commit, hash,
`published_by` database principal, `correlation_id`, `released_at`), because
shared `audit_events` requires an owner scope and user actor (ADR 0011).
Load, lint and publish emit `unai.registry` OpenTelemetry spans and the
`unai.registry.operations` counter with version, hash, commit, correlation ID
and result codes only. The loader runs Git without a shell, with replacement
objects disabled, and refuses symlinks, submodules, nested paths and files over
1 MiB.
