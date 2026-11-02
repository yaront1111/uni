# Environment contract

This is the environment contract for the delivered processes, not a proposed deployment
configuration. `pnpm check:env-contract` and `src/env-contract.test.ts` (included in
`pnpm test`) enforce the repository-read inventory. Consumer line numbers were checked
on 2026-11-02; the guard checks that the file reads the variable and that the line is
in range, not that the read remains on exactly that line. No secret values belong here.

## How the guard works

`scripts/env-contract.mjs` scans non-test `.ts`, `.tsx` and `.mjs` files under
`packages/`, `apps/web/`, `src/` and `scripts/`. It excludes names containing `.test.`,
`node_modules`, `dist`, `.next`, `.moe*`, and symlinks. It never executes scanned code.
The default root comes from the script location, not the working directory;
`node scripts/env-contract.mjs --root <dir>` supports disposable test fixtures.

Recognised line-local idioms are member reads on `process.env`, `env` or identifiers
ending in `env`/`Env` (including optional chaining), literal bracket keys (single,
double or backtick quotes), and calls to `required`, `secret`, `databasePool` (name in
argument 0) or `requireSecret`, `processingRequired`, `requiredNumber` (argument 1).
Object-literal child-environment keys, bare names in comments and error-code strings
are not reads. This is an idiom guard, not general TypeScript data-flow analysis:
destructuring (`const {X} = process.env`) and aliases whose name does not end in
`env`/`Env` are a documented non-goal and are not detected, so keep environment reads
in these forms. It does not naively strip `//` comments, which would truncate HTTPS strings.

Any bracket key on those receivers that is not exactly one quoted identifier literal
is a computed lookup: a variable (`process.env[name]`), a quote-led concatenation
(`process.env['UNAI_' + suffix]`) or an interpolated template
(`` process.env[`UNAI_${suffix}`] ``). Empty brackets such as the type `Env[]` are not.
Computed lookups are registered only in `packages/api/src/server.ts`,
`apps/web/lib/server.ts`, `packages/api/src/processing-config.ts`,
`packages/model/src/providers.ts`, `packages/secrets/src/index.ts`,
`packages/registry/src/cli.ts` and `scripts/storage-harness.mjs`.
Quoted exact uppercase names on a registered computed-read line are inventoried too.
Anywhere else a computed lookup fails closed with
`ENV_CONTRACT_DYNAMIC_READ_UNREGISTERED <file>:<line>`. A new helper needs both its
call idiom and its implementation file registered in the script, with a fixture test.

To add a variable, add a row in **each consuming process's table** in the same change
as the read. Tables must start with `Variable`, contain a `Consumer` column with
backticked repository-relative `path:line` references, and backtick variable names.
Do not put `|` inside cells: write “or”. Unrelated tables are ignored. Rows under the
exact H2 `Read by Node.js and dependencies` are exempt, but never satisfy a repository
read. The guard reports `ENV_CONTRACT_UNDOCUMENTED`, `ENV_CONTRACT_UNREAD`,
`ENV_CONTRACT_CONSUMER_REQUIRED`, `ENV_CONTRACT_CONSUMER_INVALID`, or
`ENV_CONTRACT_DYNAMIC_READ_UNREGISTERED`, then exits 1. Missing docs, invalid arguments
and read failures also exit 1. Success prints `ENV_CONTRACT_PASS`.

## Known discrepancies

- **CA names:** CLIs use `UNAI_DATABASE_CA_PATH` (`packages/postgres/src/migrate-cli.ts:5`,
  `packages/registry/src/cli.ts:46`, `:157`, `:174`); `scripts/verifier-rehearsal.mjs:20`
  delivers that name by default. API, web and worker use `UNAI_DATABASE_CA_FILE` for
  the same kind of file. These are not aliases. Rename work belongs to
  `task-047a1a0cad1743c5977df413e60a3e93`.
- **Credential representation:** `UNAI_MIGRATION_DATABASE_URL` and `UNAI_DATABASE_URL`
  are literal connection URLs carrying credentials, read directly by the CLIs, not
  secret handles. Runtime credential variables instead hold
  `secret://<provider>/<name>[#<field>]`, resolved through SecretsManager (ADR 0013).
  The S3 SDK's external credential chain is a separate existing exception below.
  This document records the CLI discrepancy; it does not authorize promoting it.
