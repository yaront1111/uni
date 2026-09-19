// These exact test-only ports never claimed bytes in the configured S3 store.
// Unknown providers must not silently evade verification.
const fixtureProviders=new Set(['kms:test','kms:test-double','kms:live-test']);

/** Validate the quiescent evidence/object snapshot before archiving any bytes.
 * Erasure retains source and key tombstones but removes the object. Requiring
 * that object to be absent prevents restoring data the owner already deleted. */
export function verifyEvidenceObjects(mappings,objects,realKeyRef){
  const objectByKey=new Map(objects.map(object=>[object.key,object]));
  let liveEvidenceObjectsVerified=0,deletedEvidenceObjectsVerified=0,syntheticObjectMappings=0;
  for(const mapping of mappings){
    const durable=mapping.encryption_key_ref===realKeyRef;
    if(!durable&&!fixtureProviders.has(mapping.encryption_key_ref))throw new Error('BACKUP_UNKNOWN_OBJECT_PROVIDER');
    if(!durable)syntheticObjectMappings++;
    if(mapping.source_deleted_at===undefined||mapping.key_deleted_at===undefined
      ||(mapping.source_deleted_at===null)!==(mapping.key_deleted_at===null))throw new Error('BACKUP_EVIDENCE_DELETION_STATE_MISMATCH');
    const object=objectByKey.get(mapping.object_store_key);
    if(mapping.source_deleted_at!==null){
      if(object)throw new Error('BACKUP_DELETED_EVIDENCE_OBJECT_PRESENT');
      if(durable)deletedEvidenceObjectsVerified++;
    }else if(durable){
      if(!object||object.digest!==mapping.content_hash)throw new Error('BACKUP_LIVE_EVIDENCE_OBJECT_MISSING_OR_CHANGED');
      liveEvidenceObjectsVerified++;
    }
  }
  if(!liveEvidenceObjectsVerified)throw new Error('BACKUP_DURABLE_EVIDENCE_FIXTURE_EMPTY');
  return {liveEvidenceObjectsVerified,deletedEvidenceObjectsVerified,syntheticObjectMappings};
}
