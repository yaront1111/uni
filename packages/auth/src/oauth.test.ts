// Controlled identity server is test-only; production retains Google's pinned issuer/discovery.
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {dirname,join,resolve} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {expect,it,vi} from 'vitest';
import {runMigrations} from '@unai/postgres';
import {createAuthOptions,resolveSession,SESSION_COOKIE} from './index.js';
import type {NextAuthOptions} from 'next-auth';
const require=createRequire(import.meta.url);
const authRoot=dirname(require.resolve('next-auth'));
const {AuthHandler}=require(join(authRoot,'core/index.js')) as {AuthHandler(input:{req:Record<string,unknown>;options:NextAuthOptions}):Promise<{body:Record<string,unknown>;redirect?:string;cookies?:Array<{name:string;value:string}>}>};
const {generateKeyPair,exportJWK,SignJWT}=createRequire(join(authRoot,'index.js'))('jose');
it('completes verified OAuth with PKCE and nonce, rejects state tampering, and logs out the database session',async()=>{
  const pool=new Pool({connectionString:process.env.UNAI_TEST_DATABASE_URL});
  await runMigrations(pool,resolve('migrations'));
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
      const idToken=await new SignJWT({name:'OAuth test',email:'oauth@example.test',email_verified:true,nonce:authorization!.searchParams.get('nonce')})
        .setProtectedHeader({alg:'RS256',kid:'test-only'}).setIssuer('https://accounts.google.com').setAudience('controlled-test-client')
        .setSubject('controlled-'+randomUUID()).setIssuedAt().setExpirationTime('5m').sign(keys.privateKey);
      res.end(JSON.stringify({access_token:'test-only',token_type:'Bearer',expires_in:300,id_token:idToken}));return;
    }
    res.statusCode=404;res.end('{}');
  })().catch(()=>{res.statusCode=500;res.end('{}');});});
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));
  base='http://127.0.0.1:'+(server.address() as {port:number}).port;
  try{
    vi.stubEnv('NEXTAUTH_URL','https://unai.example.test');
    const options=createAuthOptions(pool,{clientId:'controlled-test-client',clientSecret:'controlled-test-secret',secret:'controlled-test-only-secret-32-characters'});
    const provider=options.providers[0] as {options?:Record<string,unknown>};
    provider.options={...provider.options,wellKnown:base+'/.well-known/openid-configuration'};
    const jar:Record<string,string>={};
    async function invoke(req:Record<string,unknown>){
      const result=await AuthHandler({req:{origin:'https://unai.example.test',cookies:{...jar},...req},options});
      for(const cookie of result.cookies??[])jar[cookie.name]=cookie.value;
      return result;
    }
    const csrf=await invoke({action:'csrf',method:'GET'});
    const signin=await invoke({action:'signin',providerId:'google',method:'POST',body:{csrfToken:csrf.body.csrfToken,callbackUrl:'https://unai.example.test/'}});
    expect(signin.redirect).toContain(base+'/authorize');
    authorization=new URL(signin.redirect!);
    expect(authorization.searchParams.get('scope')).toBe('openid email profile');
    expect(authorization.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorization.searchParams.get('nonce')).toBeTruthy();
    const goodJar={...jar};
    const refused=await invoke({action:'callback',providerId:'google',method:'GET',query:{code:'test-code',state:'tampered'}});
    expect(refused.redirect).toContain('error=OAuthCallback');expect(exchanges).toBe(0);
    Object.assign(jar,goodJar);
    const callback=await invoke({action:'callback',providerId:'google',method:'GET',query:{code:'test-code',state:authorization.searchParams.get('state')}});
    expect(callback.redirect).toBe('https://unai.example.test/');
    const token=jar[SESSION_COOKIE]!;expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const session=await resolveSession(pool,token);expect(session?.user.name).toBe('OAuth test');
    const publicSession=await invoke({action:'session',method:'GET'});
    expect(publicSession.body).toMatchObject({ownerScopeId:session!.ownerScopeId,user:{name:'OAuth test'}});
    expect(JSON.stringify(publicSession.body)).not.toContain(token);
    const signoutCsrf=await invoke({action:'csrf',method:'GET'});
    await invoke({action:'signout',method:'POST',body:{csrfToken:signoutCsrf.body.csrfToken}});
    expect(await resolveSession(pool,token)).toBeNull();
  }finally{vi.unstubAllEnvs();await new Promise<void>(done=>server.close(()=>done()));await pool.end();}
},20000);
