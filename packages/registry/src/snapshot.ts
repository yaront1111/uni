import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { metrics, trace, SpanStatusCode } from '@opentelemetry/api';
import { uuidV7 } from '../../../src/kernel/identities.js';
import { RegistryError, type LoadedRegistryRelease } from './release.js';

const tracer = trace.getTracer('unai.registry', '0.1.0');
const operations = metrics.getMeter('unai.registry', '0.1.0').createCounter('unai.registry.operations');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Sorted-key JSON; arrays keep their order. Used for per-contract content hashes. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalJson((value as Record<string, unknown>)[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

function snapshotRows(release: LoadedRegistryRelease) {
  const contracts: { id: string; kind: 'FRAME' | 'PREDICATE' | 'TRANSITION'; content: unknown }[] = [];
  for (const frame of release.frames) {
    contracts.push({ id: frame.id, kind: 'FRAME', content: { ...frame, predicates: frame.predicates.map(predicate => predicate.id) } });
    for (const predicate of frame.predicates) contracts.push({ id: predicate.id, kind: 'PREDICATE', content: predicate });
  }
  for (const transition of release.transitions) contracts.push({ id: transition.id, kind: 'TRANSITION', content: transition });
  return contracts.map(contract => ({ ...contract, contentHash: createHash('sha256').update(canonicalJson(contract.content)).digest('hex') }));
}

/**
 * Deployment operation for the trusted migration principal only. Materializes a
 * tag-loaded release atomically; the immutable row is the publication audit record.
 */
export async function publishRegistryRelease(pool: Pool, release: LoadedRegistryRelease, correlationId: string)
  : Promise<{ releaseId: string; outcome: 'PUBLISHED' | 'ALREADY_PUBLISHED' }> {
  if (release.source !== 'GIT_TAG' || !release.gitCommit) throw new RegistryError('REGISTRY_TAG_SOURCE_REQUIRED');
  if (!UUID.test(correlationId)) throw new RegistryError('REGISTRY_CORRELATION_ID_INVALID');
  return tracer.startActiveSpan('registry.publish', async span => {
    span.setAttributes({ 'unai.registry.version': release.version, 'unai.registry.git_commit': release.gitCommit!,
      'unai.registry.content_hash': release.contentHash, 'unai.correlation_id': correlationId, 'unai.code_version': '0.1.0' });
    const client = await pool.connect();
    let result = 'FAILURE';
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(1970170217, 2)');
      const existing = (await client.query('SELECT id,git_tag,git_commit,content_hash FROM registry_releases WHERE semantic_version=$1', [release.version])).rows[0];
      if (existing) {
        await client.query('ROLLBACK');
        if (existing.git_tag !== release.tag || existing.git_commit !== release.gitCommit || existing.content_hash !== release.contentHash) {
          result = 'REFUSED';
          throw new RegistryError('REGISTRY_RELEASE_CONFLICT');
        }
        result = 'ALREADY_PUBLISHED';
        return { releaseId: existing.id as string, outcome: 'ALREADY_PUBLISHED' as const };
      }
      const releaseId = uuidV7();
      await client.query(`INSERT INTO registry_releases(id,semantic_version,git_tag,git_commit,content_hash,lifecycle,released_at,manifest,correlation_id)
        VALUES($1,$2,$3,$4,$5,'RELEASED',clock_timestamp(),$6,$7)`,
        [releaseId, release.version, release.tag, release.gitCommit, release.contentHash, JSON.stringify(release.manifest), correlationId]);
      for (const contract of snapshotRows(release)) {
        await client.query(`INSERT INTO registry_contracts(id,registry_release_id,contract_id,contract_version,contract_kind,content,content_hash)
          VALUES($1,$2,$3,$4,$5,$6,$7)`, [uuidV7(), releaseId, contract.id, release.version, contract.kind, JSON.stringify(contract.content), contract.contentHash]);
      }
      const commit = await client.query('COMMIT');
      if (commit.command !== 'COMMIT') throw new RegistryError('REGISTRY_PUBLISH_FAILED');
      result = 'PUBLISHED';
      return { releaseId, outcome: 'PUBLISHED' as const };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      // Database errors may echo contract content; expose only a fixed code.
      throw error instanceof RegistryError ? error : new RegistryError('REGISTRY_PUBLISH_FAILED');
    } finally {
      client.release();
      span.setAttribute('unai.result', result);
      if (result === 'FAILURE' || result === 'REFUSED') span.setStatus({ code: SpanStatusCode.ERROR });
      operations.add(1, { operation: 'publish', result });
      span.end();
    }
  });
}
