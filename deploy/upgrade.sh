#!/usr/bin/env bash
# Usage: upgrade.sh <tag> [--repo <url>] [--registry-version <x.y.z>] [--dry-run]
# ADR 0043 D12: fetch, build, maintenance, backup, migrate, publish, check, swap,
# start. Before migrate undo the upgrade; afterwards restore or fix forward.
# UNAI_DEPLOY_ROOT and UNAI_UPGRADE_DRY_RUN_FAIL_AT=0-9 are dry-run-only seams.
# Dry runs print actions without executing them. Errors: one UPPER_SNAKE line.
# A --registry-version re-pin needs no queue drain: the worker runs evidence.extract
# jobs queued or retried under the previous pin (ADR 0048; deploy/README.md, Upgrade).
set -euo pipefail
umask 022

readonly R="${UNAI_DEPLOY_ROOT:-}"
readonly TAG_PATTERN='^[A-Za-z0-9][A-Za-z0-9._+-]{0,99}$'
readonly VERSION_PATTERN='^[0-9]+\.[0-9]+\.[0-9]+$'
readonly UUID_PATTERN='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
readonly READY_SECONDS=120 API_PORT=9101 WORKER_PORT=9102
readonly -a TIMERS=(unai-backup.timer unai-restore-drill.timer)
readonly -a S=(systemd-run --wait --pipe --quiet --collect)
readonly -a CODES=(TIMERS FETCH BUILD MAINTENANCE BACKUP MIGRATE PUBLISH CHECK SWAP START)

