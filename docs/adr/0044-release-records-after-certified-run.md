# ADR 0044: Release records committed after the run they certify

Date: 2026-11-02

Status: Accepted. Interprets release criterion CRT-QA-01-A (ADR 0033); no PRD
requirement waived. Recorded before the release-checker change it governs (PRD
§0 rule 7).

## Context

- ADR 0033 makes main-branch CI evidence a release blocker, and
  `packages/domain/src/operations.ts` implemented CRT-QA-01-A as
  `ci.commit === HEAD` plus a clean workspace.
- The `ci` block is stored in the tracked file
  `docs/operations/release-input.json`. Committing that record creates a HEAD
  that the certified hosted run never saw, so the criterion fails at every
  commit that carries its own evidence. Gate 4 of
  [real-data-gates.md](../operations/real-data-gates.md) recorded this as a
  known limitation before this ADR.
- The live-connector record (`unai-live-connectors/1`, Gate 2) has the same
  problem: its `sourceCommit` names the commit the owner tested, and committing
  the record moves HEAD past it.
- REQ-QA-01 (`docs/operations/adr-inventory.json`) names only the stages CI
  runs. Exact commit equality was ADR 0033's implementation choice, so this
  record is an interpretation of the criterion, not a PRD deviation.

## Decision

1. A recorded commit (`ci.commit`, or a live-connector record's `sourceCommit`)
   is accepted when:
   - it is HEAD; or
   - `git merge-base --is-ancestor <commit> HEAD` succeeds **and**
     `git diff --name-only --no-renames <commit> HEAD` lists only
     release-record paths:
     - `docs/operations/release-input.json`
     - `docs/operations/real-data-gates.md`
     - `docs/operations/live-connectors-<name>.json`, where `<name>` is 1-100
       characters from `A-Z a-z 0-9 . _ -`
     - `corpus/expected/real-corpus-results.json`

   It is not accepted for any other changed path, a commit that is not an
   ancestor of HEAD, a commit absent from the clone, a value that is not 40
   lowercase hex characters, or a Git failure.
2. Rename detection is off, so a file moved into a record path still lists its
   old path and fails the rule.
3. Everything else in CRT-QA-01-A is unchanged: a clean workspace, the default
   branch, and all nine stages present exactly once with `PASS`.
4. `evaluateV0Release` stays pure. `src/operations/report.ts` records each
   recorded commit's relation to HEAD (`HEAD`, `RECORDS_ONLY_ANCESTOR`,
   `OTHER_PATHS_CHANGED`, `NOT_ANCESTOR` or `UNVERIFIED`) in the report. A
   criterion accepts a commit when it equals the report's `sourceCommit`, or
   when `RECORDS_ONLY_ANCESTOR` is recorded for that exact commit.
5. Three criteria join the release gate. Each is named after the PRD §54 item
   its gate closes (owner's choice, 2026-11-02):
   - `PRD-54.4-REAL-CORPUS`: `verifyRealCorpusResults` answers `PASS`.
   - `PRD-54.1-LIVE-CONNECTORS`: the newest record listed in
     `liveConnectorRecords` parses as `unai-live-connectors/1`, every required
     case passed, and its `sourceCommit` is accepted by rule 1.
   - `PRD-54.3-REGISTRY-TAGS`: every recorded registry version's
     `registry-v<version>` tag is `PRESENT`.

   Missing, unreadable, invalid, failed, skipped, pending or stale evidence
   fails its criterion; nothing defaults to a pass.

**Why this is safe.** No CI stage's outcome depends on a record path. On
2026-11-02, a search of `src`, `packages`, `apps/web` and `scripts` code and the
workflows for these paths found only:

- the release checker (`src/operations/report.ts` and its helpers in
  `src/operations/evidence.ts`);
- the real-corpus verifier and recorder in the registry package, which no CI
  stage runs;
- a comment in `packages/domain/src/evaluation.ts`;
- tests (the registry's evaluation test and `src/operations/evidence.test.ts`)
  that write record files into temporary repositories only, and the pure
  domain test, which names a record path as a string and reads no file.

The report-only steps (`pnpm ops:report` and `pnpm uai corpus status`) decide no
stage. The test harness hashes every tracked file, records included, into its
provenance digest (`scripts/workspace-evidence.mjs`). That digest records the
source state and decides no stage. A change confined to record paths therefore
cannot change what the certified run tested.

## Consequences

- Any change to a non-record path after a certified run fails CRT-QA-01-A until
  a new hosted run certifies the new commit. For the live record, any such
  change needs a new live run.
- The record paths must stay unread by every CI stage. A stage that starts
  reading one of them invalidates this rule and needs a successor ADR.
- No `deviations` entry is added to `release-input.json`: this is an
  interpretation, not a deviation, and a same-day entry would also fail
  CRT-OPS-02-A's date-precedence rule.