- **Worker diagnostics:** `packages/api/src/processing-worker.ts:51` replaces startup
  messages containing a colon (including `CONFIG_REQUIRED:<NAME>` and suffixed
  `SECRET_*` errors) with `PROCESSING_STARTUP_FAILED`. `processing-config.ts:6`
  emits `PROCESSING_CONFIGURATION_REQUIRED` without identifying the variable.
  Fix work belongs to `task-d77494c289d44b06b070bc88d667ee93`.
- **Lazy web secrets:** the mount and handles are resolved on first use, not listener
  startup. The manager is cached, the auth pool is cached after successful creation,
  but OAuth and session secrets are resolved on every `authOptions()` request
  (`apps/web/lib/server.ts:13-22`; `packages/secrets/CLAUDE.md`).
- **Observed auth fallback:** next-auth has raw `NEXTAUTH_SECRET`/`AUTH_SECRET`
  fallbacks, but the current Pages API route supplies the resolved `options.secret`
  and short-circuits them. Do not introduce a bare middleware or `getToken()` call
  that would mistake a `secret://` handle for secret material; see dependency notes.

A secret handle has no secret material in it. The mounted provider reads beneath
`UNAI_SECRETS_MOUNT`; `#field` selects a string from a JSON secret. Missing handles
produce `CONFIG_REQUIRED:<NAME>`; literals produce `SECRET_HANDLE_REQUIRED:<NAME>`;
provider/field failures use the `SECRET_*` codes documented in `packages/secrets/CLAUDE.md`.
Resolved PostgreSQL URLs must not carry certificate-verification-downgrading query
options: `createDatabasePool` rejects **all** query options and blank CA contents with
`DATABASE_TLS_CONFIG_INVALID` (`packages/postgres/src/index.ts:8-13`).

## API (pnpm start:api)

Startup order (`packages/api/src/server.ts:11-25`): secrets manager → CA and the two
resolved database URLs → database encryption-at-rest declaration → S3 bucket check →
registry pin, connector runtime and listener TLS → listen. `unai.encryption_at_rest`
is a **database setting**, not an environment variable; absence or an invalid
`volume-kms:…`, `tde:…` or `managed:…` declaration gives
`DATABASE_ENCRYPTION_AT_REST_REQUIRED`. The S3 bucket must prove exactly one `aws:kms`
rule with the configured key (`STORAGE_ENCRYPTION_REQUIRED`).
Missing `required()` configuration/handles throws uncaught `CONFIG_REQUIRED:<NAME>`;
Node prints a stack trace and exits 1. Registry configuration uses the distinct codes
below. File-open failures currently have no application-level translation here.

| Variable | Required / default | Kind | When read | Consumer | Failure when missing |
| --- | --- | --- | --- | --- | --- |
| `UNAI_SECRETS_MOUNT` | required; mounted provider directory | file path | startup | `packages/secrets/src/index.ts:107` | `CONFIG_REQUIRED:UNAI_SECRETS_MOUNT` |
| `UNAI_DATABASE_CA_FILE` | required; trusted PostgreSQL CA | file path | startup | `packages/api/src/server.ts:12` | `CONFIG_REQUIRED:UNAI_DATABASE_CA_FILE` |
| `UNAI_APP_DATABASE_URL` | required; low-privilege application URL handle | secret handle | startup | `packages/api/src/server.ts:13` | `CONFIG_REQUIRED:UNAI_APP_DATABASE_URL` |
| `UNAI_AUTH_DATABASE_URL` | required; auth-role URL handle | secret handle | startup | `packages/api/src/server.ts:14` | `CONFIG_REQUIRED:UNAI_AUTH_DATABASE_URL` |
| `UNAI_S3_ENDPOINT` | required; HTTPS endpoint | URL | startup | `packages/api/src/server.ts:18` | `CONFIG_REQUIRED:UNAI_S3_ENDPOINT` |
| `UNAI_S3_REGION` | required | literal | startup | `packages/api/src/server.ts:18` | `CONFIG_REQUIRED:UNAI_S3_REGION` |
| `UNAI_S3_BUCKET` | required; private encrypted bucket | literal | startup | `packages/api/src/server.ts:18` | `CONFIG_REQUIRED:UNAI_S3_BUCKET` |
| `UNAI_S3_KMS_KEY_ID` | required; exact bucket/receipt key identifier | literal | startup | `packages/api/src/server.ts:18` | `CONFIG_REQUIRED:UNAI_S3_KMS_KEY_ID` |
| `UNAI_REGISTRY_RELEASE_ID` | required UUID | literal | startup | `packages/api/src/processing-config.ts:10` | `PROCESSING_CONFIGURATION_REQUIRED` |
| `UNAI_REGISTRY_RELEASE` | required x.y.z release | literal | startup | `packages/api/src/processing-config.ts:11` | `PROCESSING_CONFIGURATION_REQUIRED` |
| `UNAI_API_TLS_KEY_FILE` | required; listener private-key path | file path | startup | `packages/api/src/server.ts:24` | `CONFIG_REQUIRED:UNAI_API_TLS_KEY_FILE` |
| `UNAI_API_TLS_CERT_FILE` | required; listener certificate path | file path | startup | `packages/api/src/server.ts:24` | `CONFIG_REQUIRED:UNAI_API_TLS_CERT_FILE` |
| `UNAI_API_PORT` | optional; 3443 | literal | startup | `packages/api/src/server.ts:25` | none; default |
| `UNAI_API_BIND` | optional; 127.0.0.1 (loopback) | literal | startup | `packages/api/src/server.ts:25` | none; default |

