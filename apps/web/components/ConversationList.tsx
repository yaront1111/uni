import React,{useState} from 'react';
import type {Conversation,DeletionReceipt} from '@unai/domain';
export interface ConversationListProps{
 conversations:Conversation[];selected:string|null;busy:boolean;
 onCreate:()=>Promise<void>;onRename:(id:string,title:string)=>Promise<void>;
 onPreview:(id:string)=>Promise<DeletionReceipt|null>;onDelete:(id:string)=>Promise<void>;
}
export function ConversationList(props:ConversationListProps){
 const [editing,setEditing]=useState<string|null>(null),[title,setTitle]=useState('');
 const [preview,setPreview]=useState<DeletionReceipt|null>(null),[confirmation,setConfirmation]=useState('');
 return <section className="conversation-list" aria-labelledby="conversation-list-title">
  <h2 id="conversation-list-title">Conversations</h2><button disabled={props.busy} type="button" onClick={()=>void props.onCreate()}>New conversation</button>
  {!props.conversations.length?<p>No conversations yet.</p>:null}
  <ol>{[...props.conversations].sort((a,b)=>b.lastActivityAt.localeCompare(a.lastActivityAt)||b.id.localeCompare(a.id)).map(c=><li key={c.id}>
   <a href={'/chat?conversation='+c.id} aria-current={props.selected===c.id?'page':undefined}>{c.title}</a>
   <div className="actions"><button disabled={props.busy} type="button" aria-label={'Rename '+c.title} onClick={()=>{setEditing(c.id);setTitle(c.title);}}>Rename</button>
    <button disabled={props.busy} type="button" aria-label={'Delete '+c.title} onClick={()=>{setConfirmation('');void props.onPreview(c.id).then(setPreview);}}>Delete</button></div>
   {editing===c.id?<form onSubmit={e=>{e.preventDefault();void props.onRename(c.id,title).then(()=>setEditing(null));}}>
    <label htmlFor={'title-'+c.id}>Conversation title</label><input id={'title-'+c.id} value={title} required maxLength={200} onChange={e=>setTitle(e.target.value)}/>
    <button disabled={props.busy||!title.trim()} type="submit">Save title</button><button type="button" onClick={()=>setEditing(null)}>Cancel rename</button></form>:null}
  </li>)}</ol>
  {preview?<form className="deletion-preview" onSubmit={e=>{e.preventDefault();const id=preview.conversationIds[0];if(id)void props.onDelete(id).then(()=>setPreview(null));}}>
   <h3>Delete conversation</h3><p>This permanently removes {preview.cascade.conversations} conversation and {preview.cascade.conversationTurns} turns. The deletion is audited and omitted from future exports.</p>
   <label htmlFor="chat-delete-confirmation">Type DELETE to confirm</label><input id="chat-delete-confirmation" value={confirmation} onChange={e=>setConfirmation(e.target.value)}/>
   <button type="submit" disabled={props.busy||confirmation!=='DELETE'}>Confirm deletion</button><button type="button" onClick={()=>setPreview(null)}>Cancel deletion</button>
  </form>:null}
  <p><a href="/data">Export and data controls</a> · <a href="/ops/audit">Audit log</a></p>
 </section>;
}
