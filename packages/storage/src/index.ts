import { S3Client, GetBucketEncryptionCommand, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, type GetObjectCommandOutput } from '@aws-sdk/client-s3';
import { requestContextSchema, type RequestContext } from '@unai/domain';

export interface StorageConfiguration {
  endpoint: string;
  region: string;
  bucket: string;
  kmsKeyId: string;
}

export type AuthorizedKeyResolver = (context: RequestContext, publicId: string, operation: 'READ' | 'WRITE' | 'DELETE') => Promise<string | null>;

/** Credentials use the SDK credential chain, configured by the deployment identity system.
 * The resolver must perform application ownership AND purpose checks against canonical data.
 * Public API handlers return the public receipt, never the resolver's private key.
 */
export async function createEncryptedS3Store(configuration: StorageConfiguration, resolveKey: AuthorizedKeyResolver) {
  let endpoint: URL;
  try { endpoint = new URL(configuration.endpoint); } catch { throw new Error('STORAGE_CONFIGURATION_INVALID'); }
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
    || !configuration.region.trim() || !configuration.bucket.trim() || !configuration.kmsKeyId.trim()
    || typeof resolveKey !== 'function') throw new Error('STORAGE_CONFIGURATION_INVALID');
  const config = Object.freeze({ ...configuration });
  const client = new S3Client({ endpoint: endpoint.href, region: config.region, forcePathStyle: true, maxAttempts: 3,
    requestHandler: { connectionTimeout: 5000, requestTimeout: 30000 } });
  try {
    const result = await client.send(new GetBucketEncryptionCommand({ Bucket: config.bucket }));
    const rules = result.ServerSideEncryptionConfiguration?.Rules;
    if (rules?.length !== 1 || rules[0]?.ApplyServerSideEncryptionByDefault?.SSEAlgorithm !== 'aws:kms'
      || rules[0]?.ApplyServerSideEncryptionByDefault?.KMSMasterKeyID !== config.kmsKeyId) {
      throw new Error('STORAGE_ENCRYPTION_REQUIRED');
    }
  } catch {
    client.destroy();
    throw new Error('STORAGE_ENCRYPTION_REQUIRED');
  }
  let closed = false;
  async function keyFor(input: RequestContext, publicId: string, operation: 'READ' | 'WRITE' | 'DELETE') {
    if (closed) throw new Error('STORAGE_CLOSED');
    const context = Object.freeze(requestContextSchema.parse(input));
    if (!requestContextSchema.shape.actorId.safeParse(publicId).success) throw new Error('STORAGE_PUBLIC_ID_INVALID');
    let key: string | null;
    try { key = await resolveKey(context, publicId, operation); }
    catch { throw new Error('STORAGE_ACCESS_DENIED'); }
    if (!key || key === publicId || Buffer.byteLength(key) > 1024) throw new Error('STORAGE_ACCESS_DENIED');
    return key;
  }
  function encrypted(result: { ServerSideEncryption?: string | undefined; SSEKMSKeyId?: string | undefined }) {
    if (result.ServerSideEncryption !== 'aws:kms' || result.SSEKMSKeyId !== config.kmsKeyId) {
      throw new Error('STORAGE_ENCRYPTION_REQUIRED');
    }
  }
  return Object.freeze({
    async put(context: RequestContext, id: string, bytes: Uint8Array): Promise<Readonly<{ id: string }>> {
      const key = await keyFor(context, id, 'WRITE');
      try {
        const result = await client.send(new PutObjectCommand({ Bucket: config.bucket, Key: key, Body: bytes,
          ContentType: 'application/octet-stream', ServerSideEncryption: 'aws:kms', SSEKMSKeyId: config.kmsKeyId,IfNoneMatch:'*' }));
        encrypted(result);
        return Object.freeze({ id });
      } catch { throw new Error('STORAGE_OPERATION_FAILED'); }
    },
    async get(context: RequestContext, id: string): Promise<Uint8Array> {
      const key = await keyFor(context, id, 'READ');
      let body: GetObjectCommandOutput['Body'];
      try {
        const result = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }));
        body = result.Body;
        encrypted(result);
        if (!body) throw new Error('STORAGE_BODY_MISSING');
        return await body.transformToByteArray();
      } catch { throw new Error('STORAGE_OPERATION_FAILED'); }
      finally {
        // Rejected receipts leave unread Node HTTP streams holding a connection.
        if (body && 'destroy' in body && typeof body.destroy === 'function') {
          try { body.destroy(); } catch { /* Preserve the sanitized operation outcome. */ }
        }
      }
    },
    /** Delete one object, for the deletion cascade (PRD §30.7). The resolver
     * decides whether this context may delete it, exactly as for a read or a
     * write. S3 answers success whether or not the key still existed, so a
     * retried deletion is indistinguishable from the first. */
    async delete(context: RequestContext, id: string): Promise<void> {
      const key = await keyFor(context, id, 'DELETE');
      try { await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key })); }
      catch { throw new Error('STORAGE_OPERATION_FAILED'); }
    },
    close() { closed = true; client.destroy(); },
  });
}
