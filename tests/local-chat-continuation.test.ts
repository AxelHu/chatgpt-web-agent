import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalChatContinuation, inspectLocalChat, type JsonObject, type LocalChatBridge,
  type LocalChatRoute } from '../src/local-chat-continuation.js';
import { submissionFromJournal } from '../src/local-chat-adapter.js';

const THREAD = '00000000-0000-4000-8000-000000000001';
const route: LocalChatRoute = { key: 'test', topic: 'local:test', threadId: THREAD,
  model: 'gpt-6-pro', thinking: 'standard', prompt: 'Read the authorized checkpoint and continue.',
  enabled: true, stateRoot: '/tmp/probe' };
const event = { id: 'one', route: 'test', topic: 'local:test', source: 'process.completed', stateRef: '/tmp/probe/state.txt' };
function idle(): JsonObject {
  return { conversation: { id: THREAD, conversation_origin: null, current_node: 'final', is_archived: false },
    messages: [{ id: 'final', role: 'assistant', status: 'finished_successfully', content_type: 'text', recipient: 'all' }],
    live_status: { type: 'idle' } };
}
const cleanup: Array<()=>void> = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });
function fixture(routes: LocalChatRoute[] = [route]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-chat-'));
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  let time = 1_000_000;
  const calls: Array<{ thread: string; prompt: string; model: string; thinking: string; requestId: string }> = [];
  let getCalls = 0, ackCalls = 0;
  const bridge: LocalChatBridge = {
    async get() { getCalls++; return idle(); },
    async send(thread, prompt, model, thinking, requestId) {
      calls.push({ thread, prompt, model, thinking, requestId });
      return { thread_id: thread, message_id: 'message-one', operation_outcome: 'committed', requested_model: model, requested_thinking: thinking };
    },
    markResponseDelivered() { ackCalls++; },
  };
  const open = (rs = routes) => {
    const d = new LocalChatContinuation(path.join(dir, 'state.sqlite'), rs, async()=>bridge, ()=>time);
    cleanup.push(() => { try { d.close(); } catch {} });
    return d;
  };
  return { dir, bridge, calls, open, driver: open(), advance: (ms: number)=>time+=ms,
    counters: ()=>({ getCalls, ackCalls }) };
}

