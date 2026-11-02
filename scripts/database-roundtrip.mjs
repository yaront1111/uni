import {spawnSync} from 'node:child_process';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {mkdir,writeFile,readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {createRequire} from 'node:module';
import {snapshotObjects,restoreObjects} from './recovery-objects.mjs';
import {compareAcceptanceReads} from './recovery-acceptance.mjs';
import {verifyEvidenceObjects} from './recovery-evidence-objects.mjs';
import {startStorageHarness} from './storage-harness.mjs';
import {POSTGRES_IMAGE} from './postgres-harness.mjs';
import {DUMP_PART_BYTES,createArchiveWriter,readArchive,readBackupKey,tableDigests,verifyArchive} from './lib/backup-archive.mjs';
const {Pool}=createRequire(new URL('../packages/postgres/package.json',import.meta.url))('pg');

/** All writers have stopped before this coordinated logical test backup. Source
 * KMS decrypts object bytes into a uai-backup/1 archive (scripts/lib/backup-archive.mjs);
 * an independent target KMS re-encrypts them after separate backup-key recovery.
 * Never a production tool. */
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
        POSTGRES_IMAGE,program,...args],
        {input,env,maxBuffer:256*1024*1024,timeout:120000});
    }
    if(run.error||run.status!==0)throw new Error('RECOVERY_COMMAND_FAILED: '+program+' '+(run.error?.message??run.stderr.toString()));
    return run.stdout;
  };
  const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
  const quoted=name=>'"'+name.replaceAll('"','""')+'"';
  // Streaming digests in one snapshot. `legacy` also recomputes the old jsonb_agg
  // formula once and requires equal digests, so earlier reports stay comparable.
  async function snapshot(pool,legacy=false){
    const client=await pool.connect();
    try{
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY');
      const digests=await tableDigests(client);
      if(legacy){
        const tables=(await client.query("SELECT schemaname,tablename FROM pg_tables WHERE schemaname IN ('public','unai_private') ORDER BY schemaname,tablename")).rows;
        const rows=[];
        for(const t of tables){
          const content=(await client.query('SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),\'[]\'::jsonb)::text AS content FROM '
            +quoted(t.schemaname)+'.'+quoted(t.tablename)+' t')).rows[0].content;
          rows.push({table:t.schemaname+'.'+t.tablename,digest:hash(content),rows:JSON.parse(content).length});
        }
        if(JSON.stringify(rows)!==JSON.stringify(digests))throw new Error('BACKUP_TABLE_DIGEST_MISMATCH');
      }
      await client.query('COMMIT');
      return digests;
    }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}
    finally{client.release();}
  }
  const layout=()=>new Error('BACKUP_ARCHIVE_LAYOUT_INVALID');
  const refused=async(run,code)=>{
    try{await run();}catch(error){if(error.message===code)return true;}
    throw new Error('RECOVERY_NEGATIVE_CHECK_FAILED');
  };
  let created=false,targetStorage,keyDirectory;
  try{
    const before=await snapshot(sourcePool,true);
    if(!before.length)throw new Error('BACKUP_SOURCE_EMPTY');
    const dump=command('pg_dump',['--username='+decodeURIComponent(source.username),'--dbname='+source.pathname.slice(1),'--format=custom']);
    const objects=await snapshotObjects(storageEnv);
    if(!objects.length)throw new Error('BACKUP_OBJECT_FIXTURE_EMPTY');
    const mappings=(await sourcePool.query(`SELECT k.object_store_key,k.encryption_key_ref,s.content_hash,
      s.deleted_at AS source_deleted_at,k.deleted_at AS key_deleted_at FROM evidence_object_keys k
      JOIN source_items s ON s.owner_scope_id=k.owner_scope_id AND s.id=k.source_item_id`)).rows;
    const realKeyRef='kms:'+storageEnv.UNAI_TEST_S3_KMS_KEY_ID;
    const verifiedObjects=verifyEvidenceObjects(mappings,objects,realKeyRef);
    const archivePath='test-results/operations/coordinated-backup.tar.enc';
    await mkdir('test-results/operations',{recursive:true});
    for(const stale of [archivePath,archivePath+'.partial','test-results/operations/coordinated-backup.aesgcm'])await rm(stale,{force:true});
    const key=randomBytes(32),entry=index=>'objects/'+String(index).padStart(6,'0');
    const manifest={format:'uai-backup/1',createdAt:new Date().toISOString(),tables:before,
      objects:objects.map((object,index)=>({entry:entry(index),key:object.key,sha256:object.digest}))};
    const writer=await createArchiveWriter(archivePath,key);
    let written;
    try{
      await writer.add('manifest.json',Buffer.from(JSON.stringify(manifest)));
      for(let offset=0,part=0;offset<dump.length;offset+=DUMP_PART_BYTES,part++)
        await writer.add('database.dump.'+String(part).padStart(6,'0'),dump.subarray(offset,offset+DUMP_PART_BYTES));
      for(const [index,object] of objects.entries())await writer.add(entry(index),Buffer.from(object.bytes,'base64'));
      written=await writer.finish();
    }catch(error){await writer.abort().catch(()=>{});throw error;}
    keyDirectory=await mkdtemp(join(tmpdir(),'unai-recovery-key-'));
    await writeFile(join(keyDirectory,'backup-key'),key,{mode:0o600});key.fill(0);dump.fill(0);
    // Independent recovery path: read the saved artifact and key; no source key
    // object, plaintext dump or source storage access is used by the restorer.
    const recoveredKey=await readBackupKey(join(keyDirectory,'backup-key'),{outside:['test-results']});
    const wrongKeyRefused=await refused(()=>readArchive(archivePath,randomBytes(32),()=>{throw layout();}),'BACKUP_KEY_INVALID');
    const tampered=join(keyDirectory,'tampered.tar.enc'),copy=await readFile(archivePath);
    copy[Math.floor((34+copy.length-16)/2)]^=0xff;await writeFile(tampered,copy,{mode:0o600});
    const tamperRefused=await refused(()=>verifyArchive(tampered,recoveredKey),'BACKUP_ARCHIVE_INTEGRITY_FAILED');
    await rm(tampered,{force:true});
    // Entries are untrusted until readArchive resolves: collect, then apply.
    let manifestBytes=null;const parts=[],stored=new Map();
    const read=await readArchive(archivePath,recoveredKey,({name,bytes})=>{
      if(manifestBytes===null){if(name!=='manifest.json')throw layout();manifestBytes=bytes;}
      else if(!stored.size&&name==='database.dump.'+String(parts.length).padStart(6,'0'))parts.push(bytes);
      else if(name.startsWith('objects/')&&!stored.has(name))stored.set(name,bytes);
      else throw layout();
    });
    recoveredKey.fill(0);
    if(read.sha256!==written.sha256)throw new Error('BACKUP_ARCHIVE_DIGEST_MISMATCH');
    let recovered;
    try{recovered=JSON.parse(manifestBytes.toString('utf8'));}catch{throw layout();}
    if(recovered.format!=='uai-backup/1'||!Array.isArray(recovered.objects)||recovered.objects.length!==stored.size)throw layout();
    const recoveredObjects=recovered.objects.map(object=>{
      const bytes=stored.get(object.entry);
      if(!bytes||hash(bytes)!==object.sha256)throw new Error('BACKUP_OBJECT_DIGEST_MISMATCH');
      return {key:object.key,digest:object.sha256,bytes:bytes.toString('base64')};
    });
    const recoveredDump=Buffer.concat(parts);for(const part of parts)part.fill(0);
    await sourcePool.query('CREATE DATABASE '+target);created=true;
    if((await snapshot(restoredPool)).length!==0)throw new Error('RESTORE_TARGET_NOT_EMPTY');
    command('pg_restore',['--username='+decodeURIComponent(source.username),'--dbname='+target,'--exit-on-error','--single-transaction'],recoveredDump);
    recoveredDump.fill(0);
    const after=await snapshot(restoredPool);
    if(JSON.stringify(before)!==JSON.stringify(after)||JSON.stringify(recovered.tables)!==JSON.stringify(before))throw new Error('RESTORED_DATABASE_MISMATCH');
    targetStorage=await startStorageHarness();
    const objectCount=await restoreObjects({...process.env,...targetStorage.env},recoveredObjects);
    const fixtures=await compareAcceptanceReads(sourceUrl,restored.href);
    const report={...sourceEvidence,format:'unai-coordinated-roundtrip/2',archiveFormat:'uai-backup/1',executedAt:new Date().toISOString(),environment:'TEST',result:'PASS',
      emptyTarget:true,archiveRef:archivePath,archiveDigest:written.sha256,tables:before,objectsRestored:objectCount,
      keyRecoveryVerified:true,wrongKeyRefused,tamperRefused,...verifiedObjects,acceptanceAnswersRegenerated:true,comparatorVersion:'recovery-output-v1',
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