Malformed registry UUID/version gives `PROCESSING_CONFIGURATION_INVALID`. TLS is
in-process, not terminated at a trusted proxy; these settings do not enable proxy trust.

## Web (pnpm start:web, pnpm dev:web)

The listener requires a bare canonical HTTPS origin (no userinfo, non-root path,
query or fragment) and takes its port from that origin, defaulting to 443. Invalid
origin shape gives `WEB_TLS_CONFIG_INVALID`; unparseable URLs throw from `URL`.
The Host check remains enforced. Register `NEXTAUTH_URL` + `/api/auth/callback/google`
as the Google OAuth callback. OAuth client ID is plain configuration; its secret
is a handle. The **resolved** session secret must be at least 32 characters
(`AUTH_CONFIG_REQUIRED`, `packages/auth/src/index.ts:70`).

| Variable | Required / default | Kind | When read | Consumer | Failure when missing |
| --- | --- | --- | --- | --- | --- |
| `NEXTAUTH_URL` | required; canonical HTTPS origin | URL | startup | `apps/web/server.ts:6` | `CONFIG_REQUIRED:NEXTAUTH_URL` |
| `NEXTAUTH_URL` | required; compared against Origin on proxied writes | URL | per use | `apps/web/pages/api/platform/[...path].ts:18` | `CONFIG_REQUIRED:NEXTAUTH_URL` (proxy catches as `SERVICE_UNAVAILABLE`) |
| `UNAI_WEB_TLS_KEY_FILE` | required; listener private-key path | file path | startup | `apps/web/server.ts:12` | `CONFIG_REQUIRED:UNAI_WEB_TLS_KEY_FILE` |
| `UNAI_WEB_TLS_CERT_FILE` | required; listener certificate path | file path | startup | `apps/web/server.ts:12` | `CONFIG_REQUIRED:UNAI_WEB_TLS_CERT_FILE` |
| `UNAI_WEB_BIND` | optional; 127.0.0.1 (loopback) | literal | startup | `apps/web/server.ts:13` | none; default |
| `UNAI_SECRETS_MOUNT` | required when auth is first needed | file path | first request | `packages/secrets/src/index.ts:107` | `CONFIG_REQUIRED:UNAI_SECRETS_MOUNT` |
| `UNAI_AUTH_DATABASE_URL` | required; auth-role URL handle; pool cached | secret handle | first request | `apps/web/lib/server.ts:16` | `CONFIG_REQUIRED:UNAI_AUTH_DATABASE_URL` |
| `UNAI_DATABASE_CA_FILE` | required; trusted PostgreSQL CA; pool cached | file path | first request | `apps/web/lib/server.ts:17` | `CONFIG_REQUIRED:UNAI_DATABASE_CA_FILE` |
| `GOOGLE_CLIENT_SECRET` | required for auth options; resolved each call | secret handle | per use | `apps/web/lib/server.ts:21` | `CONFIG_REQUIRED:GOOGLE_CLIENT_SECRET` |
| `NEXTAUTH_SECRET` | required; resolved secret at least 32 characters | secret handle | per use | `apps/web/lib/server.ts:21` | `CONFIG_REQUIRED:NEXTAUTH_SECRET` |
| `GOOGLE_CLIENT_ID` | required; plain OAuth client identifier | literal | per use | `apps/web/lib/server.ts:22` | `CONFIG_REQUIRED:GOOGLE_CLIENT_ID` |
| `UNAI_API_ORIGIN` | required; bare HTTPS API origin; no default | URL | per use | `apps/web/lib/server.ts:31` | `CONFIG_REQUIRED:UNAI_API_ORIGIN` |
| `UNAI_API_CA_FILE` | required; verifies API TLS certificate | file path | per use | `apps/web/lib/server.ts:35` | `CONFIG_REQUIRED:UNAI_API_CA_FILE` |
| `UNAI_OPERATIONS_REPORT_FILE` | optional; no report if absent | file path | per use | `apps/web/lib/operations-status.ts:6` | none; null report |
| `UNAI_REGISTRY_LINT_REPORT_FILE` | optional; no lint report if absent | file path | per use | `apps/web/pages/ops/registry.tsx:13` | none; null report |
| `UNAI_CORPUS_STATUS_FILE` | optional; no corpus status if absent | file path | per use | `apps/web/lib/corpus-status.ts:26` | none; null status |
| `UNAI_PRIVATE_CORPUS_DIR` | optional; adds a forbidden report location; corpus/private-local always forbidden | file path | per use | `apps/web/lib/corpus-status.ts:18` | none; built-in location remains forbidden |

