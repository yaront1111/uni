import {DEFAULT_VOICE_SETTINGS,voiceSettingsSchema,type VoiceSettings} from '@unai/domain';
import type {ControlTransaction} from './transaction.js';
function requireVoice(tx:ControlTransaction){if(tx.context.purpose!=='settings.voice')throw new Error('VOICE_PURPOSE_REFUSED');}
export async function readVoiceSettings(tx:ControlTransaction):Promise<VoiceSettings>{
 requireVoice(tx);
 const row=(await tx.query(`SELECT speech_enabled AS "speechEnabled",provider,remote_enabled AS "remoteEnabled",
 language,voice,speaking_rate AS "speakingRate",hands_free_enabled AS "handsFreeEnabled"
 FROM voice_settings WHERE owner_scope_id=$1`,[tx.context.ownerScopeId])).rows[0];
 return voiceSettingsSchema.parse(row??DEFAULT_VOICE_SETTINGS);
}
export async function updateVoiceSettings(tx:ControlTransaction,patch:{[K in keyof VoiceSettings]?:VoiceSettings[K]|undefined}):Promise<VoiceSettings>{
 requireVoice(tx);
 // Materialize then lock the owner row, so concurrent partial updates cannot lose one another.
 await tx.query('INSERT INTO voice_settings(owner_scope_id) VALUES($1) ON CONFLICT DO NOTHING',[tx.context.ownerScopeId]);
 await tx.query('SELECT owner_scope_id FROM voice_settings WHERE owner_scope_id=$1 FOR UPDATE',[tx.context.ownerScopeId]);
 const next=voiceSettingsSchema.parse({...await readVoiceSettings(tx),...patch});
 if(patch.provider==='remote'&&!next.remoteEnabled)throw new Error('VOICE_REMOTE_CONSENT_REQUIRED');
 if(!next.remoteEnabled)next.provider='local';
 await tx.query(`UPDATE voice_settings SET speech_enabled=$2,provider=$3,remote_enabled=$4,language=$5,voice=$6,
 speaking_rate=$7,hands_free_enabled=$8 WHERE owner_scope_id=$1`,[tx.context.ownerScopeId,next.speechEnabled,next.provider,
 next.remoteEnabled,next.language,next.voice,next.speakingRate,next.handsFreeEnabled]);
 return next;
}
