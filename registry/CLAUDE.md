# registry

This folder is the Git source of truth for the semantic registry: `releases.yaml` pins each recorded version to its tag and content hash, and `releases/<version>/` holds that version's frame and transition contracts as YAML. Apart from this file it holds only YAML: no code, no other documentation and no generated output -- except `evidence/<version>/`, which holds the JSON migration evidence (shadow report, projection replay report) a governed release's `releases/<version>/migration.yaml` names. An identity-, transition-affecting or breaking release is refused by `pnpm validate:registry` without that manifest and evidence (ADR 0031 §5, `docs/registry.md`). The reader, linter and publisher live in `packages/registry`, the procedure in `docs/registry.md`, and the decisions in ADR 0011.

## What is frozen

Release 0.1.0 is recorded with hash `6fec376b…` and its registry review is closed (ADR 0011). Never edit, rename, add or delete anything under `releases/0.1.0/`, and never change its entry in `releases.yaml`. Every byte of every file in the directory feeds the hash, comments and trailing newlines included, so a cosmetic edit fails `pnpm validate:registry`, CI and `packages/registry/src/release.test.ts` with `REGISTRY_CONTENT_HASH_MISMATCH`. Re-recording the hash to make an edit pass is exactly what the immutability rule forbids; a correction is a new release. The 0.1.0 files are also the fixtures that `packages/registry/src/lint.test.ts` mutates in memory, addressed by predicate position.

The root `.gitattributes` marks `registry/releases/**` and `registry/releases.yaml` as `-text`, so Git never converts line endings and a Windows checkout hashes like the Git objects. Write release files with LF endings and check that your editor does not rewrite them; do not remove or narrow those attribute lines.

## Layout rules the loader enforces

- Every entry in `releases/`, file or directory, must be named after a version recorded in `releases.yaml`; anything else fails lint with `REGISTRY_RELEASE_NOT_RECORDED`. This file sits in `registry/` for that reason, and nothing like a README may go deeper.
- A release directory is flat and contains only regular files of at most 1 MiB named `^[a-z0-9][a-z0-9_.-]*\.yaml$`, committed with mode `100644`. Subdirectories, symlinks and executable files are refused with `REGISTRY_FILE_INVALID`.
- It contains `manifest.yaml` plus exactly the files the manifest lists, with unique ids and unique file names, and each file's `id` and `kind` must equal its manifest entry. Manifest file names must start with a letter. By convention frames are `<id>.yaml` and transitions `transition.<id>.yaml`.
- YAML is parsed strictly: valid UTF-8, unique keys, no aliases (`*name`), no parser warnings, and no key outside the schema in `packages/registry/src/schema.ts`. Every field is a required key, so an empty list is written as `[]`.
- In `releases.yaml` versions are unique and `tag` is always `registry-v<version>`.

## Adding a release

1. A release is a complete set, not a delta. Copy the previous directory to `releases/<new version>/` and set `version:` in the manifest and in every contract to the new version. All four required frames (`shared.obligation`, `shared.commitment`, `shared.event_occurrence`, `finance.payment_allocation`) must be present, and `shared.obligation` must keep a required FUNCTIONAL ACTUAL `principal_amount` of type MONEY.
2. Make the contract changes. The last segment of a predicate id is split on `_`, and none of its words may be an outcome or status token such as `status`, `state`, `paid`, `open` or `closed` (full list: `OUTCOME_STATUS_TOKENS` in `packages/registry/src/lint.ts`); outcomes are expressed only through RESOLVES transitions. Semantic decisions go into an ADR before the files, and identity-affecting, transition-affecting or breaking changes also need the migration evidence that `docs/registry.md` names.
3. Compute the hash. `lint` does not reveal it: with a wrong recorded hash it only reports `REGISTRY_CONTENT_HASH_MISMATCH`, and on success it echoes the recorded value. Run this from the repository root and substitute the version:

```
pnpm exec tsx -e "import {readdirSync,readFileSync} from 'node:fs'; import {releaseContentHash} from './packages/registry/src/release.ts'; const d='registry/releases/0.2.0'; console.log(releaseContentHash(readdirSync(d).map(path=>({path,bytes:readFileSync(d+'/'+path)}))))"
```

4. Append `version`, `tag` and `contentHash` to `releases.yaml`, then run `pnpm validate:registry`. Any later byte change to the directory means repeating step 3, which is allowed only until the release tag exists.
5. Update the test that pins the release list: `packages/registry/src/cli.test.ts` expects lint to print exactly one release with 8 contracts. `cli.test.ts` and `release.test.ts` also use `0.2.0` as their example of an unrecorded version, so recording 0.2.0 means changing those cases to another version. Update the layout section of `docs/registry.md`.
6. Tagging is the operator's step after merge: `registry-v<version>` on the landing commit. Do not create, move or delete `registry-v*` tags yourself.

## Traps

- This checkout had no `registry-v*` tag when this file was written (`git tag -l "registry-v*"` to check). `pnpm uai registry publish` and `loadRegistryRelease` read Git objects at the tag, so they refuse with `REGISTRY_TAG_MISSING` until the operator tags, and uncommitted release files are invisible to them. Only `lint` reads the working tree.
- `releases.yaml` is always read from the working tree, never from the tag. It is the deployer's pin, so editing a recorded hash there makes the tagged release unloadable instead of accepting new bytes.
- `packages/registry/src/snapshot.test.ts` and `release.test.ts` copy this whole folder into a temporary Git repository, and the snapshot test fixes the commit identity and dates so its fixture commit is reproducible. Any file added or changed anywhere under `registry/`, this one included, changes that commit. This is harmless on the disposable database that `pnpm test` normally creates, but on a reused database that already holds a published 0.1.0 row (a hand-exported `UNAI_TEST_DATABASE_URL`, or the harness fallback when `CREATE DATABASE` is refused) the test fails with `REGISTRY_RELEASE_CONFLICT`.
- The published database snapshot is as immutable as the files: `registry_releases` and `registry_contracts` refuse UPDATE, DELETE and TRUNCATE with `REGISTRY_SNAPSHOT_IMMUTABLE`, so a bad release that was already published cannot be withdrawn, only superseded by a new version.
