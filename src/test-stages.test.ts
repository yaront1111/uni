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

it('maxWorkers defaults to 4 and accepts only 1-64',()=>{
  const script="import {maxWorkers} from './scripts/test-stages.mjs';const run=v=>{try{return maxWorkers(v===undefined?{}:{UNAI_TEST_MAX_WORKERS:v})}catch(e){return e.message}};process.stdout.write(JSON.stringify([undefined,'','1','2','64','0','65','-1','2.5',' 2','02','abc','1e1'].map(run)))";
  const run=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8'});
  expect(run.status,run.stderr).toBe(0);
  expect(JSON.parse(run.stdout)).toEqual([4,4,1,2,64,...Array<string>(8).fill('TEST_MAX_WORKERS_INVALID')]);
});

it('the harness refuses an invalid UNAI_TEST_MAX_WORKERS before it reads the stage or provisions anything',()=>{
  // The bogus stage is the safety net: if validation regresses, the harness dies on UNKNOWN_TEST_STAGE instead of provisioning.
  const run=spawnSync(process.execPath,['scripts/test.mjs','--stage','no-such-stage'],{env:{...process.env,UNAI_TEST_MAX_WORKERS:'0'},encoding:'utf8',timeout:60000});
  expect(run.status).toBe(1);
  expect(run.stderr).toContain('TEST_MAX_WORKERS_INVALID');
  expect(run.stderr).not.toContain('UNKNOWN_TEST_STAGE');
  expect(run.stdout).not.toContain('Applying the Git SQL migrations');
},60000);
