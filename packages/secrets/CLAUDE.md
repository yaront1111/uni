# packages/secrets

`@unai/secrets` owns the handle grammar `secret://<provider>/<name>[#<field>]`, the provider registry, and the rule that a credential variable must hold a handle instead of a literal (ADR 0013, `docs/adr/0013-secrets-manager-handles.md`). It must not own connector credentials (that ADR leaves `secret_ref` on `connectors` to the connector lifecycle node), S3 credentials (the storage adapter uses the SDK credential chain), or any vendor SDK: the empty `dependencies` object in `package.json` is deliberate.

## Surface and consumers

Everything is in `src/index.ts`. The only consumers are the two runtime entrypoints: `packages/api/src/server.ts` resolves `UNAI_APP_DATABASE_URL` and `UNAI_AUTH_DATABASE_URL`, and `apps/web/lib/server.ts` resolves `UNAI_AUTH_DATABASE_URL`, `NEXTAUTH_SECRET` and `GOOGLE_CLIENT_SECRET`. Both build the manager with `createDefaultSecretsManager()`, which registers only the `mounted` provider rooted at `UNAI_SECRETS_MOUNT`. Settings that are not credentials (CA and TLS files, `GOOGLE_CLIENT_ID`, `UNAI_S3_*`) stay plain `required(...)` reads in those entrypoints.

## Invariants

`src/index.test.ts` asserts the refusal list, the suffixed error codes and the entrypoint rule. It does not cover the length limits, the mounted provider's own traversal check and `SECRET_PROVIDER_FAILED` mapping, a non-string field value, or the absence of a cache, so a regression there fails no test.

- Grammar: the provider is lowercase `[a-z][a-z0-9]{0,31}`, so `secret://Mounted/x` is refused. The name is at most 256 characters of `[A-Za-z0-9_.\-/]`, starts with an alphanumeric, and has no empty, `.` or `..` segment. The field is at most 64 characters. `createMountedSecretsProvider` repeats the traversal check on the resolved path; keep both layers.
- `requireSecret` fails in a fixed order: `CONFIG_REQUIRED:<VAR>` when unset, `SECRET_HANDLE_REQUIRED:<VAR>` when the value is a literal, then whatever `resolve` throws.
- Error suffixes carry only a variable name or handle parts: `SECRET_PROVIDER_UNKNOWN:<provider>`, `SECRET_UNAVAILABLE:<provider>/<name>`, `SECRET_NOT_STRUCTURED:<provider>/<name>`, `SECRET_FIELD_MISSING:<provider>/<name>#<field>`. `SECRET_HANDLE_INVALID` has no suffix because its input may be a pasted credential. Never put the configured value or the resolved material in a message.
- A whole secret is trimmed, and a blank one is `SECRET_UNAVAILABLE`. With `#field`, the stored value must be a JSON object and the field a non-blank string; a number, an array document or an empty string is refused rather than coerced.
- The manager has no cache. Every `resolve` call reads the provider again, and `apps/web/lib/server.ts` resolves the sign-in secrets on each `authOptions()` call, which `pages/api/auth/[...nextauth].ts` makes per request. ADR 0013's "resolution happens once at service startup" holds for the API only.
- The two processes fail at different times. `packages/api/src/server.ts` builds the manager and resolves both URLs at top level, so a missing `UNAI_SECRETS_MOUNT` or a literal value stops startup. The web process builds the manager lazily inside `secret()`, so the same mistake surfaces on the first request that carries a session cookie or reaches the Auth.js route, not when `apps/web/server.ts` starts.

## Registering a provider

A provider is any `{read(name): Promise<string|null>}` passed by name to `createSecretsManager({mounted: ..., vault: ...})`. The registry key must itself satisfy the provider grammar, otherwise no handle can address it, and an empty registry throws `SECRET_PROVIDER_REQUIRED`. Return `null` for an absent secret. The manager does not wrap `read`, so a provider must replace vendor error text with a code on its own, as the mounted provider does: only `ENOENT` maps to `null`, and every other filesystem error becomes `SECRET_PROVIDER_FAILED` because the raw text can quote file contents. Vendor providers belong at the deployment composition site, not in this package; the entrypoint then calls `createSecretsManager(...)` instead of `createDefaultSecretsManager()`.

## Adding a credential variable

1. Read it in the entrypoint with `requireSecret(secrets,'NAME')`, never with `required('NAME')`.
2. Add `NAME` to the `credentials` array of the entrypoint test in `src/index.test.ts`, otherwise nothing guards it.
3. Add it to the variable list in `docs/foundation.md`, which describes each credential as a handle.

## Traps

The test "keeps every runtime entrypoint reading credentials through a handle" reads `packages/api/src/server.ts` and `apps/web/lib/server.ts` as text. It requires the `@unai/secrets` import, forbids `required('<credential>')`, and requires every credential the file mentions to match `/secret\w*\(\s*(?:secrets,\s*)?'NAME'/i`. The call must therefore be `requireSecret(secrets,'NAME')` with the manager variable named `secrets`, or a helper whose name contains `secret` and takes the variable name as its first argument, as `secret('NAME')` does in the web process. Renaming that variable, moving an entrypoint or passing the name through a constant fails this package's test, not the entrypoint's.

## Tests

`pnpm exec vitest run packages/secrets/src/index.test.ts` needs no database, Docker or environment variable. It writes a temporary mount under the OS temp directory and removes it afterwards.
