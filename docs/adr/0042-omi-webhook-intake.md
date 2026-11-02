# ADR 0042: Omi webhook intake

Date: 2026-11-02
Status: Accepted. It decides ADR 0041 D10(a) and is recorded before any
webhook code, as PRD §0 rule 7 requires.
Epic: epic-8d6f813adaf54bb4891d0e6152dce7bb (Omi wearable). Task: task-f4c97813333c4425a14de32d675d08a5.

This is a decision record. It adds no route, purpose, secret, migration or test.

## Context

### What Omi's webhooks are (as documented 2026-11-02; ADR 0041 OMI-8 and the epic notes)

- **W-1, kinds.** Four: memory (conversation) creation, real-time transcript,
  audio bytes (PCM16) and day summary.
- **W-2, shape.** Each is a POST to a URL the owner configures in the Omi app. The only
  identity it carries is a `uid` query parameter and an `Idempotency-Key` header.
- **W-3, unsigned.** No shared secret, signature header or IP allowlist is
  documented. Nothing in the request proves that Omi sent it.
- **W-4, delivery.** Omi times out after 30 seconds and documents no retry
  schedule. Private and loopback hosts are refused, so the target needs a public
  HTTPS name.

Nothing else is assumed about Omi's webhooks. If a later task re-checks
docs.omi.me and finds a signature or a retry scheme, it supersedes W-3 and W-4
with a dated citation.

### Where Uai's boundary stands

- **B-1, the API boundary.** `packages/api/src/index.ts:31-32` sets
  `trustProxy:false`, a 1 MiB `bodyLimit` and a 30 s `requestTimeout`. The
  `preParsing` hook (`:40-57`) refuses in this order: no TLS (426
  `TLS_REQUIRED`), no authenticated identity (401 `AUTHENTICATION_REQUIRED`), an
  invalid request context (400 `REQUEST_CONTEXT_INVALID`), a failed `authorize`
  (403 `ACCESS_DENIED`), and a write without an `idempotency-key` of 16-128
  characters (400 `IDEMPOTENCY_KEY_REQUIRED`). `actorId` comes only from the
  session.
- **B-2, one purpose per route.** `routePurpose`
  (`packages/api/src/platform.ts:76`) names the single purpose a route admits and
  the `preHandler` (`:177`) answers 403 `PURPOSE_REFUSED` for any other.
- **B-3, the browser's door.** `apps/web/pages/api/platform/[...path].ts` is the
  only way a browser reaches the API. It requires a session (`:10-11`, 401
  `SESSION_EXPIRED`), a same-origin write (`:18`, 403 `ORIGIN_REFUSED`) and a
  path-to-purpose mapping (`:19-46`).

### Topology (ADR 0043)

- **T-1.** The host admits only ports 22, 80 and 443 inbound (D1). The web
  process listens publicly on 443 at `uai.<owner-domain>`; the API binds
  `127.0.0.1:3443` and is never public (D3). ADR 0043 rejects a public API
  certificate as needless exposure.
- **T-2.** So Omi's cloud could reach only the web process, and only on a new
  public route.

### The pull path

- **P-1.** ADR 0041 D2 and D7 define the pull: an authenticated GET of
  completed conversations, a keyset cursor, and `CONNECTOR_RATE_LIMITED` on a 429.
  Omi allows 60 list reads per key per hour, and 25 of them may carry transcripts
  (OMI-8).
- **P-2.** Today a sync runs only when the owner asks:
  `POST /v1/connectors/:id/sync` under `connector.sync`. Durable `connector.sync`
  jobs (task-1d49e470) and a scheduler tick with `intervalMs` and
  `minimumIntervalByType` (task-7494e8b3) are PLANNED, not delivered.

### The latency question, answered by the owner

Asked how fast an Omi conversation must reach Uai after it ends, the owner
answered, quoted verbatim:

> Owner, 2026-11-02 (REPL, while this task was planned): "Minutes are fine (Recommended)"