fail() { printf '%s\n' "$1" >&2; exit 1; }
run() {
  printf '+'; printf ' %q' "$@"; printf '\n'
  if [[ $DRY_RUN != 1 ]]; then
    if [[ ${capture:-0} == 1 ]]; then captured_output=$("$@" 2>/dev/null); else "$@" >/dev/null 2>&1; fi
  fi
}
retry() {
  local duration=$1 deadline=$((SECONDS + $1)); shift
  printf '+ retry %s' "$duration"; printf ' %q' "$@"; printf '\n'
  [[ $DRY_RUN != 1 ]] || return 0
  while ((SECONDS < deadline)); do
    "$@" >/dev/null 2>&1 && return 0
    sleep 2 || return 1
  done
  return 1
}
env_value() {
  local line value='' count=0
  [[ -f $1 ]] || return 1
  while IFS= read -r line || [[ -n $line ]]; do
    if [[ $line == "$2="* ]]; then value=${line#*=}; count=$((count + 1)); fi
  done <"$1" 2>/dev/null
  [[ $count == 1 ]] || return 1
  printf '%s\n' "$value"
}
missing_required() {
  local line name
  while IFS= read -r line || [[ -n $line ]]; do
    if [[ $line =~ ^#\ ([A-Z][A-Z0-9_]*):\ required\; ]]; then
      name=${BASH_REMATCH[1]}
      env_value "$2" "$name" >/dev/null 2>&1 || printf '%s\n' "$name"
    fi
  done <"$1"
}
repinned() {
  local line ended
  while true; do
    ended=0; IFS= read -r line && ended=1
    [[ $ended == 1 || -n $line ]] || break
    case $line in
      UNAI_REGISTRY_RELEASE=*) line="UNAI_REGISTRY_RELEASE=$2";;
      UNAI_REGISTRY_RELEASE_ID=*) line="UNAI_REGISTRY_RELEASE_ID=$3";;
    esac
    printf '%s' "$line" || return 1
    if [[ $ended == 1 ]]; then printf '\n' || return 1; fi
  done <"$1"
}
# Parse JSON, not a substring that might occur in a diagnostic or nested object.
# Called only on real publish output or directly by the isolated helper tests.
release_id_of() {
  node -e 'try { const x=JSON.parse(process.argv[1]);
    if(x.result!=="PASS" || typeof x.releaseId!=="string" || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(x.releaseId)) process.exit(1);
    console.log(x.releaseId); } catch { process.exit(1); }' "$1" 2>/dev/null
}
arguments() {
  tag=''; repo=''; registry=''; DRY_RUN=0
  while (($#)); do
    case $1 in
      --dry-run) DRY_RUN=1; shift;;
      --repo|--registry-version)
        [[ $# -ge 2 && -n $2 && $2 != --* ]] || fail UPGRADE_USAGE
        if [[ $1 == --repo ]]; then repo=$2; else registry=$2; fi; shift 2;;
      --*) fail UPGRADE_USAGE;;
      *) [[ -z $tag ]] || fail UPGRADE_USAGE; tag=$1; shift;;
    esac
  done
  [[ -n $tag ]] || fail UPGRADE_USAGE
  [[ $tag =~ $TAG_PATTERN ]] || fail UPGRADE_TAG_INVALID
  [[ -z $R || $DRY_RUN == 1 ]] || fail UPGRADE_DEPLOY_ROOT_DRY_RUN_ONLY
  if [[ ${UNAI_UPGRADE_DRY_RUN_FAIL_AT+x} ]]; then
    [[ $DRY_RUN == 1 ]] || fail UPGRADE_FAIL_AT_DRY_RUN_ONLY
    [[ $UNAI_UPGRADE_DRY_RUN_FAIL_AT =~ ^[0-9]$ ]] || fail UPGRADE_FAIL_AT_INVALID
  fi
  [[ $DRY_RUN == 1 ]] || [[ $(id -u) == 0 ]] || fail UPGRADE_ROOT_REQUIRED
}
repo_safe() { [[ ! $repo =~ ^[Hh][Tt][Tt][Pp][Ss]?://[^/]*@ ]] || fail UPGRADE_REPO_URL_CREDENTIALS; }
registry_pin() {
  local api_version worker_version api_id worker_id file
  publish=0
  [[ -n $registry ]] || return 0
  [[ $registry =~ $VERSION_PATTERN ]] || fail UPGRADE_REGISTRY_VERSION_INVALID
  api_version=$(env_value "$R/etc/unai/api.env" UNAI_REGISTRY_RELEASE) || fail UPGRADE_REGISTRY_PIN_MISMATCH
  worker_version=$(env_value "$R/etc/unai/worker.env" UNAI_REGISTRY_RELEASE) || fail UPGRADE_REGISTRY_PIN_MISMATCH
  api_id=$(env_value "$R/etc/unai/api.env" UNAI_REGISTRY_RELEASE_ID) || fail UPGRADE_REGISTRY_PIN_MISMATCH
  worker_id=$(env_value "$R/etc/unai/worker.env" UNAI_REGISTRY_RELEASE_ID) || fail UPGRADE_REGISTRY_PIN_MISMATCH
  [[ $api_version =~ $VERSION_PATTERN && $api_version == "$worker_version" && $api_id =~ $UUID_PATTERN && $api_id == "$worker_id" ]] || fail UPGRADE_REGISTRY_PIN_MISMATCH
  [[ $registry != "$api_version" ]] || return 0
  publish=1
  for file in api worker; do
    [[ ! -e $R/etc/unai/$file.env.pre-$tag && ! -L $R/etc/unai/$file.env.pre-$tag ]] || fail UPGRADE_ENV_COPY_EXISTS
  done
}
locked_state() {
  local target
  target=$(readlink "$cur" 2>/dev/null) || fail UPGRADE_HOST_CHANGED
  [[ $target == "releases/$old" ]] || fail UPGRADE_HOST_CHANGED
  [[ ! -e $rel && ! -L $rel ]] || fail UPGRADE_RELEASE_EXISTS
  registry_pin
}
preconditions() {
  local target file origin port
  cur="$R/opt/unai/current"; rel="$R/opt/unai/releases/$tag"
  [[ -L $cur ]] || fail UPGRADE_NOT_INSTALLED
  target=$(readlink "$cur" 2>/dev/null) || fail UPGRADE_NOT_INSTALLED
  old=${target#releases/}
  [[ $target == "releases/$old" && $old =~ $TAG_PATTERN && -d $R/opt/unai/releases/$old ]] || fail UPGRADE_NOT_INSTALLED
  [[ $old != "$tag" ]] || fail UPGRADE_ALREADY_CURRENT
  [[ ! -e $rel && ! -L $rel ]] || fail UPGRADE_RELEASE_EXISTS
  [[ ! -e $cur.tmp || -L $cur.tmp ]] || fail UPGRADE_CURRENT_TMP_INVALID
  repo_safe
  for file in api web worker migrate backup; do [[ -f $R/etc/unai/$file.env ]] || fail UPGRADE_ENV_FILE_MISSING; done
  origin=$(env_value "$R/etc/unai/web.env" NEXTAUTH_URL) || fail UPGRADE_WEB_ORIGIN_INVALID
  [[ $origin =~ ^https://([A-Za-z0-9.-]+)$ ]] || fail UPGRADE_WEB_ORIGIN_INVALID
  web_host=${BASH_REMATCH[1]}
  port=$(env_value "$R/etc/unai/api.env" UNAI_PROBE_PORT) || fail UPGRADE_PROBE_PORT_REQUIRED
  [[ $port == "$API_PORT" ]] || fail UPGRADE_PROBE_PORT_REQUIRED
  port=$(env_value "$R/etc/unai/worker.env" UNAI_PROBE_PORT) || fail UPGRADE_PROBE_PORT_REQUIRED
  [[ $port == "$WORKER_PORT" ]] || fail UPGRADE_PROBE_PORT_REQUIRED
  registry_pin
  if [[ $DRY_RUN != 1 ]]; then
    { exec 9>"$R/run/lock/unai-upgrade.lock"; } 2>/dev/null || fail UPGRADE_ALREADY_RUNNING
    flock -n 9 2>/dev/null || fail UPGRADE_ALREADY_RUNNING
    # Another upgrader could have finished between our reads and acquiring fd 9.
    locked_state
    if [[ -z $repo ]]; then
      repo=$(git -C "$R/opt/unai/releases/$old" config --get remote.origin.url 2>/dev/null) || fail UPGRADE_REPO_UNKNOWN
      [[ -n $repo ]] || fail UPGRADE_REPO_UNKNOWN; repo_safe
    fi
  elif [[ -z $repo ]]; then repo='<origin-url>'; fi
}
rollback_command() {
  if ! run "$@"; then
    rollback_ok=0
    printf 'rollback incomplete:'; printf ' %q' "$@"; printf '\n'
  fi
}
rollback() {
  local state
  printf 'ROLLBACK (ADR 0043 D12): step %s failed before migrate; no data changed.\n' "$1"
  if [[ $1 == 4 ]]; then
    state=loaded
    if [[ $DRY_RUN != 1 ]]; then state=$(systemctl show -p LoadState --value unai-upgrade-backup.service 2>/dev/null) || :; fi
    if [[ $state != not-found ]]; then rollback_command systemctl stop unai-upgrade-backup.service; fi
  fi
  rollback_command ln -sfn "releases/$old" "$cur.tmp"
  rollback_command mv -T "$cur.tmp" "$cur"
  if [[ $maintenance == 1 ]]; then
    rollback_command systemctl start unai-api.service
    rollback_command systemctl start unai-worker.service
  fi
  if ((${#stopped_timers[@]})); then rollback_command systemctl start "${stopped_timers[@]}"; fi
  if [[ $created == 1 ]]; then rollback_command rm -rf -- "$rel"; fi
}
stopped() {
  local current=$old file target
  [[ $swapped != 1 ]] || current=$tag
  if [[ $DRY_RUN != 1 ]]; then
    target=$(readlink "$cur" 2>/dev/null) || target=''
    case $target in "releases/$old") current=$old;; "releases/$tag") current=$tag;; *) current=UNKNOWN;; esac
  fi
  printf 'STOPPED (ADR 0043 D12): step %s failed after migrations began; current was not swapped back.\n' "$1"
  printf 'D12: restore the step-4 backup into an empty database and an empty store and start the previous release (releases/%s), or fix forward. See deploy/README.md, Upgrade.\n' "$old"
  for file in "${repinned_files[@]}"; do
    printf 'D12: %s may now pin registry %s; the previous file is %s.pre-%s.\n' "$file" "$registry" "$file" "$tag"
  done
  printf 'D12: current -> releases/%s; unai-backup.timer and unai-restore-drill.timer stay stopped.\n' "$current"
}
failed() {
  trap '' INT TERM HUP
  [[ ${failing:-0} == 0 ]] || exit 1
  failing=1; rollback_ok=1
  if (($1 < 5)); then rollback "$1"; else stopped "$1"; fi
  if [[ $rollback_ok == 0 ]]; then printf 'rollback incomplete: inspect the host before retrying.\n'; fi
  fail "$2"
}
act() { run "$@" || failed "$step" "UPGRADE_${CODES[step]}_FAILED"; }
timers() {
  local timer state service
  stopped_timers=()
  for timer in "${TIMERS[@]}"; do
    if [[ $DRY_RUN == 1 ]] || systemctl is-active --quiet "$timer" 2>/dev/null; then stopped_timers+=("$timer"); fi
  done
  if ((${#stopped_timers[@]})); then act systemctl stop "${stopped_timers[@]}"; fi
  [[ $DRY_RUN != 1 ]] || return 0
  for service in unai-backup.service unai-restore-drill.service; do
    state=$(systemctl is-active "$service" 2>/dev/null) || :
    [[ $state == inactive || $state == failed ]] || failed "$step" UPGRADE_BACKUP_OR_DRILL_RUNNING
  done
}
fetch_release() {
  local head tagged
  created=1
  act git -c advice.detachedHead=false clone --branch "$tag" -- "$repo" "$rel"
  [[ $DRY_RUN != 1 ]] || return 0
  head=$(git -C "$rel" rev-parse -q --verify HEAD 2>/dev/null) || failed "$step" UPGRADE_RELEASE_MISMATCH
  tagged=$(git -C "$rel" rev-parse -q --verify "refs/tags/$tag^{commit}" 2>/dev/null) || failed "$step" UPGRADE_RELEASE_MISMATCH
  [[ $head == "$tagged" ]] || failed "$step" UPGRADE_RELEASE_MISMATCH
  if [[ $publish == 1 ]]; then
    git -C "$rel" rev-parse -q --verify "refs/tags/registry-v$registry^{commit}" >/dev/null 2>&1 || failed "$step" UPGRADE_REGISTRY_TAG_MISSING
  fi
}
release_files() {
  local example file missing name gaps=0
  local -a units examples
  shopt -s nullglob
  units=("$rel"/deploy/systemd/unai-*.service); examples=("$rel"/deploy/env/*.env.example)
  shopt -u nullglob
  ((${#units[@]})) || failed "$step" UPGRADE_UNITS_MISSING
  ((${#examples[@]})) || failed "$step" UPGRADE_ENV_REQUIRED_MISSING
  for example in "${examples[@]}"; do
    file=${example##*/}; file=${file%.example}
    if [[ ! -f $R/etc/unai/$file ]]; then printf 'missing: %s FILE\n' "$file"; gaps=1; fi
    missing=$(missing_required "$example" "$R/etc/unai/$file") || failed "$step" UPGRADE_ENV_REQUIRED_MISSING
    while IFS= read -r name; do
      if [[ -n $name ]]; then printf 'missing: %s %s\n' "$file" "$name"; gaps=1; fi
    done <<<"$missing"
  done
  [[ $gaps == 0 ]] || failed "$step" UPGRADE_ENV_REQUIRED_MISSING
}
build_release() {
  act env -u NODE_ENV /usr/local/bin/pnpm --dir "$rel" install --frozen-lockfile
  act env NEXT_TELEMETRY_DISABLED=1 /usr/local/bin/pnpm --dir "$rel" build
  act touch "$rel/apps/web/.next/unai-build-complete"
  if [[ $DRY_RUN != 1 ]]; then release_files; fi
}
maintenance_start() {
  maintenance=1
  act systemctl stop unai-worker.service
  act systemctl stop unai-api.service
}
backup() {
  act "${S[@]}" --unit=unai-upgrade-backup --uid=unai-backup --gid=unai-backup \
    --working-directory="$cur" --property=EnvironmentFile="$R/etc/unai/backup.env" \
    --setenv=PGPASSFILE="$R/etc/unai/backup/pgpass" --setenv=AWS_SHARED_CREDENTIALS_FILE="$R/etc/unai/backup/aws-credentials" \
    --setenv=AWS_EC2_METADATA_DISABLED=true /usr/local/bin/node scripts/backup.mjs
}
migration_command() {
  act "${S[@]}" --working-directory="$rel" --property=EnvironmentFile="$R/etc/unai/migrate.env" \
    --setenv=PGPASSFILE="$R/root/.pgpass" --setenv=HOME="$R/root" /usr/local/bin/pnpm "$@"
}
repin() {
  local file=$1 new_version=$2 new_id=$3 temp
  printf '+ repin %s %s %s\n' "$file" "$new_version" "$new_id"
  [[ $DRY_RUN != 1 ]] || return 0
  temp=$(mktemp "${file%/*}/.unai-repin.XXXXXX" 2>/dev/null) || return 1
  if ! { repinned "$file" "$new_version" "$new_id" >"$temp" && chmod 0600 "$temp" && chown root:root "$temp" && mv -f "$temp" "$file"; } 2>/dev/null; then
    rm -f -- "$temp" 2>/dev/null || :; return 1
  fi
}
publish_release() {
  local capture=1 captured_output='' new_id='<releaseId>' file
  if [[ $publish == 0 ]]; then printf 'registry: no publish, pin unchanged\n'; return 0; fi
  migration_command uai registry publish --version "$registry"
  if [[ $DRY_RUN != 1 ]]; then
    new_id=$(release_id_of "$captured_output") || failed "$step" UPGRADE_PUBLISH_FAILED
    printf '{"result":"PASS","releaseId":"%s"}\n' "$new_id"
  fi
  capture=0
  for file in "$R/etc/unai/api.env" "$R/etc/unai/worker.env"; do
    act install -m 0600 -o root -g root "$file" "$file.pre-$tag"
    # Include an in-flight rewrite in interruption diagnostics, not just successes.
    repinned_files+=("$file")
    repin "$file" "$registry" "$new_id" || failed "$step" UPGRADE_PUBLISH_FAILED
  done
}
preflight() {
  act "${S[@]}" --uid=unai-api --gid=unai-api --working-directory="$rel" --property=EnvironmentFile="$R/etc/unai/api.env" \
    --setenv=NODE_ENV=production --setenv=AWS_SHARED_CREDENTIALS_FILE="$R/etc/unai/secrets/api/aws/credentials" \
    --setenv=AWS_EC2_METADATA_DISABLED=true /usr/local/bin/node --import tsx packages/api/src/server.ts --check
  act "${S[@]}" --uid=unai-web --gid=unai-web --working-directory="$rel/apps/web" --property=EnvironmentFile="$R/etc/unai/web.env" \
    --setenv=NODE_ENV=production /usr/local/bin/node --import tsx server.ts --check
  act "${S[@]}" --uid=unai-worker --gid=unai-worker --working-directory="$rel" --property=EnvironmentFile="$R/etc/unai/worker.env" \
    --setenv=NODE_ENV=production --setenv=AWS_SHARED_CREDENTIALS_FILE="$R/etc/unai/secrets/worker/aws/credentials" \
    --setenv=AWS_EC2_METADATA_DISABLED=true /usr/local/bin/node --import tsx packages/api/src/processing-worker.ts --check
}
swap_release() {
  local -a units
  act ln -sfn "releases/$tag" "$cur.tmp"
  act mv -T "$cur.tmp" "$cur"
  swapped=1
  if [[ $DRY_RUN == 1 ]]; then
    printf '+ install -m 0644 -o root -g root -t %s %s %s\n' "$R/etc/systemd/system" "$rel/deploy/systemd/unai-*.service" "$rel/deploy/systemd/unai-*.timer"
  else
    shopt -s nullglob; units=("$rel"/deploy/systemd/unai-*.service "$rel"/deploy/systemd/unai-*.timer); shopt -u nullglob
    act install -m 0644 -o root -g root -t "$R/etc/systemd/system" "${units[@]}"
  fi
  act systemctl daemon-reload
  act install -D -m 0755 -o root -g root "$rel/deploy/certbot-deploy-hook.sh" "$R/etc/letsencrypt/renewal-hooks/deploy/unai-web.sh"
}
start_services() {
  act systemctl start unai-api.service
  retry "$READY_SECONDS" curl -fsS --max-time 5 -o /dev/null "http://127.0.0.1:$API_PORT/readyz" || failed "$step" UPGRADE_API_NOT_READY
  act systemctl restart unai-web.service
  retry "$READY_SECONDS" curl -fsS --max-time 10 -o /dev/null --resolve "$web_host:443:127.0.0.1" "https://$web_host/signin" || failed "$step" UPGRADE_WEB_NOT_SERVING
  act systemctl start unai-worker.service
  retry "$READY_SECONDS" curl -fsS --max-time 5 -o /dev/null "http://127.0.0.1:$WORKER_PORT/readyz" || failed "$step" UPGRADE_WORKER_NOT_READY
}
timer_failure() {
  trap '' INT TERM HUP
  printf 'D12 completed; timer state is unknown after the final restart attempt. Inspect both timers and backup/drill services before recovery.\n'
  fail "$1"
}
finish_upgrade() {
  # D12 is complete. A multi-unit start can partially succeed; never claim those
  # timers stayed stopped if this final operation fails or is interrupted.
  trap 'timer_failure UPGRADE_INTERRUPTED' INT TERM HUP
  if ((${#stopped_timers[@]})); then run systemctl start "${stopped_timers[@]}" || timer_failure UPGRADE_TIMERS_FAILED; fi
  if [[ $DRY_RUN == 1 ]]; then printf 'dry run: nothing was executed\n'; else printf 'upgraded %s -> %s\n' "$old" "$tag"; fi
}
main() {
  arguments "$@"; preconditions
  step=0; created=0; maintenance=0; swapped=0; failing=0; capture=0; repinned_files=(); stopped_timers=()
  trap 'failed "$step" UPGRADE_INTERRUPTED' INT TERM HUP
  local -a titles=(timers fetch build maintenance backup migrate registry preflight swap start)
  local -a actions=(timers fetch_release build_release maintenance_start backup 'migration_command db:migrate' publish_release preflight swap_release start_services)
  for step in {0..9}; do
    printf '== D12 step %s: %s\n' "$step" "${titles[step]}"
    if [[ $step == 5 ]]; then migration_command db:migrate; else "${actions[step]}"; fi
    if [[ ${UNAI_UPGRADE_DRY_RUN_FAIL_AT:-} == "$step" ]]; then failed "$step" "UPGRADE_${CODES[step]}_FAILED"; fi
  done
  finish_upgrade
}
if [[ ${BASH_SOURCE[0]} == "$0" ]]; then main "$@"; fi
