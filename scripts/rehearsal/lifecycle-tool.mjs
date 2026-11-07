// Self-contained lifecycle parsers. Raw journal/argv/secret-bearing output stays in the host.
import {pathToFileURL} from 'node:url';
const fail=code=>{throw new Error(`REHEARSAL_${code}`);};
const count=value=>Number.isSafeInteger(value)&&value>=0;
const json=text=>{try{return JSON.parse(text);}catch{fail('LIFECYCLE_JSON_INVALID');}};
const lines=text=>String(text).split('\n').filter(line=>line.trim()).map(json);
const ids={de5b426a63be47a7b6ac3eaac82e2f6f:'stopping','9d1aaa27d60140bd96365438aad20286':'stopped',
  '7d4958e842da4a758f6c1cdc7b36dcc5':'starting','39f53479d3a045ac8e11786248231fbf':'started',
  be02cf6855d2428ba40df7e9d022f03d:'failed',d9b373ed55a64feb8242e02dbe79a49c:'failed'};
export function systemdEvents(text,units){
  return lines(text).flatMap(row=>{
    const unit=String(row._PID==='1'?row.UNIT:row._SYSTEMD_UNIT).replace(/\.service$/,'');
    if(!units.includes(unit))return [];
    let event=row._PID==='1'?ids[row.MESSAGE_ID]:undefined;
    if(unit==='unai-backup'&&row._SYSTEMD_UNIT==='unai-backup.service'){
      try{if(JSON.parse(row.MESSAGE).event==='backup.completed')event='completed';}catch{}
    }
    return event?[{unit,event}]:[];
  });
}
export function followsOrder(events,expected){
  const observed=[];
  for(const event of events){
    const next=expected[observed.length];
    if(next&&next.unit===event.unit&&next.event===event.event)observed.push(event);
  }
  return {ok:observed.length===expected.length,observed};
}
export function neverStopped(events,unit){return !events.some(row=>row.unit===unit&&['stopping','stopped'].includes(row.event));}
export function peakOf(samples){
  if(!Array.isArray(samples)||!samples.length||!samples.every(count))fail('SAMPLES_INVALID');
  return {peak:samples.reduce((peak,n)=>Math.max(peak,n),0),samples:samples.length};
}
export function version(value){
  if(typeof value!=='string'||!/^\d+\.\d+\.\d+$/.test(value))fail('VERSION_INVALID');
  const [major,minor,patch]=value.split('.').map(Number);
  if(![major,minor,patch].every(count))fail('VERSION_INVALID');
  return {major,minor,patch};
}
export function registryTarget({pinned,recorded,published,tagged,bases}){
  const compare=(a,b)=>{const x=Object.values(version(a)),y=Object.values(version(b));
    return x[0]-y[0]||x[1]-y[1]||x[2]-y[2];};
  version(pinned);
  const usable=recorded.filter(v=>v!==pinned&&tagged.includes(v)&&
    (published.includes(v)||!Object.hasOwn(bases,v)||published.includes(bases[v]))).sort((a,b)=>compare(b,a));
  const target=usable.find(v=>compare(v,pinned)>0)??usable[0];
  return target?{from:version(pinned),to:version(target),direction:compare(target,pinned)>0?'forward':'backward'}:
    {unverified:'REGISTRY_TARGET_UNAVAILABLE'};
}
export function d12Steps(text){
  return [...String(text).matchAll(/^== D12 step (\d): ([a-z]+)$/gm)].map((match,index)=>{
    if(Number(match[1])!==index)fail('UPGRADE_STEPS_INVALID');return match[2];
  });
}
export function backupSummary(text){
  const row=json(text);
  if(row?.event!=='backup.completed'||!count(row.bytes)||row.bytes===0||!count(row.objects)||row.quiescence!=='systemd')fail('BACKUP_INVALID');
  return {bytes:row.bytes,objects:row.objects,quiescence:row.quiescence};
}
export function drillSummary(text){
  const row=json(text);
  if(row?.event!=='restore.drill.completed'||row.verdict!=='PASS'||!count(row.restore?.tables)||
    !count(row.restore?.objects)||!count(row.probes?.reads)||row.probes.reads===0)fail('DRILL_INVALID');
  return {verdict:'PASS',tables:row.restore.tables,objects:row.restore.objects,probeReads:row.probes.reads};
}
function checkLines(text){
  return String(text).split('\n').filter(line=>line.startsWith('{')).map(json).filter(row=>Object.hasOwn(row,'check')).map(row=>{
    if(!/^[a-z_]+$/.test(row.check)||!['ok','warn','fail'].includes(row.status)||
      !/^[A-Z][A-Z_]*(?::[A-Z_]+)?$/.test(row.code))fail('OBSERVED_INVALID');
    return {check:row.check,status:row.status,code:row.code};
  });
}
export function classifyObserved(text){
  const result={transientBackup:null,migrate:null,publish:null,checks:{}};
  for(const row of lines(text)){
    if(!Array.isArray(row.argv)||!row.argv.every(v=>typeof v==='string')||!count(row.exit)||row.exit>255)fail('OBSERVED_INVALID');
    const args=row.argv,user=args.find(v=>v.startsWith('--uid='))?.slice(6)??'root';
    if(!['root','unai-backup','unai-api','unai-web','unai-worker'].includes(user))fail('OBSERVED_INVALID');
    let key,value;
    if(args.includes('--unit=unai-upgrade-backup')){
      key='transientBackup';value={user,environmentFile:args.includes('--property=EnvironmentFile=/etc/unai/backup.env'),exit:row.exit};
    }else if(args.includes('db:migrate')||args.includes('publish')){
      key=args.includes('db:migrate')?'migrate':'publish';value={user,home:args.includes('--setenv=HOME=/root'),exit:row.exit};
    }else if(args.includes('--check')){
      const name=user.replace('unai-','');
      if(!['api','web','worker'].includes(name)||result.checks[name])fail('OBSERVED_INVALID');
      result.checks[name]={exit:row.exit,lines:checkLines(row.stdout)};continue;
    }else continue;
    if(result[key])fail('OBSERVED_INVALID');result[key]=value;
  }
  return result;
}
export function observerScript({real,log}){
  for(const path of [real,log])if(!/^\/[A-Za-z0-9_./-]+$/.test(path))fail('OBSERVER_PATH_INVALID');
  // tee passes stdout through unchanged, including the publish JSON captured by upgrade.sh.
  // stderr is inherited; pipefail/PIPESTATUS preserve the wrapped command's status.
  return `#!/bin/bash
set -uo pipefail
umask 077
out=$(mktemp)
trap 'rm -f "$out"' EXIT
${real} "$@" | tee "$out"
status=\${PIPESTATUS[0]}
node --input-type=module - '${log}' "$out" "$status" "$@" <<'OBSERVE'
import {readFileSync,appendFileSync} from 'node:fs';
const [log,out,status,...argv]=process.argv.slice(2);
appendFileSync(log,JSON.stringify({argv,exit:Number(status),stdout:argv.includes('--check')?readFileSync(out,'utf8'):''})+'\\n',{mode:0o600});
OBSERVE
exit "$status"
`;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{
    if(process.argv[2]!=='observer')fail('LIFECYCLE_USAGE');
    process.stdout.write(observerScript({real:process.argv[3],log:process.argv[4]}));
  }catch{process.stderr.write('REHEARSAL_LIFECYCLE_FAILED\n');process.exitCode=1;}
}
export const D11=[['unai-worker','stopped'],['unai-api','stopped'],['unai-backup','completed'],
  ['unai-api','started'],['unai-worker','started']].map(([unit,event])=>({unit,event}));
