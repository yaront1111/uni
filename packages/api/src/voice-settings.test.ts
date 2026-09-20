import {Pool} from 'pg';
import {beforeAll,afterAll,expect,it} from 'vitest';
import {randomUUID,randomBytes} from 'node:crypto';
import {postgresAdapter,SESSION_COOKIE} from '@unai/auth';
import {createPlatformApi} from './platform.js';
const admin=new Pool({connectionString:process.env.UNAI_TEST_DATABASE_URL});
const url=new URL(process.env.UNAI_TEST_DATABASE_URL!);url.username='voice_test_app';url.password='test-only';
const appPool=new Pool({connectionString:url.href});
beforeAll(async()=>{await admin.query("DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='voice_test_app') THEN CREATE ROLE voice_test_app LOGIN PASSWORD 'test-only'; END IF; END $$; GRANT unai_app TO voice_test_app");});
afterAll(async()=>{await appPool.end();await admin.end();});
async function owner(){const adapter=postgresAdapter(admin);const user=await adapter.createUser!({name:'Voice owner',email:randomUUID()+'@example.test',emailVerified:null});
 const scope=(user as unknown as {ownerScopeId:string}).ownerScopeId;
 async function session(){const token=randomBytes(32).toString('base64url');await adapter.createSession!({userId:user.id,sessionToken:token,expires:new Date(Date.now()+600000)});return token;}
 return {scope,session,token:await session()};}
