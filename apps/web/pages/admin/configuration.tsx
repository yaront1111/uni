import type {GetServerSideProps} from 'next';
import {Configuration} from '../../components/Configuration';
import {identity,apiRequest} from '../../lib/server';
import {loadConfiguration} from '../../lib/configuration';
import type {PermissionsProps} from '../../components/Permissions';
export default Configuration;
export const getServerSideProps:GetServerSideProps=async({req,res,query})=>{
 res.setHeader('Cache-Control','no-store');
 const session=await identity(req);
 if(!session)return {redirect:{destination:req.headers.cookie?'/signin?reason=expired':'/signin',permanent:false}};
 const loaded=await loadConfiguration(apiRequest,{cookie:req.headers.cookie??'',ownerScopeId:session.ownerScopeId},session.deviceId??null);
 if(loaded.kind==='expired')return {redirect:{destination:'/signin?reason=expired',permanent:false}};
 const saved=typeof query.saved==='string'&&['SOURCES','SENSITIVITY','PLUGIN_CAPABILITIES','ATTENTION_BUDGET','RETENTION'].includes(query.saved)?query.saved as PermissionsProps['saved']:null;
 return {props:{...loaded.props,saved,selectedConnectorId:typeof query.connector==='string'?query.connector:null}};
};