export function backupVerdict(events,summary,inventory){
  const order=followsOrder(events,D11),webNeverStopped=neverStopped(events,'unai-web');
  if(!order.ok||!webNeverStopped||inventory.archives!==1||inventory.sidecars!==2||
    !['encrypted','sizeMatches','headerValid'].every(key=>inventory[key]===true))fail('BACKUP_INVALID');
  return {...summary,...inventory,order:order.observed,webNeverStopped};
}
export function drillVerdict(input){
  const {summary,samples,limit,user,capability,protect,databases,roles,failed}=input;
  if(!['','root'].includes(user)||capability!=='cap_dac_read_search'||protect!=='strict'||
    databases!==0||roles!==0||failed!==false||!count(limit))fail('DRILL_INVALID');
  const measured=peakOf(samples);
  return {...drillSummary(summary),migratorPeak:measured.peak,migratorLimit:limit,overLimit:measured.peak>limit,
    samples:measured.samples,intervalMs:100,user:'root',capability,protect,databases,roles};
}
export const D12='timers fetch build maintenance backup migrate registry preflight swap start'.split(' ');
export function dryVerdict(text,equal){
  const steps=d12Steps(text);
  if(equal!==true||steps.join(' ')!==D12.join(' ')||!text.includes('dry run: nothing was executed'))fail('DRY_RUN_INVALID');
  return {exit:0,steps,changedPaths:0};
}
export function rollbackVerdict(input){
  const {text,exit,observed,events}=input,backup=observed.transientBackup;
  const order=followsOrder(events,D11.filter(row=>row.event!=='completed'));
  if(exit!==1||!text.trim().endsWith('UPGRADE_BACKUP_FAILED')||!text.includes('ROLLBACK (ADR 0043 D12): step 4 failed')||
    text.includes('rollback incomplete')||!order.ok||backup?.user!=='unai-backup'||backup.environmentFile!==true||
    !count(backup.exit)||backup.exit===0||!['current','removed','unchanged','noCopies','ready','timers'].every(key=>input[key]===true))fail('ROLLBACK_INVALID');
  return {exit,code:'UPGRADE_BACKUP_FAILED',transientBackup:backup,current:'rehearsal-a',releaseRemoved:true,
    protectedStateUnchanged:true,noCopies:true,ready:true,timers:true,order:order.observed};
}
export function upgradeVerdict(input){
  const {text,exit,observed,events}=input,b=observed.transientBackup;
  const root=row=>row?.user==='root'&&row.home===true&&row.exit===0;
  const order=followsOrder(events,[['unai-api','started'],['unai-web','stopped'],['unai-web','started'],['unai-worker','started']].map(([unit,event])=>({unit,event})));
  if(exit!==0||text.includes('STOPPED')||!text.includes('upgraded rehearsal-a -> rehearsal-b')||d12Steps(text).join(' ')!==D12.join(' ')||
    b?.user!=='unai-backup'||b.environmentFile!==true||b.exit!==0||!root(observed.migrate)||
    (input.publishExpected&&!root(observed.publish))||!order.ok||input.archiveDelta!==1||input.offlineVersion!=='11.0.8'||input.signin!==200||
    !['cacheUnchanged','current','marker','ready','timers'].every(key=>input[key]===true)||
    !['api','web','worker'].every(name=>observed.checks[name]?.exit===0)||
    !observed.checks.web.lines.some(line=>line.check==='api'&&line.status==='warn'&&line.code==='API_UNREACHABLE'))fail('UPGRADE_INVALID');
  return {exit,steps:D12,transientBackup:b,migrate:observed.migrate,publish:observed.publish,
    apiChecks:observed.checks.api.lines,webChecks:observed.checks.web.lines,workerChecks:observed.checks.worker.lines,
    checkExits:{api:0,web:0,worker:0},archiveDelta:input.archiveDelta,cacheUnchanged:true,offlineVersion:version(input.offlineVersion),
    current:'rehearsal-b',marker:true,ready:true,timers:true,signin:200,order:order.observed};
}
export function drillInvocation(text){
  const invocations=new Set(lines(text).filter(row=>row._SYSTEMD_UNIT==='unai-restore-drill.service')
    .map(row=>row._SYSTEMD_INVOCATION_ID).filter(id=>typeof id==='string'&&/^[a-f0-9]{32}$/.test(id)));
  if(invocations.size!==1)fail('DRILL_INVALID');return [...invocations][0];
}
export function archiveChange(before,after,events){
  if(!count(before)||!count(after)||after<before)fail('ARCHIVES_INVALID');
  const timerArchives=events.filter(row=>row.unit==='unai-backup'&&row.event==='completed').length;
  return {archiveIncrease:after-before,timerArchives,archiveDelta:after-before-timerArchives};
}
