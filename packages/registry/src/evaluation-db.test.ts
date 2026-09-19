import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer, connect, type AddressInfo, type Server } from 'node:net';
import { TLSSocket } from 'node:tls';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { OWNER_SCOPED_TABLES, runMigrations, withOwnerTransaction } from '@unai/postgres';
import { shadowReportSchema } from '@unai/domain';
import { runProjectionReplay } from '@unai/capabilities';
import { uuidV7 } from '../../../src/kernel/identities.js';
import { loadRegistryRelease, readTaggedMigrationEvidence, releaseContentHash } from './release.js';
import { publishRegistryRelease } from './snapshot.js';
import { projectionReplayReportSchema } from './schema.js';

/**
 * The database halves of the registry and evaluation tooling, as the operator
 * runs them: `uai registry shadow-diff` over an owner's canonical memory and
 * `uai registry projection-replay` are spawned as real CLI processes against
 * PostgreSQL over verified TLS (CRT-REG-02-A), and `publish` materializes a
 * migrating release's manifest (CRT-REG-05-A).
 *
 * The CLI refuses any database connection without TLS. The harness server is
 * plain TCP, so this file puts a TLS terminator in front of it that speaks the
 * PostgreSQL SSLRequest handshake -- test infrastructure only; the CLI and its
 * `createDatabasePool` are unchanged and verify the certificate as in
 * production.
 *
 * CRT-WRT-09-A: every production table this owner has rows in is digested
 * before and after the shadow run, and must be identical; the only rows the run
 * adds are its own `shadow_evaluation_runs` record and its audit event.
 */

if (!process.env.UNAI_TEST_DATABASE_URL) throw new Error('Run pnpm test for the required PostgreSQL harness');
const serverUrl = new URL(process.env.UNAI_TEST_DATABASE_URL);
const admin = new Pool({ connectionString: serverUrl.href });
const appUrl = new URL(serverUrl.href); appUrl.username = 'evaluation_test_app'; appUrl.password = 'test-only';
const appPool = new Pool({ connectionString: appUrl.href });
const cliPath = resolve('packages/registry/src/cli.ts');
const tsx = createRequire(import.meta.url).resolve('tsx/cli');
const owner = randomUUID(), actor = randomUUID();
let directory = '', caPath = '', proxy: Server | undefined, proxyPort = 0;
const scratchDatabases: string[] = [];

/** A TLS terminator for the PostgreSQL wire protocol: answers the client's
 * SSLRequest with 'S', completes the handshake with the test certificate, and
 * relays the decrypted stream to the plain harness server. */
