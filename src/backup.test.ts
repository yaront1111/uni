import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {spawn,spawnSync} from 'node:child_process';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {existsSync} from 'node:fs';
import {chmod,mkdir,mkdtemp,readdir,readFile,rm,writeFile} from 'node:fs/promises';
import {createServer,connect,type AddressInfo,type Server} from 'node:net';
import {createRequire} from 'node:module';
import {Agent} from 'node:https';
import {tmpdir} from 'node:os';
import {delimiter,join,resolve} from 'node:path';
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

/**
 * `pnpm backup` (scripts/backup.mjs) as the operator's timer runs it: a spawned
 * process against a migrated scratch database behind verified TLS and the
 * harness's KMS-encrypted object store. The harness PostgreSQL is plain TCP, so
 * a test-only terminator answers the SSLRequest; the script and libpq verify the
 * certificate exactly as in production. The password reaches pg and pg_dump only
 * through a 0600 pgpass file, never the URL.
 */
if(!process.env.UNAI_TEST_DATABASE_URL)throw new Error('Run pnpm test for the required PostgreSQL harness');
type Pool=Parameters<typeof runMigrations>[0];
interface Client{query(sql:string):Promise<unknown>;release():void}
interface Entry{name:string;size:number;bytes:Buffer}
interface Digest{table:string;digest:string;rows:number}
const archive=archiveLibrary as {
  ARCHIVE_NAME:RegExp;
  archiveName(date:Date):string;
  readArchive(path:string,key:Buffer,onEntry:(entry:Entry)=>unknown):Promise<{sha256:string;entries:{name:string;size:number}[]}>;
  tableDigests(client:Client):Promise<Digest[]>;
};
const {Pool:PgPool}=createRequire(new URL('../packages/postgres/package.json',import.meta.url))('pg') as
  {Pool:new(config:{connectionString:string;max?:number})=>Pool};
const need=(name:string)=>{const value=process.env[name];if(!value)throw new Error('HARNESS_VARIABLE_MISSING '+name);return value;};
const storage={endpoint:need('UNAI_TEST_S3_ENDPOINT'),region:'us-east-1',bucket:need('UNAI_TEST_S3_BUCKET'),kmsKeyId:need('UNAI_TEST_S3_KMS_KEY_ID')};
const posix=process.platform!=='win32';
const serverUrl=new URL(need('UNAI_TEST_DATABASE_URL'));
const database='unai_backup_'+randomBytes(8).toString('hex');
const scratchUrl=new URL(serverUrl.href);scratchUrl.pathname='/'+database;
const admin=new PgPool({connectionString:serverUrl.href,max:1});
const scratch=new PgPool({connectionString:scratchUrl.href,max:2});
const owner=randomUUID(),actor=randomUUID(),liveKey=randomUUID(),erasedKey=randomUUID();
const objectKey='evidence/OBJKEY-SENTINEL-'+randomBytes(6).toString('hex')+'/'+liveKey;
const objectBytes=Buffer.concat([Buffer.from('backup fixture '),randomBytes(4096)]);
const sha256=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const script=resolve('scripts/backup.mjs');
let root='',key=Buffer.alloc(0),keyFile='',caFile='',passFile='',passLine='',inactiveBin='',systemctlLog='',backupUrl='',firstArchive='';
let proxy:Server|undefined,proxyPort=0,pgDump:string[]=[],connector='',caBundle='';
const outputs:string[]=[],s3Sentinels:string[]=[];

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
/** A pg_dump of the server's major: a host client, else the pinned harness image. */
function pgDumpPrefix(major:number):string[]{
  const host='/usr/lib/postgresql/'+major+'/bin/pg_dump';
  if(existsSync(host))return [host];
  const onPath=spawnSync('pg_dump',['--version'],{encoding:'utf8'});
  if(!onPath.error&&onPath.status===0&&onPath.stdout.includes('(PostgreSQL) '+major+'.'))return ['pg_dump'];
  if(!posix)throw new Error('PG_DUMP_'+major+'_REQUIRED');
  const names=['PGHOST','PGPORT','PGUSER','PGDATABASE','PGSSLMODE','PGSSLROOTCERT','PGPASSFILE','PGCONNECT_TIMEOUT','PGAPPNAME'];
  return ['docker','run','--rm','--network','host','--user',`${process.getuid?.()}:${process.getgid?.()}`,
    '--volume',`${root}:${root}:ro`,...names.flatMap(name=>['--env',name]),POSTGRES_IMAGE,'pg_dump'];
}
async function fakeSystemctl(name:string,body:string){
  const bin=join(root,name);
  await mkdir(bin);
  await writeFile(join(bin,'systemctl'),'#!/bin/sh\n'+body+'\n',{mode:0o755});
  return bin;
}
/** One source item of the seeded connector and its evidence key row; `deleted` erases both. */
async function item(keyId:string,storeKey:string,hash:string,deleted:boolean){
  const id=randomUUID(),erased=deleted?'clock_timestamp()':'NULL';
  await scratch.query(`INSERT INTO source_items(id,owner_scope_id,connector_id,source_type,external_id,actor_ref,submitted_by_user_id,
    raw_object_ref,content_hash,sensitivity,allowed_purposes,ingestion_version,idempotency_key,deleted_at) VALUES($1,$2,$3,'CONVERSATION',$4,$5,$6,$7,$8,
    'PRIVATE',ARRAY['PERSONAL_ASSISTANCE'],'evidence-json-v1',$9,${erased})`,
    [id,owner,connector,'backup-'+keyId,JSON.stringify({type:'USER',id:actor}),actor,randomUUID(),hash,randomUUID()]);
  await scratch.query(`INSERT INTO evidence_object_keys(id,owner_scope_id,source_item_id,object_store_key,encryption_key_ref,deleted_at)
    VALUES($1,$2,$3,$4,$5,${erased})`,[keyId,owner,id,storeKey,'kms:'+storage.kmsKeyId]);
}
async function seed(){
  await scratch.query('INSERT INTO users(id,display_name) VALUES($1,$2)',[actor,'Backup owner']);
  await scratch.query("INSERT INTO owner_scopes(id,scope_kind,display_name,created_by_user_id) VALUES($1,'PERSONAL','Backup',$2)",[owner,actor]);
  await scratch.query("INSERT INTO owner_scope_members(owner_scope_id,user_id,role) VALUES($1,$2,'OWNER')",[owner,actor]);
  connector=randomUUID();
  await scratch.query("INSERT INTO connectors(id,owner_scope_id,connector_type,external_account_ref,permission_manifest,status) VALUES($1,$2,'CONVERSATION',$3,'{}','ACTIVE')",
    [connector,owner,'backup-'+owner]);
  await item(liveKey,objectKey,sha256(objectBytes),false);
  await item(erasedKey,'evidence/erased/'+erasedKey,sha256(Buffer.from('erased')),true);
  const store=await createEncryptedS3Store(storage,async(_context,id)=>id===liveKey?objectKey:null);
  try{await store.put({actorId:actor,ownerScopeId:owner,purpose:'evidence.ingest',correlationId:randomUUID()},liveKey,objectBytes);}
  finally{store.close();}
}

