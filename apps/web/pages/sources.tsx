import type {GetServerSideProps} from 'next';
import {randomUUID} from 'node:crypto';
import {publicEvidenceSchema,documentSearchResultSchema} from '@unai/domain';
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
  // The document index is readable as soon as an upload is stored, so the screen
  // can show that a document is searchable before any extraction has run.
  let search=null;
  const q=query.q;
  if(typeof q==='string'&&q.trim()!==''){
    try{
      const response=await apiRequest('/v1/documents/search?q='+encodeURIComponent(q.trim().slice(0,200)),'GET',{
        cookie:req.headers.cookie??'','x-owner-scope-id':session.ownerScopeId,'x-purpose':'evidence.read',
        'x-correlation-id':randomUUID(),'x-data-purpose':'PERSONAL_ASSISTANCE','x-maximum-sensitivity':'RESTRICTED'});
      if(response.status===401)return {redirect:{destination:'/signin?reason=expired',permanent:false}};
      if(response.status!==200)error=error??'The document search is unavailable or access was refused.';
      else search=documentSearchResultSchema.parse(response.body);
    }catch{error=error??'The document search could not be completed. Please retry.';}
  }
  return {props:{evidence,connector,search,receipt:null,error}};
};
