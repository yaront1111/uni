import {randomBytes} from 'node:crypto';
import type {IncomingMessage,ServerResponse} from 'node:http';

/** The response headers of the web process. Only `server.ts` imports this
 * file, never a page, so Next never bundles it. Scripts run only from this
 * origin and only when they carry the request's nonce (or were loaded by one
 * that did: 'strict-dynamic'); style-src keeps 'unsafe-inline' because Next's
 * prerendered 404/500 pages and three components render inline styles. `dev`
 * reports the same policy instead of enforcing it, because Next's webpack dev
 * build evaluates modules with eval-source-map. apps/web/CLAUDE.md has the
 * reasoning. */
export function securityHeaders(nonce:string,dev:boolean):Record<string,string>{
  const policy=`default-src 'self'; script-src 'self' 'nonce-${nonce}' 'strict-dynamic'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'self'; object-src 'none'; upgrade-insecure-requests`;
  return {
    'Strict-Transport-Security':'max-age=31536000',
    'X-Content-Type-Options':'nosniff',
    'Referrer-Policy':'same-origin',
    'X-Frame-Options':'DENY',
    'Permissions-Policy':'microphone=(self), camera=(), geolocation=(), payment=(), usb=()',
    'Cross-Origin-Opener-Policy':'same-origin',
    'Cross-Origin-Resource-Policy':'same-origin',
    [dev?'Content-Security-Policy-Report-Only':'Content-Security-Policy']:policy,
  };
}

/** The listener `server.ts` serves Next through: a fresh nonce and every
 * security header on each response, 421 for any Host but the configured
 * origin's, `Cache-Control: no-store` as the /api/ default (a route that sets
 * its own wins), and the nonce handed to `pages/_document.tsx` as the
 * `x-nonce` request header, overwriting whatever the client sent. `gate`
 * (`lib/session-gate.ts`) runs last, before handle(): a refusal answers 429
 * with Retry-After and never reaches Next. `record` (`recordWebResponse` from
 * `@unai/observability/web`, given only when telemetry is enabled) is called
 * exactly once per response, on its finish or close event, so the 421, the
 * 429, Next's responses and the 500 fallback all count. It receives numbers and
 * a boolean only, never req, res, the URL or a header; a throwing recorder never
 * changes a response. */
export function createRequestListener({origin,dev,handle,gate,record}:{origin:URL;dev:boolean;handle:(req:IncomingMessage,res:ServerResponse)=>Promise<void>;
  gate?:(req:IncomingMessage)=>Promise<{refused:false}|{refused:true;retryAfterSeconds:number}>;
  record?:(statusCode:number,durationMs:number,finished:boolean)=>void}){
  return (req:IncomingMessage,res:ServerResponse):void=>{
    if(record){
      const started=performance.now();let recorded=false;
      const done=()=>{
        if(recorded)return;recorded=true;
        try{record(res.statusCode,performance.now()-started,res.writableFinished);}catch{/* Recording never fails a response. */}
      };
      res.once('finish',done);res.once('close',done);
    }
    const nonce=randomBytes(16).toString('base64');
    for(const [name,value] of Object.entries(securityHeaders(nonce,dev)))res.setHeader(name,value);
    if(req.headers.host!==origin.host){res.writeHead(421);res.end();return;}
    if(req.url?.startsWith('/api/'))res.setHeader('Cache-Control','no-store');
    req.headers['x-nonce']=nonce;
    void (gate?gate(req).then(verdict=>{
      if(!verdict.refused)return handle(req,res);
      res.writeHead(429,{'Retry-After':String(verdict.retryAfterSeconds),'Cache-Control':'no-store','Content-Type':'application/json; charset=utf-8'});
      res.end('{"code":"RATE_LIMITED"}');
    }):handle(req,res)).catch(()=>{res.statusCode=500;res.end('Service unavailable');});
  };
}
