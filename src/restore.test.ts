import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {spawn,spawnSync} from 'node:child_process';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {existsSync} from 'node:fs';
import {chmod,copyFile,mkdir,mkdtemp,readdir,readFile,rm,symlink,writeFile} from 'node:fs/promises';
import {createServer,connect,type AddressInfo,type Server} from 'node:net';
import {createRequire} from 'node:module';
import {Agent} from 'node:https';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {TLSSocket} from 'node:tls';
import {runMigrations} from '../packages/postgres/src/index.js';
import {createEncryptedS3Store} from '../packages/storage/src/index.js';
// @ts-expect-error JavaScript harness helper.
import * as archiveLibrary from '../scripts/lib/backup-archive.mjs';
// @ts-expect-error JavaScript harness helper.
import {POSTGRES_IMAGE} from '../scripts/postgres-harness.mjs';
// @ts-expect-error JavaScript harness helper.
import {createSelfSignedCertificate} from '../scripts/tls-certificate.mjs';
// @ts-expect-error JavaScript harness helper.
import {startS3ObjectServer} from '../scripts/s3-object-server.mjs';
// @ts-expect-error JavaScript harness helper.
import {PROBE_QUESTIONS as probeQuestions,probeEnvironment as probeEnvironmentOf} from '../scripts/recovery-acceptance.mjs';

/**
 * `pnpm restore` (scripts/restore.mjs) as an operator runs it: a spawned process that restores a
 * fresh `pnpm backup` archive into a scratch database behind verified TLS and an empty prefix of
 * a second, in-process S3 bucket. The harness PostgreSQL is plain TCP, so a test-only terminator
 * answers the SSLRequest; restore.mjs and libpq verify the certificate exactly as in production,
 * and passwords reach them only through a 0600 pgpass file whose database field is `*`. Both
 * in-process S3 servers (the target bucket and an archive bucket for s3:// locations) accept one
 * test-owned credential pair, which the child reads through the SDK default chain, so no case
 * depends on delivered storage and nothing is skipped.
 *
 * FILE-SCOPE SETUP: everything above the first test is reused by task-0029882f's
 * `describe('pnpm restore:drill')`, appended at the END of this file. Keep it out of any
 * describe, under these names. Nothing writes to the source database after the backup: the
 * drill compares its probes with the untouched source.
 */
if(!process.env.UNAI_TEST_DATABASE_URL)throw new Error('Run pnpm test for the required PostgreSQL harness');
type Pool=Parameters<typeof runMigrations>[0];
interface Client{query(sql:string):Promise<unknown>;release():void}
interface Entry{name:string;size:number;bytes:Buffer}
interface Digest{table:string;digest:string;rows:number}
interface Writer{add(name:string,bytes:Uint8Array):Promise<void>;finish():Promise<{sha256:string;bytes:number}>}
const archive=archiveLibrary as {
  ARCHIVE_NAME:RegExp;
  readArchive(path:string,key:Buffer,onEntry:(entry:Entry)=>unknown):Promise<{sha256:string;entries:{name:string;size:number}[]}>;
  createArchiveWriter(path:string,key:Buffer):Promise<Writer>;
  tableDigests(client:Client):Promise<Digest[]>;
};
/** The inner manifest.json exactly as scripts/backup.mjs writes it. */
interface Manifest{
  format:string;createdAt:string;serverVersionNum:number;pgDumpMajor:number;migrations:{head:string;count:number};
  registryReleases:{id:string;semanticVersion:string;contentHash:string}[];tables:Digest[];evidence:{live:number;deleted:number};
  objects:{entry:string;evidenceObjectKeyId:string;ownerScopeId:string;key:string;sha256:string}[];
}
interface S3Server{endpoint:string;certificate:string;operations:string[];receiptOverrides:Record<string,string>;close():Promise<void>}
interface S3Output{ServerSideEncryption?:string;SSEKMSKeyId?:string;Contents?:{Key:string}[];Body?:{transformToByteArray():Promise<Uint8Array>}}
interface S3Client{send(command:object):Promise<S3Output>;destroy():void}
const sdk=createRequire(new URL('../packages/storage/package.json',import.meta.url))('@aws-sdk/client-s3') as {S3Client:new(config:object)=>S3Client;
  GetObjectCommand:new(input:object)=>object;ListObjectsV2Command:new(input:object)=>object;PutObjectCommand:new(input:object)=>object;
  DeleteObjectCommand:new(input:object)=>object};
const {Pool:PgPool}=createRequire(new URL('../packages/postgres/package.json',import.meta.url))('pg') as
  {Pool:new(config:{connectionString:string;max?:number;idleTimeoutMillis?:number})=>Pool};
const need=(name:string)=>{const value=process.env[name];if(!value)throw new Error('HARNESS_VARIABLE_MISSING '+name);return value;};
const storage={endpoint:need('UNAI_TEST_S3_ENDPOINT'),region:'us-east-1',bucket:need('UNAI_TEST_S3_BUCKET'),kmsKeyId:need('UNAI_TEST_S3_KMS_KEY_ID')};
const posix=process.platform!=='win32';
const hex=randomBytes(6).toString('hex');
const serverUrl=new URL(need('UNAI_TEST_DATABASE_URL'));
const harnessUser=decodeURIComponent(serverUrl.username);
const sourceDatabase='unai_restore_src_'+hex,probeRole='unai_restore_probe_'+hex,probePassword=randomBytes(18).toString('hex');
/** Every scratch database this file created (dropped in afterAll) and every raw pool but admin (ended first). */
const databases:string[]=[],pools:Pool[]=[];
function pgPool(database:string,max=2):Pool{
  const url=new URL(serverUrl.href);url.pathname='/'+database;
  const pool=new PgPool({connectionString:url.href,max,idleTimeoutMillis:1000});
  pool.on('error',()=>{});
  pools.push(pool);
  return pool;
}
const admin=new PgPool({connectionString:serverUrl.href,max:1});
admin.on('error',()=>{});
const source=pgPool(sourceDatabase);
const owner=randomUUID(),actor=randomUUID(),liveKey=randomUUID(),erasedKey=randomUUID();
const objectKey='evidence/OBJKEY-SENTINEL-'+hex+'/'+liveKey;
const objectBytes=Buffer.concat([Buffer.from('restore fixture '),randomBytes(4096)]);
const sha256=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex');
const script=resolve('scripts/restore.mjs'),backupScript=resolve('scripts/backup.mjs');
const region='us-west-2';
/** The one credential both in-process S3 servers accept; never the harness pair. */
const pair={accessKeyId:'unai-restore-test-'+randomBytes(8).toString('hex'),secretAccessKey:randomBytes(32).toString('hex')};
const targetBucket='restore-target-'+hex,archiveBucket='restore-archive-'+hex,archivePrefix='ARCHPREFIX-SENTINEL-'+hex+'/host/';
const kmsArn=(name:string)=>'arn:aws:kms:'+region+':111122223333:key/'+name+'-'+hex;
const targetArn=kmsArn('TARGETKMS-SENTINEL'),archiveArn=kmsArn('ARCHIVEKMS-SENTINEL'),otherArn=kmsArn('OTHERKMS-SENTINEL');
/** restore.mjs must never read these: every child gets them, and no output may echo one. */
const unaiS3Sentinels={UNAI_S3_ENDPOINT:'https://unai-s3-sentinel.invalid/UNAI-S3-SENTINEL-endpoint',UNAI_S3_REGION:'UNAI-S3-SENTINEL-region',
  UNAI_S3_BUCKET:'UNAI-S3-SENTINEL-bucket',UNAI_S3_KMS_KEY_ID:'arn:aws:kms:us-east-1:111122223333:key/UNAI-S3-SENTINEL-key'};
let root='',key=Buffer.alloc(0),otherKey=Buffer.alloc(0),keyFile='',otherKeyFile='',caFile='',caBundle='',passFile='';
let passLines:string[]=[],proxy:Server|undefined,proxyPort=0,pgDump:string[]=[],pgRestore:string[]=[],connector='';
/** root/archives: exactly one complete `pnpm backup` archive (name, path, size, sha256), its inner manifest and sidecar. */
let archiveDirectory='',archiveName='',archivePath='',archiveBytes=0,archiveSha256='',dumpParts=0;
let manifest!:Manifest,sidecar:Record<string,unknown>={},sourceDigests:Digest[]=[];
let targetServer!:S3Server,archiveServer!:S3Server,targetClient!:S3Client,archiveClient!:S3Client;
const outputs:string[]=[];

