import {readFile,readdir,mkdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {workspaceEvidence} from './workspace-evidence.mjs';

const forbidden=name=>/(^|[/@_+\-])(cordum|cap)($|[/@_+\-])/i.test(name);
export async function auditPolicyDependencies(root=process.cwd()){
  const roots=['.',...(await readdir(join(root,'packages'))).map(p=>'packages/'+p),...(await readdir(join(root,'apps'))).map(p=>'apps/'+p)];
  const offenders=[];
  for(const directory of roots){
    const manifest=JSON.parse(await readFile(join(root,directory,'package.json'),'utf8'));
    for(const name of Object.keys({...manifest.dependencies,...manifest.devDependencies,...manifest.optionalDependencies,...manifest.peerDependencies}))
      if(forbidden(name))offenders.push(directory+':'+name);
  }
  const installed=await readdir(join(root,'node_modules/.pnpm'));
  if(!installed.length)throw new Error('DEPENDENCY_INSTALLATION_UNVERIFIED');
  for(const name of installed)if(forbidden(name))offenders.push('installed:'+name);
  const lock=await readFile(join(root,'pnpm-lock.yaml'),'utf8');
  for(const line of lock.split('\n'))if(/^\s{2,}['"]?[^\s]+:/.test(line)&&forbidden(line.trim().replace(/^['"]/,'')))offenders.push('lock:'+line.trim());
  return {format:'unai-local-policy-audit/1',checkedAt:new Date().toISOString(),result:offenders.length?'FAIL':'PASS',installedEntries:installed.length,offenders};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{
    const report={...await auditPolicyDependencies(),...await workspaceEvidence()};await mkdir('test-results/operations',{recursive:true});
    await writeFile('test-results/operations/dependencies.json',JSON.stringify(report,null,2)+'\n');
    console.log('Local policy dependency audit: '+report.result);if(report.result!=='PASS')process.exitCode=1;
  }catch{console.error('LOCAL_POLICY_AUDIT_UNVERIFIED');process.exitCode=1;}
}
