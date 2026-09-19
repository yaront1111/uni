import type {GetServerSideProps} from 'next';
import {randomUUID} from 'node:crypto';
import {permissionsViewSchema} from '@unai/domain';
import {Permissions, type PermissionsProps} from '../components/Permissions';
import {apiRequest, identity} from '../lib/server';

export default Permissions;

const SAVED = new Set(['SOURCES', 'SENSITIVITY', 'PLUGIN_CAPABILITIES', 'ATTENTION_BUDGET', 'RETENTION']);

/** The Permissions and integrations surface, read under `permissions.read`. The
 * page computes nothing: every setting and its effective value is the API's. */
export const getServerSideProps: GetServerSideProps = async ({req, res, query}) => {
  res.setHeader('Cache-Control', 'no-store');
  const session = await identity(req);
  if (!session) return {redirect: {destination: req.headers.cookie ? '/signin?reason=expired' : '/signin', permanent: false}};
  const saved = typeof query.saved === 'string' && SAVED.has(query.saved) ? query.saved as PermissionsProps['saved'] : null;
  try {
    const response = await apiRequest('/v1/permissions', 'GET', {cookie: req.headers.cookie ?? '',
      'x-owner-scope-id': session.ownerScopeId, 'x-purpose': 'permissions.read', 'x-correlation-id': randomUUID()});
    if (response.status === 401) return {redirect: {destination: '/signin?reason=expired', permanent: false}};
    if (response.status !== 200) return {props: {view: null, saved, error: 'Permissions are unavailable or access was refused.'}};
    return {props: {view: permissionsViewSchema.parse(response.body), saved, error: null}};
  } catch {
    return {props: {view: null, saved, error: 'Permissions could not be loaded. Please retry.'}};
  }
};
