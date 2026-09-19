import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import {Agent} from 'node:https';
import {createHash} from 'node:crypto';
const {S3Client,ListObjectsV2Command,GetObjectCommand,PutObjectCommand}=createRequire(new URL('../packages/storage/package.json',import.meta.url))('@aws-sdk/client-s3');
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
async function clientFor(env){
  return new S3Client({endpoint:env.UNAI_TEST_S3_ENDPOINT,region:'us-east-1',forcePathStyle:true,
    ...(env.AWS_ACCESS_KEY_ID&&env.AWS_SECRET_ACCESS_KEY?{credentials:{accessKeyId:env.AWS_ACCESS_KEY_ID,secretAccessKey:env.AWS_SECRET_ACCESS_KEY,...(env.AWS_SESSION_TOKEN?{sessionToken:env.AWS_SESSION_TOKEN}:{})}}:{}),
    requestHandler:{httpsAgent:new Agent({...(env.NODE_EXTRA_CA_CERTS?{ca:await readFile(env.NODE_EXTRA_CA_CERTS)}:{}),rejectUnauthorized:true})}});
}
async function keys(client,bucket){
  const found=[];let token;
  do{
    const result=await client.send(new ListObjectsV2Command({Bucket:bucket,...(token?{ContinuationToken:token}:{})}));
    found.push(...(result.Contents??[]).map(item=>item.Key));
    token=result.IsTruncated?result.NextContinuationToken:undefined;
    if(result.IsTruncated&&!token)throw new Error('BACKUP_OBJECT_LIST_INCOMPLETE');
  }while(token);
  return found.sort();
}
/** Logical snapshot: decrypt using the source KMS while quiescent, then include
 * these bytes in the encrypted recovery archive. Restore re-encrypts using an
 * independent target KMS. No source KMS credential is needed during recovery. */
export async function snapshotObjects(env){
  const client=await clientFor(env),bucket=env.UNAI_TEST_S3_BUCKET;
  try{
    const objects=[];
    for(const key of await keys(client,bucket)){
      const result=await client.send(new GetObjectCommand({Bucket:bucket,Key:key}));
      if(result.ServerSideEncryption!=='aws:kms'||result.SSEKMSKeyId!==env.UNAI_TEST_S3_KMS_KEY_ID)throw new Error('BACKUP_OBJECT_ENCRYPTION_INVALID');
      const bytes=Buffer.from(await result.Body.transformToByteArray());
      objects.push({key,digest:digest(bytes),bytes:bytes.toString('base64')});
    }
    return objects;
  }finally{client.destroy();}
}
export async function restoreObjects(env,objects){
  const client=await clientFor(env),bucket=env.UNAI_TEST_S3_BUCKET;
  try{
    if((await keys(client,bucket)).length)throw new Error('RESTORE_OBJECT_STORE_NOT_EMPTY');
    for(const object of objects){
      const bytes=Buffer.from(object.bytes,'base64');
      if(digest(bytes)!==object.digest)throw new Error('BACKUP_OBJECT_DIGEST_MISMATCH');
      await client.send(new PutObjectCommand({Bucket:bucket,Key:object.key,Body:bytes,ServerSideEncryption:'aws:kms',SSEKMSKeyId:env.UNAI_TEST_S3_KMS_KEY_ID,IfNoneMatch:'*'}));
    }
  }finally{client.destroy();}
  const after=await snapshotObjects(env);
  if(JSON.stringify(after)!==JSON.stringify(objects))throw new Error('RESTORED_OBJECTS_MISMATCH');
  return after.length;
}

