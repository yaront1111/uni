import type {VoiceSettings} from '@unai/domain';
export interface RecognitionDraft {text:string;confidence:number|null}
export interface RecognitionSession {result:Promise<RecognitionDraft>;finish():Promise<RecognitionDraft>}
export interface SpeechEnginePort {
 capabilities(settings:VoiceSettings):Promise<boolean>;
 recognise(transcript:(text:string)=>void):RecognitionSession;
 speak(text:string,settings:VoiceSettings):Promise<void>;
 cancel():void;
}
export class FakeSpeechEngine implements SpeechEnginePort {
 available=true;listening=false;speaking=false;starts=0;spoken:string[]=[];
 result:RecognitionDraft={text:'',confidence:null};
 private endRecognition:((value:RecognitionDraft)=>void)|null=null;
 private endSpeech:(()=>void)|null=null;
 private transcript:(text:string)=>void=()=>{};
 capabilities(_settings:VoiceSettings){return Promise.resolve(this.available);}
 recognise(transcript:(text:string)=>void):RecognitionSession{
  this.listening=true;this.starts++;this.transcript=transcript;
  const result=new Promise<RecognitionDraft>(resolve=>{this.endRecognition=resolve;});
  return {result,finish:()=>{this.complete();return result;}};
 }
 interim(text:string){this.transcript(text);}
 complete(){this.listening=false;this.endRecognition?.(this.result);this.endRecognition=null;}
 speak(text:string,_settings:VoiceSettings){this.spoken.push(text);this.speaking=true;return new Promise<void>(resolve=>{this.endSpeech=resolve;});}
 finishSpeech(){this.speaking=false;this.endSpeech?.();this.endSpeech=null;}
 cancel(){this.result={text:'',confidence:null};this.complete();this.finishSpeech();}
}
interface DeviceRecognition {
 processLocally:boolean;lang:string;continuous:boolean;interimResults:boolean;
 onresult:((event:{results:ArrayLike<{isFinal:boolean;0:{transcript:string;confidence:number}}>})=>void)|null;
 onend:(()=>void)|null;onerror:(()=>void)|null;start():void;stop():void;abort():void;
}
interface RecognitionConstructor {new():DeviceRecognition;available(options:{langs:string[];processLocally:true}):Promise<string>}
/** No prefixed or remote recognition fallback. Missing proof means unavailable. */
export class LocalSpeechEngine implements SpeechEnginePort {
 private recognition:DeviceRecognition|null=null;private voice:SpeechSynthesisVoice|null=null;
 private language='';private finishRecognition:(()=>void)|null=null;private finishSpeech:(()=>void)|null=null;
 constructor(private host:Window){}
 private constructorOf(){return (this.host as Window&{SpeechRecognition?:RecognitionConstructor}).SpeechRecognition;}
 async capabilities(settings:VoiceSettings){
  this.voice=null;
  try{
   const ctor=this.constructorOf();if(!ctor?.available||!this.host.speechSynthesis)return false;
   const probe=new ctor();if(!('processLocally' in probe))return false;
   this.language=settings.language==='device'?this.host.navigator.language:settings.language;
   if(await ctor.available({langs:[this.language],processLocally:true})!=='available')return false;
   this.voice=this.host.speechSynthesis.getVoices().find(v=>v.localService===true&&v.lang.toLowerCase()===this.language.toLowerCase()&&(settings.voice==='local'||v.name===settings.voice))??null;
   return this.voice!==null;
  }catch{return false;}
 }
 recognise(transcript:(text:string)=>void):RecognitionSession{
  const ctor=this.constructorOf();if(!ctor||!this.voice)throw new Error('LOCAL_UNAVAILABLE');
  const recognition=new ctor();if(!('processLocally' in recognition))throw new Error('LOCAL_UNAVAILABLE');
  recognition.processLocally=true;if(recognition.processLocally!==true)throw new Error('LOCAL_UNAVAILABLE');
  recognition.lang=this.language;recognition.continuous=false;recognition.interimResults=true;this.recognition=recognition;
  let draft:RecognitionDraft={text:'',confidence:null};
  const result=new Promise<RecognitionDraft>((resolve,reject)=>{
   const cleanup=()=>{recognition.onresult=null;recognition.onend=null;recognition.onerror=null;if(this.recognition===recognition)this.recognition=null;this.finishRecognition=null;};
   this.finishRecognition=()=>{cleanup();resolve({text:'',confidence:null});};
   recognition.onresult=event=>{const rows=Array.from(event.results);transcript(rows.map(r=>r[0].transcript).join(' '));const finals=rows.filter(r=>r.isFinal);draft={text:finals.map(r=>r[0].transcript).join(' '),confidence:finals.length&&finals.every(r=>Number.isFinite(r[0].confidence)&&r[0].confidence>0)?Math.min(...finals.map(r=>r[0].confidence)):null};};
   recognition.onend=()=>{cleanup();resolve(draft);};recognition.onerror=()=>{cleanup();reject(new Error('LOCAL_UNAVAILABLE'));};
  });
  recognition.start();return {result,finish:()=>{if(this.recognition===recognition)recognition.stop();return result;}};
 }
 speak(text:string,settings:VoiceSettings){
  const voice=this.voice;if(!voice?.localService)throw new Error('LOCAL_UNAVAILABLE');
  const ctor=(this.host as Window&{SpeechSynthesisUtterance:typeof SpeechSynthesisUtterance}).SpeechSynthesisUtterance;
  const utterance=new ctor(text);utterance.voice=voice;utterance.lang=this.language;utterance.rate=settings.speakingRate;
  return new Promise<void>((resolve,reject)=>{const cleanup=()=>{this.finishSpeech=null;utterance.onend=null;utterance.onerror=null;};const done=()=>{cleanup();resolve();};this.finishSpeech=done;utterance.onend=done;utterance.onerror=()=>{cleanup();reject(new Error('LOCAL_UNAVAILABLE'));};this.host.speechSynthesis.speak(utterance);});
 }
 cancel(){const recognition=this.recognition;this.finishRecognition?.();recognition?.abort();this.host.speechSynthesis?.cancel();this.finishSpeech?.();}
}
