import {afterEach,expect,it,vi} from 'vitest';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {EventEmitter} from 'node:events';
import type {IncomingMessage,ServerResponse} from 'node:http';
import type {NextApiRequest,NextApiResponse} from 'next';
import {SESSION_COOKIE,resolveSession} from '@unai/auth';
const upstream=vi.hoisted(()=>({request:vi.fn()}));
vi.mock('node:https',()=>upstream);
import * as first from './server';
import proxyHandler from '../pages/api/platform/[...path]';
import {createRequestListener} from './security-headers';
import {addressKey,createSessionGate,keepSession,type SessionGateVerdict} from './session-gate';
import {createRateLimiter,DEFAULT_RATE_LIMITS,RATE_LIMIT_MAX_KEYS} from '@unai/auth/rate-limit';

const POOL=Symbol.for('unai.web.authPool');
const HOLDS=Symbol.for('unai.web.sessionHolds');
const slot=globalThis as unknown as Record<symbol,unknown>;
afterEach(()=>{delete slot[POOL];delete slot[HOLDS];vi.unstubAllEnvs();vi.useRealTimers();vi.clearAllMocks();});
// The parser Next hands pages and API routes (getCookieParser), so next-auth's view of the request.
const {parse}=createRequire(import.meta.url)('next/dist/compiled/cookie') as {parse:(cookie:string)=>Record<string,string>};
const TOKEN='t'.repeat(43),OTHER='o'.repeat(43);
const fakeRequest=(cookie?:string)=>({headers:cookie===undefined?{}:{cookie},
  rawHeaders:['Host','uai.test',...(cookie===undefined?[]:['Cookie',cookie])]}) as unknown as IncomingMessage;

it('shares one auth pool between the tsx and Next copies of lib/server', async () => {
  const sentinel=Promise.resolve({} as Awaited<ReturnType<typeof first.authPool>>);
  slot[POOL]=sentinel;
  vi.resetModules();
  const second=await import('./server');
  expect(second).not.toBe(first);
  expect(first.authPool()).toBe(sentinel);
  expect(second.authPool()).toBe(sentinel);
},30_000);

it('leaves the process-wide slot empty when the pool cannot open', async () => {
  vi.stubEnv('UNAI_SECRETS_MOUNT','');
  await expect(Promise.resolve().then(()=>first.authPool())).rejects.toThrow('CONFIG_REQUIRED:UNAI_SECRETS_MOUNT');
  expect(POOL in slot).toBe(false);
  vi.stubEnv('UNAI_SECRETS_MOUNT',tmpdir());vi.stubEnv('UNAI_AUTH_DATABASE_URL','');
  const failing=first.authPool();
  expect(slot[POOL]).toBe(failing);
  await expect(failing).rejects.toThrow('CONFIG_REQUIRED:UNAI_AUTH_DATABASE_URL');
  expect(POOL in slot).toBe(false);
});

