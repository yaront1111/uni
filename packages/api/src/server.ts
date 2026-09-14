import {readFileSync} from 'node:fs';
import {createDatabasePool} from '@unai/postgres';
import {createPlatformApi} from './platform.js';
function required(name:string){const value=process.env[name];if(!value)throw new Error('CONFIG_REQUIRED:'+name);return value;}
const ca=readFileSync(required('UNAI_DATABASE_CA_FILE'),'utf8');
const appPool=createDatabasePool(required('UNAI_APP_DATABASE_URL'),ca);
const authPool=createDatabasePool(required('UNAI_AUTH_DATABASE_URL'),ca);
const app=createPlatformApi({appPool,authPool,tls:{key:readFileSync(required('UNAI_API_TLS_KEY_FILE')),cert:readFileSync(required('UNAI_API_TLS_CERT_FILE'))}});
await app.listen({port:Number(process.env.UNAI_API_PORT??3443),host:process.env.UNAI_API_BIND??'127.0.0.1'});
process.on('SIGTERM',()=>{void app.close().then(()=>Promise.all([appPool.end(),authPool.end()]));});
