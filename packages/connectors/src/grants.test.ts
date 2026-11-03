import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { disconnectResultSchema } from '@unai/domain';
import { runMigrations, withOwnerTransaction, type OwnerTransaction } from '@unai/postgres';
import type { SecretsManager } from '@unai/secrets';
import { createConnector, disconnectConnector, markTokenRevoked } from './grants.js';
import { createTokenRevoker } from './providers.js';

// Real owner transactions and PostgreSQL; only the provider network is doubled.
if (!process.env.UNAI_TEST_DATABASE_URL) throw new Error('Run pnpm test for the required PostgreSQL harness');
const admin = new Pool({ connectionString: process.env.UNAI_TEST_DATABASE_URL });
const appUrl = new URL(process.env.UNAI_TEST_DATABASE_URL);
appUrl.username = 'grants_test_app'; appUrl.password = 'test-only';
const appPool = new Pool({ connectionString: appUrl.href });
const owner = randomUUID(), actor = randomUUID();
const NOTICE = 'CONNECTOR_REVOCATION_MANUAL_REQUIRED';

const as = <T,>(purpose: string, run: (tx: OwnerTransaction) => Promise<T>) =>
  withOwnerTransaction(appPool, { actorId: actor, ownerScopeId: owner, purpose, correlationId: randomUUID() }, run);

beforeAll(async () => {
  await runMigrations(admin, resolve('migrations'));
  await admin.query("DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='grants_test_app') THEN CREATE ROLE grants_test_app LOGIN PASSWORD 'test-only'; END IF; END $$; GRANT unai_app TO grants_test_app");
  await admin.query('INSERT INTO users(id,display_name) VALUES($1,$2)', [actor, 'Grants owner']);
  await admin.query("INSERT INTO owner_scopes(id,scope_kind,display_name,created_by_user_id) VALUES($1,'PERSONAL','Grants',$2)", [owner, actor]);
  await admin.query("INSERT INTO owner_scope_members(owner_scope_id,user_id,role) VALUES($1,$2,'OWNER')", [owner, actor]);
});
afterEach(() => { vi.unstubAllGlobals(); });
afterAll(async () => { await appPool.end(); await admin.end(); });

function connect(connectorType: 'OMI' | 'GMAIL' | 'GITHUB', capabilityId: string, externalAccountRef: string = randomUUID()) {
  return as('connector.manage', tx => createConnector(tx, {
    connectorType, externalAccountRef, secretRef: `secret://mounted/${connectorType.toLowerCase()}#key`,
    requestedCapabilities: [{ capabilityId, granted: true }],
  }));
}

function expectedReceipt(connectorId: string, capabilityId: string, manual: boolean) {
  return {
    connectorId, status: 'DISCONNECTED', tokensRevokedAtProvider: !manual,
    secretReferenceDestroyed: true, ingestionStopped: true, capabilitiesRevoked: [capabilityId],
    retainedEvidence: 'RETAINED', retainedEvidenceOptions: ['KEEP_EVIDENCE', 'REQUEST_DELETION'],
    providerRevocationNotice: manual ? NOTICE : null,
  };
}

