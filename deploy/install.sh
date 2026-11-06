#!/usr/bin/env bash
# First install of Uai on an ADR 0043 host: Ubuntu 24.04 x86_64, run as root.
#
#   sudo bash deploy/install.sh --tag <tag> [--repo <url>] [--dry-run]
#
# It installs the host packages, the pinned toolchain, the system users and the
# directory layout, builds the release at /opt/unai/releases/<tag>, points
# /opt/unai/current at it, and installs the units and the certbot hook without
# starting anything. It then prints the manual steps that remain.
#
# - Idempotent: a re-run changes nothing, and --dry-run prints the same plan
#   while executing nothing. Every mutation goes through run or put.
# - It never writes a secret: no file under /etc/unai/secrets, /etc/unai/backup,
#   /etc/unai/pgdata or /root, and no key material.
# - An installed host upgrades through deploy/upgrade.sh in the ADR 0043 D12
#   order, never through this script: it refuses when /opt/unai/current points
#   at another release.
# - UNAI_DEPLOY_ROOT is the deploy scripts' test seam, a path prefix that is
#   empty in production; it is honoured only with --dry-run.
# Errors are one UPPER_SNAKE code line on stderr.
set -euo pipefail
umask 022

# ADR 0043 D1 and D12: Node 24 and pnpm 11.0.8 stay pinned. The checksum is the
# node-v24.22.2-linux-x64.tar.xz line of nodejs.org/dist/v24.22.2/SHASUMS256.txt.
readonly NODE_VERSION=24.22.2
readonly NODE_SHA256=48cc0e21e048790e54c0cf5749c2725005313d652651c40b7a21feb9697aaf75
readonly NODE_TARBALL="node-v${NODE_VERSION}-linux-x64.tar.xz"
readonly PNPM_VERSION=11.0.8
# ADR 0043 D4: AWS CLI v2 for the data volume unlock; Ubuntu 24.04 has no awscli
# package. AWS publishes a PGP signature, not a checksum: this is the SHA-256 of
# the zip whose signature verified on 2026-11-06 against the AWS CLI Team key in
# the AWS CLI user guide, FB5D B77F D5C1 18B8 0511 ADA8 A631 0ACC 4672 475C.
readonly AWSCLI_VERSION=2.36.7
readonly AWSCLI_SHA256=d641283d37f1a2168457a9f26a20d4e29167652e9ab1719b37114ef1ebe859f4
readonly AWSCLI_ZIP="awscli-exe-linux-x86_64-${AWSCLI_VERSION}.zip"
readonly R="${UNAI_DEPLOY_ROOT:-}"

DRY_RUN=0
tag=''
repo=''
manual=()

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

# Prints the command, then executes it unless this is a dry run.
run() {
  printf '+'
  printf ' %q' "$@"
  printf '\n'
  if [[ $DRY_RUN != 1 ]]; then
    "$@"
  fi
}

# put MODE OWNER:GROUP PATH writes stdin to PATH through a temp file in the same
# directory, so the file is replaced whole.
put() {
  local mode=$1 owner=$2 path=$3 content line temp
  content=$(cat)
  printf '+ put %s %s %s\n' "$mode" "$owner" "$path"
  while IFS= read -r line; do
    printf '  | %s\n' "$line"
  done <<<"$content"
  if [[ $DRY_RUN == 1 ]]; then
    return 0
  fi
  temp=$(mktemp "${path%/*}/.unai-put.XXXXXX")
  printf '%s\n' "$content" >"$temp"
  chmod "$mode" "$temp"
  chown "$owner" "$temp"
  mv -f -- "$temp" "$path"
}

next_step() {
  manual+=("$1")
}

# Prints the version a binary reports, or nothing when it is absent.
version_of() {
  if [[ -x $1 ]]; then
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 "$1" --version 2>/dev/null || true
  fi
}

