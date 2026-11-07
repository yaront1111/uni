# ADR 0049: The release defect record comes from the task board

Date: 2026-11-07

Status: Accepted. Interprets release criterion CRT-OPS-03-A (REQ-OPS-03, PRD
§54.17: "No unresolved P0 or P1 correctness/security defect remains"); no PRD
requirement waived. Recorded before the release-checker change it governs (PRD
§0 rule 7). Source: task-c0b6d230's plan (2026-11-07).

## Context

- `docs/operations/release-input.json` carried
  `"defects": {"reviewedAt": "2026-09-19T16:08:01.816Z", "items": []}`, a
  GitHub-issues snapshot (`docs/operations/defect-triage-2026-09-19.json`).
  CRT-OPS-03-A checked only that `reviewedAt` was set and that no open P0/P1
  correctness or security item was listed. The snapshot never expired, so the
  gate passed on seven-week-old evidence.
- Defects are not filed as GitHub issues. They are rows on the Moe task board
  whose title starts with `bug:`; on 2026-11-07 three such rows were open, all
  HIGH, and none appeared in the record.
- The hosted release gate (`.github/workflows/release-gate.yml`) runs
  `pnpm check:v0-release` on a GitHub runner, where the board (`.moe/`, which
  Git ignores) does not exist. The record must therefore be committed, and it
  must expire.

## Decision

1. **Source.** The board's rows, `.moe/tasks/task-<32 hex>.json`, each a JSON
   object with string `id`, `title`, `status` and `priority`. A defect is a row
   whose trimmed title starts with `bug:` (any case). It is open unless its
   status is `DONE` or `ARCHIVED`. Only open defects are exported. Other file
   names (the daemon's temporary files) are not rows and are skipped.
2. **Severity.** Row priority maps `CRITICAL`→P0, `HIGH`→P1, `MEDIUM`→P2,
   `LOW`→P3. Any other value refuses the export.
3. **Category.** `SECURITY` when the title contains "security" (any case), else
   `CORRECTNESS`. `OTHER` is never assigned automatically, so every open P0 or
   P1 `bug:` row blocks the release.
4. **Record.** `{reviewedAt, source: "MOE_BOARD_BUG_ROWS", rowsScanned, items}`,
   where `rowsScanned` counts every board row read, not only defects.
   `pnpm ops:defects` (`src/operations/defects.ts`) writes it under `defects` in
   `docs/operations/release-input.json`, which is already a release-record path
   under ADR 0044; every other key is kept. It refuses with a code, and writes
   nothing, when the board is absent, unreadable, holds a malformed row, is
   empty, or has more than 1000 open defects.
5. **Live refresh.** `pnpm ops:report` and `pnpm check:v0-release` export the
   board themselves whenever `.moe/tasks` exists, and then ignore the committed
   record. Without a board (CI) they use the committed record. A board that
   exists but cannot be exported yields an unreviewed record
   (`reviewedAt: null`); it never falls back to the committed one.
6. **Freshness.** CRT-OPS-03-A passes only when all of these hold:
   - `source` is `MOE_BOARD_BUG_ROWS` and `rowsScanned` is greater than 0, so a
     hand-written record never passes;
   - `reviewedAt` is at most 24 hours before the report's `checkedAt` and at
     most 5 minutes after it (clock skew between the operator's machine and the
     runner);
   - no open P0 or P1 `CORRECTNESS` or `SECURITY` item is listed.

   `evaluateV0Release` stays pure: the report's own `checkedAt` is its clock.
7. The 2026-09-19 snapshot file stays as a dated historical observation. It is
   no longer evidence, and its `defects` entry is removed from
   `release-input.json`, so the criterion fails until a fresh export exists.

## Consequences

- A release needs `pnpm ops:defects` run on the board within 24 hours before the
  hosted check, committed as a records-only change (ADR 0044).
- Only `bug:` rows count. Feature rows, PRD-gap rows and deploy rows do not
  block a release; a defect that should block must be titled `bug:`.
- The record lists open defect titles in a tracked file. The operator reviews
  the diff before committing it; board rows carry no secrets.
- No `deviations` entry is added to `release-input.json`: this is an
  interpretation, not a deviation.
- The ADR index, `adr-inventory.json` REQ-OPS-03 and the operations README are
  updated by epic 2/3's documentation sweep (task-ce2123bd).
