import React, {useState} from 'react';
import type {PermissionsView} from '@unai/domain';
import {Navigation} from './Navigation';
import {platformWrite, RefusedWrite} from './controlWrite';

/** The design screen "Permissions and integrations" (PRD §7.8; CRT-UX-09-A).
 *
 * Every drawn state is reachable from props alone: connected sources with their
 * read and write scopes, the domain sensitivity mapping, the plugin capability
 * list, the attention budget editor, the retention settings, and the "saved and
 * taking effect on subsequent operations" confirmation. Status is words, never
 * colour alone. */
export interface PermissionsProps {
  embedded?:boolean;
  view: PermissionsView | null;
  /** Which setting the last save changed, for the confirmation state. */
  saved: 'SOURCES' | 'SENSITIVITY' | 'PLUGIN_CAPABILITIES' | 'ATTENTION_BUDGET' | 'RETENTION' | null;
  error: string | null;
}

const SAVED_TEXT: Record<NonNullable<PermissionsProps['saved']>, string> = {
  SOURCES: 'Connected source scopes',
  SENSITIVITY: 'Domain sensitivity',
  PLUGIN_CAPABILITIES: 'Plugin capabilities',
  ATTENTION_BUDGET: 'Attention budget',
  RETENTION: 'Data retention',
};
const REFUSAL_TEXT: Record<string, string> = {
  PLUGIN_CAPABILITY_WRITE_REFUSED: 'That capability is an external write. Uai V0 refuses it, so nothing was changed.',
  REVIEW_INPUT_INVALID: 'Those attention budget values are not allowed. Nothing was changed.',
  CONTROL_REQUEST_INVALID: 'That value is not allowed. Nothing was changed.',
};
const SENSITIVITIES = ['NORMAL', 'PRIVATE', 'RESTRICTED'] as const;