describe('disconnectConnector (ADR 0041 D8)', () => {
  it('OMI clears local authority while honestly reporting manual provider revocation', async () => {
    const { connectorId } = await connect('OMI', 'omi.read_conversations', 'omi-owner');
    await admin.query('UPDATE connectors SET last_cursor=$2 WHERE id=$1',
      [connectorId, JSON.stringify({ position: 'p', providerToken: null })]);
    const resolved: string[] = [];
    const recordingSecrets: SecretsManager = {
      async resolve(handle) { resolved.push(handle); throw new Error('unexpected secret resolution'); },
    };
    const fetchDouble = vi.fn(() => { throw new Error('unexpected provider request'); });
    vi.stubGlobal('fetch', fetchDouble);

    const receipt = await as('connector.manage', tx =>
      disconnectConnector(tx, connectorId, createTokenRevoker(recordingSecrets)));
    expect(receipt).toEqual(expectedReceipt(connectorId, 'omi.read_conversations', true));
    expect(fetchDouble).not.toHaveBeenCalled();
    expect(resolved).toEqual([]);
    const row = (await admin.query(
      'SELECT status,secret_ref,last_cursor,disconnected_at FROM connectors WHERE id=$1', [connectorId])).rows[0];
    expect(row).toEqual({ status: 'DISCONNECTED', secret_ref: null, last_cursor: null, disconnected_at: expect.any(Date) });
    const grants = (await admin.query(
      'SELECT capability_id,granted,revoked_at FROM connector_capability_grants WHERE connector_id=$1', [connectorId])).rows;
    expect(grants).toEqual([{ capability_id: 'omi.read_conversations', granted: false, revoked_at: expect.any(Date) }]);
  });

  it('GMAIL preserves the successful receipt with a null notice', async () => {
    const { connectorId } = await connect('GMAIL', 'gmail.read_metadata');
    const receipt = await as('connector.manage', tx => disconnectConnector(tx, connectorId, async () => ({ revoked: true })));
    expect(receipt).toEqual(expectedReceipt(connectorId, 'gmail.read_metadata', false));
  });

  it('GITHUB refuses failed revocation without clearing its credential or grants', async () => {
    const { connectorId } = await connect('GITHUB', 'github.read_issues');
    await expect(as('connector.manage', tx => disconnectConnector(tx, connectorId, async () => ({ revoked: false }))))
      .rejects.toThrow('CONNECTOR_REVOCATION_FAILED');
    const row = (await admin.query('SELECT status,secret_ref,disconnected_at FROM connectors WHERE id=$1', [connectorId])).rows[0];
    expect(row).toEqual({ status: 'ACTIVE', secret_ref: 'secret://mounted/github#key', disconnected_at: null });
    const grant = (await admin.query(
      'SELECT granted,revoked_at FROM connector_capability_grants WHERE connector_id=$1 AND capability_id=$2',
      [connectorId, 'github.read_issues'])).rows[0];
    expect(grant).toEqual({ granted: true, revoked_at: null });
  });

  it('a credentialed connector still requires a revoker port', async () => {
    const { connectorId } = await connect('OMI', 'omi.read_conversations');
    await expect(as('connector.manage', tx => disconnectConnector(tx, connectorId)))
      .rejects.toThrow('CONNECTOR_REVOCATION_UNAVAILABLE');
    const row = (await admin.query('SELECT status,secret_ref FROM connectors WHERE id=$1', [connectorId])).rows[0];
    expect(row).toEqual({ status: 'ACTIVE', secret_ref: 'secret://mounted/omi#key' });
  });

  it('successful provider revocation takes precedence over a contradictory manual flag', async () => {
    const { connectorId } = await connect('GMAIL', 'gmail.read_metadata');
    const receipt = await as('connector.manage', tx => disconnectConnector(tx, connectorId,
      async () => ({ revoked: true, manualRevocationRequired: true })));
    expect(receipt).toEqual(expectedReceipt(connectorId, 'gmail.read_metadata', false));
  });

  it('OMI with a previously revoked token has no held handle and no manual notice', async () => {
    const { connectorId } = await connect('OMI', 'omi.read_conversations');
    await as('connector.manage', tx => markTokenRevoked(tx, connectorId));
    const revoke = vi.fn(async () => ({ revoked: false, manualRevocationRequired: true }));
    const receipt = await as('connector.manage', tx => disconnectConnector(tx, connectorId, revoke));
    expect(revoke).not.toHaveBeenCalled();
    expect(receipt).toEqual({
      ...expectedReceipt(connectorId, 'omi.read_conversations', false), tokensRevokedAtProvider: false,
    });
  });
});

it('disconnectResultSchema requires the nullable notice and remains strict', () => {
  const receipt = expectedReceipt(randomUUID(), 'omi.read_conversations', true);
  expect(disconnectResultSchema.safeParse(receipt).success).toBe(true);
  expect(disconnectResultSchema.safeParse({ ...receipt, extra: true }).success).toBe(false);
  expect(disconnectResultSchema.safeParse({ ...receipt, providerRevocationNotice: 'SOMETHING_ELSE' }).success).toBe(false);
  const { providerRevocationNotice: _notice, ...withoutNotice } = receipt;
  expect(disconnectResultSchema.safeParse(withoutNotice).success).toBe(false);
  expect(disconnectResultSchema.safeParse({ ...receipt, providerRevocationNotice: null }).success).toBe(true);
});
