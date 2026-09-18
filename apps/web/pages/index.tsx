import type {GetServerSideProps} from 'next';
import {randomUUID} from 'node:crypto';
import {Access} from '../components/Access';
import {apiRequest,identity} from '../lib/server';
import {publicDeviceSchema} from '@unai/domain';
export default Access;
export const getServerSideProps:GetServerSideProps=async({req,res})=>{
  res.setHeader('Cache-Control','no-store');
  const session=await identity(req);
  if(!session)return {redirect:{destination:req.headers.cookie?'/signin?reason=expired':'/signin',permanent:false}};
  const response=await apiRequest('/v1/devices','GET',{cookie:req.headers.cookie??'','x-owner-scope-id':session.ownerScopeId,'x-purpose':'device.list','x-correlation-id':randomUUID()});
  if(response.status===401)return {redirect:{destination:'/signin?reason=expired',permanent:false}};
  const data=response.body as {devices?:unknown[]};
  const devices=response.status===200?(data.devices??[]).map(d=>publicDeviceSchema.parse(d)):[];
  const current=devices.find(d=>d.id===session.deviceId);
  return {props:{state:current?.kind==='PHONE'?'phone':'desktop',devices,registered:!!session.deviceId,currentDeviceId:session.deviceId,
    ownerScopeId:session.ownerScopeId,...(response.status!==200?{error:'Devices could not be loaded. Please reload to retry.'}:{})}};
};
