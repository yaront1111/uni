import Fastify, { type FastifyInstance } from 'fastify';
import type { IncomingHttpHeaders } from 'node:http';
import type { TLSSocket } from 'node:tls';
import type { ServerOptions } from 'node:https';
import { randomUUID } from 'node:crypto';
import { requestContextSchema, type RequestContext } from '@unai/domain';
import { metrics, trace, SpanStatusCode } from '@opentelemetry/api';

declare module 'fastify' {
  interface FastifyRequest { ownerContext: RequestContext | null }
}

export interface ApiBoundaryOptions {
  /** Product-approved session verification; never trust an actor header. */
  authenticate(headers: Readonly<IncomingHttpHeaders>): Promise<{ actorId: string } | null>;
  /** Check active membership AND the requested purpose. RLS is enforced separately. */
  authorize(context: RequestContext): Promise<boolean>;
  tls?: Pick<ServerOptions, 'key' | 'cert' | 'ca'>;
  log?(event: Readonly<{ event: 'api.response'; correlationId: string; statusCode: number; durationMs: number }>): void;
}

const latency = metrics.getMeter('unai.api').createHistogram('unai.api.duration', { unit: 'ms' });

/** No authentication provider or public route is installed implicitly. */
export function createApiBoundary(options: ApiBoundaryOptions): FastifyInstance {
  if (typeof options.authenticate !== 'function' || typeof options.authorize !== 'function') {
    throw new Error('API_AUTHORITY_PORTS_REQUIRED');
  }
  const app = Fastify({
    ...(options.tls ? { https: { ...options.tls, minVersion: 'TLSv1.2' as const } } : {}),
    logger: false, trustProxy: false,
    bodyLimit: 1024 * 1024, requestTimeout: 30_000,
    genReqId: () => randomUUID(),
  });
  app.decorateRequest('ownerContext', null);
  app.addHook('onRequest', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
    reply.header('x-content-type-options', 'nosniff');
  });
  app.addHook('preParsing', async (request, reply, payload) => {
    const refuse = (status: number, code: string) => reply.code(status).send({ code, correlationId: request.ownerContext?.correlationId ?? request.id });
    if ((request.raw.socket as TLSSocket).encrypted !== true) { refuse(426, 'TLS_REQUIRED'); return payload; }
    reply.header('strict-transport-security', 'max-age=31536000');
    const identity = await options.authenticate(Object.freeze({ ...request.headers }));
    if (!identity) { refuse(401, 'AUTHENTICATION_REQUIRED'); return payload; }
    const parsed = requestContextSchema.safeParse({
      actorId: identity.actorId, ownerScopeId: request.headers['x-owner-scope-id'],
      purpose: request.headers['x-purpose'], correlationId: request.headers['x-correlation-id'],
    });
    if (!parsed.success) { refuse(400, 'REQUEST_CONTEXT_INVALID'); return payload; }
    request.ownerContext = Object.freeze(parsed.data);
    reply.header('x-correlation-id', parsed.data.correlationId);
    if (!await options.authorize(request.ownerContext)) { refuse(403, 'ACCESS_DENIED'); return payload; }
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) {
      const key = request.headers['idempotency-key'];
      if (typeof key !== 'string' || !/^[a-zA-Z0-9_-]{16,128}$/.test(key)) {
        refuse(400, 'IDEMPOTENCY_KEY_REQUIRED'); return payload;
      }
    }
    return payload;
  });
  app.setErrorHandler((_error, request, reply) => {
    reply.code(500).send({ code: 'INTERNAL_ERROR', correlationId: request.ownerContext?.correlationId ?? request.id });
  });
  app.addHook('onResponse', async (request, reply) => {
    const correlationId = request.ownerContext?.correlationId ?? request.id;
    const span = trace.getTracer('unai.api', '0.1.0').startSpan('api.response');
    span.setAttributes({ 'unai.correlation_id': correlationId, 'http.response.status_code': reply.statusCode,
      'unai.code_version': '0.1.0', 'unai.result': reply.statusCode < 400 ? 'SUCCESS' : 'REFUSED' });
    if (request.ownerContext) span.setAttributes({ 'unai.owner_scope_id': request.ownerContext.ownerScopeId, 'unai.purpose': request.ownerContext.purpose });
    span.setStatus({ code: reply.statusCode >= 500 ? SpanStatusCode.ERROR : SpanStatusCode.OK });
    span.end();
    latency.record(reply.elapsedTime, { statusCode: reply.statusCode });
    // Fixed allowlist: no URLs, headers, request bodies, provider errors, or object keys.
    try { options.log?.(Object.freeze({ event: 'api.response', correlationId, statusCode: reply.statusCode, durationMs: reply.elapsedTime })); }
    catch { /* Telemetry failure must not change an already sent application response. */ }
  });
  return app;
}
