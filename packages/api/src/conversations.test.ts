import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { withOwnerTransaction } from '@unai/postgres';
import * as control from '@unai/control';
import { postgresAdapter, SESSION_COOKIE } from '@unai/auth';
import { createPlatformApi } from './platform.js';

if (!process.env.UNAI_TEST_DATABASE_URL) throw new Error('Run pnpm test for the required PostgreSQL harness');
const admin = new Pool({ connectionString: process.env.UNAI_TEST_DATABASE_URL });
const url = new URL(process.env.UNAI_TEST_DATABASE_URL);
url.username = 'conversation_test_app'; url.password = 'test-only';
const pool = new Pool({ connectionString: url.href });
const a = { ownerScopeId: randomUUID(), actorId: randomUUID() };
const b = { ownerScopeId: randomUUID(), actorId: randomUUID() };
const run = <T>(owner: typeof a, purpose: string, fn: Parameters<typeof withOwnerTransaction<T>>[2]) =>
  withOwnerTransaction(pool, { ...owner, purpose, correlationId: randomUUID() }, fn);
const service = (tx: Parameters<Parameters<typeof withOwnerTransaction>[2]>[0]) => {
  expect(control).toHaveProperty('ConversationService');
  return new control.ConversationService(tx);
};
beforeAll(async () => {
  await admin.query("DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='conversation_test_app') THEN CREATE ROLE conversation_test_app LOGIN PASSWORD 'test-only'; END IF; END $$; GRANT unai_app TO conversation_test_app");
  for (const o of [a, b]) {
    await admin.query('INSERT INTO users(id,display_name) VALUES($1,\'Conversation test\')', [o.actorId]);
    await admin.query("INSERT INTO owner_scopes(id,scope_kind,display_name,created_by_user_id) VALUES($1,'PERSONAL','Conversation test',$2)", [o.ownerScopeId, o.actorId]);
    await admin.query("INSERT INTO owner_scope_members(owner_scope_id,user_id,role) VALUES($1,$2,'OWNER')", [o.ownerScopeId, o.actorId]);
  }
});
afterAll(async () => { await pool.end(); await admin.end(); });

it('verify-a1-metadata: Persisted conversations expose each required field and reload turns in their stored order.', async () => {
  const c = await run(a, 'conversation.write', tx => service(tx).create({ title: 'First title' }));
  expect(c).toEqual({ id: expect.any(String), ownerScopeId: a.ownerScopeId, title: 'First title', createdAt: expect.any(String), lastActivityAt: expect.any(String) });
  await run(a, 'conversation.write', tx => service(tx).rename(c.id, 'Renamed'));
  const turns = await Promise.all(Array.from({ length: 6 }, (_, n) => run(a, 'conversation.write', tx =>
    service(tx).appendTurn(c.id, { speaker: 'owner', text: 'Question ' + n, status: 'accepted' }))));
  const loaded = await run(a, 'conversation.read', tx => service(tx).get(c.id));
  expect(loaded.conversation.title).toBe('Renamed');
  expect(loaded.conversation.createdAt).toBe(c.createdAt);
  expect(Date.parse(loaded.conversation.lastActivityAt)).toBeGreaterThanOrEqual(Date.parse(c.lastActivityAt));
  expect(loaded.turns).toEqual([...turns].sort((x, y) => x.storedOrder - y.storedOrder));
  expect(loaded.turns.map(t => t.storedOrder)).toEqual([0, 1, 2, 3, 4, 5]);
  await run(a, 'data.delete', tx => service(tx).deleteTurn(c.id, loaded.turns[2]!.id));
  const next = await run(a, 'conversation.write', tx => service(tx).appendTurn(c.id, { speaker: 'assistant', text: null, status: 'pending' }));
  expect(next.storedOrder).toBe(6);
  await run(a, 'conversation.write', tx => service(tx).updateTurn(c.id, next.id, { text: null, status: 'failed' }));
  const refreshed = await run(a, 'conversation.read', tx => service(tx).get(c.id));
  expect(refreshed.turns.map(t => t.storedOrder)).toEqual([0, 1, 3, 4, 5, 6]);
  expect(refreshed.turns.at(-1)?.status).toBe('failed');
  expect((await run(a, 'conversation.read', tx => service(tx).list()))[0]?.id).toBe(c.id);
});

