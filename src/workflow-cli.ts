#!/usr/bin/env node
import { EventRuntime } from './events.js';
import { WorkflowCoordinator } from './workflows.js';

function args(argv:string[]):Record<string,string> {
 const out:Record<string,string>={};for(let i=0;i<argv.length;i+=2){const k=argv[i],v=argv[i+1];if(!k?.startsWith('--')||v===undefined)throw new Error('expected --name value');out[k.slice(2)]=v;}return out;
}
function required(a:Record<string,string>,key:string):string {const v=a[key];if(!v?.trim())throw new Error('missing --'+key);return v;}
async function main() {
 const [command,...rest]=process.argv.slice(2),a=args(rest),events=new EventRuntime(),c=new WorkflowCoordinator(events);
 try {
  let result:unknown;
  switch(command) {
   case 'status':result=c.status(a.task);break;
   case 'register': {
    const role=required(a,'role');if(role!=='supervisor'&&role!=='worker')throw new Error('invalid role');
    result=c.register({key:required(a,'key'),topic:required(a,'topic'),role,workspace:a.workspace,chatRef:a['chat-ref']});break;
   }
   case 'bind':result=c.bind(required(a,'key'),a.subscription,a['chat-ref']);break;
   case 'tick':case 'external': {
    if(command==='tick') {
      const period=Number(a['period-ms']??3600000);
      if(!Number.isSafeInteger(period)||period<60000)throw new Error('period must be >= 60000 ms');
      a['dedup-key']='slot:'+Math.floor(Date.now()/period);a.reason??='external timer tick';
    }
    const dispatch=c.external({target:required(a,'target'),producer:required(a,'producer'),dedupKey:required(a,'dedup-key'),reason:required(a,'reason'),summary:a.summary,stateRef:a['state-ref']});
    if(dispatch.accepted){await events.flush(dispatch.eventId);c.synchronizeDeliveryOutcomes();}result={...dispatch,delivery:dispatch.eventId?events.outboxSummary(dispatch.eventId):[]};
    if(!dispatch.accepted)process.exitCode=3;
    else {
      const delivery=events.outboxSummary(dispatch.eventId);
      if(delivery.some(d=>d.state==='failed'||d.state==='cancelled'))process.exitCode=1;
      else if(delivery.some(d=>d.state!=='accepted'))process.exitCode=4;
    }
    break;
   }
   case 'flush':await events.flush();c.synchronizeDeliveryOutcomes();result=events.outboxSummary();break;
   case 'pause':case 'resume':result=c.setEnabled(required(a,'key'),command==='resume');break;
   default:throw new Error('usage: workflow-cli status|register|bind|external|tick|flush|pause|resume --name value ...');
  }
  process.stdout.write(JSON.stringify(result)+'\n');
 } finally {events.close();}
}
main().catch(error=>{process.stderr.write((error instanceof Error?error.message:'workflow_cli_error')+'\n');process.exitCode=1;});
