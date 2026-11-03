# Real-data gates (owner-run)

Four checks stand between this repository and PRD §54 (Definition of V0 done)
that only the owner can execute, because they need the owner's own mail,
accounts, credentials or repository rights: gate 1, the real corpus (item 4);
gate 2, live connectors (item 1); gate 3, registry tags (item 3, plus item 16's
registry-migration procedure); and gate 4, hosted CI (release criterion
CRT-QA-01-A, the `hosted-main-pipeline-deferred` deferral listed in
[README.md](README.md)). Agents prepare these steps and never execute them: no
agent selects, labels or sanitizes real threads, supplies live credentials,
pushes tags or certifies hosted CI. Each gate section below has the same six
labelled lines. After running a gate, update its Status row (UTC date, result,
artifact) and commit the artifact together with the row.

`pnpm check:v0-release` reads each gate's record through one release criterion:
PRD-54.4-REAL-CORPUS (gate 1), PRD-54.1-LIVE-CONNECTORS (gate 2),
PRD-54.3-REGISTRY-TAGS (gate 3) and CRT-QA-01-A (gate 4). A missing, invalid,
failed, skipped or stale record fails its criterion. A record committed after
the run it certifies is accepted only through the records-only rule of
[ADR 0044](../adr/0044-release-records-after-certified-run.md): the recorded
commit must be HEAD, or an ancestor of HEAD whose later changes touch only
`docs/operations/release-input.json`, `docs/operations/real-data-gates.md`,
`docs/operations/live-connectors-<name>.json` and
`corpus/expected/real-corpus-results.json`. Run the gates in this order:

1. Finish every code change.
2. Run gates 1 and 3, which bind no commit, and gate 2, whose record binds its
   `sourceCommit`. Commit their records with their Status rows.
3. Push, and let the hosted run certify gate 4 at that commit.
4. Commit the `ci` block together with its Status row, and nothing else.
5. Run the release sequence from [README.md](README.md) at that commit.

## Status

| Gate | Closes | Date (UTC) | Result | Artifact |
| --- | --- | --- | --- | --- |
| 1. Real corpus | PRD §54 item 4 | — | UNVERIFIED | `corpus/expected/real-corpus-results.json` |
| 2. Live connectors | PRD §54 item 1 | — | UNVERIFIED | `docs/operations/live-connectors-<YYYY-MM-DD>.json` |
| 3. Registry tags | PRD §54 items 3 and 16 | — | UNVERIFIED | tags `registry-v0.1.0`, `registry-v0.2.0`, `registry-v0.3.0` on `origin` |
| 4. Hosted CI | CRT-QA-01-A; PRD §54 item 3 | — | UNVERIFIED | `ci` in `docs/operations/release-input.json` |

Result is UNVERIFIED (not run, or no artifact recorded), PASS or FAIL; a skipped
test, a deferral or a local-only run is never PASS, and nothing on this page is
waived.

## Gate 1: Real corpus

**Closes:** PRD §54 item 4, "Obligation and commitment contracts pass synthetic
and real-corpus tests". This gate is the real-corpus half; CI scores the
synthetic half. It also closes the real-thread half of CRT-QA-02-A and
CRT-QA-03-A (see "What this node does not claim" in
[evaluation-and-boundaries.md](../evaluation-and-boundaries.md)).

**Who runs it:** the owner, on the machine that holds the mailbox export.
No agent may select, generate, sanitize into or relabel the threads.
They come from the owner's own mailbox and are labelled by a person.

**Inputs:**

- At least 10 threads the owner selects (`minimumRealThreads` in
  `corpus/expected/identity-thresholds.json`, thresholds version
  `identity-thresholds-1`).
- Only labelled threads count. A thread counts once its annotation has entities
  and either frame instances or non-memory items (`isLabelled`,
  `packages/registry/src/corpus.ts`).
- Across the labelled threads, every category the CLI reports must be covered:
  `sourceSpans`, `entities`, `frameInstances`, `slots`, `propositions`,
  `commitments`, `resolutions`, `nonMemoryItems`.
