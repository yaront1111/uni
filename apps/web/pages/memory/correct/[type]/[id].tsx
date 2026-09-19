import type {GetServerSideProps} from 'next';
import {CorrectionControls} from '../../../../components/CorrectionControls';
import {loadInspector} from '../../../../lib/memory';
import {apiRequest,identity} from '../../../../lib/server';
export default CorrectionControls;

/** The Correction controls screen reads the same inspection as the inspector: the
 * belief, the target every control names, and what the owner already said. */
export const getServerSideProps:GetServerSideProps=async({req,res,params})=>{
  res.setHeader('Cache-Control','no-store');
  const session=await identity(req);
  if(!session)return {redirect:{destination:req.headers.cookie?'/signin?reason=expired':'/signin',permanent:false}};
  const loaded=await loadInspector(apiRequest,{cookie:req.headers.cookie??'',ownerScopeId:session.ownerScopeId},params?.['type'],params?.['id']);
  if(loaded.kind==='expired')return {redirect:{destination:'/signin?reason=expired',permanent:false}};
  return {props:loaded.props};
};
