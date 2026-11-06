import {readFile,writeFile,rename,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {parseArguments,IMPLEMENTED,validateRecord} from './lib/rehearsal-record.mjs';

const failed=code=>process.stderr.write(JSON.stringify({event:'rehearsal.failed',code})+'\n');
async function writeRecord(path,record){
  const violations=validateRecord(record);
  if(violations.length)throw new Error(violations[0]);
  await mkdir(resolve(path,'..'),{recursive:true});
  const temporary=`${path}.${process.pid}.tmp`;
  await writeFile(temporary,JSON.stringify(record,null,2)+'\n',{mode:0o600,flag:'wx'});
  await rename(temporary,path);
}
async function verify(path){
  try{
    const errors=validateRecord(JSON.parse(await readFile(path,'utf8')));
    if(errors.length){failed(errors[0]);return 1;}
    process.stdout.write('{"event":"rehearsal.record","status":"PASS"}\n');return 0;
  }catch{failed('REHEARSAL_RECORD_INVALID');return 1;}
}
async function run(options){
  if(process.platform!=='linux'){failed('REHEARSAL_PLATFORM_UNSUPPORTED');return 1;}
  const {createRun}=await import('./rehearsal/host.mjs');
  const {servicePhases}=await import('./rehearsal/services.mjs');
  const {syncPhases}=await import('./rehearsal/sync.mjs');
  const run=await createRun(options),interrupted=new AbortController();
  Object.assign(run.phases,servicePhases,syncPhases);
  let signalCode=0,exitCode=0;
  const sigint=()=>{signalCode=130;interrupted.abort();};
  const sigterm=()=>{signalCode=143;interrupted.abort();};
  process.once('SIGINT',sigint);process.once('SIGTERM',sigterm);
  run.signal=interrupted.signal;
  try{
    for(const name of IMPLEMENTED.slice(0,IMPLEMENTED.indexOf(options.until)+1)){
      if(signalCode)break;
      const phase={name,status:'FAIL',commands:[]},start=Date.now();
      run.record.phases.push(phase);run.phase=phase;
      try{await run.phases[name](run);if(signalCode)throw new Error('REHEARSAL_INTERRUPTED');phase.status='PASS';}
      catch(error){phase.note=/^REHEARSAL_[A-Z_]+$/.test(error?.message)?error.message:'REHEARSAL_PHASE_FAILED';exitCode=1;}
      phase.durationMs=Date.now()-start;
      if(!phase.commands.length)phase.commands.push({argv:['phase',name],exitCode:null,durationMs:0,tail:phase.note??''});
      process.stdout.write(JSON.stringify({event:'rehearsal.phase',phase:name,status:phase.status,durationMs:phase.durationMs})+'\n');
      if(exitCode)break;
    }
  }finally{
    // Cleanup has its own deadline and never inherits the aborted command signal.
    try{await run.cleanup();}catch{exitCode=1;failed('REHEARSAL_CLEANUP_FAILED');}
    const last=run.record.phases.at(-1);
    if(last&&(signalCode||exitCode)&&last.status==='PASS'){
      last.status='FAIL';last.note=signalCode?'REHEARSAL_INTERRUPTED':'REHEARSAL_CLEANUP_FAILED';
    }
    run.record.completedAt=new Date().toISOString();
    if(options.record)await writeRecord(resolve(options.record),run.record);
    process.removeListener('SIGINT',sigint);process.removeListener('SIGTERM',sigterm);
  }
  return signalCode||exitCode;
}
async function main(){
  let options;
  try{options=parseArguments(process.argv.slice(2));}
  catch(error){failed(error.message);return 2;}
  if(options.help){process.stdout.write('Usage: node scripts/deploy-rehearsal.mjs [--record PATH] [--until PHASE] [--keep] | --verify-record PATH | --help\n');return 0;}
  if(options.verifyRecord)return verify(options.verifyRecord);
  try{return await run(options);}catch{failed('REHEARSAL_RUN_FAILED');return 1;}
}
process.exitCode=await main();
