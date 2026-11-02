/**
 * uai-backup/1: the one archive format of the backup CLI, the restore and the
 * `pnpm test` recovery rehearsal. node: built-ins only; never logs; writes only
 * the encrypted `<archive>.partial` file and publishes it by hard link. Every
 * thrown Error's message is a stable code and nothing else.
 *
 * File = header (34 bytes) | AES-256-GCM ciphertext | GCM tag (16 bytes)
 *   0-4   'UAIBK'
 *   5     version 0x01
 *   6-17  random 96-bit IV
 *   18-29 key check: HMAC-SHA256(key, utf8 'uai-backup/1 key-check' || IV), first 12 bytes
 *   30-33 header checksum: SHA-256(bytes 0-29), first 4 bytes
 * The whole 34-byte header is the GCM AAD; the key is exactly 32 bytes. Reader
 * order: size >= 50, magic and version, header checksum, key check, then the tag
 * after the last byte. A flipped header byte therefore fails as integrity, and
 * only a well-formed header with a different key fails BACKUP_KEY_INVALID.
 *
 * Plaintext = POSIX ustar written in process: regular files only (typeflag '0'),
 * names [A-Za-z0-9._-] segments joined by '/', at most 100 bytes, no '.' or '..'
 * segment, no prefix field; mode 0000600, uid/gid/mtime 0; size as 11 octal
 * digits + NUL (at most 8 GiB - 1); checksum as 6 octal digits, NUL, space;
 * magic 'ustar\0', version '00'; data zero-padded to 512; two zero blocks, then
 * nothing. Plaintext over 2^36 - 32 bytes (the GCM limit) is refused.
 * Entries: manifest.json first, database.dump.000000.. parts (<= 64 MiB each),
 * then objects/000000..; the manifest maps each object entry to its key.
 */
import {createCipheriv,createDecipheriv,createHash,createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import {constants} from 'node:fs';
import {link,lstat,open,readdir,realpath,unlink} from 'node:fs/promises';
import {dirname,isAbsolute,join,relative,resolve} from 'node:path';

const MAGIC=Buffer.from('UAIBK','latin1'),VERSION=1,HEADER=34,TAG=16,BLOCK=512,CHUNK=1024*1024;
const GCM_LIMIT=2**36-32,MAX_ENTRY=8*1024**3-1,DAY=86400000;
const ENTRY_NAME=/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;
const SIDECARS=['.sha256','.manifest.json'];
export const DUMP_PART_BYTES=64*1024*1024;
/** `uai-backup-<YYYYMMDDTHHMMSSZ>.tar.enc`, UTC. */
export const ARCHIVE_NAME=/^uai-backup-(\d{8}T\d{6}Z)\.tar\.enc$/;

const fail=code=>new Error(code);
const OWN_CODE=/^BACKUP_[A-Z_]+$/;
const integrity=()=>fail('BACKUP_ARCHIVE_INTEGRITY_FAILED');
const padded=size=>Math.ceil(size/BLOCK)*BLOCK;
function checkKey(key){if(!(key instanceof Uint8Array)||key.length!==32)throw fail('BACKUP_KEY_INVALID');}
const validName=name=>typeof name==='string'&&name.length<=100&&ENTRY_NAME.test(name)&&!name.split('/').some(s=>s==='.'||s==='..');
const keyCheck=(key,iv)=>createHmac('sha256',key).update('uai-backup/1 key-check').update(iv).digest().subarray(0,12);
const headerChecksum=header=>createHash('sha256').update(header.subarray(0,30)).digest().subarray(0,4);
const blockSum=block=>{let total=0;for(let i=0;i<BLOCK;i++)total+=i>=148&&i<156?32:block[i];return total;};

function ustarHeader(name,size){
  const block=Buffer.alloc(BLOCK);
  block.write(name,0,'latin1');
  for(const [offset,value] of [[100,'0000600\0'],[108,'0000000\0'],[116,'0000000\0'],[124,size.toString(8).padStart(11,'0')+'\0'],
    [136,'00000000000\0'],[156,'0'],[257,'ustar\0'],[263,'00']])block.write(value,offset,'latin1');
  block.write(blockSum(block).toString(8).padStart(6,'0')+'\0 ',148,'latin1');
  return block;
}
async function writeAll(handle,bytes){
  for(let offset=0;offset<bytes.length;)offset+=(await handle.write(bytes,offset,bytes.length-offset)).bytesWritten;
}
async function openPartial(path){
  if(await lstat(path).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw fail('BACKUP_ARCHIVE_WRITE_FAILED');}))throw fail('BACKUP_ARCHIVE_EXISTS');
  try{return await open(path+'.partial','wx',0o600);}catch(error){throw fail(error.code==='EEXIST'?'BACKUP_ARCHIVE_EXISTS':'BACKUP_ARCHIVE_WRITE_FAILED');}
}
function envelopeHeader(key,iv){
  const head=Buffer.concat([MAGIC,Buffer.from([VERSION]),iv,keyCheck(key,iv)]);
  return Buffer.concat([head,headerChecksum(head)]);
}
async function syncDirectory(directory){
  if(process.platform==='win32')return; // Windows cannot open a directory for fsync.
  const handle=await open(directory,'r');
  try{await handle.sync();}finally{await handle.close();}
}

