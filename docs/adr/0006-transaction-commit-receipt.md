# ADR 0006: Verify the database commit receipt

Date: 2026-09-14
Status: Accepted implementation detail under the ownership and audit foundation

A PostgreSQL transaction in an aborted state answers COMMIT with a ROLLBACK
command tag. A callback can catch a query error and return normally, so successful
callback completion alone does not establish durable material work or audit.

The owner transaction adapter must require a COMMIT command tag before returning
the callback result or recording success telemetry. A rollback receipt produces
the fixed TRANSACTION_NOT_COMMITTED error. This preserves the existing atomic
work/audit contract and introduces no authentication or product policy choice.

Verify against real PostgreSQL: write audit, catch a failing SQL statement inside
the callback, return a result, and assert refusal plus absence of the audit row.
Also verify the pooled connection can serve the next owner transaction.