describe('local event to existing ordinary Chat without a relay model', () => {
  it('stores then dispatches exactly the configured target/model/effort and fixed prompt', async()=>{
    const f=fixture(), d=f.driver, queued=d.enqueue(event);
    expect(queued.delivery.state).toBe('pending'); expect(f.calls).toHaveLength(0);
    const result=await d.dispatch(queued.delivery.key);
    expect(result.state).toBe('submitted'); expect(result.attempts).toBe(1);
    expect(f.calls).toMatchObject([{thread:THREAD,model:'gpt-6-pro',thinking:'standard'}]);
    expect(f.calls[0]!.prompt).toContain('LOCAL_EVENT_KEY='+result.key);
    expect(f.calls[0]!.prompt.startsWith(route.prompt)).toBe(true);
    expect(f.counters().ackCalls).toBe(1);
  });
  it('deduplicates across restart and never reads/sends a completed delivery again',async()=>{
    const f=fixture(), first=f.driver.enqueue(event);
    await f.driver.dispatch(first.delivery.key);f.driver.close();
    const d=f.open();expect(d.enqueue(event).duplicate).toBe(true);
    expect((await d.dispatch(first.delivery.key)).state).toBe('submitted');
    expect(f.calls).toHaveLength(1);expect(f.counters().getCalls).toBe(1);
  });
  it('rejects same-ID different data instead of silently changing instructions',()=>{
    const f=fixture();f.driver.enqueue(event);
    expect(()=>f.driver.enqueue({...event,reason:'changed'})).toThrow('event_id_payload_conflict');
  });
  it.each(['model','thinking','prompt','threadId','command'])('does not accept %s in event data',field=>{
    expect(()=>fixture().driver.enqueue({...event,[field]:'override'})).toThrow();
  });
  it('rejects unknown/disabled route, wrong topic, traversal and conflicting route names',()=>{
    const f=fixture();
    expect(()=>f.driver.enqueue({...event,route:'other'})).toThrow('route_not_enabled');
    expect(()=>f.driver.enqueue({...event,topic:'wrong'})).toThrow('topic_mismatch');
    expect(()=>f.driver.enqueue({...event,stateRef:'/tmp/probe/../elsewhere'})).toThrow('state_ref_outside_route');
    expect(()=>f.driver.enqueue({...event,stateRef:'relative'})).toThrow('state_ref_outside_route');
    expect(()=>f.open([route,route])).toThrow('duplicate_route_key');
    expect(()=>f.open([{...route,enabled:false}]).enqueue(event)).toThrow('route_not_enabled');
  });
  it('keeps a busy event pending, then submits it after a new explicit idle check',async()=>{
    const f=fixture(), q=f.driver.enqueue(event).delivery;
    f.bridge.get=async()=>({...idle(),live_status:{type:'active'}});
    expect(await f.driver.dispatch(q.key)).toMatchObject({state:'pending',reason:'target_busy',attempts:0});
    expect(f.calls).toHaveLength(0);
    f.bridge.get=async()=>idle();expect((await f.driver.dispatch(q.key)).state).toBe('submitted');
    expect(f.calls).toHaveLength(1);
  });
  it.each([
    ['unknown status',()=>({...idle(),live_status:{type:'unknown'}}),'target_status_unknown'],
    ['wrong target',()=>({...idle(),conversation:{id:'wrong',conversation_origin:null}}),'target_identity_unverified'],
    ['Work',()=>({...idle(),conversation:{id:THREAD,conversation_origin:'tpp'}}),'target_not_confirmed_ordinary_chat'],
    ['missing origin',()=>({...idle(),conversation:{id:THREAD}}),'target_not_confirmed_ordinary_chat'],
    ['archived',()=>({...idle(),conversation:{id:THREAD,conversation_origin:null,is_archived:true}}),'target_archived'],
    ['unresolved tail',()=>({...idle(),messages:[]}), 'target_tail_unresolved'],
  ] as const)('does not submit on %s',async(_label,get,reason)=>{
    const f=fixture(), q=f.driver.enqueue(event).delivery;f.bridge.get=async()=>get();
    expect(await f.driver.dispatch(q.key)).toMatchObject({state:'pending',reason,attempts:0});expect(f.calls).toHaveLength(0);
  });
  it('keeps read failures pending with a cooldown and never starts a send',async()=>{
    const f=fixture(), q=f.driver.enqueue(event).delivery;f.bridge.get=async()=>{throw new Error('transport down');};
    expect(await f.driver.dispatch(q.key)).toMatchObject({state:'pending',reason:'preflight_unavailable',attempts:0});
    f.bridge.get=async()=>idle();expect((await f.driver.dispatch(q.key)).state).toBe('pending');
    f.advance(30_001);expect((await f.driver.dispatch(q.key)).state).toBe('submitted');
  });
  it('honors route pause or configuration changes for already queued events',async()=>{
    const f=fixture(), q=f.driver.enqueue(event).delivery;
    const paused=f.open([{...route,enabled:false}]);expect((await paused.dispatch(q.key)).reason).toBe('route_paused');
    const changed=f.open([{...route,model:'gpt-6-sol'}]);expect((await changed.dispatch(q.key)).reason).toBe('route_changed');
    expect(f.calls).toHaveLength(0);
  });
  it('uses an atomic target lock across two independent dispatcher instances/routes',async()=>{
    const f=fixture([route,{...route,key:'second'}]);let release!:()=>void;
    const barrier=new Promise<void>(resolve=>release=resolve);
    f.bridge.get=async()=>{await barrier;return idle();};
    const a=f.driver.enqueue(event).delivery, other=f.open();
    const b=other.enqueue({...event,id:'two',route:'second'}).delivery;
    const first=f.driver.dispatch(a.key);await Promise.resolve();
    expect(await other.dispatch(b.key)).toMatchObject({state:'pending',reason:'target_locked'});
    expect(await other.dispatch(a.key)).toMatchObject({state:'checking',reason:'target_locked'});
    release();await first;expect(f.calls).toHaveLength(1);
    f.bridge.get=async()=>({...idle(),live_status:{type:'active'}});
    expect((await other.dispatch(b.key)).reason).toBe('target_busy');expect(f.calls).toHaveLength(1);
  });
  it('requires explicit not_started proof for a bounded six-attempt retry',async()=>{
    const f=fixture(), q=f.driver.enqueue(event).delivery;let sends=0;
    f.bridge.send=async()=>{sends++;return {operation_outcome:'not_started',safe_to_resubmit:true,thread_id:THREAD,message_id:'stable'};};
    for(let i=0;i<6;i++){await f.driver.dispatch(q.key);f.advance(60_001);}
    expect(await f.driver.dispatch(q.key)).toMatchObject({state:'held',attempts:6,reason:'not_started_retry_budget_exhausted'});
    expect(sends).toBe(6);
  });
  it('holds ambiguous submissions across restart and blocks competing events on that target',async()=>{
    const f=fixture(), q=f.driver.enqueue(event).delivery;let sends=0;
    f.bridge.send=async()=>{sends++;return {operation_outcome:'started_unknown_result',safe_to_resubmit:false,message_id:'possible',thread_id:THREAD};};
    expect((await f.driver.dispatch(q.key)).state).toBe('held');f.driver.close();f.advance(999_999);
    const d=f.open();await d.dispatch(q.key);expect(sends).toBe(1);
    const next=d.enqueue({...event,id:'next'}).delivery;expect((await d.dispatch(next.key)).reason).toBe('target_locked');
    expect((await d.recover(q.key)).state).toBe('held');expect(sends).toBe(1);
    f.bridge.get=async()=>({...idle(),messages:[{id:'possible',role:'user',text:d.prompt(q)}]});
    expect((await d.recover(q.key)).reason).toBe('exact_message_recovered');expect(sends).toBe(1);
  });
  it('does not use prompt similarity or another target to recover unknown sends',async()=>{
    const f=fixture(), q=f.driver.enqueue(event).delivery;
    f.bridge.send=async()=>({operation_outcome:'started_unknown_result',message_id:'exact'});
    await f.driver.dispatch(q.key);
    f.bridge.get=async()=>({...idle(),messages:[{id:'other',role:'user',text:f.driver.prompt(q)}]});
    expect((await f.driver.recover(q.key)).state).toBe('held');
    f.bridge.get=async()=>({...idle(),conversation:{id:'wrong'},messages:[{id:'exact',role:'user',text:f.driver.prompt(q)}]});
    await expect(f.driver.recover(q.key)).rejects.toThrow('recovery_target_mismatch');
  });
  it('recovers the receipt-lost crash window from exact read-only journal evidence',async()=>{
    const f=fixture(), q=f.driver.enqueue(event).delivery;
    await f.driver.dispatch(q.key);
    const lost=f.driver.get(q.key);lost.state='sending';delete lost.receipt;
    f.driver.db.prepare('UPDATE local_deliveries SET body=?,state=? WHERE key=?').run(JSON.stringify(lost),'sending',q.key);
    f.driver.db.prepare("UPDATE local_targets SET phase='sending'").run();
    f.bridge.submissionEvidence=async(thread,prompt,model,thinking,requestId)=>{
      expect([thread,prompt,model,thinking,requestId]).toEqual([THREAD,f.driver.prompt(q),route.model,route.thinking,q.requestId]);
      return {thread_id:THREAD,message_id:'message-one',operation_outcome:'committed'};
    };
    f.bridge.get=async()=>({...idle(),messages:[{id:'message-one',role:'user',text:f.driver.prompt(q)}]});
    expect(await f.open().recover(q.key)).toMatchObject({state:'submitted',reason:'exact_message_recovered'});
    expect(f.calls).toHaveLength(1);
  });
  it('rejects symlink escapes including missing trailing children and dangling links',()=>{
    const f=fixture(), allowed=path.join(f.dir,'allowed'), outside=path.join(f.dir,'outside');
    fs.mkdirSync(allowed);fs.mkdirSync(outside);fs.symlinkSync(outside,path.join(allowed,'link'));
    const d=f.open([{...route,stateRoot:allowed}]);
    expect(()=>d.enqueue({...event,stateRef:path.join(allowed,'link','not-created','state')})).toThrow('state_ref_outside_route');
    fs.symlinkSync(path.join(f.dir,'nonexistent'),path.join(allowed,'dangling'));
    expect(()=>d.enqueue({...event,stateRef:path.join(allowed,'dangling','state')})).toThrow('unresolvable_state_symlink');
  });
  it('rechecks reference containment before sending an already queued event',async()=>{
    const f=fixture(), allowed=path.join(f.dir,'allowed'), outside=path.join(f.dir,'outside');
    fs.mkdirSync(allowed);fs.mkdirSync(outside);fs.mkdirSync(path.join(allowed,'state'));
    const d=f.open([{...route,stateRoot:allowed}]);
    const q=d.enqueue({...event,stateRef:path.join(allowed,'state','file.txt')}).delivery;
    fs.rmdirSync(path.join(allowed,'state'));fs.symlinkSync(outside,path.join(allowed,'state'));
    expect((await d.dispatch(q.key)).reason).toBe('state_ref_changed');expect(f.calls).toHaveLength(0);
  });
  it('never automatically resends after an exception at the send boundary',async()=>{
    const f=fixture(), q=f.driver.enqueue(event).delivery;let calls=0;
    f.bridge.send=async()=>{calls++;throw new Error('receipt lost');};
    await f.driver.dispatch(q.key);await f.driver.recover(q.key);f.advance(1000_000);await f.driver.dispatch(q.key);
    expect(calls).toBe(1);expect(f.driver.get(q.key).state).toBe('held');
  });
  it('does not duplicate if bridge response acknowledgement fails after durable save',async()=>{
    const f=fixture(), q=f.driver.enqueue(event).delivery;f.bridge.markResponseDelivered=()=>{throw new Error('journal unavailable');};
    await f.driver.dispatch(q.key);await f.open().dispatch(q.key);expect(f.calls).toHaveLength(1);
  });
  it('rejects wrong-thread committed receipts instead of releasing the target',async()=>{
    const f=fixture(), q=f.driver.enqueue(event).delivery;
    f.bridge.send=async()=>({operation_outcome:'committed',message_id:'one',thread_id:'wrong'});
    expect((await f.driver.dispatch(q.key)).state).toBe('held');
  });
  it('recovers only expired pre-send locks, not unknown in-flight side effects',async()=>{
    const f=fixture(), q=f.driver.enqueue(event).delivery;
    f.driver.db.prepare('INSERT INTO local_targets VALUES (?,?,?,?,?)').run(THREAD,q.key,'old','checking',0);
    expect((await f.driver.dispatch(q.key)).state).toBe('submitted');
    const next=f.driver.enqueue({...event,id:'next'}).delivery;
    f.driver.db.prepare('DELETE FROM local_targets WHERE thread_id=?').run(THREAD);
    f.driver.db.prepare('INSERT INTO local_targets VALUES (?,?,?,?,?)').run(THREAD,next.key,'old','sending',0);
    f.advance(9_999_999);expect((await f.driver.dispatch(next.key)).reason).toBe('target_locked');expect(f.calls).toHaveLength(1);
  });
  it('does not treat stale idle state as completion of a just-submitted turn',async()=>{
    const f=fixture(), a=f.driver.enqueue(event).delivery;
    await f.driver.dispatch(a.key);
    const b=f.driver.enqueue({...event,id:'two'}).delivery;
    expect((await f.driver.dispatch(b.key)).reason).toBe('submitted_turn_not_observed_complete');
    expect(f.calls).toHaveLength(1);
    f.bridge.get=async()=>({...idle(),messages:[{id:'message-one',role:'user'},
      {id:'final',role:'assistant',status:'finished_successfully',content_type:'text',recipient:'all'}]});
    expect((await f.driver.dispatch(b.key)).state).toBe('submitted');expect(f.calls).toHaveLength(2);
  });
  it('settles a committed delivery only after its own message and final result are observed',async()=>{
    const f=fixture(), q=f.driver.enqueue(event).delivery;
    await f.driver.dispatch(q.key);
    expect((await f.driver.settle(q.key)).observation).toBe('submitted_turn_not_observed_complete');
    expect(f.driver.db.prepare('SELECT COUNT(*) AS n FROM local_targets').get()?.n).toBe(1);
    f.bridge.get=async()=>({...idle(),messages:[{id:'message-one',role:'user'},
      {id:'final',role:'assistant',status:'finished_successfully',content_type:'text',recipient:'all'}]});
    expect((await f.driver.settle(q.key)).observation).toBe('submitted_turn_observed_complete');
    expect(f.driver.db.prepare('SELECT COUNT(*) AS n FROM local_targets').get()?.n).toBe(0);
    expect(f.calls).toHaveLength(1);
  });
  it('filters out long tool chains before treating an exact user ID as missing',async()=>{
    const f=fixture(), q=f.driver.enqueue(event).delivery;await f.driver.dispatch(q.key);
    const calls: Array<[number,boolean]>=[];
    f.bridge.get=async(_thread,limit,tools)=>{
      calls.push([limit,tools]);
      return tools ? {...idle(),truncated:true,total_messages:1000}
        : {...idle(),truncated:false,messages:[{id:'message-one',role:'user'},
          {id:'final',role:'assistant',status:'finished_successfully',content_type:'text',recipient:'all'}]};
    };
    expect((await f.driver.settle(q.key)).observation).toBe('submitted_turn_observed_complete');
    expect(calls).toEqual([[200,true],[500,false]]);expect(f.calls).toHaveLength(1);
  });
  it('still holds if a regenerated or extremely long visible history lacks the exact ID',async()=>{
    const f=fixture(), q=f.driver.enqueue(event).delivery;await f.driver.dispatch(q.key);
    f.bridge.get=async()=>({...idle(),truncated:true,total_messages:1000});
    expect((await f.driver.settle(q.key)).observation).toBe('submitted_turn_not_observed_complete');
    expect(f.driver.db.prepare('SELECT COUNT(*) AS n FROM local_targets').get()?.n).toBe(1);
  });
  it('does not confuse a previous not_started receipt with a new attempt after a crash',async()=>{
    const f=fixture(), q=f.driver.enqueue(event).delivery;
    f.bridge.send=async()=>({operation_outcome:'not_started',safe_to_resubmit:true,message_id:'old-id'});
    await f.driver.dispatch(q.key);f.advance(1_000_000);
    f.bridge.send=async()=>{throw new Error('lost newest receipt');};
    await f.driver.dispatch(q.key);
    expect(f.driver.get(q.key).receipt?.message_id).toBeUndefined();
    expect(f.driver.get(q.key).priorReceipts?.[0]?.message_id).toBe('old-id');
    f.bridge.submissionEvidence=async()=>({thread_id:THREAD,message_id:'new-id',operation_outcome:'committed'});
    f.bridge.get=async()=>({...idle(),messages:[{id:'new-id',role:'user',text:f.driver.prompt(q)}]});
    expect((await f.driver.recover(q.key)).state).toBe('submitted');
    expect(f.driver.get(q.key).receipt?.message_id).toBe('new-id');
  });
  it('cancels only known pending work and retains all existing history',async()=>{
    const f=fixture(), q=f.driver.enqueue(event).delivery;
    expect(f.driver.cancelPending(q.key).state).toBe('cancelled');
    expect((await f.driver.dispatch(q.key)).state).toBe('cancelled');expect(f.calls).toHaveLength(0);
    expect(()=>f.driver.cancelPending(q.key)).toThrow('only_pending');
  });
  it('does not treat visible progress as an idle completed turn',()=>{
    expect(inspectLocalChat({...idle(),messages:[{id:'final',role:'tool',status:'finished_successfully',content_type:'text',recipient:'all'}]},THREAD)).toBe('target_tail_unresolved');
  });
  it('uses private database permissions and does not reset corrupt or incompatible state',()=>{
    const f=fixture();expect(fs.statSync(f.driver.dbPath).mode&0o777).toBe(0o600);
    f.driver.db.prepare("UPDATE local_meta SET value='99' WHERE key='version'").run();
    expect(()=>f.open()).toThrow('unsupported_local_dispatch_schema');
    const corrupt=path.join(f.dir,'corrupt.sqlite');fs.writeFileSync(corrupt,'not a database');
    expect(()=>new LocalChatContinuation(corrupt,[route],async()=>f.bridge)).toThrow();
    expect(fs.readFileSync(corrupt,'utf8')).toBe('not a database');
  });
});

describe('read-only per-event Desktop journal evidence',()=>{
  const record={kind:'send',thread_id:THREAD,match_key:'hash',mcp_request_id:'req',message_id:'message',operation_id:'op',outcome:'committed',expires_at_ms:0};
  it('accepts expired retained IDs only as evidence for later cloud verification',()=>{
    expect(submissionFromJournal({version:1,operations:[record]},THREAD,'hash','req')).toMatchObject({message_id:'message',operation_outcome:'committed'});
  });
  it.each(['kind','thread_id','match_key','mcp_request_id'])('rejects a mismatched %s',field=>{
    expect(submissionFromJournal({version:1,operations:[{...record,[field]:'other'}]},THREAD,'hash','req')).toBeUndefined();
  });
  it('refuses conflicting message IDs and malformed journals without erasing them',()=>{
    expect(submissionFromJournal({version:1,operations:[record,{...record,message_id:'different'}]},THREAD,'hash','req')).toBeUndefined();
    expect(()=>submissionFromJournal({version:2,operations:[]},THREAD,'hash','req')).toThrow('invalid_bridge_journal');
  });
});