/**
 * Opens `<path>.partial` (exclusive, 0600) and resolves {add, finish, abort}. The
 * key is used only here, so the caller may zero it once this resolves. Calls are
 * serialized; `bytes` must stay unchanged until add resolves, and memory is
 * bounded by one entry. finish fsyncs, links the partial to `path` (never
 * replacing an existing file), unlinks the partial, fsyncs the directory and
 * resolves {sha256, bytes, entries}. abort removes the partial and never a
 * published archive. Codes: BACKUP_KEY_INVALID, BACKUP_ARCHIVE_EXISTS,
 * BACKUP_ARCHIVE_ENTRY_INVALID, BACKUP_ARCHIVE_TOO_LARGE,
 * BACKUP_ARCHIVE_WRITER_CLOSED, BACKUP_ARCHIVE_WRITE_FAILED.
 */
export async function createArchiveWriter(path,key){
  checkKey(key);
  const partial=path+'.partial',iv=randomBytes(12),header=envelopeHeader(key,iv);
  let handle=await openPartial(path);
  const cipher=createCipheriv('aes-256-gcm',key,iv,{authTagLength:TAG});cipher.setAAD(header);
  const digest=createHash('sha256'),entries=[];
  let bytes=0,reserved=2*BLOCK,closed=false,dead=false,published=false,chain=Promise.resolve();
  const put=async chunk=>{if(chunk.length){await writeAll(handle,chunk);digest.update(chunk);bytes+=chunk.length;}};
  const discard=async()=>{
    dead=true;const current=handle;handle=null;
    await current?.close().catch(()=>{});
    if(!published)await unlink(partial).catch(error=>{if(error.code!=='ENOENT')throw fail('BACKUP_ARCHIVE_WRITE_FAILED');});
  };
  const queue=task=>{
    const next=chain.then(()=>{if(dead)throw fail('BACKUP_ARCHIVE_WRITER_CLOSED');return task();});
    chain=next.catch(()=>{});return next;
  };
  const guarded=task=>queue(async()=>{
    try{return await task();}
    catch(error){closed=true;await discard().catch(()=>{});throw error.message==='BACKUP_ARCHIVE_EXISTS'?error:fail('BACKUP_ARCHIVE_WRITE_FAILED');}
  });
  try{await put(header);}catch{await discard().catch(()=>{});throw fail('BACKUP_ARCHIVE_WRITE_FAILED');}
  const add=async(name,data)=>{
    if(closed)throw fail('BACKUP_ARCHIVE_WRITER_CLOSED');
    if(!validName(name)||!(data instanceof Uint8Array)||data.length>MAX_ENTRY)throw fail('BACKUP_ARCHIVE_ENTRY_INVALID');
    if(reserved+BLOCK+padded(data.length)>GCM_LIMIT)throw fail('BACKUP_ARCHIVE_TOO_LARGE');
    reserved+=BLOCK+padded(data.length);
    return guarded(async()=>{
      await put(cipher.update(ustarHeader(name,data.length)));
      for(let offset=0;offset<data.length;offset+=CHUNK)await put(cipher.update(data.subarray(offset,offset+CHUNK)));
      await put(cipher.update(Buffer.alloc(padded(data.length)-data.length)));
      entries.push({name,size:data.length});
    });
  };
  const finish=async()=>{
    if(closed)throw fail('BACKUP_ARCHIVE_WRITER_CLOSED');
    closed=true;
    return guarded(async()=>{
      await put(cipher.update(Buffer.alloc(2*BLOCK)));await put(cipher.final());await put(cipher.getAuthTag());
      await handle.sync();await handle.close();handle=null;
      await link(partial,path).catch(error=>{throw error.code==='EEXIST'?fail('BACKUP_ARCHIVE_EXISTS'):error;});
      published=true;
      await unlink(partial);await syncDirectory(dirname(path));
      return {sha256:digest.digest('hex'),bytes,entries:entries.map(entry=>({...entry}))};
    });
  };
  const abort=()=>{closed=true;dead=true;const next=chain.then(discard);chain=next.catch(()=>{});return next;};
  return {add,finish,abort};
}

