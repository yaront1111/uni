import type {GetServerSideProps} from 'next';
import {randomUUID} from 'node:crypto';
import {publicRecommendationSchema} from '@unai/domain';
import {RecommendationDetail} from '../../components/RecommendationDetail';
import {apiRequest, identity} from '../../lib/server';

export default RecommendationDetail;

const UNREADABLE = 'This recommendation could not be read. Please reload to retry.';

export const getServerSideProps: GetServerSideProps = async ({req, res, params}) => {
  res.setHeader('Cache-Control', 'no-store');
  const session = await identity(req);
  if (!session) return {redirect: {destination: req.headers.cookie ? '/signin?reason=expired' : '/signin', permanent: false}};
  const id = publicRecommendationSchema.shape.recommendationId.safeParse(params?.['id']);
  if (!id.success) return {props: {recommendation: null, error: 'That is not a recommendation Uai recorded.'}};
  try {
    const response = await apiRequest('/v1/recommendations/' + id.data, 'GET', {cookie: req.headers.cookie ?? '',
      'x-owner-scope-id': session.ownerScopeId, 'x-purpose': 'action.read', 'x-correlation-id': randomUUID()});
    if (response.status === 401) return {redirect: {destination: '/signin?reason=expired', permanent: false}};
    if (response.status === 404) return {props: {recommendation: null, error: 'That is not a recommendation Uai recorded.'}};
    if (response.status !== 200) return {props: {recommendation: null, error: UNREADABLE}};
    return {props: {recommendation: publicRecommendationSchema.parse(response.body), error: null}};
  } catch {
    return {props: {recommendation: null, error: UNREADABLE}};
  }
};
