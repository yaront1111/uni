import {spawnSync} from 'node:child_process';
import {randomBytes,randomUUID} from 'node:crypto';
import {cp,mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {connect,createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {isAbsolute,join,relative,resolve,sep} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {TLSSocket} from 'node:tls';
import {fileURLToPath} from 'node:url';
import {createSelfSignedCertificate} from './tls-certificate.mjs';

/** The deployment-shaped environment `with-harness.mjs` gives every command: what
 * `pnpm start:api|start:worker|start:web --check` need, built on the disposable
 * harness database and storage. Test infrastructure only (PRD §0 rule 4): never
 * reference it from deploy/, a start script or a systemd unit.
 * Credentials are random per run, live only as 0600 files in a 0700 temp mount
 * behind secret://mounted/ handles, and are never printed: this module writes no
 * output at all, and every failure is a bare DEPLOYMENT_ENVIRONMENT_* code,
 * because pg and OS error text can quote connection strings. */
const {Pool}=createRequire(new URL('../packages/postgres/package.json',import.meta.url))('pg');
const FILES='DEPLOYMENT_ENVIRONMENT_FILES_FAILED',DATABASE='DEPLOYMENT_ENVIRONMENT_DATABASE_FAILED';
const RELEASE='DEPLOYMENT_ENVIRONMENT_RELEASE_FAILED',OWNER='DEPLOYMENT_ENVIRONMENT_OWNER_FAILED';
const RELEASE_VERSION='0.1.0',ROOT_PREFIX='unai-deployment-';
// processing-runtime.test.ts's identity and dates: the commit is deterministic, so a
// rerun against a database that already holds 0.1.0 gets ALREADY_PUBLISHED.
// core.fileMode=false: a DrvFs copy reports 0777, and the loader refuses 100755.
const GIT_CONFIG=['-c','core.autocrlf=false','-c','core.fileMode=false','-c','init.defaultBranch=main',
  '-c','commit.gpgSign=false','-c','tag.gpgSign=false','-c','user.name=Registry Test','-c','user.email=registry@test.invalid'];
const GIT_STEPS=[['init','--quiet'],['add','registry'],['commit','--quiet','--no-verify','-m','release'],['tag','registry-v'+RELEASE_VERSION]];

async function phase(code,work){
  try{return await work();}catch{throw new Error(code);}
}
async function listen(server){
  await new Promise((done,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',done);});
  return server.address().port;
}
async function freePort(){
  const server=createServer(),port=await listen(server);
  await new Promise(done=>server.close(done));
  return port;
}
/** Runtime pools are TLS-verified only and the harness PostgreSQL is plain TCP:
 * answer the SSLRequest with 'S', terminate TLS here and pipe to the server. */
async function terminator(upstream,{certificate,key}){
  const sockets=new Set();
  const track=socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));return socket;};
  const pair=(one,other)=>{for(const [socket,partner] of [[one,other],[other,one]]){
    socket.on('error',()=>partner.destroy());socket.once('close',()=>partner.destroy());
  }};
  const server=createServer(client=>{
    track(client).on('error',()=>client.destroy());
    client.once('data',first=>{
      if(first.length!==8||first.readInt32BE(4)!==80877103){client.destroy();return;}
      client.pause();client.write('S');
      const secure=track(new TLSSocket(client,{isServer:true,cert:certificate,key}));
      const database=track(connect(Number(upstream.port||5432),upstream.hostname.replace(/^\[|\]$/g,'')));
      secure.pipe(database).pipe(secure);pair(secure,database);client.resume();
    });
  });
  const port=await listen(server);
  // server.close() alone waits for live connections; destroying them ends the backends.
  return {port,stop(){server.close();for(const socket of sockets)socket.destroy();}};
}
async function files(state){
  state.root=await mkdtemp(join(tmpdir(),ROOT_PREFIX));
  const path=name=>join(state.root,name),mount=path('secrets');
  await mkdir(mount,{mode:0o700});
  // Distinct subjects: OpenSSL picks a trust anchor by subject.
  const material={};
  for(const name of ['database','api','web'])material[name]=createSelfSignedCertificate({commonName:'unai-harness-'+name});
  await writeFile(path('database-ca.pem'),material.database.certificate,{flag:'wx'});
  for(const name of ['api','web']){
    await writeFile(path(name+'.pem'),material[name].certificate,{flag:'wx'});
    await writeFile(path(name+'.key'),material[name].key,{mode:0o600,flag:'wx'});
  }
  return {path,mount,material};
}
/** Per-run logins through the terminator, and the encryption declaration the
 * runtime asserts. On a delivered server that refused a scratch database, the
 * declaration stays on the delivered (disposable) database after the run. */
async function database(state,databaseUrl,material){
  state.admin=new Pool({connectionString:databaseUrl,max:1});
  // harness.close() drops the scratch database WITH (FORCE); a late 57P01 must not crash.
  state.admin.on('error',()=>{});
  const name=(await state.admin.query('SELECT current_database() AS name')).rows[0].name;
  const upstream=new URL(databaseUrl);
  state.proxy=await terminator(upstream,material);
  const suffix=randomBytes(6).toString('hex'),logins={};
  for(const [kind,grant] of [['app','unai_app'],['auth','unai_auth']]){
    const role='unai_harness_'+kind+'_'+suffix,password=randomBytes(24).toString('hex');
    await state.admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`);
    state.roles.push(role);
    await state.admin.query(`GRANT ${grant} TO ${role}`);
    const login=new URL(upstream);
    login.username=role;login.password=password;login.hostname='127.0.0.1';login.port=String(state.proxy.port);
    // createDatabasePool refuses a search part; without a path the role name would be the database.
    login.pathname='/'+encodeURIComponent(name);login.search='';login.hash='';
    logins[kind]=login.href;
  }
  const {sql}=(await state.admin.query(`SELECT format('ALTER DATABASE %I SET unai.encryption_at_rest = %L',
    current_database(),'volume-kms:harness') AS sql`)).rows[0];
  await state.admin.query(sql);
  return {logins,suffix};
}
async function secrets(mount,logins){
  const values={'app-database-url':logins.app,'auth-database-url':logins.auth,
    'model-api-key':randomBytes(24).toString('hex'),'google-client-secret':randomBytes(24).toString('hex'),
    'nextauth-secret':randomBytes(32).toString('base64url')};
  for(const [name,value] of Object.entries(values))await writeFile(join(mount,name),value,{mode:0o600,flag:'wx'});
}
/** A real release: publishRegistryRelease over a tagged temp Git copy of registry/. */
async function release(state,env,modules){
  try{
    const repository=join(state.root,'registry-release');
    await cp(fileURLToPath(new URL('../registry',import.meta.url)),join(repository,'registry'),{recursive:true});
    for(const args of GIT_STEPS){
      const result=spawnSync('git',[...GIT_CONFIG,...args],{cwd:repository,encoding:'utf8',
        env:{...env,GIT_AUTHOR_DATE:'2024-01-01T00:00:00Z',GIT_COMMITTER_DATE:'2024-01-01T00:00:00Z'}});
      if(result.error||result.status!==0)throw new Error(RELEASE);
    }
    const loaded=await modules.loadRegistryRelease({repository,version:RELEASE_VERSION});
    return (await modules.publishRegistryRelease(state.admin,loaded,randomUUID())).releaseId;
  }catch(error){
    const inner=error?.name==='RegistryError'&&/^REGISTRY_[A-Z0-9_]+$/.test(error.message)?':'+error.message:'';
    throw new Error(RELEASE+inner);
  }
}
/** Release and owner need the TypeScript sources, loaded through the tsx register
 * the harness uses for migrations (the root manifest has no @unai/* dependency). */
async function publishAndOwn(state,env,suffix){
  const unregister=await phase(RELEASE,async()=>(await import('tsx/esm/api')).register());
  try{
    const modules=await phase(RELEASE,async()=>({...await import('../packages/registry/src/release.ts'),
      ...await import('../packages/registry/src/snapshot.ts')}));
    const releaseId=await release(state,env,modules);
    const user=await phase(OWNER,async()=>{
      const {postgresAdapter}=await import('../packages/auth/src/index.ts');
      return postgresAdapter(state.admin).createUser({name:'Harness owner',email:'harness-'+suffix+'@example.invalid',emailVerified:null});
    });
    return {releaseId,ownerScopeId:user.ownerScopeId,actorId:user.id};
  }finally{await unregister();}
}
async function teardown(state){
  let ok=true;
  const attempt=async work=>{try{await work();}catch{ok=false;}};
  await attempt(()=>state.proxy?.stop());
  if(state.roles.length)await attempt(async()=>{
    const active='FROM pg_stat_activity WHERE usename = ANY($1::text[])';
    for(let tries=0;tries<200;tries++){
      if((await state.admin.query(`SELECT count(*)::int AS n ${active}`,[state.roles])).rows[0].n===0)break;
      await sleep(25);
    }
    // Only exited children ever logged in as these roles; a leftover backend is theirs.
    await state.admin.query(`SELECT pg_terminate_backend(pid) ${active}`,[state.roles]).catch(()=>{});
    await state.admin.query('DROP ROLE IF EXISTS '+state.roles.join(', '));
  });
  await attempt(()=>state.admin?.end());
  if(state.root)await attempt(()=>{
    const child=relative(resolve(tmpdir()),resolve(state.root));
    if(isAbsolute(child)||child.includes(sep)||!child.startsWith(ROOT_PREFIX))throw new Error('UNSAFE');
    return rm(state.root,{recursive:true,force:true});
  });
  if(!ok)throw new Error('DEPLOYMENT_ENVIRONMENT_CLEANUP_FAILED');
}
async function setup(state,databaseUrl,env){
  const storage={endpoint:env.UNAI_TEST_S3_ENDPOINT,bucket:env.UNAI_TEST_S3_BUCKET,kmsKeyId:env.UNAI_TEST_S3_KMS_KEY_ID};
  if(Object.values(storage).some(value=>!value?.trim()))throw new Error('DEPLOYMENT_ENVIRONMENT_STORAGE_MISSING');
  const {path,mount,material}=await phase(FILES,()=>files(state));
  const {logins,suffix}=await phase(DATABASE,()=>database(state,databaseUrl,material.database));
  await phase(FILES,()=>secrets(mount,logins));
  const {releaseId,ownerScopeId,actorId}=await publishAndOwn(state,env,suffix);
  const [apiPort,webPort]=await phase(FILES,async()=>[await freePort(),await freePort()]);
  return {
    UNAI_SECRETS_MOUNT:mount,
    UNAI_DATABASE_CA_FILE:path('database-ca.pem'),
    UNAI_APP_DATABASE_URL:'secret://mounted/app-database-url',
    UNAI_AUTH_DATABASE_URL:'secret://mounted/auth-database-url',
    UNAI_REGISTRY_RELEASE_ID:releaseId,
    UNAI_REGISTRY_RELEASE:RELEASE_VERSION,
    UNAI_S3_ENDPOINT:storage.endpoint,
    UNAI_S3_REGION:'us-east-1',
    UNAI_S3_BUCKET:storage.bucket,
    UNAI_S3_KMS_KEY_ID:storage.kmsKeyId,
    UNAI_API_PORT:String(apiPort),
    UNAI_API_TLS_KEY_FILE:path('api.key'),
    UNAI_API_TLS_CERT_FILE:path('api.pem'),
    UNAI_PROCESSING_OWNER_SCOPE_ID:ownerScopeId,
    UNAI_PROCESSING_ACTOR_ID:actorId,
    UNAI_PROCESSING_DATA_PURPOSE:'PERSONAL_ASSISTANCE',
    UNAI_PROCESSING_MAXIMUM_SENSITIVITY:'PRIVATE',
    UNAI_MODEL_PROVIDER:'anthropic',
    // RFC 2606 .invalid: the dummy key can never reach a real provider; --check never calls it.
    UNAI_MODEL_ENDPOINT:'https://model.invalid/v1/messages',
    UNAI_MODEL_ID:'harness-model',
    UNAI_MODEL_API_KEY:'secret://mounted/model-api-key',
    UNAI_MODEL_INPUT_MICROUNITS_PER_1K:'3000',
    UNAI_MODEL_OUTPUT_MICROUNITS_PER_1K:'15000',
    NEXTAUTH_URL:'https://127.0.0.1:'+webPort,
    UNAI_WEB_TLS_KEY_FILE:path('web.key'),
    UNAI_WEB_TLS_CERT_FILE:path('web.pem'),
    NEXTAUTH_SECRET:'secret://mounted/nextauth-secret',
    GOOGLE_CLIENT_SECRET:'secret://mounted/google-client-secret',
    // Google's documented client-ID shape (googleClientId); a client ID is public.
    GOOGLE_CLIENT_ID:'123456789012-0123456789abcdefghijklmnopqrstuv.apps.googleusercontent.com',
    UNAI_API_ORIGIN:'https://127.0.0.1:'+apiPort,
    UNAI_API_CA_FILE:path('api.pem'),
  };
}
/** Resolves {env, close}. `env` is the merged environment the command will get
 * ({...parent, ...harness.env}): delivered storage leaves UNAI_TEST_S3_* only in
 * the parent part. close() is memoized; it stops the terminator, waits for the
 * per-run logins to disconnect, drops them, ends the admin pool and removes the
 * temp root, attempting every step, then throws DEPLOYMENT_ENVIRONMENT_CLEANUP_FAILED
 * if any failed. Run it before harness.close(): roles are cluster-global. A setup
 * failure cleans up itself and rethrows its bare code. */
export async function deploymentEnvironment({databaseUrl,env}){
  const state={root:null,admin:null,proxy:null,roles:[]};
  let closing;
  const close=()=>closing??=teardown(state);
  try{return {env:await setup(state,databaseUrl,env),close};}
  catch(error){await close().catch(()=>{});throw error;}
}
