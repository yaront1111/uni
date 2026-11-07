// Rehearsal 2/4: services, probes, smoke and failed-start, all inside the disposable host.
// Hostnames, ids and paths are read from the env files by the in-host shell, so the driver's
// command text holds variable names, never values. Only `@@name` reports of status words,
// counts and product JSON lines cross back, and ../lib/rehearsal-checks.mjs judges them.
import {fileURLToPath} from 'node:url';
import {report,count,listeningVerdict,checksPassed,probeVerdict,webVerdict,plainHttpVerdict,burstVerdict,
  checkFailVerdict,startupFailedVerdict} from '../lib/rehearsal-checks.mjs';

export const tool='/usr/local/lib/unai-rehearsal';
export const state='/root/rehearsal';
export const active='systemctl is-active --quiet unai-rehearsal-s3-evidence unai-rehearsal-s3-backup unai-rehearsal-s3-drill';
const fail=code=>{throw new Error(`REHEARSAL_${code}`);};
// Each seam mode runs as a transient unit with its own fixed description, so the sync phase's leak
// probe can require both units' `Started <unit> - <word>.` lines in the journal it searches.
export const SEAM_WORDS={check:'rehearsal-owner-check',session:'rehearsal-session-mint'};
// Shell helpers. String.raw keeps every backslash; the seam words are the only interpolations.
export const prelude=String.raw`
envval(){ sed -n "s#^$2=##p" "/etc/unai/$1.env" | tail -n 1; }
mark(){ rm -f "$1"; journalctl -q -n 1 -o cat --no-pager --cursor-file="$1" >/dev/null; test -s "$1"; }
since(){ local cursor; cursor=$(cat "$1"); shift; journalctl -q --no-pager -o cat --after-cursor="$cursor" "$@" || true; }
seen(){ since "$1" -u "$2" | grep -E "$3" >/dev/null; }
until_ok(){ local deadline=$((SECONDS+$1)); shift; until "$@" >/dev/null 2>&1; do [ "$SECONDS" -lt "$deadline" ] || return 1; sleep 0.5; done; }
ready(){ curl -fsS --max-time 5 -o /dev/null "http://127.0.0.1:$1/readyz"; }
mono(){ /usr/local/bin/node -p 'String(process.hrtime.bigint()/1000n)'; }
started(){ systemctl show -p InactiveExitTimestampMonotonic --value "$1"; }
flag(){ if "$@"; then echo 1; else echo 0; fi; }
web_host=$(envval web NEXTAUTH_URL | sed -n 's#^https://\([a-z0-9.-]*\)$#\1#p')
web_cert=$(envval web UNAI_WEB_TLS_CERT_FILE)
test -n "$web_host"; test -n "$web_cert"
signin(){ curl -fsS --max-time 10 -o /dev/null --resolve "$web_host:443:127.0.0.1" --cacert "$web_cert" "https://$web_host/signin"; }
seam(){
  local word subject scope actor
  case "$1" in check) word=${SEAM_WORDS.check};; session) word=${SEAM_WORDS.session};; *) return 2;; esac
  subject=$(envval web UNAI_WEB_OWNER_GOOGLE_SUBJECT); scope=$(envval worker UNAI_PROCESSING_OWNER_SCOPE_ID); actor=$(envval worker UNAI_PROCESSING_ACTOR_ID)
  printf '%s\n%s\n%s\n%s\n' "$1" "$subject" "$scope" "$actor" | systemd-run --wait --pipe --quiet --uid=unai-web --gid=unai-web \
    --working-directory=/opt/unai/current/apps/web --property=EnvironmentFile=/etc/unai/web.env --setenv=NODE_ENV=production \
    --description="$word" /usr/local/bin/node --import tsx --input-type=module -e "$(cat /usr/local/lib/unai-rehearsal/auth-seam.mjs)"
}
`;
const uuid='[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
/** On failure only: the unit's last journal lines, ids removed here and scrubbed again by the driver. */
export const journalTail=unit=>`if [ "$code" != 0 ]; then echo @@journal; journalctl -u ${unit} -n 12 -o cat --no-pager 2>/dev/null | sed -E 's/${uuid}/[REDACTED]/g' || true; fi`;
// The trailing echo ends a file without a final newline (curl bodies), so the next header stays on its own line.
export const show=(...names)=>names.map(name=>`echo @@${name}; cat ${state}/${name} 2>/dev/null || true; echo`).join('\n');
const checkLine=String.raw`'^\{"check":"[a-z_]+","status":"(ok|warn|fail)","code":"[A-Z][A-Z0-9_]*(:[A-Z0-9_]+)?"\}$'`;
export function preflight(name,extra=''){
  const web=name==='web',entry=web?'server.ts':`packages/api/src/${name==='api'?'server':'processing-worker'}.ts`;
  const aws=web?'':`--setenv=AWS_SHARED_CREDENTIALS_FILE=/etc/unai/secrets/${name}/aws/credentials --setenv=AWS_EC2_METADATA_DISABLED=true --setenv=NODE_EXTRA_CA_CERTS=/etc/unai/rehearsal/ca-bundle.pem`;
  return `systemd-run --wait --pipe --quiet --uid=unai-${name} --gid=unai-${name} --working-directory=/opt/unai/current${web?'/apps/web':''} --property=EnvironmentFile=/etc/unai/${name}.env --setenv=NODE_ENV=production ${aws} ${extra} /usr/local/bin/node --import tsx ${entry} --check`;
}
const inside=(run,script,options)=>run.inside(`${active}\n${prelude}\n${script}`,options);
const seamFile=fileURLToPath(new URL('auth-seam.mjs',import.meta.url));

