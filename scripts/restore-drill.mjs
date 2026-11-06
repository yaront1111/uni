/**
 * `pnpm restore:drill`: the restore drill of ADR 0043 D9 (docs/operations/restore.md). One run draws a random 16-hex
 * <id>, creates the database unai_restore_drill_<id> on the drill server as its superuser, runs `pnpm restore`
 * (scripts/restore.mjs, unchanged) as a child into that database and the fresh prefix restore-drill-<id>/ of the drill
 * bucket, then runs the recovery-acceptance read probes (scripts/recovery-acceptance.mjs) through the temporary unai_app
 * login unai_restore_drill_probe_<id>. Teardown drops that login on every exit and, without --keep, the database and the
 * prefix's objects. It creates and removes nothing it did not name with its own <id>, never reads the key file or the
 * evidence bucket's variables, and prints exactly one JSON line, stdout on success and stderr on failure, never an error
 * message, URL, path, key, bucket, ARN, password, owner id or question.
 */
import {spawn} from 'node:child_process';
import {createHash,createHmac,pbkdf2Sync,randomBytes} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {probeEnvironment} from './recovery-acceptance.mjs';

const USAGE=`Usage: pnpm restore:drill
       pnpm restore:drill --keep
       pnpm restore:drill --help

Restores the archive UNAI_RESTORE_ARCHIVE names with pnpm restore into a database
and a bucket prefix that exist for this run only, then reads the restored memory
of every live owner member and data purpose through the product read path (Ask,
Today, the persisted packet, Why) as a temporary unai_app login, with the clock
frozen at the archive's createdAt. Each run draws a random 16-hex <id>:

  database  unai_restore_drill_<id>, created by this run on the drill server
  prefix    restore-drill-<id>/ in the drill bucket, empty when the run starts
  login     unai_restore_drill_probe_<id>: unai_app only, valid for one day

The login is dropped on every exit. The database and the prefix's objects are
removed after the verdict unless --keep. pnpm restore still refuses any target
that is not empty.

  --keep  keep the database and the prefix (the login is still dropped)
  --help  print this text and exit 0

Variables:
  UNAI_RESTORE_DRILL_SERVER_URL  postgres URL of a superuser and an existing
                                 database on the drill server, without a password
  PGPASSFILE                     libpq password file for that role, database
                                 field *; PGPASSWORD is refused
  UNAI_DATABASE_CA_FILE          CA that verifies the server certificate
  UNAI_RESTORE_S3_ENDPOINT, UNAI_RESTORE_S3_REGION, UNAI_RESTORE_S3_BUCKET
                                 the drill bucket
  UNAI_RESTORE_ARCHIVE and every other pnpm restore variable reach the child
  unchanged. The drill sets UNAI_RESTORE_DATABASE_URL and UNAI_RESTORE_S3_PREFIX
  itself and refuses to start when either is set.

AWS credentials come only from the SDK default chain.

Output: {"event":"restore.drill.completed","verdict":"PASS",...} on stdout, or
{"event":"restore.drill.failed","code":"RESTORE_..."} on stderr; a failure of
pnpm restore keeps its code and adds "stage":"restore".
Exit status: 0 PASS; 1 failure; 2 RESTORE_DRILL_ARGUMENTS_INVALID.
`;
const RESTORE=fileURLToPath(new URL('./restore.mjs',import.meta.url));
/** restore.mjs prints one short line; more than this is not its output. */
const OUTPUT_BYTES=65536;
const BARE_CODE=/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/,VARIABLE=/^[A-Z][A-Z0-9_]{0,63}$/;
class Refusal extends Error{constructor(code,details={}){super(code);this.details=details;}}
const refuse=(code,details)=>new Refusal(code,details);
const invalid=variable=>refuse('RESTORE_DRILL_CONFIGURATION_INVALID',{variable});
const s3Sdk=()=>createRequire(new URL('../packages/storage/package.json',import.meta.url))('@aws-sdk/client-s3');
// Nothing but the one JSON line, written to the streams directly, may reach the output: pg prints a deprecation notice
// when it reads the pgpass file, and the product read path logs a pipeline.stage line, with its owner scope id, per stage.
process.noDeprecation=true;
for(const method of ['debug','info','log','warn','error'])console[method]=()=>{};

