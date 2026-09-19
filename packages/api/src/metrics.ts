import type {FastifyInstance,FastifyRequest} from 'fastify';
import type {OwnerTransaction} from '@unai/postgres';
import {metricsViewSchema,publicShadowRunSchema,shadowRunsViewSchema,
  type MetricKey,type MetricValue,type MetricsView} from '@unai/domain';
import {uuidV7} from '../../../src/kernel/identities.js';
import {readPerformance} from './performance.js';

type Work=(request:FastifyRequest,run:(tx:OwnerTransaction,sessionId:string)=>Promise<unknown>)=>Promise<unknown>;

/** The economic and quality metrics backend (PRD §20.6, §45; design entity
 * `economic_and_quality_metrics`, screen "Metrics and cost"; CRT-WRT-10-A), and
 * the shadow evaluation runs of the "Registry release and migration" screen.
 *
 * The metrics are computed from counts the reviewed definer function
 * `unai_private.economic_and_quality_inputs` returns for the calling owner under
 * `ops.metrics.read` -- a purpose no table policy admits to row content -- and
 * each computed value is recorded as its own append-only row. Values are exact
 * decimal strings computed with integer arithmetic; a zero denominator is an
 * undefined value (null), never a zero. */
export const METRICS_READ_PURPOSE='ops.metrics.read';
export const SHADOW_READ_PURPOSE='ops.shadow.read';
export const METRICS_VERSION='metrics-0.1.0';
const DAY_MS=86400000;
const MAX_WINDOW_MS=366*DAY_MS;

/** Metrics whose inputs no delivered component records yet. They are listed as
 * not measured, with the reason, rather than written as a number. */
const NOT_MEASURED:ReadonlyArray<{metricKey:MetricKey;reason:string}>=Object.freeze([
  {metricKey:'overlay_visibility_success',reason:'VISIBILITY_PROBES_NOT_RECORDED'},
  {metricKey:'false_certainty_incidents',reason:'INCIDENT_LABELS_NOT_RECORDED'},
  {metricKey:'unsupported_personal_claim_rate',reason:'GROUNDING_OUTCOMES_NOT_AGGREGATED'},
  {metricKey:'clarification_prompts_per_active_day',reason:'CLARIFICATION_CARDS_NOT_RECORDED'},
  {metricKey:'repeated_question_violation_rate',reason:'CLARIFICATION_CARDS_NOT_RECORDED'},
]);

export interface EconomicAndQualityInputs{
  sourceItems:number;modelCalls:number;modelCostMicrounits:number;canonicalClaims:number;acceptedBeliefs:number;
  acceptedBeliefsRetrieved:number;extractedClaims:number;extractedClaimsNeverUsed:number;tierRoutes:Record<string,number>;
  operations:Record<string,number>;frameMerges:number;frameMergesSplitLater:number;entitiesCreated:number;entityMerges:number;
  entityMergesSplitLater:number;rebuildsCompared:number;rebuildsEqual:number;
}

/** numerator/denominator to six decimals, truncated, with integer arithmetic
 * only; null when the denominator is zero. */
export function exactRatio(numerator:bigint,denominator:bigint):string|null{
  if(denominator===0n)return null;
  const scaled=(numerator*1000000n)/denominator;
  const whole=scaled/1000000n, fraction=(scaled%1000000n).toString().padStart(6,'0');
  return whole.toString()+'.'+fraction;
}

/** The pure half: counts in, metric values out. */
export function computeMetrics(inputs:EconomicAndQualityInputs):MetricValue[]{
  const n=(value:number|undefined)=>BigInt(Math.trunc(value??0));
  const metric=(metricKey:MetricKey,unit:MetricValue['unit'],numerator:number,denominator:number):MetricValue=>
    ({metricKey,unit,value:exactRatio(n(numerator),n(denominator)),numerator,denominator,distribution:null});
  const cost=inputs.modelCostMicrounits;
  const operations=inputs.operations;
  const routed=Object.values(inputs.tierRoutes).reduce((total,count)=>total+count,0);
  return [
    metric('cost_per_source_item','MICROUNITS_PER_ITEM',cost,inputs.sourceItems),
    metric('cost_per_canonical_claim','MICROUNITS_PER_ITEM',cost,inputs.canonicalClaims),
    metric('cost_per_accepted_belief','MICROUNITS_PER_ITEM',cost,inputs.acceptedBeliefs),
    metric('cost_per_belief_later_retrieved','MICROUNITS_PER_ITEM',cost,inputs.acceptedBeliefsRetrieved),
    metric('extracted_claims_never_used','RATIO',inputs.extractedClaimsNeverUsed,inputs.extractedClaims),
    {metricKey:'tier_routing_distribution',unit:'COUNT',value:routed.toString(),numerator:routed,denominator:null,
      distribution:{...inputs.tierRoutes}},
    // Per accepted belief of the window: how often the owner confirmed one, and
    // how often they said one was wrong (a correction or a rejected
    // interpretation). A later change of state is not an error and is excluded.
    metric('user_confirmation_rate','RATIO',operations['CONFIRM']??0,inputs.acceptedBeliefs),
    metric('user_correction_rate','RATIO',(operations['CORRECT']??0)+(operations['REJECT']??0),inputs.acceptedBeliefs),
    // A merge whose survivor was split again afterwards was a false merge.
    metric('false_instance_merge_rate','RATIO',inputs.frameMergesSplitLater,inputs.frameMerges),
    metric('entity_false_merge_rate','RATIO',inputs.entityMergesSplitLater,inputs.entityMerges),
    // Two entities the resolver kept apart and the owner merged were a false split.
    metric('entity_false_split_rate','RATIO',inputs.entityMerges,inputs.entitiesCreated),
    metric('projection_rebuild_equivalence','RATIO',inputs.rebuildsEqual,inputs.rebuildsCompared),
  ];
}

