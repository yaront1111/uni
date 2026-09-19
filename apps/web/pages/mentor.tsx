import type {GetServerSideProps} from 'next';
import {randomUUID} from 'node:crypto';
import {mentorViewSchema} from '@unai/domain';
import {Mentor} from '../components/Mentor';
import {apiRequest,identity} from '../lib/server';
export default Mentor;
export const getServerSideProps:GetServerSideProps=async({req,res})=>{
  res.setHeader('Cache-Control','no-store');
  const session=await identity(req);
  if(!session)return {redirect:{destination:req.headers.cookie?'/signin?reason=expired':'/signin',permanent:false}};
  try{
    // The mentor reads the calendar through the Context Broker, so it declares the
    // same pinned evidence context every other memory read from this app declares.
    const mentor=await apiRequest('/v1/mentor/contradictions?timeZone=UTC','GET',{cookie:req.headers.cookie??'',
      'x-owner-scope-id':session.ownerScopeId,'x-purpose':'mentor.advise','x-correlation-id':randomUUID(),
      'x-data-purpose':'PERSONAL_ASSISTANCE','x-maximum-sensitivity':'RESTRICTED'});
    if(mentor.status===401)return {redirect:{destination:'/signin?reason=expired',permanent:false}};
    if(mentor.status!==200)return {props:{view:null,error:'The mentor could not be read. Please reload to retry.'}};
    return {props:{view:mentorViewSchema.parse(mentor.body)}};
  }catch{
    return {props:{view:null,error:'The mentor could not be read. Please reload to retry.'}};
  }
};
