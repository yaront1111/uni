import {createPrivateKey,X509Certificate} from 'node:crypto';
import {constants} from 'node:fs';
import {access,stat} from 'node:fs/promises';
import {createServer} from 'node:net';
import {assertDatabaseEncryptionAtRest,assertDatabaseRoleSafe} from '@unai/postgres';

export type Database={query(text:string,values?:unknown[]):Promise<{rows:unknown[]}>};

export function databaseCheck(db:Database):()=>Promise<void>{
  return async()=>{await db.query('SELECT 1');};
}

export function registryReleaseCheck(db:Database,releaseId:string):()=>Promise<void>{
  return async()=>{
    const row=(await db.query('SELECT unai_private.registry_release_published($1) AS ok',[releaseId])).rows[0];
    if(!row||typeof row!=='object'||!('ok' in row)||row.ok!==true)throw new Error('PROBE_RELEASE_UNAVAILABLE');
  };
}

export function databaseRoleCheck(db:Database):()=>Promise<void>{
  return ()=>assertDatabaseRoleSafe(db);
}

export function encryptionAtRestCheck(pool:Parameters<typeof assertDatabaseEncryptionAtRest>[0]):()=>Promise<void>{
  return async()=>{await assertDatabaseEncryptionAtRest(pool);};
}

export function objectStoreCheck(open:()=>Promise<{close():void}>):()=>Promise<void>{
  return async()=>{(await open()).close();};
}

export function tlsCertificateCheck(key:string|Buffer,cert:string|Buffer,{clock=Date.now}:{clock?:()=>number}={}):()=>Promise<'TLS_CERT_EXPIRING'|undefined>{
  let leaf:X509Certificate,privateKey:ReturnType<typeof createPrivateKey>;
  try{leaf=new X509Certificate(cert);}catch{throw new Error('TLS_CERTIFICATE_INVALID');}
  try{privateKey=createPrivateKey(key);}catch{throw new Error('TLS_KEY_INVALID');}
  if(!leaf.checkPrivateKey(privateKey))throw new Error('TLS_KEY_MISMATCH');
  const expires=leaf.validToDate.getTime();
  if(!Number.isFinite(expires))throw new Error('TLS_CERTIFICATE_INVALID');
  return async()=>{
    const remaining=expires-clock();
    if(remaining<=0)throw new Error('TLS_CERT_EXPIRED');
    if(remaining<30*86400000)return 'TLS_CERT_EXPIRING';
  };
}

export function secretsMountCheck(mount:string):()=>Promise<void>{
  return async()=>{
    // Check the type first: X_OK on a regular file can otherwise hide ENOTDIR.
    if(!(await stat(mount)).isDirectory())throw Object.assign(new Error('ENOTDIR'),{code:'ENOTDIR'});
    await access(mount,constants.R_OK|constants.X_OK);
  };
}

export function probePortCheck({bind,port}:{bind:string;port:number}):()=>Promise<void>{
  return ()=>new Promise<void>((resolve,reject)=>{
    const server=createServer(socket=>socket.destroy());
    server.once('error',()=>reject(new Error('PROBE_LISTEN_FAILED')));
    server.listen(port,bind,()=>server.close(error=>error?reject(new Error('PROBE_LISTEN_FAILED')):resolve()));
  });
}
