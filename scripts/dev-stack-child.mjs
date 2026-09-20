/** Initial supervision child only; the downstream assembly supplies API/web.
 * Resolve the mounted handles using the actual product secrets provider. */
const unregister=(await import('tsx/esm/api')).register();
try{
  const {createDefaultSecretsManager}=await import('../packages/secrets/src/index.ts');
  const secrets=createDefaultSecretsManager();
  await secrets.resolve(process.env.UNAI_DEV_DATABASE_URL);
  await secrets.resolve(process.env.UNAI_S3_CREDENTIALS);
}catch{process.exitCode=1;}
finally{await unregister();}
if(!process.exitCode){
  const timer=setInterval(()=>{},60000);
  const stop=()=>{clearInterval(timer);process.disconnect?.();};
  process.on('SIGINT',stop);process.on('SIGTERM',stop);
  process.on('disconnect',()=>clearInterval(timer));
  process.send?.({type:'ready'});
}
