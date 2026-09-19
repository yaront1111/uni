import type {GetServerSideProps} from 'next';
import {randomUUID} from 'node:crypto';
import {actionHistoryViewSchema} from '@unai/domain';
import {ActionHistory} from '../../components/ActionHistory';
import {apiRequest, identity} from '../../lib/server';

export default ActionHistory;

export const getServerSideProps: GetServerSideProps = async ({req, res}) => {
  res.setHeader('Cache-Control', 'no-store');
  const session = await identity(req);
  if (!session) return {redirect: {destination: req.headers.cookie ? '/signin?reason=expired' : '/signin', permanent: false}};
  try {
    const response = await apiRequest('/v1/action-history', 'GET', {cookie: req.headers.cookie ?? '',
      'x-owner-scope-id': session.ownerScopeId, 'x-purpose': 'action.read', 'x-correlation-id': randomUUID()});
    if (response.status === 401) return {redirect: {destination: '/signin?reason=expired', permanent: false}};
    if (response.status !== 200) return {props: {entries: [], error: 'The action history is unavailable or access was refused.'}};
    return {props: {entries: actionHistoryViewSchema.parse(response.body).entries, error: null}};
  } catch {
    return {props: {entries: [], error: 'The action history could not be loaded. Please retry.'}};
  }
};
