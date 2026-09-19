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

function escapeXml(value) {
  return value.replace(/[<>&"']/g, character =>
    ({'<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;'})[character]);
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

export async function startS3ObjectServer({bucket, kmsKeyId}) {
  const {key, certificate} = createSelfSignedCertificate();
  const accessKeyId = 'unai-test-' + randomBytes(8).toString('hex');
  const secretAccessKey = randomBytes(32).toString('hex');
  const rootKey = randomBytes(32);
  const objects = new Map();

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

  function route(request, response, body) {
    if (!authenticated(request, body)) return sendError(response, 403, 'AccessDenied');
    const url = new URL(request.url, 'https://127.0.0.1');
    const [, requestedBucket, ...rest] = url.pathname.split('/');
    const objectKey = rest.map(decodeURIComponent).join('/');
    if (requestedBucket !== bucket) return sendError(response, 404, 'NoSuchBucket');
    if (request.method === 'GET' && url.searchParams.has('encryption') && !objectKey) {
      return sendXml(response, 200, `${DOCUMENT}<ServerSideEncryptionConfiguration><Rule>`
        + `<ApplyServerSideEncryptionByDefault><SSEAlgorithm>aws:kms</SSEAlgorithm>`
        + `<KMSMasterKeyID>${escapeXml(kmsKeyId)}</KMSMasterKeyID></ApplyServerSideEncryptionByDefault>`
        + `</Rule></ServerSideEncryptionConfiguration>`);
    }
    // The SDK marks object requests with `?x-id=<operation>`; every other query
    // selects an S3 feature (multipart, versioning, tagging) this harness does not serve.
    const unsupported = [...url.searchParams.keys()].filter(parameter => parameter !== 'x-id');
    if (!objectKey || unsupported.length) return sendError(response, 501, 'NotImplemented');
    const receipt = {[SSE_ALGORITHM_HEADER]: 'aws:kms', [SSE_KEY_HEADER]: kmsKeyId};
    if (request.method === 'PUT') {
      // The bucket refuses any write that is not explicitly encrypted with its own key.
      if (request.headers[SSE_ALGORITHM_HEADER] !== 'aws:kms' || request.headers[SSE_KEY_HEADER] !== kmsKeyId) {
        return sendError(response, 400, 'InvalidArgument');
      }
      if (request.headers['if-none-match'] === '*' && objects.has(objectKey)) {
        return sendError(response, 412, 'PreconditionFailed');
      }
      objects.set(objectKey, encrypt(body));
      response.writeHead(200, {...receipt, etag: '"' + createHash('md5').update(body).digest('hex') + '"', 'content-length': 0});
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
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    certificate,
    endpoint: 'https://127.0.0.1:' + server.address().port,
    credentials: {accessKeyId, secretAccessKey},
    close() { server.close(); server.closeAllConnections(); objects.clear(); },
  };
}
