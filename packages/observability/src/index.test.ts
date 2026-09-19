import {it,expect,vi} from 'vitest';
import {trace} from '@opentelemetry/api';

it('CRT-NFR-05-A: stage spans carry metadata, duration, retry and versions without values or exception text',async()=>{
  const events:Record<string,unknown>[]=[];
  const records:Record<string,unknown>[]=[];
  const logger=vi.spyOn(console,'info').mockImplementation(value=>events.push(JSON.parse(value)));
  const provider={getTracer:()=>({startActiveSpan:(name:string,run:(span:unknown)=>unknown)=>{
    const record:Record<string,unknown>={name};records.push(record);
    return run({setAttributes:(attributes:object)=>Object.assign(record,attributes),setStatus:()=>{},end:()=>{record.ended=true;}});
  }})};
  trace.setGlobalTracerProvider(provider as unknown as Parameters<typeof trace.setGlobalTracerProvider>[0]);
  try{
    const module=await import('./index.js');
    expect(module).toHaveProperty('traceStage');
    const context={ownerScopeId:'01900000-0000-7000-8000-000000000001',correlationId:'01900000-0000-7000-8000-000000000002'};
    await expect(module.traceStage('evidence.persist',context,async()=>{throw new Error('SECRET EVIDENCE');},{attempt:2})).rejects.toThrow('SECRET EVIDENCE');
    expect(records[0]).toMatchObject({'unai.correlation_id':context.correlationId,'unai.owner_scope_id':context.ownerScopeId,
      'unai.result':'FAILURE','unai.retry_state':'RETRY','unai.attempt':2,'unai.code_version':'0.1.0',ended:true});
    expect(records[0]!['unai.duration_ms']).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify([events,records])).not.toContain('SECRET EVIDENCE');
  }finally{trace.disable();logger.mockRestore();}
});
