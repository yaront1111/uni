import {open} from 'node:fs/promises';
import {operationsReportSchema,type OperationsReport} from '@unai/domain';

/** Configuration points at an operator-published metadata report. Never accept
 * a path from the request or send an exception/path back to the browser. */
export async function readOperationsReport(path=process.env.UNAI_OPERATIONS_REPORT_FILE):Promise<{report:OperationsReport|null;error?:string}>{
  if(!path)return {report:null};
  try{
    const handle=await open(path,'r');
    try{
      const info=await handle.stat();
      if(!info.isFile()||info.size>1024*1024)throw new Error('REPORT_INVALID');
      const bytes=Buffer.alloc(1024*1024+1);
      let length=0;
      while(length<bytes.length){const read=await handle.read(bytes,length,bytes.length-length,null);if(!read.bytesRead)break;length+=read.bytesRead;}
      if(length>1024*1024)throw new Error('REPORT_INVALID');
      return {report:operationsReportSchema.parse(JSON.parse(bytes.subarray(0,length).toString('utf8')))};
    }finally{await handle.close();}
  }catch{return {report:null,error:'The operations evidence report could not be read or validated.'};}
}
