# Derived evidence and inspector privacy

Date: 2026-09-19. Follow-up to [privacy and temporal read boundaries](privacy-and-temporal-read-boundaries.md), within Task A of the [implementation plan](plans/2026-09-19-evolving-understanding.md).

## Scope

The inspector must authorize the requested object before following it to a shared proposition. A readable proposition does not authorize all of its claims, overlays, outcomes, names or derivations. Source-free canonical values also need an explicit evidence path: an accepted assessment alone cannot authorize their contents.

A recorded derivation requires every input of that computation. Alternative complete computations and independent direct evidence may separately support the same value. A surviving operand is not a replacement computation. [ADR 0033](adr/0033-derived-evidence-erasure.md) records the deletion semantics before the additive migration.

The read boundary and deletion boundary serve different purposes. Read authorization withholds a value for a particular request. Evidence deletion removes broken computation records and unsupported outputs, then invalidates composed caches so replay and later reads cannot reconstruct deleted memory. Retained assistant conversation history remains separate source-only evidence.

## Behavior

- Direct explanation and inspector reads return `403 PROPOSITION_SOURCE_WITHHELD` for an unreadable canonical subject. A requested hidden claim, outcome or owner delta is refused before following its link to a readable proposition. Missing subjects remain 404, and the Why panel retains its content-free UNKNOWN response. Invalid source declarations return 400.
- Claims, overlays, outcomes, sourced actor names, contradiction endpoints and complete inference paths are authorized separately. Opaque assessment reasons and free-form thread titles have no source provenance and are returned as null by these inspector surfaces; thread links remain available.
- The broker, inspector and Why panel share a bounded provenance reader. It accepts a direct readable assertion or a complete readable computation, follows nested inputs, preserves complete alternatives and rejects ungrounded cycles or missing inputs. Dependencies, claims and support must be known at the requested knowledge time. Derived outputs carry exact transitive source citations without claiming that an input's author directly asserted the result.
- Mixed-source facts expose only readable direct claim identities and attribution. The broker and selector derive fallback validity intervals from the same authorized claims. Source/object redactions and present owner removals also propagate through derivations.
- Migration `0029_derived_evidence_erasure.sql` replaces the existing owner- and purpose-checked erasure function. Deleting an input removes broken computation payloads, recursively removes unsupported outputs, preserves independent grounded support and clears affected caches through downstream outputs. Applied migration files and application privileges are unchanged. The new file pins LF checkout bytes because migration history is hashed.

Packet and explanation versions identify the changed behavior: broker 0.3.0, selector 0.4.0, explanation 0.2.0 and inspector 0.2.0. The changes do not refresh source evidence or mutate belief confidence during reads.

## Regression evidence

The inspected integrated baseline was `7c50078`: 907 tests passed, four live-connector tests skipped, and all 20 acceptance scenarios passed.

Before the corresponding fixes, ten inspector regressions exposed protected values, supplementary text, names or invalid request-header handling. Six broker regressions exposed derived values through unreadable or later-known inputs, missing citations, unsupported cycles and input-policy bypasses. Nine deletion regressions exposed retained outputs, calculation payloads, summaries and packets after input deletion. Fixtures keep independent readable controls and verify authorized positive reads.

Four additional inspector tests exposed unreadable contradiction endpoints and incomplete inference paths alongside a readable alternate. A further deletion test demonstrated that a derivation cycle could retain its outputs after its only grounding source was erased.

Three Ask tests inspect the actual phrasing-port request, returned and persisted packets, response and recorded answer bytes. They cover attached and unattached owner assertions withheld by sensitivity, purpose or knowledge time. These passed against the previous broker fixes after correcting the test's object-storage lookup.

Deletion fixtures separate current broker reads from schema-valid, hash-correct legacy packets that name only an output. This preserves coverage of caches produced before transitive source citations were added. Preview checks verify rollback; unrelated canonical values and summaries remain positive controls.

The final mixed-source regression first exposed hidden claim IDs, attribution and fallback dates. A subsequent regression verified that removing an unreadable claim from selection cannot turn its same-proposition retraction into an external retraction. Two thread-title regressions reproduced the inspector disclosure before titles were omitted; the web journey now verifies retained thread links with a neutral label.

## Final verification

Verified the implementation recorded in `f78f3ab`, based on Moe's `master` at `7c50078`, in the isolated free-agent worktree:

| Check | Result |
| --- | --- |
| `pnpm test` | 945 passed, four existing live-connector skips; 108 files passed, one skipped. Disposable PostgreSQL/object-storage harness, including migration 0029 and projection replay. |
| Acceptance scenarios | 20/20 passed. |
| `pnpm typecheck` | Root and web passed. |
| `pnpm build` | Next.js production build passed. |
| `pnpm validate:registry` | Releases 0.1.0 and 0.2.0 passed. |
| `pnpm uai registry test` | 736 contract cases passed. |
| `pnpm uai registry shadow-diff --sample corpus:synthetic` | Passed, zero changed semantic outcomes. |
| `pnpm uai corpus run --corpus synthetic` | 12 threads passed identity thresholds. |

This tranche adds 38 tests to its integrated baseline. Final harness output is in the local temporary file `unai-free-followup-final.log`; generated acceptance artifacts are local test output. The owner-local real-corpus gate was not run.

## Limits

This work does not complete the entire Task A audit. Full historical replay of mutable lifecycle and graph state, policy filtering before semantic relevance budgets, the 100-frame retrieval limit and other owner-wide history readers remain separate work. Input world-time validity is not a universal rule for derivations: a calculation may intentionally consume historical inputs; its output's own assessment interval governs applicability.

The provenance reader has node, row, depth and citation limits. Exhausting a graph-load limit conservatively withholds the lookup's entire batch; it does not accept a partially loaded graph. Large-graph pagination and more selective recovery remain retrieval work.

Memory-aging policies, retrieval of old unfinished commitments, production processing and scheduled initiative remain subsequent tasks. No production migration, deployment, external execution or owner-local real-corpus result is claimed.
