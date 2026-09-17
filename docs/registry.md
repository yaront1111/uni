# Semantic registry: Git release, lint and snapshot

Authority: ADR 0011; contract-uai-v0/rev-uai-v0-001 CRT-OUT-01-A, CRT-REG-01-A,
CRT-REG-01-B, CRT-REG-03-A, CRT-REG-07-A; design
goal-aa27afc9-5409-408d-961d-b9c20954d16c@v1, screen "CLI/CI: registry and
projection replay" (loader, lint and release portion), entities
registry_releases and registry_contracts.

There is no registry HTTP endpoint, web route or editing UI. Contracts are Git
files; the only interfaces are the `@unai/registry` library and the CLI.

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
pnpm uai registry lint [--version 0.1.0]
pnpm uai registry publish --version 0.1.0 [--correlation-id <uuid>]
pnpm validate:registry        # same as registry lint; runs in CI
```

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
   Identity-, transition-affecting and breaking changes also need the migration
   evidence owned by the registry replay tooling (CRT-REG-05-A).
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
