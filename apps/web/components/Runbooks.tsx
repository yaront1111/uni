import React from 'react';
import {RUNBOOK_IDS,evaluateV0Release,type OperationsReport} from '@unai/domain';
import {Navigation} from './Navigation';

const labels:Record<typeof RUNBOOK_IDS[number],string>={backup:'Backup',restore:'Restore',deletion:'Deletion',
  'registry-migration':'Registry migration','projection-rebuild':'Projection rebuild','connector-revocation':'Connector revocation'};
export function Runbooks({report,error}:{report:OperationsReport|null;error?:string}){
  const gates=report?evaluateV0Release(report):[];
  const blockers=report?.defects.items.filter(d=>d.status==='OPEN'&&(d.priority==='P0'||d.priority==='P1')
    &&(d.category==='CORRECTNESS'||d.category==='SECURITY'))??[];
  return <div className="shell">
    <a className="skip" href="#content">Skip to content</a>
    <header><a href="/" className="brand">Uai</a><span>Your personal memory</span></header>
    <Navigation current="runbooks"/>
    <main id="content" tabIndex={-1}>
      <p className="eyebrow">OPERATIONS</p><h1>Operations runbooks</h1>
      {error&&<p role="alert">{error}</p>}
      {!report?<p>No operations evidence is available. Publish the reviewed procedures and execution report before evaluating the release.</p>:<>
        <section className="card" aria-labelledby="release-gate"><h2 id="release-gate">V0 release gate</h2>
          <p role="status">{gates.every(g=>g.passed)?'All supplied release evidence meets the gate':'V0 release blocked: evidence is incomplete or failed'}</p>
          <p>Evidence recorded {report.checkedAt}. Source commit <code>{report.sourceCommit}</code>.</p>
          <ul>{gates.map(g=><li key={g.criterion}>{g.criterion}: {g.passed?'Verified by supplied evidence':'Blocked or unverified'}</li>)}</ul>
          <p>{report.ci?`CI branch ${report.ci.branch}; expected ${report.ci.defaultBranch}.`:'No default-branch CI run is recorded.'}</p>
          <p>Local policy adapters: {report.localPolicy.result}.</p>
        </section>
        <section aria-labelledby="procedures"><h2 id="procedures">Published procedures</h2>
          {RUNBOOK_IDS.map(id=>{const p=report.procedures.find(p=>p.id===id);return <details className="card" key={id}>
            <summary>{labels[id]} — {!p?'Not published':p.execution?'Executed in TEST':'Not yet executed'}</summary>
            {p&&<><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{p.body}</pre>
              {p.execution&&<><p>Executed in TEST at {p.execution.executedAt}. Evidence: <code>{p.execution.evidenceRef}</code>.</p>
                <ul>{p.execution.testNames.map(name=><li key={name}>{name}</li>)}</ul></>}</>}
          </details>;})}
        </section>
        <section className="card" aria-labelledby="restore-parity"><h2 id="restore-parity">Restore equivalence</h2>
          <p>{report.restore.result}: {report.restore.fixtures.filter(f=>f.sourceDigest===f.restoredDigest).length} of 20 acceptance fixtures match.</p>
          <p>Empty target: {report.restore.emptyEnvironment?'verified':'unverified'}. Raw objects restored: {report.restore.objectsRestored?'verified':'unverified'}.
            {' '}Key recovery: {report.restore.keyRecoveryVerified?'verified':'unverified'}.</p>
          <p>Backup reference: {report.restore.backupRef??'Not recorded'}</p>
        </section>
        <section className="card" aria-labelledby="adr-index"><h2 id="adr-index">ADR index</h2>
          <p>{report.adr.inventoryReviewedAt?`Deviation inventory reviewed ${report.adr.inventoryReviewedAt}`:'MUST/SHOULD deviation inventory has not been reviewed.'}</p>
          <ul>{report.adr.entries.map(a=><li key={a.path}>{a.title} — {a.date} <code>{a.path}</code></li>)}</ul>
          {report.adr.deviations.length>0&&<ul>{report.adr.deviations.map((d,i)=><li key={i}>{d.requirement}: {d.adrPath}; implemented {d.implementedAt}</li>)}</ul>}
        </section>
        <section className="card" aria-labelledby="defect-gate"><h2 id="defect-gate">Defect gate</h2>
          <p>{report.defects.reviewedAt?`${blockers.length} open P0/P1 correctness or security defects`:'Defect inventory has not been reviewed; zero entries is not proof of zero defects.'}</p>
          <ul>{report.defects.items.map(d=><li key={d.id}>{d.id} — {d.priority} {d.category} {d.status}: {d.detail}</li>)}</ul>
        </section>
      </>}
    </main><footer>Run administrative procedures from the documented operator environment. This screen records evidence and performs no administrative writes.</footer>
  </div>;
}
