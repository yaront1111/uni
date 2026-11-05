import {readFileSync} from 'node:fs';
import {request} from 'node:https';
import {createDatabasePool} from '@unai/postgres';
import {createAuthOptions,resolveSession,sessionToken} from '@unai/auth';
import {createDefaultSecretsManager,requireSecret} from '@unai/secrets';
import type {IncomingMessage} from 'node:http';
import type {TLSSocket} from 'node:tls';
export function required(name:string){const value=process.env[name];if(!value)throw new Error('CONFIG_REQUIRED:'+name);return value;}
/** Credentials are named by secrets-manager handle, so the web process reads the
 * sign-in secrets from the deployment's secrets manager and never from a literal
 * configuration value. */
let secrets:ReturnType<typeof createDefaultSecretsManager>|undefined;
function secret(name:string){return requireSecret(secrets??=createDefaultSecretsManager(),name);}
/** `server.ts` (under tsx) and Next's bundle each load their own copy of this
 * file, so the pool promise lives in one process-wide slot rather than a module
 * variable: one web process holds one auth pool (ADR 0043 D4). */
const POOL=Symbol.for('unai.web.authPool');
const shared=globalThis as unknown as Record<symbol,Promise<ReturnType<typeof createDatabasePool>>|undefined>;
export function authPool(){
  return shared[POOL]??=secret('UNAI_AUTH_DATABASE_URL')
    .then(url=>createDatabasePool(url,readFileSync(required('UNAI_DATABASE_CA_FILE'),'utf8')))
    .catch(error=>{delete shared[POOL];throw error;});
}
export async function authOptions(){
  const [clientSecret,sessionSecret]=await Promise.all([secret('GOOGLE_CLIENT_SECRET'),secret('NEXTAUTH_SECRET')]);
  return createAuthOptions(await authPool(),{clientId:googleClientId(required('GOOGLE_CLIENT_ID')),clientSecret,secret:sessionSecret});
}
export async function identity(req:IncomingMessage){
  if((req.socket as TLSSocket).encrypted!==true)throw new Error('TLS_REQUIRED');
  const token=sessionToken(req.headers.cookie);return token?resolveSession(await authPool(),token):null;
}
export function retryAfterHeader(value:string|string[]|undefined):string|null{
  return typeof value==='string'&&/^[0-9]{1,5}$/.test(value)&&value.trim()===value?value:null;
}
/** `maxResponseBytes` stays 1 MiB for every screen read; only the owner's export,
 * whose bundle carries raw evidence, is allowed a larger answer (ADR 0030 §9). */
export async function apiRequest(path:string,method:string,headers:Record<string,string>,body?:unknown,maxResponseBytes=1024*1024):Promise<{status:number;body:unknown;retryAfter:string|null;rateLimitBucket:'session'|'authentication'|null}>{
  const base=new URL(required('UNAI_API_ORIGIN'));
  if(base.protocol!=='https:'||base.username||base.password||base.pathname!=='/'||base.search||base.hash)throw new Error('API_TLS_CONFIG_INVALID');
  return new Promise((resolve,reject)=>{
    const encoded=body===undefined?undefined:JSON.stringify(body);
    const req=request(new URL(path,base),{method,ca:readFileSync(required('UNAI_API_CA_FILE')),rejectUnauthorized:true,
      headers:{...headers,...(encoded?{'content-type':'application/json','content-length':String(Buffer.byteLength(encoded))}:{})}},res=>{
      const chunks:Buffer[]=[];let bytes=0;
      res.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>maxResponseBytes){res.destroy();reject(new Error('API_RESPONSE_INVALID'));}else chunks.push(chunk);});
      res.on('error',()=>reject(new Error('API_UNAVAILABLE')));
      res.on('end',()=>{try{resolve({status:res.statusCode??502,body:JSON.parse(Buffer.concat(chunks).toString()),retryAfter:retryAfterHeader(res.headers['retry-after']),rateLimitBucket:rateLimitBucketHeader(res.headers['x-rate-limit-bucket'])});}catch{reject(new Error('API_RESPONSE_INVALID'));}});
    });
    req.setTimeout(15000,()=>req.destroy());req.on('error',()=>reject(new Error('API_UNAVAILABLE')));req.end(encoded);
  });
}
/** Refuses a Google OAuth client ID that has neither of Google's documented
 * shapes: `424911365001.apps.googleusercontent.com` (OpenID Connect docs) or
 * `1234567890-abc123def456.apps.googleusercontent.com` (GIS setup guide). An
 * unreplaced deploy placeholder such as deploy/env/web.env.example's
 * `<sign-in-client-id>.apps.googleusercontent.com` fails here, in `--check`'s
 * auth check and on every sign-in, because both call `authOptions()`. It is a
 * local pattern match, never a request to Google, and the value is never echoed. */
export function googleClientId(value:string):string{
  if(!/^[0-9]+(?:-[0-9a-z]+)?\.apps\.googleusercontent\.com$/.test(value))throw new Error('CONFIG_INVALID:GOOGLE_CLIENT_ID');
  return value;
}

import {createHash} from 'node:crypto';
function rateLimitBucketHeader(value:string|string[]|undefined):'session'|'authentication'|null{
  return value==='session'||value==='authentication'?value:null;
}
/** Shared by the tsx listener and Next's proxy bundle, just like the auth pool.
 * Only digests are retained; clearing at the cap fails open for earlier holds. */
const HOLDS=Symbol.for('unai.web.sessionHolds');
const sharedHolds=globalThis as unknown as Record<symbol,Map<string,number>|undefined>;
function sessionHolds():Map<string,number>{return sharedHolds[HOLDS]??=new Map<string,number>();}
export function holdSession(token:string,until:number):void{
  const holds=sessionHolds(),hash=createHash('sha256').update(token).digest('hex');
  if(!holds.has(hash)&&holds.size>=10_000)holds.clear();
  holds.set(hash,until);
}
export function heldSeconds(token:string,now:number):number|null{
  const holds=sessionHolds(),hash=createHash('sha256').update(token).digest('hex');
  const until=holds.get(hash);
  if(until!==undefined&&until>now)return Math.ceil((until-now)/1000);
  holds.delete(hash);return null;
}