Invalid API origin shape gives `API_TLS_CONFIG_INVALID`. Web table codes describe
configuration helpers, not guaranteed HTTP response codes: request boundaries may
replace them with `SERVICE_UNAVAILABLE` or a generic error. Reports never expose file errors.

## Processing worker (pnpm start:worker)

Startup (`packages/api/src/processing-worker.ts:15-34`): release/owner/purpose/sensitivity/
poll configuration → secrets → model provider → database CA and resolved application
URL → encryption-at-rest check → runtime validation and release comparison → evidence
bucket check. `--check` performs these checks then exits; it does not skip required
model credentials or the bucket check, which prints the API's `STORAGE_ENCRYPTION_REQUIRED`
or `STORAGE_CONFIGURATION_INVALID`.
A single process handles one owner scope and data purpose. Invalid UUIDs, release,
purpose, sensitivity or poll bounds give `PROCESSING_CONFIGURATION_INVALID`.
The table records the **printed** missing-configuration code (exit 1); suffixed
secret/configuration errors collapse to `PROCESSING_STARTUP_FAILED`, as noted above.

| Variable | Required / default | Kind | When read | Consumer | Failure when missing |
| --- | --- | --- | --- | --- | --- |
| `UNAI_REGISTRY_RELEASE_ID` | required UUID | literal | startup | `packages/api/src/processing-config.ts:10` | `PROCESSING_CONFIGURATION_REQUIRED` |
| `UNAI_REGISTRY_RELEASE` | required x.y.z release | literal | startup | `packages/api/src/processing-config.ts:11` | `PROCESSING_CONFIGURATION_REQUIRED` |
| `UNAI_PROCESSING_OWNER_SCOPE_ID` | required UUID | literal | startup | `packages/api/src/processing-config.ts:17` | `PROCESSING_CONFIGURATION_REQUIRED` |
| `UNAI_PROCESSING_ACTOR_ID` | required UUID | literal | startup | `packages/api/src/processing-config.ts:18` | `PROCESSING_CONFIGURATION_REQUIRED` |
| `UNAI_PROCESSING_DATA_PURPOSE` | required; uppercase identifier, at most 64 characters | literal | startup | `packages/api/src/processing-config.ts:20` | `PROCESSING_CONFIGURATION_REQUIRED` |
| `UNAI_PROCESSING_MAXIMUM_SENSITIVITY` | required; NORMAL, PRIVATE or RESTRICTED | literal | startup | `packages/api/src/processing-config.ts:21` | `PROCESSING_CONFIGURATION_REQUIRED` |
| `UNAI_PROCESSING_POLL_MS` | optional; 1000; integer 100–60000 | literal | startup | `packages/api/src/processing-config.ts:22` | none; default |
| `UNAI_SECRETS_MOUNT` | required | file path | startup | `packages/secrets/src/index.ts:107` | `PROCESSING_STARTUP_FAILED` |
| `UNAI_MODEL_PROVIDER` | required; registered provider (anthropic or openai bundled) | literal | startup | `packages/model/src/providers.ts:173` | `MODEL_CONFIG_REQUIRED` |
| `UNAI_MODEL_ENDPOINT` | required; HTTPS provider endpoint | URL | startup | `packages/model/src/providers.ts:177` | `MODEL_CONFIG_REQUIRED` |
| `UNAI_MODEL_ID` | required; provider model ID | literal | startup | `packages/model/src/providers.ts:177` | `MODEL_CONFIG_REQUIRED` |
| `UNAI_MODEL_API_KEY` | required; model credential handle | secret handle | startup | `packages/model/src/providers.ts:179` | `PROCESSING_STARTUP_FAILED` |
| `UNAI_MODEL_INPUT_MICROUNITS_PER_1K` | required; finite nonnegative input cost per 1000 tokens | literal | startup | `packages/model/src/providers.ts:183` | `MODEL_CONFIG_REQUIRED` |
| `UNAI_MODEL_OUTPUT_MICROUNITS_PER_1K` | required; finite nonnegative output cost per 1000 tokens | literal | startup | `packages/model/src/providers.ts:184` | `MODEL_CONFIG_REQUIRED` |
| `UNAI_MODEL_API_VERSION` | optional; anthropic defaults to 2023-06-01; unused by openai | literal | startup | `packages/model/src/providers.ts:186` | none; provider default |
| `UNAI_DATABASE_CA_FILE` | required; trusted PostgreSQL CA | file path | startup | `packages/api/src/processing-worker.ts:18` | `PROCESSING_CONFIGURATION_REQUIRED` |
| `UNAI_APP_DATABASE_URL` | required; application-role URL handle | secret handle | startup | `packages/api/src/processing-worker.ts:19` | `PROCESSING_STARTUP_FAILED` |
| `UNAI_S3_ENDPOINT` | required; HTTPS endpoint | URL | startup | `packages/api/src/processing-worker.ts:31` | `PROCESSING_CONFIGURATION_REQUIRED` |
| `UNAI_S3_REGION` | required | literal | startup | `packages/api/src/processing-worker.ts:31` | `PROCESSING_CONFIGURATION_REQUIRED` |
| `UNAI_S3_BUCKET` | required; private encrypted bucket | literal | startup | `packages/api/src/processing-worker.ts:32` | `PROCESSING_CONFIGURATION_REQUIRED` |
| `UNAI_S3_KMS_KEY_ID` | required; exact bucket/receipt key identifier | literal | startup | `packages/api/src/processing-worker.ts:32` | `PROCESSING_CONFIGURATION_REQUIRED` |

