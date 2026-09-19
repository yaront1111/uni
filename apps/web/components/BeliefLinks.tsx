import React from 'react';

/**
 * The one way any surface opens a belief in the Memory inspector or in the
 * Correction controls (ADR 0028 §5; CRT-UX-10-B). A surface passes the object it
 * already shows -- the proposition behind a Today item or an Ask statement, a
 * claim, the frame behind a commitment row, a resolution assertion or the
 * owner's own pending statement -- and the inspector route resolves it to the
 * belief it is about. Nothing here needs to know which screen it sits on.
 */
export type BeliefRefType='proposition'|'claim'|'frame_instance'|'resolution_assertion'|'owner_overlay_delta';

/** The object types the answer and briefing payloads name, mapped to the
 * inspector's. Plural table names and singular types both appear upstream. */
const REF_TYPES:Record<string,BeliefRefType>={
  proposition:'proposition',propositions:'proposition',claim:'claim',claims:'claim',
  frame_instance:'frame_instance',frame_instances:'frame_instance',
  resolution_assertion:'resolution_assertion',resolution_assertions:'resolution_assertion',
  owner_overlay_delta:'owner_overlay_delta',owner_overlay_deltas:'owner_overlay_delta',
};
export function beliefRefType(objectType:string):BeliefRefType|null{return REF_TYPES[objectType]??null;}

export function inspectorHref(objectType:BeliefRefType,objectId:string){return '/memory/inspector/'+objectType+'/'+objectId;}
export function correctionHref(objectType:BeliefRefType,objectId:string){return '/memory/correct/'+objectType+'/'+objectId;}

/** Two separately labelled links. `about` names the belief for a screen reader,
 * so a list of rows never reads as a column of identical "Inspect" links. */
export function BeliefLinks({objectType,objectId,about}:{objectType:string;objectId:string;about:string}){
  const type=beliefRefType(objectType);
  if(!type)return null;
  return <span className="belief-links">
    <a href={inspectorHref(type,objectId)}>Inspect<span className="sr-only"> {about}</span></a>
    {' · '}
    <a href={correctionHref(type,objectId)}>Correct<span className="sr-only"> {about}</span></a>
  </span>;
}

/** The inspectable objects among a surface's references, in order, each once.
 * A reference the inspector cannot open (a belief slot, a source item) is
 * dropped rather than linked to a page that would refuse it. */
export function inspectableRefs(refs:ReadonlyArray<{objectType:string;objectId:string}>){
  const seen=new Set<string>();
  return refs.flatMap(ref=>{
    const type=beliefRefType(ref.objectType);
    if(!type||seen.has(type+'/'+ref.objectId))return [];
    seen.add(type+'/'+ref.objectId);
    return [{objectType:type,objectId:ref.objectId}];
  });
}

/** Links for a statement that rests on one or several objects, as a Today item
 * or an Ask statement does: one pair for one belief, and a numbered list when a
 * statement names several (competing values, a resolution and its commitment),
 * so every belief the statement surfaced can be opened and corrected. */
export function BeliefRefLinks({refs,about}:{refs:ReadonlyArray<{objectType:string;objectId:string}>;about:string}){
  const inspectable=inspectableRefs(refs);
  if(inspectable.length===0)return null;
  if(inspectable.length===1)return <p className="belief-refs"><BeliefLinks {...inspectable[0]!} about={about}/></p>;
  return <ul className="belief-refs" aria-label="Memory behind this">{inspectable.map((ref,index)=><li key={ref.objectType+ref.objectId}>
    Memory {index+1}: <BeliefLinks {...ref} about={about+' (memory '+(index+1)+')'}/></li>)}</ul>;
}
