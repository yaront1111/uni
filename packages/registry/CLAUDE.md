# packages/registry

`@unai/registry` owns reading, linting, hashing and publishing the Git-file semantic registry under `registry/`. It must not become a network service, must not be imported by a deployed server or web package, and must never write to `registry/` or fall back to the working tree at runtime. Authority is ADR 0011; procedure and the refusal-code list are in `docs/registry.md`.

## Surface and consumers

Nothing imports this package today. The only consumers are the root scripts `pnpm uai` and `pnpm validate:registry`, which run `src/cli.ts` with `tsx`. `packages/api/src/registry-boundary.test.ts` keeps it that way: it fails when any `.ts`, `.tsx` or `.json` file (other than `*.test.ts`) in `packages/api`, `auth`, `domain`, `storage` or `apps/web` mentions `@unai/registry`, `packages/registry` or `registry/releases`, when any path there contains "registr", or when a production route matches `/registr|contract|release/i`. It does not scan `packages/jobs`, `postgres` or `secrets`, so an import from there would pass unnoticed. A runtime reader therefore needs an ADR and a change to that test first. ADR 0014 proposes one (a read-only snapshot view served from a SQL definer function, still without importing this package), but when this was written the test and `src/cli.ts` were unchanged, so check the code before relying on either description.

There are two loaders with one shared verifier (`assemble` in `src/release.ts`). `loadRegistryRelease` is the runtime loader: it resolves `refs/tags/registry-v<version>` and reads blobs from Git objects, so working-tree edits are invisible to it. `lintRegistryCheckout` and `lintRegistryRepository` read the working tree, return `source: 'CHECKOUT'` with `gitCommit: null`, and exist only for CI. In both cases `registry/releases.yaml` is read from the working tree; it is the deployer's pin, which is why a re-tagged commit with different bytes is refused.

## Invariants a change must keep

- `assemble` checks in a fixed order: file names and size, then `releaseContentHash` against the recorded hash, then the manifest, then lint. A byte change therefore always reports `REGISTRY_CONTENT_HASH_MISMATCH` and never reaches lint. A test that wants lint issues from a modified file must re-record the hash (see `rerecord` in `src/cli.test.ts`) or call `lintContractDocuments` directly.
- `releaseContentHash` is SHA-256 over sorted `<file name>\n<sha256(bytes)>\n` lines of every file in the release directory, the manifest included. Changing the formula invalidates every recorded hash, so it is frozen.
- `lintRegistryRepository` lints every recorded release with the current schema and rules. Recorded releases cannot be edited, so every schema or lint change must still pass release 0.1.0 unchanged. All schemas are `z.strictObject` with every key required; a new required field or a new token in `OUTCOME_STATUS_TOKENS` that 0.1.0 violates breaks `pnpm validate:registry` with no legal fix. `src/lint.test.ts` also pins `FRAME_CONTRACT_FIELDS` and `PREDICATE_CONTRACT_FIELDS` to the PRD §17.3 and §17.4 lists.
- Every release must contain all `REQUIRED_FRAME_CONTRACTS`, and every contract `version` must equal the release version, so a release is a complete set and never a delta.
- `LintIssue` carries a code, the contract file name (the contract id for `REGISTRY_REQUIRED_CONTRACT_MISSING`) and a dotted field path, never contract text. CLI output, spans and the `unai.registry.operations` counter follow the same allowlist; `src/lint.test.ts` and `src/cli.test.ts` assert that content is not echoed. Errors that are not a `RegistryError` are replaced by a fixed code (`REGISTRY_LOAD_FAILED`, `REGISTRY_PUBLISH_FAILED`, `REGISTRY_COMMAND_FAILED`) because database and parser messages can echo contract content.
- The Git loader runs `git` without a shell and with `GIT_NO_REPLACE_OBJECTS=1`, validates the version against `RELEASE_VERSION` before it reaches Git, and accepts only mode `100644` blobs directly inside the release directory. YAML parsing is strict: fatal UTF-8 decoding, unique keys, no aliases, and any parser warning is an error.
- `publishRegistryRelease` accepts only a `GIT_TAG` release with a commit, serializes on an advisory lock, verifies the `COMMIT` command tag, and answers `ALREADY_PUBLISHED` only when tag, commit and hash all match the stored row. Its pool must be the migration principal, because `unai_app` has no privilege on `registry_releases` or `registry_contracts` (migration `0006_registry_snapshot.sql`; `assertOwnershipCoverage` fails if that ever changes).
- Snapshot rows hash `canonicalJson` of the parsed Zod output, not the file bytes. A frame row stores predicate ids only and each predicate has its own `PREDICATE` row. A new contract kind needs a new migration, because `contract_kind` is a SQL `CHECK`. The same migration repeats the `RELEASE_VERSION` and contract id patterns of `src/schema.ts` as `CHECK`s, so loosening either in TypeScript alone makes publish fail with `REGISTRY_PUBLISH_FAILED`.
- `validatePredicateValue` in `src/values.ts` is the only value-level check. MONEY is a strict `{amount, currency}` object whose amount stays an exact positive decimal string (at most 18 integer and 6 fraction digits), never a number, and the library does no arithmetic (ADR 0011). `valueSchemas` is typed as a record over `VALUE_TYPES`, so a new value type fails `pnpm typecheck` until it gets a schema there.

