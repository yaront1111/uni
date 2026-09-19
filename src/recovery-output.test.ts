import {expect,it} from 'vitest';
// @ts-expect-error JavaScript harness helper.
import {comparableRecoveryOutput} from '../scripts/recovery-output.mjs';
it('recovery comparison removes only generated read receipt identifiers and their derived packet hash',()=>{
  expect(comparableRecoveryOutput({packetId:'new',packetHash:'hash',briefingEditionId:'edition',briefingItemId:'item',
    evidenceId:'source',ownerSequence:7,label:'CONTESTED',explanation:{text:'50 ILS'},watermarks:{canonical:4}}))
    .toEqual({evidenceId:'source',ownerSequence:7,label:'CONTESTED',explanation:{text:'50 ILS'},watermarks:{canonical:4}});
});
it('recovery comparison retains source identities, facts, labels and watermarks',()=>{
  const original={evidenceId:'source',text:'50 ILS',label:'CONFIRMED',watermarks:{canonical:4}};
  for(const changed of [{...original,evidenceId:'other'},{...original,text:'60 ILS'},{...original,label:'UNKNOWN'},
    {...original,watermarks:{canonical:5}}]) expect(comparableRecoveryOutput(changed)).not.toEqual(comparableRecoveryOutput(original));
});
