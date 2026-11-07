import {afterEach,expect,it} from 'vitest';
import {spawnSync} from 'node:child_process';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {evaluateV0Release,operationsReportSchema} from '../../packages/domain/src/index.js';
import {DefectExportError,exportBoardDefects,gatherDefectRecord,writeDefectRecord} from './defects.js';

const cliPath=resolve('src/operations/defects.ts');
const tsx=createRequire(import.meta.url).resolve('tsx/cli');
const NOW=new Date('2026-11-07T12:00:00.000Z');
const directories:string[]=[];
afterEach(async()=>{await Promise.all(directories.splice(0).map(path=>rm(path,{recursive:true,force:true})));});

const id=(n:number)=>'task-'+n.toString(16).padStart(32,'0');
type Row={title:string;status:string;priority:string};
async function repository(){const path=await mkdtemp(join(tmpdir(),'unai-defects-'));directories.push(path);return path;}
/** A repository whose `.moe/tasks` holds one file per row (row n gets id(n+1)) plus any extra raw files. */
async function board(rows:Row[],extra:Record<string,string>={}){
  const repo=await repository();const dir=join(repo,'.moe','tasks');await mkdir(dir,{recursive:true});
  await Promise.all(rows.map((row,i)=>writeFile(join(dir,id(i+1)+'.json'),JSON.stringify({id:id(i+1),epicId:'epic-1',description:'not exported',...row}))));
  for(const [name,body] of Object.entries(extra))await writeFile(join(dir,name),body);
  return {repo,dir};
}
/** ADR 0049's fixture: three open defects among closed, archived and non-defect rows. */
const MIXED:Row[]=[
  {title:'bug: POST /v1/x answers 500',status:'BACKLOG',priority:'HIGH'},
  {title:'bug: fixed long ago',status:'DONE',priority:'CRITICAL'},
  {title:'bug: shelved',status:'ARCHIVED',priority:'HIGH'},
  {title:'Feature: not a defect',status:'WORKING',priority:'HIGH'},
  {title:'  Bug: Security headers missing on 404',status:'REVIEW',priority:'LOW'},
  {title:'BUG:',status:'BLOCKED',priority:'CRITICAL'},
];
const TMP={[id(99)+'.json.tmp']:'{"id":"torn'};
async function refusal(promise:Promise<unknown>){
  const error=await promise.then(()=>null,(caught:unknown)=>caught);
  expect(error).toBeInstanceOf(DefectExportError);
  return (error as Error).message;
}
/** A full report like src/operations/evidence.test.ts builds, carrying the given defect record. */
function report(defects:unknown,checkedAt=NOW.toISOString()){
  return operationsReportSchema.parse({format:'unai-operations/1',checkedAt,sourceCommit:'a'.repeat(40),workspaceClean:true,
    procedures:[],restore:{result:'UNVERIFIED',emptyEnvironment:false,objectsRestored:false,keyRecoveryVerified:false,backupRef:null,fixtures:[]},
    adr:{inventoryReviewedAt:null,initialPaths:['docs/adr/0001-reference-stack.md'],entries:[],deviations:[]},defects,ci:null,
    localPolicy:{result:'UNVERIFIED',dependencyAuditRef:null,e2eRef:null},realCorpus:{result:'FAIL',failures:['REAL_RESULTS_MISSING']},
    liveConnectors:{recordRef:null,record:null,failure:'LIVE_RECORD_MISSING'},registryTags:{failure:null,tags:[]},recordedCommits:[]});
}
const defectGate=(defects:unknown,checkedAt?:string)=>evaluateV0Release(report(defects,checkedAt)).find(g=>g.criterion==='CRT-OPS-03-A')!.passed;

