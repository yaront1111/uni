import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { prepareForCapabilities } from './sync.js';

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
