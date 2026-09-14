# ADR 0004: Transactional migration ledger

Date: 2026-09-14
Status: Accepted implementation detail under the Git SQL migration requirement

Run migrations using a dedicated privileged principal over verified PostgreSQL
TLS. Serialize runners with a session advisory lock. Store each filename and
SHA-256 digest in a private deployment ledger, atomically with its migration.
Refuse changed, removed, or reordered history rather than silently replaying it.
The SQL files are trusted repository code; the runner owns transaction boundaries
and accepts the existing outer BEGIN/COMMIT envelope for compatibility.

The ledger is deployment metadata, not owner data. Its exact table is exempt from
owner RLS only when the application role has no schema or table privileges.
Every other application table remains subject to the ownership coverage check.
The runtime application must never receive migration credentials.

This does not resolve authentication, phone delivery, or semantic registry rules.