async function startPostgresTlsProxy(cert: Buffer, key: Buffer): Promise<{ server: Server; port: number }> {
  const server = createServer(client => {
    client.once('data', first => {
      if (first.length < 8 || first.readInt32BE(4) !== 80877103) { client.destroy(); return; }
      client.pause();
      client.write('S');
      const secure = new TLSSocket(client, { isServer: true, cert, key });
      const upstream = connect(Number(serverUrl.port || 5432), serverUrl.hostname);
      secure.pipe(upstream).pipe(secure);
      secure.on('error', () => upstream.destroy());
      upstream.on('error', () => secure.destroy());
      client.resume();
    });
    client.on('error', () => client.destroy());
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  return { server, port: (server.address() as AddressInfo).port };
}

beforeAll(async () => {
  await runMigrations(admin, resolve('migrations'));
  await admin.query("DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='evaluation_test_app') THEN CREATE ROLE evaluation_test_app LOGIN PASSWORD 'test-only'; END IF; END $$; GRANT unai_app TO evaluation_test_app");
  directory = await mkdtemp(join(tmpdir(), 'unai-evaluation-db-'));
  const keyPath = join(directory, 'key.pem');
  caPath = join(directory, 'cert.pem');
  const openssl = process.platform === 'win32' ? 'C:/Program Files/Git/usr/bin/openssl.exe' : 'openssl';
  const generated = spawnSync(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', keyPath, '-out', caPath], { encoding: 'utf8' });
  if (generated.status !== 0) throw new Error('OPENSSL_UNAVAILABLE');
  const started = await startPostgresTlsProxy(await readFile(caPath), await readFile(keyPath));
  proxy = started.server; proxyPort = started.port;

  // One owner with canonical memory: two obligations of the same creditor with
  // different debtors, a scheduled occurrence holding two times, their claims,
  // accepted assessments under one governed transaction, and an outcome.
  await admin.query('INSERT INTO users(id,display_name) VALUES($1,$2)', [actor, 'Evaluation owner']);
  await admin.query("INSERT INTO owner_scopes(id,scope_kind,display_name,created_by_user_id) VALUES($1,'PERSONAL','Evaluation',$2)", [owner, actor]);
  await admin.query("INSERT INTO owner_scope_members(owner_scope_id,user_id,role) VALUES($1,$2,'OWNER')", [owner, actor]);
  const context = (await admin.query('SELECT id FROM context_spaces WHERE owner_scope_id=$1', [owner])).rows[0].id;
  const connector = randomUUID(), source = randomUUID(), anchor = randomUUID(), transaction = randomUUID();
  await admin.query("INSERT INTO connectors(id,owner_scope_id,connector_type,external_account_ref,permission_manifest,status) VALUES($1,$2,'CONVERSATION',$3,'{}','ACTIVE')",
    [connector, owner, 'eval-' + owner]);
  await admin.query(`INSERT INTO source_items(id,owner_scope_id,connector_id,source_type,external_id,actor_ref,submitted_by_user_id,
    raw_object_ref,content_hash,sensitivity,allowed_purposes,ingestion_version,idempotency_key) VALUES($1,$2,$3,'CONVERSATION','eval-1',$4,$5,$6,$7,
    'PRIVATE',ARRAY['PERSONAL_ASSISTANCE'],'evidence-json-v1',$8)`,
    [source, owner, connector, JSON.stringify({ type: 'USER', id: actor }), actor, randomUUID(), 'c'.repeat(64), randomUUID()]);
  await admin.query("INSERT INTO source_anchors(id,owner_scope_id,source_item_id,anchor_kind,anchor,normalized_text) VALUES($1,$2,$3,'MESSAGE_SPAN','{\"start\":0,\"end\":10}','fixture')",
    [anchor, owner, source]);
  await admin.query(`INSERT INTO belief_transactions(id,owner_scope_id,transaction_kind,requested_by_actor_id,source_evidence_ids,
    registry_release_id,status,risk,idempotency_key,commit_receipt,committed_at) VALUES($1,$2,'CANONICALIZE',$3,'{}',$4,'COMMITTED','LOW',$5,'{}',now())`,
    [transaction, owner, actor, randomUUID(), randomUUID().replaceAll('-', '')]);
  const entity = async (label: string) => {
    const id = uuidV7();
    await admin.query("INSERT INTO entities(id,owner_scope_id,entity_kind,canonical_label) VALUES($1,$2,'PERSON',$3)", [id, owner, label]);
    return id;
  };
  const noa = await entity('Noa'), cohen = await entity('Daniel Cohen'), levi = await entity('Daniel Levi');
  const frame = async (type: string, roles: [string, string][]) => {
    const id = uuidV7();
    await admin.query('INSERT INTO frame_instances(id,owner_scope_id,frame_type_id,context_space_id) VALUES($1,$2,$3,$4)', [id, owner, type, context]);
    for (const [role, entityId] of roles) {
      await admin.query('INSERT INTO frame_instance_roles(id,owner_scope_id,frame_instance_id,role_id,entity_id) VALUES($1,$2,$3,$4,$5)',
        [randomUUID(), owner, id, role, entityId]);
    }
    return id;
  };
  const fact = async (frameId: string, predicate: string, modality: string, value: unknown) => {
    const slot = uuidV7(), proposition = uuidV7(), claim = uuidV7();
    const existing = (await admin.query('SELECT id FROM belief_slots WHERE owner_scope_id=$1 AND frame_instance_id=$2 AND predicate_id=$3',
      [owner, frameId, predicate])).rows[0]?.id as string | undefined;
    if (!existing) {
      await admin.query('INSERT INTO belief_slots(id,owner_scope_id,frame_instance_id,predicate_id,context_space_id,modality) VALUES($1,$2,$3,$4,$5,$6)',
        [slot, owner, frameId, predicate, context, modality]);
    }
    await admin.query('INSERT INTO propositions(id,owner_scope_id,belief_slot_id,normalized_value) VALUES($1,$2,$3,$4)',
      [proposition, owner, existing ?? slot, JSON.stringify(value)]);
    await admin.query(`INSERT INTO claims(id,owner_scope_id,source_anchor_id,proposition_id,claim_origin,lifecycle)
      VALUES($1,$2,$3,$4,'USER_STATEMENT','ACCEPTED')`, [claim, owner, anchor, proposition]);
    await admin.query(`INSERT INTO belief_assessments(id,owner_scope_id,proposition_id,assessment_status,policy_version,transaction_id,decision_reason)
      VALUES($1,$2,$3,'ACCEPTED','local-policy-0.1.0',$4,'{"code":"FIXTURE"}')`, [randomUUID(), owner, proposition, transaction]);
    return claim;
  };
  const taxi = await frame('shared.obligation', [['debtor', cohen], ['creditor', noa]]);
  const lunch = await frame('shared.obligation', [['debtor', levi], ['creditor', noa]]);
  await fact(taxi, 'shared.obligation.principal_amount', 'ACTUAL', { amount: '50.00', currency: 'ILS' });
  await fact(lunch, 'shared.obligation.principal_amount', 'ACTUAL', { amount: '50.00', currency: 'ILS' });
  const flight = await frame('shared.event_occurrence', []);
  await fact(flight, 'shared.event_occurrence.occurrence_time', 'SCHEDULED', '2026-09-20T03:40:00.000Z');
  const moved = await fact(flight, 'shared.event_occurrence.occurrence_time', 'SCHEDULED', '2026-09-20T04:10:00.000Z');
  await admin.query(`INSERT INTO resolution_assertions(id,owner_scope_id,source_frame_instance_id,outcome_code,effective_at,
    asserted_by_entity_id,claim_id,transition_contract_id,lifecycle,creation_transaction_id)
    VALUES($1,$2,$3,'FULFILLED',now(),$4,$5,'shared.obligation.resolution','ACCEPTED',$6)`,
    [uuidV7(), owner, taxi, cohen, moved, transaction]);
  // The projections as the reducer maintains them, so a replay has stored rows
  // to be compared with.
  await withOwnerTransaction(appPool, { ownerScopeId: owner, actorId: actor, purpose: 'memory.project', correlationId: randomUUID() },
    tx => runProjectionReplay(tx, { ownerScopeId: owner, asOf: new Date('2026-09-15T00:00:00.000Z'), compareWithStored: false }));
}, 120000);

afterAll(async () => {
  proxy?.close();
  for (const name of scratchDatabases) await admin.query('DROP DATABASE IF EXISTS ' + name + ' WITH (FORCE)').catch(() => undefined);
  await appPool.end(); await admin.end();
  if (directory) await rm(directory, { recursive: true, force: true });
});

/** The CLI as a child process. Never `spawnSync`: the TLS terminator lives on
 * this process's event loop and must keep answering while the child runs. */
function cli(cwd: string, args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const url = new URL(appUrl.href); url.hostname = '127.0.0.1'; url.port = String(proxyPort);
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, [tsx, cliPath, ...args], { cwd,
      env: { ...process.env, UNAI_DATABASE_URL: url.href, UNAI_DATABASE_CA_PATH: caPath } });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', status => done({ status, stdout, stderr }));
  });
}

