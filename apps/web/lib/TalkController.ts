import {askAnswerSchema,type VoiceSettings} from '@unai/domain';
import type {ChatProps} from './chat';
import type {RecognitionDraft,RecognitionSession,SpeechEnginePort} from './speech';
export type TalkState='idle'|'listening'|'thinking'|'speaking'|'unavailable';
export interface TalkSnapshot {state:TalkState;draft:RecognitionDraft|null;transcript:string;dialogue:boolean;data:ChatProps;error:string|null}
export type TalkExchange=ChatProps&{answerTurnId:string};
export class TalkController {
 snapshot:TalkSnapshot;
 private generation=0;private disposed=false;private available=false;private held=false;
 private session:RecognitionSession|null=null;private result:RecognitionDraft|null=null;
 private inactivity:ReturnType<typeof setTimeout>|null=null;private expiry:ReturnType<typeof setTimeout>|null=null;
 constructor(readonly engine:SpeechEnginePort,readonly settings:VoiceSettings|null,data:ChatProps,readonly ask:(text:string)=>Promise<TalkExchange>,readonly changed:()=>void){this.snapshot={state:'unavailable',draft:null,transcript:'',dialogue:false,data,error:null};}
 private update(patch:Partial<TalkSnapshot>){this.snapshot={...this.snapshot,...patch};if(!this.disposed)this.changed();}
 async initialise(){const generation=this.generation;const settings=this.settings;let available=false;
  try{available=!!settings&&settings.speechEnabled&&settings.provider==='local'&&await this.engine.capabilities(settings);}catch{}
  if(this.disposed||generation!==this.generation)return;this.available=available;this.update({state:available?'idle':'unavailable'});
 }
 private activity(){if(!this.snapshot.dialogue)return;if(this.inactivity)clearTimeout(this.inactivity);this.inactivity=setTimeout(()=>this.stop(),30000);}
 press(){if(this.disposed||!this.available||this.snapshot.state!=='idle'||this.snapshot.draft||this.session)return;this.held=true;this.listen();}
 private listen(){
  const generation=++this.generation;this.result=null;this.update({state:'listening',transcript:'',error:null});this.activity();
  try{this.session=this.engine.recognise(text=>{if(generation!==this.generation||this.disposed)return;this.update({transcript:text});if(text.trim())this.activity();});
   void this.session.result.then(result=>{if(generation!==this.generation||this.disposed)return;this.result=result;if(!this.held)this.recognised(result);},()=>{if(generation===this.generation)this.fail();});
  }catch{this.fail();}
 }
 release(){if(!this.held)return;this.held=false;if(this.result)this.recognised(this.result);else if(this.session){this.update({state:'thinking'});void this.session.finish().catch(()=>{});}}
 private recognised(result:RecognitionDraft){this.session=null;this.result=null;const text=result.text.trim();if(!text){this.stop();return;}
  this.activity();this.update({transcript:text});
  if(result.confidence!==null&&Number.isFinite(result.confidence)&&result.confidence>=.9&&result.confidence<=1)void this.submit(text);
  else this.update({state:'idle',draft:{...result,text}});
 }
 confirm(text:string){if(!this.snapshot.draft||!text.trim()||this.disposed)return;this.update({draft:null});this.activity();void this.submit(text.trim());}
 private async submit(text:string){const generation=this.generation;this.update({state:'thinking',draft:null});
  try{const data=await this.ask(text);if(this.disposed||generation!==this.generation)return;
   this.update({data});
   const latest=data.turns.find(t=>t.id===data.answerTurnId&&t.speaker==='assistant');
   const answer=latest&&latest.status==='accepted'?askAnswerSchema.safeParse(data.answers[latest.id]):null;
   if(answer?.success&&answer.data.turnId===latest!.id&&answer.data.conversationId===latest!.conversationId&&answer.data.grounding.action!=='BLOCKED'){
    // These are the persisted validator-accepted statement bytes also rendered by Chat.
    const text=answer.data.statements.filter(s=>!['NOTHING_FOUND','MEMORY_INCOMPLETE','HISTORICAL_INSTANT_MISSING','WITHHELD','GROUNDING_BLOCKED'].includes(s.kind)).map(s=>s.text).join('\n');
    if(text){this.update({state:'speaking'});await this.engine.speak(text,this.settings!);}
   }
   if(this.disposed||generation!==this.generation)return;this.update({state:'idle',transcript:''});
   if(this.snapshot.dialogue)this.listen();
  }catch{if(generation===this.generation&&!this.disposed)this.fail();}
 }
 private fail(){this.stop();this.available=false;this.update({state:'unavailable',error:'Talk is unavailable. Continue in Chat.'});}
 stop(){++this.generation;this.held=false;this.session=null;this.result=null;
  if(this.inactivity)clearTimeout(this.inactivity);if(this.expiry)clearTimeout(this.expiry);this.inactivity=null;this.expiry=null;
  this.engine.cancel();this.update({state:this.available?'idle':'unavailable',draft:null,dialogue:false,transcript:''});
 }
 startDialogue(){if(!this.settings?.handsFreeEnabled||!this.available||this.disposed||this.snapshot.state!=='idle'||this.snapshot.draft||this.snapshot.dialogue)return;
  this.update({dialogue:true});this.held=false;this.expiry=setTimeout(()=>this.stop(),300000);this.listen();
 }
 dispose(){this.disposed=true;this.stop();}
}
