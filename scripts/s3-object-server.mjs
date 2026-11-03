import {createServer} from 'node:https';
import {createCipheriv, createDecipheriv, createHash, randomBytes} from 'node:crypto';
import {createSelfSignedCertificate} from './tls-certificate.mjs';

/** Disposable S3-compatible object server for `pnpm test` when the delivered
 * runner exposes no object store and no container daemon is reachable.
 *
 * It is a harness, exactly like the MinIO container it replaces: the suite still
 * exercises the production adapter over real TLS with real SigV4 credentials,
 * and every stored object is really encrypted at rest under the harness KMS root
 * key, so an SSE-KMS receipt cannot be produced without the key. It is not an
 * AWS implementation: it verifies the presented credential and payload digest
 * rather than recomputing the request signature, and it keeps ciphertext in
 * memory for the lifetime of one test run. Never point production at it.
 */
const DOCUMENT = '<?xml version="1.0" encoding="UTF-8"?>';
const SSE_ALGORITHM_HEADER = 'x-amz-server-side-encryption';
const SSE_KEY_HEADER = 'x-amz-server-side-encryption-aws-kms-key-id';

const XML_ENTITIES = {'<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;'};
const PART_MINIMUM_BYTES = 5 * 1024 * 1024;
const OBJECT_OPERATIONS = {PUT: 'PutObject', GET: 'GetObject', HEAD: 'HeadObject', DELETE: 'DeleteObject'};
const md5 = bytes => '"' + createHash('md5').update(bytes).digest('hex') + '"';

function escapeXml(value) {
  return value.replace(/[<>&"']/g, character => XML_ENTITIES[character]);
}
function unescapeXml(value) {
  return value.replace(/&(lt|gt|amp|quot|apos);/g, entity =>
    Object.keys(XML_ENTITIES).find(character => XML_ENTITIES[character] === entity));
}
/** The S3 operation a request names, decided before authentication so a test can
 * assert exactly what reached the server. Anything this harness does not serve
 * is `Unsupported` and answered 501. */
function operationOf(method, hasObjectKey, parameters) {
  const names = [...parameters.keys()];
  const only = (...allowed) => names.every(name => name === 'x-id' || allowed.includes(name));
  if (!hasObjectKey) {
    if (method === 'GET' && parameters.has('encryption')) return 'GetBucketEncryption';
    if (method === 'GET' && parameters.get('list-type') === '2') return 'ListObjectsV2';
    return 'Unsupported';
  }
  if (method === 'POST' && parameters.has('uploads') && only('uploads')) return 'CreateMultipartUpload';
  if (method === 'PUT' && parameters.has('partNumber') && parameters.has('uploadId') && only('partNumber', 'uploadId')) return 'UploadPart';
  if (method === 'POST' && parameters.has('uploadId') && only('uploadId')) return 'CompleteMultipartUpload';
  if (method === 'DELETE' && parameters.has('uploadId') && only('uploadId')) return 'AbortMultipartUpload';
  return only() ? OBJECT_OPERATIONS[method] ?? 'Unsupported' : 'Unsupported';
}
function sendXml(response, status, body, headers = {}) {
  response.writeHead(status, {...headers, 'content-type': 'application/xml', 'content-length': Buffer.byteLength(body)});
  response.end(body);
}
function sendError(response, status, code) {
  sendXml(response, status, `${DOCUMENT}<Error><Code>${code}</Code><Message>${code}</Message></Error>`);
}
/** aws-chunked framing: `<hex length>[;extension]\r\n<bytes>\r\n`, terminated by a zero chunk. */
function decodeChunked(body) {
  const parts = [];
  let offset = 0;
  while (offset < body.length) {
    const end = body.indexOf('\r\n', offset, 'ascii');
    if (end < 0) break;
    const size = Number.parseInt(body.toString('ascii', offset, end).split(';')[0], 16);
    if (!Number.isFinite(size)) throw new Error('S3_SERVER_CHUNK_INVALID');
    if (size === 0) break;
    parts.push(body.subarray(end + 2, end + 2 + size));
    offset = end + 2 + size + 2;
  }
  return Buffer.concat(parts);
}
function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('error', reject);
    request.on('end', () => {
      const body = Buffer.concat(chunks);
      const digest = String(request.headers['x-amz-content-sha256'] ?? '');
      try { resolve(digest.startsWith('STREAMING-') ? decodeChunked(body) : body); } catch (error) { reject(error); }
    });
  });
}

/** `credentials` replaces the random pair, so a second server can accept the
 * credential the SDK default chain already holds. `logOperations` records every
 * request's operation name in `operations`. `receiptOverrides[operation]`
 * replaces the key id a receipt names, modelling a store that encrypts under
 * another key; it is for tests only and empty by default. */
