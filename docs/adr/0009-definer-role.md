# ADR 0009: Explicit restricted definer role

Date: 2026-09-14
Status: Proposed, not implemented; automatic approval review rejected the migration

The existing definer functions rely on a migration principal bypassing forced
RLS. Managed PostgreSQL does not grant ordinary superuser access. Use a dedicated
NOLOGIN, NOSUPERUSER, NOBYPASSRLS unai_definer role instead. Give that role explicit
RLS policies and only the table permissions used by the fixed-search-path auth
and membership functions. Neither application nor auth login is a member.
Keep forced owner RLS for unai_app and the narrow EXECUTE grants for unai_auth.
The proposed migration operator remains trusted; it may own the definer role, but runtime
logins must not. This records the proposal before implementation.

Automatic approval review rejected the proposed persistent migration because
its broad table access and permissive policies were considered a significant
security blast radius. No migration was written. The prospective role test was
withdrawn with this unimplemented alternative; all existing owner-isolation,
append-only audit, restricted auth-login and session lifecycle checks remain.
The delivered implementation retains the previously documented requirement for
a privileged migration/function owner on self-managed PostgreSQL. Managed RDS
deployment compatibility is not verified. A narrower definer design requires
review before this proposal can be implemented.
