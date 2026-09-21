import {randomUUID} from 'node:crypto';
import {askAnswerSchema,conversationTurnSchema,persistedConversationSchema,type AskAnswer,type Conversation,type ConversationTurn,type WhySources} from '@unai/domain';
import {loadWhy,whyRefOf,type ApiCall,type Caller} from './screens';
export interface ChatProps{
 conversations:Conversation[];conversation:Conversation|null;turns:ConversationTurn[];
 answers:Record<string,AskAnswer>;why:Record<string,Record<string,WhySources|null>>;error:string|null;
}
export const emptyChat=():ChatProps=>({conversations:[],conversation:null,turns:[],answers:{},why:{},error:null});
/** Reads existing explanation objects for each specific persisted answer. */
export async function loadChat(call:ApiCall,caller:Caller,id?:string):Promise<{kind:'expired'}|{kind:'props';props:ChatProps}>{
 const props=emptyChat();
 const headers=()=>({cookie:caller.cookie,'x-owner-scope-id':caller.ownerScopeId,'x-purpose':'conversation.read','x-correlation-id':randomUUID(),
  'x-data-purpose':'PERSONAL_ASSISTANCE','x-maximum-sensitivity':'RESTRICTED'});
 try{
  const listed=await call('/v1/conversations','GET',headers());if(listed.status===401)return {kind:'expired'};
  if(listed.status!==200)throw new Error('UNAVAILABLE');
  props.conversations=persistedConversationSchema.array().parse((listed.body as {conversations:unknown}).conversations);
  const selected=id??props.conversations[0]?.id;
  if(selected){
   const parsed=persistedConversationSchema.shape.id.safeParse(selected);if(!parsed.success)throw new Error('INVALID');
   const response=await call('/v1/conversations/'+parsed.data,'GET',headers());if(response.status===401)return {kind:'expired'};
   if(response.status!==200)throw new Error('UNAVAILABLE');
   const body=response.body as {conversation:unknown;turns:unknown;answers:Record<string,unknown>};
   props.conversation=persistedConversationSchema.parse(body.conversation);
   if(props.conversation.id!==selected||props.conversation.ownerScopeId!==caller.ownerScopeId)throw new Error('ASSOCIATION');
   props.turns=conversationTurnSchema.array().parse(body.turns).sort((a,b)=>a.storedOrder-b.storedOrder);
   for(const turn of props.turns){
    if(turn.conversationId!==selected||turn.ownerScopeId!==caller.ownerScopeId)throw new Error('ASSOCIATION');
    if(turn.speaker!=='assistant'||turn.status!=='accepted')continue;
    const answer=askAnswerSchema.safeParse(body.answers?.[turn.id]);
    if(!answer.success||answer.data.turnId!==turn.id||answer.data.conversationId!==selected||answer.data.grounding.action==='BLOCKED')continue;
    props.answers[turn.id]=answer.data;props.why[turn.id]={};
    for(const statement of answer.data.statements){
     const ref=whyRefOf(statement);const panel=ref?await loadWhy(call,caller,ref):null;
     if(panel==='expired')return {kind:'expired'};
     props.why[turn.id]![statement.statementId]=panel;
    }
   }
  }
  return {kind:'props',props};
 }catch{return {kind:'props',props:{...emptyChat(),error:'Conversations could not be loaded. Please retry.'}};}
}
