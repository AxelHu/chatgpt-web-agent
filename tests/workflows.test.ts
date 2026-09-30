import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventRuntime, type EventWebhookSender } from '../src/events.js';
import { WorkflowCoordinator } from '../src/workflows.js';
import { WorkflowBackend } from '../src/backend/workflows.js';

const cleanup:Array<()=>void>=[];
afterEach(()=>{for(const fn of cleanup.splice(0)) fn();});
async function setup() {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'workflow-test-'));let now=Date.now();
 const sender:EventWebhookSender=async(_s,body)=>{const p=JSON.parse(body);return {ok:true,status:200,body:JSON.stringify(p.type==='verification'?{challenge:p.challenge}:{})};};
 const events=new EventRuntime({storePath:path.join(dir,'events.sqlite'),sender,validateCallback:async()=>{},now:()=>new Date(now)});
 cleanup.push(()=>{events.close();fs.rmSync(dir,{recursive:true,force:true});});
 const c=new WorkflowCoordinator(events);
 for(const key of ['supervisor','worker','other']) {
  c.register({key,topic:'test:'+key,role:key==='supervisor'?'supervisor':'worker'});
  await events.subscribe('local-tunnel-user',{name:'workflow.continue',arguments:{topic:'test:'+key},delivery:{mode:'webhook',url:'https://callback.example/'+key,secret:'whsec_'+Buffer.alloc(32,7).toString('base64')},ttlMs:null});
  c.bind(key);
 }
 return {c,events,setTime:(v:number)=>{now=v;},getTime:()=>now};
}
function external(c:WorkflowCoordinator,key='tick1',target='supervisor') {return c.external({target,producer:'clock',dedupKey:key,reason:'external tick'});}
function claim(c:WorkflowCoordinator,target:string,id:string) {
 const result=c.claim({task:target,dispatchId:id,runner:'test-runner'});
 expect(result.claimed).toBe(true);return result.leaseToken!;
}
describe('supervisor → event → worker orchestration',()=>{
 it('lets a supervisor dispatch a distinct worker and distinguishes receipt/claim/completion',async()=>{
  const {c,events}=await setup();const root=external(c);await events.flush(root.eventId);
  expect(c.status('supervisor').workflows[0]!.state).toBe('queued');
  const s=claim(c,'supervisor',root.dispatchId!);
  const worker=c.dispatch({sourceTask:'supervisor',leaseToken:s,target:'worker',dedupKey:'inspect-1',reason:'ready'});
  expect(worker.accepted).toBe(true);expect(worker.rootId).toBe(root.rootId);
  c.finish({task:'supervisor',leaseToken:s,outcome:'idle'});await events.flush(worker.eventId);
  const w=claim(c,'worker',worker.dispatchId!);
  c.finish({task:'worker',leaseToken:w,outcome:'idle',checkpoint:'commit:abc',summary:'tests pass'});
  expect(c.status('worker').workflows[0]).toMatchObject({state:'idle',revision:1,checkpoint:'commit:abc'});
  expect(c.status().outbox).toHaveLength(2); // finishing emitted no extra event
 });
 it('rejects direct self-dispatch but not ordinary cross-chat work',async()=>{
  const {c}=await setup();const r=external(c),s=claim(c,'supervisor',r.dispatchId!);
  expect(c.dispatch({sourceTask:'supervisor',leaseToken:s,target:'supervisor',dedupKey:'self',reason:'again'}).reason).toBe('direct_self_dispatch');
  expect(c.dispatch({sourceTask:'supervisor',leaseToken:s,target:'worker',dedupKey:'other',reason:'work'}).accepted).toBe(true);
 });
 it('rejects same-causal-root ping-pong without new progress',async()=>{
  const {c}=await setup();const r=external(c),s=claim(c,'supervisor',r.dispatchId!);
  const w=c.dispatch({sourceTask:'supervisor',leaseToken:s,target:'worker',dedupKey:'w',reason:'work'});
  c.finish({task:'supervisor',leaseToken:s,outcome:'idle'});const wt=claim(c,'worker',w.dispatchId!);
  expect(c.dispatch({sourceTask:'worker',leaseToken:wt,target:'supervisor',dedupKey:'bounce',reason:'empty ping'}).reason).toBe('no_progress_cycle');
 });
 it('allows a cross-chat return when the target has genuinely advanced its checkpoint',async()=>{
  const {c}=await setup();const r=external(c),s=claim(c,'supervisor',r.dispatchId!);
  const w=c.dispatch({sourceTask:'supervisor',leaseToken:s,target:'worker',dedupKey:'w',reason:'work'});
  c.finish({task:'supervisor',leaseToken:s,outcome:'idle',checkpoint:'review-state:1'});const wt=claim(c,'worker',w.dispatchId!);
  expect(c.dispatch({sourceTask:'worker',leaseToken:wt,target:'supervisor',dedupKey:'review',reason:'new result ready'}).accepted).toBe(true);
 });
 it('supports 100 independent external monitoring rounds without an arbitrary lifetime hop cap',async()=>{
  const {c}=await setup();for(let i=0;i<100;i++) {
   const r=external(c,'tick-'+i),s=claim(c,'supervisor',r.dispatchId!);
   const d=c.dispatch({sourceTask:'supervisor',leaseToken:s,target:'worker',dedupKey:'continue',reason:'unfinished work'});
   expect(d.accepted).toBe(true);c.finish({task:'supervisor',leaseToken:s,outcome:'idle'});
   const w=claim(c,'worker',d.dispatchId!);c.finish({task:'worker',leaseToken:w,outcome:'idle'});
  }
  expect(c.status().counts.totalRuns).toBe(200);expect(c.status().runs).toHaveLength(40);
 });
 it('deduplicates external ticks and does not dispatch a busy task',async()=>{
  const {c}=await setup();const r=external(c);expect(external(c)).toMatchObject({reason:'duplicate_request',eventId:r.eventId});
  expect(external(c,'tick2').reason).toBe('busy');
  claim(c,'supervisor',r.dispatchId!);expect(external(c,'tick3').reason).toBe('busy');
  expect(c.claim({task:'supervisor',dispatchId:r.dispatchId!,runner:'duplicate'})).toMatchObject({claimed:false,reason:'already_claimed'});
 });
 it('fences stale leases without guessing that an apparently old Chat run is finished',async()=>{
  const {c,setTime,getTime}=await setup();const r=external(c),s=claim(c,'supervisor',r.dispatchId!);
  setTime(getTime()+3*3600_000);expect(c.status('supervisor').workflows[0]!.leaseStale).toBe(true);
  expect(external(c,'new').reason).toBe('busy');
  expect(()=>c.heartbeat('supervisor',s)).toThrow('stale_run_lease');
  c.reconcile({task:'supervisor',observedIdle:true,evidence:'fresh Desktop state idle; old job exited'});
  const next=external(c,'verified-idle');expect(next.accepted).toBe(true);
  expect(()=>c.finish({task:'supervisor',leaseToken:s,outcome:'idle'})).toThrow('invalid_run_lease');
 });
 it('keeps stopped/completed/human-input tasks stopped',async()=>{
  const {c}=await setup();c.setEnabled('worker',false);expect(external(c,'a','worker').reason).toBe('paused');
  c.setEnabled('worker',true);const r=external(c,'b','worker'),w=claim(c,'worker',r.dispatchId!);
  c.finish({task:'worker',leaseToken:w,outcome:'needs_input'});expect(external(c,'c','worker').reason).toBe('needs_input');
 });
 it('does not guess a target when two chats subscribe to one topic',async()=>{
  const {c,events}=await setup();c.register({key:'ambiguous',topic:'amb',role:'worker'});
  for(const id of ['a','b']) await events.subscribe('local-tunnel-user',{name:'workflow.continue',arguments:{topic:'amb'},delivery:{mode:'webhook',url:'https://callback.example/'+id,secret:'whsec_'+Buffer.alloc(32,7).toString('base64')},ttlMs:null});
  expect(external(c,'amb','ambiguous').reason).toBe('ambiguous_subscription');
  const chosen=events.activeSubscriptions('amb')[0]!.id;c.bind('ambiguous',chosen);
  expect(external(c,'amb','ambiguous').accepted).toBe(true);
 });
 it('never reveals callback URLs, signing secrets or leases in status',async()=>{
  const {c}=await setup();const r=external(c),token=claim(c,'supervisor',r.dispatchId!);const text=JSON.stringify(c.status());
  expect(text).not.toContain(token);expect(text).not.toContain('whsec_');expect(text).not.toContain('https://callback');
 });
 it('prevents a tool caller from masquerading as an external tick',async()=>{
  const {c}=await setup();const tool=new WorkflowBackend(c);
  const r=await tool.callTool('workflow_dispatch',{target_task:'worker',dedup_key:'a',reason:'tick',external:true});
  expect(r.isError).toBe(true);
 });
 it('uses shared workspace as an advisory concurrency key without blocking other worktrees',async()=>{
  const {c,events}=await setup();for(const key of ['same1','same2','different']) {
   c.register({key,topic:key,role:'worker',workspace:key==='different'?'/tmp/distinct-worktree':'/tmp/shared-worktree'});
   await events.subscribe('local-tunnel-user',{name:'workflow.continue',arguments:{topic:key},delivery:{mode:'webhook',url:'https://callback.example/'+key,secret:'whsec_'+Buffer.alloc(32,7).toString('base64')},ttlMs:null});
  }
  expect(external(c,'one','same1').accepted).toBe(true);expect(external(c,'two','same2').reason).toBe('workspace_busy');
  expect(external(c,'three','different').accepted).toBe(true);
 });
});