The option read: pull-only, latency bounded by the scheduled sync, with the
webhook design written up as the upgrade path.

## Options

### Option A: Never accept webhooks (pull only)

**Mechanism.** Omi's webhook settings stay unused. Conversations arrive only by
the authenticated pull of ADR 0041, started by the owner today and by the
scheduler (P-2) later. Latency equals the scheduler's OMI interval.

**PRD §31 threats.**
- Prompt injection from connected content: unchanged. Transcript text enters
  only through the authenticated read and is data (§27.4, invariant 41).
- Duplicate connector delivery: unchanged. The keyset cursor and the evidence
  `externalId` already absorb a repeated conversation (ADR 0041 D7).
- Replay attacks on write transactions: unchanged. No new write route exists.
- Unauthorized connector token use: unchanged. The only credential is the
  `secret://` handle for the Developer API key (§30.5, ADR 0013).
- Cross-scope data leakage: unchanged. Every read runs inside the owner's
  `withOwnerTransaction`.
- Secret leakage in logs: unchanged. There is no URL that carries a token.

**Operational cost.** None. No public route, no new secret, no rate limiter.
The 25 transcript lists per hour set a lower bound on the interval, and that
budget is shared with manual syncs and the live suite.

**Owner benefit.** Conversations appear within one sync interval. The owner
accepted minutes.

### Option B: Doorbell, not delivery

**Mechanism.** A per-connector capability URL: a random token of at least 256
bits, mapped to one connector row and its owner scope. The handler ignores the
pushed body except the conversation id, checks `uid` against the connector's
external account, deduplicates on `Idempotency-Key`, applies a small body limit
and a per-connector rate limit, audits under a new purpose (for example
`connector.webhook`), and then triggers an authenticated PULL of that
conversation. The stored content therefore has the trust level of the pull, never
of the pushed body.

**The boundary exception B needs (a recorded deviation).** B-1 and B-3 both
require a session, so the route must sit outside the session check in BOTH
layers:
1. a public web route that is not the session-only proxy (B-3), reachable on
   443 (T-1); and
2. an API route registered outside `createApiBoundary`'s `preParsing` session
   check (B-1), or a loopback service credential that stands in for the session.

Either needs its own ADR text before code: it breaks the rule that `actorId`
comes only from the session, and it needs its own entry in `routePurpose` (B-2).

**Token storage.** Two shapes. A `secret://` handle (§30.5, ADR 0013) keeps the
token out of the database but needs a lookup by value. A stored hash for lookup
follows the `auth_sessions.token_hash` pattern (migrations/0002_authentication.sql)
and allows a constant-time indexed lookup. The follow-up ADR chooses. A token in
a URL is visible in Omi's configuration and in any URL logging, so owners need
rotation and revocation.

**PRD §31 threats.**
- Prompt injection from connected content: closes the pushed-body path, because
  the body is ignored and content comes from the authenticated pull. It adds no
  injection route.
- Duplicate connector delivery: opens it (Omi documents no retry schedule, W-4,
  and may deliver twice). Closed again by `Idempotency-Key` dedupe plus the
  evidence `externalId`.
- Replay attacks on write transactions: opens it. A captured URL can be
  replayed by anyone. Contained because a replay only triggers a pull of data
  Omi already holds, never a write of attacker content.
- Unauthorized connector token use: opens it. The URL token is a bearer
  credential in a place §30.5 does not normally allow; rotation and revocation
  are required.
- Cross-scope data leakage: opens it. The token must map to exactly one owner
  scope and the `uid` must match that connector's account; a wrong mapping would
  trigger a pull into the wrong scope.
- Secret leakage in logs: opens it. The token lives in a URL and URLs get logged.
- Quota exhaustion (not a §31 name): a doorbell flood spends the 25/h transcript
  budget unless coalesced into one sync per window.

**Operational cost.** A public HTTPS endpoint reachable by Omi's cloud on the
single public listener (ADR 0043 D3), a new credential, a rate limiter, a purpose
with its policy and audit, rotation UI and a runbook.

