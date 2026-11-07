// Rehearsal-only seam: never shipped, never run outside the disposable rehearsal host.
// The driver passes this text to `node --import tsx --input-type=module -e` as unai-web,
// with /etc/unai/web.env and cwd /opt/unai/current/apps/web, so @unai/auth and lib/server.ts
// resolve to the installed release. lib/server.ts is loaded by a file URL built from that
// cwd: it exists only in the web app, and a relative specifier here would name a file
// beside this script that the repo does not have. It reaches the database only through
// the product's own auth adapter over the web's auth login (lib/server.ts authPool()).
// stdin holds four lines: mode, Google subject, owner scope id, actor id. argv holds none.
// - check: prints FOUND, MISSING or MISMATCH for getUserByAccount, the read next-auth runs
//   first at sign-in. FOUND means the user's id and owner scope equal the two ids.
// - session: after FOUND, mints a one-hour session through the adapter's createSession and
//   prints only its token, which the caller writes to a root-only 0600 file.
// No dollar or percent sign may appear in this file: systemd-run expands both in argv.
import {randomBytes} from 'node:crypto';
import {writeSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {postgresAdapter} from '@unai/auth';

async function main(){
  let input='';
  for await(const chunk of process.stdin)input+=chunk;
  const [mode,subject,scope,actor]=input.split('\n');
  if(mode!=='check'&&mode!=='session')throw new Error('USAGE');
  const {authPool}=await import(pathToFileURL('lib/server.ts').href);
  const pool=await authPool();
  try{
    const adapter=postgresAdapter(pool);
    const user=await adapter.getUserByAccount({provider:'google',providerAccountId:subject});
    const word=!user?'MISSING':user.id===actor&&user.ownerScopeId===scope?'FOUND':'MISMATCH';
    if(mode==='check'){writeSync(1,word+'\n');return;}
    if(word!=='FOUND')throw new Error('OWNER');
    const sessionToken=randomBytes(32).toString('base64url');
    await adapter.createSession({sessionToken,userId:user.id,expires:new Date(Date.now()+3600000)});
    writeSync(1,sessionToken+'\n');
  }finally{await pool.end();}
}
try{await main();}catch{writeSync(2,'REHEARSAL_AUTH_SEAM_FAILED\n');process.exitCode=1;}
process.exit();
