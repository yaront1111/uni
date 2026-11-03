import {spawn,spawnSync,type ChildProcess} from 'node:child_process';
import {existsSync,readdirSync,readFileSync,statSync} from 'node:fs';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {createServer,request,type IncomingHttpHeaders,type IncomingMessage,type Server} from 'node:http';
import {request as secureRequest} from 'node:https';
import {createServer as createNetServer,type AddressInfo} from 'node:net';
import {tmpdir} from 'node:os';
import {createServer as createTlsServer,type Server as TlsServer} from 'node:tls';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {createRequestListener,securityHeaders} from './lib/security-headers';

/** The headers every response of the web process carries besides the policy. */
const FIXED_HEADERS={
  'strict-transport-security':'max-age=31536000',
  'x-content-type-options':'nosniff',
  'referrer-policy':'same-origin',
  'x-frame-options':'DENY',
  'permissions-policy':'microphone=(self), camera=(), geolocation=(), payment=(), usb=()',
  'cross-origin-opener-policy':'same-origin',
  'cross-origin-resource-policy':'same-origin',
};
const policyFor=(nonce:string)=>`default-src 'self'; script-src 'self' 'nonce-${nonce}' 'strict-dynamic'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'self'; object-src 'none'; upgrade-insecure-requests`;
const NONCE=/^[A-Za-z0-9+/]{22}==$/;

type Reply={status:number;headers:IncomingHttpHeaders;body:string};
/** A GET to 127.0.0.1; over TLS verified against `ca` when one is given. */
function get(port:number,path:string,headers:Record<string,string>,ca?:Buffer):Promise<Reply>{
  return new Promise((resolve,reject)=>{
    const options={host:'127.0.0.1',port,path,headers};
    const sent=ca?secureRequest({...options,ca},onResponse):request(options,onResponse);
    function onResponse(response:IncomingMessage){
      let body='';response.setEncoding('utf8');
      response.on('data',chunk=>{body+=chunk;});
      response.on('end',()=>resolve({status:response.statusCode??0,headers:response.headers,body}));
    }
    sent.on('error',reject);sent.end();
  });
}
/** The nonce a policy header names, or a failed expectation. */
function nonceOf(policy:string|string[]|undefined):string{
  const nonce=typeof policy==='string'?/'nonce-([^']+)'/.exec(policy)?.[1]:undefined;
  expect(nonce,'the policy names a nonce').toBeTypeOf('string');
  return nonce as string;
}