## Adding a lint rule

1. ADR 0011 enumerates the lint rules beyond the schema and the forbidden outcome tokens, so record the new rule there or in a new ADR before the code.
2. Add the check to `lintContractDocuments` in `src/lint.ts` and push an issue with a new UPPER_SNAKE code and a field path.
3. Add a `mutate(...)` case to `src/lint.test.ts`. The fixtures are deep copies of the genuine 0.1.0 files, never a synthetic release, and the first test there must still report no issues.
4. Add the code to the refusal list in `docs/registry.md`. That list currently omits `REGISTRY_KIND_INVALID`, `REGISTRY_LOAD_FAILED` and `REGISTRY_COMMAND_FAILED`.

## Tests

Run from the repository root, because the tests resolve `registry/`, `migrations/` and `packages/registry/src/cli.ts` against the working directory, and they need `git` on `PATH`:

```
pnpm exec vitest run packages/registry/src/lint.test.ts packages/registry/src/release.test.ts packages/registry/src/cli.test.ts
```

These three need no database. `release.test.ts` builds real tagged repositories in the temp directory, and `cli.test.ts` spawns the CLI through `tsx` for each case. Do not pass the bare `packages/registry` path, not even with a `-t` filter, because it also collects `src/snapshot.test.ts`, which throws at import without `UNAI_TEST_DATABASE_URL` and fails the run. That test connects as the privileged principal and commits its fixture repository with a fixed identity and fixed author and committer dates so the tag resolves to the same commit on every run.

## Traps

- The CLI treats `process.cwd()` as the repository. `lint --version X` still lints every recorded release and only filters the printed list. Success is one JSON line on stdout; failure is one JSON line on stderr with exit code 1.
- ADR 0011 writes `uai registry publish --tag`; the implemented flag is `--version`.
- `src/snapshot.ts` imports `uuidV7` from the root lane by relative path (`../../../src/kernel/identities.js`), so moving either file breaks publishing.
- `src/cli.test.ts` asserts that lint prints exactly one release with 8 contracts, so recording a second release requires updating that expectation.
- The snapshot test's TRUNCATE must list `registry_releases` first, because parallel suites publish releases then contracts; the reverse order deadlocks (40P01). Every reader keeps the same order too: migration 0022 re-declares `unai_private.registry_contract_present` to open `registry_releases` before `registry_contracts`, because a reader that opened contracts first was chosen as the deadlock victim beside that TRUNCATE and failed an unrelated suite with a 500 or 503. A new reader of the snapshot must name `registry_releases` first.
