// Rehearsal 3/4: run the shipped lifecycle, never substitute product commands.
import {fileURLToPath} from 'node:url';
import {prelude,active,state,tool} from './services.mjs';
import {report,probeVerdict} from '../lib/rehearsal-checks.mjs';
import {requirePreflight} from '../lib/rehearsal-record.mjs';
import {snapshot} from './install.mjs';
const host=`NODE_EXTRA_CA_CERTS=/etc/unai/rehearsal/ca-bundle.pem node ${tool}/lifecycle-host.mjs`;
export const lifecyclePrelude=`${active}\n${prelude}
rm -f ${state}/lifecycle-report ${state}/lifecycle-error
`;
const output=`if [ "$code" = 0 ]; then echo @@lifecycle; cat ${state}/lifecycle-report; else cat ${state}/lifecycle-error 2>/dev/null || true; fi`;
export async function runPhase(run,script,timeout=300000){
  const result=await run.inside(lifecyclePrelude+script,{timeout,report:output});
  run.phase.assertions=JSON.parse(report(result,['lifecycle']).lifecycle);
}
const prerequisites=String.raw`
for name in evidence backup drill; do test "$(systemctl show -p Restart --value unai-rehearsal-s3-$name)" = no; done
test -f /etc/unai/rehearsal/ca-bundle.pem
for name in backup restore-drill; do
  test -f /etc/systemd/system/unai-$name.service.d/rehearsal.conf
  grep -qE '^[A-Z0-9_]+=.*<' /etc/unai/$name.env && exit 1
  test "$?" = 1
done
for name in backup.key pgpass aws-credentials; do test "$(stat -c '%U:%a' /etc/unai/backup/$name)" = unai-backup:600; done
test "$(stat -c '%U:%a' /etc/unai/restore-drill)" = root:700
for name in pgpass aws-credentials; do test "$(stat -c '%U:%a' /etc/unai/restore-drill/$name)" = root:600; done
test "$(stat -c '%U:%a' /var/lib/postgresql/unai-restore-drill-staging)" = root:700
install -d -m 0755 /etc/systemd/system/unai-upgrade-backup.service.d
printf '[Service]\nEnvironment=NODE_EXTRA_CA_CERTS=/etc/unai/rehearsal/ca-bundle.pem\n' > /etc/systemd/system/unai-upgrade-backup.service.d/rehearsal.conf
chmod 0644 /etc/systemd/system/unai-upgrade-backup.service.d/rehearsal.conf
systemctl daemon-reload
`;
async function backup(run){
  for(const file of ['lifecycle-tool.mjs','lifecycle-host.mjs'])
    await run.command('docker',['cp',fileURLToPath(new URL(file,import.meta.url)),`${run.container}:${tool}/${file}`]);
  run.record.unverified.push({layer:'Offline backup key custody',reason:'No offline key copy is made; the key stays in its disposable host file.'});
  await runPhase(run,`${prerequisites}
mark ${state}/lifecycle.cursor
systemctl start unai-backup.service
until_ok 120 ready 9101
until_ok 120 ready 9102
${host} backup`);
}
async function drill(run){
  await runPhase(run,String.raw`
setsid sudo -u postgres node ${tool}/lifecycle-host.mjs sample > ${state}/samples &
sampler=$!
stop_sampler(){ kill -TERM -- -"$sampler" 2>/dev/null || true; wait "$sampler" || test "$?" = 143; }
trap stop_sampler EXIT
until_ok 10 test -s ${state}/samples
kill -0 "$sampler"
mark ${state}/lifecycle.cursor
systemctl start unai-restore-drill.service
kill -0 "$sampler"
stop_sampler
trap - EXIT
${host} drill
systemctl enable --now unai-backup.timer unai-restore-drill.timer
systemctl is-active --quiet unai-backup.timer unai-restore-drill.timer
`,600000);
}
export const upgradePrelude=String.raw`
idle(){ local s; for name in backup restore-drill; do s=$(systemctl is-active unai-$name.service) || true; case "$s" in inactive|failed) ;; *) return 1;; esac; done; }
until_ok 600 idle
args=(rehearsal-b)
target=$(cat ${state}/registry-version)
if [ -n "$target" ]; then args+=(--registry-version "$target"); fi
cd /opt/unai/current
`;
export const upgradeSnapshot=`${snapshot}
database_counts(){ sudo -u postgres psql -X -d unai -At -v ON_ERROR_STOP=1 -c 'SELECT (SELECT count(*) FROM unai_migrations.applied),(SELECT count(*) FROM registry_releases)'; }
protected_snapshot(){ find /etc/unai -maxdepth 1 -type f -name '*.env*' -print0 | sort -z | xargs -0 sha256sum; database_counts; }
upgrade_snapshot(){
 snapshot /etc/unai /etc/systemd/system /etc/letsencrypt/renewal-hooks/deploy /var/lib/postgresql/unai-backup-staging
 protected_snapshot
 find /etc/systemd/system -name 'unai-*' -type f -print0 | sort -z | xargs -0 sha256sum
 sha256sum /etc/letsencrypt/renewal-hooks/deploy/unai-web.sh
 readlink /opt/unai/current
 find /opt/unai/releases -mindepth 1 -maxdepth 1 -printf '%f\\n' | sort
 flag test -e /run/lock/unai-upgrade.lock
 for unit in unai-api unai-web unai-worker unai-backup.timer unai-restore-drill.timer; do systemctl is-active "$unit"; done
}
`;
async function dry(run){
  const tags=await run.command('git',['tag','-l','rehearsal-*']);
  if(tags)throw new Error('REHEARSAL_SOURCE_TAGS_PRESENT');
  await run.inside(lifecyclePrelude+String.raw`
export GIT_DIR=/srv/unai.git GIT_INDEX_FILE=${state}/upgrade.index
trap 'rm -f "$GIT_INDEX_FILE"' EXIT
test ! -e "$GIT_INDEX_FILE"
git read-tree rehearsal-a
blob=$(printf 'Disposable rehearsal marker\n' | git hash-object -w --stdin)
git update-index --add --cacheinfo "100644,$blob,rehearsal-b.txt"
tree=$(git write-tree)
commit=$(printf 'Disposable second release\n' | git -c user.name=rehearsal -c user.email=rehearsal@example.invalid commit-tree "$tree" -p rehearsal-a)
git tag rehearsal-b "$commit"
test "$(git rev-list --count rehearsal-a..rehearsal-b)" = 1
${host} registry`);
  await runPhase(run,`${upgradePrelude}\n${upgradeSnapshot}
upgrade_snapshot > ${state}/before
bash deploy/upgrade.sh "\${args[@]}" --dry-run < /dev/null > ${state}/upgrade-output 2>&1
upgrade_snapshot > ${state}/after
${host} dry`);
  if(run.phase.assertions.registry.unverified)run.record.unverified.push({layer:'Registry re-pin',reason:run.phase.assertions.registry.unverified});
}
const observedUpgrade=String.raw`
: > /run/unai-rehearsal-observed
chmod 0600 /run/unai-rehearsal-observed
mark ${state}/lifecycle.cursor
status=0
PATH=/usr/local/lib/unai-rehearsal/observer:$PATH bash deploy/upgrade.sh "${'${args[@]}'}" < /dev/null > ${state}/upgrade-output 2>&1 || status=$?
echo "$status" > ${state}/upgrade-exit
`;
const restored=String.raw`
until_ok 120 ready 9101
until_ok 120 ready 9102
systemctl is-active --quiet unai-api.service unai-worker.service
echo ready > ${state}/ready
systemctl is-active --quiet unai-backup.timer unai-restore-drill.timer
echo active > ${state}/timers
`;
async function rollback(run){
  run.record.unverified.push(
    {layer:'Upgrade observer',reason:'Rehearsal-only systemd-run wrapper preserves argv and exit; only check stdout is retained in its root-only log.'},
    {layer:'Web system trust',reason:'Self-signed rehearsal web certificate installed in the disposable system trust store.'},
    {layer:'Transient preflight trust',reason:'Rehearsal-only prefix drop-in trusts stand-ins in anonymous transient checks.'});
  await run.inside(lifecyclePrelude+String.raw`
install -d -m 0700 /usr/local/lib/unai-rehearsal/observer
node ${tool}/lifecycle-tool.mjs observer /usr/bin/systemd-run /run/unai-rehearsal-observed > /usr/local/lib/unai-rehearsal/observer/systemd-run
chmod 0700 /usr/local/lib/unai-rehearsal/observer/systemd-run
install -m 0644 "$web_cert" /usr/local/share/ca-certificates/unai-rehearsal-web.crt
update-ca-certificates
install -d -m 0755 /etc/systemd/system/run-.service.d
printf '[Service]\nEnvironment=NODE_EXTRA_CA_CERTS=/etc/unai/rehearsal/ca-bundle.pem\n' > /etc/systemd/system/run-.service.d/rehearsal.conf
chmod 0644 /etc/systemd/system/run-.service.d/rehearsal.conf
systemctl daemon-reload`);
  await runPhase(run,`${upgradePrelude}\n${upgradeSnapshot}
systemctl is-active --quiet unai-backup.timer unai-restore-drill.timer
protected_snapshot > ${state}/before
staging=/var/lib/postgresql/unai-backup-staging
test -z "$(ls -A "$staging")"
cleanup_injection(){ rm -f "$staging/rehearsal-blocker"; test -z "$(ls -A "$staging")"; }
trap cleanup_injection EXIT
touch "$staging/rehearsal-blocker"
${observedUpgrade}
${restored}
protected_snapshot > ${state}/after
${host} rollback`,1200000);
}
async function upgrade(run){
  await runPhase(run,`${upgradePrelude}
${host} before-upgrade
cache(){ find /root/.cache/node/corepack -printf '%P %s\\n' | LC_ALL=C sort | sha256sum; }
cache > ${state}/cache-before
backup_trigger=$(systemctl show -p LastTriggerUSec --value unai-backup.timer)
drill_trigger=$(systemctl show -p LastTriggerUSec --value unai-restore-drill.timer)
${observedUpgrade}
test "$status" = 0
${restored}
systemd-run --wait --pipe --quiet --collect --working-directory=/opt/unai/current --property=EnvironmentFile=/etc/unai/migrate.env \\
 --setenv=PGPASSFILE=/root/.pgpass --setenv=HOME=/root --setenv=COREPACK_ENABLE_NETWORK=0 /usr/local/bin/pnpm --version > ${state}/offline-version
cache > ${state}/cache-after
sleep 60
until_ok 600 idle
${restored}
backup_fired=false; drill_fired=false
if [ "$backup_trigger" != "$(systemctl show -p LastTriggerUSec --value unai-backup.timer)" ]; then backup_fired=true; fi
if [ "$drill_trigger" != "$(systemctl show -p LastTriggerUSec --value unai-restore-drill.timer)" ]; then drill_fired=true; fi
printf '{"backup":%s,"restore-drill":%s}\\n' "$backup_fired" "$drill_fired" > ${state}/timer-triggers
curl -fsS --max-time 5 http://127.0.0.1:9101/readyz > ${state}/api-ready
curl -fsS --max-time 5 http://127.0.0.1:9102/readyz > ${state}/worker-ready
curl -fsS --max-time 10 -o /dev/null -w '%{http_code}' --resolve "$web_host:443:127.0.0.1" --cacert "$web_cert" "https://$web_host/signin" > ${state}/signin-status
${host} upgrade`,1200000);
  const result=run.phase.assertions;
  for(const name of ['api','web','worker'])requirePreflight(name,result[`${name}Checks`].map(row=>JSON.stringify(row)).join('\n'));
  probeVerdict(JSON.stringify(result.apiReady),'api');probeVerdict(JSON.stringify(result.workerReady),'worker');
}
export const lifecyclePhases={backup,'restore-drill':drill,'upgrade-dry-run':dry,'upgrade-rollback':rollback,upgrade};
