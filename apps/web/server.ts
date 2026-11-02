import {createServer} from 'node:https';
import {readFileSync} from 'node:fs';
import {startTelemetry,startupFailureCode} from '@unai/observability/telemetry';
// Workspace modules create instruments at evaluation time; metrics has no proxy.
// ESM evaluates static imports before this body, even beside a top-level await.
// Start the SDK first, then load application modules so meters are not permanent no-ops.
try {
  const telemetry=await startTelemetry({serviceName:'unai-web',version:'0.1.0'});
  const {default:next}=await import('next');
  const {required}=await import('./lib/server');
  const {createRequestListener}=await import('./lib/security-headers');
  const origin=new URL(required('NEXTAUTH_URL'));
  if(origin.protocol!=='https:'||origin.pathname!=='/'||origin.search||origin.hash||origin.username||origin.password)throw new Error('WEB_TLS_CONFIG_INVALID');
  const tls={key:readFileSync(required('UNAI_WEB_TLS_KEY_FILE')),cert:readFileSync(required('UNAI_WEB_TLS_CERT_FILE'))};
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
} catch (error) {
  process.exitCode=1;
  process.stderr.write(JSON.stringify({event:'startup_failed',code:'WEB_STARTUP_FAILED',cause:startupFailureCode(error)?.code??'UNCLASSIFIED'})+'\n',()=>process.exit());
}
