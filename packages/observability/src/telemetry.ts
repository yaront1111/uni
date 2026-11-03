import {createDefaultSecretsManager, requireSecret, type SecretsManager} from '@unai/secrets';
import type {core, metrics, tracing} from '@opentelemetry/sdk-node';

export type Telemetry={readonly enabled:boolean;shutdown():Promise<void>};
export type TelemetrySdkConfiguration={
  tracesUrl:string;metricsUrl:string;headers:Readonly<Record<string,string>>;
  resourceAttributes:Readonly<Record<string,string>>;metricIntervalMs:number;
};
type Sdk={start():void;shutdown():Promise<void>};
type Options={
  serviceName:string;version:string;env?:Readonly<Record<string,string|undefined>>;
  secrets?:SecretsManager;createSdk?:(config:TelemetrySdkConfiguration)=>Promise<Sdk>;
};
const OWN=/^unai\./;
const log=(status:string)=>console.info(JSON.stringify({event:'telemetry',status}));

/** Raw pg, AWS SDK, tls and fs text can carry hosts, paths or key material.
 * Only known variable prefixes may retain a suffix, never configured values. */
export function startupFailureCode(error:unknown):{code:string;variable:string|null}|null{
  const match=/^([A-Z][A-Z0-9_]{0,63})(?::((?:UNAI|NEXTAUTH|GOOGLE)_[A-Z0-9_]{1,64})$|:|$)/.exec(error instanceof Error?error.message:'');
  if(match){
    const variable=match[2]??null;
    return {code:match[1]!+(variable?':'+variable:''),variable};
  }
  if(typeof error==='object'&&error!==null&&'code' in error&&typeof error.code==='string'&&/^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)){
    return {code:error.code,variable:null};
  }
  return null;
}

export type PreflightCheck=()=>unknown|Promise<unknown>;

/** Sequential, bounded checks with the same safe output contract in every entry. */
export async function runPreflight(checks:Readonly<Record<string,PreflightCheck>>,{
  write=(line:string)=>process.stdout.write(line+'\n'),timeoutMs=10_000,
}:{write?:(line:string)=>void;timeoutMs?:number}={}):Promise<boolean>{
  let passed=true;
  for(const [check,run] of Object.entries(checks)){
    let timer:ReturnType<typeof setTimeout>|undefined;
    let status:'ok'|'warn'|'fail'='ok',code='OK';
    try{
      const result=await Promise.race([
        Promise.resolve().then(run),
        new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error('PREFLIGHT_CHECK_TIMEOUT')),timeoutMs);}),
      ]);
      if(typeof result==='string'){
        status='warn';code=/^[A-Z][A-Z0-9_]{0,63}$/.test(result)?result:'UNCLASSIFIED';
      }
    }catch(error){passed=false;status='fail';code=startupFailureCode(error)?.code??'UNCLASSIFIED';}
    finally{clearTimeout(timer);}
    write(JSON.stringify({check,status,code}));
  }
  return passed;
}

function endpointUrl(value:string):string{
  let url:URL;
  try{url=new URL(value);}catch{throw new Error('TELEMETRY_ENDPOINT_INVALID');}
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.href.includes('?')||url.href.includes('#')){
    throw new Error('TELEMETRY_ENDPOINT_INVALID');
  }
  const loopback=url.hostname==='localhost'||url.hostname==='[::1]'||/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(url.hostname);
  if(url.protocol==='http:'&&!loopback)throw new Error('TELEMETRY_ENDPOINT_INSECURE');
  return url.href.replace(/\/+$/,'')+'/';
}
function metricInterval(value:string|undefined):number{
  if(!value)return 60000;
  const interval=Number(value);
  if(!/^\d+$/.test(value)||interval<1000||interval>3600000)throw new Error('TELEMETRY_METRIC_INTERVAL_INVALID');
  return interval;
}
function deploymentEnvironment(value:string|undefined):string{
  if(!value)return 'production';
  if(!/^[a-z0-9][a-z0-9._-]{0,62}$/.test(value))throw new Error('TELEMETRY_ENVIRONMENT_INVALID');
  return value;
}
function parseHeaders(list:string):Readonly<Record<string,string>>{
  const headers:Record<string,string>=Object.create(null);
  const names=new Set<string>();
  for(const entry of list.split(',')){
    const separator=entry.indexOf('='),name=entry.slice(0,separator).trim();
    let value:string;
    try{value=decodeURIComponent(entry.slice(separator+1).trim());}catch{throw new Error('TELEMETRY_HEADERS_INVALID');}
    if(separator<1||!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)||!value||/[\u0000-\u001f\u007f]/.test(value)||names.has(name.toLowerCase())){
      throw new Error('TELEMETRY_HEADERS_INVALID');
    }
    names.add(name.toLowerCase());headers[name]=value;
  }
  return headers;
}

