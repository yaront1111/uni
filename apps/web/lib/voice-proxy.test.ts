import {beforeEach,expect,it,vi} from 'vitest';
import type {NextApiRequest,NextApiResponse} from 'next';
const server=vi.hoisted(()=>({identity:vi.fn(),apiRequest:vi.fn(),required:vi.fn(()=> 'https://uai.test')}));
vi.mock('./server',()=>server);
import handler from '../pages/api/platform/[...path]';
beforeEach(()=>{vi.clearAllMocks();server.identity.mockResolvedValue({ownerScopeId:'owner',userId:'actor'});server.apiRequest.mockResolvedValue({status:200,body:{speechEnabled:false}});});
it('forwards voice PATCH with authenticated owner and required write headers',async()=>{
 const response={setHeader:vi.fn(),status:vi.fn(),json:vi.fn()};response.status.mockReturnValue(response);
 await handler({query:{path:['settings','voice']},method:'PATCH',headers:{origin:'https://uai.test',cookie:'session','x-purpose':'settings.voice','x-correlation-id':'correlation','idempotency-key':'key'},body:{speechEnabled:false}} as unknown as NextApiRequest,response as unknown as NextApiResponse);
 expect(response.status).toHaveBeenCalledWith(200);
 expect(server.apiRequest).toHaveBeenCalledWith('/v1/settings/voice','PATCH',expect.objectContaining({'x-owner-scope-id':'owner','x-purpose':'settings.voice','x-correlation-id':'correlation','idempotency-key':'key'}),{speechEnabled:false},undefined);
});
