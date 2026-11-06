import {spawn} from 'node:child_process';
import {constants} from 'node:os';
import {provisionHarness} from './harness.mjs';

/** Run `node scripts/with-harness.mjs -- <command> [args...]` on disposable
 * PostgreSQL/pgvector, Git migrations and TLS/KMS storage, then tear it down.
 * Exits with the command's code, or 128 + signal number; usage is 2,
 * provisioning/forcing cleanup failure is 1, and command spawn failure is 127.
 * Test infrastructure only: it creates and drops databases; never reference it
 * from a package.json start script, a systemd unit or deploy/, and never deliver
 * a real database or bucket.
 * No shell: on Windows name an executable (`node ...`), not a .cmd shim such as
 * pnpm.cmd, which spawn refuses with EINVAL. Windows does not deliver SIGTERM.
 * SIGINT/SIGTERM are forwarded without escalation: an ignoring child keeps us
 * waiting. Terminal Ctrl-C may also reach the child through its process group.
 */
const [separator, command, ...args] = process.argv.slice(2);
if(separator !== '--' || !command){
  console.error('WITH_HARNESS_ARGUMENTS_INVALID: usage: node scripts/with-harness.mjs -- <command> [args...]');
  process.exitCode = 2;
}else{
  await run(command,args);
}

function runCommand(command,args,env,state){
  return new Promise(resolve=>{
    let spawned=false,failed=false;
    const fail=error=>{
      failed=true;
      console.error('WITH_HARNESS_COMMAND_FAILED: '+error.code);
    };
    try{
      const child=spawn(command,args,{stdio:'inherit',env});
      state.child=child;
      child.once('spawn',()=>{spawned=true;});
      child.on('error',error=>{if(!spawned)fail(error);});
      child.once('exit',()=>{state.finished=true;});
      child.once('close',(status,signal)=>{
        state.finished=true;
        resolve(failed?127:(status ?? 128+constants.signals[signal]));
      });
    }catch(error){
      fail(error);
      state.finished=true;
      resolve(127);
    }
  });
}

async function run(command,args){
  const state={child:null,finished:false,signal:null};
  const forward=signal=>{
    if(state.finished)return;
    if(state.child)state.child.kill(signal);
    else state.signal ??= signal;
  };
  process.on('SIGINT',()=>forward('SIGINT'));
  process.on('SIGTERM',()=>forward('SIGTERM'));
  let harness,code=1;
  try{
    harness=await provisionHarness({delivered:process.env.UNAI_TEST_DATABASE_URL ?? process.env.DATABASE_URL});
    code=state.signal?128+constants.signals[state.signal]:
      await runCommand(command,args,{...process.env,...harness.env},state);
  }catch(error){
    console.error(error.step?error.message:'TEST_HARNESS_FAILED: '+error.message);
  }finally{
    state.finished=true;
    const ok=harness?await harness.close():true;
    process.exitCode=ok?code:1;
  }
}
