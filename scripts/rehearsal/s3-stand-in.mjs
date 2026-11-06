// Copied to /usr/local/lib/unai-rehearsal; tooling is not loaded from the release.
import {readFile,mkdir,writeFile,stat} from 'node:fs/promises';
let server;
async function main(){
  const options={},args=process.argv.slice(2);
  for(let i=0;i<args.length;i+=2){
    const flag=args[i],value=args[i+1];
    if(!['--bucket','--kms-key-id','--common-name','--credentials-file','--out'].includes(flag)||!value||value.startsWith('--')||options[flag])throw new Error();
    options[flag]=value;
  }
  if(Object.keys(options).length!==5)throw new Error();
  const file=options['--credentials-file'],info=await stat(file);
  if(!info.isFile()||info.uid!==0||(info.mode&0o777)!==0o600)throw new Error();
  const credentials=JSON.parse(await readFile(file,'utf8'));
  const {startS3ObjectServer}=await import('/opt/unai/current/scripts/s3-object-server.mjs');
  server=await startS3ObjectServer({bucket:options['--bucket'],kmsKeyId:options['--kms-key-id'],commonName:options['--common-name'],credentials});
  const stop=()=>{server.close();};
  process.once('SIGTERM',stop);process.once('SIGINT',stop);
  await mkdir(options['--out'],{recursive:true,mode:0o755});
  await writeFile(`${options['--out']}/cert.pem`,server.certificate,{mode:0o644});
  await writeFile(`${options['--out']}/endpoint`,server.endpoint+'\n',{mode:0o644});
}
try{await main();}catch{server?.close();process.stderr.write('REHEARSAL_S3_FAILED\n');process.exitCode=1;}