- Export format: one JSON file per thread holding the Gmail API thread resource,
  that is the response body of
  `GET https://gmail.googleapis.com/gmail/v1/users/me/threads/<threadId>?format=full`.
  - Route with no code: the APIs Explorer panel on Google's reference pages. Use
    `users.threads.list` with a Gmail search in `q` to find the thread id, then
    `users.threads.get` with `format=full`. Sign in as the mailbox owner, allow
    only the read-only Gmail scope, and save the response body.
  - A Gmail "Download message" `.eml` file and a Takeout `.mbox` file are NOT
    accepted. Import parses JSON against `gmailThreadSchema`
    (`packages/domain/src/sources.ts`) and refuses anything else with
    `CORPUS_SOURCE_INVALID`.
- Precondition check: import one thread first. If a file saved straight from
  `users.threads.get` is refused with `CORPUS_SOURCE_INVALID`, the checkout
  predates Gmail API body decoding (its Gmail parser expects a decoded
  `payload.body.text` that the API never sends). Update to a commit that decodes
  API bodies before continuing.
- Storage: keep the exports and the private corpus on an encrypted volume
  (BitLocker, FileVault, LUKS), never in a synced folder, issue, chat or CI
  artifact. Optionally set `UNAI_PRIVATE_CORPUS_DIR` to a directory on that
  volume. A directory inside the repository must be gitignored, or import
  refuses it with `CORPUS_PRIVATE_PATH_NOT_IGNORED`.
- Never committed: anything under `corpus/private-local/` (or
  `UNAI_PRIVATE_CORPUS_DIR`), and the raw exports.
- The hook: `.githooks/pre-commit` refuses a commit that adds, copies, renames
  or modifies a file under `corpus/private-local/`, answering
  `PRIVATE_CORPUS_COMMIT_BLOCKED`. CI separately fails when any file there is
  tracked.
