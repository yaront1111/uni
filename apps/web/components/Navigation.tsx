import React from 'react';
const navigation=['Decisions','Permissions'];
export type NavigationCurrent='today'|'ask'|'devices'|'sources'|'connectors'|'jobs'|'registry'|'merge-split'|'commitments'|'obligations'
  |'weekly-review'|'memory-inbox'|'approval-rules'|null;
/** `current` is null on a screen reached from another one rather than from the
 * navigation, such as an answer's provenance or the Memory inspector, which is
 * opened from a belief rather than on its own. */
export function Navigation({current}:{current:NavigationCurrent}){
  return <nav aria-label="Main navigation"><a href="/today" aria-current={current==='today'?'page':undefined}>Today</a><a href="/ask" aria-current={current==='ask'?'page':undefined}>Ask</a><a href="/" aria-current={current==='devices'?'page':undefined}>Devices</a><a href="/sources" aria-current={current==='sources'?'page':undefined}>Documents</a><a href="/connectors" aria-current={current==='connectors'?'page':undefined}>Connected sources</a><a href="/commitments" aria-current={current==='commitments'?'page':undefined}>Commitments</a><a href="/obligations" aria-current={current==='obligations'?'page':undefined}>Obligations</a><a href="/ops/jobs" aria-current={current==='jobs'?'page':undefined}>Jobs</a><a href="/ops/registry" aria-current={current==='registry'?'page':undefined}>Registry</a><a href="/memory/merge-split" aria-current={current==='merge-split'?'page':undefined}>Merge and split</a><a href="/weekly-review" aria-current={current==='weekly-review'?'page':undefined}>Weekly Review</a><a href="/memory/inbox" aria-current={current==='memory-inbox'?'page':undefined}>Memory Inbox</a><a href="/memory/approval-rules" aria-current={current==='approval-rules'?'page':undefined}>Learned approval rules</a>{navigation.map(label=><span key={label} aria-disabled="true" title="Available when this feature is delivered">{label}</span>)}</nav>;
}
