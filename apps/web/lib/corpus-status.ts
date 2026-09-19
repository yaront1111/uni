import {readFile,realpath} from 'node:fs/promises';
import {isAbsolute,relative,resolve} from 'node:path';
import {corpusStatusSchema,type CorpusStatus} from '@unai/domain';

/** The Corpus and evaluation screen's only input: the report
 * `uai corpus status --report` wrote, named by UNAI_CORPUS_STATUS_FILE. It holds
 * counts and rates only. The web process never reads under the private corpus
 * (`corpus/private-local/` or UNAI_PRIVATE_CORPUS_DIR), so a status file placed
 * there is refused rather than read. */
const DEFAULT_PRIVATE_CORPUS_DIR='corpus/private-local';
const within=(directory:string,path:string)=>{
  const rel=relative(directory,path);
  return rel===''||(!rel.startsWith('..')&&!isAbsolute(rel));
};

export function privateCorpusPath(path:string,env:Readonly<Record<string,string|undefined>>=process.env,cwd=process.cwd()):boolean{
  const target=resolve(cwd,path);
  const directories=[resolve(cwd,DEFAULT_PRIVATE_CORPUS_DIR),...(env.UNAI_PRIVATE_CORPUS_DIR?[resolve(cwd,env.UNAI_PRIVATE_CORPUS_DIR)]:[])];
  // Any `corpus/private-local` segment counts, whatever the working directory.
  return directories.some(directory=>within(directory,target))
    ||target.replaceAll('\\','/').split('/').some((segment,index,all)=>segment==='private-local'&&all[index-1]==='corpus');
}

export async function readCorpusStatusReport(env:Readonly<Record<string,string|undefined>>=process.env,cwd=process.cwd())
  :Promise<{status:CorpusStatus|null;error?:string}>{
  const path=env.UNAI_CORPUS_STATUS_FILE;
  if(!path)return {status:null};
  const refused={status:null,error:'The corpus status report must not be kept under the private corpus path.'};
  if(privateCorpusPath(path,env,cwd))return refused;
  try{
    // A link into the private corpus is refused like the path itself.
    if(privateCorpusPath(await realpath(resolve(cwd,path)),env,cwd))return refused;
    const parsed=corpusStatusSchema.safeParse(JSON.parse(await readFile(resolve(cwd,path),'utf8')));
    return parsed.success?{status:parsed.data}:{status:null,error:'The corpus status report could not be read.'};
  }catch{
    return {status:null,error:'The corpus status report could not be read.'};
  }
}