beforeAll(async()=>{
  await admin.query('CREATE DATABASE '+database);
  // Migration 0001 alters cluster-global roles and runMigrations serializes only within one database:
  // take the lock every scratch-database suite takes on the shared database (restore.test.ts runs beside this file).
  const lock=await admin.connect();
  try{await lock.query('SELECT pg_advisory_lock(1970170217,3)');await runMigrations(scratch,resolve('migrations'));}
  finally{await lock.query('SELECT pg_advisory_unlock(1970170217,3)').catch(()=>{});lock.release(true);}
  root=await mkdtemp(join(tmpdir(),'unai-backup-test-'));
  key=randomBytes(32);keyFile=join(root,'backup.key');
  await writeFile(keyFile,key,{mode:0o600});
  const {certificate,key:tlsKey}=createSelfSignedCertificate() as {certificate:string;key:string};
  caFile=join(root,'ca.pem');await writeFile(caFile,certificate);
  const started=await startPostgresTlsProxy(certificate,tlsKey);
  proxy=started.server;proxyPort=started.port;
  const user=decodeURIComponent(serverUrl.username),escape=(value:string)=>value.replace(/[\\:]/g,'\\$&');
  passLine=['127.0.0.1',String(proxyPort),database,escape(user),escape(decodeURIComponent(serverUrl.password))].join(':');
  passFile=join(root,'pgpass');await writeFile(passFile,passLine+'\n',{mode:0o600});
  await chmod(passFile,0o600);
  backupUrl=`postgresql://${encodeURIComponent(user)}@127.0.0.1:${proxyPort}/${database}`;
  systemctlLog=join(root,'systemctl.log');
  if(posix)inactiveBin=await fakeSystemctl('inactive-bin',`echo "$@" >> '${systemctlLog}'\necho inactive\nexit 3`);
  const version=Number((await scratch.query('SHOW server_version_num')).rows[0].server_version_num);
  pgDump=pgDumpPrefix(Math.floor(version/10000));
  await seed();
},240000);

afterAll(async()=>{
  proxy?.close();
  try{
    await scratch.end();
    // Pool.end() resolves before idle backends exit; FORCE must not kill a closing client.
    for(let attempt=0;attempt<200;attempt++){
      const {rowCount}=await admin.query('SELECT 1 FROM pg_stat_activity WHERE datname=$1',[database]);
      if(rowCount===0){
        await admin.query('DROP DATABASE IF EXISTS '+database+' WITH (FORCE)');
        return;
      }
      await delay(25);
    }
    throw new Error('BACKUP_TEST_BACKENDS_STILL_ACTIVE');
  }finally{
    await admin.end();
    key.fill(0);
    if(root)await rm(root,{recursive:true,force:true});
  }
});

