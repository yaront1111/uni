// @vitest-environment jsdom
import {afterEach, describe, expect, it, vi} from 'vitest';
import {act, createElement} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {publicConnectorSchema} from '@unai/domain';
import {Connectors} from './Connectors';
import {KeyboardUser, accessibleName} from './testing/keyboard';
(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;

const GENERIC = 'The request was refused. Nothing was changed.';
const CONNECTOR_ID = '11111111-1111-4111-8111-111111111111';
const connector = publicConnectorSchema.parse({
  connectorId: CONNECTOR_ID, connectorType: 'GMAIL', manifestId: 'connector.gmail', manifestVersion: '1.0.0',
  displayName: 'Gmail', externalAccountRef: 'owner@example.test', status: 'ACTIVE', promptInjectionRisk: 'HIGH',
  capabilities: [{capabilityId: 'gmail.read_metadata', description: 'Read message metadata.', access: 'READ',
    riskClass: 'LOW', scopes: ['gmail.metadata'], granted: true, grantedAt: '2026-11-01T00:00:00.000Z', revokedAt: null}],
  grantedCapabilities: ['gmail.read_metadata'], requestedScopes: ['gmail.metadata'], cursor: null, cursorUpdatedAt: null,
  lastSyncError: null, credentialHeld: true, createdAt: '2026-11-01T00:00:00.000Z', disconnectedAt: null,
});

let root: Root | null = null;
afterEach(() => {act(() => root?.unmount()); root = null; document.body.innerHTML = ''; vi.unstubAllGlobals(); vi.restoreAllMocks();});
async function mount() {
  document.documentElement.lang = 'en'; document.title = 'Connected sources';
  document.body.innerHTML = '<div id="root"></div>'; root = createRoot(document.getElementById('root')!);
  await act(async () => root!.render(createElement(Connectors, {connectors: [connector], selected: null, lastSync: null,
    state: 'IDLE', refusal: null, error: null})));
}
const alerts = () => [...document.querySelectorAll('[role="alert"]')].map(element => element.textContent);
async function press(user: KeyboardUser, name: RegExp) {
  expect(user.tabTo(element => name.test(accessibleName(element)))).not.toBeNull();
  await act(async () => user.press('Enter'));
}
const button = (name: RegExp) => [...document.querySelectorAll('button')].find(element => name.test(accessibleName(element)))!;
function answer(body: () => Promise<unknown>, status = 403) {
  const fetcher = vi.fn(async () => ({ok: false, status, json: body}));
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}

describe('Connected sources refusals show one fixed sentence', () => {
  it('a disconnect refused with a JSON null body shows the generic sentence and re-enables the controls', async () => {
    const fetcher = answer(async () => null);
    await mount();
    await press(new KeyboardUser(document), /^Disconnect$/);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect((fetcher.mock.calls[0] as unknown[])[0]).toBe('/api/platform/connectors/' + CONNECTOR_ID + '/disconnect');
    expect(alerts()).toEqual([GENERIC]);
    expect(button(/^Disconnect$/).disabled).toBe(false);
    expect(button(/^Sync now$/).disabled).toBe(false);
  });

  const shapes: [string, unknown][] = [['an array', []], ['a string', 'refused'], ['a number', 403], ['an empty object', {}],
    ['a non-string code', {code: 403}], ['an inherited name', {code: 'constructor'}], ['an unknown code', {code: 'NOT_A_CONNECTOR_CODE'}]];
  for (const [label, body] of shapes) {
    it('a sync refused with ' + label + ' shows the generic sentence', async () => {
      answer(async () => body);
      await mount();
      await press(new KeyboardUser(document), /^Sync now$/);
      expect(alerts()).toEqual([GENERIC]);
    });
  }

  it('a refusal whose body is not JSON shows the generic sentence', async () => {
    answer(async () => {throw new SyntaxError('Unexpected token < in JSON');}, 502);
    await mount();
    await press(new KeyboardUser(document), /^Disconnect$/);
    expect(alerts()).toEqual([GENERIC]);
  });

  it('a known code keeps its own sentence', async () => {
    answer(async () => ({code: 'CONNECTOR_CAPABILITY_NOT_GRANTED', capabilityId: 'gmail.read_metadata'}));
    await mount();
    await press(new KeyboardUser(document), /^Sync now$/);
    expect(alerts()).toEqual(['That capability has not been granted, so the operation was refused.']);
  });

  it('the Connect form refused with a JSON null body shows the generic sentence', async () => {
    const fetcher = answer(async () => null);
    await mount();
    const user = new KeyboardUser(document);
    expect(user.tabTo(element => element.id === 'connect-account')).not.toBeNull();
    await act(async () => user.type('owner@example.test'));
    await press(user, /^Connect source$/);
    expect((fetcher.mock.calls[0] as unknown[])[0]).toBe('/api/platform/connectors');
    expect(alerts()).toEqual([GENERIC]);
  });

  it('a rejected fetch shows a fixed sentence and none of the error text', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {throw new TypeError('Failed to fetch https://api.internal:3443');}));
    await mount();
    await press(new KeyboardUser(document), /^Sync now$/);
    expect(alerts()).toEqual(['The request could not be completed.']);
    expect(document.body.textContent).not.toContain('api.internal');
  });
});