/** A TLS terminator for the PostgreSQL wire protocol in front of the plain harness server. */
async function startPostgresTlsProxy(cert:string,tlsKey:string):Promise<{server:Server;port:number}>{
  const server=createServer(client=>{
    client.once('data',first=>{
      if(first.length<8||first.readInt32BE(4)!==80877103){client.destroy();return;}
      client.pause();client.write('S');
      const secure=new TLSSocket(client,{isServer:true,cert,key:tlsKey});
      const upstream=connect(Number(serverUrl.port||5432),serverUrl.hostname);
      secure.pipe(upstream).pipe(secure);
      secure.on('error',()=>upstream.destroy());
      upstream.on('error',()=>secure.destroy());
      client.resume();
    });
    client.on('error',()=>client.destroy());
  });
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));
  return {server,port:(server.address() as AddressInfo).port};
}
/** A PostgreSQL client tool of the server's major: a host binary, else the pinned harness image. The
 * docker fallback needs --interactive: pg_restore reads the dump on stdin. */
function pgTool(tool:string,major:number):string[]{
  const host='/usr/lib/postgresql/'+major+'/bin/'+tool;
  if(existsSync(host))return [host];
  const onPath=spawnSync(tool,['--version'],{encoding:'utf8'});
  if(!onPath.error&&onPath.status===0&&onPath.stdout.includes('(PostgreSQL) '+major+'.'))return [tool];
  if(!posix)throw new Error(tool.toUpperCase()+'_'+major+'_REQUIRED');
  const names=['PGHOST','PGPORT','PGUSER','PGDATABASE','PGSSLMODE','PGSSLROOTCERT','PGPASSFILE','PGCONNECT_TIMEOUT','PGAPPNAME'];
  return ['docker','run','--rm','--interactive','--network','host','--user',`${process.getuid?.()}:${process.getgid?.()}`,
    '--volume',`${root}:${root}:ro`,...names.flatMap(name=>['--env',name]),POSTGRES_IMAGE,tool];
}
/** A password-less URL through the terminator; the password comes from the `*` pgpass. */
const terminatorUrl=(user:string,database:string)=>`postgresql://${encodeURIComponent(user)}@127.0.0.1:${proxyPort}/${database}`;
/** One source item of the seeded connector and its evidence key row; `deleted` erases both. */
async function item(keyId:string,storeKey:string,hash:string,deleted:boolean){
  const id=randomUUID(),erased=deleted?'clock_timestamp()':'NULL';
  await source.query(`INSERT INTO source_items(id,owner_scope_id,connector_id,source_type,external_id,actor_ref,submitted_by_user_id,
    raw_object_ref,content_hash,sensitivity,allowed_purposes,ingestion_version,idempotency_key,deleted_at) VALUES($1,$2,$3,'CONVERSATION',$4,$5,$6,$7,$8,
    'PRIVATE',ARRAY['PERSONAL_ASSISTANCE'],'evidence-json-v1',$9,${erased})`,
    [id,owner,connector,'restore-'+keyId,JSON.stringify({type:'USER',id:actor}),actor,randomUUID(),hash,randomUUID()]);
  await source.query(`INSERT INTO evidence_object_keys(id,owner_scope_id,source_item_id,object_store_key,encryption_key_ref,deleted_at)
    VALUES($1,$2,$3,$4,$5,${erased})`,[keyId,owner,id,storeKey,'kms:'+storage.kmsKeyId]);
}
/** backup.test.ts's fixture: ONE owner scope with one OWNER member, one live and one erased item. */
async function seed(){
  await source.query('INSERT INTO users(id,display_name) VALUES($1,$2)',[actor,'Restore owner']);
  await source.query("INSERT INTO owner_scopes(id,scope_kind,display_name,created_by_user_id) VALUES($1,'PERSONAL','Restore',$2)",[owner,actor]);
  await source.query("INSERT INTO owner_scope_members(owner_scope_id,user_id,role) VALUES($1,$2,'OWNER')",[owner,actor]);
  connector=randomUUID();
  await source.query("INSERT INTO connectors(id,owner_scope_id,connector_type,external_account_ref,permission_manifest,status) VALUES($1,$2,'CONVERSATION',$3,'{}','ACTIVE')",
    [connector,owner,'restore-'+owner]);
  await item(liveKey,objectKey,sha256(objectBytes),false);
  await item(erasedKey,'evidence/erased/'+erasedKey,sha256('erased'),true);
  const store=await createEncryptedS3Store(storage,async(_context,id)=>id===liveKey?objectKey:null);
  try{await store.put({actorId:actor,ownerScopeId:owner,purpose:'evidence.ingest',correlationId:randomUUID()},liveKey,objectBytes);}
  finally{store.close();}
}

interface Run{status:number|null;stdout:string;stderr:string}
/** A script as a child process; every output lands in `outputs` for the sentinel test. Never spawnSync:
 * the terminator and both S3 servers live on this event loop. */
function spawnScript(path:string,args:string[],env:NodeJS.ProcessEnv):Promise<Run>{
  return new Promise((done,reject)=>{
    const child=spawn(process.execPath,[path,...args],{env});
    let stdout='',stderr='';
    child.stdout.on('data',chunk=>{stdout+=chunk;});
    child.stderr.on('data',chunk=>{stderr+=chunk;});
    child.once('error',reject);
    child.once('close',status=>{outputs.push(stdout,stderr);done({status,stdout,stderr});});
  });
}
/** The restore child's environment: no inherited password, database URL, AWS profile or UNAI_RESTORE_*,
 * the test pair through the SDK env chain, a bundle trusting both S3 servers, and UNAI_S3_* sentinels. */
function restoreEnv(overrides:Record<string,string|undefined>={}):NodeJS.ProcessEnv{
  const env={...process.env};
  for(const name of Object.keys(env)){
    if(['PGPASSWORD','UNAI_TEST_DATABASE_URL','DATABASE_URL','AWS_PROFILE','AWS_SESSION_TOKEN'].includes(name)||name.startsWith('UNAI_RESTORE_'))delete env[name];
  }
  Object.assign(env,{PGPASSFILE:passFile,UNAI_DATABASE_CA_FILE:caFile,UNAI_RESTORE_KEY_FILE:keyFile,UNAI_RESTORE_PG_RESTORE:JSON.stringify(pgRestore),
    UNAI_RESTORE_S3_ENDPOINT:targetServer.endpoint,UNAI_RESTORE_S3_REGION:region,UNAI_RESTORE_S3_BUCKET:targetBucket,UNAI_RESTORE_S3_KMS_KEY_ID:targetArn,
    AWS_ACCESS_KEY_ID:pair.accessKeyId,AWS_SECRET_ACCESS_KEY:pair.secretAccessKey,NODE_EXTRA_CA_CERTS:caBundle,...unaiS3Sentinels});
  for(const [name,value] of Object.entries(overrides)){if(value===undefined)delete env[name];else env[name]=value;}
  return env;
}
const run=(args:string[],overrides:Record<string,string|undefined>={})=>spawnScript(script,args,restoreEnv(overrides));
/** `pnpm backup` of the source into root/archives, with the harness evidence store and AWS pair. */
function backupEnv():NodeJS.ProcessEnv{
  const env={...process.env};
  for(const name of Object.keys(env)){
    if(['PGPASSWORD','UNAI_TEST_DATABASE_URL','DATABASE_URL'].includes(name)||name.startsWith('UNAI_BACKUP_')||name.startsWith('UNAI_RESTORE_'))delete env[name];
  }
  return Object.assign(env,{UNAI_BACKUP_DATABASE_URL:terminatorUrl(harnessUser,sourceDatabase),UNAI_DATABASE_CA_FILE:caFile,
    UNAI_S3_ENDPOINT:storage.endpoint,UNAI_S3_REGION:storage.region,UNAI_S3_BUCKET:storage.bucket,UNAI_S3_KMS_KEY_ID:storage.kmsKeyId,
    UNAI_BACKUP_KEY_FILE:keyFile,UNAI_BACKUP_DESTINATION:archiveDirectory,UNAI_BACKUP_PG_DUMP:JSON.stringify(pgDump),PGPASSFILE:passFile});
}
function line(text:string):Record<string,unknown>{
  const lines=text.split('\n').filter(Boolean);
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0] as string) as Record<string,unknown>;
}
function refused(result:Run,code:string,variable?:string,status=1){
  expect(result.stdout).toBe('');
  expect(line(result.stderr)).toEqual(variable?{event:'restore.failed',code,variable}:{event:'restore.failed',code});
  expect(result.status).toBe(status);
}
/** A PASS: exit 0, nothing on stderr, exactly one restore.completed line. */
function passed(result:Run):Record<string,unknown>{
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
  const summary=line(result.stdout);
  expect(summary).toMatchObject({event:'restore.completed',verdict:'PASS'});
  return summary;
}
async function digestsOf(pool:Pool):Promise<Digest[]>{
  const client:Client=await pool.connect();
  try{
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    const digests=await archive.tableDigests(client);
    await client.query('COMMIT');
    return digests;
  }finally{client.release();}
}
/** The in-process server ignores Prefix (and its own requests are logged), so filter client-side. */
async function keysUnder(prefix:string,client=targetClient,bucket=targetBucket):Promise<string[]>{
  const listed=await client.send(new sdk.ListObjectsV2Command({Bucket:bucket,Prefix:prefix}));
  return (listed.Contents??[]).map(entry=>entry.Key).filter(key=>key.startsWith(prefix)).sort();
}
const plant=(key:string)=>targetClient.send(new sdk.PutObjectCommand({Bucket:targetBucket,Key:key,Body:'planted',ServerSideEncryption:'aws:kms',SSEKMSKeyId:targetArn}));
const upload=(key:string,body:Uint8Array|string)=>
  archiveClient.send(new sdk.PutObjectCommand({Bucket:archiveBucket,Key:key,Body:body,ServerSideEncryption:'aws:kms',SSEKMSKeyId:archiveArn}));