function parseHeader(block){
  const field=(start,length)=>block.toString('latin1',start,start+length);
  const cstring=value=>value.split('\0')[0];
  const size=field(124,12),checksum=field(148,8),name=cstring(field(0,100));
  if(!/^[0-7]{11}\0$/.test(size)||!/^[0-7]{6}\0 $/.test(checksum)||parseInt(checksum,8)!==blockSum(block)
    ||field(257,6)!=='ustar\0'||field(263,2)!=='00'||!['0','\0'].includes(field(156,1))
    ||cstring(field(345,155))!==''||!validName(name))throw integrity();
  return {name,size:parseInt(size,8)};
}
/** Incremental ustar parser; `limit` is the plaintext length, so a corrupt size cannot allocate past it. */
function ustarParser(limit){
  const head=Buffer.alloc(BLOCK),entries=[];
  let filled=0,entry=null,data=null,dataFilled=0,skip=0,zeros=0,consumed=0;
  const push=chunk=>{
    const ready=[];
    for(let at=0;at<chunk.length;){
      if(zeros===2)throw integrity();
      const take=Math.min(chunk.length-at,skip||(data?data.length-dataFilled:BLOCK-filled));
      if(skip){skip-=take;}
      else if(data){
        chunk.copy(data,dataFilled,at,at+take);dataFilled+=take;
        if(dataFilled===data.length){ready.push({...entry,bytes:data});skip=padded(entry.size)-entry.size;data=null;}
      }else{
        chunk.copy(head,filled,at,at+take);filled+=take;
        if(filled===BLOCK){
          filled=0;
          if(head.every(byte=>byte===0))zeros++;
          else{
            if(zeros)throw integrity();
            entry=parseHeader(head);
            if(consumed+take+padded(entry.size)+2*BLOCK>limit)throw integrity();
            entries.push({name:entry.name,size:entry.size});
            if(!entry.size)ready.push({...entry,bytes:Buffer.alloc(0)});
            else try{data=Buffer.alloc(entry.size);}catch{throw fail('BACKUP_ARCHIVE_UNREADABLE');}
            dataFilled=0;
          }
        }
      }
      at+=take;consumed+=take;
    }
    return ready;
  };
  const end=()=>{if(zeros!==2||filled||data||skip)throw integrity();return entries;};
  return {push,end};
}
async function readAt(handle,position,length){
  const buffer=Buffer.alloc(length);
  for(let done=0;done<length;){
    let read;
    try{read=(await handle.read(buffer,done,length-done,position+done)).bytesRead;}catch{throw fail('BACKUP_ARCHIVE_UNREADABLE');}
    if(!read)throw integrity();
    done+=read;
  }
  return buffer;
}

/**
 * Checks the header and key, then streams entries in order through
 * `await onEntry({name, size, bytes})`, and resolves {sha256, entries} only after
 * the GCM tag verifies. Everything delivered before it resolves is UNTRUSTED: a
 * restore verifies first (or buffers) and applies only after resolution. Codes:
 * BACKUP_KEY_INVALID, BACKUP_ARCHIVE_INTEGRITY_FAILED, BACKUP_ARCHIVE_UNREADABLE;
 * an error thrown by onEntry is rethrown unchanged.
 */
