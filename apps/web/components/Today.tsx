import React,{useEffect} from 'react';
import type {BriefingItem,MemoryLabel,TodayBriefing,WhySources as WhySourcesPanel} from '@unai/domain';
import {BeliefRefLinks} from './BeliefLinks';
import {CertaintyBadge,LabelKey,withoutIdentifiers} from './Labels';
import {Shell} from './Shell';
import {WhySources} from './WhySources';

/**
 * The Today briefing (design journey J2, screen "Today briefing"; CRT-UX-01-A,
 * CRT-UX-01-B, CRT-UX-02-A, CRT-UX-11-A, CRT-UX-12-A).
 *
 * Every drawn state is reachable from props alone: loading (also while the
 * browser's timezone is being learned), an empty day, the owner-local date and
 * timezone header, ranked domain sections with a small set of items, an item
 * expanded to show why it was surfaced, a past-target planned outcome, a
 * decision-affecting conflict, the "Uai recommends" block, the unchanged
 * low-priority repeat that was suppressed, a scheduled event worded as
 * scheduled, the incomplete projection notice with the pending owner assertion,
 * a withheld high-risk recommendation, and the persisted packet manifest.
 *
 * The order is the API's rank order. Nothing here re-sorts by time.
 */
export const TIME_ZONE_COOKIE='unai-tz';

export interface TodayProps{
  state:'loading'|'ready'|'error';
  briefing:TodayBriefing|null;
  /** The Why? / Sources panel of each shown item, by briefing item id. */
  why:Record<string,WhySourcesPanel|null>;
  /** The server does not know the owner's timezone yet: learn it from the
   * browser, remember it in a cookie and load again. */
  detectTimeZone?:boolean;
  error?:string|null;
}

const SECTION:Record<BriefingItem['domainSection'],string>={WORK:'Work',PERSONAL:'Personal',FINANCE:'Finance'};
const PROJECTION:Record<string,string>={open_commitments_projection:'Commitments',obligations_projection:'Obligations',schedule_projection:'Schedule'};
const WITHHELD:Record<TodayBriefing['withheldRecommendations'][number]['reason'],string>={
  SUPPORT_PROVISIONAL:'its supporting memory is only provisional',
  SUPPORT_CONTESTED:'its supporting memory is contested',
  PROJECTION_INCOMPLETE:'the view it rests on is incomplete',
};
const RISK:Record<string,string>={LOW:'low risk',MEDIUM:'medium risk',HIGH:'high risk'};
const COMPONENTS:Array<[keyof BriefingItem['rankComponents'],string]>=[['consequence','Consequence'],['urgency','Urgency'],
  ['goalRelevance','Goal relevance'],['confidence','Confidence'],['effort','Effort'],['reversibility','Reversibility'],
  ['attentionBudget','Attention budget']];

function longDate(date:string){
  return new Intl.DateTimeFormat('en-GB',{timeZone:'UTC',weekday:'long',day:'numeric',month:'long',year:'numeric'}).format(new Date(date+'T00:00:00Z'));
}

function Item({item,panel,timeZone}:{item:BriefingItem;panel:WhySourcesPanel|null;timeZone:string}){
  return <li className="briefing-item">
    <p className="item-head"><CertaintyBadge label={item.certaintyLabel}/> <strong>{withoutIdentifiers(item.headline)}</strong></p>
    <ul className="markers" aria-label="Markers">
      {item.pastTarget?<li className="marker">{item.kind==='SCHEDULED_EVENT'?'Past its planned time, no outcome recorded':'Overdue, no resolution recorded'}</li>:null}
      {item.decisionAffectingConflict?<li className="marker">Sources disagree</li>:null}
      <li className="marker">{item.priority==='HIGH'?'High priority':item.priority==='LOW'?'Low priority':'Normal priority'}</li>
    </ul>
    <details className="why-surfaced">
      <summary>Why is this here?<span className="sr-only"> {withoutIdentifiers(item.headline)}</span></summary>
      <p>{withoutIdentifiers(item.whySurfaced)}</p>
      <table>
        <caption>What it was ranked by (0 to 1)</caption>
        <tbody>{COMPONENTS.map(([key,name])=><tr key={key}><th scope="row">{name}</th><td>{item.rankComponents[key].toFixed(2)}</td></tr>)}</tbody>
      </table>
    </details>
    <WhySources about={item.headline} panel={panel} timeZone={timeZone}/>
    <BeliefRefLinks refs={item.sourceRefs.length>0?item.sourceRefs:[{objectType:item.itemObjectType,objectId:item.itemObjectId}]}
      about={withoutIdentifiers(item.headline)}/>
  </li>;
}

