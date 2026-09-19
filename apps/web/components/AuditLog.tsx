import React from 'react';
import type {AuditEventKind,AuditLog as Log,PublicAuditEvent} from '@unai/domain';
import {Shell} from './Shell';

/**
 * The Audit log (design journey J9, screen "Audit log"; PRD §30.6;
 * CRT-SEC-07-A). Every drawn state is reachable from props alone:
 *
 *  - the append-only event list with actor, owner scope, purpose, objects and
 *    fields accessed, policy decision, model or code version, result and
 *    correlation id;
 *  - the list filtered to one object;
 *  - an attempted update or delete of an event, refused by the application and
 *    recorded as its own event;
 *  - redacted metadata retained for deleted content, with no payload.
 *
 * The screen offers no control that changes an event: there is none to offer,
 * because the API has no such route. Identifiers are the point of this screen,
 * so they are shown, in code type, rather than hidden in an advanced panel.
 */
export interface AuditLogProps{
  log:Log|null;
  /** The signed-in actor, named "You" in the list. */
  actorId:string|null;
  error?:string|null;
}

export const KIND_TEXT:Record<AuditEventKind,string>={
  READ:'Read',WRITE:'Write',PROJECTION_REBUILD:'Projection rebuild',EXPORT:'Export',DELETION:'Deletion',EXTERNAL_ACTION:'External action',
};
const RESULT_TEXT:Record<PublicAuditEvent['result'],string>={SUCCESS:'Succeeded',FAILURE:'Failed',REFUSED:'Refused'};
const DECISION_TEXT:Record<PublicAuditEvent['policyDecision'],string>={ALLOW:'Allowed',DENY:'Denied'};
const AUDIT_MODIFY='audit.modify';

/** The same filters, carried into a link. */
function href(filters:Record<string,string|null|undefined>){
  const query=Object.entries(filters).filter((entry):entry is [string,string]=>typeof entry[1]==='string'&&entry[1]!=='')
    .map(([name,value])=>encodeURIComponent(name)+'='+encodeURIComponent(value)).join('&');
  return '/ops/audit'+(query?'?'+query:'');
}
const when=(iso:string)=>iso.slice(0,10)+' '+iso.slice(11,19)+' UTC';

function Objects({event}:{event:PublicAuditEvent}){
  if(event.objects.length===0)return <span className="muted">None named</span>;
  return <ul className="audit-objects">{event.objects.map((object,index)=><li key={object.type+object.id+index}>
    <code>{object.type}</code> <code>{object.id}</code>
    {object.fields.length>0?<> — fields: {object.fields.map(field=><code key={field}>{field}</code>).reduce<React.ReactNode[]>((all,field,at)=>at===0?[field]:[...all,', ',field],[])}</>
      :<> — no fields</>}
    {' '}<a href={href({objectType:object.type,objectId:object.id})}>Events for this object<span className="sr-only"> ({object.type} {object.id})</span></a>
  </li>)}</ul>;
}

function Notes({event}:{event:PublicAuditEvent}){
  const notes:string[]=[];
  if(event.purpose===AUDIT_MODIFY)notes.push(event.eventKind==='DELETION'
    ?'Refused: an attempt to delete from the audit log. Nothing was deleted.'
    :'Refused: an attempt to change the audit log. Nothing was changed.');
  if(event.eventKind==='DELETION'&&event.purpose!==AUDIT_MODIFY)notes.push('Content deleted: only identifiers and field names are kept here, never what they held.');
  return notes.length===0?null:<ul className="audit-notes">{notes.map(note=><li key={note}>{note}</li>)}</ul>;
}

function Row({event,actorId}:{event:PublicAuditEvent;actorId:string|null}){
  return <tr>
    <td>{when(event.createdAt)}</td>
    <td><strong>{KIND_TEXT[event.eventKind]}</strong><Notes event={event}/></td>
    <td>{event.actorId===actorId?'You':<code>{event.actorId}</code>}</td>
    <td><code>{event.ownerScopeId}</code></td>
    <td><code>{event.purpose}</code></td>
    <td><Objects event={event}/></td>
    <td>{DECISION_TEXT[event.policyDecision]}{event.policyDecisionId?<> (decision <code>{event.policyDecisionId}</code>)</>:null}</td>
    <td><code>{event.codeVersion}</code></td>
    <td>{RESULT_TEXT[event.result]}</td>
    <td><code>{event.correlationId}</code></td>
  </tr>;
}