# --- Preconditions: all checked before the first planned action. ---
while (($# > 0)); do
  case $1 in
    --tag | --repo)
      (($# >= 2)) || fail INSTALL_USAGE
      if [[ $1 == --tag ]]; then tag=$2; else repo=$2; fi
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    *) fail INSTALL_USAGE ;;
  esac
done
[[ -n $tag ]] || fail INSTALL_USAGE
# No '/' and no leading '-' or '.': the tag can neither leave /opt/unai/releases
# nor become a git option.
[[ $tag =~ ^[A-Za-z0-9][A-Za-z0-9._+-]{0,99}$ ]] || fail INSTALL_TAG_INVALID
[[ -z $R || $DRY_RUN == 1 ]] || fail INSTALL_DEPLOY_ROOT_DRY_RUN_ONLY
[[ $DRY_RUN == 1 || $(id -u) == 0 ]] || fail INSTALL_ROOT_REQUIRED

os_id=''
os_version=''
if [[ -r $R/etc/os-release ]]; then
  while IFS='=' read -r key value || [[ -n $key ]]; do
    value=${value#\"}
    value=${value%\"}
    case $key in
      ID) os_id=$value ;;
      VERSION_ID) os_version=$value ;;
    esac
  done <"$R/etc/os-release"
fi
[[ $os_id == ubuntu && $os_version == 24.04 ]] || fail INSTALL_UNSUPPORTED_OS
[[ $(uname -m) == x86_64 ]] || fail INSTALL_UNSUPPORTED_ARCH

rel="$R/opt/unai/releases/$tag"
current="$R/opt/unai/current"
if [[ -e $current || -L $current ]]; then
  [[ $(readlink -f -- "$current") == "$(readlink -f -- "$rel")" ]] || fail INSTALL_ALREADY_INSTALLED
fi
[[ -e $rel || -n $repo ]] || fail INSTALL_REPO_REQUIRED

# --- Host (D1, D12). ---
run timedatectl set-timezone Etc/UTC
run env DEBIAN_FRONTEND=noninteractive apt-get update
run env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
  ca-certificates curl git openssl xz-utils certbot postgresql-common cryptsetup unzip
put 0644 root:root "$R/etc/apt/apt.conf.d/51unai-unattended-upgrades" <<'EOF'
// ADR 0043 D12: PostgreSQL and pgvector update only in a maintenance window.
// Entries add to the list in 50unattended-upgrades.
Unattended-Upgrade::Package-Blacklist {
    "postgresql-17";
    "postgresql-17-pgvector";
};
EOF
put 0644 root:root "$R/etc/apt/preferences.d/unai-pgvector" <<'EOF'
Explanation: ADR 0043 D1, D4: pgvector stays on the 0.8 series.
Package: postgresql-17-pgvector
Pin: version 0.8.*
Pin-Priority: 1001
EOF

# --- PostgreSQL 17 and pgvector from PGDG (D1, D4). ---
# The package creates cluster 17/main on install, and D4 requires it on the
# mounted LUKS2 volume, so nothing is installed until the volume is mounted.
pg_mounted=0
if mountpoint -q -- "$R/var/lib/postgresql"; then
  pg_mounted=1
  run /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y
  run env DEBIAN_FRONTEND=noninteractive apt-get install -y postgresql-17 postgresql-17-pgvector
  if [[ $DRY_RUN != 1 ]]; then
    # PGDG keeps only the newest version, so the pin alone cannot hold 0.8.x.
    pgvector=$(dpkg-query -W --showformat="\${Version}" postgresql-17-pgvector) || fail INSTALL_PGVECTOR_VERSION
    if ! dpkg --compare-versions "$pgvector" ge 0.8.6 || ! dpkg --compare-versions "$pgvector" lt 0.9~; then
      fail INSTALL_PGVECTOR_VERSION
    fi
  fi
fi

# --- Toolchain (D1, D12): the official tarball layout in /usr/local, first on
# systemd's search path, so the units' bare `node` is Node 24. ---
tarball="$R/var/cache/unai/$NODE_TARBALL"
if [[ $(version_of "$R/usr/local/bin/node") != "v$NODE_VERSION" ]]; then
  # A fixed path, not mktemp, keeps the plan deterministic.
  run install -d -m 0755 "$R/var/cache/unai"
  run curl -fsSL --proto =https --tlsv1.2 --retry 3 -o "$tarball" "https://nodejs.org/dist/v$NODE_VERSION/$NODE_TARBALL"
  printf '%s  %s\n' "$NODE_SHA256" "$tarball" | put 0644 root:root "$tarball.sha256"
  run sha256sum --check --status "$tarball.sha256" || fail INSTALL_NODE_CHECKSUM_MISMATCH
  run tar --no-same-owner --strip-components=1 -xJf "$tarball" -C "$R/usr/local"
fi
if [[ $(version_of "$R/usr/local/bin/pnpm") != "$PNPM_VERSION" ]]; then
  run /usr/local/bin/corepack enable --install-directory "$R/usr/local/bin" pnpm
  run env COREPACK_ENABLE_DOWNLOAD_PROMPT=0 /usr/local/bin/corepack install -g "pnpm@$PNPM_VERSION"
fi
# AWS CLI v2 (D4), for unai-pgdata-unlock.service. Its installer keeps each
# version under /usr/local/aws-cli/v2 and links /usr/local/bin/aws to it.
zip="$R/var/cache/unai/$AWSCLI_ZIP"
if [[ $(version_of "$R/usr/local/bin/aws") != "aws-cli/$AWSCLI_VERSION "* ]]; then
  run install -d -m 0755 "$R/var/cache/unai"
  run curl -fsSL --proto =https --tlsv1.2 --retry 3 -o "$zip" "https://awscli.amazonaws.com/$AWSCLI_ZIP"
  printf '%s  %s\n' "$AWSCLI_SHA256" "$zip" | put 0644 root:root "$zip.sha256"
  run sha256sum --check --status "$zip.sha256" || fail INSTALL_AWSCLI_CHECKSUM_MISMATCH
  # A stale extraction must not mix with this one.
  run rm -rf -- "$R/var/cache/unai/aws"
  run unzip -q -o "$zip" -d "$R/var/cache/unai"
  run "$R/var/cache/unai/aws/install" --update --install-dir "$R/usr/local/aws-cli" --bin-dir "$R/usr/local/bin"
fi
if [[ $DRY_RUN != 1 ]]; then
  [[ $(version_of "$R/usr/local/bin/node") == "v$NODE_VERSION" ]] || fail INSTALL_TOOLCHAIN_MISMATCH
  [[ $(version_of "$R/usr/local/bin/pnpm") == "$PNPM_VERSION" ]] || fail INSTALL_TOOLCHAIN_MISMATCH
  [[ $(version_of "$R/usr/local/bin/aws") == "aws-cli/$AWSCLI_VERSION "* ]] || fail INSTALL_TOOLCHAIN_MISMATCH
fi

# --- System users (D1, D9): one per process, plus the backup user. ---
for user in unai-api unai-web unai-worker unai-backup; do
  if ! getent passwd "$user" >/dev/null; then
    run useradd --system --user-group --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin "$user"
  fi
done

# --- Directories (D1, D2, D4, D6, D9). install -d also corrects an existing one.
# The CA script owns tls/ca, tls/api and tls/postgres; this script creates no
# file under /etc/unai/secrets, /etc/unai/backup or /etc/unai/pgdata. ---
directory() {
  run install -d -o root -g "$2" -m "$3" "$R$1"
}
directory /opt/unai root 0755
directory /opt/unai/releases root 0755
directory /etc/unai root 0755
directory /etc/unai/secrets root 0755
directory /etc/unai/tls root 0755
for process in api web worker; do
  directory "/etc/unai/secrets/$process" "unai-$process" 0750
  if [[ $process != web ]]; then
    directory "/etc/unai/secrets/$process/connectors" "unai-$process" 0750
    directory "/etc/unai/secrets/$process/aws" "unai-$process" 0750
  fi
done
directory /etc/unai/tls/web unai-web 0750
directory /etc/unai/backup unai-backup 0750
# D4: the unlock's credentials and config, and the key that pgdata/setup.sh writes.
directory /etc/unai/pgdata root 0700
if ((pg_mounted)); then
  # D9: on the encrypted data volume, never on a tmpfs.
  run install -d -o unai-backup -g unai-backup -m 0700 "$R/var/lib/postgresql/unai-backup-staging"
fi

# --- Release (D1, D12). A full clone: registry publish needs the
# registry-v<version> tags, which a shallow clone drops. ---
if [[ ! -e $rel ]]; then
  run git -c advice.detachedHead=false clone --branch "$tag" -- "$repo" "$rel"
fi
if [[ -e $rel ]]; then
  # Catches a branch name, a moved tag or a stray directory.
  head=$(git -C "$rel" rev-parse -q --verify HEAD 2>/dev/null) || fail INSTALL_RELEASE_MISMATCH
  tagged=$(git -C "$rel" rev-parse -q --verify "refs/tags/$tag^{commit}" 2>/dev/null) || fail INSTALL_RELEASE_MISMATCH
  [[ $head == "$tagged" ]] || fail INSTALL_RELEASE_MISMATCH
elif [[ $DRY_RUN != 1 ]]; then
  fail INSTALL_RELEASE_MISMATCH
fi
# Next writes .next/BUILD_ID before static generation, so it can outlive a failed
# build. This marker is written only after the build succeeds, and next build's
# clean step deletes it again at the start of any rebuild.
built="$rel/apps/web/.next/unai-build-complete"
if [[ ! -e $built ]]; then
  # tsx, a devDependency, runs the entry points, so NODE_ENV must not drop them.
  run env -u NODE_ENV /usr/local/bin/pnpm --dir "$rel" install --frozen-lockfile
  run env NEXT_TELEMETRY_DISABLED=1 /usr/local/bin/pnpm --dir "$rel" build
  run touch "$built"
fi
# Reached only after a successful build. The target is relative, the form
# upgrade.sh swaps in.
if [[ ! -e $current && ! -L $current ]]; then
  run ln -s "releases/$tag" "$current"
fi

# --- Units, the certbot hook and env files from the release. Units are never
# enabled or started here: they start after secrets, env files, migrate and
# publish (the manual steps below). ---
if [[ -e $rel ]]; then
  shopt -s nullglob
  units=("$rel"/deploy/systemd/unai-*.service "$rel"/deploy/systemd/unai-*.timer)
  examples=("$rel"/deploy/env/*.env.example)
  shopt -u nullglob
  ((${#units[@]} > 0)) || fail INSTALL_UNITS_MISSING
  run install -m 0644 -o root -g root -t "$R/etc/systemd/system" "${units[@]}"
else
  # Dry run before the clone exists: show the patterns instead of expanding them.
  printf '+ install -m 0644 -o root -g root -t %s %s %s\n' "$R/etc/systemd/system" \
    "$rel/deploy/systemd/unai-*.service" "$rel/deploy/systemd/unai-*.timer"
  examples=()
fi
run systemctl daemon-reload
run install -D -m 0755 -o root -g root "$rel/deploy/certbot-deploy-hook.sh" \
  "$R/etc/letsencrypt/renewal-hooks/deploy/unai-web.sh"
if [[ -e $rel ]]; then
  for example in "${examples[@]}"; do
    name=${example##*/}
    target="$R/etc/unai/${name%.env.example}.env"
    # Never overwrite an env file: the operator has filled it in.
    if [[ ! -e $target ]]; then
      run install -m 0600 -o root -g root "$example" "$target"
    fi
  done
else
  printf '+ install -m 0600 -o root -g root %s %s, for each <name>.env that is absent\n' \
    "$rel/deploy/env/<name>.env.example" "$R/etc/unai/<name>.env"
fi
# D6: no password in the URL; the migration and registry CLIs read /root/.pgpass.
if [[ ! -e $R/etc/unai/migrate.env ]]; then
  put 0600 root:root "$R/etc/unai/migrate.env" <<'EOF'
UNAI_MIGRATION_DATABASE_URL=postgresql://unai_migrator@127.0.0.1:5432/unai
UNAI_DATABASE_CA_FILE=/etc/unai/tls/ca/ca.pem
EOF
fi

# --- What remains is the operator's: nothing above creates a secret. ---
next_step 'DNS: an A record uai.<owner-domain> -> <host-ipv4> and a CAA record 0 issue "letsencrypt.org" (ADR 0043 D3). Allow inbound 22, 80 and 443 only (D1).'
if ((!pg_mounted)); then
  next_step 'Set up the LUKS2 data volume (ADR 0043 D4) as deploy/README.md describes: place /etc/unai/pgdata/aws-credentials and aws-config, run deploy/pgdata/setup.sh, which mounts the volume at /var/lib/postgresql, add the keyslot-1 recovery passphrase and enable unai-pgdata-unlock.service. Then re-run this script to install PostgreSQL 17 and pgvector.'
fi
next_step 'Issue the internal CA and the API and PostgreSQL leaves (D2), then configure and provision PostgreSQL (D4).'
next_step 'Place the D6 secret files under /etc/unai/secrets/<process>/ (root:unai-<process> 0640), the AWS credentials at <mount>/aws/credentials for the api and worker mounts, and the unai_migrator password in /root/.pgpass (0600). Put backup.key, pgpass and aws-credentials in /etc/unai/backup (D9) and record the offline copy of backup.key.'
next_step 'Replace every <placeholder> in /etc/unai/*.env.'
next_step 'Run certbot certonly --standalone --key-type ecdsa -d uai.<owner-domain>, then run /etc/letsencrypt/renewal-hooks/deploy/unai-web.sh once with RENEWED_LINEAGE=/etc/letsencrypt/live/uai.<owner-domain>; renewals run it automatically.'
next_step 'From /opt/unai/current, with /etc/unai/migrate.env loaded: pnpm db:migrate, pnpm uai registry publish --version <registry-version>, the three --check preflights, then systemctl enable --now unai-api, unai-web and unai-worker, in that order (D12).'
printf '\nRemaining manual steps:\n'
for index in "${!manual[@]}"; do
  printf '%d. %s\n' "$((index + 1))" "${manual[$index]}"
done
