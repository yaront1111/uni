// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';
import {act,createElement} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import axe from 'axe-core';
import {DEFAULT_VOICE_SETTINGS,cascadeCountsSchema,type PermissionsView} from '@unai/domain';
import {VoiceSettingsPanel} from './VoiceSettingsPanel';
import {Configuration} from './Configuration';
import {DataControl} from './DataControl';
import {KeyboardUser,accessibleName} from './testing/keyboard';
(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let root:Root|null=null;
afterEach(()=>{act(()=>root?.unmount());root=null;document.body.innerHTML='';vi.unstubAllGlobals();vi.restoreAllMocks();});
async function mount(component:React.ReactElement){document.documentElement.lang='en';document.title='Configuration';document.body.innerHTML='<div id="root"></div>';root=createRoot(document.getElementById('root')!);await act(async()=>root!.render(component));}
async function press(user:KeyboardUser,name:RegExp,key:'Enter'|' '='Enter'){expect(user.tabTo(e=>name.test(accessibleName(e)))).not.toBeNull();await act(async()=>user.press(key));}
const permissions:PermissionsView={connectedSources:[],domainSensitivity:[],pluginCapabilities:[],attentionBudget:{maxCardsPerDay:3,maxCardsPerSensitivityScopePerDay:1,repeatQuestionSuppressionDays:7,isDefault:true,updatedAt:null},retention:[],dataRequests:[]};
it('changes every voice preference with the keyboard and saving never requests microphone or speech',async()=>{
 const microphone=vi.fn(),speak=vi.fn();Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:microphone}});vi.stubGlobal('speechSynthesis',{speak});
 const fetcher=vi.fn(async(_url:unknown,options:RequestInit)=>({ok:true,status:200,json:async()=>JSON.parse(String(options.body))}));vi.stubGlobal('fetch',fetcher);
 await mount(createElement(VoiceSettingsPanel,{settings:DEFAULT_VOICE_SETTINGS}));expect(fetcher).not.toHaveBeenCalled();
 const user=new KeyboardUser(document);
 await press(user,/Speech enabled/,' ');await press(user,/Enable Microsoft Azure AI Speech/,' ');
 expect(user.tabTo(e=>e.id==='voice-provider')).not.toBeNull();await act(async()=>user.arrowDown());
 for(const [id,value] of [['voice-language','he-IL'],['voice-choice','chosen-voice'],['voice-rate','1.2']]){expect(user.tabTo(e=>e.id===id)).not.toBeNull();await act(async()=>user.type(value!));}
 await press(user,/Hands-free preference/,' ');await press(user,/Save voice settings/);
 expect(fetcher).toHaveBeenCalledTimes(1);const [path,request]=fetcher.mock.calls[0]!;
 expect(path).toBe('/api/platform/settings/voice');expect(request.method).toBe('PATCH');
 expect(JSON.parse(String(request.body))).toEqual({speechEnabled:false,provider:'remote',remoteEnabled:true,language:'he-IL',voice:'chosen-voice',speakingRate:1.2,handsFreeEnabled:true});
 expect(request.headers).toMatchObject({'x-purpose':'settings.voice','x-correlation-id':expect.any(String),'idempotency-key':expect.any(String)});
 expect(document.body.textContent).toContain('Voice settings saved');expect(microphone).not.toHaveBeenCalled();expect(speak).not.toHaveBeenCalled();
});
it('can save a persisted fractional rate accepted by the settings API',async()=>{
 await mount(createElement(VoiceSettingsPanel,{settings:{...DEFAULT_VOICE_SETTINGS,speakingRate:1.25}}));
 expect(document.querySelector('form')!.checkValidity()).toBe(true);
});
it('verify-d4-connectors: At /admin/configuration the owner can connect, inspect status and revoke using the existing connector functionality.',async()=>{
 const fetcher=vi.fn(async()=>({ok:false,status:503,json:async()=>({code:'UNAVAILABLE'})}));vi.stubGlobal('fetch',fetcher);
 await mount(createElement(Configuration,{voice:DEFAULT_VOICE_SETTINGS,metrics:null,connectors:[],devices:[],currentDeviceId:null,errors:[],permissions,approvalRules:{rules:[],readAt:'2026-09-20T00:00:00.000Z'}}));
 const user=new KeyboardUser(document);expect(user.tabTo(e=>e.id==='connect-account')).not.toBeNull();await act(async()=>user.type('owner@example.test'));await press(user,/^Connect source$/);
 expect(fetcher).toHaveBeenCalledWith('/api/platform/connectors',expect.objectContaining({method:'POST',body:JSON.stringify({connectorType:'GMAIL',externalAccountRef:'owner@example.test',requestedCapabilities:[],secretRef:null})}));
 expect(document.body.textContent).toContain('The request was refused');
 const result=await axe.run(document,{rules:{'color-contrast':{enabled:false}}});expect(result.violations.map(v=>v.id)).toEqual([]);
 expect(document.querySelectorAll('main')).toHaveLength(1);expect(document.querySelectorAll('h1')).toHaveLength(1);
});
it('data controls offer conversation deletion and apply existing retention cleanup',async()=>{
 await mount(createElement(DataControl,{state:'IDLE',exportSummary:null,reindex:null,preview:null,receipt:null,error:null}));
 expect(document.querySelector('#delete-conversations')).not.toBeNull();
 expect(document.body.textContent).toContain('Apply saved retention now');
});
it('previews a conversation deletion before committing its exact scope, then shows the receipt',async()=>{
 const id='00000000-0000-4000-8000-000000000001';
 const cascade=cascadeCountsSchema.parse(Object.fromEntries(Object.keys(cascadeCountsSchema.shape).map(key=>[key,key==='conversations'?1:key==='conversationTurns'?2:0])));
 const receipt={requestId:null,status:'PREVIEW',trigger:'OWNER_REQUEST',evidenceIds:[],conversationIds:[id],cascade,projectionsRebuilt:[],auditRetainsPayload:false};
 const fetcher=vi.fn(async(path:string)=>({ok:true,status:200,json:async()=>path.endsWith('preview')?receipt:{...receipt,status:'COMPLETED',requestId:id}}));vi.stubGlobal('fetch',fetcher);
 await mount(createElement(DataControl,{state:'IDLE',exportSummary:null,reindex:null,preview:null,receipt:null,error:null}));
 const user=new KeyboardUser(document);expect(user.tabTo(e=>e.id==='delete-conversations')).not.toBeNull();await act(async()=>user.type(id));
 await press(user,/Review what will be removed/);expect(fetcher).toHaveBeenCalledTimes(1);
 expect(document.body.textContent).toContain('Nothing has been deleted yet');
 expect(user.tabTo(e=>e.id==='delete-confirm')).not.toBeNull();await act(async()=>user.type('DELETE'));await press(user,/Delete permanently/);
 expect(fetcher).toHaveBeenLastCalledWith('/api/platform/data/deletions',expect.objectContaining({body:JSON.stringify({evidenceIds:[],conversationIds:[id],confirmation:'DELETE'})}));
 expect(document.body.textContent).toContain('Deletion complete. Cascade receipt');
});
it('runs the existing attention and retention writes from Configuration',async()=>{
 const fetcher=vi.fn(async()=>({ok:false,status:403,json:async()=>({code:'REFUSED'})}));vi.stubGlobal('fetch',fetcher);
 await mount(createElement(Configuration,{voice:DEFAULT_VOICE_SETTINGS,metrics:null,connectors:[],devices:[],currentDeviceId:null,errors:[],permissions}));
 const user=new KeyboardUser(document);await press(user,/Save attention budget/);
 expect(fetcher).toHaveBeenLastCalledWith('/api/platform/settings/attention-budgets',expect.objectContaining({method:'PATCH',headers:expect.objectContaining({'x-purpose':'settings.attention'})}));
 await press(user,/Save retention/);
 expect(fetcher).toHaveBeenLastCalledWith('/api/platform/settings/retention',expect.objectContaining({method:'PATCH',headers:expect.objectContaining({'x-purpose':'permissions.manage'})}));
 vi.spyOn(window,'confirm').mockReturnValue(true);await press(user,/Apply saved retention now/);
 expect(fetcher).toHaveBeenLastCalledWith('/api/platform/data/retention/cleanup',expect.objectContaining({method:'POST',headers:expect.objectContaining({'x-purpose':'data.delete'})}));
});