it('verify-a1-storage: Reload retrieves a conversation for its owner while a different owner scope cannot read or mutate it.', async () => {
  const c = await run(a, 'conversation.write', tx => service(tx).create({ title: 'Private' }));
  const turn = await run(a, 'conversation.write', tx => service(tx).appendTurn(c.id, { speaker: 'owner', text: 'Private text', status: 'accepted' }));
  expect((await run(a, 'conversation.read', tx => service(tx).get(c.id))).turns).toEqual([turn]);
  await expect(run(b, 'conversation.read', tx => service(tx).get(c.id))).rejects.toThrow('CONVERSATION_NOT_FOUND');
  await expect(run(b, 'conversation.write', tx => service(tx).rename(c.id, 'Stolen'))).rejects.toThrow('CONVERSATION_NOT_FOUND');
  await expect(run(b, 'conversation.write', tx => service(tx).appendTurn(c.id, { speaker: 'owner', text: 'Injected', status: 'accepted' }))).rejects.toThrow('CONVERSATION_NOT_FOUND');
  await expect(run(b, 'conversation.write', tx => service(tx).updateTurn(c.id, turn.id, { text: 'Injected', status: 'accepted' }))).rejects.toThrow('CONVERSATION_NOT_FOUND');
  await expect(run(b, 'data.delete', tx => service(tx).delete(c.id))).rejects.toThrow('CONVERSATION_NOT_FOUND');
  await expect(run(b, 'data.delete', tx => service(tx).deleteTurn(c.id, turn.id))).rejects.toThrow('CONVERSATION_NOT_FOUND');
  await run(b, 'conversation.write', async tx => {
    expect((await tx.query('SELECT * FROM conversations WHERE id=$1', [c.id])).rows).toEqual([]);
    expect((await tx.query('SELECT * FROM conversation_turns WHERE id=$1', [turn.id])).rows).toEqual([]);
    expect((await tx.query('UPDATE conversations SET title=\'stolen\' WHERE id=$1', [c.id])).rowCount).toBe(0);
    expect((await tx.query('UPDATE conversation_turns SET text=\'stolen\' WHERE id=$1', [turn.id])).rowCount).toBe(0);
  });
  await expect(run(b, 'conversation.write', tx => tx.query("INSERT INTO conversation_turns(id,owner_scope_id,conversation_id,stored_order,speaker,text,status) VALUES($1,$2,$3,99,'owner','injected','accepted')", [randomUUID(), b.ownerScopeId, c.id]))).rejects.toMatchObject({ code: '23503' });
  await expect(run(b, 'conversation.write', tx => tx.query("INSERT INTO conversations(id,owner_scope_id,title) VALUES($1,$2,'injected')", [randomUUID(), a.ownerScopeId]))).rejects.toMatchObject({ code: '42501' });
  expect((await run(a, 'conversation.read', tx => service(tx).get(c.id))).turns).toEqual([turn]);
});

it('verify-a1-lifecycle: An export includes eligible conversations and turns, retention applies to them, and deleted conversations do not appear in subsequent export.', async () => {
  const c = await run(a, 'conversation.write', tx => service(tx).create({ title: 'Export me' }));
  const t = await run(a, 'conversation.write', tx => service(tx).appendTurn(c.id, { speaker: 'owner', text: 'Eligible', status: 'accepted' }));
  const gone = await run(a, 'conversation.write', tx => service(tx).appendTurn(c.id, { speaker: 'owner', text: 'Remove me', status: 'accepted' }));
  const exported = (o = a) => run(o, 'data.export', tx => control.buildExportBundle(tx, { includeRawEvidence: false, readRaw: async () => new Uint8Array() }));
  expect((await exported()).conversations).toContainEqual(expect.objectContaining({ id: c.id }));
  expect((await exported()).conversationTurns).toContainEqual(t);
  expect((await exported(b)).conversationTurns).not.toContainEqual(t);
  await run(a, 'data.delete', tx => service(tx).deleteTurn(c.id, gone.id));
  expect((await exported()).conversationTurns.some(row => row.id === gone.id)).toBe(false);
  await run(a, 'data.delete', tx => service(tx).delete(c.id));
  expect((await exported()).conversations.some(row => row.id === c.id)).toBe(false);
  expect((await exported()).conversationTurns.some(row => row.conversationId === c.id)).toBe(false);
  const old = await run(a, 'conversation.write', tx => service(tx).create({ title: 'Expire me' }));
  await run(a, 'conversation.write', tx => service(tx).appendTurn(old.id, { speaker: 'owner', text: 'Expired', status: 'accepted' }));
  const fresh = await run(a, 'conversation.write', tx => service(tx).create({ title: 'Keep me' }));
  await admin.query("UPDATE conversations SET created_at=now()-interval '3 days',last_activity_at=now()-interval '2 days' WHERE id=$1", [old.id]);
  await run(a, 'permissions.manage', tx => control.updateRetention(tx, { rules: [{ sourceType: 'CONVERSATION', rawRetentionDays: 1, derivedRetentionDays: null }] }));
  const cleaned = await run(a, 'data.delete', tx => service(tx).applyRetention(new Date()));
  expect(cleaned.map(row => row.conversationId)).toContain(old.id);
  const result = await exported();
  expect(result.conversations.some(row => row.id === old.id)).toBe(false);
  expect(result.conversationTurns.some(row => row.conversationId === old.id)).toBe(false);
  expect(result.conversations.some(row => row.id === fresh.id)).toBe(true);
  expect((await admin.query('SELECT 1 FROM conversation_turns WHERE conversation_id IN ($1,$2)', [old.id, c.id])).rowCount).toBe(0);
  expect((await admin.query("SELECT 1 FROM audit_events WHERE owner_scope_id=$1 AND event_kind='DELETION' AND objects_and_fields_accessed @> $2::jsonb", [a.ownerScopeId, JSON.stringify([{ type: 'conversations', id: c.id }])])).rowCount).toBe(2);
});

