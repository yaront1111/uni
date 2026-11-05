/** Every filtered invocation has its own database, storage and JSON report.
 * `pnpm test` without arguments continues to run the complete acceptance suite. */
export function stageFilters(stage){
  const stages={
    unit:['src/kernel/','src/wrapper/','packages/domain/','apps/web/components/'],
    property:['packages/capabilities/src/projections.test.ts','packages/capabilities/src/projection-replay.test.ts','packages/api/src/lineage.test.ts'],
    'connector-integration':['packages/connectors/','packages/api/src/connectors.test.ts','packages/api/src/connectors.live.test.ts'],
    security:['packages/api/src/security.test.ts','packages/api/src/transport.test.ts','packages/api/src/audit.test.ts','packages/api/src/control.test.ts','packages/storage/','packages/auth/'],
    'end-to-end':['apps/web/e2e/','packages/api/src/answers.test.ts','packages/api/src/today.test.ts'],
    operations:['src/backup.test.ts','src/backup-archive.test.ts','src/recovery-output.test.ts','src/recovery-storage.test.ts','src/restore.test.ts'],
  };
  if(!Object.hasOwn(stages,stage))throw new Error('UNKNOWN_TEST_STAGE');
  return stages[stage];
}

/** The harness's vitest worker count: 4 unless UNAI_TEST_MAX_WORKERS is 1-64. On DrvFs or
 * a heavily loaded host, lower it so fewer forks cold-start at once (see scripts/CLAUDE.md). */
export function maxWorkers(env){
  const value=env.UNAI_TEST_MAX_WORKERS;
  if(value===undefined||value==='')return 4;
  if(!/^[1-9][0-9]?$/.test(value)||Number(value)>64)throw new Error('TEST_MAX_WORKERS_INVALID');
  return Number(value);
}