interface Target{label:string;database:string;prefix:string;url:string;pool:Pool}
let targets=0;
/** A new empty database (with `vector` when provisioned the way deploy/postgres/provision.sql does) and a fresh prefix;
 * `label` names the case in a failure message only. */
async function freshTarget(label:string,{vector=false}:{vector?:boolean}={}):Promise<Target>{
  const n=++targets,database='unai_restore_tgt_'+hex+'_'+n;
  await admin.query('CREATE DATABASE '+database);
  databases.push(database);
  const pool=pgPool(database);
  if(vector)await pool.query('CREATE EXTENSION vector');
  return {label,database,prefix:'RESTORE-PREFIX-SENTINEL-'+hex+'-'+n+'/',url:terminatorUrl(harnessUser,database),pool};
}
/** Exactly one run into `target`, with the operations it caused on each S3 server. */
async function restoreTo(target:Target,overrides:Record<string,string|undefined>={},args:string[]=[]){
  const targetBefore=targetServer.operations.length,archiveBefore=archiveServer.operations.length;
  const result=await run(args,{UNAI_RESTORE_ARCHIVE:archivePath,UNAI_RESTORE_DATABASE_URL:target.url,UNAI_RESTORE_S3_PREFIX:target.prefix,...overrides});
  return {result,targetOperations:targetServer.operations.slice(targetBefore),archiveOperations:archiveServer.operations.slice(archiveBefore)};
}
/** Relations in public, schemas besides public/information_schema/pg_*, and keys under the prefix. */
async function stateOf(target:Target,prefix=target.prefix){
  const relations=(await target.pool.query("SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' ORDER BY 1"))
    .rows.map(row=>String(row.relname));
  const schemas=(await target.pool.query("SELECT nspname FROM pg_namespace WHERE nspname NOT IN ('public','information_schema') AND nspname !~ '^pg_' ORDER BY 1"))
    .rows.map(row=>String(row.nspname));
  return {relations,schemas,keys:await keysUnder(prefix)};
}
async function untouched(target:Target,prefix=target.prefix){
  expect(await stateOf(target,prefix),target.label).toEqual({relations:[],schemas:[],keys:[]});
}
async function copyTriple(directory:string){
  await mkdir(directory,{recursive:true});
  for(const suffix of ['','.sha256','.manifest.json'])await copyFile(join(archiveDirectory,archiveName+suffix),join(directory,archiveName+suffix));
}
/** Both sidecars for `name` as `pnpm backup` writes them, by suffix, for an archive of `bytes` hashing to `digest`. */
const sidecarsOf=(name:string,digest:string,bytes:number)=>({'.sha256':digest+'  '+name+'\n',
  '.manifest.json':JSON.stringify({...sidecar,archive:name,sha256:digest,bytes},null,2)+'\n'});
async function writeSidecars(directory:string,name:string,digest:string,bytes:number){
  for(const [suffix,body] of Object.entries(sidecarsOf(name,digest,bytes)))await writeFile(join(directory,name+suffix),body);
}
/** The archive re-sealed under the SAME key with a mutated inner manifest, as a 2020 archive with fresh sidecars. */
async function reseal(label:string,mutate:(inner:Manifest)=>void):Promise<string>{
  const directory=join(root,'crafted-'+label),name='uai-backup-20200101T000000Z.tar.enc',path=join(directory,name);
  await mkdir(directory);
  const entries:Entry[]=[];
  await archive.readArchive(archivePath,key,entry=>{entries.push(entry);});
  const inner=JSON.parse((entries[0] as Entry).bytes.toString('utf8')) as Manifest;
  mutate(inner);
  const writer=await archive.createArchiveWriter(path,key);
  await writer.add('manifest.json',Buffer.from(JSON.stringify(inner)));
  for(const entry of entries.slice(1))await writer.add(entry.name,entry.bytes);
  const written=await writer.finish();
  await writeSidecars(directory,name,written.sha256,written.bytes);
  return path;
}
/** Every value that must never reach an output, including the drill's (task-0029882f calls this too). */
function sentinels():string[]{
  const values=[serverUrl.href,terminatorUrl(harnessUser,sourceDatabase),...databases.map(database=>terminatorUrl(harnessUser,database)),
    '127.0.0.1:'+proxyPort,...passLines,probePassword,key.toString('hex'),key.toString('base64'),otherKey.toString('hex'),otherKey.toString('base64'),
    keyFile,otherKeyFile,passFile,caFile,caBundle,root,'OBJKEY-SENTINEL','URLPASS-SENTINEL','PGPASS-SENTINEL',targetBucket,archiveBucket,
    'RESTORE-PREFIX-SENTINEL','ARCHPREFIX-SENTINEL','RESTORE-OUTSIDE-SENTINEL',targetArn,archiveArn,otherArn,'KMS-SENTINEL',targetServer.endpoint,archiveServer.endpoint,
    pair.secretAccessKey,'UNAI-S3-SENTINEL'];
  const password=decodeURIComponent(serverUrl.password);
  if(password)values.push(password);
  return values.filter(Boolean);
}
/** No output recorded so far names a sentinel; the drill calls this again at the end of its describe. */
function expectNoSentinels(){
  const values=sentinels();
  outputs.forEach((output,index)=>values.forEach((value,sentinel)=>{
    if(output.includes(value))expect.fail('output '+index+' names sentinel '+sentinel);
  }));
}

beforeAll(async()=>{
  await admin.query('CREATE DATABASE '+sourceDatabase);
  databases.push(sourceDatabase);
  // Migration 0001 alters cluster-global roles and runMigrations serializes only within one database:
  // take the lock every scratch-database suite (backup.test.ts included) takes on the shared database.
  const lock=await admin.connect();
  try{await lock.query('SELECT pg_advisory_lock(1970170217,3)');await runMigrations(source,resolve('migrations'));}
  finally{await lock.query('SELECT pg_advisory_unlock(1970170217,3)').catch(()=>{});lock.release(true);}
  root=await mkdtemp(join(tmpdir(),'unai-restore-test-'));
  key=randomBytes(32);otherKey=randomBytes(32);
  keyFile=join(root,'backup.key');otherKeyFile=join(root,'other.key');
  await writeFile(keyFile,key,{mode:0o600});await writeFile(otherKeyFile,otherKey,{mode:0o600});
  const {certificate,key:tlsKey}=createSelfSignedCertificate() as {certificate:string;key:string};
  caFile=join(root,'ca.pem');await writeFile(caFile,certificate);
  const started=await startPostgresTlsProxy(certificate,tlsKey);
  proxy=started.server;proxyPort=started.port;
  await admin.query(`CREATE ROLE ${probeRole} LOGIN NOSUPERUSER PASSWORD '${probePassword}'`);
  const escape=(value:string)=>value.replace(/[\\:]/g,'\\$&');
  passLines=[[harnessUser,decodeURIComponent(serverUrl.password)],[probeRole,probePassword]]
    .map(([user,password])=>['127.0.0.1',String(proxyPort),'*',escape(user as string),escape(password as string)].join(':'));
  passFile=join(root,'pgpass');await writeFile(passFile,passLines.join('\n')+'\n',{mode:0o600});
  await chmod(passFile,0o600);
  const version=Number((await source.query('SHOW server_version_num')).rows[0].server_version_num);
  pgDump=pgTool('pg_dump',Math.floor(version/10000));pgRestore=pgTool('pg_restore',Math.floor(version/10000));
  await seed();

  // Each server has a subject of its own: OpenSSL picks a trust anchor by subject, and both share one bundle.
  const startServer=startS3ObjectServer as (options:object)=>Promise<S3Server>;
  targetServer=await startServer({bucket:targetBucket,kmsKeyId:targetArn,credentials:pair,commonName:'unai-restore-target-'+hex,logOperations:true});
  archiveServer=await startServer({bucket:archiveBucket,kmsKeyId:archiveArn,credentials:pair,commonName:'unai-restore-archive-'+hex,logOperations:true});
  caBundle=join(root,'s3-ca-bundle.pem');
  await writeFile(caBundle,targetServer.certificate+'\n'+archiveServer.certificate);
  const clientOf=(server:S3Server)=>new sdk.S3Client({endpoint:server.endpoint,region,forcePathStyle:true,credentials:pair,
    requestHandler:{httpsAgent:new Agent({ca:server.certificate,rejectUnauthorized:true})}});
  targetClient=clientOf(targetServer);archiveClient=clientOf(archiveServer);

  // backup.test.ts's 'busy' case briefly holds unai_api_login on this cluster: retry that refusal only, bounded.
  archiveDirectory=join(root,'archives');await mkdir(archiveDirectory);
  let backup:Run={status:null,stdout:'',stderr:''};
  for(let attempt=1;attempt<=20;attempt++){
    backup=await spawnScript(backupScript,['--assume-quiescent'],backupEnv());
    if(backup.status===0||!backup.stderr.includes('"code":"BACKUP_PRECONDITION_FAILED"'))break;
    await delay(3000);
  }
  if(backup.status!==0)throw new Error('RESTORE_TEST_BACKUP_FAILED '+backup.stderr.trim());
  archiveName=String(line(backup.stdout).archive);
  archivePath=join(archiveDirectory,archiveName);
  expect((await readdir(archiveDirectory)).sort()).toEqual([archiveName,archiveName+'.manifest.json',archiveName+'.sha256']);
  const file=await readFile(archivePath);
  archiveBytes=file.length;archiveSha256=sha256(file);
  let inner=Buffer.alloc(0);
  await archive.readArchive(archivePath,key,entry=>{
    if(entry.name==='manifest.json')inner=Buffer.from(entry.bytes);
    if(entry.name.startsWith('database.dump.'))dumpParts++;
  });
  manifest=JSON.parse(inner.toString('utf8')) as Manifest;
  sidecar=JSON.parse(await readFile(archivePath+'.manifest.json','utf8')) as Record<string,unknown>;
  sourceDigests=await digestsOf(source);
},600000);