- `pnpm hooks:install` (also run by the install's `prepare` script) sets
  `core.hooksPath` to `.githooks`. When `core.hooksPath` already names another
  directory it changes nothing, and the owner must call `.githooks/pre-commit`
  from that hook.

**Commands, in order:**

1. `pnpm hooks:install`; then `git config --get core.hooksPath` prints
   `.githooks`.
2. Per thread: `pnpm uai corpus import --source <thread.json>`. It prints
   `threadRef` (content-free `gmail-<16 hex>`), `outcome` (`IMPORTED`, or
   `ALREADY_IMPORTED` for identical bytes) and `messages`. A changed export of an
   imported thread is refused with `CORPUS_THREAD_CHANGED`; `--update` replaces
   it, and is safe only before labelling.
3. Per thread: `pnpm uai corpus annotate --thread <threadRef>`. It writes the
   skeleton `annotations/<threadRef>.json` in the private corpus directory (one
   span per message body; a body longer than 4,000 characters is split at line
   ends into spans `m<n>.1`, `m<n>.2`, ... of at most 4,000 characters each) and
   prints `missing`. Label by editing that file, and re-run the command to see what
   is still missing. A thread with no message text is refused with
   `CORPUS_THREAD_EMPTY`, and one that would need more than 500 spans with
   `CORPUS_THREAD_TOO_LARGE`; nothing is written, so choose another thread.
4. `pnpm uai corpus annotate` with no `--thread` lists every thread with
   `labelled` and `missing`. Continue until at least 10 threads are labelled and,
   taken together, no category is missing.
5. `pnpm uai corpus run --corpus private --record` scores the production keying
   rules and writes `corpus/expected/real-corpus-results.json`. It writes the
   file even when the run fails (`CORPUS_THRESHOLDS_NOT_MET`). A threshold
   failure is a finding about the keying rules and is recorded as FAIL; labels
   are never changed to make it pass.
6. `pnpm uai corpus verify` prints PASS with the thread count, or
   `REAL_CORPUS_EVALUATION_REQUIRED` with failure codes.
7. Optional: `pnpm uai corpus status --report <path>` refreshes the Corpus and
   evaluation screen.
8. Commit `corpus/expected/real-corpus-results.json` together with the Status
   row. `git status --porcelain` must show nothing under
   `corpus/private-local/`.

**Artifact:** `corpus/expected/real-corpus-results.json` (format
`unai-corpus-results/1`). It holds counts and rates only: thread count,
annotation digest, thresholds version, registry release, per-rule observations
and rates, coverage, pipeline checks, result and failure codes. It contains no
quote, address or thread reference.

**How `pnpm check:v0-release` reads it:** criterion PRD-54.4-REAL-CORPUS calls
`verifyRealCorpusResults` (`packages/registry/src/corpus.ts`), the same check as
`pnpm uai corpus verify` (with which `pnpm check:phase-exit` also ends), and
passes only when it answers PASS. It fails unless the recorded file:

- exists and parses (`REAL_RESULTS_MISSING`, `REAL_RESULTS_INVALID`);
- is a real run (`REAL_RESULTS_NOT_REAL`);
- has at least `minimumRealThreads` threads (`REAL_THREADS_INSUFFICIENT`);
- uses the current thresholds version (`REAL_RESULTS_THRESHOLDS_STALE`);
- evaluated every production keying rule at its current version and within
  thresholds (`KEYING_RULE_NOT_EVALUATED`, `KEYING_RULE_VERSION_STALE`,
  `KEYING_RULE_THRESHOLD_FAILED`);
- covers every category (`CORPUS_CATEGORY_MISSING`);
- passed (`REAL_RESULTS_FAILED`).

When the verifier cannot run, the criterion records UNVERIFIED with the
verifier's refusal code (`CORPUS_THRESHOLDS_INVALID` when the thresholds file is
missing or invalid) or, for any other failure, `REAL_CORPUS_UNAVAILABLE`. Every
code appears under `realCorpus` in `test-results/operations/status.json`. A
thresholds or keying-rule version change makes the recorded file stale; repeat
steps 5-8.

## Gate 2: Live connectors

**Closes:** PRD §54 item 1, "All required connectors ingest real data
read-only". It covers the live half of CRT-CON-02-A (Gmail), CRT-CON-03-A
(Google Calendar), CRT-CON-04-A (GitHub) and ADR-0041-LIVE-A (the Omi
connector of ADR 0041), plus the opt-in CRT-CON-06-A (revocation at the
provider): the five cases in `packages/api/src/connectors.live.test.ts`.

**Who runs it:** the owner, with test accounts and credentials the repository
never holds.

**Inputs:**

- A secrets directory OUTSIDE the repository checkout, readable only by the
  owner: on Linux/macOS a 0700 directory with 0600 files; on Windows a folder
  under the user profile whose ACL grants only the owner. Never put it inside the
  checkout, where `git add` could pick it up.
- Handle mapping (mounted provider, `packages/secrets/src/index.ts`):
  - `secret://mounted/<name>` reads the file `<UNAI_SECRETS_MOUNT>/<name>`,
    whitespace-trimmed.
  - `secret://mounted/<name>#<field>` reads one string field of a JSON file.
  - The suite refuses a literal credential in a `UNAI_LIVE_*_SECRET` variable
    (`SECRET_HANDLE_REQUIRED:UNAI_LIVE_*_SECRET`).