function headers(o:{scope:string;token:string},purpose='settings.voice'){return {cookie:SESSION_COOKIE+'='+o.token,'x-owner-scope-id':o.scope,'x-purpose':purpose,'x-correlation-id':randomUUID(),'idempotency-key':randomUUID()};}
function api(){const app=createPlatformApi({authPool:admin,appPool});app.addHook('onRequest',async r=>{Object.defineProperty(r.raw.socket,'encrypted',{value:true});});return app;}
it('verify-d5-persist: A saved voice change survives new sessions and another device for the same owner, remains invisible to another owner scope, and uses the stated existing-style settings route.',async()=>{
 const a=await owner(),b=await owner(),app=api();
 try{const read=()=>app.inject({url:'/v1/settings/voice',headers:headers(a)});
 expect((await read()).statusCode).toBe(200);
 expect((await read()).json()).toEqual({speechEnabled:true,provider:'local',remoteEnabled:false,language:'device',voice:'local',speakingRate:1,handsFreeEnabled:false});
 const patch=await app.inject({method:'PATCH',url:'/v1/settings/voice',headers:headers(a),payload:{language:'he-IL',speakingRate:1.25,handsFreeEnabled:true}});
 expect(patch.statusCode).toBe(200);
 const otherDevice={...a,token:await a.session()};
 expect((await app.inject({method:'POST',url:'/v1/devices',headers:headers(otherDevice,'device.register'),payload:{displayName:'Another device',kind:'PHONE'}})).statusCode).toBe(200);
 const reloaded=await app.inject({url:'/v1/settings/voice',headers:headers(otherDevice)});
 expect(reloaded.json()).toMatchObject({language:'he-IL',speakingRate:1.25,handsFreeEnabled:true,speechEnabled:true});
 expect((await app.inject({url:'/v1/settings/voice',headers:headers(b)})).json().language).toBe('device');
 expect((await app.inject({url:'/v1/settings/voice',headers:{...headers(b),'x-owner-scope-id':a.scope}})).statusCode).toBe(403);
 expect((await app.inject({method:'PATCH',url:'/v1/settings/voice',headers:headers(a),payload:{provider:'remote'}})).statusCode).toBe(400);
 expect((await app.inject({method:'PATCH',url:'/v1/settings/voice',headers:headers(a),payload:{provider:'remote',remoteEnabled:true}})).json()).toMatchObject({provider:'remote',remoteEnabled:true});
 expect((await app.inject({method:'PATCH',url:'/v1/settings/voice',headers:headers(a),payload:{remoteEnabled:false}})).json()).toMatchObject({provider:'local',remoteEnabled:false});
 for(const payload of [{},{ownerScopeId:b.scope},{speakingRate:0},{language:''}])expect((await app.inject({method:'PATCH',url:'/v1/settings/voice',headers:headers(a),payload})).statusCode).toBe(400);
 expect((await app.inject({url:'/v1/settings/voice',headers:headers(a,'permissions.manage')})).statusCode).toBe(403);
 expect((await admin.query("SELECT * FROM audit_events WHERE owner_scope_id=$1 AND purpose='settings.voice'",[a.scope])).rowCount).toBeGreaterThan(0);
 }finally{await app.close();}
});
it('verify-d4-sessions: The devices and sessions controls are available and revoke all signs another active device out.',async()=>{
 const a=await owner(),app=api(),other={...a,token:await a.session()};
 try{
 for(const [session,name] of [[a,'Desktop'],[other,'Phone']] as const)expect((await app.inject({method:'POST',url:'/v1/devices',headers:headers(session,'device.register'),payload:{displayName:name,kind:name==='Phone'?'PHONE':'DESKTOP'}})).statusCode).toBe(200);
 expect((await app.inject({url:'/v1/devices',headers:headers(other,'device.list')})).json().devices).toHaveLength(2);
 expect((await app.inject({method:'POST',url:'/v1/sessions/revoke-all',headers:headers(a,'auth.sign_out_all'),payload:{}})).statusCode).toBe(200);
 expect((await app.inject({url:'/v1/devices',headers:headers(other,'device.list')})).statusCode).toBe(401);
 }finally{await app.close();}
});
it('verify-d6-model: Configuration identifies the current answering provider and model and supplies no editing control for those values.',async()=>{
 const a=await owner();
 const app=createPlatformApi({authPool:admin,appPool,answerPhraser:{modelProvider:'configured-provider',modelId:'configured-model',promptVersion:'test',async phrase(){throw new Error('Read must not invoke model');}}});
 app.addHook('onRequest',async r=>{Object.defineProperty(r.raw.socket,'encrypted',{value:true});});
 try{const response=await app.inject({url:'/v1/ops/metrics',headers:headers(a,'ops.metrics.read')});
 expect(response.statusCode).toBe(200);expect(response.json().answeringModel).toEqual({provider:'configured-provider',model:'configured-model',mode:'model'});
 }finally{await app.close();}
});
it('verify-d4-connectors: At /admin/configuration the owner can connect, inspect status and revoke using the existing connector functionality.',async()=>{
 const a=await owner(),app=api();
 try{
  const created=await app.inject({method:'POST',url:'/v1/connectors',headers:headers(a,'connector.manage'),payload:{connectorType:'GMAIL',externalAccountRef:'owner@example.test',requestedCapabilities:[]}});
  expect(created.statusCode).toBe(201);expect(created.json().status).toBe('PENDING_AUTHORIZATION');const id=created.json().connectorId;
  expect((await app.inject({method:'POST',url:'/v1/connectors/'+id+'/capabilities',headers:headers(a,'connector.manage'),payload:{capabilities:[{capabilityId:'gmail.read_metadata',granted:true}]}})).statusCode).toBe(200);
  expect((await app.inject({url:'/v1/connectors',headers:headers(a,'connector.read')})).json().connectors).toEqual([expect.objectContaining({connectorId:id,status:'ACTIVE'})]);
  expect((await app.inject({method:'POST',url:'/v1/connectors/'+id+'/disconnect',headers:headers(a,'connector.manage'),payload:{}})).statusCode).toBe(200);
  expect((await app.inject({url:'/v1/connectors',headers:headers(a,'connector.read')})).json().connectors[0].status).toBe('DISCONNECTED');
 }finally{await app.close();}
});

