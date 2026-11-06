import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {spawn,spawnSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {existsSync,readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
// @ts-expect-error JavaScript harness helper.
import {POSTGRES_IMAGE,postgresRunArguments} from '../../scripts/postgres-harness.mjs';

if(!process.env.UNAI_TEST_DATABASE_URL)throw new Error('Run pnpm test for the required PostgreSQL harness');

/**
 * deploy/postgres (ADR 0043 D4) against the harness server. provision.sql runs
 * through real psql, twice, inside one transaction on a throwaway database that
 * is rolled back: roles are cluster-global and other test files share the
 * cluster, so nothing here commits a role, setting or extension.
 */
interface Pool{
  query(sql:string,values?:unknown[]):Promise<{rows:Record<string,unknown>[];rowCount:number|null}>;
  end():Promise<void>;
  on(event:'error',listener:()=>void):unknown;
}
interface Role{login:boolean;super:boolean;createdb:boolean;createrole:boolean;inherit:boolean;replication:boolean;bypassrls:boolean;connlimit:number;scram:boolean}
type Membership=[string,string,boolean,boolean,boolean];
interface Snapshot{roles:Record<string,Role>;members:Membership[];owner:string;vector:string|null;setconfig:string[]|null;logging:string[]}
interface Run{status:number|null;stdout:string;stderr:string}
interface Psql{command:string;args:string[];env:NodeJS.ProcessEnv}

const {Pool:PgPool}=createRequire(new URL('../../packages/postgres/package.json',import.meta.url))('pg') as
  {Pool:new(config:{connectionString:string;max?:number})=>Pool};
const root=resolve(import.meta.dirname,'../..');
const read=(file:string)=>readFileSync(resolve(root,file),'utf8').replace(/\r\n/g,'\n');
const provision=read('deploy/postgres/provision.sql');
const serverUrl=new URL(process.env.UNAI_TEST_DATABASE_URL);
const database='unai_provision_'+randomBytes(8).toString('hex');
const admin=new PgPool({connectionString:serverUrl.href,max:1});
admin.on('error',()=>{});

const EXAMPLE='volume-kms:arn:aws:kms:eu-central-1:111122223333:key/1234abcd-12ab-34cd-56ef-1234567890ab';
const PASSWORDS=['migrator_password','api_login_password','worker_login_password','auth_login_password','backup_password'];
const VARIABLES=[...PASSWORDS,'encryption_at_rest'];
const GROUP:Role={login:false,super:false,createdb:false,createrole:false,inherit:false,replication:false,bypassrls:false,connlimit:-1,scram:false};
const login=(superuser:boolean,bypassrls:boolean,connlimit:number):Role=>
  ({login:true,super:superuser,createdb:false,createrole:false,inherit:true,replication:false,bypassrls,connlimit,scram:true});
const D4_LOGINS:Record<string,Role>={unai_migrator:login(true,false,5),unai_api_login:login(false,false,12),
  unai_worker_login:login(false,false,12),unai_auth_login:login(false,false,22),unai_backup:login(false,true,3)};
const D4_MEMBERS:Membership[]=[['unai_api_login','unai_app',false,true,true],['unai_auth_login','unai_auth',false,true,true],
  ['unai_backup','pg_read_all_data',false,true,true],['unai_worker_login','unai_app',false,true,true]];
const D4_SETTINGS={listen_addresses:"'127.0.0.1'",ssl:'on',ssl_min_protocol_version:"'TLSv1.2'",
  ssl_cert_file:"'/etc/unai/tls/postgres/cert.pem'",ssl_key_file:"'/etc/unai/tls/postgres/key.pem'",
  password_encryption:'scram-sha-256',max_connections:'100',superuser_reserved_connections:'3'};
const DRILL_DATABASE='^unai_restore_drill_[0-9a-f]{16}$';
const DRILL_PROBE='^unai_restore_drill_probe_[0-9a-f]{16}$';
const D4_HBA=['hostssl unai unai_api_login,unai_worker_login,unai_auth_login,unai_backup,unai_migrator 127.0.0.1/32 scram-sha-256',
  `hostssl /${DRILL_DATABASE} unai_migrator,/${DRILL_PROBE} 127.0.0.1/32 scram-sha-256`,
  'local all postgres peer'];
const ROLES=['unai_app','unai_auth',...Object.keys(D4_LOGINS)];
const quoted=(names:string[])=>names.map(name=>`'${name}'`).join(',');

/** One labelled JSON line of everything provision.sql may change; passwords appear only as a SCRAM boolean. */
const snapshot=(label:string)=>`SELECT '${label} ' || json_build_object(
  'roles',(SELECT coalesce(json_object_agg(r.rolname,json_build_object('login',r.rolcanlogin,'super',r.rolsuper,
    'createdb',r.rolcreatedb,'createrole',r.rolcreaterole,'inherit',r.rolinherit,'replication',r.rolreplication,
    'bypassrls',r.rolbypassrls,'connlimit',r.rolconnlimit,'scram',coalesce(r.rolpassword LIKE 'SCRAM-SHA-256$%',false))),'{}')
    FROM pg_authid r WHERE r.rolname IN (${quoted(ROLES)})),
  'members',(SELECT coalesce(json_agg(json_build_array(m.rolname,g.rolname,a.admin_option,a.inherit_option,a.set_option)
    ORDER BY m.rolname COLLATE "C",g.rolname COLLATE "C"),'[]') FROM pg_auth_members a
    JOIN pg_roles m ON m.oid=a.member JOIN pg_roles g ON g.oid=a.roleid WHERE m.rolname IN (${quoted(Object.keys(D4_LOGINS))})),
  'owner',(SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname=current_database()),
  'vector',(SELECT extversion FROM pg_extension WHERE extname='vector'),
  'setconfig',(SELECT s.setconfig FROM pg_db_role_setting s JOIN pg_database d ON d.oid=s.setdatabase
    WHERE d.datname=current_database() AND s.setrole=0),
  'logging',json_build_array(current_setting('log_statement'),current_setting('log_min_duration_statement'),
    current_setting('log_min_error_statement')))::text;`;
/** Pre-existing login roles and a membership that drifted from D4; a re-run must converge them. */
const DRIFT=`ALTER ROLE unai_api_login WITH NOLOGIN CREATEDB REPLICATION CONNECTION LIMIT 1 PASSWORD NULL;
ALTER ROLE unai_backup WITH NOBYPASSRLS NOINHERIT;
REVOKE unai_app FROM unai_worker_login;`;
/** Variables as `\set` lines, then the file three times in one transaction that is rolled back. */
const session=(variables:Record<string,string>)=>[
  ...Object.entries(variables).map(([name,value])=>`\\set ${name} '${value}'`),
  'BEGIN;',snapshot('PRE'),provision,snapshot('FIRST'),provision,snapshot('SECOND'),
  DRIFT,snapshot('DRIFTED'),provision,snapshot('CONVERGED'),'ROLLBACK;',snapshot('AFTER'),''].join('\n');

/** psql of the server's major on the host, else on PATH, else the pinned harness image (scripts/database-roundtrip.mjs). */
function psqlClient(major:number):Psql{
  // No ambient PG* variable reaches the client; HOME and DOCKER_* stay so the docker CLI finds its daemon.
  const env:NodeJS.ProcessEnv={...process.env};
  for(const name of Object.keys(env))if(name.startsWith('PG'))delete env[name];
  Object.assign(env,{PGHOST:serverUrl.hostname,PGPORT:serverUrl.port||'5432',PGUSER:decodeURIComponent(serverUrl.username),
    PGPASSWORD:decodeURIComponent(serverUrl.password),PGDATABASE:database});
  const host='/usr/lib/postgresql/'+major+'/bin/psql';
  if(existsSync(host))return {command:host,args:[],env};
  const onPath=spawnSync('psql',['--version'],{env});
  if(!onPath.error&&onPath.status===0)return {command:'psql',args:[],env};
  const loopback=['127.0.0.1','localhost','[::1]'].includes(serverUrl.hostname);
  if(loopback&&process.platform==='win32')env.PGHOST='host.docker.internal';
  const network=process.platform==='win32'?[]:['--network','host'];
  return {command:'docker',env,args:['run','--rm','--interactive',...network,
    ...['PGHOST','PGPORT','PGUSER','PGPASSWORD','PGDATABASE'].flatMap(name=>['--env',name]),POSTGRES_IMAGE,'psql']};
}
function runPsql(psql:Psql,input:string,secrets:string[]):Promise<Run>{
  const scrub=(text:string)=>secrets.reduce((value,secret)=>value.replaceAll(secret,'[password]'),text);
  return new Promise((done,fail)=>{
    const child=spawn(psql.command,[...psql.args,'-X','-q','-A','-t','-v','ON_ERROR_STOP=1','-f','-'],{env:psql.env});
    let stdout='',stderr='';
    child.stdout.setEncoding('utf8').on('data',(chunk:string)=>{stdout+=chunk;});
    child.stderr.setEncoding('utf8').on('data',(chunk:string)=>{stderr+=chunk;});
    const timer=setTimeout(()=>child.kill('SIGKILL'),120_000);
    child.on('error',()=>{clearTimeout(timer);fail(new Error('PROVISION_TEST_PSQL_UNAVAILABLE'));});
    child.on('close',status=>{clearTimeout(timer);done({status,stdout:scrub(stdout),stderr:scrub(stderr)});});
    child.stdin.on('error',()=>{}); // psql stops reading at the first error.
    child.stdin.end(input);
  });
}
const labelled=(run:Run,label:string):Snapshot|undefined=>{
  const line=run.stdout.split('\n').find(text=>text.startsWith(label+' '));
  return line===undefined?undefined:JSON.parse(line.slice(label.length+1)) as Snapshot;
};
const required=(run:Run,label:string):Snapshot=>{
  const value=labelled(run,label);
  if(!value)throw new Error('PROVISION_SNAPSHOT_MISSING '+label);
  return value;
};

let created=false,main:Run={status:null,stdout:'',stderr:''};
const missing=new Map<string,Run>();
let invalid:Run={status:null,stdout:'',stderr:''};

beforeAll(async()=>{
  await admin.query(`CREATE DATABASE ${database} TEMPLATE template0`);
  created=true;
  const version=Number((await admin.query('SHOW server_version_num')).rows[0]!.server_version_num);
  const psql=psqlClient(Math.floor(version/10000));
  const passwords=PASSWORDS.map(()=>randomBytes(24).toString('hex'));
  const variables:Record<string,string>={dbname:database,encryption_at_rest:EXAMPLE};
  PASSWORDS.forEach((name,index)=>{variables[name]=passwords[index]!;});
  // One session at a time: at most one provisioning transaction is ever open on the shared cluster.
  main=await runPsql(psql,session(variables),passwords);
  for(const name of VARIABLES){
    const {[name]:_omitted,...rest}=variables;
    missing.set(name,await runPsql(psql,session(rest),passwords));
  }
  invalid=await runPsql(psql,session({...variables,encryption_at_rest:'plaintext'}),passwords);
},180_000);

afterAll(async()=>{
  try{
    if(!created)return;
    // Wait until psql's backends are gone before the forced drop (mem: pg-pool-end-drop-force-race).
    for(let attempt=0;attempt<200;attempt++){
      const {rowCount}=await admin.query('SELECT 1 FROM pg_stat_activity WHERE datname=$1',[database]);
      if(rowCount===0){await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);return;}
      await delay(25);
    }
    throw new Error('PROVISION_TEST_BACKENDS_STILL_ACTIVE');
  }finally{await admin.end();}
},30_000);

describe('provision.sql on the harness server', () => {
  it('runs twice in one transaction without an error', () => {
    expect(main.stderr).not.toContain('ERROR');
    expect(main.status).toBe(0);
  });

  it('first application yields exactly the D4 roles, SCRAM verifiers and memberships', () => {
    const pre=required(main,'PRE'),first=required(main,'FIRST');
    for(const [name,role] of Object.entries(D4_LOGINS))expect(first.roles[name],name).toEqual(role);
    // The harness migrated before vitest, so the group roles exist: only "never altered" is observable here.
    for(const name of ['unai_app','unai_auth'])expect(first.roles[name],name).toEqual(pre.roles[name]??GROUP);
    expect(first.members).toEqual(D4_MEMBERS);
  });

  it('sets owner, vector and the D4 encryption declaration on the target database', () => {
    const pre=required(main,'PRE'),first=required(main,'FIRST');
    expect([pre.vector,pre.setconfig]).toEqual([null,null]);
    expect(first.owner).toBe('unai_migrator');
    expect(first.vector).toMatch(/^\d+\.\d+\.\d+$/);
    expect(first.setconfig).toEqual(['unai.encryption_at_rest='+EXAMPLE]);
  });

  it('a second application changes nothing', () => {
    expect(required(main,'SECOND')).toEqual(required(main,'FIRST'));
  });

  it('a re-run converges drifted login roles and memberships', () => {
    const first=required(main,'FIRST');
    expect(required(main,'DRIFTED')).not.toEqual(first);
    expect(required(main,'CONVERGED')).toEqual(first);
  });

  it('leaves nothing behind after rollback', () => {
    const pre=required(main,'PRE'),after=required(main,'AFTER');
    expect([after.vector,after.setconfig,after.owner]).toEqual([null,null,pre.owner]);
    for(const name of ['unai_app','unai_auth','unai_migrator','unai_worker_login','unai_auth_login','unai_backup'])
      expect(after.roles[name],name).toEqual(pre.roles[name]);
    // src/backup.test.ts creates and drops a bare unai_api_login on this cluster concurrently,
    // so only "not provisioned" is stable for it.
    expect(after.members.filter(([member])=>member==='unai_api_login')).toEqual([]);
    expect(after.roles.unai_api_login?.connlimit).not.toBe(12);
  });

  it('refuses each missing variable with PROVISION_VARIABLE_REQUIRED before any role statement', () => {
    for(const name of VARIABLES){
      const run=missing.get(name)!;
      expect(run.status,name).not.toBe(0);
      expect(run.stderr,name).toContain('PROVISION_VARIABLE_REQUIRED:'+name);
      expect(labelled(run,'FIRST'),name).toBeUndefined();
    }
    const firstRole=provision.search(/^(SELECT 'CREATE ROLE|ALTER ROLE|GRANT )/m);
    expect(firstRole).toBeGreaterThan(0);
    for(const name of VARIABLES){
      const guard=provision.indexOf(`\\if :{?${name}}\n\\else\nDO $$BEGIN RAISE EXCEPTION 'PROVISION_VARIABLE_REQUIRED:${name}'; END$$;\n\\endif`);
      expect(guard,name).toBeGreaterThan(0);
      expect(guard,name).toBeLessThan(firstRole);
    }
  });

  it('turns statement logging off for its session before any role statement', () => {
    expect(required(main,'FIRST').logging).toEqual(['none','-1','panic']);
    const firstRole=provision.search(/^(SELECT 'CREATE ROLE|ALTER ROLE|GRANT )/m);
    for(const setting of ["log_statement = 'none'",'log_min_duration_statement = -1','log_min_error_statement = panic']){
      const index=provision.indexOf(`\nSET ${setting};\n`);
      expect(index,setting).toBeGreaterThan(0);
      expect(index,setting).toBeLessThan(firstRole);
    }
  });

  it('refuses an invalid declaration with PROVISION_ENCRYPTION_DECLARATION_INVALID', () => {
    expect(invalid.status).not.toBe(0);
    expect(invalid.stderr).toContain('PROVISION_ENCRYPTION_DECLARATION_INVALID');
    expect(labelled(invalid,'FIRST')).toBeUndefined();
  });
});

describe('provision.sql source', () => {
  const statements=provision.split('\n').filter(line=>!line.startsWith('--'));

  it('takes every password from a psql variable and has no transaction control or include', () => {
    expect(provision).not.toMatch(/\bPASSWORD\s+'/i);
    expect([...provision.matchAll(/\bPASSWORD\s+:'(\w+)'/g)].map(match=>match[1]).sort()).toEqual([...PASSWORDS].sort());
    for(const line of statements){
      expect(line).not.toMatch(/^\s*(BEGIN|COMMIT|ROLLBACK|END|ABORT|START\s+TRANSACTION|SAVEPOINT|RELEASE|PREPARE\s+TRANSACTION)\b/i);
      expect(line).not.toMatch(/^\s*\\(i|ir|include|include_relative)\b/);
    }
  });

  it('keeps the encryption pattern of packages/postgres/src/encryption.ts', () => {
    const source=/const DECLARATION = \/(.+)\/;/.exec(read('packages/postgres/src/encryption.ts'))?.[1];
    expect(source).toBeDefined();
    expect(provision).toContain(`'${source}'`);
    const documented=/^-- {3}\\set encryption_at_rest '([^'<]+)'$/m.exec(provision)?.[1];
    expect(documented).toBe(EXAMPLE);
    expect(new RegExp(source!).test(EXAMPLE)).toBe(true);
  });

  it('creates the group roles with the attributes migrations 0001 and 0002 assert', () => {
    for(const [name,migration] of [['unai_app','migrations/0001_foundation.sql'],['unai_auth','migrations/0002_authentication.sql']] as const){
      const asserted=new RegExp(`^ALTER ROLE ${name} (.+);$`,'m').exec(read(migration))?.[1];
      const created=new RegExp(`^SELECT 'CREATE ROLE ${name} (.+)' WHERE NOT EXISTS`,'m').exec(provision)?.[1];
      expect(asserted,name).toBeDefined();
      expect(created,name).toBe(asserted);
      expect(provision).not.toMatch(new RegExp(`ALTER ROLE ${name}\\b`));
    }
  });
});

describe('server configuration', () => {
  const lines=(file:string)=>read(file).split('\n').map(line=>line.trim().replace(/\s+/g,' ')).filter(line=>line&&!line.startsWith('#'));

  it('unai.conf holds exactly the D4 settings, each known to the server', async () => {
    const settings=Object.fromEntries(lines('deploy/postgres/unai.conf').map(line=>{
      const match=/^([a-z_]+) = (.+)$/.exec(line);
      expect(match,line).not.toBeNull();
      return [match![1]!,match![2]!] as const;
    }));
    expect(settings).toEqual(D4_SETTINGS);
    const {rows}=await admin.query('SELECT name,vartype,enumvals FROM pg_settings WHERE name=ANY($1)',[Object.keys(D4_SETTINGS)]);
    expect(rows.map(row=>row.name).sort()).toEqual(Object.keys(D4_SETTINGS).sort());
    for(const row of rows.filter(row=>row.vartype==='enum')){
      const value=settings[row.name as string]!.replace(/^'(.*)'$/,'$1');
      expect(row.enumvals,row.name as string).toContain(value);
    }
  });

  it('pg_hba.conf holds exactly the three D4 lines and no non-TLS host line', () => {
    const hba=lines('deploy/postgres/pg_hba.conf');
    expect(hba).toEqual(D4_HBA);
    for(const line of hba)expect(['host','hostnossl','hostgssenc','hostnogssenc']).not.toContain(line.split(' ')[0]);
  });
});

/**
 * The shipped pg_hba.conf loaded by a throwaway PostgreSQL 17 (hba_file is read only at server start, and the harness
 * server may be a delivered one). ssl is on, with the image's own snakeoil pair: with ssl off every hostssl rule
 * carries an error. A file the server cannot parse makes it refuse to start, which shows as PG_HBA_TEST_SERVER_EXITED.
 */
type HbaRule=[string,string[],string[],string|null,string|null,string,string|null];
interface HbaReport{version:number;hba:string;rules:HbaRule[];match:Record<string,[boolean,boolean]>}
const docker=(args:string[],input?:string)=>{
  const run=spawnSync('docker',args,{encoding:'utf8',timeout:60_000,...input===undefined?{}:{input}});
  return {status:run.status,error:run.error,stdout:run.stdout??'',stderr:run.stderr??''};
};

describe('pg_hba.conf on PostgreSQL 17 (POSTGRES_IMAGE)', () => {
  const container='unai-hba-'+randomBytes(6).toString('hex');
  const id=randomBytes(8).toString('hex');
  const drill='unai_restore_drill_'+id,probe='unai_restore_drill_probe_'+id;
  // [database pattern, user pattern] verdicts, written out: never derived from the patterns under test.
  const expected:Record<string,[boolean,boolean]>={[drill]:[true,false],[probe]:[false,true]};
  for(const name of ['unai','postgres','unai_restore_drill_'+id.slice(1),'unai_restore_drill_'+id+'0','unai_restore_drill_0123456789ABCDEF',
    drill+'x','x'+drill,'unai_restore_drill_probe_'+id.slice(1),probe+'0','unai_restore_drill_probe_0123456789ABCDEF',probe+'x'])expected[name]=[false,false];
  let report!:HbaReport;

  /** The entrypoint first runs an init server on the socket only; 127.0.0.1 answers once the final server runs. */
  async function ready(){
    for(let attempt=0;attempt<360;attempt++){
      const ping=docker(['exec',container,'pg_isready','-q','-h','127.0.0.1']);
      if(ping.status===0)return;
      if(/No such container|is not running/.test(ping.stderr))throw new Error('PG_HBA_TEST_SERVER_EXITED');
      await delay(250);
    }
    throw new Error('PG_HBA_TEST_SERVER_NOT_READY');
  }
  /** One socket session as postgres (`local all postgres peer`): the rules the server loaded and PostgreSQL's own regex engine. */
  function load():HbaReport{
    const select=`SELECT json_build_object('version',current_setting('server_version_num')::int,'hba',current_setting('hba_file'),
      'rules',(SELECT json_agg(json_build_array(type,database,user_name,address,netmask,auth_method,error) ORDER BY line_number) FROM pg_hba_file_rules),
      'match',(SELECT json_object_agg(n,json_build_array((n COLLATE "C") ~ :'db',(n COLLATE "C") ~ :'probe')) FROM unnest(:'names'::text[]) AS n));`;
    const run=docker(['exec','--interactive','--user','postgres',container,'psql','-X','-q','-A','-t','-v','ON_ERROR_STOP=1','-f','-'],
      [String.raw`\set db '${DRILL_DATABASE}'`,String.raw`\set probe '${DRILL_PROBE}'`,
        String.raw`\set names '{${Object.keys(expected).join(',')}}'`,select].join('\n'));
    if(run.status!==0)throw new Error('PG_HBA_TEST_QUERY_FAILED: '+run.stderr.trim());
    return JSON.parse(run.stdout.trim()) as HbaReport;
  }
  /** A connection attempt from inside the container (source 127.0.0.1) with a wrong password. A matched scram line answers
   * 'password authentication failed' even for a role or database that does not exist; no matching line answers 'no pg_hba.conf entry'. */
  const attempt=(dbname:string,user:string,sslmode:string)=>{
    const {stderr}=docker(['exec','--env','PGPASSWORD='+randomBytes(16).toString('hex'),'--env','PGCONNECT_TIMEOUT=10',container,
      'psql','-X',`host=127.0.0.1 dbname=${dbname} user=${user} sslmode=${sslmode}`,'-c','SELECT 1']);
    return /no pg_hba\.conf entry/.test(stderr)?'refused':/password authentication failed/.test(stderr)?'admitted':'unexpected';
  };

  beforeAll(async () => {
    const run=docker(postgresRunArguments({name:container,
      options:['--env','POSTGRES_PASSWORD='+randomBytes(16).toString('hex'),
        '--mount',`type=bind,src=${resolve(root,'deploy/postgres/pg_hba.conf')},dst=/etc/unai/pg_hba.conf,readonly`],
      command:['-c','hba_file=/etc/unai/pg_hba.conf','-c','ssl=on','-c','ssl_cert_file=/etc/ssl/certs/ssl-cert-snakeoil.pem',
        '-c','ssl_key_file=/etc/ssl/private/ssl-cert-snakeoil.key']}));
    if(run.error||run.status!==0)throw new Error('PG_HBA_TEST_DOCKER_UNAVAILABLE'+(run.stderr?': '+run.stderr.trim():''));
    await ready();
    report=load();
  },180_000);
  afterAll(() => {docker(['rm','--force',container]);});

  it('PostgreSQL 17 loads pg_hba.conf with ssl on: three rules, none with an error', () => {
    expect(Math.floor(report.version/10000)).toBe(17);
    expect(report.hba).toBe('/etc/unai/pg_hba.conf');
    expect(report.rules).toEqual([
      ['hostssl',['unai'],['unai_api_login','unai_worker_login','unai_auth_login','unai_backup','unai_migrator'],'127.0.0.1','255.255.255.255','scram-sha-256',null],
      ['hostssl',['/'+DRILL_DATABASE],['unai_migrator','/'+DRILL_PROBE],'127.0.0.1','255.255.255.255','scram-sha-256',null],
      ['local',['all'],['postgres'],null,null,'peer',null]]);
    expect(report.rules.filter(rule=>rule[6]!==null)).toEqual([]);
  });

  it('the drill patterns admit a generated drill database and probe login and refuse every other name', () => {
    expect(report.match).toEqual(expected);
  });

  it('the loaded server lets the drill connections past pg_hba and refuses the rest', () => {
    expect([
      attempt(drill,'unai_migrator','require'),   // pnpm restore
      attempt(drill,probe,'require'),             // the read probes
      attempt('unai','unai_migrator','require'),  // line 1, unchanged
      attempt('unai',probe,'require'),
      attempt(drill,'unai_api_login','require'),
      attempt(drill,'unai_migrator','disable'),   // hostssl only
    ]).toEqual(['admitted','admitted','admitted','refused','refused','refused']);
  },60_000);
});
