import {afterAll,beforeAll,describe, expect, it, vi} from 'vitest';
import {spawn,spawnSync} from 'node:child_process';
import {randomBytes,randomUUID,X509Certificate} from 'node:crypto';
import {mkdir,mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {connect,createServer,type AddressInfo,type Server} from 'node:net';
import {TLSSocket} from 'node:tls';
import {setTimeout as delay} from 'node:timers/promises';
import {Pool} from 'pg';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import * as telemetry from '@unai/observability/telemetry';
import {assertDatabaseRoleSafe,runMigrations} from '@unai/postgres';
import * as probes from './probes.js';

type Material={certificate:string;key:string};
const certificates=()=>import(pathToFileURL(resolve('scripts/tls-certificate.mjs')).href) as Promise<{createSelfSignedCertificate():Material}>;

describe('shared API checks',()=>{
  it('has a single implementation for readiness and startup checks',async()=>{
    const files=await readdir(resolve('packages/api/src'));
    expect(files).toContain('preflight.ts');
    const checks=await import('./preflight.js');
    expect(probes.databaseCheck).toBe(checks.databaseCheck);expect(probes.registryReleaseCheck).toBe(checks.registryReleaseCheck);
    for(const file of files.filter(name=>name.endsWith('.ts')&&!name.includes('.test.'))){
      const source=await readFile(resolve('packages/api/src',file),'utf8');
      expect(source).not.toContain('rolbypassrls');
      if(file!=='preflight.ts')expect(source).not.toMatch(/registry_release_published|validToDate|checkPrivateKey/);
    }
  });
  it('checks leaf expiry at the exact boundaries and validates its private key',async()=>{
    const {tlsCertificateCheck}=await import('./preflight.js'),{createSelfSignedCertificate}=await certificates();
    const first=createSelfSignedCertificate(),second=createSelfSignedCertificate(),day=86400000;
    const expires=new X509Certificate(first.certificate).validToDate.getTime();let now=expires-30*day;
    const check=tlsCertificateCheck(first.key,first.certificate+second.certificate,{clock:()=>now});
    expect(await check()).toBeUndefined();now++;expect(await check()).toBe('TLS_CERT_EXPIRING');
    now=expires;await expect(check()).rejects.toThrow('TLS_CERT_EXPIRED');
    expect(()=>tlsCertificateCheck(second.key,first.certificate)).toThrow('TLS_KEY_MISMATCH');
    expect(()=>tlsCertificateCheck(first.key,'junk')).toThrow('TLS_CERTIFICATE_INVALID');
    expect(()=>tlsCertificateCheck('junk',first.certificate)).toThrow('TLS_KEY_INVALID');
  });
  it('checks a directory and reports errno without reading secrets',async()=>{
    const {secretsMountCheck}=await import('./preflight.js'),root=await mkdtemp(join(tmpdir(),'unai-mount-'));
    try{
      await expect(secretsMountCheck(root)()).resolves.toBeUndefined();
      await writeFile(join(root,'file'),'private');
      await expect(secretsMountCheck(join(root,'file'))()).rejects.toMatchObject({code:'ENOTDIR'});
      await expect(secretsMountCheck(join(root,'missing'))()).rejects.toMatchObject({code:'ENOENT'});
    }finally{await rm(root,{recursive:true,force:true});}
  });
  it('binds the probe port briefly and fails on a held port',async()=>{
    const {probePortCheck}=await import('./preflight.js'),held=createServer();
    await new Promise<void>(done=>held.listen(0,'127.0.0.1',done));const port=(held.address() as AddressInfo).port;
    try{await expect(probePortCheck({bind:'127.0.0.1',port})()).rejects.toThrow('PROBE_LISTEN_FAILED');}
    finally{await new Promise<void>(done=>held.close(()=>done()));}
    await probePortCheck({bind:'127.0.0.1',port})();
    await new Promise<void>(done=>held.listen(port,'127.0.0.1',done));await new Promise<void>(done=>held.close(()=>done()));
  });
  it('closes the checked store and discards a database result',async()=>{
    const {objectStoreCheck,databaseCheck}=await import('./preflight.js'),close=vi.fn();
    await expect(objectStoreCheck(async()=>({close}))()).resolves.toBeUndefined();expect(close).toHaveBeenCalledOnce();
    await expect(databaseCheck({query:async()=>({rows:[]})})()).resolves.toBeUndefined();
  });
});

type Run={status:number|null;stdout:string;stderr:string};
const apiChecks=['rate_limits','secrets','database','auth_database','database_role','encryption_at_rest','object_store','registry_release','tls_certificate','probe_port'];
const checkLines=(run:Run):{check:string;status:string;code:string}[]=>run.stdout.trim().split('\n').map(line=>JSON.parse(line)).filter(line=>'check' in line);
async function listen(server:Server):Promise<number>{
  await new Promise<void>((done,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',done);});
  return (server.address() as AddressInfo).port;
}
async function postgresTls(url:URL,material:Material):Promise<Server>{
  const server=createServer(client=>{
    client.once('data',first=>{
      if(first.length!==8||first.readInt32BE(4)!==80877103){client.destroy();return;}
      client.pause();client.write('S');
      const secure=new TLSSocket(client,{isServer:true,cert:material.certificate,key:material.key});
      const upstream=connect(Number(url.port||5432),url.hostname);
      secure.pipe(upstream).pipe(secure);secure.on('error',()=>upstream.destroy());
      upstream.on('error',()=>secure.destroy());client.resume();
    });client.on('error',()=>client.destroy());
  });
  await listen(server);return server;
}
function apiRun(env:NodeJS.ProcessEnv,normal=false):Promise<Run>{
  const entry=resolve('packages/api/src/server.ts'),loader=pathToFileURL(resolve('node_modules/tsx/dist/loader.mjs')).href;
  const args=normal?['--import',loader,entry]:[resolve('node_modules/tsx/dist/cli.mjs'),entry,'--','--check'];
  return new Promise((done,reject)=>{
    const child=spawn(process.execPath,args,{env});let stdout='',stderr='';
    const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('PREFLIGHT_TEST_TIMEOUT'));},120000);
    child.stdout.on('data',chunk=>{
      stdout+=chunk;
      if(normal&&stdout.split('\n').some(line=>line.includes('"event":"listening"')))child.kill('SIGTERM');
    });
    child.stderr.on('data',chunk=>{stderr+=chunk;});child.once('error',reject);
    child.once('close',status=>{clearTimeout(timer);done({status,stdout,stderr});});
  });
}

