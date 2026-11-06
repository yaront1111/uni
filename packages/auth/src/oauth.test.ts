// Controlled identity server is test-only; production retains Google's pinned issuer/discovery.
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {dirname,join,resolve} from 'node:path';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {expect,it,vi} from 'vitest';
import {runMigrations} from '@unai/postgres';
import {createAuthOptions,resolveSession,SESSION_COOKIE} from './index.js';
import type {NextAuthOptions} from 'next-auth';
const require=createRequire(import.meta.url);
const authRoot=dirname(require.resolve('next-auth'));
const {AuthHandler}=require(join(authRoot,'core/index.js')) as {AuthHandler(input:{req:Record<string,unknown>;options:NextAuthOptions}):Promise<{body:Record<string,unknown>;redirect?:string;cookies?:Array<{name:string;value:string}>}>};
const {generateKeyPair,exportJWK,SignJWT}=createRequire(join(authRoot,'index.js'))('jose');
/** A per-run 21-digit Google-shaped subject, so parallel files never share one. */
const digits=()=>'1'+Array.from(randomBytes(20),byte=>byte%10).join('');
const REFUSED='{"event":"auth.refused","code":"AUTH_ACCOUNT_NOT_ALLOWED"}';
it('completes verified OAuth with PKCE and nonce, rejects state tampering, logs out, and refuses a second Google account without a row',async()=>{
  const pool=new Pool({connectionString:process.env.UNAI_TEST_DATABASE_URL});
  await runMigrations(pool,resolve('migrations'));
  const OWNER=digits(),STRANGER=digits(),ownerEmail=`owner-${randomUUID()}@example.test`,strangerEmail=`stranger-${randomUUID()}@example.test`;
  expect(STRANGER).not.toBe(OWNER);
  let claims={sub:OWNER,name:'OAuth test',email:ownerEmail};
  const keys=await generateKeyPair('RS256');
  const jwk={...await exportJWK(keys.publicKey),kid:'test-only',alg:'RS256',use:'sig'};
  let authorization:URL|undefined,base='';let exchanges=0;
  const server=createServer((req,res)=>{void(async()=>{
    res.setHeader('content-type','application/json');
    if(req.url==='/.well-known/openid-configuration'){
      res.end(JSON.stringify({issuer:'https://accounts.google.com',authorization_endpoint:base+'/authorize',token_endpoint:base+'/token',jwks_uri:base+'/jwks',response_types_supported:['code'],subject_types_supported:['public'],id_token_signing_alg_values_supported:['RS256']}));return;
    }
    if(req.url==='/jwks'){res.end(JSON.stringify({keys:[jwk]}));return;}
    if(req.url==='/token'){
      let text='';for await(const chunk of req)text+=chunk;
      const body=new URLSearchParams(text);
      if(body.get('code')!=='test-code'||createHash('sha256').update(body.get('code_verifier')??'').digest('base64url')!==authorization?.searchParams.get('code_challenge')){res.statusCode=400;res.end(JSON.stringify({error:'invalid_grant'}));return;}
      exchanges++;
      const idToken=await new SignJWT({name:claims.name,email:claims.email,email_verified:true,nonce:authorization!.searchParams.get('nonce')})
        .setProtectedHeader({alg:'RS256',kid:'test-only'}).setIssuer('https://accounts.google.com').setAudience('controlled-test-client')
        .setSubject(claims.sub).setIssuedAt().setExpirationTime('5m').sign(keys.privateKey);
      res.end(JSON.stringify({access_token:'test-only',token_type:'Bearer',expires_in:300,id_token:idToken}));return;
    }
    res.statusCode=404;res.end('{}');
  })().catch(()=>{res.statusCode=500;res.end('{}');});});
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));
  base='http://127.0.0.1:'+(server.address() as {port:number}).port;
  const warn=vi.spyOn(console,'warn'),error=vi.spyOn(console,'error');
  /** This run's rows only: other files insert users into the same database in parallel. */
  const rows=async(subject:string,email:string)=>(await pool.query(`SELECT
    (SELECT count(*) FROM auth_identities WHERE issuer='https://accounts.google.com' AND subject=$1)::int AS identities,
    (SELECT count(*) FROM users WHERE auth_email=$2)::int AS users,
    (SELECT count(*) FROM owner_scopes s JOIN users u ON u.id=s.created_by_user_id WHERE u.auth_email=$2)::int AS scopes,
    (SELECT count(*) FROM owner_scope_members m JOIN users u ON u.id=m.user_id WHERE u.auth_email=$2)::int AS members`,[subject,email])).rows[0];
  const refusals=()=>warn.mock.calls.filter(call=>call[0]===REFUSED).length;
  try{
    vi.stubEnv('NEXTAUTH_URL','https://unai.example.test');
    const options=createAuthOptions(pool,{clientId:'controlled-test-client',clientSecret:'controlled-test-secret',secret:'controlled-test-only-secret-32-characters',ownerSubject:OWNER});
    const provider=options.providers[0] as {options?:Record<string,unknown>};
    provider.options={...provider.options,wellKnown:base+'/.well-known/openid-configuration'};
    const jar:Record<string,string>={};
    async function invoke(req:Record<string,unknown>){
      const result=await AuthHandler({req:{origin:'https://unai.example.test',cookies:{...jar},...req},options});
      for(const cookie of result.cookies??[])jar[cookie.name]=cookie.value;
      return result;
    }
    /** csrf, then the sign-in POST; keeps the authorization the browser would follow. */
    async function start(){
      const csrf=await invoke({action:'csrf',method:'GET'});
      const signin=await invoke({action:'signin',providerId:'google',method:'POST',body:{csrfToken:csrf.body.csrfToken,callbackUrl:'https://unai.example.test/'}});
      expect(signin.redirect).toContain(base+'/authorize');
      return authorization=new URL(signin.redirect!);
    }
    const callback=(state:string|null)=>invoke({action:'callback',providerId:'google',method:'GET',query:{code:'test-code',state}});
    const owner=await start();
    expect(owner.searchParams.get('scope')).toBe('openid email profile');
    expect(owner.searchParams.get('code_challenge_method')).toBe('S256');
    expect(owner.searchParams.get('nonce')).toBeTruthy();
    const goodJar={...jar};
    const refused=await callback('tampered');
    expect(refused.redirect).toContain('error=OAuthCallback');expect(exchanges).toBe(0);
    Object.assign(jar,goodJar);
    const signedIn=await callback(owner.searchParams.get('state'));
    expect(signedIn.redirect).toBe('https://unai.example.test/');
    const token=jar[SESSION_COOKIE]!;expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const session=await resolveSession(pool,token);expect(session?.user.name).toBe('OAuth test');
    expect(await rows(OWNER,ownerEmail)).toEqual({identities:1,users:1,scopes:1,members:1});
    expect(refusals()).toBe(0);
    const publicSession=await invoke({action:'session',method:'GET'});
    expect(publicSession.body).toMatchObject({ownerScopeId:session!.ownerScopeId,user:{name:'OAuth test'}});
    expect(JSON.stringify(publicSession.body)).not.toContain(token);
    const signoutCsrf=await invoke({action:'csrf',method:'GET'});
    await invoke({action:'signout',method:'POST',body:{csrfToken:signoutCsrf.body.csrfToken}});
    expect(await resolveSession(pool,token)).toBeNull();
    // A second Google account passes Google's checks and is still refused, before any row exists.
    claims={sub:STRANGER,name:'OAuth stranger',email:strangerEmail};
    const second=await start();
    const stranger=await callback(second.searchParams.get('state'));
    expect(stranger.redirect).toMatch(/\/error\?error=AccessDenied$/);
    expect(exchanges).toBe(2);
    expect((stranger.cookies??[]).filter(cookie=>cookie.name===SESSION_COOKIE&&cookie.value)).toEqual([]);
    expect(await rows(STRANGER,strangerEmail)).toEqual({identities:0,users:0,scopes:0,members:0});
    expect(refusals()).toBe(1);
    const logged=JSON.stringify([...warn.mock.calls,...error.mock.calls]);
    for(const value of [STRANGER,strangerEmail,'OAuth stranger'])expect(logged).not.toContain(value);
  }finally{warn.mockRestore();error.mockRestore();vi.unstubAllEnvs();await new Promise<void>(done=>server.close(()=>done()));await pool.end();}
},20000);
