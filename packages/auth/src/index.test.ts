import { beforeAll, afterAll, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { runMigrations } from '@unai/postgres';
import { resolve } from 'node:path';
import * as auth from './index.js';
const admin=new Pool({connectionString:process.env.UNAI_TEST_DATABASE_URL});
const url=new URL(process.env.UNAI_TEST_DATABASE_URL!);url.username='auth_adapter_test';url.password='test-only';
const pool=new Pool({connectionString:url.href});
beforeAll(async()=>{await runMigrations(admin,resolve('migrations'));await admin.query("DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='auth_adapter_test') THEN CREATE ROLE auth_adapter_test LOGIN PASSWORD 'test-only'; END IF; END $$; GRANT unai_auth TO auth_adapter_test");});
afterAll(async()=>{await pool.end();await admin.end();});
it('configures only Google identity scopes and protected database session cookies',()=>{
  expect(auth).toHaveProperty('createAuthOptions');
  const config={clientId:'test-only',clientSecret:'test-only',secret:'test-only-secret-at-least-thirty-two-characters',ownerSubject:'110169484474386276334'};
  const options=auth.createAuthOptions(pool,config);
  expect(options.providers).toHaveLength(1);
  expect(options.providers[0]?.id).toBe('google');
  expect((options.providers[0] as {options?:{authorization?:unknown}}).options?.authorization).toEqual({params:{scope:'openid email profile'}});
  expect(options.session).toMatchObject({strategy:'database',maxAge:604800});
  expect(options.cookies?.sessionToken).toEqual({name:'__Host-unai.session',options:{httpOnly:true,secure:true,sameSite:'lax',path:'/'}});
  expect(()=>auth.createAuthOptions(pool,{...config,ownerSubject:''})).toThrow(/^AUTH_CONFIG_REQUIRED$/);
});
it('admits only the configured owner subject at sign-in and logs a fixed refusal line',async()=>{
  const OWNER='110169484474386276334',OTHER='110169484474386276335';
  const signIn=auth.createAuthOptions(pool,{clientId:'test-only',clientSecret:'test-only',secret:'test-only-secret-at-least-thirty-two-characters',ownerSubject:OWNER}).callbacks!.signIn!;
  const attempt=(provider:string,subject:string,iss:string)=>signIn({account:{provider,providerAccountId:subject,type:'oauth'},profile:{sub:subject,iss,email:'someone@example.test'},user:{id:subject}} as never);
  const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
  try{
    expect(await attempt('google',OWNER,'https://accounts.google.com')).toBe(true);
    expect(await attempt('google',OWNER,'accounts.google.com')).toBe(true);
    expect(warn).not.toHaveBeenCalled();
    expect(await attempt('google',OWNER,'https://evil.test')).toBe(false);
    expect(await attempt('github',OWNER,'https://accounts.google.com')).toBe(false);
    expect(warn).not.toHaveBeenCalled();
    for(const subject of [OTHER,' '+OWNER,OWNER+'\n']){
      expect(await attempt('google',subject,'https://accounts.google.com')).toBe(false);
      expect(warn.mock.calls).toEqual([['{"event":"auth.refused","code":"AUTH_ACCOUNT_NOT_ALLOWED"}']]);
      warn.mockClear();
    }
  }finally{warn.mockRestore();}
});
it('gives the auth login no direct access to application or session tables',async()=>{
  for(const table of ['users','devices','auth_sessions','auth_identities','audit_events']){
    await expect(pool.query('SELECT * FROM '+table)).rejects.toMatchObject({code:'42501'});
  }
});
it('does not extend an opaque session when Auth.js requests rolling expiry',async()=>{
  expect(auth).toHaveProperty('postgresAdapter');
  const adapter=auth.postgresAdapter(pool);
  const user=await adapter.createUser!({name:'Alice',email:'a@example.test',emailVerified:null});
  const token=randomUUID();
  const original=await adapter.createSession!({sessionToken:token,userId:user.id,expires:new Date(Date.now()+604800000)});
  const updated=await adapter.updateSession!({sessionToken:token,expires:new Date(Date.now()+1209600000)});
  expect(updated?.expires).toEqual(original.expires);
  expect(await adapter.getUserByEmail!('a@example.test')).toBeNull();
  await adapter.deleteSession!(token);
  expect(await adapter.getSessionAndUser!(token)).toBeNull();
});
it('ignores spoofed identity headers and rejects ambiguous session cookies',()=>{
  expect(auth).toHaveProperty('sessionToken');
  expect(auth.sessionToken('actor=forged')).toBeNull();
  expect(auth.sessionToken('__Host-unai.session=a; __Host-unai.session=b')).toBeNull();
});
