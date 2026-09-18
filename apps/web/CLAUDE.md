# apps/web

`@unai/web` owns the browser-facing surface: the TLS listener, the Auth.js sign-in ceremony, server-rendered screens and the same-origin write proxy. It must not own data access or business rules: its only database handle is the `unai_auth` pool used to resolve a session, and everything else is an HTTPS call to `@unai/api`. Its only workspace dependencies are `@unai/auth`, `@unai/postgres`, `@unai/domain` and `@unai/secrets`.

## Runtime shape

- `server.ts` is the only supported way to run the app (`start` is `tsx server.ts` and `dev` is the same with `--dev`). It also needs `UNAI_WEB_TLS_KEY_FILE` and `UNAI_WEB_TLS_CERT_FILE`; the full variable list is in `docs/foundation.md`. `NEXTAUTH_URL` is the single source of hostname, port and the expected `Host` header: it must be a bare `https:` origin or startup throws `WEB_TLS_CONFIG_INVALID`, and a request with another `Host` gets 421. The security headers (HSTS, `nosniff`, `X-Frame-Options`, `Referrer-Policy`) are set here, not in `next.config.ts`. The listener binds to `127.0.0.1` unless `UNAI_WEB_BIND` is set.
- Plain `next dev` or `next start` does not work as a shortcut: `identity()` in `lib/server.ts` throws `TLS_REQUIRED` when the socket is not encrypted, and `pages/api/auth/[...nextauth].ts` answers 426. ADR 0008 rules out forwarded-proto as a substitute.
- Webpack is forced in both places (`next build --webpack` in `package.json`, `webpack:true` in `server.ts`) because the `.js`-to-`.ts` `extensionAlias` that lets Next bundle the workspace packages lives in the `webpack()` hook of `next.config.ts`. Keep the two in step.
- This folder has its own `tsconfig.json` (`moduleResolution: bundler`, `jsx: react-jsx`, strict but without the root's `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`). Imports here are extensionless, unlike the `.js` specifiers used in `packages/`. The root `tsconfig.json` does not include `apps/`, so a bare root `tsc` never checks this code; `pnpm typecheck` covers it through its `pnpm --filter @unai/web typecheck` half.

## `lib/server.ts`

This is the whole server-side toolkit, imported by `server.ts`, every `getServerSideProps` and both API routes.

- `required(name)` reads plain configuration and throws `CONFIG_REQUIRED:<NAME>`. Credentials (`UNAI_AUTH_DATABASE_URL`, `NEXTAUTH_SECRET`, `GOOGLE_CLIENT_SECRET`) go through the private `secret(name)` helper instead. `packages/secrets/src/index.test.ts` reads this file as text: it must mention `@unai/secrets`, must never contain `required('<credential>')`, and every credential name the file mentions must appear as a string literal in a call matching `/secret\w*\(\s*(?:secrets,\s*)?'NAME'/i`, as `secret('<NAME>')` does. Do not rename the helper to something without `secret` in it or pass the name through a variable.
- `authPool()` memoises the pool promise and clears it on failure so a later request can retry. It is for `resolveSession` and the Auth.js adapter only; never query application tables through it.
- `identity(req)` returns the resolved session (`userId`, `ownerScopeId`, `deviceId`) or `null`. It is the only source of owner scope and actor in this app.
- `apiRequest(path, method, headers, body?)` verifies the API certificate against `UNAI_API_CA_FILE`, requires `UNAI_API_ORIGIN` to be a bare `https:` origin (`API_TLS_CONFIG_INVALID`), destroys the request after 15 s of socket inactivity, caps the response at 1 MiB and requires JSON. A transport failure rejects with `API_UNAVAILABLE`, an oversized or non-JSON response with `API_RESPONSE_INVALID`, and missing configuration with its own `CONFIG_REQUIRED:<NAME>` or file error; an HTTP error status is a resolved `{status, body}` that the caller must check.

## Reads and writes take different paths

Reads happen in `getServerSideProps`: set `Cache-Control: no-store`, call `identity(req)` and redirect to `/signin` (`/signin?reason=expired` when a cookie was present; `sources.tsx` always uses the expired form), call `apiRequest` with `GET`, the forwarded cookie, `x-owner-scope-id` from the session, the route purpose and a fresh `randomUUID()` correlation id, redirect on 401, and parse a 200 body through the `@unai/domain` public schema (`publicDeviceSchema`, `publicEvidenceSchema`, `jobsViewSchema`, `deadLetterViewSchema`). Evidence and connector reads also send the pinned `x-data-purpose` and `x-maximum-sensitivity` values. Any other status becomes a fixed English sentence in an `error` prop; API error bodies are never shown. Wrap the call in `try`/`catch` as `sources.tsx` and `ops/jobs.tsx` do, because `apiRequest` rejects when the API is unreachable; `index.tsx` does not, so that case is a 500 there. Identifiers from the query string are validated with the schema's field (`publicEvidenceSchema.shape.evidenceId`, `publicJobSchema.shape.jobId`) before they reach a URL or the page.

Writes are browser `fetch` calls to `pages/api/platform/[...path].ts`, which accepts `POST` only. Its checks run in a fixed order with fixed codes: 401 `SESSION_EXPIRED`, 405 `METHOD_REFUSED`, 403 `ORIGIN_REFUSED` (the `Origin` header must equal the `NEXTAUTH_URL` origin, so a request without one is refused), 403 `PURPOSE_REFUSED`, 400 `REQUEST_CONTEXT_REQUIRED`, and 503 `SERVICE_UNAVAILABLE` for anything thrown. The purpose is derived from the path by the ternary chain in that file (`devices`, `devices/<uuid>/revoke`, `sessions/revoke-all`, `evidence`, `ops/dead-letter/<uuid>/retry`), and the browser's `x-purpose` must equal it; an unmapped path is refused rather than forwarded. For `evidence` the proxy overwrites `ownerScopeId`, `actorRef` and `idempotencyKey` in the body from the session and the header, and pins `x-data-purpose: PERSONAL_ASSISTANCE` and `x-maximum-sensitivity: RESTRICTED`. The upstream status and body are passed through unchanged.

Components follow one write convention: send `x-purpose`, a `crypto.randomUUID()` `x-correlation-id` and an `idempotency-key`; on 401 go to `/signin?reason=expired`; on any other failure show a fixed message in `role="alert"`; on success reload or navigate so the server render re-reads state. There is no client-side store. `Evidence.tsx` keeps one `attempt` ref per selected file so a retry reuses the same idempotency key and `externalId`, and its 512 KB limit exists because the base64 envelope must fit the API's 1 MiB `bodyLimit` (`packages/api/src/index.ts`) and the proxy route's own body parser, which is left at the Next.js default of 1 MB.

## Screens and their tests

A screen exists only when the node's design draws it; `docs/foundation.md`, `docs/evidence-runtime.md` and `docs/jobs-runtime.md` record which screens and states were delivered. `Navigation.tsx` renders undelivered destinations as `aria-disabled` spans, and `Access.test.ts` expects them to stay visible. Copy must not overclaim: `Evidence.test.ts` pins the "Search and semantic extraction are not available" wording, and `Jobs.test.ts` fails if the markup contains `payload`. Status is always text, never colour alone.

Component tests render with `renderToStaticMarkup(createElement(...))` and assert on strings; there is no jsdom or browser. Two consequences: tests are `.test.ts` files that use `createElement` because the root `vitest.config.ts` includes only `apps/**/*.test.ts` (a `.test.tsx` file is silently skipped), and effects and handlers never run, so every designed state must be reachable from props alone. That is why `Access` takes `state`, `Jobs` takes `retriedJobId`, and all of them take `error`. Pages stay thin (`export default <Component>` plus `getServerSideProps`) so the component carries everything a test can see.

Run them alone from the repository root; they need no database or TLS:

```
pnpm exec vitest run apps/web
```

## Checklist: adding a screen or a browser write

1. Add the component in `components/` with a props-only state model, and a `.test.ts` next to it with one assertion per drawn state, the skip link and the labelled controls.
2. Add the page with the `getServerSideProps` pattern above; parse API bodies with a `public*Schema` from `@unai/domain` rather than a local type.
3. In `Navigation.tsx`, move the label out of the disabled `navigation` array into a real link and extend the `current` union.
4. For a new write, extend the path-to-purpose chain in `pages/api/platform/[...path].ts` with an anchored pattern, and keep it identical to the purpose the API expects for that route in `packages/api/src/platform.ts`.

## Traps

- `packages/api/src/registry-boundary.test.ts` walks this folder: any path containing `registr`, or any non-test `.ts`, `.tsx` or `.json` file that mentions `@unai/registry`, `packages/registry` or `registry/releases`, fails the suite. `packages/api/src/reference-stack.test.ts` reads `package.json` and requires `next` while refusing graph, vector-store and Redis dependencies.
- `/signin` is both the Auth.js `signIn` and `error` page (`createAuthOptions` in `@unai/auth`), so `pages/signin.tsx` maps any `?error=` to the `refused` state and `?reason=expired` to `expired`. Keep those query names stable.
