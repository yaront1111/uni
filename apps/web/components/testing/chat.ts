import type {ChatProps} from '../../lib/chat';
import {askAnsweredProps} from './screens';
export const chatId='00000000-0000-4000-8000-000000000001';
export function chatFixture():ChatProps{
 const conversation={id:chatId,ownerScopeId:'00000000-0000-4000-8000-000000000009',title:'Daniel',createdAt:'2026-09-21T00:00:00.000Z',lastActivityAt:'2026-09-21T00:00:00.000Z'};
 const base={conversationId:chatId,ownerScopeId:conversation.ownerScopeId,createdAt:conversation.createdAt,status:'accepted' as const};
 const turnId='00000000-0000-4000-8000-000000000003';
 return {conversations:[conversation],conversation,turns:[{...base,id:'00000000-0000-4000-8000-000000000002',storedOrder:0,speaker:'owner',text:'What did I promise Daniel?'},
  {...base,id:turnId,storedOrder:1,speaker:'assistant',text:'send Daniel the signed lease'}],
  answers:{[turnId]:{...askAnsweredProps.answer!,conversationId:chatId,turnId}},why:{[turnId]:askAnsweredProps.why},error:null};
}