it('integrates conversation export, deletion preview/commit and retention into existing data-control routes', async () => {
  const token = randomUUID();
  await postgresAdapter(admin).createSession!({ userId: a.actorId, sessionToken: token, expires: new Date(Date.now() + 3600000) });
  const app = createPlatformApi({ authPool: admin, appPool: pool });
  app.addHook('onRequest', async request => { Object.defineProperty(request.raw.socket, 'encrypted', { value: true }); });
  const headers = (purpose: string) => ({ cookie: SESSION_COOKIE + '=' + token, 'x-owner-scope-id': a.ownerScopeId,
    'x-purpose': purpose, 'x-correlation-id': randomUUID(), 'idempotency-key': randomUUID(), 'x-maximum-sensitivity': 'RESTRICTED' });
  try {
    const c = await run(a, 'conversation.write', tx => service(tx).create({ title: 'Route lifecycle' }));
    await run(a, 'conversation.write', tx => service(tx).appendTurn(c.id, { speaker: 'owner', text: 'Route transcript', status: 'accepted' }));
    const exported = await app.inject({ method: 'POST', url: '/v1/export', headers: headers('data.export'), payload: { includeRawEvidence: false } });
    expect(exported.statusCode, exported.body).toBe(201);
    expect(JSON.stringify(exported.json())).toContain('Route transcript');
    const before = (await admin.query('SELECT count(*)::int AS n FROM retention_and_deletion_requests WHERE owner_scope_id=$1', [a.ownerScopeId])).rows[0].n;
    const preview = await app.inject({ method: 'POST', url: '/v1/data/deletions/preview', headers: headers('data.delete'), payload: { conversationIds: [c.id] } });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json()).toMatchObject({ status: 'PREVIEW', conversationIds: [c.id], cascade: { conversations: 1, conversationTurns: 1 } });
    expect((await run(a, 'conversation.read', tx => service(tx).get(c.id))).turns).toHaveLength(1);
    expect((await admin.query('SELECT count(*)::int AS n FROM retention_and_deletion_requests WHERE owner_scope_id=$1', [a.ownerScopeId])).rows[0].n).toBe(before);
    const deleted = await app.inject({ method: 'POST', url: '/v1/data/deletions', headers: headers('data.delete'), payload: { conversationIds: [c.id], confirmation: 'DELETE' } });
    expect(deleted.statusCode, deleted.body).toBe(200);
    expect(deleted.json()).toMatchObject({ status: 'COMPLETED', conversationIds: [c.id], cascade: { conversations: 1, conversationTurns: 1 }, projectionsRebuilt: [] });
    await expect(run(a, 'conversation.read', tx => service(tx).get(c.id))).rejects.toThrow('CONVERSATION_NOT_FOUND');
    const old = await run(a, 'conversation.write', tx => service(tx).create({ title: 'Route retention' }));
    await run(a, 'conversation.write', tx => service(tx).appendTurn(old.id, { speaker: 'owner', text: 'Retained transcript', status: 'accepted' }));
    await admin.query("UPDATE conversations SET created_at=now()-interval '3 days',last_activity_at=now()-interval '2 days' WHERE id=$1", [old.id]);
    const rule = await app.inject({ method: 'PATCH', url: '/v1/settings/retention', headers: headers('permissions.manage'),
      payload: { rules: [{ sourceType: 'CONVERSATION', rawRetentionDays: 1, derivedRetentionDays: null }] } });
    expect(rule.statusCode, rule.body).toBe(200);
    const cleaned = await app.inject({ method: 'POST', url: '/v1/data/retention/cleanup', headers: headers('data.delete'), payload: {} });
    expect(cleaned.statusCode, cleaned.body).toBe(200);
    expect(cleaned.json().conversationsDeleted).toContainEqual({ conversationId: old.id, turnId: null, conversations: 1, conversationTurns: 1 });
    const after = await app.inject({ method: 'POST', url: '/v1/export', headers: headers('data.export'), payload: { includeRawEvidence: false } });
    expect(after.statusCode, after.body).toBe(201);
    expect(after.body).not.toContain('Route transcript');
    expect(after.body).not.toContain('Retained transcript');
  } finally { await app.close(); }
});

