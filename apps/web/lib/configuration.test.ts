import {expect,it,vi} from 'vitest';
import {DEFAULT_VOICE_SETTINGS} from '@unai/domain';
import {loadConfiguration} from './configuration';
it('reads all Configuration data using the supplied authenticated owner and exact existing purposes',async()=>{
 const call=vi.fn(async(path:string)=>({status:200,body:path==='/v1/settings/voice'?DEFAULT_VOICE_SETTINGS:path==='/v1/connectors'?{connectors:[]}:path==='/v1/devices'?{devices:[]}:{}}));
 const result=await loadConfiguration(call,{cookie:'authenticated',ownerScopeId:'owner-scope'},null);
 expect(result.kind).toBe('props');if(result.kind!=='props')return;
 expect(result.props.voice).toEqual(DEFAULT_VOICE_SETTINGS);expect(result.props.metrics).toBeNull();
 for(const [path,purpose] of [['/v1/settings/voice','settings.voice'],['/v1/ops/metrics','ops.metrics.read'],['/v1/connectors','connector.read'],['/v1/devices','device.list'],['/v1/permissions','permissions.read'],['/v1/approval-rules','approval.rules']]){
  expect(call).toHaveBeenCalledWith(path,'GET',expect.objectContaining({cookie:'authenticated','x-owner-scope-id':'owner-scope','x-purpose':purpose,'x-correlation-id':expect.any(String)}));
 }
 const calls=call.mock.calls as unknown as Array<[string,string,Record<string,string>]>;
 expect(new Set(calls.map(row=>row[2]['x-correlation-id'])).size).toBe(6);
});
it('expires the entire page on any session-expired read and does not fabricate failed voice settings',async()=>{
 expect(await loadConfiguration(async()=>({status:401,body:{}}),{cookie:'expired',ownerScopeId:'owner'},null)).toEqual({kind:'expired'});
 const failed=await loadConfiguration(async()=>{throw new Error('private transport detail');},{cookie:'owner',ownerScopeId:'owner'},null);
 expect(failed.kind).toBe('props');if(failed.kind!=='props')return;
 expect(failed.props.voice).toBeNull();expect(failed.props.metrics).toBeNull();expect(JSON.stringify(failed)).not.toContain('private transport detail');
});
