import {expect,it} from 'vitest';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {OperationsReport} from '@unai/domain';
import * as screen from './Runbooks';

function render(report:OperationsReport|null){
  expect(screen).toHaveProperty('Runbooks');
  return renderToStaticMarkup(createElement(screen.Runbooks,{report}));
}
const report:OperationsReport={format:'unai-operations/1',checkedAt:'2026-09-19T15:00:00.000Z',sourceCommit:'a'.repeat(40),workspaceClean:true,
  procedures:[{id:'backup',title:'Backup',body:'Stop writers; take an encrypted backup.',execution:null},
    {id:'deletion',title:'Deletion',body:'Use the owner deletion workflow.',execution:{executedAt:'2026-09-19T14:00:00.000Z',environment:'TEST',evidenceRef:'test-results/rehearsal.json',testNames:['deletion cascade']}}],
  restore:{result:'UNVERIFIED',emptyEnvironment:false,objectsRestored:false,keyRecoveryVerified:false,backupRef:null,fixtures:[]},
  adr:{inventoryReviewedAt:null,initialPaths:['docs/adr/0001-reference-stack.md'],entries:[{path:'docs/adr/0001-reference-stack.md',title:'Reference stack',date:'2026-09-14'}],deviations:[]},
  defects:{reviewedAt:null,items:[]},ci:null,localPolicy:{result:'UNVERIFIED',dependencyAuditRef:null,e2eRef:null}};
it('never labels an absent report as completed or a zero-defect gate as verified',()=>{
  const html=render(null);expect(html).toContain('Operations runbooks');expect(html).toContain('No operations evidence');
  expect(html).toContain('href="#content"');expect(html).not.toContain('Release ready');
});
it('shows published procedures, execution evidence, restore and the ADR index separately',()=>{
  const html=render(report);expect(html).toContain('Stop writers; take an encrypted backup.');
  expect(html).toContain('Not yet executed');expect(html).toContain('Executed in TEST');expect(html).toContain('deletion cascade');
  expect(html).toContain('0 of 20');expect(html).toContain('Reference stack');expect(html).toContain('2026-09-14');
  expect(html).toContain('Defect inventory has not been reviewed');expect(html).toContain('V0 release blocked');
});
it('renders procedure content as text and visibly lists open blocking defects',()=>{
  const r=structuredClone(report);r.procedures[0]!.body='<script>alert(1)</script>';
  r.defects={reviewedAt:'2026-09-19T14:00:00.000Z',items:[{id:'D1',priority:'P1',category:'SECURITY',status:'OPEN',detail:'Unauthorized access'}]};
  const html=render(r);expect(html).not.toContain('<script>');expect(html).toContain('&lt;script&gt;');
  expect(html).toContain('1 open P0/P1 correctness or security defects');expect(html).toContain('Unauthorized access');
});
