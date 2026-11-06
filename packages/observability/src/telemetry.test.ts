import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startTelemetry, type TelemetrySdkConfiguration} from './telemetry.js';

const endpoint={UNAI_OTEL_EXPORTER_OTLP_ENDPOINT:'https://collector.example.test:4318'};
const options={serviceName:'unai-api',version:'0.1.0'};
const sdk={start:vi.fn(),shutdown:vi.fn(async()=>{})};
const createSdk=vi.fn(async(_config:TelemetrySdkConfiguration)=>sdk);
let log:ReturnType<typeof vi.spyOn>;
beforeEach(()=>{vi.clearAllMocks();log=vi.spyOn(console,'info').mockImplementation(()=>{});});
afterEach(()=>vi.restoreAllMocks());
const start=(env:Readonly<Record<string,string|undefined>>={})=>startTelemetry({...options,env,createSdk});
const status=(value:string)=>JSON.stringify({event:'telemetry',status:value});

describe('telemetry configuration',()=>{
  it.each([{}, {OTEL_LOG_LEVEL:'debug'}, {UNAI_OTEL_EXPORTER_OTLP_ENDPOINT:''}])('does not load an SDK when disabled: %j',async env=>{
    const telemetry=await start(env);expect(telemetry.enabled).toBe(false);
    await telemetry.shutdown();await telemetry.shutdown();expect(createSdk).not.toHaveBeenCalled();
    expect(log.mock.calls).toEqual([[status('TELEMETRY_DISABLED')]]);
  });
  it('configures both signals and only the explicit resource',async()=>{
    expect((await start(endpoint)).enabled).toBe(true);
    expect(createSdk).toHaveBeenCalledExactlyOnceWith({tracesUrl:endpoint.UNAI_OTEL_EXPORTER_OTLP_ENDPOINT+'/v1/traces',
      metricsUrl:endpoint.UNAI_OTEL_EXPORTER_OTLP_ENDPOINT+'/v1/metrics',headers:{},metricIntervalMs:60000,
      resourceAttributes:{'service.name':'unai-api','service.version':'0.1.0','deployment.environment':'production','deployment.environment.name':'production'}});
    expect(sdk.start).toHaveBeenCalledTimes(1);expect(log.mock.calls).toEqual([[status('TELEMETRY_ENABLED')]]);
  });
  it.each(['/otlp','/otlp/','/otlp///'])('preserves path prefix %s',async path=>{
    await start({...endpoint,UNAI_OTEL_EXPORTER_OTLP_ENDPOINT:endpoint.UNAI_OTEL_EXPORTER_OTLP_ENDPOINT+path,
      UNAI_DEPLOYMENT_ENVIRONMENT:'staging',UNAI_OTEL_METRIC_EXPORT_MS:'15000'});
    expect(createSdk.mock.calls[0]?.[0]).toMatchObject({tracesUrl:endpoint.UNAI_OTEL_EXPORTER_OTLP_ENDPOINT+'/otlp/v1/traces',
      metricIntervalMs:15000,resourceAttributes:{'deployment.environment':'staging','deployment.environment.name':'staging'}});
  });
  it.each(['127.0.0.1','localhost','[::1]','127.1','2130706433'])('allows loopback http %s',async host=>{
    await start({UNAI_OTEL_EXPORTER_OTLP_ENDPOINT:`http://${host}:4318`});expect(createSdk).toHaveBeenCalledTimes(1);
  });
  it.each(['collector.example.test','0.0.0.0','localhost.example.test'])('refuses insecure remote %s',async host=>{
    await expect(start({UNAI_OTEL_EXPORTER_OTLP_ENDPOINT:`http://${host}:4318`})).rejects.toThrow(/^TELEMETRY_ENDPOINT_INSECURE$/);
    expect(createSdk).not.toHaveBeenCalled();
  });
  it.each(['not a url',' ','ftp://collector.example.test','https://user:pw-secret@collector.example.test',
    'https://collector.example.test/?token=tok-secret','https://collector.example.test/#f',
    'https://collector.example.test/?','https://collector.example.test/#'])('refuses invalid endpoint %#',async value=>{
    await expect(start({UNAI_OTEL_EXPORTER_OTLP_ENDPOINT:value})).rejects.toThrow(/^TELEMETRY_ENDPOINT_INVALID$/);
    expect(createSdk).not.toHaveBeenCalled();expect(log).not.toHaveBeenCalled();
  });
  it.each(['OTEL_EXPORTER_OTLP_HEADERS','OTEL_SDK_DISABLED','OTEL_LOG_LEVEL'])('refuses ambient %s',async name=>{
    await expect(start({...endpoint,[name]:''})).rejects.toThrow(/^TELEMETRY_OTEL_VARIABLES_REFUSED$/);
    expect(createSdk).not.toHaveBeenCalled();
  });
  it.each(['0','999','3600001','1.5','abc','99999999999999999999',' '])('refuses interval %s',async value=>{
    await expect(start({...endpoint,UNAI_OTEL_METRIC_EXPORT_MS:value})).rejects.toThrow(/^TELEMETRY_METRIC_INTERVAL_INVALID$/);
  });
  it.each(['1000','3600000',''])('accepts interval %s',async value=>{
    await start({...endpoint,UNAI_OTEL_METRIC_EXPORT_MS:value});
    expect(createSdk.mock.calls[0]?.[0].metricIntervalMs).toBe(value?Number(value):60000);
  });
  it.each(['Prod','prod env','-x','x'.repeat(64)])('refuses environment %s',async value=>{
    await expect(start({...endpoint,UNAI_DEPLOYMENT_ENVIRONMENT:value})).rejects.toThrow(/^TELEMETRY_ENVIRONMENT_INVALID$/);
  });
});