/** A digest of every row this owner has in every production table: every
 * owner-scoped table except the run's own record and the append-only audit log
 * of recording it, which the test asserts separately. */
async function productionState(): Promise<Record<string, string>> {
  const state: Record<string, string> = {};
  for (const table of OWNER_SCOPED_TABLES) {
    if (['users', 'owner_scopes', 'shadow_evaluation_runs', 'audit_events'].includes(table)) continue;
    const row = (await admin.query(`SELECT count(*)::text AS n,coalesce(md5(string_agg(md5(t::text),'' ORDER BY md5(t::text))),'') AS h
      FROM ${table} t WHERE owner_scope_id=$1`, [owner])).rows[0];
    state[table] = row.n + ':' + row.h;
  }
  return state;
}

/** A repository whose release 0.2.0 stops anchoring obligations on the debtor. */
async function candidateRepository(): Promise<string> {
  const repo = await mkdtemp(join(directory, 'repo-'));
  await cp(resolve('registry'), join(repo, 'registry'), { recursive: true });
  await cp(resolve('corpus'), join(repo, 'corpus'), { recursive: true });
  // Release 0.1.0 alone, so this candidate is the release that follows it
  // whatever this checkout records after 0.1.0.
  for (const version of await readdir(join(repo, 'registry/releases'))) {
    if (version !== '0.1.0') await rm(join(repo, 'registry/releases', version), { recursive: true, force: true });
  }
  const index = join(repo, 'registry/releases.yaml');
  const recorded = await readFile(index, 'utf8');
  const next = recorded.indexOf('  - version: ', recorded.indexOf('  - version: 0.1.0') + 1);
  if (next >= 0) await writeFile(index, recorded.slice(0, next));
  const to = join(repo, 'registry/releases/0.2.0');
  await cp(join(repo, 'registry/releases/0.1.0'), to, { recursive: true });
  for (const name of await readdir(to)) {
    let text = (await readFile(join(to, name), 'utf8')).replace(/^version: 0\.1\.0$/m, 'version: 0.2.0');
    if (name === 'shared.obligation.yaml') text = text.replace('identityAnchors: [external_reference, debtor, creditor, origin_reference]',
      'identityAnchors: [external_reference, creditor, origin_reference]');
    await writeFile(join(to, name), text);
  }
  return repo;
}
/** Records (or re-records) the release directory's content hash in the index. */
async function recordRelease(repo: string, version: string) {
  const dir = join(repo, 'registry/releases', version);
  const files = await Promise.all((await readdir(dir)).map(async path => ({ path, bytes: await readFile(join(dir, path)) })));
  const index = join(repo, 'registry/releases.yaml');
  const text = await readFile(index, 'utf8');
  const entry = '  - version: ' + version + '\n    tag: registry-v' + version + '\n    contentHash: ' + releaseContentHash(files) + '\n';
  const pattern = new RegExp('  - version: ' + version.replaceAll('.', '\\.') + '\\n    tag: [^\\n]+\\n    contentHash: [a-f0-9]{64}\\n');
  await writeFile(index, pattern.test(text) ? text.replace(pattern, entry) : text + entry);
}

