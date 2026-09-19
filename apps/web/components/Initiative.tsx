import React,{useState} from 'react';
import {initiativeSettingsInputSchema} from '@unai/domain';
import {Shell} from './Shell';
import {CertaintyBadge,withoutIdentifiers} from './Labels';
import {platformWrite,RefusedWrite} from './controlWrite';
import {watchRequest,type InitiativeChoice,type InitiativeLoad} from '../lib/initiative';

export interface InitiativeProps extends InitiativeLoad {saved:boolean}
const PREPARATION={NOT_REQUESTED:'No draft was requested.',CAPABILITY_NOT_GRANTED:'Draft permission is not granted.',
  CONFIRMATION_REQUIRED:'The supporting memory needs your confirmation before a draft can be prepared.',
  POLICY_DENIED:'Draft preparation was refused.',DRAFTED:'A draft is ready; nothing has been sent.'};
function dateLabel(value:string,zone:string){
  try{return new Intl.DateTimeFormat('en',{timeZone:zone,dateStyle:'medium',timeStyle:'short'}).format(new Date(value));}catch{return value;}
}
function choiceLabel(choice:InitiativeChoice,zone:string){
  return withoutIdentifiers(choice.label)+(choice.time?' · '+dateLabel(choice.time,zone):'')+
    (choice.scheduled?' · Scheduled':'')+(choice.provisional?' · Provisional':'');
}
export function Initiative(props:InitiativeProps){
  const [busy,setBusy]=useState(false),[error,setError]=useState(props.error??''),[scheduled,setScheduled]=useState('');
  const settings=props.settings,zone=settings?.timeZone??'UTC';
  const choices=props.choices,prerequisites=choices.prerequisites.filter(value=>value.frameId!==scheduled);
  const canCreate=choices.scheduled.some(value=>choices.prerequisites.some(other=>other.frameId!==value.frameId));
  async function write(path:string,purpose:string,body:unknown,method:'POST'|'PATCH'){
    setError('');setBusy(true);
    try{if(await platformWrite(path,purpose,body,method))window.location.assign('/initiative?saved=1');}
    catch(caught){setError(caught instanceof RefusedWrite?'The change was refused. Reload to check the available items and permissions.':'The change could not be saved. Please retry.');}
    finally{setBusy(false);}
  }
  function saveSettings(event:React.FormEvent<HTMLFormElement>){
    event.preventDefault();const data=new FormData(event.currentTarget),timeZone=String(data.get('timeZone')??'').trim();
    try{new Intl.DateTimeFormat('en',{timeZone}).format();}catch{setError('Enter a valid time zone, such as Asia/Jerusalem.');return;}
    const parsed=initiativeSettingsInputSchema.safeParse({enabled:data.get('enabled')==='on',timeZone,localTime:data.get('localTime'),
      dataPurpose:'PERSONAL_ASSISTANCE',maximumSensitivity:'PRIVATE',prepareDrafts:data.get('prepareDrafts')==='on'});
    if(!parsed.success){setError('Check the time zone and local time before saving.');return;}
    void write('settings/initiative','settings.attention',parsed.data,'PATCH');
  }
  function createWatch(event:React.FormEvent<HTMLFormElement>){
    event.preventDefault();const data=new FormData(event.currentTarget);
    const input=watchRequest(String(data.get('scheduled')??''),String(data.get('prerequisite')??''),String(data.get('requestText')??''),choices);
    if(!input){setError('Choose two different available items and describe the reminder you want.');return;}
    void write('initiative/watches','memory.correct',input,'POST');
  }
  const allChoices=new Map([...choices.scheduled,...choices.prerequisites].map(value=>[value.frameId,value]));
  const label=(id:string,fallback:string)=>{const value=allChoices.get(id);return value?withoutIdentifiers(value.label):fallback;};
  return <Shell current={null} eyebrow="INITIATIVE" title="A little help ahead of time" status={busy?'Saving your change…':props.saved?'Change saved. Future checks use your current settings.':''}
    footer="Checks follow your standing permissions. A prepared draft is never a sent message.">
    <p>Choose what Uai should keep an eye on. When a scheduled item approaches and its prerequisite is still unfinished, a check can bring it to your attention.</p>
    <p><a href="/today">Back to Today</a> · <a href="/permissions">Review actual permissions and attention limits</a></p>
    {error&&<p role="alert">{error}</p>}
    {settings&&<form className="card" onSubmit={saveSettings} aria-labelledby="daily-checks"><h2 id="daily-checks">Daily checks</h2>
      <p>{settings.enabled?'Daily checks are enabled.':'Daily checks are off.'} {settings.nextDueAt&&<>Next scheduled check: <time dateTime={settings.nextDueAt}>{dateLabel(settings.nextDueAt,zone)}</time> ({zone}).</>}</p>
      <p className="muted">A scheduled check runs when Uai’s processing service is available. New relevant information can also trigger a check.</p>
      <label htmlFor="initiative-enabled"><input id="initiative-enabled" name="enabled" type="checkbox" defaultChecked={settings.enabled} disabled={busy}/> Enable daily checks</label>
      <label htmlFor="initiative-zone">Time zone</label><input id="initiative-zone" name="timeZone" defaultValue={zone} placeholder="Asia/Jerusalem" maxLength={64} required disabled={busy} aria-describedby="zone-help"/>
      <p id="zone-help" className="muted">Use a named time zone, such as Asia/Jerusalem or America/New_York, so checks follow daylight saving changes.</p>
      <label htmlFor="initiative-time">Local time</label><input id="initiative-time" name="localTime" type="time" defaultValue={settings.localTime} required disabled={busy}/>
      <label htmlFor="initiative-drafts"><input id="initiative-drafts" name="prepareDrafts" type="checkbox" defaultChecked={settings.prepareDrafts} disabled={busy}/> Prepare generic request drafts</label>
      <p>Drafts stay inside Uai for your review. This also requires draft permission on <a href="/permissions">Permissions</a>; uncertain support may need confirmation. Nothing is sent automatically.</p>
      <p className="muted">This page uses Normal and Private sources for personal assistance. Saving sets the same scope for future checks.</p>
      {settings.maximumSensitivity!=='PRIVATE'&&<p className="muted">Current check scope: {settings.maximumSensitivity==='NORMAL'?'Normal':'Restricted'} sources.</p>}
      <button type="submit" disabled={busy}>Save daily checks</button>
    </form>}
    <section className="card" aria-labelledby="notices"><h2 id="notices">Notices</h2>
      {props.notices.length===0?<p>No notices are available. This does not establish that every prerequisite is complete.</p>:<ul className="briefing">
        {props.notices.map(notice=>{const watch=props.watches.find(value=>value.watchId===notice.watchId);return <li key={notice.noticeId} className="briefing-item">
          <p><strong>{notice.threshold==='OVERDUE'?'Past its planned time':notice.threshold==='IMMINENT'?'Due within a day':'Coming up'}</strong> · {notice.ownerLocalDate}</p>
          {watch&&<p>{label(watch.scheduledFrameId,'Scheduled item unavailable')} — {label(watch.prerequisiteFrameId,'Prerequisite unavailable')}</p>}
          <p>{notice.message}</p><p>{PREPARATION[notice.preparation]}</p>
          {notice.draftId&&<p><a href="/actions/drafts">Review prepared drafts</a></p>}
          <details><summary>Sources behind this notice</summary><ul>{notice.sourceEvidenceIds.map((id,index)=><li key={id}><a href={'/sources?evidence='+encodeURIComponent(id)}>Source {index+1}</a></li>)}</ul></details>
        </li>;})}</ul>}
    </section>
    <form className="card" onSubmit={createWatch} aria-labelledby="create-watch"><h2 id="create-watch">Create a watch</h2>
      <p>Connect a planned item with something that needs to be finished first. Your instruction is saved as a source you can review.</p>
      {choices.incomplete&&<p className="notice">Some memory is still unavailable or being processed. Only readable items with usable descriptions appear here. Missing items do not mean completed tasks.</p>}
      {!choices.scheduled.length&&<p>No readable scheduled items with a usable time are available. <a href="/sources">Check source processing</a> or <a href="/memory/inbox">review pending memory</a>.</p>}
      <label htmlFor="watch-scheduled">Scheduled item</label><select id="watch-scheduled" name="scheduled" value={scheduled} onChange={event=>setScheduled(event.target.value)} required disabled={busy||!canCreate}>
        <option value="">Choose a planned item</option>{choices.scheduled.map(value=><option key={value.frameId} value={value.frameId}>{choiceLabel(value,zone)}</option>)}
      </select>
      <label htmlFor="watch-prerequisite">Unfinished prerequisite</label><select id="watch-prerequisite" name="prerequisite" key={scheduled} defaultValue="" required disabled={busy||!canCreate}>
        <option value="">Choose what needs to be finished first</option>{prerequisites.map(value=><option key={value.frameId} value={value.frameId}>{choiceLabel(value,zone)}</option>)}
      </select>
      <label htmlFor="watch-request">What would you like Uai to help with?</label><textarea id="watch-request" name="requestText" rows={3} maxLength={2000} required disabled={busy||!canCreate}
        placeholder="Remind me to request the document before the meeting." style={{width:'100%',font:'inherit',padding:12}}/>
      <p className="muted">A scheduled item is a plan, not evidence it happened. Provisional items remain uncertain. Automatic drafts use a general request; your words here are the standing instruction, not an email to send.</p>
      <button type="submit" disabled={busy||!canCreate}>Create watch</button>
    </form>
    <section className="card" aria-labelledby="watches"><h2 id="watches">Your watches</h2>
      {!settings?.enabled&&<p>Checks are off. Saved watches will wait until you enable daily checks.</p>}
      {props.watches.length===0?<p>No watches saved yet.</p>:<ul className="briefing">{props.watches.map(watch=>{
        const item=allChoices.get(watch.scheduledFrameId);return <li className="briefing-item" key={watch.watchId}>
          <h3>{label(watch.scheduledFrameId,'Scheduled item unavailable')}</h3>
          <p>Waiting on: {label(watch.prerequisiteFrameId,'Prerequisite unavailable')}</p>
          {item?.scheduled&&<CertaintyBadge label="SCHEDULED"/>} {item?.provisional&&<span>Provisional — needs confirmation</span>}
          <p>{watch.enabled?'Enabled':'Disabled'}{watch.snoozedUntil&&<> · Snoozed until {dateLabel(watch.snoozedUntil,zone)}</>}</p>
          <p><a href={'/sources?evidence='+encodeURIComponent(watch.sourceEvidenceId)}>Review your saved instruction</a></p>
          <div className="actions"><button disabled={busy} onClick={()=>void write('initiative/watches/'+watch.watchId,'memory.correct',{enabled:!watch.enabled},'PATCH')}>{watch.enabled?'Disable watch':'Enable watch'}</button>
            {watch.enabled&&<button disabled={busy} onClick={()=>void write('initiative/watches/'+watch.watchId,'memory.correct',{snoozedUntil:new Date(Date.now()+24*3600000).toISOString()},'PATCH')}>Snooze for 24 hours</button>}
            {watch.snoozedUntil&&<button disabled={busy} onClick={()=>void write('initiative/watches/'+watch.watchId,'memory.correct',{snoozedUntil:null},'PATCH')}>Clear snooze</button>}
          </div>
        </li>;})}</ul>}
    </section>
  </Shell>;
}
