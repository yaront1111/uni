# Starts moe-next (daemon + agent wrapper, control room hosted by the daemon) FOR THIS PROJECT,
# from the packaged build. Run from any PowerShell:  D:\projexts\UnAI\.moe-next\start.ps1
# Ctrl-C in this window stops everything.
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
  # A Claude OAuth token for THIS RUN ONLY, never written to disk. Prefer setting
  # CLAUDE_CODE_OAUTH_TOKEN in your user environment instead: anything passed on the command line
  # lands in your PowerShell history and is visible in the process list while the command runs,
  # readable by anything running as you. A token that has been pasted anywhere should be reissued.
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

# --- Agents: the wrapper spawns `claude -p` per work item. It needs a credential in the
# environment or the launcher refuses. Get one once with:  claude setup-token
# then either set CLAUDE_CODE_OAUTH_TOKEN here or in your user environment.
if ($Token) { $env:CLAUDE_CODE_OAUTH_TOKEN = $Token.Trim() }
if (-not $env:CLAUDE_CODE_OAUTH_TOKEN -and -not $env:ANTHROPIC_AUTH_TOKEN -and -not $env:ANTHROPIC_API_KEY) {
  Write-Host "moe-next: no Claude credential in the environment. Run 'claude setup-token' once, then:" -ForegroundColor Yellow
  Write-Host '  $env:CLAUDE_CODE_OAUTH_TOKEN = "<token>"   (or put it in your user environment)' -ForegroundColor Yellow
  Write-Host "The launcher refuses to start agents without one. See INSTALL.md in the build." -ForegroundColor Yellow
  exit 1
}

$env:MOE_WRAPPER_MAX_AGENTS = "2"
# Operator-authored node specs are optional; uncomment if you put any under .moe-next\node-specs.
# $env:MOE_NODE_SPECS_DIR = Join-Path $here "node-specs"

# BOTH governance variables are required by the daemon: an absent or malformed one leaves the
# seat closed, so a decision bound can never be implied. The else branch clears them on purpose —
# without it, a value left over in this shell would turn governance on without being asked for.
if ($Governance) {
  $env:MOE_GOVERNANCE_MODE = "AI_GOVERNOR"
  $env:MOE_GOVERNANCE_MAX_DECISIONS = "$GovernanceMaxDecisions"
  Write-Host "moe-next: governance ON, at most $GovernanceMaxDecisions decision(s) per node." -ForegroundColor Cyan
} else {
  Remove-Item Env:MOE_GOVERNANCE_MODE -ErrorAction SilentlyContinue
  Remove-Item Env:MOE_GOVERNANCE_MAX_DECISIONS -ErrorAction SilentlyContinue
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
exit $LASTEXITCODE
