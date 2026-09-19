import { expect,it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { MetricsView } from '@unai/domain';
import * as screen from './Metrics';

const view:MetricsView={windowStart:'2026-08-20T00:00:00.000Z',windowEnd:'2026-09-19T00:00:00.000Z',metricsVersion:'metrics-0.1.0',
  recordedAt:'2026-09-19T00:00:01.000Z',
  metrics:[
    {metricKey:'cost_per_source_item',unit:'MICROUNITS_PER_ITEM',value:'375.000000',numerator:9000,denominator:24,distribution:null},
    {metricKey:'cost_per_canonical_claim',unit:'MICROUNITS_PER_ITEM',value:'3000.000000',numerator:9000,denominator:3,distribution:null},
    {metricKey:'cost_per_accepted_belief',unit:'MICROUNITS_PER_ITEM',value:'3000.000000',numerator:9000,denominator:3,distribution:null},
    {metricKey:'cost_per_belief_later_retrieved',unit:'MICROUNITS_PER_ITEM',value:null,numerator:9000,denominator:0,distribution:null},
    {metricKey:'extracted_claims_never_used',unit:'RATIO',value:'0.833333',numerator:5,denominator:6,distribution:null},
    {metricKey:'tier_routing_distribution',unit:'COUNT',value:'24',numerator:24,denominator:null,distribution:{FULL_EXTRACTION:6,INDEX_ONLY:18}},
    {metricKey:'user_confirmation_rate',unit:'RATIO',value:'0.333333',numerator:1,denominator:3,distribution:null},
    {metricKey:'user_correction_rate',unit:'RATIO',value:'0.666666',numerator:2,denominator:3,distribution:null},
    {metricKey:'false_instance_merge_rate',unit:'RATIO',value:'0.500000',numerator:1,denominator:2,distribution:null},
    {metricKey:'entity_false_merge_rate',unit:'RATIO',value:null,numerator:0,denominator:0,distribution:null},
    {metricKey:'entity_false_split_rate',unit:'RATIO',value:'0.000000',numerator:0,denominator:4,distribution:null},
    {metricKey:'projection_rebuild_equivalence',unit:'RATIO',value:'1.000000',numerator:3,denominator:3,distribution:null},
  ],
  notMeasured:[{metricKey:'overlay_visibility_success',reason:'VISIBILITY_PROBES_NOT_RECORDED'},
    {metricKey:'false_certainty_incidents',reason:'INCIDENT_LABELS_NOT_RECORDED'},
    {metricKey:'unsupported_personal_claim_rate',reason:'GROUNDING_OUTCOMES_NOT_AGGREGATED'},
    {metricKey:'clarification_prompts_per_active_day',reason:'CLARIFICATION_CARDS_NOT_RECORDED'},
    {metricKey:'repeated_question_violation_rate',reason:'CLARIFICATION_CARDS_NOT_RECORDED'}]};
const render=(props:Partial<screen.MetricsProps>)=>renderToStaticMarkup(createElement(screen.Metrics,{view:null,...props}));

it('renders cost per source item, per canonical claim, per accepted belief and per belief later retrieved',()=>{
  const html=render({view});
  expect(html).toContain('Metrics and cost');
  expect(html).toContain('Cost per source item');
  expect(html).toContain('375.000000 microunits');
  expect(html).toContain('9000 of 24');
  expect(html).toContain('Cost per belief later retrieved');
  // An undefined rate says so, never zero.
  expect(html).toContain('Undefined: nothing to divide by in this window');
  expect(html).toContain('Skip to content');
});

it('renders extracted claims never used, source-only promotion, and the tier routing distribution',()=>{
  const html=render({view});
  expect(html).toContain('Extracted claims never used');
  expect(html).toContain('83.33 %');
  expect(html).toContain('Source-only items later promoted');
  expect(html).toContain('FULL_EXTRACTION: 6, INDEX_ONLY: 18');
  expect(html).toContain('Model cost by connector and capability');
});

it('renders confirmation and correction rates and the merge and split quality rates',()=>{
  const html=render({view});
  expect(html).toContain('User confirmation rate');
  expect(html).toContain('User correction rate');
  expect(html).toContain('2 of 3');
  expect(html).toContain('False instance-merge rate');
  expect(html).toContain('50.00 %');
  expect(html).toContain('Entity false-merge rate');
  expect(html).toContain('Entity false-split rate');
  expect(html).toContain('False proposition-collision rate');
});

it('renders trust, attention cost and performance metrics that are not measured yet as not measured, with the reason',()=>{
  const html=render({view});
  expect(html).toContain('False certainty incidents');
  expect(html).toContain('No false-certainty incident is labelled yet.');
  expect(html).toContain('Unsupported personal claim rate');
  expect(html).toContain('Clarification prompts per active day');
  expect(html).toContain('No clarification card is recorded yet.');
  expect(html).toContain('Performance');
  expect(html).toContain('no load harness run is recorded');
});

it('renders the empty and error states',()=>{
  expect(render({})).toContain('No metrics have been computed');
  expect(render({error:'The metrics could not be read. Please reload to retry.'})).toContain('role="alert"');
});
