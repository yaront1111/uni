/**
 * `pnpm restore`: one encrypted uai-backup/1 archive of `pnpm backup` (scripts/lib/backup-archive.mjs),
 * from a local file or directory or, staged locally first, the backup bucket, into an EMPTY database
 * and an EMPTY prefix of an evidence bucket (docs/operations/restore.md). Pass 1 authenticates the
 * whole archive under the key and records every entry's digest; nothing is written before it
 * resolves. The apply pass reads the archive again and uses an entry only when it matches its pass-1
 * record. The verify pass compares the restored tables, migration ledger, registry releases and
 * objects with the manifest. Like `pnpm backup`, it prints exactly one JSON line, stdout on success
 * and stderr on failure, and never an error message, URL, path, key, bucket, prefix or object key.
 */
import {spawn,spawnSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {constants,createWriteStream} from 'node:fs';
import {access,lstat,readFile,readdir,realpath,rm,stat} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {basename,dirname,isAbsolute,join,resolve,sep} from 'node:path';
import {pipeline} from 'node:stream/promises';
import {ARCHIVE_NAME,readArchive,readBackupKey,tableDigests} from './lib/backup-archive.mjs';

const USAGE=`Usage: pnpm restore
       pnpm restore --help

Restores one encrypted uai-backup/1 archive written by pnpm backup into an empty
database and an empty prefix of an evidence bucket, then verifies every table
digest, the migration ledger, the registry releases and every object against the
archive's manifest. The whole archive is authenticated with the key before anything
is written. A database with a schema besides public or a relation in public, and a
prefix that holds any object, are refused: no flag skips that check.

  --help  print this text and exit 0

Variables:
  UNAI_RESTORE_ARCHIVE        an absolute archive path; an absolute directory ending
                              in / (its newest archive that has both sidecars); or
                              s3://<bucket>/<prefix>/ with an optional archive name
  UNAI_RESTORE_STAGING_DIR    s3:// only: an existing, empty absolute directory on
                              the data volume (never tmpfs), emptied on every exit
  UNAI_RESTORE_ARCHIVE_S3_ENDPOINT, UNAI_RESTORE_ARCHIVE_S3_REGION
                              s3:// only: the backup bucket's https endpoint and region
  UNAI_RESTORE_KEY_FILE       the backup's 32-byte key file, mode 0600, outside the
                              archive directory and the staging directory
  UNAI_RESTORE_DATABASE_URL   postgres URL of a superuser and the empty target
                              database, without a password
  PGPASSFILE                  libpq password file for that role; PGPASSWORD is refused
  UNAI_DATABASE_CA_FILE       CA that verifies the PostgreSQL server certificate
  UNAI_RESTORE_S3_ENDPOINT, UNAI_RESTORE_S3_REGION, UNAI_RESTORE_S3_BUCKET
                              the target evidence bucket, never the archive's bucket
  UNAI_RESTORE_S3_KMS_KEY_ID  that bucket's key as a full ARN, never an alias
  UNAI_RESTORE_S3_PREFIX      optional (<segment>/)* the objects are written under;
                              without it the whole bucket must be empty
  UNAI_RESTORE_PG_RESTORE     optional pg_restore path or JSON argv prefix of the
                              server's major version; default pg_restore

AWS credentials come only from the SDK default chain, for both buckets.

Output: {"event":"restore.completed","verdict":"PASS",...} on stdout, or
{"event":"restore.failed","code":"RESTORE_..."} on stderr.
Exit status: 0 PASS; 1 failure, for example RESTORE_TARGET_NOT_EMPTY or
RESTORE_ARCHIVE_INTEGRITY_FAILED; 2 RESTORE_ARGUMENTS_INVALID.
`;
const MAPPED={BACKUP_KEY_LOCATION_INVALID:'RESTORE_KEY_LOCATION_INVALID',BACKUP_KEY_INVALID:'RESTORE_KEY_INVALID',
  BACKUP_ARCHIVE_INTEGRITY_FAILED:'RESTORE_ARCHIVE_INTEGRITY_FAILED',BACKUP_ARCHIVE_UNREADABLE:'RESTORE_ARCHIVE_UNAVAILABLE',
  BACKUP_TABLE_DIGEST_FAILED:'RESTORE_DATABASE_FAILED',STORAGE_ENCRYPTION_REQUIRED:'RESTORE_TARGET_STORE_UNAVAILABLE',
  STORAGE_CONFIGURATION_INVALID:'RESTORE_TARGET_STORE_UNAVAILABLE',DATABASE_TLS_CONFIG_INVALID:'RESTORE_DATABASE_URL_INVALID'};
/** A sidecar is a few hundred bytes; a larger file is not one. */
const SIDECAR_BYTES=65536;
const HEX=/^[0-9a-f]{64}$/,UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,BUCKET=/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const S3_ARCHIVE=/^s3:\/\/([a-z0-9][a-z0-9.-]{1,61}[a-z0-9])\/((?:[A-Za-z0-9._-]+\/)*)([^/]*)$/;
class Refusal extends Error{constructor(code,variable){super(code);this.variable=variable;}}
const refuse=(code,variable)=>new Refusal(code,variable);
const invalid=variable=>refuse('RESTORE_CONFIGURATION_INVALID',variable);
const own=error=>error instanceof Error&&/^RESTORE_[A-Z_]+$/.test(error.message);
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const entryName=(prefix,index)=>prefix+String(index).padStart(6,'0');
const count=value=>Number.isSafeInteger(value)&&value>=0;
const nonEmpty=value=>typeof value==='string'&&value!=='';
const record=value=>typeof value==='object'&&value!==null&&!Array.isArray(value);
const s3Sdk=()=>createRequire(new URL('../packages/storage/package.json',import.meta.url))('@aws-sdk/client-s3');
// pg prints a deprecation notice when it reads the pgpass file (ADR 0043 D9);
// nothing but the one JSON line may reach the output.
process.noDeprecation=true;

let printed=false;
const print=(stream,line)=>new Promise(done=>{
  if(printed)return done();
  printed=true;stream.write(JSON.stringify(line)+'\n',()=>done());
});
function failure(error){
  if(own(error))return error.variable?{event:'restore.failed',code:error.message,variable:error.variable}:{event:'restore.failed',code:error.message};
  return {event:'restore.failed',code:error instanceof Error&&Object.hasOwn(MAPPED,error.message)?MAPPED[error.message]:'RESTORE_FAILED'};
}
/** Nothing, or `--help` alone: no flag changes what a restore checks. */
function parseArguments(argv){
  if(!argv.length)return {help:false};
  if(argv.length===1&&argv[0]==='--help')return {help:true};
  throw refuse('RESTORE_ARGUMENTS_INVALID');
}

const need=(name,value)=>{if(value===undefined||!value.trim())throw refuse('RESTORE_CONFIGURATION_REQUIRED',name);return value;};
/** (<segment>/)* of [A-Za-z0-9._-], at most 512 bytes, with no . or .. segment. */
const prefixOk=prefix=>/^(?:[A-Za-z0-9._-]+\/)*$/.test(prefix)&&Buffer.byteLength(prefix)<=512&&!prefix.split('/').some(segment=>segment==='.'||segment==='..');
function endpointOf(name,value){
  let url=null;
  try{url=new URL(need(name,value));}catch(error){if(own(error))throw error;}
  if(url?.protocol!=='https:'||url.username||url.password||url.search||url.hash)throw invalid(name);
  return url.href;
}
/** s3://<bucket>/(<segment>/)*[<archive name>], an absolute archive path, or an absolute directory ending in a
 * separator. A local directory must exist (RESTORE_ARCHIVE_NOT_FOUND); its realpath is the one ever read. */
async function archiveOf(given){
  if(/^s3:\/\//i.test(given)){
    const [,bucket,prefix,name]=S3_ARCHIVE.exec(given)??[];
    if(bucket===undefined||!prefixOk(prefix)||(name&&!ARCHIVE_NAME.test(name)))throw invalid('UNAI_RESTORE_ARCHIVE');
    return {s3:{bucket,prefix},name:name||null};
  }
  const folder=given.endsWith('/')||given.endsWith(sep);
  if(!isAbsolute(given)||(!folder&&!ARCHIVE_NAME.test(basename(given))))throw invalid('UNAI_RESTORE_ARCHIVE');
  const named=folder?given:dirname(given);
  const directory=await realpath(named).then(async real=>(await stat(real)).isDirectory()?real:null).catch(()=>null);
  if(!directory)throw refuse('RESTORE_ARCHIVE_NOT_FOUND');
  return {s3:null,given:named,directory,name:folder?null:basename(given)};
}
/** Empty at the start, so cleanup() only ever removes files this run staged; leftovers are refused, never cleaned. */
async function stagingOf(value){
  try{
    if(!isAbsolute(value))throw new Error();
    const real=await realpath(value);
    if(!(await stat(real)).isDirectory()||(await readdir(real)).length)throw new Error();
    await access(real,constants.W_OK);
    return real;
  }catch{throw invalid('UNAI_RESTORE_STAGING_DIR');}
}
/** A password-less URL of one database whose decoded name libpq cannot mistake for a connection string. */
function databaseUrlOf(value){
  const fail=()=>refuse('RESTORE_DATABASE_URL_INVALID');
  let url,database;
  try{url=new URL(value);database=decodeURIComponent(url.pathname.slice(1));decodeURIComponent(url.username);}catch{throw fail();}
  if(!['postgres:','postgresql:'].includes(url.protocol)||!url.hostname||!url.username||url.password||/^[^/]*\/\/[^/@]*:[^/@]*@/.test(value)
    ||value.includes('?')||value.includes('#')||!/^\/[^/]+$/.test(url.pathname)||!/^[A-Za-z0-9_][A-Za-z0-9_$.-]{0,62}$/.test(database))throw fail();
  return {url,database};
}
function pgRestoreOf(value){
  if(value===undefined||value==='')return ['pg_restore'];
  let prefix=[value];
  if(value.trimStart().startsWith('['))try{prefix=JSON.parse(value);}catch{prefix=null;}
  if(!Array.isArray(prefix)||!prefix.length||prefix.some(part=>typeof part!=='string'||!part))throw invalid('UNAI_RESTORE_PG_RESTORE');
  return prefix;
}
/** The target evidence bucket: never the archive's bucket, and a key ARN the receipts echo, never an alias. */
function targetOf(archive){
  const endpoint=endpointOf('UNAI_RESTORE_S3_ENDPOINT',process.env.UNAI_RESTORE_S3_ENDPOINT);
  const region=need('UNAI_RESTORE_S3_REGION',process.env.UNAI_RESTORE_S3_REGION);
  const bucket=need('UNAI_RESTORE_S3_BUCKET',process.env.UNAI_RESTORE_S3_BUCKET);
  if(!BUCKET.test(bucket)||bucket===archive.s3?.bucket)throw invalid('UNAI_RESTORE_S3_BUCKET');
  const kmsKeyId=need('UNAI_RESTORE_S3_KMS_KEY_ID',process.env.UNAI_RESTORE_S3_KMS_KEY_ID);
  if(!kmsKeyId.startsWith('arn:')||kmsKeyId.includes(':alias/'))throw invalid('UNAI_RESTORE_S3_KMS_KEY_ID');
  const prefix=process.env.UNAI_RESTORE_S3_PREFIX??'';
  if(!prefixOk(prefix))throw invalid('UNAI_RESTORE_S3_PREFIX');
  return {endpoint,region,bucket,kmsKeyId,prefix};
}
/** Every variable, in the documented order, before any network or database work. */
async function configuration(state){
  const archive=await archiveOf(need('UNAI_RESTORE_ARCHIVE',process.env.UNAI_RESTORE_ARCHIVE));
  let outside=[archive.given,archive.directory];
  if(archive.s3){
    const staging=need('UNAI_RESTORE_STAGING_DIR',process.env.UNAI_RESTORE_STAGING_DIR);
    archive.directory=await stagingOf(staging);outside=[staging,archive.directory];
    archive.s3.endpoint=endpointOf('UNAI_RESTORE_ARCHIVE_S3_ENDPOINT',process.env.UNAI_RESTORE_ARCHIVE_S3_ENDPOINT);
    archive.s3.region=need('UNAI_RESTORE_ARCHIVE_S3_REGION',process.env.UNAI_RESTORE_ARCHIVE_S3_REGION);
  }
  state.key=await readBackupKey(need('UNAI_RESTORE_KEY_FILE',process.env.UNAI_RESTORE_KEY_FILE),{outside});
  const {url,database}=databaseUrlOf(need('UNAI_RESTORE_DATABASE_URL',process.env.UNAI_RESTORE_DATABASE_URL));
  if(process.env.PGPASSWORD!==undefined)throw invalid('PGPASSWORD');
  const caFile=resolve(need('UNAI_DATABASE_CA_FILE',process.env.UNAI_DATABASE_CA_FILE));
  const ca=await readFile(caFile,'utf8').catch(()=>'');
  if(!ca.trim())throw invalid('UNAI_DATABASE_CA_FILE');
  const target=targetOf(archive);
  return {archive,url,database,caFile,ca,target,pgRestore:pgRestoreOf(process.env.UNAI_RESTORE_PG_RESTORE)};
}

const regular=async path=>(await lstat(path).catch(()=>null))?.isFile()===true;
/** The named archive, or the newest name in the directory that is a regular file with both sidecars as regular files. */
async function localArchive(archive){
  if(archive.name){
    const path=join(archive.directory,archive.name);
    if(!(await regular(path)))throw refuse('RESTORE_ARCHIVE_NOT_FOUND');
    if(!(await regular(path+'.sha256'))||!(await regular(path+'.manifest.json')))throw refuse('RESTORE_ARCHIVE_INCOMPLETE');
    return {name:archive.name,path};
  }
  const names=await readdir(archive.directory).catch(()=>{throw refuse('RESTORE_ARCHIVE_UNAVAILABLE');});
  for(const name of names.filter(candidate=>ARCHIVE_NAME.test(candidate)).sort().reverse()){
    const path=join(archive.directory,name);
    if(await regular(path)&&await regular(path+'.sha256')&&await regular(path+'.manifest.json'))return {name,path};
  }
  throw refuse('RESTORE_ARCHIVE_NOT_FOUND');
}
const clientOf=(sdk,endpoint,region)=>new sdk.S3Client({endpoint,region,forcePathStyle:true,maxAttempts:3,
  requestHandler:{connectionTimeout:5000,requestTimeout:30000}});
/** Every key under `prefix`, page by page, filtered here as well (a server may ignore Prefix); `enough` stops early. */
async function keysUnder(client,sdk,bucket,prefix,enough=()=>false){
  const keys=[];
  for(let token;;){
    const listed=await client.send(new sdk.ListObjectsV2Command({Bucket:bucket,Prefix:prefix,...token?{ContinuationToken:token}:{}}));
    for(const {Key} of listed.Contents??[])if(typeof Key==='string'&&Key.startsWith(prefix))keys.push(Key);
    if(!listed.IsTruncated||enough(keys))return keys;
    token=listed.NextContinuationToken;
    if(!token)throw new Error();
  }
}
/** s3://: one listing picks the name (a nested prefix never counts), then the .sha256, the .manifest.json and the
 * archive are staged, each recorded in state.staged before its first byte so that cleanup() empties the directory. */
async function s3Archive(archive,state){
  const sdk=s3Sdk(),{bucket,prefix,endpoint,region}=archive.s3;
  const client=state.archiveClient=clientOf(sdk,endpoint,region);
  try{
    const names=new Set((await keysUnder(client,sdk,bucket,prefix)).map(key=>key.slice(prefix.length)).filter(name=>!name.includes('/')));
    const complete=name=>names.has(name+'.sha256')&&names.has(name+'.manifest.json');
    let name=archive.name;
    if(name&&!names.has(name))throw refuse('RESTORE_ARCHIVE_NOT_FOUND');
    if(name&&!complete(name))throw refuse('RESTORE_ARCHIVE_INCOMPLETE');
    name??=[...names].filter(candidate=>ARCHIVE_NAME.test(candidate)&&complete(candidate)).sort().pop();
    if(!name)throw refuse('RESTORE_ARCHIVE_NOT_FOUND');
    for(const [file,limit] of [[name+'.sha256',SIDECAR_BYTES],[name+'.manifest.json',SIDECAR_BYTES],[name,Infinity]]){
      const object=await client.send(new sdk.GetObjectCommand({Bucket:bucket,Key:prefix+file}));
      if(!Number.isSafeInteger(object.ContentLength)||object.ContentLength>limit){object.Body?.destroy?.();throw refuse('RESTORE_ARCHIVE_INTEGRITY_FAILED');}
      const path=join(archive.directory,file);
      state.staged.push(path);
      await pipeline(object.Body,createWriteStream(path,{flags:'wx',mode:0o600}));
    }
    return {name,path:join(archive.directory,name)};
  }catch(error){throw own(error)?error:refuse('RESTORE_ARCHIVE_UNAVAILABLE');}
}

/** Pass 1: both sidecars agree with the file as `pnpm backup` writes them, then the whole archive authenticates under
 * the key while each entry's name, size and digest are recorded. Nothing is applied, and every buffer is zeroed. */
async function authenticate(found,key){
  const integrity=()=>refuse('RESTORE_ARCHIVE_INTEGRITY_FAILED');
  const sidecar=async suffix=>{
    const info=await lstat(found.path+suffix).catch(()=>null);
    if(!info?.isFile()||info.size>SIDECAR_BYTES)throw integrity();
    return readFile(found.path+suffix,'utf8').catch(()=>{throw integrity();});
  };
  const line=await sidecar('.sha256'),hex=line.slice(0,64);
  if(!HEX.test(hex)||line!==hex+'  '+found.name+'\n')throw integrity();
  let facts=null;
  try{facts=JSON.parse(await sidecar('.manifest.json'));}catch{}
  const bytes=(await lstat(found.path).catch(()=>{throw integrity();})).size;
  if(!record(facts)||facts.format!=='uai-backup/1'||facts.archive!==found.name||facts.sha256!==hex||facts.bytes!==bytes)throw integrity();
  const entries=[];let inner=null,head=null;
  const read=await readArchive(found.path,key,entry=>{
    if(!entries.length&&entry.name==='manifest.json')inner=Buffer.from(entry.bytes);
    if(entry.name==='database.dump.000000')head=entry.bytes.subarray(0,5).toString('latin1');
    entries.push({name:entry.name,size:entry.size,sha256:sha256(entry.bytes)});
    entry.bytes.fill(0);
  });
  if(read.sha256!==hex||read.entries.length!==entries.length)throw integrity();
  return {sha256:hex,bytes,entries,inner,head};
}
/** The authenticated inner manifest, consistent with the entry list: manifest.json, database.dump.000000 onward (a
 * custom-format dump), then one entry per live object, in order, with the digest the manifest states. */
function manifestOf(pass){
  const fail=()=>refuse('RESTORE_MANIFEST_INVALID');
  let m=null;
  try{m=JSON.parse(pass.inner.toString('utf8'));}catch{}
  if(!record(m)||m.format!=='uai-backup/1'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(m.createdAt)||!count(m.serverVersionNum)
    ||!count(m.pgDumpMajor)||!record(m.migrations)||!nonEmpty(m.migrations.head)||!count(m.migrations.count)||m.migrations.count<1
    ||!Array.isArray(m.registryReleases)||!m.registryReleases.every(release=>record(release)&&[release.id,release.semanticVersion,release.contentHash].every(nonEmpty))
    ||!Array.isArray(m.tables)||!m.tables.length||!m.tables.every(table=>record(table)&&nonEmpty(table.table)&&HEX.test(table.digest)&&count(table.rows))
    ||!record(m.evidence)||!count(m.evidence.live)||!count(m.evidence.deleted)||!Array.isArray(m.objects)||m.objects.length!==m.evidence.live)throw fail();
  let dumpParts=0;
  while(pass.entries[1+dumpParts]?.name===entryName('database.dump.',dumpParts))dumpParts++;
  if(pass.entries[0]?.name!=='manifest.json'||!dumpParts||pass.head!=='PGDMP'||pass.entries.length!==1+dumpParts+m.objects.length)throw fail();
  const ids=new Set(),keys=new Set();
  m.objects.forEach((object,index)=>{
    const entry=pass.entries[1+dumpParts+index];
    if(!record(object)||object.entry!==entryName('objects/',index)||entry.name!==object.entry||!UUID.test(object.evidenceObjectKeyId)
      ||!UUID.test(object.ownerScopeId)||!nonEmpty(object.key)||Buffer.byteLength(object.key)>1024||object.key===object.evidenceObjectKeyId
      ||!HEX.test(object.sha256)||entry.sha256!==object.sha256||ids.has(object.evidenceObjectKeyId)||keys.has(object.key))throw fail();
    ids.add(object.evidenceObjectKeyId);keys.add(object.key);
  });
  return {manifest:m,dumpParts};
}

async function rows(client,sql,values){
  try{return (await client.query(sql,values)).rows;}catch{throw refuse('RESTORE_DATABASE_FAILED');}
}
/** pg_restore's environment: no inherited PG* setting but PGPASSFILE, and verify-full TLS to the target database. */
function restoreEnvironment(config){
  const inherited=Object.entries(process.env).filter(([name])=>!/^PG/i.test(name)||name==='PGPASSFILE');
  return {...Object.fromEntries(inherited),PGHOST:config.url.hostname.replace(/^\[|\]$/g,''),PGPORT:config.url.port||'5432',
    PGUSER:decodeURIComponent(config.url.username),PGDATABASE:config.database,PGSSLMODE:'verify-full',PGSSLROOTCERT:config.caFile,
    PGCONNECT_TIMEOUT:'10',PGAPPNAME:'unai-restore'};
}
function pgRestoreMajor(config,major){
  const [command,...prefix]=config.pgRestore;
  const probe=spawnSync(command,[...prefix,'--version'],{env:restoreEnvironment(config),encoding:'utf8',stdio:['ignore','pipe','ignore'],timeout:120000});
  if(probe.error||probe.status!==0)throw refuse('RESTORE_PG_RESTORE_UNAVAILABLE');
  if(Number(/\(PostgreSQL\) (\d+)/.exec(probe.stdout)?.[1])!==major)throw refuse('RESTORE_PG_RESTORE_VERSION_MISMATCH');
}
/** A superuser on the manifest's server major takes the per-database restore lock, then finds no schema besides
 * public and no relation in public. Nothing is written. */
async function openTarget(config,manifest,state,createDatabasePool){
  state.pool=createDatabasePool(config.url.href,config.ca);
  state.pool.on('error',()=>{});
  try{state.client=await state.pool.connect();}catch{throw refuse('RESTORE_DATABASE_FAILED');}
  state.client.on('error',()=>{});
  const [role]=await rows(state.client,'SELECT rolsuper FROM pg_roles WHERE rolname=current_user');
  if(role?.rolsuper!==true)throw refuse('RESTORE_DATABASE_ROLE_INVALID');
  const [server]=await rows(state.client,"SELECT current_setting('server_version_num')::int AS version");
  const major=Math.floor(server.version/10000);
  if(major!==Math.floor(manifest.serverVersionNum/10000))throw refuse('RESTORE_SERVER_VERSION_MISMATCH');
  pgRestoreMajor(config,major);
  const [lock]=await rows(state.client,"SELECT pg_try_advisory_lock(hashtextextended('uai-restore',0)) AS locked");
  if(lock?.locked!==true)throw refuse('RESTORE_TARGET_BUSY');
  const [held]=await rows(state.client,`SELECT (SELECT count(*) FROM pg_namespace WHERE nspname NOT IN ('public','information_schema')
    AND nspname !~ '^pg_')::int AS schemas,(SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public')::int AS relations`);
  if(held?.schemas!==0||held.relations!==0)throw refuse('RESTORE_TARGET_NOT_EMPTY');
}
/** The adapter first checks that the bucket's encryption rule names the key; then any key under the prefix refuses it. */
async function openStore(target,objectKeys,state,createEncryptedS3Store){
  state.store=await createEncryptedS3Store({endpoint:target.endpoint,region:target.region,bucket:target.bucket,kmsKeyId:target.kmsKeyId},
    async(_context,id)=>objectKeys.get(id)??null).catch(()=>{throw refuse('RESTORE_TARGET_STORE_UNAVAILABLE');});
  const sdk=s3Sdk();
  state.targetClient=clientOf(sdk,target.endpoint,target.region);
  const keys=await keysUnder(state.targetClient,sdk,target.bucket,target.prefix,found=>found.length>0)
    .catch(()=>{throw refuse('RESTORE_TARGET_STORE_UNAVAILABLE');});
  if(keys.length)throw refuse('RESTORE_TARGET_NOT_EMPTY');
  return state.store;
}

/** The apply pass. Each entry is used only when it matches its pass-1 record. Dump parts stream into one pg_restore
 * --single-transaction that must exit 0 before the first object; objects go through the adapter's put. */
async function apply(found,pass,plan,config,store,state){
  const child=spawn(config.pgRestore[0],[...config.pgRestore.slice(1),'--exit-on-error','--single-transaction','--no-password','--dbname='+config.database],
    {env:restoreEnvironment(config),stdio:['pipe','ignore','ignore']});
  state.child=child;child.stdin.on('error',()=>{});
  const exited=new Promise(done=>{child.once('error',()=>done(null));child.once('close',code=>done(code));});
  const write=bytes=>new Promise((done,fail)=>child.stdin.write(bytes,error=>error?fail(refuse('RESTORE_DATABASE_APPLY_FAILED')):done()));
  let index=0,open=true;
  const finish=async()=>{open=false;child.stdin.end();const code=await exited;state.child=null;if(code!==0)throw refuse('RESTORE_DATABASE_APPLY_FAILED');};
  const objects=new Map(plan.manifest.objects.map(object=>[object.entry,object])),run=randomUUID();
  try{
    const read=await readArchive(found.path,state.key,async entry=>{
      try{
        const expected=pass.entries[index++];
        if(entry.name!==expected?.name||entry.size!==expected.size||sha256(entry.bytes)!==expected.sha256)throw refuse('RESTORE_ARCHIVE_INTEGRITY_FAILED');
        if(entry.name.startsWith('database.dump.'))return await write(entry.bytes);
        const object=objects.get(entry.name);
        if(!object)return;
        if(open)await finish();
        await store.put({actorId:run,ownerScopeId:object.ownerScopeId,purpose:'operations.restore',correlationId:run},object.evidenceObjectKeyId,entry.bytes)
          .catch(()=>{throw refuse('RESTORE_OBJECT_WRITE_FAILED');});
      }finally{entry.bytes.fill(0);}
    });
    if(open)await finish();
    if(read.sha256!==pass.sha256||index!==pass.entries.length)throw refuse('RESTORE_ARCHIVE_INTEGRITY_FAILED');
  }catch(error){
    if(own(error))throw error;
    throw refuse(error instanceof Error&&error.message==='BACKUP_ARCHIVE_UNREADABLE'?'RESTORE_ARCHIVE_UNAVAILABLE':'RESTORE_ARCHIVE_INTEGRITY_FAILED');
  }
}
/** The verify pass: one REPEATABLE READ snapshot of the restored tables, ledger and releases, then every object read
 * back through the adapter (whose receipt check names the key) and hash-checked. */
async function verify(manifest,store,client){
  await rows(client,'BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY');
  for(const setting of ['row_security = off','statement_timeout = 0'])await rows(client,'SET LOCAL '+setting);
  const tables=await tableDigests(client);
  if(JSON.stringify(tables)!==JSON.stringify(manifest.tables))throw refuse('RESTORE_TABLE_DIGEST_MISMATCH');
  const [ledger]=await rows(client,'SELECT max(name) AS head,count(*)::int AS count FROM unai_migrations.applied');
  if(ledger?.head!==manifest.migrations.head||ledger.count!==manifest.migrations.count)throw refuse('RESTORE_MIGRATION_LEDGER_MISMATCH');
  const releases=(await rows(client,"SELECT id,semantic_version,content_hash FROM registry_releases ORDER BY string_to_array(semantic_version,'.')::int[]"))
    .map(row=>({id:row.id,semanticVersion:row.semantic_version,contentHash:row.content_hash}));
  if(JSON.stringify(releases)!==JSON.stringify(manifest.registryReleases))throw refuse('RESTORE_REGISTRY_RELEASE_MISMATCH');
  await rows(client,'COMMIT');
  const run=randomUUID();let objects=0;
  for(const object of manifest.objects){
    const bytes=await store.get({actorId:run,ownerScopeId:object.ownerScopeId,purpose:'operations.restore',correlationId:run},object.evidenceObjectKeyId)
      .catch(()=>{throw refuse('RESTORE_OBJECT_UNREADABLE');});
    const matches=sha256(bytes)===object.sha256;
    bytes.fill(0);
    if(!matches)throw refuse('RESTORE_OBJECT_MISMATCH');
    objects++;
  }
  return {tables:tables.length,objects};
}

async function restore(state){
  const started=Date.now(),config=await configuration(state);
  const found=config.archive.s3?await s3Archive(config.archive,state):await localArchive(config.archive);
  const pass=await authenticate(found,state.key);
  const plan=manifestOf(pass),{manifest}=plan,{prefix}=config.target;
  if(manifest.objects.some(object=>Buffer.byteLength(prefix+object.key)>1024))throw invalid('UNAI_RESTORE_S3_PREFIX');
  (await import('tsx/esm/api')).register();
  const {createDatabasePool}=await import('../packages/postgres/src/index.ts');
  const {createEncryptedS3Store}=await import('../packages/storage/src/index.ts');
  await openTarget(config,manifest,state,createDatabasePool);
  const objectKeys=new Map(manifest.objects.map(object=>[object.evidenceObjectKeyId,prefix+object.key]));
  const store=await openStore(config.target,objectKeys,state,createEncryptedS3Store);
  await apply(found,pass,plan,config,store,state);
  const verified=await verify(manifest,store,state.client);
  await cleanup(state);
  return {event:'restore.completed',verdict:'PASS',format:'uai-backup/1',archive:found.name,createdAt:manifest.createdAt,sha256:pass.sha256,
    bytes:pass.bytes,tables:manifest.tables.length,tablesVerified:verified.tables,rows:manifest.tables.reduce((sum,table)=>sum+table.rows,0),
    objects:manifest.objects.length,objectsVerified:verified.objects,deletedObjects:manifest.evidence.deleted,dumpParts:plan.dumpParts,
    migrationHead:manifest.migrations.head,migrations:manifest.migrations.count,
    registryReleases:manifest.registryReleases.map(release=>release.semanticVersion),durationMs:Date.now()-started};
}
/** Every exit path: stop pg_restore (its open transaction rolls back), close both S3 clients, the store and the
 * database (which releases the restore lock), remove every staged file, zero the key. */
async function cleanup(state){
  state.child?.kill('SIGKILL');state.child=null;
  state.archiveClient?.destroy();state.archiveClient=null;
  state.targetClient?.destroy();state.targetClient=null;
  state.store?.close();state.store=null;
  state.client?.release(true);state.client=null;
  await state.pool?.end().catch(()=>{});state.pool=null;
  for(const path of state.staged)await rm(path,{force:true}).catch(()=>{});
  state.staged=[];
  state.key?.fill(0);
}

const state={key:null,child:null,store:null,pool:null,client:null,archiveClient:null,targetClient:null,staged:[]};
let stopping=false;
async function stop(error,status=1){
  if(stopping)return;
  stopping=true;
  await cleanup(state).catch(()=>{});
  await print(process.stderr,failure(error));
  process.exit(status);
}
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>stop(refuse('RESTORE_INTERRUPTED')));
process.on('uncaughtException',error=>stop(error));
process.on('unhandledRejection',error=>stop(error));
let options;
try{options=parseArguments(process.argv.slice(2));}catch(error){await stop(error,2);}
if(options.help)process.stdout.write(USAGE,()=>process.exit(0));
else try{
  const summary=await restore(state);
  if(!stopping){await print(process.stdout,summary);process.exit(0);}
}catch(error){await stop(error);}
