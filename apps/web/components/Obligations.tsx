import React from 'react';
import type {ObligationProjectionRow,ObligationsProjectionView,RelatedFrame} from '@unai/domain';
import {BeliefLinks} from './BeliefLinks';
import {Beliefs,Completeness,OUTCOME,Pending,People,ResolutionEvidence,Sources} from './Commitments';
import {MemoryPage,Status,dateText} from './MemoryChrome';

/** The design's Obligations screen (journey J4): typed principal, currency and
 * due time; the canonical allocated total and the remaining amount the
 * obligations capability recomputed; advisory coverage labelled advisory; an
 * unallocated remainder shown as unknown; conflicting amounts both shown; and
 * separate obligations with the same people kept separate. */
export interface ObligationsProps{
  state:'loading'|'ready'|'error';
  view:ObligationsProjectionView|null;
  related:Record<string,RelatedFrame>|null;
  error?:string|null;
}

const money=(amount:string|null,currency:string|null)=>amount===null?null:(currency?currency+' ':'')+amount;

function manifestList<T>(row:ObligationProjectionRow,key:string):T[]{
  const value=(row.sourceManifest as Record<string,unknown>)[key];
  return Array.isArray(value)?value as T[]:[];
}

function Row({row,frame}:{row:ObligationProjectionRow;frame:RelatedFrame|undefined}){
  const principal=money(row.principalAmount,row.currency);
  const title=principal?'Obligation of '+principal:'An obligation with no recorded amount';
  const advisory=manifestList<number>(row,'advisoryCoverageIgnored');
  const conflicting=manifestList<{propositionId:string;amount:string;currency:string}>(row,'conflictingAmounts');
  const contested=row.outcomeState==='CONTESTED'||row.conflictFlag;
  return <li className={'obligation'+(contested?' contested':'')}>
    <h3>{title}</h3>
    <p className="statuses">
      <Status kind={OUTCOME[row.outcomeState]}/>
      {contested&&row.outcomeState!=='CONTESTED'&&<> <Status kind="contested" detail="sources disagree"/></>}
      {!row.isComplete&&<> <Status kind="incomplete"/></>}
    </p>
    <dl className="amounts">
      <dt>Principal</dt><dd>{principal??'Unknown'}</dd>
      <dt>Due</dt><dd>{row.dueTime?dateText(row.dueTime):'No due date recorded'}</dd>
      <dt>Allocated so far (canonical total)</dt><dd>{money(row.totalCanonicalAllocation,row.currency)}</dd>
      <dt>Remaining (recomputed by the obligations capability)</dt>
      <dd>{row.remainingAmountCapabilityDerived===null?'Unknown':money(row.remainingAmountCapabilityDerived,row.currency)}</dd>
      <dt>Unallocated payment remainder</dt>
      <dd>{row.unclassifiedRemainder===null?<><Status kind="unknown"/> — no classification is invented for it</>:money(row.unclassifiedRemainder,row.currency)}</dd>
      {advisory.length>0&&<><dt>Coverage stated on a resolution</dt>
        <dd>{advisory.map((coverage,index)=><span key={index}><Status kind="advisory"/> {Math.round(coverage*100)}% — shown as stated; never used to compute the remaining amount. </span>)}</dd></>}
    </dl>
    {conflicting.length>1&&<div className="conflict"><p><Status kind="contested" detail="two sources give different amounts"/></p>
      <ul>{conflicting.map(entry=><li key={entry.propositionId}>{entry.currency} {entry.amount} <BeliefLinks objectType="proposition"
        objectId={entry.propositionId} about={'the amount '+entry.currency+' '+entry.amount}/></li>)}</ul>
      <p>Both amounts are kept. Uai has not chosen between them.</p></div>}
    {row.outcomeState==='RESOLVED'&&<p>Settled by an accepted resolution — no status value was recorded in its place.</p>}
    <People frame={frame}/>
    <Sources frame={frame}/>
    <ResolutionEvidence frame={frame}/>
    <Pending assertions={row.pendingAssertions}/>
    <Beliefs frame={frame} about={title}/>
  </li>;
}

export function Obligations(props:ObligationsProps){
  const rows=props.view?.rows??[];
  return <MemoryPage current="obligations" eyebrow="MEMORY" title="Obligations"
    intro={<p>Money you owe and money owed to you. Each obligation is its own situation, even when the same people are involved; amounts are exact and never converted between currencies.</p>}
    footer="Read from the obligations projection. Remaining amounts are recomputed from recorded payment allocations.">
    {props.state==='loading'&&<p role="status" aria-live="polite" aria-busy="true">Loading obligations…</p>}
    {props.state==='ready'&&props.view&&<>
      <Completeness view={props.view}/>
      <section className="card" aria-labelledby="obligation-list">
        <h2 id="obligation-list">Obligations</h2>
        {props.related===null&&<p role="alert">People, sources and resolution evidence could not be read. The obligations themselves are shown.</p>}
        {rows.length===0?<p>No obligations recorded.</p>
          :<ul className="devices">{rows.map(row=><Row key={row.obligationFrameInstanceId} row={row}
            frame={props.related?.[row.obligationFrameInstanceId]}/>)}</ul>}
      </section>
    </>}
    {props.error&&<p role="alert">{props.error}</p>}
  </MemoryPage>;
}
