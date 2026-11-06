import {describe,expect,it} from 'vitest';
import {mkdtempSync,writeFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,delimiter} from 'node:path';
import {spawnSync} from 'node:child_process';
// @ts-expect-error Plain JavaScript operator tooling.
import * as untyped from '../scripts/lib/rehearsal-record.mjs';
// @ts-expect-error Plain JavaScript operator tooling.
import {installPhases as untypedInstall} from '../scripts/rehearsal/install.mjs';
// @ts-expect-error Plain JavaScript operator tooling.
import * as configuration from '../scripts/rehearsal/configure.mjs';
// @ts-expect-error Plain JavaScript operator tooling.
import {preflightPhases as untypedPreflight} from '../scripts/rehearsal/preflights.mjs';
// @ts-expect-error Plain JavaScript operator tooling.
import {execute as untypedExecute,workingTreePaths as untypedPaths} from '../scripts/rehearsal/host.mjs';

interface Library {
  PHASES: readonly string[]; IMPLEMENTED: readonly string[];
  parseArguments(args:string[]):Record<string,unknown>;
  scrub(text:string,options?:{forbidden?:string[]}):string;
  validateRecord(record:unknown,options?:{forbidden?:string[]}):string[];
  requirePreflight(name:string,text:string):void;
}
const lib=untyped as Library;
const first='host install-dry-run install tls postgres object-store secrets migrate publish owner preflights';
const later='services probes smoke failed-start sync backup restore-drill upgrade-dry-run upgrade-rollback upgrade telemetry browser';
const command=()=>({argv:['node','--check'],exitCode:0,durationMs:1,tail:'ok'});
const phase=(name='host')=>({name,status:'PASS',commands:[command()]});
function record():Record<string,unknown>{
  return {format:'unai-deploy-rehearsal/1',sourceCommit:'a'.repeat(40),
    startedAt:'2026-11-06T12:00:00.000Z',completedAt:'2026-11-06T12:01:00.000Z',
    host:{imageDigest:`sha256:${'b'.repeat(64)}`,os:'Ubuntu 24.04',systemd:'255',engine:'29.8.0'},
    workingTree:{clean:true,paths:[]},phases:[phase()],
    unverified:[{layer:'encryption',reason:'Disposable volume, not LUKS'}]};
}
const forbidden=['private-machine','f'.repeat(64),'f'.repeat(12),'/tmp/private-run'];
const unsafe=[
  '-----BEGIN PRIVATE KEY-----\nSENTINEL\n-----END PRIVATE KEY-----',
  'postgresql://user:SENTINEL@127.0.0.1/db', 'Authorization: Basic SENTINEL',
  'Bearer SENTINEL','aws_access_key_id = SENTINEL','aws_secret_access_key=SENTINEL',
  'AKIA1234567890123456','sk-SENTINEL','password=SENTINEL','PGPASSWORD=SENTINEL',
  '10.10.12.20','192.168.1.1','private.example.com',...forbidden,
];
describe('rehearsal record and arguments',()=>{
  it('requires actual complete preflight evidence rather than a zero exit alone',()=>{
    const names='rate_limits secrets database auth_database database_role encryption_at_rest object_store registry_release tls_certificate probe_port'.split(' ');
    const lines=names.map(check=>JSON.stringify({check,status:'ok',code:'OK'}));
    expect(lib.requirePreflight('api',lines.join('\n'))).toBeUndefined();
    expect(()=>lib.requirePreflight('api','COMMAND_EXIT=0')).toThrow('REHEARSAL_PREFLIGHT_EVIDENCE_INVALID');
    expect(()=>lib.requirePreflight('api',lines.slice(1).join('\n'))).toThrow('REHEARSAL_PREFLIGHT_EVIDENCE_INVALID');
    expect(()=>lib.requirePreflight('api',[...lines,lines[0]].join('\n'))).toThrow('REHEARSAL_PREFLIGHT_EVIDENCE_INVALID');
    expect(()=>lib.requirePreflight('api',lines.join('\n').replace('"ok"','"fail"'))).toThrow('REHEARSAL_PREFLIGHT_EVIDENCE_INVALID');
    expect(lib.requirePreflight('worker','PREFLIGHT_WORKER_UNSET_EXIT=0')).toBeUndefined();
  });
  it('pins shared order and the implemented prefix',()=>{
    expect(lib.PHASES.join(' ')).toBe(`${first} ${later}`);
    expect(lib.IMPLEMENTED.join(' ')).toBe(first);
  });
  it.each(unsafe)('scrubs a sensitive string: %s',input=>{
    const output=lib.scrub(input,{forbidden});
    expect(output).not.toBe(input);
    expect(output).not.toContain('SENTINEL');
    expect(lib.scrub(output,{forbidden})).toBe(output);
  });
  it('preserves safe text and bounds tails',()=>{
    const safe='uai.rehearsal.invalid 127.0.0.1 0.0.0.0 Ubuntu 24.04 29.8.0 --check\ndatabase.migrated\nOK';
    expect(lib.scrub(safe)).toBe(safe);
    expect(lib.scrub('x'.repeat(5000))).toHaveLength(4096);
    expect(lib.scrub(Array.from({length:80},(_,i)=>String(i)).join('\n')).split('\n')).toHaveLength(40);
  });
  it('accepts the minimal record',()=>expect(lib.validateRecord(record())).toEqual([]));
  it.each(unsafe)('rejects an unscrubbed record: %s',value=>{
    const r=record(); r.unverified=[{layer:'test',reason:value}];
    expect(lib.validateRecord(r,{forbidden})).toEqual(['REHEARSAL_RECORD_UNSCRUBBED']);
  });
  const invalid:Array<[string,unknown,string]>=[
    ['format','wrong','FORMAT'],['sourceCommit','bad','SOURCE'],['startedAt','2026-99-99','TIME'],
    ['completedAt',null,'TIME'],['host',{},'HOST'],['workingTree',{clean:1,paths:[]},'WORKTREE'],
    ['phases',[phase('bogus')],'PHASES'],['phases',[phase(),phase()],'PHASES'],
    ['phases',[phase('install'),phase('host')],'PHASES'],
    ['phases',[{...phase(),status:'FAIL'},phase('install')],'PHASES'],
    ['phases',[{...phase(),status:'UNVERIFIED'}],'PHASES'],
    ['phases',[{...phase(),status:'PASS',commands:[]}],'PHASES'],
    ['phases',[{...phase(),commands:[{...command(),exitCode:'0'}]}],'COMMAND'],
    ['phases',[{...phase(),commands:[{...command(),durationMs:-1}]}],'COMMAND'],
    ['phases',[{...phase(),commands:[{...command(),argv:[1]}]}],'COMMAND'],
    ['phases',[{...phase(),commands:[{...command(),tail:null}]}],'COMMAND'],
    ['phases',[{...phase(),commands:[{...command(),exitCode:1}]}],'PHASES'],
    ['unverified',[{layer:'x',reason:''}],'UNVERIFIED'],
    ['findings',[{id:'f',area:'x',verdict:'FILED',note:'pending'}],'FINDINGS'],
    ['releaseCheck',{},'RELEASE_CHECK'],['extra','oops','SHAPE'],
  ];
  it.each(invalid)('rejects invalid %s %#',(key,value,code)=>{
    expect(lib.validateRecord({...record(),[key]:value})).toEqual([`REHEARSAL_RECORD_${code}`]);
  });
  it('refuses null and arrays without throwing',()=>{
    expect(lib.validateRecord(null)).toEqual(['REHEARSAL_RECORD_SHAPE']);
    expect(lib.validateRecord([])).toEqual(['REHEARSAL_RECORD_SHAPE']);
  });
  it('validates reserved gate evidence recursively',()=>{
    const r={...record(),findings:[{id:'f1',area:'install',verdict:'FILED',taskId:`task-${'a'.repeat(32)}`,note:'pending'}],
      releaseCheck:{checkedAt:'2026-11-06T12:01:00.000Z',sourceCommit:'c'.repeat(40),exitCode:1,
        criteria:[{criterion:'owner gates',status:'FAIL',reason:'Owner evidence pending',closedBy:'owner'}]}};
    expect(lib.validateRecord(r)).toEqual([]);
    r.findings[0]!.note='password=SENTINEL';
    expect(lib.validateRecord(r)).toEqual(['REHEARSAL_RECORD_UNSCRUBBED']);
  });
  it('accepts failure-last and unverified notes',()=>{
    expect(lib.validateRecord({...record(),phases:[{...phase(),status:'FAIL',commands:[{...command(),exitCode:1}]}]})).toEqual([]);
    expect(lib.validateRecord({...record(),phases:[{...phase(),status:'UNVERIFIED',note:'Not supported'}]})).toEqual([]);
  });
  it('parses flags and defaults',()=>{
    expect(lib.parseArguments([])).toEqual({until:'preflights',keep:false});
    expect(lib.parseArguments(['--record','r.json','--until','tls','--keep'])).toEqual({record:'r.json',until:'tls',keep:true});
    expect(lib.parseArguments(['--verify-record','r.json'])).toEqual({verifyRecord:'r.json'});
    expect(lib.parseArguments(['--help'])).toEqual({help:true});
  });
  it.each([['--bogus'],['--record'],['--keep','--keep'],['--help','--keep'],
    ['--until','--keep'],['--verify-record','r','--record','s']])('refuses usage %j',(...args)=>{
    expect(()=>lib.parseArguments(args)).toThrow('REHEARSAL_ARGUMENTS_INVALID');
  });
  it('distinguishes unknown from unimplemented phases',()=>{
    expect(()=>lib.parseArguments(['--until','what'])).toThrow('REHEARSAL_PHASE_UNKNOWN');
    expect(()=>lib.parseArguments(['--until','services'])).toThrow('REHEARSAL_PHASE_UNIMPLEMENTED');
  });
});
describe('rehearsal CLI before Docker',()=>{
  it.each(unsafe.slice(0,-4))('offline CLI refuses sensitive content %#',input=>{
    const dir=mkdtempSync(join(tmpdir(),'rehearsal-cli-')),path=join(dir,'record.json');
    try{
      writeFileSync(path,JSON.stringify({...record(),unverified:[{layer:'test',reason:input}]}));
      const result=spawnSync(process.execPath,['scripts/deploy-rehearsal.mjs','--verify-record',path],{encoding:'utf8'});
      expect(result.status).toBe(1);expect(result.stderr).toContain('REHEARSAL_RECORD_UNSCRUBBED');
    }finally{rmSync(dir,{recursive:true,force:true});}
  });
  it.each([['--bogus',2],['--help',0]] as const)('%s never calls Docker',(flag,status)=>{
    const dir=mkdtempSync(join(tmpdir(),'rehearsal-args-')),marker=join(dir,'docker-called');
    try{
      writeFileSync(join(dir,process.platform==='win32'?'docker.cmd':'docker'),
        process.platform==='win32'?`@echo called > "${marker}"\r\n`:`#!/bin/sh\necho called > '${marker}'\n`,{mode:0o755});
      const result=spawnSync(process.execPath,['scripts/deploy-rehearsal.mjs',flag],
        {encoding:'utf8',env:{...process.env,PATH:`${dir}${delimiter}${process.env.PATH??''}`}});
      expect(result.status).toBe(status); expect(existsSync(marker)).toBe(false);
      if(status===2)expect(result.stderr.trim()).toBe('{"event":"rehearsal.failed","code":"REHEARSAL_ARGUMENTS_INVALID"}');
      else expect(result.stdout).toContain('--verify-record');
    }finally{rmSync(dir,{recursive:true,force:true});}
  });
  it('verifies records offline with no platform restriction',()=>{
    const dir=mkdtempSync(join(tmpdir(),'rehearsal-verify-')),file=join(dir,'r.json');
    try{
      writeFileSync(file,JSON.stringify(record()));
      expect(spawnSync(process.execPath,['scripts/deploy-rehearsal.mjs','--verify-record',file]).status).toBe(0);
      writeFileSync(file,JSON.stringify({...record(),unverified:[{layer:'x',reason:'Bearer SENTINEL'}]}));
      expect(spawnSync(process.execPath,['scripts/deploy-rehearsal.mjs','--verify-record',file]).status).toBe(1);
    }finally{rmSync(dir,{recursive:true,force:true});}
  });
});

