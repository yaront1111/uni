import {createHash} from 'node:crypto';
import {isIPv6} from 'node:net';
import type {IncomingMessage} from 'node:http';
import {SESSION_COOKIE,sessionToken} from '@unai/auth';
import {createRateLimiter} from '@unai/auth/rate-limit';
import {heldSeconds} from './server';

/** The web process's pre-auth gate (PRD §31, §41): the listener in
 * `lib/security-headers.ts` runs it before Next's handle(), so a session token
 * is looked up on the auth pool once per request, except a proxy token held
 * after the API's session-bucket 429. A held token never reaches the pool or
 * Next; a failed lookup never reaches `identity()` or next-auth.
 * Only `server.ts` and the listener import
 * this file, never a page, so Next never bundles a second copy of its state.
 * apps/web/CLAUDE.md has the rules and the known limits. */
export type SessionGateVerdict={refused:false}|{refused:true;retryAfterSeconds:number};
const REFUSED_MARKER='unai-session-refused=1';

/** The bucket key: the TLS socket's own address, never a header (ADR 0008).
 * IPv4-mapped IPv6 becomes IPv4; IPv6 is keyed by its /64, so a host cannot
 * mint fresh buckets by rotating addresses inside its own prefix. */
export function addressKey(address:string|undefined):string{
  if(address===undefined)return '';
  const bare=address.split('%')[0]!;
  if(!isIPv6(bare))return address;
  const v4=/(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(bare);
  const text=v4?bare.slice(0,v4.index)+[[v4[1],v4[2]],[v4[3],v4[4]]].map(([high,low])=>(Number(high)*256+Number(low)).toString(16)).join(':'):bare;
  const [head='',tail]=text.split('::');
  const left=head?head.split(':'):[],right=tail?tail.split(':'):[];
  const groups=[...left,...Array<string>(8-left.length-right.length).fill('0'),...right].map(group=>parseInt(group,16));
  if(groups.slice(0,5).every(group=>group===0)&&groups[5]===0xffff)return [groups[6]!>>8,groups[6]!&255,groups[7]!>>8,groups[7]!&255].join('.');
  return groups.slice(0,4).map(group=>group.toString(16)).join(':')+'::/64';
}

/** Leaves at most one session cookie on the request, the looked-up `token`.
 * A cookie is session-named when the text before its first '=', trimmed,
 * starts with SESSION_COOKIE: Next's cookie parser reads names that way, and
 * next-auth's SessionStore joins every cookie with that prefix (its chunks
 * `.0`, `.1`). Other cookies are kept byte for byte. When a session cookie is
 * removed and none kept, the marker keeps `req.headers.cookie` truthy, so pages
 * still send the owner to `/signin?reason=expired`. */
export function keepSession(req:IncomingMessage,token:string|null):void{
  const parts=(req.headers.cookie??'').split(';');
  const others=parts.filter(part=>{const eq=part.indexOf('=');return eq<0||!part.slice(0,eq).trim().startsWith(SESSION_COOKIE);});
  if(token===null&&others.length===parts.length)return;
  const kept=others.filter(part=>part.trim()!=='').join(';');
  const cookie=(kept?kept+'; ':'')+(token===null?REFUSED_MARKER:SESSION_COOKIE+'='+token);
  req.headers.cookie=cookie;
  const raw=req.rawHeaders;
  for(let index=raw.length-2;index>=0;index-=2)if(raw[index]!.toLowerCase()==='cookie')raw.splice(index,2);
  raw.push('Cookie',cookie);
}

/** `lookup` answers whether the token resolves to a live session. A failed
 * lookup counts against the address; once failures plus lookups in flight
 * reach `authFailuresPerMinute`, a token not yet resolved in this process is
 * refused without a lookup. A resolved token passes a limited address and is
 * still looked up on every request, until a lookup fails. A thrown lookup is
 * neither counted nor stripped: downstream fails as it would without the gate.
 * Only the token's SHA-256 is held, and nothing here logs. */
export function createSessionGate({lookup,authFailuresPerMinute,clock=Date.now}:
  {lookup:(token:string)=>Promise<boolean>;authFailuresPerMinute:number;clock?:()=>number}){
  // No per-session budget on the web: the API's session bucket sees the forwarded cookie.
  const limiter=createRateLimiter({perSessionPerMinute:Number.POSITIVE_INFINITY,authFailuresPerAddressPerMinute:authFailuresPerMinute},clock);
  return async function gate(req:IncomingMessage):Promise<SessionGateVerdict>{
    const token=sessionToken(req.headers.cookie);
    if(token===null){keepSession(req,null);return {refused:false};}
    if(isPlatformProxy(req.url)){
      const retryAfterSeconds=heldSeconds(token,clock());
      if(retryAfterSeconds!==null)return {refused:true,retryAfterSeconds};
    }
    const hash=createHash('sha256').update(token).digest('hex'),key=addressKey(req.socket.remoteAddress);
    const verdict=limiter.admit(hash,key);
    if(verdict.kind==='refused')return {refused:true,retryAfterSeconds:verdict.retryAfterSeconds};
    // try/finally, never Promise.prototype.finally: failed() must count before the slot is freed.
    try{
      if(await lookup(token)){limiter.authenticated(hash);keepSession(req,token);}
      else{limiter.failed(hash,key);keepSession(req,null);}
    }catch{keepSession(req,token);}
    finally{if(verdict.kind==='unknown')limiter.release(key);}
    return {refused:false};
  };
}

function isPlatformProxy(url:string|undefined):boolean{
  const raw=new URL(url??'/','https://web.invalid').pathname;
  let path=raw;
  try{path=decodeURIComponent(raw);}catch{ /* Use the raw path when percent decoding fails. */ }
  return path.startsWith('/api/platform/');
}
