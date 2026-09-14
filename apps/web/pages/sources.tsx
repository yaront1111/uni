import type {GetServerSideProps} from 'next';
import {randomUUID} from 'node:crypto';
import {publicEvidenceSchema} from '@unai/domain';
import {Evidence} from '../components/Evidence';
import {apiRequest,identity} from '../lib/server';
export default Evidence;
export const getServerSideProps:GetServerSideProps=async({req,res,query})=>{
  res.setHeader('Cache-Control','no-store');
  const session=await identity(req);
  if(!session)return {redirect:{destination:'/signin?reason=expired',permanent:false}};
  let evidence=null,connector=null,error=null;
  const id=query.evidence??query.connector;
  if(id!==undefined){
    if(typeof id!=='string'||!publicEvidenceSchema.shape.evidenceId.safeParse(id).success)error='The source link is invalid.';
    else{
      const isEvidence=query.evidence!==undefined;
      try{
        const response=await apiRequest('/v1/'+(isEvidence?'evidence/':'connectors/')+id,'GET',{
          cookie:req.headers.cookie??'','x-owner-scope-id':session.ownerScopeId,'x-purpose':isEvidence?'evidence.read':'connector.read',
          'x-correlation-id':randomUUID(),'x-data-purpose':'PERSONAL_ASSISTANCE','x-maximum-sensitivity':'RESTRICTED'});
        if(response.status===401)return {redirect:{destination:'/signin?reason=expired',permanent:false}};
        if(response.status!==200)error='This source is unavailable or access was refused.';
        else if(isEvidence)evidence=publicEvidenceSchema.parse(response.body);
        else{
          const body=response.body as {connectorType:string;status:string;evidence:unknown[]};
          connector={connectorType:body.connectorType,status:body.status,evidence:body.evidence.map(item=>publicEvidenceSchema.parse(item))};
        }
      }catch{error='The source could not be loaded. Please retry.';}
    }
  }
  return {props:{evidence,connector,error}};
};
