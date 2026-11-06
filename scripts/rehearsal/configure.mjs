// Runs inside the rehearsal host only. Secret values never cross its boundary.
import {readFileSync,writeFileSync,chmodSync,mkdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {randomBytes,randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';

const fail=code=>{throw new Error(`REHEARSAL_${code}`);};
const read=path=>readFileSync(path,'utf8').trim();
const passwordNames=['migrator_password','api_login_password','worker_login_password','auth_login_password','backup_password'];
export function parseProvision(text){
  const passwords={};
  for(const line of text.split('\n')){
    const match=/^\\set (\w+_password) '([a-f0-9]{64})'$/.exec(line);
    if(!match)continue;
    if(passwords[match[1]]!==undefined)fail('PROVISION_INVALID');passwords[match[1]]=match[2];
  }
  if(passwordNames.some(name=>!passwords[name])||Object.keys(passwords).length!==5)fail('PROVISION_INVALID');
  return passwords;
}
export function replaceAssignments(text,values){
  for(const [name,value] of Object.entries(values)){
    if(!/^[A-Z][A-Z0-9_]*$/.test(name)||typeof value!=='string'||/[\r\n]/.test(value))fail('CONFIG_INVALID');
    const pattern=new RegExp(`^${name}=.*$`,'gm'),matches=text.match(pattern);
    if(matches?.length!==1)fail('CONFIG_INVALID');
    text=text.replace(pattern,()=>`${name}=${value}`);
  }
  return text;
}
function call(file,args,input,extra={}){
  const result=spawnSync(file,args,{cwd:'/opt/unai/current',encoding:'utf8',input,env:{...process.env,...extra},timeout:120000,maxBuffer:4194304});
  if(result.status!==0)fail('CONFIG_COMMAND_FAILED');return result.stdout;
}
function write(path,content,mode=0o600){writeFileSync(path,content,{mode,flag:'wx'});chmodSync(path,mode);}
function put(processName,name,value){
  const mount=`/etc/unai/secrets/${processName}`,path=`${mount}/${name}`;
  call('/usr/local/bin/pnpm',['secret:put',name],value,{UNAI_SECRETS_MOUNT:mount});
  call('chown',[`root:unai-${processName}`,path]);chmodSync(path,0o640);
}
function secondCopy(from,to,processName){call('install',['-o','root','-g',`unai-${processName}`,'-m','0640',from,to]);}
function rewrite(processName,values){
  const path=`/etc/unai/${processName}.env`;
  writeFileSync(path,replaceAssignments(readFileSync(path,'utf8'),values),{mode:0o600});
}
function secretFiles(){
  const passwords=parseProvision(read('/root/unai-provision.psql'));
  for(const [processName,name,role,password] of [
    ['api','api-database-url','unai_api_login','api_login_password'],
    ['worker','worker-database-url','unai_worker_login','worker_login_password'],
    ['api','auth-database-url','unai_auth_login','auth_login_password']])
    put(processName,name,`postgresql://${role}:${passwords[password]}@127.0.0.1:5432/unai`);
  secondCopy('/etc/unai/secrets/api/auth-database-url','/etc/unai/secrets/web/auth-database-url','web');
  for(const name of ['nextauth-secret','google-signin-client-secret'])put('web',name,randomBytes(32).toString('hex'));
  put('api','google-connector-client',JSON.stringify({client_id:'1234567890-rehearsal.apps.googleusercontent.com',client_secret:randomBytes(32).toString('hex')}));
  secondCopy('/etc/unai/secrets/api/google-connector-client','/etc/unai/secrets/worker/google-connector-client','worker');
  put('worker','anthropic-api-key',randomBytes(32).toString('hex'));
  const pair=JSON.parse(read('/root/rehearsal/aws-pair'));
  const aws=`[default]\naws_access_key_id = ${pair.accessKeyId}\naws_secret_access_key = ${pair.secretAccessKey}\n`;
  for(const processName of ['api','worker']){
    const path=`/etc/unai/secrets/${processName}/aws/credentials`;write(path,aws,0o640);call('chown',[`root:unai-${processName}`,path]);
  }
  mkdirSync('/etc/unai/restore-drill',{mode:0o700});
  write('/etc/unai/backup/pgpass',`127.0.0.1:5432:unai:unai_backup:${passwords.backup_password}\n`);
  write('/etc/unai/restore-drill/pgpass',`127.0.0.1:5432:*:unai_migrator:${passwords.migrator_password}\n`);
  write('/etc/unai/backup/aws-credentials',aws);write('/etc/unai/restore-drill/aws-credentials',aws);
  write('/etc/unai/backup/backup.key',randomBytes(32));
  for(const name of ['pgpass','aws-credentials','backup.key'])call('chown',['unai-backup:unai-backup',`/etc/unai/backup/${name}`]);
  call('install',['-d','-o','root','-g','root','-m','0700','/var/lib/postgresql/unai-restore-drill-staging']);
}
function settings(){
  const endpoint=name=>read(`/etc/unai/rehearsal/${name}/endpoint`);
  const evidenceKey='arn:aws:kms:us-east-1:000000000000:key/rehearsal-evidence';
  const backupKey='arn:aws:kms:us-west-2:000000000000:key/rehearsal-backup';
  const evidence={UNAI_S3_ENDPOINT:endpoint('evidence'),UNAI_S3_REGION:'us-east-1',UNAI_S3_BUCKET:'rehearsal-uai-evidence',UNAI_S3_KMS_KEY_ID:evidenceKey};
  rewrite('api',evidence);rewrite('worker',{...evidence,UNAI_MODEL_ENDPOINT:'https://model.invalid/v1/messages',
    UNAI_PROCESSING_DATA_PURPOSE:'PERSONAL_ASSISTANCE',UNAI_PROCESSING_MAXIMUM_SENSITIVITY:'PRIVATE'});
  rewrite('web',{NEXTAUTH_URL:'https://uai.rehearsal.invalid',GOOGLE_CLIENT_ID:'1234567890-rehearsal.apps.googleusercontent.com',UNAI_WEB_OWNER_GOOGLE_SUBJECT:'110169484474386276334'});
  rewrite('backup',{...evidence,UNAI_BACKUP_DESTINATION:'s3://rehearsal-uai-backup/rehearsal-host/',
    UNAI_BACKUP_S3_ENDPOINT:endpoint('backup'),UNAI_BACKUP_S3_REGION:'us-west-2',UNAI_BACKUP_S3_KMS_KEY_ID:backupKey});
  rewrite('restore-drill',{UNAI_RESTORE_S3_ENDPOINT:endpoint('drill'),UNAI_RESTORE_S3_REGION:'us-east-1',UNAI_RESTORE_S3_BUCKET:'rehearsal-uai-restore-drill',
    UNAI_RESTORE_ARCHIVE:'s3://rehearsal-uai-backup/rehearsal-host/',UNAI_RESTORE_ARCHIVE_S3_ENDPOINT:endpoint('backup'),
    UNAI_RESTORE_ARCHIVE_S3_REGION:'us-west-2',UNAI_RESTORE_S3_KMS_KEY_ID:evidenceKey});
}
function pin(){
  const lines=read('/root/rehearsal/publish-output').split('\n');
  const result=lines.filter(line=>line.startsWith('{')).map(line=>JSON.parse(line)).find(value=>value.result==='PASS'&&value.releaseId);
  if(!result||!/^\w{8}-(?:\w{4}-){3}\w{12}$/.test(result.releaseId))fail('PUBLISH_INVALID');
  for(const processName of ['api','worker'])rewrite(processName,{UNAI_REGISTRY_RELEASE_ID:result.releaseId,UNAI_REGISTRY_RELEASE:'0.1.0'});
}
function owner(){
  const passwords=parseProvision(read('/root/unai-provision.psql')),userId=randomUUID();
  const subject=/^UNAI_WEB_OWNER_GOOGLE_SUBJECT=(\d+)$/m.exec(read('/etc/unai/web.env'))?.[1];
  if(!subject)fail('OWNER_INVALID');
  write('/root/rehearsal/auth-pgpass',`127.0.0.1:5432:unai:unai_auth_login:${passwords.auth_login_password}\n`);
  call('psql',['host=127.0.0.1 dbname=unai user=unai_auth_login sslmode=verify-full sslrootcert=/etc/unai/tls/ca/ca.pem','-X','-v','ON_ERROR_STOP=1','-f','-'],
    `SELECT unai_private.auth_create_user('${userId}','Uai user','owner@rehearsal.invalid');\nSELECT unai_private.auth_link_identity('${userId}','${subject}');\n`,{PGPASSFILE:'/root/rehearsal/auth-pgpass'});
  const rows=call('sudo',['-u','postgres','psql','-X','-d','unai','-At','-v','ON_ERROR_STOP=1','-f','-'],
    `SELECT m.owner_scope_id, m.user_id FROM auth_identities i JOIN owner_scope_members m ON m.user_id = i.user_id AND m.owner_scope_id = i.owner_scope_id WHERE i.issuer = 'https://accounts.google.com' AND i.subject = '${subject}' AND m.role = 'OWNER' AND m.valid_to IS NULL;\n`).trim().split('\n');
  if(rows.length!==1||!/^[-a-f0-9]{36}\|[-a-f0-9]{36}$/.test(rows[0]))fail('OWNER_INVALID');
  const [scope,actor]=rows[0].split('|');
  rewrite('worker',{UNAI_PROCESSING_OWNER_SCOPE_ID:scope,UNAI_PROCESSING_ACTOR_ID:actor});
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{
    if(process.argv[2]==='secrets'){secretFiles();settings();}
    else if(process.argv[2]==='pin')pin();
    else if(process.argv[2]==='owner')owner();
    else fail('CONFIG_USAGE');
  }catch{process.stderr.write('REHEARSAL_CONFIG_FAILED\n');process.exitCode=1;}
}