describe.skipIf(process.platform==='win32')('bounded command runner',()=>{
  const execute=untypedExecute as (file:string,args:string[],options?:{timeout?:number;signal?:AbortSignal})=>Promise<{exitCode:number|null;output:string}>;
  it('fails instead of silently accepting truncated source output',async()=>{
    const result=await execute(process.execPath,['-e','process.stdout.write("x".repeat(1048577))']);
    expect(result.exitCode).toBe(null);
  });
  it('reaps timeout and abort children',async()=>{
    expect((await execute(process.execPath,['-e','setInterval(()=>{},1000)'],{timeout:50})).exitCode).toBe(null);
    const controller=new AbortController();controller.abort();
    expect((await execute(process.execPath,['-e','setInterval(()=>{},1000)'],{signal:controller.signal})).exitCode).toBe(null);
  });
});

it('includes staged-only edits in source provenance',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rehearsal-source-'));
  const git=(args:string[])=>{expect(spawnSync('git',args,{cwd:dir,encoding:'utf8'}).status).toBe(0);};
  try{
    git(['init','-q']);writeFileSync(join(dir,'staged.txt'),'original');
    git(['add','staged.txt']);git(['-c','user.name=test','-c','user.email=test@example.invalid','commit','-qm','initial']);
    writeFileSync(join(dir,'staged.txt'),'staged change');git(['add','staged.txt']);
    writeFileSync(join(dir,'untracked.txt'),'new');
    expect(await (untypedPaths as (cwd:string)=>Promise<string[]>)(dir)).toEqual(['staged.txt','untracked.txt']);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

describe('install recipes',()=>{
  it('executes the bundle twice and makes dry-run comparison mandatory',async()=>{
    const calls:Array<{script:string;options:Record<string,unknown>}> = [];
    const run={inside:async(script:string,options:Record<string,unknown>={})=>{calls.push({script,options});return '';}};
    const phases=untypedInstall as Record<string,(value:typeof run)=>Promise<void>>;
    for(const name of ['install-dry-run','install','tls','postgres'])await phases[name]!(run);
    expect(calls.filter(c=>c.script==='bash /root/uai-install/deploy/install.sh --tag rehearsal-a --repo file:///srv/unai.git')).toHaveLength(2);
    expect(calls.filter(c=>c.script.includes('cmp -s /root/rehearsal/before /root/rehearsal/after'))).toHaveLength(1);
    expect(calls.filter(c=>c.script.startsWith('cat /root/unai-provision.psql '))).toHaveLength(2);
    for(const {script} of calls){
      const result=spawnSync('bash',['-n'],{input:script,encoding:'utf8'});
      expect(result.stderr).toBe('');expect(result.status).toBe(0);
    }
  });
});

describe('in-host configuration',()=>{
  const config=configuration as {parseProvision(text:string):Record<string,string>;replaceAssignments(text:string,values:Record<string,string>):string};
  it('accepts exactly the five generated provisioning passwords',()=>{
    const names=['migrator_password','api_login_password','worker_login_password','auth_login_password','backup_password'];
    const text=names.map(name=>`\\set ${name} '${'a'.repeat(64)}'`).join('\n');
    expect(config.parseProvision(text)).toEqual(Object.fromEntries(names.map(name=>[name,'a'.repeat(64)])));
    expect(()=>config.parseProvision(text.replace('migrator_password','bogus'))).toThrow('REHEARSAL_PROVISION_INVALID');
    expect(()=>config.parseProvision(text+`\n\\set migrator_password '${'b'.repeat(64)}'`)).toThrow('REHEARSAL_PROVISION_INVALID');
  });
  it('replaces only exact active assignments and refuses duplicates',()=>{
    expect(config.replaceAssignments('# X=old\nX=<value>\nOTHER=keep\n',{X:'new'})).toBe('# X=old\nX=new\nOTHER=keep\n');
    expect(()=>config.replaceAssignments('X=1\nX=2\n',{X:'new'})).toThrow('REHEARSAL_CONFIG_INVALID');
    expect(()=>config.replaceAssignments('Y=1\n',{X:'new'})).toThrow('REHEARSAL_CONFIG_INVALID');
    expect(()=>config.replaceAssignments('X=1\n',{X:'bad\nINJECT=1'})).toThrow('REHEARSAL_CONFIG_INVALID');
  });
  it('runs all four preflights and actually unsets the worker endpoint',async()=>{
    const calls:Array<{script:string;report:string}>=[];
    const run={container:'test',command:async()=>'',inside:async(script:string,options:{report?:string}={})=>{
      calls.push({script,report:options.report??''});
      return 'rate_limits secrets database auth_database database_role encryption_at_rest object_store registry_release tls_certificate probe_port origin auth api'
        .split(' ').map(check=>JSON.stringify({check,status:'ok',code:'OK'})).join('\n');
    }};
    const phases=untypedPreflight as Record<string,(value:typeof run)=>Promise<void>>;
    for(const name of ['object-store','secrets','migrate','publish','owner','preflights'])await phases[name]!(run);
    const checks=calls.filter(c=>c.script.includes(' --check'));
    expect(checks).toHaveLength(4);
    expect(checks.filter(c=>c.script.includes('UnsetEnvironment=UNAI_OTEL_EXPORTER_OTLP_ENDPOINT'))).toHaveLength(1);
    expect(checks.filter(c=>c.script.includes('processing-worker.ts'))).toHaveLength(2);
    for(const {script,report} of calls){
      const result=spawnSync('bash',['-n'],{input:script+'\n'+report,encoding:'utf8'});
      expect(result.stderr).toBe('');expect(result.status).toBe(0);
    }
  });
  it('rejects an incomplete S3 launcher invocation without loading the release',()=>{
    const result=spawnSync(process.execPath,['scripts/rehearsal/s3-stand-in.mjs','--bucket','x'],{encoding:'utf8'});
    expect(result.status).toBe(1);expect(result.stderr).toBe('REHEARSAL_S3_FAILED\n');
  });
});
