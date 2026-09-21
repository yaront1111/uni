import {z} from 'zod';

/** Preferences only: none of these fields grants microphone activation. */
export const voiceSettingsSchema=z.strictObject({
 speechEnabled:z.boolean(),
 provider:z.enum(['local','remote']),
 remoteEnabled:z.boolean(),
 language:z.string().trim().min(1).max(64),
 voice:z.string().trim().min(1).max(256),
 speakingRate:z.number().min(0.1).max(10),
 handsFreeEnabled:z.boolean(),
});
export type VoiceSettings=z.infer<typeof voiceSettingsSchema>;
export const voiceSettingsPatchSchema=voiceSettingsSchema.partial().refine(value=>Object.keys(value).length>0);
export const DEFAULT_VOICE_SETTINGS:Readonly<VoiceSettings>=Object.freeze({speechEnabled:true,provider:'local',remoteEnabled:false,
 language:'device',voice:'local',speakingRate:1,handsFreeEnabled:false});
