#!/usr/bin/env bash
# certbot deploy hook for the Uai web certificate (ADR 0043 D2).
#
# deploy/install.sh installs it as /etc/letsencrypt/renewal-hooks/deploy/unai-web.sh.
# certbot runs it as root after every successful issuance or renewal, with
# RENEWED_LINEAGE=/etc/letsencrypt/live/<name>. After the first `certbot certonly`,
# run it once by hand with that variable set.
#
# It copies and never links: the web reads its key and certificate once at
# startup (apps/web/server.ts) and never from /etc/letsencrypt. Both copies land
# as *.new and are swapped in only after both succeed, so a failed copy never
# leaves a mismatched certificate and key.
# It restarts unai-web only: the API serves an internal-CA leaf, not this certificate.
# certbot runs every deploy hook for every renewed lineage, so the host must hold
# only the uai.<owner-domain> lineage (ADR 0043 D1, D2).
#
# UNAI_DEPLOY_ROOT is the deploy scripts' test seam, a path prefix that is empty
# in production. Errors are one UPPER_SNAKE code line on stderr.
set -euo pipefail

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

dest="${UNAI_DEPLOY_ROOT:-}/etc/unai/tls/web"
lineage="${RENEWED_LINEAGE:-}"

[[ -n $lineage ]] || fail CERTBOT_HOOK_LINEAGE_REQUIRED
# install.sh creates the directory root:unai-web 0750. Never create it here: it
# would get the wrong owner and mode.
[[ -d $dest ]] || fail CERTBOT_HOOK_DESTINATION_MISSING
for name in fullchain.pem privkey.pem; do
  [[ -f $lineage/$name && -r $lineage/$name ]] || fail CERTBOT_HOOK_FILES_MISSING
done

trap 'rm -f -- "$dest/cert.pem.new" "$dest/key.pem.new"' EXIT
install -o root -g unai-web -m 0640 "$lineage/fullchain.pem" "$dest/cert.pem.new"
install -o root -g unai-web -m 0640 "$lineage/privkey.pem" "$dest/key.pem.new"
mv -f -- "$dest/cert.pem.new" "$dest/cert.pem"
mv -f -- "$dest/key.pem.new" "$dest/key.pem"

# restart, not try-restart: it also brings back a web that stopped on an expired
# certificate.
systemctl restart unai-web
