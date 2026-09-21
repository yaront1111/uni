import React,{useState} from 'react';
import type {MemoryInspector as Inspection,MergeSplitReview,RelatedFrame} from '@unai/domain';
import {Shell} from './Shell';
import {MemoryInspector} from './MemoryInspector';
import {CorrectionControls} from './CorrectionControls';
import {MergeSplit} from './MergeSplit';
import {Status,assessmentStatus,predicateText} from './MemoryChrome';
import {filterMemoryFrames,type MemoryFilters} from '../lib/admin-memory-filter';
import {ProposalInbox} from './ProposalInbox';
import type {PendingProposal} from '../lib/memory-proposals';

export interface AdminMemoryProps{frames:RelatedFrame[];errors:string[];inspector:Inspection|null;review:MergeSplitReview|null;proposals?:PendingProposal[];proposalsAtLimit?:boolean;filters?:MemoryFilters}
export function AdminMemory(props:AdminMemoryProps){
  const [filters,setFilters]=useState<MemoryFilters>(props.filters??{});
  const update=(key:keyof MemoryFilters,value:string)=>setFilters(previous=>({...previous,[key]:value}));
  const people=new Map(props.frames.flatMap(frame=>frame.people.map(person=>[person.entityId,person.canonicalLabel??'Unnamed person'] as const)));
  const topics=new Map(props.frames.flatMap(frame=>frame.threads.map(thread=>[thread.memoryThreadId,thread.displayTitle??'Untitled topic'] as const)));
  const results=filterMemoryFrames(props.frames,filters);
  return <Shell current={null} eyebrow="ADMIN" title="Memory">
    <nav aria-label="Memory sections"><a href="#memory-search">Search and browse</a>{' · '}<a href="#memory-proposals">Proposal inbox</a>{' · '}<a href="/admin/memory?review=merge-split">Merge and split review</a></nav>
    {props.errors.map(error=><p key={error} role="alert">{error}</p>)}
    <section id="memory-search" aria-labelledby="memory-search-heading"><h2 id="memory-search-heading">Search and browse</h2>
      <p>Search readable memory and browse by person, topic, source date or kind. Results are bounded; refine your search to locate older items.</p>
      <form method="get" action="/admin/memory">
      <label htmlFor="memory-query">Search</label><input name="q" id="memory-query" type="search" value={filters.q??''} onChange={e=>update('q',e.target.value)}/>
      <label htmlFor="memory-person">Person</label><select name="person" id="memory-person" value={filters.person??''} onChange={e=>update('person',e.target.value)}><option value="">All people</option>{[...people].map(([id,name])=><option key={id} value={id}>{name}</option>)}</select>
      <label htmlFor="memory-topic">Topic</label><select name="topic" id="memory-topic" value={filters.topic??''} onChange={e=>update('topic',e.target.value)}><option value="">All topics</option>{[...topics].map(([id,name])=><option key={id} value={id}>{name}</option>)}</select>
      <label htmlFor="memory-from">From (source date)</label><input name="from" id="memory-from" type="date" value={filters.from??''} onChange={e=>update('from',e.target.value)}/>
      <label htmlFor="memory-to">To (source date, inclusive)</label><input name="to" id="memory-to" type="date" value={filters.to??''} onChange={e=>update('to',e.target.value)}/>
      <label htmlFor="memory-kind">Kind</label><select name="kind" id="memory-kind" value={filters.kind??''} onChange={e=>update('kind',e.target.value)}><option value="">All available kinds</option>{[...new Set(props.frames.map(frame=>frame.frameTypeId))].map(kind=><option key={kind} value={kind}>{predicateText(kind)}</option>)}</select>
      <button type="submit">Search memory</button></form>
      <p role="status">{results.length} situations match.</p>
      <ul>{results.map(frame=><li key={frame.frameInstanceId}>{predicateText(frame.frameTypeId)} — {frame.people.map(person=>person.canonicalLabel??'Unnamed person').join(', ')}
        <ul>{frame.beliefs.map(belief=><li key={belief.propositionId}><a href={'/admin/memory?type=proposition&id='+belief.propositionId}>{predicateText(belief.predicateId)}</a>{' '}<Status kind={assessmentStatus(belief.assessmentStatus)}/></li>)}</ul>
      </li>)}</ul>
    </section>
    {props.inspector&&<><MemoryInspector embedded state="ready" inspector={props.inspector}/><CorrectionControls key={props.inspector.subject.requestedId} embedded state="ready" inspector={props.inspector}/></>}
    {props.review&&<MergeSplit embedded review={props.review}/>}
    {props.proposals?<ProposalInbox proposals={props.proposals} atLimit={props.proposalsAtLimit}/>:<p role="alert">Proposal inbox is unavailable. Reload to retry.</p>}
  </Shell>;
}
