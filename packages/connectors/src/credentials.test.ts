import { randomUUID } from 'node:crypto';
import { isSecretHandle } from '@unai/secrets';
import { describe, expect, it } from 'vitest';
import { ConnectorError, connectorCredentialHandle, isConnectorCredentialHandle } from './index.js';
import { credentialHandleVectors } from './testing/credential-handles.js';

// ADR 0013, amendment 2026-11-07: the connector-credential namespace.
const owner = randomUUID();
const other = randomUUID();
const vectors = credentialHandleVectors(owner, other);

describe('isConnectorCredentialHandle', () => {
  it.each(vectors)('$title', ({ handle, accepted }) => {
    expect(isConnectorCredentialHandle(handle, owner)).toBe(accepted);
  });

  it('is checked over the full shared list: 30 vectors, every accepted one storable and a valid handle', () => {
    expect(vectors).toHaveLength(30);
    for (const vector of vectors.filter(entry => entry.accepted)) {
      expect(vector.storable, vector.title).toBe(true);
      expect(isSecretHandle(vector.handle), vector.title).toBe(true);
    }
    expect(vectors.map(entry => entry.title)).toEqual(expect.arrayContaining([
      'runtime credential handle', "another owner's prefix", 'prefix without a label', 'uppercase owner segment',
      'own namespace without #field', 'own namespace with #field']));
  });

  it('lowercases only the owner argument, and refuses a non-UUID owner or a non-string handle', () => {
    expect(isConnectorCredentialHandle(`secret://mounted/connectors/${owner}/gmail`, owner.toUpperCase())).toBe(true);
    expect(isConnectorCredentialHandle('secret://mounted/connectors/not-a-uuid/gmail', 'not-a-uuid')).toBe(false);
    for (const handle of [null, 42, undefined]) expect(isConnectorCredentialHandle(handle, owner)).toBe(false);
  });
});

describe('connectorCredentialHandle', () => {
  it('builds a lowercase handle in the owner namespace, with the provider and field asked for', () => {
    const built = [
      [connectorCredentialHandle(owner, 'gmail'), `secret://mounted/connectors/${owner}/gmail`],
      [connectorCredentialHandle(owner.toUpperCase(), 'gmail', { field: 'refresh' }),
        `secret://mounted/connectors/${owner}/gmail#refresh`],
      [connectorCredentialHandle(owner, 'github', { provider: 'vault' }), `secret://vault/connectors/${owner}/github`],
      [connectorCredentialHandle(owner, 'gmail', { field: undefined }), `secret://mounted/connectors/${owner}/gmail`],
    ] as const;
    for (const [handle, expected] of built) {
      expect(handle).toBe(expected);
      expect(isConnectorCredentialHandle(handle, owner)).toBe(true);
    }
  });

  const refusals: readonly (readonly [string, () => string])[] = [
    ['a non-UUID owner', () => connectorCredentialHandle('not-a-uuid', 'gmail')],
    ...['', '/gmail', 'gmail/', '.', '..', '../x', 'a//b', 'gm ail', 'a#b'].map(label =>
      [`the label ${JSON.stringify(label)}`, () => connectorCredentialHandle(owner, label)] as const),
    ['the provider "Mounted"', () => connectorCredentialHandle(owner, 'gmail', { provider: 'Mounted' })],
    ...['', 'a#b'].map(field =>
      [`the field ${JSON.stringify(field)}`, () => connectorCredentialHandle(owner, 'gmail', { field })] as const),
  ];
  it.each(refusals)('refuses %s with the bare code', (_title, build) => {
    let thrown: unknown;
    try { build(); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(ConnectorError);
    expect((thrown as ConnectorError).message).toBe('CONNECTOR_SECRET_REF_INVALID');
    expect((thrown as ConnectorError).detail).toEqual({});
  });
});
