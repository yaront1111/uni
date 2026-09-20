import {randomBytes,randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {Agent} from 'node:https';
import {setTimeout as delay} from 'node:timers/promises';
import {postgresRunArguments} from './postgres-harness.mjs';
import {startStorageHarness} from './storage-harness.mjs';
import {createSelfSignedCertificate} from './tls-certificate.mjs';
import {DisposableStackResources,command,privateDirectory,writeProtected,ownContainer,spawnOwnedChild} from './disposable-stack-resources.mjs';
export {DisposableStackResources} from './disposable-stack-resources.mjs';

const {Pool}=createRequire(new URL('../packages/postgres/package.json',import.meta.url))('pg');
const {S3Client,PutObjectCommand,GetObjectCommand,DeleteObjectCommand,GetBucketEncryptionCommand}=
  createRequire(new URL('../packages/storage/package.json',import.meta.url))('@aws-sdk/client-s3');
const ENCRYPTION='managed:disposable-tmpfs-no-persistent-volume';
const childScript=fileURLToPath(new URL('./dev-stack-child.mjs',import.meta.url));
const databaseSelector=key=>/DATABASE|^PG(?:HOST|HOSTADDR|PORT|DATABASE|USER|PASSWORD|PASSFILE|SERVICE|SERVICEFILE|SYSCONFDIR|SSLMODE|SSLROOTCERT)$/.test(key.toUpperCase());

/** Only explicit non-secret process support variables are inherited by children. */
function childEnvironment(env){
  return Object.fromEntries(Object.entries(env).filter(([key,value])=>value!==undefined&&
    /^(PATH|SYSTEMROOT|WINDIR|TEMP|TMP|HOME|USERPROFILE|LANG|LC_ALL)$/i.test(key)));
}

export class DevStackOrchestrator {
  resources=new DisposableStackResources();
  #stop;
  #stopped=new Promise(resolvePromise=>{this.#stop=resolvePromise;});
  #reason;
  #phase='new';
  #database;
  #storage;
  #root;
  #config;
  constructor({env=process.env,args=[],log=console.log,onReady=async()=>{},onStage=async()=>{},
    children={api:[childScript,'api'],web:[childScript,'web']}}={}){
    this.env={...env};this.args=[...args];this.log=log;this.onReady=onReady;this.onStage=onStage;this.children=children;
  }
  requestStop(reason='NORMAL_EXIT'){
    if(this.#reason)return;
    this.#reason=reason;this.#stop();
  }
  async #stage(name){
    await this.onStage(name,this);
    if(this.#reason)throw new Error('DEV_STACK_START_INTERRUPTED');
  }
  async #pool(action){
    const pool=new Pool({...this.#database,max:1,connectionTimeoutMillis:2000,query_timeout:5000});
    try{return await action(pool);}finally{await pool.end();}
  }
  async #provision(){
    await command('docker',['version','--format','{{.Server.Version}}']);
    await this.#stage('preflight');
    this.#root=await privateDirectory(this.resources);
    await this.#stage('directory');
    const {key,certificate}=createSelfSignedCertificate();
    writeProtected(join(this.#root,'localhost.key'),key);
    writeProtected(join(this.#root,'localhost.crt'),certificate);
    const password=randomBytes(32).toString('hex');
    writeProtected(join(this.#root,'runtime','postgres-password'),password);
    writeProtected(join(this.#root,'pg_hba.conf'),
      'local all all trust\nhostnossl all all 0.0.0.0/0 reject\nhostnossl all all ::/0 reject\nhostssl all all 0.0.0.0/0 scram-sha-256\nhostssl all all ::/0 scram-sha-256\n');
    const invocation=randomUUID(),name='unai-dev-db-'+invocation;
    ownContainer(this.resources,name,invocation);
    await this.#stage('before-database');
    // Host files stay private on Windows and POSIX. Root copies only the needed
    // artifacts into a container tmpfs with PostgreSQL ownership and 0600 keys.
    await command('docker',postgresRunArguments({name,options:[
      '--label','unai.dev-stack.owner='+invocation,
      '--mount',`type=bind,source=${this.#root},target=/run/unai,readonly`,
      '--tmpfs','/run/private:rw,noexec,nosuid,size=4m',
      '--env','POSTGRES_PASSWORD_FILE=/run/private/postgres-password','--env','POSTGRES_DB=unai_dev',
    ],command:['sh','-ec',
      'cp /run/unai/localhost.key /run/unai/localhost.crt /run/unai/pg_hba.conf /run/unai/runtime/postgres-password /run/private/; '+
      'chown -R postgres:postgres /run/private; chmod 700 /run/private; chmod 600 /run/private/*; '+
      'exec docker-entrypoint.sh postgres -c ssl=on -c ssl_min_protocol_version=TLSv1.2 '+
      '-c ssl_cert_file=/run/private/localhost.crt -c ssl_key_file=/run/private/localhost.key '+
      '-c hba_file=/run/private/pg_hba.conf -c unai.encryption_at_rest='+ENCRYPTION]}));
    await this.#stage('database-started');
    const ports=JSON.parse(await command('docker',['inspect','--format','{{json .NetworkSettings.Ports}}',name]));
    const port=Number(ports['5432/tcp'][0].HostPort);
    const url=`postgresql://postgres:${password}@127.0.0.1:${port}/unai_dev`;
    this.#database={connectionString:url,ssl:{ca:certificate,rejectUnauthorized:true}};
    let ready=false;
    for(let n=0;n<120;n++){
      if(this.#reason)throw new Error('DEV_STACK_START_INTERRUPTED');
      try{await this.#pool(pool=>pool.query('SELECT 1'));ready=true;break;}catch{await delay(250);}
    }
    if(!ready)throw new Error('DEV_STACK_DATABASE_NOT_READY');
    await this.#pool(async pool=>{
      await pool.query('CREATE EXTENSION IF NOT EXISTS vector');
      await pool.query("ALTER DATABASE unai_dev SET unai.encryption_at_rest = '"+ENCRYPTION+"'");
    });
    writeProtected(join(this.#root,'runtime','database'),JSON.stringify({url}));
    this.log('DEV_STACK_DATABASE_READY TLS pgvector encryption-at-rest='+ENCRYPTION);
    await this.#stage('database-ready');
    this.#storage=await startStorageHarness({privateRuntime:{resources:this.resources,directory:this.#root,writeProtected}});
    writeProtected(join(this.#root,'runtime','storage'),JSON.stringify(this.#storage.credentials));
    writeProtected(join(this.#root,'runtime','session-secret'),randomBytes(32).toString('hex'));
    this.#config=Object.freeze({
      UNAI_SECRETS_MOUNT:this.#root,UNAI_DEV_DATABASE_URL:'secret://mounted/runtime/database#url',
      UNAI_DATABASE_CA_FILE:join(this.#root,'localhost.crt'),
      UNAI_S3_CREDENTIALS:'secret://mounted/runtime/storage',UNAI_S3_ENDPOINT:this.#storage.endpoint,
      UNAI_S3_BUCKET:this.#storage.bucket,UNAI_S3_KMS_KEY_ID:this.#storage.kmsKeyId,
      UNAI_S3_CA_FILE:this.#storage.authority,NEXTAUTH_SECRET:'secret://mounted/runtime/session-secret',
      UNAI_API_TLS_KEY_FILE:join(this.#root,'localhost.key'),UNAI_API_TLS_CERT_FILE:join(this.#root,'localhost.crt'),
      UNAI_WEB_TLS_KEY_FILE:join(this.#root,'localhost.key'),UNAI_WEB_TLS_CERT_FILE:join(this.#root,'localhost.crt'),
    });
    await this.verifyServices();
    this.log('DEV_STACK_STORAGE_READY TLS AES-256-GCM aws:kms');
    await this.#stage('storage-ready');
    const env={...childEnvironment(this.env),...this.#config};
    for(const role of ['api','web']){
      const {ready:childReady}=spawnOwnedChild(this.resources,role,this.children[role],env,
        name=>{if(this.#phase!=='cleanup')this.requestStop('DEV_STACK_'+name.toUpperCase()+'_EXIT');});
      await childReady;
      await this.#stage(role+'-ready');
    }
  }
  async verifyServices(){
    const facts=await this.#pool(async pool=>{
      const tls=(await pool.query('SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()')).rows[0].ssl;
      const vector=(await pool.query("SELECT '[1,2,3]'::vector::text AS value")).rows[0].value==='[1,2,3]';
      const declared=(await pool.query("SELECT current_setting('unai.encryption_at_rest') AS value")).rows[0].value;
      return {databaseTls:tls,pgvector:vector,encryptionAtRest:declared};
    });
    const s=this.#storage;
    const client=new S3Client({endpoint:s.endpoint,region:'us-east-1',forcePathStyle:true,credentials:s.credentials,maxAttempts:1,
      requestHandler:{httpsAgent:new Agent({ca:readFileSync(s.authority),rejectUnauthorized:true}),connectionTimeout:2000,requestTimeout:5000}});
    const object='runtime-probe-'+randomUUID(),body=randomBytes(32).toString('hex');
    try{
      const encryption=await client.send(new GetBucketEncryptionCommand({Bucket:s.bucket}));
      const defaults=encryption.ServerSideEncryptionConfiguration.Rules[0].ApplyServerSideEncryptionByDefault;
      if(defaults.SSEAlgorithm!=='aws:kms'||defaults.KMSMasterKeyID!==s.kmsKeyId)throw new Error('DEV_STACK_STORAGE_ENCRYPTION_REQUIRED');
      await client.send(new PutObjectCommand({Bucket:s.bucket,Key:object,Body:body,ServerSideEncryption:'aws:kms',SSEKMSKeyId:s.kmsKeyId}));
      const result=await client.send(new GetObjectCommand({Bucket:s.bucket,Key:object}));
      const equal=await result.Body.transformToString()===body;
      if(!equal||result.ServerSideEncryption!=='aws:kms'||result.SSEKMSKeyId!==s.kmsKeyId)throw new Error('DEV_STACK_STORAGE_PROBE_FAILED');
      await client.send(new DeleteObjectCommand({Bucket:s.bucket,Key:object}));
      if(!facts.databaseTls||!facts.pgvector||facts.encryptionAtRest!==ENCRYPTION)throw new Error('DEV_STACK_DATABASE_PROBE_FAILED');
      return {...facts,objectRoundtrip:true,objectEncryption:result.ServerSideEncryption};
    }finally{client.destroy();}
  }
  async run(){
    if(this.#phase!=='new')throw new Error('DEV_STACK_ALREADY_RUN');
    this.#phase='preflight';
    // No directory, Docker command, connection or signal handler precedes refusal.
    if(Object.entries(this.env).some(([key,value])=>databaseSelector(key)&&value!==undefined)||
      this.args.some(arg=>/database|postgres|^--(?:pg|db)/i.test(arg))){
      this.log('DEV_STACK_EXTERNAL_DATABASE_REFUSED');return 1;
    }
    if(this.args.length){this.log('DEV_STACK_ARGUMENTS_INVALID');return 1;}
    const interrupt=()=>this.requestStop('SIGINT'),terminate=()=>this.requestStop('SIGTERM');
    process.on('SIGINT',interrupt);process.on('SIGTERM',terminate);
    let code=0;
    try{
      this.#phase='starting';
      await this.#provision();
      this.#phase='ready';
      this.log('DEV_STACK_READY disposable services; API/web runtime stubs; Ctrl+C to clean up');
      await this.onReady(this.#config,this);
      await this.#stopped;
    }catch{
      if(!this.#reason)this.requestStop('DEV_STACK_STARTUP_FAILED');
    }finally{
      this.#phase='cleanup';
      const reason=this.#reason??'DEV_STACK_STARTUP_FAILED';
      code=reason==='NORMAL_EXIT'?0:reason==='SIGINT'?130:reason==='SIGTERM'?143:1;
      this.log(reason);
      try{await this.resources.cleanup();this.log('DEV_STACK_CLEANUP_COMPLETE');}
      catch{this.log('DEV_STACK_CLEANUP_FAILED');code=1;}
      process.off('SIGINT',interrupt);process.off('SIGTERM',terminate);
      this.#phase='closed';
    }
    return code;
  }
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  process.exitCode=await new DevStackOrchestrator({args:process.argv.slice(2)}).run();
}
