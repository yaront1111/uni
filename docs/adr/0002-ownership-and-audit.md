# ADR 0002: Ownership and audit foundation

Date: 2026-09-14
Status: Accepted requirements; implementation pending

Authority: approved contract CRT-SEC-01-A, CRT-SEC-08-A and design v1.

Every API requires an authenticated actor, owner scope, declared purpose and
correlation ID; writes require idempotency keys. TLS is mandatory. PostgreSQL
RLS and application authorization checks independently enforce owner isolation.
Application database credentials must not own tables or bypass RLS. Request
context must be transaction-local and must not leak through connection pooling.
Every later owner-scoped table must be covered by migration and isolation checks,
including child tables whose owner is currently implicit in the design.

The shared audit_events table stores actor, owner scope, purpose, accessed object
and field references, policy decision, model or code version, result, correlation
ID and creation time. Application audit access is append-only. Audit metadata
must not contain evidence content, secrets or raw object keys. Public object IDs
are distinct from storage keys. Storage adapters resolve private keys only after
authorization. Database and object-storage encryption at rest require deployment
evidence; a configuration flag alone is not proof.

Tests must exercise real PostgreSQL RLS without application filters, using a
non-owner/non-BYPASSRLS role, and include cross-owner reads and writes, connection
reuse, audit mutation refusal and newly introduced table coverage. Whole-system
audit coverage and Audit log UI belong to production-operations.