interface Run{status:number|null;stdout:string;stderr:string}
/** The script as a child process. Never spawnSync: the terminator lives on this event loop. */
function run(args:string[],overrides:Record<string,string|undefined>={}):Promise<Run>{
  const env={...process.env};
  for(const name of Object.keys(env)){
    if(['PGPASSWORD','UNAI_TEST_DATABASE_URL','DATABASE_URL'].includes(name)||name.startsWith('UNAI_BACKUP_'))delete env[name];
  }
  Object.assign(env,{UNAI_BACKUP_DATABASE_URL:backupUrl,UNAI_DATABASE_CA_FILE:caFile,UNAI_S3_ENDPOINT:storage.endpoint,
    UNAI_S3_REGION:storage.region,UNAI_S3_BUCKET:storage.bucket,UNAI_S3_KMS_KEY_ID:storage.kmsKeyId,UNAI_BACKUP_KEY_FILE:keyFile,
    UNAI_BACKUP_PG_DUMP:JSON.stringify(pgDump),PGPASSFILE:passFile,PATH:posix?inactiveBin+delimiter+(process.env.PATH??''):(process.env.PATH??'')});
  // The harness CA plus the backup server's certificate, once the s3 block has started it.
  if(caBundle)env.NODE_EXTRA_CA_CERTS=caBundle;
  for(const [name,value] of Object.entries(overrides)){if(value===undefined)delete env[name];else env[name]=value;}
  return new Promise((done,reject)=>{
    const child=spawn(process.execPath,[script,...(posix?[]:['--assume-quiescent']),...args],{env});
    let stdout='',stderr='';
    child.stdout.on('data',chunk=>{stdout+=chunk;});
    child.stderr.on('data',chunk=>{stderr+=chunk;});
    child.once('error',reject);
    child.once('close',status=>{outputs.push(stdout,stderr);done({status,stdout,stderr});});
  });
}
function line(text:string):Record<string,unknown>{
  const lines=text.split('\n').filter(Boolean);
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0] as string) as Record<string,unknown>;
}
function refused(result:Run,code:string,variable?:string,status=1){
  expect(result.stdout).toBe('');
  const failure=line(result.stderr);
  expect(failure).toEqual(variable?{event:'backup.failed',code,variable}:{event:'backup.failed',code});
  expect(result.status).toBe(status);
}
const listing=async(directory:string)=>(await readdir(directory)).sort();
async function destination(name:string){const path=join(root,name);await mkdir(path);return path;}
async function freshDigests():Promise<Digest[]>{
  const client:Client=await scratch.connect();
  try{
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    const digests=await archive.tableDigests(client);
    await client.query('COMMIT');
    return digests;
  }finally{client.release();}
}

it('writes one verified archive whose manifest equals freshly computed digests, objects and ledger head',async()=>{
  const target=await destination('happy');
  const result=await run([],{UNAI_BACKUP_DESTINATION:target});
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
  const summary=line(result.stdout);
  const name=String(summary.archive);
  expect(name).toMatch(archive.ARCHIVE_NAME);
  expect(await listing(target)).toEqual([name,name+'.manifest.json',name+'.sha256']);
  const file=await readFile(join(target,name));
  expect(await readFile(join(target,name+'.sha256'),'utf8')).toBe(sha256(file)+'  '+name+'\n');
  firstArchive=join(target,name);

  const entries:Entry[]=[];
  const read=await archive.readArchive(firstArchive,await readFile(keyFile),entry=>{entries.push(entry);});
  expect(read.sha256).toBe(sha256(file));
  expect(entries[0]?.name).toBe('manifest.json');
  const manifest=JSON.parse((entries[0] as Entry).bytes.toString('utf8')) as Record<string,unknown>&
    {tables:Digest[];objects:{entry:string;evidenceObjectKeyId:string;ownerScopeId:string;key:string;sha256:string}[];
      migrations:{head:string;count:number};evidence:{live:number;deleted:number};registryReleases:unknown[]};
  expect(manifest.format).toBe('uai-backup/1');
  expect(manifest.tables).toEqual(await freshDigests());
  const ledger=(await scratch.query('SELECT max(name) AS head,count(*)::int AS count FROM unai_migrations.applied')).rows[0];
  expect(manifest.migrations).toEqual({head:ledger.head,count:ledger.count});
  const live=(await scratch.query('SELECT count(*)::int AS n FROM evidence_object_keys WHERE deleted_at IS NULL')).rows[0].n;
  expect(manifest.objects).toHaveLength(live);
  expect(manifest.objects).toEqual([{entry:'objects/000000',evidenceObjectKeyId:liveKey,ownerScopeId:owner,key:objectKey,sha256:sha256(objectBytes)}]);
  expect(manifest.evidence).toEqual({live:1,deleted:1});
  const releases=(await scratch.query('SELECT id,semantic_version,content_hash FROM registry_releases')).rows;
  expect(manifest.registryReleases).toHaveLength(releases.length);
  const objects=entries.filter(entry=>entry.name.startsWith('objects/'));
  expect(objects.map(entry=>[entry.name,sha256(entry.bytes)])).toEqual([['objects/000000',sha256(objectBytes)]]);
  const parts=entries.filter(entry=>entry.name.startsWith('database.dump.'));
  expect(parts.map(entry=>entry.name)).toEqual(parts.map((_entry,index)=>'database.dump.'+String(index).padStart(6,'0')));
  expect(Buffer.concat(parts.map(entry=>entry.bytes)).subarray(0,5).toString('latin1')).toBe('PGDMP');
  expect(entries.map(entry=>entry.name)).toEqual(['manifest.json',...parts.map(entry=>entry.name),'objects/000000']);

  expect(summary).toMatchObject({event:'backup.completed',format:'uai-backup/1',bytes:file.length,sha256:sha256(file),
    quiescence:posix?'systemd':'assumed',tables:manifest.tables.length,rows:manifest.tables.reduce((n,t)=>n+t.rows,0),
    objects:1,deletedObjects:1,dumpParts:parts.length,migrationHead:ledger.head,retentionRemoved:0});
  const sidecar=await readFile(join(target,name+'.manifest.json'),'utf8');
  expect(JSON.parse(sidecar)).toMatchObject({format:'uai-backup/1',archive:name,sha256:sha256(file),bytes:file.length,
    counts:{tables:manifest.tables.length,objects:1,deletedObjects:1,dumpParts:parts.length},migrationHead:ledger.head});
  for(const secret of [objectKey,...manifest.tables.map(t=>t.digest)])expect(sidecar).not.toContain(secret);
  if(posix)expect((await readFile(systemctlLog,'utf8')).trim().split('\n')).toEqual(['is-active unai-api','is-active unai-worker']);
},300000);

