# packages/control

`@unai/control` owns governed action and the data-control surface: drafts,
recommendations, the action history, plugin capability grants, the owner's
settings (retention, domain sensitivity; the attention budget is `@unai/review`'s), export, the deletion
cascade and semantic-index regeneration. Report: `docs/governed-action-and-data-control.md`;
decisions: `docs/adr/0030-governed-action-and-data-control.md`.

## Local invariants

- **Pure functions over a caller's owner transaction.** No pool, no route, no
  commit, no audit. `packages/api/src/control.ts` composes them and chooses every
  purpose in server code.
- **A draft exists only under a recorded ALLOW.** `insertDraft` takes the
  `policy_decision_id` the broker recorded; the route calls it only when
  `evaluateActionBasis` answered ALLOW. `drafts.policy_decision_id` is NOT NULL.
- **Nothing here executes anything.** `evaluateExternalAction` records the port's
  verdict and returns it; there is no executor. The only EXECUTED or
  RECEIVED_CONFIRMATION entry comes from `recordReceiptEntry`, and the table
  refuses one whose receipt is not a live `TOOL_RECEIPT` evidence row.
- **A recommendation is RECOMMENDED.** It is never a claim, a proposition or
  intent; an acceptance is `ACCEPTED_AS_INTENT_TO_PREPARE` and nothing more.
- **Deletion goes through `unai_private.erase_evidence` only.** The application
  role holds no DELETE on any canonical or evidence table (the isolation suite
  asserts it under `data.delete` too). Do not add DELETE grants to make a cascade
  step easier; extend the definer, and extend the immutability-trigger branches
  in migration 0024 only for an erasure-shaped update.

## Traps

- **Projection completeness is owner-wide.** The broker's fragments report the
  whole projection's `isComplete`, so one incomplete row anywhere makes every
  action for that owner unsettled. Tests that need settled memory use an owner
  with no incomplete row.
- **An unregistered predicate outranks unsettled memory.** For a HIGH-risk
  action the port denies an unregistered predicate first; a fixture that expects
  `HIGH_RISK_ACTION_ON_UNSETTLED_MEMORY` must pin a real registry release.
- **`evaluateActionBasis` declares a DRAFT.** Preparing is the only step V0 has,
  so a recommendation is judged as "may Uai prepare this", with the capability
  question answered true: a recommendation asks nothing of a plugin.
- **The deletion preview is a real cascade, rolled back.** It throws inside the
  transaction on purpose; do not "optimise" it into a separate counting query,
  or the preview and the deletion can disagree.
