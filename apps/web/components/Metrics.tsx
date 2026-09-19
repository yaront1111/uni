import React from 'react';
import type {MetricKey,MetricValue,MetricsView} from '@unai/domain';
import {Navigation} from './Navigation';

export interface MetricsProps {
  /** The metrics the backend computed for the window, or null when none were read. */
  view:MetricsView|null;
  error?:string;
}

const labels:Record<MetricKey,string>={
  cost_per_source_item:'Cost per source item',
  cost_per_canonical_claim:'Cost per canonical claim',
  cost_per_accepted_belief:'Cost per accepted belief',
  cost_per_belief_later_retrieved:'Cost per belief later retrieved',
  extracted_claims_never_used:'Extracted claims never used',
  tier_routing_distribution:'Tier routing distribution',
  user_confirmation_rate:'User confirmation rate',
  user_correction_rate:'User correction rate',
  false_instance_merge_rate:'False instance-merge rate',
  entity_false_merge_rate:'Entity false-merge rate',
  entity_false_split_rate:'Entity false-split rate',
  overlay_visibility_success:'Overlay visibility success',
  projection_rebuild_equivalence:'Projection rebuild equivalence',
  false_certainty_incidents:'False certainty incidents',
  unsupported_personal_claim_rate:'Unsupported personal claim rate',
  clarification_prompts_per_active_day:'Clarification prompts per active day',
  repeated_question_violation_rate:'Repeated question violation rate',
};
/** The screen's sections, in the order the design draws them. */
const sections:ReadonlyArray<{id:string;title:string;keys:readonly MetricKey[];extra?:readonly string[]}>=[
  {id:'cost',title:'Cost',keys:['cost_per_source_item','cost_per_canonical_claim','cost_per_accepted_belief','cost_per_belief_later_retrieved']},
  {id:'usage',title:'Usage and routing',keys:['extracted_claims_never_used','tier_routing_distribution'],
    extra:['Source-only items later promoted','Model cost by connector and capability']},
  {id:'owner',title:'Owner review',keys:['user_confirmation_rate','user_correction_rate']},
  {id:'identity',title:'Identity quality',keys:['false_instance_merge_rate','entity_false_merge_rate','entity_false_split_rate'],
    extra:['False proposition-collision rate']},
  {id:'trust',title:'Trust',keys:['false_certainty_incidents','unsupported_personal_claim_rate','overlay_visibility_success',
    'projection_rebuild_equivalence']},
  {id:'attention',title:'Attention cost',keys:['clarification_prompts_per_active_day','repeated_question_violation_rate']},
];
const reasons:Record<string,string>={
  VISIBILITY_PROBES_NOT_RECORDED:'No read-after-write probe is recorded yet.',
  INCIDENT_LABELS_NOT_RECORDED:'No false-certainty incident is labelled yet.',
  GROUNDING_OUTCOMES_NOT_AGGREGATED:'Grounding validator outcomes are not aggregated yet.',
  CLARIFICATION_CARDS_NOT_RECORDED:'No clarification card is recorded yet.',
};
function unitText(metric:MetricValue){
  if(metric.value===null)return 'Undefined: nothing to divide by in this window';
  return metric.unit==='MICROUNITS_PER_ITEM'?metric.value+' microunits'
    :metric.unit==='RATIO'?(Number(metric.value)*100).toFixed(2)+' %':metric.value;
}
const day=(value:string)=>value.slice(0,10);

export function Metrics({view,error}:MetricsProps){
  const measured=new Map((view?.metrics??[]).map(metric=>[metric.metricKey,metric]));
  const notMeasured=new Map((view?.notMeasured??[]).map(entry=>[entry.metricKey,entry.reason]));
  return <div className="shell">
    <a className="skip" href="#content">Skip to content</a>
    <header><a href="/" className="brand">Uai</a><span>Your personal memory</span></header>
    <Navigation current="metrics"/>
    <main id="content" tabIndex={-1}>
      <p className="eyebrow">OPERATIONS</p>
      <h1>Metrics and cost</h1>
      {error?<p role="alert">{error}</p>:!view?<p>No metrics have been computed for this owner scope.</p>:<>
        <p>Window {day(view.windowStart)} to {day(view.windowEnd)}, computed by {view.metricsVersion}. Every value is
          recorded as its own measurement; a rate with nothing to divide by is shown as undefined, never as zero.</p>
        {sections.map(section=><section key={section.id} className="card" aria-labelledby={'metrics-'+section.id}>
          <h2 id={'metrics-'+section.id}>{section.title}</h2>
          <table><caption className="sr-only">{section.title} metrics</caption>
            <thead><tr><th scope="col">Metric</th><th scope="col">Value</th><th scope="col">Counted</th></tr></thead>
            <tbody>
              {section.keys.map(key=>{
                const metric=measured.get(key);
                return <tr key={key}>
                  <th scope="row">{labels[key]}</th>
                  <td>{metric?unitText(metric):'Not measured'}</td>
                  <td>{metric?.distribution?Object.entries(metric.distribution).map(([route,count])=>route+': '+count).join(', ')
                    :metric&&metric.denominator!==null?metric.numerator+' of '+metric.denominator
                    :reasons[notMeasured.get(key)??'']??'Not recorded by this deployment yet.'}</td>
                </tr>;
              })}
              {(section.extra??[]).map(label=><tr key={label}>
                <th scope="row">{label}</th><td>Not measured</td><td>Not recorded by this deployment yet.</td>
              </tr>)}
            </tbody>
          </table>
        </section>)}
        <section className="card" aria-labelledby="metrics-performance">
          <h2 id="metrics-performance">Performance</h2>
          <p>Recorded load measurements. LLM generation excluded. Targets use a strict upper bound.</p>
          {!view.performance?.length?<p>Not measured: no load harness run is recorded in this window.</p>:null}
          <table><caption className="sr-only">Performance measurements</caption>
            <thead><tr><th scope="col">Operation</th><th scope="col">P95</th><th scope="col">Target</th><th scope="col">Load run</th></tr></thead>
            <tbody>{([
              ['EVIDENCE_INGESTION_ACK','Evidence ingestion acknowledgement',1000],
              ['TYPED_PROJECTION_READ','Typed projection read',500],
              ['CONTEXT_PACKET_ASSEMBLY','Context packet assembly',1500],
            ] as const).map(([scenario,label,target])=>{
              const result=view.performance?.find(row=>row.scenario===scenario);
              return <tr key={scenario}><th scope="row">{label}</th>
                <td>{result?result.p95Ms.toFixed(2)+' ms':'Not measured'}</td>
                <td>Under {target} ms{result?': '+(result.p95Ms<target?'Target met':'Target missed'):''}</td>
                <td>{result?<>{result.sampleCount} samples, concurrency {result.concurrency}; <time dateTime={result.recordedAt}>{result.recordedAt}</time></>:'No measurement in this window.'}</td>
              </tr>;
            })}</tbody>
          </table>
        </section>
      </>}
    </main>
    <footer>Costs are model spend recorded by the gateway for every call; nothing here is estimated.</footer>
  </div>;
}
