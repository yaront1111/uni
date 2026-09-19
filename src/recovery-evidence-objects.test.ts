import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect,it } from 'vitest';

const live={object_store_key:'raw/live',encryption_key_ref:'kms:real-test',content_hash:'a'.repeat(64),source_deleted_at:null,key_deleted_at:null};
const object={key:live.object_store_key,digest:live.content_hash};
const deleted={...live,object_store_key:'raw/deleted',content_hash:'b'.repeat(64),source_deleted_at:new Date('2026-09-19'),key_deleted_at:new Date('2026-09-19')};
async function verifier() {
  expect(existsSync(resolve('scripts/recovery-evidence-objects.mjs')),'Recovery must distinguish verified live objects from erased object tombstones').toBe(true);
  const path='../scripts/recovery-evidence-objects.mjs';
  return (await import(path)).verifyEvidenceObjects as (mappings:Record<string,unknown>[],objects:{key:string;digest:string}[],realKeyRef:string)=>{
    liveEvidenceObjectsVerified:number;deletedEvidenceObjectsVerified:number;syntheticObjectMappings:number;
  };
}

it('verifies live bytes and preserves an erased mapping without restoring its object',async()=>{
  const verify=await verifier();
  expect(verify([live,deleted],[object],'kms:real-test')).toEqual({liveEvidenceObjectsVerified:1,deletedEvidenceObjectsVerified:1,syntheticObjectMappings:0});
});
it.each(['missing','changed'])('refuses %s bytes for live evidence',async(kind)=>{
  const verify=await verifier();
  expect(()=>verify([live],kind==='missing'?[]:[{...object,digest:'f'.repeat(64)}],'kms:real-test'))
    .toThrow('BACKUP_LIVE_EVIDENCE_OBJECT_MISSING_OR_CHANGED');
});
it('refuses retained bytes for tombstoned evidence instead of putting them in the restored store',async()=>{
  const verify=await verifier();
  expect(()=>verify([live,deleted],[object,{key:deleted.object_store_key,digest:deleted.content_hash}],'kms:real-test'))
    .toThrow('BACKUP_DELETED_EVIDENCE_OBJECT_PRESENT');
});
it.each(['source_deleted_at','key_deleted_at'] as const)('refuses an inconsistent %s tombstone',async(column)=>{
  const verify=await verifier();
  expect(()=>verify([live,{...deleted,[column]:null}],[object],'kms:real-test')).toThrow('BACKUP_EVIDENCE_DELETION_STATE_MISMATCH');
});
it('refuses mappings whose query omitted deletion state',async()=>{
  const verify=await verifier();
  expect(()=>verify([{object_store_key:live.object_store_key,encryption_key_ref:live.encryption_key_ref,content_hash:live.content_hash}],
    [object],'kms:real-test')).toThrow('BACKUP_EVIDENCE_DELETION_STATE_MISMATCH');
});
it.each([live,deleted])('never bypasses provider validation for an unknown live or deleted mapping',async(mapping)=>{
  const verify=await verifier();
  expect(()=>verify([live,{...mapping,encryption_key_ref:'kms:unknown'}],[object],'kms:real-test')).toThrow('BACKUP_UNKNOWN_OBJECT_PROVIDER');
});
it('counts declared synthetic ports separately and still requires real live evidence coverage',async()=>{
  const verify=await verifier(),synthetic={...live,object_store_key:'raw/double',encryption_key_ref:'kms:test-double'};
  expect(verify([live,synthetic],[object],'kms:real-test')).toEqual({liveEvidenceObjectsVerified:1,deletedEvidenceObjectsVerified:0,syntheticObjectMappings:1});
  expect(()=>verify([synthetic,deleted],[],'kms:real-test')).toThrow('BACKUP_DURABLE_EVIDENCE_FIXTURE_EMPTY');
});