afterAll(async()=>{
  proxy?.close();
  const stuck:string[]=[];
  try{
    for(const pool of pools)await pool.end().catch(()=>{});
    // Pool.end() resolves before idle backends exit; FORCE must never kill a closing client.
    for(const database of databases){
      let idle=false;
      for(let attempt=0;attempt<200&&!idle;attempt++){
        idle=(await admin.query('SELECT 1 FROM pg_stat_activity WHERE datname=$1',[database])).rowCount===0;
        if(!idle)await delay(25);
      }
      if(idle)await admin.query('DROP DATABASE IF EXISTS '+database+' WITH (FORCE)');
      else stuck.push(database);
    }
    await admin.query('DROP ROLE IF EXISTS '+probeRole);
    if(stuck.length)throw new Error('RESTORE_TEST_BACKENDS_STILL_ACTIVE');
  }finally{
    await admin.end();
    targetClient?.destroy();archiveClient?.destroy();
    await targetServer?.close();await archiveServer?.close();
    key.fill(0);otherKey.fill(0);
    if(root)await rm(root,{recursive:true,force:true});
  }
},180000);

it('restores the fresh backup into an empty database and prefix: PASS, and the target digests equal the source',async()=>{
  const target=await freshTarget('pass',{vector:true});
  const outside='RESTORE-OUTSIDE-SENTINEL-'+hex+'/planted';
  await plant(outside);
  const {result,targetOperations,archiveOperations}=await restoreTo(target);
  const summary=passed(result);
  const tables=manifest.tables.length;
  expect(summary).toEqual({event:'restore.completed',verdict:'PASS',format:'uai-backup/1',archive:archiveName,createdAt:manifest.createdAt,
    sha256:archiveSha256,bytes:archiveBytes,tables,tablesVerified:tables,rows:manifest.tables.reduce((sum,table)=>sum+table.rows,0),
    objects:1,objectsVerified:1,deletedObjects:1,dumpParts,migrationHead:manifest.migrations.head,migrations:manifest.migrations.count,
    registryReleases:manifest.registryReleases.map(release=>release.semanticVersion),durationMs:expect.any(Number)});
  expect(Object.keys(summary)).toEqual(['event','verdict','format','archive','createdAt','sha256','bytes','tables','tablesVerified','rows',
    'objects','objectsVerified','deletedObjects','dumpParts','migrationHead','migrations','registryReleases','durationMs']);
  expect(tables).toBeGreaterThan(0);
  expect(sourceDigests).toEqual(manifest.tables);
  expect(await digestsOf(target.pool)).toEqual(sourceDigests);
  expect(targetOperations).toEqual(['GetBucketEncryption','ListObjectsV2','PutObject','GetObject']);
  expect(archiveOperations).toEqual([]);
  expect(await keysUnder(target.prefix)).toEqual([target.prefix+objectKey]);
  expect(await keysUnder(outside)).toEqual([outside]);
  const object=await targetClient.send(new sdk.GetObjectCommand({Bucket:targetBucket,Key:target.prefix+objectKey}));
  expect([object.ServerSideEncryption,object.SSEKMSKeyId]).toEqual(['aws:kms',targetArn]);
  expect(sha256(await (object.Body as {transformToByteArray():Promise<Uint8Array>}).transformToByteArray())).toBe(sha256(objectBytes));
},600000);

it('a /-terminated local directory selects the newest archive that has both sidecars',async()=>{
  const directory=join(root,'select');
  await copyTriple(directory);
  // An OLDER complete archive (the same bytes under a 2000 name): picking the oldest would restore it and report its name.
  const older='uai-backup-20000101T000000Z.tar.enc';
  await copyFile(join(directory,archiveName),join(directory,older));
  await writeSidecars(directory,older,archiveSha256,archiveBytes);
  const newer=(day:string)=>'uai-backup-209901'+day+'T000000Z.tar.enc';
  await writeFile(join(directory,newer('01')),'incomplete');await writeFile(join(directory,newer('01')+'.sha256'),'incomplete');
  await writeFile(join(directory,newer('02')),'incomplete');await writeFile(join(directory,newer('02')+'.manifest.json'),'incomplete');
  await mkdir(join(directory,newer('03')));
  for(const suffix of ['.sha256','.manifest.json']){
    await copyFile(join(directory,archiveName+suffix),join(directory,newer('03')+suffix));
    await writeFile(join(directory,newer('05')+suffix),'sidecar without its archive');
  }
  if(posix){
    await symlink(join(directory,archiveName),join(directory,newer('04')));
    for(const suffix of ['.sha256','.manifest.json'])await copyFile(join(directory,archiveName+suffix),join(directory,newer('04')+suffix));
  }
  const target=await freshTarget('select');
  const {result}=await restoreTo(target,{UNAI_RESTORE_ARCHIVE:directory+sep});
  expect(passed(result)).toMatchObject({archive:archiveName,tablesVerified:manifest.tables.length,objectsVerified:1});
},600000);

it('restores an s3:// archive through an empty staging directory, and empties it after success and failure',async()=>{
  const newer='uai-backup-20990101T000000Z.tar.enc',nested=archivePrefix+'nested/',location='s3://'+archiveBucket+'/'+archivePrefix;
  for(const suffix of ['','.sha256','.manifest.json'])await upload(archivePrefix+archiveName+suffix,await readFile(archivePath+suffix));
  // An OLDER complete triple beside it (the same bytes under a 2000 name): picking the oldest would restore it and report its name.
  const older='uai-backup-20000101T000000Z.tar.enc';
  await upload(archivePrefix+older,await readFile(archivePath));
  for(const [suffix,body] of Object.entries(sidecarsOf(older,archiveSha256,archiveBytes)))await upload(archivePrefix+older+suffix,body);
  await upload(archivePrefix+newer,'incomplete');await upload(archivePrefix+newer+'.sha256','incomplete');
  for(const suffix of ['','.sha256','.manifest.json'])await upload(nested+'uai-backup-20990202T000000Z.tar.enc'+suffix,await readFile(archivePath+suffix));
  const s3Env=async(label:string,named:string)=>{
    const staging=join(root,'staging-'+label);await mkdir(staging);
    return {staging,overrides:{UNAI_RESTORE_ARCHIVE:location+named,UNAI_RESTORE_STAGING_DIR:staging,
      UNAI_RESTORE_ARCHIVE_S3_ENDPOINT:archiveServer.endpoint,UNAI_RESTORE_ARCHIVE_S3_REGION:region}};
  };

  const named=await s3Env('named',archiveName),namedTarget=await freshTarget('s3-named');
  const first=await restoreTo(namedTarget,named.overrides);
  expect(passed(first.result)).toMatchObject({archive:archiveName,sha256:archiveSha256,objectsVerified:1});
  expect(first.archiveOperations).toEqual(['ListObjectsV2','GetObject','GetObject','GetObject']);
  expect(first.targetOperations).toEqual(['GetBucketEncryption','ListObjectsV2','PutObject','GetObject']);
  expect(await readdir(named.staging)).toEqual([]);
  expect(await digestsOf(namedTarget.pool)).toEqual(sourceDigests);

  const newest=await s3Env('newest',''),newestTarget=await freshTarget('s3-newest');
  const second=await restoreTo(newestTarget,newest.overrides);
  expect(passed(second.result)).toMatchObject({archive:archiveName,objectsVerified:1});
  expect(second.archiveOperations).toEqual(['ListObjectsV2','GetObject','GetObject','GetObject']);
  expect(await readdir(newest.staging)).toEqual([]);

  const incomplete=await s3Env('incomplete',newer),incompleteTarget=await freshTarget('s3-incomplete');
  const third=await restoreTo(incompleteTarget,incomplete.overrides);
  refused(third.result,'RESTORE_ARCHIVE_INCOMPLETE');
  expect(third.archiveOperations).toEqual(['ListObjectsV2']);
  expect(third.targetOperations).toEqual([]);
  expect(await readdir(incomplete.staging)).toEqual([]);
  await untouched(incompleteTarget);

  const wrongKey=await s3Env('wrong-key',archiveName),wrongKeyTarget=await freshTarget('s3-wrong-key');
  const fourth=await restoreTo(wrongKeyTarget,{...wrongKey.overrides,UNAI_RESTORE_KEY_FILE:otherKeyFile});
  refused(fourth.result,'RESTORE_KEY_INVALID');
  expect(fourth.archiveOperations).toEqual(['ListObjectsV2','GetObject','GetObject','GetObject']);
  expect(fourth.targetOperations).toEqual([]);
  expect(await readdir(wrongKey.staging)).toEqual([]);
  await untouched(wrongKeyTarget);
},900000);

