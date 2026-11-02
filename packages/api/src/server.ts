import {readFileSync} from 'node:fs';
import {startTelemetry} from '@unai/observability/telemetry';
// Workspace modules create instruments at evaluation time; metrics has no proxy.
// ESM evaluates static imports before this body, even beside a top-level await.
// Start the SDK first, then load application modules so meters are not permanent no-ops.
const telemetry=await startTelemetry({serviceName:'unai-api',version:'0.1.0'});
const {createDatabasePool,assertDatabaseEncryptionAtRest}=await import('@unai/postgres');
const {createDefaultSecretsManager,requireSecret}=await import('@unai/secrets');
const {createPlatformApi}=await import('./platform.js');
const {createEvidenceObjects}=await import('./evidence.js');
const {createConnectorRuntime}=await import('./connectors.js');
const {processingRelease}=await import('./processing-config.js');
function required(name:string){const value=process.env[name];if(!value)throw new Error('CONFIG_REQUIRED:'+name);return value;}
// Credentials arrive as secrets-manager handles; configuration holding a literal
// database URL is refused rather than started with.
const secrets=createDefaultSecretsManager();
const ca=readFileSync(required('UNAI_DATABASE_CA_FILE'),'utf8');
const appPool=createDatabasePool(await requireSecret(secrets,'UNAI_APP_DATABASE_URL'),ca);
const authPool=createDatabasePool(await requireSecret(secrets,'UNAI_AUTH_DATABASE_URL'),ca);
// The database must declare the encryption at rest its storage was provisioned
// with; the object store proves its own in createEvidenceObjects (CRT-SEC-08-A).
await assertDatabaseEncryptionAtRest(appPool);
const evidenceObjects=await createEvidenceObjects({endpoint:required('UNAI_S3_ENDPOINT'),region:required('UNAI_S3_REGION'),bucket:required('UNAI_S3_BUCKET'),kmsKeyId:required('UNAI_S3_KMS_KEY_ID')});
// The connector runtime is wired here and nowhere else: without it a deployment
// holds the read-only provider clients and the revocation call in the package but
// can reach neither, so a sync would answer CONNECTOR_CLIENT_UNSUPPORTED and a
// disconnect CONNECTOR_REVOCATION_UNAVAILABLE. The OAuth material stays a
// secret:// handle on the connector row; this passes the manager, not a token.
const app=createPlatformApi({appPool,authPool,evidenceObjects,...processingRelease(process.env),connectors:createConnectorRuntime(secrets),tls:{key:readFileSync(required('UNAI_API_TLS_KEY_FILE')),cert:readFileSync(required('UNAI_API_TLS_CERT_FILE'))}});
await app.listen({port:Number(process.env.UNAI_API_PORT??3443),host:process.env.UNAI_API_BIND??'127.0.0.1'});
let closing=false;
const close=()=>{
  if(closing)return;closing=true;
  void app.close().then(()=>{evidenceObjects.close();return Promise.all([appPool.end(),authPool.end()]);}).finally(()=>telemetry.shutdown());
};
process.on('SIGTERM',close);process.on('SIGINT',close);
