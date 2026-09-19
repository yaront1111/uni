import {askAnswerSchema,cardDecisionResultSchema,memoryInboxViewSchema,todayBriefingSchema,weeklyReviewSchema,whySourcesSchema,
  type BriefingItem,type CardDecisionResult,type ClarificationCard,type CommitmentProjectionRow,type CommitmentsProjectionView,
  type RelatedFrame} from '@unai/domain';
import type {TodayProps} from '../Today';
import type {AskProps} from '../Ask';
import type {CommitmentsProps} from '../Commitments';
import type {WeeklyReviewProps} from '../WeeklyReview';
import type {MemoryInspectorProps} from '../MemoryInspector';
import type {MemoryInboxProps} from '../MemoryInbox';
import {inspection} from './inspection';

/** Props for the six core views the accessibility suite walks (Today, Ask,
 * Commitments, Weekly Review, Memory Inspector, Memory Inbox), each in a
 * populated state so every control a core task needs is on the page. Test data
 * only; no page imports it. */
export const id=(n:number)=>'0192f3a0-0000-7000-8000-'+String(n).padStart(12,'0');

// --- Today -----------------------------------------------------------------
const components={consequence:0.9,urgency:0.9,goalRelevance:0.5,confidence:1,effort:0.5,reversibility:0.5,attentionBudget:1};
const item=(n:number,over:Partial<BriefingItem>):BriefingItem=>({
  briefingItemId:id(100+n),itemObjectType:'frame_instance',itemObjectId:id(200+n),kind:'COMMITMENT',domainSection:'PERSONAL',
  headline:'Commitment to Daniel: send Daniel the signed lease. Due Tue 22 Sep, 11:00; not yet fulfilled.',
  whySurfaced:'It is due within the next 24 hours. Stated priority: high.',
  certaintyLabel:'CONFIRMED',outcomeState:'UNRESOLVED',targetTime:'2026-09-22T02:00:00.000Z',targetLocal:'Tue 22 Sep, 11:00',
  pastTarget:false,decisionAffectingConflict:false,priority:'HIGH',rankScore:0.82,rankComponents:components,rankPosition:n,
  sourceRefs:[{objectType:'propositions',objectId:id(300+n)}],evidenceIds:[id(400+n)],...over,
});
const whyPanel=(subject:string)=>whySourcesSchema.parse({
  subject:{objectType:'propositions',objectId:subject},subjectKind:'BELIEF',label:'CONFIRMED',
  statement:'commitment action description: send Daniel the signed lease',modality:'COMMITTED',assessmentStatus:'ACCEPTED',
  effectiveTime:{from:'2026-09-20T08:00:00.000Z',to:null,recordedAt:'2026-09-20T09:00:00.000Z'},
  confidence:{extraction:0.93,entityResolution:null,temporalResolution:0.88,instanceResolution:null,assessmentStatus:'ACCEPTED'},
  claims:[],claimingActors:[{kind:'PERSON',label:'Maya',entityId:id(5)}],
  sources:[{evidenceId:id(401),sourceType:'CONVERSATION',occurredAt:null,anchorKind:'MESSAGE_SPAN',excerpt:'I will send Daniel the signed lease.'}],
  redactions:[],conflict:{status:'NO_CONFLICT',competing:[],relations:[]},derivation:{isInferred:false,steps:[],modelClaims:[]},
  resolutions:[],explainPath:null,panelVersion:'why-sources-0.1.0',readAt:'2026-09-21T20:00:00.000Z',
});
export const todayProps:TodayProps={state:'ready',why:{[id(101)]:whyPanel(id(301))},briefing:todayBriefingSchema.parse({
  briefingEditionId:id(1),ownerLocalDate:'2026-09-22',timeZone:'Asia/Tokyo',utcOffset:'+09:00',generatedAt:'2026-09-21T20:00:00.000Z',
  isEmpty:false,
  sections:[
    {domain:'PERSONAL',items:[item(1,{})]},
    {domain:'FINANCE',items:[item(2,{kind:'OBLIGATION',domainSection:'FINANCE',certaintyLabel:'CONTESTED',decisionAffectingConflict:true,
      headline:'Payment obligation to Daniel: loan for the car repair (ILS 450.00 or ILS 540.00, sources disagree).',
      whySurfaced:'Sources disagree about it, which affects what to do.',rankScore:0.78})]},
    {domain:'WORK',items:[item(4,{kind:'SCHEDULED_EVENT',domainSection:'WORK',certaintyLabel:'SCHEDULED',pastTarget:true,priority:'NORMAL',
      headline:'Planned for Tue 22 Sep, 00:00: Planning call with the design team. Nothing recorded says whether it took place.',
      whySurfaced:'Its planned time has passed and no outcome is recorded.',rankScore:0.68})]},
  ],
  recommendations:[{label:'RECOMMENDED',text:'Set aside time for “send Daniel the signed lease” before Tue 22 Sep, 11:00.',basedOnItemId:id(201),risk:'LOW'}],
  withheldRecommendations:[{basedOnItemId:id(202),risk:'HIGH',reason:'SUPPORT_CONTESTED'}],
  suppressedRepeats:[{briefingItemId:id(7),itemObjectType:'frame_instance',itemObjectId:id(207),
    headline:'Commitment: water the office plants.',lastShownOn:'2026-09-21'}],
  deferredByAttentionBudget:1,
  projectionCompleteness:[{projectionName:'schedule_projection',isComplete:false,pendingAssertions:[{overlayDeltaId:id(301),ownerSequence:1,
    deltaKind:'USER_ASSERTION',lifecycle:'USER_ASSERTED',rawText:'The dentist moved it to 16:00.',reason:'DELTA_KIND_NOT_REDUCIBLE',targetFrameInstanceId:id(203)}]}],
  packetManifest:{contextPacketId:id(9),packetHash:'a'.repeat(64),beliefIds:[id(301)],claimIds:[],evidenceIds:[id(401)],overlayDeltaIds:[id(301)],
    resolutionAssertionIds:[],frameInstanceIds:[id(201)],projectionVersions:{schedule_projection:null},
    watermarks:{ownerOverlayWatermark:1,canonicalTransactionWatermark:'2026-09-21T19:00:00.000Z',projectionVersions:{schedule_projection:null},
      registryRelease:'0.1.0',knowledgeTime:'2026-09-21T20:00:00.000Z',worldTime:'2026-09-21T20:00:00.000Z'}},
  rankingVersion:'briefing-ranking-0.1.0',
})};

