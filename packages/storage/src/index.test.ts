import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { S3Client, GetBucketEncryptionCommand, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import * as storage from './index.js';

const context = { actorId: randomUUID(), ownerScopeId: randomUUID(), purpose: 'evidence.read', correlationId: randomUUID() };
const id = randomUUID();
const configuration = { endpoint: 'https://storage.example.test', region: 'test', bucket: 'private-evidence', kmsKeyId: 'test-kms-key' };
const encryption = { ServerSideEncryptionConfiguration: { Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'aws:kms', KMSMasterKeyID: configuration.kmsKeyId } }] } };
afterEach(() => vi.restoreAllMocks());

it.each(['receipt', 'body'])('closes the object stream after a %s failure', async failure => {
  const consume = vi.fn(async () => { throw new Error('private/raw/object-key'); });
  const body = Object.assign(new Readable({ read() {} }), { transformToByteArray: consume });
  vi.spyOn(S3Client.prototype, 'send').mockImplementation((async (command: unknown) => {
    if (command instanceof GetBucketEncryptionCommand) return encryption;
    return { ServerSideEncryption: 'aws:kms',
      SSEKMSKeyId: failure === 'receipt' ? 'wrong-key' : configuration.kmsKeyId, Body: body };
  }) as never);
  const store = await factory()(configuration, async () => 'private/raw/object-key');
  try {
    await expect(store.get(context, id)).rejects.toThrow(/^STORAGE_OPERATION_FAILED$/);
    expect(consume).toHaveBeenCalledTimes(failure === 'receipt' ? 0 : 1);
    expect(body.destroyed).toBe(true);
  } finally { body.destroy(); store.close(); }
});

function factory() {
  const create = (storage as Record<string, unknown>).createEncryptedS3Store;
  expect(create, 'production S3 adapter must exist').toBeTypeOf('function');
  return create as typeof import('./index.js').createEncryptedS3Store;
}

it('refuses a non-TLS endpoint before calling the provider', async () => {
  const send = vi.spyOn(S3Client.prototype, 'send');
  await expect(factory()({ ...configuration, endpoint: 'http://storage.example.test' }, async () => 'private-key')).rejects.toThrow('STORAGE_CONFIGURATION_INVALID');
  expect(send).not.toHaveBeenCalled();
});

it('fails startup when bucket encryption does not match the configured KMS key', async () => {
  vi.spyOn(S3Client.prototype, 'send').mockResolvedValue({ ServerSideEncryptionConfiguration: { Rules: [] } } as never);
  await expect(factory()(configuration, async () => 'private-key')).rejects.toThrow('STORAGE_ENCRYPTION_REQUIRED');
});

it('writes with explicit KMS encryption and returns only the public ID', async () => {
  const commands: unknown[] = [];
  vi.spyOn(S3Client.prototype, 'send').mockImplementation((async (command: unknown) => {
    commands.push(command);
    if (command instanceof GetBucketEncryptionCommand) return encryption;
    return { ServerSideEncryption: 'aws:kms', SSEKMSKeyId: configuration.kmsKeyId };
  }) as never);
  const resolver = vi.fn(async () => 'private/raw/object-key');
  const store = await factory()(configuration, resolver);
  try {
    const result = await store.put(context, id, Buffer.from('private evidence'));
    expect(result).toEqual({ id });
    expect(JSON.stringify(result)).not.toContain('object-key');
    expect(resolver).toHaveBeenCalledWith(context, id, 'WRITE');
    expect(commands[1]).toBeInstanceOf(PutObjectCommand);
    expect((commands[1] as PutObjectCommand).input).toMatchObject({ Bucket: configuration.bucket, Key: 'private/raw/object-key',
      ServerSideEncryption: 'aws:kms', SSEKMSKeyId: configuration.kmsKeyId,IfNoneMatch:'*' });
  } finally { store.close(); }
});

it('does not contact S3 for an unauthorized object', async () => {
  const send = vi.spyOn(S3Client.prototype, 'send').mockResolvedValue(encryption as never);
  const store = await factory()(configuration, async () => null);
  send.mockClear();
  try {
    await expect(store.get(context, id)).rejects.toThrow('STORAGE_ACCESS_DENIED');
    expect(send).not.toHaveBeenCalled();
  } finally { store.close(); }
});

it('returns encrypted-object contents only after authorization and rejects provider key leakage', async () => {
  const send = vi.spyOn(S3Client.prototype, 'send').mockImplementation((async (command: unknown) => {
    if (command instanceof GetBucketEncryptionCommand) return encryption;
    if (command instanceof GetObjectCommand) return { ServerSideEncryption: 'aws:kms', SSEKMSKeyId: configuration.kmsKeyId,
      Body: { transformToByteArray: async () => Buffer.from('private evidence') } };
    throw new Error('private/raw/object-key');
  }) as never);
  const store = await factory()(configuration, async () => 'private/raw/object-key');
  try {
    expect(await store.get(context, id)).toEqual(Buffer.from('private evidence'));
    send.mockRejectedValue(new Error('private/raw/object-key') as never);
    await expect(store.get(context, id)).rejects.toThrow(/^STORAGE_OPERATION_FAILED$/);
  } finally { store.close(); }
});
