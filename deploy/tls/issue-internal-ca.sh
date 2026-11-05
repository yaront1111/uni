#!/usr/bin/env bash
# Issues the ADR 0043 D2 "Uai internal CA" and its two loopback leaves, on the
# host, as root, after deploy/install.sh and after PostgreSQL is installed.
#
#   sudo bash deploy/tls/issue-internal-ca.sh [--renew-leaves] [--dry-run]
#
#   /etc/unai/tls/ca/                 root:root      0755
#     ca.key                          root:root      0400  ECDSA P-256
#     ca.pem                          root:root      0644  CA, 3650 days
#   /etc/unai/tls/api/                root:unai-api  0750
#     cert.pem, key.pem               root:unai-api  0640  SAN IP:127.0.0.1, 365 days
#   /etc/unai/tls/postgres/           root:postgres  0750
#     cert.pem, key.pem               root:postgres  0640  SAN IP:127.0.0.1, DNS:localhost, 365 days
#
# deploy/postgres/unai.conf and deploy/env/*.env.example read exactly these
# paths. install.sh owns /etc/unai/tls itself and tls/web; this script creates
# nothing else.
#
# - An existing CA key is never replaced, --renew-leaves included. A missing
#   leaf is issued; existing leaves are re-issued only with --renew-leaves, or
#   when this run issues the CA, so a leaf always chains to the CA on disk.
#   Every run converges the modes and owners above.
# - Each new file is written as *.new with its final mode and owner, then moved
#   into place: the certificate first, the key last. An interrupted first issue
#   leaves at most a lone ca.pem, which the next run refuses with
#   INTERNAL_CA_INCOMPLETE; remove it and run again. A --renew-leaves
#   interrupted between its two moves leaves a new certificate beside the old
#   key; running --renew-leaves again completes it.
# - It restarts nothing: the rotation runbook restarts unai-api and reloads
#   PostgreSQL.
# - --dry-run prints every command and executes none.
# - UNAI_DEPLOY_ROOT is the deploy scripts' test seam, a path prefix that is
#   empty in production. Unlike install.sh, it is honoured in a real run.
# Errors are one UPPER_SNAKE code line on stderr.
set -euo pipefail
umask 077

readonly R="${UNAI_DEPLOY_ROOT:-}"
readonly TLS="$R/etc/unai/tls"
readonly CA="$TLS/ca"
DRY_RUN=0
RENEW=0

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
    "$@" || fail INTERNAL_CA_STEP_FAILED
  fi
}

# own MODE GROUP PATH...: mode MODE, owner root:GROUP.
own() {
  local mode=$1 group=$2
  shift 2
  run chmod "$mode" "$@"
  run chown "root:$group" "$@"
}

# --- Preconditions: all checked before the first action. ---
for arg in "$@"; do
  case $arg in
    --dry-run) DRY_RUN=1 ;;
    --renew-leaves) RENEW=1 ;;
    *) fail INTERNAL_CA_USAGE ;;
  esac
done
[[ $DRY_RUN == 1 || -n $R || $(id -u) == 0 ]] || fail INTERNAL_CA_ROOT_REQUIRED
[[ -d $TLS ]] || fail INTERNAL_CA_TLS_DIRECTORY_MISSING
getent group unai-api >/dev/null || fail INTERNAL_CA_USERS_MISSING
getent group postgres >/dev/null || fail INTERNAL_CA_POSTGRES_MISSING
if [[ $DRY_RUN != 1 ]]; then
  # req -CA, which signs a leaf in one step, needs OpenSSL 3.
  version=$(openssl version 2>/dev/null) || fail INTERNAL_CA_OPENSSL_UNSUPPORTED
  [[ $version == 'OpenSSL 3.'* ]] || fail INTERNAL_CA_OPENSSL_UNSUPPORTED
  # The lock is on the directory itself, so no lock file is left behind.
  exec 9<"$TLS"
  flock -n 9 || fail INTERNAL_CA_BUSY
fi
if [[ -e $CA/ca.key && ! -e $CA/ca.pem || ! -e $CA/ca.key && -e $CA/ca.pem ]]; then
  fail INTERNAL_CA_INCOMPLETE
fi
if [[ $DRY_RUN != 1 ]]; then
  trap 'rm -f -- "$CA"/*.new "$TLS"/api/*.new "$TLS"/postgres/*.new' EXIT
fi

# --- Directories. ---
directory() {
  local path="$TLS/$1"
  if [[ ! -d $path ]]; then
    run mkdir -m "$3" "$path"
  fi
  own "$3" "$2" "$path"
}
directory ca root 0755
directory api unai-api 0750
directory postgres postgres 0750

# --- The CA, only when it has no key yet. ---
p256=(-algorithm EC -pkeyopt ec_paramgen_curve:P-256 -pkeyopt ec_param_enc:named_curve)
if [[ ! -e $CA/ca.key ]]; then
  run openssl genpkey "${p256[@]}" -out "$CA/ca.key.new"
  run openssl req -x509 -new -config /dev/null -key "$CA/ca.key.new" -sha256 -days 3650 -subj '/CN=Uai internal CA' \
    -addext 'basicConstraints=critical,CA:TRUE,pathlen:0' -addext 'keyUsage=critical,keyCertSign,cRLSign' \
    -addext 'subjectKeyIdentifier=hash' -out "$CA/ca.pem.new"
  own 0644 root "$CA/ca.pem.new"
  own 0400 root "$CA/ca.key.new"
  run mv -f -- "$CA/ca.pem.new" "$CA/ca.pem"
  run mv -f -- "$CA/ca.key.new" "$CA/ca.key"
  # Leaves kept from an earlier CA would no longer chain.
  RENEW=1
else
  own 0644 root "$CA/ca.pem"
  own 0400 root "$CA/ca.key"
fi

# --- Leaves: leaf DIRECTORY GROUP COMMON-NAME SUBJECT-ALT-NAMES. ---
leaf() {
  local dir="$TLS/$1" group=$2
  if ((RENEW)) || [[ ! -e $dir/cert.pem || ! -e $dir/key.pem ]]; then
    run openssl genpkey "${p256[@]}" -out "$dir/key.pem.new"
    run openssl req -x509 -new -config /dev/null -key "$dir/key.pem.new" -CA "$CA/ca.pem" -CAkey "$CA/ca.key" \
      -sha256 -days 365 -subj "/CN=$3" -addext 'basicConstraints=critical,CA:FALSE' \
      -addext 'keyUsage=critical,digitalSignature' -addext 'extendedKeyUsage=serverAuth' \
      -addext "subjectAltName=$4" -out "$dir/cert.pem.new"
    own 0640 "$group" "$dir/cert.pem.new" "$dir/key.pem.new"
    run mv -f -- "$dir/cert.pem.new" "$dir/cert.pem"
    run mv -f -- "$dir/key.pem.new" "$dir/key.pem"
  else
    own 0640 "$group" "$dir/cert.pem" "$dir/key.pem"
  fi
}
leaf api unai-api 'Uai API' 'IP:127.0.0.1'
leaf postgres postgres 'Uai PostgreSQL' 'IP:127.0.0.1,DNS:localhost'
