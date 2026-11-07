import {metrics, trace, SpanStatusCode} from '@opentelemetry/api';

/** The web process's one response instrument (scope `unai.web`).
 *
 * 1. Load this module only by dynamic `import()` after `startTelemetry` (apps/web/server.ts):
 *    the metrics API has no proxy, so a histogram created before the SDK starts is a no-op forever.
 * 2. Privacy: the recorder receives numbers and a boolean only. Never add a URL, path, route,
 *    query, Host, http.target, header, cookie, user agent, correlation or owner id attribute;
 *    apps/web/server.test.ts asserts the exact attribute key sets. */
const tracer=trace.getTracer('unai.web','0.1.0');
const duration=metrics.getMeter('unai.web','0.1.0').createHistogram('unai.web.duration',{unit:'ms'});

/** One span and one duration point per response. `finished` is false when the connection
 * closed before the response finished (ABORTED). Never throws: recording must not change a response. */
export function recordWebResponse(statusCode:number,durationMs:number,finished:boolean):void{
  try{
    const span=tracer.startSpan('web.response',{attributes:{'http.response.status_code':statusCode,'unai.code_version':'0.1.0',
      'unai.result':finished?(statusCode<400?'SUCCESS':'REFUSED'):'ABORTED'}});
    span.setStatus({code:statusCode>=500?SpanStatusCode.ERROR:SpanStatusCode.OK});
    span.end();
    duration.record(durationMs,{statusCode});
  }catch{/* Telemetry failure must not change an already sent response. */}
}