- What each secret file holds:
  - Gmail and Calendar: what the Google clients send as `Bearer <value>`
    (`packages/connectors/src/providers.ts`). At this writing that is an OAuth
    access token, which Google expires after about an hour, so mint it right
    before the run. Once the clients exchange a refresh token before each sync,
    the file holds that refresh token instead. Mint Gmail with
    `https://www.googleapis.com/auth/gmail.readonly` only and Calendar with
    `https://www.googleapis.com/auth/calendar.readonly` only.
  - GitHub: a token limited to the one test repository, with read-only access to
    metadata, issues, pull requests and checks, and never one that can write.
  - Omi: an Omi developer key created at app.omi.me/developers with only the
    `conversations:read` scope. The key names its account, so no account variable
    is needed. The case makes one GET (one conversation-list page) against the
    key's hourly rate limit; on a 429, run again later, never record a pass.
    The account must have a completed, non-discarded conversation with transcript
    segments and a structured summary; otherwise the case fails as misconfigured.
    Uai cannot revoke the key; the owner revokes it in the Omi app (ADR 0041 D8).
  - The suite asserts that the connector requested only read-only scopes. It
    cannot see a token's grant, so a token with write access is the owner's own
    finding, not a pass.
- Environment variables:

  | Variable | Value |
  | --- | --- |
  | `UNAI_SECRETS_MOUNT` | absolute path of the secrets directory |
  | `UNAI_LIVE_GMAIL_ACCOUNT` | test mailbox address |
  | `UNAI_LIVE_GMAIL_SECRET` | `secret://mounted/<name>` |
  | `UNAI_LIVE_CALENDAR_ACCOUNT` | calendar id |
  | `UNAI_LIVE_CALENDAR_SECRET` | a handle |
  | `UNAI_LIVE_GITHUB_REPOSITORY` | `owner/name` |
  | `UNAI_LIVE_GITHUB_SECRET` | a handle |
  | `UNAI_LIVE_OMI_SECRET` | a handle |
  | `UNAI_LIVE_CONNECTOR_ALLOW_REVOCATION` | `true` only for the revocation case |

  A case runs only when `UNAI_SECRETS_MOUNT` and its secret handle are set,
  plus its account/repository variable where listed (Omi needs none);
  otherwise `pnpm test` reports it skipped.
- Revocation is destructive: with `UNAI_LIVE_CONNECTOR_ALLOW_REVOCATION=true`,
  CRT-CON-06-A revokes the Gmail token at Google and a new one must be minted.
  Leave it unset for the regular run.
- Precondition check (Gmail): if the Gmail case fails at its first sync with
  HTTP 500 while Calendar and GitHub pass, the checkout predates Gmail API body
  decoding (its parser rejects every real thread because it expects a decoded
  `payload.body.text`). That is a code finding, not an account problem.
- Never committed: the secrets directory, tokens, account addresses, calendar
  ids, repository names, mailbox content and Omi conversation content.

**Commands, in order:**

```bash
# 1. Must print nothing, so that only a run of committed code is recorded.
git status --porcelain

# 2. Export every variable from the table above.
export UNAI_SECRETS_MOUNT='<absolute path outside the checkout>'
export UNAI_LIVE_GMAIL_ACCOUNT='<test mailbox>'
export UNAI_LIVE_GMAIL_SECRET='secret://mounted/<name>'
export UNAI_LIVE_CALENDAR_ACCOUNT='<calendar id>'
export UNAI_LIVE_CALENDAR_SECRET='secret://mounted/<name>'
export UNAI_LIVE_GITHUB_REPOSITORY='<owner>/<name>'
export UNAI_LIVE_GITHUB_SECRET='secret://mounted/<name>'
export UNAI_LIVE_OMI_SECRET='secret://mounted/<name>'

# 3. Run the suite.
pnpm test

# 4. Read-only extraction of the run's provenance and the live cases.
node -e "const r=require('./test-results/acceptance/vitest.json'),p=require('./test-results/acceptance/vitest.json.provenance.json');console.log(JSON.stringify({sourceCommit:p.sourceCommit,workspaceDigest:p.workspaceDigest,completedAt:p.completedAt,exitCode:p.exitCode}));for(const f of r.testResults)if(f.name.includes('connectors.live.test'))for(const t of f.assertionResults)console.log(t.status,t.fullName)"
```

In PowerShell each variable is set with `$env:NAME = '<value>'`. `pnpm test`
(`scripts/test.mjs`) passes its whole environment to vitest, so the variables
reach the suite; the harness still provisions its own disposable database and
object store, so no production system is touched. Then write the record, add it
to `release-input.json`, update the Status row and commit them together.