describe('the request listener',()=>{
  const HOST='web.test:8443';
  const seen:(string|string[]|undefined)[]=[];
  const servers:Server[]=[];
  const ports={production:0,dev:0};
  beforeAll(async()=>{
    for(const mode of ['production','dev'] as const){
      const server=createServer(createRequestListener({origin:new URL(`https://${HOST}`),dev:mode==='dev',handle:async(req,res)=>{
        seen.push(req.headers['x-nonce']);
        if(req.url==='/fail')throw new Error('HANDLER_FAILED');
        if(req.url==='/api/cached')res.setHeader('Cache-Control','max-age=60');
        res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<!doctype html><p>ok</p>');
      }}));
      await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
      servers.push(server);ports[mode]=(server.address() as AddressInfo).port;
    }
  });
  afterAll(async()=>{await Promise.all(servers.map(server=>new Promise(resolve=>server.close(resolve))));});

  it('sends the enforced policy and every fixed header in production',async()=>{
    const reply=await get(ports.production,'/',{host:HOST});
    expect(reply.status).toBe(200);
    expect(reply.headers).toMatchObject(FIXED_HEADERS);
    expect(reply.headers['content-security-policy']).toBe(policyFor(nonceOf(reply.headers['content-security-policy'])));
    expect(reply.headers['content-security-policy-report-only']).toBeUndefined();
  });

  it('sends the identical policy as Report-Only under --dev',async()=>{
    const reply=await get(ports.dev,'/',{host:HOST});
    expect(reply.headers).toMatchObject(FIXED_HEADERS);
    expect(reply.headers['content-security-policy-report-only']).toBe(policyFor(nonceOf(reply.headers['content-security-policy-report-only'])));
    expect(reply.headers['content-security-policy']).toBeUndefined();
  });

  it('hands the handler the policy nonce, fresh for every request',async()=>{
    const first=await get(ports.production,'/',{host:HOST});
    const firstNonce=nonceOf(first.headers['content-security-policy']);
    expect(seen.at(-1)).toBe(firstNonce);
    expect(firstNonce).toMatch(NONCE);
    const second=nonceOf((await get(ports.production,'/',{host:HOST})).headers['content-security-policy']);
    expect(seen.at(-1)).toBe(second);
    expect(second).not.toBe(firstNonce);
  });

  it('overwrites a client-supplied x-nonce',async()=>{
    const reply=await get(ports.production,'/',{host:HOST,'x-nonce':'attacker'});
    expect(seen.at(-1)).toBe(nonceOf(reply.headers['content-security-policy']));
  });

  it('defaults /api/ responses to no-store and lets a route choose its own',async()=>{
    expect((await get(ports.production,'/api/x',{host:HOST})).headers['cache-control']).toBe('no-store');
    expect((await get(ports.production,'/api/cached',{host:HOST})).headers['cache-control']).toBe('max-age=60');
    expect((await get(ports.production,'/apiary',{host:HOST})).headers['cache-control']).toBeUndefined();
  });

  it('answers 421 to another Host, with the headers and without calling the handler',async()=>{
    const before=seen.length;
    const reply=await get(ports.production,'/',{host:'evil.test'});
    expect(reply.status).toBe(421);
    expect(reply.headers).toMatchObject(FIXED_HEADERS);
    expect(reply.headers['content-security-policy']).toBe(policyFor(nonceOf(reply.headers['content-security-policy'])));
    expect(seen.length).toBe(before);
  });

  it('answers 500 with a fixed sentence when the handler rejects',async()=>{
    const reply=await get(ports.production,'/fail',{host:HOST});
    expect(reply.status).toBe(500);
    expect(reply.body).toBe('Service unavailable');
    expect(reply.headers).toMatchObject(FIXED_HEADERS);
  });
});

describe('the policy',()=>{
  const directives=(policy:string)=>new Map(policy.split(';').map(part=>part.trim().split(/\s+/)).map(([name='',...sources])=>[name,sources]));
  for(const dev of [false,true]){
    it(`keeps script-src strict and names no other origin${dev?' under --dev':''}`,()=>{
      const headers=securityHeaders('AAAAAAAAAAAAAAAAAAAAAA==',dev);
      const policy=headers[dev?'Content-Security-Policy-Report-Only':'Content-Security-Policy'];
      expect(policy).toBe(policyFor('AAAAAAAAAAAAAAAAAAAAAA=='));
      const parsed=directives(policy as string);
      expect(parsed.get('script-src')).not.toContain("'unsafe-inline'");
      expect(parsed.get('script-src')).not.toContain("'unsafe-eval'");
      for(const [name,sources] of parsed){
        for(const source of sources){
          const allowed=["'self'","'none'","'strict-dynamic'"].includes(source)||/^'nonce-[A-Za-z0-9+/]+={0,2}'$/.test(source)
            ||(name==='style-src'&&source==="'unsafe-inline'")||(name==='img-src'&&source==='data:');
          expect(allowed,`${name} ${source}`).toBe(true);
        }
      }
    });
  }
});

