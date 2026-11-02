import {expect,it} from 'vitest';
import {spawnSync} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,rm,symlink} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {tmpdir} from 'node:os';

const script=resolve('scripts/env-contract.mjs');
const document='docs/operations/environment.md';
const source='packages/x/src/a.ts';
const table=(rows:string,heading='API')=>`## ${heading}\n\n| Variable | Required / default | Kind | When read | Consumer | Failure when missing |\n| --- | --- | --- | --- | --- | --- |\n${rows}\n`;
const row=(name:string,consumer=`${source}:1`)=>`| \`${name}\` | required | literal | startup | ${consumer?`\`${consumer}\``:''} | none |`;
const run=(root:string,...args:string[])=>spawnSync(process.execPath,[script,'--root',root,...args],{encoding:'utf8'});
async function fixture(files:Record<string,string>,check:(root:string)=>void|Promise<void>){
  const root=await mkdtemp(join(tmpdir(),'unai-env-contract-'));
  try{
    for(const [path,content] of Object.entries(files)){
      await mkdir(dirname(join(root,path)),{recursive:true});
      await writeFile(join(root,path),content);
    }
    await check(root);
  }finally{await rm(root,{recursive:true,force:true});}
}

it('reports undocumented reads and unread rows, not documented reads',async()=>{
  await fixture({[document]:table([row('UNAI_FIXTURE_DOCUMENTED'),row('UNAI_FIXTURE_UNREAD')].join('\n')),
    [source]:'export const a = process.env.UNAI_FIXTURE_DOCUMENTED ?? process.env.UNAI_FAKE_VAR;'},root=>{
    const result=run(root);
    expect(result.status,result.stderr).toBe(1);
    expect(result.stderr).toContain(`ENV_CONTRACT_UNDOCUMENTED UNAI_FAKE_VAR ${source}:1`);
    expect(result.stderr).toContain('ENV_CONTRACT_UNREAD UNAI_FIXTURE_UNREAD');
    expect(result.stderr).not.toContain('UNAI_FIXTURE_DOCUMENTED');
    expect(result.stderr).toContain('ENV_CONTRACT_FAILED 2 issue(s); see docs/operations/environment.md');
  });
});

it('recognises member, literal-index and helper reads without counting keys or error codes',async()=>{
  const names=['BRACKET','ENV','SUFFIX','REQUIRED','SECRET','POOL','OPTIONAL','TEMPLATE','PROCESSING','NUMBER','SECRET_WRAPPER'];
  const reads=["process.env['UNAI_FIXTURE_BRACKET']",'env.UNAI_FIXTURE_ENV','storageEnv.UNAI_FIXTURE_SUFFIX',
    "required('UNAI_FIXTURE_REQUIRED')","requireSecret(secrets,'UNAI_FIXTURE_SECRET')",
    "databasePool('UNAI_FIXTURE_POOL','UNAI_FIXTURE_POOL_CODE')",'env?.UNAI_FIXTURE_OPTIONAL',
    'process.env[`UNAI_FIXTURE_TEMPLATE`]',"processingRequired(env,'UNAI_FIXTURE_PROCESSING')",
    "requiredNumber(env,'UNAI_FIXTURE_NUMBER')","secret('UNAI_FIXTURE_SECRET_WRAPPER')"];
  await fixture({[document]:table(''),[source]:[...reads,"const x={UNAI_FIXTURE_WRITE:'x'};",
    '// UNAI_FIXTURE_COMMENT',"new Error('UNAI_FIXTURE_ERROR');",'type E=Env[];','env[ ];'].join('\n'),
    'packages/x/src/b.test.ts':'process.env.UNAI_EXCLUDED_TEST',
    'packages/x/node_modules/dep/index.mjs':'process.env.UNAI_EXCLUDED_DEP',
    'packages/x/dist/out.mjs':'process.env.UNAI_EXCLUDED_DIST',
    'apps/web/.next/server/page.mjs':'process.env.UNAI_EXCLUDED_NEXT',
    'packages/x/.moe-next/t.ts':'process.env.UNAI_EXCLUDED_MOE',
    'other/outside.ts':'process.env.UNAI_EXCLUDED_OUTSIDE'},root=>{
    const result=run(root);
    expect(result.status).toBe(1);
    for(const [index,name] of names.entries())expect(result.stderr).toContain(`ENV_CONTRACT_UNDOCUMENTED UNAI_FIXTURE_${name} ${source}:${index+1}`);
    for(const name of ['POOL_CODE','WRITE','COMMENT','ERROR'])expect(result.stderr).not.toContain(`UNAI_FIXTURE_${name}`);
    expect(result.stderr).not.toContain('UNAI_EXCLUDED_');
    expect(result.stderr).not.toContain('ENV_CONTRACT_DYNAMIC_READ_UNREGISTERED');
  });
});

it('rejects computed reads in unregistered files and invalid consumer references',async()=>{
  await fixture({[document]:table(row('UNAI_FIXTURE_READ','packages/x/src/missing.ts:1'))+
    table(row('NODE_FIXTURE_EXTERNAL',''),'Read by Node.js and dependencies'),
    [source]:'process.env.UNAI_FIXTURE_READ;',
    'packages/x/src/c.ts':'export const need = (n: string) => process.env[n];'},root=>{
    const result=run(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('ENV_CONTRACT_DYNAMIC_READ_UNREGISTERED packages/x/src/c.ts:1');
    expect(result.stderr).toContain('ENV_CONTRACT_CONSUMER_INVALID UNAI_FIXTURE_READ packages/x/src/missing.ts:1');
    expect(result.stderr).not.toContain('NODE_FIXTURE_EXTERNAL');
  });
});

it('requires a consumer that reads the name and has an in-range line',async()=>{
  await fixture({[document]:table([row('UNAI_FIXTURE_READ',''),row('UNAI_FIXTURE_READ',`${source}:9`),
    row('UNAI_FIXTURE_READ','src/empty.ts:1'),row('UNAI_FIXTURE_READ',`${source}:0`)].join('\n')),
    [source]:'process.env.UNAI_FIXTURE_READ;', 'src/empty.ts':'export {};'},root=>{
    const result=run(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('ENV_CONTRACT_CONSUMER_REQUIRED UNAI_FIXTURE_READ');
    for(const ref of [`${source}:9`,'src/empty.ts:1',`${source}:0`]){
      expect(result.stderr).toContain(`ENV_CONTRACT_CONSUMER_INVALID UNAI_FIXTURE_READ ${ref}`);
    }
  });
});

it('accepts CRLF tables, grouped names, registered computed reads and file-level references',async()=>{
  const path='scripts/storage-harness.mjs';
  const doc=table(row('UNAI_FIXTURE_READ',`${source}:1`))+
    table('| `UNAI_FIXTURE_A`, `UNAI_FIXTURE_B` | required | literal | startup | `scripts/storage-harness.mjs:1` | none |')+
    '\n| Other | Consumer |\n| --- | --- |\n| `UNAI_NOT_A_ROW` | none |\n';
  await fixture({[document]:doc.replaceAll('\n','\r\n'),[source]:'// https://example.invalid\r\nprocess.env.UNAI_FIXTURE_READ;\r\n',
    [path]:"['UNAI_FIXTURE_A','UNAI_FIXTURE_B'].filter(name=>process.env[name]);"},root=>{
    const result=run(root);
    expect(result.status,result.stderr).toBe(0);
    expect(result.stdout).toBe('ENV_CONTRACT_PASS 3 variables, 2 files scanned\n');
    expect(result.stderr).toBe('');
  });
});

it('does not let an external row conceal a repository read',async()=>{
  await fixture({[document]:table(row('UNAI_FIXTURE_READ',''),'Read by Node.js and dependencies'),
    [source]:'process.env.UNAI_FIXTURE_READ;'},root=>{
    expect(run(root).stderr).toContain(`ENV_CONTRACT_UNDOCUMENTED UNAI_FIXTURE_READ ${source}:1`);
  });
});

it('ignores symlinked scan roots and nested directories',async()=>{
  await fixture({[document]:table(''),'outside/a.ts':'process.env.UNAI_SYMLINK_READ;','src/empty.ts':''},async root=>{
    await symlink(join(root,'outside'),join(root,'packages'),'junction');
    await symlink(join(root,'outside'),join(root,'src/linked'),'junction');
    const result=run(root);
    expect(result.status,result.stderr).toBe(0);
    expect(result.stdout).toBe('ENV_CONTRACT_PASS 0 variables, 1 files scanned\n');
  });
});

it('fails closed on a missing document or invalid arguments',async()=>{
  await fixture({},root=>{
    expect(run(root).status).toBe(1);
    expect(run(root).stderr).toBe('ENV_CONTRACT_DOCUMENT_MISSING\n');
    const invalid=run(root,'--unknown');
    expect(invalid.status).toBe(1);
    expect(invalid.stderr).toBe('ENV_CONTRACT_ARGUMENTS_INVALID\n');
    const missing=spawnSync(process.execPath,[script,'--root'],{encoding:'utf8'});
    expect(missing.status).toBe(1);
    expect(missing.stderr).toBe('ENV_CONTRACT_ARGUMENTS_INVALID\n');
  });
});

it('fails closed without leaking OS errors when the document cannot be read',async()=>{
  await fixture({[`${document}/child`]:'not a regular file'},root=>{
    const result=run(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toBe('ENV_CONTRACT_FAILED unable to read repository files\n');
  });
});

// Add this only with the contract document, so other shared-checkout suites stay green.
it('passes the repository contract from a different working directory',()=>{
  const result=spawnSync(process.execPath,[script],{cwd:tmpdir(),encoding:'utf8'});
  expect(result.status,result.stderr).toBe(0);
  expect(result.stderr).toBe('');
  expect(result.stdout).toMatch(/^ENV_CONTRACT_PASS /);
},30000);
