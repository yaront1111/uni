import NextAuth from 'next-auth';
import type {NextApiRequest,NextApiResponse} from 'next';
import type {TLSSocket} from 'node:tls';
import {authOptions} from '../../../lib/server';
export default async function handler(req:NextApiRequest,res:NextApiResponse){
  if((req.socket as TLSSocket).encrypted!==true)return res.status(426).json({code:'TLS_REQUIRED'});
  return NextAuth(req,res,authOptions());
}
