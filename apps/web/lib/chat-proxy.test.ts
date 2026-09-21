import {beforeEach,expect,it,vi} from 'vitest';
import type {NextApiRequest,NextApiResponse} from 'next';
const server=vi.hoisted(()=>({identity:vi.fn(),apiRequest:vi.fn(),required:vi.fn(()=> 'https://uai.test')}));
vi.mock('./server',()=>server);
import handler from '../pages/api/platform/[...path]';
beforeEach(()=>{vi.clearAllMocks();server.identity.mockResolvedValue({ownerScopeId:'owner',userId:'actor'});server.apiRequest.mockResolvedValue({status:200,body:{}});});
it.each([['conversations','POST','conversation.write'],['conversations/00000000-0000-4000-8000-000000000001','PATCH','conversation.write'],['ask','POST','memory.read']])('forwards %s through the authenticated write proxy',async(path,method,purpose)=>{
 const response={setHeader:vi.fn(),status:vi.fn(),json:vi.fn()};response.status.mockReturnValue(response);
 await handler({query:{path:path.split('/')},method,headers:{origin:'https://uai.test',cookie:'session','x-purpose':purpose,'x-correlation-id':'correlation','idempotency-key':'key'},body:{question:'Question',ownerScopeId:'intruder',purpose:'ADVERTISING'}} as unknown as NextApiRequest,response as unknown as NextApiResponse);
 expect(response.status).toHaveBeenCalledWith(200);
 expect(server.apiRequest).toHaveBeenCalledWith('/v1/'+path,method,expect.objectContaining({'x-owner-scope-id':'owner','x-purpose':purpose,'x-correlation-id':'correlation','idempotency-key':'key'}),path==='ask'?expect.objectContaining({ownerScopeId:'owner',purpose:'PERSONAL_ASSISTANCE',maximumSensitivity:'RESTRICTED',worldTime:'NOW',knowledgeTime:'LATEST'}):expect.any(Object),undefined);
});
