import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import {startStorageHarness} from './storage-harness.mjs';

const name = 'unai-test-' + randomUUID();
function docker(args) {
  const result = spawnSync('docker', args, { encoding:'utf8', timeout:120000 });
  if (result.error || result.status !== 0) throw new Error(result.stderr || String(result.error));
  return result.stdout.trim();
}
let created = false;
let storage;
try {
  console.log('Starting disposable PostgreSQL/pgvector for the full suite...');
  docker(['run','--detach','--rm','--name',name,'--publish','127.0.0.1::5432',
    '--env','POSTGRES_PASSWORD=unai-test-only','--env','POSTGRES_DB=unai_test',
    '--tmpfs','/var/lib/postgresql/data','pgvector/pgvector@sha256:cf134a767f474095eeba57e0117be8e568e011a63f33fbf252f14c9b760f8e6f']);
  created = true;
  const binding=JSON.parse(docker(['inspect','--format','{{json .NetworkSettings.Ports}}',name]))['5432/tcp'][0];
  let ready=false;
  for(let attempt=0;attempt<120;attempt++){
    const check=spawnSync('docker',['exec',name,'pg_isready','-U','postgres'],{stdio:'ignore'});
    if(check.status===0){ready=true;break;}
    await setTimeout(250);
  }
  if(!ready) throw new Error('Test PostgreSQL did not become ready');
  console.log('Starting disposable TLS/KMS object storage...');
  storage=await startStorageHarness();
  const test=spawnSync(process.execPath,['node_modules/vitest/vitest.mjs','run'],{
    stdio:'inherit',
    env:{...process.env,...storage.env,UNAI_TEST_DATABASE_URL:'postgresql://postgres:unai-test-only@127.0.0.1:'+binding.HostPort+'/unai_test'},
  });
  process.exitCode=test.status ?? 1;
} catch(error) {
  console.error(error.message); process.exitCode=1;
} finally {
  try{storage?.close();}catch(error){console.error('Storage cleanup failed:',error.message);process.exitCode=1;}
  if(created) {
    try { docker(['stop',name]); }
    catch(error) { console.error('Test container cleanup failed:',error.message); process.exitCode=1; }
  }
}