it('keys an address by the socket value: IPv4, mapped IPv4 as IPv4, IPv6 by its /64', () => {
  expect(addressKey('10.0.0.7')).toBe('10.0.0.7');
  expect(addressKey('::ffff:10.0.0.7')).toBe('10.0.0.7');
  expect(addressKey('::FFFF:10.0.0.7')).toBe('10.0.0.7');
  expect(addressKey('2001:db8:1:2::a')).toBe('2001:db8:1:2::/64');
  expect(addressKey('2001:db8:1:2:ffff:ffff:ffff:b')).toBe('2001:db8:1:2::/64');
  expect(addressKey('2001:0DB8:0001:0002::1')).toBe('2001:db8:1:2::/64');
  expect(addressKey('2001:db8:1:3::a')).toBe('2001:db8:1:3::/64');
  expect(addressKey('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
  expect(addressKey('::1')).toBe('0:0:0:0::/64');
  expect(addressKey('64:ff9b::192.0.2.1')).toBe('64:ff9b:0:0::/64');
  expect(addressKey(undefined)).toBe('');
});

it.each([
  ['the exact cookie, kept',`a=1; ${SESSION_COOKIE}=${TOKEN}; b="2"`,TOKEN,`a=1; b="2"; ${SESSION_COOKIE}=${TOKEN}`],
  ['the exact cookie, refused',`a=1; ${SESSION_COOKIE}=${TOKEN}; b=2`,null,'a=1; b=2; unai-session-refused=1'],
  ['next-auth chunks',`${SESSION_COOKIE}.0=${TOKEN}; a=1; ${SESSION_COOKIE}.1=${OTHER}`,null,' a=1; unai-session-refused=1'],
  ['chunks beside a kept token',`${SESSION_COOKIE}=${TOKEN}; ${SESSION_COOKIE}.0=${OTHER}`,TOKEN,`${SESSION_COOKIE}=${TOKEN}`],
  ['a duplicate',`${SESSION_COOKIE}=${TOKEN}; ${SESSION_COOKIE}=${OTHER}`,null,'unai-session-refused=1'],
  ['a spaced name before the token',`${SESSION_COOKIE} =${OTHER}; ${SESSION_COOKIE}=${TOKEN}`,TOKEN,`${SESSION_COOKIE}=${TOKEN}`],
  ['a quoted value',`${SESSION_COOKIE}="${TOKEN}"`,null,'unai-session-refused=1'],
  ['a malformed value',`${SESSION_COOKIE}=short;flag`,null,'flag; unai-session-refused=1'],
])('keepSession leaves only the looked-up token: %s',(_name,cookie,token,expected)=>{
  const req=fakeRequest(cookie);
  keepSession(req,token);
  expect(req.headers.cookie).toBe(expected);
  expect(req.rawHeaders).toEqual(['Host','uai.test','Cookie',expected]);
  const named=Object.entries(parse(expected)).filter(([name])=>name.startsWith(SESSION_COOKIE));
  expect(named).toEqual(token===null?[]:[[SESSION_COOKIE,token]]);
});

it('keepSession leaves a request without a session cookie untouched', () => {
  for(const cookie of [undefined,'a=1;b=2','__host-unai.session=x; unai-tz=Europe%2FLondon']){
    const req=fakeRequest(cookie);
    keepSession(req,null);
    expect(req.headers.cookie).toBe(cookie);
    expect(req.rawHeaders).toEqual(fakeRequest(cookie).rawHeaders);
  }
});

it('keepSession rewrites every raw Cookie entry into one', () => {
  const req={headers:{cookie:`a=1; ${SESSION_COOKIE}.0=${OTHER}`},
    rawHeaders:['cookie','a=1','Host','uai.test','COOKIE',`${SESSION_COOKIE}.0=${OTHER}`]} as unknown as IncomingMessage;
  keepSession(req,null);
  expect(req.rawHeaders).toEqual(['Host','uai.test','Cookie','a=1; unai-session-refused=1']);
});

const FIXED_HEADERS={
  'strict-transport-security':'max-age=31536000','x-content-type-options':'nosniff','referrer-policy':'same-origin',
  'x-frame-options':'DENY','permissions-policy':'microphone=(self), camera=(), geolocation=(), payment=(), usb=()',
  'cross-origin-opener-policy':'same-origin','cross-origin-resource-policy':'same-origin',
};
const token=(n:number)=>('token'+n).padEnd(43,'x');
const session=(value:string)=>`a=1; ${SESSION_COOKIE}=${value}`;
type Sent={status:number;headers:Record<string,string>;body:string;cookie:string|undefined};

/** A listener over the real gate: a fake clock 15 s into a window, limit 3, a
 * lookup double that counts calls and resolves only `valid` tokens (or a held
 * promise), and a handle double that records the Cookie header Next would see. */
function harness({gate,route}:{gate?:(req:IncomingMessage)=>Promise<SessionGateVerdict>;route?:(req:IncomingMessage,res:ServerResponse)=>Promise<void>}={}){
  const clock={now:15_000},valid=new Set<string>(),held=new Map<string,(ok:boolean)=>void>();
  let failing=false;
  const lookup=vi.fn(async(value:string)=>{
    if(failing)throw new Error('connection refused by 10.9.9.9');
    if(value.startsWith('held'))return new Promise<boolean>(resolve=>held.set(value,resolve));
    return valid.has(value);
  });
  const handle=vi.fn(route??(async(_req:IncomingMessage,res:ServerResponse)=>{res.end('page');}));
  const listener=createRequestListener({origin:new URL('https://uai.test'),dev:false,handle,
    gate:gate??createSessionGate({lookup,authFailuresPerMinute:3,clock:()=>clock.now})});
  function send({cookie,address='10.0.0.7',url='/',host='uai.test',forwarded,method='GET'}:{cookie?:string;address?:string;url?:string;host?:string;forwarded?:string;method?:string}={}):Promise<Sent>{
    const headers:Record<string,string>={host,...(cookie===undefined?{}:{cookie}),...(forwarded?{'x-forwarded-for':forwarded}:{})};
    const req={headers,rawHeaders:Object.entries(headers).flat(),url,method,socket:{remoteAddress:address,encrypted:true}} as unknown as IncomingMessage;
    return new Promise(resolve=>{
      const sent:Record<string,string>={};
      const res={statusCode:200,
        setHeader(name:string,value:string){sent[name.toLowerCase()]=value;},
        writeHead(status:number,extra:Record<string,string>={}){res.statusCode=status;for(const [name,value] of Object.entries(extra))sent[name.toLowerCase()]=value;return res;},
        end(body=''){resolve({status:res.statusCode,headers:sent,body:String(body),cookie:req.headers.cookie});return res;}};
      listener(req,res as unknown as ServerResponse);
    });
  }
  return {clock,valid,held,lookup,handle,send,fail:(on:boolean)=>{failing=on;}};
}
function expectRefused(sent:Sent,retryAfter:string){
  expect(sent.status).toBe(429);
  expect(sent.body).toBe('{"code":"RATE_LIMITED"}');
  expect(sent.headers).toMatchObject({...FIXED_HEADERS,'retry-after':retryAfter,'cache-control':'no-store','content-type':'application/json; charset=utf-8'});
  expect(sent.headers['content-security-policy']).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/]{22}==' 'strict-dynamic'/);
}

it('refuses an unknown token from an address with N failed lookups, without a lookup or handle', async () => {
  const {clock,lookup,handle,send}=harness();
  for(const n of [1,2,3]){
    const sent=await send({cookie:session(token(n))});
    expect(sent).toMatchObject({status:200,cookie:'a=1; unai-session-refused=1'});
  }
  expect(lookup).toHaveBeenCalledTimes(3);
  expectRefused(await send({cookie:session(token(4))}),'45');
  expect(lookup).toHaveBeenCalledTimes(3);
  expect(handle).toHaveBeenCalledTimes(3);
  clock.now=60_000;
  expect(await send({cookie:session(token(5))})).toMatchObject({status:200});
  expect(lookup).toHaveBeenCalledTimes(4);
});

it('puts next-auth\'s GET /api/auth/session behind the same gate', async () => {
  const {lookup,send}=harness();
  for(const n of [1,2,3]){
    const sent=await send({url:'/api/auth/session',cookie:`${SESSION_COOKIE}=${token(n)}`});
    expect(sent).toMatchObject({status:200,cookie:'unai-session-refused=1'});
    expect(sent.headers['cache-control']).toBe('no-store');
  }
  expectRefused(await send({url:'/api/auth/session',cookie:`${SESSION_COOKIE}=${token(4)}`}),'45');
  expect(lookup).toHaveBeenCalledTimes(3);
});

it('lets cookie-less and malformed requests through uncounted, and a resolved token until it fails', async () => {
  const {valid,lookup,handle,send}=harness();
  const malformed=[undefined,'a=1',`${SESSION_COOKIE}=short`,`${SESSION_COOKIE}="${token(9)}"`,
    `${SESSION_COOKIE}=${token(8)}; ${SESSION_COOKIE}=${token(9)}`,`${SESSION_COOKIE}.0=${token(8)}; ${SESSION_COOKIE}.1=${token(9)}`,
    `${SESSION_COOKIE} =${token(9)}`];
  for(const cookie of malformed)expect((await send({cookie,address:'10.0.0.9'})).status).toBe(200);
  expect(lookup).not.toHaveBeenCalled();
  valid.add(token(0));
  expect(await send({cookie:session(token(0))})).toMatchObject({status:200,cookie:session(token(0))});
  for(const n of [1,2,3])await send({cookie:session(token(n))});
  expect(lookup).toHaveBeenCalledTimes(4);
  for(const cookie of malformed){
    const sent=await send({cookie});
    expect(sent.status).toBe(200);
    expect(Object.keys(parse(sent.cookie??'')).filter(name=>name.startsWith(SESSION_COOKIE))).toEqual([]);
  }
  expect(lookup).toHaveBeenCalledTimes(4);
  for(const n of [1,2,3])expect((await send({cookie:session(token(n)),address:'10.0.0.9'})).status).toBe(200);
  expect(await send({cookie:`${SESSION_COOKIE}.0=${token(9)}; ${SESSION_COOKIE}=${token(0)}`})).toMatchObject({status:200,cookie:`${SESSION_COOKIE}=${token(0)}`});
  expect(lookup).toHaveBeenCalledTimes(8);
  valid.delete(token(0));
  expect(await send({cookie:session(token(0))})).toMatchObject({status:200,cookie:'a=1; unai-session-refused=1'});
  expect(lookup).toHaveBeenCalledTimes(9);
  expectRefused(await send({cookie:session(token(0))}),'45');
  expect(lookup).toHaveBeenCalledTimes(9);
  expect(handle).toHaveBeenCalledTimes(2*malformed.length+9);
});

it('keys the bucket by the socket address only', async () => {
  const {lookup,send}=harness();
  for(const n of [1,2,3])await send({cookie:session(token(n)),forwarded:`192.0.2.${n}`});
  expectRefused(await send({cookie:session(token(4)),forwarded:'192.0.2.99'}),'45');
  expectRefused(await send({cookie:session(token(4)),address:'::ffff:10.0.0.7'}),'45');
  expect((await send({cookie:session(token(4)),address:'10.0.0.8',forwarded:'10.0.0.7'})).status).toBe(200);
  for(const n of [5,6,7])await send({cookie:session(token(n)),address:'2001:db8:1:2::a'});
  expectRefused(await send({cookie:session(token(8)),address:'2001:db8:1:2::b'}),'45');
  expect((await send({cookie:session(token(8)),address:'2001:db8:1:3::a'})).status).toBe(200);
  expect(lookup).toHaveBeenCalledTimes(8);
});

it('counts lookups in flight against the address and frees them when they settle', async () => {
  const {valid,held,lookup,send}=harness();
  valid.add(token(0));
  await send({cookie:session(token(0))});
  const pending=[1,2,3].map(n=>send({cookie:session(('held'+n).padEnd(43,'x'))}));
  await vi.waitFor(()=>expect(held.size).toBe(3));
  // A resolved token neither takes nor frees an in-flight slot.
  expect(await send({cookie:session(token(0))})).toMatchObject({status:200,cookie:session(token(0))});
  expectRefused(await send({cookie:session(token(4))}),'45');
  expect(lookup).toHaveBeenCalledTimes(5);
  for(const resolve of held.values())resolve(true);
  for(const sent of await Promise.all(pending))expect(sent.status).toBe(200);
  expect(await send({cookie:session(token(4))})).toMatchObject({status:200});
  expect(lookup).toHaveBeenCalledTimes(6);
});

it('passes a thrown lookup through uncounted with exactly its token', async () => {
  const {lookup,send,fail}=harness();
  fail(true);
  for(const n of [1,2,3,4,5])expect(await send({cookie:`${SESSION_COOKIE}.0=x; ${SESSION_COOKIE}=${token(n)}`})).toMatchObject({status:200,cookie:`${SESSION_COOKIE}=${token(n)}`});
  expect(lookup).toHaveBeenCalledTimes(5);
});

it('answers a wrong Host 421 before the gate, and a throwing gate 500', async () => {
  const {lookup,handle,send}=harness();
  expect((await send({cookie:session(token(1)),host:'evil.test'})).status).toBe(421);
  expect(lookup).not.toHaveBeenCalled();
  const broken=harness({gate:async()=>{throw new Error('boom 10.0.0.7');}});
  expect(await broken.send({cookie:session(token(1))})).toMatchObject({status:500,body:'Service unavailable'});
  expect(broken.handle).not.toHaveBeenCalled();
  expect(handle).not.toHaveBeenCalled();
});

it('never writes the token or its SHA-256 to a response or a log', async () => {
  const lines:string[]=[];
  const record=(...args:unknown[])=>{lines.push(args.map(String).join(' '));return true;};
  for(const method of ['log','info','warn','error','debug'] as const)vi.spyOn(console,method).mockImplementation(record);
  vi.spyOn(process.stdout,'write').mockImplementation(record);vi.spyOn(process.stderr,'write').mockImplementation(record);
  try{
    const sentinel='SENTINEL'.padEnd(43,'s'),hash=createHash('sha256').update(sentinel).digest('hex');
    const {valid,send,fail,clock}=harness();
    const replies=[];
    for(const n of [1,2,3])replies.push(await send({cookie:session(token(n))}));
    replies.push(await send({cookie:session(sentinel)}));
    valid.add(sentinel);
    replies.push(await send({cookie:session(sentinel),address:'10.0.0.8'}));
    valid.delete(sentinel);
    replies.push(await send({cookie:session(sentinel),address:'10.0.0.8'}));
    fail(true);
    replies.push(await send({cookie:session(sentinel),address:'10.0.0.8'}));
    expect(replies.map(sent=>sent.status)).toEqual([200,200,200,429,200,200,200]);
    expect(first.holdSession).toBeTypeOf('function');
    first.holdSession(sentinel,clock.now+41_000);
    const refused=await send({cookie:session(sentinel),url:'/api/platform/ask'});
    expectRefused(refused,'41');replies.push(refused);
    const written=JSON.stringify([replies.map(({headers,body})=>({headers,body})),lines]);
    expect(written).not.toContain(sentinel);
    expect(written).not.toContain(hash);
    expect(written).not.toContain('10.0.0.7');expect(written).not.toContain('10.0.0.8');
  }finally{vi.restoreAllMocks();}
});

it.each(['/api/platform/ask','/api/%70latform/ask','/api/platform/ask?x=1','/api/platform/%invalid'])('refuses a held token without lookup or handle at %s',async url=>{
  expect(first.holdSession).toBeTypeOf('function');
  const {clock,lookup,handle,send}=harness();
  first.holdSession(TOKEN,clock.now+40_001);
  expectRefused(await send({cookie:session(TOKEN),url}),'41');
  clock.now+=2;expectRefused(await send({cookie:session(TOKEN),url}),'40');
  expect(lookup).not.toHaveBeenCalled();expect(handle).not.toHaveBeenCalled();
  // A held request must not reserve an address slot, even for an unknown token.
  for(const n of [1,2,3])expect((await send({cookie:session(token(n))})).status).toBe(200);
  expect(lookup).toHaveBeenCalledTimes(3);
});

it.each(['/','/api/chat','/api/auth/session','/_next/static/app.js','/api/platform-other/ask'])('still looks up a held token outside the platform proxy at %s',async url=>{
  expect(first.holdSession).toBeTypeOf('function');
  const {clock,valid,lookup,send}=harness();valid.add(TOKEN);
  first.holdSession(TOKEN,clock.now+41_000);
  expect((await send({cookie:session(TOKEN),url})).status).toBe(200);
  expect(lookup).toHaveBeenCalledExactlyOnceWith(TOKEN);
});

it('looks up an unheld token and resumes the held token at expiry',async()=>{
  expect(first.holdSession).toBeTypeOf('function');
  const {clock,valid,lookup,send}=harness();valid.add(TOKEN);valid.add(OTHER);
  first.holdSession(TOKEN,clock.now+41_000);
  expect((await send({cookie:session(OTHER),url:'/api/platform/ask'})).status).toBe(200);
  clock.now+=41_000;
  expect((await send({cookie:session(TOKEN),url:'/api/platform/ask'})).status).toBe(200);
  expect(lookup.mock.calls).toEqual([[OTHER],[TOKEN]]);
  expect((slot[HOLDS] as Map<string,number>).size).toBe(0);
});

it('shares digest-only holds between module graphs and updates one token idempotently',async()=>{
  expect(first.holdSession).toBeTypeOf('function');
  vi.resetModules();const second=await import('./server');
  first.holdSession(TOKEN,56_000);second.holdSession(TOKEN,56_000);
  expect(second.heldSeconds(TOKEN,15_000)).toBe(41);
  expect(slot[HOLDS]).toEqual(new Map([[createHash('sha256').update(TOKEN).digest('hex'),56_000]]));
  expect(first.heldSeconds(TOKEN,56_000)).toBeNull();
  expect(second.heldSeconds(TOKEN,15_000)).toBeNull();
});

it('fails open for old holds at the 10 000-key cap, without clearing on an update',()=>{
  expect(first.holdSession).toBeTypeOf('function');
  for(let n=0;n<10_000;n++)first.holdSession(token(n),56_000);
  first.holdSession(token(0),56_000);
  expect((slot[HOLDS] as Map<string,number>).size).toBe(10_000);
  expect(first.heldSeconds(token(1),15_000)).toBe(41);
  first.holdSession(token(10_000),56_000);
  expect((slot[HOLDS] as Map<string,number>).size).toBe(1);
  expect(first.heldSeconds(token(0),15_000)).toBeNull();
  expect(first.heldSeconds(token(9999),15_000)).toBeNull();
  expect(first.heldSeconds(token(10_000),15_000)).toBe(41);
});

it('keeps a held session API-refused through an API capacity turnover until after its hold ends',()=>{
  let now=15_000;
  const api=createRateLimiter(DEFAULT_RATE_LIMITS,()=>now),hash=createHash('sha256').update(TOKEN).digest('hex');
  api.authenticated(hash);
  for(let n=0;n<599;n++)expect(api.admit(hash,'10.0.0.7')).toEqual({kind:'counted'});
  const refusal=api.admit(hash,'10.0.0.7');
  expect(refusal).toEqual({kind:'refused',bucket:'session',retryAfterSeconds:45});
  first.holdSession(TOKEN,now+(Math.min(45,60)-1)*1000); // The proxy's rule for that 429: pages/api/platform/[...path].ts.
  for(let n=0;n<RATE_LIMIT_MAX_KEYS;n++)api.authenticated('other'+n); // The API's capacity turnover.
  expect(api.admit(hash,'10.0.0.7')).toEqual(refusal);
  expect(first.heldSeconds(TOKEN,now)).toBe(44);
  expect(slot[HOLDS]).toEqual(new Map([[hash,59_000]]));
  now=58_999;
  expect(first.heldSeconds(TOKEN,now)).toBe(1);
  expect(api.admit(hash,'10.0.0.7')).toEqual({kind:'refused',bucket:'session',retryAfterSeconds:2});
  now=59_000;
  expect(first.heldSeconds(TOKEN,now)).toBeNull();
  expect(api.admit(hash,'10.0.0.7')).toEqual({kind:'refused',bucket:'session',retryAfterSeconds:1});
  now=60_000;
  expect(api.admit(hash,'10.0.0.7')).toEqual({kind:'counted'});
});

/** Next's request/response shape at the real platform route, after the listener. */
async function proxyRoute(req:IncomingMessage,res:ServerResponse){
  if(req.url==='/'){res.end('page');return;}
  const request={query:{path:['ask']},method:req.method,headers:{...req.headers,origin:'https://uai.test',
    'x-purpose':'memory.read','x-correlation-id':'correlation','idempotency-key':'key'},body:{question:'What is next?'},socket:req.socket};
  const response={setHeader:(name:string,value:string)=>res.setHeader(name,value),
    status(code:number){res.statusCode=code;return response;},json:(body:unknown)=>res.end(JSON.stringify(body))};
  await proxyHandler(request as unknown as NextApiRequest,response as unknown as NextApiResponse);
}

it('holds the real proxy after an API session refusal with zero further auth-pool queries',async()=>{
  vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(15_250);
  vi.stubEnv('NEXTAUTH_URL','https://uai.test');vi.stubEnv('UNAI_API_ORIGIN','https://api.test');vi.stubEnv('UNAI_API_CA_FILE','package.json');
  const pool={query:vi.fn(async()=>({rows:[{value:{id:'session-id',userId:'actor',ownerScopeId:'owner',deviceId:null}}]}))};
  slot[POOL]=Promise.resolve(pool);
  let statusCode=429;
  upstream.request.mockImplementation((_url:URL,_options:unknown,callback:(res:IncomingMessage)=>void)=>{
    const response=Object.assign(new EventEmitter(),{statusCode,headers:{'retry-after':'42','x-rate-limit-bucket':'session'}});
    return Object.assign(new EventEmitter(),{setTimeout:vi.fn(),destroy:vi.fn(),end:()=>{
      callback(response as unknown as IncomingMessage);
      response.emit('data',Buffer.from(JSON.stringify(statusCode===429?{code:'RATE_LIMITED',correlationId:'c'}:{ok:true})));response.emit('end');
    }});
  });
  const gate=createSessionGate({authFailuresPerMinute:3,lookup:async value=>Boolean(await resolveSession(await first.authPool(),value))});
  const {send}=harness({gate,route:proxyRoute});
  const post=()=>send({cookie:session(TOKEN),url:'/api/platform/ask',method:'POST'});
  const initial=await post();
  expect(initial).toMatchObject({status:429,headers:{'retry-after':'42'},body:'{"code":"RATE_LIMITED","correlationId":"c"}'});
  expect(pool.query).toHaveBeenCalledTimes(2);expect(upstream.request).toHaveBeenCalledTimes(1);
  for(let n=0;n<5;n++){
    const held=await post();expect(pool.query).toHaveBeenCalledTimes(2);expect(upstream.request).toHaveBeenCalledTimes(1);
    expectRefused(held,String(41-n));vi.setSystemTime(Date.now()+1000);
  }
  expect(pool.query).toHaveBeenCalledTimes(2);expect(upstream.request).toHaveBeenCalledTimes(1);
  expect((await send({cookie:session(TOKEN)})).status).toBe(200);
  expect(pool.query).toHaveBeenCalledTimes(3);
  vi.setSystemTime(56_250);statusCode=200;
  expect(await post()).toMatchObject({status:200,body:'{"ok":true}'});
  expect(pool.query).toHaveBeenCalledTimes(5);expect(upstream.request).toHaveBeenCalledTimes(2);
});
