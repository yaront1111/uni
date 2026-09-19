import React, {useState} from 'react';
import type {PublicDraft} from '@unai/domain';
import {Navigation} from './Navigation';
import {platformWrite, RefusedWrite} from './controlWrite';

/** The design screen "Draft approval" (PRD §8.4, §27.5; CRT-CON-08-A).
 *
 * A draft is a Uai artifact awaiting the owner's explicit approval, never an
 * external action. Every drawn refusal -- capability not granted, the action
 * policy denied it, and each external write V0 refuses -- has its own sentence,
 * and the receipt state says what establishes an execution. */
export interface DraftApprovalProps {
  drafts: PublicDraft[];
  /** A refusal the API named, shown with its reason. */
  refusal: {code: string; reason: string | null; actionKind: string | null} | null;
  /** An authoritative tool receipt the history holds for one of these actions. */
  receiptIngested: {receiptEvidenceId: string; actionKind: string} | null;
  error: string | null;
}

const ACTION_TEXT: Record<string, string> = {
  EMAIL_SEND: 'Email send is refused in V0. Uai prepares drafts; it never sends.',
  CALENDAR_CREATE: 'Calendar create is refused in V0. Uai never writes to your calendar.',
  CALENDAR_UPDATE: 'Calendar update is refused in V0. Uai never writes to your calendar.',
  MONEY_MOVEMENT: 'Money movement is refused in V0. Uai never moves money.',
  TRADE: 'Trading is refused in V0. Uai never submits an order.',
};
function refusalText(refusal: NonNullable<DraftApprovalProps['refusal']>): string {
  if (refusal.code === 'DRAFT_CAPABILITY_NOT_GRANTED') {
    return 'Draft creation was refused: the draft capability is not granted. Grant it on the Permissions page.';
  }
  if (refusal.code === 'DRAFT_POLICY_DENIED') {
    return 'Draft creation was refused by the action policy (EvaluateMemoryAction): ' + (refusal.reason ?? 'denied') + '.';
  }
  if (refusal.code === 'DRAFT_CONFIRMATION_REQUIRED') {
    return 'The memory behind this draft is not settled, so it needs your confirmation first: ' + (refusal.reason ?? '') + '.';
  }
  if (refusal.code === 'EXTERNAL_ACTION_REFUSED' && refusal.actionKind) return ACTION_TEXT[refusal.actionKind] ?? 'That action is refused in V0.';
  return 'The request was refused. Nothing was changed.';
}
const STATUS_TEXT: Record<string, string> = {
  CREATED: 'Draft created. Not yet sent for approval.',
  AWAITING_APPROVAL: 'Awaiting your explicit approval. Stored as a draft artifact, not an external action.',
  APPROVED: 'Approved by you. Still a draft: Uai V0 sends nothing.',
  DISCARDED: 'Discarded.',
};

export function DraftApproval(props: DraftApprovalProps) {
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState(props.refusal);
  const [error, setError] = useState(props.error ?? '');
  async function act(path: string, purpose: string, body: unknown) {
    setBusy(true); setError(''); setRefusal(null);
    try {
      if (await platformWrite(path, purpose, body)) window.location.reload();
    } catch (caught) {
      if (caught instanceof RefusedWrite) {
        setRefusal({code: caught.code, reason: typeof caught.body['reason'] === 'string' ? caught.body['reason'] : null,
          actionKind: typeof caught.body['actionKind'] === 'string' ? caught.body['actionKind'] : null});
      } else setError('The request could not be completed. Please retry.');
    } finally {setBusy(false);}
  }
  return <div className="shell"><a className="skip" href="#content">Skip to content</a>
    <header><a href="/" className="brand">Uai</a><span>Your personal memory</span></header>
    <Navigation current="drafts"/>
    <main id="content" tabIndex={-1}>
      <h1>Draft approval</h1>
      <p>Drafts are prepared inside Uai for you to review. A draft is never recorded as an external action, and in V0
        nothing is sent, scheduled, paid or traded.</p>
      {error && <p role="alert">{error}</p>}
      {refusal && <p role="alert">{refusalText(refusal)}</p>}
      {props.receiptIngested && <p role="status">An authoritative receipt from the tool was ingested as evidence
        ({props.receiptIngested.receiptEvidenceId}): only that receipt establishes that the
        {' '}{props.receiptIngested.actionKind} actually happened.</p>}
      {props.drafts.length === 0 ? <p>No drafts.</p> : <ul className="devices">{props.drafts.map(draft => <li key={draft.draftId}>
        <div>
          <h2>{draft.content.subject ?? (draft.draftKind === 'EMAIL' ? 'Email draft' : 'Calendar event draft')}</h2>
          {draft.recommendationId && <p>Proposed from <a href={'/recommendations/' + draft.recommendationId}>a recommendation</a>.</p>}
          <p>{draft.content.body}</p>
          <p>Status: {STATUS_TEXT[draft.status] ?? draft.status}</p>
          <p className="muted">Created under capability {draft.capabilityId}, allowed by action policy decision {draft.policyDecisionId}.</p>
        </div>
        <div className="actions">
          {draft.status === 'CREATED' && <button type="button" disabled={busy}
            onClick={() => act('drafts/' + draft.draftId + '/decision', 'action.draft', {decision: 'REQUEST_APPROVAL'})}>Ask for my approval</button>}
          {draft.status === 'AWAITING_APPROVAL' && <button type="button" disabled={busy}
            onClick={() => act('drafts/' + draft.draftId + '/decision', 'action.draft', {decision: 'APPROVE'})}>Approve draft</button>}
          {(draft.status === 'CREATED' || draft.status === 'AWAITING_APPROVAL') && <button type="button" disabled={busy}
            onClick={() => act('drafts/' + draft.draftId + '/decision', 'action.draft', {decision: 'DISCARD'})}>Discard</button>}
          {draft.status === 'APPROVED' && <button type="button" disabled={busy}
            onClick={() => act('actions/execute', 'action.execute', {actionKind: draft.draftKind === 'EMAIL' ? 'EMAIL_SEND' : 'CALENDAR_CREATE',
              subjectRef: {objectType: 'draft', objectId: draft.draftId}, purpose: 'PERSONAL_ASSISTANCE', actionRisk: 'MEDIUM'})}>
            {draft.draftKind === 'EMAIL' ? 'Send email' : 'Create calendar event'}</button>}
        </div>
      </li>)}</ul>}
    </main></div>;
}