**Owner benefit.** Near-real-time arrival, bounded by the pull rather than by
the scheduler interval. It buys latency only.

### Option C: Trust the pushed body

**Mechanism.** The public handler parses the pushed transcript, stores it as
evidence and runs triage directly, without an authenticated read.

**PRD §31 threats.**
- Prompt injection from connected content: opens it. An unsigned body (W-3) lets
  anyone who holds or guesses the URL inject fabricated transcripts, and
  invariant 41 says connector content cannot grant itself authority.
- Duplicate connector delivery: opens it, with no authenticated cursor to
  reconcile against.
- Replay attacks on write transactions: opens it. A replayed body is a replayed
  evidence write.
- Unauthorized connector token use: opens it. The URL token alone authorizes a
  write.
- Cross-scope data leakage: opens it. Routing rests on an unauthenticated `uid`.
- Secret leakage in logs: opens it, as in B.
- Model hallucination becoming memory: opens it. Evidence that no authenticated
  read backs can reach extraction.

The real-time and audio webhooks would also deliver audio, which ADR 0041 D2 and
D10 excluded.

**Operational cost.** Everything B costs, plus a parser for four payload kinds.

**Owner benefit.** The same latency as B with the worst trust. Expect a
rejection.

### Comparison

| Option | New public surface | §31 threats opened | Latency | Cost |
|---|---|---|---|---|
| A | none | none | one sync interval | none |
| B | one capability URL, two boundary exceptions | 5, each contained | seconds | high |
| C | the same URL, plus a trusted body | 7, not contained | seconds | higher |

## Recommendation

Option A: never accept Omi webhooks. Pull only; the production epic's scheduled
sync is the latency bound.

Reasons:
- The owner said minutes are fine (quoted above), and A delivers that.
- A opens no §31 threat and keeps ADR 0043's single public listener and the
  boundary order of `packages/api/src/index.ts:40-57` intact.
- B buys only latency, at the price of two boundary exceptions, a bearer
  credential in a URL, a rate limiter, a purpose and its audit trail.
- C fails PRD §27.4 and invariant 41 outright.
- Omi's content is third-party data under §30.8; the narrower the door, the
  smaller the exposure.

Consequence for the scheduler: OMI needs a `minimumIntervalByType` entry
(task-7494e8b3) that keeps transcript lists within 25 per hour per key, shared
with manual syncs and the live suite. The scheduler task picks the value.

## Upgrade path if latency requirements change

If the owner later needs seconds, a later epic builds B. Follow-up tasks, title
and one line each, with no further design:

1. **ADR amendment: webhook boundary deviation.** Record the public web route and
   the API route outside the session check, and the token storage choice.
2. **Migration: webhook token, purpose and policy.** Token hash or handle, the
   `connector.webhook` purpose, its SQL policy and `ownership.ts` classification.
3. **Public web route and loopback API intake.** A route outside the session-only
   proxy, with a small body limit that ignores the body except the conversation id.
4. **Dedupe, rate limit and coalescing.** `Idempotency-Key` deduplication, a
   per-connector rate limit, and one `connector.sync` per window.
5. **Owner UI to create, rotate and revoke the URL.**
6. **Security tests.** Wrong token, foreign `uid`, oversized body, replay or
   flood, and a pushed body that is provably ignored.
7. **Runbook.** Setting the URL in the Omi app, rotation, and what to do after a leak.

## Consequences

- No webhook route, purpose, secret or migration exists. Omi's webhook settings
  stay unused.
- ADR 0041 D10(a) is decided here. ADR 0041 already names this record at its
  header and in D10(a), so it needs no edit.
- A future owner request for seconds-level latency reopens this record through
  the upgrade path, not through a quiet code change.

## PRD references

§0 rule 7, §27.4, §27.5, §30.5, §30.8, §31, invariant 41; ADR 0013, 0041, 0043.