Unknown providers give `MODEL_PROVIDER_UNKNOWN`; bad/non-HTTPS endpoints give
`MODEL_ENDPOINT_INVALID`/`MODEL_ENDPOINT_INSECURE`. Empty numeric strings currently
coerce to zero (only undefined, nonfinite or negative costs are refused).

## Command-line tools

These tables describe current behavior, including the literal credential URLs noted
above; do not put URL values in this document or Git. `uai registry lint`,
`uai registry test`, `ops:report` and `check:v0-release` have no repository-owned
environment reads of their own. Dependency defaults are listed separately.

### pnpm db:migrate

| Variable | Required / default | Kind | When read | Consumer | Failure when missing |
| --- | --- | --- | --- | --- | --- |
| `UNAI_MIGRATION_DATABASE_URL` | required; literal privileged migration connection URL, not a handle | URL | startup | `packages/postgres/src/migrate-cli.ts:4` | `MIGRATION_TLS_CONFIGURATION_REQUIRED` |
| `UNAI_DATABASE_CA_PATH` | required; trusted PostgreSQL CA | file path | startup | `packages/postgres/src/migrate-cli.ts:5` | `MIGRATION_TLS_CONFIGURATION_REQUIRED` |

### pnpm uai registry publish

| Variable | Required / default | Kind | When read | Consumer | Failure when missing |
| --- | --- | --- | --- | --- | --- |
| `UNAI_MIGRATION_DATABASE_URL` | required; literal privileged connection URL, not a handle | URL | startup | `packages/registry/src/cli.ts:157` | `REGISTRY_PUBLISH_CONFIGURATION_REQUIRED` |
| `UNAI_DATABASE_CA_PATH` | required; trusted PostgreSQL CA | file path | startup | `packages/registry/src/cli.ts:157` | `REGISTRY_PUBLISH_CONFIGURATION_REQUIRED` |

