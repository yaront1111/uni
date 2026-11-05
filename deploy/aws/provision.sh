#!/usr/bin/env bash
# The AWS side of ADR 0043: the evidence bucket (D5), the backup bucket (D9),
# the restore-drill bucket (D9) and five IAM users, each with one inline policy
# named after it (D4, D5, D9). The operator runs it through AWS CLI v2 with
# administrator credentials, never with one of the five users' keys.
#
#   bash deploy/aws/provision.sh --region <aws-region> --backup-region <backup-region> \
#     --bucket-prefix <prefix> --evidence-key-arn <arn> --backup-key-arn <arn> \
#     --pgdata-key-arn <arn> --host-ipv4 <ipv4> [--dry-run]
#
# - Every input is checked before the first AWS call. Key ARNs are full ARNs,
#   never aliases: the storage adapter compares the bucket rule with
#   UNAI_S3_KMS_KEY_ID by exact string.
# - Idempotent: every put-* replaces the whole configuration, and a bucket or
#   user that already exists is not created again.
# - --dry-run executes nothing, not even a probe, and prints every command it
#   would run, creates included, one `+ aws ...` line each.
# - Bucket names are global: a name another account holds ends in
#   AWS_PROVISION_FAILED; choose another prefix.
# - It never creates, changes or deletes a KMS key, alias or key policy, never
#   creates an access key or console password, never turns on S3 Object Lock,
#   never deletes anything and never prints a credential. The account sts
#   reports is compared with the key ARNs' account, never printed. The manual
#   steps at the end are the operator's.
# Errors are one UPPER_SNAKE code line on stderr; a failing aws command also
# leaves the CLI's own message above it.
set -euo pipefail
export AWS_PAGER='' AWS_CLI_AUTO_PROMPT=off

DRY_RUN=0
region=''
backup_region=''
prefix=''
evidence_arn=''
backup_arn=''
pgdata_arn=''
host_ipv4=''

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

# Prints the command, quoting each argument that is not a plain word (the JSON
# documents, which hold no quote and no blank), then runs it unless this is a
# dry run.
aws_run() {
  local arg line='+ aws' plain='^[A-Za-z0-9_./:=@+,-]+$'
  for arg in "$@"; do
    if [[ $arg =~ $plain ]]; then line+=" $arg"; else line+=" '$arg'"; fi
  done
  printf '%s\n' "$line"
  if [[ $DRY_RUN != 1 ]]; then
    aws "$@" >/dev/null || fail AWS_PROVISION_FAILED
  fi
}

# Probes: true when the resource must be created. A dry run probes nothing.
bucket_missing() {
  if [[ $DRY_RUN == 1 ]]; then return 0; fi
  ! aws s3api head-bucket --bucket "$1" --region "$2" >/dev/null 2>&1
}
user_missing() {
  if [[ $DRY_RUN == 1 ]]; then return 0; fi
  ! aws iam get-user --user-name "$1" --region "$region" >/dev/null 2>&1
}

# Reads a heredoc of JSON and prints it compact. Safe because no input admits
# a blank (the validators below).
compact() {
  tr -d ' \n'
}

# --- Inputs: all checked before the first AWS call. ---
while (($# > 0)); do
  case $1 in
    --region | --backup-region | --bucket-prefix | --evidence-key-arn | --backup-key-arn | --pgdata-key-arn | --host-ipv4)
      if (($# < 2)) || [[ $2 == -* ]]; then fail AWS_PROVISION_USAGE; fi
      case $1 in
        --region) region=$2 ;;
        --backup-region) backup_region=$2 ;;
        --bucket-prefix) prefix=$2 ;;
        --evidence-key-arn) evidence_arn=$2 ;;
        --backup-key-arn) backup_arn=$2 ;;
        --pgdata-key-arn) pgdata_arn=$2 ;;
        --host-ipv4) host_ipv4=$2 ;;
      esac
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    *) fail AWS_PROVISION_USAGE ;;
  esac
done
for value in "$region" "$backup_region" "$prefix" "$evidence_arn" "$backup_arn" "$pgdata_arn" "$host_ipv4"; do
  [[ -n $value ]] || fail AWS_PROVISION_USAGE
done

