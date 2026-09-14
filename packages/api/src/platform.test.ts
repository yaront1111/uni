import { Pool } from 'pg';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { randomUUID, randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { runMigrations } from '@unai/postgres';
import { postgresAdapter, SESSION_COOKIE } from '@unai/auth';
import * as platform from './platform.js';
const admin=new Pool({connectionString:process.env.UNAI_TEST_DATABASE_URL});
const url=new URL(process.env.UNAI_TEST_DATABASE_URL!);url.username='platform_test_app';url.password='test-only';
const appPool=new Pool({connectionString:url.href});
beforeAll(async()=>{
  await runMigrations(admin,resolve('migrations'));
  await admin.query("CREATE ROLE platform_test_app LOGIN PASSWORD 'test-only'; GRANT unai_app TO platform_test_app");
});
afterAll(async()=>{await appPool.end();await admin.end();});
it('registers and removes only the authenticated device with durable audit and revocation',async()=>{
  expect(platform).toHaveProperty('createPlatformApi');
  const adapter=postgresAdapter(admin);
  const user=await adapter.createUser!({name:'Test',email:'route@example.test',emailVerified:null});
  const token=randomBytes(32).toString('base64url');
  await adapter.createSession!({userId:user.id,sessionToken:token,expires:new Date(Date.now()+604800000)});
  const owner=(user as unknown as {ownerScopeId:string}).ownerScopeId;
  const app=platform.createPlatformApi({authPool:admin,appPool});
  app.addHook('onRequest',async request=>{Object.defineProperty(request.raw.socket,'encrypted',{value:true});});
  const headers={cookie:SESSION_COOKIE+'='+token,'x-owner-scope-id':owner,'x-purpose':'device.register','x-correlation-id':randomUUID(),'idempotency-key':randomUUID()};
  try{
    const result=await app.inject({method:'POST',url:'/v1/devices',headers,payload:{displayName:'My phone',kind:'PHONE'}});
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({displayName:'My phone',kind:'PHONE'});
    expect(JSON.stringify(result.json())).not.toMatch(/token|hash|key/i);
    const repeated=await app.inject({method:'POST',url:'/v1/devices',headers,payload:{displayName:'My phone',kind:'PHONE'}});
    expect(repeated.json().id).toBe(result.json().id);
    const denied=await app.inject({url:'/v1/devices',headers:{...headers,'x-purpose':'evidence.read'}});
    expect(denied.statusCode).toBe(403);
    const cross=await app.inject({url:'/v1/devices',headers:{...headers,'x-purpose':'device.list','x-owner-scope-id':randomUUID()}});
    expect(cross.statusCode).toBe(403);
    const removed=await app.inject({method:'POST',url:'/v1/devices/'+result.json().id+'/revoke',headers:{...headers,'x-purpose':'device.remove'},payload:{}});
    expect(removed.statusCode).toBe(200);
    expect(await adapter.getSessionAndUser!(token)).toBeNull();
    expect((await admin.query('SELECT purpose FROM audit_events WHERE correlation_id=$1',[headers['x-correlation-id']])).rows.map((r:{purpose:string})=>r.purpose)).toContain('device.remove');
  }finally{await app.close();}
});
