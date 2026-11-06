// Pure record contract. Rehearsal extensions append implementations, not phase names.
export const PHASES=Object.freeze(('host install-dry-run install tls postgres object-store secrets migrate publish owner preflights '+
  'services probes smoke failed-start sync backup restore-drill upgrade-dry-run upgrade-rollback upgrade telemetry browser').split(' '));
export const IMPLEMENTED=Object.freeze(PHASES.slice(0,11));
const invalid=code=>{throw new Error(`REHEARSAL_${code}`);};

export function requirePreflight(name,text){
  const expected={api:'rate_limits secrets database auth_database database_role encryption_at_rest object_store registry_release tls_certificate probe_port',
    web:'rate_limits origin tls_certificate auth api',worker:''}[name];
  if(expected===undefined)invalid('PREFLIGHT_EVIDENCE_INVALID');
  const seen=new Set();
  for(const line of text.split('\n').filter(line=>line.startsWith('{'))){
    let value;try{value=JSON.parse(line);}catch{invalid('PREFLIGHT_EVIDENCE_INVALID');}
    if(!value||typeof value.check!=='string'||seen.has(value.check))invalid('PREFLIGHT_EVIDENCE_INVALID');
    const warning=name==='web'&&value.check==='api'&&value.status==='warn'&&value.code==='API_UNREACHABLE';
    if(!warning&&(value.status!=='ok'||value.code!=='OK'))invalid('PREFLIGHT_EVIDENCE_INVALID');
    seen.add(value.check);
  }
  if(expected.split(' ').filter(Boolean).some(check=>!seen.has(check)))invalid('PREFLIGHT_EVIDENCE_INVALID');
}

export function parseArguments(argv){
  const parsed={},seen=new Set();
  for(let i=0;i<argv.length;i++){
    const flag=argv[i];
    if(!['--record','--until','--keep','--verify-record','--help'].includes(flag)||seen.has(flag))invalid('ARGUMENTS_INVALID');
    seen.add(flag);
    const key={'--record':'record','--until':'until','--keep':'keep','--verify-record':'verifyRecord','--help':'help'}[flag];
    if(['--keep','--help'].includes(flag))parsed[key]=true;
    else{
      const value=argv[++i];
      if(!value||value.startsWith('--'))invalid('ARGUMENTS_INVALID');
      parsed[key]=value;
    }
  }
  if((parsed.help||parsed.verifyRecord)&&seen.size!==1)invalid('ARGUMENTS_INVALID');
  if(parsed.help||parsed.verifyRecord)return parsed;
  if(parsed.until&&!PHASES.includes(parsed.until))invalid('PHASE_UNKNOWN');
  if(parsed.until&&!IMPLEMENTED.includes(parsed.until))invalid('PHASE_UNIMPLEMENTED');
  return {until:'preflights',keep:false,...parsed};
}

export function scrub(text,{forbidden=[]}={}){
  let value=String(text);
  for(const literal of [...forbidden].filter(Boolean).sort((a,b)=>b.length-a.length))value=value.split(literal).join('[REDACTED]');
  value=value.replace(/-----BEGIN [A-Z0-9 ]+-----[\s\S]*?-----END [A-Z0-9 ]+-----/g,'[REDACTED]')
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi,'$1[REDACTED]@')
    .replace(/Authorization\s*:[^\r\n]*/gi,'[REDACTED]')
    .replace(/\bBearer\s+(?!\[REDACTED\])\S+/gi,'[REDACTED]')
    .replace(/\b(?:aws_access_key_id|aws_secret_access_key|password|PGPASSWORD)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s;]+)/gi,'[REDACTED]')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g,'[REDACTED]').replace(/\bsk-[\w-]+/g,'[REDACTED]')
    .replace(/(?<![\w:])(?:[a-f0-9]{64}|[a-f0-9]{12})(?![a-f0-9])/gi,'[REDACTED]')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g,ip=>['127.0.0.1','0.0.0.0'].includes(ip)?ip:'[REDACTED]')
    .replace(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/gi,name=>{
      // Product event identifier, not a hostname; retain migration evidence.
      if(['uai.rehearsal.invalid','database.migrated'].includes(name)||/\.(?:mjs|ts|tsx|json|yaml|sql|sh|env|pem|conf|service|timer|md|git|bundle|key|psql|txt|log)$/i.test(name))return name;
      return '[REDACTED]';
    });
  return value.split('\n').slice(-40).join('\n').slice(-4096);
}

const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const string=value=>typeof value==='string'&&value.trim().length>0;
const integer=value=>Number.isSafeInteger(value);
const sha=value=>typeof value==='string'&&/^[a-f0-9]{40}$/.test(value);
const iso=value=>typeof value==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)&&
  Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
