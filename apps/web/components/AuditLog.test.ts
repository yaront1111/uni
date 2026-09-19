import {expect,it} from 'vitest';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {AuditLog,type AuditLogProps} from './AuditLog';
import {AUDIT_ACTOR,AUDIT_EVENTS,AUDIT_OBJECT,AUDIT_OWNER,auditLog} from './testing/audit';

/** The Audit log screen (design "Audit log"; CRT-SEC-07-A): one assertion per
 * drawn state, the shell's landmarks, and no control that could change an event. */

const render=(props:Partial<AuditLogProps>)=>renderToStaticMarkup(createElement(AuditLog,{log:null,actorId:AUDIT_ACTOR,...props}));

it('draws the append-only event list with every audited field', ()=>{
  const html=render({log:auditLog()});
  expect(html).toContain('<h1 id="page-title">Audit log</h1>');
  expect(html).toContain('Skip to content');
  expect(html).toContain('role="status"');
  expect(html).toContain('7 events shown.');
  for(const column of ['When','Kind','Actor','Owner scope','Purpose','Objects and fields','Policy decision','Model or code version','Result','Correlation id']){
    expect(html,column).toContain('<th scope="col">'+column+'</th>');
  }
  // Each field, from real values.
  expect(html).toContain('2026-09-19 10:53:00 UTC');
  for(const kind of ['Read','Write','Projection rebuild','Export','Deletion','External action'])expect(html,kind).toContain('<strong>'+kind+'</strong>');
  expect(html).toContain('You');
  expect(html).toContain(AUDIT_OWNER);
  expect(html).toContain('<code>data.export</code>');
  expect(html).toContain('<code>source_items</code>');
  expect(html).toContain('fields: <code>content_hash</code>, <code>sensitivity</code>');
  expect(html).toContain('Allowed');
  expect(html).toContain('Denied (decision <code>');
  expect(html).toContain('<code>projection-reducers-0.1.0</code>');
  expect(html).toContain('Succeeded');
  expect(html).toContain(AUDIT_EVENTS[0]!.correlationId);
  // The list is newest first and pages backwards.
  expect(html).toContain('Audit events, newest first');
  expect(html).toContain('Older events</a>');
  expect(html).toContain('before=2026-09-19T10%3A52%3A00.000000Z');
  // It is a log, not an editor: no button or form acts on an event.
  expect(html.match(/<button/g)).toHaveLength(1);
  expect(html).toContain('<button type="submit">Show events</button>');
  expect(html).not.toMatch(/method="post"|Edit|Remove this/i);
});

it('draws the list filtered to one object, with a way back to every event', ()=>{
  const html=render({log:auditLog({filters:{objectType:AUDIT_OBJECT.type,objectId:AUDIT_OBJECT.id,actorId:null,purpose:null,eventKind:null,from:null,to:null},
    events:AUDIT_EVENTS.filter(event=>event.objects.some(object=>object.id===AUDIT_OBJECT.id))})});
  expect(html).toContain('Events about one object');
  expect(html).toContain('Showing only events that name <code>source_items</code> <code>'+AUDIT_OBJECT.id+'</code>');
  expect(html).toContain('<a href="/ops/audit">Show all events</a>');
  expect(html).toContain('objectType=source_items&amp;objectId='+AUDIT_OBJECT.id);
  expect(html).toContain('3 events shown.');
  // Every object in the list links to its own history.
  expect(html).toContain('Events for this object<span class="sr-only"> (source_items '+AUDIT_OBJECT.id+')</span>');
});

it('draws an attempted update or delete of an audit event as refused by the application', ()=>{
  const html=render({log:auditLog()});
  expect(html).toContain('Attempts to change the audit log were refused');
  expect(html).toContain('1 attempt was made to change or delete audit events. Each was refused by the application');
  expect(html).toContain('Refused: an attempt to delete from the audit log. Nothing was deleted.');
  const edit=render({log:auditLog({events:[{...AUDIT_EVENTS[0]!,eventKind:'WRITE'}]})});
  expect(edit).toContain('Refused: an attempt to change the audit log. Nothing was changed.');
  // With no attempt, no such notice.
  expect(render({log:auditLog({events:AUDIT_EVENTS.slice(1)})})).not.toContain('Attempts to change the audit log were refused');
});

it('draws the redacted metadata retained for deleted content, with no payload', ()=>{
  const html=render({log:auditLog()});
  expect(html).toContain('Deleted content');
  expect(html).toContain('Deleted items keep only redacted metadata here: which objects and fields the deletion touched, never their content.');
  expect(html).toContain('Content deleted: only identifiers and field names are kept here, never what they held.');
  expect(html).toContain('fields: <code>deleted_at</code>');
});

it('draws the empty, filtered-empty and error states in words', ()=>{
  expect(render({log:auditLog({events:[],nextCursor:null})})).toContain('No audit event matches.');
  expect(render({log:auditLog({events:[],nextCursor:null,filters:{objectType:null,objectId:null,actorId:null,purpose:'data.export',eventKind:null,from:null,to:null}})}))
    .toContain('No audit event matches these filters.');
  const failed=render({error:'The audit log could not be read. Please reload to retry.'});
  expect(failed).toContain('role="alert"');
  expect(failed).toContain('The audit log could not be read.');
  // The filters are labelled controls.
  for(const [id,label] of [['audit-kind','Kind'],['audit-purpose','Purpose'],['audit-object-type','Object type'],['audit-object-id','Object identifier']]){
    expect(failed).toContain('<label for="'+id+'">'+label+'</label>');
  }
  expect(failed).toContain('aria-current="page">Audit log</a>');
});