describe('telemetry secret headers and lifecycle',()=>{
  it('refuses literal headers without exposing the value',async()=>{
    await expect(startTelemetry({...options,env:{...endpoint,UNAI_OTEL_EXPORTER_OTLP_HEADERS:'hdr-secret'},
      secrets:{resolve:vi.fn()},createSdk})).rejects.toThrow(/^SECRET_HANDLE_REQUIRED:UNAI_OTEL_EXPORTER_OTLP_HEADERS$/);
    expect(createSdk).not.toHaveBeenCalled();expect(log).not.toHaveBeenCalled();
  });
  it('resolves mounted headers and decodes values',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'unai-otel-'));
    try{
      await writeFile(join(dir,'otel-headers'),'Authorization=Bearer%20hdr-secret, x-team = unai');
      await start({...endpoint,UNAI_SECRETS_MOUNT:dir,UNAI_OTEL_EXPORTER_OTLP_HEADERS:'secret://mounted/otel-headers'});
      expect(createSdk.mock.calls[0]?.[0].headers).toEqual({Authorization:'Bearer hdr-secret','x-team':'unai'});
      expect(JSON.stringify(log.mock.calls)).not.toContain('hdr-secret');
    }finally{await rm(dir,{recursive:true,force:true});}
  });
  it.each(['','novalue','bad name=x','a=','a=%0D%0Ainjected','a=%00','a=%7F','a=1,A=2','a=%E0%A4%A'])('refuses malformed header list %#',async value=>{
    await expect(startTelemetry({...options,env:{...endpoint,UNAI_OTEL_EXPORTER_OTLP_HEADERS:'secret://mounted/otel-headers'},
      secrets:{resolve:async()=>value},createSdk})).rejects.toThrow(/^TELEMETRY_HEADERS_INVALID$/);
    expect(createSdk).not.toHaveBeenCalled();expect(log).not.toHaveBeenCalled();
  });
  it('memoises concurrent and repeated shutdown',async()=>{
    const telemetry=await start(endpoint);await Promise.all([telemetry.shutdown(),telemetry.shutdown()]);await telemetry.shutdown();
    expect(sdk.shutdown).toHaveBeenCalledTimes(1);
  });
  it.each(['reject','throw'])('suppresses raw shutdown %s',async mode=>{
    sdk.shutdown.mockImplementationOnce(()=>{if(mode==='throw')throw new Error('raw-shutdown-text');return Promise.reject(new Error('raw-shutdown-text'));});
    const telemetry=await start(endpoint);await Promise.all([telemetry.shutdown(),telemetry.shutdown()]);
    expect(sdk.shutdown).toHaveBeenCalledTimes(1);
    expect(log.mock.calls).toEqual([[status('TELEMETRY_ENABLED')],[status('TELEMETRY_SHUTDOWN_FAILED')]]);
  });
  it.each(['create','start'])('suppresses raw %s failure',async mode=>{
    const fail=()=>{throw new Error('raw-start-text');};
    if(mode==='start')sdk.start.mockImplementationOnce(fail);else createSdk.mockImplementationOnce(fail);
    await expect(start(endpoint)).rejects.toThrow(/^TELEMETRY_START_FAILED$/);expect(log).not.toHaveBeenCalled();
  });
});

