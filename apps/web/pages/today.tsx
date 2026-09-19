import type {GetServerSideProps} from 'next';
import {timeZoneSchema} from '@unai/domain';
import {Today,TIME_ZONE_COOKIE} from '../components/Today';
import {apiRequest,identity} from '../lib/server';
import {cookieValue,loadToday} from '../lib/screens';
export default Today;

/** The Today briefing: `GET /v1/today` in the owner's timezone, then each item's
 * Why? / Sources panel. The timezone is the browser's, remembered in a cookie;
 * the API also remembers the owner's last one. */
export const getServerSideProps:GetServerSideProps=async({req,res})=>{
  res.setHeader('Cache-Control','no-store');
  const session=await identity(req);
  if(!session)return {redirect:{destination:req.headers.cookie?'/signin?reason=expired':'/signin',permanent:false}};
  const zone=timeZoneSchema.safeParse(cookieValue(req.headers.cookie,TIME_ZONE_COOKIE));
  const loaded=await loadToday((path,method,headers,body)=>apiRequest(path,method,headers,body),
    {cookie:req.headers.cookie??'',ownerScopeId:session.ownerScopeId},zone.success?zone.data:null);
  if(loaded.kind==='expired')return {redirect:{destination:'/signin?reason=expired',permanent:false}};
  return {props:loaded.props};
};