**Artifact:** `docs/operations/live-connectors-<YYYY-MM-DD>.json` (UTC date of
the run), appended (newest last) to a new top-level key in
`docs/operations/release-input.json`:
`"liveConnectorRecords": ["docs/operations/live-connectors-<YYYY-MM-DD>.json"]`.

The record has the shape `unai-live-connectors/1`:

```json
{
  "format": "unai-live-connectors/1",
  "recordedAt": "<UTC ISO-8601>",
  "recordedBy": "owner",
  "command": "pnpm test",
  "sourceCommit": "<provenance sourceCommit, 40 hex>",
  "workspaceDigest": "<provenance workspaceDigest, 64 hex>",
  "completedAt": "<provenance completedAt>",
  "exitCode": 0,
  "workspaceClean": true,
  "revocationAllowed": false,
  "cases": [
    { "criterion": "CRT-CON-02-A", "connector": "GMAIL", "status": "passed", "testName": "<fullName as printed>" },
    { "criterion": "CRT-CON-03-A", "connector": "GOOGLE_CALENDAR", "status": "passed", "testName": "<fullName as printed>" },
    { "criterion": "CRT-CON-04-A", "connector": "GITHUB", "status": "passed", "testName": "<fullName as printed>" },
    { "criterion": "CRT-CON-06-A", "connector": "GMAIL", "status": "skipped", "testName": "<fullName as printed>" },
    { "criterion": "ADR-0041-LIVE-A", "connector": "OMI", "status": "passed", "testName": "<fullName as printed>" }
  ],
  "totals": { "passed": 4, "failed": 0, "skipped": 1 }
}
```

Rules for the record:

- `status` and `testName` are copied exactly as the extraction prints them.
- `workspaceClean` is true only when command 1 printed nothing.
- `totals` counts `cases` by status; anything neither passed nor failed counts as
  skipped.
- The Omi case is criterion `ADR-0041-LIVE-A` with connector `OMI`.
- The record holds no account address, calendar id, repository name, token,
  handle or path.
- `recordedBy` is the literal `owner`, and `command` is the literal `pnpm test`.
- Timestamps (`recordedAt`, `completedAt`) are UTC and end in `Z`.
- Unknown keys, another `format` and an unknown `connector` are refused.
- The file is named `live-connectors-<name>.json`, where `<name>` is 1-100
  letters, digits, `.`, `_` or `-` (by convention the UTC date of the run).
- Gate result: PASS only when `exitCode` is 0 and the Gmail, Calendar, GitHub
  and Omi cases are `passed`; FAIL when any of them failed;
  otherwise UNVERIFIED.
- Adding `liveConnectorRecords` is the only change to `release-input.json`.

**How `pnpm check:v0-release` reads it:** criterion PRD-54.1-LIVE-CONNECTORS
reads only the LAST path listed in `liveConnectorRecords`. It passes only when
all of these hold:

- the path is `docs/operations/live-connectors-<name>.json` and the record
  parses as `unai-live-connectors/1`;
- `exitCode` is 0 and `workspaceClean` is true;
- the cases CRT-CON-02-A `GMAIL`, CRT-CON-03-A `GOOGLE_CALENDAR`,
  CRT-CON-04-A `GITHUB` and ADR-0041-LIVE-A `OMI` are present;
- every case `passed`, except CRT-CON-06-A (revocation, opt-in), which may be
  skipped but never failed;
- `totals` match the cases;
- `sourceCommit` is HEAD or a records-only ancestor of HEAD (ADR 0044).

A missing key, an empty list or an absent file records `LIVE_RECORD_MISSING`;
any other listing, path or record problem records `LIVE_RECORD_INVALID` (under
`liveConnectors` in `test-results/operations/status.json`). Any code change
after the run fails the criterion until a new live run is recorded. `pnpm test`
without credentials reports the live cases as skipped, never as passed.