// No import of ./index.js until the SDK has installed the meter provider.
import {createServer, type IncomingHttpHeaders} from 'node:http';
import {context, metrics, propagation, trace} from '@opentelemetry/api';
type Attribute={key:string;value:{stringValue?:string}};
type Signal={resource:{attributes:Attribute[]};scopeSpans?:{scope:{name:string};spans:{name:string}[]}[];
  scopeMetrics?:{scope:{name:string};metrics:{name:string}[]}[]};
type ExportBody={resourceSpans?:Signal[];resourceMetrics?:Signal[]};
function attributes(signal:Signal){return Object.fromEntries(signal.resource.attributes.map(a=>[a.key,a.value.stringValue]));}

it('exports real spans and pipeline metrics, never foreign scopes or detected resources',async()=>{
  const requests:{url:string;method:string;headers:IncomingHttpHeaders;body:string}[]=[];
  const receiver=createServer((req,res)=>{
    let body='';req.setEncoding('utf8');req.on('data',(chunk:string)=>{body+=chunk;});
    req.on('end',()=>{requests.push({url:req.url??'',method:req.method??'',headers:req.headers,body});
      res.writeHead(200,{'content-type':'application/json'});res.end('{}');});
  });
  const dir=await mkdtemp(join(tmpdir(),'unai-otel-'));
  let telemetry:Awaited<ReturnType<typeof startTelemetry>>|undefined;
  try{
    await new Promise<void>(resolve=>receiver.listen(0,'127.0.0.1',resolve));
    const address=receiver.address();if(!address||typeof address==='string')throw new Error('TEST_LISTENER_FAILED');
    await writeFile(join(dir,'otel-headers'),'authorization=Bearer%20e2e-token');
    telemetry=await startTelemetry({serviceName:'unai-test',version:'0.1.0',env:{
      UNAI_OTEL_EXPORTER_OTLP_ENDPOINT:`http://127.0.0.1:${address.port}`,UNAI_SECRETS_MOUNT:dir,
      UNAI_OTEL_EXPORTER_OTLP_HEADERS:'secret://mounted/otel-headers',UNAI_DEPLOYMENT_ENVIRONMENT:'test'}});
    vi.resetModules();const {traceStage}=await import('./index.js');
    await traceStage('evidence.persist',{ownerScopeId:'01900000-0000-7000-8000-000000000001',
      correlationId:'01900000-0000-7000-8000-000000000002'},async()=>1);
    trace.getTracer('next.js').startSpan('GET /ask',{attributes:{'http.target':'/ask?q=private-question'}}).end();
    metrics.getMeter('next.js').createCounter('next.requests').add(1);
    await telemetry.shutdown();
    expect(requests.map(r=>r.url)).toEqual(expect.arrayContaining(['/v1/traces','/v1/metrics']));
    for(const r of requests){expect(r.method).toBe('POST');expect(r.headers.authorization).toBe('Bearer e2e-token');
      expect(r.headers['content-type']).toContain('application/json');}
    const signals=requests.flatMap(r=>{const body=JSON.parse(r.body) as ExportBody;return [...body.resourceSpans??[],...body.resourceMetrics??[]];});
    for(const signal of signals)expect(attributes(signal)).toEqual({'service.name':'unai-test','service.version':'0.1.0',
      'deployment.environment':'test','deployment.environment.name':'test'});
    const spans=signals.flatMap(s=>s.scopeSpans??[]),meters=signals.flatMap(s=>s.scopeMetrics??[]);
    for(const group of [...spans,...meters])expect(group.scope.name).toMatch(/^unai\./);
    expect(spans.flatMap(s=>s.spans.map(s=>s.name))).toContain('evidence.persist');
    expect(meters.flatMap(s=>s.metrics.map(m=>m.name))).toContain('unai.pipeline.duration');
    expect(requests.map(r=>r.body).join('')).not.toMatch(/private-question|next\.js|e2e-token/);
  }finally{
    await telemetry?.shutdown();trace.disable();metrics.disable();context.disable();propagation.disable();
    await new Promise<void>(resolve=>receiver.close(()=>resolve()));await rm(dir,{recursive:true,force:true});
  }
},180000);

