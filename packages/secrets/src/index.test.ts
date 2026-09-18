import {mkdtemp,mkdir,writeFile,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {createDefaultSecretsManager,createMountedSecretsProvider,createSecretsManager,
  isSecretHandle,parseSecretHandle,requireSecret,type SecretsProvider} from './index.js';

let mount='';
const password='pg-password-value';
const databaseUrl='postgresql://unai_app:'+password+'@db.internal:5432/unai';
beforeAll(async()=>{
  mount=await mkdtemp(join(tmpdir(),'unai-secrets-'));
  await mkdir(join(mount,'runtime'),{recursive:true});
  await writeFile(join(mount,'runtime','app-database'),JSON.stringify({url:databaseUrl,unused:''}));
  await writeFile(join(mount,'runtime','nextauth-secret'),' session-signing-secret-32-characters \n');
  await writeFile(join(mount,'runtime','blank'),'   ');
  await writeFile(join(mount,'runtime','plain-text'),'not json at all');
});
afterAll(async()=>{await rm(mount,{recursive:true,force:true});});

function manager(){return createSecretsManager({mounted:createMountedSecretsProvider(mount)});}

it('parses a handle as a reference and never as a credential', () => {
  expect(parseSecretHandle('secret://mounted/runtime/app-database#url'))
    .toEqual({provider:'mounted',name:'runtime/app-database',field:'url'});
  expect(parseSecretHandle('secret://aws/unai/prod/api')).toEqual({provider:'aws',name:'unai/prod/api',field:null});
  expect(isSecretHandle('secret://mounted/runtime/nextauth-secret')).toBe(true);
});

it('refuses a literal credential in configuration', () => {
  // The whole point of the handle: a password pasted into deployment
  // configuration is rejected instead of quietly becoming the credential.
  for(const literal of [databaseUrl,'hunter2','',' ','secret://','secret:///name','http://vault/secret',
    'secret://Mounted/name','secret://mounted/','secret://mounted/../../etc/passwd','secret://mounted/a#',undefined,null,42]){
    expect(()=>parseSecretHandle(literal),String(literal)).toThrow('SECRET_HANDLE_INVALID');
    expect(isSecretHandle(literal)).toBe(false);
  }
});

it('resolves a whole secret and a field of a structured secret', async () => {
  expect(await manager().resolve('secret://mounted/runtime/app-database#url')).toBe(databaseUrl);
  expect(await manager().resolve('secret://mounted/runtime/nextauth-secret')).toBe('session-signing-secret-32-characters');
});

it('reports a missing, blank or malformed secret with a stable code and no material', async () => {
  await expect(manager().resolve('secret://mounted/runtime/absent')).rejects.toThrow('SECRET_UNAVAILABLE:mounted/runtime/absent');
  await expect(manager().resolve('secret://mounted/runtime/blank')).rejects.toThrow('SECRET_UNAVAILABLE:mounted/runtime/blank');
  await expect(manager().resolve('secret://mounted/runtime/plain-text#url')).rejects.toThrow('SECRET_NOT_STRUCTURED:mounted/runtime/plain-text');
  await expect(manager().resolve('secret://mounted/runtime/app-database#unused')).rejects.toThrow('SECRET_FIELD_MISSING:mounted/runtime/app-database#unused');
  await expect(manager().resolve('secret://vault/runtime/app-database')).rejects.toThrow('SECRET_PROVIDER_UNKNOWN:vault');
  for(const handle of ['secret://mounted/runtime/absent','secret://mounted/runtime/plain-text#url']){
    const error=await manager().resolve(handle).then(()=>new Error('resolved'),(thrown:Error)=>thrown);
    expect(error.message).not.toContain(password);
  }
});

it('stays independent of one secrets vendor through the provider registry', async () => {
  const reads:string[]=[];
  const vault:SecretsProvider={async read(name){reads.push(name);return JSON.stringify({url:databaseUrl});}};
  const mixed=createSecretsManager({mounted:createMountedSecretsProvider(mount),vault});
  expect(await mixed.resolve('secret://vault/unai/prod/database#url')).toBe(databaseUrl);
  expect(await mixed.resolve('secret://mounted/runtime/nextauth-secret')).toBe('session-signing-secret-32-characters');
  expect(reads).toEqual(['unai/prod/database']);
  expect(()=>createSecretsManager({})).toThrow('SECRET_PROVIDER_REQUIRED');
});

it('requires configuration to name a handle for every credential', async () => {
  const env={UNAI_APP_DATABASE_URL:'secret://mounted/runtime/app-database#url',UNAI_AUTH_DATABASE_URL:databaseUrl};
  expect(await requireSecret(manager(),'UNAI_APP_DATABASE_URL',env)).toBe(databaseUrl);
  await expect(requireSecret(manager(),'UNAI_AUTH_DATABASE_URL',env)).rejects.toThrow('SECRET_HANDLE_REQUIRED:UNAI_AUTH_DATABASE_URL');
  await expect(requireSecret(manager(),'UNAI_MISSING',env)).rejects.toThrow('CONFIG_REQUIRED:UNAI_MISSING');
});

it('keeps every runtime entrypoint reading credentials through a handle', async () => {
  const root=resolve(import.meta.dirname,'../../..');
  // A credential must never be read straight out of deployment configuration.
  const credentials=['UNAI_APP_DATABASE_URL','UNAI_AUTH_DATABASE_URL','NEXTAUTH_SECRET','GOOGLE_CLIENT_SECRET'];
  for(const entrypoint of ['packages/api/src/server.ts','apps/web/lib/server.ts']){
    const source=await readFile(resolve(root,entrypoint),'utf8');
    expect(source,entrypoint).toContain('@unai/secrets');
    for(const name of credentials){
      expect(source.includes("required('"+name+"')"),entrypoint+' reads '+name+' directly').toBe(false);
      if(source.includes(name))expect(source,entrypoint+' resolves '+name).toMatch(new RegExp("secret\\w*\\(\\s*(?:secrets,\\s*)?'"+name+"'",'i'));
    }
  }
});

it('builds the default mounted manager only when the mount is configured', async () => {
  expect(()=>createDefaultSecretsManager({})).toThrow('CONFIG_REQUIRED:UNAI_SECRETS_MOUNT');
  const configured=createDefaultSecretsManager({UNAI_SECRETS_MOUNT:mount});
  expect(await configured.resolve('secret://mounted/runtime/app-database#url')).toBe(databaseUrl);
});
