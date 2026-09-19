import { createHash } from 'node:crypto';
import { PARTIAL_OUTCOME_CODES,type ContextPacket } from '@unai/domain';
import { canonicalJson } from '@unai/memory';
import { dueInstant,readTimeValue } from '@unai/capabilities';

/** Both scheduled evaluation and notice reads use the current authorized packet.
 * A saved receipt does not keep an old deadline or unresolved state current. */
export function initiativeSituation(packet:ContextPacket,watch:Record<string,any>,now:Date) {
  const ids=[watch.scheduled_frame_id as string,watch.prerequisite_frame_id as string];
  const selected=packet.selections.filter(value=>ids.includes(value.frameInstanceId)&&value.outcome==='SELECTED'&&value.selectedPropositionId&&'selectedValue' in value);
  if(ids.some(id=>!selected.some(value=>value.frameInstanceId===id)))return null;
  const resolutions=packet.resolutionAssertions.filter(value=>ids.includes(value.sourceFrameInstanceId)&&value.lifecycle==='ACCEPTED');
  const finalCodes=new Set(resolutions.filter(value=>value.sourceFrameInstanceId===watch.prerequisite_frame_id)
    .map(value=>value.outcomeCode).filter(code=>!PARTIAL_OUTCOME_CODES.includes(code)));
  if(finalCodes.size===1)return null;
  const scheduledFinalCodes=new Set(resolutions.filter(value=>value.sourceFrameInstanceId===watch.scheduled_frame_id)
    .map(value=>value.outcomeCode).filter(code=>!PARTIAL_OUTCOME_CODES.includes(code)));
  if(scheduledFinalCodes.size===1)return null;
  const time=selected.find(value=>value.frameInstanceId===watch.scheduled_frame_id&&['shared.commitment.due_time','shared.event_occurrence.occurrence_time'].includes(value.predicateId));
  // The owner's readable pending correction can dispute the selected canonical
  // deadline. Until it is governed, that old time cannot trigger a reminder.
  if(!time||time.ownerAssertionPending)return null;
  const due=time.predicateId.endsWith('due_time')?dueInstant(time.selectedValue):readTimeValue(time.selectedValue)?.start;
  if(!due)return null;
  const remaining=due.getTime()-now.getTime();
  if(remaining>48*3600000)return null;
  const threshold=remaining<=0?'OVERDUE':remaining<=24*3600000?'IMMINENT':'UPCOMING';
  const sourceIds=[...new Set([watch.source_item_id as string,...selected.flatMap(value=>value.evidenceIds??[])])].sort();
  if(sourceIds.length>200)return null;
  const incomplete=packet.projectionFragments.some(value=>!value.isComplete);
  const settled=selected.every(value=>value.certainty==='ACCEPTED'&&!value.ownerAssertionPending)&&finalCodes.size===0&&scheduledFinalCodes.size===0&&!incomplete
    &&!packet.conflicts.some(value=>ids.includes(value.frameInstanceId));
  const state={selected:selected.map(value=>({id:value.selectedPropositionId,value:value.selectedValue,certainty:value.certainty,overlayIds:value.overlayDeltaIds})),
    resolutions:resolutions.map(value=>value.resolutionAssertionId)};
  return {threshold,sourceIds,settled,due,stateDigest:createHash('sha256').update(canonicalJson(state)).digest('hex'),
    nextThreshold:remaining>24*3600000?new Date(due.getTime()-24*3600000):remaining>0?due:null};
}
