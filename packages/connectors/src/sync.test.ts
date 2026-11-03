import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ConnectorError } from './manifests.js';
import type { ConnectorTransaction } from './grants.js';
import { prepareForCapabilities, runConnectorSync } from './sync.js';

const fixture: unknown = JSON.parse(await readFile(resolve('fixtures/sources/omi-conversation.json'), 'utf8'));
const capabilityId = 'omi.read_conversations';
const externalRef = 'omi:conversation:omi-conv-2026-10-28-7f3a';

it.each([{ granted: [] }, { granted: ['gmail.read_metadata', 'calendar.read', 'omi.write_conversations'] }])(
  'ADR 0041 D6: refuses OMI without its exact read grant ($granted)', ({ granted }) => {
    expect(prepareForCapabilities('OMI', fixture, granted)).toEqual({
      externalRef, code: 'CONNECTOR_CAPABILITY_NOT_GRANTED', capabilityId,
    });
  },
);

it('ADR 0041 D6: passes the same whole conversation through without mutation', () => {
  const before = structuredClone(fixture);
  const prepared = prepareForCapabilities('OMI', fixture, [capabilityId]);
  expect(prepared).toEqual({ sourceType: 'OMI', payload: fixture, externalRef,
    aggregatedEvents: 0, capabilityUsed: capabilityId });
  if (!('payload' in prepared)) throw new Error('EXPECTED_PREPARED_PAYLOAD');
  expect(prepared.payload).toBe(fixture);
  expect(fixture).toEqual(before);
});

it.each([null, {}, { id: 42 }, { id: '' }, [], 42].map(payload => ({ payload })))(
  'uses a bounded fallback reference for $payload on both paths', ({ payload }) => {
    for (const granted of [[], [capabilityId]]) {
      expect(prepareForCapabilities('OMI', payload, granted).externalRef).toBe('omi:conversation');
    }
  },
);

it('bounds the whole reference, including its prefix, on both paths', () => {
  const payload = { id: 'x'.repeat(600) };
  for (const granted of [[], [capabilityId]]) {
    const prepared = prepareForCapabilities('OMI', payload, granted);
    expect(prepared.externalRef).toBe('omi:conversation:' + 'x'.repeat(495));
    expect(prepared.externalRef.length).toBe(512);
    expect(prepared.externalRef.startsWith('omi:conversation:xxx')).toBe(true);
  }
});

it('keeps unknown connector types refused', () => {
  expect(prepareForCapabilities('NOT_A_CONNECTOR', fixture, [capabilityId])).toEqual({
    externalRef: 'NOT_A_CONNECTOR', code: 'CONNECTOR_TYPE_UNSUPPORTED', capabilityId: null,
  });
});

function ingestionFailure(error: Error) {
  const connectorId = randomUUID();
  const tx: ConnectorTransaction = {
    context: { ownerScopeId: randomUUID(), actorId: randomUUID(), purpose: 'connector.sync', correlationId: randomUUID() },
    async query(sql) {
      if (/SELECT.*connector_capability_grants/s.test(sql)) {
        return { rows: [{ capability_id: capabilityId }], rowCount: 1 };
      }
      if (/SELECT.*FROM connectors/s.test(sql)) {
        return { rows: [{ id: connectorId, connector_type: 'OMI', external_account_ref: 'owner@example.test',
          status: 'ACTIVE', secret_ref: null, last_cursor: null }], rowCount: 1 };
      }
      throw new Error('UNEXPECTED_TEST_QUERY');
    },
  };
  return { connectorId, run: () => runConnectorSync(tx, {
    connectorId, request: { mode: 'INCREMENTAL', sensitivity: 'PRIVATE', allowedPurposes: ['PERSONAL_ASSISTANCE'], maxPages: 1 },
    client: { async fetchPage() { return { payloads: [{ id: 'conv-1' }], nextCursor: null }; } },
    ingest: async () => { throw error; },
  }) };
}

it.each([
  Object.assign(new Error('CONNECTOR_INGESTION_STOPPED'), { code: '55000' }),
  new Error('CONNECTOR_REFUSED'),
])('names the stopped-ingestion port refusal: %s', async error => {
  const { connectorId, run } = ingestionFailure(error);
  const refusal = await run().then(() => null, (failure: unknown) => failure);
  expect(refusal).toBeInstanceOf(ConnectorError);
  expect(refusal).toMatchObject({ message: 'CONNECTOR_INGESTION_STOPPED' });
  expect((refusal as ConnectorError).detail).toEqual({ connectorId });
});

it.each([
  Object.assign(new Error('EVIDENCE_IMMUTABLE'), { code: '55000' }),
  Object.assign(new Error('CONNECTOR_INGESTION_STOPPED'), { code: '23505' }),
])('rethrows an unrelated ingest failure unchanged: %s', async error => {
  await expect(ingestionFailure(error).run()).rejects.toBe(error);
});
