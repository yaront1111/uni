import type {GetServerSideProps} from 'next';
import {Access} from '../components/Access';
export default Access;
export const getServerSideProps:GetServerSideProps=async({query,res})=>{
  res.setHeader('Cache-Control','no-store');
  return {props:{state:query.error?'refused':query.reason==='expired'?'expired':'signed-out',devices:[],registered:false}};
};
