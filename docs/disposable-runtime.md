# Disposable development runtime

Run `pnpm dev:stack` with Node 24, pnpm 11 and a reachable Linux-container Docker daemon. It owns a fresh PostgreSQL/pgvector container and an in-process TLS encrypted object service. The ready terminal identifies the API/web children as **runtime stubs**. Ctrl+C shuts down the children and services and removes the private temporary directory, secrets mount and container.

This node implements the initial **pnpm dev:stack provisioning and ready terminal**, **Local launch refusal and cleanup terminal**, `DevStackOrchestrator`, and the script-only `DisposableStackResources` entity. It does not claim an assembled application or the script-only one-time sign-in screen. The downstream local-product-launch node supplies migrations, application roles/credentials, fixtures, API/web listeners, and bootstrap authentication. `onReady(config, orchestrator)` supplies safe configuration to that integration; `children` supplies Node child entrypoints, which signal readiness through IPC `{type:'ready'}`. Call `requestStop()` for normal shutdown. Startup failures and any child exit terminate the invocation.

## Ownership and terminal behavior

The in-memory ledger exists at construction, before preflight/provisioning. It registers directory, secrets mount, container, object listener and child cleanup before each allocation. Cleanup runs in reverse order; a failed container/child cleanup retains its backing secret artifacts for a retry and emits `DEV_STACK_CLEANUP_FAILED`, never a success receipt. Cleanup is serialized and retryable. A container is removed only if its unique name and invocation label match. No global prune, existing-database migration or unrelated-directory deletion is used.

The command refuses externally supplied database selectors, including `DATABASE_URL`, `UNAI_*DATABASE*`, libpq connection selectors and database command-line arguments, with `DEV_STACK_EXTERNAL_DATABASE_REFUSED` before filesystem creation, Docker access or any connection. Remove those selectors from the launch environment; there is no existing-database override. Other unsupported arguments receive `DEV_STACK_ARGUMENTS_INVALID`.

`DEV_STACK_DATABASE_READY` reports verified TLS, pgvector and the explicit `unai.encryption_at_rest` declaration. `DEV_STACK_STORAGE_READY` follows an actual encrypted object write/read/delete and bucket/receipt verification. `DEV_STACK_READY` identifies the provisional children. Normal stop exits 0; Ctrl+C exits 130; SIGTERM exits 143; crashes/startup/cleanup failures exit 1. Driver exceptions and child output never reach terminal output. Only successful cleanup prints `DEV_STACK_CLEANUP_COMPLETE`.

## Secrets, TLS and at-rest policy

Generated credential bytes exist in memory and private ephemeral runtime files only. No credential is passed in Docker arguments/environment, child environment, terminal output, or a repository file. The PostgreSQL password enters Docker through a read-only bind mount and `POSTGRES_PASSWORD_FILE`; root copies the protected key/password into a PostgreSQL-owned container tmpfs with mode 0600. PostgreSQL rejects plaintext network connections and uses a generated loopback certificate verified by the orchestrator. No certificate-verification bypass is used.

The host directory has mode 0700 and files 0600 on POSIX. Windows disables inherited ACLs and grants access to the current user SID and SYSTEM before writing secrets. `UNAI_SECRETS_MOUNT` is the private mounted-provider root. Runtime configuration contains `secret://mounted/runtime/database#url`, `secret://mounted/runtime/storage`, and `secret://mounted/runtime/session-secret`; the child stubs resolve them through the existing `@unai/secrets` implementation. Certificate/key configuration contains protected file paths. The bootstrap URL exception is reserved for downstream work; this runtime emits no session URL and broadens no credential exception from clarification `clar-035e096e373627895e546be4`.

The database declaration is `managed:disposable-tmpfs-no-persistent-volume`: its data directory lives in disposable container tmpfs, with no persistent database volume. This explicitly describes the local storage policy; it is **not evidence of host disk/swap encryption or PostgreSQL TDE**. The runtime makes no such claim. The object service reuses the existing test S3 service: TLS, AES-256-GCM object encryption, fresh per-object data keys wrapped by an ephemeral in-memory root, and verified `aws:kms` receipts. It retains the existing harness's documented S3 authentication limitations and is a disposable local service, not a production S3 deployment.

## Assigned acceptance checks (retained in full)

- [verify-f1-reuse] Provisioning reuses scripts/test.mjs, scripts/tls-certificate.mjs, scripts/storage-harness.mjs and scripts/s3-object-server.mjs without introducing a competing pinned-image source.
- [verify-f1-secrets] Runtime secret configuration uses mounted handles, with credential contents confined to protected temporary runtime artifacts allowed by the recorded clarification.
- [verify-f1-stack] A fresh stack run starts its own TLS PostgreSQL/pgvector instance with an explicit encryption-at-rest declaration.
- [verify-f1-storage] A fresh stack run starts and uses the encrypted object-store service.
- [verify-f4-refuse] Pointing the command at an existing database refuses execution with a named code and does not provision into that database.

`src/dev-stack.test.ts` verifies these checks against real disposable services. The ownership lifecycle driver exercises normal exit, Ctrl+C, API/web crashes, failure at seven startup boundaries, and two interrupted-start boundaries. It inspects resource removal and preserves an unrelated container and directory sentinel. Tests also check mounted handle resolution, private file permissions/ACLs, container configuration without credentials, plaintext PostgreSQL refusal, TLS sessions, pgvector and the declaration, and the encrypted object roundtrip.

Both the full test runner and development runtime reuse `postgresRunArguments` extracted from `scripts/test.mjs`. The PostgreSQL digest has one source in `scripts/postgres-harness.mjs`, also consumed by recovery; the existing MinIO digest remains solely in `scripts/storage-harness.mjs`. No required repository checks were removed or weakened.

The assigned acceptance gate is these five checks plus **`pnpm test`**. Full assembled-product cleanup/replay (`verify-f4-cleanup`), launch timing/disclosure, migrations/roles, web/API behavior, sign-in and fixtures retain their sealed-plan downstream owners. The local lifecycle harness is this node's foundation evidence, not a claim that those downstream checks passed.