export async function readArchive(path,key,onEntry){
  checkKey(key);
  let handle;
  try{handle=await open(path,'r');}catch{throw fail('BACKUP_ARCHIVE_UNREADABLE');}
  try{
    const info=await handle.stat().catch(()=>{throw fail('BACKUP_ARCHIVE_UNREADABLE');});
    if(!info.isFile())throw fail('BACKUP_ARCHIVE_UNREADABLE');
    if(info.size<HEADER+TAG)throw integrity();
    const header=await readAt(handle,0,HEADER),tag=await readAt(handle,info.size-TAG,TAG),iv=header.subarray(6,18);
    if(!header.subarray(0,5).equals(MAGIC)||header[5]!==VERSION||!timingSafeEqual(header.subarray(30,34),headerChecksum(header)))throw integrity();
    if(!timingSafeEqual(header.subarray(18,30),keyCheck(key,iv)))throw fail('BACKUP_KEY_INVALID');
    const decipher=createDecipheriv('aes-256-gcm',key,iv,{authTagLength:TAG});decipher.setAAD(header);decipher.setAuthTag(tag);
    const end=info.size-TAG,digest=createHash('sha256').update(header),parser=ustarParser(end-HEADER);
    for(let offset=HEADER;offset<end;){
      const chunk=await readAt(handle,offset,Math.min(CHUNK,end-offset));
      offset+=chunk.length;digest.update(chunk);
      for(const entry of parser.push(decipher.update(chunk)))await onEntry(entry);
    }
    try{decipher.final();}catch{throw integrity();}
    return {sha256:digest.update(tag).digest('hex'),entries:parser.end()};
  }finally{await handle.close().catch(()=>{});}
}
/** A full authenticated pass that discards the plaintext. */
export const verifyArchive=(path,key)=>readArchive(path,key,()=>undefined);

const win32=process.platform==='win32';
function within(directory,target){
  const rel=win32?relative(directory.toLowerCase(),target.toLowerCase()):relative(directory,target);
  return !isAbsolute(rel)&&rel.split(/[\\/]/)[0]!=='..';
}
/**
 * Reads a 32-byte backup key and resolves the Buffer; the caller zero-fills it.
 * BACKUP_KEY_LOCATION_INVALID unless `path` is a regular file and not a symlink,
 * when any group or other mode bit is set (POSIX only: Windows has no POSIX mode
 * and relies on ACLs, so that check is skipped on win32), or when its realpath
 * lies inside any `outside` directory (compared both as given and resolved, so a
 * symlinked parent on either side does not hide it). BACKUP_KEY_INVALID unless it
 * holds exactly 32 bytes.
 */
export async function readBackupKey(path,{outside=[]}={}){
  const location=()=>fail('BACKUP_KEY_LOCATION_INVALID');
  const info=await lstat(path).catch(()=>null);
  if(!info?.isFile())throw location();
  // O_NOFOLLOW and O_NONBLOCK close the swap-for-a-symlink-or-FIFO race after lstat (POSIX).
  const handle=await open(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0)|(constants.O_NONBLOCK??0)).catch(()=>null);
  if(!handle)throw location();
  try{
    const opened=await handle.stat();
    if(!opened.isFile()||opened.ino!==info.ino||(!win32&&(opened.mode&0o077)))throw location();
    const real=await realpath(path).catch(()=>{throw location();});
    for(const directory of outside){
      const resolved=await realpath(directory).catch(()=>resolve(directory));
      if(within(resolve(directory),real)||within(resolved,real))throw location();
    }
    if(opened.size!==32)throw fail('BACKUP_KEY_INVALID');
    const key=await readAt(handle,0,32).catch(()=>{throw fail('BACKUP_KEY_INVALID');});
    if((await handle.read(Buffer.alloc(1),0,1,32)).bytesRead)throw fail('BACKUP_KEY_INVALID');
    return key;
  }catch(error){throw OWN_CODE.test(error.message)?error:location();}
  finally{await handle.close().catch(()=>{});}
}

