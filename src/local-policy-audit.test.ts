import {it,expect} from 'vitest';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';

it('refuses a declared or transitive Cordum/CAP dependency and permits capabilities',async()=>{
  const root=await mkdtemp(join(tmpdir(),'unai-policy-audit-'));
  try{
    await mkdir(join(root,'node_modules/.pnpm'),{recursive:true});
    await mkdir(join(root,'packages'));await mkdir(join(root,'apps'));
    await writeFile(join(root,'package.json'),JSON.stringify({dependencies:{'@unai/capabilities':'workspace:*'}}));
    await writeFile(join(root,'pnpm-lock.yaml'),'packages: {}');
    await mkdir(join(root,'node_modules/.pnpm/typescript@5.9.3'));
    const check=()=>spawnSync(process.execPath,['--input-type=module','-e',
      "import {auditPolicyDependencies} from './scripts/local-policy-audit.mjs';const r=await auditPolicyDependencies(process.argv[1]);process.stdout.write(JSON.stringify(r));",root],{encoding:'utf8'});
    let run=check();expect(run.status,run.stderr).toBe(0);expect(JSON.parse(run.stdout).result).toBe('PASS');
    await mkdir(join(root,'node_modules/.pnpm/@cordum+cap@1.0.0'));
    run=check();expect(run.status,run.stderr).toBe(0);expect(JSON.parse(run.stdout).result).toBe('FAIL');
  }finally{await rm(root,{recursive:true,force:true});}
});
