import React from 'react';
const navigation=['Today','Ask','Commitments','Decisions','Weekly Review','Memory Inspector','Memory Inbox','Permissions'];
export function Navigation({current}:{current:'devices'|'sources'}){
  return <nav aria-label="Main navigation"><a href="/" aria-current={current==='devices'?'page':undefined}>Devices</a><a href="/sources" aria-current={current==='sources'?'page':undefined}>Documents</a>{navigation.map(label=><span key={label} aria-disabled="true" title="Available when this feature is delivered">{label}</span>)}</nav>;
}
