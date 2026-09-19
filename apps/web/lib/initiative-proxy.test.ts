import {beforeEach,expect,it,vi} from 'vitest';
import type {NextApiRequest,NextApiResponse} from 'next';
const server=vi.hoisted(()=>({identity:vi.fn(),apiRequest:vi.fn(),required:vi.fn(()=> 'https://uai.test')}));
vi.mock('./server',()=>server);
import handler from '../pages/api/platform/[...path]';
const id='00000000-0000-4000-8000-000000000001';
beforeEach(()=>{vi.clearAllMocks();server.identity.mockResolvedValue({ownerScopeId:id,userId:id});server.apiRequest.mockResolvedValue({status:200,body:{ok:true}});});
async function call(path:string,method:string,purpose:string){const response={setHeader:vi.fn(),status:vi.fn(),json:vi.fn()};response.status.mockReturnValue(response);
 await handler({query:{path:path.split('/')},method,headers:{origin:'https://uai.test',cookie:'session','x-purpose':purpose,'x-correlation-id':id,'idempotency-key':id,'x-data-purpose':'MARKETING','x-maximum-sensitivity':'RESTRICTED'},
  body:{enabled:true,dataPurpose:'MARKETING',maximumSensitivity:'RESTRICTED'}} as unknown as NextApiRequest,response as unknown as NextApiResponse);return response;}
it('forwards only the declared initiative write methods and pins source authority',async()=>{
 for(const [path,method,purpose] of [['settings/initiative','PATCH','settings.attention'],['initiative/watches','POST','memory.correct'],['initiative/watches/'+id,'PATCH','memory.correct']]){
  server.apiRequest.mockClear();expect((await call(path!,method!,purpose!)).status).toHaveBeenCalledWith(200);
  expect(server.apiRequest).toHaveBeenCalledWith('/v1/'+path,method,expect.objectContaining({'x-purpose':purpose,'x-data-purpose':'PERSONAL_ASSISTANCE','x-maximum-sensitivity':'PRIVATE'}),
   path==='settings/initiative'?expect.objectContaining({dataPurpose:'PERSONAL_ASSISTANCE',maximumSensitivity:'PRIVATE'}):expect.anything(),undefined);
 }
});
it('refuses method and purpose substitution before reaching the API',async()=>{
 expect((await call('initiative/watches/'+id,'POST','memory.correct')).status).toHaveBeenCalledWith(405);
 expect((await call('settings/initiative','PATCH','permissions.manage')).status).toHaveBeenCalledWith(403);
 expect(server.apiRequest).not.toHaveBeenCalled();
});
