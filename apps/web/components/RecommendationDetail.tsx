import React, {useState} from 'react';
import type {PublicRecommendation} from '@unai/domain';
import {Navigation} from './Navigation';
import {platformWrite, RefusedWrite} from './controlWrite';

/** The design screen "Recommendation detail" (PRD §24.2, §60; CRT-AI-04-A,
 * CRT-SEC-11-A).
 *
 * Evidence, inference and recommendation are three separately labelled parts.
 * The recommendation is RECOMMENDED and never user intent; accepting it records
 * intent to prepare only, with no executed-order fact; a blocked one says why. */
export interface RecommendationDetailProps {
  recommendation: PublicRecommendation | null;
  error: string | null;
}

const ASSESSMENT_TEXT: Record<string, string> = {
  ACCEPTED: 'Accepted memory', PROVISIONAL: 'Provisional memory only', CONTESTED: 'Contested memory',
  NONE: 'No supporting memory',
};
const BLOCKED_TEXT: Record<string, string> = {
  HIGH_RISK_ACTION_ON_UNSETTLED_MEMORY: 'the supporting memory is only provisional, contested or from an incomplete projection',
  PURPOSE_NOT_IN_ALLOWED_PURPOSES: 'the evidence behind it was not given for this purpose',
  UNREGISTERED_PREDICATE_MAY_NOT_AUTHORIZE_HIGH_RISK_ACTION: 'it rests on a fact type the registry does not govern',
};

export function RecommendationDetail(props: RecommendationDetailProps) {
  const [busy, setBusy] = useState(false);
  const [words, setWords] = useState('');
  const [error, setError] = useState(props.error ?? '');
  const recommendation = props.recommendation;
  async function respond(response: 'ACCEPTED_AS_INTENT_TO_PREPARE' | 'DISMISSED') {
    if (!recommendation) return;
    setBusy(true); setError('');
    try {
      const answer = await platformWrite('recommendations/' + recommendation.recommendationId + '/respond', 'action.recommend',
        {response, rawText: words.trim() === '' ? null : words, dataPurpose: 'PERSONAL_ASSISTANCE'});
      if (answer) window.location.reload();
    } catch (caught) {
      setError(caught instanceof RefusedWrite && caught.code === 'RECOMMENDATION_BLOCKED'
        ? 'This recommendation is withheld and cannot be acted on.'
        : 'Your answer could not be recorded. Please retry.');
    } finally {setBusy(false);}
  }
  return <div className="shell"><a className="skip" href="#content">Skip to content</a>
    <header><a href="/" className="brand">Uai</a><span>Your personal memory</span></header>
    <Navigation current={null}/>
    <main id="content" tabIndex={-1}>
      <h1>Recommendation detail</h1>
      {error && <p role="alert">{error}</p>}
      {recommendation === null ? <p>This recommendation could not be shown.</p> : <>
        <section className="card" aria-labelledby="recommendation-heading">
          <p className="eyebrow">RECOMMENDATION (Uai's suggestion, not your intent)</p>
          <h2 id="recommendation-heading">{recommendation.recommendationText}</h2>
          <p>Stored as recommended. It is not something you decided, and not something that happened.</p>
          {recommendation.status === 'BLOCKED' && <p role="alert">Withheld: {BLOCKED_TEXT[recommendation.blockedReason ?? '']
            ?? recommendation.blockedReason}. It can be dismissed but not acted on.</p>}
          {recommendation.requiresConfirmation && recommendation.status === 'ACTIVE' &&
            <p>Needs your confirmation before anything is prepared: the memory behind it is not settled.</p>}
        </section>
        <section className="card" aria-labelledby="evidence-heading">
          <p className="eyebrow">EVIDENCE</p>
          <h2 id="evidence-heading">What it rests on</h2>
          {recommendation.supportingEvidenceIds.length === 0 ? <p>No evidence was available to it.</p>
            : <ul>{recommendation.supportingEvidenceIds.map(id => <li key={id}>Evidence item {id}</li>)}</ul>}
        </section>
        <section className="card" aria-labelledby="inference-heading">
          <p className="eyebrow">INFERENCE</p>
          <h2 id="inference-heading">How sure the memory is</h2>
          <p>{ASSESSMENT_TEXT[recommendation.supportingAssessment]}. Projection {recommendation.projectionComplete
            ? 'complete' : 'incomplete: a pending change has not been applied yet'}.</p>
        </section>
        <section className="card" aria-labelledby="response-heading"><h2 id="response-heading">Your answer</h2>
          {recommendation.userResponse === 'NONE' || recommendation.userResponse === 'SNOOZED' ? <>
            <label htmlFor="response-words">Your words (kept as your statement)</label>
            <input id="response-words" value={words} onChange={event => setWords(event.target.value)}
              placeholder="Yes, prepare it, but do not submit it."/>
            {recommendation.status === 'ACTIVE' && <button type="button" disabled={busy || words.trim() === ''}
              onClick={() => respond('ACCEPTED_AS_INTENT_TO_PREPARE')}>Prepare it, do not submit</button>}
            <button type="button" disabled={busy} onClick={() => respond('DISMISSED')}>Dismiss</button>
          </> : recommendation.userResponse === 'ACCEPTED_AS_INTENT_TO_PREPARE'
            ? <p role="status">Accepted as an intent to prepare only. Nothing was submitted, and no executed-order fact
                exists{recommendation.executionReceipted ? ' other than the one an authoritative tool receipt established.' : '.'}</p>
            : <p role="status">Dismissed.</p>}
          {recommendation.executionReceipted && <p>An authoritative tool receipt has since been ingested: see the
            {' '}<a href="/actions">action history</a>.</p>}
        </section>
      </>}
    </main></div>;
}
