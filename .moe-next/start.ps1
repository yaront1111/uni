# Starts moe-next (daemon + agent wrapper, control room hosted by the daemon) FOR THIS PROJECT.
# Run from any PowerShell:  D:\projexts\UnAI\.moe-next\start.ps1
# Ctrl-C in this window stops everything.
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$moeNext = "D:\projexts\moe-next"

# --- Project identity (the durable store lives beside this script, git-ignored) ---
$env:MOE_PROJECT_ID        = "unai"
$env:MOE_STORE_PATH        = Join-Path $here "store.sqlite"
$env:MOE_NODE_SPECS_DIR    = Join-Path $here "node-specs"
# Fixed dev secrets so `seed.ps1` can talk to the same daemon. Local machine only.
$env:MOE_DAEMON_CREDENTIAL = "unai-dev-daemon-credential-change-me"
$env:MOE_CSRF_TOKEN        = "unai-dev-csrf-change-me"

# --- Agents: the wrapper spawns `claude -p` per work item. It needs a credential in the
# environment or the launcher refuses. Get one once with:  claude setup-token
# then either set CLAUDE_CODE_OAUTH_TOKEN below or in your user environment.
if (-not $env:CLAUDE_CODE_OAUTH_TOKEN -and -not $env:ANTHROPIC_AUTH_TOKEN -and -not $env:ANTHROPIC_API_KEY) {
  Write-Host "moe-next: no Claude credential in the environment. Run 'claude setup-token' once, then:" -ForegroundColor Yellow
  Write-Host '  $env:CLAUDE_CODE_OAUTH_TOKEN = "<token>"   (or put it in your user environment)' -ForegroundColor Yellow
  Write-Host "The launcher refuses to start agents without one. See README.md." -ForegroundColor Yellow
  exit 1
}
$env:MOE_WRAPPER_MAX_AGENTS = "2"

Push-Location $moeNext
try {
  pnpm start
} finally {
  Pop-Location
}
