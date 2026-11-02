import {readFileSync} from 'node:fs';
import type {AddressInfo} from 'node:net';
import {startTelemetry,startupFailureCode} from '@unai/observability/telemetry';
// Workspace modules create instruments at evaluation time; metrics has no proxy.
// ESM evaluates static imports before this body, even beside a top-level await.
// Start the SDK first, then load application modules so meters are not permanent no-ops.
try {
  const telemetry=await startTelemetry({serviceName:'unai-api',version:'0.1.0'});
  const {createDatabasePool,assertDatabaseEncryptionAtRest}=await import('@unai/postgres');
  const {createDefaultSecretsManager,requireSecret}=await import('@unai/secrets');
  const {createPlatformApi}=await import('./platform.js');
  const {createEvidenceObjects}=await import('./evidence.js');
  const {createConnectorRuntime}=await import('./connectors.js');
  const {processingRelease}=await import('./processing-config.js');
  const {DEFAULT_RATE_LIMITS,parseRateLimit}=await import('./rate-limit.js');
  const {probeConfiguration,createProbeServer,databaseCheck,registryReleaseCheck,cachedCheck,certificateCheck}=await import('./probes.js');
  function required(name:string){const value=process.env[name];if(!value)throw new Error('CONFIG_REQUIRED:'+name);return value;}
  // Credentials arrive as secrets-manager handles; configuration holding a literal
  // database URL is refused rather than started with.
  const rateLimit={
    perSessionPerMinute:parseRateLimit(process.env.UNAI_API_RATE_LIMIT_PER_MINUTE,'UNAI_API_RATE_LIMIT_PER_MINUTE',DEFAULT_RATE_LIMITS.perSessionPerMinute),
    authFailuresPerAddressPerMinute:parseRateLimit(process.env.UNAI_API_AUTH_FAILURE_RATE_LIMIT_PER_MINUTE,'UNAI_API_AUTH_FAILURE_RATE_LIMIT_PER_MINUTE',DEFAULT_RATE_LIMITS.authFailuresPerAddressPerMinute),
  };
  const secrets=createDefaultSecretsManager();
  const ca=readFileSync(required('UNAI_DATABASE_CA_FILE'),'utf8');
  const appPool=createDatabasePool(await requireSecret(secrets,'UNAI_APP_DATABASE_URL'),ca);
  const authPool=createDatabasePool(await requireSecret(secrets,'UNAI_AUTH_DATABASE_URL'),ca);
  // The database must declare the encryption at rest its storage was provisioned
  // with; the object store proves its own in createEvidenceObjects (CRT-SEC-08-A).
  await assertDatabaseEncryptionAtRest(appPool);
  const storage={endpoint:required('UNAI_S3_ENDPOINT'),region:required('UNAI_S3_REGION'),bucket:required('UNAI_S3_BUCKET'),kmsKeyId:required('UNAI_S3_KMS_KEY_ID')};
  const evidenceObjects=await createEvidenceObjects(storage);
  // The connector runtime is wired here and nowhere else: without it a deployment
  // holds the read-only provider clients and the revocation call in the package but
  // can reach neither, so a sync would answer CONNECTOR_CLIENT_UNSUPPORTED and a
  // disconnect CONNECTOR_REVOCATION_UNAVAILABLE. The OAuth material stays a
  // secret:// handle on the connector row; this passes the manager, not a token.
  const release=processingRelease(process.env);
  const connectors=createConnectorRuntime(secrets);
  const tls={key:readFileSync(required('UNAI_API_TLS_KEY_FILE')),cert:readFileSync(required('UNAI_API_TLS_CERT_FILE'))};
  const app=createPlatformApi({appPool,authPool,evidenceObjects,rateLimit,...release,connectors,tls});
  const probeConfig=probeConfiguration(process.env);
  await app.listen({port:Number(process.env.UNAI_API_PORT??3443),host:process.env.UNAI_API_BIND??'127.0.0.1'});
  console.info(JSON.stringify({event:'listening',port:(app.server.address() as AddressInfo).port}));
  const probes=probeConfig && await createProbeServer({...probeConfig,checks:{
    database:databaseCheck(appPool),
    encryption_at_rest:()=>assertDatabaseEncryptionAtRest(appPool),
    object_store:cachedCheck(async()=>(await createEvidenceObjects(storage)).close(),300_000,{primed:true}),
    registry_release:registryReleaseCheck(appPool,release.registryReleaseId),
    tls_certificate:certificateCheck(tls.cert),
  }});
  let closing=false;
  const close=()=>{
    if(closing)return;closing=true;
    void Promise.all([probes?.close(),app.close()]).then(()=>{evidenceObjects.close();return Promise.all([appPool.end(),authPool.end()]);}).finally(()=>telemetry.shutdown());
  };
  process.on('SIGTERM',close);process.on('SIGINT',close);
} catch (error) {
  process.exitCode=1;
  process.stderr.write(JSON.stringify({event:'startup_failed',code:'API_STARTUP_FAILED',cause:startupFailureCode(error)?.code??'UNCLASSIFIED'})+'\n',()=>process.exit());
}
