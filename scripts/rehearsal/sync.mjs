// Rehearsal 2/4 sync: one scheduler-enqueued connector.sync, completed by the running
// unai-worker against the recorded GitHub double (./github-double.mjs). Tokens, ids and
// hostnames stay in root-only files inside the host; only counts, status words and the
// double's route lines cross back, and ../lib/rehearsal-checks.mjs judges them.
import {writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {report,count,syncVerdict,doubleCounts,schedulerPasses,leakVerdict} from '../lib/rehearsal-checks.mjs';
import {tool,state,active,prelude,show,journalTail,SEAM_WORDS} from './services.mjs';

const fail=code=>{throw new Error(`REHEARSAL_${code}`);};
const inside=(run,script,options)=>run.inside(`${active}\n${prelude}\n${script}`,options);
const github='/etc/unai/rehearsal/github';
// The product web listens on 0.0.0.0:443, which holds port 443 on every local IPv4 address, and the
// image has no nft or iptables to redirect. So the double gets its own network namespace, reached over
// a veth pair in 198.18.0.0/30 (RFC 2544 benchmarking space, never routed), and dies with the host.
export const NAMESPACE='rehearsal-github',DOUBLE_ADDRESS='198.18.0.2';
const local=name=>fileURLToPath(new URL(name,import.meta.url));
// deploy/README.md names connector tokens connectors/<name>, but the shipped connectors.secret_ref
// check (migration 0018) refuses the slash and the API answers 500, so this run uses a flat name.
const SECRET_NAME='connectors-github';
const finding={id:'connector-secret-ref-slash',area:'sync',verdict:'FILED',taskId:'task-43a9ecba94a348aaa4d050e7920ec14a',
  note:'The shipped connectors.secret_ref check (migration 0018) refuses the slash in the deploy/README.md handle secret://mounted/connectors/<name>, so POST /v1/connectors answers 500 INTERNAL_ERROR; this run names the token connectors-github.'};
// The scheduler interval is the shipped default (UNAI_CONNECTOR_SYNC_INTERVAL_MS unset):
// GITHUB windows are 900 s. The whole trigger must fit inside one window, or a boundary pass
// would enqueue the next window's job, so a start closer than 420 s to it waits past it.
export const WINDOW_MS=900000,WINDOW_BUDGET_MS=420000;

// (a) the double, (b) its CA in 1/4's NODE_EXTRA_CA_CERTS bundle, (c) the token behind a
// secret:// handle. The CA subject differs from the S3 stand-ins' (scripts/CLAUDE.md).
export const doubleScript=String.raw`
install -d -m 0755 ${github}
cd ${github}
printf '[req]\ndistinguished_name=dn\n[dn]\n[ca]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\n[leaf]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:api.github.com\nauthorityKeyIdentifier=keyid\n' > openssl.cnf
openssl req -x509 -config openssl.cnf -extensions ca -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -keyout ca.key -out ca.pem -days 1 -subj /CN=rehearsal-github-ca
openssl req -new -config openssl.cnf -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -keyout leaf.key -out leaf.csr -subj /CN=api.github.com
openssl x509 -req -in leaf.csr -CA ca.pem -CAkey ca.key -CAcreateserial -days 1 -extfile openssl.cnf -extensions leaf -out leaf.pem
openssl verify -CAfile ca.pem leaf.pem
rm -f ca.key ca.srl leaf.csr
chmod 0600 leaf.key; chmod 0644 ca.pem leaf.pem
test "$(grep -c 'BEGIN CERTIFICATE' /etc/unai/rehearsal/ca-bundle.pem)" = 3
cat ca.pem >> /etc/unai/rehearsal/ca-bundle.pem
ip netns add ${NAMESPACE}
ip link add rehearsal-gh0 type veth peer name rehearsal-gh1 netns ${NAMESPACE}
ip addr add 198.18.0.1/30 dev rehearsal-gh0
ip link set rehearsal-gh0 up
ip -n ${NAMESPACE} addr add ${DOUBLE_ADDRESS}/30 dev rehearsal-gh1
ip -n ${NAMESPACE} link set rehearsal-gh1 up
ip -n ${NAMESPACE} link set lo up
printf '${DOUBLE_ADDRESS} api.github.com\n' >> /etc/hosts
test "$(getent hosts api.github.com | awk '{print $1}')" = ${DOUBLE_ADDRESS}
openssl rand -hex 24 > ${state}/github-token
cd /opt/unai/current
UNAI_SECRETS_MOUNT=/etc/unai/secrets/api /usr/local/bin/pnpm secret:put ${SECRET_NAME} < ${state}/github-token > /dev/null
chown root:unai-api /etc/unai/secrets/api/${SECRET_NAME}; chmod 0640 /etc/unai/secrets/api/${SECRET_NAME}
install -o root -g unai-worker -m 0640 /etc/unai/secrets/api/${SECRET_NAME} /etc/unai/secrets/worker/${SECRET_NAME}
systemd-run --unit=rehearsal-github-double --property=Restart=no --property=NetworkNamespacePath=/run/netns/${NAMESPACE} /usr/local/bin/node ${tool}/github-double.mjs ${github}/leaf.pem ${github}/leaf.key ${tool}/github-issue-thread.json ${state}/github-token ${DOUBLE_ADDRESS}
probe(){ test "$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 --cacert /etc/unai/rehearsal/ca-bundle.pem https://api.github.com/rehearsal-probe)" = 404; }
until_ok 30 probe`;

// (d) a session through the product adapter, (e) the connector through the API, (f) a worker
// restart whose first scheduler pass enqueues, then a second restart in the same window.
const settledSql=`SELECT count(*) > 0 AND bool_and(status IN ('SUCCEEDED','DEAD_LETTER')) FROM jobs WHERE job_kind = 'connector.sync' AND payload->>'connectorId' = :'id';`;
const rowSql=String.raw`WITH j AS (SELECT * FROM jobs WHERE job_kind = 'connector.sync' AND payload->>'connectorId' = :'id')
SELECT json_build_object('jobs', (SELECT count(*) FROM j), 'status', (SELECT string_agg(status, ' ') FROM j),
  'scheduled', (SELECT bool_and(payload->>'mode' = 'INCREMENTAL' AND payload->>'window' ~ '^[0-9]+$'
    AND idempotency_key = 'connector_sync_' || :'id' || '_INCREMENTAL_' || (payload->>'window')) FROM j),
  'attempts', (SELECT max(attempt_count) FROM j), 'jobErrorClear', (SELECT bool_and(last_error IS NULL) FROM j),
  'lastError', (SELECT max(last_error) FROM j),
  'evidence', (SELECT count(*) FROM source_items s WHERE s.connector_id = c.id),
  'connectorType', c.connector_type, 'connectorStatus', c.status,
  'cursorAdvanced', c.last_cursor IS NOT NULL AND c.cursor_updated_at IS NOT NULL,
  'cursorPage', CASE WHEN c.last_cursor->>'providerToken' ~ '^[0-9]{1,6}$' THEN (c.last_cursor->>'providerToken')::int END,
  'syncErrorClear', c.last_sync_error IS NULL, 'syncError', c.last_sync_error)
FROM connectors c WHERE c.id = (:'id')::uuid;`;
export const syncScript=String.raw`
test -z "$(envval worker UNAI_CONNECTOR_SYNC_INTERVAL_MS)"
left=$((${WINDOW_MS} - $(date +%s%3N) % ${WINDOW_MS}))
if [ "$left" -lt ${WINDOW_BUDGET_MS} ]; then sleep $((left / 1000 + 2)); fi
seam session > ${state}/session-token
grep -Eqx '[A-Za-z0-9_-]{43}' ${state}/session-token
api_origin=$(envval web UNAI_API_ORIGIN); api_ca=$(envval web UNAI_API_CA_FILE); scope=$(envval worker UNAI_PROCESSING_OWNER_SCOPE_ID)
test -n "$api_origin"; test -n "$api_ca"; test -n "$scope"
{
  printf 'cookie: __Host-unai.session=%s\n' "$(cat ${state}/session-token)"
  printf 'x-owner-scope-id: %s\nx-purpose: connector.manage\n' "$scope"
  printf 'x-correlation-id: %s\n' "$(cat /proc/sys/kernel/random/uuid)"
  printf 'idempotency-key: rehearsal-connector-%s\ncontent-type: application/json\n' "$(openssl rand -hex 8)"
} > ${state}/connector-headers
printf '%s' '{"connectorType":"GITHUB","externalAccountRef":"example-org/uai-reference","secretRef":"secret://mounted/${SECRET_NAME}","requestedCapabilities":[{"capabilityId":"github.read_issues","granted":true}]}' > ${state}/connector-body
curl -sS --max-time 30 -o ${state}/connector-response -w '%{http_code}' --cacert "$api_ca" -H @${state}/connector-headers --data-binary @${state}/connector-body "$api_origin/v1/connectors" > ${state}/connector-status
test "$(cat ${state}/connector-status)" = 201
/usr/local/bin/node -e 'const fs=require("fs");const id=JSON.parse(fs.readFileSync(process.argv[1],"utf8")).connectorId;if(!/^[0-9a-f-]{36}$/.test(id))process.exit(1);fs.writeFileSync(process.argv[2],id)' ${state}/connector-response ${state}/connector-id
id=$(cat ${state}/connector-id)
cat > ${state}/settled.sql <<'SQL'
${settledSql}
SQL
cat > ${state}/row.sql <<'SQL'
${rowSql}
SQL
sql(){ sudo -u postgres psql -X -d unai -At -v ON_ERROR_STOP=1 -v id="$id" -f - < "$1"; }
settled(){ test "$(sql ${state}/settled.sql)" = t; }
scheduled(){ since "$1" -u unai-worker.service | grep -F '"event":"connector.scheduler"' >/dev/null; }
mark ${state}/sync-a.cursor
systemctl restart unai-worker.service
until_ok 120 ready 9102
until_ok 60 scheduled ${state}/sync-a.cursor
# A job that never settles is still reported: the row says which state it stopped in.
until_ok 180 settled || true
mark ${state}/sync-b.cursor
systemctl restart unai-worker.service
until_ok 120 ready 9102
until_ok 60 scheduled ${state}/sync-b.cursor
{ since ${state}/sync-a.cursor -u unai-worker.service | grep -F '"event":"connector.scheduler"' || true; } > ${state}/scheduler-lines
sql ${state}/row.sql > ${state}/sync-row
{ journalctl -q -u rehearsal-github-double -o cat --no-pager | grep -F '"event":"github.double"' || true; } > ${state}/double-lines`;

// (h) Neither token anywhere in the journal (every field of every entry, _CMDLINE included), a
// data-only dump of the database, or the record so far. Both tokens go into one root-only needle
// file. grep's status is read, never dropped: 1 is no match, 0 a match, anything else fails the
// phase. Each seam unit's Started line and a _CMDLINE field must be in the same capture before
// anything is counted, so an empty or partial capture cannot pass (leakVerdict reads the lines);
// the dump must hold this run's connector row and the copy must be the record, or a zero proves nothing.
export const leakScript=String.raw`
umask 077
needles=${state}/leak-needles capture=${state}/leak-journal dump=${state}/leak-database leaks=${state}/leaks
trap 'rm -f "$needles" "$capture" "$dump" ${state}/record-copy.json' EXIT
hits(){ local n status=0; n=$(grep -a -c "$@") || status=$?; case "$status:$n" in 0:[1-9]*|1:0) echo "$n";; *) return 2;; esac; }
control(){ local n; n=$(hits -E "$2" "$capture"); echo "$1 $n" >> "$leaks"; test "$n" -ge 1; }
search(){ local n; n=$(hits -F -f "$needles" "$2"); echo "$1 $n" >> "$leaks"; }
{ tr -d '[:space:]' < ${state}/github-token; echo; tr -d '[:space:]' < ${state}/session-token; echo; } > "$needles"
awk 'NR==1{ok=length($0)==48&&$0~/^[0-9a-f]+$/} NR==2{ok=ok&&length($0)==43&&$0~/^[A-Za-z0-9_-]+$/} END{if(!ok||NR!=2)exit 1;print "needles",NR}' "$needles" > "$leaks"
journalctl --sync
journalctl -o export --no-pager > "$capture"
sudo -u postgres pg_dump -d unai --data-only > "$dump"
for file in "$needles" "$capture" "$dump"; do test "$(stat -c %a "$file")" = 600; done
control owner-check '^MESSAGE=Started [^ ]+ - ${SEAM_WORDS.check}\.$'
control session-mint '^MESSAGE=Started [^ ]+ - ${SEAM_WORDS.session}\.$'
control cmdline '^_CMDLINE='
search journal "$capture"
search database "$dump"
search record ${state}/record-copy.json
grep -q -F 'secret://mounted/${SECRET_NAME}' "$dump"; grep -q '^{"format":"unai-deploy-rehearsal/1"' ${state}/record-copy.json`;

const CODE=/^[A-Z][A-Z0-9_]*(?::[A-Z][A-Z0-9_]*)?$/;
/** On a refused sync, the job and connector state as status words, so the record says why. */
export function syncDiagnostic(row){
  const word=value=>value===null||value===undefined?null:typeof value==='string'&&CODE.test(value)&&/[G-Z]/.test(value)?value:'UNREADABLE';
  return {jobs:Number.isSafeInteger(row?.jobs)?row.jobs:null,status:word(row?.status),lastError:word(row?.lastError),
    syncError:word(row?.syncError),connectorStatus:word(row?.connectorStatus)};
}
async function sync(run){
  (run.record.findings??=[]).push({...finding});
  run.record.unverified.push({layer:'GitHub provider',
    reason:'A recorded double in a transient host unit with its own network namespace, behind a rehearsal-only CA and hosts entry, answers the sync; no GitHub account or sidecar container.'});
  await run.command('docker',['cp',local('github-double.mjs'),`${run.container}:${tool}/github-double.mjs`]);
  await run.command('docker',['cp',local('../../fixtures/sources/github-issue-thread.json'),`${run.container}:${tool}/github-issue-thread.json`]);
  await inside(run,doubleScript,{timeout:300000,report:journalTail('rehearsal-github-double')});
  const names=['connector-status','scheduler-lines','sync-row','double-lines'];
  const parsed=report(await inside(run,syncScript,{timeout:1200000,
    report:`${show(...names)}\n${journalTail('unai-worker')}`}),names);
  let row;try{row=JSON.parse(parsed['sync-row']);}catch{fail('SYNC_INVALID');}
  const passes=schedulerPasses(parsed['scheduler-lines']);
  run.phase.assertions={connector:{status:count(parsed['connector-status'])},diagnostic:syncDiagnostic(row)};
  const verdict=syncVerdict({...row,...doubleCounts(parsed['double-lines'])});
  if(passes.length!==2||passes[0].enqueued<1)fail('SCHEDULER_LOG_INVALID');
  run.phase.assertions={...verdict,connector:{status:201},scheduler:{passes:2,firstPassEnqueued:passes[0].enqueued,restartKeptOneJob:true}};
  const copy=join(run.directory,'record-copy.json');
  try{
    await writeFile(copy,JSON.stringify(run.record),{mode:0o600});
    await run.command('docker',['cp',copy,`${run.container}:${state}/record-copy.json`]);
  }finally{await rm(copy,{force:true});}
  const leaks=report(await inside(run,leakScript,{timeout:300000,report:show('leaks')}),['leaks']);
  run.phase.assertions.secretLeaks=leakVerdict(leaks.leaks);
}
export const syncPhases={sync};
