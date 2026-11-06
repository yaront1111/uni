#!/usr/bin/env bash
# Creates the ADR 0043 D4 encrypted PostgreSQL data volume, once, on the host, as
# root, after deploy/install.sh's first pass and before PostgreSQL is installed.
#
#   bash deploy/pgdata/setup.sh --device <block-device> --key-arn <pgdata-key-arn> [--dry-run]
#
# Run it in the root shell deploy/README.md prescribes (sudo -i): plain sudo
# would drop the exported credentials.
# - Credentials: AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY (optionally
#   AWS_SESSION_TOKEN) of an identity allowed kms:GenerateDataKey on the pgdata
#   key, for this one run: unai-host-unlock may only Decrypt. No AWS config,
#   credentials file or profile is read.
# - Before any AWS call or write it refuses a device that is not a disk or a
#   partition, is mounted, has a partition or mapping, or carries a filesystem,
#   partition table or LUKS signature; an existing volume-key.enc, mapping or
#   by-label link; and a mounted or non-empty /var/lib/postgresql.
# - It takes 64 bytes from KMS GenerateDataKey and writes one file,
#   /etc/unai/pgdata/volume-key.enc (root:root 0400, the KMS ciphertext). It
#   pipes the plaintext into cryptsetup luksFormat (LUKS2, aes-xts-plain64,
#   512-bit, argon2id, label unai-pgdata) and cryptsetup open, makes ext4 on
#   /dev/mapper/unai-pgdata and mounts it at /var/lib/postgresql (nodev,nosuid).
#   The plaintext exists only in this shell's memory and in pipes: never in a
#   file, an argv, the output or a log.
# - Recovery: a run that fails after writing volume-key.enc keeps it, and maybe a
#   LUKS header, and a re-run refuses both. The volume holds nothing yet: remove
#   the key file and wipe the device as deploy/README.md describes, then re-run.
# - --dry-run runs the read-only probes and prints the steps, with no AWS call
#   and no change.
# - UNAI_DEPLOY_ROOT is the deploy scripts' test seam, a path prefix that is
#   empty in production. As in issue-internal-ca.sh it is honoured in a real
#   run, but only for a --device under it, so it can never format a real disk.
# Errors are one UPPER_SNAKE code line on stderr; AWS CLI errors pass through.
set -euo pipefail
umask 077
export LC_ALL=C

readonly R="${UNAI_DEPLOY_ROOT:-}"
readonly NAME=unai-pgdata
readonly DIR="$R/etc/unai/pgdata"
readonly KEY="$DIR/volume-key.enc"
readonly MAPPED="$R/dev/mapper/$NAME"
readonly LABEL="$R/dev/disk/by-label/$NAME"
readonly MNT="$R/var/lib/postgresql"
# A full key ARN; never an alias or a multi-Region key.
readonly ARN_PATTERN='^arn:aws:kms:([a-z0-9-]+):[0-9]{12}:key/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
DRY_RUN=0
device=''
arn=''
plain=''

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

show() {
  printf '+'
  printf ' %q' "$@"
  printf '\n'
}

# run CODE COMMAND...: prints COMMAND, then runs it unless this is a dry run.
run() {
  local code=$1
  shift
  show "$@"
  if ((!DRY_RUN)); then
    "$@" || fail "$code"
  fi
}

# with_key CODE COMMAND...: as run, with the volume key on COMMAND's stdin.
# printf is a builtin, so the key never enters an argv.
with_key() {
  local code=$1
  shift
  show "$@"
  if ((!DRY_RUN)); then
    printf '%s' "$plain" | base64 -d | "$@" || fail "$code"
  fi
}