it('refuses a tampered archive with RESTORE_ARCHIVE_INTEGRITY_FAILED before any write, with or without recomputed sidecars',async()=>{
  for(const recompute of [false,true]){
    const directory=join(root,recompute?'tampered-resealed':'tampered');
    await copyTriple(directory);
    const path=join(directory,archiveName),bytes=await readFile(path);
    const at=Math.floor((34+bytes.length-16)/2);
    bytes[at]=(bytes[at] as number)^0x01;
    await writeFile(path,bytes);
    if(recompute)await writeSidecars(directory,archiveName,sha256(bytes),bytes.length);
    const target=await freshTarget(recompute?'tampered-resealed':'tampered');
    const {result,targetOperations}=await restoreTo(target,{UNAI_RESTORE_ARCHIVE:path});
    refused(result,'RESTORE_ARCHIVE_INTEGRITY_FAILED');
    expect(targetOperations).toEqual([]);
    await untouched(target);
  }
},600000);

it('refuses an authentic archive whose sidecars disagree with it: RESTORE_ARCHIVE_INTEGRITY_FAILED before any write',async()=>{
  // Only the sidecars change, so the archive still authenticates: the file's own digest and the .sha256 line must decide.
  const cases:[string,(directory:string)=>Promise<void>][]=[
    ['digest',directory=>writeSidecars(directory,archiveName,sha256('another archive'),archiveBytes)],
    ['line',directory=>writeFile(join(directory,archiveName+'.sha256'),archiveSha256+'  uai-backup-20000101T000000Z.tar.enc\n')],
  ];
  for(const [label,alter] of cases){
    const directory=join(root,'sidecar-'+label);
    await copyTriple(directory);
    await alter(directory);
    const target=await freshTarget('sidecar-'+label);
    const {result,targetOperations}=await restoreTo(target,{UNAI_RESTORE_ARCHIVE:join(directory,archiveName)});
    refused(result,'RESTORE_ARCHIVE_INTEGRITY_FAILED');
    expect(targetOperations).toEqual([]);
    await untouched(target);
  }
},600000);

it('refuses a non-empty database or prefix with RESTORE_TARGET_NOT_EMPTY and leaves it as it was',async()=>{
  const table=await freshTarget('table');
  await table.pool.query('CREATE TABLE public.planted_relation(id int)');
  const tableRun=await restoreTo(table);
  refused(tableRun.result,'RESTORE_TARGET_NOT_EMPTY');
  expect(tableRun.targetOperations).toEqual([]);
  expect(await stateOf(table)).toEqual({relations:['planted_relation'],schemas:[],keys:[]});

  const schema=await freshTarget('schema');
  await schema.pool.query('CREATE SCHEMA planted_schema');
  const schemaRun=await restoreTo(schema);
  refused(schemaRun.result,'RESTORE_TARGET_NOT_EMPTY');
  expect(schemaRun.targetOperations).toEqual([]);
  expect(await stateOf(schema)).toEqual({relations:[],schemas:['planted_schema'],keys:[]});

  const object=await freshTarget('object');
  await plant(object.prefix+'planted');
  const objectRun=await restoreTo(object);
  refused(objectRun.result,'RESTORE_TARGET_NOT_EMPTY');
  expect(objectRun.targetOperations).toEqual(['GetBucketEncryption','ListObjectsV2']);
  expect(await stateOf(object)).toEqual({relations:[],schemas:[],keys:[object.prefix+'planted']});

  const bucket=await freshTarget('bucket'),before=await keysUnder('');
  expect(before.length).toBeGreaterThan(0);
  const bucketRun=await restoreTo(bucket,{UNAI_RESTORE_S3_PREFIX:undefined});
  refused(bucketRun.result,'RESTORE_TARGET_NOT_EMPTY');
  expect(bucketRun.targetOperations).toEqual(['GetBucketEncryption','ListObjectsV2']);
  expect(await keysUnder('')).toEqual(before);
  await untouched(bucket);
},600000);

it('fails the restore when a PutObject or GetObject receipt names another key',async()=>{
  targetServer.receiptOverrides.PutObject=otherArn;
  try{
    const target=await freshTarget('put-receipt');
    const {result,targetOperations}=await restoreTo(target);
    refused(result,'RESTORE_OBJECT_WRITE_FAILED');
    expect(targetOperations).toEqual(['GetBucketEncryption','ListObjectsV2','PutObject']);
  }finally{delete targetServer.receiptOverrides.PutObject;}
  targetServer.receiptOverrides.GetObject=otherArn;
  try{
    const target=await freshTarget('get-receipt');
    const {result,targetOperations}=await restoreTo(target);
    refused(result,'RESTORE_OBJECT_UNREADABLE');
    expect(targetOperations).toEqual(['GetBucketEncryption','ListObjectsV2','PutObject','GetObject']);
  }finally{delete targetServer.receiptOverrides.GetObject;}
},600000);

it('stops at a failing pg_restore with RESTORE_DATABASE_APPLY_FAILED: no object is written and its transaction leaves nothing',async()=>{
  const target=await freshTarget('apply');
  // A function is no relation, so the target still counts as empty. Its event trigger fails pg_restore at the first
  // CREATE INDEX, which comes after every table has been created and loaded: the single transaction must undo them.
  await target.pool.query("CREATE FUNCTION public.refuse_index() RETURNS event_trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'refused'; END$$");
  await target.pool.query("CREATE EVENT TRIGGER refuse_index ON ddl_command_start WHEN TAG IN ('CREATE INDEX') EXECUTE FUNCTION public.refuse_index()");
  const {result,targetOperations}=await restoreTo(target);
  refused(result,'RESTORE_DATABASE_APPLY_FAILED');
  expect(targetOperations).toEqual(['GetBucketEncryption','ListObjectsV2']);
  await untouched(target);
},600000);

it('verifies table digests, the migration ledger and registry releases against the manifest',async()=>{
  const cases:[string,(inner:Manifest)=>void,string][]=[
    ['digest',inner=>{(inner.tables[0] as Digest).digest=sha256('another table');},'RESTORE_TABLE_DIGEST_MISMATCH'],
    ['ledger',inner=>{inner.migrations.count+=1;},'RESTORE_MIGRATION_LEDGER_MISMATCH'],
    ['release',inner=>{inner.registryReleases.push({id:randomUUID(),semanticVersion:'99.0.0',contentHash:sha256('release')});},'RESTORE_REGISTRY_RELEASE_MISMATCH'],
  ];
  for(const [label,mutate,code] of cases){
    const path=await reseal(label,mutate),target=await freshTarget(label);
    const {result,targetOperations}=await restoreTo(target,{UNAI_RESTORE_ARCHIVE:path});
    refused(result,code);
    expect(targetOperations).toEqual(['GetBucketEncryption','ListObjectsV2','PutObject']);
  }
},900000);