### pnpm uai registry projection-replay

| Variable | Required / default | Kind | When read | Consumer | Failure when missing |
| --- | --- | --- | --- | --- | --- |
| `UNAI_DATABASE_URL` | required; literal low-privilege application connection URL, not a handle | URL | startup | `packages/registry/src/cli.ts:174` | `PROJECTION_REPLAY_CONFIGURATION_REQUIRED` |
| `UNAI_DATABASE_CA_PATH` | required; trusted PostgreSQL CA | file path | startup | `packages/registry/src/cli.ts:174` | `PROJECTION_REPLAY_CONFIGURATION_REQUIRED` |

### pnpm uai registry shadow-diff

Only `--sample owner` needs the database. `--sample corpus:private` reads the private
corpus directory; the synthetic corpus needs neither credential nor private path.

| Variable | Required / default | Kind | When read | Consumer | Failure when missing |
| --- | --- | --- | --- | --- | --- |
| `UNAI_DATABASE_URL` | required for owner sample; literal connection URL, not a handle | URL | per use | `packages/registry/src/cli.ts:117` | `SHADOW_OWNER_SAMPLE_CONFIGURATION_REQUIRED` |
| `UNAI_DATABASE_CA_PATH` | required for owner sample | file path | per use | `packages/registry/src/cli.ts:46` | `SHADOW_OWNER_SAMPLE_CONFIGURATION_REQUIRED` |
| `UNAI_PRIVATE_CORPUS_DIR` | optional; corpus/private-local relative to repository | file path | per use | `packages/registry/src/corpus.ts:59` | none; default |

### pnpm uai corpus import, annotate, run, verify and status

| Variable | Required / default | Kind | When read | Consumer | Failure when missing |
| --- | --- | --- | --- | --- | --- |
| `UNAI_PRIVATE_CORPUS_DIR` | optional; corpus/private-local; used for private corpus operations | file path | per use | `packages/registry/src/corpus.ts:59` | none; default |

## Test and development harness

Never deliver an owner's production database or bucket. Tests create/drop databases,
roles and objects. With no delivered database the harness provisions disposable
pgvector; storage uses delivered S3, else MinIO, else the in-process encrypted store.
`*.test.*` reads are excluded from the guard; these rows describe harness source.

