import {describe,expect,it} from 'vitest';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,existsSync,rmSync} from 'node:fs';
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
// @ts-expect-error Plain JavaScript operator tooling.
import * as untypedChecks from '../scripts/lib/rehearsal-checks.mjs';
// @ts-expect-error Plain JavaScript operator tooling.
import {servicePhases as untypedServices,show as untypedShow} from '../scripts/rehearsal/services.mjs';
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
    expect(lib.IMPLEMENTED.join(' ')).toBe(`${first} services probes smoke failed-start sync`);
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
    expect(()=>lib.parseArguments(['--until','backup'])).toThrow('REHEARSAL_PHASE_UNIMPLEMENTED');
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
  leakVerdict(text:string,secrets:string[]):Record<string,number>;
}
const syncChecks=untypedChecks as SyncChecks;
interface Answer {route:string;status:number;authorized:boolean;body:unknown}
const double=untypedDouble as {route(input:Record<string,unknown>):Answer;logLine(answer:Answer):string};
const fixture=JSON.parse(readFileSync('fixtures/sources/github-issue-thread.json','utf8')) as
  {repository:{full_name:string};issue:Record<string,unknown>&{number:number};comments:unknown[]};
const doubleLine=(route:string,status:number,authorized:boolean)=>JSON.stringify({event:'github.double',route,status,authorized});
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
  it('passes only zero leak counts for every secret, in order',()=>{
    const names=['github-token','session-token'];
    expect(syncChecks.leakVerdict('github-token 0 0 0\nsession-token 0 0 0\n',names)).toEqual({secrets:2,journal:0,database:0,record:0});
    for(const bad of ['github-token 0 0 1\nsession-token 0 0 0','github-token 0 0 0','session-token 0 0 0\ngithub-token 0 0 0',
      'github-token 0 0\nsession-token 0 0 0','github-token 0 0 0\nsession-token 0 2 0'])
      expect(()=>syncChecks.leakVerdict(bad,names)).toThrow('REHEARSAL_SECRET_LEAKED');
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
      :`@@leaks\n${options.leaks??'github-token 0 0 0\nsession-token 0 0 0'}`);
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
      secretLeaks:{secrets:2,journal:0,database:0,record:0}});
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
    for(const {script,report} of calls){expect(script).not.toContain('${');expect(report).not.toContain('${');}
    shellSyntax(calls);
  });
  it('names the token by a handle the shipped secret_ref check accepts and files the slash refusal',async()=>{
    const {run,calls,directory}=syncRun();
    await sync(run);rmSync(directory,{recursive:true,force:true});
    const [setup,trigger]=calls.map(call=>call.script);
    const check=/secret_ref ~ '([^']+)'/.exec(readFileSync('migrations/0018_connector_capabilities_and_lifecycle.sql','utf8'))![1]!;
    const handle=/"secretRef":"([^"]+)"/.exec(trigger!)![1]!;
    expect(handle).toBe('secret://mounted/connectors-github');expect(new RegExp(check).test(handle)).toBe(true);
    expect(setup).toContain('pnpm secret:put connectors-github <');
    expect(setup).toContain('/etc/unai/secrets/api/connectors-github /etc/unai/secrets/worker/connectors-github\n');
    expect(`${setup}${trigger}`).not.toContain('connectors/github');
    expect(run.record.findings).toEqual([{id:'connector-secret-ref-slash',area:'sync',verdict:'FILED',
      taskId:'task-43a9ecba94a348aaa4d050e7920ec14a',note:expect.stringContaining('500 INTERNAL_ERROR')}]);
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
    await expect(sync(syncRun({leaks:'github-token 1 0 0\nsession-token 0 0 0'}).run)).rejects.toThrow('REHEARSAL_SECRET_LEAKED');
  });
});
