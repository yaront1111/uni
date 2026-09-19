import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

it.each([
  ['Asia/Jerusalem','09:00','2026-09-19T05:59:00Z','2026-09-19T06:00:00.000Z'],
  ['Asia/Jerusalem','09:00','2026-09-19T06:00:00Z','2026-09-20T06:00:00.000Z'],
  // The requested minute does not exist on the spring-forward day.
  ['America/New_York','02:30','2026-03-08T00:00:00Z','2026-03-08T07:00:00.000Z'],
  // An overlapping minute runs once, at the first occurrence.
  ['America/New_York','01:30','2026-11-01T00:00:00Z','2026-11-01T05:30:00.000Z'],
  ['America/New_York','01:30','2026-11-01T05:30:00Z','2026-11-02T06:30:00.000Z'],
])('schedules the next %s %s occurrence after %s', async (zone,time,after,expected) => {
  expect(existsSync(resolve('packages/api/src/initiative-time.ts')), 'A durable scheduler needs an explicit owner-local recurrence implementation').toBe(true);
  const path = './initiative-time.js';
  const { nextInitiativeRun } = await import(path);
  expect(nextInitiativeRun(new Date(after),zone,time).toISOString()).toBe(expected);
});