let printed=false;
const print=(stream,line)=>new Promise(done=>{
  if(printed)return done();
  printed=true;stream.write(JSON.stringify(line)+'\n',()=>done());
});
function failure(error,state){
  const line={event:'restore.drill.failed',code:error instanceof Refusal?error.message:'RESTORE_DRILL_FAILED'};
  if(error instanceof Refusal)Object.assign(line,error.details);
  if(state.id)line.drill=state.id;
  const kept=remaining(state);
  if(kept)line.kept=kept;
  return line;
}
/** What this run made and has not removed (--keep, or a removal that failed), or null. */
function remaining(state){
  const left=Object.entries({database:state.database,prefix:state.prefix,role:state.role}).filter(([,name])=>name);
  return left.length?Object.fromEntries(left):null;
}
/** Nothing, `--keep` or `--help`, each alone: no flag changes what the restore checks. */
function parseArguments(argv){
  if(!argv.length)return {help:false,keep:false};
  if(argv.length===1&&argv[0]==='--help')return {help:true,keep:false};
  if(argv.length===1&&argv[0]==='--keep')return {help:false,keep:true};
  throw refuse('RESTORE_DRILL_ARGUMENTS_INVALID');
}

const need=(name,value)=>{if(value===undefined||!value.trim())throw refuse('RESTORE_DRILL_CONFIGURATION_REQUIRED',{variable:name});return value;};
/** restore.mjs's grammar: a password-less URL of one existing database whose name libpq cannot misread. */
function serverUrlOf(value){
  const fail=()=>refuse('RESTORE_DRILL_DATABASE_URL_INVALID');
  let url,database;
  try{url=new URL(value);database=decodeURIComponent(url.pathname.slice(1));decodeURIComponent(url.username);}catch{throw fail();}
  if(!['postgres:','postgresql:'].includes(url.protocol)||!url.hostname||!url.username||url.password||/^[^/]*\/\/[^/@]*:[^/@]*@/.test(value)
    ||value.includes('?')||value.includes('#')||!/^\/[^/]+$/.test(url.pathname)||!/^[A-Za-z0-9_][A-Za-z0-9_$.-]{0,62}$/.test(database))throw fail();
  return url;
}
function endpointOf(name,value){
  let url=null;
  try{url=new URL(need(name,value));}catch(error){if(error instanceof Refusal)throw error;}
  if(url?.protocol!=='https:'||url.username||url.password||url.search||url.hash)throw invalid(name);
  return url.href;
}
/** Every variable the drill itself reads, before any network or database work; restore.mjs checks the rest. */
async function configuration(){
  if(process.env.UNAI_RESTORE_DATABASE_URL!==undefined)throw invalid('UNAI_RESTORE_DATABASE_URL');
  if(process.env.UNAI_RESTORE_S3_PREFIX!==undefined)throw invalid('UNAI_RESTORE_S3_PREFIX');
  const server=serverUrlOf(need('UNAI_RESTORE_DRILL_SERVER_URL',process.env.UNAI_RESTORE_DRILL_SERVER_URL));
  if(process.env.PGPASSWORD!==undefined)throw invalid('PGPASSWORD');
  const ca=await readFile(resolve(need('UNAI_DATABASE_CA_FILE',process.env.UNAI_DATABASE_CA_FILE)),'utf8').catch(()=>'');
  if(!ca.trim())throw invalid('UNAI_DATABASE_CA_FILE');
  const endpoint=endpointOf('UNAI_RESTORE_S3_ENDPOINT',process.env.UNAI_RESTORE_S3_ENDPOINT);
  const region=need('UNAI_RESTORE_S3_REGION',process.env.UNAI_RESTORE_S3_REGION);
  const bucket=need('UNAI_RESTORE_S3_BUCKET',process.env.UNAI_RESTORE_S3_BUCKET);
  return {server,ca,store:{endpoint,region,bucket}};
}

async function rows(pool,sql){
  try{return (await pool.query(sql)).rows;}catch{throw refuse('RESTORE_DRILL_DATABASE_FAILED');}
}
/** Every name is built from the hex <id> alone, and still quoted as an identifier. */
const quoted=name=>'"'+name+'"';
const scratchUrl=(config,state)=>{const url=new URL(config.server.href);url.pathname='/'+state.database;return url;};
/** One CREATE of a name drawn with this run's <id>. The name is recorded before the statement, so a stop during it still
 * removes what it made, and cleared when the statement fails, so a name that already existed is never removed. */
