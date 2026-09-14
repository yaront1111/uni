import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import type { Pool } from 'pg';
import type { Adapter, AdapterUser, AdapterAccount } from 'next-auth/adapters';
import type { NextAuthOptions } from 'next-auth';
import type { GoogleProfile } from 'next-auth/providers/google';
import type { OAuthConfig, OAuthUserConfig } from 'next-auth/providers/oauth';

const Google: (options: OAuthUserConfig<GoogleProfile>)=>OAuthConfig<GoogleProfile> = createRequire(import.meta.url)('next-auth/providers/google').default;
export const SESSION_COOKIE='__Host-unai.session';
const digest=(token:string)=>createHash('sha256').update(token).digest('hex');
export interface IdentityUser extends AdapterUser { ownerScopeId:string }
export interface ResolvedSession {id:string;userId:string;ownerScopeId:string;deviceId:string|null;expires:string;user:IdentityUser}

export function sessionToken(cookie:string|undefined):string|null {
  const values=(cookie??'').split(';').map(value=>value.trim()).filter(value=>value.startsWith(SESSION_COOKIE+'='));
  if(values.length!==1)return null;
  const value=values[0]!.slice(SESSION_COOKIE.length+1);
  return /^[A-Za-z0-9_-]{32,128}$/.test(value)?value:null;
}
export async function resolveSession(pool:Pool,token:string):Promise<ResolvedSession|null>{
  return (await pool.query('SELECT unai_private.auth_session($1) AS value',[digest(token)])).rows[0].value;
}
export async function revokeSessions(pool:Pool,token:string,correlationId:string,all=false):Promise<void>{
  await pool.query('SELECT unai_private.auth_revoke_session($1,$2,$3)',[digest(token),correlationId,all]);
}
export function postgresAdapter(pool:Pool):Adapter {
  async function getUser(id:string):Promise<IdentityUser|null>{
    return (await pool.query('SELECT unai_private.auth_user($1) AS value',[id])).rows[0].value;
  }
  return {
    async createUser(user:Omit<AdapterUser,'id'>){
      return (await pool.query('SELECT unai_private.auth_create_user($1,$2,$3) AS value',[randomUUID(),user.name??'Uai user',user.email])).rows[0].value;
    },
    getUser,
    // Email is display metadata, never an identity or account-linking key.
    async getUserByEmail(){return null;},
    async getUserByAccount(account){
      if(account.provider!=='google')return null;
      return (await pool.query('SELECT unai_private.auth_identity($1) AS value',[account.providerAccountId])).rows[0].value;
    },
    async linkAccount(account:AdapterAccount){
      if(account.provider!=='google')throw new Error('AUTH_PROVIDER_REFUSED');
      await pool.query('SELECT unai_private.auth_link_identity($1,$2)',[account.userId,account.providerAccountId]);
    },
    async updateUser(user){
      const existing=await getUser(user.id);
      if(!existing)throw new Error('AUTH_REFUSED');
      return existing;
    },
    async createSession(session){
      const value:ResolvedSession=(await pool.query('SELECT unai_private.auth_create_session($1,$2,$3,$4) AS value',
        [digest(session.sessionToken),session.userId,session.expires,randomUUID()])).rows[0].value;
      if(!value)throw new Error('AUTH_REFUSED');
      return {sessionToken:session.sessionToken,userId:value.userId,expires:new Date(value.expires)};
    },
    async getSessionAndUser(token){
      const value=await resolveSession(pool,token);
      return value?{session:{sessionToken:token,userId:value.userId,expires:new Date(value.expires)},user:value.user}:null;
    },
    async updateSession(session){
      const value=await resolveSession(pool,session.sessionToken);
      return value?{sessionToken:session.sessionToken,userId:value.userId,expires:new Date(value.expires)}:null;
    },
    async deleteSession(token){await revokeSessions(pool,token,randomUUID());},
  };
}

export function createAuthOptions(pool:Pool,config:{clientId:string;clientSecret:string;secret:string}):NextAuthOptions{
  if(!config.clientId||!config.clientSecret||config.secret.length<32)throw new Error('AUTH_CONFIG_REQUIRED');
  return {
    secret:config.secret,adapter:postgresAdapter(pool),
    providers:[Google({clientId:config.clientId,clientSecret:config.clientSecret,
      authorization:{params:{scope:'openid email profile'}},checks:['pkce','state','nonce'],
      allowDangerousEmailAccountLinking:false})],
    session:{strategy:'database',maxAge:7*86400,updateAge:7*86400,generateSessionToken:()=>randomBytes(32).toString('base64url')},
    useSecureCookies:true,
    cookies:{sessionToken:{name:SESSION_COOKIE,options:{httpOnly:true,secure:true,sameSite:'lax',path:'/'}}},
    pages:{signIn:'/signin',error:'/signin'},
    callbacks:{
      async signIn({account,profile}){
        return account?.provider==='google' && !!profile &&
          ['https://accounts.google.com','accounts.google.com'].includes(String((profile as GoogleProfile).iss));
      },
      async session({session,user}){
        return {expires:session.expires,user:{name:user.name??'Uai user'},ownerScopeId:(user as IdentityUser).ownerScopeId};
      },
    },
    logger:{error(){console.error(JSON.stringify({event:'auth.error',code:'AUTHENTICATION_FAILED'}));},
      warn(){console.warn(JSON.stringify({event:'auth.warning'}));},debug(){}},
  };
}
