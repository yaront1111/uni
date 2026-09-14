# ADR 0007: Close rejected object response streams

Date: 2026-09-14
Status: Implementation detail under CRT-SEC-08-A

The Node.js S3 adapter owns the response body returned by GetObject. A rejected
encryption receipt must not leave an unread stream holding a provider connection.
After every read attempt, destroy a Node response stream, including when receipt
validation or body consumption fails. Preserve the fixed public error code and
never return bytes from an object whose encryption receipt was rejected.

This adds no product policy, screen, or authentication mechanism. Test with a real
Node Readable body and a test-only S3 transport stub. Record the failing regression
before changing the adapter, then run the full suite and registry gate.
