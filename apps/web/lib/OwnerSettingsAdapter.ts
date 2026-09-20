import {voiceSettingsSchema,type VoiceSettings} from '@unai/domain';
import {platformWrite} from '../components/controlWrite';

export const REMOTE_SPEECH_PROVIDER_NAME='Microsoft Azure AI Speech';
/** The session and owner are supplied by the same-origin proxy, never by form fields.
 * This adapter changes preferences only and has no speech or microphone dependency. */
export const OwnerSettingsAdapter={
 async save(patch:Partial<VoiceSettings>):Promise<VoiceSettings|null>{
  const answer=await platformWrite('settings/voice','settings.voice',patch,'PATCH');
  return answer===null?null:voiceSettingsSchema.parse(answer);
 },
};
