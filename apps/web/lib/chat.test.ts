import {beforeEach,expect,it,vi} from 'vitest';
import type {GetServerSidePropsContext,NextApiRequest,NextApiResponse} from 'next';
import {loadChat} from './chat';
import {chatFixture,chatId} from '../components/testing/chat';
import {askAnsweredProps} from '../components/testing/screens';
const server=vi.hoisted(()=>({identity:vi.fn(),apiRequest:vi.fn()}));vi.mock('./server',()=>server);
import {getServerSideProps as chatRoute} from '../pages/chat';
import {getServerSideProps as askRoute} from '../pages/ask';
import readChat from '../pages/api/chat';
const context=(query:Record<string,string>={})=>({req:{headers:{cookie:'session'}},res:{setHeader:vi.fn()},query} as unknown as GetServerSidePropsContext);
beforeEach(()=>{vi.clearAllMocks();server.identity.mockResolvedValue({ownerScopeId:chatFixture().conversation!.ownerScopeId});});
it('real /chat route reads ordered owner turns and turn-specific explanations using server identity',async()=>{
 const fixture=chatFixture();server.apiRequest.mockImplementation(async(path:string)=>({status:200,body:path==='/v1/conversations'?{conversations:fixture.conversations}:path==='/v1/conversations/'+chatId?fixture:askAnsweredProps.why.S1}));
 const loaded=await chatRoute(context({conversation:chatId}));expect(loaded).toHaveProperty('props.turns',fixture.turns);
 expect(loaded).toHaveProperty('props.why.'+fixture.turns[1]!.id+'.S1',askAnsweredProps.why.S1);
 expect(server.apiRequest.mock.calls.every(call=>call[2]['x-owner-scope-id']===fixture.conversation!.ownerScopeId)).toBe(true);
});
it('verify-b2-expired: An expired-session response causes navigation to exactly /signin?reason=expired.',async()=>{
 server.apiRequest.mockResolvedValue({status:401,body:{}});
 expect(await chatRoute(context())).toEqual({redirect:{destination:'/signin?reason=expired',permanent:false}});
 expect(await askRoute(context({q:'Question'}))).toEqual({redirect:{destination:'/signin?reason=expired',permanent:false}});
 server.identity.mockResolvedValue(null);expect(await chatRoute(context())).toEqual({redirect:{destination:'/signin?reason=expired',permanent:false}});
});
it('verify-b5-ask: Visiting /ask?q= with a question creates a new conversation containing the same grounded answer produced for that question.',async()=>{
 const answer={...askAnsweredProps.answer!,conversationId:chatId,turnId:chatFixture().turns[1]!.id};
 server.apiRequest.mockImplementation(async(path:string)=>({status:200,body:path==='/v1/ask'?answer:askAnsweredProps.why.S1}));
 expect(await askRoute(context({q:answer.question}))).toEqual({redirect:{destination:'/chat?conversation='+chatId,permanent:false}});
 const asks=server.apiRequest.mock.calls.filter(call=>call[0]==='/v1/ask');expect(asks).toHaveLength(1);expect(asks[0]![3]).not.toHaveProperty('conversationId');expect(asks[0]![3].question).toBe(answer.question);
});
it('rejects mismatched answer associations instead of displaying another turn',async()=>{
 const fixture=chatFixture();fixture.answers[fixture.turns[1]!.id]!.turnId=chatId;
 const loaded=await loadChat(async path=>({status:200,body:path==='/v1/conversations'?{conversations:fixture.conversations}:fixture}),{cookie:'session',ownerScopeId:fixture.conversation!.ownerScopeId},chatId);
 expect(loaded).toHaveProperty('props.answers',{});
});
it('read API authenticates and returns fixed failure without exception content',async()=>{
 server.apiRequest.mockRejectedValue(new Error('private database password'));
 const res={setHeader:vi.fn(),status:vi.fn(),json:vi.fn()};res.status.mockReturnValue(res);
 await readChat({method:'GET',headers:{cookie:'session'},query:{}} as NextApiRequest,res as unknown as NextApiResponse);
 expect(server.identity).toHaveBeenCalledOnce();expect(res.status).toHaveBeenCalledWith(503);expect(JSON.stringify(res.json.mock.calls)).not.toContain('password');
});
