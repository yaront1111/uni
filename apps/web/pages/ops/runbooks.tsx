import type {GetServerSideProps} from 'next';
import {Runbooks} from '../../components/Runbooks';
import {readOperationsReport} from '../../lib/operations-status';
import {identity} from '../../lib/server';
export default Runbooks;
export const getServerSideProps:GetServerSideProps=async({req,res})=>{
  res.setHeader('Cache-Control','no-store');
  const session=await identity(req);
  if(!session)return {redirect:{destination:req.headers.cookie?'/signin?reason=expired':'/signin',permanent:false}};
  return {props:await readOperationsReport()};
};
