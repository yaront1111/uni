import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,cp,rm,lstat} from 'node:fs/promises';
import {tmpdir,hostname} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {scrub} from '../lib/rehearsal-record.mjs';
import {installPhases} from './install.mjs';
import {preflightPhases} from './preflights.mjs';

export const IMAGE_DIGEST='sha256:fe81560990fae86dc4743202b2cb4d3df98d0bcf949173cecef15ce1127ef852';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const identity=['-c','user.name=rehearsal','-c','user.email=rehearsal@example.invalid','-c','core.autocrlf=false','-c','core.fileMode=false'];
const unverified=[
  ['LUKS2 and KMS unlock','Disposable Docker data volume; no encrypted block device or KMS unlock exercised.'],
  ['AWS IAM and KMS','Three in-memory TLS S3 stand-ins share a disposable key pair; AWS provisioning is not run.'],
  ['certbot HTTP-01','Self-signed web certificate for uai.rehearsal.invalid; issuance not exercised.'],
  ['DNS and CAA','Reserved rehearsal name only; public DNS and CAA not exercised.'],
  ['firewall','No inbound firewall configured in the container.'],
  ['NODE_EXTRA_CA_CERTS','Rehearsal-only service drop-ins trust the three S3 stand-in certificates.'],
  ['model and Google credentials','Disposable syntactic credentials; no real provider call or sign-in ceremony.'],
].map(([layer,reason])=>({layer,reason}));

