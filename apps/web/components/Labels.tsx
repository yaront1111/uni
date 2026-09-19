import React from 'react';
import type {AskStatement,MemoryLabel} from '@unai/domain';

/**
 * The uncertainty label system (design "uncertainty label system distinguishable
 * without colour"; PRD §24.5; CRT-UX-12-A).
 *
 * Every label carries three cues, none of them colour: its own words, its own
 * glyph and its own border pattern. The stylesheet draws them in black, grey and
 * white only, so a grayscale rendering is the same rendering and nothing is lost
 * in it. The glyph is decorative (`aria-hidden`); the words are what a screen
 * reader announces, and the description says what the label promises.
 */
export interface LabelStyle{text:string;glyph:string;pattern:string;description:string}

export const MEMORY_LABELS:Readonly<Record<MemoryLabel,LabelStyle>>=Object.freeze({
  CONFIRMED:{text:'Confirmed',glyph:'✓',pattern:'solid',description:'Accepted, and stated by you or an authoritative source.'},
  REPORTED:{text:'Reported',glyph:'❝',pattern:'dashed',description:'Someone said so; it is not independently confirmed.'},
  INFERRED:{text:'Inferred',glyph:'∴',pattern:'dotted',description:'Worked out from other memory, not stated by anyone.'},
  CONTESTED:{text:'Contested',glyph:'≠',pattern:'double',description:'Sources disagree and neither value is settled.'},
  PENDING_OWNER_ASSERTION:{text:'Your statement, pending',glyph:'⧗',pattern:'groove',description:'What you said, not yet verified or attached to memory.'},
  SCHEDULED:{text:'Scheduled',glyph:'◷',pattern:'ridge',description:'Planned for a time; nothing says it has happened.'},
  RESOLVED:{text:'Resolved',glyph:'■',pattern:'inset',description:'An accepted resolution records the outcome.'},
  UNKNOWN:{text:'Unknown',glyph:'?',pattern:'outset',description:'Memory does not say.'},
  INTENDED:{text:'Intended',glyph:'→',pattern:'solid-thin',description:'Meant to be done; not done yet.'},
  COMMITTED:{text:'Committed',glyph:'✎',pattern:'dashed-thin',description:'Promised; not yet fulfilled.'},
  PREDICTED:{text:'Predicted',glyph:'≈',pattern:'dotted-thin',description:'Expected; not yet known to have happened.'},
  RECOMMENDED:{text:'Recommended',glyph:'☆',pattern:'double-thin',description:'A suggestion, not a decision and not something done.'},
});

/** The label an Ask statement is shown with. The Ask vocabulary says CONFLICTING
 * where the reader sees CONTESTED; the owner's own pending word and a recorded
 * outcome are told apart by the statement's kind rather than folded into
 * "reported" or "confirmed". */
export function displayLabelOf(statement:Pick<AskStatement,'label'|'kind'>):MemoryLabel{
  if(statement.kind==='OWNER_ASSERTION_PENDING')return 'PENDING_OWNER_ASSERTION';
  if(statement.kind==='RESOLUTION'&&statement.label==='CONFIRMED')return 'RESOLVED';
  if(statement.label==='CONFLICTING')return 'CONTESTED';
  return statement.label;
}

export function CertaintyBadge({label}:{label:MemoryLabel}){
  const style=MEMORY_LABELS[label];
  return <span className={'label label-'+style.pattern} data-label={label} title={style.description}>
    <span className="glyph" aria-hidden="true">{style.glyph}</span> {style.text}
  </span>;
}

/** The key to the labels, shown once per screen so a reader never has to guess
 * what a glyph means. */
export function LabelKey({labels}:{labels:readonly MemoryLabel[]}){
  return <details className="label-key">
    <summary>What the labels mean</summary>
    <dl>{labels.map(label=><React.Fragment key={label}><dt><CertaintyBadge label={label}/></dt><dd>{MEMORY_LABELS[label].description}</dd></React.Fragment>)}</dl>
  </details>;
}

const UUID=/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
/** Technical identifiers belong in the advanced inspector only. A value that
 * happens to carry one (an entity reference, say) is shown without it. */
export function withoutIdentifiers(text:string):string{return text.replace(UUID,'(see the advanced inspector)');}
