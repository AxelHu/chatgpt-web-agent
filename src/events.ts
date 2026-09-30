import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { Webhook } from "standardwebhooks";
import { z } from "zod";
import { StateDatabase } from "./state-db.js";
import { pinnedHttpsPost, resolvePublicCallback, type CallbackResponse } from "./event-network.js";

export const CONTINUE_EVENT_NAME = "workflow.continue";

export const EVENT_DEFINITIONS = [
  {
    name: CONTINUE_EVENT_NAME,
    description:
      "A local workflow is ready for ChatGPT to continue work in the subscribed chat. " +
      "Use a stable topic to bind a continuation stream to one project, task, or research thread.",
    delivery: ["webhook"],
    inputSchema: {
      type: "object",
      properties: {
        topic: {
          type: "string",
          minLength: 1,
          maxLength: 200,
          description: "Stable continuation topic, for example light-alchemy:item-expansion.",
        },
      },
      required: ["topic"],
      additionalProperties: false,
    },
    payloadSchema: {
      type: "object",
      properties: {
        topic: { type: "string" },
        trigger_reason: {
          type: "string",
          description: "Data describing why the local workflow became ready to continue.",
        },
        summary: {
          type: "string",
          description: "Small state summary. Large state should be fetched with normal MCP tools.",
        },
        state_ref: {
          type: "string",
          description: "Optional durable local reference such as a process session, checkpoint, or repo path.",
        },
        source: {
          type: "string",
          description: "Optional producer label such as process, timer, codex, git, or research.",
        },
        dispatch_id: { type: "string" },
        root_id: { type: "string" },
        source_task: { type: "string" },
        target_task: { type: "string" },
        progress_version: { type: "integer", minimum: 0 },
        sequence: {
          type: "integer",
          minimum: 0,
          description: "Optional producer sequence number for ordering or deduplication.",
        },
      },
      required: ["topic", "trigger_reason"],
      additionalProperties: false,
    },
  },
] as const;

export type ContinueEventData = {
  topic: string;
  trigger_reason: string;
  summary?: string;
  state_ref?: string;
  source?: string;
  sequence?: number;
  dispatch_id?: string;
  root_id?: string;
  source_task?: string;
  target_task?: string;
  progress_version?: number;
};

