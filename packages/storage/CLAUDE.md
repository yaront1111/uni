# packages/storage

`@unai/storage` owns the encrypted S3 adapter `createEncryptedS3Store`: transport and encryption verification, the indirection from a public object id to a private key, and sanitized error codes (ADR 0005 and ADR 0007 in `docs/adr/`). It must not own authorization data or key naming. It has no database access, and deciding who may touch which object belongs to the resolver the caller supplies.

## Surface and consumers

`src/index.ts` exports `createEncryptedS3Store(configuration, resolveKey)`, `StorageConfiguration` and `AuthorizedKeyResolver`. The returned store has `put`, `get`, `delete` and `close`; there is no list or overwrite. `delete` exists for the deletion cascade (ADR 0027 §8) and goes through the same resolver with operation `DELETE`, which `createEvidenceObjects` answers only under `data.delete`. The single consumer is `createEvidenceObjects` in `packages/api/src/evidence.ts`, which imports `../../storage/src/index.js` by relative path because `@unai/api` does not declare this package as a dependency. `scripts/storage-harness.mjs` resolves `@aws-sdk/client-s3` through this folder's `package.json` with `createRequire` at module load, so the SDK dependency must stay declared here: `packages/api/src/reference-stack.test.ts` asserts it, and without it `scripts/test.mjs` dies on import, before any named harness step.

## Invariants

- Configuration is validated before any network call: an `https:` endpoint with no userinfo, query or fragment, non-blank `region`, `bucket` and `kmsKeyId`, and a function resolver, otherwise `STORAGE_CONFIGURATION_INVALID`. There is no credentials field. The SDK default chain supplies credentials, and `@unai/secrets` handles are not involved. There is no CA or agent option either, so a private CA reaches the client only through `NODE_EXTRA_CA_CERTS`. The client uses `forcePathStyle:true`; the harness endpoints are bare `https://127.0.0.1:<port>` addresses, and `scripts/s3-object-server.mjs` parses `/<bucket>/<key>` paths.
- The factory is async because it sends `GetBucketEncryptionCommand` once and requires exactly one rule with `aws:kms` and a `KMSMasterKeyID` equal to `kmsKeyId`. Any other answer, and any error from that call (network, credentials, permissions), becomes `STORAGE_ENCRYPTION_REQUIRED`, so that code at startup does not by itself prove a misconfigured bucket. `packages/api/src/server.ts` awaits the factory at top level, so a failure stops the API from starting.
- The KMS key is compared by exact string equality, at startup and on every receipt, so an alias never matches an ARN. Both backends that `scripts/storage-harness.mjs` starts set the bucket rule and `UNAI_TEST_S3_KMS_KEY_ID` to the same `arn:aws:kms:unai-test-key` string.
- `put` always sends `ServerSideEncryption`, `SSEKMSKeyId` and `IfNoneMatch:'*'`, then checks the response receipt. `get` checks the receipt before consuming the body and destroys the body stream in `finally` (ADR 0007); the test asserts that `transformToByteArray` is never called after a bad receipt and that the stream ends up destroyed.
- `put` returns only the frozen `{id}`. The private key never appears in a return value or in an error.

## Resolver contract

Before the resolver runs, `put` and `get` check in order: `STORAGE_CLOSED` after `close()`, then `requestContextSchema.parse` on the context, then that the public id is a UUID (otherwise `STORAGE_PUBLIC_ID_INVALID`). An invalid context, including one with an extra key because the schema is strict, throws the Zod error from that parse, not a `STORAGE_*` code.

`resolveKey(context, publicId, operation)` receives the frozen parse result, the public id and `'READ'` or `'WRITE'`. It must check ownership and purpose against canonical data and return the private key or `null`. A throw, `null`, an empty key, a key equal to the public id and a key over 1024 bytes all become `STORAGE_ACCESS_DENIED` with no S3 request. The number mirrors the `object_store_key` CHECK in `migrations/0008_evidence_object_keys_and_anchors.sql`, which counts characters rather than bytes; production keys are ASCII. The production resolver compares `JSON.stringify(tx.context)` with the context it is handed. Both sides come from `requestContextSchema.parse` (here and in `withOwnerTransaction`), so if the adapter ever passed the resolver the raw input or an enriched context, every request would be denied.

## Traps

- Once the key is resolved, every failure in `put` and `get` collapses to `STORAGE_OPERATION_FAILED`, including a rejected receipt, a missing body and the 412 of a conditional PUT. `STORAGE_ENCRYPTION_REQUIRED` and `STORAGE_BODY_MISSING` thrown inside those bodies are internal and never reach a caller. Tests assert the message with `/^STORAGE_OPERATION_FAILED$/`, so never append provider text or a key.
- Because of `IfNoneMatch`, `put` is not an idempotent retry: a second write to the same key fails. `ingest` in `packages/api/src/evidence.ts` calls it only for a newly inserted row with a fresh random `raw/<hex>` key, after inserting the `evidence_object_keys` row that the resolver reads back in the same transaction.
- An object can outlive its row, either through a failed database commit or through a PUT whose receipt was rejected after the write. The adapter deletes only objects whose row the erasure names, so an orphan is still deployment reconciliation work (`docs/evidence-runtime.md`).

## Tests and changing the S3 request shape

`pnpm exec vitest run packages/storage/src/index.test.ts` needs no database, network or environment variable. It stubs `S3Client.prototype.send` with `vi.spyOn` and uses a real Node `Readable` as the response body. The real TLS and KMS path runs only in `packages/api/src/evidence.test.ts` under `pnpm test` with `UNAI_TEST_S3_*`. When you add a command, header or query parameter, extend `scripts/s3-object-server.mjs` too. It serves only the bucket `?encryption` query, PUT, GET and HEAD, answers 501 to any query parameter other than `x-id`, 400 to a PUT without the matching SSE headers, and 412 to a conflicting `If-None-Match: *`.
