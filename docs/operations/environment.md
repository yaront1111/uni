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

- **CA names:** `pnpm db:migrate` and `uai registry publish`, `projection-replay` and
  `shadow-diff --sample owner` read the canonical `UNAI_DATABASE_CA_FILE` through
  `resolveDatabaseCaFile` (`packages/postgres/src/database-ca.ts:8`). They still accept
  `UNAI_DATABASE_CA_PATH` as a deprecated alias, which prints
  `CONFIG_DEPRECATED_ALIAS:UNAI_DATABASE_CA_PATH` once on stderr; different non-empty
  values refuse with `CONFIG_CONFLICT:UNAI_DATABASE_CA_FILE`.
  `scripts/verifier-rehearsal.mjs:20` still exports the alias by default, mirroring the
  moe-next verifier, so verifier runs print that line. API, web and worker accept only
  `UNAI_DATABASE_CA_FILE`.
- **Credential representation:** `UNAI_MIGRATION_DATABASE_URL` and `UNAI_DATABASE_URL`
  are literal connection URLs carrying credentials, read directly by the CLIs, not
  secret handles. Runtime credential variables instead hold
  `secret://<provider>/<name>[#<field>]`, resolved through SecretsManager (ADR 0013).
  The S3 SDK's external credential chain is a separate existing exception below.
  This document records the CLI discrepancy; it does not authorize promoting it.
- **Lazy web secrets:** auth handles are resolved on first use, not listener
  startup. Telemetry resolves the mount at startup when the endpoint and
  UNAI_OTEL_EXPORTER_OTLP_HEADERS are set. The manager is cached, the auth pool is cached after successful creation,
  but OAuth and session secrets are resolved on every `authOptions()` request
  (`apps/web/lib/server.ts:13-27`; `packages/secrets/CLAUDE.md`).
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

## Startup failure output

Each process that fails during startup writes exactly one JSON line to stderr and
exits 1, never a stack trace or raw database, provider, TLS or filesystem error text.
The worker writes `{"event":"startup_failed","code":"<CODE>","variable":"<NAME>"}`
(or `null` for `variable`). The API writes
`{"event":"startup_failed","code":"API_STARTUP_FAILED","cause":"<CODE>"}`;
the web uses the same shape with `WEB_STARTUP_FAILED`.

The shared classifier keeps a leading uppercase code and retains a colon suffix
only for variable names beginning `UNAI_`, `NEXTAUTH_` or `GOOGLE_`; other suffixes
are discarded. For example, `CONFIG_REQUIRED:UNAI_MODEL_API_KEY` is preserved, while
`SECRET_UNAVAILABLE:mounted/runtime/model-key` prints only `SECRET_UNAVAILABLE`.
Node error codes such as `ENOENT`, `EACCES`, `EADDRINUSE` and `ERR_INVALID_URL` pass
through without their error text. Unclassified failures use `PROCESSING_STARTUP_FAILED`
for the worker or `UNCLASSIFIED` as the API/web cause.

The API writes one `{"event":"listening","port":N}` line to stdout after binding,
using the actual bound port (including when the configured port is zero), never the
host. Existing telemetry, probe-status and runtime log lines remain unchanged.

## API (pnpm start:api)

Startup order (`packages/api/src/server.ts:8-94`): startTelemetry → rate-limit validation → secrets manager → CA and the two
resolved database URLs → database encryption-at-rest declaration → S3 bucket check →
registry pin, connector runtime and listener TLS → probe configuration → API listen → probe listener. `unai.encryption_at_rest`
is a **database setting**, not an environment variable; absence or an invalid
`volume-kms:…`, `tde:…` or `managed:…` declaration gives
`DATABASE_ENCRYPTION_AT_REST_REQUIRED`. The S3 bucket must prove exactly one `aws:kms`
rule with the configured key (`STORAGE_ENCRYPTION_REQUIRED`).
Startup failures print the `startup_failed` line with `API_STARTUP_FAILED`; the
table's last column is the printed cause. Missing `required()` configuration/handles
uses `CONFIG_REQUIRED:<NAME>`; registry configuration uses the distinct codes below.
File-open failures print their errno, without the file path.

`pnpm start:api -- --check` runs `rate_limits`, `secrets`, `database`,
`auth_database`, `database_role`, `encryption_at_rest`, `object_store`,
`registry_release`, `tls_certificate` and `probe_port`, in that order. Each check
writes one stdout JSON line `{"check":"<name>","status":"ok|warn|fail","code":"<CODE>"}`.
Existing telemetry and probe-status events remain; consumers select lines with a
`check` member. `ok` carries `OK`; `warn` carries `TLS_CERT_EXPIRING` when fewer
than 30 days remain. Exit is 0 with no `fail` line, otherwise 1. A failed input
repeats its code for every check that depends on it; independent checks continue.

Failures retain only classified codes: `CONFIG_REQUIRED:<VAR>`, errno, `SECRET_*`,
`DATABASE_ROLE_UNSAFE`, `DATABASE_TLS_CONFIG_INVALID`,
`DATABASE_ENCRYPTION_AT_REST_REQUIRED`, `DATABASE_ENCRYPTION_AT_REST_UNVERIFIED`,
`STORAGE_ENCRYPTION_REQUIRED`, `PROCESSING_CONFIGURATION_*`,
`PROBE_RELEASE_UNAVAILABLE`, `TLS_CERTIFICATE_INVALID`, `TLS_KEY_INVALID`,
`TLS_KEY_MISMATCH`, `TLS_CERT_EXPIRED`, `PROBE_LISTEN_FAILED`,
`PREFLIGHT_CHECK_TIMEOUT` (10 seconds) or `UNCLASSIFIED`. Invalid rate limits and
probe configuration retain their documented codes. A failure before the checks
start (for example telemetry configuration) prints `startup_failed` instead.

The check never listens on `UNAI_API_PORT`, serves, migrates, publishes or writes
an object. It binds the configured probe port only briefly, then closes it; run
it with the API stopped (`ExecStartPre`, ADR 0043 D12 step 7). Created pools and
telemetry are closed; shutdown is bounded to another 10 seconds if a dependency
remains hung.

