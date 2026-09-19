import {expect,it} from 'vitest';
import {spawnSync} from 'node:child_process';

it('selects explicit stages and refuses an unknown stage instead of running an empty suite',()=>{
  const script="import {stageFilters} from './scripts/test-stages.mjs';process.stdout.write(JSON.stringify(['unit','property','connector-integration','security','end-to-end'].map(stageFilters)));try{stageFilters('typo');process.exit(2)}catch{}";
  const run=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8'});
  expect(run.status,run.stderr).toBe(0);
  const selections=JSON.parse(run.stdout) as string[][];
  expect(selections.every(s=>s.length>0)).toBe(true);
  expect(selections[1]).toContain('packages/capabilities/src/projections.test.ts');
  expect(selections[4]).toContain('apps/web/e2e/');
});
