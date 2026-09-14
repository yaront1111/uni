import {readFileSync} from 'node:fs';
import {request} from 'node:https';
import {createDatabasePool} from '@unai/postgres';
import {createAuthOptions,resolveSession,sessionToken} from '@unai/auth';
import type {IncomingMessage} from 'node:http';
import type {TLSSocket} from 'node:tls';
export function required(name:string){const value=process.env[name];if(!value)throw new Error('CONFIG_REQUIRED:'+name);return value;}
let pool:ReturnType<typeof createDatabasePool>|undefined;
export function authPool(){return pool??=createDatabasePool(required('UNAI_AUTH_DATABASE_URL'),readFileSync(required('UNAI_DATABASE_CA_FILE'),'utf8'));}
export function authOptions(){return createAuthOptions(authPool(),{clientId:required('GOOGLE_CLIENT_ID'),clientSecret:required('GOOGLE_CLIENT_SECRET'),secret:required('NEXTAUTH_SECRET')});}
export async function identity(req:IncomingMessage){
  if((req.socket as TLSSocket).encrypted!==true)throw new Error('TLS_REQUIRED');
  const token=sessionToken(req.headers.cookie);return token?resolveSession(authPool(),token):null;
}
export async function apiRequest(path:string,method:string,headers:Record<string,string>,body?:unknown):Promise<{status:number;body:unknown}>{
  const base=new URL(required('UNAI_API_ORIGIN'));
  if(base.protocol!=='https:'||base.username||base.password||base.pathname!=='/'||base.search||base.hash)throw new Error('API_TLS_CONFIG_INVALID');
  return new Promise((resolve,reject)=>{
    const encoded=body===undefined?undefined:JSON.stringify(body);
    const req=request(new URL(path,base),{method,ca:readFileSync(required('UNAI_API_CA_FILE')),rejectUnauthorized:true,
      headers:{...headers,...(encoded?{'content-type':'application/json','content-length':String(Buffer.byteLength(encoded))}:{})}},res=>{
      const chunks:Buffer[]=[];let bytes=0;
      res.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>1024*1024){res.destroy();reject(new Error('API_RESPONSE_INVALID'));}else chunks.push(chunk);});
      res.on('error',()=>reject(new Error('API_UNAVAILABLE')));
      res.on('end',()=>{try{resolve({status:res.statusCode??502,body:JSON.parse(Buffer.concat(chunks).toString())});}catch{reject(new Error('API_RESPONSE_INVALID'));}});
    });
    req.setTimeout(15000,()=>req.destroy());req.on('error',()=>reject(new Error('API_UNAVAILABLE')));req.end(encoded);
  });
}
