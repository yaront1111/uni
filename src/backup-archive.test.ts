import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {createCipheriv,createDecipheriv,createHash,createHmac,randomBytes} from 'node:crypto';
import {chmod,lstat,mkdir,mkdtemp,readFile,readdir,rm,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
// @ts-expect-error JavaScript harness helper.
import * as untyped from '../scripts/lib/backup-archive.mjs';

interface Listed {name:string;size:number}
interface Entry extends Listed {bytes:Buffer}
interface Writer {add(name:string,bytes:Uint8Array):Promise<void>;finish():Promise<{sha256:string;bytes:number;entries:Listed[]}>;abort():Promise<void>}
interface Query {query(text:string):Promise<{rows:Array<Record<string,unknown>>}>}
interface ArchiveLibrary {
  createArchiveWriter(path:string,key:Uint8Array):Promise<Writer>;
  readArchive(path:string,key:Uint8Array,onEntry:(entry:Entry)=>unknown):Promise<{sha256:string;entries:Listed[]}>;
  verifyArchive(path:string,key:Uint8Array):Promise<{sha256:string;entries:Listed[]}>;
  readBackupKey(path:string,options?:{outside?:string[]}):Promise<Buffer>;
  archiveName(date:Date):string;
  ARCHIVE_NAME:RegExp;
  pruneArchives(directory:string,days:unknown,now?:Date):Promise<string[]>;
  tableDigests(client:Query):Promise<Array<{table:string;digest:string;rows:number}>>;
}
const lib=untyped as ArchiveLibrary;
const posix=process.platform!=='win32';
const sha=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex');
// Deep equality over multi-MiB Buffers is slow in vitest, so entries are compared by digest.
const summary=(list:Array<{name:string;bytes:Buffer;size?:number}>)=>list.map(e=>({name:e.name,size:e.size??e.bytes.length,sha256:sha(e.bytes)}));
const code=async(run:()=>unknown)=>{try{await run();}catch(error){return (error as Error).message;}return 'RESOLVED';};

// Independent implementation of the documented uai-backup/1 layout (scripts/CLAUDE.md).
const keyCheck=(key:Buffer,iv:Buffer)=>createHmac('sha256',key).update(Buffer.concat([Buffer.from('uai-backup/1 key-check'),iv])).digest().subarray(0,12);
function seal(key:Buffer,tar:Buffer):Buffer{
  const iv=randomBytes(12),head=Buffer.concat([Buffer.from('UAIBK'),Buffer.from([1]),iv,keyCheck(key,iv)]);
  const header=Buffer.concat([head,createHash('sha256').update(head).digest().subarray(0,4)]);
  const cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(header);
  return Buffer.concat([header,cipher.update(tar),cipher.final(),cipher.getAuthTag()]);
}
function unseal(file:Buffer,key:Buffer):Buffer{
  const header=file.subarray(0,34),iv=header.subarray(6,18);
  expect([header.subarray(0,5).toString('latin1'),header[5]]).toEqual(['UAIBK',1]);
  expect(header.subarray(18,30).equals(keyCheck(key,iv))).toBe(true);
  expect(header.subarray(30,34).equals(createHash('sha256').update(header.subarray(0,30)).digest().subarray(0,4))).toBe(true);
  const decipher=createDecipheriv('aes-256-gcm',key,iv);decipher.setAAD(header);decipher.setAuthTag(file.subarray(file.length-16));
  return Buffer.concat([decipher.update(file.subarray(34,file.length-16)),decipher.final()]);
}
const text=(block:Buffer,start:number,length:number)=>block.subarray(start,start+length).toString('latin1').replace(/\0[\s\S]*$/,'');
const checksum=(block:Buffer)=>block.reduce((total,byte,index)=>total+(index>=148&&index<156?32:byte),0);
function untar(tar:Buffer):Array<{name:string;bytes:Buffer}>{
  const entries:Array<{name:string;bytes:Buffer}>=[];
  for(let offset=0;;){
    const block=tar.subarray(offset,offset+512);expect(block.length).toBe(512);
    if(block.every(byte=>byte===0)){
      expect(tar.subarray(offset+512).every(byte=>byte===0)).toBe(true);expect(tar.length).toBe(offset+1024);return entries;
    }
    expect(parseInt(text(block,148,8),8)).toBe(checksum(block));
    expect([text(block,156,1),block.subarray(257,263).toString('latin1'),text(block,263,2),text(block,345,155)]).toEqual(['0','ustar\0','00','']);
    const size=parseInt(text(block,124,12),8);
    entries.push({name:text(block,0,100),bytes:Buffer.from(tar.subarray(offset+512,offset+512+size))});
    offset+=512+Math.ceil(size/512)*512;
  }
}
function rechecksum(block:Buffer){block.fill(32,148,156);block.write(checksum(block).toString(8).padStart(6,'0')+'\0 ',148,'latin1');}

let dir='';
beforeEach(async()=>{dir=await mkdtemp(join(tmpdir(),'unai-archive-test-'));});
afterEach(async()=>{await rm(dir,{recursive:true,force:true});});

const key=randomBytes(32),sentinel=randomBytes(32);
const entries=():Array<{name:string;bytes:Buffer}>=>[
  {name:'manifest.json',bytes:Buffer.from(JSON.stringify({format:'uai-backup/1',objects:[]}))},
  {name:'database.dump.000000',bytes:Buffer.alloc(0)},
  {name:'objects/000000',bytes:Buffer.concat([randomBytes(50*1024),sentinel,randomBytes(50*1024)])},
  {name:'objects/000001',bytes:randomBytes(3*1024*1024+7)},
  {name:'a'.repeat(96)+'.bin',bytes:Buffer.from('x')},
];
async function write(path:string,list=entries()){
  const writer=await lib.createArchiveWriter(path,key);
  for(const entry of list)await writer.add(entry.name,entry.bytes);
  return {list,result:await writer.finish()};
}

describe('uai-backup/1 envelope and ustar layout',()=>{
  it('an independent decoder reads the writer output and no plaintext or partial file remains',async()=>{
    const path=join(dir,'a.tar.enc'),{list,result}=await write(path);
    const file=await readFile(path);
    expect(summary(untar(unseal(file,key)))).toEqual(summary(list));
    expect(result).toEqual({sha256:sha(file),bytes:file.length,entries:list.map(e=>({name:e.name,size:e.bytes.length}))});
    expect(file.includes(sentinel)).toBe(false);
    expect(await readdir(dir)).toEqual(['a.tar.enc']);
    if(posix)expect((await lstat(path)).mode&0o777).toBe(0o600);
  });
  it('readArchive delivers every entry in order, one at a time, and verifyArchive agrees',async()=>{
    const path=join(dir,'a.tar.enc'),{list,result}=await write(path);
    const seen:Entry[]=[];let busy=false;
    const read=await lib.readArchive(path,key,async entry=>{
      expect(busy).toBe(false);busy=true;await new Promise(r=>setTimeout(r,2));seen.push(entry);busy=false;
    });
    expect(seen.every(e=>Object.keys(e).sort().join()==='bytes,name,size')).toBe(true);
    expect(summary(seen)).toEqual(summary(list));
    expect(read).toEqual({sha256:result.sha256,entries:result.entries});
    expect(await lib.verifyArchive(path,key)).toEqual(read);
  });
  it('reads an archive sealed by the independent encoder and rethrows a callback error unchanged',async()=>{
    const path=join(dir,'a.tar.enc');await write(path);
    const resealed=join(dir,'b.tar.enc');await writeFile(resealed,seal(key,unseal(await readFile(path),key)));
    expect((await lib.verifyArchive(resealed,key)).entries.map(e=>e.name)).toEqual(entries().map(e=>e.name));
    const stop=new Error('CALLER_STOP');
    await expect(lib.readArchive(resealed,key,()=>{throw stop;})).rejects.toBe(stop);
  });
  it('a wrong key fails BACKUP_KEY_INVALID before any entry is delivered',async()=>{
    const path=join(dir,'a.tar.enc');await write(path);
    let delivered=0;
    expect(await code(()=>lib.readArchive(path,randomBytes(32),()=>{delivered++;}))).toBe('BACKUP_KEY_INVALID');
    expect(await code(()=>lib.verifyArchive(path,randomBytes(32)))).toBe('BACKUP_KEY_INVALID');
    expect(await code(()=>lib.verifyArchive(path,randomBytes(31)))).toBe('BACKUP_KEY_INVALID');
    expect(delivered).toBe(0);
  });
  it('any flipped header, ciphertext or tag byte and any truncation fail BACKUP_ARCHIVE_INTEGRITY_FAILED',async()=>{
    const path=join(dir,'a.tar.enc');await write(path);
    const file=await readFile(path);
    const variants=[0,5,6,18,30,34,Math.floor(file.length/2),file.length-1].map(offset=>{
      const copy=Buffer.from(file);copy[offset]=copy[offset]!^0xff;return copy;
    });
    variants.push(file.subarray(0,file.length-1),file.subarray(0,20));
    for(const [index,variant] of variants.entries()){
      const tampered=join(dir,'tampered-'+index);await writeFile(tampered,variant);
      expect([index,await code(()=>lib.readArchive(tampered,key,()=>undefined))]).toEqual([index,'BACKUP_ARCHIVE_INTEGRITY_FAILED']);
    }
  });
  it('an authentic envelope around a malformed tar still fails BACKUP_ARCHIVE_INTEGRITY_FAILED',async()=>{
    const path=join(dir,'a.tar.enc');await write(path,[{name:'manifest.json',bytes:Buffer.from('{}')}]);
    const tar=unseal(await readFile(path),key);
    const header=(change:(block:Buffer)=>void)=>{const copy=Buffer.from(tar);change(copy.subarray(0,512));return copy;};
    const malformed=[
      Buffer.concat([tar,Buffer.alloc(512)]),tar.subarray(0,tar.length-1024),tar.subarray(0,tar.length-512),
      header(block=>{block[0]=0x4e;}),
      header(block=>{block.write('5',156,'latin1');rechecksum(block);}),
      header(block=>{block.write('../x\0',0,'latin1');rechecksum(block);}),
      header(block=>{block.write('00000077777\0',124,'latin1');rechecksum(block);}),
      header(block=>{block.write('ustar ',257,'latin1');rechecksum(block);}),
    ];
    for(const [index,bytes] of malformed.entries()){
      const target=join(dir,'malformed-'+index);await writeFile(target,seal(key,bytes));
      expect([index,await code(()=>lib.verifyArchive(target,key))]).toEqual([index,'BACKUP_ARCHIVE_INTEGRITY_FAILED']);
    }
  });
});

describe('createArchiveWriter guards',()=>{
  it('refuses invalid entry names without poisoning the writer',async()=>{
    const path=join(dir,'a.tar.enc'),writer=await lib.createArchiveWriter(path,key);
    for(const name of ['a'.repeat(101),'a b','café','/abs','a/./b','a/../b','.','..','','a/','a//b','a\\b'])
      expect([name,await code(()=>writer.add(name,Buffer.from('x')))]).toEqual([name,'BACKUP_ARCHIVE_ENTRY_INVALID']);
    await writer.add('kept',Buffer.from('y'));await writer.finish();
    expect(untar(unseal(await readFile(path),key))).toEqual([{name:'kept',bytes:Buffer.from('y')}]);
  });
  it('refuses a short key, an existing target and an existing partial file, which it leaves alone',async()=>{
    expect(await code(()=>lib.createArchiveWriter(join(dir,'a'),randomBytes(31)))).toBe('BACKUP_KEY_INVALID');
    await writeFile(join(dir,'taken'),'old');
    expect(await code(()=>lib.createArchiveWriter(join(dir,'taken'),key))).toBe('BACKUP_ARCHIVE_EXISTS');
    await writeFile(join(dir,'busy.partial'),'other writer');
    expect(await code(()=>lib.createArchiveWriter(join(dir,'busy'),key))).toBe('BACKUP_ARCHIVE_EXISTS');
    expect([await readFile(join(dir,'taken'),'utf8'),await readFile(join(dir,'busy.partial'),'utf8')]).toEqual(['old','other writer']);
  });
  it('never clobbers a target created while it was writing',async()=>{
    const path=join(dir,'a.tar.enc'),writer=await lib.createArchiveWriter(path,key);
    await writer.add('x',Buffer.from('x'));await writeFile(path,'raced');
    expect(await code(()=>writer.finish())).toBe('BACKUP_ARCHIVE_EXISTS');
    expect([await readFile(path,'utf8'),await readdir(dir)]).toEqual(['raced',['a.tar.enc']]);
  });
  it('is closed after finish or abort, and abort removes the partial file',async()=>{
    const finished=await lib.createArchiveWriter(join(dir,'a'),key);await finished.finish();
    expect(await code(()=>finished.add('x',Buffer.from('x')))).toBe('BACKUP_ARCHIVE_WRITER_CLOSED');
    expect(await code(()=>finished.finish())).toBe('BACKUP_ARCHIVE_WRITER_CLOSED');
    await finished.abort();
    const aborted=await lib.createArchiveWriter(join(dir,'b'),key);await aborted.add('x',Buffer.from('x'));
    expect(await readdir(dir)).toEqual(['a','b.partial']);
    await aborted.abort();await aborted.abort();
    expect(await readdir(dir)).toEqual(['a']);
    expect(await code(()=>aborted.add('y',Buffer.from('y')))).toBe('BACKUP_ARCHIVE_WRITER_CLOSED');
    expect((await lib.verifyArchive(join(dir,'a'),key)).entries).toEqual([]);
  });
});

describe('readBackupKey',()=>{
  const keyFile=async(path:string,bytes:Buffer,mode=0o600)=>{await writeFile(path,bytes,{mode});await chmod(path,mode);return path;};
  it('returns a private 32-byte key and refuses a missing path or a directory',async()=>{
    const bytes=randomBytes(32);
    expect(await lib.readBackupKey(await keyFile(join(dir,'key'),bytes))).toEqual(bytes);
    expect(await code(()=>lib.readBackupKey(join(dir,'missing')))).toBe('BACKUP_KEY_LOCATION_INVALID');
    expect(await code(()=>lib.readBackupKey(dir))).toBe('BACKUP_KEY_LOCATION_INVALID');
  });
  it('refuses a key that is not exactly 32 bytes',async()=>{
    for(const size of [0,31,33])expect(await code(async()=>lib.readBackupKey(await keyFile(join(dir,'k'+size),randomBytes(size))))).toBe('BACKUP_KEY_INVALID');
  });
  it('refuses a key inside a forbidden directory',async()=>{
    await mkdir(join(dir,'data','nested'),{recursive:true});
    const path=await keyFile(join(dir,'data','nested','key'),randomBytes(32));
    expect(await code(()=>lib.readBackupKey(path,{outside:[join(dir,'data')]}))).toBe('BACKUP_KEY_LOCATION_INVALID');
    expect(await lib.readBackupKey(path,{outside:[join(dir,'dat'),join(dir,'elsewhere')]})).toHaveLength(32);
  });
  it.skipIf(!posix)('refuses a symlink, a group- or other-accessible file and a forbidden directory reached through a symlink',async()=>{
    const path=await keyFile(join(dir,'key'),randomBytes(32));
    await symlink(path,join(dir,'link'));
    expect(await code(()=>lib.readBackupKey(join(dir,'link')))).toBe('BACKUP_KEY_LOCATION_INVALID');
    for(const mode of [0o640,0o604,0o644,0o610])
      expect(await code(async()=>lib.readBackupKey(await keyFile(join(dir,'m'+mode.toString(8)),randomBytes(32),mode)))).toBe('BACKUP_KEY_LOCATION_INVALID');
    await mkdir(join(dir,'real','data'),{recursive:true});await symlink(join(dir,'real'),join(dir,'alias'));
    await keyFile(join(dir,'real','data','key'),randomBytes(32));
    expect(await code(()=>lib.readBackupKey(join(dir,'alias','data','key'),{outside:[join(dir,'real','data')]}))).toBe('BACKUP_KEY_LOCATION_INVALID');
    expect(await code(()=>lib.readBackupKey(join(dir,'real','data','key'),{outside:[join(dir,'alias')]}))).toBe('BACKUP_KEY_LOCATION_INVALID');
  });
});

describe('archive names and retention',()=>{
  it('names an archive by its UTC second',()=>{
    const name=lib.archiveName(new Date('2026-11-02T03:30:00.123Z'));
    expect(name).toBe('uai-backup-20261102T033000Z.tar.enc');
    expect(lib.ARCHIVE_NAME.test(name)).toBe(true);
  });
  it('removes only old archive trios by the time in the name and keeps everything else',async()=>{
    const archives=['20261001T120000Z','20261020T000000Z','20261026T000000Z','20261031T000000Z'].map(t=>'uai-backup-'+t+'.tar.enc');
    const others=['uai-backup-20200101T000000Z.tar.enc.bak','uai-backup-notes.txt','other-20200101T000000Z.tar.enc',
      'UAI-BACKUP-20200101T000000Z.tar.enc','uai-backup-20201399T000000Z.tar.enc','uai-backup-20200101T000000Z.tar.enc.sha256','target.txt'];
    for(const name of archives)for(const suffix of ['','.sha256','.manifest.json'])await writeFile(join(dir,name+suffix),'x');
    for(const name of others)await writeFile(join(dir,name),'x');
    await mkdir(join(dir,'uai-backup-20190101T000000Z.tar.enc'));
    if(posix)await symlink(join(dir,'target.txt'),join(dir,'uai-backup-20180101T000000Z.tar.enc'));
    const removed=await lib.pruneArchives(dir,7,new Date('2026-11-02T00:00:00Z'));
    expect(removed).toEqual(archives.slice(0,2));
    const kept=archives.slice(2).flatMap(n=>[n,n+'.sha256',n+'.manifest.json']);
    expect((await readdir(dir)).sort()).toEqual([...kept,...others,'uai-backup-20190101T000000Z.tar.enc',...(posix?['uai-backup-20180101T000000Z.tar.enc']:[])].sort());
  });
  it('never removes the newest archive and refuses a non-integer or zero window',async()=>{
    for(const name of ['uai-backup-20200101T000000Z.tar.enc','uai-backup-20210101T000000Z.tar.enc'])await writeFile(join(dir,name),'x');
    expect(await lib.pruneArchives(dir,1,new Date('2026-11-02T00:00:00Z'))).toEqual(['uai-backup-20200101T000000Z.tar.enc']);
    expect(await readdir(dir)).toEqual(['uai-backup-20210101T000000Z.tar.enc']);
    for(const days of [0,1.5,'7',Number.NaN])expect(await code(()=>lib.pruneArchives(dir,days))).toBe('BACKUP_RETENTION_INVALID');
  });
});

describe('tableDigests',()=>{
  it('streams each table through a cursor and hashes the bytes of the old jsonb_agg formula',async()=>{
    const data=new Map<string,string[]>([['"public"."claims"',Array.from({length:2500},(_,i)=>'{"id": '+i+'}')],
      ['"public"."empty"',[]],['"unai_private"."we""ird"',['{"a": 1}']]]);
    const queries:string[]=[],fetches=new Map<string,number>();let open:string|null=null,cursor:string[]=[];
    const client:Query={async query(sql){
      queries.push(sql);
      if(sql.includes('pg_tables'))return {rows:[{schemaname:'public',tablename:'claims'},{schemaname:'public',tablename:'empty'},{schemaname:'unai_private',tablename:'we"ird'}]};
      const declared=/^DECLARE uai_table_digest NO SCROLL CURSOR FOR SELECT to_jsonb\(t\)::text AS r FROM (.+) t ORDER BY 1$/.exec(sql)?.[1];
      if(declared!==undefined&&open===null){open=declared;cursor=[...(data.get(declared)??['UNKNOWN'])];return {rows:[]};}
      if(sql==='FETCH FORWARD 1000 FROM uai_table_digest'&&open!==null){fetches.set(open,(fetches.get(open)??0)+1);return {rows:cursor.splice(0,1000).map(r=>({r}))};}
      if(sql==='CLOSE uai_table_digest'&&open!==null){open=null;return {rows:[]};}
      throw new Error('UNEXPECTED_QUERY');
    }};
    const claims=data.get('"public"."claims"')!;
    expect(await lib.tableDigests(client)).toEqual([
      {table:'public.claims',digest:sha('['+claims.join(', ')+']'),rows:2500},
      {table:'public.empty',digest:sha('[]'),rows:0},
      {table:'unai_private.we"ird',digest:sha('[{"a": 1}]'),rows:1},
    ]);
    expect(queries[0]).toMatch(/schemaname IN \('public','unai_private'\) ORDER BY schemaname,tablename/);
    expect(fetches.get('"public"."claims"')).toBeGreaterThan(1);
    expect(open).toBeNull();
  });
});
