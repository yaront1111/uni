# ADR 0035: Historical deviation inventory and recording precedence

Date: 2026-09-19
Status: Retrospective record; predating remains UNVERIFIED

This ADR post-dates the implementing changes. It is dated today and must never
be represented as an advance decision or backdated to make the release gate pass.

The review covers all 128 requirements of approved contract-uai-v0 revision
rev-uai-v0-001, digest 22027aaaeea527eb7b1d2ae3dab70bfabda8ff13c660bf0e0839356f91fe1339.
The requirement-by-requirement inventory, criterion IDs, test locations and ADR
links are in docs/operations/adr-inventory.json. This is an inventory of decisions,
not certification of their implementation or of all product boundary checks.

The historical deliberate differences found are:

- REQ-SEC-07 / PRD §30.6: global registry publication uses its immutable release
  record, principal, correlation metadata and trace/log as the audit instead of
  an owner-scoped audit_events row. ADR 0011 already records this difference;
  packages/registry/src/snapshot.ts implements it. Its first source commit is
  2ce84e5a56ce1ae0ff8b7abd3b409d416316ffb7 (2026-09-17).
- REQ-QA-02 / PRD §§43.4, 46: ordinary CI uses committed synthetic equivalents;
  private real-corpus verification is retained in the operator-run phase-exit
  gate. ADR 0031 already records this placement and the local CLI annotation
  editor. packages/registry/src/corpus.ts and the workflow implement it, starting
  with 14d84c104f4b2dbe52a2919234d0614e4c52f13d (2026-09-19). This record does not
  approve production keying rules solely on synthetic data.
- REQ-OPS-02 / PRD §0.7: the historical record does not establish advance ADR
  timing for every implementation. Some ADRs and implementing code arrive in one
  commit; ADRs 0018–0020 contain no Date field; merged history has no standalone
  add event for several renamed/integrated records. Those files are preserved.
  ADR 0034 now records the previously unrecorded fallback test-storage choice
  and recovery details explicitly, including that it post-dates those changes.

Existing ADR 0024 also explicitly records the deterministic lexical embedding
choice and its recall limit. ADR 0008 records the approved responsive-web and
Google/Auth.js choices; native mobile was not part of V0. ADR 0009 remains a
rejected/unimplemented proposal, not an implemented deviation. Live provider,
private-corpus and deployment evidence still require their own gates; an absent
receipt is not silently reclassified as an approved product deviation.

No additional undocumented deliberate MUST/SHOULD deviation was identified in
this reviewed approved scope. Later PRD roadmap work is kept distinct from the
sealed contract. The release gate stays fail-closed. Under the operator ruling,
`adr-predating-unsatisfiable` is MINOR, UNVERIFIED, deferred to the operator-run
phase-exit gate, not waived. This document cannot repair historical precedence.