region_pattern='^[a-z]{2}(-[a-z]+)+-[0-9]+$'
[[ $region =~ $region_pattern && $backup_region =~ $region_pattern ]] || fail AWS_PROVISION_REGION_INVALID
# D9: the backup bucket lives in another region than the evidence bucket.
[[ $region != "$backup_region" ]] || fail AWS_PROVISION_BACKUP_REGION_SAME

# No dots (D5: path-style addressing), and <prefix>-uai-restore-drill, the
# longest name, stays within S3's 63 characters. S3 reserves the other prefixes.
prefix_pattern='^[a-z0-9]([a-z0-9-]{0,43}[a-z0-9])?$'
[[ $prefix =~ $prefix_pattern ]] || fail AWS_PROVISION_BUCKET_PREFIX_INVALID
[[ $prefix != xn--* && $prefix != sthree-* && $prefix != amzn-s3-demo-* ]] || fail AWS_PROVISION_BUCKET_PREFIX_INVALID

# A full key ARN: arn:aws:kms:<region>:<account>:key/<id>. An alias never matches.
arn_pattern='^arn:aws:kms:([a-z0-9-]+):([0-9]{12}):key/(mrk-[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$'
[[ $evidence_arn =~ $arn_pattern ]] || fail AWS_PROVISION_KEY_ARN_INVALID
evidence_key_region=${BASH_REMATCH[1]}
account=${BASH_REMATCH[2]}
evidence_key=${BASH_REMATCH[3]}
[[ $pgdata_arn =~ $arn_pattern ]] || fail AWS_PROVISION_KEY_ARN_INVALID
pgdata_key_region=${BASH_REMATCH[1]}
pgdata_account=${BASH_REMATCH[2]}
pgdata_key=${BASH_REMATCH[3]}
[[ $backup_arn =~ $arn_pattern ]] || fail AWS_PROVISION_KEY_ARN_INVALID
backup_key_region=${BASH_REMATCH[1]}
backup_account=${BASH_REMATCH[2]}
backup_key=${BASH_REMATCH[3]}
# SSE-KMS needs a key in the bucket's region; the pgdata key sits beside the
# evidence key (D4, D5). One account, and three separate keys: a multi-region
# replica shares its key id, so ids are compared, not ARNs.
[[ $evidence_key_region == "$region" && $pgdata_key_region == "$region" && $backup_key_region == "$backup_region" ]] ||
  fail AWS_PROVISION_KEY_ARN_INVALID
[[ $pgdata_account == "$account" && $backup_account == "$account" ]] || fail AWS_PROVISION_KEY_ARN_INVALID
[[ $evidence_key != "$pgdata_key" && $evidence_key != "$backup_key" && $pgdata_key != "$backup_key" ]] ||
  fail AWS_PROVISION_KEY_ARN_INVALID

# A dotted quad without a CIDR suffix: the unlock policy appends /32.
octet='(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])'
ipv4_pattern="^${octet}[.]${octet}[.]${octet}[.]${octet}\$"
[[ $host_ipv4 =~ $ipv4_pattern ]] || fail AWS_PROVISION_HOST_IPV4_INVALID

# --- Real run only: the CLI and the caller's account, before any mutation. The
# account is compared, never printed. ---
if [[ $DRY_RUN != 1 ]]; then
  version=$(aws --version 2>&1) || fail AWS_PROVISION_CLI_V2_REQUIRED
  [[ $version == aws-cli/2.* ]] || fail AWS_PROVISION_CLI_V2_REQUIRED
  caller=$(aws sts get-caller-identity --region "$region" --query Account --output text 2>/dev/null) ||
    fail AWS_PROVISION_CREDENTIALS_UNAVAILABLE
  [[ $caller == "$account" ]] || fail AWS_PROVISION_ACCOUNT_MISMATCH
fi

evidence="$prefix-uai-evidence"
backup="$prefix-uai-backup"
drill="$prefix-uai-restore-drill"
E="arn:aws:s3:::$evidence"
B="arn:aws:s3:::$backup"
D="arn:aws:s3:::$drill"

