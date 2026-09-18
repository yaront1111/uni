import { expect, it } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

// CRT-NFR-07-A: the repository uses the PRD section 28 reference stack, and no
// graph database or separate vector database is introduced. A deviation would
// require its own ADR under docs/adr before the change.
const workspaceRoot = resolve(import.meta.dirname, '../../..');
async function manifests() {
  const roots = ['.', ...(await readdir(resolve(workspaceRoot, 'packages'))).map(name => 'packages/' + name),
    ...(await readdir(resolve(workspaceRoot, 'apps'))).map(name => 'apps/' + name)];
  return Promise.all(roots.map(async root => ({
    root, manifest: JSON.parse(await readFile(resolve(workspaceRoot, root, 'package.json'), 'utf8')) as
      { dependencies?: Record<string, string>; devDependencies?: Record<string, string> },
  })));
}
function dependencies(manifest: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }) {
  return Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });
}

it('declares no graph database and no separate vector database dependency', async () => {
  const refused = /neo4j|neptune|arangodb|janusgraph|tigergraph|dgraph|gremlin|orientdb|nebula-graph|cypher|pinecone|weaviate|qdrant|milvus|chromadb|chroma-|lancedb|vectordb|vespa|redis/i;
  const offenders: string[] = [];
  for (const { root, manifest } of await manifests()) {
    for (const name of dependencies(manifest)) if (refused.test(name)) offenders.push(root + ':' + name);
  }
  expect(offenders).toEqual([]);
  const lock = await readFile(resolve(workspaceRoot, 'pnpm-lock.yaml'), 'utf8');
  expect(lock.split('\n').filter(line => /^\s{2,}(neo4j|pinecone|weaviate|qdrant|milvus|redis)[@/:]/.test(line))).toEqual([]);
});

it('keeps every section 28 reference stack component present', async () => {
  const declared = new Map((await manifests()).map(({ root, manifest }) => [root, dependencies(manifest)]));
  expect(declared.get('.')).toContain('typescript');
  expect(declared.get('packages/api')).toContain('fastify');
  expect(declared.get('apps/web')).toContain('next');
  expect(declared.get('packages/domain')).toContain('zod');
  expect(declared.get('packages/postgres')).toContain('pg');
  expect(declared.get('packages/storage')).toContain('@aws-sdk/client-s3');
  // PostgreSQL-backed job queue: no broker package is introduced for V0 background work.
  expect(declared.get('packages/jobs')).toEqual(expect.arrayContaining(['pg', '@unai/postgres']));
  expect(declared.get('packages/jobs')).toContain('@opentelemetry/api');
  const workspace = await readFile(resolve(workspaceRoot, 'pnpm-workspace.yaml'), 'utf8');
  expect(workspace).toMatch(/packages\/\*/);
  expect(workspace).toMatch(/apps\/\*/);
});

it('checks every SQL migration into Git, including the pgvector extension and the job queue', async () => {
  // Tracked or staged for the next commit, and never excluded by a Git ignore rule.
  const versioned = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', 'migrations'],
    { cwd: workspaceRoot, encoding: 'utf8' });
  expect(versioned.status).toBe(0);
  const inGit = versioned.stdout.trim().split('\n').map(name => name.replace('migrations/', ''));
  const onDisk = (await readdir(resolve(workspaceRoot, 'migrations'))).filter(name => name.endsWith('.sql'));
  expect(onDisk.length).toBeGreaterThan(0);
  expect(inGit).toEqual(expect.arrayContaining(onDisk));
  const sql = (await Promise.all(onDisk.map(name => readFile(resolve(workspaceRoot, 'migrations', name), 'utf8')))).join('\n');
  expect(sql).toMatch(/CREATE EXTENSION IF NOT EXISTS vector/);
  expect(sql).toMatch(/CREATE TABLE jobs/);
});

it('records the reference stack and its no-graph, no-vector-database decision in an ADR', async () => {
  const adrs = (await readdir(resolve(workspaceRoot, 'docs/adr'))).filter(name => name.endsWith('.md'));
  expect(adrs).toContain('0001-reference-stack.md');
  const text = (await Promise.all(adrs.map(name => readFile(resolve(workspaceRoot, 'docs/adr', name), 'utf8')))).join('\n');
  expect(text).toMatch(/no graph database/i);
  expect(text).toMatch(/separate vector database/i);
});
