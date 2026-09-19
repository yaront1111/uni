import type {GetServerSideProps} from 'next';
import {randomUUID} from 'node:crypto';
import {draftsViewSchema} from '@unai/domain';
import {DraftApproval} from '../../components/DraftApproval';
import {apiRequest, identity} from '../../lib/server';

export default DraftApproval;

export const getServerSideProps: GetServerSideProps = async ({req, res}) => {
  res.setHeader('Cache-Control', 'no-store');
  const session = await identity(req);
  if (!session) return {redirect: {destination: req.headers.cookie ? '/signin?reason=expired' : '/signin', permanent: false}};
  const empty = {drafts: [], refusal: null, receiptIngested: null};
  try {
    const response = await apiRequest('/v1/drafts', 'GET', {cookie: req.headers.cookie ?? '',
      'x-owner-scope-id': session.ownerScopeId, 'x-purpose': 'action.read', 'x-correlation-id': randomUUID()});
    if (response.status === 401) return {redirect: {destination: '/signin?reason=expired', permanent: false}};
    if (response.status !== 200) return {props: {...empty, error: 'Drafts are unavailable or access was refused.'}};
    return {props: {...empty, drafts: draftsViewSchema.parse(response.body).drafts, error: null}};
  } catch {
    return {props: {...empty, error: 'Drafts could not be loaded. Please retry.'}};
  }
};
