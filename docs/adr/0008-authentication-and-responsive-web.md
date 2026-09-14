# ADR 0008: Delegated sign-in, sessions and responsive web

Date: 2026-09-14
Status: Accepted implementation choices, operator approval 8b34b4cc2c28dc99827581219988b820c68f72b35a044f5db6f68726f75842d7, review version 10.

This supersedes the open-choice paragraph in ADR 0001. Google OpenID Connect
through Auth.js (the stable next-auth integration) is the sole sign-in method.
Identity is issuer plus subject, never email equality. Request only openid,
email and profile; connector consent is separate. No production test provider.

Use opaque PostgreSQL sessions, Secure/HttpOnly/SameSite=Lax cookies and a
seven-day absolute lifetime. Database expiry cannot be extended by Auth.js
rolling-session callbacks. Logout revokes the current session; sign-out-all
and account disablement revoke all sessions; device removal revokes its sessions.
Store only a SHA-256 digest of the high-entropy session token in the database.
Auth.js owns OAuth state, PKCE, CSRF and callback verification. Its authentication
ceremony necessarily precedes an authenticated actor; it grants no memory/API
access. Business endpoints independently require actor, owner, purpose and
correlation ID, check membership, and execute under forced owner RLS.

A dedicated unai_auth role receives only narrow fixed-search-path definer
functions for identity bootstrap and token resolution. It receives no direct
application-table access. Identity and session tables have forced owner RLS;
the ordinary application role cannot read token digests. Bootstrap atomically
creates the user, personal owner scope and membership. OAuth tokens are not
retained. Device registration binds the authenticated session to a device;
removal retains a tombstone and revokes sessions atomically.

The existing Next.js app serves responsive desktop and phone web. No native,
offline or push scope is introduced. Run Next.js and Fastify behind their own
TLS listeners; forwarded-proto is not a substitute for an encrypted socket.
Production configuration requires Google OAuth credentials and trusted database
and API CA certificates. Encryption-at-rest deployment evidence remains required.

Reference: https://github.com/nextauthjs/next-auth (stable adapter/session API).
This ADR precedes this integration's source changes and is not acceptance proof.