it('CRT-WRT-09-A and CRT-REG-02-A: uai registry shadow-diff over an owner sample emits all seven diffs and changes no production table', async () => {
  const repo = await candidateRepository();
  await recordRelease(repo, '0.2.0');
  const before = await productionState();
  const auditBefore = Number((await admin.query('SELECT count(*) AS n FROM audit_events WHERE owner_scope_id=$1', [owner])).rows[0].n);
  const correlationId = randomUUID();
  const result = await cli(repo, ['registry', 'shadow-diff', '--sample', 'owner', '--owner-scope', owner, '--actor', actor,
    '--baseline', '0.1.0', '--candidate', '0.2.0', '--as-of', '2026-09-15T00:00:00.000Z', '--correlation-id', correlationId,
    '--report', join(repo, 'shadow.json')]);
  expect(result.status, result.stderr).toBe(0);
  const summary = JSON.parse(result.stdout.trim());
  expect(summary).toMatchObject({ event: 'registry.shadow-diff', result: 'PASS', runKind: 'REGISTRY', productionUnchanged: true });
  const report = shadowReportSchema.parse(JSON.parse(await readFile(join(repo, 'shadow.json'), 'utf8')));
  // Two obligations with different debtors were distinct under 0.1.0; without the
  // debtor anchor 0.2.0 no longer says so.
  expect(report.diffs.instanceMatch.entries).toEqual([expect.objectContaining({ code: 'MATCH_OUTCOME_CHANGED', baseline: 'CONFIRMED_DISTINCT' })]);
  expect(report.diffs.slotCollision.notes).toMatchObject({ baselineCollisions: 2, candidateCollisions: 2 });
  expect(report.diffs.proposition.compared).toBe(4);
  expect(report.diffs.beliefStatus.compared).toBe(4);
  expect(report.diffs.resolution.compared).toBe(1);
  expect(report.diffs.projection.notes).toMatchObject({ replayEqualsStored: true });
  expect(report.diffs.costAndLatency.baseline.items).toBe(4);
  expect(report.sampleRef).toMatchObject({ kind: 'OWNER_SAMPLE', frameInstances: 3, claims: 4, resolutions: 1 });

  // Production state is identical, table by table.
  expect(await productionState()).toEqual(before);
  // The run's own record and the audit event of recording it are the only writes.
  const runs = (await admin.query('SELECT * FROM shadow_evaluation_runs WHERE owner_scope_id=$1', [owner])).rows;
  expect(runs).toHaveLength(1);
  expect(runs[0]).toMatchObject({ id: report.runId, run_kind: 'REGISTRY', baseline_version: '0.1.0', candidate_version: '0.2.0',
    production_unchanged: true, requested_by_actor_id: actor, correlation_id: correlationId });
  for (const column of ['instance_match_diff', 'slot_collision_diff', 'proposition_diff', 'belief_status_diff', 'resolution_diff',
    'projection_diff', 'cost_and_latency_diff']) expect(runs[0][column], column).toBeTypeOf('object');
  const audits = (await admin.query('SELECT purpose FROM audit_events WHERE owner_scope_id=$1 AND correlation_id=$2', [owner, correlationId])).rows;
  expect(audits).toEqual([{ purpose: 'evaluation.shadow' }]);
  expect(Number((await admin.query('SELECT count(*) AS n FROM audit_events WHERE owner_scope_id=$1', [owner])).rows[0].n)).toBe(auditBefore + 1);
}, 180000);

