# Package boundaries, gold corpus, shadow evaluation, migration governance and metrics

Authority: goal-b2cc3b54-1876-401e-a6a2-527f99b679bc design v1, sealed graph
3a910def2655f69aa3feb9855e481cbda6d643a7325e83e4844b56bd2351c494, node key
`architecture-boundaries-corpus-shadow-eval-and-metrics`. This node owns
CRT-CON-09-A, CRT-NFR-08-A, CRT-QA-02-A, CRT-QA-03-A, CRT-RD-01-A,
CRT-REG-02-A, CRT-REG-05-A, CRT-WRT-01-A, CRT-WRT-09-A and CRT-WRT-10-A. ADR
0031 records its decisions; ADRs 0001–0030 and every delivered slice were
inspected and retained.

## Design entities implemented here

- **`shadow_evaluation_runs`** and **`economic_and_quality_metrics`**, owner
  scoped, added by `migrations/0025_evaluation_and_metrics.sql` with forced RLS,
  purpose-gated policies (`evaluation.shadow` writes a run, `ops.shadow.read`
  reads one; `ops.metrics.read` reads and records metrics) and triggers that
  refuse any update or delete, for every principal.
- **`registry_migration_manifests`**, global reference data beside
  `registry_releases`: forced RLS, no policy, no application privilege, immutable,
  written only by `uai registry publish`.
- **`corpus_annotations`**, as files: the annotation format is
  `corpusAnnotationSchema` in `@unai/domain`; the committed synthetic equivalents
  are under `corpus/synthetic/`, the real ones under the gitignored
  `corpus/private-local/`.

There are now 58 application tables, 55 of them owner-scoped and classified in
`packages/postgres/src/ownership.ts`. The migration also adds the reviewed
definer reader `unai_private.economic_and_quality_inputs`.

## Design screens this node draws

- **Registry release and migration** (`/ops/registry`, extended): the migration
  evidence table from the lint report (computed change class; manifest, shadow
  diff, projection replay and rollback plan each present, missing or invalid),
  the CI-blocked state with each missing piece named, and the recorded shadow
  runs with all seven diff counts and whether production stayed unchanged.
- **Metrics and cost** (`/ops/metrics`, new): every metric of the screen, the
  measured ones with numerator and denominator, the rest as not measured with the
  reason.
- **Corpus and evaluation** (`/ops/corpus`, new): the private path's location,
  ignore and commit-block status, real and synthetic thread counts, the local
  CLI annotation steps, label coverage by category (items, and threads lacking
  each), the thresholds recorded in CI, and per-keying-rule results --
  real-corpus results when recorded, otherwise the verification failures.

## Acceptance evidence

| Criterion | Where it is proven |
| --- | --- |
| CRT-CON-09-A | `src/boundaries.test.ts`: the walk from every connector package reaches no commit declaration, commit route or belief-write SQL; probes importing, calling through a helper, routing to and writing past the commit path each fail it. |
| CRT-NFR-08-A | `src/boundaries.test.ts`: no package or kernel module imports `apps/web` by specifier, path or manifest; the belief engine's import closure holds no gateway or extraction module; probes fail both. `packages/belief/src/no-llm.test.ts`: the engine decides with every model variable removed. |
| CRT-RD-01-A | `src/boundaries.test.ts`: the gateway and the plugin runtime import no driver or repository package, read no database credential and reach no memory table or repository function except through `packages/context`; probes fail each rule and a plugin calling the broker passes. |
| CRT-WRT-01-A | `src/boundaries.test.ts` (no path from extraction or the gateway to an assessment writer or assessment SQL, probes fail it) and `packages/model/src/assessment-boundary.test.ts` (real gateway output written without a transaction is refused by RLS and by the transaction foreign key). |
| CRT-REG-02-A | `packages/registry/src/evaluation.test.ts` and `cli.test.ts` (lint, test, corpus shadow-diff as CLI processes; lint exits 1 on a missing §17.3 field), `packages/registry/src/evaluation-db.test.ts` (owner-sample shadow-diff and projection-replay as CLI processes over TLS), and the CI workflow steps. |
| CRT-REG-05-A | `packages/registry/src/evaluation.test.ts`: an identity-affecting 0.2.0 is refused by `uai registry lint` without a manifest, and for a missing shadow diff, projection replay output or rollback plan each by name, an understated class or evidence for another release pair; it lands once all are present. `evaluation-db.test.ts`: publish materializes the manifest after its base release. |
| CRT-WRT-09-A | `packages/registry/src/evaluation-db.test.ts`: a shadow run over an owner's memory emits all seven diffs with real changes and leaves every production table's digest identical; its only writes are its own run row and one audit event. |
| CRT-WRT-10-A | `packages/api/src/metrics.test.ts`: the synthetic corpus is ingested, routed and extracted through the real gateway, and `GET /v1/ops/metrics` reports every required metric equal to counts taken independently from the same rows. |
| CRT-QA-02-A | The private path is gitignored and tracked by nothing (`evaluation.test.ts`, CI step); a forced commit is refused by the hook (`evaluation.test.ts`); CI scores the synthetic corpus against the recorded thresholds. **The ten labelled real Gmail threads do not exist in this repository or on this machine**; see below. |
| CRT-QA-03-A | `uai corpus verify` refuses until real-corpus results cover every production keying rule at its current version; recording and verification are proven end to end in `evaluation.test.ts`. **No real-corpus results are recorded**; see below. |

