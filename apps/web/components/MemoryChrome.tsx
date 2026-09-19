import React,{type ReactNode} from 'react';
import {Navigation,type NavigationCurrent} from './Navigation';

/** The page frame the memory screens share: skip link, landmarks, navigation. */
export function MemoryPage({current,eyebrow,title,intro,footer,children}:{current:NavigationCurrent;eyebrow:string;title:string;
  intro?:ReactNode;footer:string;children:ReactNode}){
  return <div className="shell">
    <a className="skip" href="#content">Skip to content</a>
    <header><a href="/" className="brand">Uai</a><span>Your personal memory</span></header>
    <Navigation current={current}/>
    <main id="content" tabIndex={-1}>
      <p className="eyebrow">{eyebrow}</p>
      <h1>{title}</h1>
      {intro}
      {children}
    </main>
    <footer>{footer}</footer>
  </div>;
}

/**
 * Every status a memory screen shows, as a word and a symbol. None of them is
 * carried by colour, so they stay distinguishable in grayscale and are read out
 * by a screen reader (design accessibility rule). The symbol is decorative.
 */
export type StatusKind='open'|'overdue'|'due-soon'|'resolved'|'partially-resolved'|'contested'|'pending-owner'|
  'incomplete'|'complete'|'confirmed'|'provisional'|'rejected'|'unsupported'|'suppressed'|'superseded'|'advisory'|'unknown'|
  'withheld'|'scheduled';
const STATUS:Record<StatusKind,[string,string]>={
  open:['○','Open'],overdue:['⚠','Overdue'],'due-soon':['◷','Due soon'],resolved:['✓','Resolved'],
  'partially-resolved':['◐','Partially resolved'],contested:['⇄','Contested'],'pending-owner':['✎','Pending your assertion'],
  incomplete:['…','Incomplete'],complete:['■','Complete'],confirmed:['✓','Confirmed'],provisional:['?','Provisional'],
  rejected:['✕','Rejected'],unsupported:['⊘','Unsupported'],suppressed:['⊖','Suppressed'],superseded:['↷','Superseded'],
  advisory:['ⓘ','Advisory only'],unknown:['?','Unknown'],withheld:['▯','Withheld'],scheduled:['◷','Scheduled'],
};
export function Status({kind,detail}:{kind:StatusKind;detail?:string}){
  const [symbol,label]=STATUS[kind];
  return <span className={'status status-'+kind}><span aria-hidden="true">{symbol} </span>{label}{detail?<>: {detail}</>:null}</span>;
}

/** The assessment status of a belief, as its label. */
export function assessmentStatus(status:string|null|undefined):StatusKind{
  switch(status){
    case 'ACCEPTED':return 'confirmed';
    case 'CONTESTED':return 'contested';
    case 'REJECTED':return 'rejected';
    case 'UNSUPPORTED':return 'unsupported';
    case 'SUPPRESSED':return 'suppressed';
    case 'SUPERSEDED':return 'superseded';
    case 'CANDIDATE':case 'PROVISIONAL':return 'provisional';
    default:return 'unknown';
  }
}

/** An accepted outcome as its label: a partial outcome never reads as resolved. */
export function outcomeStatus(outcomeCode:string|null):StatusKind{
  return outcomeCode==='PARTIALLY_FULFILLED'||outcomeCode==='PARTIALLY_CONFIRMED'?'partially-resolved':'resolved';
}

/** A stored value as words: an amount with its currency, a time, a text. Never
 * an invented reading: anything else is shown as it is stored. */
export function valueText(value:unknown):string{
  if(value===null||value===undefined)return 'No value recorded';
  if(typeof value==='string')return value;
  if(typeof value==='number'||typeof value==='boolean')return String(value);
  if(typeof value==='object'){
    const record=value as Record<string,unknown>;
    if(typeof record.amount==='string'&&typeof record.currency==='string')return record.currency+' '+record.amount;
    for(const key of ['text','description','value','label'])if(typeof record[key]==='string')return record[key] as string;
    if(typeof record.time==='string')return dateText(record.time);
    if(typeof record.start==='string'||typeof record.end==='string'){
      return (typeof record.start==='string'?dateText(record.start):'…')+' to '+(typeof record.end==='string'?dateText(record.end):'…');
    }
  }
  return JSON.stringify(value);
}

/** A time in a fixed, locale-independent form, so a server render and a test
 * read the same words. */
export function dateText(iso:string|null):string{
  if(!iso)return 'no time recorded';
  const date=new Date(iso);
  return Number.isNaN(date.getTime())?iso:date.toISOString().slice(0,16).replace('T',' ')+' UTC';
}

/** The last segment of a registry id, spaced: `shared.commitment.due_time` reads "due time". */
export function predicateText(predicateId:string):string{
  return (predicateId.split('.').pop()??predicateId).replaceAll('_',' ');
}

export const SOURCE_TYPES:Record<string,string>={CONVERSATION:'Conversation',GMAIL_THREAD:'Email thread',GOOGLE_CALENDAR_EVENT:'Calendar event',
  GITHUB_ISSUE_THREAD:'GitHub thread',UPLOADED_DOCUMENT:'Document',ASSISTANT_CONVERSATION:'Assistant answer'};
export function sourceText(sourceType:string){return SOURCE_TYPES[sourceType]??sourceType.toLowerCase().replaceAll('_',' ');}
