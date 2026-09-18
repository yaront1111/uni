# packages/auth

`@unai/auth` owns the sign-in ceremony and the opaque session: the Auth.js (next-auth 4) options for Google OIDC, the PostgreSQL adapter behind them, and the three helpers the web and API apply to a session cookie (`sessionToken`, `resolveSession`, `revokeSessions`). It must not own authorization (owner scope, purpose, membership and RLS live in `@unai/api` and `@unai/postgres`), device binding, or any table access of its own. ADR 0008 is the decision record.

## Surface and consumers

Everything is in `src/index.ts`. `apps/web/lib/server.ts` builds `createAuthOptions` for `pages/api/auth/[...nextauth].ts` and uses `sessionToken` + `resolveSession` in `identity()`. `packages/api/src/platform.ts` uses `sessionToken`, `resolveSession` and `revokeSessions` for `authenticate`, `deviceWork` and `POST /v1/sessions/revoke-all`. The API test suites call `postgresAdapter(adminPool).createUser/createSession` with `SESSION_COOKIE` to seed signed-in fixtures, so the adapter's method signatures are test infrastructure for another package too.

In production every function takes a `Pool` whose login is a member of `unai_auth`; both `apps/web/lib/server.ts` and `packages/api/src/server.ts` build it from `UNAI_AUTH_DATABASE_URL`. Runtime code issues nothing except `SELECT unai_private.auth_*($1,...)`. The API suites and `oauth.test.ts` pass the privileged test pool instead, so only `index.test.ts` exercises the restricted login and a privilege mistake can pass everywhere else. The `@unai/postgres` dependency is used by the tests only (`runMigrations`); do not reach for `withOwnerTransaction` here, because no actor exists before sign-in.

## Invariants

- The real logic is SQL in `migrations/0002_authentication.sql`: `SECURITY DEFINER` functions with `search_path=pg_catalog`, revoked from `PUBLIC` and granted to `unai_auth`. The auth login has no table privileges at all; `index.test.ts` expects `42501` on `users`, `devices`, `auth_sessions`, `auth_identities` and `audit_events`. A direct table query added here will fail in production. The auth tables have forced RLS with policies for `unai_app` only, so the functions return rows only because their owner, the privileged migration login, bypasses RLS; the restricted definer role proposed in ADR 0009 was rejected and never implemented.
- Only `digest(token)` (SHA-256 hex) crosses into SQL. `auth_sessions.token_hash` has a `^[a-f0-9]{64}$` CHECK and `unai_app` has no column grant on it (`packages/postgres/src/isolation.test.ts`). Changing the digest format breaks the constraint and every live session.
- The seven-day lifetime is absolute and enforced three times: `maxAge` in `createAuthOptions`, `least(expiry, now()+interval '7 days')` in `auth_create_session`, and the table CHECK. `updateAge` equals `maxAge`, so Auth.js does not request a rolling update before the session has expired, and `updateSession` ignores the `expires` Auth.js passes and returns the stored value; `index.test.ts` ("does not extend an opaque session") and `packages/postgres/src/auth.test.ts` hold this. Auth.js may still push the browser cookie's expiry forward; the database deadline is what counts.
- Identity is Google issuer + subject. `getUserByEmail` always returns null, `allowDangerousEmailAccountLinking` is false, `linkAccount` throws `AUTH_PROVIDER_REFUSED` for any other provider, and `auth_identities.issuer` is pinned by a CHECK. `linkAccount` forwards only the user id and the provider subject, so OAuth access, refresh and ID tokens are never stored (ADR 0008). `updateUser` deliberately writes nothing; email is display metadata stored once by `auth_create_user`, which also creates the personal owner scope and membership atomically.
- The `session` callback returns only `expires`, `user.name` and `ownerScopeId`. `oauth.test.ts` asserts the token never appears in that body. The `logger` prints fixed JSON and drops its arguments so provider and database error text is never logged.
- `sessionToken` returns null when the cookie is absent, repeated, or not 32 to 128 URL-safe characters. Generated tokens are 32 random bytes as base64url (43 characters).

## Revoke paths

There are four, and only two are in this file. `deleteSession` (Auth.js sign-out) revokes the current session; `revokeSessions(pool, token, correlationId, true)` revokes all of the user's sessions. `auth_revoke_session` silently returns, without an audit row, when the digest is unknown, expired or already revoked. It takes the same `users ... FOR UPDATE` lock as `auth_create_session` so a concurrent sign-in cannot escape a sign-out-all. The other two are triggers in 0002 on `users.disabled_at` and `devices.removed_at`; re-enabling a user does not revive sessions. `auth_session` additionally re-checks user, owner scope, membership validity and device tombstone on every resolve. Sign-in and sign-out audit rows are written inside the SQL functions; Auth.js supplies no correlation id, so the adapter passes a fresh `randomUUID()`.

## Changing things

Adding a field to `ResolvedSession` or `IdentityUser`: the interfaces mirror the `jsonb_build_object` in `auth_session`/`auth_user` and nothing parses them at runtime. Add a new migration that replaces the function (0002 is applied and immutable), update the interface, and extend `packages/postgres/src/auth.test.ts`, where the SQL lifecycle tests live. A new function needs the same definer, `search_path`, `REVOKE ... FROM PUBLIC` and `GRANT EXECUTE ... TO unai_auth` treatment.

`next-auth` is pinned to the exact version `4.24.15` here and in `apps/web/package.json`; bump both together. The Google provider is loaded through `createRequire` and typed by hand, and `oauth.test.ts` requires the internal `next-auth/core/index.js` `AuthHandler` plus next-auth's own `jose`, so an upgrade can break the test through moved internals alone.

## Tests

Both files need `UNAI_TEST_DATABASE_URL` for a privileged login: they run `runMigrations`, and `index.test.ts` creates the cluster-global login `auth_adapter_test` and grants it `unai_auth`. Neither file has the "Run pnpm test for the required PostgreSQL harness" guard that `packages/postgres/src/isolation.test.ts` and some other database suites carry: without the variable `index.test.ts` dies with `Invalid URL` and `oauth.test.ts` opens a pool with no connection string. Run from the repository root, because `resolve('migrations')` is relative to the working directory:

```
pnpm exec vitest run packages/auth
```

`oauth.test.ts` drives a full sign-in through `AuthHandler` against a local HTTP identity server by overwriting `provider.options.wellKnown` on the object `createAuthOptions` returned. That override is test-only: `createAuthOptions` passes no `wellKnown` or issuer, so next-auth's built-in Google discovery URL applies, and ADR 0008 forbids a production test provider, so do not add a configuration knob to make the test easier. The fake server still advertises and signs `iss: https://accounts.google.com`, because the `signIn` callback refuses any other issuer. SQL never sees the token's issuer; `auth_link_identity` hardcodes the Google value. The test also proves PKCE (`S256`), nonce, refusal of a tampered `state` before any token exchange, and that sign-out revokes the database session.