# --- Preconditions: all checked before the first AWS call or write. ---
while (($# > 0)); do
  case $1 in
    --device | --key-arn)
      (($# >= 2)) || fail PGDATA_SETUP_USAGE
      if [[ $1 == --device ]]; then device=$2; else arn=$2; fi
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    *) fail PGDATA_SETUP_USAGE ;;
  esac
done
[[ -n $device && -n $arn ]] || fail PGDATA_SETUP_USAGE
[[ $arn =~ $ARN_PATTERN ]] || fail PGDATA_SETUP_KEY_ARN_INVALID
region=${BASH_REMATCH[1]}
# Absolute, so it can never be read as an option.
[[ $device == /* && $device != *..* ]] || fail PGDATA_SETUP_DEVICE_INVALID
[[ -z $R || $device == "$R"/* ]] || fail PGDATA_SETUP_DEPLOY_ROOT_DEVICE
[[ $DRY_RUN == 1 || -n $R || $(id -u) == 0 ]] || fail PGDATA_SETUP_ROOT_REQUIRED
for tool in aws cryptsetup mkfs.ext4 blkid lsblk mount mountpoint base64 flock; do
  command -v "$tool" >/dev/null || fail PGDATA_SETUP_TOOL_MISSING
done
if ((!DRY_RUN)); then
  version=$(aws --version 2>/dev/null) || fail PGDATA_SETUP_CLI_V2_REQUIRED
  [[ $version == aws-cli/2.* ]] || fail PGDATA_SETUP_CLI_V2_REQUIRED
  [[ -n ${AWS_ACCESS_KEY_ID:-} && -n ${AWS_SECRET_ACCESS_KEY:-} ]] || fail PGDATA_SETUP_CREDENTIALS_REQUIRED
fi
[[ -d $DIR ]] || fail PGDATA_SETUP_DIRECTORY_MISSING
if ((!DRY_RUN)); then
  # The lock is on the directory itself, so no lock file is left behind.
  exec 9<"$DIR"
  flock -n 9 || fail PGDATA_SETUP_BUSY
fi
[[ ! -e $KEY && ! -L $KEY ]] || fail PGDATA_SETUP_KEY_EXISTS

# The device and every partition or mapping on it: one "TYPE MOUNTPOINT" row each.
info=$(lsblk -nro TYPE,MOUNTPOINT "$device" 2>/dev/null) || fail PGDATA_SETUP_DEVICE_INVALID
mapfile -t rows <<<"$info"
read -r type _ <<<"${rows[0]}"
[[ $type == disk || $type == part ]] || fail PGDATA_SETUP_DEVICE_INVALID
for row in "${rows[@]}"; do
  read -r _ mountpoint <<<"$row"
  [[ -z $mountpoint ]] || fail PGDATA_SETUP_DEVICE_IN_USE
done
((${#rows[@]} == 1)) || fail PGDATA_SETUP_DEVICE_NOT_EMPTY
# Low-level probe: 2 is nothing found, 0 a signature, 8 conflicting signatures.
probe=0
blkid -p -o export "$device" >/dev/null 2>&1 || probe=$?
case $probe in
  2) ;;
  0 | 8) fail PGDATA_SETUP_DEVICE_NOT_EMPTY ;;
  *) fail PGDATA_SETUP_DEVICE_PROBE_FAILED ;;
esac
if [[ -e $MAPPED || -L $MAPPED ]] || cryptsetup status "$NAME" >/dev/null 2>&1; then
  fail PGDATA_SETUP_MAPPING_EXISTS
fi
# The unlock finds the volume by this label, so it must be the only one.
[[ ! -e $LABEL && ! -L $LABEL ]] || fail PGDATA_SETUP_LABEL_EXISTS
if mountpoint -q "$MNT"; then
  fail PGDATA_SETUP_ALREADY_MOUNTED
fi
if [[ -e $MNT || -L $MNT ]]; then
  [[ -d $MNT && ! -L $MNT ]] || fail PGDATA_SETUP_MOUNT_POINT_NOT_EMPTY
  [[ -z $(find "$MNT" -mindepth 1 -maxdepth 1 -print -quit) ]] || fail PGDATA_SETUP_MOUNT_POINT_NOT_EMPTY
fi

# --- The volume key: 64 bytes from KMS, with the operator's environment credentials only. ---
generate=(aws kms generate-data-key --region "$region" --key-id "$arn" --number-of-bytes 64
  --query '[CiphertextBlob,Plaintext]' --output text)
show "${generate[@]}"
if ((!DRY_RUN)); then
  pair=$(env -u AWS_PROFILE -u AWS_DEFAULT_PROFILE AWS_CONFIG_FILE=/dev/null AWS_SHARED_CREDENTIALS_FILE=/dev/null \
    AWS_EC2_METADATA_DISABLED=true AWS_PAGER='' "${generate[@]}") || fail PGDATA_SETUP_KMS_FAILED
  blob=${pair%%$'\t'*}
  plain=${pair#*$'\t'}
  unset pair
  # 64 bytes are exactly 88 base64 characters, the last two '='.
  [[ $blob =~ ^[A-Za-z0-9+/]+=*$ && $plain =~ ^[A-Za-z0-9+/]{86}==$ ]] || fail PGDATA_SETUP_KMS_RESPONSE_INVALID
fi

# --- Only the ciphertext reaches disk: written whole at its final mode, then moved. ---
printf '+ base64 -d > %q  (the KMS ciphertext)\n' "$KEY.new"
if ((!DRY_RUN)); then
  trap 'rm -f -- "$KEY.new"' EXIT
  printf '%s' "$blob" | base64 -d >"$KEY.new" || fail PGDATA_SETUP_KEY_WRITE_FAILED
fi
run PGDATA_SETUP_KEY_WRITE_FAILED chmod 0400 "$KEY.new"
run PGDATA_SETUP_KEY_WRITE_FAILED chown root:root "$KEY.new"
run PGDATA_SETUP_KEY_WRITE_FAILED mv -T -- "$KEY.new" "$KEY"

# --- LUKS2 (D4), then the filesystem and the mount. ---
with_key PGDATA_SETUP_FORMAT_FAILED cryptsetup luksFormat --batch-mode --type luks2 --cipher aes-xts-plain64 \
  --key-size 512 --pbkdf argon2id --label "$NAME" --key-file=- "$device"
with_key PGDATA_SETUP_OPEN_FAILED cryptsetup open --type luks2 --key-file=- "$device" "$NAME"
unset plain
# No filesystem label: the LUKS2 label alone owns /dev/disk/by-label/unai-pgdata.
run PGDATA_SETUP_MKFS_FAILED mkfs.ext4 -q "$MAPPED"
if [[ ! -d $MNT ]]; then
  run PGDATA_SETUP_MOUNT_FAILED install -d -m 0755 "$MNT"
fi
run PGDATA_SETUP_MOUNT_FAILED mount -o nodev,nosuid "$MAPPED" "$MNT"

cat <<'EOF'

Remaining manual steps (deploy/README.md, "Encrypted data volume"):
1. Write /etc/unai/pgdata/aws-credentials (unai-host-unlock) and
   /etc/unai/pgdata/aws-config ("[default]" and "region = <aws-region>"),
   both root:root 0400.
2. Add the keyslot-1 recovery passphrase, typed at the prompt, and keep it
   offline with the backup key (ADR 0043 D9):
   cryptsetup luksAddKey --key-slot 1 --key-file <(AWS_SHARED_CREDENTIALS_FILE=/etc/unai/pgdata/aws-credentials AWS_CONFIG_FILE=/etc/unai/pgdata/aws-config AWS_EC2_METADATA_DISABLED=true aws kms decrypt --ciphertext-blob fileb:///etc/unai/pgdata/volume-key.enc --query Plaintext --output text | base64 -d) /dev/disk/by-label/unai-pgdata
3. Keep the D4 evidence: cryptsetup luksDump /dev/disk/by-label/unai-pgdata,
   lsblk -o NAME,TYPE,FSTYPE,MOUNTPOINT, aws kms describe-key --key-id alias/unai-pgdata.
4. systemctl enable unai-pgdata-unlock.service
5. Re-run deploy/install.sh with the same --tag to install PostgreSQL 17 and pgvector.
EOF