async function startApi(run){
  const output=await inside(run,String.raw`
mark ${state}/api.cursor
start=$SECONDS
systemctl enable --now unai-api.service
until_ok 120 ready 9101
echo $((SECONDS-start)) > ${state}/api-ready-seconds
mono > ${state}/api-ready-mono
listening(){ since ${state}/api.cursor -u unai-api.service | grep -F '"event":"listening"' >/dev/null; }
until_ok 30 listening
since ${state}/api.cursor -u unai-api.service | grep -F '"event":"listening"' > ${state}/api-listening || true`,
  {timeout:300000,report:`${show('api-ready-seconds','api-listening')}\n${journalTail('unai-api')}`});
  const parsed=report(output,['api-ready-seconds','api-listening']);
  return {apiReadySeconds:count(parsed['api-ready-seconds']),listening:listeningVerdict(parsed['api-listening'],3443)};
}
async function restartWeb(run){
  const checks=report(await inside(run,`${preflight('web')} > ${state}/web-check 2>&1`,
    {report:`echo @@web-check; grep -E ${checkLine} ${state}/web-check || true`}),['web-check']);
  const webChecks=checksPassed(checks['web-check'],['rate_limits','origin','tls_certificate','auth','api']);
  // The web already runs since 1/4's renewal hook: it must restart after the API is ready.
  const output=await inside(run,String.raw`
old=$(systemctl show -p InvocationID --value unai-web.service)
systemctl enable unai-web.service
systemctl restart unai-web.service
until_ok 120 signin
new=$(systemctl show -p InvocationID --value unai-web.service)
flag test -n "$new" -a "$new" != "$old" > ${state}/web-invocation-changed
flag test "$(started unai-web.service)" -gt "$(cat ${state}/api-ready-mono)" > ${state}/web-after-api`,
  {timeout:300000,report:`${show('web-invocation-changed','web-after-api')}\n${journalTail('unai-web')}`});
  const parsed=report(output,['web-invocation-changed','web-after-api']);
  return {webChecks,webInvocationChanged:parsed['web-invocation-changed']==='1',webRestartedAfterApiReady:parsed['web-after-api']==='1'};
}
async function startWorker(run){
  const output=await inside(run,String.raw`
${preflight('worker')} > ${state}/worker-check 2>&1
start=$SECONDS
systemctl enable --now unai-worker.service
until_ok 120 ready 9102
echo $((SECONDS-start)) > ${state}/worker-ready-seconds
w=$(started unai-worker.service)
flag test "$w" -gt "$(started unai-api.service)" -a "$w" -gt "$(started unai-web.service)" > ${state}/worker-last`,
  {timeout:300000,report:`${show('worker-ready-seconds','worker-last')}\n${journalTail('unai-worker')}`});
  const parsed=report(output,['worker-ready-seconds','worker-last']);
  return {workerReadySeconds:count(parsed['worker-ready-seconds']),workerStartedLast:parsed['worker-last']==='1'};
}
async function services(run){
  await run.command('docker',['cp',seamFile,`${run.container}:${tool}/auth-seam.mjs`]);
  const owner=report(await inside(run,`seam check > ${state}/owner-word`,{report:show('owner-word')}),['owner-word']);
  if(owner['owner-word']!=='FOUND')fail('OWNER_UNRESOLVED');
  const assertions={adapterResolvesOwner:true,...await startApi(run),...await restartWeb(run),...await startWorker(run)};
  run.phase.assertions=assertions;
  if(!assertions.webInvocationChanged||!assertions.webRestartedAfterApiReady||!assertions.workerStartedLast)fail('SERVICE_ORDER_INVALID');
}
async function probes(run){
  const names=[['api-healthz',9101,'healthz','healthz'],['api-readyz',9101,'readyz','api'],
    ['worker-healthz',9102,'healthz','healthz'],['worker-readyz',9102,'readyz','worker']];
  const parsed=report(await inside(run,names.map(([name,port,path])=>`curl -fsS --max-time 5 http://127.0.0.1:${port}/${path} > ${state}/${name}`).join('\n'),
    {report:show(...names.map(([name])=>name))}),names.map(([name])=>name));
  const body=name=>probeVerdict(parsed[name],names.find(entry=>entry[0]===name)[3]);
  run.phase.assertions={api:{healthz:body('api-healthz'),readyz:body('api-readyz')},worker:{healthz:body('worker-healthz'),readyz:body('worker-readyz')}};
}
// The burst runs last: the API limiter is in-process, so failed-start's restart clears it.
const smokeScript=String.raw`
web(){ curl -sS --max-time 10 -D - -o /dev/null --resolve "$web_host:443:127.0.0.1" --cacert "$web_cert" "https://$web_host$1" | tr -d '\r' \
  | grep -iE '^(HTTP/|content-security-policy:|permissions-policy:|strict-transport-security:|location:)' \
  | sed -E "s#'nonce-[A-Za-z0-9+/=_-]{16,}'#'nonce-[REDACTED]'#g"; }
web / > ${state}/web-root
web /signin > ${state}/web-signin
api_origin=$(envval web UNAI_API_ORIGIN); api_ca=$(envval web UNAI_API_CA_FILE)
api_address=$(printf '%s' "$api_origin" | sed -n 's#^https://\([^/]*\)$#\1#p')
test -n "$api_address"; test -n "$api_ca"
set +e
curl -sS -i --max-time 10 "http://$api_address/v1/devices" > ${state}/plain-response 2>&1
echo $? > ${state}/plain-exit
set -e
grep -E '^HTTP/' ${state}/plain-response > ${state}/plain-http || true
limit=$(envval api UNAI_API_AUTH_FAILURE_RATE_LIMIT_PER_MINUTE)
[ -n "$limit" ] || limit=30
echo "$limit" > ${state}/burst-limit
second=$(date +%S); second=$((10#$second))
if [ "$second" -gt 45 ]; then sleep $((61-second)); fi
: > ${state}/burst
i=0
while [ "$i" -lt $((2*limit+2)) ]; do
  i=$((i+1))
  status=$(curl -sS --max-time 10 -D ${state}/burst-head -o ${state}/burst-body -w '%{http_code}' --cacert "$api_ca" "$api_origin/v1/devices")
  tr -d '\r' < ${state}/burst-head > ${state}/burst-head-lf
  retry=$(sed -n 's/^[Rr]etry-[Aa]fter: *\([0-9]*\)$/\1/p' ${state}/burst-head-lf | tail -n 1)
  bucket=$(sed -n 's/^[Xx]-[Rr]ate-[Ll]imit-[Bb]ucket: *\([a-z]*\)$/\1/p' ${state}/burst-head-lf | tail -n 1)
  body=$(sed -n 's/.*"code":"\([A-Z_]*\)".*/\1/p' ${state}/burst-body | tail -n 1)
  hsts=$(flag grep -iqE '^strict-transport-security: *max-age=31536000([; ]|$)' ${state}/burst-head-lf)
  [ -n "$retry" ] || retry=-; [ -n "$bucket" ] || bucket=-; [ -n "$body" ] || body=-
  printf '%s %s %s %s %s\n' "$status" "$retry" "$bucket" "$body" "$hsts" >> ${state}/burst
  [ "$status" != 429 ] || break
done`;
async function smoke(run){
  const names=['web-root','web-signin','plain-exit','plain-http','burst-limit','burst'];
  const parsed=report(await inside(run,smokeScript,{timeout:300000,report:show(...names)}),names);
  run.phase.assertions={web:{root:webVerdict(parsed['web-root'],'/'),signin:webVerdict(parsed['web-signin'],'/signin')},
    plainHttp:plainHttpVerdict(count(parsed['plain-exit']),parsed['plain-http']),
    burst:burstVerdict(parsed.burst,count(parsed['burst-limit']))};
  // burstVerdict proved every request before the 429 was a 401 AUTHENTICATION_REQUIRED with HSTS.
  run.phase.assertions.unauthenticated={status:401,code:'AUTHENTICATION_REQUIRED',hsts:true};
}
// One required variable per unit (docs/operations/environment.md: CONFIG_REQUIRED:<NAME>).
export const FAILED_START=[['api','UNAI_API_TLS_CERT_FILE','until_ok 120 ready 9101'],
  ['web','UNAI_WEB_TLS_CERT_FILE','until_ok 120 signin'],['worker','UNAI_PROCESSING_OWNER_SCOPE_ID','until_ok 120 ready 9102']];
