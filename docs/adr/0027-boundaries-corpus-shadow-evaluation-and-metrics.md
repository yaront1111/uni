# ADR 0027: Package boundaries, the gold corpus, shadow evaluation, registry migration governance and metrics

Date: 2026-09-19
Status: Accepted
Node: `architecture-boundaries-corpus-shadow-eval-and-metrics` of
goal-b2cc3b54-1876-401e-a6a2-527f99b679bc (design v1, sealed graph
3a910def2655f69aa3feb9855e481cbda6d643a7325e83e4844b56bd2351c494).
Criteria: CRT-CON-09-A, CRT-NFR-08-A, CRT-QA-02-A, CRT-QA-03-A, CRT-RD-01-A,
CRT-REG-02-A, CRT-REG-05-A, CRT-WRT-01-A, CRT-WRT-09-A, CRT-WRT-10-A.

Recorded before the implementing change, per PRD §0.7. The node's branch was
brought up to master (connector capabilities, semantic index and Ask, merge and
split, answer manifests) before this work, so its migration is 0022.

## 1. Boundaries are checked by what code reaches, and each check is proven able to fail

PRD §32 states the rules ("Domain packages must not import web UI code", "The
belief engine must be executable in unit tests without an LLM", "Connector
adapters may emit evidence but may not commit beliefs directly") and the design
adds that language models and plugins hold no database credentials, import no
repository, and read memory only through the Context Broker.

`src/boundaries.test.ts` builds one TypeScript program of the workspace and, from
the files of the checked package, resolves every identifier to its declaration
and walks every workspace function, method and initializer it reaches. A
forbidden declaration, or a forbidden SQL or route literal inside reached code,
is a violation carrying the chain of declarations that reached it. A call
through an interface member -- an injected port such as `tx.query` or
`enqueueExtraction` -- ends the walk: what a port does is decided by the
composition that supplies it, which is where these rules place that decision.

Definitions the tests fix:

- **Connector packages** are `packages/connectors` and any later
  `packages/connector-*`. The **commit path** is `commitBeliefTransaction` and
  `readCommitReceipt` in `@unai/belief`, the commit route
  `/v1/memory/transactions/{id}/commit`, and SQL writing `belief_transactions`,
  `belief_transaction_operations`, `belief_assessments` or `belief_support`.
- The **LLM gateway** is `@unai/model`. The **plugin runtime** is
  `@unai/connectors`: the connector manifests, the per-capability grants and the
  least-context plugin bundle of PRD §27.
- **Database credentials**: an import of a database driver or `@unai/postgres`,
  `@unai/auth`; a runtime dependency on one; any `env` read of a name matching
  DATABASE, POSTGRES, `PG*`, DB URL or password; an embedded `postgres://` URL.
- **Repository packages**: `@unai/postgres`, `memory`, `belief`, `capabilities`,
  `jobs`, `storage`, `auth`, `registry`.
- **Memory** is the canonical and context layer: every table from `entities`
  through `answer_manifests` in the list the test holds. Evidence and connector
  tables are the plugin runtime's own. A memory read path bypasses the broker
  when code reached from the gateway or the plugin runtime -- without passing
  through `packages/context/src` -- lands in `memory`, `belief`, `capabilities`
  or `postgres`, or holds SQL reading a memory table.
- **Assessment writers** are `commitBeliefTransaction`, `recordBeliefAssessment`,
  `recordBeliefStateVersion`, `reassessDerivedPropositions`, and any SQL that
  inserts into or updates `belief_assessments`.

The program also holds in-memory probe files -- a connector importing the
commit, a connector reaching it through a helper in another package, a gateway
opening a `pg` pool from `UNAI_DATABASE_URL`, a gateway reading claims through
`@unai/memory`, extraction importing the assessment engine, a domain package
importing `apps/web`, the belief engine importing the gateway -- and every rule
must report its probe while reporting nothing in the real packages. The probes
never touch disk.

The runtime half of CRT-WRT-01-A is `packages/model/src/assessment-boundary.test.ts`:
a real gateway call returns "ACCEPTED", and every way of writing it without a
governed transaction is refused by the database -- RLS under `model.call`,
`memory.extract` and `memory.canonicalize` (42501), and the foreign key to
`belief_transactions` under `memory.govern` and even for the migration principal
(23503). No schema change was needed: migration 0012 already made an assessment
without a transaction unrepresentable.

The second half of CRT-NFR-08-A is `packages/belief/src/no-llm.test.ts`, which
removes every model-gateway variable before importing the engine and then runs
admission, auto-accept, independence and circular-support decisions.

## 2. The plugin runtime's one memory read moves into the Context Broker package

Writing the rule above found one real bypass: `hasOpenThread` in
`packages/connectors/src/documents.ts` read `memory_threads` directly to decide
whether an upload is workflow-related (CRT-CON-05-A). It now calls
`listOpenThreadIds` in `@unai/context`, the package that owns memory threads and
is the only memory read path for plugins. The SQL, the purpose it runs under and
the behaviour are unchanged; only the package holding the read moved.

## 3. The gold corpus

Layout (PRD §32 `corpus/`): `corpus/synthetic/{threads,annotations}` committed;
`corpus/private-local/{threads,annotations}` gitignored; `corpus/expected/`
holds `identity-thresholds.json` and, once recorded, `real-corpus-results.json`.
`UNAI_PRIVATE_CORPUS_DIR` may place the private corpus on an encrypted volume
outside the repository (PRD §43.4 "encrypted or stored locally"). `corpus/**` is
`-text` in `.gitattributes`, because annotations are labelled against a SHA-256
of the raw thread bytes.

- **Commit block.** `.githooks/pre-commit` refuses any staged addition,
  modification or rename under `corpus/private-local/`. `pnpm install` runs
  `scripts/install-git-hooks.mjs` through the root `prepare` script, which sets
  `core.hooksPath=.githooks` only when no other hooks path is configured and
  never fails an install. CI additionally fails when any file under the path is
  tracked, so a `--no-verify` commit cannot land either.
- **Annotation format** (`corpus_annotations`, `@unai/domain` `evaluation.ts`):
  labelled spans with their exact quotes, expected entities with alias-bearing
  mentions, frame instances with role fillers, instance-match cases with the
  signals the discourse carries, slots with propositions and one observation per
  span, commitments and resolutions, unknowns and non-memory items, and the
  thresholds version the thread was labelled under.
- **Production keying rules** are enumerated in `PRODUCTION_KEYING_RULES`:
  entity strong-alias identity, frame-instance confirmed match, belief-slot
  descriptor identity and proposition normalized-value identity. The scorer runs
  the production code: `decideEntityResolution` (extracted from `resolveEntity`
  so the rule and its evaluation cannot drift), `scoreInstanceMatch` with
  `mayReuseInstance`, `slotFingerprint` with descriptor equality, the registry
  value validator with `propositionFingerprint`. Each rule is scored pairwise:
  the false-merge rate is predicted-same pairs that are labelled different over
  predicted-same pairs; the false-split rate is labelled-same pairs predicted
  different over labelled-same pairs.
- **Thresholds** (`identity-thresholds-1`): no false merge for any rule; false
  splits tolerated up to 50 % for entities and instances (the under-merge default
  of PRD §13 and ADR 0015 §3), 0 % for slots and 10 % for propositions; minimum
  observations per rule; at least ten real threads. CI scores the synthetic
  corpus against them (`uai corpus run --corpus synthetic`) and uploads the
  report.
- **Real-corpus results** are recorded by `uai corpus run --corpus private
  --record` as counts and rates only -- no thread reference, span, alias or value
  -- and are therefore committable. `uai corpus verify` refuses unless they are
  from the real corpus, cover at least the minimum threads and every label
  category, were recorded under the current thresholds, and hold every
  production rule at the version production runs today. A rule change makes its
  recorded result stale. `verify` runs in `pnpm check:phase-exit`, the PRD §46
  exit gate, not in every CI run: the real threads are the owner's to select and
  label, and until they exist every pull request would fail for a reason no
  pull request can fix.
- **Deviation from the design screen.** The Corpus and evaluation screen draws
  an "annotation editor". The private corpus never passes through a server, so
  editing is `uai corpus annotate` on the owner's machine, which writes the
  skeleton and lists missing categories (without `--thread`, for every thread);
  the screen says annotation is local and CLI-based, shows the commands, and
  shows per-category label coverage from the counts-only status report
  `uai corpus status --report` writes. The operator accepted this CLI and
  file-based editor for the design state (review version 3); no route, proxy
  mapping or server module reads the private corpus, and the web reader refuses
  a status file placed under it.

## 4. Shadow evaluation changes no production state by construction

`uai registry shadow-diff` evaluates one sample through two pipelines -- a
baseline and a candidate registry release (`REGISTRY`), or the claims two
recorded extractor versions produced under one release (`EXTRACTOR`) -- with the
production keying, admission and transition code, and emits the seven diffs of
PRD §43.5. Diff entries carry object references and stable codes (outcomes,
admission statuses, partition digests), never a value.

- A **corpus sample** touches no database.
- An **owner sample** is read in `READ ONLY` transactions: under
  `memory.inspect` for canonical memory and under `memory.project` for the
  stored-versus-recomputed projection comparison, which uses the reducer's new
  `computeProjectionRows` (the replay's compute half, without its write). A
  digest of every sampled table is taken before the read and after it; the run
  records the computed comparison as `production_unchanged`.
- The run's only write is its `shadow_evaluation_runs` row, under
  `evaluation.shadow`, a purpose no production table admits.
- An `EXTRACTOR` run compares extraction versions already recorded; it never
  calls a model, because a model call records `model_call_records`, a
  production table.

`shadow_evaluation_runs` is owner-scoped, which the design entity did not state:
an owner sample's diff names that owner's objects, and every such row in this
schema is behind RLS.

## 5. Registry migration governance

A migration manifest is `migration.yaml` inside the migrating release's
directory, so it is part of the immutable release and its content hash. The
evidence it names -- the shadow report and the projection replay report -- lives
under `registry/evidence/<version>/` because it is regenerable output.
`classifyRegistryChange` computes the change class of each recorded release
against the one before it from the contracts: identity anchors, identity
strategy, context policy, modalities, slot qualifiers, predicate cardinality or
normalization and merge or split policy are identity-affecting; transition
fields are transition-affecting; a removed frame, predicate, role or transition,
or a changed value type, is breaking. `uai registry lint` (already a CI step)
refuses an identity-, transition-affecting or breaking release unless the
manifest exists, does not understate the computed class, and names a shadow
report for exactly this release pair, a passing projection replay report for
this release (`projection-replay --registry-version`), and a rollback plan --
each refusal under its own code.

`uai registry publish` materializes the manifest into
`registry_migration_manifests` in the same transaction as the release, after its
base release; the slot and proposition diff counts and the shadow run id are read
from the shadow report at the same immutable tag. The table is global reference
data like `registry_releases`; its release ids carry no foreign key, for the
reason ADR 0015 §2 records and because a key into `registry_releases` would make
that table's truncation guard unreachable.

`uai registry test` runs every frame contract of every recorded release through
the ten areas of PRD §43.3 with the production code and the committed corpus.

## 6. Metrics are computed from aggregates, recorded as measurements

`GET /v1/ops/metrics` runs under `ops.metrics.read`, which no table policy admits
to row content. Its inputs come from one reviewed definer function,
`unai_private.economic_and_quality_inputs`, which returns counts for the calling
owner and window and NULL for any other purpose. Values are exact decimals from
integer arithmetic; a zero denominator is an undefined value (NULL), never zero.
Definitions:

- cost per source item, canonical claim, accepted belief and belief later
  retrieved: model spend recorded by the gateway in the window over, in turn,
  source items observed, claims attached to a proposition, propositions with an
  ACCEPTED assessment recorded, and those among them any context packet or answer
  manifest supplied;
- extracted claims never used: extracted claims neither supplied in a packet or
  manifest nor attached to a retrieved belief, over extracted claims;
- tier routing distribution: triage decisions by Tier-1 route;
- user confirmation rate: CONFIRM operations over accepted beliefs; user
  correction rate: CORRECT and REJECT operations over accepted beliefs (a
  CHANGED operation records a real change, not an error);
- false instance-merge rate and entity false-merge rate: merges whose survivor
  was later split, over merges; entity false-split rate: owner entity merges over
  entities created.

Each computed value is appended to `economic_and_quality_metrics`, which is
owner-scoped (the design entity allowed a null owner; corpus-level rates live in
the corpus results instead). Metrics whose inputs no delivered component records
-- overlay visibility probes, false-certainty labels, aggregated grounding
outcomes, clarification cards -- are listed as not measured with the reason, and
are never written as numbers.