| Variable | Required / default | Kind | When read | Consumer | Failure when missing |
| --- | --- | --- | --- | --- | --- |
| `UNAI_TEST_DATABASE_URL` | optional; takes precedence over DATABASE_URL; else disposable container | URL | startup | `scripts/test.mjs:33` | none; provisions database; provisioning failure `DATABASE_PROVISIONING_FAILED` |
| `DATABASE_URL` | optional; fallback delivered disposable-server URL | URL | startup | `scripts/test.mjs:33` | none; provisions database |
| `UNAI_TEST_S3_ENDPOINT` | optional all-or-none trio; HTTPS endpoint | URL | per use | `scripts/storage-harness.mjs:20`, `scripts/recovery-objects.mjs:8` | partial trio: `STORAGE_PROVISIONING_FAILED` with incomplete-storage diagnostic |
| `UNAI_TEST_S3_BUCKET` | optional all-or-none trio | literal | per use | `scripts/storage-harness.mjs:20`, `scripts/recovery-objects.mjs:26` | partial trio: `STORAGE_PROVISIONING_FAILED` with incomplete-storage diagnostic |
| `UNAI_TEST_S3_KMS_KEY_ID` | optional all-or-none trio; exact key ID | literal | per use | `scripts/storage-harness.mjs:20`, `scripts/recovery-objects.mjs:31`, `scripts/database-roundtrip.mjs:65` | partial trio: `STORAGE_PROVISIONING_FAILED` with incomplete-storage diagnostic |
| `AWS_ACCESS_KEY_ID` | optional; explicit recovery credentials only with secret key, else SDK chain | literal | per use | `scripts/recovery-objects.mjs:9` | none at read; chain/storage operation may fail |
| `AWS_SECRET_ACCESS_KEY` | optional; literal SDK credential, not SecretsManager handle | literal | per use | `scripts/recovery-objects.mjs:9` | none at read; chain/storage operation may fail |
| `AWS_SESSION_TOKEN` | optional; temporary credential token | literal | per use | `scripts/recovery-objects.mjs:9` | none; omitted |
| `NODE_EXTRA_CA_CERTS` | optional; recovery explicitly loads CA in addition to Node startup behavior | file path | per use | `scripts/recovery-objects.mjs:10` | none; default trust; private CA verification may fail |
| `UNAI_SECRETS_MOUNT` | required in dev child; parent supplies disposable mount | file path | startup | `packages/secrets/src/index.ts:107` | child exits 1 silently; helper `CONFIG_REQUIRED:UNAI_SECRETS_MOUNT` |
| `UNAI_DEV_DATABASE_URL` | required in dev child; parent supplies handle | secret handle | startup | `scripts/dev-stack-child.mjs:7` | child exits 1 silently on secret resolution failure |
| `UNAI_S3_CREDENTIALS` | required in dev child; parent supplies handle | secret handle | startup | `scripts/dev-stack-child.mjs:8` | child exits 1 silently on secret resolution failure |
| `MOE_VERIFIER_DB_IMAGE` | optional; pgvector/pgvector:pg17 | literal | startup | `scripts/verifier-rehearsal.mjs:18` | none; default |
| `MOE_VERIFIER_DB_URL_VARS` | optional; DATABASE_URL,UNAI_MIGRATION_DATABASE_URL (comma-separated names to export) | literal | startup | `scripts/verifier-rehearsal.mjs:19` | none; default |
| `MOE_VERIFIER_DB_CA_VAR` | optional; UNAI_DATABASE_CA_PATH (name to export) | literal | startup | `scripts/verifier-rehearsal.mjs:20` | none; default |
| `DEV_DB_URL` | optional in tracked scratch script; otherwise pg defaults (not safe for production) | URL | startup | `scripts/.tmp/migrate-check.mjs:5` | no explicit guard; connection may fail |

The dev orchestrator is not a production start script. `scripts/dev-stack.mjs:19,150`
refuses any set environment key containing `DATABASE` or matching its PG selector
(HOST, HOSTADDR, PORT, DATABASE, USER, PASSWORD, PASSFILE, SERVICE, SERVICEFILE,
SYSCONFDIR, SSLMODE, SSLROOTCERT), with `DEV_STACK_EXTERNAL_DATABASE_REFUSED`.
Its child passthrough at `:22-24` allows only PATH, SYSTEMROOT, WINDIR, TEMP, TMP, HOME,
USERPROFILE, LANG and LC_ALL (case-insensitive). These pattern reads are described
here, not expanded into guard rows. `scripts/.tmp/migrate-check.mjs` is tracked debris
for `task-de6f21daedcb402392b44cee4c666d9e` to remove **together with its DEV_DB_URL row**;
otherwise the reverse inventory check fails.

## Read by Node.js and dependencies

These rows are exempt from the repository scan; they describe selected operationally
relevant dependency behavior, not permission to configure credentials as literals in
runtime handle variables. Source references below are within the named installed
package, inspected under `node_modules/.pnpm` (not scanned by the guard).

`packages/storage/src/index.ts:24` supplies neither credentials nor a CA option to
S3Client. Thus the SDK credential chain applies, and `NODE_EXTRA_CA_CERTS` at process
startup is the existing way to add a private S3 CA to the API's client. Node 24's
`node --help` confirms this file is read once at startup. Production's credential
source is the deployment ADR 0043 decision, not a choice made by this contract.

