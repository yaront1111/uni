import {expect,it} from 'vitest';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {InitiativeSettings} from '@unai/domain';
import {Initiative} from './Initiative';
const id=(n:number)=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const settings:InitiativeSettings={enabled:false,timeZone:'Asia/Jerusalem',localTime:'09:00',dataPurpose:'PERSONAL_ASSISTANCE',maximumSensitivity:'PRIVATE',prepareDrafts:false,nextDueAt:null,revision:0};
it('offers opt-in, readable watch choices, permission review and notice management without technical identifiers',()=>{
 const html=renderToStaticMarkup(createElement(Initiative,{settings,error:null,saved:false,
  choices:{scheduled:[{frameId:id(1),label:'Planning meeting',time:'2026-09-20T10:00:00.000Z',provisional:true,scheduled:true}],prerequisites:[{frameId:id(2),label:'Send the planning document',time:null,provisional:false,scheduled:false}],incomplete:false},
  watches:[{watchId:id(3),sourceEvidenceId:id(4),scheduledFrameId:id(1),prerequisiteFrameId:id(2),enabled:true,snoozedUntil:null,createdAt:'2026-09-19T10:00:00.000Z'}],
  notices:[{noticeId:id(5),watchId:id(3),threshold:'UPCOMING',message:'A scheduled item is approaching or overdue, and its linked prerequisite remains unresolved.',sourceEvidenceIds:[id(4)],draftId:id(6),preparation:'DRAFTED',ownerLocalDate:'2026-09-19',createdAt:'2026-09-19T10:00:00.000Z'}]}));
 for(const text of ['Daily checks','Enable daily checks','Time zone','Local time','Prepare generic request drafts','Planning meeting','Provisional','Scheduled','Unfinished prerequisite','Snooze for 24 hours','Disable watch'])expect(html).toContain(text);
 expect(html).toContain('href="/permissions"');expect(html).toContain('href="/actions/drafts"');expect(html).toContain('nothing has been sent');
 expect(html.replace(/<[^>]+>/g,' ')).not.toMatch(/[0-9a-f]{8}-[0-9a-f-]{27}/i);
});
it('keeps an incomplete screen usable without allowing an invented watch',()=>{
 const html=renderToStaticMarkup(createElement(Initiative,{settings,watches:[],notices:[],error:null,saved:false,choices:{scheduled:[],prerequisites:[],incomplete:true}}));
 expect(html).toContain('Some memory is still unavailable or being processed');expect(html).toContain('No readable scheduled items with a usable time');expect(html).toMatch(/<button[^>]*disabled[^>]*>Create watch/);
});
