# Starts moe-next (daemon + agent wrapper, control room hosted by the daemon) FOR THIS PROJECT,
# from the packaged build. Run from any PowerShell:  D:\projexts\UnAI\.moe-next\start.ps1
# Ctrl-C in this window stops everything, and the shell is left with NOTHING from this run: every
# MOE_* knob set below is removed and the credential is put back to what it was (the finally
# block at the bottom). A run's policy and a run's token live exactly as long as the run.
#
# WHY THIS NO LONGER RUNS `pnpm start`. That started moe-next from SOURCE, ignoring the packaged
# build entirely, and it set MOE_PROJECT_ID and MOE_STORE_PATH here — naming project "unai" with
# its store at .moe-next\store.sqlite. This project actually runs as "unai-9705356d4240" with its
# store at the project root, so those variables pointed at a DIFFERENT database: the one beside
# this script stopped updating on 6 September, and reading it shows a project frozen months ago.
#
# moe.config.json beside this project owns the project id, the store path and the daemon
# credential, and the packaged CLI reads it. That is why none of those variables are set below:
# setting them again is the bug, not the configuration.
# [CmdletBinding()] makes an unknown parameter a hard ERROR. Without it PowerShell quietly
# collects unmatched arguments into $args, so a mistyped or unsupported switch does nothing at
# all and the script carries on as if you had not passed it.
[CmdletBinding()]
param(
  # The unzipped artifact. Override if you keep the build somewhere else.
  [string]$Install = "D:\projexts\moe-next\dist\moe-windows",
  # Governance answers an exhausted review instead of parking it on you. Off by default.
  [switch]$Governance,
  [int]$GovernanceMaxDecisions = 3,
  # Each node codes in its own Git working tree under .moe-next\trees, so nodes run in parallel
  # instead of queueing on the one checkout. Off by default. Safe to turn on with nodes mid-flight
  # (measured 2026-09-18): a node already holding the shared checkout finishes there, the wrapper
  # says so by name at startup, and it takes its own tree the next time it is staffed.
  [switch]$NodeTrees,
  # Seats the wrapper may run at once. Without -NodeTrees, extra seats mostly wait on the checkout.
  [ValidateRange(1, 16)][int]$MaxAgents = 2,
  # A Claude OAuth token for THIS RUN ONLY, never written to disk. You should not need it: the
  # saved `claude` sign-in is used when no credential is in the environment, and with neither the
  # script runs `claude setup-token` and asks for the token with a hidden prompt. Anything passed
  # here on the command line lands in your PowerShell history and is visible in the process list
  # while the command runs. A token that has been pasted anywhere should be reissued.
  [string]$Token
)
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$project = Split-Path -Parent $here
$moe = Join-Path $Install "moe.ps1"

if (-not (Test-Path $moe)) {
  Write-Host "moe-next: no install at $Install (expected moe.ps1)." -ForegroundColor Red
  Write-Host "Unzip dist\moe-windows.zip into that folder, then run this again." -ForegroundColor Red
  exit 1
}
if (-not (Test-Path (Join-Path $project "moe.config.json"))) {
  Write-Host "moe-next: no moe.config.json in $project." -ForegroundColor Red
  Write-Host "It carries this project's id, store path and credential. Do not recreate it by hand." -ForegroundColor Red
  exit 1
}

# Every knob this script owns. ALL of them are cleared before the run (a value left in this shell
# by an earlier run must never masquerade as this run's policy — measured 2026-09-18: the wrapper
# read "cap=1h" after the override was retired) and ALL of them are removed again after it. Each
# name must also be on the build's PROJECT_STACK_ENVIRONMENT_KEYS roster, or the broker drops it
# on the way to the wrapper and the knob silently does nothing; the wrapper's first log lines
# ("[verifier] database: …", "[wrapper] seat budget: …") state what actually arrived. READ THEM.
$runKnobs = @(
  "MOE_WRAPPER_MAX_AGENTS", "MOE_NODE_TREES", "MOE_NODE_SPECS_DIR",
  "MOE_AGENT_TIMEOUT_MS", "MOE_AGENT_SILENCE_MS",
  "MOE_GOVERNANCE_MODE", "MOE_GOVERNANCE_MAX_DECISIONS",
  "MOE_VERIFIER_DB_IMAGE", "MOE_VERIFIER_DB_URL_VARS", "MOE_VERIFIER_DB_TLS", "MOE_VERIFIER_DB_CA_VAR"
)
function Clear-RunKnobs { foreach ($name in $runKnobs) { Remove-Item "Env:$name" -ErrorAction SilentlyContinue } }

