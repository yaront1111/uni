import { spawn } from 'node:child_process';
import {mkdir,readFile,writeFile,unlink} from 'node:fs/promises';
import {acceptanceResults} from './acceptance-gate.mjs';
import {maxWorkers,stageFilters} from './test-stages.mjs';
import {workspaceEvidence} from './workspace-evidence.mjs';
import {databaseRoundtrip} from './database-roundtrip.mjs';
import {provisionHarness} from './harness.mjs';

const args=process.argv.slice(2);
if(args.length&&!(args.length===2&&args[0]==='--stage'))throw new Error('TEST_ARGUMENTS_INVALID');
const stage=args[1],workers=maxWorkers(process.env);
const filters=stage?stageFilters(stage):[];

/** The shared harness owns only disposable infrastructure:
 * - a fresh database on a delivered server, or the pinned container;
 * - the SELECT 1 readiness probe;
 * - the Git SQL migrations;
 * - delivered storage, or disposable TLS/KMS storage.
 * This entry point still owns argument parsing and stage selection,
 * workspace evidence, the vitest child and its acceptance gate,
 * the coordinated recovery rehearsal and the final provenance write.
 * The child inherits the harness environment, including its database URL.
 * The rehearsal inherits only storage additions, not the scratch URL.
 * Cleanup precedes provenance so its failures remain part of the verdict.
 * The harness handle also retains the container name the rehearsal needs.
 * A caller that provisions its own PostgreSQL/pgvector server delivers the
 * URL instead of Docker; migrations and the suite run against it unchanged.
 * Never deliver an owner's production database or bucket: the suite creates
 * and drops databases and objects.
 * Keep the delivered read on the environment contract's cited line below.
 */

const delivered = process.env.UNAI_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
let harness;
let sourceEvidence;
const testReport=stage?'test-results/acceptance/'+stage+'.json':'test-results/acceptance/vitest.json';
try {
  sourceEvidence=await workspaceEvidence();
  await unlink(testReport+'.provenance.json').catch(error=>{if(error.code!=='ENOENT')throw error;});
  harness = await provisionHarness({delivered});
  // vitest runs as an awaited child, never spawnSync: a harness that serves object
  // storage from this process must keep answering requests while the suite runs.
  await mkdir('test-results/acceptance',{recursive:true});
  for(const path of stage?[testReport]:[testReport,'test-results/acceptance/scenarios.json','test-results/performance/load.json','test-results/performance/trace.json']){
    await unlink(path).catch(error=>{if(error.code!=='ENOENT')throw error;});
  }
  const test=spawn(process.execPath,['node_modules/vitest/vitest.mjs','run',...filters,'--maxWorkers='+workers,'--silent=passed-only','--reporter=default','--reporter=json','--outputFile.json='+testReport],{
    stdio:'inherit',
    env:{...process.env,...harness.env},
  });
  process.exitCode=await new Promise((resolve,reject)=>{
    test.once('error',reject);
    test.once('close',code=>resolve(code ?? 1));
  });
  const completedEvidence=await workspaceEvidence();
  if(completedEvidence.workspaceDigest!==sourceEvidence.workspaceDigest){console.error('WORKSPACE_CHANGED_DURING_TEST');process.exitCode=1;}
  if(!stage){
    const acceptance=acceptanceResults(JSON.parse(await readFile(testReport,'utf8')));
    await writeFile('test-results/acceptance/scenarios.json',JSON.stringify({format:'unai-acceptance/1',scenarios:acceptance},null,2)+'\n');
    const failed=acceptance.filter(scenario=>!scenario.passed);
    if(failed.length){console.error('ACCEPTANCE_SCENARIOS_FAILED: '+failed.map(row=>row.scenario).join(', '));process.exitCode=1;}
    else console.log('Acceptance scenarios: 20/20 passed.');
  }
  if(!stage){
    if(process.exitCode===0){
      const {UNAI_TEST_DATABASE_URL: _scratchUrl, ...storageEnv} = harness.env;
      await databaseRoundtrip(harness.container,harness.databaseUrl,{...process.env,...storageEnv},sourceEvidence);
    }
  }
} catch(error) {
  console.error(error.step?error.message:'TEST_HARNESS_FAILED: '+error.message); process.exitCode=1;
} finally {
  if(harness && !await harness.close())process.exitCode=1;
  if(sourceEvidence){
    try{
      const finalEvidence=await workspaceEvidence();
      if(finalEvidence.workspaceDigest!==sourceEvidence.workspaceDigest)process.exitCode=1;
      await mkdir('test-results/acceptance',{recursive:true});
      await writeFile(testReport+'.provenance.json',JSON.stringify({...sourceEvidence,completedAt:new Date().toISOString(),exitCode:process.exitCode??1},null,2)+'\n');
    }catch{console.error('TEST_PROVENANCE_WRITE_FAILED');process.exitCode=1;}
  }
}