function Filters({log}:{log:Log|null}){
  const filters=log?.filters;
  return <form className="card" method="get" action="/ops/audit" aria-labelledby="audit-filter">
    <h2 id="audit-filter">Filter</h2>
    <label htmlFor="audit-kind">Kind</label>
    <select id="audit-kind" name="eventKind" defaultValue={filters?.eventKind??''}>
      <option value="">Any kind</option>
      {(Object.keys(KIND_TEXT) as AuditEventKind[]).map(kind=><option key={kind} value={kind}>{KIND_TEXT[kind]}</option>)}
    </select>
    <label htmlFor="audit-purpose">Purpose</label>
    <input id="audit-purpose" name="purpose" type="text" defaultValue={filters?.purpose??''} placeholder="For example: data.export"/>
    <label htmlFor="audit-object-type">Object type</label>
    <input id="audit-object-type" name="objectType" type="text" defaultValue={filters?.objectType??''} placeholder="For example: source_items"/>
    <label htmlFor="audit-object-id">Object identifier</label>
    <input id="audit-object-id" name="objectId" type="text" defaultValue={filters?.objectId??''} aria-describedby="audit-object-help"/>
    <p id="audit-object-help" className="muted">An object filter needs both its type and its identifier.</p>
    <button type="submit">Show events</button>
  </form>;
}

export function AuditLog({log,actorId,error}:AuditLogProps){
  const events=log?.events??[];
  const filters=log?.filters;
  const object=filters?.objectType&&filters.objectId?{type:filters.objectType,id:filters.objectId}:null;
  const refused=events.filter(event=>event.purpose===AUDIT_MODIFY);
  const deletions=events.filter(event=>event.eventKind==='DELETION'&&event.purpose!==AUDIT_MODIFY);
  return <Shell current="audit" eyebrow="OPERATIONS" title="Audit log"
    status={log?events.length+' event'+(events.length===1?'':'s')+' shown.':''}
    footer="The audit log is append-only. It records who read or changed what, why, under which decision and with what result.">
    <p>Every read, write, projection rebuild, export, deletion and external action appends one event here. Uai offers no way to change or delete an event: an attempt is refused, and the refusal is recorded as an event of its own.</p>
    {error?<p role="alert">{error}</p>:null}
    <Filters log={log}/>
    {object?<section className="card" aria-labelledby="audit-object">
      <h2 id="audit-object">Events about one object</h2>
      <p>Showing only events that name <code>{object.type}</code> <code>{object.id}</code>. <a href="/ops/audit">Show all events</a></p>
    </section>:null}
    {refused.length>0?<section className="card notice" aria-labelledby="audit-refused">
      <h2 id="audit-refused">Attempts to change the audit log were refused</h2>
      <p>{refused.length} attempt{refused.length===1?' was':'s were'} made to change or delete audit events. Each was refused by the application; no event was changed or removed, and each attempt is listed below.</p>
    </section>:null}
    {deletions.length>0?<section className="card" aria-labelledby="audit-deleted">
      <h2 id="audit-deleted">Deleted content</h2>
      <p>Deleted items keep only redacted metadata here: which objects and fields the deletion touched, never their content.</p>
    </section>:null}
    {log?<section className="card" aria-labelledby="audit-events">
      <h2 id="audit-events">Events</h2>
      {events.length===0?<p>No audit event matches{object||filters?.eventKind||filters?.purpose?' these filters':''}.</p>:
        <div className="table-scroll" role="region" aria-label="Audit event table (scrolls sideways)" tabIndex={0}>
          <table>
            <caption>Audit events, newest first</caption>
            <thead><tr>
              <th scope="col">When</th><th scope="col">Kind</th><th scope="col">Actor</th><th scope="col">Owner scope</th>
              <th scope="col">Purpose</th><th scope="col">Objects and fields</th><th scope="col">Policy decision</th>
              <th scope="col">Model or code version</th><th scope="col">Result</th><th scope="col">Correlation id</th>
            </tr></thead>
            <tbody>{events.map(event=><Row key={event.auditEventId} event={event} actorId={actorId}/>)}</tbody>
          </table>
        </div>}
      {log.nextCursor?<p><a href={href({objectType:filters?.objectType,objectId:filters?.objectId,purpose:filters?.purpose,
        eventKind:filters?.eventKind,before:log.nextCursor})}>Older events</a></p>:null}
    </section>:null}
  </Shell>;
}
