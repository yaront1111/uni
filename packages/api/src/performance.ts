import type {OwnerTransaction} from '@unai/postgres';
import {performanceMeasurementSchema,type PerformanceMeasurement} from '@unai/domain';
import {uuidV7} from '../../../src/kernel/identities.js';

const SCENARIOS=['EVIDENCE_INGESTION_ACK','TYPED_PROJECTION_READ','CONTEXT_PACKET_ASSEMBLY'] as const;
type Scenario=typeof SCENARIOS[number];

/** Nearest-rank P95. Every attempt must succeed; failures abort the run rather
 * than disappear from a success-only latency distribution. Recording happens
 * after timing, and the three results commit atomically in one transaction. */
export async function recordLoadRun(options:{
  operations:Record<Scenario,()=>Promise<void>>;sampleCount:number;concurrency:number;
  record<T>(run:(tx:OwnerTransaction)=>Promise<T>):Promise<T>;
}):Promise<PerformanceMeasurement[]>{
  const {sampleCount,concurrency}=options;
  if(!Number.isInteger(sampleCount)||sampleCount<20||sampleCount>100000||!Number.isInteger(concurrency)||concurrency<1||concurrency>128){
    throw new Error('LOAD_CONFIGURATION_INVALID');
  }
  const samples=new Map<Scenario,number[]>();
  for(const scenario of SCENARIOS){
    const durations:number[]=[];
    let next=0;
    const workers=await Promise.allSettled(Array.from({length:Math.min(concurrency,sampleCount)},async()=>{
      while(next++<sampleCount){
        const start=performance.now();
        await options.operations[scenario]();
        durations.push(performance.now()-start);
      }
    }));
    const failed=workers.find(worker=>worker.status==='rejected');
    if(failed?.status==='rejected')throw failed.reason;
    samples.set(scenario,durations);
  }
  const runId=uuidV7();
  return options.record(async tx=>{
    const results:PerformanceMeasurement[]=[];
    for(const scenario of SCENARIOS){
      const values=samples.get(scenario)!;
      const p95=[...values].sort((a,b)=>a-b)[Math.ceil(values.length*0.95)-1]!;
      const id=uuidV7();
      const row=(await tx.query(`INSERT INTO performance_measurements(id,owner_scope_id,run_id,scenario,p95_ms,sample_count,
        concurrency,samples_ms,excludes_llm_generation,harness_version,correlation_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,true,'load-harness-0.1.0',$9) RETURNING recorded_at`,
        [id,tx.context.ownerScopeId,runId,scenario,p95,sampleCount,concurrency,values,tx.context.correlationId])).rows[0]!;
      results.push(performanceMeasurementSchema.parse({id,runId,scenario,p95Ms:p95,sampleCount,concurrency,
        excludesLlmGeneration:true,recordedAt:(row.recorded_at as Date).toISOString()}));
    }
    await tx.audit({policyDecision:'ALLOW',codeVersion:'load-harness-0.1.0',result:'SUCCESS',
      objects:results.map(row=>({type:'performance_measurements',id:row.id,fields:['scenario','p95_ms','sample_count']}))});
    return results;
  });
}

export async function readPerformance(tx:OwnerTransaction,start:Date,end:Date):Promise<PerformanceMeasurement[]>{
  const rows=(await tx.query(`SELECT DISTINCT ON (scenario) id,run_id,scenario,p95_ms,sample_count,concurrency,excludes_llm_generation,recorded_at FROM performance_measurements
    WHERE recorded_at >= $1 AND recorded_at < $2 ORDER BY scenario,recorded_at DESC,id DESC`,[start,end])).rows;
  if(rows.length)await tx.audit({policyDecision:'ALLOW',codeVersion:'load-harness-0.1.0',result:'SUCCESS',
    objects:rows.map(row=>({type:'performance_measurements',id:row.id as string,fields:['scenario','p95_ms','sample_count','recorded_at']}))});
  return SCENARIOS.flatMap(scenario=>{
    const row=rows.find(row=>row.scenario===scenario);
    return row?[performanceMeasurementSchema.parse({id:row.id,runId:row.run_id,scenario:row.scenario,p95Ms:row.p95_ms,
      sampleCount:row.sample_count,concurrency:row.concurrency,excludesLlmGeneration:row.excludes_llm_generation,
      recordedAt:(row.recorded_at as Date).toISOString()})]:[];
  });
}