// --- Ask -------------------------------------------------------------------
const statement=(n:number,over:Record<string,unknown>)=>({statementId:'S'+n,kind:'SELECTED_STATE',label:'COMMITTED',
  text:'Committed, not yet fulfilled: commitment action description is send Daniel the signed lease.',
  objectRefs:[{objectType:'propositions',objectId:id(300+n)}],sourceEvidenceIds:[id(400)],
  explainPath:'/v1/memory/propositions/'+id(300+n)+'/explain',...over});
export const askAnsweredProps:AskProps={state:'answered',question:'What did I promise Daniel?',why:{S1:whyPanel(id(301))},
  answer:askAnswerSchema.parse({
    question:'What did I promise Daniel?',answerType:'FUTURE_COMMITMENT',queryMode:'OPEN_COMMITMENTS',historicalMode:null,
    classification:{matchedRule:'FUTURE_COMMITMENT_PROMISE',classifierVersion:'question-classifier-0.1.0'},
    worldTime:'2026-09-21T20:00:00.000Z',knowledgeTime:'2026-09-21T20:00:00.000Z',
    statements:[statement(1,{}),statement(2,{kind:'CONFLICT',label:'CONFLICTING',text:'These disagree about principal amount: ILS 450.00 versus ILS 540.00.'})],
    sourceLinks:[{evidenceId:id(400),sourceType:'CONVERSATION',occurredAt:'2026-09-20T08:00:00.000Z',anchorIds:[id(401)],href:'/v1/evidence/'+id(400)}],
    declinesToAssert:false,packetId:id(1),packetHash:'b'.repeat(64),selectionsDigest:'c'.repeat(64),
    composer:{kind:'DETERMINISTIC_COMPOSER',version:'ask-composer-0.1.0',modelCalled:false,modelId:null,promptVersion:null},
    grounding:{validatorVersion:'grounding-validator-0.1.0',action:'PASSED',finalSource:'DETERMINISTIC_COMPOSER',
      attempts:[{attempt:1,candidateSource:'DETERMINISTIC_COMPOSER',outcome:'PASSED',violations:[]}],violations:[]},
    answerManifestId:id(2),
  })};
export const askEmptyProps:AskProps={state:'empty',question:'',answer:null,why:{}};

// --- Commitments -----------------------------------------------------------
const at='2026-09-18T10:00:00.000Z';
const commitment=(n:number,over:Partial<CommitmentProjectionRow>):CommitmentProjectionRow=>({ownerScopeId:id(1),projectionVersion:id(2),
  canonicalTransactionWatermark:at,ownerOverlayWatermark:4,reducerVersion:'projection-reducers-0.1.0',isComplete:true,sourceManifest:{},updatedAt:at,
  commitmentFrameInstanceId:id(10+n),promisorEntityId:id(20),promiseeEntityId:id(21),actionDescription:'send Daniel the report',
  dueTime:'2026-09-20T17:00:00.000Z',outcomeState:'UNRESOLVED',overdue:false,dueSoon:false,sourceStrength:'OWNER_STATEMENT',conflictFlag:false,
  overlayComplete:true,lastMaterialUpdate:at,pendingAssertions:[],...over});
