import {readFileSync} from 'node:fs';
import {createDatabasePool} from '@unai/postgres';
import {createDefaultSecretsManager,requireSecret} from '@unai/secrets';
import {createPlatformApi} from './platform.js';
import {createEvidenceObjects} from './evidence.js';
function required(name:string){const value=process.env[name];if(!value)throw new Error('CONFIG_REQUIRED:'+name);return value;}
// Credentials arrive as secrets-manager handles; configuration holding a literal
// database URL is refused rather than started with.
const secrets=createDefaultSecretsManager();
const ca=readFileSync(required('UNAI_DATABASE_CA_FILE'),'utf8');
const appPool=createDatabasePool(await requireSecret(secrets,'UNAI_APP_DATABASE_URL'),ca);
const authPool=createDatabasePool(await requireSecret(secrets,'UNAI_AUTH_DATABASE_URL'),ca);
const evidenceObjects=await createEvidenceObjects({endpoint:required('UNAI_S3_ENDPOINT'),region:required('UNAI_S3_REGION'),bucket:required('UNAI_S3_BUCKET'),kmsKeyId:required('UNAI_S3_KMS_KEY_ID')});
const app=createPlatformApi({appPool,authPool,evidenceObjects,tls:{key:readFileSync(required('UNAI_API_TLS_KEY_FILE')),cert:readFileSync(required('UNAI_API_TLS_CERT_FILE'))}});
await app.listen({port:Number(process.env.UNAI_API_PORT??3443),host:process.env.UNAI_API_BIND??'127.0.0.1'});
process.on('SIGTERM',()=>{void app.close().then(()=>{evidenceObjects.close();return Promise.all([appPool.end(),authPool.end()]);});});