it('refuses rejected candidate text, wrong purposes and immutable order changes, and rolls back erasure with its receipt', async () => {
  const c = await run(b, 'conversation.write', tx => service(tx).create({ title: 'Rollback' }));
  const turn = await run(b, 'conversation.write', tx => service(tx).appendTurn(c.id, { speaker: 'assistant', text: null, status: 'pending' }));
  await expect(run(b, 'conversation.write', tx => service(tx).updateTurn(c.id, turn.id, { text: 'Rejected candidate', status: 'refused' }))).rejects.toThrow('CONVERSATION_TEXT_STATUS_INVALID');
  await expect(run(b, 'conversation.read', tx => service(tx).rename(c.id, 'Denied'))).rejects.toThrow('CONTROL_PURPOSE_REFUSED');
  await expect(run(b, 'conversation.write', tx => tx.query('UPDATE conversation_turns SET stored_order=8 WHERE id=$1', [turn.id]))).rejects.toMatchObject({ code: '42501' });
  await expect(run(b, 'conversation.write', tx => tx.query('SELECT unai_private.erase_conversation($1,$2,NULL)', [b.ownerScopeId, c.id]))).rejects.toMatchObject({ code: '42501' });
  await expect(run(a, 'data.delete', tx => tx.query('SELECT unai_private.erase_conversation($1,$2,NULL)', [b.ownerScopeId, c.id]))).rejects.toMatchObject({ code: '42501' });
  await expect(run(b, 'data.delete', async tx => { await service(tx).delete(c.id); throw new Error('ROLLBACK_TEST'); })).rejects.toThrow('ROLLBACK_TEST');
  expect((await run(b, 'conversation.read', tx => service(tx).get(c.id))).turns).toEqual([turn]);
  expect((await admin.query("SELECT 1 FROM audit_events WHERE objects_and_fields_accessed @> $1::jsonb", [JSON.stringify([{ type: 'conversations', id: c.id }])])).rowCount).toBe(0);
});

it('reference resolution reads only the named owner thread and eligible purpose/sensitivity turns', async () => {
  const c = await run(a, 'conversation.write', tx => service(tx).create({ title: 'Dana' }));
  const other = await run(a, 'conversation.write', tx => service(tx).create({ title: 'Other thread' }));
  await run(a, 'conversation.write', tx => service(tx).appendTurn(c.id, {
    speaker: 'owner', text: 'What do I owe Dana this week?', status: 'accepted',
  }));
  const resolve = (o: typeof a, id: string) => run(o, 'conversation.read', tx => service(tx).resolveReference(id, 'And next week?'));
  expect(await resolve(a, c.id)).toEqual({ question: 'What do I owe Dana next week?', status: 'resolved' });
  expect(await resolve(a, other.id)).toEqual({ question: 'And next week?', status: 'unresolved' });
  await expect(resolve(b, c.id)).rejects.toThrow('CONVERSATION_NOT_FOUND');
  await admin.query("UPDATE conversation_turns SET data_purpose='PERSONAL_FINANCE',sensitivity='PRIVATE' WHERE conversation_id=$1", [c.id]);
  const scoped = (purpose: string, sensitivity: string) => run(a, 'conversation.read', async tx => {
    await tx.query("SELECT set_config('unai.data_purpose',$1,true),set_config('unai.maximum_sensitivity',$2,true)", [purpose, sensitivity]);
    return service(tx).resolveReference(c.id, 'And next week?');
  });
  expect((await scoped('PERSONAL_FINANCE', 'PRIVATE')).status).toBe('resolved');
  expect((await scoped('PERSONAL_FINANCE', 'NORMAL')).status).toBe('unresolved');
  expect((await scoped('FAMILY_COORDINATION', 'RESTRICTED')).status).toBe('unresolved');
});
