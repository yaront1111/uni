import { Pool } from 'pg';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { runMigrations } from './migrations.js';
import { resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

const pool = new Pool({ connectionString: process.env.UNAI_TEST_DATABASE_URL });
beforeAll(async () => { await runMigrations(pool, resolve('migrations')); });
afterAll(async () => { await pool.end(); });
it('installs the approved opaque-session and issuer-subject identity boundary', async () => {
  const tables = (await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename IN ('auth_identities','auth_sessions') ORDER BY tablename")).rows;
  expect(tables).toEqual([{tablename:'auth_identities'}, {tablename:'auth_sessions'}]);
});
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
async function call(name: string, args: unknown[]) {
  expect((await pool.query('SELECT 1 FROM pg_proc WHERE proname=$1', [name])).rowCount, name).toBe(1);
  return (await pool.query(`SELECT unai_private.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) AS value`, args)).rows[0].value;
}
async function user() {
  const id=randomUUID();
  return call('auth_create_user',[id,'Test person','same@example.test']);
}
async function session(userId: string) {
  const token=hash(randomUUID());
  await call('auth_create_session',[token,userId,new Date(Date.now()+30*86400000),randomUUID()]);
  return token;
}
it('keeps different Google subjects separate even with identical emails',async()=>{
  const a=await user(), b=await user();
  await call('auth_link_identity',[a.id,'subject-'+a.id]);
  await call('auth_link_identity',[b.id,'subject-'+b.id]);
  expect((await call('auth_identity',['subject-'+a.id])).id).toBe(a.id);
  expect((await call('auth_identity',['subject-'+b.id])).id).toBe(b.id);
  expect(a.ownerScopeId).not.toBe(b.ownerScopeId);
});
it('caps lifetime at seven days and refuses expired and revoked sessions',async()=>{
  const a=await user(), token=await session(a.id);
  const resolved=await call('auth_session',[token]);
  expect(Date.parse(resolved.expires)-Date.now()).toBeGreaterThan(6.99*86400000);
  expect(Date.parse(resolved.expires)-Date.now()).toBeLessThanOrEqual(7*86400000);
  await call('auth_revoke_session',[token,randomUUID(),false]);
  expect(await call('auth_session',[token])).toBeNull();
  const expired=await session(a.id);
  await pool.query("UPDATE auth_sessions SET expires_at=now()-interval '1 second' WHERE token_hash=$1",[expired]);
  expect(await call('auth_session',[expired])).toBeNull();
});
it('revokes only current session on logout and all on sign-out-all',async()=>{
  const a=await user(), t1=await session(a.id), t2=await session(a.id);
  await call('auth_revoke_session',[t1,randomUUID(),false]);
  expect(await call('auth_session',[t1])).toBeNull();
  expect((await call('auth_session',[t2])).userId).toBe(a.id);
  const t3=await session(a.id);
  await call('auth_revoke_session',[t2,randomUUID(),true]);
  expect(await call('auth_session',[t3])).toBeNull();
});
it('revokes every session permanently when an account is disabled',async()=>{
  const a=await user(), token=await session(a.id);
  await pool.query('UPDATE users SET disabled_at=now() WHERE id=$1',[a.id]);
  expect(await call('auth_session',[token])).toBeNull();
  await pool.query('UPDATE users SET disabled_at=NULL WHERE id=$1',[a.id]);
  expect(await call('auth_session',[token])).toBeNull();
});
it('revokes device sessions atomically while keeping other devices signed in',async()=>{
  const a=await user(), first=await session(a.id), second=await session(a.id), device=randomUUID();
  await pool.query('INSERT INTO devices(id,owner_scope_id,user_id,display_name) VALUES($1,$2,$3,$4)',[device,a.ownerScopeId,a.id,'Phone']);
  await pool.query('UPDATE auth_sessions SET device_id=$1 WHERE token_hash=$2',[device,first]);
  await pool.query('UPDATE devices SET removed_at=now() WHERE id=$1',[device]);
  expect(await call('auth_session',[first])).toBeNull();
  expect((await call('auth_session',[second])).userId).toBe(a.id);
});
