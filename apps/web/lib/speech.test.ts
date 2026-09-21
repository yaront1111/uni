import {expect,it,vi} from 'vitest';
import {FakeSpeechEngine,LocalSpeechEngine} from './speech';
import {DEFAULT_VOICE_SETTINGS} from '@unai/domain';
it('verify-c8-interface: Talk tests run through a fake implementation of all four operations and screen code has no direct browser speech API dependency.',async()=>{
 const engine=new FakeSpeechEngine();expect(await engine.capabilities(DEFAULT_VOICE_SETTINGS)).toBe(true);
 const session=engine.recognise(()=>{});engine.result={text:'hello',confidence:.99};expect(await session.finish()).toEqual(engine.result);
 const speaking=engine.speak('accepted',DEFAULT_VOICE_SETTINGS);expect(engine.speaking).toBe(true);engine.cancel();await speaking;expect(engine.speaking).toBe(false);
});
it('requires proven local recognition and synthesis',async()=>{
 expect(await new LocalSpeechEngine({} as Window).capabilities(DEFAULT_VOICE_SETTINGS)).toBe(false);
});
function device(){
 class Recognition {
  static available=vi.fn(async()=> 'available');static latest:Recognition;
  processLocally=false;lang='';continuous=false;interimResults=false;
  onresult:((event:unknown)=>void)|null=null;onend:(()=>void)|null=null;onerror:(()=>void)|null=null;
  start=vi.fn(()=>{expect(this.processLocally).toBe(true);});stop=vi.fn(()=>this.onend?.());abort=vi.fn();
  constructor(){Recognition.latest=this;}
 }
 class Utterance {voice:unknown;lang='';rate=1;onend:(()=>void)|null=null;onerror:(()=>void)|null=null;constructor(readonly text:string){}}
 const voice={localService:true,lang:'en-US',name:'Local'};
 const synthesis={getVoices:()=>[voice],speak:vi.fn(),cancel:vi.fn()};
 const host={SpeechRecognition:Recognition,SpeechSynthesisUtterance:Utterance,speechSynthesis:synthesis,navigator:{language:'en-US'}} as unknown as Window;
 return {Recognition,voice,synthesis,host};
}
it('verified local adapter uses local-only recognition and an explicit local synthesis voice',async()=>{
 const {host,Recognition,voice,synthesis}=device();const engine=new LocalSpeechEngine(host);
 expect(await engine.capabilities(DEFAULT_VOICE_SETTINGS)).toBe(true);expect(Recognition.available).toHaveBeenCalledWith({langs:['en-US'],processLocally:true});
 const transcript=vi.fn();const session=engine.recognise(transcript);const recognition=Recognition.latest;
 recognition.onresult?.({results:[{isFinal:true,0:{transcript:'local question',confidence:.97}}]});expect(transcript).toHaveBeenCalledWith('local question');
 expect(await session.finish()).toEqual({text:'local question',confidence:.97});
 const speech=engine.speak('accepted text',DEFAULT_VOICE_SETTINGS);expect(synthesis.speak).toHaveBeenCalledWith(expect.objectContaining({text:'accepted text',voice}));engine.cancel();await speech;expect(synthesis.cancel).toHaveBeenCalledOnce();
});
it.each(['unavailable','downloadable','downloading'])('does not start recognition when local packs are %s',async availability=>{const {host,Recognition}=device();Recognition.available.mockResolvedValue(availability);const engine=new LocalSpeechEngine(host);expect(await engine.capabilities(DEFAULT_VOICE_SETTINGS)).toBe(false);expect(()=>engine.recognise(()=>{})).toThrow('LOCAL_UNAVAILABLE');expect(Recognition.latest.start).not.toHaveBeenCalled();});
it('rejects remote voices and unknown recognition locality',async()=>{const {host,voice,Recognition}=device();voice.localService=false;const engine=new LocalSpeechEngine(host);expect(await engine.capabilities(DEFAULT_VOICE_SETTINGS)).toBe(false);voice.localService=true;Object.defineProperty(Recognition,'available',{value:undefined});expect(await engine.capabilities(DEFAULT_VOICE_SETTINGS)).toBe(false);});
it('local synthesis errors reject instead of resuming hands-free recognition',async()=>{const {host,synthesis}=device();const engine=new LocalSpeechEngine(host);await engine.capabilities(DEFAULT_VOICE_SETTINGS);const speaking=engine.speak('accepted',DEFAULT_VOICE_SETTINGS);const outcome=expect(speaking).rejects.toThrow('LOCAL_UNAVAILABLE');(synthesis.speak.mock.calls[0] as unknown as [{onerror:()=>void}])[0].onerror();await outcome;});
