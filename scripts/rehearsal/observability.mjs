import {fileURLToPath} from 'node:url';
import {prelude,tool,state,show} from './services.mjs';
import {report} from '../lib/rehearsal-checks.mjs';
const fail=code=>{throw new Error(`REHEARSAL_${code}`);};
const observe=`/usr/local/bin/node ${tool}/observe.mjs`;
const directory='/var/lib/otelcol/unai';
// TOFU pin from the Stable Chrome for Testing JSON, 2026-11-07. Download pattern:
// https://storage.googleapis.com/chrome-for-testing-public/<version>/linux64/chrome-headless-shell-linux64.zip
export const CHROME_VERSION='157.0.8103.38';
export const CHROME_SHA256='deafffa74660b34853a4119c361fd427ac8c9fcb62db51ddb8a797cd83a4ba2d';
export const browserProvisionScript=String.raw`
${prelude}
install -d -m 0700 /opt/unai-rehearsal/chrome
curl -fsSL --proto =https --tlsv1.2 --retry 3 'https://storage.googleapis.com/chrome-for-testing-public/${CHROME_VERSION}/linux64/chrome-headless-shell-linux64.zip' -o /opt/unai-rehearsal/chrome/archive.zip
printf '%s  %s\n' '${CHROME_SHA256}' /opt/unai-rehearsal/chrome/archive.zip | sha256sum --check --status
apt-get update -qq
# ldd on the pinned shell in the Ubuntu host identified these missing runtime libraries.
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends unzip libnss3-tools libglib2.0-0t64 libnspr4 libnss3 libatk1.0-0t64 libatk-bridge2.0-0t64 libdbus-1-3 libx11-6 libxcomposite1 libxdamage1 libxext6 libxfixes3 libxrandr2 libgbm1 libexpat1 libxcb1 libxkbcommon0 libasound2t64 libatspi2.0-0t64
unzip -q -o /opt/unai-rehearsal/chrome/archive.zip -d /opt/unai-rehearsal/chrome
chrome=/opt/unai-rehearsal/chrome/chrome-headless-shell-linux64/chrome-headless-shell
ldd "$chrome" > ${state}/chrome-libraries
if grep -q 'not found' ${state}/chrome-libraries; then exit 1; fi
home=$(mktemp -d /root/rehearsal/browser-home-XXXXXX)
trap 'rm -rf -- "$home"; rm -f ${state}/browser-token' EXIT
install -d -m 0700 "$home/.pki/nssdb"
certutil -N --empty-password -d "sql:$home/.pki/nssdb"
certutil -A -d "sql:$home/.pki/nssdb" -n rehearsal -t 'CP,,' -i "$web_cert"
seam session > ${state}/browser-token
chmod 0600 ${state}/browser-token
test -s ${state}/browser-token
`;
export const telemetryScript=String.raw`
${prelude}
for name in api web worker; do
  envfile=/etc/unai/$name.env
  test "$(grep -c '^UNAI_OTEL_EXPORTER_OTLP_ENDPOINT=' "$envfile")" = 1
  test "$(grep -cx 'UNAI_OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318' "$envfile")" = 1
  sed -i '/^UNAI_OTEL_METRIC_EXPORT_MS=/d' "$envfile"
  printf '\nUNAI_OTEL_METRIC_EXPORT_MS=5000\n' >> "$envfile"
  test "$(grep -c '^UNAI_OTEL_METRIC_EXPORT_MS=' "$envfile")" = 1
done
${observe} snapshot ${directory} ${state}/telemetry-offsets
systemctl restart unai-api
until_ok 120 ready 9101
systemctl restart unai-web
until_ok 120 signin
systemctl restart unai-worker
until_ok 120 ready 9102
ready 9101; ready 9102; signin
api_origin=$(envval web UNAI_API_ORIGIN); api_ca=$(envval web UNAI_API_CA_FILE)
test "$(curl -sS --max-time 10 -o /dev/null -w '%{http_code}' --cacert "$api_ca" "$api_origin/v1/devices")" = 401
${observe} otlp ${directory} ${state}/telemetry-offsets > ${state}/telemetry-receipt
`;
export function telemetryVerdict(value){
  const proof=value.installedByBundle;
  const counts=Object.entries(value.scopes??{});
  const validCounts=counts.length>0&&counts.every(([key,c])=>/^unai_(api|web|postgres|registry|jobs|pipeline)$/.test(key)&&
    [c.spans,c.points].every(n=>Number.isSafeInteger(n)&&n>=0)&&c.spans+c.points>0)&&
    counts.some(([,c])=>c.spans>0)&&counts.some(([,c])=>c.points>0);
  if(!proof||['versionMatches','configMatches','dropInPresent','active','loopbackOnly'].some(k=>proof[k]!==true)||
    ['nonUnaiScopes','nextScopes','httpTargetAttributes','invalidLines'].some(k=>value[k]!==0)||
    !Array.isArray(value.services)||value.services.join(',')!=='unai-api,unai-web,unai-worker'||
    !Array.isArray(value.missingServices)||value.missingServices.length||value.metricExportMs!==5000||
    !validCounts)fail('TELEMETRY_INVALID');
  return {...value,allUnaiPrefixed:true};
}
async function telemetry(run){
  await run.command('docker',['cp',fileURLToPath(new URL('observe.mjs',import.meta.url)),`${run.container}:${tool}/observe.mjs`]);
  run.record.unverified.push({layer:'metric interval',reason:'Rehearsal uses a five second metric export interval instead of the shipped default.'});
  const output=await run.inside(telemetryScript,{timeout:600000,report:show('telemetry-receipt')});
  const receipt=JSON.parse(report(output,['telemetry-receipt'])['telemetry-receipt']);
  run.phase.assertions=receipt;
  run.phase.assertions=telemetryVerdict(receipt);
}
export function browserVerdict(value){
  if(value.chromeMajor!==Number(CHROME_VERSION.split('.')[0])||value.sha256Verified!==true||value.certificateTrust!=='nss')fail('BROWSER_INVALID');
  for(const name of ['signin','today','ask','talk']){
    const p=value.pages?.[name];
    if(!p||p.status!==200||p.cspEvents!==0||p.cspConsole!==0||p.pathMatches!==true||p.allNonced!==true||
      !Number.isInteger(p.scripts)||p.scripts<1||p.nonced!==p.scripts)fail('BROWSER_INVALID');
  }
  const talk=value.pages.talk,control=value.detectorControl;
  if(talk.microphoneSelf!==true||!['prompt','granted','denied'].includes(talk.microphonePermission)||
    !control||control.status!==404||![control.cspEvents,control.cspConsole].every(n=>Number.isSafeInteger(n)&&n>=0)||
    control.cspEvents+control.cspConsole<1)fail('BROWSER_INVALID');
  return value;
}
async function browser(run){
  run.record.unverified.push(
    {layer:'browser download pin',reason:'Chrome for Testing checksum pinned by trust on first use; upstream signed checksum not available.'},
    {layer:'browser sandbox',reason:'Disposable root container requires no-sandbox and disable-dev-shm-usage; production sandbox not exercised.'},
    {layer:'browser certificate trust',reason:'Fresh NSS database trusts the stand-in certificate; public certificate issuance not exercised.'});
  const script=browserProvisionScript+`${observe} browser "$chrome" "$home" ${state}/browser-token "https://$web_host" > ${state}/browser-receipt\n`;
  const output=await run.inside(script,{timeout:600000,report:show('browser-receipt')});
  const receipt={chromeMajor:Number(CHROME_VERSION.split('.')[0]),sha256Verified:true,certificateTrust:'nss',
    ...JSON.parse(report(output,['browser-receipt'])['browser-receipt'])};
  run.phase.assertions=receipt;
  run.phase.assertions=browserVerdict(receipt);
}
export const observabilityPhases={telemetry,browser};
