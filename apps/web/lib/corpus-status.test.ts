import { afterEach,expect,it } from 'vitest';
import { mkdir,mkdtemp,rm,writeFile } from 'node:fs/promises';
import { readFileSync,readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { privateCorpusPath,readCorpusStatusReport } from './corpus-status';

const directories:string[]=[];
afterEach(async()=>{await Promise.all(directories.splice(0).map(path=>rm(path,{recursive:true,force:true})));});
const report={format:'unai-corpus-status/1'};

it('never reads a status file under the private corpus path or UNAI_PRIVATE_CORPUS_DIR',async()=>{
  const cwd=await mkdtemp(join(tmpdir(),'unai-web-corpus-'));
  directories.push(cwd);
  await mkdir(join(cwd,'corpus/private-local'),{recursive:true});
  await mkdir(join(cwd,'vault'),{recursive:true});
  await writeFile(join(cwd,'corpus/private-local/status.json'),JSON.stringify(report));
  await writeFile(join(cwd,'vault/status.json'),JSON.stringify(report));
  for(const path of ['corpus/private-local/status.json',join(cwd,'corpus','private-local','status.json'),'/elsewhere/corpus/private-local/x.json']){
    expect(privateCorpusPath(path,{},cwd)).toBe(true);
    expect(await readCorpusStatusReport({UNAI_CORPUS_STATUS_FILE:path},cwd))
      .toEqual({status:null,error:'The corpus status report must not be kept under the private corpus path.'});
  }
  expect(await readCorpusStatusReport({UNAI_CORPUS_STATUS_FILE:'vault/status.json',UNAI_PRIVATE_CORPUS_DIR:'vault'},cwd))
    .toMatchObject({status:null,error:'The corpus status report must not be kept under the private corpus path.'});
  // Outside it the report is read, and one that is not a status report is refused.
  expect(privateCorpusPath('reports/status.json',{},cwd)).toBe(false);
  expect(await readCorpusStatusReport({UNAI_CORPUS_STATUS_FILE:'vault/status.json'},cwd))
    .toEqual({status:null,error:'The corpus status report could not be read.'});
  expect(await readCorpusStatusReport({},cwd)).toEqual({status:null});
});

it('no route, proxy mapping or server module of the web application or the API names the private corpus or loads the corpus tooling',()=>{
  const sources=(directory:string):string[]=>readdirSync(directory,{withFileTypes:true}).flatMap(entry=>
    entry.isDirectory()?(['node_modules','.next'].includes(entry.name)?[]:sources(join(directory,entry.name)))
      :/\.(ts|tsx|js|mjs)$/.test(entry.name)&&!/\.test\.tsx?$/.test(entry.name)?[join(directory,entry.name)]:[]);
  const files=[...sources(resolve('apps/web')),...sources(resolve('packages/api/src'))];
  expect(files.length).toBeGreaterThan(10);
  const findings=files.filter(file=>!file.endsWith(join('lib','corpus-status.ts'))).filter(file=>
    /private-local|UNAI_PRIVATE_CORPUS_DIR|@unai\/registry|registry\/src\/corpus/.test(readFileSync(file,'utf8')));
  expect(findings).toEqual([]);
});
