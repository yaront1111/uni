/**
 * `pnpm backup`: one encrypted uai-backup/1 archive (scripts/lib/backup-archive.mjs)
 * of the database and every live evidence object, for a timer to run under
 * ADR 0043 D11 maintenance mode (docs/operations/backup.md). Unlike the harness,
 * this tool runs against real infrastructure, so it follows the product error
 * rules: it prints exactly one JSON line, stdout on success and stderr on
 * failure, and never an error message, URL, path, key or object key.
 */
import {spawn,spawnSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {access,readFile,realpath,rename,rm,stat,writeFile} from 'node:fs/promises';
import {isAbsolute,join,resolve} from 'node:path';
import {DUMP_PART_BYTES,archiveName,createArchiveWriter,pruneArchives,readBackupKey,tableDigests,verifyArchive} from './lib/backup-archive.mjs';

const USAGE=`Usage: pnpm backup [--assume-quiescent]
       pnpm backup --help

Writes one encrypted uai-backup/1 archive of the database and every live evidence
object to UNAI_BACKUP_DESTINATION as uai-backup-<UTC>.tar.enc, with .sha256 and
.manifest.json sidecars, verifies it with the key, then applies retention.

  --assume-quiescent  skip the systemd unit check (hosts without systemd only);
                      the database backend check always runs
  --help              print this text and exit 0

Variables:
  UNAI_BACKUP_DATABASE_URL    postgres URL of the backup role, without a password
  PGPASSFILE                  libpq password file for that role; PGPASSWORD is refused
  UNAI_DATABASE_CA_FILE       CA that verifies the PostgreSQL server certificate
  UNAI_S3_ENDPOINT, UNAI_S3_REGION, UNAI_S3_BUCKET, UNAI_S3_KMS_KEY_ID
                              the evidence bucket, as the API reads them
  UNAI_BACKUP_KEY_FILE        32-byte key file, mode 0600, outside the destination
  UNAI_BACKUP_DESTINATION     absolute local directory (s3:// is not supported yet)
  UNAI_BACKUP_RETENTION_DAYS  optional, 1-3650: prune older archives after success
  UNAI_BACKUP_PG_DUMP         optional pg_dump path or JSON argv prefix; default pg_dump

Output: {"event":"backup.completed",...} on stdout, or
{"event":"backup.failed","code":"BACKUP_..."} on stderr.
Exit status: 0 success; 1 failure, for example BACKUP_PRECONDITION_FAILED or
BACKUP_KEY_LOCATION_INVALID; 2 BACKUP_ARGUMENTS_INVALID.
`;
const UNITS=['unai-api','unai-worker'];
const MAPPED={STORAGE_ENCRYPTION_REQUIRED:'BACKUP_EVIDENCE_STORE_UNAVAILABLE',STORAGE_CONFIGURATION_INVALID:'BACKUP_EVIDENCE_STORE_UNAVAILABLE',
  STORAGE_OPERATION_FAILED:'BACKUP_EVIDENCE_OBJECT_UNREADABLE',STORAGE_ACCESS_DENIED:'BACKUP_EVIDENCE_OBJECT_UNREADABLE',
  DATABASE_TLS_CONFIG_INVALID:'BACKUP_DATABASE_URL_INVALID'};
class Refusal extends Error{constructor(code,variable){super(code);this.variable=variable;}}
const refuse=(code,variable)=>new Refusal(code,variable);
const own=error=>error instanceof Error&&/^BACKUP_[A-Z_]+$/.test(error.message);
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const entryName=(prefix,index)=>prefix+String(index).padStart(6,'0');
// pg prints a deprecation notice when it reads the pgpass file (ADR 0043 D9);
// nothing but the one JSON line may reach the output.
process.noDeprecation=true;

let printed=false;
const print=(stream,record)=>new Promise(done=>{
  if(printed)return done();
  printed=true;stream.write(JSON.stringify(record)+'\n',()=>done());
});
function failure(error){
  if(own(error))return error.variable?{event:'backup.failed',code:error.message,variable:error.variable}:{event:'backup.failed',code:error.message};
  return {event:'backup.failed',code:error instanceof Error&&Object.hasOwn(MAPPED,error.message)?MAPPED[error.message]:'BACKUP_FAILED'};
}
function parseArguments(argv){
  const flags=new Set();
  for(const flag of argv){
    if(!['--help','--assume-quiescent'].includes(flag)||flags.has(flag))throw refuse('BACKUP_ARGUMENTS_INVALID');
    flags.add(flag);
  }
  return {help:flags.has('--help'),assumeQuiescent:flags.has('--assume-quiescent')};
}

const need=(name,value)=>{if(value===undefined||!value.trim())throw refuse('BACKUP_CONFIGURATION_REQUIRED',name);return value;};
async function destinationOf(value){
  if(/^s3:\/\//i.test(value))throw refuse('BACKUP_DESTINATION_UNSUPPORTED');
  try{
    if(!isAbsolute(value))throw new Error();
    const real=await realpath(value);
    if(!(await stat(real)).isDirectory())throw new Error();
    await access(real,constants.W_OK);
    return real;
  }catch{throw refuse('BACKUP_DESTINATION_INVALID');}
}
function retentionOf(value){
  if(value===undefined||value==='')return null;
  if(!/^[1-9][0-9]{0,3}$/.test(value)||Number(value)>3650)throw refuse('BACKUP_RETENTION_INVALID');
  return Number(value);
}
function databaseUrlOf(value){
  let url;
  try{url=new URL(value);}catch{throw refuse('BACKUP_DATABASE_URL_INVALID');}
  if(!['postgres:','postgresql:'].includes(url.protocol)||!url.hostname||!url.username||url.password||/^[^/]*\/\/[^/@]*:[^/@]*@/.test(value)
    ||value.includes('?')||value.includes('#')||!/^\/[^/]+$/.test(url.pathname))throw refuse('BACKUP_DATABASE_URL_INVALID');
  try{decodeURIComponent(url.username);decodeURIComponent(url.pathname);}catch{throw refuse('BACKUP_DATABASE_URL_INVALID');}
  return url;
}
function pgDumpOf(value){
  if(value===undefined||value==='')return ['pg_dump'];
  let prefix=[value];
  if(value.trimStart().startsWith('['))try{prefix=JSON.parse(value);}catch{prefix=null;}
  if(!Array.isArray(prefix)||!prefix.length||prefix.some(part=>typeof part!=='string'||!part))throw refuse('BACKUP_CONFIGURATION_INVALID','UNAI_BACKUP_PG_DUMP');
  return prefix;
}
/** Every variable, in the documented order, before any network or database work. */
async function configuration(state){
  const given=need('UNAI_BACKUP_DESTINATION',process.env.UNAI_BACKUP_DESTINATION);
  const destination=await destinationOf(given);
  state.key=await readBackupKey(need('UNAI_BACKUP_KEY_FILE',process.env.UNAI_BACKUP_KEY_FILE),{outside:[given,destination]});
  const retentionDays=retentionOf(process.env.UNAI_BACKUP_RETENTION_DAYS);
  const url=databaseUrlOf(need('UNAI_BACKUP_DATABASE_URL',process.env.UNAI_BACKUP_DATABASE_URL));
  if(process.env.PGPASSWORD!==undefined)throw refuse('BACKUP_CONFIGURATION_INVALID','PGPASSWORD');
  const caFile=resolve(need('UNAI_DATABASE_CA_FILE',process.env.UNAI_DATABASE_CA_FILE));
  const ca=await readFile(caFile,'utf8').catch(()=>'');
  if(!ca.trim())throw refuse('BACKUP_CONFIGURATION_INVALID','UNAI_DATABASE_CA_FILE');
  const storage={endpoint:need('UNAI_S3_ENDPOINT',process.env.UNAI_S3_ENDPOINT),region:need('UNAI_S3_REGION',process.env.UNAI_S3_REGION),
    bucket:need('UNAI_S3_BUCKET',process.env.UNAI_S3_BUCKET),kmsKeyId:need('UNAI_S3_KMS_KEY_ID',process.env.UNAI_S3_KMS_KEY_ID)};
  const pgDump=pgDumpOf(process.env.UNAI_BACKUP_PG_DUMP);
  return {destination,retentionDays,url,caFile,ca,storage,pgDump};
}
/** ADR 0043 D11: both units report inactive or failed. No systemd counts as unknown, never as stopped. */
function unitsStopped(){
  for(const unit of UNITS){
    const probe=spawnSync('systemctl',['is-active',unit],{encoding:'utf8',stdio:['ignore','pipe','ignore'],timeout:30000});
    if(probe.error||![3,4].includes(probe.status)||!['inactive','failed'].includes(probe.stdout.trim()))throw refuse('BACKUP_PRECONDITION_FAILED');
  }
}

async function rows(client,text,values){
  try{return (await client.query(text,values)).rows;}catch{throw refuse('BACKUP_DATABASE_FAILED');}
}
/** Verified TLS only; a role that cannot bypass row security would back up nothing under FORCE RLS. */
async function openDatabase(config,state,createDatabasePool){
  state.pool=createDatabasePool(config.url.href,config.ca);
  state.pool.on('error',()=>{});
  try{state.client=await state.pool.connect();}catch{throw refuse('BACKUP_DATABASE_FAILED');}
  state.client.on('error',()=>{});
  const [role]=await rows(state.client,'SELECT rolsuper OR rolbypassrls AS bypass FROM pg_roles WHERE rolname=current_user');
  if(role?.bypass!==true)throw refuse('BACKUP_DATABASE_ROLE_INVALID');
  const [busy]=await rows(state.client,"SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename IN ('unai_api_login','unai_worker_login')");
  if(busy?.n!==0)throw refuse('BACKUP_PRECONDITION_FAILED');
  const [server]=await rows(state.client,"SELECT current_setting('server_version_num')::int AS version");
  return server.version;
}
/** pg_dump's environment: no inherited PG* setting but PGPASSFILE, and verify-full TLS. */
function dumpEnvironment(config){
  const inherited=Object.entries(process.env).filter(([name])=>!/^PG/i.test(name)||name==='PGPASSFILE');
  return {...Object.fromEntries(inherited),PGHOST:config.url.hostname.replace(/^\[|\]$/g,''),PGPORT:config.url.port||'5432',
    PGUSER:decodeURIComponent(config.url.username),PGDATABASE:decodeURIComponent(config.url.pathname.slice(1)),
    PGSSLMODE:'verify-full',PGSSLROOTCERT:config.caFile,PGCONNECT_TIMEOUT:'10',PGAPPNAME:'unai-backup'};
}
function pgDumpMajor(prefix,environment,serverVersion){
  const probe=spawnSync(prefix[0],[...prefix.slice(1),'--version'],{env:environment,encoding:'utf8',stdio:['ignore','pipe','ignore'],timeout:120000});
  if(probe.error||probe.status!==0)throw refuse('BACKUP_PG_DUMP_UNAVAILABLE');
  const major=Number(/\(PostgreSQL\) (\d+)/.exec(probe.stdout)?.[1]);
  if(major!==Math.floor(serverVersion/10000))throw refuse('BACKUP_PG_DUMP_VERSION_MISMATCH');
  return major;
}
/** One exported snapshot: everything the manifest states is read in it, and pg_dump imports it. */
async function snapshot(client,kmsKeyId){
  await rows(client,'BEGIN ISOLATION LEVEL SERIALIZABLE, READ ONLY, DEFERRABLE');
  for(const setting of ['row_security = off','statement_timeout = 0','idle_in_transaction_session_timeout = 0'])await rows(client,'SET LOCAL '+setting);
  const [exported]=await rows(client,'SELECT pg_export_snapshot() AS id');
  const tables=await tableDigests(client);
  const [ledger]=await rows(client,'SELECT max(name) AS head,count(*)::int AS count FROM unai_migrations.applied');
  const releases=(await rows(client,"SELECT id,semantic_version,content_hash FROM registry_releases ORDER BY string_to_array(semantic_version,'.')::int[]"))
    .map(row=>({id:row.id,semanticVersion:row.semantic_version,contentHash:row.content_hash}));
  const evidence=await rows(client,`SELECT k.id,k.owner_scope_id,k.object_store_key,k.encryption_key_ref,k.deleted_at IS NOT NULL AS key_deleted,
    s.deleted_at IS NOT NULL AS source_deleted,s.content_hash FROM evidence_object_keys k
    JOIN source_items s ON s.owner_scope_id=k.owner_scope_id AND s.id=k.source_item_id ORDER BY k.id`);
  const live=[];let deleted=0;
  for(const row of evidence){
    if(row.key_deleted!==row.source_deleted)throw refuse('BACKUP_EVIDENCE_DELETION_STATE_MISMATCH');
    if(row.key_deleted){deleted++;continue;}
    if(row.encryption_key_ref!=='kms:'+kmsKeyId)throw refuse('BACKUP_EVIDENCE_PROVIDER_UNKNOWN');
    live.push(row);
  }
  return {snapshotId:exported.id,tables,migrations:{head:ledger.head,count:ledger.count},releases,live,deleted};
}
/** Streams pg_dump's output into database.dump.NNNNNN parts; its stderr is discarded unread. */
async function dumpInto(writer,config,environment,snapshotId,state){
  const child=spawn(config.pgDump[0],[...config.pgDump.slice(1),'--format=custom','--snapshot='+snapshotId,'--no-password','--lock-wait-timeout=60000'],
    {env:environment,stdio:['ignore','pipe','pipe']});
  state.child=child;child.stderr.resume();
  const exited=new Promise(done=>{child.once('error',()=>done(null));child.once('close',code=>done(code));});
  let pending=[],size=0,parts=0;
  const flush=async bytes=>{
    if(!parts&&bytes.subarray(0,5).toString('latin1')!=='PGDMP')throw refuse('BACKUP_PG_DUMP_FAILED');
    await writer.add(entryName('database.dump.',parts++),bytes);
  };
  const take=async length=>{
    const all=Buffer.concat(pending,size),rest=Buffer.from(all.subarray(length));
    await flush(all.subarray(0,length));
    all.fill(0);for(const chunk of pending)chunk.fill(0);
    pending=rest.length?[rest]:[];size=rest.length;
  };
  try{
    for await(const chunk of child.stdout){pending.push(chunk);size+=chunk.length;while(size>=DUMP_PART_BYTES)await take(DUMP_PART_BYTES);}
    if(size)await take(size);
  }catch(error){child.kill('SIGKILL');throw own(error)?error:refuse('BACKUP_PG_DUMP_FAILED');}
  const code=await exited;state.child=null;
  if(code===null)throw refuse('BACKUP_PG_DUMP_UNAVAILABLE');
  if(code!==0||!parts)throw refuse('BACKUP_PG_DUMP_FAILED');
  return parts;
}
/** Each live object through the adapter's verified read, checked against the snapshot's content hash. */
async function objectsInto(writer,store,live){
  const run=randomUUID();
  for(const [index,row] of live.entries()){
    const bytes=await store.get({actorId:run,ownerScopeId:row.owner_scope_id,purpose:'operations.backup',correlationId:run},row.id);
    const matches=sha256(bytes)===row.content_hash;
    if(matches)await writer.add(entryName('objects/',index),bytes);
    bytes.fill(0);
    if(!matches)throw refuse('BACKUP_EVIDENCE_OBJECT_MISMATCH');
  }
}
async function sidecar(path,text,state){
  state.sidecars.push(path+'.partial',path);
  try{await writeFile(path+'.partial',text,{mode:0o600,flag:'wx'});await rename(path+'.partial',path);}
  catch{throw refuse('BACKUP_ARCHIVE_WRITE_FAILED');}
}

async function backup(options,state){
  const started=Date.now(),config=await configuration(state);
  if(!options.assumeQuiescent)unitsStopped();
  (await import('tsx/esm/api')).register();
  const {createDatabasePool}=await import('../packages/postgres/src/index.ts');
  const {createEncryptedS3Store}=await import('../packages/storage/src/index.ts');
  const serverVersion=await openDatabase(config,state,createDatabasePool);
  const environment=dumpEnvironment(config),pgDumpVersion=pgDumpMajor(config.pgDump,environment,serverVersion);
  const objectKeys=new Map();
  state.store=await createEncryptedS3Store(config.storage,async(_context,id)=>objectKeys.get(id)??null);
  const now=new Date(),name=archiveName(now),path=join(config.destination,name);
  const taken=await snapshot(state.client,config.storage.kmsKeyId);
  for(const row of taken.live)objectKeys.set(row.id,row.object_store_key);
  const manifest={format:'uai-backup/1',createdAt:now.toISOString(),serverVersionNum:serverVersion,pgDumpMajor:pgDumpVersion,
    migrations:taken.migrations,registryReleases:taken.releases,tables:taken.tables,evidence:{live:taken.live.length,deleted:taken.deleted},
    objects:taken.live.map((row,index)=>({entry:entryName('objects/',index),evidenceObjectKeyId:row.id,ownerScopeId:row.owner_scope_id,
      key:row.object_store_key,sha256:row.content_hash}))};
  state.writer=await createArchiveWriter(path,state.key);
  await state.writer.add('manifest.json',Buffer.from(JSON.stringify(manifest)));
  const dumpParts=await dumpInto(state.writer,config,environment,taken.snapshotId,state);
  await objectsInto(state.writer,state.store,taken.live);
  const written=await state.writer.finish();state.writer=null;state.archive=path;
  await rows(state.client,'COMMIT');state.client.release();state.client=null;
  const read=await verifyArchive(path,state.key);
  if(read.sha256!==written.sha256||JSON.stringify(read.entries)!==JSON.stringify(written.entries))throw refuse('BACKUP_ARCHIVE_INTEGRITY_FAILED');
  const counts={tables:taken.tables.length,rows:taken.tables.reduce((sum,table)=>sum+table.rows,0),objects:taken.live.length,deletedObjects:taken.deleted,dumpParts};
  const versions=taken.releases.map(release=>release.semanticVersion);
  await sidecar(path+'.sha256',written.sha256+'  '+name+'\n',state);
  await sidecar(path+'.manifest.json',JSON.stringify({format:'uai-backup/1',archive:name,createdAt:manifest.createdAt,sha256:written.sha256,
    bytes:written.bytes,counts,migrationHead:taken.migrations.head,registryReleases:versions},null,2)+'\n',state);
  state.archive=null;state.sidecars=[];
  await cleanup(state);
  const removed=config.retentionDays?await pruneArchives(config.destination,config.retentionDays,new Date()):[];
  return {event:'backup.completed',format:'uai-backup/1',archive:name,bytes:written.bytes,sha256:written.sha256,
    quiescence:options.assumeQuiescent?'assumed':'systemd',...counts,migrationHead:taken.migrations.head,registryReleases:versions,
    retentionRemoved:removed.length,durationMs:Date.now()-started};
}
/** Every exit path: stop pg_dump, drop the partial or the unfinished archive and sidecars, roll back, zero the key. */
async function cleanup(state){
  state.child?.kill('SIGKILL');state.child=null;
  await state.writer?.abort().catch(()=>{});state.writer=null;
  state.store?.close();state.store=null;
  state.client?.release(true);state.client=null;
  await state.pool?.end().catch(()=>{});state.pool=null;
  for(const path of [...state.sidecars,state.archive])if(path)await rm(path,{force:true}).catch(()=>{});
  state.sidecars=[];state.archive=null;
  state.key?.fill(0);
}

const state={key:null,writer:null,child:null,store:null,pool:null,client:null,archive:null,sidecars:[]};
let stopping=false;
async function stop(error,status=1){
  if(stopping)return;
  stopping=true;
  await cleanup(state).catch(()=>{});
  await print(process.stderr,failure(error));
  process.exit(status);
}
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>stop(refuse('BACKUP_INTERRUPTED')));
process.on('uncaughtException',error=>stop(error));
process.on('unhandledRejection',error=>stop(error));
let options;
try{options=parseArguments(process.argv.slice(2));}catch(error){await stop(error,2);}
if(options.help)process.stdout.write(USAGE,()=>process.exit(0));
else try{
  const summary=await backup(options,state);
  if(!stopping){await print(process.stdout,summary);process.exit(0);}
}catch(error){await stop(error);}
