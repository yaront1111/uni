import {afterAll,beforeAll,expect,it} from 'vitest';
import {spawn,spawnSync} from 'node:child_process';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {existsSync} from 'node:fs';
import {chmod,mkdir,mkdtemp,readdir,readFile,rm,writeFile} from 'node:fs/promises';
import {createServer,connect,type AddressInfo,type Server} from 'node:net';
import {createRequire} from 'node:module';
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
let proxy:Server|undefined,proxyPort=0,pgDump:string[]=[];
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
async function seed(){
  await scratch.query('INSERT INTO users(id,display_name) VALUES($1,$2)',[actor,'Backup owner']);
  await scratch.query("INSERT INTO owner_scopes(id,scope_kind,display_name,created_by_user_id) VALUES($1,'PERSONAL','Backup',$2)",[owner,actor]);
  await scratch.query("INSERT INTO owner_scope_members(owner_scope_id,user_id,role) VALUES($1,$2,'OWNER')",[owner,actor]);
  const connector=randomUUID();
  await scratch.query("INSERT INTO connectors(id,owner_scope_id,connector_type,external_account_ref,permission_manifest,status) VALUES($1,$2,'CONVERSATION',$3,'{}','ACTIVE')",
    [connector,owner,'backup-'+owner]);
  const item=async(keyId:string,storeKey:string,hash:string,deleted:boolean)=>{
    const id=randomUUID(),erased=deleted?'clock_timestamp()':'NULL';
    await scratch.query(`INSERT INTO source_items(id,owner_scope_id,connector_id,source_type,external_id,actor_ref,submitted_by_user_id,
      raw_object_ref,content_hash,sensitivity,allowed_purposes,ingestion_version,idempotency_key,deleted_at) VALUES($1,$2,$3,'CONVERSATION',$4,$5,$6,$7,$8,
      'PRIVATE',ARRAY['PERSONAL_ASSISTANCE'],'evidence-json-v1',$9,${erased})`,
      [id,owner,connector,'backup-'+keyId,JSON.stringify({type:'USER',id:actor}),actor,randomUUID(),hash,randomUUID()]);
    await scratch.query(`INSERT INTO evidence_object_keys(id,owner_scope_id,source_item_id,object_store_key,encryption_key_ref,deleted_at)
      VALUES($1,$2,$3,$4,$5,${erased})`,[keyId,owner,id,storeKey,'kms:'+storage.kmsKeyId]);
  };
  await item(liveKey,objectKey,sha256(objectBytes),false);
  await item(erasedKey,'evidence/erased/'+erasedKey,sha256(Buffer.from('erased')),true);
  const store=await createEncryptedS3Store(storage,async(_context,id)=>id===liveKey?objectKey:null);
  try{await store.put({actorId:actor,ownerScopeId:owner,purpose:'evidence.ingest',correlationId:randomUUID()},liveKey,objectBytes);}
  finally{store.close();}
}

beforeAll(async()=>{
  await admin.query('CREATE DATABASE '+database);
  await runMigrations(scratch,resolve('migrations'));
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
  refused(await run([],{UNAI_BACKUP_DESTINATION:'s3://uai-backup/host/'}),'BACKUP_DESTINATION_UNSUPPORTED');
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
  for(const word of ['pnpm backup','--assume-quiescent','UNAI_BACKUP_KEY_FILE','UNAI_BACKUP_DESTINATION','BACKUP_PRECONDITION_FAILED'])
    expect(result.stdout).toContain(word);
});

it('never prints a password, URL, key, key path or object key',()=>{
  expect(outputs.length).toBeGreaterThan(10);
  const sentinels=[serverUrl.href,scratchUrl.href,backupUrl,'127.0.0.1:'+proxyPort,passLine,key.toString('hex'),key.toString('base64'),
    keyFile,passFile,root,'OBJKEY-SENTINEL','URLPASS-SENTINEL','PGPASS-SENTINEL'];
  const password=decodeURIComponent(serverUrl.password);
  if(password)sentinels.push(password);
  for(const output of outputs)for(const sentinel of sentinels)expect(output).not.toContain(sentinel);
});