it('an archive decrypted with another key fails BACKUP_KEY_INVALID',async()=>{
  expect(firstArchive).not.toBe('');
  await expect(archive.readArchive(firstArchive,randomBytes(32),()=>undefined)).rejects.toThrow(/^BACKUP_KEY_INVALID$/);
});

it('refuses a key file inside the destination or readable by others with BACKUP_KEY_LOCATION_INVALID',async()=>{
  const target=await destination('key-inside');
  const inside=join(target,'backup.key');
  await writeFile(inside,randomBytes(32),{mode:0o600});
  refused(await run([],{UNAI_BACKUP_DESTINATION:target,UNAI_BACKUP_KEY_FILE:inside}),'BACKUP_KEY_LOCATION_INVALID');
  expect(await listing(target)).toEqual(['backup.key']);
  if(posix){
    const open=join(root,'open.key');
    await writeFile(open,randomBytes(32));await chmod(open,0o644);
    refused(await run([],{UNAI_BACKUP_DESTINATION:target,UNAI_BACKUP_KEY_FILE:open}),'BACKUP_KEY_LOCATION_INVALID');
    expect(await listing(target)).toEqual(['backup.key']);
  }
},120000);

it('refuses with BACKUP_PRECONDITION_FAILED while an API login holds a backend, whatever the flags',async()=>{
  const target=await destination('busy');
  const password=randomBytes(12).toString('hex');
  const existed=(await admin.query("SELECT 1 FROM pg_roles WHERE rolname='unai_api_login'")).rowCount===1;
  await admin.query(`${existed?'ALTER':'CREATE'} ROLE unai_api_login LOGIN PASSWORD '${password}'`);
  const login=new URL(scratchUrl.href);login.username='unai_api_login';login.password=password;
  const holder=new PgPool({connectionString:login.href,max:1});
  try{
    const held=await holder.connect();
    try{refused(await run(['--assume-quiescent'],{UNAI_BACKUP_DESTINATION:target}),'BACKUP_PRECONDITION_FAILED');}
    finally{held.release();}
  }finally{
    await holder.end();
    for(let n=0;n<40&&(await admin.query("SELECT 1 FROM pg_stat_activity WHERE usename='unai_api_login'")).rowCount;n++)await delay(250);
    if(!existed)await admin.query('DROP ROLE IF EXISTS unai_api_login');
  }
  expect(await listing(target)).toEqual([]);
},180000);

it.skipIf(!posix)('refuses with BACKUP_PRECONDITION_FAILED when a unit is active or systemctl is unavailable',async()=>{
  const target=await destination('active');
  const activeBin=await fakeSystemctl('active-bin','exit 0'),emptyBin=await destination('empty-bin');
  refused(await run([],{UNAI_BACKUP_DESTINATION:target,PATH:activeBin+delimiter+(process.env.PATH??'')}),'BACKUP_PRECONDITION_FAILED');
  refused(await run([],{UNAI_BACKUP_DESTINATION:target,PATH:emptyBin}),'BACKUP_PRECONDITION_FAILED');
  expect(await listing(target)).toEqual([]);
},120000);

it('retention removes only the script\'s own archives older than the window',async()=>{
  const target=await destination('retention');
  const recent=archive.archiveName(new Date(Date.now()-2*86400000));
  const planted=['uai-backup-20200101T000000Z.tar.enc','uai-backup-20200101T000000Z.tar.enc.sha256','uai-backup-20200101T000000Z.tar.enc.manifest.json',
    recent,recent+'.sha256',recent+'.manifest.json','uai-backup-20200101T000000Z.tar.enc.bak','uai-backup-notes.txt','other-20200101T000000Z.tar.enc'];
  for(const name of planted)await writeFile(join(target,name),'planted');
  await mkdir(join(target,'uai-backup-20190101T000000Z.tar.enc'));
  const result=await run([],{UNAI_BACKUP_DESTINATION:target,UNAI_BACKUP_RETENTION_DAYS:'7'});
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
  const summary=line(result.stdout),name=String(summary.archive);
  expect(summary.retentionRemoved).toBe(1);
  expect(await listing(target)).toEqual([...planted.slice(3),'uai-backup-20190101T000000Z.tar.enc',name,name+'.manifest.json',name+'.sha256'].sort());
},300000);

