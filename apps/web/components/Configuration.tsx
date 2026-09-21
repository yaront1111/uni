import React from 'react';
import type {VoiceSettings,MetricsView,PublicConnector,PublicDevice,PermissionsView,LearnedApprovalRulesView} from '@unai/domain';
import {Shell} from './Shell';
import {Connectors} from './Connectors';
import {Access} from './Access';
import {VoiceSettingsPanel} from './VoiceSettingsPanel';
import {ModelCostReadout} from './ModelCostReadout';
import {Permissions,type PermissionsProps} from './Permissions';
import {ApprovalRules} from './ApprovalRules';
import {DataControl} from './DataControl';

export interface ConfigurationProps{
 voice:VoiceSettings|null;metrics:MetricsView|null;connectors:PublicConnector[];devices:PublicDevice[];
 currentDeviceId:string|null;errors:string[];selectedConnectorId?:string|null;
 permissions?:PermissionsView|null;approvalRules?:LearnedApprovalRulesView|null;saved?:PermissionsProps['saved'];
}
export function Configuration(props:ConfigurationProps){
 return <Shell current={null} eyebrow="ADMIN" title="Configuration">
  {props.errors.map(error=><p role="alert" key={error}>{error}</p>)}
  <Connectors embedded connectors={props.connectors} selected={props.connectors.find(c=>c.connectorId===props.selectedConnectorId)??null}
   lastSync={null} state="IDLE" refusal={null} error={null}/>
  <section className="card" aria-labelledby="configuration-policy"><h2 id="configuration-policy">Permissions and policies</h2>
   <p><a href="/permissions">Permissions, source scopes, domain sensitivity, plugin capabilities and attention budgets</a></p>
   <p><a href="/memory/approval-rules">Review, approve and revoke approval rules</a></p>
  </section>
  <Permissions embedded view={props.permissions??null} saved={props.saved??null} error={null}/>
  {props.approvalRules?<ApprovalRules embedded view={props.approvalRules}/>:<p>Approval rules could not be loaded. Reload to retry.</p>}
  <section className="card" aria-labelledby="configuration-data"><h2 id="configuration-data">Data controls</h2>
   <p><a href="/data">Export or delete my data, preview deletion and view its receipt</a></p>
   <p><a href="/permissions#retention-heading">Manage retention rules</a></p>
  </section>
  <DataControl embedded state="IDLE" exportSummary={null} reindex={null} preview={null} receipt={null} error={null}/>
  <Access embedded state={props.devices.find(device=>device.id===props.currentDeviceId)?.kind==='PHONE'?'phone':'desktop'} devices={props.devices} registered={!!props.currentDeviceId} currentDeviceId={props.currentDeviceId}/>
  <VoiceSettingsPanel settings={props.voice}/>
  <ModelCostReadout view={props.metrics}/>
 </Shell>;
}