## What this node does not claim

- **Phase exits.** Neither the Phase 0 exit (PRD §46) nor the Phase 1
  real-corpus threshold exit (PRD §47) is claimed. Both need real-corpus results
  that do not exist yet, and `pnpm check:phase-exit` fails until the owner
  records them (below). Nothing here weakens, skips or soft-fails that gate, and
  no synthetic run is recorded as a real one.
- **Real Gmail threads.** PRD §43.4 requires at least ten real, user-selected,
  manually labelled threads. They must come from the owner's own mailbox and be
  labelled by a person; no agent may select, generate, sanitize into or relabel
  them, and none exists here. Until the owner imports and labels them and
  records results, `uai corpus verify` fails with
  `REAL_CORPUS_EVALUATION_REQUIRED` / `REAL_RESULTS_MISSING`, and
  `pnpm check:phase-exit` fails with it. CRT-QA-02-A's real-thread half and
  CRT-QA-03-A are therefore **open owner actions, not met**. The tooling half of
  CRT-QA-02-A (gitignored path, commit block, CI tracked-file guard, annotation
  format, CLI, synthetic equivalents, thresholds scored in CI) is delivered.

  Owner steps, on the machine that holds the mailbox export:

  1. Export at least ten Gmail threads you select, then for each one run
     `pnpm uai corpus import --source <export.json>`.
  2. Label each thread with `pnpm uai corpus annotate --thread <ref>` (the ref
     `import` printed), editing the annotation file it writes until it lists no
     missing category; `pnpm uai corpus annotate` lists every thread's missing
     categories. Together the threads must cover source spans, entities, frame
     instances, slots, propositions, commitments, resolutions and non-memory
     items.
  3. Record the results with `pnpm uai corpus run --corpus private --record`,
     check them with `pnpm uai corpus verify`, and commit
     `corpus/expected/real-corpus-results.json` (counts and rates only). This is
     what CRT-QA-03-A waits for.
  4. Refresh the Corpus and evaluation screen with
     `pnpm uai corpus status --report <path>`.
- **Commit block activation.** The hook is active in a clone once
  `pnpm install` (the `prepare` script) or `pnpm hooks:install` has set
  `core.hooksPath`. It was not run against the shared Git configuration by this
  node; CI refuses a tracked private file regardless.
- **Metrics without inputs (deferred, not dropped).** The seven metrics
  CRT-WRT-10-A names are measured and tested. The remaining states of the
  Metrics and cost screen are still owed by the product. Until their inputs are
  recorded, `GET /v1/ops/metrics` returns each in `notMeasured` with its reason
  (or the screen marks it not measured). None is written to
  `economic_and_quality_metrics`, and none is shown as zero or as an estimate.
  When an input is recorded, the metric is computed through
  `unai_private.economic_and_quality_inputs`, the same definer-function pattern,
  with a test.

  | Deferred metric | Input it waits for |
  | --- | --- |
  | Overlay visibility success | Overlay visibility probes: read-after-write probe outcomes. |
  | False certainty incidents | False-certainty labels: owner-labelled incidents. |
  | Unsupported personal claim rate | Aggregated grounding outcomes from the answer grounding validator. |
  | Clarification prompts per active day | Clarification cards (`clarification_cards`). |
  | Repeated question violation rate | Repeated-question records over clarification cards. |
  | Source-only items later promoted | Source-only promotion records. |
  | False proposition-collision rate | Proposition-collision labels. |
  | Model cost by connector and capability | Per-connector and per-capability cost attribution on model call records. |
  | Ingestion, projection read and packet assembly P95 | The load harness's `performance_measurements`. |
- **Annotation editor.** The CLI and file-based editor is the accepted design:
  annotation happens locally through `uai corpus annotate`, not in the web
  application (ADR 0031 §3). The Corpus and evaluation screen says so, shows the
  commands, and shows label coverage by category from the
  `uai corpus status --report` output, which holds counts only. No route, proxy
  mapping or server module reads under `corpus/private-local/` or
  `UNAI_PRIVATE_CORPUS_DIR`. The web reader refuses a status file placed there,
  and `apps/web/lib/corpus-status.test.ts` fails if server code names the path.
- **Extractor shadow runs** compare extraction versions already recorded for
  canonicalized claims; they do not call a model.
