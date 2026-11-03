import {readFileSync} from 'node:fs';
import type {AddressInfo} from 'node:net';
import {runPreflight,startTelemetry,startupFailureCode} from '@unai/observability/telemetry';
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
  const {probeConfiguration,createProbeServer,cachedCheck,loggedWarnings}=await import('./probes.js');
  const {databaseCheck,registryReleaseCheck,databaseRoleCheck,encryptionAtRestCheck,objectStoreCheck,
    tlsCertificateCheck,secretsMountCheck,probePortCheck}=await import('./preflight.js');
  function required(name:string){const value=process.env[name];if(!value)throw new Error('CONFIG_REQUIRED:'+name);return value;}
  function once<T>(open:()=>T):()=>T{
    let cached=false,value:T;
    return ()=>{if(!cached){value=open();cached=true;}return value;};
  }
  // Credentials arrive as secrets-manager handles; configuration holding a literal
  // database URL is refused rather than started with.
  const rateLimits=once(()=>({
    perSessionPerMinute:parseRateLimit(process.env.UNAI_API_RATE_LIMIT_PER_MINUTE,'UNAI_API_RATE_LIMIT_PER_MINUTE',DEFAULT_RATE_LIMITS.perSessionPerMinute),
    authFailuresPerAddressPerMinute:parseRateLimit(process.env.UNAI_API_AUTH_FAILURE_RATE_LIMIT_PER_MINUTE,'UNAI_API_AUTH_FAILURE_RATE_LIMIT_PER_MINUTE',DEFAULT_RATE_LIMITS.authFailuresPerAddressPerMinute),
  }));
  const secretsManager=once(createDefaultSecretsManager);
  const databaseCa=once(()=>readFileSync(required('UNAI_DATABASE_CA_FILE'),'utf8'));
  const appDatabase=once(async()=>{
    const secrets=secretsManager(),ca=databaseCa();
    return createDatabasePool(await requireSecret(secrets,'UNAI_APP_DATABASE_URL'),ca);
  });
  const authDatabase=once(async()=>{
    const secrets=secretsManager(),ca=databaseCa();
    return createDatabasePool(await requireSecret(secrets,'UNAI_AUTH_DATABASE_URL'),ca);
  });
  const storageConfiguration=once(()=>({endpoint:required('UNAI_S3_ENDPOINT'),region:required('UNAI_S3_REGION'),bucket:required('UNAI_S3_BUCKET'),kmsKeyId:required('UNAI_S3_KMS_KEY_ID')}));
  const listenerTls=once(()=>({key:readFileSync(required('UNAI_API_TLS_KEY_FILE')),cert:readFileSync(required('UNAI_API_TLS_CERT_FILE'))}));
  if(process.argv.includes('--check')){
    const passed=await runPreflight({
      rate_limits:rateLimits,
      secrets:()=>{secretsManager();return secretsMountCheck(required('UNAI_SECRETS_MOUNT'))();},
      database:async()=>databaseCheck(await appDatabase())(),
      auth_database:async()=>databaseCheck(await authDatabase())(),
      database_role:async()=>databaseRoleCheck(await appDatabase())(),
      encryption_at_rest:async()=>encryptionAtRestCheck(await appDatabase())(),
      object_store:objectStoreCheck(()=>createEvidenceObjects(storageConfiguration())),
      registry_release:async()=>{const release=processingRelease(process.env);return registryReleaseCheck(await appDatabase(),release.registryReleaseId)();},
      tls_certificate:()=>{const tls=listenerTls();return tlsCertificateCheck(tls.key,tls.cert)();},
      probe_port:()=>{const config=probeConfiguration(process.env);return config?probePortCheck(config)():undefined;},
    });
    process.exitCode=passed?0:1;
    // A timed-out query must not keep pool.end() (and this one-shot check) alive.
    const exit=()=>process.stdout.write('',()=>process.exit());
    const deadline=setTimeout(exit,10_000);
    await Promise.all([appDatabase().then(pool=>pool.end(),()=>undefined),authDatabase().then(pool=>pool.end(),()=>undefined)]);
    await telemetry.shutdown();clearTimeout(deadline);exit();
  }else{
  const rateLimit=rateLimits();
  const appPool=await appDatabase();
  const authPool=await authDatabase();
  // The database must declare the encryption at rest its storage was provisioned
  // with; the object store proves its own in createEvidenceObjects (CRT-SEC-08-A).
  await assertDatabaseEncryptionAtRest(appPool);
  const storage=storageConfiguration();
  const evidenceObjects=await createEvidenceObjects(storage);
  // The connector runtime is wired here and nowhere else: without it a deployment
  // holds the read-only provider clients and the revocation call in the package but
  // can reach neither, so a sync would answer CONNECTOR_CLIENT_UNSUPPORTED and a
  // disconnect CONNECTOR_REVOCATION_UNAVAILABLE. The OAuth material stays a
  // secret:// handle on the connector row; this passes the manager, not a token.
  const release=processingRelease(process.env);
  const connectors=createConnectorRuntime(secretsManager());
  const tls=listenerTls();
  const app=createPlatformApi({appPool,authPool,evidenceObjects,rateLimit,...release,connectors,tls});
  const probeConfig=probeConfiguration(process.env);
  await app.listen({port:Number(process.env.UNAI_API_PORT??3443),host:process.env.UNAI_API_BIND??'127.0.0.1'});
  console.info(JSON.stringify({event:'listening',port:(app.server.address() as AddressInfo).port}));
  const probes=probeConfig && await createProbeServer({...probeConfig,checks:{
    database:databaseCheck(appPool),
    encryption_at_rest:encryptionAtRestCheck(appPool),
    object_store:cachedCheck(objectStoreCheck(()=>createEvidenceObjects(storage)),300_000,{primed:true}),
    registry_release:registryReleaseCheck(appPool,release.registryReleaseId),
    tls_certificate:loggedWarnings(tlsCertificateCheck(tls.key,tls.cert)),
  }});
  let closing=false;
  const close=()=>{
    if(closing)return;closing=true;
    void Promise.all([probes?.close(),app.close()]).then(()=>{evidenceObjects.close();return Promise.all([appPool.end(),authPool.end()]);}).finally(()=>telemetry.shutdown());
  };
  process.on('SIGTERM',close);process.on('SIGINT',close);
  }
} catch (error) {
  process.exitCode=1;
  process.stderr.write(JSON.stringify({event:'startup_failed',code:'API_STARTUP_FAILED',cause:startupFailureCode(error)?.code??'UNCLASSIFIED'})+'\n',()=>process.exit());
}
