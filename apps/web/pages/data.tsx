import type {GetServerSideProps} from 'next';
import {DataControl} from '../components/DataControl';
import {identity} from '../lib/server';

export default DataControl;

/** Export and delete my data. Nothing is read to draw the idle screen: every
 * later state is the answer of a write the owner started from it. */
export const getServerSideProps: GetServerSideProps = async ({req, res}) => {
  res.setHeader('Cache-Control', 'no-store');
  const session = await identity(req);
  if (!session) return {redirect: {destination: req.headers.cookie ? '/signin?reason=expired' : '/signin', permanent: false}};
  return {props: {state: 'IDLE', exportSummary: null, reindex: null, preview: null, receipt: null, error: null}};
};
