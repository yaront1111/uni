import { expect, it } from 'vitest';
import { changeWindow } from './change-window.js';

it('uses the requested month rather than filtering every change question to this month', () => {
  expect(changeWindow('What changed this month?', '2026-01-02T01:00:00.000Z')).toMatchObject({from:'2026-01-01T00:00:00.000Z',to:null});
  expect(changeWindow('What changed last month?', '2026-01-02T01:00:00.000Z')).toMatchObject({from:'2025-12-01T00:00:00.000Z',to:'2026-01-01T00:00:00.000Z'});
  expect(changeWindow('What changed?', '2026-01-02T01:00:00.000Z')).toMatchObject({from:null,to:null});
  expect(changeWindow('What changed last week?', '2026-01-02T01:00:00.000Z')).toMatchObject({from:'2025-12-22T00:00:00.000Z',to:'2025-12-29T00:00:00.000Z'});
});

it('lets an explicit declared window narrow the record and labels the UTC fallback', () => {
  expect(changeWindow('What changed this month?', '2026-01-02T01:00:00.000Z',{from:'2025-04-01T00:00:00.000Z',to:null}).from).toBe('2025-04-01T00:00:00.000Z');
  expect(changeWindow('What changed this month?', '2026-01-02T01:00:00.000Z').description).toContain('UTC');
  expect(changeWindow('What changed in July?', '2026-01-02T01:00:00.000Z').description).toContain('No exact date range');
});
