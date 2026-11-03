import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {EventEmitter} from 'node:events';
import type {IncomingMessage} from 'node:http';
import type {NextApiRequest,NextApiResponse} from 'next';

const server=vi.hoisted(()=>({identity:vi.fn(),apiRequest:vi.fn(),required:vi.fn(()=> 'https://uai.test')}));
const upstream=vi.hoisted(()=>({request:vi.fn()}));
vi.mock('node:https',()=>upstream);
vi.mock('./server',async importOriginal=>({
  ...await importOriginal<typeof import('./server')>(),...server,
}));
import handler from '../pages/api/platform/[...path].js';
import {retryAfterHeader} from './server';
const actual=await vi.importActual<typeof import('./server')>('./server');

beforeEach(()=>{vi.clearAllMocks();server.identity.mockResolvedValue({ownerScopeId:'owner',userId:'actor'});});
afterEach(()=>vi.unstubAllEnvs());

async function proxy(status:number,retryAfter:string|null|undefined){
  const body=status===429?{code:'RATE_LIMITED',correlationId:'c'}:{};
  server.apiRequest.mockResolvedValue({status,body,retryAfter});
  const response={setHeader:vi.fn(),status:vi.fn(),json:vi.fn()};response.status.mockReturnValue(response);
  await handler({query:{path:['ask']},method:'POST',headers:{origin:'https://uai.test',cookie:'session',
    'x-purpose':'memory.read','x-correlation-id':'correlation','idempotency-key':'key'},body:{question:'What is next?'}} as unknown as NextApiRequest,
  response as unknown as NextApiResponse);
  return response;
}

it('passes a rate-limit body and whole-second Retry-After to the browser',async()=>{
  const response=await proxy(429,'17');
  expect(response.setHeader).toHaveBeenCalledWith('Retry-After','17');
  expect(response.status).toHaveBeenCalledWith(429);
  expect(response.json).toHaveBeenCalledWith({code:'RATE_LIMITED',correlationId:'c'});
});

it.each([null,'17'])('never forwards Retry-After on a 200 (upstream %s)',async value=>{
  const response=await proxy(200,value);
  expect(response.status).toHaveBeenCalledWith(200);
  expect(response.setHeader.mock.calls.some(([name])=>name==='Retry-After')).toBe(false);
});

it('accepts only a bounded whole-second Retry-After',()=>{
  expect(retryAfterHeader('17')).toBe('17');
  expect(retryAfterHeader('0')).toBe('0');
  expect(retryAfterHeader('99999')).toBe('99999');
  for(const value of ['Wed, 21 Oct 2026 07:28:00 GMT',['1','2'],undefined,'123456','','1.5','-1',' 17','17\n','17\r']){
    expect(retryAfterHeader(value)).toBeNull();
  }
});

it.each(['17','Wed, 21 Oct 2026 07:28:00 GMT',undefined])('apiRequest exposes only validated Retry-After (%s)',async value=>{
  vi.stubEnv('UNAI_API_ORIGIN','https://api.test');
  vi.stubEnv('UNAI_API_CA_FILE','package.json'); // I/O double below does not use TLS.
  upstream.request.mockImplementation((_url:URL,_options:unknown,callback:(res:IncomingMessage)=>void)=>{
    const response=Object.assign(new EventEmitter(),{statusCode:429,headers:{'retry-after':value}});
    const request=Object.assign(new EventEmitter(),{setTimeout:vi.fn(),destroy:vi.fn(),end:()=>{
      callback(response as IncomingMessage);
      response.emit('data',Buffer.from('{"code":"RATE_LIMITED","correlationId":"c"}'));response.emit('end');
    }});
    return request;
  });
  expect(await actual.apiRequest('/v1/ask','POST',{},{})).toEqual({
    status:429,body:{code:'RATE_LIMITED',correlationId:'c'},retryAfter:value==='17'?'17':null,
  });
});
