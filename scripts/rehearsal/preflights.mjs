import {fileURLToPath} from 'node:url';
import {requirePreflight} from '../lib/rehearsal-record.mjs';
const active='systemctl is-active --quiet unai-rehearsal-s3-evidence unai-rehearsal-s3-backup unai-rehearsal-s3-drill';
const tool='/usr/local/lib/unai-rehearsal';
const setup=`/usr/local/bin/node ${tool}/configure.mjs`;
const migration='cd /opt/unai/current; set -a; . /etc/unai/migrate.env; set +a;';

async function objectStore(run){
  await run.inside(`install -d -m 0755 ${tool} /etc/unai/rehearsal`);
  for(const file of ['s3-stand-in.mjs','configure.mjs'])
    await run.command('docker',['cp',fileURLToPath(new URL(file,import.meta.url)),`${run.container}:${tool}/${file}`]);
  await run.inside(String.raw`
node --input-type=module -e "import {writeFileSync} from 'node:fs';import {randomBytes} from 'node:crypto';writeFileSync('/root/rehearsal/aws-pair',JSON.stringify({accessKeyId:randomBytes(16).toString('hex'),secretAccessKey:randomBytes(32).toString('hex')}),{mode:0o600,flag:'wx'})"
`);
  for(const name of ['evidence','backup','drill']){
    const bucket=name==='drill'?'restore-drill':name;
    const key=name==='backup'?'arn:aws:kms:us-west-2:000000000000:key/rehearsal-backup':'arn:aws:kms:us-east-1:000000000000:key/rehearsal-evidence';
    await run.inside(`systemd-run --unit=unai-rehearsal-s3-${name} --property=Restart=no /usr/local/bin/node ${tool}/s3-stand-in.mjs --bucket rehearsal-uai-${bucket} --kms-key-id ${key} --common-name rehearsal-${name} --credentials-file /root/rehearsal/aws-pair --out /etc/unai/rehearsal/${name}
for i in $(seq 1 100); do test ! -f /etc/unai/rehearsal/${name}/endpoint || break; sleep 0.1; done
test -f /etc/unai/rehearsal/${name}/endpoint
systemctl is-active --quiet unai-rehearsal-s3-${name}`);
  }
  await run.inside(`${active}
cat /etc/unai/rehearsal/{evidence,backup,drill}/cert.pem > /etc/unai/rehearsal/ca-bundle.pem
chmod 0644 /etc/unai/rehearsal/ca-bundle.pem`);
}
async function secrets(run){
  await run.inside(`${active}\n${setup} secrets`);
  await run.inside(String.raw`
for name in api worker backup restore-drill; do
  install -d -m 0755 "/etc/systemd/system/unai-$name.service.d"
  printf '[Service]\nEnvironment=NODE_EXTRA_CA_CERTS=/etc/unai/rehearsal/ca-bundle.pem\n' > "/etc/systemd/system/unai-$name.service.d/rehearsal.conf"
  chmod 0644 "/etc/systemd/system/unai-$name.service.d/rehearsal.conf"
done
systemctl daemon-reload
grep -nE '^[A-Z0-9_]+=.*<' /etc/unai/*.env || test "$?" = 1
`,{report:'grep -E \'^[^ ]*:[0-9]+:[A-Z0-9_]+=<[a-z.-]+>$\' "$log" || true'});
  await run.inside('RENEWED_LINEAGE=/etc/letsencrypt/live/uai.rehearsal.invalid /etc/letsencrypt/renewal-hooks/deploy/unai-web.sh\nsystemctl is-active --quiet unai-web',
    {report:'if [ "$code" = 0 ]; then echo WEB_HOOK_ACTIVE; fi'});
}
async function migrate(run){
  await run.inside(`${active}\n${migration} pnpm db:migrate`,{report:String.raw`
node --input-type=module - "$log" <<'REPORT'
import {readFileSync} from 'node:fs';
for(const line of readFileSync(process.argv[2],'utf8').split('\n')){
 if(!line.startsWith('{'))continue;
 try{const value=JSON.parse(line);if(value.event==='database.migrated'&&value.ownershipCoverage==='verified'&&Array.isArray(value.applied))
  console.log(JSON.stringify({event:'database.migrated',appliedCount:value.applied.length,ownershipCoverage:'verified'}));}catch{}
}
REPORT`});
}
async function publish(run){
  await run.inside(`${active}\n${migration} pnpm uai registry tags --require`);
  await run.inside(`${migration} pnpm uai registry publish --version 0.1.0 > /root/rehearsal/publish-output\n${setup} pin`,
    {report:'if [ "$code" = 0 ]; then echo REGISTRY_PUBLISHED=0.1.0; fi'});
}
async function owner(run){
  await run.inside(`${active}\n${setup} owner`,{report:'if [ "$code" = 0 ]; then echo OWNER_MEMBERSHIP_COUNT=1; fi'});
}
const checkReport=String.raw`
node --input-type=module - "$log" <<'REPORT'
import {readFileSync} from 'node:fs';
for(const line of readFileSync(process.argv[2],'utf8').split('\n')){
 if(!line.startsWith('{'))continue;
 let value;try{value=JSON.parse(line);}catch{continue;}
 if(typeof value.check==='string'&&/^[a-z_]+$/.test(value.check)&&['ok','warn','fail'].includes(value.status)&&/^[A-Z][A-Z0-9_]*(?::[A-Z0-9_]+)?$/.test(value.code)){
  console.log(JSON.stringify({check:value.check,status:value.status,code:value.code}));
  if(value.status==='fail')process.exitCode=1;
 }
}
REPORT`;
async function preflights(run){
  await run.inside(`${active}\nsystemctl stop unai-api`);
  for(const [name,endpoint] of [['api',''],['web',''],['worker','unset'],['worker','set']]){
    const web=name==='web',directory='/opt/unai/current'+(web?'/apps/web':'');
    const entry=web?'server.ts':`packages/api/src/${name==='api'?'server':'processing-worker'}.ts`;
    const extra=web?'':`--setenv=AWS_SHARED_CREDENTIALS_FILE=/etc/unai/secrets/${name}/aws/credentials --setenv=AWS_EC2_METADATA_DISABLED=true --setenv=NODE_EXTRA_CA_CERTS=/etc/unai/rehearsal/ca-bundle.pem`;
    // UnsetEnvironment is applied after EnvironmentFile; --setenv alone would
    // be overwritten by the endpoint in worker.env and test the same case twice.
    const otlp=endpoint==='unset'?'--property=UnsetEnvironment=UNAI_OTEL_EXPORTER_OTLP_ENDPOINT':'';
    const output=await run.inside(`${active}\nsystemd-run --wait --pipe --quiet --uid=unai-${name} --gid=unai-${name} --working-directory=${directory} --property=EnvironmentFile=/etc/unai/${name}.env --setenv=NODE_ENV=production ${extra} ${otlp} /usr/local/bin/node --import tsx ${entry} --check`,
      {report:`${checkReport}\nprintf 'PREFLIGHT_${name.toUpperCase()}_${endpoint.toUpperCase()||'DEFAULT'}_EXIT=%s\\n' "$code"`});
    requirePreflight(name,output);
  }
}
export const preflightPhases={'object-store':objectStore,secrets,migrate,publish,owner,preflights};