export function Permissions(props: PermissionsProps) {
  const Frame=props.embedded?'section':'main';
  const Heading=props.embedded?'h2':'h1';
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(props.error ?? '');
  async function save(saved: NonNullable<PermissionsProps['saved']>, path: string, purpose: string, body: unknown,
    method: 'POST' | 'PATCH') {
    setBusy(true); setError('');
    try {
      const answer = await platformWrite(path, purpose, body, method);
      if (answer) window.location.assign((props.embedded?'/admin/configuration':'/permissions')+'?saved=' + saved);
    } catch (caught) {
      setError(caught instanceof RefusedWrite
        ? REFUSAL_TEXT[caught.code] ?? 'The change was refused. Nothing was changed.'
        : 'The change could not be saved. Please retry.');
    } finally {setBusy(false);}
  }
  const view = props.view;
  return <div className={props.embedded?undefined:'shell'}>{!props.embedded&&<><a className="skip" href="#content">Skip to content</a>
    <header><a href="/" className="brand">Uai</a><span>Your personal memory</span></header>
    <Navigation current="permissions"/></>}
    <Frame id={props.embedded?'configuration-permissions':'content'} tabIndex={-1}>
      <Heading>Permissions and integrations</Heading>
      {error && <p role="alert">{error}</p>}
      {props.saved && <p role="status" aria-live="polite">
        {SAVED_TEXT[props.saved]} saved. The change takes effect on the next operation that uses it; nothing already
        stored was rewritten.</p>}
      {view === null ? <p>Permissions could not be shown.</p> : <>
        <section className="card" aria-labelledby="sources-heading"><h2 id="sources-heading">Connected sources</h2>
          {view.connectedSources.length === 0 ? <p>No sources connected.</p>
            : <table><thead><tr><th scope="col">Source</th><th scope="col">Status</th><th scope="col">Read scopes</th>
                <th scope="col">Write scopes</th></tr></thead>
              <tbody>{view.connectedSources.map(source => <tr key={source.connectorId}>
                <th scope="row">{source.displayName}</th><td>{source.status}</td>
                <td>{source.readScopes.length === 0 ? 'None' : source.readScopes.join(', ')}</td>
                <td>None. Uai V0 is read-only.</td>
              </tr>)}</tbody></table>}
          <p><a href="/connectors">Change connected sources and their scopes</a></p>
        </section>

        <section className="card" aria-labelledby="sensitivity-heading"><h2 id="sensitivity-heading">Domain sensitivity</h2>
          <p>The level each source stores new items at: NORMAL, PRIVATE or RESTRICTED. A change applies to items stored
            after it.</p>
          <ul>{view.domainSensitivity.map(entry => <li key={entry.sourceType}>
            <label htmlFor={'sensitivity-' + entry.sourceType}>{entry.sourceType} (default {entry.defaultSensitivity})</label>
            <select id={'sensitivity-' + entry.sourceType} disabled={busy} defaultValue={entry.effectiveSensitivity}
              onChange={event => save('SENSITIVITY', 'settings/domain-sensitivity', 'permissions.manage',
                {mappings: [{sourceType: entry.sourceType, sensitivity: event.target.value}]}, 'PATCH')}>
              {SENSITIVITIES.map(level => <option key={level} value={level}>{level}</option>)}
            </select>
            <p>Stored at: {entry.effectiveSensitivity}{entry.ownerSetting ? ' (your setting)' : ' (default)'}</p>
          </li>)}</ul>
        </section>

        <section className="card" aria-labelledby="plugins-heading"><h2 id="plugins-heading">Plugin capabilities</h2>
          <p>Each capability has its own permission and risk class. Granting one never grants another.</p>
          <ul>{view.pluginCapabilities.map(capability => <li key={capability.capabilityId}>
            <h3>{capability.capabilityId}</h3>
            <p>{capability.description}</p>
            <p>Risk classification: {capability.riskClass}. {capability.access === 'DRAFT'
              ? 'Prepares a draft inside Uai only.' : 'External write: refused in V0.'}</p>
            <p id={'plugin-' + capability.capabilityId}>
              {capability.granted ? 'Granted' : capability.revokedAt ? 'Revoked' : 'Not granted'}</p>
            {capability.grantable
              ? <button type="button" disabled={busy} aria-describedby={'plugin-' + capability.capabilityId}
                  aria-pressed={capability.granted}
                  onClick={() => save('PLUGIN_CAPABILITIES', 'plugin-capabilities', 'permissions.manage',
                    {capabilities: [{capabilityId: capability.capabilityId, granted: !capability.granted}]}, 'POST')}>
                  {capability.granted ? 'Withhold ' + capability.capabilityId : 'Grant ' + capability.capabilityId}
                </button>
              : <p>Cannot be granted in V0.</p>}
          </li>)}</ul>
        </section>

        <AttentionBudgetEditor view={view} busy={busy} onSave={body =>
          save('ATTENTION_BUDGET', 'settings/attention-budgets', 'settings.attention', body, 'PATCH')}/>

        <RetentionEditor view={view} busy={busy} onSave={body =>
          save('RETENTION', 'settings/retention', 'permissions.manage', body, 'PATCH')}/>

        <section className="card" aria-labelledby="data-heading"><h2 id="data-heading">Export and deletion</h2>
          <p><a href="/data">Export or delete my data</a></p>
          {view.dataRequests.length === 0 ? <p>No export or deletion has been requested.</p>
            : <ul>{view.dataRequests.map(request => <li key={request.requestId}>
                {request.requestKind === 'EXPORT' ? 'Export' : request.requestKind === 'DELETE' ? 'Deletion' : request.requestKind}
                {' '}({request.trigger === 'RETENTION_POLICY' ? 'retention rule' : 'your request'}): {request.status}
                {' on '}{request.requestedAt}</li>)}</ul>}
        </section>
      </>}
    </Frame></div>;
}

