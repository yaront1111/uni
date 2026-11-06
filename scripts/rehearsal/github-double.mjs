// Rehearsal-only GitHub double: never shipped, never run outside the disposable rehearsal host.
// The sync phase copies it and fixtures/sources/github-issue-thread.json into the host and runs
// it as the transient unit rehearsal-github-double on port 443 of its own network namespace (the
// product web holds 0.0.0.0:443 in the host's), behind an /etc/hosts entry and a rehearsal-only
// CA, so the worker's unchanged GitHub client reaches it
// (packages/connectors/src/providers.ts createGithubClient).
// It answers the issue list (page 1: the fixture issue, later pages: none) and that issue's
// comments, each only for the exact bearer token; anything else is 404. It logs one JSON line
// per request with the route word, the status and whether the bearer matched: never a header,
// a path, a query or the token. argv: certificate, key, fixture and token file paths,
// then the address to listen on.
import {createServer} from 'node:https';
import {readFileSync} from 'node:fs';
import {createHash,timingSafeEqual} from 'node:crypto';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const digest=value=>createHash('sha256').update(String(value)).digest();

/** The answer to one request. The issue is served without `pull_request`: `{}` is truthy
 * there and would send the client on to the pull request, commit and check-run reads. */
export function route({method,url,authorization,token,fixture}){
  const {pull_request:_pull,...issue}=fixture.issue;
  const target=new URL(url,'https://double.invalid'),issues=`/repos/${fixture.repository.full_name}/issues`;
  let name='none',body={message:'Not Found'};
  if(method==='GET'&&target.pathname===issues){
    name='issues';body=target.searchParams.get('page')==='1'?[issue]:[];
  }else if(method==='GET'&&target.pathname===`${issues}/${issue.number}/comments`){
    name='comments';body=fixture.comments;
  }
  const authorized=typeof authorization==='string'&&typeof token==='string'&&token.length>0&&
    timingSafeEqual(digest(authorization),digest(`Bearer ${token}`));
  if(name==='none')return {route:name,status:404,authorized,body};
  return authorized?{route:name,status:200,authorized,body}:{route:name,status:401,authorized,body:{message:'Bad credentials'}};
}

/** The one line logged per request. */
export const logLine=answer=>JSON.stringify({event:'github.double',route:answer.route,status:answer.status,authorized:answer.authorized});

function main([certificate,key,fixturePath,tokenPath,address]){
  const fixture=JSON.parse(readFileSync(fixturePath,'utf8')),token=readFileSync(tokenPath,'utf8').trim();
  const server=createServer({cert:readFileSync(certificate),key:readFileSync(key)},(request,response)=>{
    const answer=route({method:request.method,url:request.url,authorization:request.headers.authorization,token,fixture});
    process.stdout.write(logLine(answer)+'\n');
    response.writeHead(answer.status,{'content-type':'application/json; charset=utf-8'}).end(JSON.stringify(answer.body));
  });
  server.listen(443,address);
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main(process.argv.slice(2));