it('refuses unsupported or unsafe configuration before any side effect',async()=>{
  const target=await destination('refusals');
  const withPassword=new URL(backupUrl);withPassword.password='URLPASS-SENTINEL';
  refused(await run([],{UNAI_BACKUP_DESTINATION:'s3://uai-backup/host/'}),'BACKUP_CONFIGURATION_REQUIRED','UNAI_BACKUP_STAGING_DIR');
  refused(await run([],{UNAI_BACKUP_DESTINATION:'relative/backups'}),'BACKUP_DESTINATION_INVALID');
  refused(await run([],{UNAI_BACKUP_DESTINATION:target,UNAI_BACKUP_DATABASE_URL:withPassword.href}),'BACKUP_DATABASE_URL_INVALID');
  for(const malformed of ['postgresql://us%zzer@127.0.0.1:1/db','postgresql://user@127.0.0.1:1/d%zzb'])
    refused(await run([],{UNAI_BACKUP_DESTINATION:target,UNAI_BACKUP_DATABASE_URL:malformed}),'BACKUP_DATABASE_URL_INVALID');
  refused(await run([],{UNAI_BACKUP_DESTINATION:target,PGPASSWORD:'PGPASS-SENTINEL'}),'BACKUP_CONFIGURATION_INVALID','PGPASSWORD');
  refused(await run([],{UNAI_BACKUP_DESTINATION:target,UNAI_S3_BUCKET:undefined}),'BACKUP_CONFIGURATION_REQUIRED','UNAI_S3_BUCKET');
  refused(await run([],{UNAI_BACKUP_DESTINATION:target,UNAI_BACKUP_PG_DUMP:'["pg_dump",""]'}),'BACKUP_CONFIGURATION_INVALID','UNAI_BACKUP_PG_DUMP');
  refused(await run([],{UNAI_BACKUP_DESTINATION:target,UNAI_BACKUP_RETENTION_DAYS:'0'}),'BACKUP_RETENTION_INVALID');
  refused(await run(['--force'],{UNAI_BACKUP_DESTINATION:target}),'BACKUP_ARGUMENTS_INVALID',undefined,2);
  expect(await listing(target)).toEqual([]);
},180000);

it('prints usage for --help without reading the environment',async()=>{
  const result=await new Promise<Run>((done,reject)=>{
    const env={...process.env};
    for(const name of Object.keys(env))if(name!=='PATH')delete env[name];
    const child=spawn(process.execPath,[script,'--help'],{env});
    let stdout='',stderr='';
    child.stdout.on('data',chunk=>{stdout+=chunk;});
    child.stderr.on('data',chunk=>{stderr+=chunk;});
    child.once('error',reject);
    child.once('close',status=>done({status,stdout,stderr}));
  });
  expect(result).toMatchObject({status:0,stderr:''});
  for(const word of ['pnpm backup','--assume-quiescent','UNAI_BACKUP_KEY_FILE','UNAI_BACKUP_DESTINATION','BACKUP_PRECONDITION_FAILED',
    'UNAI_BACKUP_STAGING_DIR','UNAI_BACKUP_S3_ENDPOINT','UNAI_BACKUP_S3_REGION','UNAI_BACKUP_S3_KMS_KEY_ID'])
    expect(result.stdout).toContain(word);
});

interface S3Server{endpoint:string;certificate:string;operations:string[];receiptOverrides:Record<string,string>;readonly pendingUploads:number;close():Promise<void>}
interface S3Client{send(command:object):Promise<Record<string,unknown>&{Body?:{transformToByteArray():Promise<Uint8Array>}}>;destroy():void}
const sdk=createRequire(new URL('../packages/storage/package.json',import.meta.url))('@aws-sdk/client-s3') as
  {S3Client:new(config:object)=>S3Client;GetObjectCommand:new(input:object)=>object;ListObjectsV2Command:new(input:object)=>object};
const shared=process.env.AWS_ACCESS_KEY_ID&&process.env.AWS_SECRET_ACCESS_KEY?
  {accessKeyId:process.env.AWS_ACCESS_KEY_ID,secretAccessKey:process.env.AWS_SECRET_ACCESS_KEY}:undefined;

/**
 * ADR 0043 D9's backup bucket: a second in-process S3 server with its own bucket and
 * key. It accepts the credential the harness exported, so the script reaches it
 * through the SDK default chain exactly as in production. Only delivered storage on
 * another credential chain lacks that pair; MinIO and the in-process server export it.
 */
