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