| Variable | Required / default | Kind | When read | Consumer | Failure when missing |
| --- | --- | --- | --- | --- | --- |
| `NODE_EXTRA_CA_CERTS` | optional; extra trust file; no default | file path | startup | Node 24 TLS (`node --help`) | none; system/bundled trust only |
| `NODE_ENV` | dependency mode; use production for production | literal | per use | next 16.3.5 `dist/server/next.js:460`; next-auth 4.24.15 `core/lib/assert.js:28` | no app missing-variable code |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN` | optional environment provider; token for temporary credentials | literal | per use | @aws-sdk/credential-provider-env 3.972.71 `dist-cjs/index.js:12-14` | chain tries alternatives; API maps bucket-check failure to `STORAGE_ENCRYPTION_REQUIRED` |
| `AWS_PROFILE` | optional; default profile; explicit profile takes precedence over static env pair | literal | per use | @smithy/core 3.34.1 `dist-cjs/submodules/config/index.js:165-167`; @aws-sdk/credential-provider-node 3.972.83 `dist-cjs/index.js:98-118` | none; default profile |
| `AWS_SHARED_CREDENTIALS_FILE` | optional; ~/.aws/credentials | file path | per use | @smithy/core 3.34.1 `dist-cjs/submodules/config/index.js:207-208` | chain tries alternatives |
| `AWS_CONFIG_FILE` | optional; ~/.aws/config | file path | per use | @smithy/core 3.34.1 `dist-cjs/submodules/config/index.js:204-205` | chain tries alternatives |
| `AWS_WEB_IDENTITY_TOKEN_FILE` | optional web-identity token file; requires role | file path | per use | @aws-sdk/credential-provider-web-identity 3.972.77 `dist-cjs/index.js:31-38` | chain tries alternatives |
| `AWS_ROLE_ARN` | optional web-identity role identifier; requires token file | literal | per use | @aws-sdk/credential-provider-web-identity 3.972.77 `dist-cjs/index.js:31-38` | chain tries alternatives |
| `NEXTAUTH_URL` | required by this app; dependency canonical URL | URL | per use | next-auth 4.24.15 `utils/detect-origin.js:9`, `react/index.js:53-56` | dependency fallback; app separately requires it |
| `NEXTAUTH_SECRET`, `AUTH_SECRET` | raw dependency fallbacks only; app supplies resolved options.secret | literal | per use | next-auth 4.24.15 `next/index.js:17`, `jwt/index.js:70`, `next/middleware.js:27` | missing secret in production rejected by dependency |
| `NEXTAUTH_URL_INTERNAL` | optional; server fetch URL, falls back to NEXTAUTH_URL then VERCEL_URL | URL | per use | next-auth 4.24.15 `react/index.js:55-56` (module initialization) | none; fallback |
| `AUTH_TRUST_HOST`, `VERCEL` | optional; dependency forwarded-host fallback only without NEXTAUTH_URL; do not enable proxy trust | literal | per use | next-auth 4.24.15 `utils/detect-origin.js:10`; `jwt/index.js:65` also reads VERCEL | none; canonical URL path used |
| `VERCEL_URL` | optional dependency URL fallback; not deployment configuration for this app | URL | per use | next-auth 4.24.15 `react/index.js:53-56` | none; parser default |
| `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE` | URL omissions: host localhost, port 5432, user USER/USERNAME, password null, database user; prefer complete URLs | literal | per use | pg 8.23.0 `lib/connection-parameters.js:9-22,59-68`; `lib/defaults.js:5-28` | no single missing-variable code; connection/auth may fail |
| `PGSSLMODE` | pg fallback only when ssl is unspecified; overridden by application explicit ssl | literal | per use | pg 8.23.0 `lib/connection-parameters.js:25-37,85` | none; application TLS remains verified |
| `PGCONNECT_TIMEOUT` | pg fallback only without connectionTimeoutMillis; app explicitly supplies 5000 ms | literal | per use | pg 8.23.0 `lib/connection-parameters.js:126-129` | none; application timeout remains 5 s |

The active web route (`apps/web/pages/api/auth/[...nextauth].ts:7`) calls NextAuth with
`await authOptions()`. `packages/auth/src/index.ts:72` supplies resolved `secret`, so
next-auth's Pages-handler fallback at `next/index.js:17` does **not** read the handle
as a secret on this path. Its JWT/middleware fallback would read the raw environment
if used without an explicit secret; that is not how the current route works.
PostgreSQL's explicit `{ca, rejectUnauthorized:true}` overrides `PGSSLMODE`, and the
URL-query ban prevents pg's parsed connection options from replacing that object.