# bucket_base NAME REGION KEY_ARN creates the bucket when it is missing, then
# applies what every Uai bucket shares: Block Public Access x4,
# BucketOwnerEnforced and exactly one aws:kms rule naming KEY_ARN. us-east-1
# refuses a LocationConstraint.
bucket_base() {
  local name=$1 location=$2 key_arn=$3
  local -a configuration=()
  if [[ $location != us-east-1 ]]; then
    configuration=(--create-bucket-configuration "{\"LocationConstraint\":\"$location\"}")
  fi
  if bucket_missing "$name" "$location"; then
    aws_run s3api create-bucket --bucket "$name" --region "$location" "${configuration[@]}"
  fi
  aws_run s3api put-public-access-block --bucket "$name" --region "$location" --public-access-block-configuration \
    '{"BlockPublicAcls":true,"IgnorePublicAcls":true,"BlockPublicPolicy":true,"RestrictPublicBuckets":true}'
  aws_run s3api put-bucket-ownership-controls --bucket "$name" --region "$location" --ownership-controls \
    '{"Rules":[{"ObjectOwnership":"BucketOwnerEnforced"}]}'
  aws_run s3api put-bucket-encryption --bucket "$name" --region "$location" --server-side-encryption-configuration \
    "{\"Rules\":[{\"ApplyServerSideEncryptionByDefault\":{\"SSEAlgorithm\":\"aws:kms\",\"KMSMasterKeyID\":\"$key_arn\"},\"BucketKeyEnabled\":true}]}"
}

# --- (a) Evidence bucket (D5): versioned, noncurrent copies kept 30 days, and a
# policy that refuses plain HTTP and any put not under the evidence key. ---
bucket_base "$evidence" "$region" "$evidence_arn"
aws_run s3api put-bucket-versioning --bucket "$evidence" --region "$region" --versioning-configuration '{"Status":"Enabled"}'
aws_run s3api put-bucket-lifecycle-configuration --bucket "$evidence" --region "$region" --lifecycle-configuration "$(compact <<EOF
{"Rules": [{"ID": "uai-evidence-noncurrent", "Status": "Enabled", "Filter": {},
  "NoncurrentVersionExpiration": {"NoncurrentDays": 30},
  "Expiration": {"ExpiredObjectDeleteMarker": true}}]}
EOF
)"
aws_run s3api put-bucket-policy --bucket "$evidence" --region "$region" --policy "$(compact <<EOF
{"Version": "2012-10-17", "Statement": [
  {"Sid": "DenyInsecureTransport", "Effect": "Deny", "Principal": "*", "Action": "s3:*",
    "Resource": ["$E", "$E/*"], "Condition": {"Bool": {"aws:SecureTransport": "false"}}},
  {"Sid": "DenyPutWithoutKms", "Effect": "Deny", "Principal": "*", "Action": "s3:PutObject",
    "Resource": "$E/*", "Condition": {"StringNotEquals": {"s3:x-amz-server-side-encryption": "aws:kms"}}},
  {"Sid": "DenyPutUnderAnotherKey", "Effect": "Deny", "Principal": "*", "Action": "s3:PutObject",
    "Resource": "$E/*", "Condition": {"StringNotEquals": {"s3:x-amz-server-side-encryption-aws-kms-key-id": "$evidence_arn"}}}]}
EOF
)"

# --- (b) Backup bucket (D9), in the backup region under the backup key: 30 days
# current, 5 days noncurrent, unfinished multipart uploads aborted after 1 day.
# No bucket policy: a multipart UploadPart carries no SSE header. ---
bucket_base "$backup" "$backup_region" "$backup_arn"
aws_run s3api put-bucket-versioning --bucket "$backup" --region "$backup_region" --versioning-configuration '{"Status":"Enabled"}'
aws_run s3api put-bucket-lifecycle-configuration --bucket "$backup" --region "$backup_region" --lifecycle-configuration "$(compact <<EOF
{"Rules": [{"ID": "uai-backup-retention", "Status": "Enabled", "Filter": {},
  "Expiration": {"Days": 30}, "NoncurrentVersionExpiration": {"NoncurrentDays": 5},
  "AbortIncompleteMultipartUpload": {"DaysAfterInitiation": 1}}]}
EOF
)"

# --- (c) Restore-drill bucket (D9): the evidence key, because the drill restores
# through the storage adapter; unversioned, so a drill's DeleteObject removes
# what it restored; anything left expires after 2 days. ---
bucket_base "$drill" "$region" "$evidence_arn"
aws_run s3api put-bucket-lifecycle-configuration --bucket "$drill" --region "$region" --lifecycle-configuration "$(compact <<EOF
{"Rules": [{"ID": "uai-restore-drill-expiry", "Status": "Enabled", "Filter": {}, "Expiration": {"Days": 2}}]}
EOF
)"

