import React,{useState} from 'react';
import type {VoiceSettings} from '@unai/domain';
import {OwnerSettingsAdapter,REMOTE_SPEECH_PROVIDER_NAME} from '../lib/OwnerSettingsAdapter';

export function VoiceSettingsPanel(props:{settings:VoiceSettings|null;state?:'ready'|'saving'|'saved'|'error';capabilityUnavailable?:boolean}){
 const [settings,setSettings]=useState(props.settings);
 const [state,setState]=useState(props.state??'ready');
 function change<K extends keyof VoiceSettings>(key:K,value:VoiceSettings[K]){
  setSettings(previous=>previous?{...previous,[key]:value,...(key==='remoteEnabled'&&value===false?{provider:'local' as const}:{})}:null);
  setState('ready');
 }
 async function save(event:React.FormEvent){
  event.preventDefault();if(!settings||state==='saving')return;
  setState('saving');
  try{const saved=await OwnerSettingsAdapter.save(settings);if(saved){setSettings(saved);setState('saved');}}
  catch{setState('error');}
 }
 return <section className="card" aria-labelledby="voice-heading">
  <h2 id="voice-heading">Voice settings</h2>
  <p>Settings apply to your devices. Saving or restoring them never starts the microphone. Talk requires an action in the current session.</p>
  {props.capabilityUnavailable&&<p role="status">On-device speech is unavailable on this device. Use <a href="/chat">Chat</a> or explicitly enable the named remote provider.</p>}
  {!settings?<p role="alert">Voice settings could not be loaded. Reload to retry.</p>:<form onSubmit={event=>void save(event)}>
   <fieldset disabled={state==='saving'}><legend>Speech preferences</legend>
    <label><input type="checkbox" name="speechEnabled" checked={settings.speechEnabled} onChange={e=>change('speechEnabled',e.target.checked)}/> Speech enabled</label>
    <label><input type="checkbox" name="remoteEnabled" checked={settings.remoteEnabled} onChange={e=>change('remoteEnabled',e.target.checked)}/> Enable {REMOTE_SPEECH_PROVIDER_NAME}</label>
    <p>Enabling this provider permits remote speech when selected and available. Local speech remains the default.</p>
    <label htmlFor="voice-provider">Speech provider</label>
    <select id="voice-provider" name="provider" value={settings.provider} onChange={e=>change('provider',e.target.value as VoiceSettings['provider'])}>
     <option value="local">On-device speech</option><option value="remote" disabled={!settings.remoteEnabled}>{REMOTE_SPEECH_PROVIDER_NAME}</option>
    </select>
    <label htmlFor="voice-language">Language</label>
    <input id="voice-language" name="language" required maxLength={64} value={settings.language} onChange={e=>change('language',e.target.value)} aria-describedby="voice-language-help"/>
    <p id="voice-language-help">Use device for the device language, or a language tag such as en-US.</p>
    <label htmlFor="voice-choice">Voice</label>
    <input id="voice-choice" name="voice" required maxLength={256} value={settings.voice} onChange={e=>change('voice',e.target.value)} aria-describedby="voice-choice-help"/>
    <p id="voice-choice-help">Use local for the device voice, or the voice name supported by the selected engine. Availability is checked in Talk.</p>
    <label htmlFor="voice-rate">Speaking rate (1 is normal)</label>
    <input id="voice-rate" name="speakingRate" type="number" min={0.1} max={10} step="any" required value={settings.speakingRate} onChange={e=>change('speakingRate',e.target.valueAsNumber)}/>
    <label><input type="checkbox" name="handsFreeEnabled" checked={settings.handsFreeEnabled} onChange={e=>change('handsFreeEnabled',e.target.checked)}/> Hands-free preference</label>
    <p>Off by default. This preference never permits always-listening or starts listening by itself.</p>
    <button type="submit">{state==='saving'?'Saving voice settings…':'Save voice settings'}</button>
   </fieldset>
  </form>}
  {state==='saved'&&<p role="status">Voice settings saved. They take effect on the next turn.</p>}
  {state==='saving'&&<p role="status">Saving voice settings…</p>}
  {state==='error'&&<p role="alert">Voice settings could not be saved. Please retry.</p>}
 </section>;
}
