import {expect,it} from 'vitest';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {todayBriefingSchema,whySourcesSchema,type BriefingItem,type TodayBriefing,type WhySources} from '@unai/domain';
import {Today,type TodayProps} from './Today';

/** The Today briefing screen: one assertion per drawn state, the landmarks and
 * live region of the shell, and no identifier outside the advanced inspector. */

const id=(n:number)=>'0192f3a0-0000-7000-8000-'+String(n).padStart(12,'0');
const UUID=/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const readingPath=(html:string)=>html.replace(/<details class="advanced">[\s\S]*?<\/details>/g,'').replace(/<[^>]+>/g,' ');
const components={consequence:0.9,urgency:0.9,goalRelevance:0.5,confidence:1,effort:0.5,reversibility:0.5,attentionBudget:1};
const item=(n:number,over:Partial<BriefingItem>):BriefingItem=>({
  briefingItemId:id(100+n),itemObjectType:'frame_instance',itemObjectId:id(200+n),kind:'COMMITMENT',domainSection:'PERSONAL',
  headline:'Commitment to Daniel: send Daniel the signed lease. Due Tue 22 Sep, 11:00; not yet fulfilled.',
  whySurfaced:'It is due within the next 24 hours. Stated priority: high. Ranked for its consequence, urgency and confidence, not for when it was recorded.',
  certaintyLabel:'CONFIRMED',outcomeState:'UNRESOLVED',targetTime:'2026-09-22T02:00:00.000Z',targetLocal:'Tue 22 Sep, 11:00',
  pastTarget:false,decisionAffectingConflict:false,priority:'HIGH',rankScore:0.82,rankComponents:components,rankPosition:n,
  sourceRefs:[{objectType:'propositions',objectId:id(300+n)}],evidenceIds:[id(400+n)],...over,
});
const briefing:TodayBriefing=todayBriefingSchema.parse({
  briefingEditionId:id(1),ownerLocalDate:'2026-09-22',timeZone:'Asia/Tokyo',utcOffset:'+09:00',generatedAt:'2026-09-21T20:00:00.000Z',
  isEmpty:false,
  sections:[
    {domain:'PERSONAL',items:[item(1,{}),item(3,{kind:'SCHEDULED_EVENT',certaintyLabel:'PENDING_OWNER_ASSERTION',priority:'NORMAL',
      headline:'Scheduled, not yet happened: Dentist appointment at Wed 23 Sep, 01:00.',rankScore:0.63,
      sourceRefs:[{objectType:'owner_overlay_deltas',objectId:id(301)}]})]},
    {domain:'FINANCE',items:[item(2,{kind:'OBLIGATION',domainSection:'FINANCE',certaintyLabel:'CONTESTED',decisionAffectingConflict:true,
      headline:'Payment obligation to Daniel: loan for the car repair (ILS 450.00 or ILS 540.00, sources disagree). Due Wed 23 Sep, 04:00.',
      whySurfaced:'It is due within the next 24 hours. Sources disagree about it, which affects what to do.',rankScore:0.78})]},
    {domain:'WORK',items:[item(4,{kind:'SCHEDULED_EVENT',domainSection:'WORK',certaintyLabel:'SCHEDULED',pastTarget:true,priority:'NORMAL',
      headline:'Planned for Tue 22 Sep, 00:00: Planning call with the design team. Nothing recorded says whether it took place.',
      whySurfaced:'Its planned time (Tue 22 Sep, 00:00) has passed and no outcome is recorded.',rankScore:0.68}),
      item(5,{domainSection:'WORK',certaintyLabel:'INFERRED',priority:'NORMAL',headline:'Commitment: prepare the quarterly board summary. Due Tue 22 Sep, 15:00; not yet fulfilled.',rankScore:0.65}),
      item(6,{domainSection:'WORK',certaintyLabel:'REPORTED',priority:'LOW',headline:'Commitment to Dana: order printer paper. Due Thu 24 Sep, 01:00; not yet fulfilled.',rankScore:0.5})]},
  ],
  recommendations:[{label:'RECOMMENDED',text:'Set aside time for “send Daniel the signed lease” before Tue 22 Sep, 11:00.',basedOnItemId:id(201),risk:'LOW'},
    {label:'RECOMMENDED',text:'Record whether “Planning call with the design team” took place, so it stops showing as only planned.',basedOnItemId:id(204),risk:'LOW'}],
  withheldRecommendations:[{basedOnItemId:id(202),risk:'HIGH',reason:'SUPPORT_CONTESTED'}],
  suppressedRepeats:[{briefingItemId:id(7),itemObjectType:'frame_instance',itemObjectId:id(207),
    headline:'Commitment: water the office plants. Due Wed 23 Sep, 09:00; not yet fulfilled.',lastShownOn:'2026-09-21'}],
  deferredByAttentionBudget:1,
  projectionCompleteness:[{projectionName:'schedule_projection',isComplete:false,pendingAssertions:[{overlayDeltaId:id(301),ownerSequence:1,
    deltaKind:'USER_ASSERTION',lifecycle:'USER_ASSERTED',rawText:'The dentist moved it to 16:00.',reason:'DELTA_KIND_NOT_REDUCIBLE',targetFrameInstanceId:id(203)}]},
    {projectionName:'open_commitments_projection',isComplete:true,pendingAssertions:[]}],
  packetManifest:{contextPacketId:id(9),packetHash:'a'.repeat(64),beliefIds:[id(301)],claimIds:[],evidenceIds:[id(401)],overlayDeltaIds:[id(301)],
    resolutionAssertionIds:[],frameInstanceIds:[id(201)],projectionVersions:{schedule_projection:null},
    watermarks:{ownerOverlayWatermark:1,canonicalTransactionWatermark:'2026-09-21T19:00:00.000Z',projectionVersions:{schedule_projection:null},
      registryRelease:'0.1.0',knowledgeTime:'2026-09-21T20:00:00.000Z',worldTime:'2026-09-21T20:00:00.000Z'}},
  rankingVersion:'briefing-ranking-0.1.0',
});
const panel:WhySources=whySourcesSchema.parse({
  subject:{objectType:'propositions',objectId:id(301)},subjectKind:'BELIEF',label:'CONFIRMED',
  statement:'commitment action description: send Daniel the signed lease',modality:'COMMITTED',assessmentStatus:'ACCEPTED',
  effectiveTime:{from:'2026-09-20T08:00:00.000Z',to:null,recordedAt:'2026-09-20T09:00:00.000Z'},
  confidence:{extraction:0.93,entityResolution:null,temporalResolution:0.88,instanceResolution:null,assessmentStatus:'ACCEPTED'},
  claims:[],claimingActors:[{kind:'PERSON',label:'Maya',entityId:id(5)}],
  sources:[{evidenceId:id(401),sourceType:'CONVERSATION',occurredAt:null,anchorKind:'MESSAGE_SPAN',excerpt:'I will send Daniel the signed lease.'}],
  redactions:[],conflict:{status:'NO_CONFLICT',competing:[],relations:[]},derivation:{isInferred:false,steps:[],modelClaims:[]},
  resolutions:[],explainPath:null,panelVersion:'why-sources-0.1.0',readAt:'2026-09-21T20:00:00.000Z',
});
const render=(props:Partial<TodayProps>)=>renderToStaticMarkup(createElement(Today,{state:'ready',briefing:null,why:{},...props}));