const WEB=fileURLToPath(new URL('.',import.meta.url));
type CheckRun={status:number|null;stdout:string;stderr:string};
function webCheck(env:NodeJS.ProcessEnv):Promise<CheckRun>{
  return new Promise((done,reject)=>{
    const child=spawn(process.execPath,[join(WEB,'../../node_modules/tsx/dist/cli.mjs'),'server.ts','--','--check'],{cwd:WEB,env});
    let stdout='',stderr='';const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('WEB_CHECK_TIMEOUT'));},120000);
    child.stdout.on('data',chunk=>{stdout+=chunk;});child.stderr.on('data',chunk=>{stderr+=chunk;});child.once('error',reject);
    child.once('close',status=>{clearTimeout(timer);done({status,stdout,stderr});});
  });
}
describe('web --check (no Next build or database needed)',()=>{
  let root='',api:TlsServer,held:ReturnType<typeof createNetServer>,handshakes=0,bytes=0;
  let runs:CheckRun[]=[];
  const lines=(run:CheckRun):{check:string;status:string;code:string}[]=>run.stdout.trim().split('\n').map(line=>JSON.parse(line)).filter(line=>'check' in line);
  beforeAll(async()=>{
    const {createSelfSignedCertificate}=await import(pathToFileURL(join(WEB,'../../scripts/tls-certificate.mjs')).href) as {
      createSelfSignedCertificate():{key:string;certificate:string};
    };
    root=await mkdtemp(join(tmpdir(),'unai-web-check-'));const material=createSelfSignedCertificate();
    const key=join(root,'key.pem'),cert=join(root,'cert.pem'),wrong=join(root,'wrong.pem'),mount=join(root,'secrets');
    await writeFile(key,material.key,{mode:0o600});await writeFile(cert,material.certificate);
    await writeFile(wrong,createSelfSignedCertificate().certificate);await mkdir(mount,{mode:0o700});
    for(const [name,value] of Object.entries({session:'SENTINEL_session_secret_at_least_32_characters',short:'SENTINEL_short',
      google:'SENTINEL_google',auth:'postgresql://u:SENTINEL_password@127.0.0.1:9/auth'}))await writeFile(join(mount,name),value,{mode:0o600});
    api=createTlsServer({key:material.key,cert:material.certificate},socket=>{
      handshakes++;socket.on('data',chunk=>{bytes+=chunk.length;});socket.on('error',()=>socket.destroy());
    });
    await new Promise<void>(done=>api.listen(0,'127.0.0.1',done));
    held=createNetServer();await new Promise<void>(done=>held.listen(0,'127.0.0.1',done));
    const down=createNetServer();await new Promise<void>(done=>down.listen(0,'127.0.0.1',done));
    const downPort=(down.address() as AddressInfo).port;await new Promise<void>(done=>down.close(()=>done()));
    const env:NodeJS.ProcessEnv={PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,TEMP:process.env.TEMP,NODE_ENV:'test',
      NEXTAUTH_URL:`https://127.0.0.1:${(held.address() as AddressInfo).port}`,UNAI_WEB_TLS_KEY_FILE:key,UNAI_WEB_TLS_CERT_FILE:cert,
      UNAI_SECRETS_MOUNT:mount,NEXTAUTH_SECRET:'secret://mounted/session',GOOGLE_CLIENT_SECRET:'secret://mounted/google',GOOGLE_CLIENT_ID:'test-client',
      UNAI_AUTH_DATABASE_URL:'secret://mounted/auth',UNAI_DATABASE_CA_FILE:cert,
      UNAI_API_ORIGIN:`https://127.0.0.1:${(api.address() as AddressInfo).port}`,UNAI_API_CA_FILE:cert};
    runs=await Promise.all([webCheck(env),webCheck({...env,UNAI_API_ORIGIN:`https://127.0.0.1:${downPort}`}),
      webCheck({...env,NEXTAUTH_URL:'http://x'}),webCheck({...env,NEXTAUTH_SECRET:'secret://mounted/short'}),webCheck({...env,UNAI_API_CA_FILE:wrong})]);
  },180000);
  afterAll(async()=>{
    await Promise.all([api,held].filter(Boolean).map(server=>new Promise<void>(done=>server.close(()=>done()))));
    if(root)await rm(root,{recursive:true,force:true});
  });
  it('reports four successful checks while its service port is held, without connecting to the auth DB',()=>{
    expect(runs[0]!.status,runs[0]!.stderr).toBe(0);
    expect(lines(runs[0]!)).toEqual(['origin','tls_certificate','auth','api'].map(check=>({check,status:'ok',code:'OK'})));
    expect(JSON.parse(readFileSync(join(WEB,'package.json'),'utf8')).scripts.start).toBe('tsx server.ts');
    expect(JSON.parse(readFileSync(join(WEB,'../../package.json'),'utf8')).scripts['start:web']).toBe('pnpm --filter @unai/web start');
  });
  it('completes the API handshake without sending application bytes',()=>{expect(handshakes).toBeGreaterThan(0);expect(bytes).toBe(0);});
  it.each([[1,'api','warn','API_UNREACHABLE',0],[2,'origin','fail','WEB_TLS_CONFIG_INVALID',1],
    [3,'auth','fail','AUTH_CONFIG_REQUIRED',1],[4,'api','fail','API_TLS_HANDSHAKE_FAILED',1]] as const)(
    'classifies case %s and continues the remaining checks',(index,check,status,code,exit)=>{
      expect(runs[index]!.status).toBe(exit);expect(lines(runs[index]!).filter(line=>line.status!=='ok')).toEqual([{check,status,code}]);
    });
  it('prints only JSON status words and codes without any sensitive material',()=>{
    for(const run of runs){
      expect(run.stderr).toBe('');expect(lines(run).map(line=>line.check)).toEqual(['origin','tls_certificate','auth','api']);
      for(const secret of ['SENTINEL','://','BEGIN',root,'startup_failed'])expect(run.stdout+run.stderr).not.toContain(secret);
    }
  });
});
/** Every page must render per request: a statically optimised page is
 * prerendered at build time without a nonce, so 'strict-dynamic' blocks all of
 * its scripts. */
