import {spawn,spawnSync} from 'node:child_process';
import {mkdirSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {randomUUID} from 'node:crypto';

/** Runtime-only ownership ledger. Entries precede allocation, including partial
 * allocations. A failed child/container removal retains its parent secret mount.
 * Cleanup is serialized, retryable, and never reports success for a live entry. */
export class DisposableStackResources {
  #entries=[];
  #cleaning;
  #sealed=false;
  own(kind,id,remove,describe=()=>({})){
    if(this.#sealed)throw new Error('DEV_STACK_LEDGER_CLOSED');
    if(this.#entries.some(entry=>entry.kind===kind&&entry.id===id))throw new Error('DEV_STACK_DUPLICATE_RESOURCE');
    this.#entries.push({kind,id,remove,describe,removed:false});
  }
  snapshot(){return this.#entries.map(({kind,id,removed,describe})=>({kind,id,removed,...describe()}));}
  cleanup(){
    if(this.#cleaning)return this.#cleaning;
    this.#sealed=true;
    this.#cleaning=(async()=>{
      for(const entry of [...this.#entries].reverse()){
        if(entry.removed)continue;
        try{await entry.remove();entry.removed=true;}
        catch{throw new Error('DEV_STACK_CLEANUP_FAILED');}
      }
    })().finally(()=>{this.#cleaning=undefined;});
    return this.#cleaning;
  }
}

/** Captures and discards driver diagnostics: they can include credentials. */
export function command(program,args,{env=process.env,timeout=120000}={}){
  return new Promise((resolvePromise,reject)=>{
    const child=spawn(program,args,{env,windowsHide:true,stdio:['ignore','pipe','pipe']});
    let stdout='',overflow=false;
    child.stdout.on('data',chunk=>{if(stdout.length<1024*1024)stdout+=chunk;else overflow=true;});
    child.stderr.resume();
    const timer=setTimeout(()=>child.kill('SIGKILL'),timeout);
    child.once('error',()=>{clearTimeout(timer);reject(new Error('DEV_STACK_COMMAND_FAILED'));});
    child.once('close',code=>{clearTimeout(timer);code===0&&!overflow?resolvePromise(stdout.trim()):reject(new Error('DEV_STACK_COMMAND_FAILED'));});
  });
}

/** Create an ACL-protected parent before any credential bytes are written. */
export async function privateDirectory(resources){
  const root=resolve(join(tmpdir(),'unai-dev-stack-'+randomUUID()));
  let created=false;
  resources.own('directory',root,async()=>{
    if(!created)return;
    if(dirname(root)!==resolve(tmpdir())||!root.startsWith(join(resolve(tmpdir()),'unai-dev-stack-')))throw new Error('DEV_STACK_UNSAFE_CLEANUP');
    rmSync(root,{recursive:true,force:true,maxRetries:20,retryDelay:100});
    if(existsSync(root))throw new Error('DEV_STACK_CLEANUP_FAILED');
  });
  mkdirSync(root,{mode:0o700});
  created=true;
  if(process.platform==='win32'){
    const identity=await command('whoami',['/user','/fo','csv','/nh']);
    const sid=identity.match(/S-1-5-[0-9-]+/)?.[0];
    if(!sid)throw new Error('DEV_STACK_SECRET_PROTECTION_FAILED');
    await command('icacls',[root,'/inheritance:r','/grant:r','*'+sid+':(OI)(CI)F','*S-1-5-18:(OI)(CI)F']);
  }
  mkdirSync(join(root,'runtime'),{mode:0o700});
  resources.own('secrets-mount',root,async()=>{}); // parent removal disposes the mounted provider
  return root;
}
export function writeProtected(path,value){writeFileSync(path,value,{mode:0o600,flag:'wx'});}

/** Label check prevents a failed name collision from deleting an unrelated DB. */
export function ownContainer(resources,name,invocation){
  resources.own('container',name,async()=>{
    const names=await command('docker',['ps','--all','--format','{{.Names}}']);
    if(!names.split('\n').includes(name))return;
    const owner=await command('docker',['inspect','--format','{{index .Config.Labels "unai.dev-stack.owner"}}',name]);
    if(owner!==invocation)throw new Error('DEV_STACK_CONTAINER_OWNERSHIP_MISMATCH');
    await command('docker',['rm','--force','--volumes',name]);
    const remaining=await command('docker',['ps','--all','--filter','name=^/'+name+'$','--format','{{.Names}}']);
    if(remaining)throw new Error('DEV_STACK_CLEANUP_FAILED');
  });
}

export function spawnOwnedChild(resources,role,args,env,onExit){
  let child,closed=false;
  let resolveClosed;
  const completion=new Promise(resolvePromise=>{resolveClosed=resolvePromise;});
  resources.own('child',role,async()=>{
    if(!child||closed)return;
    child.kill('SIGTERM');
    const timer=setTimeout(()=>{
      if(process.platform==='win32')spawnSync('taskkill',['/pid',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
      else child.kill('SIGKILL');
    },2000);
    try{await completion;}finally{clearTimeout(timer);}
  },()=>({pid:child?.pid}));
  child=spawn(process.execPath,args,{env,windowsHide:true,stdio:['ignore','ignore','ignore','ipc']});
  // exit, not close: IPC or a descendant may keep stdio open after process death.
  child.once('error',()=>{closed=true;resolveClosed();onExit(role);});
  child.once('exit',()=>{closed=true;resolveClosed();onExit(role);});
  const ready=new Promise((resolvePromise,reject)=>{
    const timer=setTimeout(()=>reject(new Error('DEV_STACK_CHILD_NOT_READY')),10000);
    const finish=()=>{clearTimeout(timer);reject(new Error('DEV_STACK_CHILD_NOT_READY'));};
    child.once('error',finish);child.once('exit',finish);
    child.on('message',message=>{
      if(message?.type!=='ready')return;
      clearTimeout(timer);child.off('error',finish);child.off('exit',finish);resolvePromise();
    });
  });
  return {child,ready};
}