$tokenWasSet = $false
$priorToken = $env:CLAUDE_CODE_OAUTH_TOKEN
$code = 1
try {
  Clear-RunKnobs

  # --- Agents: the wrapper spawns `claude -p` per work item. `moe start` accepts, in order: a
  # credential in the environment (CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_AUTH_TOKEN, ANTHROPIC_API_KEY),
  # else the saved `claude` sign-in (.credentials.json). Only with neither does this script mint a
  # token, and then it is held in this process's environment for the run and nowhere else.
  $claudeHome = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { Join-Path $env:USERPROFILE ".claude" }
  if ($Token) {
    $env:CLAUDE_CODE_OAUTH_TOKEN = $Token.Trim(); $tokenWasSet = $true
  } elseif ($env:CLAUDE_CODE_OAUTH_TOKEN -or $env:ANTHROPIC_AUTH_TOKEN -or $env:ANTHROPIC_API_KEY) {
    Write-Host "moe-next: using the Claude credential already in this shell's environment." -ForegroundColor Cyan
  } elseif (Test-Path (Join-Path $claudeHome ".credentials.json")) {
    Write-Host "moe-next: using the saved Claude sign-in ($claudeHome). No token needed." -ForegroundColor Cyan
  } else {
    Write-Host "moe-next: no Claude credential and no saved sign-in. Running 'claude setup-token';" -ForegroundColor Yellow
    Write-Host "copy the token it prints, then paste it at the hidden prompt. It is kept for this run only." -ForegroundColor Yellow
    & claude setup-token
    $pasted = [System.Net.NetworkCredential]::new("", (Read-Host "Token (hidden)" -AsSecureString)).Password.Trim()
    if (-not $pasted) { Write-Host "moe-next: no token entered." -ForegroundColor Red; exit 1 }
    $env:CLAUDE_CODE_OAUTH_TOKEN = $pasted; $tokenWasSet = $true
    $pasted = $null
  }

  $env:MOE_WRAPPER_MAX_AGENTS = "$MaxAgents"
  if ($NodeTrees) {
    $env:MOE_NODE_TREES = "1"
    Write-Host "moe-next: node trees ON, up to $MaxAgents node(s) in parallel, one working tree each." -ForegroundColor Cyan
  }
  # Seat lifetime (moe-next 31b8191b and later): a seat is killed on SILENCE, MOE_AGENT_SILENCE_MS
  # (default 20 min) with no output, no live tool child and no CPU growth; MOE_AGENT_TIMEOUT_MS is
  # only the absolute backstop (default 2 h). Both are left at the build's defaults; set either
  # here only to tighten a specific product's budget.
  # Operator-authored node specs are optional; uncomment if you put any under .moe-next\node-specs.
  # $env:MOE_NODE_SPECS_DIR = Join-Path $here "node-specs"

  # BOTH governance variables are required by the daemon: an absent or malformed one leaves the
  # seat closed, so a decision bound can never be implied. Off means absent, which Clear-RunKnobs
  # above already guaranteed.
  if ($Governance) {
    $env:MOE_GOVERNANCE_MODE = "AI_GOVERNOR"
    $env:MOE_GOVERNANCE_MAX_DECISIONS = "$GovernanceMaxDecisions"
    Write-Host "moe-next: governance ON, at most $GovernanceMaxDecisions decision(s) per node." -ForegroundColor Cyan
  }

  # The verifier's disposable database must match what THIS product's db:migrate needs
  # (packages/postgres/src/migrate-cli.ts): pgvector, a TLS server it can pin, and its own variable
  # names. Without these the verifier spins up plain postgres + DATABASE_URL, migrate-cli refuses
  # MIGRATION_TLS_CONFIGURATION_REQUIRED before its first migration, and every DB-backed node loops
  # to the review ceiling (measured 2026-09-17). Docker Desktop must be running for any of it.
  $env:MOE_VERIFIER_DB_IMAGE = "pgvector/pgvector:pg17"
  $env:MOE_VERIFIER_DB_URL_VARS = "DATABASE_URL,UNAI_MIGRATION_DATABASE_URL"
  $env:MOE_VERIFIER_DB_TLS = "1"
  $env:MOE_VERIFIER_DB_CA_VAR = "UNAI_DATABASE_CA_PATH"

  # --operator-stdin enables the pairing channel: this window reads the confirmation label you type
  # in the control room and hands it to the daemon, which mints your OPERATOR session. Without it the
  # daemon only reads pairing input when stdin is a TTY, which it is NOT through the pwsh -> moe.ps1
  # -> node launch chain, so every operator action (Close, Abandon, Allow one more attempt) stays
  # refused OPERATOR_PRINCIPAL_REQUIRED. Pass it explicitly here, because this launcher IS the
  # interactive foreground the pairing flow expects.
  & $moe start $project --operator-stdin
  $code = $LASTEXITCODE
} finally {
  # Runs on a normal exit, on a refusal above and on Ctrl-C alike.
  Clear-RunKnobs
  if ($tokenWasSet) {
    if ($priorToken) { $env:CLAUDE_CODE_OAUTH_TOKEN = $priorToken }
    else { Remove-Item Env:CLAUDE_CODE_OAUTH_TOKEN -ErrorAction SilentlyContinue }
  }
}
exit $code
