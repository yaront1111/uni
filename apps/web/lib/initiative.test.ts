import {expect,it} from 'vitest';
import {contextPacketSchema,contextSelectionSchema} from '@unai/domain';
import {initiativeChoices,loadInitiative,watchRequest} from './initiative';
import type {ApiCall} from './screens';
const id=(n:number)=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const at='2026-09-19T10:00:00.000Z';
const settings={enabled:false,timeZone:'Asia/Jerusalem',localTime:'09:00',dataPurpose:'PERSONAL_ASSISTANCE',maximumSensitivity:'PRIVATE',prepareDrafts:false,nextDueAt:null,revision:0};
function selection(frame:number,n:number,predicate:string,value:unknown,over:Record<string,unknown>={}){return contextSelectionSchema.parse({
  beliefSlotId:id(n+200),frameInstanceId:id(frame),frameTypeId:predicate.startsWith('shared.commitment')?'shared.commitment':'shared.event_occurrence',predicateId:predicate,
  modality:'SCHEDULED',contextKind:'BASE',predicateRegistered:true,outcome:'SELECTED',reason:'CURRENT_VALUE',selectedPropositionId:id(n),selectedValue:value,
  certainty:'ACCEPTED',assessmentId:null,assessmentStatus:'ACCEPTED',validFrom:null,validTo:null,competingPropositionIds:[],claimOrigins:['USER_STATEMENT'],
  evidenceIds:[id(100)],appliedRelations:[],overlayDeltaIds:[],ownerAssertionPending:false,steps:[],...over});}
export function packet(){const selections=[selection(1,11,'shared.event_occurrence.description',{text:'Planning meeting'}),
  selection(1,12,'shared.event_occurrence.occurrence_time',{time:'2026-09-20T10:00:00.000Z'},{certainty:'PROVISIONAL',assessmentStatus:'PROVISIONAL'}),
  selection(2,13,'shared.commitment.action_description','Send the planning document',{modality:'COMMITTED'})];
  return contextPacketSchema.parse({packetId:id(90),packetHash:'a'.repeat(64),ownerScopeId:id(80),requestingActorId:id(81),purpose:'PERSONAL_ASSISTANCE',answerType:'OPEN_COMMITMENTS',
    lifeCategory:null,registryRelease:'0.3.0',worldTime:at,knowledgeTime:at,currentBeliefs:[],historicalBeliefs:[],
    futureClaims:selections.map(s=>({propositionId:s.selectedPropositionId,frameInstanceId:s.frameInstanceId,frameTypeId:s.frameTypeId,predicateId:s.predicateId,modality:s.modality,normalizedValue:s.selectedValue,lifeCategories:[],evidenceIds:s.evidenceIds})),
    resolutionAssertions:[],conflicts:[],unknowns:[],ownerOverlayDeltas:[],projectionFragments:[],evidenceRefs:[],memoryThreads:[],allowedActions:[],actionDecision:null,redactions:[],
    watermarks:{ownerOverlayWatermark:0,canonicalTransactionWatermark:at,projectionVersions:{},registryRelease:'0.3.0',knowledgeTime:at,worldTime:at},
    selections,semanticSearch:null,understanding:{asOf:at,currentPropositionIds:[],lastKnownPropositionIds:[],historicalPropositionIds:[],unresolvedFrameIds:[id(2)],origins:[],transitions:[],goalLinks:[],complete:true},
    selectionReason:{answerType:'OPEN_COMMITMENTS',worldTimeFilter:at,knowledgeTimeFilter:at,requiredCertainty:['ACCEPTED','PROVISIONAL','CONTESTED','OWNER_OVERLAY'],contextKind:'BASE',appliedRules:[],overlayDeltasApplied:[],selectorVersion:'test-0.1',selectionsDigest:'b'.repeat(64)},
    policy:{outcome:'ALLOW',reason:'READ_ALLOWED',policyVersion:'test-0.1',policyDecisionId:id(91)},brokerVersion:'test-0.1',createdAt:at});}
