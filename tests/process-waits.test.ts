import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach,describe,expect,it } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { LocalToolBackend } from '../src/backend/types.js';
import { EventRuntime } from '../src/events.js';
import { WorkflowCoordinator,type ProcessWait } from '../src/workflows.js';
import { ProcessWaitDriver,inspectProcessResult } from '../src/process-waits.js';
import { WorkflowBackend } from '../src/backend/workflows.js';

const cleanup:Array<()=>void>=[];
afterEach(()=>{for(const f of cleanup.splice(0))f();});
async function fixture() {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'process-waits-'));let now=Date.now(),deliveryStatus=200;
 const options={storePath:path.join(dir,'events.sqlite'),now:()=>new Date(now),validateCallback:async()=>{},
  sender:async(_s:unknown,body:string)=>{const p=JSON.parse(body),status=p.type==='verification'?200:deliveryStatus;return {ok:status<300,status,body:JSON.stringify(p.type==='verification'?{challenge:p.challenge}:{})};}};
 const events=new EventRuntime(options);const instances=[events];cleanup.push(()=>{instances.forEach(e=>e.close());fs.rmSync(dir,{recursive:true,force:true});});
 const c=new WorkflowCoordinator(events);
 c.register({key:'worker',topic:'process-test:worker',role:'worker',workspace:path.join(dir,'repo')});
 await events.subscribe('local-tunnel-user',{name:'workflow.continue',arguments:{topic:'process-test:worker'},delivery:{mode:'webhook',url:'https://callback.example/worker',secret:'whsec_'+Buffer.alloc(32,4).toString('base64')},ttlMs:null});
 c.bind('worker');
 let result:CallToolResult={content:[],structuredContent:{sessionId:'session-1',status:'running'}};
 const calls:Array<{name:string;args:Record<string,unknown>}>=[];
 const backend:LocalToolBackend={id:'process-fixture',listTools:async()=>[],callTool:async(name,args)=>{calls.push({name,args});return result;}};
 const driver=new ProcessWaitDriver(c,backend);
 const set=(d:Record<string,unknown>)=>{result={content:[{type:'text',text:'DO-NOT-SEND-RAW-LOG'}],structuredContent:{sessionId:'session-1',...d}};};
 const restart=()=>{const e=new EventRuntime(options);instances.push(e);const coordinator=new WorkflowCoordinator(e);return {events:e,c:coordinator,driver:new ProcessWaitDriver(coordinator,backend)};};
 return {c,events,driver,backend,calls,set,setDeliveryStatus:(status:number)=>{deliveryStatus=status;},setError:()=>{result={isError:true,content:[{type:'text',text:'missing or unavailable'}]};},advance:()=>{now+=65000;},restart};
}
async function arm(f:Awaited<ReturnType<typeof fixture>>) {return f.driver.register({task:'worker',sessionId:'session-1'});}
describe('durable process-completion continuation',()=>{
 it('records a non-polling wait, retains the workspace fence and sends nothing while running',async()=>{
  const f=await fixture();await arm(f);await f.driver.tick();
  expect(f.c.status('worker').workflows[0]?.state).toBe('waiting');expect(f.events.db.count('outbox')).toBe(0);
  expect(f.c.external({target:'worker',producer:'clock',dedupKey:'1',reason:'tick'}).reason).toBe('waiting_process');
  expect(f.calls.every(c=>c.name==='process'&&c.args.action==='log'&&c.args.limit===0)).toBe(true);
 });
 it.each([
  [{status:'completed',exitCode:0},'process.completed'],
  [{status:'failed',exitCode:7},'process.failed'],
  [{status:'completed',exitCode:7},'process.failed'],
  [{status:'failed',exitSignal:'SIGTERM',exitReason:'signal'},'process.signalled'],
  [{status:'failed',exitReason:'overall-timeout',timedOut:true},'process.timed_out'],
  [{status:'completed',exitReason:'no-output-timeout',noOutputTimedOut:true},'process.timed_out'],
 ] as const)('emits once from a real terminal receipt: %j',async(d,reason)=>{
  const f=await fixture();await arm(f);f.set(d);await f.driver.tick();await f.driver.tick();
  expect(f.c.status('worker').workflows[0]?.state).toBe('queued');
  const deliveries=f.events.db.all<{body:string}>('outbox');expect(deliveries).toHaveLength(1);
  const event=JSON.parse(deliveries[0]!.body);expect(event.data.trigger_reason).toBe(reason);expect(event.data.state_ref).toBe('process:session-1');
  expect(deliveries[0]!.body).not.toContain('DO-NOT-SEND-RAW-LOG');
  const run=f.c.status('worker').runs[0]!;const claim=f.c.claim({task:'worker',dispatchId:run.id,runner:'resumed'});expect(claim.claimed).toBe(true);
  f.c.finish({task:'worker',leaseToken:claim.leaseToken!,outcome:'completed'});
  await f.driver.tick();expect(f.events.db.count('outbox')).toBe(1);
 });
 it('handles an already-finished silent process without missing the completion race',async()=>{
  const f=await fixture();f.set({status:'completed',exitCode:0});const w=await arm(f);expect(w.observedState).toBe('terminal');
  await f.driver.tick();expect(f.events.db.count('outbox')).toBe(1);
 });
 it('turns an active leased run into a waiting task and invalidates its old execution lease',async()=>{
  const f=await fixture();const r=f.c.external({target:'worker',producer:'clock',dedupKey:'start',reason:'start'});
  const claim=f.c.claim({task:'worker',dispatchId:r.dispatchId!,runner:'worker-chat'});
  await f.driver.register({task:'worker',sessionId:'session-1',leaseToken:claim.leaseToken!,checkpoint:'report-ref'});
  expect(f.c.status('worker').workflows[0]).toMatchObject({state:'waiting',checkpoint:'report-ref'});
  expect(()=>f.c.heartbeat('worker',claim.leaseToken!)).toThrow('invalid_run_lease');
  f.set({status:'completed',exitCode:0});await f.driver.tick();expect(f.events.db.count('outbox')).toBe(2);
 });
 it('refuses to take a running task away from its owner without a lease',async()=>{
  const f=await fixture();const r=f.c.external({target:'worker',producer:'clock',dedupKey:'start',reason:'start'});
  f.c.claim({task:'worker',dispatchId:r.dispatchId!,runner:'active'});
  await expect(arm(f)).rejects.toThrow('run_lease_required');expect(f.events.db.count('process_waits')).toBe(0);
 });
 it('does not treat disappearance or a runtime read failure as completion',async()=>{
  const f=await fixture();await arm(f);f.setError();await f.driver.tick();
  expect(f.events.db.count('outbox')).toBe(0);expect(f.c.status('worker').processWaits[0]?.lastError).toBe('process_read_error');
  expect(f.c.status('worker').workflows[0]?.state).toBe('waiting');
  f.advance();f.set({status:'completed',exitCode:0});await f.driver.tick();expect(f.events.db.count('outbox')).toBe(1);
 });
 it('does not accept a text-only or incomplete success claim',()=>{
  expect(inspectProcessResult({content:[{type:'text',text:'completed'}]},'s').kind).toBe('unknown');
  expect(inspectProcessResult({content:[],structuredContent:{status:'completed',sessionId:'s'}},'s').kind).toBe('unknown');
  expect(inspectProcessResult({content:[],structuredContent:{status:'completed',sessionId:'other',exitCode:0}},'s').kind).toBe('unknown');
 });
 it('recovers persisted waits after restart and deduplicates competing completion observers',async()=>{
  const f=await fixture();await arm(f);const g=f.restart();f.set({status:'completed',exitCode:0});
  await Promise.all([f.driver.tick(),g.driver.tick()]);expect(f.events.db.count('outbox')).toBe(1);
  expect(g.c.status('worker').processWaits[0]?.state).toBe('dispatched');
 });
 it('treats repeated registration as one logical process completion',async()=>{
  const f=await fixture();const a=await arm(f),b=await arm(f);expect(b.id).toBe(a.id);expect(b.duplicate).toBe(true);
  f.set({status:'completed',exitCode:0});await f.driver.tick();await arm(f);await f.driver.tick();expect(f.events.db.count('outbox')).toBe(1);
 });
 it('retains a terminal receipt while paused and queues only after resumption',async()=>{
  const f=await fixture();await arm(f);f.c.setEnabled('worker',false);f.set({status:'completed',exitCode:0});await f.driver.tick();
  expect(f.events.db.count('outbox')).toBe(0);expect(f.c.status('worker').processWaits[0]).toMatchObject({state:'terminal',lastError:'paused'});
  f.c.setEnabled('worker',true);f.advance();await f.driver.tick();expect(f.events.db.count('outbox')).toBe(1);
 });
 it('retains completion when the subscription temporarily disappears',async()=>{
  const f=await fixture();await arm(f);const sub=f.events.activeSubscriptions('process-test:worker')[0]!;
  f.events.db.put('subscriptions',sub.id,{...sub,disabled:true});f.set({status:'completed',exitCode:0});await f.driver.tick();
  expect(f.c.status('worker').processWaits[0]?.lastError).toBe('no_active_subscription');expect(f.events.db.count('outbox')).toBe(0);
  f.events.db.put('subscriptions',sub.id,sub);f.advance();await f.driver.tick();expect(f.events.db.count('outbox')).toBe(1);
 });
 it('cancels only the notification and keeps uncertainty until real job reconciliation',async()=>{
  const f=await fixture();await arm(f);expect(f.c.cancelProcessWait('worker')).toMatchObject({cancelled:true,processStopped:false});
  f.set({status:'completed',exitCode:0});await f.driver.tick();expect(f.events.db.count('outbox')).toBe(0);
  expect(f.c.status('worker').workflows[0]?.state).toBe('uncertain');
  f.c.reconcile({task:'worker',observedIdle:true,evidence:'terminal job receipt inspected'});
  expect(f.c.status('worker').workflows[0]?.waitingFor).toBeUndefined();
  expect(f.calls.every(c=>c.args.action==='log')).toBe(true);
 });
 it('keeps same-worktree tasks fenced while the model is no longer running',async()=>{
  const f=await fixture();const ws=f.c.status('worker').workflows[0]!.workspace;await arm(f);
  f.c.register({key:'sibling',topic:'process-test:sibling',role:'worker',workspace:ws});
  expect(f.c.external({target:'sibling',producer:'clock',dedupKey:'s',reason:'start'}).reason).toBe('workspace_busy');
 });
 it('exposes idle-chat watch and leased wait through existing workflow tools',async()=>{
  const f=await fixture();const tools=new WorkflowBackend(f.c,f.driver);
  const r=await tools.callTool('workflow_manage',{action:'watch_process',key:'worker',session_id:'session-1'});expect(r.isError).not.toBe(true);
  expect(f.c.status('worker').workflows[0]?.state).toBe('waiting');
 });
});

