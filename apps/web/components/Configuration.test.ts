import {expect,it} from 'vitest';
import {existsSync} from 'node:fs';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
async function components(){expect(existsSync('apps/web/components/Configuration.tsx')).toBe(true);return import('./Configuration');}
it('verify-d4-policy: The owner can reach and operate each existing permissions, approval-rule and attention-budget setting from Configuration.',async()=>{
 const {Configuration}=await components();const html=renderToStaticMarkup(createElement(Configuration,{voice:null,metrics:null,connectors:[],devices:[],currentDeviceId:null,errors:[]}));
 for(const path of ['/permissions','/memory/approval-rules'])expect(html).toContain('href="'+path+'"');
 expect(html).toContain('attention budgets');
});
it('verify-d4-data: The owner can access and operate the existing export, deletion and retention controls from Configuration.',async()=>{
 const {Configuration}=await components();const html=renderToStaticMarkup(createElement(Configuration,{voice:null,metrics:null,connectors:[],devices:[],currentDeviceId:null,errors:[]}));
 expect(html).toContain('href="/data"');expect(html).toContain('retention');
});
it('verify-d5-voice: Each listed voice setting is present and can be changed, with hands-free off until explicitly enabled.',async()=>{
 await components();const {VoiceSettingsPanel}=await import('./VoiceSettingsPanel');
 const {DEFAULT_VOICE_SETTINGS}=await import('@unai/domain');
 const html=renderToStaticMarkup(createElement(VoiceSettingsPanel,{settings:DEFAULT_VOICE_SETTINGS}));
 for(const label of ['Speech enabled','Microsoft Azure AI Speech','Language','Voice','Speaking rate','Hands-free','Save voice settings'])expect(html).toContain(label);
 expect(html).toMatch(/name="handsFreeEnabled"/);expect(html).not.toMatch(/name="handsFreeEnabled"[^>]*checked/);
});
it('verify-d6-cost: Displayed counters match the metrics-route values and cannot be edited in the UI.',async()=>{
 await components();const {ModelCostReadout}=await import('./ModelCostReadout');
 const html=renderToStaticMarkup(createElement(ModelCostReadout,{view:{windowStart:'2026-09-01T00:00:00.000Z',windowEnd:'2026-09-20T00:00:00.000Z',recordedAt:'2026-09-20T00:00:00.000Z',metricsVersion:'metrics-0.1.0',notMeasured:[],
 answeringModel:{provider:'actual-provider',model:'actual-model',mode:'model'},metrics:[{metricKey:'cost_per_source_item',unit:'MICROUNITS_PER_ITEM',value:'12.345',numerator:2469,denominator:200,distribution:null}]}}));
 for(const value of ['actual-provider','actual-model','12.345','2469','200'])expect(html).toContain(value);
 expect(html).not.toMatch(/<(input|select|button|textarea)\b/);
});