export function Today(props:TodayProps){
  useEffect(()=>{
    if(!props.detectTimeZone)return;
    const zone=Intl.DateTimeFormat().resolvedOptions().timeZone;
    document.cookie=TIME_ZONE_COOKIE+'='+encodeURIComponent(zone)+'; Path=/; Max-Age=31536000; SameSite=Lax; Secure';
    window.location.reload();
  },[props.detectTimeZone]);
  const briefing=props.briefing;
  const shown=briefing?briefing.sections.flatMap(section=>section.items):[];
  const labels=[...new Set<MemoryLabel>([...shown.map(item=>item.certaintyLabel),'RECOMMENDED'])];
  return <Shell current="today" eyebrow="TODAY" title={briefing?longDate(briefing.ownerLocalDate):'Today'}
    status={props.state==='loading'?'Loading today\'s briefing…':briefing?'Today\'s briefing is ready: '+shown.length+' item'+(shown.length===1?'':'s')+'.':''}>
    {props.state==='error'||(props.state==='ready'&&!briefing)?<p role="alert">{props.error??'Today\'s briefing could not be loaded. Please reload to retry.'}</p>:null}
    {props.state==='loading'?<p className="card">Preparing your briefing for your local date{props.detectTimeZone?' and timezone':''}{'…'}</p>:null}
    {briefing?<>
      <p className="today-zone">Your local date in <strong>{briefing.timeZone}</strong> (UTC{briefing.utcOffset}). Items are ranked by consequence, urgency, confidence and effort, not by when they were recorded.</p>
      <LabelKey labels={labels}/>
      {briefing.projectionCompleteness.filter(entry=>!entry.isComplete).map(entry=><section key={entry.projectionName} className="notice" aria-labelledby={'incomplete-'+entry.projectionName}>
        <h2 id={'incomplete-'+entry.projectionName}>{PROJECTION[entry.projectionName]??'A view'} is incomplete</h2>
        <p>Something you said has not been applied to it yet, so this briefing may be missing a change. High-risk suggestions based on it are withheld.</p>
        <ul>{entry.pendingAssertions.slice(0,5).map(assertion=><li key={assertion.overlayDeltaId}><CertaintyBadge label="PENDING_OWNER_ASSERTION"/> {'“'}{assertion.rawText}{'”'}</li>)}</ul>
      </section>)}
      {briefing.isEmpty?<section className="card" aria-labelledby="empty"><h2 id="empty">Nothing material today</h2>
        <p>Nothing current or due in the next two days needs your attention. Your commitments and schedule are still in their own views.</p></section>:null}
      {briefing.sections.map(section=><section key={section.domain} className="card" aria-labelledby={'section-'+section.domain}>
        <h2 id={'section-'+section.domain}>{SECTION[section.domain]}</h2>
        <ol className="briefing">{section.items.map(item=><Item key={item.briefingItemId} item={item} panel={props.why[item.briefingItemId]??null} timeZone={briefing.timeZone}/>)}</ol>
      </section>)}
      {briefing.recommendations.length>0||briefing.withheldRecommendations.length>0?<section className="card" aria-labelledby="recommends">
        <h2 id="recommends">Uai recommends</h2>
        <p className="muted">Suggestions only. Nothing here is done, decided or scheduled for you.</p>
        <ul>{briefing.recommendations.map((recommendation,index)=><li key={index}><CertaintyBadge label="RECOMMENDED"/> {withoutIdentifiers(recommendation.text)} <small>({RISK[recommendation.risk]})</small></li>)}</ul>
        {briefing.withheldRecommendations.map((withheld,index)=>{
          const about=shown.find(item=>item.itemObjectId===withheld.basedOnItemId);
          return <p key={index}>A high-risk suggestion{about?' about “'+withoutIdentifiers(about.headline)+'”':''} was withheld because {WITHHELD[withheld.reason]}.</p>;
        })}
      </section>:null}
      {briefing.suppressedRepeats.length>0||briefing.deferredByAttentionBudget>0?<section className="card" aria-labelledby="not-shown">
        <h2 id="not-shown">Not shown today</h2>
        {briefing.suppressedRepeats.length>0?<details><summary>{briefing.suppressedRepeats.length} unchanged low-priority item{briefing.suppressedRepeats.length===1?' you already saw is':'s you already saw are'} not repeated</summary>
          <ul>{briefing.suppressedRepeats.map(repeat=><li key={repeat.briefingItemId}>{withoutIdentifiers(repeat.headline)} <small>(shown {longDate(repeat.lastShownOn)}, unchanged since)</small></li>)}</ul></details>:null}
        {briefing.deferredByAttentionBudget>0?<p>{briefing.deferredByAttentionBudget} more item{briefing.deferredByAttentionBudget===1?' is':'s are'} left for their own views to keep today short.</p>:null}
      </section>:null}
      <details className="advanced">
        <summary>Advanced inspector: how this briefing was built</summary>
        <p>This edition was built from one context packet, persisted with the manifest of everything it supplied.</p>
        <dl>
          <dt>Briefing edition</dt><dd><code>{briefing.briefingEditionId}</code></dd>
          <dt>Context packet</dt><dd><code>{briefing.packetManifest.contextPacketId}</code></dd>
          <dt>Packet hash</dt><dd><code>{briefing.packetManifest.packetHash}</code></dd>
          <dt>Supplied</dt><dd>{briefing.packetManifest.beliefIds.length} beliefs, {briefing.packetManifest.evidenceIds.length} evidence items, {briefing.packetManifest.overlayDeltaIds.length} of your statements, {briefing.packetManifest.resolutionAssertionIds.length} resolutions</dd>
          <dt>Ranking</dt><dd><code>{briefing.rankingVersion}</code></dd>
          {shown.map(item=><React.Fragment key={item.briefingItemId}><dt>Item {item.rankPosition}</dt><dd><code>{item.itemObjectType} {item.itemObjectId}</code></dd></React.Fragment>)}
        </dl>
      </details>
    </>:null}
  </Shell>;
}
