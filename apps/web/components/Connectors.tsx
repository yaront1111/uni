import React, {useState} from 'react';
import type {PublicConnector, PublicCapabilityGrant, SyncResult} from '@unai/domain';
import {Navigation} from './Navigation';

/** The design screens "Connected sources" and "Grant connector capabilities".
 *
 * Every drawn state is reachable from props alone, because the component tests
 * render static markup and never run an effect. Status is always words: a
 * revoked token, a failed sync and a disconnected source each say what happened
 * in text, never in colour alone. */
export interface ConnectorsProps {
  connectors: PublicConnector[];
  /** The source whose capability grants are being edited, if any. */
  selected: PublicConnector | null;
  /** The result of the most recent sync, so the screen can show that the second
   * run resumed from the stored cursor and discarded the redelivered items. */
  lastSync: SyncResult | null;
  state: 'IDLE' | 'SYNCING' | 'DISCONNECTING';
  /** A refusal the API named, shown with its reason rather than as a generic
   * failure: a request needing a write scope is the drawn case. */
  refusal: {code: string; capabilityId: string | null} | null;
  error: string | null;
}

const STATUS_TEXT: Record<string, string> = {
  PENDING_AUTHORIZATION: 'Awaiting your consent. No data has been read.',
  ACTIVE: 'Connected.',
  SYNC_FAILED: 'Sync failed.',
  TOKEN_REVOKED: 'Access was revoked at the provider. Reauthorization required.',
  DISCONNECTED: 'Disconnected: tokens revoked and ingestion stopped.',
};
const REFUSAL_TEXT: Record<string, string> = {
  CONNECTOR_WRITE_SCOPE_REFUSED: 'That capability needs a write scope. Uai V0 is read-only and refused it.',
  CONNECTOR_CAPABILITY_NOT_GRANTED: 'That capability has not been granted, so the operation was refused.',
  CONNECTOR_INGESTION_STOPPED: 'This source is disconnected or revoked, so nothing was ingested.',
  CONNECTOR_ALREADY_CONNECTED: 'That account is already connected to this owner scope.',
};

