import {realpathSync} from 'node:fs';
import {readFile,readdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {operationsReportSchema,type OperationsReport} from '../../packages/domain/src/index.js';

// ADR 0049: the release defect record is an export of the task board's open `bug:` rows.
type DefectRecord=OperationsReport['defects'];
type DefectItem=DefectRecord['items'][number];
type DefectCode='DEFECT_SOURCE_UNAVAILABLE'|'DEFECT_SOURCE_INVALID'|'DEFECT_SOURCE_EMPTY'|'DEFECT_RECORD_TOO_LARGE'|'DEFECT_RECORD_WRITE_FAILED';
/** Its message is only ever a code: never error text or file content. */
export class DefectExportError extends Error{
  constructor(code:DefectCode){super(code);this.name='DefectExportError';}
}

export const DEFECT_RECORD_PATH='docs/operations/release-input.json';
const BOARD_DIR=join('.moe','tasks');
/** Board rows only; the daemon's temporary files do not match. */
const ROW_FILE=/^task-[0-9a-f]{32}\.json$/;
const SEVERITY=new Map<string,DefectItem['priority']>([['CRITICAL','P0'],['HIGH','P1'],['MEDIUM','P2'],['LOW','P3']]);
const CLOSED=new Set(['DONE','ARCHIVED']);
const MAX_ITEMS=1000,MAX_DETAIL=2048;
const unreviewed=():DefectRecord=>({reviewedAt:null,items:[]});

function boardRow(raw:string):{id:string;title:string;status:string;priority:string}{
  let value:unknown;
  try{value=JSON.parse(raw);}catch{throw new DefectExportError('DEFECT_SOURCE_INVALID');}
  if(typeof value!=='object'||value===null||Array.isArray(value))throw new DefectExportError('DEFECT_SOURCE_INVALID');
  const {id,title,status,priority}=value as Record<string,unknown>;
  if(typeof id!=='string'||typeof title!=='string'||typeof status!=='string'||typeof priority!=='string')
    throw new DefectExportError('DEFECT_SOURCE_INVALID');
  return {id,title,status,priority};
}

/** At most MAX_DETAIL UTF-16 units, never ending on the high half of a surrogate pair. */
function cut(value:string):string{
  if(value.length<=MAX_DETAIL)return value;
  const last=value.charCodeAt(MAX_DETAIL-1);
  return value.slice(0,last>=0xd800&&last<=0xdbff?MAX_DETAIL-1:MAX_DETAIL);
}

/** An open `bug:` row as a defect item, else null. Every status but DONE and ARCHIVED is open. */
function defectItem(row:ReturnType<typeof boardRow>):DefectItem|null{
  const title=row.title.trim();
  if(!/^bug:/i.test(title)||CLOSED.has(row.status))return null;
  const priority=SEVERITY.get(row.priority);
  if(priority===undefined)throw new DefectExportError('DEFECT_SOURCE_INVALID');
  return {id:row.id,priority,category:/security/i.test(title)?'SECURITY':'CORRECTNESS',status:'OPEN',
    detail:cut(title.slice(4).trim()||title)};
}

/** The board's record at `now`, or null when the board directory does not exist. */
export async function exportBoardDefects(boardDir:string,now:Date):Promise<DefectRecord|null>{
  let names:string[];
  try{names=await readdir(boardDir);}
  catch(error){
    if((error as {code?:unknown}).code==='ENOENT')return null;
    throw new DefectExportError('DEFECT_SOURCE_UNAVAILABLE');
  }
  const files=names.filter(name=>ROW_FILE.test(name)).sort();
  if(files.length===0)throw new DefectExportError('DEFECT_SOURCE_EMPTY');
  const items:DefectItem[]=[];
  for(const file of files){
    let raw:string;
    try{raw=await readFile(join(boardDir,file),'utf8');}catch{throw new DefectExportError('DEFECT_SOURCE_UNAVAILABLE');}
    const item=defectItem(boardRow(raw));
    if(item)items.push(item);
  }
  if(items.length>MAX_ITEMS)throw new DefectExportError('DEFECT_RECORD_TOO_LARGE');
  items.sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
  const parsed=operationsReportSchema.shape.defects.safeParse({reviewedAt:now.toISOString(),source:'MOE_BOARD_BUG_ROWS',rowsScanned:files.length,items});
  if(!parsed.success)throw new DefectExportError('DEFECT_SOURCE_INVALID');
  return parsed.data;
}

/** The live board export when `.moe/tasks` exists; otherwise the committed record if it parses.
 * A board that exists but cannot be exported is unreviewed: it never falls back to the committed record. */
export async function gatherDefectRecord(repository:string,committed:unknown,now:Date):Promise<DefectRecord>{
  let live:DefectRecord|null;
  try{live=await exportBoardDefects(join(repository,BOARD_DIR),now);}catch{return unreviewed();}
  if(live!==null)return live;
  const parsed=operationsReportSchema.shape.defects.safeParse(committed);
  return parsed.success?parsed.data:unreviewed();
}

/** Replaces only `defects` in release-input.json, keeping every other key and its order; writes LF. */
export async function writeDefectRecord(repository:string,record:DefectRecord):Promise<void>{
  const path=join(repository,DEFECT_RECORD_PATH);
  let input:unknown;
  try{input=JSON.parse(await readFile(path,'utf8'));}catch{throw new DefectExportError('DEFECT_RECORD_WRITE_FAILED');}
  if(typeof input!=='object'||input===null||Array.isArray(input))throw new DefectExportError('DEFECT_RECORD_WRITE_FAILED');
  try{await writeFile(path,JSON.stringify({...input,defects:record},null,2)+'\n');}
  catch{throw new DefectExportError('DEFECT_RECORD_WRITE_FAILED');}
}

/** `pnpm ops:defects`: export the board under the working directory and record it. */
async function main():Promise<void>{
  const record=await exportBoardDefects(BOARD_DIR,new Date());
  if(record===null)throw new DefectExportError('DEFECT_SOURCE_UNAVAILABLE');
  await writeDefectRecord('.',record);
  const blocking=record.items.filter(item=>item.priority==='P0'||item.priority==='P1').length;
  console.log(JSON.stringify({defects:DEFECT_RECORD_PATH,rowsScanned:record.rowsScanned,open:record.items.length,blocking}));
}

function isEntry():boolean{
  const entry=process.argv[1];
  if(entry===undefined)return false;
  try{return import.meta.url===pathToFileURL(realpathSync(entry)).href;}catch{return false;}
}
if(isEntry())main().catch((error:unknown)=>{
  console.error(error instanceof DefectExportError?error.message:'DEFECT_RECORD_WRITE_FAILED');process.exitCode=1;
});