it('loads initiative with declared source authority and a complete actor-bound context request',async()=>{
  const calls:Parameters<ApiCall>[]=[];
  const loaded=await loadInitiative(async(...args)=>{calls.push(args);const path=args[0];return {status:path==='/v1/memory/context'?201:200,body:path.endsWith('/settings/initiative')?{settings}:path.endsWith('/watches')?{watches:[]}:path.endsWith('/notices')?{notices:[]}:packet()};},{cookie:'session',ownerScopeId:id(80),userId:id(81)});
  expect(calls).toHaveLength(4);for(const [, ,headers] of calls){expect(headers['x-data-purpose']).toBe('PERSONAL_ASSISTANCE');expect(headers['x-maximum-sensitivity']).toBe('PRIVATE');expect(headers.cookie).toBe('session');}
  expect(calls.find(c=>c[0].endsWith('/settings/initiative'))?.[2]['x-purpose']).toBe('settings.attention');
  const context=calls.find(c=>c[0]==='/v1/memory/context')!;expect(context[1]).toBe('POST');expect(context[3]).toMatchObject({ownerScopeId:id(80),requestingActorId:id(81),frameTypeHints:['shared.commitment','shared.event_occurrence'],requiredCertainty:['ACCEPTED','PROVISIONAL','CONTESTED','OWNER_OVERLAY'],maximumSensitivity:'PRIVATE'});
  if(loaded.kind!=='props')throw new Error('Expected loaded props');
  expect(loaded.props.choices.scheduled).toEqual([expect.objectContaining({frameId:id(1),label:'Planning meeting',provisional:true})]);
});
it('keeps refused sources out of the screen and redirects an expired session',async()=>{
  const refused=await loadInitiative(async path=>({status:path.endsWith('/settings/initiative')?200:403,body:path.endsWith('/settings/initiative')?{settings}:{rawText:'protected-source-marker'}}),{cookie:'s',ownerScopeId:id(80),userId:id(81)});
  if(refused.kind!=='props')throw new Error('Expected refused props');
  expect(refused.props.error).toBeTruthy();expect(refused.props.choices.scheduled).toEqual([]);expect(refused.props.notices).toEqual([]);expect(JSON.stringify(refused)).not.toContain('protected-source-marker');
  expect(await loadInitiative(async()=>({status:401,body:{}}),{cookie:'s',ownerScopeId:id(80),userId:id(81)})).toEqual({kind:'expired'});
});
it('does not turn missing, withheld, conflicted or resolved values into watch choices',()=>{
  const good=packet(),choices=initiativeChoices(good);expect(choices.prerequisites.map(c=>c.frameId)).toContain(id(2));
  expect(watchRequest(id(1),id(2),'Please remind me to request the document.',choices)).toMatchObject({scheduledFrameId:id(1),prerequisiteFrameId:id(2)});
  for(const invalid of ['',id(98),id(1)])expect(watchRequest(id(1),invalid,'Please remind me.',choices)).toBeNull();
  expect(watchRequest(id(1),id(2),'  ',choices)).toBeNull();
  const missing=packet();delete missing.selections[0]!.selectedValue;expect(initiativeChoices(missing).scheduled).toEqual([]);
  const withheld=packet();withheld.selections[0]!.evidenceIds=[];expect(initiativeChoices(withheld).scheduled).toEqual([]);
  const conflict=packet();conflict.selections[1]!.outcome='CONTESTED';expect(initiativeChoices(conflict).scheduled).toEqual([]);
  const resolved=packet();resolved.understanding!.unresolvedFrameIds=[];expect(initiativeChoices(resolved).prerequisites).toEqual([]);
  const incomplete=packet();incomplete.understanding!.complete=false;expect(initiativeChoices(incomplete).incomplete).toBe(true);
});