export async function readEconomicAndQualityMetrics(tx:OwnerTransaction,window:{windowStart:Date;windowEnd:Date}):Promise<MetricsView>{
  const inputs=(await tx.query('SELECT unai_private.economic_and_quality_inputs($1,$2) AS inputs',
    [window.windowStart,window.windowEnd])).rows[0]?.inputs as EconomicAndQualityInputs|null|undefined;
  if(!inputs)throw new Error('METRICS_INPUTS_REFUSED');
  const metrics=computeMetrics(inputs);
  const recordedAt=(await tx.query('SELECT now() AS now')).rows[0]!.now as Date;
  const ids:string[]=[];
  for(const metric of metrics){
    const id=uuidV7();
    ids.push(id);
    await tx.query(`INSERT INTO economic_and_quality_metrics(id,owner_scope_id,metric_key,unit,value,numerator,denominator,
      distribution,window_start,window_end,metrics_version,correlation_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [id,tx.context.ownerScopeId,metric.metricKey,metric.unit,metric.value,metric.numerator,metric.denominator,
      metric.distribution?JSON.stringify(metric.distribution):null,window.windowStart,window.windowEnd,METRICS_VERSION,
      tx.context.correlationId]);
  }
  await tx.audit({policyDecision:'ALLOW',codeVersion:METRICS_VERSION,result:'SUCCESS',
    objects:ids.map(id=>({type:'economic_and_quality_metrics',id,fields:['metric_key','value','numerator','denominator']}))});
  return metricsViewSchema.parse({windowStart:window.windowStart.toISOString(),windowEnd:window.windowEnd.toISOString(),
    metricsVersion:METRICS_VERSION,metrics,performance:await readPerformance(tx,window.windowStart,window.windowEnd),
    notMeasured:[...NOT_MEASURED],recordedAt:recordedAt.toISOString()});
}

function instant(value:unknown):Date|null{
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(value))return null;
  const parsed=new Date(value);
  return Number.isNaN(parsed.getTime())?null:parsed;
}

export function registerMetricsRoutes(app:FastifyInstance,work:Work){
  /** Design screen "Metrics and cost". The window defaults to the last 30 days. */
  app.get<{Querystring:{windowStart?:string;windowEnd?:string}}>('/v1/ops/metrics',async(request,reply)=>{
    const now=new Date();
    const windowEnd=request.query.windowEnd===undefined?now:instant(request.query.windowEnd);
    const windowStart=request.query.windowStart===undefined&&windowEnd?new Date(windowEnd.getTime()-30*DAY_MS):instant(request.query.windowStart);
    if(!windowStart||!windowEnd||windowStart>=windowEnd||windowEnd.getTime()-windowStart.getTime()>MAX_WINDOW_MS){
      return reply.code(400).send({code:'METRICS_WINDOW_INVALID'});
    }
    return work(request,tx=>readEconomicAndQualityMetrics(tx,{windowStart,windowEnd}));
  });
  /** The recorded shadow evaluation runs (design screen "Registry release and
   * migration"): counts of what changed and whether production stayed
   * unchanged, never an entry's contents. */
  app.get('/v1/ops/shadow-evaluations',async request=>work(request,async tx=>{
    const rows=(await tx.query(`SELECT id,run_kind,baseline_version,candidate_version,sample_ref,cost_and_latency_diff,
        production_unchanged,created_at,
        (instance_match_diff->>'changed')::int AS instance_match,(slot_collision_diff->>'changed')::int AS slot_collision,
        (proposition_diff->>'changed')::int AS proposition,(belief_status_diff->>'changed')::int AS belief_status,
        (resolution_diff->>'changed')::int AS resolution,(projection_diff->>'changed')::int AS projection
      FROM shadow_evaluation_runs ORDER BY created_at DESC,id DESC LIMIT 20`)).rows;
    const runs=rows.map(row=>publicShadowRunSchema.parse({shadowRunId:row.id,runKind:row.run_kind,
      baselineVersion:row.baseline_version,candidateVersion:row.candidate_version,sampleRef:row.sample_ref,
      changed:{instanceMatch:row.instance_match,slotCollision:row.slot_collision,proposition:row.proposition,
        beliefStatus:row.belief_status,resolution:row.resolution,projection:row.projection},
      costAndLatency:row.cost_and_latency_diff,productionUnchanged:row.production_unchanged,
      createdAt:(row.created_at as Date).toISOString()}));
    await tx.audit({policyDecision:'ALLOW',codeVersion:'0.1.0',result:'SUCCESS',
      objects:runs.map(run=>({type:'shadow_evaluation_runs',id:run.shadowRunId,fields:['run_kind','baseline_version',
        'candidate_version','production_unchanged']}))});
    return shadowRunsViewSchema.parse({runs});
  }));
}
