import React from 'react';
import type {MetricsView} from '@unai/domain';

/** All numbers are the metrics route's exact values, including undefined ratios. */
export function ModelCostReadout({view}:{view:MetricsView|null}){
 return <section className="card" aria-labelledby="model-cost-heading">
  <h2 id="model-cost-heading">Answering model and costs</h2>
  {!view?<p>Model and metrics are unavailable. Reload to retry.</p>:<>
   {view.answeringModel?<dl><dt>Answering provider</dt><dd>{view.answeringModel.provider}</dd><dt>Answering model</dt><dd>{view.answeringModel.model}</dd></dl>:<p>Answering provider and model are unavailable.</p>}
   {view.answeringModel?.mode==='deterministic'&&<p>The deterministic composer answers in this deployment; no language model is called to phrase answers.</p>}
   <p>Metrics window: {view.windowStart} to {view.windowEnd}. Read-only values recorded by {view.metricsVersion}.</p>
   <div style={{overflowX:'auto'}}><table><caption>Recorded cost and usage counters</caption>
    <thead><tr><th scope="col">Metric</th><th scope="col">Value</th><th scope="col">Unit</th><th scope="col">Numerator</th><th scope="col">Denominator</th></tr></thead>
    <tbody>{view.metrics.map(metric=><tr key={metric.metricKey}>
     <th scope="row">{metric.metricKey.replaceAll('_',' ')}</th><td>{metric.value??'Undefined'}</td><td>{metric.unit}</td>
     <td>{metric.numerator??'Not recorded'}</td><td>{metric.denominator??'Not recorded'}</td>
    </tr>)}</tbody>
   </table></div>
   {view.metrics.filter(metric=>metric.distribution!==null).map(metric=><dl key={metric.metricKey} aria-label={metric.metricKey.replaceAll('_',' ')}>
    {Object.entries(metric.distribution??{}).map(([label,value])=><React.Fragment key={label}><dt>{label}</dt><dd>{value}</dd></React.Fragment>)}
   </dl>)}
   {view.notMeasured.length>0&&<p>Not measured: {view.notMeasured.map(metric=>metric.metricKey.replaceAll('_',' ')).join(', ')}.</p>}
  </>}
  <a href="/ops/metrics">Full metrics and cost report</a>
 </section>;
}
