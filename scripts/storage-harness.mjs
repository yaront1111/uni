import {spawnSync} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {Agent} from 'node:https';
import {setTimeout} from 'node:timers/promises';
const {S3Client,CreateBucketCommand,PutBucketEncryptionCommand}=createRequire(new URL('../packages/storage/package.json',import.meta.url))('@aws-sdk/client-s3');

export async function startStorageHarness(){
  const directory=mkdtempSync(join(tmpdir(),'unai-s3-')),name='unai-s3-test-'+randomUUID();
  let created=false;
  const execute=(command,args)=>{
    const r=spawnSync(command,args,{encoding:'utf8',timeout:120000});
    if(r.error||r.status!==0)throw new Error('STORAGE_HARNESS_COMMAND_FAILED: '+command+' '+(r.error?.message??r.stderr));
    return r.stdout.trim();
  };
  function close(){
    if(created)execute('docker',['stop',name]);
    const absolute=resolve(directory);
    const child=relative(resolve(tmpdir()),absolute);
    if(isAbsolute(child)||child.startsWith('..')||!child.startsWith('unai-s3-'))throw new Error('UNSAFE_TEST_CLEANUP');
    rmSync(absolute,{recursive:true,force:true});
  }
  try{
    const openssl=process.platform==='win32'&&existsSync('C:/Program Files/Git/usr/bin/openssl.exe')?'C:/Program Files/Git/usr/bin/openssl.exe':'openssl';
    execute(openssl,['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(directory,'private.key'),'-out',join(directory,'public.crt'),'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1']);
    const accessKey='unai-test',secretKey=randomBytes(32).toString('hex'),kmsKey='unai-test-key';
    execute('docker',['run','--detach','--rm','--name',name,'--publish','127.0.0.1::9000','--tmpfs','/data',
      '--mount',`type=bind,source=${directory},target=/certs,readonly`,
      '--env','MINIO_ROOT_USER='+accessKey,'--env','MINIO_ROOT_PASSWORD='+secretKey,
      '--env','MINIO_KMS_SECRET_KEY='+kmsKey+':'+randomBytes(32).toString('base64'),
      'quay.io/minio/minio@sha256:a1ea29fa28355559ef137d71fc570e508a214ec84ff8083e39bc5428980b015e',
      'server','/data','--certs-dir','/certs']);
    created=true;
    const port=JSON.parse(execute('docker',['inspect','--format','{{json .NetworkSettings.Ports}}',name]))['9000/tcp'][0].HostPort;
    const endpoint='https://127.0.0.1:'+port,bucket='unai-evidence-test';
    const client=new S3Client({endpoint,region:'us-east-1',forcePathStyle:true,credentials:{accessKeyId:accessKey,secretAccessKey:secretKey},
      maxAttempts:1,requestHandler:{httpsAgent:new Agent({ca:readFileSync(join(directory,'public.crt')),rejectUnauthorized:true}),connectionTimeout:1000,requestTimeout:2000}});
    try{
      let ready=false;
      for(let n=0;n<40;n++){try{await client.send(new CreateBucketCommand({Bucket:bucket}));ready=true;break;}catch{await setTimeout(250);}}
      if(!ready)throw new Error('STORAGE_HARNESS_NOT_READY');
      await client.send(new PutBucketEncryptionCommand({Bucket:bucket,ServerSideEncryptionConfiguration:{Rules:[{ApplyServerSideEncryptionByDefault:{SSEAlgorithm:'aws:kms',KMSMasterKeyID:'arn:aws:kms:'+kmsKey}}]}}));
    }finally{client.destroy();}
    return {close,env:{NODE_EXTRA_CA_CERTS:join(directory,'public.crt'),AWS_ACCESS_KEY_ID:accessKey,AWS_SECRET_ACCESS_KEY:secretKey,AWS_SESSION_TOKEN:'',
      UNAI_TEST_S3_ENDPOINT:endpoint,UNAI_TEST_S3_BUCKET:bucket,UNAI_TEST_S3_KMS_KEY_ID:'arn:aws:kms:'+kmsKey}};
  }catch(error){close();throw error;}
}
