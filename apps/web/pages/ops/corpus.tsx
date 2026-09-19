import type {GetServerSideProps} from 'next';
import {Corpus} from '../../components/Corpus';
import {readCorpusStatusReport} from '../../lib/corpus-status';
import {identity} from '../../lib/server';
export default Corpus;

/** Reads the status report `uai corpus status --report` wrote, when the
 * deployment configures one. It holds counts and rates only: the private corpus
 * itself stays on the owner's machine and never reaches this process. */
export const getServerSideProps:GetServerSideProps=async({req,res})=>{
  res.setHeader('Cache-Control','no-store');
  const session=await identity(req);
  if(!session)return {redirect:{destination:req.headers.cookie?'/signin?reason=expired':'/signin',permanent:false}};
  const {status,error}=await readCorpusStatusReport();
  return {props:error?{status,error}:{status}};
};
