import {createServer} from 'node:https';
import {readFileSync} from 'node:fs';
import {isIP} from 'node:net';
import {connect,createSecureContext} from 'node:tls';
import {runPreflight,startTelemetry,startupFailureCode} from '@unai/observability/telemetry';

/** Verify TLS without sending HTTP or trusting proxy headers. */
function apiHandshake(origin:URL,ca:Buffer):Promise<'API_UNREACHABLE'|undefined>{
  return new Promise((resolve,reject)=>{
    const host=origin.hostname.replace(/^\[|\]$/g,''),socket=connect({host,port:Number(origin.port||443),ca,
      rejectUnauthorized:true,minVersion:'TLSv1.2',...(!isIP(host)?{servername:host}:{})});
    let connected=false,finished=false;
    const finish=(ok:boolean)=>{
      if(finished)return;finished=true;clearTimeout(timer);socket.destroy();
      if(ok)resolve(undefined);
      else if(connected)reject(new Error('API_TLS_HANDSHAKE_FAILED'));
      else resolve('API_UNREACHABLE');
    };
    const timer=setTimeout(()=>finish(false),5000);
    socket.once('connect',()=>{connected=true;});
    // Flush TLS Finished/close_notify before destroying; no application bytes.
    socket.once('secureConnect',()=>socket.end(()=>finish(true)));
    socket.once('error',()=>finish(false));socket.once('close',()=>finish(false));
  });
}
// Workspace modules create instruments at evaluation time; metrics has no proxy.
// ESM evaluates static imports before this body, even beside a top-level await.
// Start the SDK first, then load application modules so meters are not permanent no-ops.
try {
  const telemetry=await startTelemetry({serviceName:'unai-web',version:'0.1.0'});
  const {required,authOptions,authPool}=await import('./lib/server');
  function bareOrigin(value:string,code:string):URL{
    const origin=new URL(value);
    if(origin.protocol!=='https:'||origin.pathname!=='/'||origin.search||origin.hash||origin.username||origin.password)throw new Error(code);
    return origin;
  }
  const webTls=()=>({key:readFileSync(required('UNAI_WEB_TLS_KEY_FILE')),cert:readFileSync(required('UNAI_WEB_TLS_CERT_FILE'))});
  if(process.argv.includes('--check')){
    const passed=await runPreflight({
      origin:()=>{bareOrigin(required('NEXTAUTH_URL'),'WEB_TLS_CONFIG_INVALID');},
      tls_certificate:()=>{
        const tls=webTls();
        try{createSecureContext({...tls,minVersion:'TLSv1.2'});}catch{throw new Error('WEB_TLS_CONFIG_INVALID');}
      },
      auth:async()=>{await authOptions();},
      api:()=>apiHandshake(bareOrigin(required('UNAI_API_ORIGIN'),'API_TLS_CONFIG_INVALID'),readFileSync(required('UNAI_API_CA_FILE'))),
    });
    process.exitCode=passed?0:1;
    const exit=()=>process.stdout.write('',()=>process.exit()),deadline=setTimeout(exit,10_000);
    await authPool().then(pool=>pool.end(),()=>undefined);await telemetry.shutdown();clearTimeout(deadline);exit();
  }else{
  const {default:next}=await import('next');
  const {createRequestListener}=await import('./lib/security-headers');
  const origin=bareOrigin(required('NEXTAUTH_URL'),'WEB_TLS_CONFIG_INVALID');
  const tls=webTls();
  const dev=process.argv.includes('--dev');
  const app=next({dev,hostname:origin.hostname,port:Number(origin.port||443),webpack:true});
  await app.prepare();
  const handle=app.getRequestHandler();
  const server=createServer({...tls,minVersion:'TLSv1.2'},createRequestListener({origin,dev,handle}));
  await new Promise<void>((resolve,reject)=>{
    server.once('error',reject);
    server.listen(Number(origin.port||443),process.env.UNAI_WEB_BIND??'127.0.0.1',()=>{
      server.off('error',reject);resolve();
    });
  });
  let closing=false;
  const close=()=>{
    if(closing)return;closing=true;
    server.close(()=>{void app.close().finally(()=>telemetry.shutdown()).then(()=>process.exit(0));});
  };
  process.on('SIGTERM',close);process.on('SIGINT',close);
  }
} catch (error) {
  process.exitCode=1;
  process.stderr.write(JSON.stringify({event:'startup_failed',code:'WEB_STARTUP_FAILED',cause:startupFailureCode(error)?.code??'UNCLASSIFIED'})+'\n',()=>process.exit());
}
