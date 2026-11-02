import {afterAll, expect, it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {startupFailureCode} from './telemetry.js';
import {processingConfiguration} from '../../api/src/processing-config.js';

const directory=mkdtempSync(join(tmpdir(),'unai-startup-'));
const sentinel='sentinel-'+randomUUID();
afterAll(()=>rmSync(directory,{recursive:true,force:true}));

it.each([
  [new Error('CONFIG_REQUIRED:UNAI_SECRETS_MOUNT'),{code:'CONFIG_REQUIRED:UNAI_SECRETS_MOUNT',variable:'UNAI_SECRETS_MOUNT'}],
  [new Error('PROCESSING_CONFIGURATION_REQUIRED:UNAI_REGISTRY_RELEASE_ID'),{code:'PROCESSING_CONFIGURATION_REQUIRED:UNAI_REGISTRY_RELEASE_ID',variable:'UNAI_REGISTRY_RELEASE_ID'}],
  [new Error('CONFIG_REQUIRED:NEXTAUTH_URL'),{code:'CONFIG_REQUIRED:NEXTAUTH_URL',variable:'NEXTAUTH_URL'}],
  [new Error('CONFIG_REQUIRED:GOOGLE_CLIENT_ID'),{code:'CONFIG_REQUIRED:GOOGLE_CLIENT_ID',variable:'GOOGLE_CLIENT_ID'}],
  [new Error('TELEMETRY_ENDPOINT_INSECURE'),{code:'TELEMETRY_ENDPOINT_INSECURE',variable:null}],
  [new Error('SECRET_UNAVAILABLE:mounted/runtime/app-database'),{code:'SECRET_UNAVAILABLE',variable:null}],
  [new Error('CONFIG_INVALID:SK_LIVE_VALUE'),{code:'CONFIG_INVALID',variable:null}],
  [new Error('CONFIG_REQUIRED:UNAI_X:extra'),{code:'CONFIG_REQUIRED',variable:null}],
  [Object.assign(new Error('listen EADDRINUSE: address already in use 127.0.0.1:3443'),{code:'EADDRINUSE'}),{code:'EADDRINUSE',variable:null}],
  [Object.assign(new TypeError('Invalid URL'),{code:'ERR_INVALID_URL'}),{code:'ERR_INVALID_URL',variable:null}],
  [Object.assign(new AggregateError([]),{code:'ECONNREFUSED'}),{code:'ECONNREFUSED',variable:null}],
  [Object.assign(new Error('raw tls text'),{code:'ERR_OSSL_PEM_NO_START_LINE'}),{code:'ERR_OSSL_PEM_NO_START_LINE',variable:null}],
  [{code:'EACCES'},{code:'EACCES',variable:null}],
  [{code:'path/with-secret'},null],
  [{code:123},null],
  [new Error('A'.repeat(65)),null],
  [Object.assign(new Error('password authentication failed for user "unai"'),{code:'28P01'}),null],
  [new Error('connect ECONNREFUSED 10.0.0.5:5432'),null],
  ['CONFIG_REQUIRED:UNAI_X',null],
  [undefined,null],
  [null,null],
  [new Error('x'.repeat(1_000_000)),null],
])('classifies only stable startup codes (%#)',(error,expected)=>{
  expect(startupFailureCode(error)).toEqual(expected);
});

it('strips the path from a real filesystem error',()=>{
  let failure:unknown;
  try{readFileSync(join(directory,sentinel,'ca.pem'));}catch(error){failure=error;}
  const classified=startupFailureCode(failure);
  expect(classified).toEqual({code:'ENOENT',variable:null});
  expect(JSON.stringify(classified)).not.toContain(sentinel);
});

const root=resolve(import.meta.dirname,'../../..');
const scope={
  UNAI_REGISTRY_RELEASE_ID:randomUUID(),UNAI_REGISTRY_RELEASE:'0.1.0',
  UNAI_PROCESSING_OWNER_SCOPE_ID:randomUUID(),UNAI_PROCESSING_ACTOR_ID:randomUUID(),
  UNAI_PROCESSING_DATA_PURPOSE:'MEMORY_EXTRACTION',UNAI_PROCESSING_MAXIMUM_SENSITIVITY:'NORMAL',
};
const model={...scope,UNAI_SECRETS_MOUNT:directory,UNAI_MODEL_PROVIDER:'anthropic',
  UNAI_MODEL_ENDPOINT:'https://model.example.test',UNAI_MODEL_ID:'claude-sonnet-5-5'};
const modelKey='model-key-'+randomUUID();
writeFileSync(join(directory,'model-key'),modelKey);
const missingCa=join(directory,sentinel,'ca.pem');
type Failure={event:'startup_failed';code:string;variable?:string|null;cause?:string};

function spawnFailure(entry:string,configuration:Record<string,string>,expected:Failure,args:string[]=[]){
  const web=entry==='apps/web/server.ts';
  const result=spawnSync(process.execPath,[join(root,'node_modules/tsx/dist/cli.mjs'),web?'server.ts':join(root,entry),...args],{
    cwd:web?join(root,'apps/web'):root,encoding:'utf8',timeout:120000,
    env:{PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,TEMP:process.env.TEMP,NODE_ENV:'test',...configuration},
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(result.stderr).toBe(JSON.stringify(expected)+'\n');
  expect(result.stderr).not.toContain('    at ');
  expect(result.stdout+result.stderr).not.toContain(sentinel);
  expect(result.stdout+result.stderr).not.toContain(modelKey);
  expect(result.stdout).not.toContain('"event":"listening"');
}

it.each(Object.keys(scope))('names the missing processing variable %s',name=>{
  const configuration:NodeJS.ProcessEnv={NODE_ENV:'test',...scope};delete configuration[name];
  expect(()=>processingConfiguration(configuration)).toThrow('PROCESSING_CONFIGURATION_REQUIRED:'+name);
});

it.each([
  [{},'PROCESSING_CONFIGURATION_REQUIRED:UNAI_REGISTRY_RELEASE_ID','UNAI_REGISTRY_RELEASE_ID'],
  [model,'CONFIG_REQUIRED:UNAI_MODEL_API_KEY','UNAI_MODEL_API_KEY'],
  [{...model,UNAI_MODEL_API_KEY:'secret://mounted/model-key',UNAI_MODEL_INPUT_MICROUNITS_PER_1K:'2000',
    UNAI_MODEL_OUTPUT_MICROUNITS_PER_1K:'10000',UNAI_DATABASE_CA_FILE:missingCa},'ENOENT',null],
] satisfies [Record<string,string>,string,string|null][])('reports one worker startup failure (%#)',(configuration,code,variable)=>{
  spawnFailure('packages/api/src/processing-worker.ts',configuration,{event:'startup_failed',code,variable});
},180000);

it('keeps worker --check failure semantics',()=>{
  spawnFailure('packages/api/src/processing-worker.ts',{},
    {event:'startup_failed',code:'PROCESSING_CONFIGURATION_REQUIRED:UNAI_REGISTRY_RELEASE_ID',variable:'UNAI_REGISTRY_RELEASE_ID'},['--check']);
},180000);

it.each([
  [{},'CONFIG_REQUIRED:UNAI_SECRETS_MOUNT'],
  [{UNAI_SECRETS_MOUNT:directory,UNAI_DATABASE_CA_FILE:missingCa},'ENOENT'],
] satisfies [Record<string,string>,string][])('reports one API startup failure (%#)',(configuration,cause)=>{
  spawnFailure('packages/api/src/server.ts',configuration,{event:'startup_failed',code:'API_STARTUP_FAILED',cause});
},180000);

it('logs the bound API port once after listening',()=>{
  const source=readFileSync(join(root,'packages/api/src/server.ts'),'utf8');
  expect(source.match(/event:\s*['"]listening['"]/g)).toHaveLength(1);
  expect(source.search(/event:\s*['"]listening['"]/)).toBeGreaterThan(source.indexOf('app.listen('));
  expect(source).toContain('app.server.address()');
});

it.each([
  [{},'CONFIG_REQUIRED:NEXTAUTH_URL'],
  [{NEXTAUTH_URL:'https://web.test:8443',UNAI_WEB_TLS_KEY_FILE:join(directory,sentinel,'key.pem'),
    UNAI_WEB_TLS_CERT_FILE:join(directory,sentinel,'cert.pem')},'ENOENT'],
  [{NEXTAUTH_URL:'invalid-'+sentinel},'ERR_INVALID_URL'],
] satisfies [Record<string,string>,string][])('reports one web startup failure (%#)',(configuration,cause)=>{
  spawnFailure('apps/web/server.ts',configuration,{event:'startup_failed',code:'WEB_STARTUP_FAILED',cause});
},180000);

it('preflights web TLS before Next prepares and awaits listen errors',()=>{
  const source=readFileSync(join(root,'apps/web/server.ts'),'utf8');
  for(const name of ['UNAI_WEB_TLS_KEY_FILE','UNAI_WEB_TLS_CERT_FILE']){
    expect(source.indexOf(name)).toBeLessThan(source.indexOf('next({'));
    expect(source.indexOf(name)).toBeLessThan(source.indexOf('app.prepare()'));
  }
  expect(source).toContain("server.once('error',reject)");
  expect(source).toContain("server.off('error',reject)");
  expect(source).toContain('await new Promise<void>');
});
