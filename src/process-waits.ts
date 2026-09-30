import { randomUUID } from 'node:crypto';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { LocalToolBackend } from './backend/types.js';
import { WorkflowCoordinator, type ProcessObservation, type ProcessWait } from './workflows.js';

export type ProcessInspection={kind:'running'}|{kind:'terminal';observation:ProcessObservation}|{kind:'unknown';reason:string};
/** Never infer success from silence, wall time, disappearance, or a text log. */
export function inspectProcessResult(result:CallToolResult,sessionId:string):ProcessInspection {
  if(result.isError) return {kind:'unknown',reason:'process_read_error'};
  const d=result.structuredContent as Record<string,unknown>|undefined;
  if(!d||d.sessionId!==sessionId) return {kind:'unknown',reason:'process_identity_unconfirmed'};
  if(d.status==='running') return {kind:'running'};
  if(d.status!=='completed'&&d.status!=='failed') return {kind:'unknown',reason:'process_status_unconfirmed'};
  const exitCode=typeof d.exitCode==='number'&&Number.isSafeInteger(d.exitCode)?d.exitCode:undefined;
  const exitSignal=typeof d.exitSignal==='string'&&d.exitSignal?d.exitSignal:undefined;
  const exitReason=typeof d.exitReason==='string'&&d.exitReason?d.exitReason:undefined;
  if(exitCode===undefined&&!exitSignal&&!exitReason&&d.timedOut!==true&&d.noOutputTimedOut!==true)
    return {kind:'unknown',reason:'terminal_receipt_incomplete'};
  return {kind:'terminal',observation:{status:d.status,exitCode,exitSignal,exitReason,
    timedOut:d.timedOut===true,noOutputTimedOut:d.noOutputTimedOut===true}};
}

/** Runs in the MCP service, not in a model turn. log (not poll) preserves the
 * caller's unread-log cursor. The durable outbox handles webhook retries. */
export class ProcessWaitDriver {
  constructor(readonly coordinator:WorkflowCoordinator,readonly backend:LocalToolBackend) {}
  private async inspect(sessionId:string):Promise<ProcessInspection> {
    try {
      const result=await this.backend.callTool('process',{action:'log',sessionId,offset:0,limit:0},{callId:'process-watch-'+randomUUID()});
      return inspectProcessResult(result,sessionId);
    } catch { return {kind:'unknown',reason:'process_runtime_unavailable'}; }
  }
  async register(input:{task:string;sessionId:string;leaseToken?:string;checkpoint?:string;summary?:string}) {
    const inspection=await this.inspect(input.sessionId);
    if(inspection.kind==='unknown') throw new Error(inspection.reason);
    const wait=this.coordinator.waitProcess(input);
    if(inspection.kind==='terminal') this.coordinator.recordProcessObservation(wait.id,inspection.observation);
    return {...wait,observedState:inspection.kind,notificationOnly:true};
  }
  async tick():Promise<void> {
    const {events}=this.coordinator,now=events.now().getTime();
    const due=events.db.all<ProcessWait>('process_waits')
      .filter(w=>(w.state==='watching'||w.state==='terminal')&&w.nextCheckAt<=now)
      .sort((a,b)=>a.nextCheckAt-b.nextCheckAt).slice(0,16);
    for(const snapshot of due) {
      if(snapshot.state==='watching') {
        const inspection=await this.inspect(snapshot.sessionId);
        // Read-only observations may overlap across service/CLI instances;
        // all mutation/dispatch transitions are fenced in SQLite transactions.
        if(inspection.kind==='terminal') this.coordinator.recordProcessObservation(snapshot.id,inspection.observation);
        else events.db.atomic(()=>{
          const current=events.db.get<ProcessWait>('process_waits',snapshot.id);
          if(!current||current.state!=='watching') return;
          current.lastObservedAt=events.now().getTime();
          if(inspection.kind==='unknown') {current.failures++;current.lastError=inspection.reason;}
          else {current.failures=0;delete current.lastError;}
          current.nextCheckAt=events.now().getTime()+(inspection.kind==='unknown'?Math.min(60000,2000*2**Math.min(current.failures,5)):2000);
          events.db.put('process_waits',current.id,current);
        });
      }
      const current=events.db.get<ProcessWait>('process_waits',snapshot.id);
      if(current?.state==='terminal') this.coordinator.resumeProcessWait(current.id);
    }
  }
}