describe.runIf(Boolean(process.env.UNAI_TEST_DATABASE_URL&&process.env.UNAI_TEST_S3_ENDPOINT))('API preflight harness',()=>{
  const suffix=randomBytes(6).toString('hex'),database='unai_preflight_'+suffix;
  const roles=['preflight_app_'+suffix,'preflight_auth_'+suffix],sentinel='SENTINEL_'+suffix;
  let admin:Pool,scratch:Pool,proxy:Server,held:Server,root='',env:NodeJS.ProcessEnv;
  let results:Run[]=[];
  async function material(name:string,value:Material){
    const key=join(root,name+'.key'),cert=join(root,name+'.pem');
    await writeFile(key,value.key,{mode:0o600});await writeFile(cert,value.certificate);return {key,cert};
  }
  async function setupDatabase(){
    const url=new URL(process.env.UNAI_TEST_DATABASE_URL!),scratchUrl=new URL(url);scratchUrl.pathname='/'+database;
    admin=new Pool({connectionString:url.href});await admin.query('CREATE DATABASE '+database);
    scratch=new Pool({connectionString:scratchUrl.href});await runMigrations(scratch,resolve('migrations'));
    await admin.query(`ALTER DATABASE ${database} SET unai.encryption_at_rest='volume-kms:preflight-test'`);
    const id=randomUUID();
    await scratch.query(`INSERT INTO registry_releases(id,semantic_version,git_tag,git_commit,content_hash,lifecycle,released_at,manifest,correlation_id)
      VALUES($1,'9995.0.6','registry-v9995.0.6',$2,$3,'RELEASED',now(),'{}',$4)`,[id,'a'.repeat(40),'b'.repeat(64),randomUUID()]);
    const {createSelfSignedCertificate}=await certificates(),tls=createSelfSignedCertificate();
    proxy=await postgresTls(url,tls);const ca=await material('database',tls);
    const mount=join(root,'secrets');await mkdir(mount,{mode:0o700});
    const superUrl=new URL(scratchUrl);superUrl.hostname='127.0.0.1';superUrl.port=String((proxy.address() as AddressInfo).port);
    await writeFile(join(mount,'super'),superUrl.href,{mode:0o600});
    for(const [index,role] of roles.entries()){
      const password=sentinel+randomBytes(16).toString('hex');
      await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`);
      await admin.query(`GRANT ${index===0?'unai_app':'unai_auth'} TO ${role}`);
      const login=new URL(superUrl);login.username=role;login.password=password;
      await writeFile(join(mount,index===0?'app':'auth'),login.href,{mode:0o600});
    }
    return {UNAI_SECRETS_MOUNT:mount,UNAI_DATABASE_CA_FILE:ca.cert,UNAI_APP_DATABASE_URL:'secret://mounted/app',
      UNAI_AUTH_DATABASE_URL:'secret://mounted/auth',UNAI_REGISTRY_RELEASE_ID:id,UNAI_REGISTRY_RELEASE:'9995.0.6'};
  }
  beforeAll(async()=>{
    root=await mkdtemp(join(tmpdir(),'unai-preflight-'));const config=await setupDatabase();
    const {createSelfSignedCertificate}=await certificates(),short=await material('short',createSelfSignedCertificate());
    const time=vi.spyOn(Date,'now').mockReturnValue(Date.now()-3*86400000);
    let expired:Material;try{expired=createSelfSignedCertificate();}finally{time.mockRestore();}
    const old=await material('expired',expired),key=join(root,'long.key'),cert=join(root,'long.pem');
    const openssl=process.platform==='win32'?'C:/Program Files/Git/usr/bin/openssl.exe':'openssl';
    const generated=spawnSync(openssl,['req','-x509','-newkey','ec','-pkeyopt','ec_paramgen_curve:prime256v1','-nodes','-days','365',
      '-subj','/CN=localhost','-addext','subjectAltName=IP:127.0.0.1','-keyout',key,'-out',cert],{encoding:'utf8'});
    expect(generated.status,generated.stderr).toBe(0);
    held=createServer();const port=await listen(held),free=createServer(),probe=await listen(free);
    await new Promise<void>(done=>free.close(()=>done()));
    env={PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,TEMP:process.env.TEMP,NODE_ENV:'test',...config,
      ...Object.fromEntries(Object.entries(process.env).filter(([name])=>name.startsWith('AWS_')||name==='NODE_EXTRA_CA_CERTS')),
      UNAI_API_PORT:String(port),UNAI_API_TLS_KEY_FILE:key,UNAI_API_TLS_CERT_FILE:cert,
      UNAI_S3_ENDPOINT:process.env.UNAI_TEST_S3_ENDPOINT,UNAI_S3_REGION:'us-east-1',
      UNAI_S3_BUCKET:process.env.UNAI_TEST_S3_BUCKET,UNAI_S3_KMS_KEY_ID:process.env.UNAI_TEST_S3_KMS_KEY_ID};
    const missing={...env};delete missing.UNAI_S3_BUCKET;
    results=await Promise.all([
      apiRun({...env,UNAI_PROBE_PORT:String(probe)}),apiRun(missing),
      apiRun({...env,UNAI_API_TLS_KEY_FILE:old.key,UNAI_API_TLS_CERT_FILE:old.cert}),
      apiRun({...env,UNAI_API_TLS_KEY_FILE:short.key,UNAI_API_TLS_CERT_FILE:short.cert}),
      apiRun({...env,UNAI_APP_DATABASE_URL:'secret://mounted/super'}),apiRun({...env,UNAI_PROBE_PORT:String(port)}),
    ]);
  },240000);
  afterAll(async()=>{
    proxy?.close();held?.close();await scratch?.end();
    if(admin){try{
      for(let n=0;n<200;n++){
        if((await admin.query('SELECT 1 FROM pg_stat_activity WHERE datname=$1',[database])).rowCount===0)break;
        await delay(25);
      }
      await admin.query('DROP DATABASE IF EXISTS '+database+' WITH (FORCE)');
      for(const role of roles)await admin.query('DROP ROLE IF EXISTS '+role);
    }finally{await admin.end();}}
    if(root)await rm(root,{recursive:true,force:true});
  },30000);
  it('passes without binding the held service port and records literal check evidence',async()=>{
    const run=results[0]!;expect(run.status,run.stderr+run.stdout).toBe(0);
    expect(checkLines(run)).toEqual(apiChecks.map(check=>({check,status:'ok',code:'OK'})));
    expect(JSON.parse(await readFile('package.json','utf8')).scripts['start:api']).toBe('tsx packages/api/src/server.ts');
    await mkdir('test-results/preflight',{recursive:true});await writeFile('test-results/preflight/api-check.log',run.stdout+'exit='+run.status+'\n');
  });
  it.each([[1,'object_store','CONFIG_REQUIRED:UNAI_S3_BUCKET'],[2,'tls_certificate','TLS_CERT_EXPIRED'],
    [4,'database_role','DATABASE_ROLE_UNSAFE'],[5,'probe_port','PROBE_LISTEN_FAILED']] as const)('reports the exact failure for case %s',(index,check,code)=>{
    expect(results[index]!.status).toBe(1);expect(checkLines(results[index]!).filter(line=>line.status==='fail')).toEqual([{check,status:'fail',code}]);
  });
  it('warns for an expiring certificate without failing',()=>{
    expect(results[3]!.status).toBe(0);expect(checkLines(results[3]!).filter(line=>line.status!=='ok')).toEqual([
      {check:'tls_certificate',status:'warn',code:'TLS_CERT_EXPIRING'},
    ]);
  });
  it('emits only JSON with no secret, connection string, path or PEM',()=>{
    for(const run of results){
      expect(run.stderr).toBe('');expect(checkLines(run).map(line=>line.check)).toEqual(apiChecks);
      for(const secret of [sentinel,'://','BEGIN',root,'startup_failed'])expect(run.stdout+run.stderr).not.toContain(secret);
    }
  });
  it('rejects an actual superuser pool',async()=>{
    const {databaseRoleCheck}=await import('./preflight.js');await expect(databaseRoleCheck(scratch)()).rejects.toThrow('DATABASE_ROLE_UNSAFE');
  });
  it('preserves normal startup: one bound-port line followed by graceful SIGTERM',async()=>{
    const run=await apiRun({...env,UNAI_API_PORT:'0'},true);expect(run.stderr).toBe('');expect(run.status).toBe(0);
    const lines=run.stdout.trim().split('\n').map(line=>JSON.parse(line)).filter(line=>line.event==='listening');
    expect(lines).toHaveLength(1);expect(lines[0].port).toBeGreaterThan(0);
  },180000);
});

it('accepts only an explicit safe-role result',async()=>{
  await expect(assertDatabaseRoleSafe({query:async()=>({rows:[{unsafe:false}]})})).resolves.toBeUndefined();
  for(const row of [{unsafe:true},{unsafe:null},{},null]){
    await expect(assertDatabaseRoleSafe({query:async()=>({rows:[row]})})).rejects.toThrow('DATABASE_ROLE_UNSAFE');
  }
});

describe('preflight output runner',()=>{
  it('exports the shared runner',()=>{expect(telemetry).toHaveProperty('runPreflight',expect.any(Function));});
  it('runs sequentially and emits only classified lines, including synchronous failures',async()=>{
    const lines:string[]=[], order:string[]=[];
    const passed=await telemetry.runPreflight({
      first:async()=>{await Promise.resolve();order.push('first');},
      warning:()=>{order.push('warning');return 'TLS_CERT_EXPIRING';},
      missing:()=>{throw new Error('CONFIG_REQUIRED:UNAI_X');},
      private:async()=>{throw new Error('password authentication failed SENTINEL');},
      untrusted:()=> 'SENTINEL://secret',
      last:()=>{order.push('last');return {private:'SENTINEL'};},
    },{write:line=>lines.push(line)});
    expect(passed).toBe(false);expect(order).toEqual(['first','warning','last']);
    expect(lines.map(line=>JSON.parse(line))).toEqual([
      {check:'first',status:'ok',code:'OK'},{check:'warning',status:'warn',code:'TLS_CERT_EXPIRING'},
      {check:'missing',status:'fail',code:'CONFIG_REQUIRED:UNAI_X'},
      {check:'private',status:'fail',code:'UNCLASSIFIED'},{check:'untrusted',status:'warn',code:'UNCLASSIFIED'},
      {check:'last',status:'ok',code:'OK'},
    ]);expect(lines.join('')).not.toContain('SENTINEL');
  });
  it('returns true when warnings are the worst result',async()=>{
    expect(await telemetry.runPreflight({ok:()=>undefined,warn:()=> 'WARN'},{write:()=>{}})).toBe(true);
  });
  it('bounds hung checks and continues',async()=>{
    const lines:string[]=[];
    expect(await telemetry.runPreflight({hung:()=>new Promise(()=>{}),after:()=>undefined},
      {timeoutMs:20,write:line=>lines.push(line)})).toBe(false);
    expect(lines.map(line=>JSON.parse(line))).toEqual([
      {check:'hung',status:'fail',code:'PREFLIGHT_CHECK_TIMEOUT'},{check:'after',status:'ok',code:'OK'},
    ]);
  });
});
