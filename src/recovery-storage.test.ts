import {expect,it} from 'vitest';
import {createRequire} from 'node:module';
import {Agent} from 'node:https';
// @ts-expect-error JavaScript test harness.
import {startS3ObjectServer} from '../scripts/s3-object-server.mjs';
const {S3Client,ListObjectsV2Command,PutObjectCommand}=createRequire(new URL('../packages/storage/package.json',import.meta.url))('@aws-sdk/client-s3');
it('the fallback recovery snapshot enumerates every stored object without exposing plaintext',async()=>{
  const server=await startS3ObjectServer({bucket:'backup-test',kmsKeyId:'test-key'});
  const client=new S3Client({endpoint:server.endpoint,region:'us-east-1',forcePathStyle:true,credentials:server.credentials,
    requestHandler:{httpsAgent:new Agent({ca:server.certificate,rejectUnauthorized:true})}});
  try{
    expect((await client.send(new ListObjectsV2Command({Bucket:'backup-test'}))).Contents??[]).toEqual([]);
    await client.send(new PutObjectCommand({Bucket:'backup-test',Key:'private/a&b',Body:'private content',ServerSideEncryption:'aws:kms',SSEKMSKeyId:'test-key'}));
    const listing=await client.send(new ListObjectsV2Command({Bucket:'backup-test'}));
    expect(listing.Contents.map((item:{Key:string})=>item.Key)).toEqual(['private/a&b']);
    expect(JSON.stringify(listing)).not.toContain('private content');
  }finally{client.destroy();server.close();}
});