it('keeps every page server-rendered, so each response gets its own nonce',()=>{
  const pages=(readdirSync(join(WEB,'pages'),{recursive:true}) as string[]).map(path=>path.replaceAll('\\','/'))
    .filter(path=>path.endsWith('.tsx')&&!['_app.tsx','_document.tsx'].includes(path)&&!path.startsWith('api/'));
  expect(pages.length).toBeGreaterThan(30);
  const staticPages=pages.filter(path=>!/export\s+(?:const|(?:async\s+)?function)\s+getServerSideProps\b|\.getInitialProps\s*=/.test(readFileSync(join(WEB,'pages',path),'utf8')));
  expect(staticPages,'these pages would be prerendered without a CSP nonce and lose every script; give them getServerSideProps').toEqual([]);
});

/** The production half reads apps/web/.next, so it runs only against a build
 * newer than every source Next bundles from this folder (server.ts is not
 * bundled: tsx runs it). CI sets UNAI_WEB_REQUIRE_BUILD=1 after `pnpm build`,
 * which turns a missing or stale build into a failure instead of a skip. */
function freshBuild():boolean{
  const buildId=join(WEB,'.next','BUILD_ID');
  if(!existsSync(buildId))return false;
  const sources=['pages','components','lib','styles'].flatMap(dir=>(readdirSync(join(WEB,dir),{recursive:true}) as string[])
    .filter(path=>!path.includes('.test.')).map(path=>join(WEB,dir,path))).concat(join(WEB,'next.config.ts'),join(WEB,'package.json'));
  const built=statSync(buildId).mtimeMs;
  return sources.every(path=>{const stat=statSync(path);return !stat.isFile()||stat.mtimeMs<=built;});
}
const fresh=freshBuild();
if(!fresh&&process.env.UNAI_WEB_REQUIRE_BUILD==='1')it('has a fresh production build to test',()=>{throw new Error('WEB_BUILD_MISSING_OR_STALE');});

