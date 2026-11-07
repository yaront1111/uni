// Pure parsers and verdicts for rehearsal 2/4 (services, probes, smoke, failed-start,
// sync). No I/O. A verdict returns only numbers, booleans and status words for a
// phase's `assertions`, never raw output, and refuses with a bare REHEARSAL_ code.
const invalid=code=>{throw new Error(`REHEARSAL_${code}`);};
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const exactly=(value,names)=>object(value)&&Object.keys(value).length===names.length&&names.every(name=>Object.hasOwn(value,name));
const whole=value=>Number.isSafeInteger(value)&&value>=0;

/** `@@name` delimited blocks of an in-host report; every named block must be present once. */
export function report(text,names){
  const found={};let current;
  for(const line of String(text).split('\n')){
    const head=/^@@([a-z][a-z0-9-]*)$/.exec(line.trimEnd());
    if(head){
      if(Object.hasOwn(found,head[1]))invalid('REPORT_INVALID');
      current=head[1];found[current]=[];
    }else if(current)found[current].push(line);
  }
  if(names.some(name=>!Object.hasOwn(found,name)))invalid('REPORT_INVALID');
  return Object.fromEntries(Object.entries(found).map(([name,lines])=>[name,lines.join('\n').trim()]));
}
export function count(text){
  if(!/^\d{1,9}$/.test(String(text).trim()))invalid('REPORT_INVALID');
  return Number(text);
}
function jsonLines(text){
  const values=[];
  for(const line of String(text).split('\n')){
    if(!line.trim().startsWith('{'))continue;
    try{const value=JSON.parse(line);if(object(value))values.push(value);}catch{/* not a product line */}
  }
  return values;
}

/** The API prints one listening line, last (packages/api/src/server.ts). */
export function listeningVerdict(text,port){
  const lines=jsonLines(text).filter(value=>value.event==='listening');
  if(lines.length!==1||!exactly(lines[0],['event','port'])||lines[0].port!==port)invalid('LISTENING_INVALID');
  return {count:1,port};
}
/** Every named preflight check, in order, ok with code OK: no warning admitted. */
export function checksPassed(text,names){
  const lines=jsonLines(text).filter(value=>typeof value.check==='string');
  if(lines.length!==names.length||lines.some((line,index)=>!exactly(line,['check','status','code'])||
    line.check!==names[index]||line.status!=='ok'||line.code!=='OK'))invalid('PREFLIGHT_EVIDENCE_INVALID');
  return Object.fromEntries(names.map(name=>[name,'ok']));
}
const PROBES={healthz:[],api:['database','encryption_at_rest','object_store','registry_release','tls_certificate'],
  worker:['database','registry_release','loop']};
/** Health bodies carry status words only (packages/api/src/probes.ts). */
export function probeVerdict(body,kind){
  if(!Object.hasOwn(PROBES,kind))invalid('PROBE_INVALID');
  let value;try{value=JSON.parse(body);}catch{invalid('PROBE_INVALID');}
  if(kind==='healthz'){
    if(!exactly(value,['status'])||value.status!=='ok')invalid('PROBE_INVALID');
    return {status:'ok'};
  }
  const names=PROBES[kind];
  if(!exactly(value,['status','checks'])||value.status!=='ready'||!exactly(value.checks,names)||
    names.some(name=>value.checks[name]!=='ok'))invalid('PROBE_INVALID');
  return {status:'ready',checks:Object.fromEntries(names.map(name=>[name,'ok']))};
}

