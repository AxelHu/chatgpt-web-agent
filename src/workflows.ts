import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { EventRuntime } from './events.js';

export type Workflow = {
  key: string; topic: string; role: 'supervisor'|'worker'; workspace?: string;
  subscriptionId?: string; chatRef?: string;
  enabled: boolean; state: 'idle'|'queued'|'running'|'waiting'|'completed'|'needs_input'|'uncertain';
  waitingFor?: string;
  revision: number; checkpoint?: string; summary?: string; currentRun?: string;
  permissionProfile: 'personal-development'; updatedAt: number;
};
export type WorkflowRun = {
  id:string; eventId:string; task:string; rootId:string; sourceTask?:string; requestKey?:string;
  state:'queued'|'running'|'finished'|'cancelled'; requestedAt:number; startedAt?:number;
  lastHeartbeat?:number; leaseUntil?:number; leaseToken?:string; runner?:string;
  requestedRevision:number; finishedAt?:number; outcome?:string;
};
export type DispatchResult = { accepted:boolean; reason:string; dispatchId?:string; eventId?:string; rootId?:string; warnings?:string[] };
export type ProcessObservation = { status:'completed'|'failed'; exitCode?:number; exitSignal?:string; exitReason?:string; timedOut?:boolean; noOutputTimedOut?:boolean };
export type ProcessWait = {
  id:string; task:string; sessionId:string; state:'watching'|'terminal'|'dispatched'|'delivery_failed'|'cancelled';
  createdAt:number; nextCheckAt:number; failures:number; lastError?:string; lastObservedAt?:number;
  observation?:ProcessObservation; dispatchId?:string; eventId?:string; sourceRunId?:string;
};
const hash=(v:string)=>createHash('sha256').update(v).digest('hex');
function equal(a:string,b:string):boolean { const x=Buffer.from(a),y=Buffer.from(b); return x.length===y.length&&timingSafeEqual(x,y); }

/** Cooperation, not a filesystem sandbox. Local shell remains fully usable.
 * No command blacklist, no arbitrary cap on total cross-chat work. A new
 * external tick starts a new causal root. Checkpoint references are telemetry,
 * never a semantic proof of progress or an execution permission. */