it('CRT-REG-02-A: uai registry projection-replay runs over TLS and reports the release it was run for', async () => {
  const reportPath = join(directory, 'replay.json');
  const result = await cli(resolve('.'), ['registry', 'projection-replay', '--owner-scope', owner, '--actor', actor,
    '--as-of', '2026-09-15T00:00:00.000Z', '--registry-version', '0.1.0', '--report', reportPath]);
  expect(result.status, result.stderr).toBe(0);
  const report = projectionReplayReportSchema.parse(JSON.parse(await readFile(reportPath, 'utf8')));
  expect(report).toMatchObject({ result: 'PASS', registryVersion: '0.1.0', equalsIncremental: true, ownerScopeId: owner });
  expect(report.receipts.map(receipt => receipt.projectionName).sort())
    .toEqual(['obligations_projection', 'open_commitments_projection', 'schedule_projection']);
  // A release the repository has not recorded is refused before any replay.
  const unknown = await cli(resolve('.'), ['registry', 'projection-replay', '--owner-scope', owner, '--actor', actor, '--registry-version', '9.9.9']);
  expect(unknown.status).toBe(1);
  expect(unknown.stderr).toContain('REGISTRY_RELEASE_NOT_RECORDED');
}, 180000);

it('CRT-REG-05-A: publishing a migrating release materializes its manifest, and only after its base release', async () => {
  const repo = await candidateRepository();
  await recordRelease(repo, '0.2.0');
  await mkdir(join(repo, 'registry/evidence/0.2.0'), { recursive: true });
  const shadow = await cli(repo, ['registry', 'shadow-diff', '--baseline', '0.1.0', '--candidate', '0.2.0', '--report', 'registry/evidence/0.2.0/shadow-diff.json']);
  expect(shadow.status, shadow.stderr).toBe(0);
  const runId = JSON.parse(await readFile(join(repo, 'registry/evidence/0.2.0/shadow-diff.json'), 'utf8')).runId as string;
  await writeFile(join(repo, 'registry/releases/0.2.0/migration.yaml'), ['kind: MIGRATION', 'from: 0.1.0', 'to: 0.2.0',
    'changeClass: IDENTITY_AFFECTING', 'description: Obligations stop anchoring on the debtor.',
    'shadowDiff: registry/evidence/0.2.0/shadow-diff.json', 'projectionReplay: registry/evidence/0.2.0/projection-replay.json',
    'rollbackPlan: Pin deployments back to 0.1.0.', 'pinnedTests:', '  - packages/registry/src/evaluation-db.test.ts', ''].join('\n'));
  await recordRelease(repo, '0.2.0');
  const git = (...args: string[]) => {
    const out = spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'user.name=Registry Test', '-c', 'user.email=registry@test.invalid', ...args],
      { cwd: repo, encoding: 'utf8' });
    if (out.status !== 0) throw new Error(out.stderr);
  };
  git('init', '-q'); git('add', 'registry'); git('commit', '-q', '-m', 'releases'); git('tag', 'registry-v0.1.0'); git('tag', 'registry-v0.2.0');

  // A database of this test's own: the shared suite database holds exactly one
  // release, which the registry snapshot suite asserts.
  const name = 'unai_publish_' + randomUUID().replaceAll('-', '');
  await admin.query('CREATE DATABASE ' + name);
  scratchDatabases.push(name);
  const url = new URL(serverUrl.href); url.pathname = '/' + name;
  const scratch = new Pool({ connectionString: url.href });
  // `afterAll` force-drops this database; a connection still closing then gets a
  // termination notice, which is expected and must not surface as an error.
  scratch.on('error', () => undefined);
  try {
    const lock = await admin.connect();
    try { await lock.query('SELECT pg_advisory_lock(1970170217, 3)'); await runMigrations(scratch, resolve('migrations')); }
    finally { await lock.query('SELECT pg_advisory_unlock(1970170217, 3)').catch(() => undefined); lock.release(); }
    const release = await loadRegistryRelease({ repository: repo, version: '0.2.0' });
    expect(release.migration).toMatchObject({ from: '0.1.0', changeClass: 'IDENTITY_AFFECTING' });
    const evidence = readTaggedMigrationEvidence(repo, release);
    await expect(publishRegistryRelease(scratch, release, randomUUID(), evidence)).rejects.toThrow('REGISTRY_MIGRATION_BASE_NOT_PUBLISHED');
    const base = await publishRegistryRelease(scratch, await loadRegistryRelease({ repository: repo, version: '0.1.0' }), randomUUID());
    const published = await publishRegistryRelease(scratch, release, randomUUID(), evidence);
    const rows = (await scratch.query('SELECT * FROM registry_migration_manifests')).rows;
    expect(rows).toEqual([expect.objectContaining({ from_registry_release_id: base.releaseId, to_registry_release_id: published.releaseId,
      from_semantic_version: '0.1.0', to_semantic_version: '0.2.0', change_class: 'IDENTITY_AFFECTING', shadow_run_id: runId,
      projection_replay_ref: 'registry/evidence/0.2.0/projection-replay.json', rollback_plan: 'Pin deployments back to 0.1.0.',
      manifest_content_hash: release.migrationContentHash })]);
    expect(rows[0].slot_and_proposition_diff).toMatchObject({ shadowDiff: 'registry/evidence/0.2.0/shadow-diff.json',
      slotCollision: { compared: expect.any(Number), changed: expect.any(Number) }, proposition: { compared: expect.any(Number), changed: expect.any(Number) } });
    await expect(scratch.query("UPDATE registry_migration_manifests SET rollback_plan='none'")).rejects.toThrow('REGISTRY_SNAPSHOT_IMMUTABLE');
  } finally { await scratch.end(); }
}, 240000);