Probe startup failures are `PROBE_LISTEN_FAILED` and `TLS_CERTIFICATE_INVALID`.
The separate loopback-only HTTP `/healthz` and `/readyz` return status words only.
Readiness is cached for 10 seconds with a 2-second check deadline; bucket verification
is rechecked at most every 5 minutes. Readiness uses the same check functions as
`--check`. A certificate with under 30 days left remains
ready and logs `TLS_CERT_EXPIRING` at most once per day; an expired certificate fails.

Probe binds reject hostnames, IPv4-mapped IPv6, IPv6 zones and padded IPv4 octets
(`127.000.0.1` is not accepted by Node isIPv4). Leading zeroes in ports are decimal
(`09101` means 9101); whitespace is refused. Empty bind uses the default.

| Variable | Required / default | Kind | When read | Consumer | Failure when missing |
| --- | --- | --- | --- | --- | --- |
| `UNAI_GOOGLE_CONNECTOR_CLIENT` | optional; unset or empty makes Google sync refuse `CONNECTOR_OAUTH_CLIENT_MISSING`; ADR 0043 D6 convention: `secret://mounted/google-connector-client` | secret handle; whole JSON secret (no #field) with client_id and client_secret of the Uai connectors client that minted the refresh tokens | runtime construction on normal start, not --check; resolved each token exchange | `packages/api/src/connectors.ts:117` | none when unset; literal: `SECRET_HANDLE_REQUIRED:UNAI_GOOGLE_CONNECTOR_CLIENT`; #field: `CONFIG_INVALID:UNAI_GOOGLE_CONNECTOR_CLIENT` |
| `UNAI_PROBE_PORT` | optional; unset or empty disables probes with one PROBES_DISABLED line; decimal integer 1–65535; ADR 0043 D3 uses 9101 | literal | startup | `packages/api/src/probes.ts:21` | PROBE_PORT_INVALID |
| `UNAI_PROBE_BIND` | optional; 127.0.0.1; loopback IP literal only (127.0.0.0/8 or ::1, including expanded IPv6); no remote override (ADR 0043 D10) | literal | startup when port is set | `packages/api/src/probes.ts:24` | PROBE_BIND_NOT_LOOPBACK |
| `UNAI_API_RATE_LIMIT_PER_MINUTE` | optional; 600 | literal | startup, before database connections | `packages/api/src/server.ts:27` | none; default applies; invalid value gives `CONFIG_INVALID:UNAI_API_RATE_LIMIT_PER_MINUTE` |
| `UNAI_API_AUTH_FAILURE_RATE_LIMIT_PER_MINUTE` | optional; 30 | literal | startup, before database connections | `packages/api/src/server.ts:28` | none; default applies; invalid value gives `CONFIG_INVALID:UNAI_API_AUTH_FAILURE_RATE_LIMIT_PER_MINUTE` |
| `UNAI_OTEL_EXPORTER_OTLP_ENDPOINT` | optional; unset or empty disables export and logs TELEMETRY_DISABLED | URL; HTTPS or loopback HTTP (localhost, 127.0.0.0/8 or [::1]); no credentials, query or fragment | startup via startTelemetry at `packages/api/src/server.ts:8` | `packages/observability/src/telemetry.ts:95` | TELEMETRY_ENDPOINT_INVALID, TELEMETRY_ENDPOINT_INSECURE, TELEMETRY_OTEL_VARIABLES_REFUSED, TELEMETRY_START_FAILED |
| `UNAI_OTEL_EXPORTER_OTLP_HEADERS` | optional; read only with endpoint | secret handle; secret holds OTLP header list name=value,… with percent-encoded values | startup with endpoint | `packages/observability/src/telemetry.ts:102` | SECRET_HANDLE_REQUIRED:UNAI_OTEL_EXPORTER_OTLP_HEADERS, SECRET_* resolution codes, TELEMETRY_HEADERS_INVALID |
| `UNAI_OTEL_METRIC_EXPORT_MS` | optional; 60000; range 1000–3600000 | literal | startup with endpoint | `packages/observability/src/telemetry.ts:99` | TELEMETRY_METRIC_INTERVAL_INVALID |
| `UNAI_DEPLOYMENT_ENVIRONMENT` | optional; production; lowercase token | literal | startup with endpoint | `packages/observability/src/telemetry.ts:100` | TELEMETRY_ENVIRONMENT_INVALID |
| `UNAI_SECRETS_MOUNT` | required; mounted provider directory | file path | startup | `packages/secrets/src/index.ts:107`, `packages/api/src/server.ts:45` | `CONFIG_REQUIRED:UNAI_SECRETS_MOUNT` |
| `UNAI_DATABASE_CA_FILE` | required; trusted PostgreSQL CA | file path | startup | `packages/api/src/server.ts:31` | `CONFIG_REQUIRED:UNAI_DATABASE_CA_FILE` |
| `UNAI_APP_DATABASE_URL` | required; low-privilege application URL handle | secret handle | startup | `packages/api/src/server.ts:34` | `CONFIG_REQUIRED:UNAI_APP_DATABASE_URL` |
| `UNAI_AUTH_DATABASE_URL` | required; auth-role URL handle | secret handle | startup | `packages/api/src/server.ts:38` | `CONFIG_REQUIRED:UNAI_AUTH_DATABASE_URL` |
| `UNAI_S3_ENDPOINT` | required; HTTPS endpoint | URL | startup | `packages/api/src/server.ts:40` | `CONFIG_REQUIRED:UNAI_S3_ENDPOINT` |
| `UNAI_S3_REGION` | required | literal | startup | `packages/api/src/server.ts:40` | `CONFIG_REQUIRED:UNAI_S3_REGION` |
| `UNAI_S3_BUCKET` | required; private encrypted bucket | literal | startup | `packages/api/src/server.ts:40` | `CONFIG_REQUIRED:UNAI_S3_BUCKET` |
| `UNAI_S3_KMS_KEY_ID` | required; exact bucket/receipt key identifier | literal | startup | `packages/api/src/server.ts:40` | `CONFIG_REQUIRED:UNAI_S3_KMS_KEY_ID` |
| `UNAI_REGISTRY_RELEASE_ID` | required UUID | literal | startup | `packages/api/src/processing-config.ts:10` | `PROCESSING_CONFIGURATION_REQUIRED:UNAI_REGISTRY_RELEASE_ID` |
| `UNAI_REGISTRY_RELEASE` | required x.y.z release | literal | startup | `packages/api/src/processing-config.ts:11` | `PROCESSING_CONFIGURATION_REQUIRED:UNAI_REGISTRY_RELEASE` |
| `UNAI_API_TLS_KEY_FILE` | required; listener private-key path | file path | startup | `packages/api/src/server.ts:41` | `CONFIG_REQUIRED:UNAI_API_TLS_KEY_FILE` |
| `UNAI_API_TLS_CERT_FILE` | required; listener certificate path | file path | startup | `packages/api/src/server.ts:41` | `CONFIG_REQUIRED:UNAI_API_TLS_CERT_FILE` |
| `UNAI_API_PORT` | optional; 3443 | literal | startup | `packages/api/src/server.ts:80` | none; default |
| `UNAI_API_BIND` | optional; 127.0.0.1 (loopback) | literal | startup | `packages/api/src/server.ts:80` | none; default |

Rate limits are per API process and per aligned one-minute window; a single-owner
deployment runs one API process. A refused request answers 429 `RATE_LIMITED` with
a whole-second `Retry-After`. Both settings accept integers 1–999999; unset or
empty uses the default. Sessions that already authenticated in this process bypass
the address-failure bucket, but still count against their own session budget.

Malformed registry UUID/version gives `PROCESSING_CONFIGURATION_INVALID`. TLS is
in-process, not terminated at a trusted proxy; these settings do not enable proxy trust.

## Web (pnpm start:web, pnpm dev:web)

Startup begins with startTelemetry, before Next.js or application modules load.
The listener requires a bare canonical HTTPS origin (no userinfo, non-root path,
query or fragment) and takes its port from that origin, defaulting to 443. Invalid
origin shape gives cause `WEB_TLS_CONFIG_INVALID`; unparseable URLs give
`ERR_INVALID_URL`. Startup failures print the `startup_failed` line with
`WEB_STARTUP_FAILED` and the classified cause. TLS files are read before Next
prepares; file-open and bind failures print their errno, never paths or addresses.
The Host check remains enforced. Register `NEXTAUTH_URL` + `/api/auth/callback/google`
as the Google OAuth callback. OAuth client ID is plain configuration; its secret
is a handle. The **resolved** session secret must be at least 32 characters
(`AUTH_CONFIG_REQUIRED`, `packages/auth/src/index.ts:70`).
Before Next.js loads, the listener's pre-auth session gate parses its limit: per
web process and aligned one-minute window, a client address (its TLS socket's,
IPv6 by /64) may fail that many session lookups, after which a token not yet
resolved in this process answers 429 `RATE_LIMITED` with a whole-second
`Retry-After` (integers 1–999999; unset or empty uses 30; `apps/web/CLAUDE.md`).

`pnpm start:web -- --check` runs `rate_limits`, `origin`, `tls_certificate`, `auth` and `api`
in order, using the API preflight JSON line and exit-status contract above. It
parses the session-gate limit, validates the bare HTTPS origin, parses and matches the listener TLS key/cert
(`WEB_TLS_CONFIG_INVALID`), resolves mounted auth secrets and validates the
auth-pool configuration without connecting to the auth database. Next.js never
loads and the web service port is never bound.

The `api` check verifies a TLS handshake against `UNAI_API_CA_FILE` without any
HTTP request. Unreachable before TCP connects (including a 5-second timeout) is
`warn` / `API_UNREACHABLE`: maintenance mode deliberately stops the API while
keeping the web up. Verification/protocol failure or timeout after TCP connects
is `fail` / `API_TLS_HANDSHAKE_FAILED`. Independent checks still run after a
failure; secrets, URLs and raw error text never appear in output.


| Variable | Required / default | Kind | When read | Consumer | Failure when missing |
| --- | --- | --- | --- | --- | --- |
| `UNAI_OTEL_EXPORTER_OTLP_ENDPOINT` | optional; unset or empty disables export and logs TELEMETRY_DISABLED | URL; HTTPS or loopback HTTP (localhost, 127.0.0.0/8 or [::1]); no credentials, query or fragment | startup via startTelemetry at `apps/web/server.ts:30` | `packages/observability/src/telemetry.ts:95` | TELEMETRY_ENDPOINT_INVALID, TELEMETRY_ENDPOINT_INSECURE, TELEMETRY_OTEL_VARIABLES_REFUSED, TELEMETRY_START_FAILED |
| `UNAI_OTEL_EXPORTER_OTLP_HEADERS` | optional; read only with endpoint | secret handle; secret holds OTLP header list name=value,… with percent-encoded values | startup with endpoint | `packages/observability/src/telemetry.ts:102` | SECRET_HANDLE_REQUIRED:UNAI_OTEL_EXPORTER_OTLP_HEADERS, SECRET_* resolution codes, TELEMETRY_HEADERS_INVALID |
| `UNAI_OTEL_METRIC_EXPORT_MS` | optional; 60000; range 1000–3600000 | literal | startup with endpoint | `packages/observability/src/telemetry.ts:99` | TELEMETRY_METRIC_INTERVAL_INVALID |
| `UNAI_DEPLOYMENT_ENVIRONMENT` | optional; production; lowercase token | literal | startup with endpoint | `packages/observability/src/telemetry.ts:100` | TELEMETRY_ENVIRONMENT_INVALID |
| `NEXTAUTH_URL` | required; canonical HTTPS origin | URL | startup | `apps/web/server.ts:60` | `CONFIG_REQUIRED:NEXTAUTH_URL` |
| `NEXTAUTH_URL` | required; compared against Origin on proxied writes | URL | per use | `apps/web/pages/api/platform/[...path].ts:18` | `CONFIG_REQUIRED:NEXTAUTH_URL` (proxy catches as `SERVICE_UNAVAILABLE`) |
| `UNAI_WEB_TLS_KEY_FILE` | required; listener private-key path | file path | startup | `apps/web/server.ts:39` | `CONFIG_REQUIRED:UNAI_WEB_TLS_KEY_FILE` |
| `UNAI_WEB_TLS_CERT_FILE` | required; listener certificate path | file path | startup | `apps/web/server.ts:39` | `CONFIG_REQUIRED:UNAI_WEB_TLS_CERT_FILE` |
| `UNAI_WEB_BIND` | optional; 127.0.0.1 (loopback) | literal | startup | `apps/web/server.ts:71` | none; default |
| `UNAI_WEB_AUTH_FAILURE_RATE_LIMIT_PER_MINUTE` | optional; 30 | literal | startup, before Next.js loads; startup under --check | `apps/web/server.ts:32` | none; default applies; invalid value gives `CONFIG_INVALID:UNAI_WEB_AUTH_FAILURE_RATE_LIMIT_PER_MINUTE` |
| `UNAI_SECRETS_MOUNT` | required when auth or telemetry headers are first needed | file path | first request; at startup when endpoint and UNAI_OTEL_EXPORTER_OTLP_HEADERS are set; startup under --check | `packages/secrets/src/index.ts:107` | `CONFIG_REQUIRED:UNAI_SECRETS_MOUNT` |
| `UNAI_AUTH_DATABASE_URL` | required; auth-role URL handle; pool cached | secret handle | first request; startup under --check | `apps/web/lib/server.ts:20` | `CONFIG_REQUIRED:UNAI_AUTH_DATABASE_URL` |
| `UNAI_DATABASE_CA_FILE` | required; trusted PostgreSQL CA; pool cached | file path | first request; startup under --check | `apps/web/lib/server.ts:21` | `CONFIG_REQUIRED:UNAI_DATABASE_CA_FILE` |
| `GOOGLE_CLIENT_SECRET` | required for auth options; resolved each call | secret handle | per use; startup under --check | `apps/web/lib/server.ts:25` | `CONFIG_REQUIRED:GOOGLE_CLIENT_SECRET` |
| `NEXTAUTH_SECRET` | required; resolved secret at least 32 characters | secret handle | per use; startup under --check | `apps/web/lib/server.ts:25` | `CONFIG_REQUIRED:NEXTAUTH_SECRET` |
| `GOOGLE_CLIENT_ID` | required; plain OAuth client identifier | literal | per use; startup under --check | `apps/web/lib/server.ts:26` | `CONFIG_REQUIRED:GOOGLE_CLIENT_ID` |
| `UNAI_API_ORIGIN` | required; bare HTTPS API origin; no default | URL | per use; startup under --check | `apps/web/lib/server.ts:38`, `apps/web/server.ts:49` | `CONFIG_REQUIRED:UNAI_API_ORIGIN` |
| `UNAI_API_CA_FILE` | required; verifies API TLS certificate | file path | per use; startup under --check | `apps/web/lib/server.ts:42`, `apps/web/server.ts:49` | `CONFIG_REQUIRED:UNAI_API_CA_FILE` |
| `UNAI_OPERATIONS_REPORT_FILE` | optional; no report if absent | file path | per use | `apps/web/lib/operations-status.ts:6` | none; null report |
| `UNAI_REGISTRY_LINT_REPORT_FILE` | optional; no lint report if absent | file path | per use | `apps/web/pages/ops/registry.tsx:13` | none; null report |
| `UNAI_CORPUS_STATUS_FILE` | optional; no corpus status if absent | file path | per use | `apps/web/lib/corpus-status.ts:26` | none; null status |
| `UNAI_PRIVATE_CORPUS_DIR` | optional; adds a forbidden report location; corpus/private-local always forbidden | file path | per use | `apps/web/lib/corpus-status.ts:18` | none; built-in location remains forbidden |

Invalid API origin shape gives `API_TLS_CONFIG_INVALID`. Web table codes describe
configuration helpers, not guaranteed HTTP response codes: request boundaries may
replace them with `SERVICE_UNAVAILABLE` or a generic error. Reports never expose file errors.

## Processing worker (pnpm start:worker)

Startup (`packages/api/src/processing-worker.ts:13-86`): startTelemetry → connector-sync and retention-cleanup intervals/release/owner/
purpose/sensitivity/poll configuration → probe configuration → secrets → model provider → database CA and resolved application
URL → encryption-at-rest check → runtime validation and release comparison → evidence
bucket check. `--check` performs these checks then exits; it does not skip required
model credentials or the bucket check, which prints the API's `STORAGE_ENCRYPTION_REQUIRED`
or `STORAGE_CONFIGURATION_INVALID`. `--once` runs the same checks, then one retention cleanup tick (below; none when its
interval is 0; a failed tick prints `RETENTION_SCHEDULER_TICK_FAILED`, does not stop what
follows and makes the exit code 1) and one connector-sync
scheduling pass (a `connector.read` listing, and one INCREMENTAL `connector.sync` job per
due connector under `jobs.enqueue`), and exits 0 without probes or job turns; it is meant
for timer-driven deployments, whose long-running worker sets the interval to 0. The probe
listener starts after the `--check` return and before the loop; a listen failure gives `PROBE_LISTEN_FAILED`. Its
loopback-only HTTP `/healthz` and `/readyz` carry status words only. The loop check
allows 3× pollMs while idle and 1,800,000 ms while busy (the sum of the extraction,
initiative and connector-sync leases plus 600,000 ms for a retention drain), so a healthy long sync stays ready.
Each turn ends with a connector-sync scheduler tick at the next window boundary, where
window = floor(now / max(interval, per-type minimum)); it skips connectors that are not
ACTIVE or SYNC_FAILED, hold no granted capability, or are of a type without a sync client.
A failed tick prints `CONNECTOR_SCHEDULER_TICK_FAILED` and waits for the next boundary.
Just before it, the retention scheduler runs, once per window = floor(now /
`UNAI_RETENTION_CLEANUP_INTERVAL_MS`), the cleanup `POST /v1/data/retention/cleanup` runs
(`runRetentionCleanup` in `packages/api/src/control.ts`) for this process's owner scope only:
under `data.delete` (audit kind DELETION; the projection replay under `memory.project`), in
passes of at most 50 evidence items until one comes back short, at most 20 per tick. It
prints one `retention.scheduler` JSON line of counts; a failed tick prints
`RETENTION_SCHEDULER_TICK_FAILED` and waits for the next boundary. The window is
process-local, so a restart or each `--once` run repeats the cleanup: idempotent, but an
empty pass still records one DELETION audit row. Raw objects are deleted inside the erasure
transaction, so the worker principal needs `s3:DeleteObject` on the evidence bucket
(ADR 0043 D5) unless the interval is 0.
A single process handles one owner scope and data purpose. Invalid UUIDs, release,
purpose, sensitivity or poll bounds give `PROCESSING_CONFIGURATION_INVALID`.
The table records the **printed** missing-configuration code (exit 1). The
`startup_failed` line retains a variable suffix only for `UNAI_`, `NEXTAUTH_` and
`GOOGLE_` names; other suffixes are discarded. Unknown errors alone use
`PROCESSING_STARTUP_FAILED`.

Probe binds reject hostnames, IPv4-mapped IPv6, IPv6 zones and padded IPv4 octets
(`127.000.0.1` is not accepted by Node isIPv4). Leading zeroes in ports are decimal
(`09101` means 9101); whitespace is refused. Empty bind uses the default.

| Variable | Required / default | Kind | When read | Consumer | Failure when missing |
| --- | --- | --- | --- | --- | --- |
| `UNAI_GOOGLE_CONNECTOR_CLIENT` | optional; unset or empty makes Google sync refuse `CONNECTOR_OAUTH_CLIENT_MISSING`; ADR 0043 D6 convention: `secret://mounted/google-connector-client` | secret handle; whole JSON secret (no #field) with client_id and client_secret of the Uai connectors client that minted the refresh tokens | runtime construction on normal start, not --check; resolved each token exchange | `packages/api/src/connectors.ts:117` | none when unset; literal: `SECRET_HANDLE_REQUIRED:UNAI_GOOGLE_CONNECTOR_CLIENT`; #field: `CONFIG_INVALID:UNAI_GOOGLE_CONNECTOR_CLIENT` |
| `UNAI_PROBE_PORT` | optional; unset or empty disables probes with one PROBES_DISABLED line; decimal integer 1–65535; ADR 0043 D3 uses 9102 | literal | startup | `packages/api/src/probes.ts:21` | PROBE_PORT_INVALID |
| `UNAI_PROBE_BIND` | optional; 127.0.0.1; loopback IP literal only (127.0.0.0/8 or ::1, including expanded IPv6); no remote override (ADR 0043 D10) | literal | startup when port is set | `packages/api/src/probes.ts:24` | PROBE_BIND_NOT_LOOPBACK |
| `UNAI_OTEL_EXPORTER_OTLP_ENDPOINT` | optional; unset or empty disables export and logs TELEMETRY_DISABLED | URL; HTTPS or loopback HTTP (localhost, 127.0.0.0/8 or [::1]); no credentials, query or fragment | startup via startTelemetry at `packages/api/src/processing-worker.ts:13` | `packages/observability/src/telemetry.ts:95` | TELEMETRY_ENDPOINT_INVALID, TELEMETRY_ENDPOINT_INSECURE, TELEMETRY_OTEL_VARIABLES_REFUSED, TELEMETRY_START_FAILED |
| `UNAI_OTEL_EXPORTER_OTLP_HEADERS` | optional; read only with endpoint | secret handle; secret holds OTLP header list name=value,… with percent-encoded values | startup with endpoint | `packages/observability/src/telemetry.ts:102` | SECRET_HANDLE_REQUIRED:UNAI_OTEL_EXPORTER_OTLP_HEADERS, SECRET_* resolution codes, TELEMETRY_HEADERS_INVALID |
| `UNAI_OTEL_METRIC_EXPORT_MS` | optional; 60000; range 1000–3600000 | literal | startup with endpoint | `packages/observability/src/telemetry.ts:99` | TELEMETRY_METRIC_INTERVAL_INVALID |
| `UNAI_DEPLOYMENT_ENVIRONMENT` | optional; production; lowercase token | literal | startup with endpoint | `packages/observability/src/telemetry.ts:100` | TELEMETRY_ENVIRONMENT_INVALID |
| `UNAI_REGISTRY_RELEASE_ID` | required UUID | literal | startup | `packages/api/src/processing-config.ts:10` | `PROCESSING_CONFIGURATION_REQUIRED:UNAI_REGISTRY_RELEASE_ID` |
| `UNAI_REGISTRY_RELEASE` | required x.y.z release | literal | startup | `packages/api/src/processing-config.ts:11` | `PROCESSING_CONFIGURATION_REQUIRED:UNAI_REGISTRY_RELEASE` |
| `UNAI_PROCESSING_OWNER_SCOPE_ID` | required UUID | literal | startup | `packages/api/src/processing-config.ts:18` | `PROCESSING_CONFIGURATION_REQUIRED:UNAI_PROCESSING_OWNER_SCOPE_ID` |
| `UNAI_PROCESSING_ACTOR_ID` | required UUID | literal | startup | `packages/api/src/processing-config.ts:19` | `PROCESSING_CONFIGURATION_REQUIRED:UNAI_PROCESSING_ACTOR_ID` |
| `UNAI_PROCESSING_DATA_PURPOSE` | required; uppercase identifier, at most 64 characters | literal | startup | `packages/api/src/processing-config.ts:21` | `PROCESSING_CONFIGURATION_REQUIRED:UNAI_PROCESSING_DATA_PURPOSE` |
| `UNAI_PROCESSING_MAXIMUM_SENSITIVITY` | required; NORMAL, PRIVATE or RESTRICTED | literal | startup | `packages/api/src/processing-config.ts:22` | `PROCESSING_CONFIGURATION_REQUIRED:UNAI_PROCESSING_MAXIMUM_SENSITIVITY` |
| `UNAI_PROCESSING_POLL_MS` | optional; 1000; integer 100–60000 | literal | startup | `packages/api/src/processing-config.ts:23` | none; default |
| `UNAI_CONNECTOR_SYNC_INTERVAL_MS` | optional; 900000 when unset or empty; integer 60000–86400000, or 0 to disable connector-sync scheduling (one CONNECTOR_SCHEDULER_DISABLED line; the loop never ticks and --once does nothing); GMAIL, GOOGLE_CALENDAR and GITHUB never faster than 300000, OMI never faster than 900000 | literal | startup | `packages/api/src/processing-config.ts:31` | none; default. Out of range or not an integer: `CONFIG_INVALID:UNAI_CONNECTOR_SYNC_INTERVAL_MS` |
| `UNAI_RETENTION_CLEANUP_INTERVAL_MS` | optional; 86400000 when unset or empty; integer 3600000–86400000, or 0 to disable the scheduled retention cleanup (one RETENTION_SCHEDULER_DISABLED line; the loop never cleans and --once makes no retention cleanup) | literal | startup | `packages/api/src/processing-config.ts:41` | none; default. Out of range or not an integer: `CONFIG_INVALID:UNAI_RETENTION_CLEANUP_INTERVAL_MS` (`--check` exits 1) |
| `UNAI_SECRETS_MOUNT` | required | file path | startup | `packages/secrets/src/index.ts:107` | `CONFIG_REQUIRED:UNAI_SECRETS_MOUNT` |
| `UNAI_MODEL_PROVIDER` | required; registered provider (anthropic or openai bundled) | literal | startup | `packages/model/src/providers.ts:173` | `MODEL_CONFIG_REQUIRED` |
| `UNAI_MODEL_ENDPOINT` | required; HTTPS provider endpoint | URL | startup | `packages/model/src/providers.ts:177` | `MODEL_CONFIG_REQUIRED` |
| `UNAI_MODEL_ID` | required; provider model ID | literal | startup | `packages/model/src/providers.ts:177` | `MODEL_CONFIG_REQUIRED` |
| `UNAI_MODEL_API_KEY` | required; model credential handle | secret handle | startup | `packages/model/src/providers.ts:179` | `CONFIG_REQUIRED:UNAI_MODEL_API_KEY` |
| `UNAI_MODEL_INPUT_MICROUNITS_PER_1K` | required; finite nonnegative input cost per 1000 tokens | literal | startup | `packages/model/src/providers.ts:183` | `MODEL_CONFIG_REQUIRED` |
| `UNAI_MODEL_OUTPUT_MICROUNITS_PER_1K` | required; finite nonnegative output cost per 1000 tokens | literal | startup | `packages/model/src/providers.ts:184` | `MODEL_CONFIG_REQUIRED` |
| `UNAI_MODEL_API_VERSION` | optional; anthropic defaults to 2023-06-01; unused by openai | literal | startup | `packages/model/src/providers.ts:186` | none; provider default |
| `UNAI_DATABASE_CA_FILE` | required; trusted PostgreSQL CA | file path | startup | `packages/api/src/processing-worker.ts:37` | `PROCESSING_CONFIGURATION_REQUIRED:UNAI_DATABASE_CA_FILE` |
| `UNAI_APP_DATABASE_URL` | required; application-role URL handle | secret handle | startup | `packages/api/src/processing-worker.ts:38` | `CONFIG_REQUIRED:UNAI_APP_DATABASE_URL` |
| `UNAI_S3_ENDPOINT` | required; HTTPS endpoint | URL | startup | `packages/api/src/processing-worker.ts:51` | `PROCESSING_CONFIGURATION_REQUIRED:UNAI_S3_ENDPOINT` |
| `UNAI_S3_REGION` | required | literal | startup | `packages/api/src/processing-worker.ts:51` | `PROCESSING_CONFIGURATION_REQUIRED:UNAI_S3_REGION` |
| `UNAI_S3_BUCKET` | required; private encrypted bucket | literal | startup | `packages/api/src/processing-worker.ts:52` | `PROCESSING_CONFIGURATION_REQUIRED:UNAI_S3_BUCKET` |
| `UNAI_S3_KMS_KEY_ID` | required; exact bucket/receipt key identifier | literal | startup | `packages/api/src/processing-worker.ts:52` | `PROCESSING_CONFIGURATION_REQUIRED:UNAI_S3_KMS_KEY_ID` |

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
| `UNAI_DATABASE_CA_FILE` | required; canonical; trusted PostgreSQL CA | file path | startup | `packages/postgres/src/database-ca.ts:8` | `MIGRATION_TLS_CONFIGURATION_REQUIRED`, after the stderr line `CONFIG_REQUIRED:UNAI_DATABASE_CA_FILE` when neither CA variable is set |
| `UNAI_DATABASE_CA_PATH` | deprecated alias of `UNAI_DATABASE_CA_FILE`; prints `CONFIG_DEPRECATED_ALIAS:UNAI_DATABASE_CA_PATH` once; a different value from `UNAI_DATABASE_CA_FILE` throws `CONFIG_CONFLICT:UNAI_DATABASE_CA_FILE` | file path | startup | `packages/postgres/src/database-ca.ts:8` | none; `UNAI_DATABASE_CA_FILE` is used |

### pnpm uai registry publish

| Variable | Required / default | Kind | When read | Consumer | Failure when missing |
| --- | --- | --- | --- | --- | --- |
| `UNAI_MIGRATION_DATABASE_URL` | required; literal privileged connection URL, not a handle | URL | startup | `packages/registry/src/cli.ts:162` | `REGISTRY_PUBLISH_CONFIGURATION_REQUIRED` |
| `UNAI_DATABASE_CA_FILE` | required; canonical; trusted PostgreSQL CA | file path | startup | `packages/postgres/src/database-ca.ts:8` | `REGISTRY_PUBLISH_CONFIGURATION_REQUIRED`, after the stderr line `CONFIG_REQUIRED:UNAI_DATABASE_CA_FILE` when neither CA variable is set |
| `UNAI_DATABASE_CA_PATH` | deprecated alias of `UNAI_DATABASE_CA_FILE`; prints `CONFIG_DEPRECATED_ALIAS:UNAI_DATABASE_CA_PATH` once; a different value from `UNAI_DATABASE_CA_FILE` fails with the JSON code `CONFIG_CONFLICT:UNAI_DATABASE_CA_FILE` | file path | startup | `packages/postgres/src/database-ca.ts:8` | none; `UNAI_DATABASE_CA_FILE` is used |

### pnpm uai registry projection-replay

| Variable | Required / default | Kind | When read | Consumer | Failure when missing |
| --- | --- | --- | --- | --- | --- |
| `UNAI_DATABASE_URL` | required; literal low-privilege application connection URL, not a handle | URL | startup | `packages/registry/src/cli.ts:179` | `PROJECTION_REPLAY_CONFIGURATION_REQUIRED` |
| `UNAI_DATABASE_CA_FILE` | required; canonical; trusted PostgreSQL CA | file path | startup | `packages/postgres/src/database-ca.ts:8` | `PROJECTION_REPLAY_CONFIGURATION_REQUIRED`, after the stderr line `CONFIG_REQUIRED:UNAI_DATABASE_CA_FILE` when neither CA variable is set |
| `UNAI_DATABASE_CA_PATH` | deprecated alias of `UNAI_DATABASE_CA_FILE`; prints `CONFIG_DEPRECATED_ALIAS:UNAI_DATABASE_CA_PATH` once; a different value from `UNAI_DATABASE_CA_FILE` fails with the JSON code `CONFIG_CONFLICT:UNAI_DATABASE_CA_FILE` | file path | startup | `packages/postgres/src/database-ca.ts:8` | none; `UNAI_DATABASE_CA_FILE` is used |

### pnpm uai registry shadow-diff

Only `--sample owner` needs the database. `--sample corpus:private` reads the private
corpus directory; the synthetic corpus needs neither credential nor private path.

| Variable | Required / default | Kind | When read | Consumer | Failure when missing |
| --- | --- | --- | --- | --- | --- |
| `UNAI_DATABASE_URL` | required for owner sample; literal connection URL, not a handle | URL | per use | `packages/registry/src/cli.ts:122` | `SHADOW_OWNER_SAMPLE_CONFIGURATION_REQUIRED` |
| `UNAI_DATABASE_CA_FILE` | required for owner sample; canonical | file path | per use | `packages/postgres/src/database-ca.ts:8` | `SHADOW_OWNER_SAMPLE_CONFIGURATION_REQUIRED`, after the stderr line `CONFIG_REQUIRED:UNAI_DATABASE_CA_FILE` when neither CA variable is set |
| `UNAI_DATABASE_CA_PATH` | deprecated alias of `UNAI_DATABASE_CA_FILE` for owner sample; prints `CONFIG_DEPRECATED_ALIAS:UNAI_DATABASE_CA_PATH` once; a different value from `UNAI_DATABASE_CA_FILE` fails with the JSON code `CONFIG_CONFLICT:UNAI_DATABASE_CA_FILE` | file path | per use | `packages/postgres/src/database-ca.ts:8` | none; `UNAI_DATABASE_CA_FILE` is used |
| `UNAI_PRIVATE_CORPUS_DIR` | optional; corpus/private-local relative to repository | file path | per use | `packages/registry/src/corpus.ts:59` | none; default |

### pnpm uai corpus import, annotate, run, verify and status

| Variable | Required / default | Kind | When read | Consumer | Failure when missing |
| --- | --- | --- | --- | --- | --- |
| `UNAI_PRIVATE_CORPUS_DIR` | optional; corpus/private-local; used for private corpus operations | file path | per use | `packages/registry/src/corpus.ts:59` | none; default |

### pnpm backup

`scripts/backup.mjs` reads every row below in this order before any network or database
work, and `--help` reads none of them; a local-directory destination reads none of the
four rows marked `s3://` only. Every failure is one stderr JSON line
`{"event":"backup.failed","code":…}`; only `BACKUP_CONFIGURATION_REQUIRED` and
`BACKUP_CONFIGURATION_INVALID` add a `variable` naming the row. An empty optional value
counts as unset. Procedure: `docs/operations/backup.md`.

| Variable | Required / default | Kind | When read | Consumer | Failure when missing |
| --- | --- | --- | --- | --- | --- |
| `UNAI_BACKUP_DESTINATION` | required; an existing writable absolute directory, or `s3://<bucket>/<prefix>/` for the ADR 0043 D9 backup bucket: a lowercase bucket name, then zero or more `[A-Za-z0-9._-]` segments each ending in `/`, none `.` or `..`, at most 512 bytes of prefix | file path or URL | startup | `scripts/backup.mjs:155` | `BACKUP_CONFIGURATION_REQUIRED`; `BACKUP_DESTINATION_INVALID`, which also covers an `s3://` bucket equal to `UNAI_S3_BUCKET` or a backup key equal to `UNAI_S3_KMS_KEY_ID` |
| `UNAI_BACKUP_STAGING_DIR` | `s3://` only: required with an `s3://` destination, not read otherwise; an existing, writable, empty absolute directory on the data volume, never tmpfs (ADR 0043 D9), where the archive and both sidecars are written and verified before upload; its free space must exceed the last run's `bytes`; the run removes its own files on success and on failure | file path | startup | `scripts/backup.mjs:158` | `BACKUP_CONFIGURATION_REQUIRED`; missing, relative, unwritable or non-empty `BACKUP_CONFIGURATION_INVALID` |
| `UNAI_BACKUP_KEY_FILE` | required; exactly 32 bytes, mode 0600 on POSIX, a regular file outside the destination and the staging directory | file path | startup | `scripts/backup.mjs:161` | `BACKUP_CONFIGURATION_REQUIRED`; `BACKUP_KEY_LOCATION_INVALID`; `BACKUP_KEY_INVALID` |
| `UNAI_BACKUP_RETENTION_DAYS` | optional, local directory only; unset keeps every archive; 1–3650 | literal | startup | `scripts/backup.mjs:162` | none; no pruning; bad value `BACKUP_RETENTION_INVALID`; any value with an `s3://` destination `BACKUP_CONFIGURATION_INVALID`, because the bucket's lifecycle rule owns retention and the principal cannot delete |
| `UNAI_BACKUP_DATABASE_URL` | required; literal `postgres(ql)://user@host[:port]/database` URL with no password, query or fragment; the role must be superuser or BYPASSRLS; password from PGPASSFILE | URL | startup | `scripts/backup.mjs:163` | `BACKUP_CONFIGURATION_REQUIRED`; `BACKUP_DATABASE_URL_INVALID` |
| `PGPASSWORD` | refused when set, even empty: the password belongs in PGPASSFILE | literal | startup | `scripts/backup.mjs:164` | none; set gives `BACKUP_CONFIGURATION_INVALID` |
| `UNAI_DATABASE_CA_FILE` | required; trusted PostgreSQL CA, also pg_dump's PGSSLROOTCERT | file path | startup | `scripts/backup.mjs:165` | `BACKUP_CONFIGURATION_REQUIRED`; unreadable or empty `BACKUP_CONFIGURATION_INVALID` |
| `UNAI_S3_ENDPOINT` | required; evidence bucket endpoint | URL | startup | `scripts/backup.mjs:168` | `BACKUP_CONFIGURATION_REQUIRED` |
| `UNAI_S3_REGION` | required | literal | startup | `scripts/backup.mjs:168` | `BACKUP_CONFIGURATION_REQUIRED` |
| `UNAI_S3_BUCKET` | required; private encrypted evidence bucket, read only; never the backup bucket | literal | startup | `scripts/backup.mjs:169` | `BACKUP_CONFIGURATION_REQUIRED`; bucket check `BACKUP_EVIDENCE_STORE_UNAVAILABLE`; an `s3://` destination naming it `BACKUP_DESTINATION_INVALID` |
| `UNAI_S3_KMS_KEY_ID` | required; exact bucket/receipt key identifier; live evidence rows must name `kms:<this id>`; never the backup key | literal | startup | `scripts/backup.mjs:169` | `BACKUP_CONFIGURATION_REQUIRED`; `BACKUP_EVIDENCE_PROVIDER_UNKNOWN`; equal to `UNAI_BACKUP_S3_KMS_KEY_ID` `BACKUP_DESTINATION_INVALID` |
| `UNAI_BACKUP_S3_ENDPOINT` | `s3://` only: required with an `s3://` destination, not read otherwise; the backup bucket's HTTPS endpoint in its own region, with no userinfo, query or fragment | URL | startup | `scripts/backup.mjs:120` | `BACKUP_CONFIGURATION_REQUIRED`; not such an https URL `BACKUP_CONFIGURATION_INVALID` |
| `UNAI_BACKUP_S3_REGION` | `s3://` only: required with an `s3://` destination, not read otherwise; the backup bucket's region | literal | startup | `scripts/backup.mjs:124` | `BACKUP_CONFIGURATION_REQUIRED` |
| `UNAI_BACKUP_S3_KMS_KEY_ID` | `s3://` only: required with an `s3://` destination, not read otherwise; the full key ARN behind `alias/unai-backup`, which every upload receipt must echo; never an alias | literal | startup | `scripts/backup.mjs:125` | `BACKUP_CONFIGURATION_REQUIRED`; `alias/…` or an ARN with `:alias/` `BACKUP_CONFIGURATION_INVALID`; a receipt naming another key `BACKUP_DESTINATION_ENCRYPTION_INVALID` |
| `UNAI_BACKUP_PG_DUMP` | optional; `pg_dump` on PATH; one executable path or a JSON array command prefix; its major must equal the server's | literal | startup | `scripts/backup.mjs:171` | none; default; bad value `BACKUP_CONFIGURATION_INVALID` |

The pg_dump child inherits the environment without any variable starting with `PG`
except `PGPASSFILE` (`scripts/backup.mjs:200`), then gets `PGHOST`, `PGPORT`, `PGUSER`,
`PGDATABASE` from the URL, `PGSSLMODE=verify-full`, `PGSSLROOTCERT`,
`PGCONNECT_TIMEOUT=10` and `PGAPPNAME=unai-backup`. Both S3 clients, the evidence read
and the backup-bucket write, take credentials only from the SDK default chain below, as
the API does; under ADR 0043 D9 the chain reads the `unai-backup` IAM user's
`/etc/unai/backup/aws-credentials` through `AWS_SHARED_CREDENTIALS_FILE`.

## Test and development harness

Never deliver an owner's production database or bucket. Tests create/drop databases,
roles and objects. With no delivered database the harness provisions disposable
pgvector; storage uses delivered S3, else MinIO, else the in-process encrypted store.
`*.test.*` reads are excluded from the guard; these rows describe harness source.

| Variable | Required / default | Kind | When read | Consumer | Failure when missing |
| --- | --- | --- | --- | --- | --- |
| `UNAI_TEST_DATABASE_URL` | optional; takes precedence over DATABASE_URL; else disposable container | URL | startup | `scripts/test.mjs:33` | none; provisions database; provisioning failure `DATABASE_PROVISIONING_FAILED` |
| `DATABASE_URL` | optional; fallback delivered disposable-server URL | URL | startup | `scripts/test.mjs:33` | none; provisions database |
| `UNAI_TEST_MAX_WORKERS` | optional; 4; decimal 1 to 64 | literal | startup | `scripts/test-stages.mjs:19` | none; default 4. Any other value: `TEST_MAX_WORKERS_INVALID` before provisioning |
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

The dev orchestrator is not a production start script. `scripts/dev-stack.mjs:19,150`
refuses any set environment key containing `DATABASE` or matching its PG selector
(HOST, HOSTADDR, PORT, DATABASE, USER, PASSWORD, PASSFILE, SERVICE, SERVICEFILE,
SYSCONFDIR, SSLMODE, SSLROOTCERT), with `DEV_STACK_EXTERNAL_DATABASE_REFUSED`.
Its child passthrough at `:22-24` allows only PATH, SYSTEMROOT, WINDIR, TEMP, TMP, HOME,
USERPROFILE, LANG and LC_ALL (case-insensitive). These pattern reads are described
here, not expanded into guard rows.

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
| Any variable starting with OTEL_ | refused when UNAI_OTEL_EXPORTER_OTLP_ENDPOINT is set; exporter configuration comes only from UNAI_OTEL_* rows | dependency configuration | startup | @opentelemetry/sdk-node 0.223.0 and OTLP exporters | TELEMETRY_OTEL_VARIABLES_REFUSED when present with endpoint; no requirement otherwise |
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
| `PGPASSFILE` | optional; ~/.pgpass (%APPDATA%\postgresql\pgpass.conf on Windows); the `pnpm backup` password source, mode 0600 | file path | per use | libpq for pg_dump; pg 8.23.0 `lib/client.js:299` through pgpass 1.0.5 `lib/helper.js:58-61` when the URL has no password | no password: authentication fails, `BACKUP_DATABASE_FAILED` |
| `PGSSLMODE` | pg fallback only when ssl is unspecified; overridden by application explicit ssl | literal | per use | pg 8.23.0 `lib/connection-parameters.js:25-37,85` | none; application TLS remains verified |
| `PGCONNECT_TIMEOUT` | pg fallback only without connectionTimeoutMillis; app explicitly supplies 5000 ms | literal | per use | pg 8.23.0 `lib/connection-parameters.js:126-129` | none; application timeout remains 5 s |

The active web route (`apps/web/pages/api/auth/[...nextauth].ts:7`) calls NextAuth with
`await authOptions()`. `packages/auth/src/index.ts:72` supplies resolved `secret`, so
next-auth's Pages-handler fallback at `next/index.js:17` does **not** read the handle
as a secret on this path. Its JWT/middleware fallback would read the raw environment
if used without an explicit secret; that is not how the current route works.
PostgreSQL's explicit `{ca, rejectUnauthorized:true}` overrides `PGSSLMODE`, and the
URL-query ban prevents pg's parsed connection options from replacing that object.
