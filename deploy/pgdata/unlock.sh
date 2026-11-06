#!/usr/bin/env bash
# Unlocks and mounts the ADR 0043 D4 encrypted PostgreSQL data volume at boot.
# deploy/systemd/unai-pgdata-unlock.service runs it as root, before
# postgresql@17-main.service, which requires that unit once it is enabled.
#
#   bash deploy/pgdata/unlock.sh
#
# - Credentials and region come only from the unit's environment:
#   AWS_SHARED_CREDENTIALS_FILE=/etc/unai/pgdata/aws-credentials (unai-host-unlock,
#   kms:Decrypt only), AWS_CONFIG_FILE=/etc/unai/pgdata/aws-config and
#   AWS_EC2_METADATA_DISABLED=true.
# - It waits for /dev/disk/by-label/unai-pgdata, decrypts
#   /etc/unai/pgdata/volume-key.enc through KMS and pipes the 64-byte plaintext
#   into cryptsetup open. The plaintext exists only in this shell's memory and in
#   pipes: never in a file, an argv, the output or the journal.
# - It mounts /dev/mapper/unai-pgdata at /var/lib/postgresql (nodev,nosuid).
# - Fails closed: when the volume, KMS or the key is unavailable, it stops with a
#   code before opening or mounting anything. The unit then fails, PostgreSQL never
#   starts on the bare mount point, and /var/lib/postgresql stays unmounted.
# - An already open mapping (for example after a recovery-passphrase open) needs
#   no KMS call: the script only mounts it if needed.
# - UNAI_DEPLOY_ROOT is the deploy scripts' test seam, a path prefix that is empty
#   in production.
# Errors are one UPPER_SNAKE code line on stderr; no tool or provider text is
# printed. Success prints pgdata.unlocked.
set -euo pipefail
umask 077

readonly R="${UNAI_DEPLOY_ROOT:-}"
readonly NAME=unai-pgdata
readonly KEY="$R/etc/unai/pgdata/volume-key.enc"
readonly LABEL="$R/dev/disk/by-label/$NAME"
readonly MAPPED="$R/dev/mapper/$NAME"
readonly MNT="$R/var/lib/postgresql"
plain=''

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

[[ -n $R || $(id -u) == 0 ]] || fail PGDATA_UNLOCK_ROOT_REQUIRED
if ! cryptsetup status "$NAME" >/dev/null 2>&1; then
  [[ -f $KEY && ! -L $KEY ]] || fail PGDATA_UNLOCK_KEY_MISSING
  udevadm wait --timeout=60 "$LABEL" >/dev/null 2>&1 || fail PGDATA_UNLOCK_DEVICE_MISSING
  plain=$(aws kms decrypt --ciphertext-blob "fileb://$KEY" --cli-connect-timeout 10 \
    --query Plaintext --output text 2>/dev/null) || fail PGDATA_UNLOCK_KMS_FAILED
  # 64 bytes are exactly 88 base64 characters, the last two '='.
  [[ $plain =~ ^[A-Za-z0-9+/]{86}==$ ]] || fail PGDATA_UNLOCK_KMS_RESPONSE_INVALID
  # printf is a builtin, so the key never enters an argv.
  printf '%s' "$plain" | base64 -d | cryptsetup open --type luks2 --key-file=- "$LABEL" "$NAME" >/dev/null 2>&1 ||
    fail PGDATA_UNLOCK_OPEN_FAILED
  unset plain
fi
if ! mountpoint -q "$MNT"; then
  mount -o nodev,nosuid "$MAPPED" "$MNT" >/dev/null 2>&1 || fail PGDATA_UNLOCK_MOUNT_FAILED
fi
printf 'pgdata.unlocked\n'
