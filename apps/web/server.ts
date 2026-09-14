import {createServer} from 'node:https';
import {readFileSync} from 'node:fs';
import next from 'next';
import {required} from './lib/server';
const origin=new URL(required('NEXTAUTH_URL'));
if(origin.protocol!=='https:'||origin.pathname!=='/'||origin.search||origin.hash||origin.username||origin.password)throw new Error('WEB_TLS_CONFIG_INVALID');
const app=next({dev:process.argv.includes('--dev'),hostname:origin.hostname,port:Number(origin.port||443),webpack:true});
await app.prepare();
const handle=app.getRequestHandler();
const server=createServer({key:readFileSync(required('UNAI_WEB_TLS_KEY_FILE')),cert:readFileSync(required('UNAI_WEB_TLS_CERT_FILE')),minVersion:'TLSv1.2'},(req,res)=>{
  res.setHeader('Strict-Transport-Security','max-age=31536000');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','same-origin');res.setHeader('X-Frame-Options','DENY');
  if(req.headers.host!==origin.host){res.writeHead(421);res.end();return;}
  void handle(req,res).catch(()=>{res.statusCode=500;res.end('Service unavailable');});
});
server.listen(Number(origin.port||443),process.env.UNAI_WEB_BIND??'127.0.0.1');
process.on('SIGTERM',()=>{server.close(()=>{void app.close().then(()=>process.exit(0));});});