const related=(frameInstanceId:string,beliefId:string):RelatedFrame=>({frameInstanceId,frameTypeId:'shared.commitment',lifecycle:'ACTIVE',
  people:[{roleId:'promisee',entityId:id(21),entityKind:'PERSON',canonicalLabel:'Daniel'},{roleId:'promisor',entityId:id(20),entityKind:'PERSON',canonicalLabel:'Me'}],
  sources:[{evidenceId:id(30),sourceType:'CONVERSATION',sensitivity:'PRIVATE',occurredAt:'2026-09-01T08:00:00.000Z',observedAt:at,
    anchors:[{sourceAnchorId:id(31),anchorKind:'MESSAGE_SPAN',text:'I will send Daniel the report'}]}],
  withheldSourceCount:0,resolutions:[],
  beliefs:[{propositionId:beliefId,predicateId:'shared.commitment.action_description',modality:'COMMITTED',assessmentStatus:'ACCEPTED'}],
  threads:[{memoryThreadId:id(50),displayTitle:'Daniel report'}]});
const commitmentsView:CommitmentsProjectionView={projectionName:'open_commitments_projection',
  rows:[commitment(1,{}),commitment(2,{actionDescription:'bring the spare keys',overdue:true,conflictFlag:true})],
  isComplete:true,ownerOverlayWatermark:4,canonicalTransactionWatermark:at,projectionVersion:id(2),reducerVersion:'projection-reducers-0.1.0',
  pendingAssertions:[],highRiskActionsBlocked:false,readAt:at};
export const commitmentsProps:CommitmentsProps={state:'ready',view:commitmentsView,
  related:{[id(11)]:related(id(11),id(41)),[id(12)]:related(id(12),id(42))},
  filters:{person:null,thread:null,dueBefore:null,dueAfter:null,includeResolved:false}};

// --- Weekly Review ---------------------------------------------------------
const ground=(n:number)=>({objectType:'proposition' as const,objectId:id(n)});
const section=(prefix:string,texts:Array<[string,string]>)=>({availability:'AVAILABLE' as const,note:null,
  statements:texts.map(([text,label],index)=>({statementId:prefix+'-'+(index+1),text,label,lifeCategory:null,grounds:[ground(index+1)]}))});
export const weeklyReviewProps:WeeklyReviewProps={weekStart:'2026-03-02',review:weeklyReviewSchema.parse({
  weeklyReviewId:id(90),weekStart:'2026-03-02',weekEnd:'2026-03-08',timeZone:'UTC',
  priorityVersusCalendar:{...section('priority',[['Family: you stated 1 high-priority commitment, and 1 hour of 11 scheduled went to family.','INFERRED']]),
    allocation:[{lifeCategory:'FAMILY',scheduledMinutes:60,eventCount:1,highPriorityCommitments:1,statedPriorityCommitments:1}]},
  commitmentsVersusResolutions:{...section('commitments',[['Completed: "Call the bank" (fulfilled on 2026-03-04).','CONFIRMED']]),openCount:2,slippingCount:1,completedCount:1},
  decisionsVersusOutcomes:{availability:'NOT_AVAILABLE_IN_THIS_RELEASE',note:'No decision is compared here yet.',statements:[]},
  plannedVersusObservedSpending:section('spending',[['Planned: ₪60 due 2026-03-05.','CONFIRMED']]),
  materialChanges:section('changes',[['Changed (Finance): the obligation principal amount was ₪50 and is now ₪60.','CONFIRMED']]),
  repeatedPostponement:{...section('postponement',[['Postponed: "Ship the quarterly report" moved from 2026-03-03 to 2026-03-04.','COMMITTED']]),episodeCount:1},
  behavioralObservations:[],contextPacketId:id(91),packetHash:'a'.repeat(64),
  manifest:{packetId:id(91),packetHash:'a'.repeat(64),beliefIds:[],claimIds:[],evidenceIds:[],overlayDeltaIds:[],frameInstanceIds:[],resolutionAssertionIds:[]},
  statementCount:5,reviewVersion:'weekly-review-0.1.0',createdAt:'2026-03-09T08:00:00.000Z'})};

// --- Memory Inspector ------------------------------------------------------
export const memoryInspectorProps:MemoryInspectorProps={state:'ready',inspector:inspection()};