it('refuses an inconsistent manifest, another server major or an over-long object key before any write',async()=>{
  const longPrefix=('RESTORE-PREFIX-SENTINEL-'+hex+'-').padEnd(39,'x')+'/';
  expect(Buffer.byteLength(longPrefix)).toBe(40);
  const cases:[string,(inner:Manifest)=>void,string,string?,string?][]=[
    ['object-digest',inner=>{(inner.objects[0] as Manifest['objects'][number]).sha256=sha256('another object');},'RESTORE_MANIFEST_INVALID'],
    ['format',inner=>{inner.format='uai-backup/2';},'RESTORE_MANIFEST_INVALID'],
    ['server-major',inner=>{inner.serverVersionNum+=10000;},'RESTORE_SERVER_VERSION_MISMATCH'],
    ['long-key',inner=>{(inner.objects[0] as Manifest['objects'][number]).key='evidence/'+'k'.repeat(991);},'RESTORE_CONFIGURATION_INVALID','UNAI_RESTORE_S3_PREFIX',longPrefix],
  ];
  for(const [label,mutate,code,variable,prefix] of cases){
    const path=await reseal(label,mutate),target=await freshTarget(label);
    const {result,targetOperations}=await restoreTo(target,{UNAI_RESTORE_ARCHIVE:path,...prefix?{UNAI_RESTORE_S3_PREFIX:prefix}:{}});
    refused(result,code,variable);
    expect(targetOperations).toEqual([]);
    await untouched(target,prefix??target.prefix);
  }
},600000);

it('refuses a target another restore holds (RESTORE_TARGET_BUSY) and a role that is not superuser',async()=>{
  const busy=await freshTarget('busy');
  const holder=await busy.pool.connect();
  try{
    await holder.query("SELECT pg_advisory_lock(hashtextextended('uai-restore',0))");
    const {result,targetOperations}=await restoreTo(busy);
    refused(result,'RESTORE_TARGET_BUSY');
    expect(targetOperations).toEqual([]);
  }finally{
    await holder.query("SELECT pg_advisory_unlock(hashtextextended('uai-restore',0))").catch(()=>{});
    holder.release();
  }
  await untouched(busy);
  const probe=await freshTarget('probe-role');
  const {result,targetOperations}=await restoreTo(probe,{UNAI_RESTORE_DATABASE_URL:terminatorUrl(probeRole,probe.database)});
  refused(result,'RESTORE_DATABASE_ROLE_INVALID');
  expect(targetOperations).toEqual([]);
  await untouched(probe);
},600000);

it('refuses missing or unsafe configuration and arguments before any side effect',async()=>{
  const stage=join(root,'staging-refusals'),occupied=join(root,'staging-occupied'),keyInside=join(root,'keyinside');
  await mkdir(stage);await mkdir(occupied);
  await writeFile(join(occupied,'operator-file'),'kept');
  await copyTriple(keyInside);
  await writeFile(join(keyInside,'backup.key'),key,{mode:0o600});
  const openKey=join(root,'open.key'),emptyCa=join(root,'empty-ca.pem');
  await writeFile(openKey,randomBytes(32));await chmod(openKey,0o644);
  await writeFile(emptyCa,'');
  const closed=terminatorUrl(harnessUser,'unai_restore_closed').replace(':'+proxyPort+'/',':1/');
  const local={UNAI_RESTORE_ARCHIVE:archivePath,UNAI_RESTORE_DATABASE_URL:closed,UNAI_RESTORE_S3_PREFIX:'RESTORE-PREFIX-SENTINEL-'+hex+'-refusals/'};
  const remote={...local,UNAI_RESTORE_ARCHIVE:'s3://'+archiveBucket+'/'+archivePrefix+archiveName,UNAI_RESTORE_STAGING_DIR:stage,
    UNAI_RESTORE_ARCHIVE_S3_ENDPOINT:archiveServer.endpoint,UNAI_RESTORE_ARCHIVE_S3_REGION:region};
  const withPassword=new URL(closed);withPassword.password='URLPASS-SENTINEL';
  type Case=[string,Record<string,string|undefined>,string,string?];
  const invalid=(variable:string,values:string[],base:Record<string,string|undefined>=local):Case[]=>
    values.map(value=>[variable+'='+value.length,{...base,[variable]:value},'RESTORE_CONFIGURATION_INVALID',variable]);
  const cases:Case[]=[
    ['archive missing',{...local,UNAI_RESTORE_ARCHIVE:undefined},'RESTORE_CONFIGURATION_REQUIRED','UNAI_RESTORE_ARCHIVE'],
    ...invalid('UNAI_RESTORE_ARCHIVE',['relative/'+archiveName,'relative/',archivePath+'.sha256',archiveDirectory,join(archiveDirectory,'notes.txt')]),
    ...invalid('UNAI_RESTORE_ARCHIVE',['s3://Bad_Bucket/h/','s3://bkt-x/h','s3://bkt-x/a/../','s3://bkt-x/./','s3://bkt-x//','s3://bkt-x/'+'p/'.repeat(257),
      's3://bkt-x/h/uai-backup-x.tar.enc','s3://bkt-x'],remote),
    ['directory absent',{...local,UNAI_RESTORE_ARCHIVE:join(root,'absent')+sep},'RESTORE_ARCHIVE_NOT_FOUND'],
    ['named archive absent',{...local,UNAI_RESTORE_ARCHIVE:join(archiveDirectory,'uai-backup-20200101T000000Z.tar.enc')},'RESTORE_ARCHIVE_NOT_FOUND'],
    ['named archive in an absent directory',{...local,UNAI_RESTORE_ARCHIVE:join(root,'absent','uai-backup-20200101T000000Z.tar.enc')},'RESTORE_ARCHIVE_NOT_FOUND'],
    ['staging missing',{...remote,UNAI_RESTORE_STAGING_DIR:undefined},'RESTORE_CONFIGURATION_REQUIRED','UNAI_RESTORE_STAGING_DIR'],
    ...invalid('UNAI_RESTORE_STAGING_DIR',['relative/staging',join(root,'staging-absent'),occupied],remote),
    ['archive endpoint missing',{...remote,UNAI_RESTORE_ARCHIVE_S3_ENDPOINT:undefined},'RESTORE_CONFIGURATION_REQUIRED','UNAI_RESTORE_ARCHIVE_S3_ENDPOINT'],
    ...invalid('UNAI_RESTORE_ARCHIVE_S3_ENDPOINT',[archiveServer.endpoint.replace('https:','http:'),'not a url'],remote),
    ['archive region missing',{...remote,UNAI_RESTORE_ARCHIVE_S3_REGION:undefined},'RESTORE_CONFIGURATION_REQUIRED','UNAI_RESTORE_ARCHIVE_S3_REGION'],
    ['key missing',{...local,UNAI_RESTORE_KEY_FILE:undefined},'RESTORE_CONFIGURATION_REQUIRED','UNAI_RESTORE_KEY_FILE'],
    ['key inside the archive directory',{...local,UNAI_RESTORE_ARCHIVE:join(keyInside,archiveName),UNAI_RESTORE_KEY_FILE:join(keyInside,'backup.key')},
      'RESTORE_KEY_LOCATION_INVALID'],
    ...(posix?[['key readable by others',{...local,UNAI_RESTORE_KEY_FILE:openKey},'RESTORE_KEY_LOCATION_INVALID'] as Case]:[]),
    ['url missing',{...local,UNAI_RESTORE_DATABASE_URL:undefined},'RESTORE_CONFIGURATION_REQUIRED','UNAI_RESTORE_DATABASE_URL'],
    ...[withPassword.href,closed+'?sslmode=disable',closed.replace(/\/[^/]+$/,'/host%3Dexample'),closed.replace(/\/[^/]+$/,'/d%zzb'),
      closed.replace(/^postgresql:/,'mysql:')].map((value,index):Case=>['url '+index,{...local,UNAI_RESTORE_DATABASE_URL:value},'RESTORE_DATABASE_URL_INVALID']),
    ['PGPASSWORD set',{...local,PGPASSWORD:'PGPASS-SENTINEL'},'RESTORE_CONFIGURATION_INVALID','PGPASSWORD'],
    ['PGPASSWORD empty',{...local,PGPASSWORD:''},'RESTORE_CONFIGURATION_INVALID','PGPASSWORD'],
    ['ca missing',{...local,UNAI_DATABASE_CA_FILE:undefined},'RESTORE_CONFIGURATION_REQUIRED','UNAI_DATABASE_CA_FILE'],
    ...invalid('UNAI_DATABASE_CA_FILE',[emptyCa,join(root,'absent.pem')]),
    ...['UNAI_RESTORE_S3_ENDPOINT','UNAI_RESTORE_S3_REGION','UNAI_RESTORE_S3_BUCKET','UNAI_RESTORE_S3_KMS_KEY_ID']
      .map((variable):Case=>[variable+' missing',{...local,[variable]:undefined},'RESTORE_CONFIGURATION_REQUIRED',variable]),
    ...invalid('UNAI_RESTORE_S3_ENDPOINT',[targetServer.endpoint.replace('https:','http:'),targetServer.endpoint+'?x=1','https://user@127.0.0.1:1']),
    ...invalid('UNAI_RESTORE_S3_BUCKET',['Bad_Bucket','b','bucket-']),
    ...invalid('UNAI_RESTORE_S3_KMS_KEY_ID',['alias/unai-evidence','arn:aws:kms:'+region+':111122223333:alias/unai-evidence','1234abcd-12ab-34cd-56ef-1234567890ab']),
    ...invalid('UNAI_RESTORE_S3_PREFIX',['no-slash','/leading/','a//','./','a/../','sp ace/','p/'.repeat(257)]),
    ['target bucket is the archive bucket',{...remote,UNAI_RESTORE_S3_BUCKET:archiveBucket},'RESTORE_CONFIGURATION_INVALID','UNAI_RESTORE_S3_BUCKET'],
    ...invalid('UNAI_RESTORE_PG_RESTORE',['["pg_restore",""]','[]','[1]','["pg_restore"']),
  ];
  const targetBefore=targetServer.operations.length,archiveBefore=archiveServer.operations.length;
  for(const [label,overrides,code,variable] of cases){
    const result=await run([],overrides);
    expect({label,failure:result.stderr.trim(),stdout:result.stdout,status:result.status})
      .toEqual({label,failure:JSON.stringify(variable?{event:'restore.failed',code,variable}:{event:'restore.failed',code}),stdout:'',status:1});
  }
  for(const args of [['--force'],['--help','--help'],['--help','--force'],['restore']])refused(await run(args,local),'RESTORE_ARGUMENTS_INVALID',undefined,2);
  // Control: with nothing wrong, the same configuration gets as far as the closed database port.
  refused(await run([],local),'RESTORE_DATABASE_FAILED');
  expect(targetServer.operations.slice(targetBefore)).toEqual([]);
  expect(archiveServer.operations.slice(archiveBefore)).toEqual([]);
  expect(await readdir(stage)).toEqual([]);
  expect(await readdir(occupied)).toEqual(['operator-file']);
},600000);