/** One response head as `curl -D -` prints it; a repeated header is refused. */
export function httpHead(text){
  const lines=String(text).replace(/\r/g,'').split('\n'),starts=[];
  lines.forEach((line,index)=>{if(/^HTTP\/[\d.]+ \d{3}\b/.test(line))starts.push(index);});
  if(starts.length!==1)invalid('HTTP_RESPONSE_INVALID');
  const status=Number(/^HTTP\/[\d.]+ (\d{3})/.exec(lines[starts[0]])[1]),headers={};
  for(const line of lines.slice(starts[0]+1)){
    const match=/^([A-Za-z0-9-]+):[ \t]*(.*)$/.exec(line);
    if(!match)continue;
    const name=match[1].toLowerCase();
    if(Object.hasOwn(headers,name))invalid('HTTP_RESPONSE_INVALID');
    headers[name]=match[2].trim();
  }
  return {status,headers};
}
/** script-src needs a nonce and no unsafe source; style-src may keep 'unsafe-inline' (apps/web CLAUDE.md). */
export function securityHeaderProblems(headers){
  const problems=[],csp=headers['content-security-policy'];
  const script=csp?.split(';').map(part=>part.trim()).find(part=>/^script-src\s/.test(part));
  if(!csp)problems.push('CSP_MISSING');
  else if(!script||!/'nonce-(?:\[REDACTED\]|[A-Za-z0-9+/_-]{16,}={0,2})'/.test(script))problems.push('CSP_NONCE_MISSING');
  if(script&&/'unsafe-(?:inline|eval|hashes)'/.test(script))problems.push('CSP_SCRIPT_UNSAFE');
  if(!headers['permissions-policy'])problems.push('PERMISSIONS_POLICY_MISSING');
  const hsts=/(?:^|;)\s*max-age=(\d+)\s*(?:;|$)/i.exec(headers['strict-transport-security']??'');
  if(!hsts)problems.push('HSTS_MISSING');
  else if(Number(hsts[1])<31536000)problems.push('HSTS_TOO_SHORT');
  return problems;
}
/** `/signin` answers 200; `/` without a session answers 307 to /signin (comment-267527d1 (3)). */
export function webVerdict(text,path){
  const {status,headers}=httpHead(text),problems=securityHeaderProblems(headers);
  if(problems.length)invalid(problems[0]);
  if(path==='/signin'&&status===200)return {status,securityHeaders:true};
  if(path==='/'&&status===307&&headers.location==='/signin')return {status,signinRedirect:true,securityHeaders:true};
  invalid('WEB_STATUS_INVALID');
}
/** Plain HTTP to the TLS listener gets no HTTP answer at all: curl 52 or 56, never 426. */
export function plainHttpVerdict(exitCode,text){
  if(![52,56].includes(exitCode)||/^HTTP\//m.test(String(text)))invalid('PLAIN_HTTP_ANSWERED');
  return {curlExit:exitCode,httpResponse:false};
}
/** Lines `<status> <retry-after|-> <bucket|-> <code|-> <hsts 0|1>`: exactly `limit`
 * 401s, then one address-bucket 429 (packages/auth/src/rate-limit.ts admit()). */
export function burstVerdict(text,limit){
  const rows=String(text).split('\n').map(line=>line.trim()).filter(Boolean).map(line=>line.split(' '));
  const last=rows.at(-1),retryAfter=Number(last?.[1]);
  const valid=whole(limit)&&limit>0&&rows.length===limit+1&&rows.every(row=>row.length===5&&row[4]==='1')&&
    rows.slice(0,-1).every(([status,,,code])=>status==='401'&&code==='AUTHENTICATION_REQUIRED')&&
    last[0]==='429'&&last[2]==='authentication'&&last[3]==='RATE_LIMITED'&&Number.isInteger(retryAfter)&&retryAfter>=1&&retryAfter<=60;
  if(!valid)invalid('BURST_INVALID');
  return {limit,unauthorized:limit,status:429,retryAfter,bucket:'authentication',code:'RATE_LIMITED',hsts:true};
}
/** The shipped ExecStartPre --check refuses first, with one fail line (comment-267527d1 (2)). */
export function checkFailVerdict(text,variable){
  const failed=jsonLines(text).filter(value=>typeof value.check==='string'&&value.status==='fail');
  if(failed.length!==1||!exactly(failed[0],['check','status','code'])||failed[0].code!==`CONFIG_REQUIRED:${variable}`)invalid('PREFLIGHT_REFUSAL_INVALID');
  return failed[0].code;
}
const STARTUP={'unai-api':'API_STARTUP_FAILED','unai-web':'WEB_STARTUP_FAILED'};
/** One startup_failed line naming the variable (API/web `cause`, worker `variable`) and no stack frame. */
export function startupFailedVerdict(text,frames,unit,variable){
  const lines=jsonLines(text).filter(value=>value.event==='startup_failed'),[line]=lines;
  const named=unit==='unai-worker'
    ?exactly(line,['event','code','variable'])&&line.variable===variable&&line.code===`PROCESSING_CONFIGURATION_REQUIRED:${variable}`
    :Object.hasOwn(STARTUP,unit)&&exactly(line,['event','code','cause'])&&line.code===STARTUP[unit]&&line.cause===`CONFIG_REQUIRED:${variable}`;
  if(lines.length!==1||frames!==0||!named)invalid('STARTUP_FAILED_INVALID');
  return unit==='unai-worker'?line.code:line.cause;
}
/** The GitHub double's lines `{event,route,status,authorized}` (scripts/rehearsal/github-double.mjs). */
export function doubleCounts(text){
  const lines=jsonLines(text).filter(value=>value.event==='github.double');
  if(lines.some(line=>!exactly(line,['event','route','status','authorized'])||!['issues','comments','none'].includes(line.route)||
    !whole(line.status)||typeof line.authorized!=='boolean'))invalid('DOUBLE_LOG_INVALID');
  const served=route=>lines.filter(line=>line.route===route&&line.status===200&&line.authorized).length;
  return {issuesServed:served('issues'),commentsServed:served('comments'),unauthorized:lines.filter(line=>line.status===401).length};
}
/** Scheduler pass lines (packages/api/src/connector-sync-scheduler.ts); the disabled line is refused. */
export function schedulerPasses(text){
  const names=['enqueued','alreadyQueued','skipped'];
  const lines=jsonLines(text).filter(value=>value.event==='connector.scheduler');
  if(lines.some(line=>!exactly(line,['event',...names])||!names.every(name=>whole(line[name]))))invalid('SCHEDULER_LOG_INVALID');
  return lines.map(line=>Object.fromEntries(names.map(name=>[name,line[name]])));
}
const LEAK_PROBE=['needles','owner-check','session-mint','cmdline','journal','database','record'];
/** In-host lines `<name> <count>` in LEAK_PROBE order (scripts/rehearsal/sync.mjs leakScript). Without
 * two needles and every positive control seen the probe proves nothing; then no match anywhere. */
export function leakVerdict(text){
  const rows=String(text).split('\n').map(line=>line.trim()).filter(Boolean).map(line=>line.split(' '));
  const valid=rows.length===LEAK_PROBE.length&&rows.every((row,index)=>row.length===2&&row[0]===LEAK_PROBE[index]&&/^\d{1,9}$/.test(row[1]));
  const counts=valid?Object.fromEntries(rows.map(([name,value])=>[name,Number(value)])):{};
  if(!valid||counts.needles!==2||!(counts['owner-check']>0&&counts['session-mint']>0&&counts.cmdline>0))invalid('LEAK_PROBE_INVALID');
  if(counts.journal||counts.database||counts.record)invalid('SECRET_LEAKED');
  return {needles:2,controls:{ownerCheck:counts['owner-check'],sessionMint:counts['session-mint'],cmdline:counts.cmdline},journal:0,database:0,record:0};
}
const SYNC={jobs:1,status:'SUCCEEDED',scheduled:true,jobErrorClear:true,connectorType:'GITHUB',connectorStatus:'ACTIVE',
  cursorAdvanced:true,cursorPage:2,syncErrorClear:true,unauthorized:0};
/** One scheduler-enqueued connector.sync the running worker completed against the double. */
export function syncVerdict(row){
  const counted=['attempts','evidence','issuesServed','commentsServed'];
  const valid=object(row)&&Object.entries(SYNC).every(([key,value])=>row[key]===value)&&
    counted.every(key=>whole(row[key])&&row[key]>0);
  if(!valid)invalid('SYNC_INVALID');
  return Object.fromEntries([...Object.keys(SYNC),...counted].map(key=>[key,row[key]]));
}