# --- IAM users, one inline policy each, named after the user. Allow statements
# only; no s3:DeleteObjectVersion, no listing of the evidence bucket, no kms
# action beyond GenerateDataKey and Decrypt, no wildcard. ---
# D5 as amended 2026-11-03: unai-api and unai-worker hold the same set, delete
# included (the ADR 0030 cascade runs in both).
runtime_policy=$(compact <<EOF
{"Version": "2012-10-17", "Statement": [
  {"Effect": "Allow", "Action": ["s3:GetEncryptionConfiguration"], "Resource": ["$E"]},
  {"Effect": "Allow", "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"], "Resource": ["$E/*"]},
  {"Effect": "Allow", "Action": ["kms:GenerateDataKey", "kms:Decrypt"], "Resource": ["$evidence_arn"]}]}
EOF
)
# D9: reads evidence, writes archives, never deletes one.
backup_policy=$(compact <<EOF
{"Version": "2012-10-17", "Statement": [
  {"Effect": "Allow", "Action": ["s3:GetEncryptionConfiguration"], "Resource": ["$E"]},
  {"Effect": "Allow", "Action": ["s3:GetObject"], "Resource": ["$E/*"]},
  {"Effect": "Allow", "Action": ["kms:Decrypt"], "Resource": ["$evidence_arn"]},
  {"Effect": "Allow", "Action": ["s3:ListBucket"], "Resource": ["$B"]},
  {"Effect": "Allow", "Action": ["s3:PutObject", "s3:GetObject", "s3:AbortMultipartUpload"], "Resource": ["$B/*"]},
  {"Effect": "Allow", "Action": ["kms:GenerateDataKey", "kms:Decrypt"], "Resource": ["$backup_arn"]}]}
EOF
)
# D4 as amended 2026-11-05: decrypt the volume key, only from the host.
unlock_policy=$(compact <<EOF
{"Version": "2012-10-17", "Statement": [
  {"Effect": "Allow", "Action": ["kms:Decrypt"], "Resource": ["$pgdata_arn"],
    "Condition": {"IpAddress": {"aws:SourceIp": "$host_ipv4/32"}}}]}
EOF
)
# D9 as amended 2026-11-05: read the backup bucket, restore into the drill bucket.
drill_policy=$(compact <<EOF
{"Version": "2012-10-17", "Statement": [
  {"Effect": "Allow", "Action": ["s3:ListBucket"], "Resource": ["$B"]},
  {"Effect": "Allow", "Action": ["s3:GetObject"], "Resource": ["$B/*"]},
  {"Effect": "Allow", "Action": ["kms:Decrypt"], "Resource": ["$backup_arn"]},
  {"Effect": "Allow", "Action": ["s3:GetEncryptionConfiguration", "s3:ListBucket"], "Resource": ["$D"]},
  {"Effect": "Allow", "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"], "Resource": ["$D/*"]},
  {"Effect": "Allow", "Action": ["kms:GenerateDataKey", "kms:Decrypt"], "Resource": ["$evidence_arn"]}]}
EOF
)

user_policy() {
  if user_missing "$1"; then
    aws_run iam create-user --user-name "$1" --region "$region"
  fi
  aws_run iam put-user-policy --user-name "$1" --policy-name "$1" --region "$region" --policy-document "$2"
}
user_policy unai-api "$runtime_policy"
user_policy unai-worker "$runtime_policy"
user_policy unai-backup "$backup_policy"
user_policy unai-host-unlock "$unlock_policy"
user_policy unai-restore-drill "$drill_policy"

printf '\nRemaining manual steps:\n'
printf '%s\n' \
  "1. Keep the three customer-managed keys on their default key policy, which lets these IAM policies grant their use: alias/unai-evidence and alias/unai-pgdata in $region, alias/unai-backup in $backup_region. Nothing here changes a key or its policy." \
  '2. Create one access key per user and write it as a shared-credentials file, owners and modes per ADR 0043 D4, D6 and D9:' \
  '   - /etc/unai/secrets/api/aws/credentials (unai-api)' \
  '   - /etc/unai/secrets/worker/aws/credentials (unai-worker)' \
  '   - /etc/unai/backup/aws-credentials (unai-backup)' \
  '   - /etc/unai/pgdata/aws-credentials (unai-host-unlock)' \
  "   - the restore drill's own credentials file (unai-restore-drill)"
