import { expect,it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { FrameInstanceMergeResult,FrameInstanceSplitResult,MergeSplitReview,ProjectionRebuildReceipt } from '@unai/domain';
import * as screen from './MergeSplit';

/** The Merge and split review screen, one assertion group per state the design
 * draws (design screen "Merge and split review", journey J5). */

const id=(n:number)=>'0192f3a0-0000-7000-8000-'+String(n).padStart(12,'0');
const empty:MergeSplitReview={frameCandidates:[],entityCandidates:[],recentLineage:[],readAt:'2026-09-18T10:00:00.000Z'};
const review:MergeSplitReview={
  frameCandidates:[{candidateId:id(1),frameTypeId:'shared.obligation',candidateFrameInstanceId:id(2),resolvedFrameInstanceId:id(3),
    matchOutcome:'PROBABLE_MATCH',score:0.72,scoreComponents:{sharedEntities:1,amountCompatibility:1},keptSeparate:true,
    reusedExistingInstance:false,createdAt:'2026-09-18T09:00:00.000Z'},
  {candidateId:id(4),frameTypeId:'shared.obligation',candidateFrameInstanceId:id(5),resolvedFrameInstanceId:id(6),
    matchOutcome:'POSSIBLE_MATCH',score:0.4,scoreComponents:{},keptSeparate:true,reusedExistingInstance:false,createdAt:'2026-09-18T09:01:00.000Z'}],
  entityCandidates:[{entityKind:'PERSON',sharedAlias:'daniel',entityIds:[id(7),id(8)],keptSeparate:true}],
  recentLineage:[],readAt:'2026-09-18T10:00:00.000Z',
};
const receipts:ProjectionRebuildReceipt[]=['open_commitments_projection','obligations_projection','schedule_projection'].map((name,index)=>({
  projectionRebuildReceiptId:id(20+index),projectionName:name as ProjectionRebuildReceipt['projectionName'],trigger:'MERGE',
  transactionId:id(30),rowsRebuilt:1,equalsIncremental:true,projectionVersion:id(40),reducerVersion:'projection-reducers-0.1.0',
  detail:{},createdAt:'2026-09-18T10:01:00.000Z'}));
const merged:FrameInstanceMergeResult={transactionId:id(30),committedAt:'2026-09-18T10:01:00.000Z',survivorFrameInstanceId:id(2),
  survivorCreated:false,mergedFrameInstanceIds:[id(3)],
  lineage:[{lineageId:id(50),objectType:'frame_instance',fromId:id(3),toId:id(2),lineageKind:'MERGED_INTO',transactionId:id(30),createdAt:'2026-09-18T10:01:00.000Z'}],
  propositionLineage:[],merges:[{survivorFrameInstanceId:id(2),mergedFrameInstanceId:id(3),frameTypeId:'shared.obligation',
    rehomedSlots:[],collidingSlots:[],mergedPropositions:[],conflicts:[],assessments:[]}],
  projectionRebuildReceipts:receipts,
  resolution:[{objectType:'frame_instance',id:id(3),lifecycle:'MERGED',resolvesTo:[id(2)],lineage:[]},
    {objectType:'frame_instance',id:id(2),lifecycle:'ACTIVE',resolvesTo:[id(2)],lineage:[]}]};
const split:FrameInstanceSplitResult={transactionId:id(31),committedAt:'2026-09-18T10:02:00.000Z',
  lineage:[{lineageId:id(51),objectType:'frame_instance',fromId:id(9),toId:id(10),lineageKind:'SPLIT_INTO',transactionId:id(31),createdAt:'2026-09-18T10:02:00.000Z'},
    {lineageId:id(52),objectType:'frame_instance',fromId:id(9),toId:id(11),lineageKind:'SPLIT_INTO',transactionId:id(31),createdAt:'2026-09-18T10:02:00.000Z'}],
  propositionLineage:[],
  split:{parentFrameInstanceId:id(9),frameTypeId:'shared.obligation',
    newFrameInstances:[{partitionKey:'concert',frameInstanceId:id(10)},{partitionKey:'dinner',frameInstanceId:id(11)}],
    reassignedClaims:[{claimId:id(12),partitionKey:'concert',frameInstanceId:id(10),fromPropositionId:id(13),toPropositionId:id(14),beliefSupportId:id(15)}],
    contestedClaims:[{claimId:id(16),propositionId:id(13),previousLifecycle:'PROVISIONAL'}],
    retainedOnParentClaims:[{claimId:id(17),lifecycle:'REJECTED',reason:'LIFECYCLE_ALREADY_SETTLED'}],
    newSlots:[{beliefSlotId:id(18),fromBeliefSlotId:id(19),frameInstanceId:id(10),partitionKey:'concert',predicateId:'shared.obligation.principal_amount',mixedSituations:true}],
    newPropositions:[],assessments:[]},
  projectionRebuildReceipts:receipts.map(receipt=>({...receipt,trigger:'SPLIT',transactionId:id(31)})),
  resolution:[{objectType:'frame_instance',id:id(9),lifecycle:'SPLIT',resolvesTo:[id(10),id(11)],lineage:[]}]};

function render(props:Partial<screen.MergeSplitProps>){
  return renderToStaticMarkup(createElement(screen.MergeSplit,{review:empty,...props}));
}

it('renders candidate pairs with their match outcome and score components, with the skip link and labelled controls',()=>{
  expect(screen).toHaveProperty('MergeSplit');
  const html=render({review});
  expect(html).toContain('Merge and split review');
  expect(html).toContain('Skip to content');
  expect(html).toContain('Probable match (score 0.72)');
  expect(html).toContain('sharedEntities: 1, amountCompatibility: 1');
  expect(html).toContain('No score components recorded');
  expect(html).toContain('Preview merge');
  expect(html).toContain('<label for="split-target">Identifier to split</label>');
  expect(html).toContain('aria-current="page">Merge and split</a>');
});

it('renders a probable or possible match as kept separate and never reused for a material accepted update',()=>{
  const html=render({review});
  expect(html).toContain('Kept separate — a probable match never reuses a situation for a material accepted update');
  expect(html).toContain('Kept separate — a possible match never reuses a situation for a material accepted update');
});

it('renders two same-name people kept as separate entities absent sufficient evidence',()=>{
  const html=render({review});
  expect(html).toContain('2 separate person entities kept apart: a shared name is not sufficient evidence that they are one.');
  expect(html).toContain(id(7)+', '+id(8));
});

it('renders a merge preview naming the survivor and the lineage to be written',()=>{
  const html=render({review,preview:{kind:'merge',objectType:'frame_instance',survivorId:id(2),mergedIds:[id(3)]}});
  expect(html).toContain('Merge preview');
  expect(html).toContain('The situation <code>'+id(2)+'</code> survives. This lineage will be written:');
  expect(html).toContain('<code>'+id(3)+'</code> merged into <code>'+id(2)+'</code>');
  expect(html).toContain('Confirm merge');
});

it('renders a merge receipt with lineage records, a projection rebuild receipt, and the old id still resolving to the survivor',()=>{
  const html=render({review,result:{kind:'frame-merge',result:merged}});
  expect(html).toContain('Merge receipt');
  expect(html).toContain('Lineage records');
  expect(html).toContain('Situation <code>'+id(3)+'</code> merged into <code>'+id(2)+'</code>');
  expect(html).toContain('Projection rebuild receipts');
  expect(html).toContain('obligations_projection: rebuilt 1 row after the merge — replay equals the maintained state');
  expect(html).toContain('<code>'+id(3)+'</code> (Situation, merged) resolves to <code>'+id(2)+'</code>');
  expect(html).toContain('kept as history, never reused for anything else');
});

it('renders a split preview that leaves unassigned claims contested on the retired parent',()=>{
  const html=render({review,preview:{kind:'split',objectType:'frame_instance',targetId:id(9),partitions:['concert','dinner'],
    assignments:[{objectId:id(12),partitionKey:'concert'}]}});
  expect(html).toContain('Split preview');
  expect(html).toContain('split into 2 new situations: concert, dinner');
  expect(html).toContain('<code>'+id(12)+'</code> goes to concert');
  expect(html).toContain('Claims you do not assign cannot be safely assigned: they are left contested and attached to the retired parent.');
  expect(html).toContain('Confirm split');
});

it('renders a split receipt with the claims that could not be safely assigned left contested or on the retired parent',()=>{
  const html=render({review,result:{kind:'frame-split',result:split}});
  expect(html).toContain('Split receipt');
  expect(html).toContain('Claims that cannot be safely assigned');
  expect(html).toContain('Claim <code>'+id(16)+'</code>: contested, still attached to the retired parent');
  expect(html).toContain('Claim <code>'+id(17)+'</code>: attached to the retired parent (rejected)');
  expect(html).toContain('each new situation received a slot of its own');
  expect(html).toContain('after the split');
  expect(html).toContain('(Situation, split) resolves to <code>'+id(10)+'</code><code>'+id(11)+'</code>');
});

it('renders an empty review and a read failure',()=>{
  const html=render({});
  expect(html).toContain('No candidate pairs have been recorded.');
  expect(html).toContain('No two entities share a name.');
  expect(html).toContain('Nothing has been merged or split yet.');
  expect(render({error:'The merge and split review could not be read. Please reload to retry.'}))
    .toContain('role="alert"');
});
