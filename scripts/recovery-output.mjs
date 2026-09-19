/** v1: generated read receipt ids differ; their packet hashes cover those ids.
 * Everything else, including source ids, facts, labels, order and watermarks,
 * remains part of the equality assertion. */
const receiptFields=new Set(['packetId','contextPacketId','packetHash','briefingEditionId','briefingItemId']);
export function comparableRecoveryOutput(value){
  if(Array.isArray(value))return value.map(comparableRecoveryOutput);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value)
    .filter(([key])=>!receiptFields.has(key)).map(([key,item])=>[key,comparableRecoveryOutput(item)]));
  return value;
}
