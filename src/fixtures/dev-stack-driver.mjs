import {DevStackOrchestrator} from '../../scripts/dev-stack.mjs';

const scenario=process.argv[2];
const stub=role=>['--input-type=module','-e',
  `const timer=setInterval(()=>{},60000);process.send({type:'ready'});`+
  `process.on('SIGTERM',()=>{clearInterval(timer);process.disconnect();});`+
  (scenario===role+'-crash'?`setTimeout(()=>process.exit(17),500);`:'')];
const stack=new DevStackOrchestrator({children:{api:stub('api'),web:stub('web')},
  onStage:async stage=>{
    process.send?.({type:'resources',resources:stack.resources.snapshot()});
    if(scenario==='fail:'+stage)throw new Error('private startup detail must not reach terminal');
    if(scenario==='interrupt:'+stage)process.emit('SIGINT');
  },
  onReady:async()=>{
    process.send?.({type:'ready',resources:stack.resources.snapshot()});
    if(scenario==='normal')stack.requestStop();
  }});
process.on('message',message=>{
  if(message?.type==='interrupt')process.emit('SIGINT');
});
process.exitCode=await stack.run();
process.send?.({type:'finished',resources:stack.resources.snapshot()});
process.disconnect?.();