export function Connectors(props: ConnectorsProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(props.error ?? '');
  async function post(path: string, body: Record<string, unknown>, purpose: string) {
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/platform/' + path, {
        method: 'POST',
        headers: {'content-type': 'application/json', 'x-purpose': purpose,
          'x-correlation-id': crypto.randomUUID(), 'idempotency-key': crypto.randomUUID()},
        body: JSON.stringify(body),
      });
      if (response.status === 401) {window.location.assign('/signin?reason=expired'); return;}
      if (!response.ok) {
        const answer = await response.json().catch(() => ({code: 'REQUEST_REFUSED'}));
        throw new Error(REFUSAL_TEXT[answer.code as string] ?? 'The request was refused. Nothing was changed.');
      }
      window.location.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The request could not be completed.');
    } finally {setBusy(false);}
  }
  const disabled = busy || props.state !== 'IDLE';
  return <div className="shell"><a className="skip" href="#content">Skip to content</a>
    <header><a href="/" className="brand">Uai</a><span>Your personal memory</span></header>
    <Navigation current="connectors"/>
    <main id="content" tabIndex={-1}>
      <h1>Connected sources</h1>
      {error && <p role="alert">{error}</p>}
      {props.refusal && <p role="alert">
        {REFUSAL_TEXT[props.refusal.code] ?? 'The request was refused.'}
        {props.refusal.capabilityId ? ' Capability: ' + props.refusal.capabilityId + '.' : ''}
      </p>}
      {props.state === 'SYNCING' && <p role="status" aria-live="polite">Initial sync running. Reading only what you granted.</p>}
      {props.state === 'DISCONNECTING' && <p role="status" aria-live="polite">Disconnecting and revoking tokens.</p>}

      {props.connectors.length === 0
        ? <section className="card"><h2>No sources connected</h2>
            <p>Nothing is being read. Connect a source to start storing evidence.</p></section>
        : <ul className="card">{props.connectors.map(connector => <li key={connector.connectorId}>
            <h2>{connector.displayName}</h2>
            <p>Status: {STATUS_TEXT[connector.status] ?? connector.status}</p>
            {connector.lastSyncError && <p>Reason: {connector.lastSyncError}</p>}
            <dl>
              <dt>Account</dt><dd>{connector.externalAccountRef}</dd>
              <dt>Granted capabilities</dt>
              <dd>{connector.grantedCapabilities.length === 0 ? 'None granted' : connector.grantedCapabilities.join(', ')}</dd>
              <dt>Read scopes requested</dt>
              <dd>{connector.requestedScopes.length === 0 ? 'None' : connector.requestedScopes.join(', ')}</dd>
              <dt>Last stored cursor position</dt>
              <dd>{connector.cursor ? connector.cursor.position : 'No cursor stored yet'}</dd>
              <dt>Credential</dt>
              <dd>{connector.credentialHeld ? 'Held by the secrets manager' : 'None held'}</dd>
              <dt>Prompt-injection risk of this source</dt><dd>{connector.promptInjectionRisk}</dd>
            </dl>
            <a href={'/connectors?connector=' + encodeURIComponent(connector.connectorId)}>Grant connector capabilities</a>
            {connector.status !== 'DISCONNECTED' && <>
              <button disabled={disabled} onClick={() => post('connectors/' + connector.connectorId + '/sync',
                {mode: 'INCREMENTAL', allowedPurposes: ['PERSONAL_ASSISTANCE']}, 'connector.sync')}>Sync now</button>
              <button disabled={disabled} onClick={() => post('connectors/' + connector.connectorId + '/disconnect',
                {}, 'connector.manage')}>Disconnect</button>
            </>}
          </li>)}</ul>}

      {props.lastSync && <section className="card"><h2>Last sync</h2>
        <p role="status">
          {props.lastSync.resumedFromCursor
            ? 'Resumed from the stored cursor ' + props.lastSync.resumedFromCursor.position + '.'
            : 'Started from the beginning; no cursor was stored yet.'}
        </p>
        <dl>
          <dt>Items ingested</dt><dd>{props.lastSync.itemsIngested}</dd>
          <dt>Redelivered items discarded as duplicates</dt><dd>{props.lastSync.duplicatesSuppressed}</dd>
          <dt>Thread updates applied</dt><dd>{props.lastSync.threadUpdatesApplied}</dd>
          <dt>Recurrence updates applied</dt><dd>{props.lastSync.recurrenceUpdatesApplied}</dd>
          <dt>Commit and CI bursts aggregated into one episode each</dt>
          <dd>{props.lastSync.episodesAggregated} ({props.lastSync.aggregatedEvents} events)</dd>
          <dt>New cursor position</dt><dd>{props.lastSync.newCursor ? props.lastSync.newCursor.position : 'None'}</dd>
        </dl>
        {props.lastSync.refusals.length > 0 && <ul>{props.lastSync.refusals.map(refusal =>
          <li key={refusal.externalRef}>{refusal.externalRef}: {REFUSAL_TEXT[refusal.code] ?? refusal.code}
            {refusal.capabilityId ? ' (' + refusal.capabilityId + ')' : ''}</li>)}</ul>}
      </section>}

      {props.selected && <CapabilityGrants connector={props.selected} disabled={disabled}
        onToggle={(capability, granted) => post('connectors/' + props.selected!.connectorId + '/capabilities',
          {capabilities: [{capabilityId: capability.capabilityId, granted}]}, 'connector.manage')}/>}
    </main></div>;
}

/** The "Grant connector capabilities" screen: one independent control per
 * discrete manifest capability, each with its own risk classification. */
function CapabilityGrants(props: {
  connector: PublicConnector; disabled: boolean;
  onToggle(capability: PublicCapabilityGrant, granted: boolean): void;
}) {
  return <section className="card"><h2>Grant connector capabilities</h2>
    <p>{props.connector.displayName}: each capability is granted on its own. Granting one never grants another.</p>
    <p>Consent requests read-only access: {props.connector.requestedScopes.length === 0
      ? 'no scopes are requested until you grant a capability'
      : props.connector.requestedScopes.join(', ')}.</p>
    <ul>{props.connector.capabilities.map(capability => <li key={capability.capabilityId}>
      <h3>{capability.capabilityId}</h3>
      <p>{capability.description}</p>
      <p>Risk classification: {capability.riskClass}. Access: {capability.access === 'READ' ? 'read-only' : 'write'}.</p>
      <p>Scopes: {capability.scopes.length === 0 ? 'none (first-party)' : capability.scopes.join(', ')}</p>
      <p id={'state-' + capability.capabilityId}>
        {capability.granted ? 'Granted' : capability.revokedAt ? 'Revoked' : 'Not granted'}
      </p>
      {capability.access === 'WRITE'
        ? <p>{REFUSAL_TEXT.CONNECTOR_WRITE_SCOPE_REFUSED}</p>
        : <button type="button" disabled={props.disabled}
            aria-describedby={'state-' + capability.capabilityId}
            aria-pressed={capability.granted}
            onClick={() => props.onToggle(capability, !capability.granted)}>
            {capability.granted ? 'Revoke ' + capability.capabilityId : 'Grant ' + capability.capabilityId}
          </button>}
    </li>)}</ul>
    <p>Sending email, creating calendar events and any other external write are refused in V0. Draft creation is
      governed separately, by the draft capability and the action policy, not by a connector grant.</p>
  </section>;
}