function create(state,field,name,sql){
  state[field]=name;
  state.creating=state.server.query(sql).then(()=>{},()=>{state[field]=null;throw refuse('RESTORE_DRILL_DATABASE_FAILED');});
  return state.creating;
}
/** A superuser creates the run's database from template0, so nothing a template carries can make it non-empty. */
async function createScratch(config,state,createDatabasePool){
  state.server=createDatabasePool(config.server.href,config.ca);
  state.server.on('error',()=>{});
  const [role]=await rows(state.server,'SELECT rolsuper FROM pg_roles WHERE rolname=current_user');
  if(role?.rolsuper!==true)throw refuse('RESTORE_DRILL_ROLE_INVALID');
  const database='unai_restore_drill_'+state.id;
  await create(state,'database',database,'CREATE DATABASE '+quoted(database)+' TEMPLATE template0');
}
/** At most OUTPUT_BYTES of a stream, or null when it said more. */
function captured(stream){
  const chunks=[];let size=0;
  stream.on('data',chunk=>{size+=chunk.length;if(size<=OUTPUT_BYTES)chunks.push(chunk);});
  return ()=>size<=OUTPUT_BYTES?Buffer.concat(chunks).toString('utf8'):null;
}
/** pnpm restore into the run's database and prefix; every other variable reaches it unchanged. */
function runRestore(config,state){
  state.prefix='restore-drill-'+state.id+'/';
  const child=spawn(process.execPath,[RESTORE],{stdio:['ignore','pipe','pipe'],
    env:{...process.env,UNAI_RESTORE_DATABASE_URL:scratchUrl(config,state).href,UNAI_RESTORE_S3_PREFIX:state.prefix}});
  state.child=child;
  const stdout=captured(child.stdout),stderr=captured(child.stderr);
  state.childClosed=new Promise(done=>{
    child.once('error',()=>done({status:null,stdout:null,stderr:null}));
    child.once('close',status=>done({status,stdout:stdout(),stderr:stderr()}));
  }).finally(()=>{state.child=null;});
  return state.childClosed;
}
function oneLine(text){
  const lines=(text??'').split('\n').filter(Boolean);
  if(lines.length!==1)return null;
  try{const value=JSON.parse(lines[0]);return typeof value==='object'&&value!==null&&!Array.isArray(value)?value:null;}catch{return null;}
}
/** PASS yields restore's summary without its event; a restore.failed line keeps its code at stage restore. */
function restoreVerdict(result){
  if(result.status===0){
    const line=oneLine(result.stdout);
    if(line?.event==='restore.completed'&&line.verdict==='PASS'&&typeof line.createdAt==='string'&&!Number.isNaN(Date.parse(line.createdAt))){
      const {event:_event,...restore}=line;
      return restore;
    }
  }else if(result.status===1||result.status===2){
    const line=oneLine(result.stderr);
    if(line?.event==='restore.failed'&&typeof line.code==='string'&&/^RESTORE_[A-Z_]+$/.test(line.code)){
      throw refuse(line.code,{...typeof line.variable==='string'&&VARIABLE.test(line.variable)?{variable:line.variable}:{},stage:'restore'});
    }
  }
  throw refuse('RESTORE_DRILL_RESTORE_OUTPUT_INVALID');
}

/** A SCRAM-SHA-256 verifier (RFC 7677, PostgreSQL's stored form): the server never receives the password itself. */
function scramVerifier(password){
  const salt=randomBytes(16),salted=pbkdf2Sync(password,salt,4096,32,'sha256');
  const hmac=text=>createHmac('sha256',salted).update(text).digest();
  const stored=createHash('sha256').update(hmac('Client Key')).digest();
  return 'SCRAM-SHA-256$4096:'+salt.toString('base64')+'$'+stored.toString('base64')+':'+hmac('Server Key').toString('base64');
}
/** withOwnerTransaction refuses a superuser session, so the probes read as a temporary unai_app login. */
async function createProbeLogin(state){
  const role='unai_restore_drill_probe_'+state.id,password=randomBytes(32).toString('hex');
  const until=new Date(Date.now()+86400000).toISOString();
  await create(state,'role',role,`CREATE ROLE ${quoted(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT
    CONNECTION LIMIT 4 VALID UNTIL '${until}' PASSWORD '${scramVerifier(password)}'`);
  await rows(state.server,'GRANT unai_app TO '+quoted(role));
  return password;
}
/** The probes over the restored database with the clock at the archive's createdAt; a probe that reads nothing fails. */
async function probe(config,state,restore,createDatabasePool){
  const password=await createProbeLogin(state),url=scratchUrl(config,state);
  state.admin=createDatabasePool(url.href,config.ca);state.admin.on('error',()=>{});
  url.username=state.role;url.password=password;
  state.app=createDatabasePool(url.href,config.ca);state.app.on('error',()=>{});
  let probes;
  try{probes=await probeEnvironment(state.admin,state.app,{now:new Date(restore.createdAt)});}
  catch(error){throw refuse('RESTORE_DRILL_PROBE_FAILED',error instanceof Error&&BARE_CODE.test(error.message)&&error.message.length<=64?{probeCode:error.message}:{});}
  if(probes.reads===0)throw refuse('RESTORE_DRILL_PROBES_EMPTY');
  return probes;
}

