import {beforeEach,expect,it,vi} from 'vitest';
import type {NextApiRequest,NextApiResponse} from 'next';
const server=vi.hoisted(()=>({identity:vi.fn(),apiRequest:vi.fn(),required:vi.fn(()=> 'https://uai.test')}));
vi.mock('./server',()=>server);
import handler from '../pages/api/platform/[...path]';
beforeEach(()=>{vi.clearAllMocks();server.identity.mockResolvedValue({ownerScopeId:'owner',userId:'actor'});server.apiRequest.mockResolvedValue({status:200,body:{}});});
it.each(['propose','00000000-0000-4000-8000-000000000001/commit','00000000-0000-4000-8000-000000000001/reject'])('verify-d2-inbox verify-r04-proposal: proxies governed %s with authenticated scope',async operation=>{
 const response={setHeader:vi.fn(),status:vi.fn(),json:vi.fn()};response.status.mockReturnValue(response);
 await handler({query:{path:('memory/transactions/'+operation).split('/')},method:'POST',headers:{origin:'https://uai.test',cookie:'session','x-purpose':'memory.govern','x-correlation-id':'correlation','idempotency-key':'key'},body:{}} as unknown as NextApiRequest,response as unknown as NextApiResponse);
 expect(response.status).toHaveBeenCalledWith(200);
 expect(server.apiRequest).toHaveBeenCalledWith('/v1/memory/transactions/'+operation,'POST',expect.objectContaining({'x-owner-scope-id':'owner','x-data-purpose':'PERSONAL_ASSISTANCE','x-purpose':'memory.govern','x-correlation-id':'correlation','idempotency-key':'key'}),{},undefined);
});
it('proxies an owner outcome to POST /v1/memory/resolutions under memory.govern with the pinned evidence context',async()=>{
 const response={setHeader:vi.fn(),status:vi.fn(),json:vi.fn()};response.status.mockReturnValue(response);
 const body={statement:'Done, I sent it',sourceFrameInstanceId:'00000000-0000-4000-8000-000000000002'};
 await handler({query:{path:['memory','resolutions']},method:'POST',headers:{origin:'https://uai.test',cookie:'session','x-purpose':'memory.govern','x-correlation-id':'correlation','idempotency-key':'key','x-data-purpose':'MARKETING','x-maximum-sensitivity':'NORMAL'},body} as unknown as NextApiRequest,response as unknown as NextApiResponse);
 expect(response.status).toHaveBeenCalledWith(200);
 expect(server.apiRequest).toHaveBeenCalledWith('/v1/memory/resolutions','POST',expect.objectContaining({'x-owner-scope-id':'owner','x-purpose':'memory.govern','x-data-purpose':'PERSONAL_ASSISTANCE','x-maximum-sensitivity':'RESTRICTED','x-correlation-id':'correlation','idempotency-key':'key'}),body,undefined);
});
it('refuses an owner outcome declared under any purpose but memory.govern',async()=>{
 const response={setHeader:vi.fn(),status:vi.fn(),json:vi.fn()};response.status.mockReturnValue(response);
 await handler({query:{path:['memory','resolutions']},method:'POST',headers:{origin:'https://uai.test',cookie:'session','x-purpose':'memory.correct','x-correlation-id':'correlation','idempotency-key':'key'},body:{statement:'Done'}} as unknown as NextApiRequest,response as unknown as NextApiResponse);
 expect(response.status).toHaveBeenCalledWith(403);
 expect(response.json).toHaveBeenCalledWith({code:'PURPOSE_REFUSED'});
 expect(server.apiRequest).not.toHaveBeenCalled();
});