it('exports only the open bug: rows, with severity from priority and category from the title (ADR 0049)',async()=>{
  const {dir}=await board(MIXED,TMP);
  expect(await exportBoardDefects(dir,NOW)).toEqual({reviewedAt:NOW.toISOString(),source:'MOE_BOARD_BUG_ROWS',rowsScanned:6,items:[
    {id:id(1),priority:'P1',category:'CORRECTNESS',status:'OPEN',detail:'POST /v1/x answers 500'},
    {id:id(5),priority:'P3',category:'SECURITY',status:'OPEN',detail:'Security headers missing on 404'},
    {id:id(6),priority:'P0',category:'CORRECTNESS',status:'OPEN',detail:'BUG:'},
  ]});
});
it('cuts a long title to 2048 UTF-16 units without splitting a surrogate pair',async()=>{
  const {dir}=await board([
    {title:'bug: '+'a'.repeat(2047)+'\u{1F600}',status:'BACKLOG',priority:'MEDIUM'},
    {title:'bug: '+'b'.repeat(3000),status:'BACKLOG',priority:'MEDIUM'},
  ]);
  const record=await exportBoardDefects(dir,NOW);
  expect(record?.items.map(item=>item.detail)).toEqual(['a'.repeat(2047),'b'.repeat(2048)]);
});
it('fails CRT-OPS-03-A on an export holding an open HIGH bug and passes one whose only open bug is MEDIUM',async()=>{
  const blocking=await exportBoardDefects((await board(MIXED,TMP)).dir,NOW);
  expect(defectGate(blocking)).toBe(false);
  const minor=await exportBoardDefects((await board([{title:'bug: cosmetic',status:'PLANNING',priority:'MEDIUM'},
    {title:'bug: was serious',status:'DONE',priority:'HIGH'},{title:'Deploy: high but not a defect',status:'WORKING',priority:'CRITICAL'}])).dir,NOW);
  expect(minor?.items).toHaveLength(1);
  expect(defectGate(minor)).toBe(true);
  expect(defectGate(minor,new Date(NOW.getTime()+24*60*60*1000+1).toISOString())).toBe(false);
});
it('reads the live board when present and never the committed record beside it',async()=>{
  const committed={reviewedAt:NOW.toISOString(),source:'MOE_BOARD_BUG_ROWS',rowsScanned:9,items:[]};
  const {repo}=await board(MIXED,TMP);
  const live=await gatherDefectRecord(repo,committed,NOW);
  expect(live.rowsScanned).toBe(6);expect(live.items).toHaveLength(3);
  const corrupt=await board(MIXED,{[id(50)+'.json']:'{"id":'});
  expect(await gatherDefectRecord(corrupt.repo,committed,NOW)).toEqual({reviewedAt:null,items:[]});
  const empty=await board([]);
  expect(await gatherDefectRecord(empty.repo,committed,NOW)).toEqual({reviewedAt:null,items:[]});
});
it('uses the committed record only without a board, and an invalid or absent one is unreviewed',async()=>{
  const repo=await repository();
  const committed={reviewedAt:'2026-11-07T11:00:00.000Z',source:'MOE_BOARD_BUG_ROWS',rowsScanned:4,items:[]};
  expect(await gatherDefectRecord(repo,committed,NOW)).toEqual(committed);
  for(const value of [undefined,null,'2026-09-19',{reviewedAt:'yesterday',items:[]},{...committed,extra:1}])
    expect(await gatherDefectRecord(repo,value,NOW)).toEqual({reviewedAt:null,items:[]});
  expect(defectGate(await gatherDefectRecord(repo,undefined,NOW))).toBe(false);
});
it('replaces only the defects key of release-input.json and writes LF',async()=>{
  const repo=await repository();await mkdir(join(repo,'docs','operations'),{recursive:true});
  const path=join(repo,'docs','operations','release-input.json');
  const input={adrInventoryReviewedAt:'2026-09-19T16:05:50.287Z',deviations:[{requirement:'R',adrPath:'docs/adr/0011-x.md',implementedAt:'2026-09-17T06:28:14.000Z'}],
    defects:{reviewedAt:'2026-09-19T16:08:01.816Z',items:[]},ci:null,restore:{result:'UNVERIFIED',fixtures:[]}};
  await writeFile(path,JSON.stringify(input,null,2).replaceAll('\n','\r\n')+'\r\n');
  const record=(await exportBoardDefects((await board(MIXED)).dir,NOW))!;
  await writeDefectRecord(repo,record);
  const text=await readFile(path,'utf8');const written=JSON.parse(text);
  expect(text.endsWith('}\n')).toBe(true);expect(text).not.toContain('\r');
  expect(Object.keys(written)).toEqual(Object.keys(input));
  expect({...written,defects:null}).toEqual({...input,defects:null});
  expect(written.defects).toEqual(record);
  const {defects:_,...withoutDefects}=input;await writeFile(path,JSON.stringify(withoutDefects,null,2)+'\n');
  await writeDefectRecord(repo,record);
  const appended=JSON.parse(await readFile(path,'utf8'));
  expect(Object.keys(appended)).toEqual([...Object.keys(withoutDefects),'defects']);expect(appended.defects).toEqual(record);
  await writeFile(path,'[]\n');
  expect(await refusal(writeDefectRecord(repo,record))).toBe('DEFECT_RECORD_WRITE_FAILED');
});
it('answers null for a missing board and refuses a bad one with a bare code',async()=>{
  const repo=await repository();
  expect(await exportBoardDefects(join(repo,'.moe','tasks'),NOW)).toBeNull();
  await writeFile(join(repo,'not-a-directory'),'x');
  expect(await refusal(exportBoardDefects(join(repo,'not-a-directory'),NOW))).toBe('DEFECT_SOURCE_UNAVAILABLE');
  expect(await refusal(exportBoardDefects((await board([])).dir,NOW))).toBe('DEFECT_SOURCE_EMPTY');
  expect(await refusal(exportBoardDefects((await board([],TMP)).dir,NOW))).toBe('DEFECT_SOURCE_EMPTY');
  expect(await refusal(exportBoardDefects((await board([{title:'bug: x',status:'BACKLOG',priority:'URGENT'}])).dir,NOW))).toBe('DEFECT_SOURCE_INVALID');
  expect(await refusal(exportBoardDefects((await board([{title:'bug: x',status:'BACKLOG',priority:'constructor'}])).dir,NOW))).toBe('DEFECT_SOURCE_INVALID');
  for(const body of ['{"id":','[]','null','"bug: x"','{"id":"task-1","title":"bug: x","status":"BACKLOG"}','{"id":7,"title":"bug: x","status":"BACKLOG","priority":"HIGH"}'])
    expect(await refusal(exportBoardDefects((await board([],{[id(7)+'.json']:body})).dir,NOW))).toBe('DEFECT_SOURCE_INVALID');
  const many=Array.from({length:1001},(_,i)=>({title:'bug: '+i,status:'BACKLOG',priority:'LOW'}));
  expect(await refusal(exportBoardDefects((await board(many)).dir,NOW))).toBe('DEFECT_RECORD_TOO_LARGE');
});
it('pnpm ops:defects writes the board export into release-input.json, and refuses without a board',async()=>{
  const {repo}=await board(MIXED,TMP);await mkdir(join(repo,'docs','operations'),{recursive:true});
  const path=join(repo,'docs','operations','release-input.json');
  await writeFile(path,JSON.stringify({adrInventoryReviewedAt:null,ci:null},null,2)+'\n');
  const run=(cwd:string)=>spawnSync(process.execPath,[tsx,cliPath],{cwd,encoding:'utf8',timeout:60000});
  const ok=run(repo);
  expect(ok.stderr).toBe('');expect(ok.status).toBe(0);
  expect(JSON.parse(ok.stdout)).toEqual({defects:'docs/operations/release-input.json',rowsScanned:6,open:3,blocking:2});
  const written=JSON.parse(await readFile(path,'utf8'));
  expect(Object.keys(written)).toEqual(['adrInventoryReviewedAt','ci','defects']);
  expect(written.defects).toMatchObject({source:'MOE_BOARD_BUG_ROWS',rowsScanned:6});expect(written.defects.items).toHaveLength(3);
  const bare=await repository();
  const refused=run(bare);
  expect(refused.status).toBe(1);expect(refused.stdout).toBe('');expect(refused.stderr.trim()).toBe('DEFECT_SOURCE_UNAVAILABLE');
},120000);
