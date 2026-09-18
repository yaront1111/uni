import {readFile} from 'node:fs/promises';
import {resolve,sep} from 'node:path';

/** Secrets-manager handles for runtime credentials.
 *
 * Deployment configuration carries a *handle* — a reference to a secret held by
 * the deployment's secrets manager — never the credential itself. A literal
 * password or client secret in an environment variable is refused rather than
 * silently accepted, so a credential cannot reach a process listing, a container
 * inspect output or a crash report through configuration.
 *
 * The provider registry keeps the manager independent of one secrets vendor: a
 * mounted provider covers Kubernetes projected secrets and Vault Agent files,
 * and a deployment on AWS Secrets Manager or Vault HTTP registers its own
 * provider at startup without changing any caller.
 */

const HANDLE=/^secret:\/\/([a-z][a-z0-9]{0,31})\/([A-Za-z0-9][A-Za-z0-9_.\-/]{0,255})(?:#([A-Za-z0-9][A-Za-z0-9_.-]{0,63}))?$/;

export interface SecretHandle {
  readonly provider:string;
  /** Reference within the provider. Never a credential, so it is safe to log. */
  readonly name:string;
  /** Field of a structured (JSON) secret, or null for the whole value. */
  readonly field:string|null;
}

/** Refuses anything that is not a handle, including a literal credential and any
 * reference that tries to escape its provider's namespace. */
export function parseSecretHandle(value:unknown):SecretHandle{
  if(typeof value!=='string')throw new Error('SECRET_HANDLE_INVALID');
  const match=HANDLE.exec(value);
  if(!match)throw new Error('SECRET_HANDLE_INVALID');
  const provider=match[1]!,name=match[2]!,field=match[3];
  if(name.split('/').some(segment=>segment===''||segment==='.'||segment==='..'))throw new Error('SECRET_HANDLE_INVALID');
  return Object.freeze({provider,name,field:field??null});
}

/** True for a well-formed handle. Use it to tell a handle from a literal value
 * without throwing. */
export function isSecretHandle(value:unknown):boolean{
  try{parseSecretHandle(value);return true;}catch{return false;}
}

export interface SecretsProvider {
  /** Returns the stored secret material for a reference, or null when absent. */
  read(name:string):Promise<string|null>;
}

export interface SecretsManager {
  /** Resolves a handle to its credential. Errors carry stable codes and the
   * handle only, never the resolved material. */
  resolve(handle:string):Promise<string>;
}

/** Reads secrets from a directory the deployment's secrets manager mounts
 * (Kubernetes projected volume, Vault Agent template, SOPS-decrypted mount). */
export function createMountedSecretsProvider(root:string):SecretsProvider{
  const base=resolve(root);
  return {
    async read(name){
      const path=resolve(base,name);
      // Defence in depth behind the handle syntax: never read outside the mount.
      if(path!==base&&!path.startsWith(base+sep))throw new Error('SECRET_HANDLE_INVALID');
      try{return await readFile(path,'utf8');}
      catch(error){
        if((error as NodeJS.ErrnoException).code==='ENOENT')return null;
        // Provider error text can quote file contents, so only a code escapes.
        throw new Error('SECRET_PROVIDER_FAILED');
      }
    },
  };
}

export function createSecretsManager(providers:Readonly<Record<string,SecretsProvider>>):SecretsManager{
  const registry=new Map(Object.entries(providers));
  if(registry.size===0)throw new Error('SECRET_PROVIDER_REQUIRED');
  return {
    async resolve(handle){
      const parsed=parseSecretHandle(handle);
      const provider=registry.get(parsed.provider);
      if(!provider)throw new Error('SECRET_PROVIDER_UNKNOWN:'+parsed.provider);
      const stored=await provider.read(parsed.name);
      if(stored===null)throw new Error('SECRET_UNAVAILABLE:'+parsed.provider+'/'+parsed.name);
      const value=parsed.field===null?stored.trim():jsonField(stored,parsed.field,parsed);
      if(value==='')throw new Error('SECRET_UNAVAILABLE:'+parsed.provider+'/'+parsed.name);
      return value;
    },
  };
}

function jsonField(stored:string,field:string,parsed:SecretHandle):string{
  let document:unknown;
  try{document=JSON.parse(stored);}catch{throw new Error('SECRET_NOT_STRUCTURED:'+parsed.provider+'/'+parsed.name);}
  if(typeof document!=='object'||document===null||Array.isArray(document)){
    throw new Error('SECRET_NOT_STRUCTURED:'+parsed.provider+'/'+parsed.name);
  }
  const value=(document as Record<string,unknown>)[field];
  if(typeof value!=='string'||value.trim()==='')throw new Error('SECRET_FIELD_MISSING:'+parsed.provider+'/'+parsed.name+'#'+field);
  return value.trim();
}

/** The default manager for a runtime service: secrets arrive on the mount named
 * by UNAI_SECRETS_MOUNT. A deployment using a different secrets manager passes
 * its own provider registry to createSecretsManager instead. */
export function createDefaultSecretsManager(env:Readonly<Record<string,string|undefined>>=process.env):SecretsManager{
  const mount=env.UNAI_SECRETS_MOUNT;
  if(!mount)throw new Error('CONFIG_REQUIRED:UNAI_SECRETS_MOUNT');
  return createSecretsManager({mounted:createMountedSecretsProvider(mount)});
}

/** Reads a credential whose configuration variable must hold a handle. */
export async function requireSecret(manager:SecretsManager,name:string,
  env:Readonly<Record<string,string|undefined>>=process.env):Promise<string>{
  const configured=env[name];
  if(!configured)throw new Error('CONFIG_REQUIRED:'+name);
  if(!isSecretHandle(configured))throw new Error('SECRET_HANDLE_REQUIRED:'+name);
  return manager.resolve(configured);
}