export function failedStartScript(name,variable,wait){
  const unit=`unai-${name}.service`,dir=`/run/systemd/system/${unit}.d`,dropIn=`${dir}/50-rehearsal.conf`,copy=`/run/unai-rehearsal/${name}.env`;
  const refusal=name==='worker'?'"event":"startup_failed"':'"status":"fail"';
  // (a) the shipped ExecStartPre --check refuses; (b) with it cleared, the process itself
  // fails once (Restart=no); (c) the shipped configuration comes back and is ready again.
  // Cursor scoping keeps only lines after each restart, as InvocationID matching would.
  return String.raw`
rm -f ${state}/failed-*
test "$(grep -c '^${variable}=' /etc/unai/${name}.env)" = 1
install -d -m 0700 /run/unai-rehearsal
grep -v '^${variable}=' /etc/unai/${name}.env > ${copy}
install -d -m 0755 ${dir}
printf '[Service]\nEnvironmentFile=\nEnvironmentFile=${copy}\nRestart=no\n' > ${dropIn}
chmod 0644 ${dropIn}
systemctl daemon-reload
mark ${state}/failed-a.cursor
if systemctl restart ${unit}; then exit 1; fi
until_ok 30 seen ${state}/failed-a.cursor ${unit} '${refusal}'
since ${state}/failed-a.cursor -u ${unit} > ${state}/failed-a
printf 'ExecStartPre=\n' >> ${dropIn}
systemctl daemon-reload
systemctl reset-failed ${unit}
mark ${state}/failed-b.cursor
systemctl restart ${unit} || true
until_ok 120 systemctl is-failed --quiet ${unit}
until_ok 30 seen ${state}/failed-b.cursor ${unit} '"event":"startup_failed"'
since ${state}/failed-b.cursor -u ${unit} > ${state}/failed-b
grep -cE '^\s+at ' ${state}/failed-b > ${state}/failed-frames || true
systemctl show -p ExecMainStatus --value ${unit} > ${state}/failed-status
rm -f ${dropIn} ${copy}
rmdir --ignore-fail-on-non-empty ${dir}
systemctl daemon-reload
systemctl reset-failed ${unit}
systemctl restart ${unit}
${wait}
systemctl is-active --quiet ${unit}
echo 1 > ${state}/failed-restored`;
}
async function failedStart(run){
  const units=[];
  for(const [name,variable,wait] of FAILED_START){
    const unit=`unai-${name}`,grep=name==='worker'?`grep -F '"event":"startup_failed"'`:`grep -E ${checkLine}`;
    const output=await inside(run,failedStartScript(name,variable,wait),{timeout:600000,report:[
      `echo @@refusal; ${grep} ${state}/failed-a 2>/dev/null || true`,
      `echo @@startup; grep -F '"event":"startup_failed"' ${state}/failed-b 2>/dev/null || true`,
      show('failed-frames','failed-status','failed-restored'),journalTail(unit)].join('\n')});
    const parsed=report(output,['refusal','startup','failed-frames','failed-status','failed-restored']);
    const preflightRefusal=name==='worker'?startupFailedVerdict(parsed.refusal,0,unit,variable):checkFailVerdict(parsed.refusal,variable);
    const startupFailed=startupFailedVerdict(parsed.startup,count(parsed['failed-frames']),unit,variable);
    const exitStatus=count(parsed['failed-status']);
    if(exitStatus!==1||parsed['failed-restored']!=='1')fail('FAILED_START_INVALID');
    units.push({unit,variable,preflightRefusal,startupFailed,exitStatus,restored:true});
  }
  run.phase.assertions={units};
}
export const servicePhases={services,probes,smoke,'failed-start':failedStart};
