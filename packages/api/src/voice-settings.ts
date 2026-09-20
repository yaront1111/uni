import type {FastifyInstance,FastifyRequest} from 'fastify';
import type {OwnerTransaction} from '@unai/postgres';
import {voiceSettingsPatchSchema} from '@unai/domain';
import {readVoiceSettings,updateVoiceSettings} from '@unai/control';
type Work=(request:FastifyRequest,run:(tx:OwnerTransaction,sessionId:string)=>Promise<unknown>)=>Promise<unknown>;
export function registerVoiceSettingsRoutes(app:FastifyInstance,work:Work){
 const audit=(tx:OwnerTransaction)=>tx.audit({policyDecision:'ALLOW',codeVersion:'0.1.0',result:'SUCCESS',
 objects:[{type:'voice_settings',id:tx.context.ownerScopeId,fields:['speech_enabled','provider','remote_enabled','language','voice','speaking_rate','hands_free_enabled']}]});
 app.get('/v1/settings/voice',request=>work(request,async tx=>{const settings=await readVoiceSettings(tx);await audit(tx);return settings;}));
 app.patch('/v1/settings/voice',async(request,reply)=>{
  const parsed=voiceSettingsPatchSchema.safeParse(request.body);
  if(!parsed.success)return reply.code(400).send({code:'VOICE_SETTINGS_INVALID'});
  try{return await work(request,async tx=>{const settings=await updateVoiceSettings(tx,parsed.data);await audit(tx);return settings;});}
  catch(error){if(error instanceof Error&&error.message==='VOICE_REMOTE_CONSENT_REQUIRED')return reply.code(400).send({code:'VOICE_REMOTE_CONSENT_REQUIRED'});throw error;}
 });
}
