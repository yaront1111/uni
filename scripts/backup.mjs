/**
 * `pnpm backup`: one encrypted uai-backup/1 archive (scripts/lib/backup-archive.mjs)
 * of the database and every live evidence object, for a timer to run under
 * ADR 0043 D11 maintenance mode (docs/operations/backup.md), into a local
 * directory or, staged locally first, the D9 backup bucket. Unlike the harness,
 * this tool runs against real infrastructure, so it follows the product error
 * rules: it prints exactly one JSON line, stdout on success and stderr on
 * failure, and never an error message, URL, path, key or object key.
 */
import {spawn,spawnSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {access,open,readFile,readdir,realpath,rename,rm,stat,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {isAbsolute,join,resolve} from 'node:path';
import {DUMP_PART_BYTES,archiveName,createArchiveWriter,pruneArchives,readBackupKey,tableDigests,verifyArchive} from './lib/backup-archive.mjs';

const USAGE=`Usage: pnpm backup [--assume-quiescent]
       pnpm backup --help

Writes one encrypted uai-backup/1 archive of the database and every live evidence
object to UNAI_BACKUP_DESTINATION as uai-backup-<UTC>.tar.enc, with .sha256 and
.manifest.json sidecars, and verifies it with the key. A local directory then
applies retention. An s3:// destination is written to UNAI_BACKUP_STAGING_DIR
first, uploaded with SSE-KMS under the backup key (the manifest last), and the
staged files are removed; retention there belongs to the bucket's lifecycle rule.

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
                              and the staging directory
  UNAI_BACKUP_DESTINATION     absolute local directory, or s3://<bucket>/<prefix>/
  UNAI_BACKUP_STAGING_DIR     s3:// only: an existing, empty absolute directory on
                              the data volume (never tmpfs)
  UNAI_BACKUP_RETENTION_DAYS  optional, 1-3650, local directory only: prune older
                              archives after success; refused with s3://
  UNAI_BACKUP_S3_ENDPOINT, UNAI_BACKUP_S3_REGION
                              s3:// only: the backup bucket's https endpoint and region
  UNAI_BACKUP_S3_KMS_KEY_ID   s3:// only: the backup key's full ARN, never an alias
  UNAI_BACKUP_PG_DUMP         optional pg_dump path or JSON argv prefix; default pg_dump

AWS credentials come only from the SDK default chain, for both buckets.

Output: {"event":"backup.completed",...} on stdout, or
{"event":"backup.failed","code":"BACKUP_..."} on stderr.
Exit status: 0 success; 1 failure, for example BACKUP_PRECONDITION_FAILED or
BACKUP_KEY_LOCATION_INVALID; 2 BACKUP_ARGUMENTS_INVALID.
`;
const UNITS=['unai-api','unai-worker'];
/** S3's part floor is 5 MiB; 8 MiB × 10,000 parts covers uai-backup/1's 2^36-byte ceiling. */
const UPLOAD_PART_BYTES=8*1024*1024;
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
/** The realpath of an existing, writable directory named by an absolute path; throws a bare Error otherwise. */
async function directoryOf(value){
  if(!isAbsolute(value))throw new Error();
  const real=await realpath(value);
  if(!(await stat(real)).isDirectory())throw new Error();
  await access(real,constants.W_OK);
  return real;
}
async function destinationOf(value){
  try{return await directoryOf(value);}catch{throw refuse('BACKUP_DESTINATION_INVALID');}
}
/** Empty at the start, so cleanup() only ever removes files this run created; leftovers are refused, never cleaned. */
async function stagingOf(value){
  try{
    const real=await directoryOf(value);
    if((await readdir(real)).length)throw new Error();
    return real;
  }catch{throw refuse('BACKUP_CONFIGURATION_INVALID','UNAI_BACKUP_STAGING_DIR');}
}
const S3_DESTINATION=/^s3:\/\/([a-z0-9][a-z0-9.-]{1,61}[a-z0-9])\/((?:[A-Za-z0-9._-]+\/)*)$/;
/** null for a local path; otherwise s3://<bucket>/(<segment>/)* with no . or .. segment and a prefix of at most 512 bytes. */
function s3DestinationOf(value){
  if(!/^s3:\/\//i.test(value))return null;
  const [,bucket,prefix]=S3_DESTINATION.exec(value)??[];
  if(bucket===undefined||prefix.length>512||prefix.split('/').some(segment=>segment==='.'||segment==='..'))throw refuse('BACKUP_DESTINATION_INVALID');
  return {bucket,prefix};
}
/** ADR 0043 D9: the backup bucket has its own endpoint, region and key, and is never the evidence bucket. */
function backupBucketOf(target,storage){
  const endpoint=need('UNAI_BACKUP_S3_ENDPOINT',process.env.UNAI_BACKUP_S3_ENDPOINT);
  let url=null;
  try{url=new URL(endpoint);}catch{}
  if(url?.protocol!=='https:'||url.username||url.password||url.search||url.hash)throw refuse('BACKUP_CONFIGURATION_INVALID','UNAI_BACKUP_S3_ENDPOINT');
  const region=need('UNAI_BACKUP_S3_REGION',process.env.UNAI_BACKUP_S3_REGION);
  const keyId=need('UNAI_BACKUP_S3_KMS_KEY_ID',process.env.UNAI_BACKUP_S3_KMS_KEY_ID);
  // Receipts echo the key ARN, never an alias, so an alias would fail only after a whole backup.
  if(/^alias\/|:alias\//.test(keyId))throw refuse('BACKUP_CONFIGURATION_INVALID','UNAI_BACKUP_S3_KMS_KEY_ID');
  if(target.bucket===storage.bucket.toLowerCase()||keyId===storage.kmsKeyId)throw refuse('BACKUP_DESTINATION_INVALID');
  return {...target,endpoint:url.href,region,keyId};
}
function retentionOf(value,s3){
  if(value===undefined||value==='')return null;
  // The backup principal cannot delete there: the lifecycle rule owns retention (ADR 0043 D9).
  if(s3)throw refuse('BACKUP_CONFIGURATION_INVALID','UNAI_BACKUP_RETENTION_DAYS');
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
  let target=s3DestinationOf(given),directory,outside;
  if(target){
    const staging=need('UNAI_BACKUP_STAGING_DIR',process.env.UNAI_BACKUP_STAGING_DIR);
    directory=await stagingOf(staging);outside=[staging,directory];
  }else{directory=await destinationOf(given);outside=[given,directory];}
  state.key=await readBackupKey(need('UNAI_BACKUP_KEY_FILE',process.env.UNAI_BACKUP_KEY_FILE),{outside});
  const retentionDays=retentionOf(process.env.UNAI_BACKUP_RETENTION_DAYS,target!==null);
  const url=databaseUrlOf(need('UNAI_BACKUP_DATABASE_URL',process.env.UNAI_BACKUP_DATABASE_URL));
  if(process.env.PGPASSWORD!==undefined)throw refuse('BACKUP_CONFIGURATION_INVALID','PGPASSWORD');
  const caFile=resolve(need('UNAI_DATABASE_CA_FILE',process.env.UNAI_DATABASE_CA_FILE));
  const ca=await readFile(caFile,'utf8').catch(()=>'');
  if(!ca.trim())throw refuse('BACKUP_CONFIGURATION_INVALID','UNAI_DATABASE_CA_FILE');
  const storage={endpoint:need('UNAI_S3_ENDPOINT',process.env.UNAI_S3_ENDPOINT),region:need('UNAI_S3_REGION',process.env.UNAI_S3_REGION),
    bucket:need('UNAI_S3_BUCKET',process.env.UNAI_S3_BUCKET),kmsKeyId:need('UNAI_S3_KMS_KEY_ID',process.env.UNAI_S3_KMS_KEY_ID)};
  if(target)target=backupBucketOf(target,storage);
  const pgDump=pgDumpOf(process.env.UNAI_BACKUP_PG_DUMP);
  return {directory,target,retentionDays,url,caFile,ca,storage,pgDump};
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

/** Above one part: 8 MiB slices read from the staged file one at a time. state.upload is recorded before any
 * receipt check and cleared once Complete returns, so cleanup() aborts every unfinished upload. */
async function putParts(request,path,size,s3,state){
  const created=await s3.send(new s3.sdk.CreateMultipartUploadCommand(request));
  state.upload={Bucket:request.Bucket,Key:request.Key,UploadId:created.UploadId};
  s3.sealed(created);
  const file=await open(path,'r'),Parts=[];
  try{
    for(let offset=0;offset<size;offset+=UPLOAD_PART_BYTES){
      const Body=Buffer.alloc(Math.min(UPLOAD_PART_BYTES,size-offset));
      for(let filled=0;filled<Body.length;){
        const {bytesRead}=await file.read(Body,filled,Body.length-filled,offset+filled);
        if(!bytesRead)throw refuse('BACKUP_DESTINATION_UPLOAD_FAILED');
        filled+=bytesRead;
      }
      const PartNumber=Parts.length+1;
      Parts.push({ETag:s3.sealed(await s3.send(new s3.sdk.UploadPartCommand({...state.upload,PartNumber,Body}))).ETag,PartNumber});
    }
  }finally{await file.close().catch(()=>{});}
  const completed=await s3.send(new s3.sdk.CompleteMultipartUploadCommand({...state.upload,MultipartUpload:{Parts},IfNoneMatch:'*'}));
  state.upload=null;
  s3.sealed(completed);
}
/** One staged file to <prefix><name> under the backup key, never overwriting, then a HeadObject size check. */
async function putFile(target,path,name,s3,state){
  const request={Bucket:target.bucket,Key:target.prefix+name,ServerSideEncryption:'aws:kms',SSEKMSKeyId:target.keyId};
  try{
    const size=(await stat(path)).size;
    if(size>UPLOAD_PART_BYTES)await putParts(request,path,size,s3,state);
    else s3.sealed(await s3.send(new s3.sdk.PutObjectCommand({...request,Body:await readFile(path),IfNoneMatch:'*'})));
    const head=s3.sealed(await s3.send(new s3.sdk.HeadObjectCommand({Bucket:request.Bucket,Key:request.Key})));
    if(head.ContentLength!==size)throw refuse('BACKUP_DESTINATION_UPLOAD_FAILED');
  }catch(error){throw own(error)?error:refuse('BACKUP_DESTINATION_UPLOAD_FAILED');}
}
/** ADR 0043 D9: the archive, .sha256, then .manifest.json last, so an archive without its manifest marks an
 * incomplete run. Credentials come only from the SDK default chain. Never a delete and never a list. */
async function upload(target,directory,name,state){
  const sdk=createRequire(new URL('../packages/storage/package.json',import.meta.url))('@aws-sdk/client-s3');
  const client=new sdk.S3Client({endpoint:target.endpoint,region:target.region,forcePathStyle:true,maxAttempts:3,
    requestHandler:{connectionTimeout:5000,requestTimeout:30000}});
  state.backup={sdk,client};
  const s3={sdk,
    send:command=>client.send(command).catch(error=>{
      throw refuse(error?.$metadata?.httpStatusCode===412?'BACKUP_ARCHIVE_EXISTS':'BACKUP_DESTINATION_UPLOAD_FAILED');
    }),
    sealed:result=>{
      if(result?.ServerSideEncryption!=='aws:kms'||result.SSEKMSKeyId!==target.keyId)throw refuse('BACKUP_DESTINATION_ENCRYPTION_INVALID');
      return result;
    }};
  for(const file of [name,name+'.sha256',name+'.manifest.json'])await putFile(target,join(directory,file),file,s3,state);
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
  const now=new Date(),name=archiveName(now),path=join(config.directory,name);
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
  // Staged files stay in state, so cleanup() empties the staging directory on success and on every failure.
  if(config.target)await upload(config.target,config.directory,name,state);
  else{state.archive=null;state.sidecars=[];}
  await cleanup(state);
  const removed=config.retentionDays?await pruneArchives(config.directory,config.retentionDays,new Date()):[];
  return {event:'backup.completed',format:'uai-backup/1',archive:name,bytes:written.bytes,sha256:written.sha256,
    quiescence:options.assumeQuiescent?'assumed':'systemd',...counts,migrationHead:taken.migrations.head,registryReleases:versions,
    retentionRemoved:removed.length,durationMs:Date.now()-started};
}
/** Every exit path: stop pg_dump, drop the partial or the unfinished archive and sidecars, abort an unfinished
 * multipart upload, roll back, zero the key. */
async function cleanup(state){
  state.child?.kill('SIGKILL');state.child=null;
  await state.writer?.abort().catch(()=>{});state.writer=null;
  state.store?.close();state.store=null;
  if(state.upload)await state.backup.client.send(new state.backup.sdk.AbortMultipartUploadCommand(state.upload)).catch(()=>{});
  state.upload=null;
  state.backup?.client.destroy();state.backup=null;
  state.client?.release(true);state.client=null;
  await state.pool?.end().catch(()=>{});state.pool=null;
  for(const path of [...state.sidecars,state.archive])if(path)await rm(path,{force:true}).catch(()=>{});
  state.sidecars=[];state.archive=null;
  state.key?.fill(0);
}

const state={key:null,writer:null,child:null,store:null,pool:null,client:null,archive:null,sidecars:[],backup:null,upload:null};
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
