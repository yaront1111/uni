import {spawnSync} from 'node:child_process';
import {createHash,randomBytes,randomUUID,createCipheriv,createDecipheriv} from 'node:crypto';
import {mkdir,writeFile,readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {createRequire} from 'node:module';
import {snapshotObjects,restoreObjects} from './recovery-objects.mjs';
import {compareAcceptanceReads} from './recovery-acceptance.mjs';
import {startStorageHarness} from './storage-harness.mjs';
const {Pool}=createRequire(new URL('../packages/postgres/package.json',import.meta.url))('pg');

/** All writers have stopped before this coordinated logical test backup. Source
 * KMS decrypts object bytes into an encrypted archive; an independent target KMS
 * re-encrypts them after separate backup-key recovery. Never a production tool. */
export async function databaseRoundtrip(container,sourceUrl,storageEnv,sourceEvidence){
  if(container&&!/^unai-test-[a-f0-9-]{36}$/.test(container))throw new Error('BACKUP_TEST_CONTAINER_REQUIRED');
  const target='unai_restore_'+randomUUID().replaceAll('-','');
  const source=new URL(sourceUrl);
  const sourcePool=new Pool({connectionString:sourceUrl,max:1});
  const restored=new URL(sourceUrl);restored.pathname='/'+target;
  const restoredPool=new Pool({connectionString:restored.href,max:1});
  const command=(program,args,input)=>{
    let run=container?spawnSync('docker',['exec',...(input?['-i']:[]),container,program,...args],{input,maxBuffer:256*1024*1024,timeout:120000}):
      spawnSync(program,args,{input,maxBuffer:256*1024*1024,timeout:120000,env:{...process.env,
        PGHOST:source.hostname,PGPORT:source.port||'5432',PGUSER:decodeURIComponent(source.username),PGPASSWORD:decodeURIComponent(source.password)}});
    if(!container&&run.error?.code==='ENOENT'){
      // Delivered PostgreSQL may have no host CLI. Reuse the harness's pinned
      // PostgreSQL client image; credentials are passed by environment name.
      const localHost=['127.0.0.1','localhost','[::1]'].includes(source.hostname);
      const env={...process.env,PGHOST:localHost&&process.platform==='win32'?'host.docker.internal':source.hostname,
        PGPORT:source.port||'5432',PGUSER:decodeURIComponent(source.username),PGPASSWORD:decodeURIComponent(source.password)};
      const network=process.platform==='win32'?[]:['--network','host'];
      run=spawnSync('docker',['run','--rm',...(input?['--interactive']:[]),...network,
        '--env','PGHOST','--env','PGPORT','--env','PGUSER','--env','PGPASSWORD',
        'pgvector/pgvector@sha256:cf134a767f474095eeba57e0117be8e568e011a63f33fbf252f14c9b760f8e6f',program,...args],
        {input,env,maxBuffer:256*1024*1024,timeout:120000});
    }
    if(run.error||run.status!==0)throw new Error('RECOVERY_COMMAND_FAILED: '+program+' '+(run.error?.message??run.stderr.toString()));
    return run.stdout;
  };
  const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
  const quoted=name=>'"'+name.replaceAll('"','""')+'"';
  async function snapshot(pool){
    const tables=(await pool.query("SELECT schemaname,tablename FROM pg_tables WHERE schemaname IN ('public','unai_private') ORDER BY schemaname,tablename")).rows;
    const rows=[];
    for(const t of tables){
      const content=(await pool.query('SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),\'[]\'::jsonb)::text AS content FROM '
        +quoted(t.schemaname)+'.'+quoted(t.tablename)+' t')).rows[0].content;
      rows.push({table:t.schemaname+'.'+t.tablename,digest:hash(content),rows:JSON.parse(content).length});
    }
    return rows;
  }
  let created=false,targetStorage,keyDirectory;
  try{
    const before=await snapshot(sourcePool);
    if(!before.length)throw new Error('BACKUP_SOURCE_EMPTY');
    const dump=command('pg_dump',['--username='+decodeURIComponent(source.username),'--dbname='+source.pathname.slice(1),'--format=custom']);
    const objects=await snapshotObjects(storageEnv);
    if(!objects.length)throw new Error('BACKUP_OBJECT_FIXTURE_EMPTY');
    const objectByKey=new Map(objects.map(object=>[object.key,object]));
    const mappings=(await sourcePool.query(`SELECT k.object_store_key,k.encryption_key_ref,s.content_hash FROM evidence_object_keys k
      JOIN source_items s ON s.owner_scope_id=k.owner_scope_id AND s.id=k.source_item_id`)).rows;
    const realKeyRef='kms:'+storageEnv.UNAI_TEST_S3_KMS_KEY_ID;
    // These exact test-only providers are declared by the existing isolation,
    // API and live connector fixtures. They never claimed bytes in this S3 store.
    // Count them explicitly; unknown providers cannot silently evade verification.
    const fixtureProviders=new Set(['kms:test','kms:test-double','kms:live-test']);
    const syntheticMappings=mappings.filter(mapping=>fixtureProviders.has(mapping.encryption_key_ref));
    const durableMappings=mappings.filter(mapping=>mapping.encryption_key_ref===realKeyRef);
    if(syntheticMappings.length+durableMappings.length!==mappings.length)throw new Error('BACKUP_UNKNOWN_OBJECT_PROVIDER');
    if(!durableMappings.length)throw new Error('BACKUP_DURABLE_EVIDENCE_FIXTURE_EMPTY');
    for(const mapping of durableMappings){
      const object=objectByKey.get(mapping.object_store_key);
      if(!object||object.digest!==mapping.content_hash)throw new Error('BACKUP_LIVE_EVIDENCE_OBJECT_MISSING_OR_CHANGED');
    }
    const payload=Buffer.from(JSON.stringify({database:dump.toString('base64'),objects}));
    const key=randomBytes(32),iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);
    const archive=Buffer.concat([iv,Buffer.alloc(16),cipher.update(payload),cipher.final()]);cipher.getAuthTag().copy(archive,12);
    await mkdir('test-results/operations',{recursive:true});
    const archivePath='test-results/operations/coordinated-backup.aesgcm';await writeFile(archivePath,archive);
    keyDirectory=await mkdtemp(join(tmpdir(),'unai-recovery-key-'));
    await writeFile(join(keyDirectory,'backup-key'),key,{mode:0o600});key.fill(0);payload.fill(0);dump.fill(0);
    // Independent recovery path: read the saved artifact and key; no source key
    // object, plaintext dump or source storage access is used by the restorer.
    const saved=await readFile(archivePath),recoveredKey=await readFile(join(keyDirectory,'backup-key'));
    const decipher=createDecipheriv('aes-256-gcm',recoveredKey,saved.subarray(0,12));decipher.setAuthTag(saved.subarray(12,28));
    const clear=Buffer.concat([decipher.update(saved.subarray(28)),decipher.final()]);recoveredKey.fill(0);
    const recovery=JSON.parse(clear.toString('utf8'));clear.fill(0);
    await sourcePool.query('CREATE DATABASE '+target);created=true;
    if((await snapshot(restoredPool)).length!==0)throw new Error('RESTORE_TARGET_NOT_EMPTY');
    command('pg_restore',['--username='+decodeURIComponent(source.username),'--dbname='+target,'--exit-on-error','--single-transaction'],Buffer.from(recovery.database,'base64'));
    const after=await snapshot(restoredPool);
    if(JSON.stringify(before)!==JSON.stringify(after))throw new Error('RESTORED_DATABASE_MISMATCH');
    targetStorage=await startStorageHarness();
    const objectCount=await restoreObjects({...process.env,...targetStorage.env},recovery.objects);
    const fixtures=await compareAcceptanceReads(sourceUrl,restored.href);
    const report={...sourceEvidence,format:'unai-coordinated-roundtrip/1',executedAt:new Date().toISOString(),environment:'TEST',result:'PASS',
      emptyTarget:true,archiveRef:archivePath,archiveDigest:hash(saved),tables:before,objectsRestored:objectCount,
      keyRecoveryVerified:true,liveEvidenceObjectsVerified:durableMappings.length,syntheticObjectMappings:syntheticMappings.length,acceptanceAnswersRegenerated:true,comparatorVersion:'recovery-output-v1',
      fixtureScope:'Fresh Today/Ask/Why reads of terminal persisted states from the existing passing AC44 suites; no fixture reseeding after restore.',fixtures};
    await writeFile('test-results/operations/coordinated-roundtrip.json',JSON.stringify(report,null,2)+'\n');
    console.log('Coordinated backup/restore: '+before.length+' tables, '+objectCount+' objects and '+fixtures.length+' fixture read digest pairs identical.');
  }finally{
    targetStorage?.close();
    await restoredPool.end();
    if(created)await sourcePool.query('DROP DATABASE '+target+' WITH (FORCE)');
    await sourcePool.end();
    if(keyDirectory){
      const child=relative(resolve(tmpdir()),resolve(keyDirectory));
      if(isAbsolute(child)||child.startsWith('..')||!child.startsWith('unai-recovery-key-'))throw new Error('UNSAFE_RECOVERY_KEY_CLEANUP');
      await rm(keyDirectory,{recursive:true,force:true});
    }
  }
}



