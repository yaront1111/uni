import {expect,it} from 'vitest';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readOperationsReport} from './operations-status';

it('returns no report when unconfigured and sanitizes malformed, missing and oversized report failures',async()=>{
  expect(await readOperationsReport('')).toEqual({report:null});
  const directory=await mkdtemp(join(tmpdir(),'unai-ops-reader-'));
  try{
    for(const body of ['{"format":"unai-operations/1"}', 'secret-do-not-expose', 'x'.repeat(1024*1024+1)]){
      const path=join(directory,'status.json');await writeFile(path,body);
      const result=await readOperationsReport(path);expect(result.report).toBeNull();
      expect(result.error).toBe('The operations evidence report could not be read or validated.');
      expect(JSON.stringify(result)).not.toContain(directory);
    }
    expect((await readOperationsReport(join(directory,'missing'))).report).toBeNull();
  }finally{await rm(directory,{recursive:true,force:true});}
});
