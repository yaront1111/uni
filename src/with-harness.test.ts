import {afterAll,expect,it} from 'vitest';
import {spawn,spawnSync,type ChildProcess} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {existsSync,mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import type {createDatabasePool} from '../packages/postgres/src/index.js';

if(!process.env.UNAI_TEST_DATABASE_URL)throw new Error('Run pnpm test for the required PostgreSQL harness');
type Pool=ReturnType<typeof createDatabasePool>;
interface Run{status:number|null;signal:NodeJS.Signals|null;stdout:string;stderr:string}
interface ChildResult{one:number;db:string;args:string[];storage:string[];port:string}
const {Pool:PgPool}=createRequire(new URL('../packages/postgres/package.json',import.meta.url))('pg') as
  {Pool:new(config:{connectionString:string;max:number})=>Pool};
const outer=new URL(process.env.UNAI_TEST_DATABASE_URL);
const admin=new PgPool({connectionString:outer.href,max:1});
admin.on('error',()=>{});
const root=mkdtempSync(join(tmpdir(),'unai-with-harness-'));
const children=new Set<ChildProcess>(),pids=new Set<number>(),databases=new Set<string>();
const scratchPattern=/Disposable database for this run: (unai_test_[0-9a-f]{32})\./g;
const docker=spawnSync('docker',['version','--format','{{.Server.Version}}'],{encoding:'utf8',timeout:60000}).status===0;
const pg=`const {Pool}=require('node:module').createRequire(${JSON.stringify(resolve('packages/postgres/package.json'))})('pg');`;
const query=pg+`const pool=new Pool({connectionString:process.env.UNAI_TEST_DATABASE_URL});
(async()=>{try{const {rows}=await pool.query('SELECT 1 AS one, current_database() AS db');
console.log(JSON.stringify({...rows[0],args:process.argv.slice(1),port:new URL(process.env.UNAI_TEST_DATABASE_URL).port,
storage:[process.env.UNAI_TEST_S3_ENDPOINT,process.env.UNAI_TEST_S3_BUCKET,process.env.UNAI_TEST_S3_KMS_KEY_ID]}));
}finally{await pool.end();}})().then(()=>{process.exitCode=EXIT_CODE});`;

/** Piped asynchronous child: signals and in-process storage must keep flowing. */
function run(args:string[],env:NodeJS.ProcessEnv={...process.env},onStdout?:(text:string,child:ChildProcess)=>void):Promise<Run>{
  return new Promise((done,reject)=>{
    const child=spawn(process.execPath,[resolve('scripts/with-harness.mjs'),...args],{env});
    children.add(child);
    let stdout='',stderr='';
    child.stdout.on('data',chunk=>{
      stdout+=chunk;
      for(const match of stdout.matchAll(scratchPattern))if(match[1])databases.add(match[1]);
      onStdout?.(stdout,child);
    });
    child.stderr.on('data',chunk=>{stderr+=chunk;});
    child.once('error',reject);
    child.once('close',(status,signal)=>{children.delete(child);done({status,signal,stdout,stderr});});
  });
}
function scratchOf(stdout:string):string{
  const name=[...stdout.matchAll(scratchPattern)][0]?.[1];
  expect(name).toMatch(/^unai_test_[0-9a-f]{32}$/);
  if(!name)throw new Error('SCRATCH_DATABASE_NOT_REPORTED');
  return name;
}
async function expectDropped(name:string){
  expect((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1',[name])).rows).toEqual([]);
}
function resultOf(stdout:string):ChildResult{
  const lines=stdout.split('\n').filter(line=>line.startsWith('{'));
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0]!) as ChildResult;
}

afterAll(async()=>{
  try{
    for(const pid of pids){try{process.kill(pid,'SIGKILL');}catch{/* Already exited. */}}
    await Promise.all([...children].map(child=>new Promise<void>(done=>{
      child.once('close',()=>done());child.kill('SIGKILL');
    })));
    for(const name of databases){
      if(!/^unai_test_[0-9a-f]{32}$/.test(name))throw new Error('UNSAFE_TEST_CLEANUP');
      await admin.query('DROP DATABASE IF EXISTS '+name+' WITH (FORCE)');
    }
  }finally{await admin.end();rmSync(root,{recursive:true,force:true});}
});

it('runs SQL in a fresh scratch database, preserves argv/storage and exit 7, then drops it',async()=>{
  const extra='$HOME;$(exit 9)';
  const output=await run(['--',process.execPath,'-e',query.replace('EXIT_CODE','7'),extra]);
  expect(output.status,output.stderr).toBe(7);
  expect(output.signal).toBeNull();
  const name=scratchOf(output.stdout),result=resultOf(output.stdout);
  expect(result.one).toBe(1);
  expect(result.db).toBe(name);
  expect(result.db).not.toBe(outer.pathname.slice(1));
  expect(result.args).toEqual([extra]);
  expect(result.storage).toEqual([process.env.UNAI_TEST_S3_ENDPOINT,process.env.UNAI_TEST_S3_BUCKET,process.env.UNAI_TEST_S3_KMS_KEY_ID]);
  await expectDropped(name);
},180_000);

it.skipIf(!docker)('starts and removes the pinned container when no database is delivered',async()=>{
  const env={...process.env};delete env.UNAI_TEST_DATABASE_URL;delete env.DATABASE_URL;
  const output=await run(['--',process.execPath,'-e',query.replace('EXIT_CODE','0')],env);
  expect(output.status,output.stderr).toBe(0);
  expect(output.stdout).toContain('Starting disposable PostgreSQL/pgvector');
  const result=resultOf(output.stdout);
  expect(result.db).toBe('unai_test');
  expect(result.port).toMatch(/^[0-9]+$/);
  expect(result.port).not.toBe(outer.port);
  const running=spawnSync('docker',['ps','--format','{{.Ports}}'],{encoding:'utf8',timeout:60000});
  expect(running.status,running.stderr).toBe(0);
  expect(running.stdout).not.toContain('127.0.0.1:'+result.port+'->5432/tcp');
},180_000);

it.each([{label:'missing arguments',args:[]},{label:'bare separator',args:['--']},
  {label:'missing separator',args:['node','-e','1']}])('refuses $label before provisioning',async({args})=>{
  const output=await run(args);
  expect(output.status).toBe(2);
  expect(output.stderr).toBe('WITH_HARNESS_ARGUMENTS_INVALID: usage: node scripts/with-harness.mjs -- <command> [args...]\n');
  expect(output.stdout).toBe('');
});

it('reports partial delivered storage after migrations and never runs the command',async()=>{
  const env={...process.env};delete env.UNAI_TEST_S3_BUCKET;delete env.UNAI_TEST_S3_KMS_KEY_ID;
  const marker=join(root,'command-ran');
  const output=await run(['--',process.execPath,'-e',`require('node:fs').writeFileSync(${JSON.stringify(marker)},'ran')`],env);
  expect(output.status).toBe(1);
  expect(output.stderr).toBe('STORAGE_PROVISIONING_FAILED: Delivered object storage is incomplete; also set UNAI_TEST_S3_BUCKET, UNAI_TEST_S3_KMS_KEY_ID\n');
  expect(output.stdout).toContain('Migrations: ');
  expect(existsSync(marker)).toBe(false);
  await expectDropped(scratchOf(output.stdout));
},180_000);

it.skipIf(process.platform==='win32')('forwards SIGTERM, waits for the child and drops the scratch database',async()=>{
  let pid=0,db='';
  const script=`console.log('READY '+process.pid+' '+new URL(process.env.UNAI_TEST_DATABASE_URL).pathname.slice(1));setTimeout(()=>process.exit(99),120000);`;
  const output=await run(['--',process.execPath,'-e',script],{...process.env},(stdout,child)=>{
    const ready=/READY (\d+) (unai_test_[0-9a-f]{32})\n/.exec(stdout);
    if(ready&&!pid){pid=Number(ready[1]);db=ready[2]!;pids.add(pid);child.kill('SIGTERM');}
  });
  expect(output.status,output.stderr).toBe(143);
  expect(pid).toBeGreaterThan(0);
  expect(db).toBe(scratchOf(output.stdout));
  expect(()=>process.kill(pid,0)).toThrowError(expect.objectContaining({code:'ESRCH'}));
  pids.delete(pid);
  await expectDropped(db);
},180_000);

it('returns 127 for ENOENT and still drops the scratch database',async()=>{
  const output=await run(['--','unai-with-harness-missing-'+randomUUID()]);
  expect(output.status).toBe(127);
  expect(output.stderr).toBe('WITH_HARNESS_COMMAND_FAILED: ENOENT\n');
  await expectDropped(scratchOf(output.stdout));
},180_000);

it('keeps provisioning exclusively in the shared harness module',()=>{
  const harness=readFileSync('scripts/harness.mjs','utf8');
  for(const path of ['scripts/test.mjs','scripts/with-harness.mjs']){
    const source=readFileSync(path,'utf8');
    expect(source).toContain("from './harness.mjs'");
    for(const token of ['docker(','runMigrations','startStorageHarness']){
      expect(harness).toContain(token);
      expect(source).not.toContain(token);
    }
  }
});

it.each(['UNAI_TEST_DATABASE_URL','DATABASE_URL'])('preserves the cited environment-contract line for %s',variable=>{
  const rows=readFileSync('docs/operations/environment.md','utf8').split('\n');
  const row=rows.find(line=>line.startsWith('| `'+variable+'` |')&&line.includes('scripts/test.mjs:'));
  const match=/scripts\/test\.mjs:(\d+)/.exec(row??'');
  expect(match).not.toBeNull();
  const lines=readFileSync('scripts/test.mjs','utf8').split('\n');
  expect(lines[Number(match![1])-1]).toContain('process.env.UNAI_TEST_DATABASE_URL ?? process.env.DATABASE_URL');
});