## Gate 3: Registry tags

**Closes:** PRD §54 item 3, "The canonical registry is Git-versioned and
CI-validated": the Git-versioned half. The gate also makes item 16's
registry-migration procedure ([registry-migration.md](registry-migration.md))
executable, because:

- `pnpm uai registry publish --version <version>` resolves
  `refs/tags/registry-v<version>` and refuses an untagged version with
  `REGISTRY_TAG_MISSING` (`packages/registry/src/release.ts`);
- the processing worker refuses to start without a published release
  ([processing-runtime.md](../processing-runtime.md)).

**Who runs it:** the owner, who holds push rights to `origin`. Agents never
create or push tags.

**Inputs:**

- A full (not shallow) clone with push rights.
- The versions recorded in `registry/releases.yaml` (0.1.0, 0.2.0 and 0.3.0 at
  this writing), each with its `tag` and `contentHash`.
- Requirement: for each version, a tag `registry-v<version>` on a commit whose
  committed `registry/releases/<version>/` files hash to the recorded
  `contentHash`.
- The loader resolves the tag to its commit and reads the files from Git
  objects, so working-tree edits never count, and a tag on a commit with
  different bytes is refused with `REGISTRY_CONTENT_HASH_MISMATCH`.
- Use annotated tags (`git tag -a`) so each tag records who created it and when.
- This clone has no `registry-v*` tags yet.

**Commands, in order:**

1. `pnpm uai registry lint` prints every recorded version with its `tag` and
   `contentHash`, read from the working tree.
2. `pnpm uai registry tags` prints one line per recorded version, with the
   exact `git tag -a` command for each one that is not PRESENT
   ([registry.md](../registry.md)). Run each printed `git tag -a ...` command.
   `pnpm uai registry tags --require` must then exit 0 before step 3. A
   MISMATCH tag also gets a printed `git push --force origin refs/tags/<tag>`
   line, and forcing it is the owner's call. When origin already holds that
   tag, run the forced line before step 3: step 3's by-name push is rejected
   for a tag that origin holds at another commit. Keep that line from the first
   report, because a re-run after re-tagging reports PRESENT and prints no push
   line.
3. `git push origin registry-v0.1.0 registry-v0.2.0 registry-v0.3.0`. Push only
   these; pushing every local tag would also publish any other tag you hold.
4. `git ls-remote --tags origin 'registry-v*'`. Its `^{}` line for each tag is
   the commit the tag points at.

**Artifact:** the pushed tags themselves. Record each tag's commit in the Status
row, for example `registry-v0.1.0 → <commit>`.

**How `pnpm check:v0-release` reads it:** criterion PRD-54.3-REGISTRY-TAGS runs
the same read-only inspection as `pnpm uai registry tags` over the clone's LOCAL
tags, and passes only when every version recorded in `registry/releases.yaml`
is PRESENT. It fails on a MISSING or MISMATCH tag, an empty index, and the codes
`REGISTRY_INDEX_INVALID`, `REGISTRY_HISTORY_SHALLOW`, `REGISTRY_GIT_UNAVAILABLE`
and `REGISTRY_TAGS_UNAVAILABLE` (under `registryTags` in
`test-results/operations/status.json`). A fresh clone holds no tags until
`git fetch --tags origin` runs, so run that first.
`pnpm uai registry publish` (used by the registry-migration runbook and every
install or upgrade) resolves each tag and verifies its hash before writing
anything.

## Gate 4: Hosted CI

