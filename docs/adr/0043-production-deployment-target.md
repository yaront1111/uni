# ADR 0043: Production deployment target and topology

Date: 2026-11-02

Status: Accepted. Owner decisions recorded 2026-11-02 (Context). Recorded before
any deploy artifact, probe, backup automation or runbook it governs (PRD §0
rule 7).

## Context

**Purpose.** Epic epic-08b55f45867a480b8b756dedba29cf13 takes Uai from a suite
that passes against a disposable harness to a single-owner deployment the owner
runs every day. The deploy bundle, probes, backups and runbooks of that epic are
built against the one target recorded here. PRD §0 rule 7 requires any deviation
to be recorded before the code; PRD §28 is the reference stack; PRD §30.5 sets
the encryption, secrets and transport requirements; PRD §41 Reliability sets the
backup, restore and upgrade bar.

**Owner decisions.** The owner answered three questions in the architect's
interactive planning session on 2026-11-02. Task comment
comment-37a6626aa433431ba856336df852a5ea records them verbatim; they are quoted
here exactly as recorded there.

Q1 (asked 2026-11-02):

> "ADR 0043 needs your hosting target. Production must run PostgreSQL 17 + pgvector 0.8 to match the pinned test image (the governor's options said 16). Which target should the ADR record?"

Owner's answer (2026-11-02): "A: one Linux VPS (Recommended)"

Text of the option the owner selected:

> "Ubuntu 24.04 LTS running api + web + worker under systemd. PostgreSQL 17 + pgvector sits on a LUKS2 data volume whose key is wrapped by AWS KMS, and evidence goes to AWS S3 + KMS. The web reads Let's Encrypt cert files in-process; the API stays loopback-only behind a private-CA cert."

Q2 (asked 2026-11-02):

> "The Gmail and Calendar connectors use Google restricted/sensitive scopes. Google's docs (checked today) say External apps in 'Testing' get refresh tokens that expire after 7 days, while a personal-use app 'In production' may stay unverified behind a click-through warning. Which setup fits your Google account?" (options offered: "Workspace org: Internal client" / "Gmail: External, In production" / "External, Testing")

Owner's answer (2026-11-02, free text): "any"

The comment adds the architect's reading of "any", which D6 adopts. It is the
architect's interpretation, not the owner's:

> Architect's interpretation (not the owner's words): either production-grade setup is acceptable, chosen by account type — an Internal client when the account belongs to a Workspace org the owner administers, otherwise External + In production (unverified, under Google's personal-use exemption). Testing status is not used in production because of its 7-day refresh-token expiry.

Q3 (asked 2026-11-02):

> "Which Anthropic model should the worker's extraction be pinned to? The code caps each run at 20,000 microunits (USD millionths) for FULL and 4,000 for ENTITY extraction, with a 2,048-token output cap that includes thinking tokens. A call over budget is billed by Anthropic and then rejected."

Owner's answer (2026-11-02): "Claude Sonnet 5.5"

Text of the option the owner selected:

> "$2/$10 per million tokens, so 2,000/10,000 per 1k. A typical full run (~3k tokens in, 1k out, about 16,000) fits, but long outputs go over 20,000 and nearly every entity run goes over 4,000 unless the budgets are raised."

**Facts the decisions rest on** (read from master on 2026-11-02):

- packages/api/src/server.ts:11-25, API startup order: secrets manager on
  `UNAI_SECRETS_MOUNT`; `UNAI_DATABASE_CA_FILE`; `UNAI_APP_DATABASE_URL` and
  `UNAI_AUTH_DATABASE_URL` resolved as handles; the encryption-at-rest
  assertion; `UNAI_S3_ENDPOINT`/`_REGION`/`_BUCKET`/`_KMS_KEY_ID` and the live
  bucket check; `UNAI_REGISTRY_RELEASE_ID` and `UNAI_REGISTRY_RELEASE`;
  `UNAI_API_TLS_KEY_FILE` and `UNAI_API_TLS_CERT_FILE` read once; listen on
  `UNAI_API_PORT ?? 3443` and `UNAI_API_BIND ?? 127.0.0.1`. SIGTERM closes the
  app and pools (server.ts:26).
- packages/api/src/index.ts:30-31: TLS 1.2 minimum and `trustProxy: false`.
- apps/web/server.ts:5-15: `NEXTAUTH_URL` must be a bare https origin; a Host
  mismatch answers 421; `UNAI_WEB_TLS_KEY_FILE` and `UNAI_WEB_TLS_CERT_FILE` are
  read once (line 10); bind `UNAI_WEB_BIND ?? 127.0.0.1`.
- apps/web/lib/server.ts:13-22: `UNAI_AUTH_DATABASE_URL`,
  `GOOGLE_CLIENT_SECRET` and `NEXTAUTH_SECRET` arrive as handles;
  `GOOGLE_CLIENT_ID` is plain configuration. Lines 31-35: `UNAI_API_ORIGIN`
  must be a bare https origin and `UNAI_API_CA_FILE` is the only CA trusted for
  the API leg.
- packages/api/src/processing-worker.ts:11-25 and processing-config.ts:15-24:
  one owner scope, actor, data purpose and sensitivity ceiling per worker
  (`UNAI_PROCESSING_OWNER_SCOPE_ID`, `_ACTOR_ID`, `_DATA_PURPOSE`,
  `_MAXIMUM_SENSITIVITY`); the model provider from `UNAI_MODEL_*`
  (packages/model/src/providers.ts:151-173); `--check` validates and exits.
- packages/postgres/src/index.ts:13: every pool has `max: 10`; line 10 refuses a
  connection URL with a query string.
- packages/postgres/src/encryption.ts:21: the declaration must match
  `^(volume-kms|tde|managed):[A-Za-z0-9:/_.@+-]{1,200}$`.
- packages/storage/src/index.ts:24-32: path-style addressing is forced, and the
  bucket must have exactly one `aws:kms` default rule whose `KMSMasterKeyID`
  equals the configured key by exact string; lines 48-52 repeat the check on
  every read and write receipt.
- scripts/postgres-harness.mjs:2: the pinned harness image runs PostgreSQL 17.11
  + pgvector 0.8.6 on Debian 12 (read from the image on 2026-11-02).
- Verified 2026-11-02 in a throwaway container of that image: a non-superuser
  CREATEROLE role running migration 0001's
  `ALTER ROLE unai_app NOLOGIN NOSUPERUSER … NOBYPASSRLS` fails with "Only roles
  with the SUPERUSER attribute may change the SUPERUSER attribute", and
  `CREATE EXTENSION vector` fails with "Must be superuser to create this
  extension" (vector 0.8.6: trusted = f).

## D1 Host and topology

**Host.**

- One VPS from any provider that offers a static IPv4 address and an attachable
  block volume.
- Ubuntu Server 24.04 LTS x86_64, timezone Etc/UTC.
- Minimum 2 vCPU and 4 GB RAM; 8 GB recommended because `next build` runs on
  the host.
- No swap, or encrypted swap only.

**Processes.**

- Three systemd units: `unai-api.service`, `unai-web.service` and
  `unai-worker.service`.
- Each runs as its own system user (`unai-api`, `unai-web`, `unai-worker`), so a
  compromised internet-facing web process cannot read API or worker secrets
  (D6).
- Releases live in `/opt/unai/releases/<git-tag>`, with `/opt/unai/current`
  pointing at the active one. Root-owned, mode 0755, no secrets in the tree.
- Toolchain: Node 24 and pnpm 11.0.8. `pnpm install --frozen-lockfile` keeps
  devDependencies, because the entry points run through `tsx`, a root
  devDependency (`devDependencies.tsx` in package.json). The web needs `pnpm build`.
- `ExecStart` runs `node --import tsx <entry>` directly, with no pnpm wrapper,
  so SIGTERM reaches the handlers at packages/api/src/server.ts:26,
  apps/web/server.ts:16 and packages/api/src/processing-worker.ts:19.
- `Restart=on-failure`. Units are sandboxed with `NoNewPrivileges=yes`,
  `ProtectSystem=strict`, `ProtectHome=yes` and `PrivateTmp=yes`.

**PostgreSQL.** Version 17 + pgvector 0.8.x (at least 0.8.6, pinned to the 0.8
series) from the PGDG apt repository, on the same host. This matches the
harness major and extension versions, as the prerequisites of
docs/operations/restore.md require ("matching PostgreSQL/pgvector versions").

**Evidence objects.** AWS S3 + KMS (D5). No Docker on the host.

**Process per owner.** One owner scope per worker by design
(`UNAI_PROCESSING_OWNER_SCOPE_ID`/`_ACTOR_ID`; ADR 0038). This deployment serves
one owner, so it runs one worker; a second owner is out of scope.

**Network.**

- ufw denies all inbound traffic except 22/tcp (SSH, keys only), 80/tcp (ACME
  HTTP-01 only, D2) and 443/tcp.
- Outbound traffic goes to Google APIs, api.anthropic.com, AWS S3/KMS and
  Let's Encrypt.

Cites PRD §28, PRD §41 Portability and Reliability, ADR 0038 and ADR 0008.

## D2 TLS strategy (ADR 0008)

**General.**

- Every listener terminates TLS in its own process: no reverse proxy, L7 load
  balancer, CDN or tunnel. ADR 0008: "Run Next.js and Fastify behind their own
  TLS listeners; forwarded-proto is not a substitute for an encrypted socket."
- `trustProxy: false` stays (packages/api/src/index.ts:31) and forwarded headers
  are never trusted. No decision in this ADR introduces proxy-header trust.
- TLS 1.2 minimum on every listener. An L4 passthrough would be compatible but
  is not used; any other termination point needs a successor ADR.

**Web.**

- Let's Encrypt certificate from the Ubuntu `certbot` package, HTTP-01 in
  `--standalone` mode on port 80, ECDSA key.
- Nothing else listens on port 80 and there is no redirect listener; HSTS is
  already set (apps/web/server.ts:11).
- Renewal runs from `certbot.timer`. The deploy hook
  `/etc/letsencrypt/renewal-hooks/deploy/unai-web.sh` (installed from
  `deploy/certbot-deploy-hook.sh` by task-90ac39b69040428c84bc7f5187a3fc83)
  copies `fullchain.pem` to `/etc/unai/tls/web/cert.pem` and `privkey.pem` to
  `/etc/unai/tls/web/key.pem` (root:unai-web 0640), then runs
  `systemctl restart unai-web`. A restart is needed because the web reads its
  key and certificate once at startup (apps/web/server.ts:10).
- `UNAI_WEB_TLS_CERT_FILE` and `UNAI_WEB_TLS_KEY_FILE` point at those copies,
  never into `/etc/letsencrypt`.

**API.**

- A host-local "Uai internal CA": ECDSA P-256, 10-year validity, key at
  `/etc/unai/tls/ca/ca.key` (root:root 0400), certificate at
  `/etc/unai/tls/ca/ca.pem` (0644).
- API leaf certificate: SAN `IP:127.0.0.1`, 365 days, at
  `/etc/unai/tls/api/cert.pem` and `/etc/unai/tls/api/key.pem`
  (root:unai-api 0640). `UNAI_API_CA_FILE=/etc/unai/tls/ca/ca.pem` for the web.
- Why: the browser never calls the API (the same-origin proxy does, through
  apps/web/lib/server.ts:30-35), a public CA cannot certify 127.0.0.1, and
  ADR 0008 already requires "trusted database and API CA certificates".
- The leaf is renewed at least 30 days before expiry through the rotation
  runbook, then `unai-api` is restarted, because the API reads its TLS files
  once (packages/api/src/server.ts:24). The D10 readiness check
  `tls_certificate` reports `fail` within 7 days of expiry.

**PostgreSQL.**

- Server leaf from the same internal CA with SAN `IP:127.0.0.1` and
  `DNS:localhost`, issued together with the API leaf so one expiry warning
  covers both.
- `ssl = on`, `ssl_min_protocol_version = 'TLSv1.2'`.
- `UNAI_DATABASE_CA_FILE` (runtime processes) and `UNAI_DATABASE_CA_PATH` (the
  migration and registry CLIs) both point at `/etc/unai/tls/ca/ca.pem`.

Cites ADR 0008 and PRD §30.5 ("Encrypt data in transit and at rest").

## D3 Names, origins, bind addresses and ports

- Public name `uai.<owner-domain>`. The real name lives only in the host env
  files, never in Git.
- DNS: an A record to `<host-ipv4>`. No AAAA record unless IPv6 works end to
  end, because Let's Encrypt prefers IPv6. CAA record: `0 issue "letsencrypt.org"`.
- `NEXTAUTH_URL=https://uai.<owner-domain>` (port 443; a Host mismatch answers
  421, apps/web/server.ts:12).
- `UNAI_WEB_BIND=0.0.0.0`. `unai-web` gets
  `AmbientCapabilities=CAP_NET_BIND_SERVICE` to bind 443 without root.
- `UNAI_API_BIND=127.0.0.1`, `UNAI_API_PORT=3443`,
  `UNAI_API_ORIGIN=https://127.0.0.1:3443`. The IP, not `localhost`, so the name
  never resolves to ::1 while the API listens on IPv4.
- PostgreSQL: `127.0.0.1:5432`, database `unai`.
- Probe listeners: API `127.0.0.1:9101`, worker `127.0.0.1:9102` (D10). OTLP
  collector: `127.0.0.1:4318` (D8).
- Google sign-in client: JavaScript origin `https://uai.<owner-domain>`,
  redirect URI `https://uai.<owner-domain>/api/auth/callback/google` (Auth.js
  route apps/web/pages/api/auth/[...nextauth].ts).

Cites ADR 0008 (Host check, own TLS listeners) and PRD §30.5.

## D4 PostgreSQL

**Version and install.** As D1: PostgreSQL 17 + pgvector 0.8.x from PGDG.

**Data volume.**

- The data directory sits on a dedicated block volume encrypted with LUKS2
  (`aes-xts-plain64`, 512-bit key, argon2id), mapped as `unai-pgdata` and
  mounted at `/var/lib/postgresql` before the cluster is created.
- Volume key: 64 random bytes. They exist only as an AWS KMS ciphertext at
  `/etc/unai/pgdata/volume-key.enc` (root:root 0400) under the dedicated
  customer-managed key `alias/unai-pgdata`. The plaintext never touches disk.
- At boot the oneshot `unai-pgdata-unlock.service`, ordered before PostgreSQL,
  runs `aws kms decrypt` and pipes the plaintext into
  `cryptsetup open --key-file=-`.
- Unlock credentials: IAM user `unai-host-unlock`, allowed only `kms:Decrypt`
  on that key, with the key-policy condition `aws:SourceIp = <host-ipv4>`. File:
  `/etc/unai/pgdata/aws-credentials` (root:root 0400).
- LUKS keyslot 1 holds a random recovery passphrase that the owner keeps offline
  with the backup key (D9).

**Exact declaration.** Provisioning sets it as the `postgres` superuser:

```sql
ALTER DATABASE unai SET unai.encryption_at_rest =
  'volume-kms:arn:aws:kms:<aws-region>:<aws-account-id>:key/<pgdata-key-id>';
```

For example, with AWS's documentation account id,
`volume-kms:arn:aws:kms:eu-central-1:111122223333:key/1234abcd-12ab-34cd-56ef-1234567890ab`
matches `^(volume-kms|tde|managed):[A-Za-z0-9:/_.@+-]{1,200}$`
(packages/postgres/src/encryption.ts:21).

**Evidence.** The declaration is configuration, not proof: the provider keeps
the evidence (encryption.ts comment; ADR 0002; ADR 0032 §4). The operator keeps
this evidence outside Git:

- `cryptsetup luksDump` showing LUKS2, `aes-xts-plain64`, 512-bit key.
- `lsblk -o NAME,TYPE,FSTYPE,MOUNTPOINT` showing `crypto_LUKS`, then
  `unai-pgdata`, then `/var/lib/postgresql`.
- `aws kms describe-key --key-id alias/unai-pgdata`: Enabled, customer-managed.
- The CloudTrail `Decrypt` event of each boot.

**Roles.** Provisioning creates the login roles before the first migration, with
passwords taken from psql `\set` variables, never literals.

| Role | Attributes | Membership | Connection limit | Used by |
|---|---|---|---|---|
| `unai_migrator` | LOGIN SUPERUSER, owns database `unai` | — | 5 | `pnpm db:migrate`, `pnpm uai registry publish`, restore |
| `unai_app` | NOLOGIN (created and asserted by migration 0001) | — | — | group role only |
| `unai_auth` | NOLOGIN (created and asserted by migration 0002) | — | — | group role only |
| `unai_api_login` | LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS INHERIT | `unai_app` | 12 | `unai-api` |
| `unai_worker_login` | same as above | `unai_app` | 12 | `unai-worker` |
| `unai_auth_login` | same as above | `unai_auth` | 22 (API auth 10 + web auth 10 + 2) | `unai-api`, `unai-web` |
| `unai_backup` | LOGIN NOSUPERUSER BYPASSRLS | `pg_read_all_data` | 3 | `unai-backup` (D9) |

- The migration owner is a superuser because it must be, not for convenience:
  migrations 0001 and 0002 run `ALTER ROLE … NOSUPERUSER … NOBYPASSRLS`
  (migrations/0001_foundation.sql:9, migrations/0002_authentication.sql:5) and
  0001 runs `CREATE EXTENSION IF NOT EXISTS vector` (line 2). Both are refused
  for a non-superuser (Context, verified 2026-11-02).
- No runtime unit ever uses `unai_migrator` or `unai_backup`:
  `withOwnerTransaction` refuses a superuser or BYPASSRLS role with
  `DATABASE_ROLE_UNSAFE` (packages/postgres/src/index.ts:37-42).
- `unai_api_login` and `unai_worker_login` are separate logins for attribution
  in `pg_stat_activity` and independent rotation.
- `unai_backup` needs RLS bypass (docs/operations/backup.md step 2).

**Extension.** Provisioning runs `CREATE EXTENSION vector` in `unai` as the
superuser before the first migration.

**Connection capacity** (the governor's follow-up from task comment
comment-2fb66f2b58344dffa1ef91d4685e9771, folded in here):

- Every pool has `max: 10` (packages/postgres/src/index.ts:13).
- Runtime: API app 10 + API auth 10 + web auth 10 + worker app 10 = 40. The
  CLIs and the backup add at most 15.
- `max_connections = 100`, `superuser_reserved_connections = 3`. The per-role
  limits above sum to 54.

**Server settings.**

- `listen_addresses = '127.0.0.1'`, `ssl = on` (D2),
  `password_encryption = scram-sha-256`.
- `pg_hba.conf` has only
  `hostssl unai unai_api_login,unai_worker_login,unai_auth_login,unai_backup,unai_migrator 127.0.0.1/32 scram-sha-256`
  plus `local all postgres peer`. There is no non-TLS `host` line.
- Runtime URLs are `postgresql://<login>:<password>@127.0.0.1:5432/unai` with no
  query string, because `createDatabasePool` refuses one
  (packages/postgres/src/index.ts:10-12). They live only in secret files (D6).

Cites PRD §28, PRD §30.5, ADR 0032 §4 and ADR 0004.

## D5 Object storage

**Bucket and variables.**

- S3 general-purpose bucket `<bucket-prefix>-uai-evidence` in `<aws-region>`,
  with no dots in the name. The adapter forces path-style addressing
  (packages/storage/src/index.ts:24), so the deploy rehearsal must prove the
  startup check against real S3.
- `UNAI_S3_ENDPOINT=https://s3.<aws-region>.amazonaws.com`
- `UNAI_S3_REGION=<aws-region>`
- `UNAI_S3_BUCKET=<bucket-prefix>-uai-evidence`
- `UNAI_S3_KMS_KEY_ID=arn:aws:kms:<aws-region>:<aws-account-id>:key/<evidence-key-id>`

**Default encryption: exactly one rule.**

```json
{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"aws:kms","KMSMasterKeyID":"arn:aws:kms:<aws-region>:<aws-account-id>:key/<evidence-key-id>"},"BucketKeyEnabled":true}]}
```

- `KMSMasterKeyID` and `UNAI_S3_KMS_KEY_ID` are the identical full key ARN,
  never an alias or a bare key id. The adapter compares exact strings at startup
  and on every receipt (packages/storage/src/index.ts:27-32 and 48-52;
  packages/storage/CLAUDE.md).
- A dedicated customer-managed key, `alias/unai-evidence`, separate from the
  pgdata (D4) and backup (D9) keys.

**Bucket settings.**

- All four Block Public Access settings on; Object Ownership
  `BucketOwnerEnforced`.
- The bucket policy denies requests with `aws:SecureTransport = false`, and
  denies `PutObject` without `aws:kms` SSE under that ARN.

**Versioning.**

- ENABLED. A lifecycle rule expires noncurrent versions after 30 days and
  removes expired delete markers.
- Object Lock is OFF, because it would block lawful erasure (PRD §30.7).
- Why: the services hold `s3:DeleteObject` but never `s3:DeleteObjectVersion`,
  so a compromised host can only add delete markers. Erasure (the ADR 0030
  cascade) completes within 30 days, inside the backup window (D9).

**IAM.** Two IAM users without console access; credentials reach the SDK
default chain through files laid out by D6.

- `unai-api`: `s3:GetEncryptionConfiguration` on the bucket; `s3:PutObject`,
  `s3:GetObject` and `s3:DeleteObject` on `<bucket>/*` (delete only because the
  deletion cascade runs in the API); `kms:GenerateDataKey` and `kms:Decrypt` on
  the evidence key. No `s3:ListBucket`: the adapter never lists.
- `unai-worker`: the same minus `s3:DeleteObject`. Installed only once the
  worker holds the evidence store (task-1d49e470fb8f4d08aa0e705b081a40c3);
  until then the worker holds no AWS credentials.
- No host principal may run `kms:ScheduleKeyDeletion` or `kms:DisableKey`, or
  change key policies.

Cites PRD §30.5, PRD §30.7, ADR 0005, ADR 0007 and ADR 0030.

## D6 Secrets layout and handles

**Mount and permissions.**

- Only the `mounted` provider exists (packages/secrets/src/index.ts:58-73 and
  106-110), so every credential is a file under a mount.
- One mount per process: `UNAI_SECRETS_MOUNT` is `/etc/unai/secrets/api`,
  `/etc/unai/secrets/web` or `/etc/unai/secrets/worker`.
- `/etc/unai/secrets` is root:root 0755. Each process directory and its
  subdirectories (`connectors/`, `aws/`) are root:<process-user> 0750; files are
  root:<process-user> 0640.
- A secret two processes need is placed in both directories. The duplication is
  deliberate: no shared group and no ACLs, so the web can read only its own
  three files. The rotation runbook names every copy.

**Handles per process.** Every handle has the form `secret://mounted/<name>`;
the file is `<mount>/<name>`.

| Process | Variable or reference | Handle | Issuer |
|---|---|---|---|
| api | `UNAI_APP_DATABASE_URL` | `secret://mounted/api-database-url` | provisioning (login `unai_api_login`, D4) |
| api | `UNAI_AUTH_DATABASE_URL` | `secret://mounted/auth-database-url` | provisioning (login `unai_auth_login`) |
| api, worker | connector `secret_ref` stored on the connector row | `secret://mounted/connectors/<name>` | the OAuth ceremony CLI (task-a814e89c582143b19660af695d824a24), or a GitHub PAT |
| api, worker | Google connector OAuth client | `secret://mounted/google-connector-client` (JSON with `client_id` and `client_secret`) | Google Cloud console; the variable naming it is added by task-c7b1ad4dbf9545148bd0a5c6624ef318 |
| web | `UNAI_AUTH_DATABASE_URL` | `secret://mounted/auth-database-url` | provisioning (login `unai_auth_login`) |
| web | `NEXTAUTH_SECRET` | `secret://mounted/nextauth-secret` | at least 32 random bytes, generated on the host |
| web | `GOOGLE_CLIENT_SECRET` | `secret://mounted/google-signin-client-secret` | Google Cloud console ("Uai sign-in" client) |
| worker | `UNAI_APP_DATABASE_URL` | `secret://mounted/worker-database-url` | provisioning (login `unai_worker_login`) |
| worker | `UNAI_MODEL_API_KEY` | `secret://mounted/anthropic-api-key` | Anthropic Console (D7) |

- `GOOGLE_CLIENT_ID` stays plain configuration (apps/web/lib/server.ts:22).
- AWS keys are not handles, because the storage adapter has no credentials
  field and uses the SDK default chain (packages/storage/CLAUDE.md). The unit
  sets `AWS_SHARED_CREDENTIALS_FILE=<mount>/aws/credentials` and
  `AWS_EC2_METADATA_DISABLED=true`. The API holds them; the worker only once it
  writes evidence (D5).
- The backup key and backup credentials are not runtime secrets; they live under
  `/etc/unai/backup` (D9).

**Outside the runtime mounts.**

- `/etc/unai/api.env`, `/etc/unai/web.env` and `/etc/unai/worker.env`
  (root:root 0600; systemd reads them as PID 1) hold only plain configuration,
  handles and paths.
- `/etc/unai/migrate.env` (root:root 0600) holds
  `UNAI_MIGRATION_DATABASE_URL=postgresql://unai_migrator@127.0.0.1:5432/unai`
  with NO password, and `UNAI_DATABASE_CA_PATH=/etc/unai/tls/ca/ca.pem`.
- `/root/.pgpass` (0600) holds the migrator password. The migration and
  registry CLIs read literal URLs (packages/postgres/src/migrate-cli.ts:4-5,
  packages/registry/src/cli.ts:157), and node-postgres 8.23 (pnpm-lock.yaml)
  reads pgpass when the URL carries no password. pgpass support is deprecated
  for pg 9, so a pg 9 upgrade must move these CLIs to handles first.
- Backup material: `/etc/unai/backup` (D9). LUKS material: `/etc/unai/pgdata`
  (D4). TLS keys: `/etc/unai/tls` (D2).

**Google OAuth** (the governor's follow-up from task comment
comment-2fb66f2b58344dffa1ef91d4685e9771, folded in here; the owner answered
"any", Context):

- One Google Cloud project with two clients:
  - "Uai sign-in": web application, scopes `openid email profile` only
    (packages/auth/src/index.ts:74; ADR 0008).
  - "Uai connectors": `gmail.readonly`, `gmail.metadata` and
    `calendar.readonly` (packages/connectors/src/manifests.ts:27-29). Its client
    type is chosen by the ceremony task (task-a814e89c582143b19660af695d824a24).
- Consent-screen audience: Internal if the owner's account belongs to a Google
  Workspace organisation the owner administers. Otherwise External with
  publishing status In production, left unverified under Google's personal-use
  exemption (a click-through unverified-app warning and a 100-new-user lifetime
  cap).
- Testing status is never used in production: its refresh tokens expire after
  7 days. Sources, checked by the architect on 2026-11-02:
  https://developers.google.com/identity/protocols/oauth2 (Refresh token
  expiration), https://support.google.com/cloud/answer/7454865 (Unverified
  apps) and https://support.google.com/cloud/answer/13464323 (When is
  verification not needed).
