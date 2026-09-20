import {randomUUID} from 'node:crypto';
import {voiceSettingsSchema,metricsViewSchema,publicConnectorSchema,publicDeviceSchema,permissionsViewSchema,learnedApprovalRulesViewSchema} from '@unai/domain';
import type {ApiCall,Caller} from './screens';
import type {ConfigurationProps} from '../components/Configuration';

/** Owner-authorized reads only; failures never turn into invented settings or counters. */
export async function loadConfiguration(call:ApiCall,caller:Caller,currentDeviceId:string|null){
 const props:ConfigurationProps={voice:null,metrics:null,connectors:[],devices:[],permissions:null,approvalRules:null,currentDeviceId,errors:[]};
 let expired=false;
 async function read(path:string,purpose:string,apply:(body:unknown)=>void,label:string){
  try{const response=await call(path,'GET',{cookie:caller.cookie,'x-owner-scope-id':caller.ownerScopeId,'x-purpose':purpose,'x-correlation-id':randomUUID()});
   if(response.status===401){expired=true;return;}
   if(response.status!==200)throw new Error('unavailable');apply(response.body);
  }catch{props.errors.push(label+' could not be loaded. Reload to retry.');}
 }
 await Promise.all([
  read('/v1/settings/voice','settings.voice',body=>{props.voice=voiceSettingsSchema.parse(body);},'Voice settings'),
  read('/v1/ops/metrics','ops.metrics.read',body=>{props.metrics=metricsViewSchema.parse(body);},'Model and metrics'),
  read('/v1/connectors','connector.read',body=>{props.connectors=publicConnectorSchema.array().parse((body as {connectors:unknown}).connectors);},'Connected sources'),
  read('/v1/devices','device.list',body=>{props.devices=publicDeviceSchema.array().parse((body as {devices:unknown}).devices);},'Devices'),
  read('/v1/permissions','permissions.read',body=>{props.permissions=permissionsViewSchema.parse(body);},'Permissions'),
  read('/v1/approval-rules','approval.rules',body=>{props.approvalRules=learnedApprovalRulesViewSchema.parse(body);},'Approval rules'),
 ]);
 return expired?{kind:'expired' as const}:{kind:'props' as const,props};
}
