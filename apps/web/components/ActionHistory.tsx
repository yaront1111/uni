import React from 'react';
import type {ActionHistoryEntry} from '@unai/domain';
import {Navigation} from './Navigation';

/** The design screen "Action history" (PRD §8.4, §37.8; CRT-UX-13-A).
 *
 * Each entry says exactly one of observed, suggested, drafted, requested
 * approval, executed or received confirmation, in words. Executed and received
 * confirmation name the receipt that established them; a draft only ever reads
 * drafted or requested approval. */
export interface ActionHistoryProps {
  entries: ActionHistoryEntry[];
  error: string | null;
}

const KIND_TEXT: Record<string, string> = {
  DRAFT: 'Draft', EMAIL_SEND: 'Send email', CALENDAR_CREATE: 'Create calendar event',
  CALENDAR_UPDATE: 'Change calendar event', MONEY_MOVEMENT: 'Move money', TRADE: 'Trade', OTHER: 'Recommendation',
};
const SUBJECT_TEXT: Record<string, string> = {recommendation: 'a recommendation', draft: 'a draft', evidence: 'evidence'};

export function ActionHistory(props: ActionHistoryProps) {
  return <div className="shell"><a className="skip" href="#content">Skip to content</a>
    <header><a href="/" className="brand">Uai</a><span>Your personal memory</span></header>
    <Navigation current="actions"/>
    <main id="content" tabIndex={-1}>
      <h1>Action history</h1>
      <p>Every entry carries exactly one label. A proposed, drafted or attempted action is never shown as executed:
        only an authoritative receipt from the tool that acted establishes execution.</p>
      {props.error && <p role="alert">{props.error}</p>}
      {props.entries.length === 0 ? <p>No actions yet.</p>
        : <table><thead><tr><th scope="col">Label</th><th scope="col">Action</th><th scope="col">About</th>
            <th scope="col">When</th><th scope="col">Receipt</th></tr></thead>
          <tbody>{props.entries.map(entry => <tr key={entry.entryId}>
            <th scope="row"><strong>{entry.label}</strong></th>
            <td>{KIND_TEXT[entry.actionKind] ?? entry.actionKind}</td>
            <td>{entry.subject.objectType === 'recommendation'
              ? <a href={'/recommendations/' + entry.subject.objectId}>{SUBJECT_TEXT.recommendation}</a>
              : entry.subject.objectType === 'draft' ? <a href="/actions/drafts">{SUBJECT_TEXT.draft}</a>
                : SUBJECT_TEXT.evidence}</td>
            <td>{entry.createdAt}</td>
            <td>{entry.receiptEvidenceId ? 'Tool receipt ' + entry.receiptEvidenceId : 'None'}</td>
          </tr>)}</tbody></table>}
    </main></div>;
}
