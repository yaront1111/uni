# ADR 0033: Erasing inputs of recorded derivations

Date: 2026-09-19
Status: Accepted. Recorded before the implementation migration.

Authority: PRD sections 12.10, 24.4, 30.7, 42 and 44.18; extends ADR 0030's
evidence-erasure cascade and ADR 0017's dependency records.

## Decision

One `DERIVE` operation records one computation: its input claim and proposition
IDs, evaluator and version, calculation inputs and output. All recorded inputs
belong to that computation. Erasing or discovering a missing input invalidates
the whole dependency record, including its calculation inputs. Remaining operands
are not a replacement computation and cannot certify the old output.

This is a deletion rule, distinct from ordinary belief reassessment. PRD 24.4
requires an output to become unsupported when all its support is invalidated.
A broken computation supplies no remaining support, but another complete
computation or genuinely independent live evidence may still support the same
output. Preserve that independently supported canonical value. Otherwise remove
the unsupported output and propagate the erasure through downstream derivations.

`ADD_SUPPORT` is separate from `DERIVE`, and its rows do not identify a dependency
record. A `DERIVATION` support edge cannot rescue an output whose recorded
computation is broken merely because the edge's operand survives. A separate
complete dependency record can rescue it. An independently live direct claim or
`DIRECT_ASSERTION` support backed by retained source evidence can also rescue it;
neither missing inputs nor rejected/suppressed claims count as live support.

Rescue requires grounded support, calculated from live independent evidence and
extended only through complete computations whose inputs are already grounded.
Mutually retained proposition rows do not ground one another. The erasure uses a
monotone fixed point bounded by the owner's finite proposition graph; failure to
reach that bound aborts the transaction rather than retaining unverified output.
This covers cycles admitted through `DERIVE`, which the existing `ADD_SUPPORT`
cycle check does not inspect, without redesigning the write governor.

The deletion workflow never changes the output's normalized value to approximate
a recomputation. A new computation needs its own governed write and provenance.
Ordinary suppression/reassessment semantics remain outside this change.

## Cascade and caches

Keep separate sets for outputs affected by erasure and outputs actually removed.
Erase broken dependency rows even when independent support preserves the output.
Invalidate cached summaries, context packets, briefings and other existing
composed-memory caches naming any affected output: these may quote deleted inputs
without naming those inputs directly. Include dependency IDs when erasing recorded
operation payloads. Preserve unrelated canonical values and caches.

Use the existing `unai_private.erase_evidence` definer, owner/purpose checks,
transaction boundary, tombstones, count-only receipt and subsequent projection
replay. Add a migration replacing the function; do not edit applied migrations or
grant the application new deletion privileges. Check actual input-row existence
as well as the current erasure set, so sequential and batched deletions agree.

## Verification

Real API regressions cover claim and proposition inputs, partial input deletion,
transitive outputs, sequential and batched deletion, a surviving operand's
`DERIVATION` edge, alternative complete computations, independent direct support,
output-only cache references, preview rollback, export, current/historical reads
and projection replay. Positive controls retain unrelated live evidence and
independently supported output. Assistant conversation evidence remains separate
`SOURCE_ONLY` history and is never used to reconstruct erased canonical memory.