describe.skipIf(!fresh)('the production server (skipped without a fresh build: run pnpm build)',{timeout:120000},()=>{
  let directory='',cert=Buffer.alloc(0),port=0,child:ChildProcess|undefined,output='';
  const fetch=(path:string)=>get(port,path,{host:`127.0.0.1:${port}`},cert);
  beforeAll(async()=>{
    directory=await mkdtemp(join(tmpdir(),'unai-web-tls-'));
    const keyPath=join(directory,'key.pem'),certPath=join(directory,'cert.pem');
    const openssl=process.platform==='win32'?'C:/Program Files/Git/usr/bin/openssl.exe':'openssl';
    const generated=spawnSync(openssl,['req','-x509','-newkey','rsa:2048','-nodes','-days','1',
      '-subj','/CN=localhost','-addext','subjectAltName=IP:127.0.0.1','-keyout',keyPath,'-out',certPath],{encoding:'utf8'});
    expect(generated.status,generated.stderr).toBe(0);
    cert=readFileSync(certPath);
    port=await new Promise<number>((resolve,reject)=>{
      const probe=createNetServer().once('error',reject).listen(0,'127.0.0.1',()=>{const {port:free}=probe.address() as AddressInfo;probe.close(()=>resolve(free));});
    });
    // One process (tsx's loader, not its CLI, which runs the server in a child
    // that a kill on Windows would orphan), started the way `pnpm start:web` is.
    child=spawn(process.execPath,['--import',pathToFileURL(join(WEB,'../../node_modules/tsx/dist/loader.mjs')).href,'server.ts'],{cwd:WEB,
      env:{PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,TEMP:process.env.TEMP,NODE_ENV:'production',NEXT_TELEMETRY_DISABLED:'1',
        NEXTAUTH_URL:`https://127.0.0.1:${port}`,UNAI_WEB_TLS_KEY_FILE:keyPath,UNAI_WEB_TLS_CERT_FILE:certPath}});
    child.stdout?.on('data',chunk=>{output+=chunk;});child.stderr?.on('data',chunk=>{output+=chunk;});
    // Next's production start loads from source through tsx; on a slow or busy
    // disk (a WSL /mnt checkout beside the other web suites) it takes minutes.
    for(const deadline=Date.now()+180000;;){
      if(child.exitCode!==null||child.signalCode!==null)throw new Error(`WEB_SERVER_EXITED ${child.exitCode??child.signalCode}\n${output}`);
      try{await fetch('/signin');return;}catch{if(Date.now()>deadline)throw new Error(`WEB_SERVER_NOT_READY\n${output}`);}
      await new Promise(resolve=>setTimeout(resolve,250));
    }
  },240000);
  afterAll(async()=>{
    if(child&&child.exitCode===null&&child.signalCode===null){
      const exited=new Promise(resolve=>child?.once('exit',resolve));
      child.kill('SIGTERM');
      const timer=setTimeout(()=>child?.kill('SIGKILL'),10000);
      await exited;clearTimeout(timer);
    }
    if(directory)await rm(directory,{recursive:true,force:true});
  },30000);

  const expectHeaders=(reply:Reply)=>{
    expect(reply.headers).toMatchObject(FIXED_HEADERS);
    const nonce=nonceOf(reply.headers['content-security-policy']);
    expect(reply.headers['content-security-policy']).toBe(policyFor(nonce));
    expect(nonce).toMatch(NONCE);
    return nonce;
  };

  it('enforces the policy with a fresh nonce on / and /signin',async()=>{
    const root=await fetch('/');
    expect(root.status).toBe(307);
    expect(root.headers.location).toBe('/signin');
    expectHeaders(root);
    const first=await fetch('/signin'),second=await fetch('/signin');
    expect(first.status).toBe(200);
    expect(first.headers['content-type']).toMatch(/^text\/html/);
    expect(expectHeaders(first)).not.toBe(expectHeaders(second));
  });

  it('puts the header nonce on every script Next renders, and names no other origin',async()=>{
    const page=await fetch('/signin');
    const nonce=expectHeaders(page);
    const scripts=page.body.match(/<script\b[^>]*>/g)??[];
    expect(scripts.some(tag=>tag.includes('id="__NEXT_DATA__"')),'the inline __NEXT_DATA__ script is rendered').toBe(true);
    expect(scripts.some(tag=>/\ssrc="/.test(tag)),'Next\'s own script files are rendered').toBe(true);
    for(const tag of scripts)expect(tag).toContain(`nonce="${nonce}"`);
    const references=[...page.body.matchAll(/<(?:script|link)\b[^>]*?\s(?:src|href)="([^"]*)"/g)].map(match=>match[1]??'');
    expect(references.length).toBeGreaterThan(0);
    expect(references.filter(reference=>/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(reference))).toEqual([]);
    expect(page.body).not.toMatch(/<[^>]*\son[a-z]+\s*=/i);
    expect(page.body).not.toMatch(/javascript:/i);
  });

  it('defaults API answers to no-store',async()=>{
    const reply=await fetch('/api/platform/devices');
    expect(reply.status).toBe(401);
    expect(JSON.parse(reply.body)).toEqual({code:'SESSION_EXPIRED'});
    expect(reply.headers['cache-control']).toBe('no-store');
    expectHeaders(reply);
  });

  it('sends the headers with the prerendered 404 page',async()=>{
    const reply=await fetch('/no-such-page');
    expect(reply.status).toBe(404);
    expectHeaders(reply);
  });
});