function AttentionBudgetEditor(props: {view: PermissionsView; busy: boolean; onSave(body: Record<string, number>): void}) {
  const budget = props.view.attentionBudget;
  const [day, setDay] = useState(budget.maxCardsPerDay);
  const [scope, setScope] = useState(budget.maxCardsPerSensitivityScopePerDay);
  const [repeat, setRepeat] = useState(budget.repeatQuestionSuppressionDays);
  return <section className="card" aria-labelledby="budget-heading"><h2 id="budget-heading">Attention budget</h2>
    <p>{budget.isDefault ? 'Using the defaults: at most 3 cards a day and 1 per sensitivity scope.'
      : 'Your saved budget.'} Cards beyond the budget wait for batch review.</p>
    <form onSubmit={event => {event.preventDefault();
      props.onSave({maxCardsPerDay: day, maxCardsPerSensitivityScopePerDay: scope, repeatQuestionSuppressionDays: repeat});}}>
      <label htmlFor="budget-day">Most clarification cards per day</label>
      <input id="budget-day" type="number" min={0} max={50} value={day} onChange={event => setDay(Number(event.target.value))}/>
      <label htmlFor="budget-scope">Most cards per sensitivity scope per day</label>
      <input id="budget-scope" type="number" min={0} max={50} value={scope} onChange={event => setScope(Number(event.target.value))}/>
      <label htmlFor="budget-repeat">Days before the same question may be asked again</label>
      <input id="budget-repeat" type="number" min={1} max={365} value={repeat} onChange={event => setRepeat(Number(event.target.value))}/>
      <button type="submit" disabled={props.busy}>Save attention budget</button>
    </form>
  </section>;
}

function RetentionEditor(props: {view: PermissionsView; busy: boolean; onSave(body: unknown): void}) {
  const [sourceType, setSourceType] = useState('GMAIL');
  const [raw, setRaw] = useState('');
  const [derived, setDerived] = useState('');
  const days = (value: string) => value.trim() === '' ? null : Number(value);
  return <section className="card" aria-labelledby="retention-heading"><h2 id="retention-heading">Data retention</h2>
    {props.view.retention.length === 0 ? <p>Everything is kept until you delete it.</p>
      : <table><thead><tr><th scope="col">Source type</th><th scope="col">Raw evidence kept for</th>
          <th scope="col">Derived data kept for</th></tr></thead>
        <tbody>{props.view.retention.map(rule => <tr key={rule.sourceType}><th scope="row">{rule.sourceType}</th>
          <td>{rule.rawRetentionDays === null ? 'Until deleted' : rule.rawRetentionDays + ' days'}</td>
          <td>{rule.derivedRetentionDays === null ? 'Until deleted' : rule.derivedRetentionDays + ' days'}</td></tr>)}</tbody></table>}
    <form onSubmit={event => {event.preventDefault();
      props.onSave({rules: [{sourceType, rawRetentionDays: days(raw), derivedRetentionDays: days(derived)}]});}}>
      <label htmlFor="retention-source">Source type</label>
      <select id="retention-source" value={sourceType} onChange={event => setSourceType(event.target.value)}>
        {['CONVERSATION', 'GMAIL', 'GOOGLE_CALENDAR', 'GITHUB', 'DOCUMENT'].map(type => <option key={type} value={type}>{type}</option>)}
      </select>
      <label htmlFor="retention-raw">Keep raw evidence for (days, empty keeps it)</label>
      <input id="retention-raw" inputMode="numeric" value={raw} onChange={event => setRaw(event.target.value)}/>
      <label htmlFor="retention-derived">Keep derived index data for (days, empty keeps it)</label>
      <input id="retention-derived" inputMode="numeric" value={derived} onChange={event => setDerived(event.target.value)}/>
      <button type="submit" disabled={props.busy}>Save retention</button>
    </form>
    <p>The next cleanup applies the saved rules through the same deletion cascade as a deletion you request.</p>
  </section>;
}
