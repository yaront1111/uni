import {expect,it,vi} from 'vitest';
import {loadAdminMemory} from './admin-memory';
import {inspection} from '../components/testing/inspection';
import type {ApiCall} from './memory';
const owner='0192f3a0-0000-7000-8000-000000000099';
const caller={cookie:'session=private',ownerScopeId:owner};
const empty=(kind:string)=>({projectionName:kind==='commitments'?'open_commitments_projection':kind+'_projection',rows:[],
  isComplete:true,ownerOverlayWatermark:0,canonicalTransactionWatermark:'2026-01-01T00:00:00.000Z',projectionVersion:null,
  reducerVersion:'projection-1',pendingAssertions:[],highRiskActionsBlocked:false,readAt:'2026-01-01T00:00:00.000Z'});
it('reads projections and selected inspector through existing owner-scoped routes only',async()=>{
  const call=vi.fn<ApiCall>(async path=>({status:200,body:path==='/v1/memory/transactions'?{proposals:[],atLimit:false}:path.startsWith('/v1/memory/inspector/')?inspection():empty(path.split('/')[3]!.split('?')[0]!)}));
  const result=await loadAdminMemory(call,caller,{id:inspection().subject.requestedId,type:'proposition'});
  expect(result).toEqual({kind:'props',props:{frames:[],errors:[],inspector:inspection(),review:null,proposals:[],proposalsAtLimit:false}});
  expect(call.mock.calls.map(([path])=>path)).toEqual(['/v1/projections/commitments?includeResolved=true','/v1/projections/obligations?includeResolved=true','/v1/projections/schedule?includeResolved=true','/v1/memory/inspector/proposition/'+inspection().subject.requestedId,'/v1/memory/transactions']);
  const correlations=new Set<string>();
  for(const [,method,headers] of call.mock.calls){
    expect(method).toBe('GET');expect(headers.cookie).toBe(caller.cookie);expect(headers['x-owner-scope-id']).toBe(owner);
    expect(headers['x-data-purpose']).toBe('PERSONAL_ASSISTANCE');correlations.add(headers['x-correlation-id']!);
  }
  expect(correlations.size).toBe(5);
});
it('discards partial data on session expiry and does not expose refusal details',async()=>{
  const expired=vi.fn<ApiCall>(async()=>({status:401,body:{}}));
  expect(await loadAdminMemory(expired,caller,{})).toEqual({kind:'expired'});expect(expired).toHaveBeenCalledTimes(1);
  const refused:ApiCall=async()=>({status:403,body:{secret:'INTERNAL DETAIL'}});
  const result=await loadAdminMemory(refused,caller,{id:'invalid'});
  expect(JSON.stringify(result)).not.toContain('INTERNAL DETAIL');
  expect(result.kind==='props'&&result.props.errors.length).toBe(5);
});
