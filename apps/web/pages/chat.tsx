import type {GetServerSideProps} from 'next';
import {Chat} from '../components/Chat';
import {apiRequest,identity} from '../lib/server';
import {loadChat} from '../lib/chat';
export default Chat;
export const getServerSideProps:GetServerSideProps=async({req,res,query})=>{
 res.setHeader('Cache-Control','no-store');const session=await identity(req);
 if(!session)return {redirect:{destination:req.headers.cookie?'/signin?reason=expired':'/signin',permanent:false}};
 const loaded=await loadChat(apiRequest,{cookie:req.headers.cookie??'',ownerScopeId:session.ownerScopeId},typeof query.conversation==='string'?query.conversation:undefined);
 return loaded.kind==='expired'?{redirect:{destination:'/signin?reason=expired',permanent:false}}:{props:loaded.props};
};