export async function execute(file,args,{cwd=root,input,signal,timeout=120000}={}){
  return new Promise(resolveResult=>{
    let output='',settled=false,overflow=false;
    const child=spawn(file,args,{cwd,env:{...process.env},stdio:['pipe','pipe','pipe'],detached:true});
    const stop=()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}};
    const timer=setTimeout(stop,timeout);
    const finish=(exitCode)=>{
      if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',stop);
      resolveResult({exitCode:overflow?null:exitCode,output});
    };
    signal?.addEventListener('abort',stop,{once:true});if(signal?.aborted)stop();
    const capture=chunk=>{
      output+=chunk.toString();
      if(output.length>1048576){overflow=true;output=output.slice(-1048576);stop();}
    };
    child.stdout.on('data',capture);child.stderr.on('data',capture);
    child.on('error',()=>finish(null));child.on('close',finish);
    child.stdin.on('error',()=>{});child.stdin.end(input);
  });
}
async function command(run,file,args,options={}){
  if(run.signal.aborted)throw new Error('REHEARSAL_INTERRUPTED');
  const start=Date.now(),actual=file==='docker'?['--config',join(run.directory,'docker'),...args]:args;
  const result=await execute(file,actual,{...options,signal:run.signal});
  await writeFile(join(run.directory,`command-${run.sequence++}.log`),result.output,{mode:0o600});
  run.phase.commands.push({argv:[file,...args].map(s=>scrub(s,{forbidden:run.forbidden})),
    exitCode:result.exitCode,durationMs:Date.now()-start,tail:scrub(result.output,{forbidden:run.forbidden})});
  if(result.exitCode!==0)throw new Error(run.signal.aborted?'REHEARSAL_INTERRUPTED':'REHEARSAL_COMMAND_FAILED');
  return result.output.trim();
}
async function inside(run,script,{timeout=120000,report=''}={}){
  // No raw host output crosses the boundary, even on errors. Secret-bearing
  // failures stay root-only inside this disposable host. Reports are explicit.
  const index=run.sequence;
  const wrapped=`umask 077\nmkdir -p /root/rehearsal\nlog=/root/rehearsal/command-${index}.log\nset +e\nbash -euo pipefail -s > "$log" 2>&1 <<'REHEARSAL_SCRIPT'\n${script}\nREHEARSAL_SCRIPT\ncode=$?\nset -e\nprintf 'COMMAND_EXIT=%s\\n' "$code"\n${report}\nexit "$code"`;
  const commandIndex=run.phase.commands.length;
  try{return await command(run,'docker',['exec','-i',run.container,'bash','-euo','pipefail','-s'],{input:wrapped,timeout});}
  finally{run.phase.commands[commandIndex]?.argv.push(scrub(script,{forbidden:run.forbidden}));}
}
export async function workingTreePaths(cwd=root){
  const paths=[];
  for(const args of [['diff','--name-only','-z','HEAD'],['ls-files','-o','--exclude-standard','-z']]){
    const result=await execute('git',args,{cwd});
    if(result.exitCode!==0)throw new Error('REHEARSAL_SOURCE_FAILED');
    paths.push(...result.output.split('\0').filter(Boolean));
  }
  return [...new Set(paths)].sort();
}
async function source(run){
  const git=(args,options={})=>run.command('git',args,options);
  const head=await git(['rev-parse','HEAD']);run.record.sourceCommit=head;
  const paths=await workingTreePaths();
  run.record.workingTree={clean:paths.length===0,paths:paths.map(p=>scrub(p,{forbidden:run.forbidden}))};
  const destination=join(run.directory,'src');
  await git(['clone','--no-hardlinks','--no-local',root,destination]);
  // Tracked diff includes staged edits and deletions. Untracked copies never
  // follow symlinks out of the source tree. No original refs or index writes.
  const diff=await execute('git',['diff','--binary','HEAD'],{cwd:root});
  if(diff.exitCode!==0)throw new Error('REHEARSAL_SOURCE_FAILED');
  if(diff.output)await git(['apply','--binary','-'],{cwd:destination,input:diff.output});
  const added=(await git(['ls-files','-o','--exclude-standard','-z'])).split('\0').filter(Boolean);
  for(const path of added){
    if((await lstat(join(root,path))).isSymbolicLink())throw new Error('REHEARSAL_SOURCE_SYMLINK');
    await mkdir(dirname(join(destination,path)),{recursive:true});await cp(join(root,path),join(destination,path));
  }
  if(paths.length){await git([...identity,'add','--all'],{cwd:destination});await git([...identity,'commit','-m','rehearsal snapshot'],{cwd:destination});}
  // Same CLI as pnpm uai, without pnpm's auto-install/purge in a temporary
  // clone. Its read-only repository input is cwd; dependencies stay at root.
  const registryArgs=['--import',join(root,'node_modules/tsx/dist/loader.mjs'),join(root,'packages/registry/src/cli.ts'),'registry','tags'];
  const tags=await run.command(process.execPath,registryArgs,{cwd:destination});
  for(const line of tags.split('\n')){
    const match=/^registry-v(\d+\.\d+\.\d+) (?:MISSING|MISMATCH) git tag -a (?:-f )?registry-v\1 ([a-f0-9]{40}) -m "registry \1"$/.exec(line);
    if(match)await git([...identity,'tag','-a','-f',`registry-v${match[1]}`,match[2],'-m',`registry ${match[1]}`],{cwd:destination});
  }
  await run.command(process.execPath,[...registryArgs,'--require'],{cwd:destination});
  await git([...identity,'tag','-f','rehearsal-a'],{cwd:destination});
  await git(['bundle','create',join(run.directory,'unai.bundle'),'--all'],{cwd:destination});
  await run.command('docker',['cp',join(run.directory,'unai.bundle'),`${run.container}:/root/unai.bundle`]);
  await run.inside('git clone --mirror /root/unai.bundle /srv/unai.git');
}
async function host(run){
  try{run.record.host.engine=await run.command('docker',['version','--format','{{.Server.Version}}']);}
  catch{throw new Error(run.signal.aborted?'REHEARSAL_INTERRUPTED':'REHEARSAL_DOCKER_UNAVAILABLE');}
  await run.command('docker',['network','create','--label',run.label,run.container]);
  await run.command('docker',['volume','create','--label',run.label,`${run.container}-pgdata`]);
  const dockerfile=`FROM ubuntu:24.04@${IMAGE_DIGEST}\nRUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends systemd systemd-sysv dbus sudo ca-certificates curl git openssl iproute2 procps tzdata && rm -rf /var/lib/apt/lists/* && rm -f /usr/sbin/policy-rc.d\nSTOPSIGNAL SIGRTMIN+3\nCMD ["/sbin/init"]\n`;
  const image=await run.command('docker',['build','-q','--label',run.label,'-'],{input:dockerfile,timeout:900000});
  const imageId=image.split('\n').findLast(line=>/^sha256:[a-f0-9]{64}$/.test(line));
  if(!imageId)throw new Error('REHEARSAL_IMAGE_FAILED');
  const id=await run.command('docker',['run','-d','--name',run.container,'--label',run.label,'--privileged','--cgroupns=private',
    '--tmpfs','/run','--tmpfs','/run/lock','--env','container=docker','--hostname','rehearsal-host',
    '--network',run.container,'--mount',`source=${run.container}-pgdata,target=/var/lib/postgresql`,imageId]);
  run.forbidden.push(id,id.slice(0,12));
  const state=await run.inside(`state=$(timeout 120 systemctl is-system-running --wait || true)\ncase "$state" in running|degraded) ;; *) exit 1;; esac\nprintf '%s\\n' "$state" > /root/rehearsal/boot-state`,
    {timeout:130000,report:'cat /root/rehearsal/boot-state; systemctl --failed --no-legend --plain | awk \'{print $1}\''});
  if(state.includes('degraded'))run.record.unverified.push({layer:'systemd degraded',reason:'Container boot has failed units; see host phase. Not a bare-metal boot certification.'});
  const version=await run.inside('systemctl --version > /root/rehearsal/systemd-version',{report:'head -n 1 /root/rehearsal/systemd-version'});
  run.record.host.systemd=version.split('\n').find(line=>line.startsWith('systemd '))??'unknown';
  await source(run);
}
async function cleanup(run){
  if(run.options.keep){process.stdout.write(JSON.stringify({event:'rehearsal.kept',container:run.container})+'\n');return;}
  let failed=false;
  for(const [listing,remove] of [[['ps','-aq'],['rm','-f']],[['network','ls','-q'],['network','rm']],[['volume','ls','-q'],['volume','rm']]]){
    const config=['--config',join(run.directory,'docker')];
    const result=await execute('docker',[...config,...listing,'--filter',`label=${run.label}`]);
    if(result.exitCode!==0){failed=true;continue;}
    const ids=result.output.trim().split(/\s+/).filter(Boolean);
    if(ids.length&&(await execute('docker',[...config,...remove,...ids])).exitCode!==0)failed=true;
  }
  if(failed)throw new Error('REHEARSAL_CLEANUP_FAILED');
  await rm(run.directory,{recursive:true,force:true});
}
export async function createRun(options){
  const sourceHead=await execute('git',['rev-parse','HEAD']);
  if(sourceHead.exitCode!==0||!/^[a-f0-9]{40}$/.test(sourceHead.output.trim()))throw new Error('REHEARSAL_SOURCE_FAILED');
  const directory=await mkdtemp(join(tmpdir(),'unai-rehearsal-')),id=randomBytes(6).toString('hex');
  await mkdir(join(directory,'docker'),{mode:0o700});
  const run={directory,options,container:`unai-rehearsal-${id}`,label:`unai-rehearsal=${id}`,sequence:0,
    forbidden:[hostname(),directory,'rehearsal-host'],
    record:{format:'unai-deploy-rehearsal/1',sourceCommit:sourceHead.output.trim(),startedAt:new Date().toISOString(),
      completedAt:new Date().toISOString(),host:{imageDigest:IMAGE_DIGEST,os:'Ubuntu 24.04',systemd:'unknown',engine:'unknown'},
      workingTree:{clean:true,paths:[]},phases:[],unverified:structuredClone(unverified)},phases:{host,...installPhases,...preflightPhases}};
  run.command=(file,args,options)=>command(run,file,args,options);
  run.inside=(script,options)=>inside(run,script,options);
  run.cleanup=()=>cleanup(run);
  return run;
}