export type EventDelivery = { mode: 'webhook'; url: string; secret: string };
export type EventSubscription = {
  id: string; owner: string; name: string; arguments: Record<string, unknown>;
  delivery: EventDelivery; createdAt: string; updatedAt: string; refreshBefore: string | null;
  verifiedAt?: number; previousSecret?: string; previousSecretUntil?: number;
  disabled?: boolean;
};
export type SubscribeRequest = { name: string; arguments?: Record<string, unknown>; delivery: EventDelivery; cursor?: string | null; ttlMs?: number | null };
export type UnsubscribeRequest = { name: string; arguments?: Record<string, unknown>; delivery: Pick<EventDelivery, 'mode' | 'url'> };
export type EventDeliveryResponse = CallbackResponse;
export type EventWebhookSender = (subscription: EventSubscription, body: string, headers: Record<string,string>) => Promise<CallbackResponse>;
export type EventRuntimeOptions = { storePath?: string; sender?: EventWebhookSender; validateCallback?: (url: string) => Promise<void>; now?: () => Date; db?: StateDatabase };
export type OutboxDelivery = {
  key: string; eventId: string; subscriptionId: string; body: string;
  state: 'pending' | 'sending' | 'accepted' | 'failed' | 'cancelled';
  attempts: number; nextAttemptAt: number; claimUntil?: number; claimId?: string;
  ambiguousAttempts?: number;
  status?: number; error?: string;
};
export class CallbackEndpointError extends Error {
  readonly code = -32015;
  constructor(readonly reason: string) { super('Callback verification failed'); this.name = 'CallbackEndpointError'; }
}
const dataSchema = z.object({
  topic: z.string().min(1).max(200), trigger_reason: z.string().min(1).max(2000),
  summary: z.string().max(8000).optional(), state_ref: z.string().max(2000).optional(),
  source: z.string().max(200).optional(), sequence: z.number().int().nonnegative().optional(),
  dispatch_id: z.string().optional(), root_id: z.string().optional(),
  source_task: z.string().optional(), target_task: z.string().optional(),
  progress_version: z.number().int().nonnegative().optional(),
}).strict();
function defaultStorePath(): string {
  const explicit = process.env.CHATGPT_WEB_AGENT_EVENT_STORE?.trim();
  return explicit ? path.resolve(explicit) : path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'chatgpt-web-agent', 'events.sqlite');
}
export function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  return '{' + Object.keys(value).filter(k => (value as Record<string,unknown>)[k] !== undefined).sort().map(k => JSON.stringify(k) + ':' + canonicalJson((value as Record<string,unknown>)[k])).join(',') + '}';
}
function identity(owner: string, url: string, name: string, args: Record<string,unknown>): string {
  return 'sub_' + createHash('sha256').update(canonicalJson([owner,url,name,args])).digest('hex').slice(0,32);
}
export function validateSecret(secret: string): void {
  if (!/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret)) throw new Error('invalid_webhook_secret');
  const encoded = secret.slice(6); const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length < 24 || bytes.length > 64 || bytes.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')) throw new Error('invalid_webhook_secret');
}
function topicArgs(name: string, args: Record<string,unknown>): { topic: string } {
  if (name !== CONTINUE_EVENT_NAME) throw new Error('unsupported_event');
  return z.object({ topic: z.string().trim().min(1).max(200) }).strict().parse(args);
}
function equalText(a: string,b: string): boolean {
  const x=Buffer.from(a),y=Buffer.from(b); return x.length===y.length && timingSafeEqual(x,y);
}
export class EventRuntime {
  readonly storePath: string; readonly db: StateDatabase;
  readonly sender: EventWebhookSender; readonly now: () => Date;
  readonly validateCallback: (url:string) => Promise<void>;
  constructor(options: EventRuntimeOptions = {}) {
    this.storePath = options.storePath ?? defaultStorePath();
    // Never silently strand subscriptions from the pre-SQLite default.
    if (!options.db && !fs.existsSync(this.storePath) && path.basename(this.storePath) === 'events.sqlite') {
      const oldDefault = path.join(path.dirname(this.storePath), 'events.json');
      if (fs.existsSync(oldDefault)) throw new Error('legacy_json_store_requires_migration');
    }
    // A pre-existing JSON PoC store must be migrated explicitly, never replaced.
    if (!options.db && fs.existsSync(this.storePath)) {
      const fd = fs.openSync(this.storePath, 'r'); const head = Buffer.alloc(16);
      try { fs.readSync(fd, head, 0, 16, 0); } finally { fs.closeSync(fd); }
      if (head.toString().trimStart().startsWith('{')) throw new Error('legacy_json_store_requires_migration');
    }
    this.db = options.db ?? new StateDatabase(this.storePath);
    this.sender = options.sender ?? ((subscription,body,headers) => pinnedHttpsPost(subscription.delivery.url,body,headers));
    this.validateCallback = options.validateCallback ?? (async url => { await resolvePublicCallback(url); });
    this.now = options.now ?? (() => new Date());
  }
  list() { return { events: EVENT_DEFINITIONS }; }
  private active(sub: EventSubscription): boolean { return !sub.disabled && (sub.refreshBefore === null || Date.parse(sub.refreshBefore) > this.now().getTime()); }
  activeSubscriptions(topic: string, owner = 'local-tunnel-user'): EventSubscription[] {
    return this.db.all<EventSubscription>('subscriptions').filter(s => s.owner === owner && s.arguments.topic === topic && this.active(s));
  }
  async subscriptions(): Promise<EventSubscription[]> { return this.db.all('subscriptions'); }
  subscriptionSummaries() {
    return this.db.all<EventSubscription>('subscriptions').map(s => ({ id:s.id,owner:s.owner,name:s.name,arguments:s.arguments,refreshBefore:s.refreshBefore,active:this.active(s) }));
  }
  private headers(sub: EventSubscription, id: string, body: string): Record<string,string> {
    const date = this.now(); const signatures = [new Webhook(sub.delivery.secret).sign(id,date,body)];
    if (sub.previousSecret && (sub.previousSecretUntil ?? 0) > date.getTime()) signatures.push(new Webhook(sub.previousSecret).sign(id,date,body));
    return { 'content-type':'application/json','webhook-id':id,'webhook-timestamp':String(Math.floor(date.getTime()/1000)), 'webhook-signature':signatures.join(' '),'X-MCP-Subscription-Id':sub.id };
  }
  async subscribe(owner: string, request: SubscribeRequest) {
    const args=topicArgs(request.name,request.arguments ?? {});
    if (request.delivery?.mode !== 'webhook') throw new Error('unsupported_delivery');
    validateSecret(request.delivery.secret);
    const ttl=request.ttlMs;
    if (ttl !== null && ttl !== undefined && (!Number.isSafeInteger(ttl) || ttl < 0)) throw new Error('invalid_ttl');
    const id=identity(owner,request.delivery.url,request.name,args);
    const cancelEpoch=this.db.get<number>('subscription-cancel-epochs',id)??0;
    try { await this.validateCallback(request.delivery.url); } catch { throw new CallbackEndpointError('invalid_url'); }
    const now=this.now(); const prior=this.db.get<EventSubscription>('subscriptions',id);
    const candidate: EventSubscription={id,owner,name:request.name,arguments:args,delivery:request.delivery,
      createdAt:prior?.createdAt ?? now.toISOString(),updatedAt:now.toISOString(),
      refreshBefore:ttl===null ? null : new Date(now.getTime()+Math.max(60_000,ttl ?? 30*86400_000)).toISOString()};
    const cacheHit = prior && !prior.disabled && prior.delivery.secret===candidate.delivery.secret && now.getTime()-(prior.verifiedAt ?? 0)<300_000;
    if (!cacheHit) {
      const challenge=randomUUID(),verificationId='verify_'+randomUUID();
      const body=JSON.stringify({type:'verification',challenge});
      let response: CallbackResponse;
      try { response=await this.sender(candidate,body,this.headers(candidate,verificationId,body)); }
      catch { throw new CallbackEndpointError('timeout'); }
      if (!response.ok) throw new CallbackEndpointError('challenge_failed');
      let echoed: unknown;
      try { echoed=JSON.parse(response.body); } catch { throw new CallbackEndpointError('challenge_failed'); }
      const text=(echoed as {challenge?:unknown})?.challenge;
      if (typeof text!=='string' || !equalText(challenge,text)) throw new CallbackEndpointError('challenge_failed');
    }
    candidate.verifiedAt=cacheHit ? prior.verifiedAt : now.getTime();
    if (prior?.delivery.secret && prior.delivery.secret!==candidate.delivery.secret) {
      candidate.previousSecret=prior.delivery.secret; candidate.previousSecretUntil=now.getTime()+300_000;
    } else if (prior?.previousSecret && (prior.previousSecretUntil ?? 0)>now.getTime()) {
      candidate.previousSecret=prior.previousSecret; candidate.previousSecretUntil=prior.previousSecretUntil;
    }
    // The write is a row-level upsert; parallel callbacks cannot erase peers.
    this.db.atomic(() => {
      if((this.db.get<number>('subscription-cancel-epochs',id)??0)!==cancelEpoch) throw new Error('subscription_cancelled_during_verification');
      this.db.put('subscriptions',id,candidate);
    });
    return {id,refreshBefore:candidate.refreshBefore,cursor:null,truncated:false};
  }
  async unsubscribe(owner:string,request:UnsubscribeRequest): Promise<Record<string,never>> {
    const args=topicArgs(request.name,request.arguments ?? {});
    if (request.delivery?.mode!=='webhook') throw new Error('unsupported_delivery');
    const id=identity(owner,request.delivery.url,request.name,args);
    this.db.atomic(() => {
      this.db.put('subscription-cancel-epochs',id,(this.db.get<number>('subscription-cancel-epochs',id)??0)+1);
      this.db.remove('subscriptions',id);
      for (const d of this.db.all<OutboxDelivery>('outbox')) if(d.subscriptionId===id && (d.state==='pending'||d.state==='sending')) this.db.put('outbox',d.key,{...d,state:'cancelled'});
    });
    return {};
  }
  enqueueContinue(data:ContinueEventData,options:{eventId?:string;subscriptionId?:string;owner?:string}={}) {
    const validated=dataSchema.parse(data); const eventId=options.eventId ?? 'evt_'+randomUUID();
    const body=JSON.stringify({eventId,name:CONTINUE_EVENT_NAME,timestamp:this.now().toISOString(),data:validated,cursor:null});
    if(Buffer.byteLength(body)>262144) throw new Error('event_too_large');
    return this.db.atomic(() => {
      const subs=this.db.all<EventSubscription>('subscriptions').filter(s => this.active(s) && s.arguments.topic===data.topic && (!options.subscriptionId||s.id===options.subscriptionId) && (!options.owner||s.owner===options.owner));
      for(const sub of subs) {
        const key=eventId+':'+sub.id; const existing=this.db.get<OutboxDelivery>('outbox',key);
        if(existing) {
          if(canonicalJson(JSON.parse(existing.body).data)!==canonicalJson(validated)) throw new Error('event_id_conflict');
          continue;
        }
        this.db.put<OutboxDelivery>('outbox',key,{key,eventId,subscriptionId:sub.id,body,state:'pending',attempts:0,nextAttemptAt:this.now().getTime()});
      }
      return {eventId,matched:subs.length};
    });
  }
  async emitContinue(data:ContinueEventData,options:{eventId?:string;subscriptionId?:string;owner?:string}={}) {
    const result=this.enqueueContinue(data,options); await this.flush(result.eventId);
    const deliveries=this.db.db.prepare("SELECT value FROM objects WHERE bucket='outbox' AND json_extract(value,'$.eventId')=?").all(result.eventId).map(row=>JSON.parse(String(row.value)) as OutboxDelivery);
    return {...result,delivered:deliveries.filter(d=>d.state==='accepted').length,pending:deliveries.filter(d=>d.state==='pending'||d.state==='sending').length,
      failed:deliveries.filter(d=>d.state==='failed'||d.state==='cancelled').map(d=>({subscriptionId:d.subscriptionId,status:d.status,error:d.error}))};
  }
  async flush(eventId?:string): Promise<void> {
    const now=this.now().getTime();
    const due=this.db.db.prepare(`SELECT value FROM objects WHERE bucket='outbox'
      AND (json_extract(value,'$.state')='pending' OR (json_extract(value,'$.state')='sending' AND json_extract(value,'$.claimUntil')<?))
      AND json_extract(value,'$.nextAttemptAt')<=? AND (? IS NULL OR json_extract(value,'$.eventId')=?)
      ORDER BY json_extract(value,'$.nextAttemptAt') LIMIT 32`).all(now,now,eventId??null,eventId??null)
      .map(row=>JSON.parse(String(row.value)) as OutboxDelivery);
    for(const candidate of due) {
      const claimed=this.db.atomic(() => {
        const d=this.db.get<OutboxDelivery>('outbox',candidate.key);
        if(!d || (d.state!=='pending'&&!(d.state==='sending'&&(d.claimUntil ?? 0)<this.now().getTime())) || d.nextAttemptAt>this.now().getTime()) return undefined;
        const sub=this.db.get<EventSubscription>('subscriptions',d.subscriptionId);
        if(!sub||!this.active(sub)) { this.db.put('outbox',d.key,{...d,state:'cancelled',error:'subscription_inactive'}); return undefined; }
        const next:OutboxDelivery={...d,state:'sending',attempts:d.attempts+1,ambiguousAttempts:(d.ambiguousAttempts??0)+(d.state==='sending'?1:0),claimUntil:this.now().getTime()+30_000,claimId:randomUUID()};
        this.db.put('outbox',d.key,next); return {delivery:next,sub};
      });
      if(!claimed) continue;
      let response:CallbackResponse|undefined; let error:string|undefined;
      try { response=await this.sender(claimed.sub,claimed.delivery.body,this.headers(claimed.sub,claimed.delivery.eventId,claimed.delivery.body)); }
      catch { error='transport_error'; }
      this.db.atomic(() => {
        const current=this.db.get<OutboxDelivery>('outbox',candidate.key);
        if(!current||current.state!=='sending'||current.claimId!==claimed.delivery.claimId) return;
        const ambiguous=!response||response.status===408||response.status>=500;
        const ambiguousAttempts=(current.ambiguousAttempts??0)+(ambiguous?1:0);
        const transient=ambiguous||response?.status===429;
        const state:OutboxDelivery['state']=response?.ok?'accepted':transient&&current.attempts<6?'pending':'failed';
        this.db.put('outbox',current.key,{...current,state,status:response?.status,error,ambiguousAttempts,nextAttemptAt:this.now().getTime()+Math.max(Math.min(response?.retryAfterMs??0,86400_000),1000*2**(current.attempts-1))});
        if(response?.status===410) {
          const sub=this.db.get<EventSubscription>('subscriptions',current.subscriptionId);
          if(sub) this.db.put('subscriptions',sub.id,{...sub,disabled:true});
        }
      });
    }
  }
  outboxSummary(eventId?:string) {
    const rows=eventId ? this.db.db.prepare("SELECT value FROM objects WHERE bucket='outbox' AND json_extract(value,'$.eventId')=? ORDER BY rowid DESC LIMIT 100").all(eventId).map(row=>JSON.parse(String(row.value)) as OutboxDelivery) : this.db.recent<OutboxDelivery>('outbox',40);
    return rows.map(({body,claimId,...row})=>row);
  }
  close():void { this.db.close(); }
}
