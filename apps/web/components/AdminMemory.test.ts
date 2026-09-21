import {expect,it} from 'vitest';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {readFileSync} from 'node:fs';
import {inspection} from './testing/inspection';

it('provides the assigned owner memory workspace route',()=>{
  expect(()=>readFileSync('apps/web/pages/admin/memory.tsx','utf8')).not.toThrow();
});

it('filters existing frames by search, person, topic, source time and kind without changing certainty',async()=>{
  const {filterMemoryFrames}=await import('../lib/admin-memory-filter');
  const frame={frameInstanceId:'frame',frameTypeId:'shared.obligation',lifecycle:'ACTIVE',
    people:[{entityId:'person',canonicalLabel:'Dana',entityKind:'PERSON',roleId:'creditor'}],
    sources:inspection().originalEvidence,withheldSourceCount:0,resolutions:[],
    beliefs:[{propositionId:'belief',predicateId:'shared.obligation.amount',modality:'ACTUAL',assessmentStatus:'CONTESTED'}],
    threads:[{memoryThreadId:'thread',displayTitle:'Trip expenses'}]};
  for(const filters of [{q:'borrowed'},{person:'person'},{topic:'thread'},{from:'2026-03-01',to:'2026-03-01'},{kind:'shared.obligation'}]){
    expect(filterMemoryFrames([frame],filters)).toEqual([frame]);
  }
  for(const filters of [{q:'missing'},{person:'other'},{topic:'other'},{from:'2026-03-02'},{kind:'shared.commitment'}]){
    expect(filterMemoryFrames([frame],filters)).toEqual([]);
  }
});

it('verify-d1-belief: embeds exact certainty, supporting source text and existing action controls in one memory workspace',async()=>{
  const {AdminMemory}=await import('./AdminMemory');
  const html=renderToStaticMarkup(createElement(AdminMemory,{frames:[],errors:[],inspector:inspection(),review:null}));
  expect(html.match(/<main\b/g)).toHaveLength(1);
  expect(html).toContain('Confirmed');
  expect(html).toContain('I borrowed ILS 500 from Daniel');
  for(const label of ['Search','Person','Topic','From','Kind','Correct','Keep uncertain','Archive','Delete'])expect(html).toContain(label);
  expect(html).toContain('Proposal inbox is unavailable');
});