it('accepts leased wait_process through the tool adapter and exposes truthful write hints',async()=>{
 const f=await fixture(),tools=new WorkflowBackend(f.c,f.driver);
 const r=f.c.external({target:'worker',producer:'clock',dedupKey:'leased-start',reason:'start'});
 const lease=f.c.claim({task:'worker',dispatchId:r.dispatchId!,runner:'active-worker'}).leaseToken!;
 const response=await tools.callTool('workflow_run',{action:'wait_process',task:'worker',lease_token:lease,session_id:'session-1'});
 expect(response.isError).not.toBe(true);expect(f.c.status('worker').workflows[0]?.state).toBe('waiting');
 const hints=await tools.listTools();
 for(const name of ['workflow_manage','workflow_run']) expect(hints.find(t=>t.name===name)?.annotations).toMatchObject({readOnlyHint:false,openWorldHint:true});
 f.set({status:'completed',exitCode:0});await f.driver.tick();expect(f.events.db.count('outbox')).toBe(2);
});

 it.each([400,413])('preserves a terminal receipt after HTTP %s rejection and rearms only after repair/resume',async status=>{
  const f=await fixture();await arm(f);f.set({status:'completed',exitCode:0});await f.driver.tick();
  f.setDeliveryStatus(status);await f.events.flush();f.c.synchronizeDeliveryOutcomes();
  expect(f.c.status('worker').processWaits[0]).toMatchObject({state:'delivery_failed',observation:{exitCode:0}});
  expect(f.c.status('worker').workflows[0]?.state).toBe('waiting');
  for(let i=0;i<3;i++){f.advance();await f.driver.tick();}expect(f.events.db.count('outbox')).toBe(1);
  f.setDeliveryStatus(200);f.c.setEnabled('worker',true);await f.driver.tick();await f.events.flush();
  expect(f.events.db.count('outbox')).toBe(2);expect(f.c.status('worker').processWaits[0]?.state).toBe('dispatched');
  const next=f.c.status('worker').runs[0]!;expect(next.state).toBe('queued');
  expect(f.c.claim({task:'worker',dispatchId:next.id,runner:'repaired-callback'}).claimed).toBe(true);
 });
 it('does not rearm a possibly delivered process event after an ambiguous transport failure',async()=>{
  const f=await fixture();await arm(f);f.set({status:'completed',exitCode:0});await f.driver.tick();
  for(const row of f.events.db.all<import('../src/events.js').OutboxDelivery>('outbox'))f.events.db.put('outbox',row.key,{...row,state:'failed',status:503,attempts:6,ambiguousAttempts:1});
  f.c.synchronizeDeliveryOutcomes();f.c.setEnabled('worker',true);f.advance();await f.driver.tick();
  expect(f.c.status('worker').workflows[0]?.state).toBe('uncertain');expect(f.events.db.count('outbox')).toBe(1);
 });
