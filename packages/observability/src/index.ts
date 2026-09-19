import {trace,metrics,SpanStatusCode,type Span} from '@opentelemetry/api';

export type Stage='evidence.persist'|'evidence.triage'|'evidence.parse'|'extraction.run'|'memory.canonicalize'
  |'belief.validate'|'belief.commit'|'projection.reduce'|'projection.read'|'context.assemble'
  |'answer.compose'|'answer.ground'|'answer.record'|'model.generate';
type Scope={ownerScopeId:string;correlationId:string};
type Versions={attempt?:number|undefined;registryReleaseId?:string|null|undefined;componentVersion?:string;costMicrounits?:()=>number|undefined};
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VERSION=/^[a-z0-9][a-z0-9_.-]{0,100}$/;
const duration=metrics.getMeter('unai.pipeline','0.1.0').createHistogram('unai.pipeline.duration',{unit:'ms'});

function start(stage:Stage,scope:Scope,versions:Versions,span:Span){
  const started=performance.now();
  // Construct every field explicitly. Never spread a request, return value,
  // error, query, source id, model input or arbitrary metadata into telemetry.
  const attributes={
    'unai.correlation_id':UUID.test(scope.correlationId)?scope.correlationId:'INVALID',
    'unai.owner_scope_id':UUID.test(scope.ownerScopeId)?scope.ownerScopeId:'INVALID',
    'unai.stage':stage,'unai.code_version':'0.1.0',
    'unai.component_version':versions.componentVersion&&VERSION.test(versions.componentVersion)?versions.componentVersion:'0.1.0',
    'unai.registry_release_id':versions.registryReleaseId&&UUID.test(versions.registryReleaseId)?versions.registryReleaseId:'NOT_APPLICABLE',
    'unai.attempt':Number.isInteger(versions.attempt)&&versions.attempt!>0?versions.attempt!:1,
    'unai.retry_state':(versions.attempt??1)>1?'RETRY':'FIRST_ATTEMPT',
  };
  return (result:'SUCCESS'|'FAILURE')=>{
    const durationMs=performance.now()-started;
    const record={...attributes,'unai.duration_ms':durationMs,'unai.result':result};
    try{
      span.setAttributes(record);
      const cost=versions.costMicrounits?.();
      if(cost!==undefined&&Number.isFinite(cost)&&cost>=0)span.setAttributes({'unai.cost_microunits':cost});
      span.setStatus({code:result==='SUCCESS'?SpanStatusCode.OK:SpanStatusCode.ERROR});
      duration.record(durationMs,{stage,result});
      console.info(JSON.stringify({event:'pipeline.stage',...record,...(cost!==undefined&&Number.isFinite(cost)&&cost>=0?{'unai.cost_microunits':cost}:{})}));
    }catch{/* Telemetry failure must not turn a committed operation into a retry. */}
    finally{try{span.end();}catch{/* Exporter failure is not a product failure. */}}
  };
}

export function traceStage<T>(stage:Stage,scope:Scope,run:()=>Promise<T>,versions:Versions={}):Promise<T>{
  return trace.getTracer('unai.pipeline','0.1.0').startActiveSpan(stage,async span=>{
    const finish=start(stage,scope,versions,span);
    let result:'SUCCESS'|'FAILURE'='FAILURE';
    try{const value=await run();result='SUCCESS';return value;}finally{finish(result);}
  });
}

export function traceStageSync<T>(stage:Stage,scope:Scope,run:()=>T,versions:Versions={}):T{
  return trace.getTracer('unai.pipeline','0.1.0').startActiveSpan(stage,span=>{
    const finish=start(stage,scope,versions,span);
    let result:'SUCCESS'|'FAILURE'='FAILURE';
    try{const value=run();result='SUCCESS';return value;}finally{finish(result);}
  });
}