// --- Memory Inbox ----------------------------------------------------------
const inputs={errorProbability:0.4,consequence:'HIGH',irreversibility:'COSTLY_TO_REVERSE',urgency:'LOW',interruptionCost:'LOW',
  expectedValue:0.15,interruptionCostValue:0.05,sensitivityScope:'FINANCE/PRIVATE',ownerLocalDate:'2026-03-02',timeZone:'UTC',
  budget:{maxCardsPerDay:3,maxCardsPerSensitivityScopePerDay:1,repeatQuestionSuppressionDays:7,askedToday:0,askedInScopeToday:0},
  lastAskedAt:null,suppressedUntil:null,materialNewEvidenceIds:[],learnedApprovalRuleId:null} as const;
export const inboxCard:ClarificationCard={
  clarificationCardId:id(1),situationKey:'thread:'+id(2),situationKind:'REPAYMENT',title:'Possible Daniel repayment',
  facts:['An obligation of ₪50 is on record.','A ₪60 transfer with the memo "Daniel dinner" was recorded.'],
  whyItMatters:'Whether this transfer repaid the ₪50 obligation decides whether you still owe it.',
  choices:[
    {choiceId:'confirm_repayment',label:'Confirm repayment',effect:'CONFIRM',whatWillChange:'Records that the ₪60 transfer repaid this obligation.',targets:[{objectType:'proposition',objectId:id(3)}]},
    {choiceId:'different_person',label:'Different person',effect:'REJECT',whatWillChange:'Records that the transfer went to someone else.',targets:[{objectType:'proposition',objectId:id(3)}]},
    {choiceId:'keep_uncertain',label:'Keep uncertain',effect:'KEEP_UNCERTAIN',whatWillChange:'Nothing is decided.',targets:[{objectType:'proposition',objectId:id(3)}]}],
  groupedAmbiguityIds:[id(3)],
  ambiguities:[{ambiguityId:id(3),kind:'UNCONFIRMED_INTERPRETATION',frameInstanceId:id(5),frameTypeId:'finance.payment_allocation',
    predicateId:'finance.payment_allocation.allocated_amount',propositionIds:[id(3)],evidenceIds:[],detail:'The allocated amount "₪60" is not confirmed.'}],
  sensitivityScope:'FINANCE/PRIVATE',status:'ASKED',askedAt:'2026-03-02T09:00:00.000Z',answeredAt:null,suppressedUntil:null,
  reopenedByEvidenceId:null,appliedRuleId:null,answer:null,
  interruption:{decision:'ASK',reason:'WITHIN_ATTENTION_BUDGET',policyInputs:{...inputs,budget:{...inputs.budget},materialNewEvidenceIds:[]},decidedAt:'2026-03-02T09:00:00.000Z'},
};
export const memoryInboxProps:MemoryInboxProps={view:memoryInboxViewSchema.parse({ownerLocalDate:'2026-03-02',timeZone:'UTC',
  budget:{maxCardsPerDay:3,maxCardsPerSensitivityScopePerDay:1,repeatQuestionSuppressionDays:7,isDefault:true,updatedAt:null},
  remainingToday:2,remainingByScope:[],cards:[inboxCard],deferredCount:1,withheld:[],resolvedToday:[],contextPacketId:null,readAt:'2026-03-02T09:00:00.000Z'})};
/** What `POST /v1/memory/inbox/cards/{id}/decide` answers for the first choice. */
export const inboxDecision:CardDecisionResult=cardDecisionResultSchema.parse({
  card:{...inboxCard,status:'RESOLVED',answeredAt:'2026-03-02T09:05:00.000Z',appliedRuleId:null,answer:{choiceId:'confirm_repayment',effect:'CONFIRM',
    answeredBy:'OWNER',learnedApprovalRuleId:null,evidenceId:id(11),overlayDeltaIds:[id(12)],memoryOperationIds:[id(13)],proposedTransactionId:id(14)}},
  answer:{choiceId:'confirm_repayment',effect:'CONFIRM',answeredBy:'OWNER',learnedApprovalRuleId:null,evidenceId:id(11),overlayDeltaIds:[id(12)],
    memoryOperationIds:[id(13)],proposedTransactionId:id(14)},
  interruptionDecision:{interruptionDecisionId:id(15),clarificationCardId:inboxCard.clarificationCardId,candidateAmbiguityId:id(3),
    ambiguityKind:'UNCONFIRMED_INTERPRETATION',decision:'ASK',reason:'WITHIN_ATTENTION_BUDGET',policyInputs:inboxCard.interruption!.policyInputs,
    ownerLocalDate:'2026-03-02',policyVersion:'interruption-policy-0.1.0',decidedAt:'2026-03-02T09:00:00.000Z'},
  proposedRule:null});
