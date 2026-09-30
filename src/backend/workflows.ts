import { z } from 'zod';
import type { LocalToolBackend,LocalToolDescriptor } from './types.js';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { WorkflowCoordinator } from '../workflows.js';

const text=z.string().min(1).max(200);
const manage=z.discriminatedUnion('action',[
 z.object({action:z.literal('register'),key:text,topic:text,role:z.enum(['supervisor','worker']),workspace:z.string().optional(),chat_ref:z.string().optional()}).strict(),
 z.object({action:z.literal('bind'),key:text,subscription_id:z.string().optional(),chat_ref:z.string().optional()}).strict(),
 z.object({action:z.enum(['pause','resume']),key:text}).strict(),
 z.object({action:z.literal('reconcile'),key:text,observed_idle:z.literal(true),evidence:z.string().min(1).max(2000)}).strict(),
]);
const dispatch=z.object({source_task:text,lease_token:text,target_task:text,dedup_key:text,reason:z.string().min(1).max(2000),summary:z.string().max(8000).optional(),state_ref:z.string().max(2000).optional()}).strict();
const run=z.discriminatedUnion('action',[
 z.object({action:z.literal('claim'),task:text,dispatch_id:text,runner:text,lease_ms:z.number().int().optional()}).strict(),
 z.object({action:z.literal('heartbeat'),task:text,lease_token:text,lease_ms:z.number().int().optional()}).strict(),
 z.object({action:z.literal('finish'),task:text,lease_token:text,outcome:z.enum(['idle','completed','needs_input']),checkpoint:z.string().max(2000).optional(),summary:z.string().max(8000).optional()}).strict(),
]);
const read={readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false};
const write={readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:false};
function objectSchema(properties:Record<string,unknown>,required:string[]=[]):LocalToolDescriptor['inputSchema'] {return {type:'object',properties,required,additionalProperties:false};}
const str={type:'string'};
export class WorkflowBackend implements LocalToolBackend {
 readonly id='workflow-coordinator';
 constructor(readonly coordinator:WorkflowCoordinator) {}
 async listTools():Promise<LocalToolDescriptor[]> { return [
  {name:'workflow_status',description:'Read registered workflow/chat targets, current dispatch/run status, and redacted event-delivery receipts. Never returns callback URLs, signing secrets or run lease tokens.',inputSchema:objectSchema({task:str}),annotations:read},
  {name:'workflow_manage',description:'Register or bind an authorized workflow to an existing event subscription; pause/resume it, or reconcile only after actually observing the prior chat/job idle. Registration creates no subscription, schedule, or model run.',inputSchema:objectSchema({action:{enum:['register','bind','pause','resume','reconcile']},key:str,topic:str,role:{enum:['supervisor','worker']},workspace:str,chat_ref:str,subscription_id:str,observed_idle:{type:'boolean'},evidence:str},['action','key']),annotations:write},
  {name:'workflow_dispatch',description:'Queue a continuation event for another registered workflow/chat using the caller run lease and an idempotency key. Carries status data, never a new prompt. Direct self-dispatch and repeated no-progress feedback are rejected; independent external ticks may revisit targets. May start a new billable ChatGPT run under its saved instructions.',inputSchema:objectSchema({source_task:str,lease_token:str,target_task:str,dedup_key:str,reason:str,summary:str,state_ref:str},['source_task','lease_token','target_task','dedup_key','reason']),annotations:{...write,openWorldHint:true}},
  {name:'workflow_run',description:'Claim an event dispatch exactly once before doing work, heartbeat its lease, or record completion/checkpoint. A duplicate claim must not perform the work again. Finishing records status and does not automatically trigger another run.',inputSchema:objectSchema({action:{enum:['claim','heartbeat','finish']},task:str,dispatch_id:str,runner:str,lease_token:str,lease_ms:{type:'integer'},outcome:{enum:['idle','completed','needs_input']},checkpoint:str,summary:str},['action','task']),annotations:write},
 ];}
 async callTool(name:string,args:Record<string,unknown>):Promise<CallToolResult> {
  try {
   let result:unknown;
   if(name==='workflow_status') { const a=z.object({task:text.optional()}).strict().parse(args);result=this.coordinator.status(a.task); }
   else if(name==='workflow_manage') {
    const a=manage.parse(args);
    if(a.action==='register') result=this.coordinator.register({key:a.key,topic:a.topic,role:a.role,workspace:a.workspace,chatRef:a.chat_ref});
    else if(a.action==='bind') result=this.coordinator.bind(a.key,a.subscription_id,a.chat_ref);
    else if(a.action==='reconcile') result=this.coordinator.reconcile({task:a.key,observedIdle:a.observed_idle,evidence:a.evidence});
    else result=this.coordinator.setEnabled(a.key,a.action==='resume');
   } else if(name==='workflow_dispatch') {
    const a=dispatch.parse(args);result=this.coordinator.dispatch({sourceTask:a.source_task,leaseToken:a.lease_token,target:a.target_task,dedupKey:a.dedup_key,reason:a.reason,summary:a.summary,stateRef:a.state_ref});
   } else if(name==='workflow_run') {
    const a=run.parse(args);
    if(a.action==='claim') result=this.coordinator.claim({task:a.task,dispatchId:a.dispatch_id,runner:a.runner,leaseMs:a.lease_ms});
    else if(a.action==='heartbeat') result=this.coordinator.heartbeat(a.task,a.lease_token,a.lease_ms);
    else result=this.coordinator.finish({task:a.task,leaseToken:a.lease_token,outcome:a.outcome,checkpoint:a.checkpoint,summary:a.summary});
   } else throw new Error('unknown_workflow_tool');
   return {content:[{type:'text',text:JSON.stringify(result)}],structuredContent:result as Record<string,unknown>};
  } catch(error) {
   const message=error instanceof z.ZodError?'Invalid workflow arguments':error instanceof Error?error.message:'workflow_error';
   return {isError:true,content:[{type:'text',text:message}]};
  }
 }
}