const shape=(value,required,optional=[])=>object(value)&&required.every(key=>Object.hasOwn(value,key))&&
  Object.keys(value).every(key=>[...required,...optional].includes(key));
const list=(value,test)=>Array.isArray(value)&&value.every(test);
const exit=value=>value===null||(integer(value)&&value>=0&&value<=255);

function commandValid(value){
  return shape(value,['argv','exitCode','durationMs','tail'])&&list(value.argv,string)&&value.argv.length>0&&
    exit(value.exitCode)&&integer(value.durationMs)&&value.durationMs>=0&&typeof value.tail==='string';
}
function phaseErrors(phases,add){
  if(!Array.isArray(phases)){add('PHASES');return;}
  let previous=-1;
  phases.forEach((phase,index)=>{
    if(!shape(phase,['name','status','commands'],['note','durationMs'])){add('PHASES');return;}
    const position=PHASES.indexOf(phase.name);
    if(position<=previous||position<0||!['PASS','FAIL','UNVERIFIED'].includes(phase.status)||
      (phase.status==='FAIL'&&index!==phases.length-1)||
      (phase.status==='UNVERIFIED'&&!string(phase.note))||
      (phase.note!==undefined&&!string(phase.note))||
      (phase.durationMs!==undefined&&(!integer(phase.durationMs)||phase.durationMs<0)))add('PHASES');
    previous=position;
    if(!Array.isArray(phase.commands)||phase.commands.length===0){add('PHASES');return;}
    for(const command of phase.commands){
      if(!commandValid(command))add('COMMAND');
      else if(phase.status==='PASS'&&command.exitCode!==0)add('PHASES');
    }
  });
}
function findingsValid(findings){
  return list(findings,f=>shape(f,['id','area','verdict','note'],['taskId'])&&
    [f.id,f.area,f.note].every(string)&&['CLEAR','FIXED','FILED'].includes(f.verdict)&&
    (f.verdict!=='FILED'||typeof f.taskId==='string')&&
    (f.taskId===undefined||/^task-[a-f0-9]{32}$/.test(f.taskId)));
}
function releaseValid(value){
  return shape(value,['checkedAt','sourceCommit','exitCode','criteria'])&&iso(value.checkedAt)&&sha(value.sourceCommit)&&
    integer(value.exitCode)&&exit(value.exitCode)&&list(value.criteria,c=>
      shape(c,['criterion','status','reason','closedBy'])&&[c.criterion,c.reason,c.closedBy].every(string)&&['PASS','FAIL'].includes(c.status));
}
function scrubbed(value,options,seen=new Set()){
  if(typeof value==='string')return scrub(value,options)===value;
  if(!value||typeof value!=='object')return true;
  if(seen.has(value))return false;
  seen.add(value);
  const result=Object.entries(value).every(([key,item])=>scrub(key,options)===key&&scrubbed(item,options,seen));
  seen.delete(value);return result;
}
export function validateRecord(record,options={}){
  if(!object(record))return ['REHEARSAL_RECORD_SHAPE'];
  const errors=new Set(),add=code=>errors.add(`REHEARSAL_RECORD_${code}`);
  if(!shape(record,['format','sourceCommit','startedAt','completedAt','host','workingTree','phases','unverified'],['findings','releaseCheck']))add('SHAPE');
  if(record.format!=='unai-deploy-rehearsal/1')add('FORMAT');
  if(!sha(record.sourceCommit))add('SOURCE');
  if(!iso(record.startedAt)||!iso(record.completedAt)||record.completedAt<record.startedAt)add('TIME');
  const host=record.host;
  if(!shape(host,['imageDigest','os','systemd','engine'])||!/^sha256:[a-f0-9]{64}$/.test(host.imageDigest)||
    ![host.os,host.systemd,host.engine].every(string))add('HOST');
  const tree=record.workingTree;
  if(!shape(tree,['clean','paths'])||typeof tree.clean!=='boolean'||!list(tree.paths,string)||tree.clean!==(tree.paths.length===0))add('WORKTREE');
  phaseErrors(record.phases,add);
  if(!list(record.unverified,u=>shape(u,['layer','reason'])&&string(u.layer)&&string(u.reason)))add('UNVERIFIED');
  if(record.findings!==undefined&&!findingsValid(record.findings))add('FINDINGS');
  if(record.releaseCheck!==undefined&&!releaseValid(record.releaseCheck))add('RELEASE_CHECK');
  if(!scrubbed(record,options))add('UNSCRUBBED');
  return [...errors].sort();
}
