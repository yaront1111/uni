# Running Uai with moe-next

moe-next builds this project slice by slice: you approve a plan in the browser, agents
build it in this repo, the daemon verifies every delivery with `pnpm test` before it
counts. `prd.md` is the product authority.

## One-time setup

1. Node 24 + pnpm are installed (they are). moe-next lives at `D:\projexts\moe-next`
   and its control-room bundle is built (`pnpm --filter @moe/control-room build` there
   if `start.ps1` ever says "control room unavailable").
2. Agents run as `claude -p`. Give the launcher a credential ONCE:
   ```powershell
   claude setup-token            # prints a long-lived token
   $env:CLAUDE_CODE_OAUTH_TOKEN = "<paste>"   # or set it in your user environment
   ```
3. Dev secrets (`MOE_DAEMON_CREDENTIAL`, `MOE_CSRF_TOKEN`) are fixed strings in
   `start.ps1`/`seed.ps1` so the two scripts agree. Local machine only.

## Every session

**Terminal 1 — start the stack**
```powershell
D:\projexts\UnAI\.moe-next\start.ps1
```
It prints `moe up: daemon listening on http://127.0.0.1:NNNNN` and
`moe up: control room -> open http://127.0.0.1:NNNNN`. Keep this window: it is
also where you TYPE the pairing label (step 3) and where Ctrl-C stops everything.

**Terminal 2 — seed the first slice (first run only, or after a reset)**
```powershell
D:\projexts\UnAI\.moe-next\seed.ps1 -Origin http://127.0.0.1:NNNNN
```
It registers the project, installs policy, creates the goal, proposes the plan from
`node-specs/01-*.json`, and STOPS at plan review ("PENDING approval.decide ... approve
it on the live board").

**Browser**
1. Open the origin from Terminal 1.
2. The page shows a pairing label like `ab12-cd34-ef56`. Type it into **Terminal 1**
   (lowercase, then Enter) and click "I entered this label". You are paired. A page
   reload needs a new label - that is the security model, not a bug.
3. The board lists the goal. Open it: the plan review shows the slice. If the Approve
   button says `APPROVAL_INTENT_POLICY_REF_UNAVAILABLE`, the agent wrapper has not yet
   taken the `policy.validate` step the seed leaves READY - wait a few seconds and
   refresh (the wrapper staffs it automatically).
4. Click **Approve**. That is approve-and-start: the daemon mints the decision record,
   activates the graph, and the wrapper spawns a Claude agent in `D:\projexts\UnAI`
   with the slice's instructions. Watch the board; the node goes COMMITTED when the
   agent's delivery passes the daemon's own `pnpm test` verification.

**Next slice**
Add `node-specs/02-<name>.json` (same fields: `nodeRef`, `title`, `instructions`,
`test`, `workspace`), then re-run `seed.ps1` against a fresh store (see Reset) - the
seed proposes the FIRST spec by file name, so keep one live spec per run for now.
The PRD-driven lane (drop the PRD, get a plan back without writing specs) is landing
in moe-next; this runbook is the manual loop until it does.

## Reset
Stop Terminal 1 (Ctrl-C), delete `.moe-next/store.sqlite*`, start again.

## Where things live
- `.moe-next/store.sqlite` - the durable ledger (git-ignored).
- `.moe-next/node-specs/` - hand-written slice specs (the plan input today).
- `.moe/` - an OLD Moe (v1) board from 2026-08-27; moe-next does not read it.
- `src/` + `vitest` - the code agents land; `pnpm test` is the verification command.