it('is an accessible shell: skip link, banner, navigation, one main landmark, footer and a live region',()=>{
  const html=render({briefing});
  expect(html).toContain('Skip to content');
  expect(html).toContain('<header>');expect(html).toContain('<nav aria-label="Main navigation">');
  expect(html).toContain('<main id="content" tabindex="-1" aria-labelledby="page-title">');
  expect(html).toContain('<footer>');
  expect(html).toContain('role="status" aria-live="polite"');
  expect(html).toContain('href="/today" aria-current="page">Today</a>');
  expect(html).toContain('href="/ask">Ask</a>');
});

it('shows the loading state in the live region, including while the timezone is learned',()=>{
  const html=render({state:'loading',detectTimeZone:true});
  expect(html).toMatch(/role="status" aria-live="polite" aria-atomic="true">Loading today(&#x27;|')s briefing/);
  expect(html).toContain('for your local date and timezone');
});

it('headers the briefing with the owner-local date and timezone',()=>{
  const html=render({briefing});
  expect(html).toContain('Tuesday, 22 September 2026');
  expect(html).toContain('Asia/Tokyo');expect(html).toContain('(UTC+09:00)');
  expect(html).toContain('not by when they were recorded');
});

it('ranks domain sections holding only a small set of items, in the API\'s order',()=>{
  const html=render({briefing});
  expect(html.indexOf('>Personal</h2>')).toBeLessThan(html.indexOf('>Finance</h2>'));
  expect(html.indexOf('>Finance</h2>')).toBeLessThan(html.indexOf('>Work</h2>'));
  expect(html.match(/class="briefing-item"/g)?.length).toBe(6);
});

it('expands an item to show why it was surfaced and what it was ranked by',()=>{
  const html=render({briefing});
  expect(html).toContain('<summary>Why is this here?');
  expect(html).toContain('It is due within the next 24 hours. Stated priority: high.');
  for(const name of ['Consequence','Urgency','Goal relevance','Confidence','Effort','Reversibility','Attention budget'])expect(html).toContain('>'+name+'</th>');
});

it('marks the past-target planned outcome, the decision-affecting conflict and each label in words',()=>{
  const html=render({briefing});
  expect(html).toContain('Past its planned time, no outcome recorded');
  expect(html).toContain('Sources disagree');
  expect(html).toContain('ILS 450.00 or ILS 540.00, sources disagree');
  for(const label of ['CONFIRMED','CONTESTED','PENDING_OWNER_ASSERTION','SCHEDULED','INFERRED','REPORTED'])expect(html).toContain('data-label="'+label+'"');
  expect(html).toContain('What the labels mean');
});

it('words a scheduled event as scheduled, never as having happened',()=>{
  const html=render({briefing});
  expect(html).toContain('Scheduled, not yet happened: Dentist appointment');
  expect(html).toContain('Nothing recorded says whether it took place.');
});

it('offers at most a few recommendations and says why a high-risk one was withheld',()=>{
  const html=render({briefing});
  expect(html).toContain('Uai recommends');
  expect(html).toContain('Suggestions only. Nothing here is done, decided or scheduled for you.');
  expect(html.match(/data-label="RECOMMENDED"/g)!.length).toBeGreaterThanOrEqual(2);
  expect(html).toContain('was withheld because its supporting memory is contested');
});

it('says which unchanged low-priority item is not repeated and how many were deferred',()=>{
  const html=render({briefing});
  expect(html).toContain('1 unchanged low-priority item you already saw is not repeated');
  expect(html).toContain('water the office plants');expect(html).toContain('shown Monday, 21 September 2026, unchanged since');
  expect(html).toContain('1 more item is left for their own views');
});

it('shows the incomplete projection notice with the pending owner assertion',()=>{
  const html=render({briefing});
  expect(html).toContain('Schedule is incomplete');
  expect(html).toContain('The dentist moved it to 16:00.');
  expect(html).not.toContain('Commitments is incomplete');
});

it('keeps the persisted packet manifest and every identifier inside the advanced inspector',()=>{
  const html=render({briefing,why:{[id(101)]:panel}});
  expect(html).toContain('Advanced inspector: how this briefing was built');
  expect(html).toContain(id(9));expect(html).toContain('a'.repeat(64));
  expect(readingPath(html)).not.toMatch(UUID);
});

it('opens Why? / Sources on an item: the belief, who claimed it, the excerpt, when and how sure',()=>{
  const html=render({briefing,why:{[id(101)]:panel}});
  expect(html).toContain('<details class="why"><summary>Why? / Sources');
  expect(html).toContain('Maya');expect(html).toContain('I will send Daniel the signed lease.');
  expect(html).toContain('Assessment: accepted.');expect(html).toContain('Nothing recorded disputes this.');
});

it('shows an empty day and a failure in fixed words',()=>{
  const empty=render({briefing:{...briefing,isEmpty:true,sections:[],recommendations:[],withheldRecommendations:[],suppressedRepeats:[],deferredByAttentionBudget:0}});
  expect(empty).toContain('Nothing material today');
  const failed=render({state:'error',error:'Today\'s briefing could not be loaded. Please reload to retry.'});
  expect(failed).toContain('role="alert"');expect(failed).not.toContain('Uai recommends');
});