import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import {SyntaxKind} from 'typescript/unstable/ast';
import {isImportDeclaration,isStringLiteral} from 'typescript/unstable/ast/is';
import {API} from 'typescript/unstable/sync';
const entries=[
  ['packages/api/src/server.ts','CONFIG_REQUIRED:UNAI_SECRETS_MOUNT','.'],
  ['packages/api/src/processing-worker.ts','PROCESSING_CONFIGURATION_REQUIRED','.'],
  ['apps/web/server.ts','CONFIG_REQUIRED:NEXTAUTH_URL','apps/web'],
] as const;
it('starts telemetry before instrument-creating modules in all three entries',()=>{
  // TypeScript 7 parses only through its compiler service; the web entry belongs to the apps/web project.
  const root=resolve('.').replaceAll('\\','/'),api=new API({cwd:root});
  try{
    const snapshot=api.updateSnapshot({openProjects:[root+'/tsconfig.json',root+'/apps/web/tsconfig.json']});
    for(const [file] of entries){
      const source=readFileSync(file,'utf8'),path=root+'/'+file;
      const ast=snapshot.getDefaultProjectForFile(path)?.program.getSourceFile(path);
      if(!ast)throw new Error('ENTRY_NOT_IN_PROGRAM:'+file);
      for(const statement of ast.statements){
        if(!isImportDeclaration(statement)||statement.importClause?.phaseModifier===SyntaxKind.TypeKeyword)continue;
        const name=isStringLiteral(statement.moduleSpecifier)?statement.moduleSpecifier.text:'';
        expect(name.startsWith('node:')||name==='@unai/observability/telemetry',`${file}: static imports capture no-op meters`).toBe(true);
      }
      expect(source.match(/startTelemetry\(/g),`${file}: start exactly once`).toHaveLength(1);
      expect(source.indexOf('startTelemetry('),`${file}: start before dynamic imports`).toBeLessThan(source.indexOf('import('));
    }
  }finally{api.close();}
  const source=readFileSync('packages/observability/src/telemetry.ts','utf8');
  expect(source).not.toMatch(/from ['"]\.\/index|import\(['"]\.\/index/);
  expect([...source.matchAll(/['"](@unai\/[^'"]+)['"]/g)].map(m=>m[1])).toEqual(['@unai/secrets']);
},60000);
function spawnEntry(file:string,cwd:string,extra:Record<string,string>={}){
  return spawnSync(process.execPath,[resolve('node_modules/tsx/dist/cli.mjs'),resolve(file)],{
    cwd:resolve(cwd),encoding:'utf8',timeout:60000,
    env:{PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,TEMP:process.env.TEMP,NODE_ENV:'test',...extra},
  });
}
describe('real process startup',{timeout:180000},()=>{
  it.each(entries)('loads %s with telemetry disabled', (file,refusal,cwd)=>{
    const result=spawnEntry(file,cwd);
    expect(result.error).toBeUndefined();expect(result.status).toBe(1);
    expect(result.stdout.trim().split('\n')).toEqual([status('TELEMETRY_DISABLED')]);
    expect(result.stderr).toContain(refusal);expect(result.stderr).not.toMatch(/ERR_MODULE_NOT_FOUND|Cannot find module/);
  });
  it.each(entries)('loads %s with telemetry enabled', (file,refusal,cwd)=>{
    const result=spawnEntry(file,cwd,{UNAI_OTEL_EXPORTER_OTLP_ENDPOINT:'http://127.0.0.1:1'});
    expect(result.error).toBeUndefined();expect(result.status).toBe(1);
    expect(result.stdout.trim().split('\n')).toEqual([status('TELEMETRY_ENABLED')]);
    expect(result.stderr).toContain(refusal);expect(result.stdout+result.stderr).not.toMatch(/ECONNREFUSED|ERR_MODULE_NOT_FOUND|Cannot find module/);
  });
  it('refuses an insecure collector before worker configuration',()=>{
    const result=spawnEntry(entries[1][0],'.',{UNAI_OTEL_EXPORTER_OTLP_ENDPOINT:'http://collector.example.test:4318'});
    expect(result.status).toBe(1);expect(result.stderr).toContain('TELEMETRY_ENDPOINT_INSECURE');
    expect(result.stderr).not.toContain('PROCESSING_CONFIGURATION_REQUIRED');
  });
});
