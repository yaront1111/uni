import {expect,it} from 'vitest';
import {existsSync,readFileSync,mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {resolve} from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {createDefaultSecretsManager} from '../packages/secrets/src/index.js';

async function runtime(){
  expect(existsSync(resolve('scripts/dev-stack.mjs'))).toBe(true);
  // @ts-expect-error JavaScript runtime harness.
  return import('../scripts/dev-stack.mjs');
}
function cleanEnv(){
  return {...Object.fromEntries(Object.entries(process.env).filter(([key])=>!(/DATABASE|^PG|^UNAI_TEST_S3_|^AWS_|^UNAI_SECRETS_MOUNT/.test(key)))),NODE_ENV:'test' as const};
}

it('provides the disposable runtime entrypoint before product assembly',()=>{
  expect(existsSync(resolve('scripts/dev-stack.mjs'))).toBe(true);
  expect(JSON.parse(readFileSync('package.json','utf8')).scripts['dev:stack']).toBe('node scripts/dev-stack.mjs');
});

it('verify-f4-refuse: refuses all external database selectors before allocating anything',async()=>{
  const {DevStackOrchestrator}=await runtime();
  for(const key of ['DATABASE_URL','UNAI_TEST_DATABASE_URL','UNAI_APP_DATABASE_URL','UNAI_AUTH_DATABASE_URL','UNAI_MIGRATION_DATABASE_URL','PGHOST','PGSERVICE','PGDATABASE']){
    const messages:string[]=[];
    const stack=new DevStackOrchestrator({env:{...cleanEnv(),[key]:'postgresql://external:private@existing/db'},log:(s:string)=>messages.push(s)});
    expect(await stack.run()).toBe(1);
    expect(stack.resources.snapshot()).toEqual([]);
    expect(messages).toEqual(['DEV_STACK_EXTERNAL_DATABASE_REFUSED']);
  }
  for(const flag of ['--database-url','--db-url','--database','--pg-host']){
    const cli=spawnSync(process.execPath,['scripts/dev-stack.mjs',flag,'secret://mounted/runtime/url'],{env:cleanEnv(),encoding:'utf8'});
    expect(cli.status).toBe(1);
    expect(cli.stdout+cli.stderr).toBe('DEV_STACK_EXTERNAL_DATABASE_REFUSED\n');
  }
});

it('owns cleanup before provisioning, unwinds in reverse, and retries failed cleanup',async()=>{
  const {DisposableStackResources}=await runtime();
  const ledger=new DisposableStackResources();
  const seen:string[]=[];let fails=true;
  ledger.own('directory','own-root',async()=>{seen.push('root');});
  ledger.own('container','own-db',async()=>{seen.push('db');if(fails)throw Error('private diagnostic');});
  await expect(ledger.cleanup()).rejects.toThrow('DEV_STACK_CLEANUP_FAILED');
  // A mount's parent must survive when its container could not be removed.
  expect(seen).toEqual(['db']);
  fails=false;
  await Promise.all([ledger.cleanup(),ledger.cleanup()]);
  expect(seen).toEqual(['db','db','root']);
  expect(ledger.snapshot().every((r:{removed:boolean})=>r.removed)).toBe(true);
});

it('verify-f1-reuse: the test runner, recovery and dev runtime share one pinned PostgreSQL source',async()=>{
  await runtime();
  const read=(p:string)=>readFileSync(p,'utf8');
  expect(read('scripts/test.mjs')).toContain("from './postgres-harness.mjs'");
  expect(read('scripts/database-roundtrip.mjs')).toContain("from './postgres-harness.mjs'");
  expect(read('scripts/dev-stack.mjs')).toContain("from './postgres-harness.mjs'");
  expect(read('scripts/dev-stack.mjs')).toContain("from './storage-harness.mjs'");
  expect(read('scripts/dev-stack.mjs')).toContain("from './tls-certificate.mjs'");
  expect(read('scripts/storage-harness.mjs')).toContain("from './s3-object-server.mjs'");
  expect(['scripts/test.mjs','scripts/database-roundtrip.mjs','scripts/dev-stack.mjs','scripts/postgres-harness.mjs'].map(read).join('\n').match(/pgvector\/pgvector@sha256:/g)).toHaveLength(1);
});

it('verify-f1-stack, verify-f1-storage, verify-f1-secrets: fresh real services, mounted handles, TLS and cleanup',async()=>{
  const {DevStackOrchestrator}=await runtime();
  const messages:string[]=[];let ready=false;let root='';let db='';
  const stack=new DevStackOrchestrator({env:cleanEnv(),log:(s:string)=>messages.push(s),onReady:async(config:Record<string,string>)=>{
    ready=true;root=config.UNAI_SECRETS_MOUNT!;
    const secrets=createDefaultSecretsManager(config);
    const url=await secrets.resolve(config.UNAI_DEV_DATABASE_URL!);
    const password=new URL(url).password;
    expect(password.length).toBeGreaterThanOrEqual(32);
    expect(JSON.stringify(config)).not.toContain(password);
    expect(config.UNAI_DEV_DATABASE_URL).toBe('secret://mounted/runtime/database#url');
    expect(config.UNAI_S3_CREDENTIALS).toBe('secret://mounted/runtime/storage');
    expect(JSON.stringify(config)).not.toContain('AWS_SECRET_ACCESS_KEY');
    const facts=await stack.verifyServices();
    expect(facts).toEqual({databaseTls:true,pgvector:true,encryptionAtRest:'managed:disposable-tmpfs-no-persistent-volume',objectRoundtrip:true,objectEncryption:'aws:kms'});
    db=stack.resources.snapshot().find((r:{kind:string})=>r.kind==='container').id;
    const inspected=spawnSync('docker',['inspect',db],{encoding:'utf8'});
    expect(inspected.status).toBe(0);
    expect(inspected.stdout).not.toContain(password);
    expect(inspected.stdout).toContain('POSTGRES_PASSWORD_FILE=/run/private/postgres-password');
    expect(JSON.parse(inspected.stdout)[0].Mounts.some((m:{Type:string})=>m.Type==='volume')).toBe(false);
    const {Pool}=createRequire(new URL('../packages/postgres/package.json',import.meta.url))('pg');
    const plaintext=new Pool({connectionString:url,ssl:false,connectionTimeoutMillis:2000});
    try{await expect(plaintext.query('SELECT 1')).rejects.toThrow();}finally{await plaintext.end();}
    const existing=new Pool({connectionString:url,ssl:{ca:readFileSync(config.UNAI_DATABASE_CA_FILE!),rejectUnauthorized:true}});
    try{
      await existing.query("CREATE TABLE refusal_sentinel(value text); INSERT INTO refusal_sentinel VALUES ('preserve existing data')");
      const refusedOutput:string[]=[];
      const refused=new DevStackOrchestrator({env:{...cleanEnv(),DATABASE_URL:url},log:(s:string)=>refusedOutput.push(s)});
      expect(await refused.run()).toBe(1);
      expect(refusedOutput).toEqual(['DEV_STACK_EXTERNAL_DATABASE_REFUSED']);
      expect(refused.resources.snapshot()).toEqual([]);
      expect((await existing.query('SELECT value FROM refusal_sentinel')).rows).toEqual([{value:'preserve existing data'}]);
    }finally{await existing.end();}
    if(process.platform!=='win32'){
      const {statSync}=await import('node:fs');
      expect(statSync(root).mode&0o777).toBe(0o700);
      expect(statSync(resolve(root,'runtime/database')).mode&0o777).toBe(0o600);
    }else{
      const acl=spawnSync('icacls',[root],{encoding:'utf8'});
      expect(acl.status).toBe(0);expect(acl.stdout).not.toContain('(I)');
    }
    stack.requestStop('NORMAL_EXIT');
  }});
  expect(await stack.run()).toBe(0);
  expect(ready).toBe(true);
  expect(existsSync(root)).toBe(false);
  expect(spawnSync('docker',['inspect',db],{stdio:'ignore'}).status).not.toBe(0);
  expect(messages.at(-1)).toBe('DEV_STACK_CLEANUP_COMPLETE');
  expect(stack.resources.snapshot().every((r:{removed:boolean})=>r.removed)).toBe(true);
},120000);

it('lifecycle harness: normal, Ctrl+C, API/web crashes and partial starts remove only invocation resources',async()=>{
  await runtime();
  // @ts-expect-error Shared JavaScript harness image.
  const {POSTGRES_IMAGE}=await import('../scripts/postgres-harness.mjs');
  const unrelated='unai-unrelated-'+randomUUID();
  const directory=mkdtempSync(resolve(tmpdir(),'unai-unrelated-'));
  writeFileSync(resolve(directory,'keep'),'unrelated sentinel');
  const created=spawnSync('docker',['create','--name',unrelated,POSTGRES_IMAGE],{encoding:'utf8'});
  expect(created.status).toBe(0);
  try{
    for(const scenario of ['normal','interrupt','api-crash','web-crash',
      'fail:directory','fail:before-database','fail:database-started','fail:database-ready','fail:storage-ready','fail:api-ready','fail:web-ready',
      'interrupt:database-started','interrupt:storage-ready']){
      const child=spawn(process.execPath,['src/fixtures/dev-stack-driver.mjs',scenario],{env:cleanEnv(),stdio:['ignore','pipe','pipe','ipc'],windowsHide:true});
      let output='';let resources:Array<{kind:string,id:string,removed:boolean,pid?:number}>=[];let finished=false;
      child.stdout!.on('data',chunk=>{output+=chunk;});child.stderr!.on('data',chunk=>{output+=chunk;});
      child.on('message',(message:any)=>{
        resources=message.resources??resources;
        if(message.type==='finished')finished=true;
        if(message.type==='ready'&&scenario==='interrupt'){
          // Windows does not deliver POSIX signals through child.kill. Exercise
          // Node's same SIGINT event used by Ctrl+C; Unix also tests OS delivery.
          if(process.platform==='win32')child.send({type:'interrupt'});else child.kill('SIGINT');
        }
      });
      const code=await new Promise((done,reject)=>{child.once('error',reject);child.once('exit',done);});
      expect(code,scenario+'\n'+output).toBe(scenario==='normal'?0:scenario.startsWith('interrupt')?130:1);
      expect(finished,scenario).toBe(true);
      expect(output,scenario).toContain('DEV_STACK_CLEANUP_COMPLETE');
      expect(output).not.toContain('private startup detail');
      if(scenario.endsWith('-crash'))expect(output).toContain('DEV_STACK_'+scenario.split('-')[0]!.toUpperCase()+'_EXIT');
      expect(resources.length,scenario).toBeGreaterThan(0);
      expect(resources.every(resource=>resource.removed),scenario).toBe(true);
      for(const resource of resources){
        if(resource.kind==='directory'||resource.kind==='secrets-mount')expect(existsSync(resource.id),scenario).toBe(false);
        if(resource.kind==='container')expect(spawnSync('docker',['inspect',resource.id],{stdio:'ignore'}).status,scenario).not.toBe(0);
        if(resource.kind==='child'){
          expect(resource.pid,scenario).toBeTypeOf('number');
          expect(()=>process.kill(resource.pid!,0),scenario).toThrow();
        }
      }
      expect(spawnSync('docker',['inspect',unrelated],{stdio:'ignore'}).status,scenario).toBe(0);
      expect(readFileSync(resolve(directory,'keep'),'utf8')).toBe('unrelated sentinel');
    }
  }finally{
    spawnSync('docker',['rm','--volumes',unrelated],{stdio:'ignore'});
    rmSync(directory,{recursive:true,force:true});
  }
},180000);