it('prints usage for --help without reading the environment',async()=>{
  const env={...process.env};
  for(const name of Object.keys(env))if(name!=='PATH')delete env[name];
  const result=await spawnScript(script,['--help'],env);
  expect(result).toMatchObject({status:0,stderr:''});
  for(const word of ['pnpm restore','restore.completed','restore.failed','PGPASSFILE','UNAI_DATABASE_CA_FILE','UNAI_RESTORE_ARCHIVE',
    'UNAI_RESTORE_STAGING_DIR','UNAI_RESTORE_ARCHIVE_S3_ENDPOINT','UNAI_RESTORE_ARCHIVE_S3_REGION','UNAI_RESTORE_KEY_FILE','UNAI_RESTORE_DATABASE_URL',
    'UNAI_RESTORE_S3_ENDPOINT','UNAI_RESTORE_S3_REGION','UNAI_RESTORE_S3_BUCKET','UNAI_RESTORE_S3_KMS_KEY_ID','UNAI_RESTORE_S3_PREFIX','UNAI_RESTORE_PG_RESTORE'])
    expect(result.stdout).toContain(word);
  expect(result.stdout).not.toContain('UNAI_S3_');
});

it('has no flag but --help, never reads UNAI_S3_*, and never deletes, drops or empties anything',async()=>{
  const text=await readFile(script,'utf8');
  const allowed=['--help','--exit-on-error','--single-transaction','--no-password','--dbname','--version'];
  expect([...new Set(text.match(/--[A-Za-z][A-Za-z-]*/g)??[])].filter(flag=>!allowed.includes(flag))).toEqual([]);
  expect(text).not.toContain('UNAI_S3_');
  expect(text).not.toMatch(/Delete[A-Za-z]*Command/);
  expect(text).not.toContain('.delete(');
  // Word-anchored: the SQL keywords, and "truncate(d|s)" in any comment, but not the S3 field IsTruncated.
  expect(text).not.toMatch(/\bdrop\s+(database|schema|table)\b|\btruncate/i);
});

/** The last restore test: no output so far names a URL, password, key, key path, object key, bucket, prefix, ARN or endpoint. */
it('never prints a URL, password, key, key path, object key, bucket, prefix, KMS ARN or endpoint',()=>{
  expect(outputs.length).toBeGreaterThan(40);
  expectNoSentinels();
});

/**
 * `pnpm restore:drill` (scripts/restore-drill.mjs) restores the beforeAll archive into a scratch database it creates on
 * the harness server and a fresh prefix of the target bucket, by running restore.mjs as a child, then probes the
 * restored database through a temporary unai_app login. Every case runs after every restore case above, so the source
 * is still exactly what the archive holds when the last case probes it for the comparison.
 */
