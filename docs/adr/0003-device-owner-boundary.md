# ADR 0003: Explicit device ownership

Date: 2026-09-14
Status: Accepted implementation detail under CRT-SEC-01-A

Design v1 relates devices to users without an explicit owner field. Devices can be referenced by owner-local overlays and audit records. Add owner_scope_id to devices and a composite membership foreign key. A device registration belongs to one owner scope and one user. This does not decide authentication or device registration ceremonies. User rows are actor-private, while all owner data including devices is protected by forced RLS. This strengthens ownership without introducing a new product screen or authentication method.

