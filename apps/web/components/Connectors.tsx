import React, {useState} from 'react';
import {disconnectResultSchema, type ConnectorType, type DisconnectResult, type PublicConnector, type PublicCapabilityGrant, type SyncResult} from '@unai/domain';
import {Navigation} from './Navigation';

export type DisconnectReceipt = Pick<DisconnectResult, 'connectorId' | 'providerRevocationNotice'>;

/** The design screens "Connected sources" and "Grant connector capabilities".
 *
 * Every drawn state is reachable from props alone, because the component tests
 * render static markup and never run an effect. Status is always words: a
 * revoked token, a failed sync and a disconnected source each say what happened
 * in text, never in colour alone. */
export interface ConnectorsProps {
  embedded?:boolean;
  connectors: PublicConnector[];
  /** The source whose capability grants are being edited, if any. */
  selected: PublicConnector | null;
  /** The result of the most recent sync, so the screen can show that the second
   * run resumed from the stored cursor and discarded the redelivered items. */
  lastSync: SyncResult | null;
  /** Validated receipt of the last disconnect; omitted in embedded screens. */
  lastDisconnect?: DisconnectReceipt | null;
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
  DISCONNECTED: 'Disconnected: ingestion stopped.',
};
/** The Connect form's words, in display order. A new domain type requires a label here. */
const CONNECTOR_TYPE_LABEL: Record<ConnectorType, string> = {
  GMAIL: 'Gmail', GOOGLE_CALENDAR: 'Google Calendar', GITHUB: 'GitHub', DOCUMENT: 'Documents',
  CONVERSATION: 'Conversation source', OMI: 'Omi wearable',
};
// ADR 0041 D7: a rate-limited run fails at once, and the API sends the provider's whole-second Retry-After as retryAfterSeconds, or null.
function rateLimitedText(retry: string): string {
  return 'The provider is limiting requests, so the sync stopped. Try again ' + retry + '.';
}
const REFUSAL_TEXT: Record<string, string> = {
  CONNECTOR_WRITE_SCOPE_REFUSED: 'That capability needs a write scope. Uai V0 is read-only and refused it.',
  CONNECTOR_CAPABILITY_NOT_GRANTED: 'That capability has not been granted, so the operation was refused.',
  CONNECTOR_INGESTION_STOPPED: 'This source is disconnected or revoked, so nothing was ingested.',
  CONNECTOR_ALREADY_CONNECTED: 'That account is already connected to this owner scope.',
  CONNECTOR_RATE_LIMITED: rateLimitedText('later'),
  CONNECTOR_TOKEN_REVOKED: 'The provider refused the credential for this source, so the sync stopped. Reauthorization is required before it can sync again.',
};
// Other sync failures the API records on the connector (SYNC_FAILED) after the run rolls back; the record is best-effort, so no sentence claims it.
const SYNC_FAILURE_TEXT: Record<string, string> = {
  CONNECTOR_PROVIDER_UNAVAILABLE: 'The provider could not be reached, so the sync stopped. Try again later.',
  CONNECTOR_PROVIDER_RESPONSE_INVALID: 'The provider sent a response Uai could not read, so the sync stopped. Try again later.',
  CONNECTOR_CURSOR_INVALID: "The provider no longer accepts this source's saved sync position, so the sync stopped.",
  CONNECTOR_CREDENTIAL_MISSING: 'Uai could not read the stored credential for this source, so the sync stopped.',
  CONNECTOR_OAUTH_CLIENT_MISSING: 'The Google connectors client is not configured on this server, so the sync stopped.',
};
// A disconnect refused for an unreachable provider rolls back in one transaction, so the source is still connected.
const DISCONNECT_REFUSAL_TEXT: Record<string, string> = {
  CONNECTOR_PROVIDER_UNAVAILABLE: 'The provider could not be reached to revoke access, so the source is still connected. Try again later.',
};
const ACTION_TEXT = {sync: SYNC_FAILURE_TEXT, disconnect: DISCONNECT_REFUSAL_TEXT};
/** The one sentence a refused write shows. Only an object body whose own string
 * `code` is a REFUSAL_TEXT key picks its own sentence; every other body (null,
 * array, scalar, unknown or inherited name) gets the generic one.
 *
 * CONNECTOR_RATE_LIMITED and CONNECTOR_TOKEN_REVOKED are sync refusals the API
 * has already recorded on the connector (SYNC_FAILED, or TOKEN_REVOKED after a
 * provider 401), so neither sentence says nothing changed. The wait is named
 * only for a non-negative safe integer: no other body string reaches the DOM.
 *
 * The button that posted passes `action`, never the response body. After the
 * sync route's run rolls back, its catch block (packages/api/src/connectors.ts)
 * records SYNC_FAILED for the other provider, response, cursor and credential
 * codes, so SYNC_FAILURE_TEXT never says nothing changed. A disconnect refusal
 * rolls back, so DISCONNECT_REFUSAL_TEXT says the source is still connected. */
