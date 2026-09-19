import React from 'react';
const navigation=['Today','Ask','Commitments','Decisions','Weekly Review','Memory Inspector','Memory Inbox','Permissions'];
/** `current` is null on a screen reached from another one rather than from the
 * navigation, such as an answer's provenance. */
export function Navigation({current}:{current:'devices'|'sources'|'jobs'|'registry'|null}){
  return <nav aria-label="Main navigation"><a href="/" aria-current={current==='devices'?'page':undefined}>Devices</a><a href="/sources" aria-current={current==='sources'?'page':undefined}>Documents</a><a href="/ops/jobs" aria-current={current==='jobs'?'page':undefined}>Jobs</a><a href="/ops/registry" aria-current={current==='registry'?'page':undefined}>Registry</a>{navigation.map(label=><span key={label} aria-disabled="true" title="Available when this feature is delivered">{label}</span>)}</nav>;
}
