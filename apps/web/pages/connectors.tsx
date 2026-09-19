import type {GetServerSideProps} from 'next';
import {randomUUID} from 'node:crypto';
import {publicConnectorSchema} from '@unai/domain';
import {Connectors} from '../components/Connectors';
import {apiRequest, identity} from '../lib/server';

export default Connectors;

export const getServerSideProps: GetServerSideProps = async ({req, res, query}) => {
  res.setHeader('Cache-Control', 'no-store');
  const session = await identity(req);
  if (!session) return {redirect: {destination: '/signin?reason=expired', permanent: false}};
  let connectors: unknown[] = [], error: string | null = null;
  try {
    const response = await apiRequest('/v1/connectors', 'GET', {
      cookie: req.headers.cookie ?? '', 'x-owner-scope-id': session.ownerScopeId,
      'x-purpose': 'connector.read', 'x-correlation-id': randomUUID(),
    });
    if (response.status === 401) return {redirect: {destination: '/signin?reason=expired', permanent: false}};
    if (response.status !== 200) error = 'Connected sources are unavailable or access was refused.';
    else connectors = (response.body as {connectors: unknown[]}).connectors.map(entry => publicConnectorSchema.parse(entry));
  } catch {error = 'Connected sources could not be loaded. Please retry.';}
  const wanted = typeof query.connector === 'string' ? query.connector : null;
  const parsed = connectors as ReturnType<typeof publicConnectorSchema.parse>[];
  const selected = wanted === null ? null : parsed.find(connector => connector.connectorId === wanted) ?? null;
  if (wanted !== null && selected === null && error === null) error = 'That source is not connected to this owner scope.';
  return {props: {connectors: parsed, selected, lastSync: null, state: 'IDLE', refusal: null, error}};
};