export function refusalText(answer: unknown, action?: 'sync' | 'disconnect'): string {
  const body = typeof answer === 'object' && answer !== null ? (answer as {code?: unknown; retryAfterSeconds?: unknown}) : undefined;
  const code = body?.code;
  const actionText = action && Object.hasOwn(ACTION_TEXT, action) ? ACTION_TEXT[action] : undefined;
  if (typeof code === 'string' && actionText && Object.hasOwn(actionText, code)) return actionText[code];
  if (typeof code !== 'string' || !Object.hasOwn(REFUSAL_TEXT, code)) return 'The request was refused. Nothing was changed.';
  const wait = body?.retryAfterSeconds;
  if (code === 'CONNECTOR_RATE_LIMITED' && typeof wait === 'number' && Number.isSafeInteger(wait) && wait >= 0) {
    return rateLimitedText('in ' + wait + (wait === 1 ? ' second' : ' seconds'));
  }
  return REFUSAL_TEXT[code];
}

const MANUAL_REVOCATION_TEXT = 'Uai has stopped using this key and forgotten its handle. Omi does not let apps revoke developer keys: revoke it in the Omi app under Settings > Developer.';

/** Preserve only the domain notice when navigating to the fresh server render. */
export function afterDisconnect(connectorId: string, answer: unknown): string {
  const path = '/connectors?disconnected=' + encodeURIComponent(connectorId);
  const receipt = disconnectResultSchema.safeParse(answer);
  return receipt.success && receipt.data.providerRevocationNotice !== null
    ? path + '&notice=' + receipt.data.providerRevocationNotice : path;
}

/** Query values become props only after matching the freshly parsed source list. */
export function lastDisconnectFrom(disconnected: unknown, notice: unknown,
  connectors: readonly PublicConnector[]): DisconnectReceipt | null {
  const connector = connectors.find(entry => entry.connectorId === disconnected && entry.status === 'DISCONNECTED');
  if (!connector) return null;
  const parsed = disconnectResultSchema.shape.providerRevocationNotice.safeParse(notice ?? null);
  return {connectorId: connector.connectorId, providerRevocationNotice: parsed.success ? parsed.data : null};
}