/** The archive name for `date`, in UTC to the second. */
export function archiveName(date){
  const name=date instanceof Date&&Number.isFinite(date.getTime())
    ?'uai-backup-'+date.toISOString().replace(/\.\d{3}Z$/,'Z').replace(/[-:]/g,'')+'.tar.enc':'';
  if(!ARCHIVE_NAME.test(name))throw fail('BACKUP_ARCHIVE_NAME_INVALID');
  return name;
}
/** Milliseconds embedded in an ARCHIVE_NAME, or null (also for impossible dates). */
function archiveTime(name){
  const stamp=ARCHIVE_NAME.exec(name)?.[1];
  if(!stamp)return null;
  const [y,mo,d,h,mi,s]=[[0,4],[4,6],[6,8],[9,11],[11,13],[13,15]].map(([from,to])=>Number(stamp.slice(from,to)));
  const time=Date.UTC(y,mo-1,d,h,mi,s);
  return archiveName(new Date(time))===name?time:null;
}
/**
 * Deletes each archive whose NAME time is older than `days` whole days before
 * `now`, sidecars first, then the archive. Only regular files named by
 * ARCHIVE_NAME count; the newest of them is always kept; mtime is never read;
 * symlinks, directories and every other name are left alone. Resolves the
 * removed archive names, sorted. BACKUP_RETENTION_INVALID, BACKUP_RETENTION_FAILED.
 */
export async function pruneArchives(directory,days,now=new Date()){
  if(!Number.isInteger(days)||days<1||!(now instanceof Date)||!Number.isFinite(now.getTime()))throw fail('BACKUP_RETENTION_INVALID');
  const regular=async path=>(await lstat(path).catch(error=>{if(error.code==='ENOENT')return null;throw error;}))?.isFile()??false;
  try{
    const candidates=[];
    for(const name of await readdir(directory)){
      const time=archiveTime(name);
      if(time!==null&&await regular(join(directory,name)))candidates.push({name,time});
    }
    candidates.sort((a,b)=>a.time-b.time);
    const cutoff=now.getTime()-days*DAY,removed=[];
    for(const {name,time} of candidates.slice(0,-1)){
      if(time>=cutoff)continue;
      for(const suffix of [...SIDECARS,'']){
        const path=join(directory,name+suffix);
        if(await regular(path))await unlink(path).catch(error=>{if(error.code!=='ENOENT')throw error;});
      }
      removed.push(name);
    }
    return removed.sort();
  }catch{throw fail('BACKUP_RETENTION_FAILED');}
}

const quoted=name=>'"'+name.replaceAll('"','""')+'"';
/**
 * Per table in schemas public and unai_private: {table, digest, rows}, where
 * digest = SHA-256 of '[' + rows joined by ', ' + ']' with rows as
 * to_jsonb(t)::text in text order. Those are exactly the bytes the old
 * `COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]')::text`
 * produced, so old reports stay comparable, but no table is ever aggregated into
 * one value (jsonb caps a value at 255 MB). Rows stream through a server-side
 * cursor, so `client` must be inside an open transaction (DECLARE fails outside one).
 * Any database error becomes BACKUP_TABLE_DIGEST_FAILED, without its text.
 */
export async function tableDigests(client){
  try{return await digestTables(client);}catch{throw fail('BACKUP_TABLE_DIGEST_FAILED');}
}
async function digestTables(client){
  const tables=(await client.query("SELECT schemaname,tablename FROM pg_tables WHERE schemaname IN ('public','unai_private') ORDER BY schemaname,tablename")).rows;
  const digests=[];
  for(const {schemaname,tablename} of tables){
    const hash=createHash('sha256').update('[');let rows=0;
    await client.query('DECLARE uai_table_digest NO SCROLL CURSOR FOR SELECT to_jsonb(t)::text AS r FROM '+quoted(schemaname)+'.'+quoted(tablename)+' t ORDER BY 1');
    for(let batch;(batch=(await client.query('FETCH FORWARD 1000 FROM uai_table_digest')).rows).length;)
      for(const {r} of batch)hash.update((rows++?', ':'')+r);
    await client.query('CLOSE uai_table_digest');
    digests.push({table:schemaname+'.'+tablename,digest:hash.update(']').digest('hex'),rows});
  }
  return digests;
}
