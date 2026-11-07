// Self-contained observation tool: copied into the disposable host, never shipped.
import {pathToFileURL} from 'node:url';
import {readFileSync,writeFileSync,readdirSync,statSync,mkdtempSync,rmSync} from 'node:fs';
import {execFileSync,spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
const services=['unai-api','unai-web','unai-worker'];
const scopes=['unai.api','unai.jobs','unai.postgres','unai.registry','unai.web','unai.pipeline'];
const fail=code=>{throw new Error(`REHEARSAL_${code}`);};
function targets(value){
  if(!value||typeof value!=='object')return 0;
  return Object.entries(value).reduce((n,[key,item])=>n+
    (key==='attributes'&&Array.isArray(item)?item.filter(a=>a?.key==='http.target').length:0)+targets(item),0);
}
function collect(output,resources,metrics){
  for(const resource of resources){
    const service=resource.resource?.attributes?.find(a=>a.key==='service.name')?.value?.stringValue;
    if(!services.includes(service))throw new Error('service');
    const entries=resource[metrics?'scopeMetrics':'scopeSpans'];
    if(!Array.isArray(entries)||!entries.length)throw new Error('scopes');
    for(const entry of entries){
      const name=entry.scope?.name;
      if(typeof name!=='string')throw new Error('scope');
      const count=entryCount(entry,metrics);
      if(!count)throw new Error('empty');
      if(!name.startsWith('unai.')){output.nonUnaiScopes++;if(name.startsWith('next'))output.nextScopes++;continue;}
      if(!scopes.includes(name))throw new Error('scope'); // Never turn arbitrary payload text into a public key.
      const counts=output.scopes[name.replaceAll('.','_')]??={spans:0,points:0};
      counts[metrics?'points':'spans']+=count;
    }
    output.services.add(service);
  }
}
function entryCount(entry,metrics){
  if(!metrics){if(!Array.isArray(entry.spans))throw new Error('spans');return entry.spans.length;}
  if(!Array.isArray(entry.metrics))throw new Error('metrics');
  let points=0;
  for(const metric of entry.metrics)for(const type of ['gauge','sum','histogram','exponentialHistogram','summary'])
    if(metric[type]){if(!Array.isArray(metric[type].dataPoints))throw new Error('points');points+=metric[type].dataPoints.length;}
  return points;
}
export function summarizeOtlp(lines){
  const output={services:new Set(),scopes:{},nonUnaiScopes:0,nextScopes:0,httpTargetAttributes:0,invalidLines:0};
  for(const line of lines){
    if(!line.trim())continue;
    try{
      const value=JSON.parse(line);
      output.httpTargetAttributes+=targets(value);
      if(!value||(!Array.isArray(value.resourceSpans)&&!Array.isArray(value.resourceMetrics)))throw new Error('export');
      if(value.resourceSpans)collect(output,value.resourceSpans,false);
      if(value.resourceMetrics)collect(output,value.resourceMetrics,true);
    }catch{output.invalidLines++;}
  }
  return {...output,services:[...output.services].sort()};
}
export function cspNonce(header){
  const directive=header.split(';').find(s=>/^\s*script-src\s/.test(s));
  const matches=[...(directive??'').matchAll(/'nonce-([A-Za-z0-9+/_=-]+)'/g)];
  return matches.length===1?matches[0][1]:null;
}
export function permissionAllows(header,feature,origin){
  const rule=header.split(',').map(s=>s.trim()).find(s=>s.startsWith(`${feature}=`));
  const values=rule?.slice(feature.length+1).match(/^\((.*)\)$/)?.[1].split(/\s+/)??[];
  return values.includes('self')||values.includes(`"${origin}"`);
}
export function classifyCdp(messages,loaderId){
  const out={status:null,csp:'',permissionsPolicy:'',cspEvents:0,cspConsole:0};
  for(const {method,params:p} of messages){
    if(method==='Network.responseReceived'&&p.type==='Document'&&p.loaderId===loaderId){
      const headers=Object.fromEntries(Object.entries(p.response.headers).map(([k,v])=>[k.toLowerCase(),v]));
      out.status=p.response.status;out.csp=headers['content-security-policy']??'';out.permissionsPolicy=headers['permissions-policy']??'';
    }
    if(method==='Runtime.bindingCalled'&&p.name==='rehearsalCsp')out.cspEvents++;
    if(['Log.entryAdded','Runtime.consoleAPICalled','Runtime.exceptionThrown'].includes(method)&&/content security policy/i.test(JSON.stringify(p)))out.cspConsole++;
  }
  return out;
}
export function noncedScripts(nonce,nonces){
  const nonced=nonces.filter(n=>Boolean(nonce)&&n===nonce).length;
  return {scripts:nonces.length,nonced,all:nonces.length>0&&nonced===nonces.length};
}
const command=(file,args)=>execFileSync(file,args,{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
export function collectorVersion(source){
  return source.match(/^(?:readonly )?OTELCOL_VERSION=['"]?(\d+\.\d+\.\d+)['"]?\r?$/m)?.[1]??null;
}
function collectorProof(){
  const source=readFileSync('/opt/unai/current/deploy/install.sh','utf8');
  const version=collectorVersion(source);
  const config=source.match(/collector_yaml=\$\(cat <<'EOF'\n([\s\S]*?)\nEOF\n\)/)?.[1];
  const dropIn=source.match(/collector_dropin=\$\(cat <<'EOF'\n([\s\S]*?)\nEOF\n\)/)?.[1];
  const pid=command('systemctl',['show','-p','MainPID','--value','otelcol-contrib']);
  const listeners=command('ss',['-Hltnp']).split('\n').filter(s=>s.includes(`pid=${pid},`)).map(s=>s.trim().split(/\s+/)[3]);
  return {versionMatches:Boolean(version)&&command('dpkg-query',['-W','-f=${Version}','otelcol-contrib'])===version,
    configMatches:Boolean(config)&&readFileSync('/etc/otelcol-contrib/unai.yaml','utf8').trim()===config.trim(),
    dropInPresent:Boolean(dropIn)&&readFileSync('/etc/systemd/system/otelcol-contrib.service.d/unai.conf','utf8').trim()===dropIn.trim()&&
      command('systemctl',['show','-p','ExecStart','--value','otelcol-contrib']).includes('--config=/etc/otelcol-contrib/unai.yaml'),
    active:command('systemctl',['is-active','otelcol-contrib'])==='active',loopbackOnly:listeners.length===1&&listeners[0]==='127.0.0.1:4318'};
}
function exporterFiles(directory){
  return readdirSync(directory).filter(name=>/^telemetry.*\.jsonl$/.test(name)).sort().map(name=>`${directory}/${name}`);
}
function snapshot(directory,path){
  const offsets=Object.fromEntries(exporterFiles(directory).map(file=>{const s=statSync(file);return [s.ino,s.size];}));
  writeFileSync(path,JSON.stringify(offsets),{mode:0o600});
}
function exporterLines(directory,offsets={}){
  return exporterFiles(directory).flatMap(file=>{
    const s=statSync(file),offset=offsets[s.ino]??0;
    if(s.size<offset)fail('TELEMETRY_TRUNCATED');
    const bytes=readFileSync(file).subarray(offset),end=bytes.lastIndexOf(10);
    // Ignore an in-progress last line; the bounded wait will read it again.
    return bytes.subarray(0,end+1).toString('utf8').split('\n');
  });
}
async function otlp(directory,path){
  const offsets=JSON.parse(readFileSync(path,'utf8')),deadline=Date.now()+45000;
  let missingServices;
  do{
    const fresh=summarizeOtlp(exporterLines(directory,offsets));
    missingServices=services.filter(s=>!fresh.services.includes(s));
    if(!missingServices.length)break;
    await delay(500);
  }while(Date.now()<deadline);
  return {...summarizeOtlp(exporterLines(directory)),missingServices,installedByBundle:collectorProof(),metricExportMs:5000};
}
async function until(predicate,timeout=30000){
  const deadline=Date.now()+timeout;
  do{const result=await predicate();if(result)return result;await delay(100);}while(Date.now()<deadline);
  fail('BROWSER_TIMEOUT');
}
async function connect(url){
  const socket=new WebSocket(url),pending=new Map(),messages=[];
  let sequence=0,lastNetwork=Date.now();
  try{await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('connect')),10000);
    socket.addEventListener('open',()=>{clearTimeout(timer);resolve();},{once:true});
    socket.addEventListener('error',()=>{clearTimeout(timer);reject(new Error('connect'));},{once:true});
  });}catch{socket.close();fail('BROWSER_CONNECT_FAILED');}
  socket.addEventListener('message',event=>{
    const message=JSON.parse(event.data);
    if(message.id){pending.get(message.id)?.(message);pending.delete(message.id);}
    else{messages.push(message);if(message.method.startsWith('Network.'))lastNetwork=Date.now();}
  });
  socket.addEventListener('close',()=>{for(const done of pending.values())done({error:true});pending.clear();});
  return {messages,get lastNetwork(){return lastNetwork;},close:()=>socket.close(),send:(method,params={})=>new Promise((resolve,reject)=>{
    const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(new Error('CDP_TIMEOUT'));},10000);
    pending.set(id,message=>{clearTimeout(timer);message.error?reject(new Error('CDP_FAILED')):resolve(message.result);});
    socket.send(JSON.stringify({id,method,params}));
  })};
}
async function evaluate(cdp,expression){
  const value=await cdp.send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
  if(value.exceptionDetails)fail('BROWSER_EVALUATION_FAILED');
  return value.result.value;
}
async function visit(cdp,origin,path){
  cdp.messages.length=0;
  const navigation=await cdp.send('Page.navigate',{url:origin+path});
  if(navigation.errorText||!navigation.loaderId)fail('BROWSER_NAVIGATION_FAILED');
  const start=Date.now();
  await until(()=>cdp.messages.some(m=>m.method==='Page.loadEventFired')&&Date.now()-cdp.lastNetwork>500&&Date.now()-start>1200);
  const response=classifyCdp(cdp.messages,navigation.loaderId);
  const data=await evaluate(cdp,'({path:location.pathname,nonces:Array.from(document.scripts,s=>s.nonce)})');
  const nonce=noncedScripts(cspNonce(response.csp),data.nonces);
  const result={status:response.status,cspEvents:response.cspEvents,cspConsole:response.cspConsole,
    scripts:nonce.scripts,nonced:nonce.nonced,allNonced:nonce.all,pathMatches:data.path===path};
  if(path==='/talk'){
    result.microphoneSelf=permissionAllows(response.permissionsPolicy,'microphone',origin);
    const permission=await evaluate(cdp,"navigator.permissions.query({name:'microphone'}).then(p=>p.state)");
    if(!['prompt','granted','denied'].includes(permission))fail('BROWSER_PERMISSION_INVALID');
    result.microphonePermission=permission;
  }
  return result;
}
async function browser(chrome,home,tokenPath,origin){
  const profile=mkdtempSync(`${home}/profile-`),hostname=new URL(origin).hostname;
  let child,closed,cdp,spawnFailed=false;
  try{
    child=spawn(chrome,['--headless',`--user-data-dir=${profile}`,'--remote-debugging-port=0','--remote-debugging-address=127.0.0.1',
      `--host-resolver-rules=MAP ${hostname} 127.0.0.1`,'--disable-dev-shm-usage','--no-sandbox','about:blank'],
      {env:{...process.env,HOME:home},stdio:'ignore',detached:true});
    child.on('error',()=>{spawnFailed=true;});
    closed=new Promise(resolve=>{child.once('close',resolve);child.once('error',resolve);});
    const port=await until(()=>{
      if(spawnFailed||child.exitCode!==null||child.signalCode!==null)fail('BROWSER_START_FAILED');
      try{return Number(readFileSync(`${profile}/DevToolsActivePort`,'utf8').split('\n')[0]);}catch{return false;}
    });
    const target=await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`,{method:'PUT',signal:AbortSignal.timeout(10000)})).json();
    cdp=await connect(target.webSocketDebuggerUrl);
    for(const domain of ['Page','Network','Runtime','Log'])await cdp.send(`${domain}.enable`);
    await cdp.send('Runtime.addBinding',{name:'rehearsalCsp'});
    await cdp.send('Page.addScriptToEvaluateOnNewDocument',{source:"addEventListener('securitypolicyviolation',e=>globalThis.rehearsalCsp(e.effectiveDirective))"});
    const pages={signin:await visit(cdp,origin,'/signin')};
    const cookie=await cdp.send('Network.setCookie',{name:'__Host-unai.session',value:readFileSync(tokenPath,'utf8').trim(),url:origin+'/',secure:true,httpOnly:true,path:'/'});
    if(cookie.success!==true)fail('BROWSER_SESSION_FAILED');
    for(const name of ['today','ask','talk'])pages[name]=await visit(cdp,origin,`/${name}`);
    const control=await visit(cdp,origin,'/rehearsal-unknown-page');
    return {pages,detectorControl:{status:control.status,cspEvents:control.cspEvents,cspConsole:control.cspConsole}};
  }finally{
    cdp?.close();
    try{
      if(child?.pid){try{process.kill(-child.pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw error;}}
      if(closed)await closed;
    }finally{rmSync(profile,{recursive:true,force:true});}
  }
}
async function main(){
  const [mode,...args]=process.argv.slice(2);
  if(mode==='snapshot'){snapshot(...args);return;}
  if(mode==='otlp'){process.stdout.write(JSON.stringify(await otlp(...args))+'\n');return;}
  if(mode==='browser'){process.stdout.write(JSON.stringify(await browser(...args))+'\n');return;}
  fail('OBSERVATION_ARGUMENTS_INVALID');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{await main();}catch(error){
    const code=/^REHEARSAL_[A-Z_]+$/.test(error?.message)?error.message:'REHEARSAL_OBSERVATION_FAILED';
    process.stderr.write(code+'\n');process.exitCode=1;
  }
}