describe.skipIf(!shared)('s3:// destination',()=>{
  const hex=randomBytes(6).toString('hex'),region='us-west-2',partBytes=8*1024*1024;
  const bucket='bkt-sentinel-'+hex,keyArn='arn:aws:kms:'+region+':111122223333:key/KMSSENTINEL-'+hex;
  const otherArn='arn:aws:kms:'+region+':111122223333:key/OTHERSENTINEL-'+hex;
  const largeKey=randomUUID(),largeObjectKey='evidence/OBJKEY-SENTINEL-'+hex+'/'+largeKey;
  let server:S3Server|undefined,client:S3Client|undefined,largeDigest='';
  const backupServer=()=>server as S3Server,backupClient=()=>client as S3Client;
  const largeStore=()=>createEncryptedS3Store(storage,async(_context,id)=>id===largeKey?largeObjectKey:null);
  const context=()=>({actorId:actor,ownerScopeId:owner,purpose:'evidence.ingest',correlationId:randomUUID()});
  const prefixOf=(name:string)=>'HOSTSENTINEL-'+hex+'-'+name+'/';
  const s3Env=(name:string,staging:string):Record<string,string>=>({UNAI_BACKUP_DESTINATION:'s3://'+bucket+'/'+prefixOf(name),
    UNAI_BACKUP_STAGING_DIR:staging,UNAI_BACKUP_S3_ENDPOINT:backupServer().endpoint,UNAI_BACKUP_S3_REGION:region,UNAI_BACKUP_S3_KMS_KEY_ID:keyArn});

  beforeAll(async()=>{
    // Its own subject: the bundle also holds the harness CA, which is CN=localhost.
    server=await (startS3ObjectServer as (options:object)=>Promise<S3Server>)({bucket,kmsKeyId:keyArn,credentials:shared,
      commonName:'unai-backup-bucket-'+hex,logOperations:true});
    const harness=process.env.NODE_EXTRA_CA_CERTS?await readFile(process.env.NODE_EXTRA_CA_CERTS,'utf8'):'';
    caBundle=join(root,'s3-ca-bundle.pem');
    await writeFile(caBundle,harness+'\n'+server.certificate);
    client=new sdk.S3Client({endpoint:server.endpoint,region,forcePathStyle:true,credentials:shared,
      requestHandler:{httpsAgent:new Agent({ca:server.certificate,rejectUnauthorized:true})}});
    s3Sentinels.push(bucket,keyArn,otherArn,'HOSTSENTINEL-'+hex,'KMSSENTINEL-'+hex,'OTHERSENTINEL-'+hex,server.endpoint,caBundle);
  });
  afterAll(async()=>{
    caBundle='';
    client?.destroy();
    await server?.close();
    // Best effort: the recovery rehearsal copies the whole harness evidence bucket.
    if(largeDigest){
      const store=await largeStore().catch(()=>null);
      await store?.delete(context(),largeKey).catch(()=>{});
      store?.close();
    }
  });

  /** A 9 MiB live evidence object, so the next archive is larger than one upload part. */
  async function ensureLargeObject(){
    if(largeDigest)return;
    const bytes=randomBytes(9*1024*1024),digest=sha256(bytes);
    await item(largeKey,largeObjectKey,digest,false);
    const store=await largeStore();
    try{await store.put(context(),largeKey,bytes);largeDigest=digest;}finally{store.close();}
  }
  async function keysUnder(prefix:string){
    const listed=await backupClient().send(new sdk.ListObjectsV2Command({Bucket:bucket,Prefix:prefix}));
    return ((listed.Contents??[]) as {Key:string}[]).map(entry=>entry.Key).filter(key=>key.startsWith(prefix)).sort();
  }
  /** One run into its own prefix and staging directory: the operations it caused and the keys it left. */
  async function backupTo(name:string){
    const stage=await destination('staging-'+name),before=backupServer().operations.length;
    const result=await run([],s3Env(name,stage));
    const operations=backupServer().operations.slice(before);
    return {result,operations,stage,keys:await keysUnder(prefixOf(name))};
  }
  async function download(key:string){
    const object=await backupClient().send(new sdk.GetObjectCommand({Bucket:bucket,Key:key}));
    expect([object.ServerSideEncryption,object.SSEKMSKeyId]).toEqual(['aws:kms',keyArn]);
    return Buffer.from(await (object.Body as {transformToByteArray():Promise<Uint8Array>}).transformToByteArray());
  }
  interface Inner{tables:Digest[];objects:{entry:string;evidenceObjectKeyId:string;sha256:string}[]}
  /** The three objects are this run's: SSE-KMS receipts, both sidecars, and the archive verified with the key file. */
  async function verifyUploaded(name:string,summary:Record<string,unknown>){
    const prefix=prefixOf(name),file=String(summary.archive);
    expect(await keysUnder(prefix)).toEqual([file,file+'.manifest.json',file+'.sha256'].map(entry=>prefix+entry));
    const bytes=await download(prefix+file),local=join(root,'downloaded-'+name+'.tar.enc');
    await writeFile(local,bytes);
    expect([bytes.length,sha256(bytes)]).toEqual([summary.bytes,summary.sha256]);
    expect((await download(prefix+file+'.sha256')).toString('utf8')).toBe(summary.sha256+'  '+file+'\n');
    expect(JSON.parse((await download(prefix+file+'.manifest.json')).toString('utf8'))).toEqual({format:'uai-backup/1',archive:file,
      createdAt:expect.any(String),sha256:summary.sha256,bytes:summary.bytes,migrationHead:summary.migrationHead,registryReleases:summary.registryReleases,
      counts:{tables:summary.tables,rows:summary.rows,objects:summary.objects,deletedObjects:summary.deletedObjects,dumpParts:summary.dumpParts}});
    const inner:Inner[]=[],objects:{name:string;sha256:string}[]=[];
    const read=await archive.readArchive(local,await readFile(keyFile),entry=>{
      if(entry.name==='manifest.json')inner.push(JSON.parse(entry.bytes.toString('utf8')) as Inner);
      if(entry.name.startsWith('objects/'))objects.push({name:entry.name,sha256:sha256(entry.bytes)});
    });
    expect(read.sha256).toBe(summary.sha256);
    expect(inner).toHaveLength(1);
    const manifest=inner[0] as Inner;
    expect(manifest.tables).toEqual(await freshDigests());
    // Digests, never a multi-MiB Buffer toEqual (vitest compares those byte by byte).
    expect(objects).toEqual(manifest.objects.map(object=>({name:object.entry,sha256:object.sha256})));
    return manifest.objects.map(object=>({id:object.evidenceObjectKeyId,sha256:object.sha256})).sort((a,b)=>a.id.localeCompare(b.id));
  }

  it('refuses unsafe s3 destinations before any database or object read',async()=>{
    const stage=await destination('staging-refusals'),occupied=await destination('staging-occupied');
    await writeFile(join(occupied,'operator-file'),'kept');
    const closed=`postgresql://${encodeURIComponent(decodeURIComponent(serverUrl.username))}@127.0.0.1:1/${database}`;
    const base={...s3Env('refusals',stage),UNAI_BACKUP_DATABASE_URL:closed};
    // The equality refusals must not pass because the harness bucket fails the grammar.
    expect(storage.bucket).toMatch(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/);
    const before=backupServer().operations.length;
    const cases:[Record<string,string|undefined>,string,string?][]=[
      [{UNAI_BACKUP_DESTINATION:'s3://'+storage.bucket+'/h/'},'BACKUP_DESTINATION_INVALID'],
      [{UNAI_BACKUP_S3_KMS_KEY_ID:storage.kmsKeyId},'BACKUP_DESTINATION_INVALID'],
      [{UNAI_BACKUP_RETENTION_DAYS:'7'},'BACKUP_CONFIGURATION_INVALID','UNAI_BACKUP_RETENTION_DAYS'],
      [{UNAI_BACKUP_STAGING_DIR:undefined},'BACKUP_CONFIGURATION_REQUIRED','UNAI_BACKUP_STAGING_DIR'],
      [{UNAI_BACKUP_STAGING_DIR:join(root,'staging-absent')},'BACKUP_CONFIGURATION_INVALID','UNAI_BACKUP_STAGING_DIR'],
      [{UNAI_BACKUP_STAGING_DIR:'relative/staging'},'BACKUP_CONFIGURATION_INVALID','UNAI_BACKUP_STAGING_DIR'],
      [{UNAI_BACKUP_STAGING_DIR:occupied},'BACKUP_CONFIGURATION_INVALID','UNAI_BACKUP_STAGING_DIR'],
      ...['s3://Bad_Bucket/h/','s3://bkt-x/h','s3://bkt-x/a/../','s3://bkt-x/./','s3://bkt-x//','s3://bkt-x/'+'p/'.repeat(257)]
        .map((value):[Record<string,string>,string]=>[{UNAI_BACKUP_DESTINATION:value},'BACKUP_DESTINATION_INVALID']),
      [{UNAI_BACKUP_S3_KMS_KEY_ID:'alias/unai-backup'},'BACKUP_CONFIGURATION_INVALID','UNAI_BACKUP_S3_KMS_KEY_ID'],
      [{UNAI_BACKUP_S3_KMS_KEY_ID:'arn:aws:kms:'+region+':111122223333:alias/unai-backup'},'BACKUP_CONFIGURATION_INVALID','UNAI_BACKUP_S3_KMS_KEY_ID'],
      [{UNAI_BACKUP_S3_ENDPOINT:backupServer().endpoint.replace('https:','http:')},'BACKUP_CONFIGURATION_INVALID','UNAI_BACKUP_S3_ENDPOINT'],
      [{UNAI_BACKUP_S3_ENDPOINT:undefined},'BACKUP_CONFIGURATION_REQUIRED','UNAI_BACKUP_S3_ENDPOINT'],
      [{UNAI_BACKUP_S3_REGION:undefined},'BACKUP_CONFIGURATION_REQUIRED','UNAI_BACKUP_S3_REGION'],
      [{UNAI_BACKUP_S3_KMS_KEY_ID:undefined},'BACKUP_CONFIGURATION_REQUIRED','UNAI_BACKUP_S3_KMS_KEY_ID'],
    ];
    for(const [overrides,code,variable] of cases)refused(await run([],{...base,...overrides}),code,variable);
    // Control: with nothing wrong, the same configuration gets as far as the closed database port.
    refused(await run([],base),'BACKUP_DATABASE_FAILED');
    expect(await listing(stage)).toEqual([]);
    expect(await listing(occupied)).toEqual(['operator-file']);
    expect(backupServer().operations.slice(before)).toEqual([]);
  },300000);

  it('uploads the archive, then .sha256, then .manifest.json under the backup key and empties the staging directory',async()=>{
    const {result,operations,stage}=await backupTo('small');
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    const summary=line(result.stdout);
    expect(String(summary.archive)).toMatch(archive.ARCHIVE_NAME);
    expect(summary).toMatchObject({event:'backup.completed',format:'uai-backup/1',objects:1,deletedObjects:1,retentionRemoved:0});
    expect(Number(summary.bytes)).toBeLessThanOrEqual(partBytes);
    expect(operations).toEqual(['PutObject','HeadObject','PutObject','HeadObject','PutObject','HeadObject']);
    expect(await verifyUploaded('small',summary)).toEqual([{id:liveKey,sha256:sha256(objectBytes)}]);
    expect(await listing(stage)).toEqual([]);
  },300000);

  it('stops after a PutObject receipt under another key with BACKUP_DESTINATION_ENCRYPTION_INVALID',async()=>{
    backupServer().receiptOverrides.PutObject=otherArn;
    try{
      const {result,operations,stage,keys}=await backupTo('put-receipt');
      refused(result,'BACKUP_DESTINATION_ENCRYPTION_INVALID');
      expect(operations).toEqual(['PutObject']);
      // The completed PUT stays (the principal cannot delete); no sidecar follows it.
      expect(keys).toHaveLength(1);
      expect(keys[0]).toMatch(/\.tar\.enc$/);
      expect(await listing(stage)).toEqual([]);
    }finally{delete backupServer().receiptOverrides.PutObject;}
  },300000);

  it('uploads an archive larger than one 8 MiB part through a multipart upload',async()=>{
    await ensureLargeObject();
    const {result,operations,stage}=await backupTo('multipart');
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    const summary=line(result.stdout),parts=Math.ceil(Number(summary.bytes)/partBytes);
    expect(parts).toBeGreaterThanOrEqual(2);
    expect(summary).toMatchObject({event:'backup.completed',objects:2,retentionRemoved:0});
    expect(operations).toEqual(['CreateMultipartUpload',...Array<string>(parts).fill('UploadPart'),'CompleteMultipartUpload','HeadObject',
      'PutObject','HeadObject','PutObject','HeadObject']);
    expect(backupServer().pendingUploads).toBe(0);
    expect(await verifyUploaded('multipart',summary)).toEqual([{id:liveKey,sha256:sha256(objectBytes)},{id:largeKey,sha256:largeDigest}]
      .sort((a,b)=>a.id.localeCompare(b.id)));
    expect(await listing(stage)).toEqual([]);
  },300000);

  it('aborts the multipart upload when a part receipt names another key',async()=>{
    await ensureLargeObject();
    backupServer().receiptOverrides.UploadPart=otherArn;
    try{
      const {result,operations,stage,keys}=await backupTo('part-receipt');
      refused(result,'BACKUP_DESTINATION_ENCRYPTION_INVALID');
      expect(operations).toEqual(['CreateMultipartUpload','UploadPart','AbortMultipartUpload']);
      expect(backupServer().pendingUploads).toBe(0);
      expect(keys).toEqual([]);
      expect(await listing(stage)).toEqual([]);
    }finally{delete backupServer().receiptOverrides.UploadPart;}
  },300000);

  it('checks the Create, Complete and HeadObject receipts too, aborting only an unfinished upload',async()=>{
    await ensureLargeObject();
    const cases:[string,(parts:string[])=>string[],number][]=[
      ['CreateMultipartUpload',()=>['CreateMultipartUpload','AbortMultipartUpload'],0],
      // A completed upload is an object the principal cannot delete: nothing to abort, the lifecycle rule keeps it.
      ['CompleteMultipartUpload',parts=>['CreateMultipartUpload',...parts,'CompleteMultipartUpload'],1],
      ['HeadObject',parts=>['CreateMultipartUpload',...parts,'CompleteMultipartUpload','HeadObject'],1],
    ];
    for(const [operation,expected,objects] of cases){
      backupServer().receiptOverrides[operation]=otherArn;
      try{
        const {result,operations,stage,keys}=await backupTo('receipt-'+operation);
        refused(result,'BACKUP_DESTINATION_ENCRYPTION_INVALID');
        const parts=operations.filter(name=>name==='UploadPart');
        if(objects)expect(parts.length).toBeGreaterThanOrEqual(2);
        expect(operations).toEqual(expected(parts));
        expect(backupServer().pendingUploads).toBe(0);
        expect(keys).toHaveLength(objects);
        expect(await listing(stage)).toEqual([]);
      }finally{delete backupServer().receiptOverrides[operation];}
    }
  },300000);
});

it('never names a delete or list command, so the backup principal never deletes or lists (ADR 0043 D9)',async()=>{
  expect(await readFile(script,'utf8')).not.toMatch(/Delete\w*Command|List\w*Command/);
});

it('never prints a password, URL, key, key path or object key',()=>{
  expect(outputs.length).toBeGreaterThan(10);
  const sentinels=[serverUrl.href,scratchUrl.href,backupUrl,'127.0.0.1:'+proxyPort,passLine,key.toString('hex'),key.toString('base64'),
    keyFile,passFile,root,'OBJKEY-SENTINEL','URLPASS-SENTINEL','PGPASS-SENTINEL',...s3Sentinels];
  const password=decodeURIComponent(serverUrl.password);
  if(password)sentinels.push(password);
  for(const output of outputs)for(const sentinel of sentinels)expect(output).not.toContain(sentinel);
});
