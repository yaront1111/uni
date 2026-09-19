import {spawnSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';

export async function workspaceEvidence(){
  const head=spawnSync('git',['rev-parse','HEAD'],{encoding:'utf8'});
  const listing=spawnSync('git',['ls-files','--cached','--others','--exclude-standard','-z'],{encoding:'utf8',maxBuffer:8*1024*1024});
  if(head.status!==0||listing.status!==0)throw new Error('WORKSPACE_EVIDENCE_UNAVAILABLE');
  const hash=createHash('sha256');
  for(const path of [...new Set(listing.stdout.split('\0').filter(Boolean))].sort()){
    hash.update(path+'\0');
    try{hash.update(createHash('sha256').update(await readFile(path)).digest('hex'));}
    catch(error){if(error.code!=='ENOENT')throw error;hash.update('DELETED');}
  }
  return {sourceCommit:head.stdout.trim(),workspaceDigest:hash.digest('hex')};
}