export async function startS3ObjectServer({bucket, kmsKeyId, own, credentials, logOperations = false}) {
  if (credentials !== undefined && !(typeof credentials?.accessKeyId === 'string' && credentials.accessKeyId
    && typeof credentials.secretAccessKey === 'string' && credentials.secretAccessKey)) throw new Error('S3_SERVER_CREDENTIALS_INVALID');
  const {key, certificate} = createSelfSignedCertificate();
  const accessKeyId = credentials?.accessKeyId ?? 'unai-test-' + randomBytes(8).toString('hex');
  const secretAccessKey = credentials?.secretAccessKey ?? randomBytes(32).toString('hex');
  const rootKey = randomBytes(32);
  const objects = new Map();
  /** uploadId -> {key, parts: Map<partNumber, {etag, size, sealed}>} */
  const uploads = new Map();
  const operations = [];
  const receiptOverrides = {};

  /** Envelope encryption: a fresh data key per object, wrapped under the KMS root key. */
  function encrypt(plaintext) {
    const dataKey = randomBytes(32), iv = randomBytes(12), wrapIv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', dataKey, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const wrapper = createCipheriv('aes-256-gcm', rootKey, wrapIv);
    const wrappedKey = Buffer.concat([wrapper.update(dataKey), wrapper.final()]);
    return {ciphertext, iv, tag: cipher.getAuthTag(), wrappedKey, wrapIv, wrapTag: wrapper.getAuthTag()};
  }
  function decrypt(object) {
    const unwrapper = createDecipheriv('aes-256-gcm', rootKey, object.wrapIv);
    unwrapper.setAuthTag(object.wrapTag);
    const dataKey = Buffer.concat([unwrapper.update(object.wrappedKey), unwrapper.final()]);
    const decipher = createDecipheriv('aes-256-gcm', dataKey, object.iv);
    decipher.setAuthTag(object.tag);
    return Buffer.concat([decipher.update(object.ciphertext), decipher.final()]);
  }
  function authenticated(request, body) {
    const credential = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/\d{8}\/[^/]+\/s3\/aws4_request,/
      .exec(String(request.headers.authorization ?? ''));
    if (credential?.[1] !== accessKeyId || !request.headers['x-amz-date']) return false;
    const digest = String(request.headers['x-amz-content-sha256'] ?? '');
    return !/^[0-9a-f]{64}$/.test(digest) || digest === createHash('sha256').update(body).digest('hex');
  }

  const encryptedWith = request =>
    request.headers[SSE_ALGORITHM_HEADER] === 'aws:kms' && request.headers[SSE_KEY_HEADER] === kmsKeyId;
  const receiptFor = operation => ({[SSE_ALGORITHM_HEADER]: 'aws:kms', [SSE_KEY_HEADER]: receiptOverrides[operation] ?? kmsKeyId});
  const uploadOf = (url, objectKey) => {
    const upload = uploads.get(url.searchParams.get('uploadId'));
    return upload?.key === objectKey ? upload : undefined;
  };
  const resultXml = (name, fields) => `${DOCUMENT}<${name} xmlns="http://s3.amazonaws.com/doc/2006-03-01/">`
    + Object.entries(fields).map(([field, value]) => `<${field}>${escapeXml(value)}</${field}>`).join('') + `</${name}>`;

  /** CreateMultipartUpload, UploadPart, CompleteMultipartUpload and AbortMultipartUpload,
   * with the S3 and MinIO rules a real bucket would apply. */
  function multipart(operation, request, response, body, url, objectKey) {
    const receipt = receiptFor(operation);
    if (operation === 'CreateMultipartUpload') {
      if (!encryptedWith(request)) return sendError(response, 400, 'InvalidArgument');
      const uploadId = randomBytes(16).toString('hex');
      uploads.set(uploadId, {key: objectKey, parts: new Map()});
      return sendXml(response, 200, resultXml('InitiateMultipartUploadResult', {Bucket: bucket, Key: objectKey, UploadId: uploadId}), receipt);
    }
    const upload = uploadOf(url, objectKey);
    if (!upload) return sendError(response, 404, 'NoSuchUpload');
    if (operation === 'AbortMultipartUpload') {
      uploads.delete(url.searchParams.get('uploadId'));
      response.writeHead(204);
      return response.end();
    }
    if (operation === 'UploadPart') {
      const partNumber = url.searchParams.get('partNumber');
      if (!/^[1-9][0-9]{0,4}$/.test(partNumber) || Number(partNumber) > 10000) return sendError(response, 400, 'InvalidArgument');
      const etag = md5(body);
      upload.parts.set(Number(partNumber), {etag, size: body.length, sealed: encrypt(body)});
      response.writeHead(200, {...receipt, etag, 'content-length': 0});
      return response.end();
    }
    const listed = [...body.toString('utf8').matchAll(/<Part>([\s\S]*?)<\/Part>/g)].map(([, part]) => ({
      number: Number(/<PartNumber>([0-9]+)<\/PartNumber>/.exec(part)?.[1]),
      etag: unescapeXml(/<ETag>([\s\S]*?)<\/ETag>/.exec(part)?.[1] ?? ''),
    }));
    if (!listed.length) return sendError(response, 400, 'MalformedXML');
    if (listed.some((part, index) => index && part.number <= listed[index - 1].number)) return sendError(response, 400, 'InvalidPartOrder');
    const parts = listed.map(part => upload.parts.get(part.number)?.etag === part.etag ? upload.parts.get(part.number) : undefined);
    if (parts.includes(undefined)) return sendError(response, 400, 'InvalidPart');
    if (parts.slice(0, -1).some(part => part.size < PART_MINIMUM_BYTES)) return sendError(response, 400, 'EntityTooSmall');
    if (request.headers['if-none-match'] === '*' && objects.has(objectKey)) return sendError(response, 412, 'PreconditionFailed');
    const whole = Buffer.concat(parts.map(part => decrypt(part.sealed)));
    objects.set(objectKey, encrypt(whole));
    uploads.delete(url.searchParams.get('uploadId'));
    return sendXml(response, 200, resultXml('CompleteMultipartUploadResult', {Bucket: bucket, Key: objectKey, ETag: md5(whole)}), receipt);
  }

  function route(request, response, body) {
    const url = new URL(request.url, 'https://127.0.0.1');
    const [, requestedBucket, ...rest] = url.pathname.split('/');
    const operation = operationOf(request.method, rest.join('/') !== '', url.searchParams);
    if (logOperations) operations.push(operation);
    if (!authenticated(request, body)) return sendError(response, 403, 'AccessDenied');
    const objectKey = rest.map(decodeURIComponent).join('/');
    if (requestedBucket !== bucket) return sendError(response, 404, 'NoSuchBucket');
    if (operation.endsWith('MultipartUpload') || operation === 'UploadPart') {
      return multipart(operation, request, response, body, url, objectKey);
    }
    if (request.method === 'GET' && url.searchParams.has('encryption') && !objectKey) {
      return sendXml(response, 200, `${DOCUMENT}<ServerSideEncryptionConfiguration><Rule>`
        + `<ApplyServerSideEncryptionByDefault><SSEAlgorithm>aws:kms</SSEAlgorithm>`
        + `<KMSMasterKeyID>${escapeXml(kmsKeyId)}</KMSMasterKeyID></ApplyServerSideEncryptionByDefault>`
        + `</Rule></ServerSideEncryptionConfiguration>`);
    }
    // Complete enumeration for the coordinated logical test backup. This
    // disposable store has no object versioning; deletion removes the object.
    if (request.method === 'GET' && !objectKey && url.searchParams.get('list-type') === '2') {
      const entries = [...objects.entries()].sort(([a], [b]) => a.localeCompare(b));
      return sendXml(response, 200, `${DOCUMENT}<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">`
        + `<Name>${escapeXml(bucket)}</Name><KeyCount>${entries.length}</KeyCount><IsTruncated>false</IsTruncated>`
        + entries.map(([key, value]) => `<Contents><Key>${escapeXml(key)}</Key><Size>${value.ciphertext.length}</Size></Contents>`).join('')
        + '</ListBucketResult>');
    }
    // The SDK marks object requests with `?x-id=<operation>`; every other query
    // selects an S3 feature (versioning, tagging, part listing) this harness does not serve.
    const unsupported = [...url.searchParams.keys()].filter(parameter => parameter !== 'x-id');
    if (!objectKey || unsupported.length) return sendError(response, 501, 'NotImplemented');
    const receipt = receiptFor(operation);
    if (request.method === 'PUT') {
      // The bucket refuses any write that is not explicitly encrypted with its own key.
      if (!encryptedWith(request)) return sendError(response, 400, 'InvalidArgument');
      if (request.headers['if-none-match'] === '*' && objects.has(objectKey)) {
        return sendError(response, 412, 'PreconditionFailed');
      }
      objects.set(objectKey, encrypt(body));
      response.writeHead(200, {...receipt, etag: md5(body), 'content-length': 0});
      return response.end();
    }
    if (request.method === 'GET' || request.method === 'HEAD') {
      const object = objects.get(objectKey);
      if (!object) return sendError(response, 404, 'NoSuchKey');
      const plaintext = decrypt(object);
      response.writeHead(200, {...receipt, 'content-type': 'application/octet-stream', 'content-length': plaintext.length});
      return request.method === 'HEAD' ? response.end() : response.end(plaintext);
    }
    // S3 answers 204 whether or not the key existed, so a retried deletion
    // succeeds exactly as the first one did.
    if (request.method === 'DELETE') {
      objects.delete(objectKey);
      response.writeHead(204);
      return response.end();
    }
    return sendError(response, 501, 'NotImplemented');
  }

  const server = createServer({key, cert: certificate}, (request, response) => {
    readBody(request)
      .then(body => route(request, response, body))
      .catch(() => sendError(response, 500, 'InternalError'));
  });
  const close=()=>new Promise((resolve,reject)=>{
    server.close(error=>{objects.clear();uploads.clear();rootKey.fill(0);error&&error.code!=='ERR_SERVER_NOT_RUNNING'?reject(error):resolve();});
    server.closeAllConnections();
  });
  // Register before listen: a failed or interrupted partial start still has an owner.
  own?.(close);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    certificate,
    endpoint: 'https://127.0.0.1:' + server.address().port,
    credentials: {accessKeyId, secretAccessKey},
    operations,
    receiptOverrides,
    get pendingUploads() { return uploads.size; },
    close,
  };
}