**Closes:** release criterion CRT-QA-01-A, recorded in [README.md](README.md) as
the deferral `hosted-main-pipeline-deferred` ("the complete hosted `master`
pipeline can only certify this change after integration and publication"). It
also closes the CI-validated half of PRD §54 item 3. Local stage runs such as
[local-ci-2026-09-19.json](local-ci-2026-09-19.json) never close it.

**Who runs it:** the owner, who pushes to the default branch, reads the hosted
run and records it.

**Which run closes it:** a green run of the workflow `V0 pipeline`
(`.github/workflows/foundation.yml`, job `foundation`, on every push) on the
default branch `master`, with all nine stages passing, at the commit
`pnpm check:v0-release` runs at (HEAD) or at a records-only ancestor of HEAD
([ADR 0044](../adr/0044-release-records-after-certified-run.md)). The stage
names in `ci.stages[].name` (`V0_CI_STAGES`, `packages/domain/src/operations.ts`)
map to workflow steps:

| `ci.stages[].name` | Workflow step name |
| --- | --- |
| `lint` | Lint and type validation |
| `unit` | Unit tests |
| `property` | Property-based replay, reordering and identity tests |
| `registry-lint` | Registry lint |
| `registry-contract` | Registry contract tests |
| `connector-integration` | Connector integration |
| `security` | Security |
| `corpus` | Corpus evaluation |
| `end-to-end` | End-to-end source, Today, Ask and explanation |

**Inputs:** the run URL (`https://github.com/<owner>/<repo>/actions/runs/<id>`),
its commit (`headSha`, 40 hex), its branch, and each step's conclusion. With the
GitHub CLI:
`gh run list --workflow foundation.yml --branch master --limit 5 --json databaseId,headSha,conclusion,url`,
then `gh run view <id> --json jobs`.

**Commands, in order:**

1. Find the run and confirm its nine steps succeeded.
2. Set `ci` in `docs/operations/release-input.json`. A stage that did not
   succeed is recorded `FAIL`, never `PASS`:

   ```json
   "ci": {
     "branch": "master",
     "defaultBranch": "master",
     "commit": "<headSha, 40 hex>",
     "runRef": "https://github.com/<owner>/<repo>/actions/runs/<id>",
     "stages": [
       { "name": "lint", "result": "PASS" },
       { "name": "unit", "result": "PASS" },
       { "name": "property", "result": "PASS" },
       { "name": "registry-lint", "result": "PASS" },
       { "name": "registry-contract", "result": "PASS" },
       { "name": "connector-integration", "result": "PASS" },
       { "name": "security", "result": "PASS" },
       { "name": "corpus", "result": "PASS" },
       { "name": "end-to-end", "result": "PASS" }
     ]
   }
   ```

3. Commit `release-input.json` together with the Status row, and nothing else.
   Then run the release sequence from [README.md](README.md):
   `node scripts/local-policy-audit.mjs`, `pnpm test`, `pnpm ops:report`,
   `pnpm check:v0-release`.

**Artifact:** the `ci` object in `release-input.json` (schema
`operationsReportSchema.ci`, `packages/domain/src/operations.ts`), plus the run
URL in the Status row.

**How `pnpm check:v0-release` reads it:** CRT-QA-01-A
(`packages/domain/src/operations.ts`) passes only when the workspace is clean,
`ci` is present, `ci.branch` equals `ci.defaultBranch`, `ci.commit` is the
checked-out HEAD or a records-only ancestor of it, and each of the nine stages
appears exactly once with `PASS`. Records-only
([ADR 0044](../adr/0044-release-records-after-certified-run.md)) means that
`git merge-base --is-ancestor <ci.commit> HEAD` succeeds and
`git diff --name-only --no-renames <ci.commit> HEAD` lists only these paths:

- `docs/operations/release-input.json`
- `docs/operations/real-data-gates.md`
- `docs/operations/live-connectors-<name>.json`
- `corpus/expected/real-corpus-results.json`

A file renamed into one of these paths still lists its old path, so it fails.
The relation found is recorded under `recordedCommits` in
`test-results/operations/status.json`.

Committing the record, stated plainly:

- Commit the `ci` block and its Status row on their own, after the run. Any
  other change after the certified commit fails the criterion until a new
  hosted run certifies the new commit.
- Never hide the edit (`git update-index --assume-unchanged` or
  `--skip-worktree`), and never run with a dirty tree to force a pass: that
  certifies an input the hosted run never saw.
