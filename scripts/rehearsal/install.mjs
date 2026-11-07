// Shell runs only inside the disposable host, with root-only logs.
const installer='bash /root/uai-install/deploy/install.sh --tag rehearsal-a --repo file:///srv/unai.git';
export const snapshot=String.raw`
snapshot() {
  if [ "$#" = 0 ]; then set -- /opt/unai /etc/unai /etc/systemd/system /etc/apt /etc/letsencrypt /usr/local/bin /usr/local/aws-cli /var/cache/unai /var/lib/postgresql; fi
  for path in "$@"; do
    if [ -e "$path" ]; then find "$path" -printf '%p %m %u %g %s %T@\n' | LC_ALL=C sort; else printf 'absent:%s\n' "$path"; fi
  done | sha256sum
  (getent passwd unai-api unai-web unai-worker unai-backup || true) | sha256sum
  dpkg-query -W | sha256sum
  timedatectl show -p Timezone
}
`;
async function dryRun(run){
  await run.inside('git clone --depth 1 --branch rehearsal-a file:///srv/unai.git /root/uai-install');
  await run.inside(`${snapshot}\nsnapshot > /root/rehearsal/before\n${installer} --dry-run\nsnapshot > /root/rehearsal/after\ncmp -s /root/rehearsal/before /root/rehearsal/after`,
    {report:'if [ "$code" = 0 ]; then echo DRY_RUN_SNAPSHOT_EQUAL; fi'});
}
async function install(run){
  for(let pass=0;pass<2;pass++)await run.inside(installer,{timeout:2400000,report:'sed -n \'/Remaining manual steps:/,$p\' "$log"'});
  await run.inside(String.raw`
test "$(readlink /opt/unai/current)" = releases/rehearsal-a
test -f /opt/unai/current/apps/web/.next/unai-build-complete
test "$(node -v)" = v24.22.2
test "$(pnpm -v)" = 11.0.8
aws --version | grep -q '^aws-cli/2.36.7 '
pg_lsclusters --no-header | grep -Eq '^17[[:space:]]+main[[:space:]]+5432[[:space:]]+online'
v=$(dpkg-query -W postgresql-17-pgvector | awk '{print $2}')
dpkg --compare-versions "$v" ge 0.8.6
dpkg --compare-versions "$v" lt 0.9~
for unit in /opt/unai/current/deploy/systemd/unai-*.service /opt/unai/current/deploy/systemd/unai-*.timer; do test -f "/etc/systemd/system/$(basename "$unit")"; done
test -f /etc/unai/migrate.env
for file in /etc/unai/*.env; do test "$(stat -c '%U:%G:%a' "$file")" = root:root:600; done
`,{report:'if [ "$code" = 0 ]; then echo INSTALL_ASSERTIONS_OK; fi'});
}
async function tls(run){
  await run.inside('cd /opt/unai/current; bash deploy/tls/issue-internal-ca.sh --dry-run; bash deploy/tls/issue-internal-ca.sh');
  await run.inside(String.raw`
install -d -m 0700 /etc/letsencrypt/live/uai.rehearsal.invalid
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 2 \
 -subj /CN=uai.rehearsal.invalid -addext subjectAltName=DNS:uai.rehearsal.invalid \
 -keyout /etc/letsencrypt/live/uai.rehearsal.invalid/privkey.pem -out /etc/letsencrypt/live/uai.rehearsal.invalid/fullchain.pem
chmod 0600 /etc/letsencrypt/live/uai.rehearsal.invalid/privkey.pem
`);
}
async function postgres(run){
  await run.inside(String.raw`
cd /opt/unai/current
install -o root -g root -m 0644 deploy/postgres/unai.conf /etc/postgresql/17/main/conf.d/unai.conf
install -o postgres -g postgres -m 0640 deploy/postgres/pg_hba.conf /etc/postgresql/17/main/pg_hba.conf
systemctl restart postgresql
set -o noclobber
{
  for name in migrator_password api_login_password worker_login_password auth_login_password backup_password; do
    v=$(openssl rand -hex 32)
    printf "\\set %s '%s'\n" "$name" "$v"
    unset v
  done
  printf "\\set encryption_at_rest '%s'\n" 'volume-kms:arn:aws:kms:us-east-1:000000000000:key/rehearsal-pgdata'
} > /root/unai-provision.psql
`);
  for(let pass=0;pass<2;pass++)await run.inside('cat /root/unai-provision.psql /opt/unai/current/deploy/postgres/provision.sql | sudo -u postgres psql -X -v ON_ERROR_STOP=1 -f -',
    {report:`if [ "$code" = 0 ]; then echo PROVISION_PASS_${pass+1}; fi`});
  await run.inside(String.raw`
v=$(awk -F "'" '/^\\set migrator_password /{print $2}' /root/unai-provision.psql)
test -n "$v"
printf '127.0.0.1:5432:unai:unai_migrator:%s\n' "$v" > /root/.pgpass
unset v
chmod 0600 /root/.pgpass
psql 'host=127.0.0.1 dbname=unai user=unai_migrator sslmode=verify-full sslrootcert=/etc/unai/tls/ca/ca.pem' -X -v ON_ERROR_STOP=1 -At -c 'SELECT 1' | grep -qx 1
if psql 'host=127.0.0.1 dbname=unai user=unai_migrator sslmode=disable' -X -c 'SELECT 1'; then exit 1; fi
`,{report:'if [ "$code" = 0 ]; then echo POSTGRES_VERIFY_FULL_OK; echo POSTGRES_PLAINTEXT_REFUSED; fi'});
}
export const installPhases={'install-dry-run':dryRun,install,tls,postgres};
