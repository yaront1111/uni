// In-host I/O boundary. Only verified allowlisted summaries are printed; never raw child output.
import {readFileSync,writeFileSync,existsSync,readlinkSync,statSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {systemdEvents,backupSummary,backupVerdict,drillVerdict,registryTarget,version,dryVerdict,
  classifyObserved,rollbackVerdict,upgradeVerdict,drillInvocation,archiveChange} from './lifecycle-tool.mjs';
export const state='/root/rehearsal';
export const fail=code=>{throw new Error(`REHEARSAL_${code}`);};
export const read=path=>readFileSync(path,'utf8').trim();
export function command(file,args,input){
  const r=spawnSync(file,args,{encoding:'utf8',input,timeout:120000,maxBuffer:16777216});
  if(r.status!==0)fail('LIFECYCLE_COMMAND_FAILED');return r.stdout.trim();
}
export const sql=query=>command('sudo',['-u','postgres','psql','-X','-d','unai','-At','-v','ON_ERROR_STOP=1','-c',query]);
export function environment(name){
  return parseEnvironment(read(`/etc/unai/${name}.env`));
}
export function parseEnvironment(text){
  return Object.fromEntries(text.split('\n').filter(line=>/^[A-Z_][A-Z0-9_]*=/.test(line)).map(line=>{
    const at=line.indexOf('=');return [line.slice(0,at),line.slice(at+1)];
  }));
}
export function journal(){
  command('journalctl',['--sync']);
  return command('journalctl',['-q','--no-pager','-o','json','--after-cursor='+read(`${state}/lifecycle.cursor`),
    ...['worker','api','web','backup','restore-drill'].flatMap(name=>['-u',`unai-${name}.service`])]);
}
export function events(text){return systemdEvents(text,['unai-worker','unai-api','unai-web','unai-backup','unai-restore-drill']);}
export function productLine(text,event){
  const found=text.split('\n').filter(Boolean).map(line=>JSON.parse(line)).flatMap(row=>{
    try{const body=JSON.parse(row.MESSAGE);return body.event===event?[row.MESSAGE]:[];}catch{return [];}
  });
  if(found.length!==1)fail('LIFECYCLE_EVIDENCE_INVALID');return found[0];
}
export async function archives(summary){
  const env=environment('backup'),destination=new URL(env.UNAI_BACKUP_DESTINATION),prefix=destination.pathname.slice(1);
  const sdk=createRequire('/opt/unai/current/packages/storage/package.json')('@aws-sdk/client-s3');
  const client=new sdk.S3Client({endpoint:env.UNAI_BACKUP_S3_ENDPOINT,region:env.UNAI_BACKUP_S3_REGION,forcePathStyle:true,
    credentials:JSON.parse(read(`${state}/aws-pair`)),requestHandler:{connectionTimeout:5000,requestTimeout:30000}});
  try{
    const names=[];
    for(let token;;){
      const page=await client.send(new sdk.ListObjectsV2Command({Bucket:destination.hostname,Prefix:prefix,ContinuationToken:token}));
      names.push(...(page.Contents??[]).map(row=>row.Key).filter(key=>typeof key==='string'&&key.startsWith(prefix)));
      if(!page.IsTruncated)break;token=page.NextContinuationToken;if(!token)fail('ARCHIVES_INVALID');
    }
    const files=names.filter(key=>key.endsWith('.tar.enc'));
    if(!summary)return {archives:files.length};
    if(files.length!==1)fail('ARCHIVES_INVALID');
    const Key=files[0],Bucket=destination.hostname;
    const head=await client.send(new sdk.HeadObjectCommand({Bucket,Key}));
    const body=await client.send(new sdk.GetObjectCommand({Bucket,Key}));
    const bytes=Buffer.from(await body.Body.transformToByteArray());
    return {archives:files.length,sidecars:['.sha256','.manifest.json'].filter(suffix=>names.includes(Key+suffix)).length,
      encrypted:head.ServerSideEncryption==='aws:kms'&&head.SSEKMSKeyId===env.UNAI_BACKUP_S3_KMS_KEY_ID,
      sizeMatches:head.ContentLength===summary.bytes&&bytes.length===summary.bytes,headerValid:bytes.subarray(0,6).equals(Buffer.from('UAIBK\x01'))};
  }finally{client.destroy();}
}
async function backup(){
  const text=journal(),summary=backupSummary(productLine(text,'backup.completed'));
  return {...backupVerdict(events(text),summary,await archives(summary)),prerequisitesPresent:true};
}
async function sample(){
  const {Client}=createRequire('/opt/unai/current/packages/postgres/package.json')('pg');
  const client=new Client({host:'/var/run/postgresql',user:'postgres',database:'unai'});
  await client.connect();
  let busy=false,stopping=false;
  client.on('error',()=>{process.exitCode=1;stop();});
  const take=async()=>{
    if(busy||stopping)return;busy=true;
    try{const r=await client.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE usename='unai_migrator'");
      process.stdout.write(String(r.rows[0].count)+'\n');
    }catch{process.exitCode=1;await stop();}finally{busy=false;}
  };
  const timer=setInterval(take,100);
  async function stop(){if(stopping)return;stopping=true;clearInterval(timer);await client.end().catch(()=>{process.exitCode=1;});}
  process.once('SIGTERM',stop);process.once('SIGINT',stop);
  await take();
}
function drill(){
  const invocation=drillInvocation(journal());
  command('journalctl',['--sync']);
  const text=command('journalctl',['-q','--no-pager','-o','json',`_SYSTEMD_INVOCATION_ID=${invocation}`]);
  const show=property=>command('systemctl',['show','-p',property,'--value','unai-restore-drill.service']);
  const summary=drillVerdict({summary:productLine(text,'restore.drill.completed'),
    failed:text.includes('restore.drill.failed'),samples:read(`${state}/samples`).split('\n').map(Number),
    limit:Number(sql("SELECT rolconnlimit FROM pg_roles WHERE rolname='unai_migrator'")),
    user:show('User'),capability:show('CapabilityBoundingSet'),protect:show('ProtectSystem'),
    databases:Number(sql("SELECT count(*) FROM pg_database WHERE datname LIKE 'unai_restore_drill_%'")),
    roles:Number(sql("SELECT count(*) FROM pg_roles WHERE rolname LIKE 'unai_restore_drill_probe_%'"))});
  return {...summary,timersEnabledHere:true};
}
function registry(){
  const root='/opt/unai/current',yaml=createRequire(`${root}/packages/registry/package.json`)('yaml');
  const recorded=yaml.parse(read(`${root}/registry/releases.yaml`)).releases.map(row=>row.version),bases={};
  for(const v of recorded){
    version(v);
    const path=`${root}/registry/releases/${v}/migration.yaml`;
    if(existsSync(path))bases[v]=yaml.parse(read(path)).from??'unavailable';
  }
  const target=registryTarget({pinned:environment('api').UNAI_REGISTRY_RELEASE,recorded,bases,
    published:sql('SELECT semantic_version FROM registry_releases').split('\n'),
    tagged:command('git',['--git-dir=/srv/unai.git','tag','-l','registry-v*']).split('\n').map(v=>v.replace('registry-v',''))});
  writeFileSync(`${state}/registry-target`,JSON.stringify(target),{mode:0o600});
  writeFileSync(`${state}/registry-version`,target.to?Object.values(target.to).join('.'):'',{mode:0o600});
  return target;
}
function dry(){
  return {...dryVerdict(read(`${state}/upgrade-output`),read(`${state}/before`)==read(`${state}/after`)),
    registry:JSON.parse(read(`${state}/registry-target`))};
}
function rollback(){
  return rollbackVerdict({text:read(`${state}/upgrade-output`),exit:Number(read(`${state}/upgrade-exit`)),
    observed:classifyObserved(read('/run/unai-rehearsal-observed')),events:events(journal()),
    current:readlinkSync('/opt/unai/current')==='releases/rehearsal-a',removed:!existsSync('/opt/unai/releases/rehearsal-b'),
    unchanged:read(`${state}/before`)===read(`${state}/after`),
    noCopies:!['api','worker'].some(name=>existsSync(`/etc/unai/${name}.env.pre-rehearsal-b`)),
    ready:read(`${state}/ready`)==='ready',timers:read(`${state}/timers`)==='active'});
}
function registryProof(){
  const target=JSON.parse(read(`${state}/registry-target`));if(!target.to)return target;
  const want=Object.values(target.to).join('.'),api=environment('api'),worker=environment('worker');
  const before=Object.fromEntries(read('/etc/unai/api.env.pre-rehearsal-b').split('\n').filter(line=>line.includes('=')).map(line=>line.split('=')));
  const equalNewIds=api.UNAI_REGISTRY_RELEASE_ID===worker.UNAI_REGISTRY_RELEASE_ID&&api.UNAI_REGISTRY_RELEASE_ID!==before.UNAI_REGISTRY_RELEASE_ID;
  const pins=api.UNAI_REGISTRY_RELEASE===want&&worker.UNAI_REGISTRY_RELEASE===want;
  const copies=['api','worker'].every(name=>{const s=statSync(`/etc/unai/${name}.env.pre-rehearsal-b`);return s.uid===0&&s.gid===0&&(s.mode&0o777)===0o600;});
  const published=sql('SELECT semantic_version FROM registry_releases').split('\n').includes(want);
  if(!equalNewIds||!pins||!copies||!published)fail('REGISTRY_REPIN_INVALID');
  return {...target,equalNewIds,pins,copies,published};
}
async function beforeUpgrade(){
  const result={...await archives(),counts:sql('SELECT (SELECT count(*) FROM unai_migrations.applied),(SELECT count(*) FROM registry_releases)')};
  writeFileSync(`${state}/upgrade-before`,JSON.stringify(result),{mode:0o600});return {};
}
async function upgrade(){
  const before=JSON.parse(read(`${state}/upgrade-before`)),text=journal(),seen=events(text);
  const counts=archiveChange(before.archives,(await archives()).archives,seen);
  const result=upgradeVerdict({text:read(`${state}/upgrade-output`),exit:Number(read(`${state}/upgrade-exit`)),
    observed:classifyObserved(read('/run/unai-rehearsal-observed')),events:seen,
    archiveDelta:counts.archiveDelta,cacheUnchanged:read(`${state}/cache-before`)===read(`${state}/cache-after`),
    offlineVersion:read(`${state}/offline-version`),current:readlinkSync('/opt/unai/current')==='releases/rehearsal-b',
    marker:read('/opt/unai/current/rehearsal-b.txt')==='Disposable rehearsal marker',ready:read(`${state}/ready`)==='ready',
    timers:read(`${state}/timers`)==='active',signin:Number(read(`${state}/signin-status`)),
    publishExpected:!!JSON.parse(read(`${state}/registry-target`)).to});
  const triggered=JSON.parse(read(`${state}/timer-triggers`));
  const persistent=Object.fromEntries(['backup','restore-drill'].map(name=>[name.replace('-','_'),
    triggered[name]||seen.some(row=>row.unit===`unai-${name}`&&['starting','started'].includes(row.event))]));
  return {...result,...counts,registry:registryProof(),persistent,apiReady:JSON.parse(read(`${state}/api-ready`)),workerReady:JSON.parse(read(`${state}/worker-ready`))};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{
    const mode=process.argv[2];
    if(mode==='sample')await sample();
    else{
      const action={backup,drill,registry,dry,rollback,'before-upgrade':beforeUpgrade,upgrade}[mode];if(!action)fail('LIFECYCLE_USAGE');
      writeFileSync(`${state}/lifecycle-report`,JSON.stringify(await action())+'\n',{mode:0o600});
    }
  }catch(error){
    const code=/^REHEARSAL_[A-Z_]+$/.test(error?.message)?error.message:'REHEARSAL_LIFECYCLE_FAILED';
    try{if(process.argv[2]!=='sample')writeFileSync(`${state}/lifecycle-error`,code+'\n',{mode:0o600});}catch{}
    process.stderr.write(code+'\n');process.exitCode=1;
  }
}
