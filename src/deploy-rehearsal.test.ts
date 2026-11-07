import {describe,expect,it} from 'vitest';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,delimiter} from 'node:path';
import {spawnSync} from 'node:child_process';
import {isConnectorCredentialHandle} from '../packages/connectors/src/index.js';
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
// @ts-expect-error Plain JavaScript operator tooling.
import * as untypedChecks from '../scripts/lib/rehearsal-checks.mjs';
// @ts-expect-error Plain JavaScript operator tooling.
import {servicePhases as untypedServices,show as untypedShow,prelude as untypedPrelude} from '../scripts/rehearsal/services.mjs';
// @ts-expect-error Plain JavaScript operator tooling.
import * as untypedSync from '../scripts/rehearsal/sync.mjs';
// @ts-expect-error Plain JavaScript operator tooling.
import * as untypedDouble from '../scripts/rehearsal/github-double.mjs';

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
    expect(lib.IMPLEMENTED.join(' ')).toBe(`${first} ${later}`);
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
    expect(lib.parseArguments([])).toEqual({until:'browser',keep:false});
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
    expect(lib.parseArguments(['--until','telemetry'])).toEqual({until:'telemetry',keep:false});
    expect(lib.parseArguments(['--until','upgrade']).until).toBe('upgrade');
    expect(lib.parseArguments(['--until','sync'])).toEqual({until:'sync',keep:false});
  });
  const assertions={adapterResolvesOwner:true,apiReadySeconds:4,listening:{port:3443,count:1},
    checks:{encryption_at_rest:'ok',loop:'ok'},failedStart:[{unit:'unai-api',variable:'UNAI_API_TLS_CERT_FILE',
      preflightRefusal:'CONFIG_REQUIRED:UNAI_API_TLS_CERT_FILE',exitStatus:1,restored:true}],bucket:'authentication',cursorPage:null};
  it('accepts phase assertions made of numbers, booleans and status words',()=>{
    expect(lib.validateRecord({...record(),phases:[{...phase(),assertions}]})).toEqual([]);
  });
  const leaked:Array<[string,unknown]>=[
    ['token',{token:'mQ3vX9_pLr2KdT8sYw4bNc6HfJ1gZe0aUi5oVxRtEyA'}],['hostname',{host:'private.example.com'}],
    ['uuid',{owner:'0b9a6f1e-3c2d-4e5f-8a7b-9c0d1e2f3a4b'}],['container id',{container:'3f4e5d6c7b8a9f0e1d2c'}],
    ['hex word',{token:'deadbeefcafe'}],['letter-only hex key',{deadbeefcafe:true}],['free text',{note:'Owner evidence pending'}],
    ['path',{file:'/etc/unai/api.env'}],['large number',{subject:110169484474386276334}],['nested token',{a:[{b:'Bearer SENTINEL'}]}],
    ['array root',[]],['deep',{a:{b:{c:{d:{e:true}}}}}],
  ];
  it.each(leaked)('rejects assertions holding a %s',(_name,value)=>{
    expect(lib.validateRecord({...record(),phases:[{...phase(),assertions:value}]})).toContain('REHEARSAL_RECORD_ASSERTIONS');
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

interface Checks {
  report(text:string,names:string[]):Record<string,string>; count(text:string):number;
  listeningVerdict(text:string,port:number):unknown; checksPassed(text:string,names:string[]):unknown;
  probeVerdict(body:string,kind:string):unknown; httpHead(text:string):{status:number;headers:Record<string,string>};
  securityHeaderProblems(headers:Record<string,string>):string[]; webVerdict(text:string,path:string):unknown;
  plainHttpVerdict(exitCode:number,text:string):unknown; burstVerdict(text:string,limit:number):unknown;
  checkFailVerdict(text:string,variable:string):string; startupFailedVerdict(text:string,frames:number,unit:string,variable:string):string;
  syncVerdict(row:unknown):unknown;
}
const checks=untypedChecks as Checks;
const csp="default-src 'self'; script-src 'self' 'nonce-[REDACTED]' 'strict-dynamic'; style-src 'self' 'unsafe-inline'";
const head=(status:string,extra:string[]=[])=>[`HTTP/1.1 ${status}`,`content-security-policy: ${csp}`,
  'permissions-policy: microphone=(self), camera=()','strict-transport-security: max-age=31536000',...extra].join('\r\n');
describe('rehearsal 2/4 pure helpers',()=>{
  it('splits @@ report sections and refuses repeats or missing names',()=>{
    expect(checks.report('COMMAND_EXIT=0\n@@owner\nFOUND\n@@seconds\n 4 \n',['owner','seconds'])).toEqual({owner:'FOUND',seconds:'4'});
    expect(()=>checks.report('@@owner\nA\n@@owner\nB',['owner'])).toThrow('REHEARSAL_REPORT_INVALID');
    expect(()=>checks.report('@@owner\nA',['owner','seconds'])).toThrow('REHEARSAL_REPORT_INVALID');
    expect(checks.count('0')).toBe(0);
    for(const bad of ['','x','-1','1.5'])expect(()=>checks.count(bad)).toThrow('REHEARSAL_REPORT_INVALID');
  });
  it('counts exactly one listening line of the exact shape',()=>{
    const line='{"event":"listening","port":3443}';
    expect(checks.listeningVerdict(`noise\n${line}\n{"event":"probes","status":"OK"}`,3443)).toEqual({count:1,port:3443});
    for(const text of ['',`${line}\n${line}`,'{"event":"listening","port":9101}','{"event":"listening","port":3443,"host":"x"}'])
      expect(()=>checks.listeningVerdict(text,3443)).toThrow('REHEARSAL_LISTENING_INVALID');
  });
  it('requires every named check ok in order',()=>{
    const names=['rate_limits','origin','tls_certificate','auth','api'];
    const lines=names.map(check=>JSON.stringify({check,status:'ok',code:'OK'}));
    expect(checks.checksPassed(lines.join('\n'),names)).toEqual(Object.fromEntries(names.map(n=>[n,'ok'])));
    const warned=lines.join('\n').replace('{"check":"api","status":"ok","code":"OK"}','{"check":"api","status":"warn","code":"API_UNREACHABLE"}');
    for(const text of [warned,lines.slice(1).join('\n'),[...lines].reverse().join('\n'),lines.join('\n')+'\n'+lines[0]])
      expect(()=>checks.checksPassed(text,names)).toThrow('REHEARSAL_PREFLIGHT_EVIDENCE_INVALID');
  });
  it('accepts only exact probe bodies with status words',()=>{
    expect(checks.probeVerdict('{"status":"ok"}','healthz')).toEqual({status:'ok'});
    expect(checks.probeVerdict('{"status":"ready","checks":{"database":"ok","registry_release":"ok","loop":"ok"}}','worker'))
      .toEqual({status:'ready',checks:{database:'ok',registry_release:'ok',loop:'ok'}});
    for(const [body,kind] of [['{"status":"ok","version":"1"}','healthz'],['not json','healthz'],['{"status":"ok"}','bogus'],
      ['{"status":"not-ready","checks":{"database":"fail","registry_release":"ok","loop":"ok"}}','worker'],
      ['{"status":"ready","checks":{"database":"ok","registry_release":"ok"}}','worker'],
      ['{"status":"ready","checks":{"database":"ok","registry_release":"ok","loop":"ok"}}','api']] as const)
      expect(()=>checks.probeVerdict(body,kind)).toThrow('REHEARSAL_PROBE_INVALID');
  });
  it('parses one response head and finds missing or weak security headers',()=>{
    const parsed=checks.httpHead(head('200 OK'));
    expect(parsed.status).toBe(200);expect(checks.securityHeaderProblems(parsed.headers)).toEqual([]);
    expect(checks.securityHeaderProblems({...parsed.headers,'content-security-policy':csp.replace("'nonce-[REDACTED]' ",'')})).toEqual(['CSP_NONCE_MISSING']);
    expect(checks.securityHeaderProblems({...parsed.headers,'content-security-policy':csp.replace("'strict-dynamic'","'unsafe-inline'")})).toEqual(['CSP_SCRIPT_UNSAFE']);
    expect(checks.securityHeaderProblems({'strict-transport-security':'max-age=300'})).toEqual(['CSP_MISSING','PERMISSIONS_POLICY_MISSING','HSTS_TOO_SHORT']);
    expect(checks.securityHeaderProblems({...parsed.headers,'strict-transport-security':''})).toEqual(['HSTS_MISSING']);
    expect(()=>checks.httpHead('curl: (7) Failed to connect')).toThrow('REHEARSAL_HTTP_RESPONSE_INVALID');
    expect(()=>checks.httpHead(`${head('200 OK')}\r\n${head('200 OK')}`)).toThrow('REHEARSAL_HTTP_RESPONSE_INVALID');
  });
  it('requires /signin 200 and / 307 to /signin, both with security headers',()=>{
    expect(checks.webVerdict(head('200 OK'),'/signin')).toEqual({status:200,securityHeaders:true});
    expect(checks.webVerdict(head('307 Temporary Redirect',['location: /signin']),'/')).toEqual({status:307,signinRedirect:true,securityHeaders:true});
    expect(()=>checks.webVerdict(head('200 OK'),'/')).toThrow('REHEARSAL_WEB_STATUS_INVALID');
    expect(()=>checks.webVerdict(head('307 Temporary Redirect',['location: /elsewhere']),'/')).toThrow('REHEARSAL_WEB_STATUS_INVALID');
    expect(()=>checks.webVerdict(head('200 OK').replace(/permissions-policy[^\r]*\r\n/,''),'/signin')).toThrow('REHEARSAL_PERMISSIONS_POLICY_MISSING');
  });
  it('accepts only an empty reply to plain HTTP on the TLS listener',()=>{
    expect(checks.plainHttpVerdict(52,'curl: (52) Empty reply from server')).toEqual({curlExit:52,httpResponse:false});
    expect(checks.plainHttpVerdict(56,'curl: (56) Recv failure')).toEqual({curlExit:56,httpResponse:false});
    for(const [code,text] of [[0,'HTTP/1.1 426 Upgrade Required'],[52,'HTTP/1.1 400 Bad Request'],[7,'curl: (7) Failed']] as const)
      expect(()=>checks.plainHttpVerdict(code,text)).toThrow('REHEARSAL_PLAIN_HTTP_ANSWERED');
  });
  it('requires exactly limit authentication failures and then one address 429',()=>{
    const fail='401 - - AUTHENTICATION_REQUIRED 1',limited='429 37 authentication RATE_LIMITED 1';
    const burst=(n:number,last=limited)=>[...Array.from({length:n},()=>fail),last].join('\n');
    expect(checks.burstVerdict(burst(3),3)).toEqual({limit:3,unauthorized:3,status:429,retryAfter:37,bucket:'authentication',code:'RATE_LIMITED',hsts:true});
    for(const [text,limit] of [[burst(2),3],[burst(4),3],[burst(3,'429 0 authentication RATE_LIMITED 1'),3],
      [burst(3,'429 61 authentication RATE_LIMITED 1'),3],[burst(3,'429 37 session RATE_LIMITED 1'),3],[burst(3,fail),3],
      [burst(3).replace(fail,'403 - - ACCESS_DENIED 1'),3],[burst(3).replace(/ 1$/m,' 0'),3],[burst(0),0]] as const)
      expect(()=>checks.burstVerdict(text,limit)).toThrow('REHEARSAL_BURST_INVALID');
  });
  it('requires a single preflight refusal naming the removed variable',()=>{
    const ok='{"check":"rate_limits","status":"ok","code":"OK"}',fail='{"check":"tls_certificate","status":"fail","code":"CONFIG_REQUIRED:UNAI_API_TLS_CERT_FILE"}';
    expect(checks.checkFailVerdict(`${ok}\n${fail}`,'UNAI_API_TLS_CERT_FILE')).toBe('CONFIG_REQUIRED:UNAI_API_TLS_CERT_FILE');
    for(const text of [ok,`${fail}\n${fail}`,fail.replace('TLS_CERT','TLS_KEY'),fail.replace('}',',"detail":"x"}')])
      expect(()=>checks.checkFailVerdict(text,'UNAI_API_TLS_CERT_FILE')).toThrow('REHEARSAL_PREFLIGHT_REFUSAL_INVALID');
  });
  it('requires one startup_failed line naming the variable, without stack frames',()=>{
    const api='{"event":"startup_failed","code":"API_STARTUP_FAILED","cause":"CONFIG_REQUIRED:UNAI_API_TLS_CERT_FILE"}';
    const worker='{"event":"startup_failed","code":"PROCESSING_CONFIGURATION_REQUIRED:UNAI_PROCESSING_OWNER_SCOPE_ID","variable":"UNAI_PROCESSING_OWNER_SCOPE_ID"}';
    expect(checks.startupFailedVerdict(api,0,'unai-api','UNAI_API_TLS_CERT_FILE')).toBe('CONFIG_REQUIRED:UNAI_API_TLS_CERT_FILE');
    expect(checks.startupFailedVerdict(api.replace('API_STARTUP','WEB_STARTUP').replace('API_TLS','WEB_TLS'),0,'unai-web','UNAI_WEB_TLS_CERT_FILE')).toBe('CONFIG_REQUIRED:UNAI_WEB_TLS_CERT_FILE');
    expect(checks.startupFailedVerdict(worker,0,'unai-worker','UNAI_PROCESSING_OWNER_SCOPE_ID')).toBe('PROCESSING_CONFIGURATION_REQUIRED:UNAI_PROCESSING_OWNER_SCOPE_ID');
    for(const [text,frames,unit] of [[api,1,'unai-api'],[`${api}\n${api}`,0,'unai-api'],[api,0,'unai-web'],['',0,'unai-api'],
      [api.replace('CONFIG_REQUIRED:UNAI_API_TLS_CERT_FILE','UNCLASSIFIED'),0,'unai-api'],[worker.replace('"variable":"UNAI_PROCESSING_OWNER_SCOPE_ID"','"variable":null'),0,'unai-worker'],
      [api,0,'unai-backup']] as const)
      expect(()=>checks.startupFailedVerdict(text,frames,unit,'UNAI_API_TLS_CERT_FILE')).toThrow('REHEARSAL_STARTUP_FAILED_INVALID');
  });
  const row={jobs:1,status:'SUCCEEDED',scheduled:true,attempts:1,jobErrorClear:true,evidence:3,connectorType:'GITHUB',
    connectorStatus:'ACTIVE',cursorAdvanced:true,cursorPage:2,syncErrorClear:true,issuesServed:1,commentsServed:1,unauthorized:0};
  it('accepts one scheduler-enqueued, succeeded sync with evidence and an advanced cursor',()=>{
    expect(checks.syncVerdict(row)).toEqual(row);
    expect(checks.syncVerdict({...row,extra:'x'})).toEqual(row);
  });
  it.each(Object.entries({jobs:2,status:'DEAD_LETTER',scheduled:false,attempts:0,jobErrorClear:false,evidence:0,connectorType:'GMAIL',
    connectorStatus:'SYNC_FAILED',cursorAdvanced:false,cursorPage:1,syncErrorClear:false,issuesServed:0,commentsServed:-1,unauthorized:1}))
  ('refuses a sync with %s %j',(key,value)=>expect(()=>checks.syncVerdict({...row,[key]:value})).toThrow('REHEARSAL_SYNC_INVALID'));
});

type PhaseRun={container:string;phase:{name:string;assertions?:Record<string,unknown>};command:()=>Promise<string>;
  inside:(script:string,options?:{report?:string})=>Promise<string>};
type Phase=(run:PhaseRun)=>Promise<void>;
const phases2=untypedServices as Record<string,Phase>;
function mockRun(name:string,answer:(script:string)=>string){
  const calls:Array<{script:string;report:string}>=[];
  const run:PhaseRun={container:'test',phase:{name},command:async()=>'',inside:async(script,options={})=>{
    calls.push({script,report:options.report??''});return `COMMAND_EXIT=0\n${answer(script)}`;
  }};
  return {run,calls};
}
function shellSyntax(calls:Array<{script:string;report:string}>){
  for(const {script,report} of calls){
    const result=spawnSync('bash',['-n'],{input:script+'\n'+report,encoding:'utf8'});
    expect(result.stderr).toBe('');expect(result.status).toBe(0);
  }
}
const recordWith=(name:string,assertions:unknown)=>({...record(),phases:[{...phase(name),assertions}]});
const subject='110169484474386276334';
describe('rehearsal 2/4 auth seam',()=>{
  const text=readFileSync('scripts/rehearsal/auth-seam.mjs','utf8');
  function release(){
    const directory=mkdtempSync(join(tmpdir(),'unai-seam-'));
    mkdirSync(join(directory,'node_modules/@unai/auth'),{recursive:true});mkdirSync(join(directory,'lib'));
    writeFileSync(join(directory,'node_modules/@unai/auth/package.json'),JSON.stringify({name:'@unai/auth',type:'module',exports:'./index.js'}));
    writeFileSync(join(directory,'node_modules/@unai/auth/index.js'),[
      "import {appendFileSync} from 'node:fs';",
      'const log=value=>appendFileSync("calls",JSON.stringify(value)+"\\n");',
      'export function postgresAdapter(pool){return {',
      ` async getUserByAccount(account){log(["lookup",account]);return account.providerAccountId==="${subject}"?{id:"actor-id",ownerScopeId:"scope-id"}:null;},`,
      ' async createSession(session){log(["session",session.userId,session.sessionToken.length,Math.round((session.expires-Date.now())/60000)]);return session;}};}'].join('\n'));
    writeFileSync(join(directory,'lib/server.ts'),"import {appendFileSync} from 'node:fs';\nexport async function authPool(){return {end:async()=>appendFileSync('calls','[\"end\"]\\n')};}\n");
    return directory;
  }
  const seam=(directory:string,lines:string[])=>{
    const result=spawnSync(process.execPath,['--input-type=module','-e',text],{cwd:directory,input:lines.join('\n')+'\n',encoding:'utf8'});
    const calls=existsSync(join(directory,'calls'))?readFileSync(join(directory,'calls'),'utf8').trim().split('\n').map(line=>JSON.parse(line)):[];
    rmSync(directory,{recursive:true,force:true});
    return {...result,calls};
  };
  it('holds no dollar or percent sign for systemd-run and reads no environment',()=>{
    expect(text).not.toMatch(/[$%]/);expect(text).not.toMatch(/process\s*\.\s*env/);
  });
  it('names no relative specifier: lib/server.ts exists only in the installed web app',()=>{
    expect(text).not.toMatch(/(?:\bfrom|\bimport\s*\()\s*['"]\.{1,2}\//);
  });
  it.each([[[subject,'scope-id','actor-id'],'FOUND'],[[subject,'other-scope','actor-id'],'MISMATCH'],
    [[subject,'scope-id','other-actor'],'MISMATCH'],[['1','scope-id','actor-id'],'MISSING']])
  ('answers the owner check for %j with %s through the adapter',(values,word)=>{
    const result=seam(release(),['check',...values]);
    expect(result.status).toBe(0);expect(result.stdout).toBe(`${word}\n`);
    expect(result.calls).toEqual([['lookup',{provider:'google',providerAccountId:values[0]}],['end']]);
  });
  it('mints a one-hour session for the owner only and prints only its token',()=>{
    const minted=seam(release(),['session',subject,'scope-id','actor-id']);
    expect(minted.status).toBe(0);expect(minted.stdout).toMatch(/^[A-Za-z0-9_-]{43}\n$/);
    expect(minted.calls.slice(1)).toEqual([['session','actor-id',43,60],['end']]);
    for(const lines of [['session',subject,'other-scope','actor-id'],['delete',subject,'scope-id','actor-id']]){
      const refused=seam(release(),lines);
      expect(refused.status).toBe(1);expect(refused.stdout).toBe('');
      expect(refused.stderr).toContain('REHEARSAL_AUTH_SEAM_FAILED');
      expect(refused.calls.filter(call=>call[0]==='session')).toEqual([]);
    }
  });
});
describe('rehearsal 2/4 service phases',()=>{
  it('keeps every report header on its own line after a body without a final newline',()=>{
    const directory=mkdtempSync(join(tmpdir(),'unai-show-')).replace(/\\/g,'/');
    writeFileSync(join(directory,'api-healthz'),'{"status":"ok"}');writeFileSync(join(directory,'api-readyz'),'{"status":"ready"}\n');
    const text=(untypedShow as (...names:string[])=>string)('api-healthz','api-readyz','missing').replaceAll('/root/rehearsal',directory);
    const result=spawnSync('bash',['-c',text],{encoding:'utf8'});rmSync(directory,{recursive:true,force:true});
    expect(result.status).toBe(0);
    expect(checks.report(result.stdout,['api-healthz','api-readyz','missing'])).toEqual({'api-healthz':'{"status":"ok"}','api-readyz':'{"status":"ready"}',missing:''});
  });
  const webNames=['rate_limits','origin','tls_certificate','auth','api'];
  const servicesReport=(word='FOUND',after='1')=>['@@owner-word',word,'@@api-ready-seconds','4','@@api-listening','{"event":"listening","port":3443}',
    '@@web-check',...webNames.map(check=>JSON.stringify({check,status:'ok',code:'OK'})),'@@web-invocation-changed','1',
    '@@web-after-api',after,'@@worker-ready-seconds','6','@@worker-last','1'].join('\n');
  it('checks the owner first, then starts the API, restarts the web after API readiness and starts the worker last',async()=>{
    const {run,calls}=mockRun('services',()=>servicesReport());
    await phases2.services!(run);
    expect(run.phase.assertions).toEqual({adapterResolvesOwner:true,apiReadySeconds:4,listening:{count:1,port:3443},
      webChecks:Object.fromEntries(webNames.map(name=>[name,'ok'])),webInvocationChanged:true,webRestartedAfterApiReady:true,
      workerReadySeconds:6,workerStartedLast:true});
    const at=(text:string)=>calls.findIndex(call=>call.script.includes(text));
    expect(at('seam check')).toBe(0);
    expect(at('enable --now unai-api.service')).toBe(1);
    expect(at('server.ts --check')).toBeLessThan(at('systemctl restart unai-web.service'));
    expect(at('systemctl restart unai-web.service')).toBeLessThan(at('enable --now unai-worker.service'));
    expect(lib.validateRecord(recordWith('services',run.phase.assertions))).toEqual([]);
    shellSyntax(calls);
    for(const {script} of calls)expect(script).not.toMatch(new RegExp(`${subject}|rehearsal\\.invalid`));
  });
  it('refuses an unresolved owner before starting any service, and a web restart before API readiness',async()=>{
    for(const word of ['MISSING','MISMATCH']){
      const {run,calls}=mockRun('services',()=>servicesReport(word));
      await expect(phases2.services!(run)).rejects.toThrow('REHEARSAL_OWNER_UNRESOLVED');
      expect(calls).toHaveLength(1);
    }
    const {run}=mockRun('services',()=>servicesReport('FOUND','0'));
    await expect(phases2.services!(run)).rejects.toThrow('REHEARSAL_SERVICE_ORDER_INVALID');
  });
  it('records the four probe bodies as status words',async()=>{
    const api='{"status":"ready","checks":{"database":"ok","encryption_at_rest":"ok","object_store":"ok","registry_release":"ok","tls_certificate":"ok"}}';
    const worker='{"status":"ready","checks":{"database":"ok","registry_release":"ok","loop":"ok"}}';
    const {run,calls}=mockRun('probes',()=>`@@api-healthz\n{"status":"ok"}\n@@api-readyz\n${api}\n@@worker-healthz\n{"status":"ok"}\n@@worker-readyz\n${worker}`);
    await phases2.probes!(run);
    expect(run.phase.assertions).toEqual({api:{healthz:{status:'ok'},readyz:JSON.parse(api)},worker:{healthz:{status:'ok'},readyz:JSON.parse(worker)}});
    expect(lib.validateRecord(recordWith('probes',run.phase.assertions))).toEqual([]);
    shellSyntax(calls);
  });
  it('records web headers, the plain-HTTP refusal and the burst without a hostname or token',async()=>{
    const burst=[...Array.from({length:3},()=>'401 - - AUTHENTICATION_REQUIRED 1'),'429 41 authentication RATE_LIMITED 1'].join('\n');
    const lf=(text:string)=>text.replace(/\r/g,'');
    const {run,calls}=mockRun('smoke',()=>[`@@web-root\n${lf(head('307 Temporary Redirect',['location: /signin']))}`,
      `@@web-signin\n${lf(head('200 OK'))}`,'@@plain-exit\n52\n@@plain-http','@@burst-limit\n3',`@@burst\n${burst}`].join('\n'));
    await phases2.smoke!(run);
    expect(run.phase.assertions).toEqual({web:{root:{status:307,signinRedirect:true,securityHeaders:true},signin:{status:200,securityHeaders:true}},
      plainHttp:{curlExit:52,httpResponse:false},burst:{limit:3,unauthorized:3,status:429,retryAfter:41,bucket:'authentication',code:'RATE_LIMITED',hsts:true},
      unauthenticated:{status:401,code:'AUTHENTICATION_REQUIRED',hsts:true}});
    expect(lib.validateRecord(recordWith('smoke',run.phase.assertions))).toEqual([]);
    expect(calls[0]!.script).not.toContain(' -k');expect(calls[0]!.script).toContain('--cacert "$web_cert"');
    shellSyntax(calls);
  });
  it('fails each unit twice with one variable removed and restores it',async()=>{
    const answer=(script:string)=>{
      const [name,variable]=([['worker','UNAI_PROCESSING_OWNER_SCOPE_ID'],['web','UNAI_WEB_TLS_CERT_FILE'],['api','UNAI_API_TLS_CERT_FILE']] as const)
        .find(([,name])=>script.includes(`'^${name}='`))!;
      const startup=name==='worker'?JSON.stringify({event:'startup_failed',code:`PROCESSING_CONFIGURATION_REQUIRED:${variable}`,variable})
        :JSON.stringify({event:'startup_failed',code:`${name.toUpperCase()}_STARTUP_FAILED`,cause:`CONFIG_REQUIRED:${variable}`});
      const refusal=name==='worker'?startup:JSON.stringify({check:'tls_certificate',status:'fail',code:`CONFIG_REQUIRED:${variable}`});
      return `@@refusal\n${refusal}\n@@startup\n${startup}\n@@failed-frames\n0\n@@failed-status\n1\n@@failed-restored\n1`;
    };
    const {run,calls}=mockRun('failed-start',answer);
    await phases2['failed-start']!(run);
    const units=(run.phase.assertions as {units:Array<Record<string,unknown>>}).units;
    expect(units.map(unit=>[unit.unit,unit.variable,unit.preflightRefusal,unit.startupFailed,unit.exitStatus,unit.restored])).toEqual([
      ['unai-api','UNAI_API_TLS_CERT_FILE','CONFIG_REQUIRED:UNAI_API_TLS_CERT_FILE','CONFIG_REQUIRED:UNAI_API_TLS_CERT_FILE',1,true],
      ['unai-web','UNAI_WEB_TLS_CERT_FILE','CONFIG_REQUIRED:UNAI_WEB_TLS_CERT_FILE','CONFIG_REQUIRED:UNAI_WEB_TLS_CERT_FILE',1,true],
      ['unai-worker','UNAI_PROCESSING_OWNER_SCOPE_ID','PROCESSING_CONFIGURATION_REQUIRED:UNAI_PROCESSING_OWNER_SCOPE_ID','PROCESSING_CONFIGURATION_REQUIRED:UNAI_PROCESSING_OWNER_SCOPE_ID',1,true]]);
    expect(lib.validateRecord(recordWith('failed-start',run.phase.assertions))).toEqual([]);
    for(const {script} of calls){
      expect(script).toContain('Restart=no');expect(script).toContain("printf 'ExecStartPre=\\n'");
      expect(script.indexOf('reset-failed')).toBeLessThan(script.indexOf('is-failed'));
    }
    shellSyntax(calls);
    const {run:stuck}=mockRun('failed-start',script=>answer(script).replace('@@failed-status\n1','@@failed-status\n143'));
    await expect(phases2['failed-start']!(stuck)).rejects.toThrow('REHEARSAL_FAILED_START_INVALID');
  });
});

interface SyncChecks {
  doubleCounts(text:string):Record<string,number>; schedulerPasses(text:string):Array<Record<string,number>>;
  leakVerdict(text:string):Record<string,unknown>;
}
const leakLines=(changes:Record<string,string>={})=>Object.entries({needles:'2','owner-check':'1','session-mint':'1',cmdline:'9',
  journal:'0',database:'0',record:'0',...changes}).map(([name,value])=>`${name} ${value}`).join('\n');
const syncChecks=untypedChecks as SyncChecks;
interface Answer {route:string;status:number;authorized:boolean;body:unknown}
const double=untypedDouble as {route(input:Record<string,unknown>):Answer;logLine(answer:Answer):string};
const fixture=JSON.parse(readFileSync('fixtures/sources/github-issue-thread.json','utf8')) as
  {repository:{full_name:string};issue:Record<string,unknown>&{number:number};comments:unknown[]};
const doubleLine=(route:string,status:number,authorized:boolean)=>JSON.stringify({event:'github.double',route,status,authorized});
// Two owner scopes for the connector credential namespace (ADR 0013): the rehearsal's own and a stranger's.
const SAMPLE='0193a4b2-6c7d-7e8f-9a0b-1c2d3e4f5a6b',OTHER='0193a4b2-6c7d-7e8f-9a0b-1c2d3e4f5a6c';
interface SyncNames {OWNER_SCOPE:string;TOKEN_NAME:string;TOKEN_HANDLE:string;syncScript:string;leakScript:string}
const syncNames=untypedSync as SyncNames;
describe('rehearsal 2/4 GitHub double',()=>{
  const base=`/repos/${fixture.repository.full_name}/issues`,token='a'.repeat(48);
  const ask=(url:string,authorization:string|undefined=`Bearer ${token}`,method='GET')=>double.route({method,url,authorization,token,fixture});
  it('serves the fixture issue without pull_request on page 1 and nothing after it',()=>{
    const {pull_request:_pull,...issue}=fixture.issue;
    expect(fixture.issue).toHaveProperty('pull_request');
    expect(ask(`${base}?state=all&per_page=50&page=1`)).toEqual({route:'issues',status:200,authorized:true,body:[issue]});
    expect(ask(`${base}?state=all&per_page=50&page=2`)).toEqual({route:'issues',status:200,authorized:true,body:[]});
    expect(ask(`${base}/${fixture.issue.number}/comments?per_page=100`)).toEqual({route:'comments',status:200,authorized:true,body:fixture.comments});
  });
  it('refuses a wrong or missing bearer and answers 404 off its two routes',()=>{
    for(const authorization of [`Bearer ${'b'.repeat(48)}`,token,`Bearer ${token} `])
      expect(ask(`${base}?page=1`,authorization)).toMatchObject({route:'issues',status:401,authorized:false});
    expect(double.route({method:'GET',url:`${base}?page=1`,token,fixture})).toMatchObject({route:'issues',status:401,authorized:false});
    expect(double.route({method:'GET',url:`${base}?page=1`,authorization:'Bearer ',token:'',fixture})).toMatchObject({status:401,authorized:false});
    for(const url of [`${base}/1/comments`,`/repos/other/repo/issues?page=1`,`/repos/${fixture.repository.full_name}/pulls/412/commits`,'/rehearsal-probe'])
      expect(ask(url)).toMatchObject({route:'none',status:404});
    expect(ask(`${base}?page=1`,`Bearer ${token}`,'POST')).toMatchObject({route:'none',status:404});
  });
  it('logs the route word, status and match only, and reads no environment',()=>{
    const answer=ask(`${base}?page=1`);
    expect(JSON.parse(double.logLine(answer))).toEqual({event:'github.double',route:'issues',status:200,authorized:true});
    expect(double.logLine(answer)).not.toContain(token);
    expect(readFileSync('scripts/rehearsal/github-double.mjs','utf8')).not.toMatch(/process\s*\.\s*env|headers\)|console\./);
  });
});
describe('rehearsal 2/4 sync helpers',()=>{
  it('counts served pages and refusals from the double lines only',()=>{
    const text=['noise',doubleLine('none',404,false),doubleLine('issues',200,true),doubleLine('comments',200,true),
      doubleLine('issues',401,false),'{"event":"other"}'].join('\n');
    expect(syncChecks.doubleCounts(text)).toEqual({issuesServed:1,commentsServed:1,unauthorized:1});
    expect(syncChecks.doubleCounts('')).toEqual({issuesServed:0,commentsServed:0,unauthorized:0});
    for(const bad of ['{"event":"github.double","route":"issues","status":200,"authorized":true,"token":"x"}',
      doubleLine('pulls',200,true),'{"event":"github.double","route":"issues","status":"200","authorized":true}'])
      expect(()=>syncChecks.doubleCounts(bad)).toThrow('REHEARSAL_DOUBLE_LOG_INVALID');
  });
  it('reads scheduler passes and refuses the disabled line',()=>{
    const pass='{"event":"connector.scheduler","enqueued":1,"alreadyQueued":0,"skipped":0}';
    expect(syncChecks.schedulerPasses(`x\n${pass}\n${pass}`)).toEqual([{enqueued:1,alreadyQueued:0,skipped:0},{enqueued:1,alreadyQueued:0,skipped:0}]);
    for(const bad of ['{"event":"connector.scheduler","status":"CONNECTOR_SCHEDULER_DISABLED"}',
      '{"event":"connector.scheduler","enqueued":-1,"alreadyQueued":0,"skipped":0}'])
      expect(()=>syncChecks.schedulerPasses(bad)).toThrow('REHEARSAL_SCHEDULER_LOG_INVALID');
  });
  it('passes two needles, every control seen and zero matches, and tells a leak from a malformed probe',()=>{
    expect(syncChecks.leakVerdict(`${leakLines()}\n`)).toEqual({needles:2,controls:{ownerCheck:1,sessionMint:1,cmdline:9},journal:0,database:0,record:0});
    for(const name of ['journal','database','record'])
      expect(()=>syncChecks.leakVerdict(leakLines({[name]:'3'}))).toThrow('REHEARSAL_SECRET_LEAKED');
    const lines=leakLines().split('\n');
    for(const bad of [leakLines({needles:'1'}),leakLines({'owner-check':'0'}),leakLines({'session-mint':'0'}),leakLines({cmdline:'0'}),
      leakLines({journal:'x'}),leakLines({journal:'-1'}),leakLines({record:'0 0'}),lines.slice(0,-1).join('\n'),
      [lines[1],lines[0],...lines.slice(2)].join('\n'),`${leakLines()}\nrecord 0`,''])
      expect(()=>syncChecks.leakVerdict(bad)).toThrow('REHEARSAL_LEAK_PROBE_INVALID');
  });
});
// The leak probe and the seam run as bash does in the host (`bash -euo pipefail -s`), with
// journalctl, sudo and systemd-run replaced by shell functions. Linux only: the host's GNU tools (stat -c).
describe.skipIf(process.platform!=='linux')('rehearsal 2/4 leak probe and seam words in bash',()=>{
  const {leakScript}=untypedSync as {leakScript:string};
  const githubToken='0123456789abcdef'.repeat(3),sessionToken=`${'Ab9_-'.repeat(8)}xyz`;
  const entry=(...fields:string[])=>`__CURSOR=s=${fields.length}\n${fields.join('\n')}\n\n`;
  const journal=[entry('_CMDLINE=/sbin/init','MESSAGE=Started run-u7.service - rehearsal-owner-check.'),
    entry('_CMDLINE=/sbin/init',`MESSAGE=Started run-r${'0a'.repeat(16)}.service - rehearsal-session-mint.`),
    entry('_CMDLINE=/usr/local/bin/node github-double.mjs /root/rehearsal/github-token','MESSAGE={"event":"github.double"}')].join('');
  const connectorRow=(error='\\N',handle=`secret://mounted/connectors/${SAMPLE}/github`)=>
    `COPY public.connectors (id, secret_ref, last_sync_error) FROM stdin;\nc1\t${handle}\t${error}\n\\.\n`;
  // envval answers only the worker's owner scope, and silently: the calls file records the capture tools alone.
  const envval=(scope:string)=>`envval(){ [ "$1 $2" = 'worker UNAI_PROCESSING_OWNER_SCOPE_ID' ] && printf '%s\\n' '${scope}'; }`;
  // journalctl -o export writes a value holding a newline or a control byte as name, LE64 length, bytes.
  const binary=(name:string,value:string)=>{
    const length=Buffer.alloc(8);length.writeBigUInt64LE(BigInt(Buffer.byteLength(value)));
    return Buffer.concat([Buffer.from(`__CURSOR=s=9\n${name}\n`),length,Buffer.from(`${value}\n\n`)]);
  };
  function probe(files:Record<string,string|Buffer|null>={},scope=SAMPLE){
    const directory=mkdtempSync(join(tmpdir(),'unai-leak-')),path=(name:string)=>join(directory,name);
    const contents:Record<string,string|Buffer|null>={'github-token':`${githubToken}\n`,'session-token':`${sessionToken}\n`,
      'record-copy.json':'{"format":"unai-deploy-rehearsal/1"}',journal,dump:connectorRow(),...files};
    for(const [name,value] of Object.entries(contents))if(value!==null)writeFileSync(path(name),value);
    const stubs=`journalctl(){ echo "journalctl $*" >> ${path('calls')}; [ "$1" = --sync ] || cat ${path('journal')}; }
sudo(){ echo "sudo $*" >> ${path('calls')}; cat ${path('dump')}; }
${envval(scope)}`;
    const result=spawnSync('bash',['-euo','pipefail','-s'],{input:`${stubs}\n${leakScript.replaceAll('/root/rehearsal',directory)}`,encoding:'utf8'});
    const read=(name:string)=>existsSync(path(name))?readFileSync(path(name),'utf8'):null;
    const outcome={status:result.status,leaks:read('leaks'),calls:read('calls'),
      left:['leak-needles','leak-journal','leak-database','record-copy.json'].filter(name=>existsSync(path(name)))};
    rmSync(directory,{recursive:true,force:true});
    return outcome;
  }
  it('counts nothing in a clean capture that holds both seam units and _CMDLINE, then removes every copy',()=>{
    const result=probe();
    expect(result.status).toBe(0);
    expect(result.leaks).toBe('needles 2\nowner-check 1\nsession-mint 1\ncmdline 3\njournal 0\ndatabase 0\nrecord 0\n');
    expect(syncChecks.leakVerdict(result.leaks!)).toEqual({needles:2,controls:{ownerCheck:1,sessionMint:1,cmdline:3},journal:0,database:0,record:0});
    expect(result.calls).toBe('journalctl --sync\njournalctl -o export --no-pager\nsudo -u postgres pg_dump -d unai --data-only\n');
    expect(result.left).toEqual([]);
  });
  it.each([
    ['a GitHub token in _CMDLINE','journal',{journal:journal+entry(`_CMDLINE=/usr/bin/curl -H authorization:${githubToken}`,'MESSAGE=x')}],
    ['a session token in a binary field','journal',{journal:Buffer.concat([Buffer.from(journal),binary('MESSAGE',`cookie\n__Host-unai.session=${sessionToken}\0`)])}],
    ['a GitHub token in the database','database',{dump:connectorRow(githubToken)}],
    ['a session token in the record','record',{'record-copy.json':JSON.stringify({format:'unai-deploy-rehearsal/1',tail:sessionToken})}],
    ['a session token read from a file with CRLF and padding','journal',{'session-token':` ${sessionToken}\r\n`,journal:journal+entry(`MESSAGE=${sessionToken}`)}],
  ])('reports %s as a %s match',(_name,where,files)=>{
    const result=probe(files);
    expect(result.status).toBe(0);
    expect(result.leaks).toMatch(new RegExp(`^${where} 1$`,'m'));
    expect(()=>syncChecks.leakVerdict(result.leaks!)).toThrow('REHEARSAL_SECRET_LEAKED');
    expect(result.left).toEqual([]);
  });
  it.each([
    ['a missing token file',{'session-token':null},''],
    ['a token of the wrong length',{'github-token':`${githubToken.slice(1)}\n`},''],
    ['an empty token file, which would match every line',{'github-token':''},''],
    ['a missing record copy (grep status 2)',{'record-copy.json':null},'database 0'],
    ['a capture without the session mint Started line',{journal:journal.replace('rehearsal-session-mint','rehearsal-auth-seam')},'session-mint 0'],
    ['an empty capture',{journal:''},'owner-check 0'],
    ['a dump without this run\'s connector row',{dump:'COPY public.connectors (id, secret_ref, last_sync_error) FROM stdin;\n\\.\n'},'record 0'],
    ['a dump whose only connector row names the flat legacy handle',{dump:connectorRow('\\N','secret://mounted/connectors-github')},'record 0'],
    ['a dump whose only connector row names another owner\'s namespace',{dump:connectorRow('\\N',`secret://mounted/connectors/${OTHER}/github`)},'record 0'],
    ['a record copy that is not the record',{'record-copy.json':'{"phases":[{"format":"unai-deploy-rehearsal/1"}]}'},'record 0'],
  ])('fails the phase on %s',(_name,files,last)=>{
    const result=probe(files);
    expect(result.status).not.toBe(0);
    expect((result.leaks??'').trim().split('\n').at(-1)).toBe(last);
    expect(result.left).toEqual([]);
  });
  it.each(['not-a-uuid','',SAMPLE.toUpperCase(),`${SAMPLE}/..`])('refuses the owner scope %j before any capture',scope=>{
    const result=probe({},scope);
    expect(result.status).not.toBe(0);
    expect(result.leaks).toBeNull();expect(result.calls).toBeNull();expect(result.left).toEqual([]);
  });
  // The trigger's body line, run as the host runs it: the handle is built from the validated scope inside the host.
  it.each([[SAMPLE,true],['not-a-uuid',false],['',false],[SAMPLE.toUpperCase(),false]] as const)(
    'builds the connector body from the owner scope %j only when it is a lowercase UUID',(scope,valid)=>{
      const line=syncNames.syncScript.split('\n').filter(text=>text.startsWith('printf ')&&text.includes('/connector-body'));
      expect(line).toHaveLength(1);
      const directory=mkdtempSync(join(tmpdir(),'unai-body-')),body=join(directory,'connector-body');
      const result=spawnSync('bash',['-euo','pipefail','-s'],
        {input:`${envval(scope)}\n${syncNames.OWNER_SCOPE}\n${line[0]!.replaceAll('/root/rehearsal',directory)}`,encoding:'utf8'});
      const written=existsSync(body)?readFileSync(body,'utf8'):null;
      rmSync(directory,{recursive:true,force:true});
      if(!valid){expect(result.status).not.toBe(0);expect(written).toBeNull();return;}
      expect(result.stderr).toBe('');expect(result.status).toBe(0);
      expect(JSON.parse(written!)).toEqual({connectorType:'GITHUB',externalAccountRef:'example-org/uai-reference',
        secretRef:`secret://mounted/connectors/${SAMPLE}/github`,requestedCapabilities:[{capabilityId:'github.read_issues',granted:true}]});
    });
  it('runs each seam mode as a unit with its own description and passes the values on stdin only',()=>{
    const directory=mkdtempSync(join(tmpdir(),'unai-seam-words-')),path=(name:string)=>join(directory,name);
    writeFileSync(path('web.env'),`NEXTAUTH_URL=https://rehearsal.invalid\nUNAI_WEB_TLS_CERT_FILE=${path('cert.pem')}\nUNAI_WEB_OWNER_GOOGLE_SUBJECT=${subject}\n`);
    writeFileSync(path('worker.env'),'UNAI_PROCESSING_OWNER_SCOPE_ID=scope-id\nUNAI_PROCESSING_ACTOR_ID=actor-id\n');
    writeFileSync(path('auth-seam.mjs'),'seam source');
    const stub=`systemd-run(){ printf '%s\\n' "$@" -- >> ${path('argv')}; cat >> ${path('stdin')}; }`;
    const text=(untypedPrelude as string).replaceAll('/etc/unai/',`${directory}/`).replaceAll('/usr/local/lib/unai-rehearsal/',`${directory}/`);
    const result=spawnSync('bash',['-euo','pipefail','-s'],{input:`${stub}\n${text}\nseam check\nseam session\nseam delete || echo "refused $?"`,encoding:'utf8'});
    const argv=readFileSync(path('argv'),'utf8').split(/^--$/m).map(part=>part.trim()).filter(Boolean).map(part=>part.split('\n'));
    const stdin=readFileSync(path('stdin'),'utf8');
    rmSync(directory,{recursive:true,force:true});
    expect(result.stderr).toBe('');expect(result.status).toBe(0);expect(result.stdout).toBe('refused 2\n');
    expect(argv).toHaveLength(2);
    expect(argv.map(args=>args.filter(arg=>arg.startsWith('--description=')))).toEqual([['--description=rehearsal-owner-check'],['--description=rehearsal-session-mint']]);
    expect(argv.map(args=>args.at(-1))).toEqual(['seam source','seam source']);
    expect(stdin).toBe(`check\n${subject}\nscope-id\nactor-id\nsession\n${subject}\nscope-id\nactor-id\n`);
    for(const args of argv)expect(args.join(' ')).not.toMatch(new RegExp(`${subject}|scope-id|actor-id`));
  });
});
describe('rehearsal 2/4 sync phase',()=>{
  const sync=(untypedSync as {syncPhases:Record<string,Phase>}).syncPhases.sync!;
  const pass='{"event":"connector.scheduler","enqueued":1,"alreadyQueued":0,"skipped":0}';
  const row={jobs:1,status:'SUCCEEDED',scheduled:true,attempts:1,jobErrorClear:true,lastError:null,evidence:3,connectorType:'GITHUB',
    connectorStatus:'ACTIVE',cursorAdvanced:true,cursorPage:2,syncErrorClear:true,syncError:null};
  const lines=[doubleLine('none',404,false),doubleLine('issues',200,true),doubleLine('comments',200,true)].join('\n');
  function syncRun(options:{row?:Record<string,unknown>;passes?:string[];leaks?:string}={}){
    const directory=mkdtempSync(join(tmpdir(),'unai-sync-')),commands:string[][]=[],copies:string[]=[];
    const {run,calls}=mockRun('sync',script=>script.includes('rehearsal-github-ca')?''
      :script.includes('seam session')?['@@connector-status','201','@@scheduler-lines',...(options.passes??[pass,pass]),
        '@@sync-row',JSON.stringify(options.row??row),'@@double-lines',lines].join('\n')
      :`@@leaks\n${options.leaks??leakLines()}`);
    const full=Object.assign(run,{record:record(),directory,command:async(file:string,args:string[])=>{
      commands.push([file,...args]);
      if(args[0]==='cp'&&String(args[1]).endsWith('record-copy.json'))copies.push(readFileSync(String(args[1]),'utf8'));
      return '';
    }});
    return {run:full as unknown as PhaseRun&{record:Record<string,unknown>},calls,commands,copies,directory};
  }
  it('creates the connector, restarts the worker twice in one window and records counts only',async()=>{
    const {run,calls,commands,copies,directory}=syncRun();
    await sync(run);
    expect(run.phase.assertions).toEqual({jobs:1,status:'SUCCEEDED',scheduled:true,jobErrorClear:true,connectorType:'GITHUB',
      connectorStatus:'ACTIVE',cursorAdvanced:true,cursorPage:2,syncErrorClear:true,unauthorized:0,attempts:1,evidence:3,
      issuesServed:1,commentsServed:1,connector:{status:201},scheduler:{passes:2,firstPassEnqueued:1,restartKeptOneJob:true},
      secretLeaks:{needles:2,controls:{ownerCheck:1,sessionMint:1,cmdline:9},journal:0,database:0,record:0}});
    expect(commands.map(command=>command.slice(0,2).join(' '))).toEqual(['docker cp','docker cp','docker cp']);
    expect(commands[0]![2]).toMatch(/github-double\.mjs$/);expect(commands[1]![2]).toMatch(/github-issue-thread\.json$/);
    expect(copies).toHaveLength(1);expect(JSON.parse(copies[0]!).unverified.at(-1).layer).toBe('GitHub provider');
    expect(existsSync(join(directory,'record-copy.json'))).toBe(false);rmSync(directory,{recursive:true,force:true});
    expect(lib.validateRecord({...run.record,phases:[{...phase('sync'),assertions:run.phase.assertions}]})).toEqual([]);
    const [setup,trigger,leak]=calls.map(call=>call.script);
    expect(setup).toContain('/CN=rehearsal-github-ca');expect(setup).toContain('cat ca.pem >> /etc/unai/rehearsal/ca-bundle.pem');
    expect(setup).toContain('systemd-run --unit=rehearsal-github-double --property=Restart=no --property=NetworkNamespacePath=/run/netns/rehearsal-github');
    expect(setup).toMatch(/github-token 198\.18\.0\.2\n/);expect(setup).toContain("printf '198.18.0.2 api.github.com\\n' >> /etc/hosts");
    const at=(text:string)=>trigger!.indexOf(text);
    expect(at('-lt 420000')).toBeGreaterThan(-1);expect(at('-lt 420000')).toBeLessThan(at('seam session'));
    const steps=['seam session','/v1/connectors','systemctl restart unai-worker.service','until_ok 180 settled'].map(at);
    steps.push(trigger!.lastIndexOf('systemctl restart unai-worker.service'),at('row.sql > '));
    expect(steps.every((position,index)=>position>(index?steps[index-1]!:-1))).toBe(true);
    expect(leak).toContain('pg_dump -d unai --data-only');
    const {leakScript}=untypedSync as {leakScript:string};
    expect(leak!.endsWith(leakScript)).toBe(true);
    expect(leakScript.indexOf('journalctl --sync')).toBeGreaterThan(-1);
    expect(leakScript.indexOf('journalctl --sync')).toBeLessThan(leakScript.indexOf('journalctl -o export --no-pager'));
    expect(leakScript).not.toMatch(/-o (?:cat|json)|\|\| true/);
    for(const {script,report} of calls){expect(script).not.toContain('${');expect(report).not.toContain('${');}
    shellSyntax(calls);
  });
  it('names the token inside the rehearsal owner\'s connector namespace (ADR 0013) and files no finding',async()=>{
    const {run,calls,directory}=syncRun();
    await sync(run);rmSync(directory,{recursive:true,force:true});
    const {OWNER_SCOPE,TOKEN_NAME,TOKEN_HANDLE}=syncNames;
    expect(TOKEN_NAME).toBe('connectors/$scope/github');expect(TOKEN_HANDLE).toBe('secret://mounted/connectors/$scope/github');
    expect(OWNER_SCOPE).toBe(String.raw`scope=$(envval worker UNAI_PROCESSING_OWNER_SCOPE_ID); printf '%s\n' "$scope" | grep -Eqx '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'`);
    expect(isConnectorCredentialHandle(TOKEN_HANDLE.replace('$scope',SAMPLE),SAMPLE)).toBe(true);
    expect(isConnectorCredentialHandle(TOKEN_HANDLE.replace('$scope',SAMPLE),OTHER)).toBe(false);
    expect(isConnectorCredentialHandle('secret://mounted/connectors-github',SAMPLE)).toBe(false);
    const [setup,trigger,leak]=calls.map(call=>call.script);
    const ordered=(text:string,parts:string[])=>{
      const at=parts.map(part=>text.indexOf(part));
      expect(at.every((position,index)=>position>(index?at[index-1]!:-1)),JSON.stringify(at)).toBe(true);
    };
    const api='/etc/unai/secrets/api/connectors/$scope',worker='/etc/unai/secrets/worker/connectors/$scope';
    ordered(setup!,[OWNER_SCOPE,`install -d -o root -g unai-api -m 0750 ${api}\n`,`install -d -o root -g unai-worker -m 0750 ${worker}\n`,
      'pnpm secret:put connectors/$scope/github < /root/rehearsal/github-token',
      `chown root:unai-api ${api}/github; chmod 0640 ${api}/github`,`install -o root -g unai-worker -m 0640 ${api}/github ${worker}/github\n`]);
    ordered(trigger!,['seam session',OWNER_SCOPE,'"secretRef":"%s"',
      `' "secret://mounted/connectors/$scope/github" > /root/rehearsal/connector-body\n`,'/v1/connectors']);
    expect(leak!.endsWith(syncNames.leakScript)).toBe(true);
    // The scope is checked once the cleanup trap holds the record copy and before anything is captured.
    ordered(syncNames.leakScript,[`trap 'rm -f "$needles" "$capture" "$dump" /root/rehearsal/record-copy.json' EXIT\n${OWNER_SCOPE}\n`,
      'journalctl --sync']);
    expect(leak).toContain('grep -q -F "secret://mounted/connectors/$scope/github" "$dump"');
    expect(`${setup}${trigger}${leak}`).not.toMatch(/connectors-github|secret:\/\/mounted\/connectors\/github/);
    expect(run.record.findings).toBeUndefined();
    expect(lib.validateRecord({...run.record,phases:[{...phase('sync'),assertions:run.phase.assertions}]})).toEqual([]);
  });
  it('records the stopped state and refuses a dead-lettered or twice-enqueued sync',async()=>{
    const dead=syncRun({row:{...row,status:'DEAD_LETTER',attempts:3,jobErrorClear:false,lastError:'CONNECTOR_PROVIDER_UNAVAILABLE',
      connectorStatus:'SYNC_FAILED',syncErrorClear:false,syncError:'CONNECTOR_PROVIDER_UNAVAILABLE'}});
    await expect(sync(dead.run)).rejects.toThrow('REHEARSAL_SYNC_INVALID');
    expect(dead.run.phase.assertions).toEqual({connector:{status:201},diagnostic:{jobs:1,status:'DEAD_LETTER',
      lastError:'CONNECTOR_PROVIDER_UNAVAILABLE',syncError:'CONNECTOR_PROVIDER_UNAVAILABLE',connectorStatus:'SYNC_FAILED'}});
    expect(lib.validateRecord({...dead.run.record,phases:[{...phase('sync'),status:'FAIL',assertions:dead.run.phase.assertions}]})).toEqual([]);
    expect(dead.calls).toHaveLength(2);
    const twice=syncRun({row:{...row,jobs:2,status:'SUCCEEDED SUCCEEDED'}});
    await expect(sync(twice.run)).rejects.toThrow('REHEARSAL_SYNC_INVALID');
    expect((twice.run.phase.assertions as {diagnostic:{status:string}}).diagnostic.status).toBe('UNREADABLE');
    await expect(sync(syncRun({passes:[pass]}).run)).rejects.toThrow('REHEARSAL_SCHEDULER_LOG_INVALID');
    await expect(sync(syncRun({leaks:leakLines({journal:'1'})}).run)).rejects.toThrow('REHEARSAL_SECRET_LEAKED');
    await expect(sync(syncRun({leaks:leakLines({'session-mint':'0'})}).run)).rejects.toThrow('REHEARSAL_LEAK_PROBE_INVALID');
  });
});

// @ts-expect-error Plain JavaScript operator tooling.
import * as untypedLifecycle from '../scripts/rehearsal/lifecycle-tool.mjs';
type UnitEvent={unit:string;event:string};
type Version={major:number;minor:number;patch:number};
interface Lifecycle {
  systemdEvents(text:string,units:string[]):UnitEvent[];
  followsOrder(events:UnitEvent[],expected:UnitEvent[]):{ok:boolean;observed:UnitEvent[]};
  neverStopped(events:UnitEvent[],unit:string):boolean;
  peakOf(samples:number[]):{peak:number;samples:number};
  version(value:string):Version;
  registryTarget(input:{pinned:string;recorded:string[];published:string[];tagged:string[];bases:Record<string,string>}):
    {from:Version;to:Version;direction:string}|{unverified:string};
  d12Steps(text:string):string[];
  classifyObserved(text:string):Record<string,unknown>;
  observerScript(paths:{real:string;log:string}):string;
  backupSummary(text:string):Record<string,unknown>;
  drillSummary(text:string):Record<string,unknown>;
}
const lifecycle=untypedLifecycle as Lifecycle;
const journalIds={stopping:'de5b426a63be47a7b6ac3eaac82e2f6f',stopped:'9d1aaa27d60140bd96365438aad20286',
  starting:'7d4958e842da4a758f6c1cdc7b36dcc5',started:'39f53479d3a045ac8e11786248231fbf',failed:'be02cf6855d2428ba40df7e9d022f03d'};
const d11:UnitEvent[]=[{unit:'unai-worker',event:'stopped'},{unit:'unai-api',event:'stopped'},
  {unit:'unai-backup',event:'completed'},{unit:'unai-api',event:'started'},{unit:'unai-worker',event:'started'}];
const backupLine=JSON.stringify({event:'backup.completed',bytes:123,objects:3,quiescence:'systemd',archive:'private.tar.enc',sha256:'f'.repeat(64)});
const drillLine=JSON.stringify({event:'restore.drill.completed',verdict:'PASS',restore:{tables:10,objects:3},probes:{reads:2},drill:'PRIVATE'});
const jsonLines=(values:unknown[])=>values.map(value=>JSON.stringify(value)).join('\n');
const patched=(line:string,patch:Record<string,unknown>)=>JSON.stringify({...JSON.parse(line) as Record<string,unknown>,...patch});
type Case=[string,Record<string,unknown>];
describe('rehearsal lifecycle pure evidence',()=>{
  it('pins D11 journal order and drops private fields and spoofed events',()=>{
    const rows=d11.map(row=>row.event==='completed'?{_SYSTEMD_UNIT:row.unit+'.service',MESSAGE:backupLine}:
      {_PID:'1',UNIT:row.unit+'.service',MESSAGE_ID:journalIds[row.event as keyof typeof journalIds],_HOSTNAME:'private.host'});
    const result=lifecycle.systemdEvents(jsonLines([...rows,{...rows[0],_PID:'99'},
      {_PID:'1',UNIT:'other.service',MESSAGE_ID:journalIds.started}]),['unai-worker','unai-api','unai-backup']);
    expect(result).toEqual(d11);
    expect(lifecycle.followsOrder(result,d11)).toEqual({ok:true,observed:d11});
    expect(lifecycle.neverStopped(result,'unai-web')).toBe(true);
    expect(lifecycle.neverStopped(result,'unai-api')).toBe(false);
  });
  it('takes stop and start events only from PID 1 and completion only from the backup unit itself',()=>{
    const spoofs=[{_PID:'99',_SYSTEMD_UNIT:'unai-worker.service',UNIT:'unai-worker.service',MESSAGE_ID:journalIds.stopped},
      {_PID:'1',_SYSTEMD_UNIT:'init.scope',UNIT:'unai-backup.service',MESSAGE:backupLine},
      {_PID:'42',_SYSTEMD_UNIT:'unai-worker.service',MESSAGE:backupLine},
      {_PID:'7',_SYSTEMD_UNIT:'unai-backup.service',MESSAGE:JSON.stringify({event:'backup.failed',code:'BACKUP_FAILED'})},
      {_PID:'7',_SYSTEMD_UNIT:'unai-backup.service',MESSAGE:'(node) warning'}];
    for(const spoof of spoofs)expect(lifecycle.systemdEvents(JSON.stringify(spoof),['unai-worker','unai-api','unai-backup'])).toEqual([]);
  });
  it('counts stopping as a stop and matches each ordered step on both unit and event',()=>{
    for(const event of ['stopping','stopped'])expect(lifecycle.neverStopped([{unit:'unai-web',event}],'unai-web')).toBe(false);
    expect(lifecycle.neverStopped([{unit:'unai-web',event:'started'},{unit:'unai-api',event:'stopped'}],'unai-web')).toBe(true);
    expect(lifecycle.followsOrder([{unit:'unai-worker',event:'started'},...d11.slice(1)],d11).ok).toBe(false);
    expect(lifecycle.followsOrder(d11.slice(0,4),d11)).toEqual({ok:false,observed:d11.slice(0,4)});
  });
  it.each([[d11[1]!,d11[0]!,...d11.slice(2)],[...d11.slice(0,2),d11[3]!,d11[2]!,d11[4]!]].map(events=>({events})))('rejects reordered D11 %#',({events})=>{
    expect(lifecycle.followsOrder(events,d11)?.ok).toBe(false);
  });
  it('samples finite nonnegative integers, requiring at least one',()=>{
    expect(lifecycle.peakOf([0,2,6,3])).toEqual({peak:6,samples:4});
    for(const samples of [[],[NaN],[1.1],[-1]])expect(()=>lifecycle.peakOf(samples)).toThrow('REHEARSAL_SAMPLES_INVALID');
    expect(()=>lifecycle.peakOf(null as unknown as number[])).toThrow('REHEARSAL_SAMPLES_INVALID');
  });
  it('encodes versions as safe integers and refuses any other shape',()=>{
    expect(lifecycle.version('11.0.8')).toEqual({major:11,minor:0,patch:8});
    for(const value of ['0.1','v0.1.0','0.1.0-rc1','99999999999999999999.0.0'])expect(()=>lifecycle.version(value)).toThrow('REHEARSAL_VERSION_INVALID');
  });
  it('picks the newest safe registry tag in either direction',()=>{
    const input={pinned:'0.1.0',recorded:['0.1.0','0.2.0','0.3.0'],published:['0.1.0'],tagged:['0.1.0','0.2.0','0.3.0'],bases:{}};
    const version=(minor:number)=>({major:0,minor,patch:0});
    expect(lifecycle.registryTarget(input)).toEqual({from:version(1),to:version(3),direction:'forward'});
    expect(lifecycle.registryTarget({...input,pinned:'0.3.0'})).toEqual({from:version(3),to:version(2),direction:'backward'});
    expect(lifecycle.registryTarget({...input,bases:{'0.3.0':'0.2.0'}})).toEqual({from:version(1),to:version(2),direction:'forward'});
    expect(lifecycle.registryTarget({...input,tagged:[]})).toEqual({unverified:'REGISTRY_TARGET_UNAVAILABLE'});
    expect(lifecycle.registryTarget({...input,bases:{'0.3.0':'0.1.0'}})).toEqual({from:version(1),to:version(3),direction:'forward'});
    expect(lifecycle.registryTarget({...input,published:['0.1.0','0.3.0'],bases:{'0.3.0':'0.2.0'}})).toEqual({from:version(1),to:version(3),direction:'forward'});
    expect(()=>lifecycle.registryTarget({...input,pinned:'latest',tagged:[]})).toThrow('REHEARSAL_VERSION_INVALID');
  });
  it('keeps only D12 titles and summary counts, refuses empty probe evidence',()=>{
    expect(lifecycle.d12Steps('private\n== D12 step 0: timers\n== D12 step 1: fetch\n')).toEqual(['timers','fetch']);
    expect(lifecycle.backupSummary(backupLine)).toEqual({bytes:123,objects:3,quiescence:'systemd'});
    expect(lifecycle.drillSummary(drillLine)).toEqual({verdict:'PASS',tables:10,objects:3,probeReads:2});
    expect(()=>lifecycle.drillSummary(drillLine.replace('"reads":2','"reads":0'))).toThrow('REHEARSAL_DRILL_INVALID');
    expect(()=>lifecycle.backupSummary('{}')).toThrow('REHEARSAL_BACKUP_INVALID');
    expect(()=>lifecycle.d12Steps('== D12 step 0: timers\n== D12 step 2: fetch\n')).toThrow('REHEARSAL_UPGRADE_STEPS_INVALID');
  });
  it.each<Case>([['another event',{event:'backup.failed'}],['an empty archive',{bytes:0}],['fractional bytes',{bytes:1.5}],
    ['negative objects',{objects:-1}],['assumed quiescence',{quiescence:'assumed'}],['no quiescence',{quiescence:'none'}]])('refuses a backup summary with %s',(_,patch)=>{
    expect(()=>lifecycle.backupSummary(patched(backupLine,patch))).toThrow('REHEARSAL_BACKUP_INVALID');
  });
  it.each<Case>([['another event',{event:'restore.drill.failed'}],['verdict FAIL',{verdict:'FAIL'}],
    ['negative tables',{restore:{tables:-1,objects:3}}],['fractional objects',{restore:{tables:10,objects:0.5}}],
    ['no probe reads',{probes:{}}]])('refuses a drill summary with %s',(_,patch)=>{
    expect(()=>lifecycle.drillSummary(patched(drillLine,patch))).toThrow('REHEARSAL_DRILL_INVALID');
  });
  it('classifies observed invocations without exposing argv or stdout',()=>{
    const rows=[{argv:['--unit=unai-upgrade-backup','--uid=unai-backup','--property=EnvironmentFile=/etc/unai/backup.env'],exit:1,stdout:''},
      {argv:['--setenv=HOME=/root','/usr/local/bin/pnpm','db:migrate'],exit:0,stdout:'PRIVATE'},
      {argv:['--setenv=HOME=/root','/usr/local/bin/pnpm','uai','registry','publish'],exit:0,stdout:'PRIVATE'},
      {argv:['--uid=unai-web','server.ts','--check'],exit:0,stdout:'noise\n'+JSON.stringify({check:'api',status:'warn',code:'API_UNREACHABLE',secret:'PRIVATE'})}];
    expect(lifecycle.classifyObserved(jsonLines(rows))).toEqual({transientBackup:{user:'unai-backup',environmentFile:true,exit:1},
      migrate:{user:'root',home:true,exit:0},publish:{user:'root',home:true,exit:0},checks:{web:{exit:0,lines:[{check:'api',status:'warn',code:'API_UNREACHABLE'}]}}});
  });
  it('records a missing HOME or backup environment file instead of assuming it, and ignores unrelated runs',()=>{
    const rows=[{argv:['--unit=unai-upgrade-backup','--uid=unai-backup','--property=EnvironmentFile=/etc/unai/api.env'],exit:0,stdout:''},
      {argv:['/usr/local/bin/pnpm','db:migrate'],exit:0,stdout:''},
      {argv:['--setenv=HOME=/home/unai','/usr/local/bin/pnpm','uai','registry','publish'],exit:0,stdout:''},
      {argv:['--uid=unai-api','/usr/bin/true'],exit:0,stdout:''}];
    expect(lifecycle.classifyObserved(jsonLines(rows))).toStrictEqual({transientBackup:{user:'unai-backup',environmentFile:false,exit:0},
      migrate:{user:'root',home:false,exit:0},publish:{user:'root',home:false,exit:0},checks:{}});
  });
  const checkRun=(row:Record<string,unknown>)=>({argv:['--uid=unai-api','--check'],exit:0,stdout:JSON.stringify(row)});
  it.each<[string,unknown[]]>([['argv that is not a list',[{argv:'--check',exit:0}]],['a non-string argument',[{argv:[1],exit:0}]],
    ['a negative exit',[{argv:[],exit:-1}]],['an exit above 255',[{argv:[],exit:256}]],
    ['an unknown service user',[{argv:['--unit=unai-upgrade-backup','--uid=nobody'],exit:0}]],
    ['a --check run as root',[{argv:['--check'],exit:0,stdout:''}]],
    ['a second web --check',[{argv:['--uid=unai-web','--check'],exit:0,stdout:''},{argv:['--uid=unai-web','--check'],exit:0,stdout:''}]],
    ['a second migrate',[{argv:['db:migrate'],exit:0},{argv:['db:migrate'],exit:0}]],
    ['an uppercase check name',[checkRun({check:'API',status:'ok',code:'OK'})]],
    ['an unknown check status',[checkRun({check:'api',status:'maybe',code:'OK'})]],
    ['raw text as a check code',[checkRun({check:'api',status:'fail',code:'connect ECONNREFUSED'})]]])('refuses an observation with %s',(_,rows)=>{
    expect(()=>lifecycle.classifyObserved(jsonLines(rows))).toThrow('REHEARSAL_OBSERVED_INVALID');
  });
  it.each([{real:'systemd-run',log:'/run/observed'},{real:'/usr/bin/systemd-run',log:'/run/$(id)'},
    {real:'/usr/bin/systemd run',log:'/run/observed'}])('refuses an observer path that is relative or not plain %#',paths=>{
    expect(()=>lifecycle.observerScript(paths)).toThrow('REHEARSAL_OBSERVER_PATH_INVALID');
  });
  it.skipIf(process.platform!=='linux')('observer preserves argv stdout and exit, only retains checks',()=>{
    const dir=mkdtempSync(join(tmpdir(),'observer-')),real=join(dir,'real'),log=join(dir,'log'),observer=join(dir,'observer');
    try{
      writeFileSync(real,'#!/bin/bash\nprintf \'{"check":"api","status":"warn","code":"API_UNREACHABLE"}\\n\'\nexit 3\n',{mode:0o700});
      writeFileSync(observer,lifecycle.observerScript({real,log}),{mode:0o700});
      for(const args of [['--check'],['db:migrate']]){
        const r=spawnSync('bash',[observer,...args],{encoding:'utf8'});
        expect(r.status).toBe(3);expect(r.stdout).toContain('API_UNREACHABLE');
      }
      const rows=readFileSync(log,'utf8').trim().split('\n').map(line=>JSON.parse(line) as {argv:string[];exit:number;stdout:string});
      expect(rows.map(row=>row.argv)).toEqual([['--check'],['db:migrate']]);
      expect(rows.map(row=>row.exit)).toEqual([3,3]);
      expect(rows[0]!.stdout).toContain('API_UNREACHABLE');expect(rows[1]!.stdout).toBe('');
    }finally{rmSync(dir,{recursive:true,force:true});}
  });
});

// @ts-expect-error Plain JavaScript operator tooling.
import {backupVerdict as untypedBackupVerdict} from '../scripts/rehearsal/lifecycle-tool.mjs';
const backupVerdict=untypedBackupVerdict as (events:UnitEvent[],summary:Record<string,unknown>,inventory:Record<string,unknown>)=>Record<string,unknown>;
describe('rehearsal backup proof',()=>{
  const inventory={archives:1,sidecars:2,encrypted:true,sizeMatches:true,headerValid:true};
  it('requires the actual D11 order and one encrypted archive with both sidecars',()=>{
    expect(backupVerdict(d11,{bytes:123,objects:3,quiescence:'systemd'},inventory)).toMatchObject({webNeverStopped:true,archives:1,bytes:123});
  });
  it.each(['archives','sidecars','encrypted','sizeMatches','headerValid'])('refuses a failed archive observation %s',key=>{
    expect(()=>backupVerdict(d11,{bytes:123,objects:3,quiescence:'systemd'},{...inventory,[key]:false})).toThrow('REHEARSAL_BACKUP_INVALID');
  });
  it.each<[string,UnitEvent[]]>([['the API stopped before the worker',[d11[1]!,d11[0]!,...d11.slice(2)]],['no worker restart',d11.slice(0,4)],
    ['the web stopping',[...d11.slice(0,2),{unit:'unai-web',event:'stopping'},...d11.slice(2)]],
    ['the web stopped',[...d11.slice(0,2),{unit:'unai-web',event:'stopped'},...d11.slice(2)]]])('refuses a backup with %s',(_,events)=>{
    expect(()=>backupVerdict(events,{bytes:123,objects:3,quiescence:'systemd'},inventory)).toThrow('REHEARSAL_BACKUP_INVALID');
  });
  it.each([{archives:2},{archives:0},{sidecars:1},{sidecars:3}])('refuses anything but one archive and two sidecars %#',override=>{
    expect(()=>backupVerdict(d11,{bytes:123,objects:3,quiescence:'systemd'},{...inventory,...override})).toThrow('REHEARSAL_BACKUP_INVALID');
  });
});

// @ts-expect-error Plain JavaScript operator tooling.
import {drillVerdict as untypedDrillVerdict} from '../scripts/rehearsal/lifecycle-tool.mjs';
const drillVerdict=untypedDrillVerdict as (input:Record<string,unknown>)=>Record<string,unknown>;
describe('rehearsal restore drill proof',()=>{
  const good={summary:drillLine,samples:[0,2,6,3],limit:5,user:'',capability:'cap_dac_read_search',protect:'strict',databases:0,roles:0,failed:false};
  it('records a measured over-limit finding signal without hiding a passing restore',()=>{
    expect(drillVerdict(good)).toMatchObject({verdict:'PASS',migratorPeak:6,migratorLimit:5,overLimit:true,samples:4,intervalMs:100,user:'root'});
  });
  it.each([{user:'unai-backup'},{capability:''},{protect:'full'},{databases:1},{roles:1},{failed:true},{limit:NaN},
    {databases:undefined},{roles:undefined},{failed:undefined}])('fails on invalid or missing drill evidence %#',override=>{
    expect(()=>drillVerdict({...good,...override})).toThrow('REHEARSAL_DRILL_INVALID');
  });
  it('raises the over-limit signal only above the limit, which admits exactly limit connections',()=>{
    expect(drillVerdict({...good,samples:[0,5],limit:5})).toMatchObject({migratorPeak:5,migratorLimit:5,overLimit:false});
    expect(drillVerdict({...good,samples:[0,4],limit:5})).toMatchObject({migratorPeak:4,overLimit:false});
  });
  it('accepts systemd reporting the root user by name',()=>expect(drillVerdict({...good,user:'root'})).toMatchObject({user:'root'}));
});

// @ts-expect-error Plain JavaScript operator tooling.
import {dryVerdict as untypedDryVerdict} from '../scripts/rehearsal/lifecycle-tool.mjs';
const dryVerdict=untypedDryVerdict as (text:string,equal:boolean)=>Record<string,unknown>;
const upgradeTitles='timers fetch build maintenance backup migrate registry preflight swap start'.split(' ');
const dryText=upgradeTitles.map((title,i)=>`== D12 step ${i}: ${title}`).join('\n')+'\ndry run: nothing was executed\n';
describe('rehearsal dry upgrade proof',()=>{
  it('requires all ten titles, a zero-mutation snapshot and dry marker',()=>{
    expect(dryVerdict(dryText,true)).toEqual({exit:0,steps:upgradeTitles,changedPaths:0});
    expect(()=>dryVerdict(dryText,false)).toThrow('REHEARSAL_DRY_RUN_INVALID');
    expect(()=>dryVerdict(dryText.replace('dry run: nothing was executed',''),true)).toThrow('REHEARSAL_DRY_RUN_INVALID');
    expect(()=>dryVerdict(dryText.replace('== D12 step 9: start',''),true)).toThrow('REHEARSAL_DRY_RUN_INVALID');
  });
});

// @ts-expect-error Plain JavaScript operator tooling.
import {rollbackVerdict as untypedRollbackVerdict} from '../scripts/rehearsal/lifecycle-tool.mjs';
const rollbackVerdict=untypedRollbackVerdict as (input:Record<string,unknown>)=>Record<string,unknown>;
describe('rehearsal real rollback proof',()=>{
  const input={text:'ROLLBACK (ADR 0043 D12): step 4 failed before migrate; no data changed.\nUPGRADE_BACKUP_FAILED',exit:1,
    observed:{transientBackup:{user:'unai-backup',environmentFile:true,exit:1}},events:d11.filter(row=>row.event!=='completed'),
    current:true,removed:true,unchanged:true,noCopies:true,ready:true,timers:true};
  it('accepts only the step-four propagated failure and restored state',()=>{
    expect(rollbackVerdict(input)).toMatchObject({exit:1,code:'UPGRADE_BACKUP_FAILED',current:'rehearsal-a',releaseRemoved:true});
  });
  it.each(['current','removed','unchanged','noCopies','ready','timers'])('rejects missing rollback proof %s',key=>{
    expect(()=>rollbackVerdict({...input,[key]:false})).toThrow('REHEARSAL_ROLLBACK_INVALID');
  });
  it('rejects an earlier failure or incomplete rollback',()=>{
    expect(()=>rollbackVerdict({...input,text:input.text.replace('step 4','step 2')})).toThrow('REHEARSAL_ROLLBACK_INVALID');
    expect(()=>rollbackVerdict({...input,text:'rollback incomplete\n'+input.text})).toThrow('REHEARSAL_ROLLBACK_INVALID');
    expect(()=>rollbackVerdict({...input,observed:{transientBackup:{user:'unai-backup',environmentFile:true,exit:0}}})).toThrow('REHEARSAL_ROLLBACK_INVALID');
  });
  const backup={user:'unai-backup',environmentFile:true,exit:1};
  it.each<Case>([['a zero exit',{exit:0}],['a usage exit',{exit:2}],
    ['another final code',{text:input.text.replace(/UPGRADE_BACKUP_FAILED$/,'UPGRADE_MIGRATE_FAILED')}],
    ['the API started after the worker',{events:[d11[0]!,d11[1]!,d11[4]!,d11[3]!]}],['no restart',{events:d11.slice(0,2)}],
    ['a transient backup run as root',{observed:{transientBackup:{...backup,user:'root'}}}],
    ['a transient backup without backup.env',{observed:{transientBackup:{...backup,environmentFile:false}}}],
    ['a non-numeric transient exit',{observed:{transientBackup:{...backup,exit:'1'}}}],
    ['no transient backup observed',{observed:{transientBackup:null}}]])('rejects a rollback with %s',(_,override)=>{
    expect(()=>rollbackVerdict({...input,...override})).toThrow('REHEARSAL_ROLLBACK_INVALID');
  });
});

// @ts-expect-error Plain JavaScript operator tooling.
import {parseEnvironment as untypedParseEnvironment} from '../scripts/rehearsal/lifecycle-host.mjs';
const parseEnvironment=untypedParseEnvironment as (text:string)=>Record<string,string>;
it('parses numbered S3 variable names without dropping endpoints or keys',()=>{
  expect(parseEnvironment('# comment\nUNAI_BACKUP_S3_ENDPOINT=https://127.0.0.1\nUNAI_BACKUP_S3_REGION=west\n')).toEqual({UNAI_BACKUP_S3_ENDPOINT:'https://127.0.0.1',UNAI_BACKUP_S3_REGION:'west'});
});

// @ts-expect-error Plain JavaScript operator tooling.
import {upgradeVerdict as untypedUpgradeVerdict} from '../scripts/rehearsal/lifecycle-tool.mjs';
const upgradeVerdict=untypedUpgradeVerdict as (input:Record<string,unknown>)=>Record<string,unknown>;
describe('rehearsal real upgrade proof',()=>{
  const observed={transientBackup:{user:'unai-backup',environmentFile:true,exit:0},migrate:{user:'root',home:true,exit:0},
    publish:{user:'root',home:true,exit:0},checks:{api:{exit:0,lines:[]},worker:{exit:0,lines:[]},
      web:{exit:0,lines:[{check:'api',status:'warn',code:'API_UNREACHABLE'}]}}};
  const input={text:dryText.replace('dry run: nothing was executed','upgraded rehearsal-a -> rehearsal-b'),exit:0,observed,
    events:[['unai-api','started'],['unai-web','stopped'],['unai-web','started'],['unai-worker','started']].map(([unit,event])=>({unit,event})),
    archiveDelta:1,cacheUnchanged:true,offlineVersion:'11.0.8',current:true,marker:true,ready:true,timers:true,signin:200,publishExpected:true};
  it('requires real invocations, offline corepack, swap and ordered restart',()=>{
    expect(upgradeVerdict(input)).toMatchObject({exit:0,current:'rehearsal-b',archiveDelta:1,offlineVersion:{major:11,minor:0,patch:8}});
  });
  it.each(['cacheUnchanged','current','marker','ready','timers'])('fails a missing upgrade proof %s',key=>{
    expect(()=>upgradeVerdict({...input,[key]:false})).toThrow('REHEARSAL_UPGRADE_INVALID');
  });
  it.each([{archiveDelta:0},{offlineVersion:'11.0.9'},{signin:302},{exit:1},{observed:{...observed,publish:null}},
    {observed:{...observed,migrate:{user:'root',home:false,exit:0}}}])('refuses incomplete upgrade %#',override=>{
    expect(()=>upgradeVerdict({...input,...override})).toThrow('REHEARSAL_UPGRADE_INVALID');
  });
  const events=(...pairs:Array<[string,string]>)=>pairs.map(([unit,event])=>({unit,event}));
  const web=(lines:unknown[])=>({observed:{...observed,checks:{...observed.checks,web:{exit:0,lines}}}});
  const transient=(patch:Record<string,unknown>)=>({observed:{...observed,transientBackup:{...observed.transientBackup,...patch}}});
  it.each<Case>([
    ['a STOPPED message despite exit 0',{text:input.text+'STOPPED (ADR 0043 D12): step 7 failed after migrations began; current was not swapped back.\n'}],
    ['no upgraded line',{text:input.text.replace('upgraded rehearsal-a -> rehearsal-b','')}],
    ['a missing D12 step',{text:input.text.replace('== D12 step 9: start\n','')}],
    ['the worker started before the API',{events:events(['unai-worker','started'],['unai-api','started'],['unai-web','stopped'],['unai-web','started'])}],
    ['no web restart',{events:events(['unai-api','started'],['unai-worker','started'])}],
    ['a second archive',{archiveDelta:2}],
    ['a transient backup run as root',transient({user:'root'})],
    ['a transient backup without backup.env',transient({environmentFile:false})],
    ['a failed transient backup',transient({exit:1})],
    ['migrate as a service user',{observed:{...observed,migrate:{user:'unai-api',home:true,exit:0}}}],
    ['a failed migrate',{observed:{...observed,migrate:{user:'root',home:true,exit:1}}}],
    ['publish without HOME',{observed:{...observed,publish:{user:'root',home:false,exit:0}}}],
    ...(['api','web','worker'] as const).map((name):Case=>[`a failed ${name} --check`,
      {observed:{...observed,checks:{...observed.checks,[name]:{...observed.checks[name],exit:1}}}}]),
    ['no worker --check',{observed:{...observed,checks:{api:observed.checks.api,web:observed.checks.web}}}],
    ['the web API check ok while the API is stopped',web([{check:'api',status:'ok',code:'OK'}])],
    ['the web API check warning another code',web([{check:'api',status:'warn',code:'API_TLS_FAILED'}])],
    ['the web API check failing',web([{check:'api',status:'fail',code:'API_UNREACHABLE'}])],
    ['the warning on another web check',web([{check:'auth',status:'warn',code:'API_UNREACHABLE'}])]])('refuses an upgrade with %s',(_,override)=>{
    expect(()=>upgradeVerdict({...input,...override})).toThrow('REHEARSAL_UPGRADE_INVALID');
  });
  it('accepts no publish when the registry re-pin is UNVERIFIED',()=>{
    expect(upgradeVerdict({...input,publishExpected:false,observed:{...observed,publish:null}})).toMatchObject({exit:0,publish:null});
  });
});

// @ts-expect-error Plain JavaScript operator tooling.
import {lifecyclePhases as untypedLifecyclePhases} from '../scripts/rehearsal/lifecycle.mjs';
const apiCheckNames='rate_limits secrets database auth_database database_role encryption_at_rest object_store registry_release tls_certificate probe_port'.split(' ');
const checkRows=(names:string[])=>names.map(check=>({check,status:'ok',code:'OK'}));
it.skipIf(process.platform!=='linux')('lifecycle recipes are valid bash, isolate state, and run the shipped commands',async()=>{
  const calls:Array<{script:string;report?:string}>=[];
  const value={registry:{from:{major:0,minor:1,patch:0},to:{major:0,minor:3,patch:0}},
    apiChecks:checkRows(apiCheckNames),webChecks:[...checkRows(['rate_limits','origin','tls_certificate','auth']),{check:'api',status:'warn',code:'API_UNREACHABLE'}],workerChecks:[],
    apiReady:{status:'ready',checks:Object.fromEntries(['database','encryption_at_rest','object_store','registry_release','tls_certificate'].map(key=>[key,'ok']))},
    workerReady:{status:'ready',checks:{database:'ok',registry_release:'ok',loop:'ok'}}};
  const run={container:'disposable',record:{unverified:[] as unknown[]},phase:{assertions:{}},command:async()=>'',
    inside:async(script:string,options:{report?:string}={})=>{calls.push({script,...options});return '@@lifecycle\n'+JSON.stringify(value);}};
  const phases=untypedLifecyclePhases as Record<string,(r:typeof run)=>Promise<void>>;
  expect(Object.keys(phases)).toEqual(['backup','restore-drill','upgrade-dry-run','upgrade-rollback','upgrade']);
  for(const phase of Object.values(phases))await phase(run);
  for(const {script,report} of calls){
    const result=spawnSync('bash',['-n'],{input:script+'\n'+(report??''),encoding:'utf8'});
    expect(result.stderr).toBe('');expect(result.status).toBe(0);
  }
  const text=calls.map(call=>call.script).join('\n');
  expect(text).toContain('systemctl start unai-backup.service');
  expect(text).toContain('systemctl start unai-restore-drill.service');
  expect(text).toContain('trap stop_sampler EXIT');expect(text).toContain('trap cleanup_injection EXIT');
  expect(text).toContain('run-.service.d');expect(text).toContain('COREPACK_ENABLE_NETWORK=0');
  expect(text).toContain('bash deploy/upgrade.sh "${args[@]}"');
  expect(text).not.toMatch(/(?:cat|cp|base64) .*backup\.key/);
  expect(run.record.unverified).toHaveLength(4);
  expect(lib.validateRecord({...record(),phases:[{...phase('upgrade'),assertions:value}]})).toEqual([]);
});

// @ts-expect-error Plain JavaScript operator tooling.
import {drillInvocation as untypedDrillInvocation} from '../scripts/rehearsal/lifecycle-tool.mjs';
const drillInvocation=untypedDrillInvocation as (text:string)=>string;
it('finds the completed oneshot invocation in the cursor-scoped journal after systemd clears the property',()=>{
  const row={_SYSTEMD_UNIT:'unai-restore-drill.service',_SYSTEMD_INVOCATION_ID:'a'.repeat(32),MESSAGE:drillLine};
  expect(drillInvocation(JSON.stringify(row))).toBe('a'.repeat(32));
  expect(()=>drillInvocation('')).toThrow('REHEARSAL_DRILL_INVALID');
  expect(()=>drillInvocation(jsonLines([row,{...row,_SYSTEMD_INVOCATION_ID:'b'.repeat(32)}]))).toThrow('REHEARSAL_DRILL_INVALID');
  expect(()=>drillInvocation(JSON.stringify({...row,_SYSTEMD_INVOCATION_ID:'z'.repeat(32)}))).toThrow('REHEARSAL_DRILL_INVALID');
  expect(drillInvocation(jsonLines([row,{...row,_SYSTEMD_UNIT:'unai-backup.service',_SYSTEMD_INVOCATION_ID:'b'.repeat(32)}]))).toBe('a'.repeat(32));
});

it('puts the executable observer outside the noexec run tmpfs',()=>{
  const source=readFileSync('scripts/rehearsal/lifecycle.mjs','utf8');
  expect(source).not.toContain('/run/unai-rehearsal-observer');
  expect(source).toContain('/usr/local/lib/unai-rehearsal/observer');
});

it('ignores non-check telemetry JSON without losing check lines',()=>{
  const line={argv:['--uid=unai-web','--check'],exit:0,stdout:jsonLines([{event:'telemetry.startup',status:'TELEMETRY_ENABLED'},
    {check:'api',status:'warn',code:'API_UNREACHABLE'}])};
  expect(lifecycle.classifyObserved(JSON.stringify(line))).toMatchObject({checks:{web:{exit:0,lines:[{check:'api',status:'warn',code:'API_UNREACHABLE'}]}}});
});
it.skipIf(process.platform!=='linux')('sampler startup failure emits a bare code even without root state access',()=>{
  const r=spawnSync(process.execPath,['scripts/rehearsal/lifecycle-host.mjs','sample'],{encoding:'utf8'});
  expect(r.status).toBe(1);expect(r.stderr).toBe('REHEARSAL_LIFECYCLE_FAILED\n');
});

// @ts-expect-error Plain JavaScript operator tooling.
import {archiveChange as untypedArchiveChange} from '../scripts/rehearsal/lifecycle-tool.mjs';
const archiveChange=untypedArchiveChange as (before:number,after:number,events:UnitEvent[])=>Record<string,number>;
it('attributes only completed timer archives separately from the upgrade backup',()=>{
  expect(archiveChange(1,3,[{unit:'unai-backup',event:'completed'}])).toEqual({archiveIncrease:2,timerArchives:1,archiveDelta:1});
  expect(archiveChange(1,2,[{unit:'unai-backup',event:'starting'}])).toEqual({archiveIncrease:1,timerArchives:0,archiveDelta:1});
  expect(archiveChange(1,2,[{unit:'unai-restore-drill',event:'completed'}])).toEqual({archiveIncrease:1,timerArchives:0,archiveDelta:1});
  for(const [before,after] of [[2,1],[-1,1],[1,1.5],[Number.NaN,1]] as Array<[number,number]>){
    expect(()=>archiveChange(before,after,[])).toThrow('REHEARSAL_ARCHIVES_INVALID');
  }
});

interface Observation {
  summarizeOtlp(lines:string[]):{services:string[];scopes:Record<string,{spans:number;points:number}>;nonUnaiScopes:number;nextScopes:number;httpTargetAttributes:number;invalidLines:number};
  classifyCdp(messages:unknown[],loaderId:string):{status:number|null;csp:string;permissionsPolicy:string;cspEvents:number;cspConsole:number};
  cspNonce(header:string):string|null;
  permissionAllows(header:string,feature:string,origin:string):boolean;
  noncedScripts(nonce:string|null,nonces:string[]):{scripts:number;nonced:number;all:boolean};
}
const observation=async():Promise<Observation>=>{
  const path='../scripts/rehearsal/observe.mjs';
  const result:unknown=await import(path).catch(()=>({}));
  expect(result).toHaveProperty('summarizeOtlp');
  return result as Observation;
};
const attr=(key:string,value:string)=>({key,value:{stringValue:value}});
const otlp=(service:string,scope:string,metrics=false)=>({
  [metrics?'resourceMetrics':'resourceSpans']:[{resource:{attributes:[attr('service.name',service)]},
    [metrics?'scopeMetrics':'scopeSpans']:[{scope:{name:scope},...(metrics?{metrics:[{histogram:{dataPoints:[{attributes:[attr('http.target','PRIVATE')]}]}}]}:
      {spans:[{attributes:[],events:[{attributes:[attr('http.target','PRIVATE')]}],links:[{attributes:[attr('safe','ok')]}]}]})}]}],
});
describe('rehearsal observation helpers',()=>{
  it('counts exact scope spans and metric points without returning payloads',async()=>{
    const m=await observation();
    expect(m.summarizeOtlp([JSON.stringify(otlp('unai-api','unai.api')),JSON.stringify(otlp('unai-worker','unai.jobs',true))])).toEqual({
      services:['unai-api','unai-worker'],scopes:{unai_api:{spans:1,points:0},unai_jobs:{spans:0,points:1}},
      nonUnaiScopes:0,nextScopes:0,httpTargetAttributes:2,invalidLines:0});
  });
  it('flags foreign scopes and every nested target, counting malformed lines',async()=>{
    const m=await observation();
    const input=otlp('unai-web','next.js',true);
    const result=m.summarizeOtlp([JSON.stringify(input),'not json','null','',JSON.stringify({bogus:[]})]);
    expect(result).toEqual({services:['unai-web'],scopes:{},nonUnaiScopes:1,nextScopes:1,httpTargetAttributes:1,invalidLines:3});
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });
  it('does not disclose unknown service or scope strings as record keys',async()=>{
    const m=await observation();
    const result=m.summarizeOtlp([JSON.stringify(otlp('PRIVATE','unai.private.value'))]);
    expect(result.services).toEqual([]);
    expect(result.scopes).toEqual({});
    expect(result.invalidLines).toBe(1);
  });
  it('takes only the matching main document response, never a subresource or old loader',async()=>{
    const m=await observation();
    const response=(loaderId:string,type:string,status:number)=>({method:'Network.responseReceived',params:{loaderId,type,response:{status,headers:{'Content-Security-Policy':"script-src 'nonce-match'",'Permissions-Policy':'microphone=(self)'}}}});
    const result=m.classifyCdp([response('main','Document',200),response('main','Image',404),response('old','Document',302),
      {method:'Runtime.bindingCalled',params:{name:'rehearsalCsp',payload:'script-src-elem'}},
      {method:'Runtime.bindingCalled',params:{name:'unrelated',payload:'private'}},
      {method:'Log.entryAdded',params:{entry:{text:'violates Content Security Policy'}}},
      {method:'Runtime.consoleAPICalled',params:{args:[{value:'Content Security Policy refused'}]}},
      {method:'Runtime.exceptionThrown',params:{exceptionDetails:{text:'Content Security Policy refused'}}},
      {method:'Runtime.consoleAPICalled',params:{args:[{value:'unrelated error'}]}}],'main');
    expect(result).toEqual({status:200,csp:"script-src 'nonce-match'",permissionsPolicy:'microphone=(self)',cspEvents:1,cspConsole:3});
    expect(m.classifyCdp([response('main','Image',200)],'main').status).toBeNull();
  });
  it('requires a nonempty identical script nonce and a nonempty script set',async()=>{
    const m=await observation();
    expect(m.cspNonce("default-src 'self'; script-src 'nonce-match' 'strict-dynamic'")).toBe('match');
    expect(m.cspNonce("script-src 'self'")).toBeNull();
    expect(m.noncedScripts('match',['match','match'])).toEqual({scripts:2,nonced:2,all:true});
    for(const nonces of [['match',''],['match','wrong'],[]])expect(m.noncedScripts('match',nonces).all).toBe(false);
    expect(m.noncedScripts(null,[''])).toEqual({scripts:1,nonced:0,all:false});
  });
  it('recognizes explicit self policy and refuses absent, wildcard or foreign origins',async()=>{
    const m=await observation(),origin='https://rehearsal.invalid';
    expect(m.permissionAllows('camera=(), microphone=(self)','microphone',origin)).toBe(true);
    expect(m.permissionAllows(`microphone=("${origin}")`,'microphone',origin)).toBe(true);
    for(const h of ['', 'microphone=()', 'microphone=*','microphone=("https://foreign.invalid")'])expect(m.permissionAllows(h,'microphone',origin)).toBe(false);
  });
});

interface Observability {
  telemetryVerdict(value:Record<string,unknown>):Record<string,unknown>;
  telemetryScript:string;
}
async function observability():Promise<Observability>{
  const path='../scripts/rehearsal/observability.mjs';
  const value:unknown=await import(path).catch(()=>({}));
  expect(value).toHaveProperty('telemetryVerdict');return value as Observability;
}
const telemetryReceipt=()=>({services:['unai-api','unai-web','unai-worker'],scopes:{unai_api:{spans:1,points:1},unai_web:{spans:1,points:1},unai_postgres:{spans:1,points:1}},
  nonUnaiScopes:0,nextScopes:0,httpTargetAttributes:0,invalidLines:0,missingServices:[],
  installedByBundle:{versionMatches:true,configMatches:true,dropInPresent:true,active:true,loopbackOnly:true},metricExportMs:5000});
describe('rehearsal telemetry phase',()=>{
  it('requires fresh service receipts and the installed collector proof',async()=>{
    const m=await observability(),receipt=telemetryReceipt();
    expect(m.telemetryVerdict(receipt)).toEqual({...receipt,allUnaiPrefixed:true});
    for(const key of Object.keys(receipt.installedByBundle))expect(()=>m.telemetryVerdict({...receipt,installedByBundle:{...receipt.installedByBundle,[key]:false}})).toThrow('REHEARSAL_TELEMETRY_INVALID');
    for(const key of ['nonUnaiScopes','nextScopes','httpTargetAttributes','invalidLines'])expect(()=>m.telemetryVerdict({...receipt,[key]:1})).toThrow('REHEARSAL_TELEMETRY_INVALID');
    for(const service of receipt.services){
      expect(()=>m.telemetryVerdict({...receipt,services:receipt.services.filter(s=>s!==service)})).toThrow('REHEARSAL_TELEMETRY_INVALID');
      expect(()=>m.telemetryVerdict({...receipt,missingServices:[service]})).toThrow('REHEARSAL_TELEMETRY_INVALID');
    }
    expect(()=>m.telemetryVerdict({...receipt,scopes:{}})).toThrow('REHEARSAL_TELEMETRY_INVALID');
    expect(()=>m.telemetryVerdict({...receipt,metricExportMs:60000})).toThrow('REHEARSAL_TELEMETRY_INVALID');
  });
  it('restarts in readiness order and requires the shipped endpoint rather than installing a collector',async()=>{
    const m=await observability();
    let previous=-1;
    for(const token of ['snapshot','systemctl restart unai-api','until_ok 120 ready 9101','systemctl restart unai-web','until_ok 120 signin','systemctl restart unai-worker','until_ok 120 ready 9102','401',' otlp ']){
      const index=m.telemetryScript.indexOf(token,previous+1);expect(index).toBeGreaterThan(previous);previous=index;
    }
    expect(m.telemetryScript).toContain("grep -cx 'UNAI_OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318'");
    expect(m.telemetryScript).toContain('UNAI_OTEL_METRIC_EXPORT_MS=5000');
  });
  it('never downloads, installs or rewrites the bundle collector from a rehearsal source',async()=>{
    await observability();
    const {readdirSync}=await import('node:fs');
    const paths=['scripts/deploy-rehearsal.mjs','scripts/lib/rehearsal-record.mjs',...readdirSync('scripts/rehearsal').filter(p=>p.endsWith('.mjs')).map(p=>`scripts/rehearsal/${p}`)];
    for(const path of paths){
      const source=readFileSync(path,'utf8');
      expect(source).not.toMatch(/(?:curl|wget)[^\n]*(?:otelcol|\.deb)/);
      expect(source).not.toMatch(/\bdpkg\s+(?:-[^\n]*\s)?-i\b|apt(?:-get)?[^\n]*install[^\n]*otelcol/);
      expect(source).not.toMatch(/(?:writeFile(?:Sync)?\s*\(|>\s*|tee\s+)['"]?\/etc\/otelcol-contrib/);
    }
  });
});

it('pins and verifies the browser before extraction without disabling certificate verification',async()=>{
  const m=await observability() as Observability & {browserProvisionScript:string;CHROME_VERSION:string;CHROME_SHA256:string};
  expect(m.CHROME_VERSION).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
  expect(m.CHROME_SHA256).toMatch(/^[a-f0-9]{64}$/);
  const script=m.browserProvisionScript;
  expect(script).toContain('curl -fsSL --proto =https --tlsv1.2');
  expect(script.indexOf('sha256sum --check')).toBeLessThan(script.indexOf('unzip -q'));
  expect(script).toContain('libnss3-tools');
  expect(script).toContain("-t 'CP,,'");
  expect(script).toContain('trap ');
  expect(script).toContain('seam session >');
  expect(script).toContain('chmod 0600');
  expect(script).not.toMatch(/--ignore-certificate-errors|--ignore-certificate-errors-spki-list/);
});

const browserReceipt=()=>({chromeMajor:157,sha256Verified:true,certificateTrust:'nss',pages:Object.fromEntries(['signin','today','ask','talk'].map(name=>[name,
  {status:200,cspEvents:0,cspConsole:0,scripts:4,nonced:4,allNonced:true,pathMatches:true,...(name==='talk'?{microphoneSelf:true,microphonePermission:'prompt'}:{})}])),detectorControl:{status:404,cspEvents:1,cspConsole:1}});
it('refuses every failed browser fact and a dead detector, keeping controls separate',async()=>{
  const m=await observability() as Observability & {browserVerdict(value:unknown):unknown};
  const value=browserReceipt();
  expect(typeof m.browserVerdict).toBe('function');expect(m.browserVerdict(value)).toEqual(value);
  for(const name of ['signin','today','ask','talk'])for(const [key,bad] of [['status',302],['cspEvents',1],['cspConsole',1],['allNonced',false],['pathMatches',false],['scripts',0],['nonced',3]] as const){
    expect(()=>m.browserVerdict({...value,pages:{...value.pages,[name]:{...value.pages[name],[key]:bad}}})).toThrow('REHEARSAL_BROWSER_INVALID');
  }
  for(const bad of [{microphoneSelf:false},{microphonePermission:'unknown'}])expect(()=>m.browserVerdict({...value,pages:{...value.pages,talk:{...value.pages.talk,...bad}}})).toThrow('REHEARSAL_BROWSER_INVALID');
  expect(()=>m.browserVerdict({...value,detectorControl:{status:404,cspEvents:0,cspConsole:0}})).toThrow('REHEARSAL_BROWSER_INVALID');
  expect(()=>m.browserVerdict({...value,sha256Verified:false})).toThrow('REHEARSAL_BROWSER_INVALID');
  const r=record();r.phases=[{...phase('browser'),assertions:value}];expect(lib.validateRecord(r)).toEqual([]);
});

it('never treats an empty OTLP batch as a fresh service receipt',async()=>{
  const m=await observation();
  const value={resourceSpans:[{resource:{attributes:[attr('service.name','unai-web')]},scopeSpans:[{scope:{name:'unai.web'},spans:[]}]}]};
  const result=m.summarizeOtlp([JSON.stringify(value)]);
  expect(result.services).toEqual([]);expect(result.invalidLines).toBe(1);
});
it('rejects vacuous metric receipts and missing detector counters',async()=>{
  const m=await observability() as Observability & {browserVerdict(value:unknown):unknown};
  for(const scopes of [{unai_api:{spans:0,points:0}},{unai_api:{spans:1,points:0}},{next_js:{spans:1,points:1}}]){
    expect(()=>m.telemetryVerdict({...telemetryReceipt(),scopes})).toThrow('REHEARSAL_TELEMETRY_INVALID');
  }
  for(const control of [{status:404,cspEvents:1},{status:404,cspEvents:-1,cspConsole:3},{status:404,cspEvents:NaN,cspConsole:1}]){
    expect(()=>m.browserVerdict({...browserReceipt(),detectorControl:control})).toThrow('REHEARSAL_BROWSER_INVALID');
  }
});

it('does not accept a missing checksum command just because extraction has a later index',async()=>{
  const m=await observability() as Observability & {browserProvisionScript:string};
  expect(m.browserProvisionScript.indexOf('sha256sum --check --status')).toBeGreaterThan(0);
});
it('counts target attributes at every OTLP container and metric point kind',async()=>{
  const m=await observation();
  const attributes=[attr('http.target','PRIVATE')];
  const lines=[{resourceSpans:[{resource:{attributes:[attr('service.name','unai-api'),...attributes]},scopeSpans:[{scope:{name:'unai.api',attributes},spans:[{attributes,events:[{attributes}],links:[{attributes}]}]}]}]},
    {resourceMetrics:[{resource:{attributes:[attr('service.name','unai-worker'),...attributes]},scopeMetrics:[{scope:{name:'unai.jobs',attributes},metrics:
      ['gauge','sum','histogram','exponentialHistogram','summary'].map(type=>({[type]:{dataPoints:[{attributes}]}}))}]}]}];
  expect(m.summarizeOtlp(lines.map(x=>JSON.stringify(x)))).toEqual({services:['unai-api','unai-worker'],
    scopes:{unai_api:{spans:1,points:0},unai_jobs:{spans:0,points:5}},nonUnaiScopes:0,nextScopes:0,httpTargetAttributes:12,invalidLines:0});
});

it.skipIf(process.platform!=='linux')('reaps a signal-exited browser and removes its profile on refusal',()=>{
  const dir=mkdtempSync(join(tmpdir(),'unai-browser-exit-'));
  try{
    const binary=join(dir,'chrome');writeFileSync(binary,'#!/bin/sh\nkill -KILL $$\n',{mode:0o700});
    const run=spawnSync(process.execPath,['scripts/rehearsal/observe.mjs','browser',binary,dir,join(dir,'token'),'https://rehearsal.invalid'],{encoding:'utf8',timeout:4000});
    expect(run.status).toBe(1);expect(run.stdout).toBe('');expect(run.stderr).toBe('REHEARSAL_BROWSER_START_FAILED\n');
    expect(existsSync(join(dir,'token'))).toBe(false);
    const listing=spawnSync('find',[dir,'-mindepth','1','-type','d'],{encoding:'utf8'});expect(listing.stdout).toBe('');
  }finally{rmSync(dir,{recursive:true,force:true});}
});

it('returns stable observation failure codes without raw provider errors',()=>{
  const run=spawnSync(process.execPath,['scripts/rehearsal/observe.mjs','unknown'],{encoding:'utf8'});
  expect(run.status).toBe(1);expect(run.stdout).toBe('');expect(run.stderr).toBe('REHEARSAL_OBSERVATION_ARGUMENTS_INVALID\n');
});

it('redacts inherited diagnostic URL literals, owner ids, cookies and nonces without changing phase facts',()=>{
  const sanitize=(untyped as Library & {publicRecord(value:unknown):unknown}).publicRecord;
  expect(typeof sanitize).toBe('function');
  const r=record(),id='12345678-1234-4321-8123-123456789012';
  r.phases=[{...phase('telemetry'),assertions:telemetryReceipt(),commands:[{...command(),tail:`https://uai.rehearsal.invalid/today ${id} __Host-unai.session=SENTINEL 'nonce-SENTINEL1234567890'`}]}];
  r.unverified=[{layer:'certificate',reason:'uai.rehearsal.invalid https://\\('}];
  const result=sanitize(r) as Record<string,unknown>,text=JSON.stringify(result);
  for(const token of ['https://','uai.rehearsal.invalid',id,'SENTINEL'])expect(text).not.toContain(token);
  expect(result.sourceCommit).toBe(r.sourceCommit);
  expect((result.phases as Array<{assertions:unknown}>)[0]?.assertions).toEqual(telemetryReceipt());
  expect(lib.validateRecord(result)).toEqual([]);
  expect(JSON.stringify(r)).toContain('SENTINEL');
});

it('reads the collector version from the actual readonly bundle declaration',async()=>{
  const m=await observation() as Observation & {collectorVersion(source:string):string|null};
  expect(typeof m.collectorVersion).toBe('function');
  expect(m.collectorVersion(readFileSync('deploy/install.sh','utf8'))).toBe('0.164.0');
  expect(m.collectorVersion('readonly OTELCOL_VERSION=wrong')).toBeNull();
});