/** Import this subpath before any module that creates an instrument. No signals here. */
export async function startTelemetry(options:Options):Promise<Telemetry>{
  const env=options.env??process.env;
  const endpoint=env.UNAI_OTEL_EXPORTER_OTLP_ENDPOINT;
  if(!endpoint){log('TELEMETRY_DISABLED');return {enabled:false,shutdown:async()=>{}};}
  if(Object.keys(env).some(name=>name.startsWith('OTEL_')))throw new Error('TELEMETRY_OTEL_VARIABLES_REFUSED');
  const base=endpointUrl(endpoint);
  const metricIntervalMs=metricInterval(env.UNAI_OTEL_METRIC_EXPORT_MS);
  const environment=deploymentEnvironment(env.UNAI_DEPLOYMENT_ENVIRONMENT);
  let headers:Readonly<Record<string,string>>={};
  if(env.UNAI_OTEL_EXPORTER_OTLP_HEADERS){
    const manager=options.secrets??createDefaultSecretsManager(env);
    headers=parseHeaders(await requireSecret(manager,'UNAI_OTEL_EXPORTER_OTLP_HEADERS',env));
  }
  const config:TelemetrySdkConfiguration={tracesUrl:base+'v1/traces',metricsUrl:base+'v1/metrics',headers,metricIntervalMs,
    resourceAttributes:{'service.name':options.serviceName,'service.version':options.version,
      'deployment.environment':environment,'deployment.environment.name':environment}};
  let sdk:Sdk;
  try{sdk=await (options.createSdk??createNodeSdk)(config);sdk.start();}
  catch{throw new Error('TELEMETRY_START_FAILED');}
  log('TELEMETRY_ENABLED');
  let closing:Promise<void>|undefined;
  return {enabled:true,shutdown:()=>closing??=Promise.resolve().then(()=>sdk.shutdown()).catch(()=>{log('TELEMETRY_SHUTDOWN_FAILED');})};
}

function ownSpans(delegate:tracing.SpanExporter,success:core.ExportResultCode):tracing.SpanExporter{
  return {
    export(spans,done){
      const own=spans.filter(span=>OWN.test(span.instrumentationScope.name));
      if(own.length)delegate.export(own,done);else done({code:success});
    },
    shutdown:()=>delegate.shutdown(),
    ...(delegate.forceFlush?{forceFlush:delegate.forceFlush.bind(delegate)}:{}),
  };
}
function ownMetrics(delegate:metrics.PushMetricExporter,success:core.ExportResultCode):metrics.PushMetricExporter{
  return {
    export(batch,done){
      const scopeMetrics=batch.scopeMetrics.filter(scope=>OWN.test(scope.scope.name));
      if(scopeMetrics.length)delegate.export({...batch,scopeMetrics},done);else done({code:success});
    },
    shutdown:()=>delegate.shutdown(),forceFlush:()=>delegate.forceFlush(),
    ...(delegate.selectAggregationTemporality?{selectAggregationTemporality:delegate.selectAggregationTemporality.bind(delegate)}:{}),
    ...(delegate.selectAggregation?{selectAggregation:delegate.selectAggregation.bind(delegate)}:{}),
  };
}
async function createNodeSdk(config:TelemetrySdkConfiguration):Promise<Sdk>{
  const [{NodeSDK,core,metrics,resources},{OTLPTraceExporter},{OTLPMetricExporter}]=await Promise.all([
    import('@opentelemetry/sdk-node'),import('@opentelemetry/exporter-trace-otlp-http'),import('@opentelemetry/exporter-metrics-otlp-http'),
  ]);
  return new NodeSDK({
    resource:resources.resourceFromAttributes(config.resourceAttributes),autoDetectResources:false,
    instrumentations:[],textMapPropagator:null,logRecordProcessors:[],
    traceExporter:ownSpans(new OTLPTraceExporter({url:config.tracesUrl,headers:{...config.headers}}),core.ExportResultCode.SUCCESS),
    metricReaders:[new metrics.PeriodicExportingMetricReader({
      exporter:ownMetrics(new OTLPMetricExporter({url:config.metricsUrl,headers:{...config.headers}}),core.ExportResultCode.SUCCESS),
      exportIntervalMillis:config.metricIntervalMs,
    })],
  });
}
