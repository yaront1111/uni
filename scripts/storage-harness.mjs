import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {Agent} from 'node:https';
import {setTimeout} from 'node:timers/promises';
import {createSelfSignedCertificate} from './tls-certificate.mjs';
import {startS3ObjectServer} from './s3-object-server.mjs';
const {S3Client,CreateBucketCommand,PutBucketEncryptionCommand}=createRequire(new URL('../packages/storage/package.json',import.meta.url))('@aws-sdk/client-s3');

const BUCKET='unai-evidence-test';

/** A runner that provisions its own encrypted S3-compatible bucket delivers the
 * endpoint, bucket and KMS key instead of a container, exactly as it delivers
 * DATABASE_URL for PostgreSQL. The suite then uses that bucket unchanged, with
 * the credentials and NODE_EXTRA_CA_CERTS the runner already exported. */
export function deliveredStorage(){
  const missing=['UNAI_TEST_S3_ENDPOINT','UNAI_TEST_S3_BUCKET','UNAI_TEST_S3_KMS_KEY_ID'].filter(name=>!process.env[name]?.trim());
  if(missing.length===3)return null;
  if(missing.length)throw new Error('Delivered object storage is incomplete; also set '+missing.join(', '));
  return {description:'delivered object storage at '+process.env.UNAI_TEST_S3_ENDPOINT,env:{},close(){}};
}

function containerDaemonReachable(){
  const probe=spawnSync('docker',['version','--format','{{.Server.Version}}'],{encoding:'utf8',timeout:60000});
  return !probe.error&&probe.status===0;
}

function temporaryDirectory(){
  const directory=mkdtempSync(join(tmpdir(),'unai-s3-'));
  return {directory,remove(){
    const absolute=resolve(directory);
    const child=relative(resolve(tmpdir()),absolute);
    if(isAbsolute(child)||child.startsWith('..')||!child.startsWith('unai-s3-'))throw new Error('UNSAFE_TEST_CLEANUP');
    rmSync(absolute,{recursive:true,force:true});
  }};
}

/** The suite always runs against real TLS and real KMS-encrypted object storage.
 * MinIO serves that whenever a container daemon is reachable; the in-process
 * S3-compatible server serves it when one is not. Neither is a production store. */
export async function startStorageHarness(){
  return containerDaemonReachable()?startMinioContainer():startLocalObjectServer();
}

async function startLocalObjectServer(){
  const {directory,remove}=temporaryDirectory();
  let server;
  try{
    const kmsKeyId='arn:aws:kms:unai-test-key';
    server=await startS3ObjectServer({bucket:BUCKET,kmsKeyId});
    const authority=join(directory,'public.crt');
    writeFileSync(authority,server.certificate);
    return {description:'in-process S3-compatible TLS/KMS object storage (no container daemon)',
      close(){server.close();remove();},
      env:{NODE_EXTRA_CA_CERTS:authority,AWS_ACCESS_KEY_ID:server.credentials.accessKeyId,
        AWS_SECRET_ACCESS_KEY:server.credentials.secretAccessKey,AWS_SESSION_TOKEN:'',
        UNAI_TEST_S3_ENDPOINT:server.endpoint,UNAI_TEST_S3_BUCKET:BUCKET,UNAI_TEST_S3_KMS_KEY_ID:kmsKeyId}};
  }catch(error){server?.close();remove();throw error;}
}

async function startMinioContainer(){
  const {directory,remove}=temporaryDirectory();
  const name='unai-s3-test-'+randomUUID();
  let created=false;
  const execute=(command,args)=>{
    const r=spawnSync(command,args,{encoding:'utf8',timeout:120000});
    if(r.error||r.status!==0)throw new Error('STORAGE_HARNESS_COMMAND_FAILED: '+command+' '+(r.error?.message??r.stderr));
    return r.stdout.trim();
  };
  function close(){
    if(created)execute('docker',['stop',name]);
    remove();
  }
  try{
    const {key,certificate}=createSelfSignedCertificate();
    writeFileSync(join(directory,'private.key'),key);
    writeFileSync(join(directory,'public.crt'),certificate);
    const accessKey='unai-test',secretKey=randomBytes(32).toString('hex'),kmsKey='unai-test-key';
    execute('docker',['run','--detach','--rm','--name',name,'--publish','127.0.0.1::9000','--tmpfs','/data',
      '--mount',`type=bind,source=${directory},target=/certs,readonly`,
      '--env','MINIO_ROOT_USER='+accessKey,'--env','MINIO_ROOT_PASSWORD='+secretKey,
      '--env','MINIO_KMS_SECRET_KEY='+kmsKey+':'+randomBytes(32).toString('base64'),
      'quay.io/minio/minio@sha256:a1ea29fa28355559ef137d71fc570e508a214ec84ff8083e39bc5428980b015e',
      'server','/data','--certs-dir','/certs']);
    created=true;
    const port=JSON.parse(execute('docker',['inspect','--format','{{json .NetworkSettings.Ports}}',name]))['9000/tcp'][0].HostPort;
    const endpoint='https://127.0.0.1:'+port;
    const client=new S3Client({endpoint,region:'us-east-1',forcePathStyle:true,credentials:{accessKeyId:accessKey,secretAccessKey:secretKey},
      maxAttempts:1,requestHandler:{httpsAgent:new Agent({ca:readFileSync(join(directory,'public.crt')),rejectUnauthorized:true}),connectionTimeout:1000,requestTimeout:2000}});
    try{
      let ready=false;
      for(let n=0;n<40;n++){try{await client.send(new CreateBucketCommand({Bucket:BUCKET}));ready=true;break;}catch{await setTimeout(250);}}
      if(!ready)throw new Error('STORAGE_HARNESS_NOT_READY');
      await client.send(new PutBucketEncryptionCommand({Bucket:BUCKET,ServerSideEncryptionConfiguration:{Rules:[{ApplyServerSideEncryptionByDefault:{SSEAlgorithm:'aws:kms',KMSMasterKeyID:'arn:aws:kms:'+kmsKey}}]}}));
    }finally{client.destroy();}
    return {description:'disposable MinIO TLS/KMS object storage',close,
      env:{NODE_EXTRA_CA_CERTS:join(directory,'public.crt'),AWS_ACCESS_KEY_ID:accessKey,AWS_SECRET_ACCESS_KEY:secretKey,AWS_SESSION_TOKEN:'',
        UNAI_TEST_S3_ENDPOINT:endpoint,UNAI_TEST_S3_BUCKET:BUCKET,UNAI_TEST_S3_KMS_KEY_ID:'arn:aws:kms:'+kmsKey}};
  }catch(error){close();throw error;}
}