/** Every key under the run's prefix, all pages, filtered here as well (a server may ignore Prefix), then each deleted. */
async function removePrefix(store,prefix){
  const sdk=s3Sdk();
  const client=new sdk.S3Client({endpoint:store.endpoint,region:store.region,forcePathStyle:true,maxAttempts:3,
    requestHandler:{connectionTimeout:5000,requestTimeout:30000}});
  try{
    const keys=[];
    for(let token;;){
      const listed=await client.send(new sdk.ListObjectsV2Command({Bucket:store.bucket,Prefix:prefix,...token?{ContinuationToken:token}:{}}));
      for(const {Key} of listed.Contents??[])if(typeof Key==='string'&&Key.startsWith(prefix))keys.push(Key);
      if(!listed.IsTruncated)break;
      token=listed.NextContinuationToken;
      if(!token)throw new Error();
    }
    for(const key of keys)await client.send(new sdk.DeleteObjectCommand({Bucket:store.bucket,Key:key}));
  }finally{client.destroy();}
}
/** Pool.end() resolves before the server backends exit; wait (bounded: DROP DATABASE's FORCE ends any still there)
 * until no client backend is left on the database or as the login. */
async function quiesce(state){
  for(let attempt=0;attempt<200;attempt++){
    const [busy]=await state.server.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE backend_type='client backend'
      AND (datname=$1 OR usename=$2)`,[state.database,state.role]).then(result=>result.rows);
    if(busy?.n===0)return;
    await delay(25);
  }
}
/** Every exit path: the probe login always goes; the database and the prefix's objects go unless --keep. Returns
 * whether every removal it attempted succeeded. Only names drawn with this run's <id> are ever removed. */
async function cleanup(state){
  let clean=true;
  const attempt=work=>work().catch(()=>{clean=false;});
  state.child?.kill('SIGKILL');
  await state.creating?.catch(()=>{});
  for(const name of ['app','admin']){await state[name]?.end().catch(()=>{});state[name]=null;}
  if(state.server&&(state.database||state.role))await attempt(()=>quiesce(state));
  if(state.server&&state.database&&!state.keep)await attempt(async()=>{
    await state.server.query('DROP DATABASE IF EXISTS '+quoted(state.database)+' WITH (FORCE)');state.database=null;
  });
  if(state.server&&state.role)await attempt(async()=>{await state.server.query('DROP ROLE IF EXISTS '+quoted(state.role));state.role=null;});
  if(state.prefix&&!state.keep)await attempt(async()=>{await removePrefix(state.config.store,state.prefix);state.prefix=null;});
  await state.server?.end().catch(()=>{});state.server=null;
  return clean;
}

async function drill(state){
  const started=Date.now();
  state.config=await configuration();
  state.id=randomBytes(8).toString('hex');
  (await import('tsx/esm/api')).register();
  const {createDatabasePool}=await import('../packages/postgres/src/index.ts');
  await createScratch(state.config,state,createDatabasePool);
  const restore=restoreVerdict(await runRestore(state.config,state));
  const probes=await probe(state.config,state,restore,createDatabasePool);
  if(!(await cleanup(state)))throw refuse('RESTORE_DRILL_CLEANUP_FAILED');
  return {event:'restore.drill.completed',verdict:'PASS',drill:state.id,restore,probes,kept:remaining(state),durationMs:Date.now()-started};
}

const state={keep:false,config:null,id:null,server:null,admin:null,app:null,child:null,childClosed:null,creating:null,database:null,role:null,prefix:null};
let stopping=false;
/** A running restore child is asked to stop first (its own cleanup rolls back and closes), then the drill's cleanup. */
async function stop(error,status=1){
  if(stopping)return;
  stopping=true;
  if(state.child){state.child.kill('SIGTERM');await Promise.race([state.childClosed,delay(30000)]);}
  await cleanup(state).catch(()=>{});
  await print(process.stderr,failure(error,state));
  process.exit(status);
}
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>stop(refuse('RESTORE_DRILL_INTERRUPTED')));
process.on('uncaughtException',error=>stop(error));
process.on('unhandledRejection',error=>stop(error));
let options;
try{options=parseArguments(process.argv.slice(2));}catch(error){await stop(error,2);}
if(options.help)process.stdout.write(USAGE,()=>process.exit(0));
else try{
  state.keep=options.keep;
  const summary=await drill(state);
  if(!stopping){await print(process.stdout,summary);process.exit(0);}
}catch(error){await stop(error);}