describe('pnpm restore:drill',()=>{
  const drillScript=resolve('scripts/restore-drill.mjs');
  const questions=probeQuestions as string[];
  const probeEnvironment=probeEnvironmentOf as (admin:Pool,app:Pool,options:{now:Date})=>Promise<Record<string,unknown>>;
  const serverDatabase=decodeURIComponent(serverUrl.pathname.slice(1));
  const ID=/^[0-9a-f]{16}$/;
  /** restore's environment without the two variables the drill sets itself, plus the archive directory and the server. */
  const drillEnv=(overrides:Record<string,string|undefined>)=>restoreEnv({UNAI_RESTORE_ARCHIVE:archiveDirectory+sep,
    UNAI_RESTORE_DRILL_SERVER_URL:terminatorUrl(harnessUser,serverDatabase),...overrides});
  const drill=(args:string[],overrides:Record<string,string|undefined>={})=>spawnScript(drillScript,args,drillEnv(overrides));
  const names=(id:string)=>({database:'unai_restore_drill_'+id,role:'unai_restore_drill_probe_'+id,prefix:'restore-drill-'+id+'/'});
  const drillDatabases=async()=>
    (await admin.query("SELECT datname FROM pg_database WHERE datname ~ '^unai_restore_drill_' ORDER BY 1")).rows.map(row=>String(row.datname));
  async function leftovers(id:string){
    const {database,role,prefix}=names(id);
    return {database:(await admin.query('SELECT 1 FROM pg_database WHERE datname=$1',[database])).rowCount,
      role:(await admin.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[role])).rowCount,keys:await keysUnder(prefix)};
  }
  /** The probes of each PASS run, in order: the default run, then --keep. */
  const probeRuns:Record<string,unknown>[]=[];
  function drillPassed(result:Run){
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    const summary=line(result.stdout);
    expect(Object.keys(summary)).toEqual(['event','verdict','drill','restore','probes','kept','durationMs']);
    expect(summary).toMatchObject({event:'restore.drill.completed',verdict:'PASS',drill:expect.stringMatching(ID),durationMs:expect.any(Number)});
    const tables=manifest.tables.length;
    expect(summary.restore).toEqual({verdict:'PASS',format:'uai-backup/1',archive:archiveName,createdAt:manifest.createdAt,sha256:archiveSha256,
      bytes:archiveBytes,tables,tablesVerified:tables,rows:manifest.tables.reduce((sum,table)=>sum+table.rows,0),objects:1,objectsVerified:1,
      deletedObjects:1,dumpParts,migrationHead:manifest.migrations.head,migrations:manifest.migrations.count,
      registryReleases:manifest.registryReleases.map(release=>release.semanticVersion),durationMs:expect.any(Number)});
    // One owner scope with one member and one live item allowed for PERSONAL_ASSISTANCE: 1 × 1 × the probe questions.
    expect(summary.probes).toEqual({owners:1,members:1,ownersWithoutEvidence:0,reads:questions.length,statements:expect.any(Number),
      beliefs:expect.any(Number),explanations:expect.any(Number),todayItems:expect.any(Number),digest:expect.stringMatching(/^[0-9a-f]{64}$/)});
    probeRuns.push(summary.probes as Record<string,unknown>);
    return summary as {drill:string;kept:unknown};
  }
  /** Removes a kept scratch database once no backend is left on it (Pool.end() resolves before backends exit). */
  async function dropScratch(database:string){
    for(let attempt=0;attempt<200;attempt++){
      if((await admin.query('SELECT 1 FROM pg_stat_activity WHERE datname=$1',[database])).rowCount===0){
        await admin.query('DROP DATABASE '+database+' WITH (FORCE)');
        return;
      }
      await delay(25);
    }
    throw new Error('RESTORE_TEST_BACKENDS_STILL_ACTIVE');
  }

  it('restores into its own database and prefix, probes every owner member and purpose, and removes both: PASS',async()=>{
    const before=await drillDatabases(),operations=targetServer.operations.length;
    const summary=drillPassed(await drill([]));
    // restore: the encryption check, the emptiness listing, the put, the read-back; then the drill lists and deletes its prefix.
    expect(targetServer.operations.slice(operations)).toEqual(['GetBucketEncryption','ListObjectsV2','PutObject','GetObject','ListObjectsV2','DeleteObject']);
    expect(summary.kept).toBeNull();
    expect(await leftovers(summary.drill)).toEqual({database:0,role:0,keys:[]});
    expect(await drillDatabases()).toEqual(before);
  },300000);

  it('--keep keeps exactly its database and prefix with the restored data, and still drops the probe login',async()=>{
    const summary=drillPassed(await drill(['--keep']));
    const {database,role,prefix}=names(summary.drill);
    expect(summary.kept).toEqual({database,prefix});
    const url=new URL(serverUrl.href);url.pathname='/'+database;
    const kept=new PgPool({connectionString:url.href,max:1});
    kept.on('error',()=>{});
    try{
      const relations=await kept.query("SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r'");
      expect(relations.rows[0].n).toBeGreaterThan(0);
      expect((await kept.query('SELECT id FROM owner_scopes')).rows.map(row=>String(row.id))).toEqual([owner]);
    }finally{await kept.end();}
    expect(await keysUnder(prefix)).toEqual(manifest.objects.map(object=>prefix+object.key).sort());
    expect((await admin.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[role])).rowCount).toBe(0);
    await dropScratch(database);
    for(const key of await keysUnder(prefix))await targetClient.send(new sdk.DeleteObjectCommand({Bucket:targetBucket,Key:key}));
    expect(await leftovers(summary.drill)).toEqual({database:0,role:0,keys:[]});
  },300000);

  it('fails a tampered archive at the restore stage with RESTORE_ARCHIVE_INTEGRITY_FAILED and leaves nothing behind',async()=>{
    const directory=join(root,'drill-tampered');
    await copyTriple(directory);
    const path=join(directory,archiveName),bytes=await readFile(path);
    const at=Math.floor((34+bytes.length-16)/2);
    bytes[at]=(bytes[at] as number)^0x01;
    await writeFile(path,bytes);
    // Sidecars that agree with the flipped file, so the AES-GCM tag decides.
    await writeSidecars(directory,archiveName,sha256(bytes),bytes.length);
    const before=await drillDatabases(),operations=targetServer.operations.length;
    const result=await drill([],{UNAI_RESTORE_ARCHIVE:directory+sep});
    expect(result.stdout).toBe('');
    expect(result.status).toBe(1);
    const failure=line(result.stderr);
    expect(failure).toEqual({event:'restore.drill.failed',code:'RESTORE_ARCHIVE_INTEGRITY_FAILED',stage:'restore',drill:expect.stringMatching(ID)});
    // Only the drill's own cleanup listing of its prefix: the child wrote nothing.
    expect(targetServer.operations.slice(operations)).toEqual(['ListObjectsV2']);
    expect(await leftovers(String(failure.drill))).toEqual({database:0,role:0,keys:[]});
    expect(await drillDatabases()).toEqual(before);
  },300000);

  it('refuses unsafe configuration, a role that is not superuser and any flag but --keep and --help before creating anything',async()=>{
    const before=await drillDatabases(),operations=targetServer.operations.length;
    const server=terminatorUrl(harnessUser,serverDatabase),withPassword=new URL(server);
    withPassword.password='URLPASS-SENTINEL';
    type Case=[string,Record<string,string|undefined>,Record<string,string>];
    const required=(variable:string):Case=>[variable+' missing',{[variable]:undefined},{code:'RESTORE_DRILL_CONFIGURATION_REQUIRED',variable}];
    const invalid=(variable:string,value:string):Case=>[variable+'='+value.length,{[variable]:value},{code:'RESTORE_DRILL_CONFIGURATION_INVALID',variable}];
    const cases:Case[]=[
      invalid('UNAI_RESTORE_DATABASE_URL',terminatorUrl(harnessUser,'unai_restore_drill_operator')),
      invalid('UNAI_RESTORE_DATABASE_URL',''),
      invalid('UNAI_RESTORE_S3_PREFIX','RESTORE-PREFIX-SENTINEL-'+hex+'-drill/'),
      required('UNAI_RESTORE_DRILL_SERVER_URL'),
      ...[withPassword.href,server+'?sslmode=disable',server+'#x',server+'/extra',server.replace(/\/[^/]+$/,'/'),server.replace(/^postgresql:/,'mysql:'),'not a url']
        .map((value,index):Case=>['server url '+index,{UNAI_RESTORE_DRILL_SERVER_URL:value},{code:'RESTORE_DRILL_DATABASE_URL_INVALID'}]),
      invalid('PGPASSWORD','PGPASS-SENTINEL'),
      invalid('PGPASSWORD',''),
      required('UNAI_DATABASE_CA_FILE'),
      invalid('UNAI_DATABASE_CA_FILE',join(root,'absent.pem')),
      required('UNAI_RESTORE_S3_ENDPOINT'),
      invalid('UNAI_RESTORE_S3_ENDPOINT',targetServer.endpoint.replace('https:','http:')),
      invalid('UNAI_RESTORE_S3_ENDPOINT','https://user@127.0.0.1:1'),
      required('UNAI_RESTORE_S3_REGION'),
      required('UNAI_RESTORE_S3_BUCKET'),
    ];
    for(const [label,overrides,expected] of cases){
      const result=await drill([],overrides);
      expect({label,failure:result.stderr.trim(),stdout:result.stdout,status:result.status})
        .toEqual({label,failure:JSON.stringify({event:'restore.drill.failed',...expected}),stdout:'',status:1});
    }
    for(const args of [['--force'],['--keep','--keep'],['--keep=1'],['keep']]){
      const result=await drill(args);
      expect({args,failure:result.stderr.trim(),stdout:result.stdout,status:result.status})
        .toEqual({args,failure:JSON.stringify({event:'restore.drill.failed',code:'RESTORE_DRILL_ARGUMENTS_INVALID'}),stdout:'',status:2});
    }
    // A login without SUPERUSER is refused before CREATE DATABASE (it has an id by then, and nothing to remove).
    const weak=await drill([],{UNAI_RESTORE_DRILL_SERVER_URL:terminatorUrl(probeRole,serverDatabase)});
    expect(weak.stdout).toBe('');
    expect(weak.status).toBe(1);
    expect(line(weak.stderr)).toEqual({event:'restore.drill.failed',code:'RESTORE_DRILL_ROLE_INVALID',drill:expect.stringMatching(ID)});
    expect(targetServer.operations.slice(operations)).toEqual([]);
    expect(await drillDatabases()).toEqual(before);
  },300000);

  it('prints usage for --help without reading the environment',async()=>{
    const env={...process.env};
    for(const name of Object.keys(env))if(name!=='PATH')delete env[name];
    const result=await spawnScript(drillScript,['--help'],env);
    expect(result).toMatchObject({status:0,stderr:''});
    for(const word of ['pnpm restore:drill','--keep','--help','UNAI_RESTORE_DRILL_SERVER_URL','UNAI_RESTORE_ARCHIVE','UNAI_RESTORE_DATABASE_URL',
      'UNAI_RESTORE_S3_PREFIX','restore.drill.completed','restore.drill.failed'])expect(result.stdout).toContain(word);
  });

  it('has no flag but --keep and --help and never reads UNAI_S3_*',async()=>{
    const text=await readFile(drillScript,'utf8');
    expect([...new Set(text.match(/--[A-Za-z][A-Za-z-]*/g)??[])].sort()).toEqual(['--help','--keep']);
    expect(text).not.toContain('UNAI_S3_');
    expect(text).not.toContain('DeleteObjects');
  });

  it('probes the untouched source with the same frozen clock to the digest of both drills',async()=>{
    expect(probeRuns).toHaveLength(2);
    expect(probeRuns[1]).toEqual(probeRuns[0]);
    await admin.query('GRANT unai_app TO '+probeRole);
    const url=new URL(serverUrl.href);url.pathname='/'+sourceDatabase;url.username=probeRole;url.password=probePassword;
    const app=new PgPool({connectionString:url.href,max:2});
    app.on('error',()=>{});
    try{expect(await probeEnvironment(source,app,{now:new Date(manifest.createdAt)})).toEqual(probeRuns[0]);}
    finally{await app.end();}
  },300000);

  it('never prints a URL, password, key, bucket, prefix, ARN, endpoint, owner id or question',()=>{
    expect(outputs.length).toBeGreaterThan(70);
    expectNoSentinels();
    const values=[owner,actor,liveKey,erasedKey,'Restore owner',...questions];
    outputs.forEach((output,index)=>values.forEach((value,sentinel)=>{
      if(output.includes(value))expect.fail('output '+index+' names drill sentinel '+sentinel);
    }));
  });
});
