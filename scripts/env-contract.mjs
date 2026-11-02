import {lstatSync,readdirSync,readFileSync} from 'node:fs';
import {join,relative,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';

const DOCUMENT='docs/operations/environment.md';
const EXTERNAL='Read by Node.js and dependencies';
const ROOTS=['packages','apps/web','src','scripts'];
const RECEIVER=String.raw`(?:\bprocess\.env|\b\w*[eE]nv)`;
// A new helper must be added both to HELPERS (with its name argument position)
// and REGISTERED (the file implementing its computed lookup). No blanket bypass.
const HELPERS=[
  /\b(?:required|secret|databasePool)\s*\(\s*(['"`])([A-Z][A-Z0-9_]*)\1/g,
  /\b(?:requireSecret|processingRequired|requiredNumber)\s*\(\s*[^,()]+,\s*(['"`])([A-Z][A-Z0-9_]*)\1/g,
];
const REGISTERED=new Set([
  'packages/api/src/server.ts','apps/web/lib/server.ts','packages/api/src/processing-config.ts',
  'packages/model/src/providers.ts','packages/secrets/src/index.ts',
  'packages/registry/src/cli.ts','scripts/storage-harness.mjs',
]);
const MEMBERS=[new RegExp(RECEIVER+String.raw`\s*\??\.\s*([A-Z][A-Z0-9_]*)\b`,'g'),
  /\bprocess\.env\s*\??\.\s*([A-Za-z_]\w*)\b/g];
const INDEX=new RegExp(RECEIVER+'\\s*(?:\\?\\.)?\\[\\s*([\'"`])([A-Za-z_]\\w*)\\1\\s*\\]','g');
// Any bracket key except an empty one (a TypeScript array type) or exactly one quoted
// identifier literal (an INDEX read) is computed, so a quote-led concatenation or
// interpolated template fails closed. Whitespace is skipped inside the lookaheads.
const COMPUTED=new RegExp(RECEIVER+'\\s*(?:\\?\\.)?\\[(?!\\s*\\])(?!\\s*([\'"`])[A-Za-z_]\\w*\\1\\s*\\])');
const QUOTED=/(['"`])([A-Z][A-Z0-9_]*)\1/g;
const skipped=name=>['node_modules','dist','.next'].includes(name)||name.startsWith('.moe');
const portable=path=>path.split(sep).join('/');

function plainPath(root,path){
  let current=root;
  for(const part of path.split('/')){
    current=join(current,part);
    const stat=lstatSync(current,{throwIfNoEntry:false});
    if(!stat||stat.isSymbolicLink())return false;
  }
  return true;
}
function walk(root,directory,files){
  for(const entry of readdirSync(directory,{withFileTypes:true})){
    if(skipped(entry.name))continue;
    const path=join(directory,entry.name);
    if(entry.isDirectory())walk(root,path,files);
    else if(entry.isFile()&&/\.(ts|tsx|mjs)$/.test(entry.name)&&!entry.name.includes('.test.')){
      files.set(portable(relative(root,path)),readFileSync(path,'utf8').split(/\r?\n/));
    }
  }
}
function scan(root,issues){
  const files=new Map(),reads=new Map();
  for(const directory of ROOTS)if(plainPath(root,directory))walk(root,join(root,directory),files);
  for(const [file,lines] of files)lines.forEach((line,index)=>{
    const add=name=>{
      if(!reads.has(name))reads.set(name,new Map());
      reads.get(name).set(`${file}:${index+1}`,file);
    };
    for(const regex of MEMBERS)for(const match of line.matchAll(regex))add(match[1]);
    for(const regex of [INDEX,...HELPERS])for(const match of line.matchAll(regex))add(match[2]);
    if(COMPUTED.test(line)){
      if(REGISTERED.has(file))for(const match of line.matchAll(QUOTED))add(match[2]);
      else issues.add(`ENV_CONTRACT_DYNAMIC_READ_UNREGISTERED ${file}:${index+1}`);
    }
  });
  return {files,reads};
}
const cells=line=>line.trim().replace(/^\||\|$/g,'').split(/(?<!\\)\|/).map(cell=>cell.trim());
function rowsOf(text){
  const lines=text.split(/\r?\n/),rows=[];
  let heading='',consumer=-1,table=false;
  for(let index=0;index<lines.length;index++){
    const line=lines[index],title=/^##\s+(.+)$/.exec(line);
    if(title){heading=title[1].trim();table=false;}
    if(!line.startsWith('|')){table=false;continue;}
    if(/^\|\s*:?-{3,}/.test(lines[index+1]??'')){
      const headers=cells(line);
      table=headers[0].toLowerCase()==='variable';
      consumer=headers.findIndex(header=>/^consumer/i.test(header));
      index++;continue;
    }
    if(!table||heading===EXTERNAL)continue;
    const values=cells(line);
    const names=[...values[0].matchAll(/`([A-Z][A-Z0-9_]*)`/g)].map(match=>match[1]);
    const refs=[...(values[consumer]??'').matchAll(/`([^`]+\.(?:ts|tsx|mjs)):(\d+)`/g)]
      .map(match=>({file:match[1],line:Number(match[2]),text:`${match[1]}:${match[2]}`}));
    for(const name of names)rows.push({name,refs});
  }
  return rows;
}
function check(rows,files,reads,issues){
  const documented=new Set(rows.map(row=>row.name));
  for(const [name,locations] of reads){
    if(!documented.has(name))issues.add(`ENV_CONTRACT_UNDOCUMENTED ${name} ${[...locations.keys()].sort().join(',')}`);
  }
  for(const {name,refs} of rows){
    if(!reads.has(name)){issues.add(`ENV_CONTRACT_UNREAD ${name}`);continue;}
    if(!refs.length)issues.add(`ENV_CONTRACT_CONSUMER_REQUIRED ${name}`);
    for(const ref of refs){
      const lines=files.get(ref.file),consumers=new Set(reads.get(name).values());
      if(!lines||ref.line<1||ref.line>lines.length||!consumers.has(ref.file)){
        issues.add(`ENV_CONTRACT_CONSUMER_INVALID ${name} ${ref.text}`);
      }
    }
  }
}
function fail(message){process.stderr.write(message+'\n');process.exitCode=1;}
function main(){
  const args=process.argv.slice(2);
  if(args.length!==0&&(args.length!==2||args[0]!=='--root'||!args[1]||args[1].startsWith('--'))){
    fail('ENV_CONTRACT_ARGUMENTS_INVALID');return;
  }
  const root=args.length?resolve(args[1]):fileURLToPath(new URL('..',import.meta.url));
  if(!plainPath(root,DOCUMENT)){fail('ENV_CONTRACT_DOCUMENT_MISSING');return;}
  const rows=rowsOf(readFileSync(join(root,DOCUMENT),'utf8')),issues=new Set();
  const {files,reads}=scan(root,issues);
  check(rows,files,reads,issues);
  if(issues.size){
    for(const issue of [...issues].sort())process.stderr.write(issue+'\n');
    fail(`ENV_CONTRACT_FAILED ${issues.size} issue(s); see ${DOCUMENT}`);
  }else process.stdout.write(`ENV_CONTRACT_PASS ${reads.size} variables, ${files.size} files scanned\n`);
}
try{main();}catch{fail('ENV_CONTRACT_FAILED unable to read repository files');}