it('a paused source can finish current work but cannot launch further downstream work',async()=>{
 const {c}=await setup();const r=external(c),s=claim(c,'supervisor',r.dispatchId!);c.setEnabled('supervisor',false);
 expect(c.dispatch({sourceTask:'supervisor',leaseToken:s,target:'worker',dedupKey:'late',reason:'work'}).reason).toBe('source_paused');
 expect(c.finish({task:'supervisor',leaseToken:s,outcome:'idle'}).state).toBe('idle');
 expect(external(c,'next').reason).toBe('paused');
});

it.each([410,413])('releases a queued workflow after an unambiguously rejected HTTP %s',async status=>{
 const {c,events}=await setup();const r=external(c);
 for(const row of events.db.all<import('../src/events.js').OutboxDelivery>('outbox'))if(row.eventId===r.eventId)events.db.put('outbox',row.key,{...row,state:'failed',status,attempts:1,ambiguousAttempts:0});
 c.synchronizeDeliveryOutcomes();expect(c.status('supervisor').workflows[0]!.state).toBe('idle');
 expect(c.claim({task:'supervisor',dispatchId:r.dispatchId!,runner:'late'}).claimed).toBe(false);
 expect(external(c,'after-fixed-callback').accepted).toBe(true);
});
it('keeps a fence for uncertain delivery and accepts a late authentic run claim',async()=>{
 const {c,events}=await setup();const r=external(c);
 for(const row of events.db.all<import('../src/events.js').OutboxDelivery>('outbox'))if(row.eventId===r.eventId)events.db.put('outbox',row.key,{...row,state:'failed',status:503,attempts:6,ambiguousAttempts:6});
 c.synchronizeDeliveryOutcomes();expect(c.status('supervisor').workflows[0]!.state).toBe('uncertain');expect(external(c,'another-tick').reason).toBe('uncertain');
 const token=claim(c,'supervisor',r.dispatchId!);c.finish({task:'supervisor',leaseToken:token,outcome:'idle'});expect(external(c,'after-real-finish').accepted).toBe(true);
});
it('a later definitive rejection does not erase an earlier ambiguous delivery',async()=>{
 const {c,events}=await setup();const r=external(c);
 for(const row of events.db.all<import('../src/events.js').OutboxDelivery>('outbox'))if(row.eventId===r.eventId)events.db.put('outbox',row.key,{...row,state:'failed',status:410,attempts:2,ambiguousAttempts:1});
 c.synchronizeDeliveryOutcomes();expect(c.status('supervisor').workflows[0]!.state).toBe('uncertain');
});

it('allows the same external tick key to retry after a definitive rejection was reconciled',async()=>{
 const {c,events}=await setup();const first=external(c,'same-clock-slot');
 for(const row of events.db.all<import('../src/events.js').OutboxDelivery>('outbox'))if(row.eventId===first.eventId)events.db.put('outbox',row.key,{...row,state:'failed',status:413,attempts:1,ambiguousAttempts:0});
 c.synchronizeDeliveryOutcomes();const second=external(c,'same-clock-slot');
 expect(second.accepted).toBe(true);expect(second.dispatchId).not.toBe(first.dispatchId);expect(second.rootId).toBe(first.rootId);
});