export class WorkflowCoordinator {
  constructor(readonly events:EventRuntime,readonly owner='local-tunnel-user') {}
  private get now():number { return this.events.now().getTime(); }
  private task(key:string):Workflow { const t=this.events.db.get<Workflow>('workflows',key); if(!t) throw new Error('unknown_workflow'); return t; }
  private save(task:Workflow):void { task.updatedAt=this.now; this.events.db.put('workflows',task.key,task); }
  register(input:{key:string;topic:string;role:'supervisor'|'worker';workspace?:string;chatRef?:string}):Workflow {
    return this.events.db.atomic(()=>{
      const old=this.events.db.get<Workflow>('workflows',input.key);
      if(old&&(old.topic!==input.topic||old.role!==input.role||old.workspace!==(input.workspace?path.resolve(input.workspace):undefined))) throw new Error('workflow_identity_conflict');
      if(old) return old;
      const task:Workflow={...input,workspace:input.workspace?path.resolve(input.workspace):undefined,enabled:true,state:'idle',revision:0,permissionProfile:'personal-development',updatedAt:this.now};
      this.save(task); return task;
    });
  }
  bind(key:string,subscriptionId?:string,chatRef?:string):Workflow {
    return this.events.db.atomic(()=>{
      const task=this.task(key);
      const subs=this.events.activeSubscriptions(task.topic,this.owner).filter(s=>!subscriptionId||s.id===subscriptionId);
      if(subs.length!==1) throw new Error(subs.length?'ambiguous_subscription':'no_active_subscription');
      if(task.currentRun&&task.subscriptionId&&task.subscriptionId!==subs[0]!.id) throw new Error('cannot_rebind_active_workflow');
      task.subscriptionId=subs[0]!.id; if(chatRef) task.chatRef=chatRef; this.save(task); return task;
    });
  }
  setEnabled(key:string,enabled:boolean):Workflow {
    return this.events.db.atomic(()=>{
      this.synchronizeDeliveryOutcomes();
      const task=this.task(key);task.enabled=enabled;
      const wait=task.waitingFor?this.events.db.get<ProcessWait>('process_waits',task.waitingFor):undefined;
      if(enabled&&wait?.state==='delivery_failed'&&wait.observation) {
        // A definite rejection must not be retried forever with fresh IDs.
        // After repairing the cause, an authorized supervisor/operator can
        // resume this saved terminal receipt without running the job again.
        wait.state='terminal';wait.nextCheckAt=this.now;delete wait.lastError;
        this.events.db.put('process_waits',wait.id,wait);
      }
      this.save(task);return task;
    });
  }
  status(key?:string) {
    const workflows=(key?[this.task(key)]:this.events.db.all<Workflow>('workflows')).map(t=>{
      const r=t.currentRun?this.events.db.get<WorkflowRun>('runs',t.currentRun):undefined;
      return {...t,leaseStale:Boolean(r?.state==='running'&&(r.leaseUntil??0)<this.now)};
    });
    const runs=this.events.db.recent<WorkflowRun>('runs',40,key).map(({leaseToken,...r})=>r);
    return {workflows,runs,processWaits:this.events.db.recent<ProcessWait>('process_waits',40,key),counts:{totalRuns:this.events.db.count('runs'),totalDeliveries:this.events.db.count('outbox'),recentLimit:40},subscriptions:this.events.subscriptionSummaries(),outbox:this.events.outboxSummary()};
  }
  /** Observe terminal transport outcomes without treating a timeout as proof
   * that no Chat run started. Definitively rejected deliveries release a queue;
   * ambiguous failures keep its fence, and a late real claim remains valid. */
  synchronizeDeliveryOutcomes(): void {
    this.events.db.atomic(() => {
      for (const task of this.events.db.all<Workflow>('workflows')) {
        if (!task.currentRun || task.state !== 'queued') continue;
        const run = this.events.db.get<WorkflowRun>('runs', task.currentRun);
        if (!run || run.state !== 'queued') continue;
        const rows = this.events.outboxSummary(run.eventId);
        if (!rows.length || rows.some(d => d.state === 'accepted' || d.state === 'sending' || d.state === 'pending')) continue;
        if (rows.some(d => (d.ambiguousAttempts ?? 0) > 0)) {
          task.state = 'uncertain'; task.summary = 'Delivery outcome uncertain; check actual Chat state before retry.';
          this.save(task); continue;
        }
        run.state = 'cancelled'; run.outcome = 'delivery_rejected'; run.finishedAt = this.now;
        this.events.db.put('runs', run.id, run);
        this.events.db.remove('visits', hash(run.rootId+'\n'+task.key+'\n'+run.requestedRevision));
        if(run.requestKey) this.events.db.remove('requests',run.requestKey);
        delete task.currentRun; task.state = 'idle'; task.summary = 'Delivery rejected; no run claimed.';
        const wait=this.events.db.all<ProcessWait>('process_waits').find(w=>w.dispatchId===run.id&&w.state==='dispatched');
        if(wait) {
          wait.state='delivery_failed';wait.lastError='delivery_rejected:'+rows.map(r=>r.status??r.state).join(',');
          this.events.db.put('process_waits',wait.id,wait);
          task.state='waiting';task.waitingFor=wait.id;
          task.summary='Process ended, but its notification was rejected. Repair callback and resume to retry the saved receipt.';
        }
        this.save(task);
      }
    });
  }
  private actor(sourceTask:string,leaseToken:string):WorkflowRun {
    const task=this.task(sourceTask); const run=task.currentRun?this.events.db.get<WorkflowRun>('runs',task.currentRun):undefined;
    if(!run||run.state!=='running'||!run.leaseToken||!equal(run.leaseToken,leaseToken)) throw new Error('invalid_run_lease');
    if((run.leaseUntil??0)<this.now) throw new Error('stale_run_lease_requires_reconciliation');
    return run;
  }
  dispatch(input:{target:string;dedupKey:string;reason:string;sourceTask:string;leaseToken:string;summary?:string;stateRef?:string}):DispatchResult {
    return this.events.db.atomic(()=>{
      const source=this.actor(input.sourceTask,input.leaseToken);
      if(!this.task(input.sourceTask).enabled) return {accepted:false,reason:'source_paused'};
      if(input.target===input.sourceTask) return {accepted:false,reason:'direct_self_dispatch'};
      return this.enqueue({...input,rootId:source.rootId,sourceTask:source.task,actor:'run:'+source.id});
    });
  }
  /** Trusted local producer entry. Not exposed as an MCP tool: an event-driven
   * model cannot label itself an external timer to reset its causal lineage. */
  external(input:{target:string;producer:string;dedupKey:string;reason:string;summary?:string;stateRef?:string}):DispatchResult {
    return this.events.db.atomic(()=>this.enqueue({...input,actor:'external:'+input.producer,rootId:'root_'+hash(input.producer+'\n'+input.dedupKey).slice(0,32)}));
  }
  private enqueue(input:{target:string;dedupKey:string;reason:string;actor:string;rootId:string;sourceTask?:string;summary?:string;stateRef?:string}):DispatchResult {
    this.synchronizeDeliveryOutcomes();
    const db=this.events.db;
    const requestKey=hash(input.actor+'\n'+input.target+'\n'+input.dedupKey);
    const prior=db.get<DispatchResult>('requests',requestKey);
    if(prior) return {...prior,reason:'duplicate_request'};
    const task=this.task(input.target);
    if(!task.enabled) return {accepted:false,reason:'paused'};
    if(task.state==='completed'||task.state==='needs_input'||task.state==='uncertain') return {accepted:false,reason:task.state};
    if(task.currentRun||task.state==='queued'||task.state==='running') return {accepted:false,reason:'busy'};
    if(task.waitingFor||task.state==='waiting') return {accepted:false,reason:'waiting_process'};
    if(task.workspace&&db.all<Workflow>('workflows').some(t=>t.key!==task.key&&t.workspace===task.workspace&&(t.currentRun||t.waitingFor))) return {accepted:false,reason:'workspace_busy'};
    const subs=this.events.activeSubscriptions(task.topic,this.owner).filter(s=>!task.subscriptionId||s.id===task.subscriptionId);
    if(subs.length!==1) return {accepted:false,reason:subs.length?'ambiguous_subscription':'no_active_subscription'};
    task.subscriptionId=subs[0]!.id;
    const visitKey=hash(input.rootId+'\n'+task.key+'\n'+task.revision);
    // Unchanged/missing checkpoints do not establish lack of progress. In
    // particular a worker returning findings must be able to wake its reviewer.
    const sameCheckpointRevisit=Boolean(db.get('visits',visitKey));
    const id='run_'+randomUUID(),eventId='evt_'+randomUUID();
    const run:WorkflowRun={id,eventId,task:task.key,rootId:input.rootId,sourceTask:input.sourceTask,requestKey,state:'queued',requestedAt:this.now,requestedRevision:task.revision};
    const queued=this.events.enqueueContinue({topic:task.topic,trigger_reason:input.reason,summary:input.summary,state_ref:input.stateRef,
      source:input.sourceTask?'workflow':'external',source_task:input.sourceTask,target_task:task.key,root_id:input.rootId,dispatch_id:id,progress_version:task.revision},
      {eventId,subscriptionId:task.subscriptionId,owner:this.owner});
    if(queued.matched!==1) throw new Error('subscription_changed');
    task.currentRun=id; task.state='queued'; this.save(task); db.put('runs',id,run);
    const result:DispatchResult={accepted:true,reason:'queued',dispatchId:id,eventId,rootId:input.rootId,
      ...(sameCheckpointRevisit?{warnings:['same_root_checkpoint_unchanged_advisory']}: {})};
    db.put('visits',visitKey,{runId:id}); db.put('requests',requestKey,result); return result;
  }
  claim(input:{task:string;dispatchId:string;runner:string;leaseMs?:number}) {
    return this.events.db.atomic(()=>{
      const task=this.task(input.task); const run=this.events.db.get<WorkflowRun>('runs',input.dispatchId);
      if(!task.enabled) return {claimed:false,reason:'paused'};
      if(!run||run.task!==task.key||task.currentRun!==run.id) return {claimed:false,reason:'not_current_dispatch'};
      if(run.state!=='queued') return {claimed:false,reason:'already_claimed'};
      const leaseToken=randomUUID(); const leaseMs=this.leaseDuration(input.leaseMs);
      run.state='running'; run.runner=input.runner; run.leaseToken=leaseToken;
      run.startedAt=this.now; run.lastHeartbeat=this.now; run.leaseUntil=this.now+leaseMs;
      task.state='running'; this.save(task); this.events.db.put('runs',run.id,run);
      return {claimed:true,dispatchId:run.id,leaseToken,leaseUntil:run.leaseUntil,rootId:run.rootId};
    });
  }
  private leaseDuration(value?:number):number {
    const ms=value??2*3600_000;
    if(!Number.isSafeInteger(ms)||ms<60_000||ms>24*3600_000) throw new Error('invalid_lease_duration');
    return ms;
  }
  heartbeat(task:string,leaseToken:string,leaseMs?:number) {
    return this.events.db.atomic(()=>{
      const run=this.actor(task,leaseToken); run.lastHeartbeat=this.now; run.leaseUntil=this.now+this.leaseDuration(leaseMs);
      this.events.db.put('runs',run.id,run); return {leaseUntil:run.leaseUntil};
    });
  }
  finish(input:{task:string;leaseToken:string;outcome:'idle'|'completed'|'needs_input';checkpoint?:string;summary?:string}) {
    return this.events.db.atomic(()=>{
      const run=this.actor(input.task,input.leaseToken),task=this.task(input.task);
      run.state='finished'; run.outcome=input.outcome; run.finishedAt=this.now; delete run.leaseToken;
      if(input.checkpoint&&input.checkpoint!==task.checkpoint) { task.checkpoint=input.checkpoint; task.revision++; }
      task.summary=input.summary; task.state=input.outcome; delete task.currentRun;
      this.events.db.put('runs',run.id,run); this.save(task);
      // Completion only records state; it never emits another continuation.
      return {state:task.state,revision:task.revision};
    });
  }
  /** Explicitly hand the task to a real process. An ordinary idle chat can
   * register a wait without a run lease; a running worker must present its lease.
   * Waiting releases the model run, but retains the shared-workspace fence. */
  waitProcess(input:{task:string;sessionId:string;leaseToken?:string;checkpoint?:string;summary?:string}) {
    return this.events.db.atomic(()=>{
      if(!input.sessionId.trim()||input.sessionId.length>200) throw new Error('invalid_process_session');
      const id='wait_'+hash(input.task+'\n'+input.sessionId).slice(0,32);
      const existing=this.events.db.get<ProcessWait>('process_waits',id);
      if(existing) return {...existing,duplicate:true};
      let task=this.task(input.task);
      if(task.waitingFor) throw new Error('already_waiting_for_process');
      let sourceRunId:string|undefined;
      if(task.currentRun) {
        if(!input.leaseToken) throw new Error('run_lease_required');
        sourceRunId=this.actor(input.task,input.leaseToken).id;
        this.finish({task:input.task,leaseToken:input.leaseToken,outcome:'idle',checkpoint:input.checkpoint,summary:input.summary});
        task=this.task(input.task);
      } else if(input.leaseToken) throw new Error('invalid_run_lease');
      else if(task.state!=='idle') throw new Error('workflow_not_idle');
      if(task.workspace&&this.events.db.all<Workflow>('workflows').some(t=>t.key!==task.key&&t.workspace===task.workspace&&(t.currentRun||t.waitingFor))) throw new Error('workspace_busy');
      const wait:ProcessWait={id,task:input.task,sessionId:input.sessionId,state:'watching',createdAt:this.now,nextCheckAt:this.now,failures:0,sourceRunId};
      task.waitingFor=id;task.state='waiting';this.save(task);this.events.db.put('process_waits',id,wait);
      return {...wait,duplicate:false};
    });
  }
  recordProcessObservation(id:string,observation:ProcessObservation) {
    this.events.db.atomic(()=>{
      const wait=this.events.db.get<ProcessWait>('process_waits',id);
      if(!wait||wait.state!=='watching') return;
      wait.observation=observation;wait.state='terminal';wait.lastObservedAt=this.now;wait.nextCheckAt=this.now;delete wait.lastError;
      this.events.db.put('process_waits',id,wait);
    });
  }
  resumeProcessWait(id:string):DispatchResult {
    return this.events.db.atomic(()=>{
      const wait=this.events.db.get<ProcessWait>('process_waits',id);
      if(!wait||wait.state!=='terminal'||!wait.observation) return {accepted:false,reason:'process_not_terminal'};
      const task=this.task(wait.task);
      if(task.waitingFor!==id||task.state!=='waiting') return {accepted:false,reason:'wait_not_current'};
      // One SQLite transaction: neither lost resumes nor a second
      // worker can appear in the gap between releasing and replacing the fence.
      delete task.waitingFor;task.state='idle';this.save(task);
      const o=wait.observation;
      const reason=o.timedOut||o.noOutputTimedOut?'process.timed_out':o.exitSignal?'process.signalled':o.status==='failed'||(o.exitCode!==undefined&&o.exitCode!==0)?'process.failed':'process.completed';
      const result=this.external({target:task.key,producer:'process:'+wait.sessionId,dedupKey:wait.id,reason,
        summary:JSON.stringify({session_id:wait.sessionId,...o}),stateRef:'process:'+wait.sessionId});
      if(result.accepted) {wait.state='dispatched';wait.dispatchId=result.dispatchId;wait.eventId=result.eventId;delete wait.lastError;}
      else {task.waitingFor=id;task.state='waiting';this.save(task);wait.lastError=result.reason;wait.nextCheckAt=this.now+5000;}
      this.events.db.put('process_waits',id,wait);return result;
    });
  }
  cancelProcessWait(taskKey:string) {
    return this.events.db.atomic(()=>{
      const task=this.task(taskKey),wait=task.waitingFor?this.events.db.get<ProcessWait>('process_waits',task.waitingFor):undefined;
      if(!wait) return {cancelled:false,reason:'no_current_process_wait'};
      wait.state='cancelled';this.events.db.put('process_waits',wait.id,wait);
      // Cancelling the notification is not evidence that the process stopped.
      task.state='uncertain';task.summary='Process notification cancelled; verify the job before releasing its workspace.';this.save(task);
      return {cancelled:true,processStopped:false};
    });
  }
  reconcile(input:{task:string;observedIdle:boolean;evidence:string}) {
    if(!input.observedIdle||!input.evidence.trim()) throw new Error('idle_observation_required');
    return this.events.db.atomic(()=>{
      const task=this.task(input.task);
      if(task.currentRun) {
        const run=this.events.db.get<WorkflowRun>('runs',task.currentRun);
        if(run) {
          run.state='cancelled';run.outcome='reconciled_idle: '+input.evidence;delete run.leaseToken;this.events.db.put('runs',run.id,run);
          for(const delivery of this.events.db.all<import('./events.js').OutboxDelivery>('outbox')) {
            if(delivery.eventId===run.eventId && (delivery.state==='pending'||delivery.state==='sending')) this.events.db.put('outbox',delivery.key,{...delivery,state:'cancelled',error:'workflow_reconciled'});
          }
        }
      }
      if(task.waitingFor) {
        const wait=this.events.db.get<ProcessWait>('process_waits',task.waitingFor);
        if(wait&&wait.state!=='dispatched'){wait.state='cancelled';this.events.db.put('process_waits',wait.id,wait);}
        delete task.waitingFor;
      }
      task.state='idle'; delete task.currentRun; this.save(task); return task;
    });
  }
}