export function Connectors(props: ConnectorsProps) {
  const Frame=props.embedded?'section':'main';
  const Heading=props.embedded?'h2':'h1';
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(props.error ?? '');
  async function post(path: string, body: Record<string, unknown>, purpose: string, next?: (answer: unknown) => string, action?: 'sync' | 'disconnect') {
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/platform/' + path, {
        method: 'POST',
        headers: {'content-type': 'application/json', 'x-purpose': purpose,
          'x-correlation-id': crypto.randomUUID(), 'idempotency-key': crypto.randomUUID()},
        body: JSON.stringify(body),
      });
      if (response.status === 401) {window.location.assign('/signin?reason=expired'); return;}
      if (!response.ok) {setError(refusalText(await response.json().catch(() => null), action)); return;}
      if (next) window.location.assign(next(await response.json().catch(() => null)));
      else window.location.reload();
    } catch {
      // A thrown error's text (a network failure names the URL) is never shown.
      setError('The request could not be completed.');
    } finally {setBusy(false);}
  }
  const disabled = busy || props.state !== 'IDLE';
  return <div className={props.embedded?undefined:'shell'}>{!props.embedded&&<><a className="skip" href="#content">Skip to content</a>
    <header><a href="/" className="brand">Uai</a><span>Your personal memory</span></header>
    <Navigation current="connectors"/></>}
    <Frame id={props.embedded?'configuration-connectors':'content'} tabIndex={-1}>
      <Heading>Connected sources</Heading>
      {error && <p role="alert">{error}</p>}
      {props.refusal && <p role="alert">
        {REFUSAL_TEXT[props.refusal.code] ?? 'The request was refused.'}
        {props.refusal.capabilityId ? ' Capability: ' + props.refusal.capabilityId + '.' : ''}
      </p>}
      {props.state === 'SYNCING' && <p role="status" aria-live="polite">Initial sync running. Reading only what you granted.</p>}
      {props.state === 'DISCONNECTING' && <p role="status" aria-live="polite">Disconnecting and revoking tokens.</p>}

      {props.lastDisconnect && <p role="status" aria-live="polite">
        {props.connectors.find(connector => connector.connectorId === props.lastDisconnect?.connectorId)?.displayName ?? 'The source'} is disconnected: ingestion stopped and the evidence already stored is kept.
        {props.lastDisconnect.providerRevocationNotice === 'CONNECTOR_REVOCATION_MANUAL_REQUIRED' ? ' ' + MANUAL_REVOCATION_TEXT : ''}
      </p>}

      <form className="card" onSubmit={event=>{event.preventDefault();const data=new FormData(event.currentTarget);
        const secretRef=String(data.get('secretRef')??'').trim();
        if(secretRef&&!/^secret:\/\/[^\s]+$/.test(secretRef)){setError('Enter a secrets-manager handle, never a token or password.');return;}
        void post('connectors',{connectorType:data.get('connectorType'),externalAccountRef:data.get('externalAccountRef'),requestedCapabilities:[],secretRef:secretRef||null},'connector.manage');}}>
        <h3>Connect a source</h3>
        <label htmlFor="connect-type">Source type</label><select id="connect-type" name="connectorType" defaultValue="GMAIL">
          {Object.entries(CONNECTOR_TYPE_LABEL).map(([type, label]) => <option key={type} value={type}>{label}</option>)}
        </select>
        <label htmlFor="connect-account">Account reference</label><input id="connect-account" name="externalAccountRef" required maxLength={512}/>
        <details><summary>Existing credential reference</summary>
          <p>If your deployment has provisioned this connection, enter its secrets-manager handle. Never enter a token or password.</p>
          <p>For the Omi wearable, the handle must resolve to an Omi developer API key that has the conversations:read scope. Omi has no consent screen, so without a handle it cannot sync.</p>
          <label htmlFor="connect-secret">Secrets-manager handle (optional)</label><input id="connect-secret" name="secretRef" maxLength={512} autoComplete="off"/>
        </details>
        <p>After connecting, grant each capability separately. No access is granted by this form.</p>
        <button type="submit" disabled={disabled}>Connect source</button>
      </form>

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
            <a href={(props.embedded?'/admin/configuration':'/connectors')+'?connector=' + encodeURIComponent(connector.connectorId)}>Grant connector capabilities</a>
            {connector.status !== 'DISCONNECTED' && <>
              <button disabled={disabled} onClick={() => post('connectors/' + connector.connectorId + '/sync',
                {mode: 'INCREMENTAL', allowedPurposes: ['PERSONAL_ASSISTANCE']}, 'connector.sync', undefined, 'sync')}>Sync now</button>
              <button disabled={disabled} onClick={() => post('connectors/' + connector.connectorId + '/disconnect',
                {}, 'connector.manage', answer => afterDisconnect(connector.connectorId, answer), 'disconnect')}>Disconnect</button>
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
    </Frame></div>;
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
