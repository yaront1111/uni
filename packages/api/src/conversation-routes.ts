import type {FastifyInstance,FastifyRequest} from 'fastify';
import type {OwnerTransaction} from '@unai/postgres';
import {conversationTitleSchema,persistedConversationSchema,askAnswerSchema,dataPurposeSchema,sensitivitySchema,type AskAnswer,type Conversation,type ConversationTurn} from '@unai/domain';
import {ConversationService,ControlError} from '@unai/control';
import {readAnswerManifest,ContextBrokerError} from '@unai/context';
type Work=(request:FastifyRequest,run:(tx:OwnerTransaction,sessionId:string)=>Promise<unknown>,purpose?:string)=>Promise<unknown>;
/** Transport only: lifecycle, owner isolation and ordering belong to the service. */
export function registerConversationRoutes(app:FastifyInstance,work:Work){
 const audit=(tx:OwnerTransaction,ids:string[])=>tx.audit({policyDecision:'ALLOW',codeVersion:'0.1.0',result:'SUCCESS',
  objects:ids.slice(0,100).map(id=>({type:'conversations',id,fields:['id','title','last_activity_at']}))});
 app.get('/v1/conversations',request=>work(request,async tx=>{
  const conversations=await new ConversationService(tx).list();await audit(tx,conversations.map(c=>c.id));return {conversations};
 }));
 app.post('/v1/conversations',async(request,reply)=>{
  const parsed=conversationTitleSchema.safeParse((request.body as {title?:unknown}|null)?.title);
  if(!parsed.success)return reply.code(400).send({code:'CONVERSATION_TITLE_INVALID'});
  return work(request,async tx=>{const conversation=await new ConversationService(tx).create({title:parsed.data});await audit(tx,[conversation.id]);return conversation;});
 });
 app.patch<{Params:{id:string}}>('/v1/conversations/:id',async(request,reply)=>{
  const id=persistedConversationSchema.shape.id.safeParse(request.params.id);
  const title=conversationTitleSchema.safeParse((request.body as {title?:unknown}|null)?.title);
  if(!id.success||!title.success)return reply.code(400).send({code:'CONVERSATION_INPUT_INVALID'});
  try{return await work(request,async tx=>{const conversation=await new ConversationService(tx).rename(id.data,title.data);await audit(tx,[id.data]);return conversation;});}
  catch(error){if(error instanceof ControlError)return reply.code(404).send({code:'CONVERSATION_NOT_FOUND'});throw error;}
 });
 app.get<{Params:{id:string}}>('/v1/conversations/:id',async(request,reply)=>{
  const id=persistedConversationSchema.shape.id.safeParse(request.params.id);
  if(!id.success)return reply.code(400).send({code:'CONVERSATION_INPUT_INVALID'});
  const purpose=dataPurposeSchema.safeParse(request.headers['x-data-purpose']),ceiling=sensitivitySchema.safeParse(request.headers['x-maximum-sensitivity']);
  if(!purpose.success||!ceiling.success)return reply.code(400).send({code:'CONVERSATION_SCOPE_REQUIRED'});
  const scope=(tx:OwnerTransaction)=>tx.query("SELECT set_config('unai.data_purpose',$1,true),set_config('unai.maximum_sensitivity',$2,true)",[purpose.data,ceiling.data]);
  try{const result=await work(request,async tx=>{
   await scope(tx);
   const view=await new ConversationService(tx).get(id.data);
   const rows=(await tx.query(`SELECT t.id,t.presented_answer,a.answer_manifest_id FROM conversation_turns t
    JOIN answer_provenance a ON a.owner_scope_id=t.owner_scope_id AND a.turn_id=t.id
    WHERE t.owner_scope_id=$1 AND t.conversation_id=$2 AND t.presented_answer IS NOT NULL`,[tx.context.ownerScopeId,id.data])).rows;
   const answers:Record<string,AskAnswer>={};
   for(const row of rows){const parsed=askAnswerSchema.safeParse({...row['presented_answer'],answerManifestId:row['answer_manifest_id'],conversationId:id.data,turnId:row['id']});
    if(parsed.success&&parsed.data.grounding.action!=='BLOCKED')answers[row['id']]=parsed.data;}
   await audit(tx,[id.data]);return {...view,answers};
  }) as {conversation:Conversation;turns:ConversationTurn[];answers:Record<string,AskAnswer>};
  // Reuse the manifest's current source permission check before releasing stored
  // answer bytes. Separate transactions avoid holding the session lock recursively.
  for(const turn of result.turns.filter(t=>t.speaker==='assistant'&&t.status==='accepted')){
   const answer=result.answers[turn.id];let readable=false;
   if(answer?.answerManifestId)try{readable=await work(request,async tx=>{
    await scope(tx);
    const manifest=await readAnswerManifest(tx,{ownerScopeId:tx.context.ownerScopeId,answerManifestId:answer.answerManifestId!});
    await audit(tx,[id.data]);return manifest?.turnId===turn.id&&manifest.conversationId===id.data;
   },'memory.inspect') as boolean;}catch(error){if(!(error instanceof ContextBrokerError))throw error;}
   if(!readable){delete result.answers[turn.id];turn.text=null;turn.status='unable';}
  }
  return result;
  }catch(error){if(error instanceof ControlError)return reply.code(404).send({code:'CONVERSATION_NOT_FOUND'});throw error;}
 });
}