- The refresh-token exchange, implemented by
  task-c7b1ad4dbf9545148bd0a5c6624ef318, treats `invalid_grant` as a revoked
  token with the operator message "re-run connect:google". Causes include
  revocation, six months unused, a password change for Gmail scopes and Testing
  expiry.

**GitHub.** A read-only fine-grained personal access token (Metadata, Issues
and Pull requests: read) on selected repositories, expiring within one year,
stored as a connector secret and sent as a bearer token
(packages/connectors/src/providers.ts:209).

Cites ADR 0013, ADR 0008, ADR 0023 and PRD §30.5 ("Use a secrets manager for
connector credentials").

## D7 Model provider pin

**Variables** (worker only; the API makes no model call, packages/api/src/server.ts
wires no model provider):

- `UNAI_MODEL_PROVIDER=anthropic` (adapter at packages/model/src/providers.ts:73-94).
- `UNAI_MODEL_ENDPOINT=https://api.anthropic.com/v1/messages`
- `UNAI_MODEL_ID=claude-sonnet-5-5`, the owner's choice (Context).
- `UNAI_MODEL_API_VERSION` stays unset, so the adapter's default
  `anthropic-version: 2023-06-01` applies (providers.ts:80).
- `UNAI_MODEL_INPUT_MICROUNITS_PER_1K=2000` and
  `UNAI_MODEL_OUTPUT_MICROUNITS_PER_1K=10000`. Source: Anthropic's first-party
  price for Claude Sonnet 5.5, US$2 input / US$10 output per million tokens,
  from Anthropic's model reference consulted 2026-11-02. The operator re-checks
  the price at deploy time and on every upgrade; prices are configuration, never
  code (providers.ts:18-19).
- `UNAI_MODEL_API_KEY=secret://mounted/anthropic-api-key` (D6).

**Account.** A dedicated Anthropic Console workspace with its own key and a
monthly spend limit set by the owner, starting at about US$50. That limit is the
provider-enforced ceiling across all runs.

**Per-run ceilings.** The code's `ROUTE_COST_BUDGET_MICROUNITS`
(packages/extraction/src/triage.ts:25-27) is ENTITY_EXTRACTION 4,000 and
FULL_EXTRACTION 20,000. The gateway enforces them after the call
(packages/model/src/gateway.ts:165), and `maxOutputTokens` defaults to 2,048
(gateway.ts:135). At this pin:

- About 1k input + 300 output tokens cost about 2,000 + 3,000 = 5,000
  microunits, over 4,000, so most entity runs are rejected.
- 2,048 output tokens alone cost 20,480 microunits, over 20,000.
- A rejected call is already billed: the overspend is recorded, then refused.
- Sonnet 5.5 runs adaptive thinking at effort `high` when `thinking` is
  omitted. Thinking tokens bill as output and count against `max_tokens`, and
  the adapter sends neither `thinking` nor `output_config`
  (providers.ts:79-84).

**Thinking controls on `claude-sonnet-5-5`** (Claude API reference, checked
2026-11-02; governor note comment-788da75f074b49248d2436832ece23ee). Recorded as
facts the follow-up must respect, not as a chosen setting:

- `thinking: {type: "disabled"}` is refused with HTTP 400.
- The only off switch is `thinking: {type: "between_tools"}`. It is accepted
  only at effort `high` or below and takes no other thinking field.
- Effort is set with `output_config: {effort: ...}` (`low`, `medium`, `high`,
  `xhigh`, `max`; default `high`).

**Required follow-up: task-9436f4840ca04fc0afbe2bdc2be6fd42** ("Extraction cost
ceilings and Anthropic thinking/effort settings for the pinned
claude-sonnet-5-5"). The governor filed it from
comment-37a6626aa433431ba856336df852a5ea, and it depends on this ADR. It must
land before real evidence is extracted, but it does not block the deployment
itself.

- Resolved by task-9436f4840ca04fc0afbe2bdc2be6fd42: ceilings and thinking/effort settings are recorded in [Cost ceilings and request settings](../model-path-and-extraction.md#cost-ceilings-and-request-settings).

- Ceilings: raise them to cover a worst-case call at the output cap.
  ENTITY_EXTRACTION 30,000 and FULL_EXTRACTION 60,000 are a starting
  recommendation that task-9436f4840ca04fc0afbe2bdc2be6fd42 finalizes, not
  values this ADR decides.
- Thinking/effort: that task chooses the setting and its mechanism. Measuring
  it on the synthetic corpus is an optional owner-run refinement: it needs the
  owner's Anthropic key, which agents never hold.

Cites PRD §28 design constraints, PRD §41 Portability, PRD §20 and ADR 0016.

## D8 Observability

**Logs.**

- The units write the existing allowlisted JSON lines
  (packages/api/src/platform.ts:175; packages/observability/src/index.ts:34) to
  journald.
- Drop-in `/etc/systemd/journald.conf.d/unai.conf`: `Storage=persistent`,
  `SystemMaxUse=2G`, `MaxRetentionSec=30day`. PostgreSQL also logs to journald.
- Logs never leave the host. Adding a shipper needs a successor ADR.

**Traces and metrics.**

- OTLP/HTTP to a local OpenTelemetry Collector (`otelcol-contrib` official
  .deb, version pinned at install) listening only on `127.0.0.1:4318`.
- `UNAI_OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318`. Plain http is
  acceptable only because it is loopback; the exporter, implemented by
  task-fc564767f0e9492cadad015259a53817, refuses http to any remote host.
- `UNAI_DEPLOYMENT_ENVIRONMENT=production`. No
  `UNAI_OTEL_EXPORTER_OTLP_HEADERS`.
- Service names: `unai-api`, `unai-web`, `unai-worker`.
- Collector pipeline: `otlp` receiver, `batch` processor, `file` exporter
  writing JSON lines under `/var/lib/otelcol/unai` with 14-day rotation.
- No remote exporter, because spans carry owner-scope identifiers. A hosted
  backend needs a successor ADR.

Cites PRD §28, PRD §41 Observability and docs/foundation.md:69 ("Deployment
supplies the OpenTelemetry exporter").

## D9 Backups

**Destination bucket.**

- `<bucket-prefix>-uai-backup` in `<backup-region>`, a different region from
  the evidence bucket.
- One SSE-KMS default rule using its own customer-managed key
  `alias/unai-backup`, named by full ARN.
- Block Public Access on, versioning ENABLED. A lifecycle rule expires current
  objects after 30 days and noncurrent versions after 5 days. No Object Lock.
- The backup principal holds no `s3:DeleteObject*`, so a compromised host
  cannot destroy archives; retention is the lifecycle's job.

**Archives** (`scripts/backup.mjs`, implemented by
task-cd57e1f0e42442ac938e936b95171097):

- One AES-256-GCM archive per run: `uai-backup-<utc>.tar.enc` plus `.sha256`
  plus `.manifest.json`.
- `UNAI_BACKUP_DESTINATION=s3://<bucket-prefix>-uai-backup/<host-name>/`
- `UNAI_BACKUP_KEY_FILE=/etc/unai/backup/backup.key`
- `UNAI_BACKUP_RETENTION_DAYS` applies only to a local-directory destination.

**Schedule.**

- Daily at 03:30 UTC from `unai-backup.timer` (`Persistent=true`), under D11
  maintenance mode.
- A monthly restore drill on the first Sunday at 05:00 UTC
  (task-0029882ff3c84cef89ffa6b150c03bb0, task-a620d2e856d947f5a2ffd49c1e279ada)
  into an empty database `unai_restore_drill` and an empty bucket
  `<bucket-prefix>-uai-restore-drill` (single `aws:kms` rule, objects expire
  after 2 days). Both are torn down after verification.
- Size the data volume at least 2.5× the database. RPO 24 h, RTO target 4 h.

**Principal.**

- System user `unai-backup`. `/etc/unai/backup` is root:unai-backup 0750 and
  holds:
  - `backup.key`: owner `unai-backup`, mode 0600, 32 random bytes.
  - `pgpass`: 0600, used through `PGPASSFILE`, role `unai_backup` (D4).
  - `aws-credentials`: 0600, IAM user `unai-backup`: `s3:GetObject` and
    `s3:GetEncryptionConfiguration` on the evidence bucket; `kms:Decrypt` on the
    evidence key; `s3:PutObject`, `s3:GetObject` and `s3:ListBucket` on the
    backup bucket; `kms:GenerateDataKey` and `kms:Decrypt` on the backup key.
- The drill uses IAM user `unai-restore-drill`, limited to the drill bucket and
  the evidence key. Production restores use credentials the operator supplies
  at restore time.

**Key custody.**

- On the host the backup key exists only at `backup.key`: never in the backup
  bucket, the runtime mounts, Git, logs or the manifest.
- Before the first backup the owner records an offline copy (paper in a safe
  and/or a password manager off this host). The restore runbook recovers the
  key from it after host loss. The LUKS recovery passphrase (D4) is kept with
  it.
- Runtime secrets are not backed up: each can be re-issued by its issuer (D6).

**Erasure.** Erased evidence survives in archives at most 35 days (30 current +
5 noncurrent). A restore replays deletion requests newer than the backup
watermark before any read (docs/operations/restore.md step 5;
docs/operations/deletion.md).

Cites PRD §41 Reliability ("Backup and restore procedures tested"), PRD §30.5,
PRD §30.7, ADR 0034 and docs/operations/backup.md steps 3-6.

## D10 Health probes (deviation)

**Deviation.** This decision departs from two rules, and is recorded here per
PRD §0 rule 7 before its code (implemented by
task-e9dd2f5215e9486fb09f60d18ee6e5ae):

- ADR 0008: every listener sits behind its own TLS.
- The owner boundary: every API request needs a TLS socket, a session, an owner
  scope, a purpose and a correlation id.

**Decision.**

- A separate plain-HTTP listener inside the API and inside the worker, set by
  `UNAI_PROBE_BIND` (default `127.0.0.1`) and `UNAI_PROBE_PORT` (unset means
  probes are off).
- A non-loopback bind is refused at startup. There is no remote override in
  this topology.
- Ports: API 9101, worker 9102 (D3).
- These process-neutral names replace the provisional `UNAI_API_PROBE_*` names
  in that task's description.
- The web has no probe. Its liveness is the unit state plus
  `curl --resolve uai.<owner-domain>:443:127.0.0.1 https://uai.<owner-domain>/signin`.

**What the probes may reveal.**

- `GET /healthz` returns `{"status":"ok"}`.
- `GET /readyz` returns `{"status":"ready"|"not-ready","checks":{"<fixed name>":"ok"|"fail"}}`.
- Never owner data, ids, versions, timestamps, error text or configuration.
- Any other path answers 404 with an empty body; any other method answers 405.
  Client details are never logged.

**Consumers.** The upgrade script (D12) and the operator.

Satisfies PRD §41 Reliability and Observability.

## D11 Maintenance mode for backups (definition)

**Definition.** This makes docs/operations/backup.md:7 ("Put the deployment in
maintenance mode") executable:

- `unai-worker` is stopped first (connector polling, extraction, initiative and
  cleanup), then `unai-api` (owner writes, ingestion, erasure).
- `unai-web` stays up. API-backed pages show their existing unavailable states,
  and proxied calls answer 503 `SERVICE_UNAVAILABLE`
  (apps/web/pages/api/platform/[...path].ts:73). No code change.
- `systemctl stop` waits for the SIGTERM handlers (D1).

**Backup service.**

- `unai-backup.service` runs its stop and start commands as `+`-prefixed
  `ExecStartPre` and `ExecStopPost`, so the unprivileged `unai-backup` user
  never holds systemctl rights.
- `ExecStopPost` starts the API and then the worker whether the backup
  succeeded or failed. A failed run is unusable and is retried from maintenance
  mode (backup.md step 6).

**Precondition**, checked by the backup script
(task-cd57e1f0e42442ac938e936b95171097): both units inactive and no
`pg_stat_activity` backend for `unai_api_login` or `unai_worker_login`.
Otherwise the run stops with `BACKUP_PRECONDITION_FAILED`.

**Why not pg_dump's snapshot alone.**

- The snapshot covers the database only. Objects are immutable and written
  before their row commits, but a concurrent erasure can remove an object the
  snapshot still lists, and the deletion watermark must be stable.
- Cost: API downtime around 03:30 UTC, acceptable for a single owner.

Satisfies PRD §41 Reliability and ADR 0034. Implemented by
task-cd57e1f0e42442ac938e936b95171097 and task-a620d2e856d947f5a2ffd49c1e279ada.

## D12 Upgrade and rollback order

**Order.**

1. Fetch the tag into `/opt/unai/releases/<tag>`.
2. Run `pnpm install --frozen-lockfile` and `pnpm build` there.
3. Enter D11 maintenance mode.
4. Take a D9 backup. This is the rollback point; abort if it fails.
5. Run `pnpm db:migrate` with `migrate.env` and pgpass (D6).
6. Run `pnpm uai registry publish` if the release pins a new registry version.
   It needs the local tag `registry-v<version>` (`REGISTRY_TAG_MISSING` at
   packages/registry/src/release.ts:170); pushing tags is an owner gate.
7. Update `/etc/unai/*.env` for new variables and run all three `--check`
   preflights against the new release.
8. Swap `/opt/unai/current`.
9. Start the API and wait for `/readyz` on 9101; restart the web and check
   `/signin`; start the worker last and wait for `/readyz` on 9102.

Steps 5 and 6 come before any runtime start, as docs/processing-runtime.md:5
requires ("Run migrations and publish the selected immutable registry release
before starting the API and worker").

**Rollback.**

- A failure before step 5 changes no data: swap back and start the old units.
- From step 5 on, migrations are forward-only (digest ledger, no down
  migrations: migrations/CLAUDE.md:8, ADR 0004). Rollback means restoring the
  step-4 backup into an empty database and store and starting the previous
  release, or fixing forward.

**Packages.**

- `postgresql-17` is excluded from unattended-upgrades; minor updates happen in
  a maintenance window.
- OS security updates come from unattended-upgrades. Node and pnpm stay pinned.

Cites docs/processing-runtime.md:5, ADR 0004 and PRD §41 Reliability.

## Alternatives considered

- B, all-AWS with RDS: the owner chose A. A managed PostgreSQL without a true
  superuser also cannot run migrations 0001/0002 as written (D4).
- C, Cloudflare Tunnel: the edge would terminate TLS and see plaintext.
- A public certificate for the API: needless exposure, and ADR 0008 already
  expects an API CA.
- One shared `unai` user and secrets directory: a web compromise would expose
  every secret.
- pg_dump without stopping the writers: see D11.
- A remote telemetry backend: deferred (D8).

## Consequences and follow-ups

Decisions map to the tasks that implement them; none of this exists yet:

- D1, D3, D6 units and env files: task-e71e55bb25f14ec182668e1deee0b42c.
- D2, D4, D5, D12 install, upgrade, certificate hook, internal-CA issuance,
  provisioning SQL and bucket setup: task-90ac39b69040428c84bc7f5187a3fc83.
- D9, D11: task-cd57e1f0e42442ac938e936b95171097,
  task-0029882ff3c84cef89ffa6b150c03bb0 and
  task-a620d2e856d947f5a2ffd49c1e279ada (the rotation runbook covers every D6
  copy and the internal-CA leaves).
- D10: task-e9dd2f5215e9486fb09f60d18ee6e5ae. D8:
  task-fc564767f0e9492cadad015259a53817.
- Google OAuth (D6): task-c7b1ad4dbf9545148bd0a5c6624ef318 and
  task-a814e89c582143b19660af695d824a24.
- D7: task-9436f4840ca04fc0afbe2bdc2be6fd42.

Variables named here that no code reads yet (`UNAI_PROBE_*`, `UNAI_OTEL_*`,
`UNAI_DEPLOYMENT_ENVIRONMENT`, `UNAI_BACKUP_*`, `PGPASSFILE`,
`AWS_SHARED_CREDENTIALS_FILE`, `AWS_EC2_METADATA_DISABLED`, the Google
connector client variable) join docs/operations/environment.md with the task
that adds the read (the contract itself: task-c3fba39163a24321a2b61702ce3c5cf1).

**Known gaps.**

- The migration and registry CLIs take literal URLs; pgpass mitigates this (D6).
- Path-style S3 must be proven in the deploy rehearsal
  (task-837b543ced444582b24fa6805b186d6c).
- TLS files and database URLs are read once, so rotating them needs a restart.
- An unattended reboot needs AWS KMS reachable; if it is not, the data volume
  stays locked and PostgreSQL stays stopped (fail closed).

This ADR changes no code and does not amend ADR 0008.
