# Seeds the FIRST slice from .moe-next/node-specs onto the running daemon, then stops at the
# plan review so YOU approve it in the browser. Run while start.ps1 is up, in a second window:
#   D:\projexts\UnAI\.moe-next\seed.ps1 -Origin http://127.0.0.1:<port>
# (<port> is printed by start.ps1: "moe up: daemon listening on http://127.0.0.1:NNNNN").
param([Parameter(Mandatory = $true)][string]$Origin)
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$moeNext = "D:\projexts\moe-next"

$env:MOE_PROJECT_ID              = "unai"
$env:MOE_NODE_SPECS_DIR          = Join-Path $here "node-specs"
$env:MOE_DAEMON_CREDENTIAL       = "unai-dev-daemon-credential-change-me"
$env:MOE_CSRF_TOKEN              = "unai-dev-csrf-change-me"
$env:MOE_DAEMON_ORIGIN           = $Origin
$env:MOE_SEED_STOP_BEFORE_APPROVAL = "1"

Push-Location $moeNext
try {
  pnpm seed
} finally {
  Pop-Location
}
