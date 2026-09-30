import type { AddressInfo } from "node:net";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { LocalToolBackend } from "../src/backend/types.js";
import { CONTINUE_EVENT_NAME, EventRuntime } from "../src/events.js";
import { createHttpMcpServer, type HttpMcpServer } from "../src/http-server.js";

const servers: HttpMcpServer[] = [];

afterEach(async () => {
  await Promise.allSettled(servers.splice(0).map((server) => server.close()));
});

function stubBackend(): LocalToolBackend {
  return {
    id: "stub",
    async listTools() {
      return [{
        name: "read",
        description: "read a local file",
        inputSchema: { type: "object", properties: { path: { type: "string" } } },
      }];
    },
    async callTool(name, args) {
      return { content: [{ type: "text", text: `${name}:${String(args.path ?? "")}` }] };
    },
  };
}

async function listen(server: HttpMcpServer): Promise<URL> {
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.server.once("error", reject);
    server.server.listen(0, "127.0.0.1", () => {
      server.server.off("error", reject);
      resolve();
    });
  });
  const address = server.server.address() as AddressInfo;
  return new URL(`http://127.0.0.1:${address.port}/mcp`);
}

async function assertToolSurface(client: Client, expectedPath: string): Promise<void> {
  expect(client.getInstructions()).toContain("primary interface");
  expect(client.getInstructions()).toContain("durable working environment");
  expect(client.getInstructions()).toContain("Gitea issue");
  const { tools } = await client.listTools();
  expect(tools.map((tool) => tool.name)).toEqual(["read"]);
  const result = await client.callTool({ name: "read", arguments: { path: expectedPath } });
  expect(result.content).toEqual([{ type: "text", text: `read:${expectedPath}` }]);
}

describe("sessionless Streamable HTTP MCP server", () => {
  it("serves the modern 2026-07-28 per-request protocol", async () => {
    const mcp = createHttpMcpServer({ backend: stubBackend() });
    const endpoint = await listen(mcp);
    const client = new Client(
      { name: "http-modern-test", version: "0.1.0" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    const transport = new StreamableHTTPClientTransport(endpoint);
    await client.connect(transport);

    expect(client.getProtocolEra()).toBe("modern");
    expect(client.getNegotiatedProtocolVersion()).toBe("2026-07-28");
    expect(transport.sessionId).toBeUndefined();
    await assertToolSurface(client, "/tmp/modern");
    expect(transport.sessionId).toBeUndefined();
    await client.close();
  });

  it("keeps 2025-era clients working through the stateless compatibility leg", async () => {
    const mcp = createHttpMcpServer({ backend: stubBackend() });
    const endpoint = await listen(mcp);
    const client = new Client({ name: "http-legacy-test", version: "0.1.0" });
    const transport = new StreamableHTTPClientTransport(endpoint);
    await client.connect(transport);

    expect(client.getProtocolEra()).toBe("legacy");
    expect(client.getNegotiatedProtocolVersion()).not.toBe("2026-07-28");
    expect(transport.sessionId).toBeUndefined();
    await assertToolSurface(client, "/tmp/legacy");
    expect(transport.sessionId).toBeUndefined();
    await client.close();
  });

  it("reports sessionless health and rejects non-local browser origins", async () => {
    const mcp = createHttpMcpServer({ backend: stubBackend() });
    const endpoint = await listen(mcp);
    const base = new URL(endpoint);

    const health = await fetch(new URL("/healthz", base));
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toMatchObject({
      ok: true,
      mode: "sessionless",
      modernProtocol: "2026-07-28",
      legacyCompatibility: "stateless",
      sessions: 0,
    });

    const rejected = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://example.com",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(rejected.status).toBe(403);
  });

  it("advertises and serves the modern MCP event surface", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "webagent-http-events-"));
    const events = new EventRuntime({
      storePath: path.join(dir, "events.json"),
      validateCallback: async () => {},
      sender: async (_subscription, body) => {
        const parsed = JSON.parse(body) as { type?: string; challenge?: string };
        return parsed.type === "verification"
          ? { ok: true, status: 200, body: JSON.stringify({ challenge: parsed.challenge }) }
          : { ok: true, status: 200, body: "" };
      },
    });
    const mcp = createHttpMcpServer({ backend: stubBackend(), events });
    const endpoint = await listen(mcp);
    const client = new Client(
      { name: "http-events-test", version: "0.1.0" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    await client.connect(new StreamableHTTPClientTransport(endpoint));

    expect(client.getProtocolEra()).toBe("modern");
    // The generic MCP client normalizes known capabilities when connecting, so
    // query discover with a permissive schema to assert the extension survives
    // on the actual modern wire.
    const discover = await client.request(
      { method: "server/discover", params: {} },
      z.object({
        supportedVersions: z.array(z.string()),
        capabilities: z.record(z.string(), z.unknown()),
      }).passthrough(),
    );
    expect(discover.capabilities.events).toEqual({});

    const result = await client.request(
      { method: "events/list", params: {} },
      z.object({
        events: z.array(z.object({
          name: z.string(),
          description: z.string(),
        }).passthrough()),
      }),
    );
    expect(result.events.map((event) => event.name)).toContain(CONTINUE_EVENT_NAME);

    const secret = `whsec_${Buffer.alloc(32, 9).toString("base64")}`;
    const subscribed = await client.request(
      {
        method: "events/subscribe",
        params: {
          name: CONTINUE_EVENT_NAME,
          arguments: { topic: "poc:continue-chat" },
          delivery: {
            mode: "webhook",
            url: "https://events.example.com/callback",
            secret,
          },
          ttlMs: null,
        },
      },
      z.object({
        id: z.string(),
        refreshBefore: z.string().nullable(),
        cursor: z.string().nullable(),
        truncated: z.boolean(),
      }),
    );
    expect(subscribed.id).toMatch(/^sub_/);
    expect(await events.subscriptions()).toHaveLength(1);

    await client.request(
      {
        method: "events/unsubscribe",
        params: {
          name: CONTINUE_EVENT_NAME,
          arguments: { topic: "poc:continue-chat" },
          delivery: {
            mode: "webhook",
            url: "https://events.example.com/callback",
          },
        },
      },
      z.object({}).passthrough(),
    );
    expect(await events.subscriptions()).toHaveLength(0);
    await client.close();
  });
});

describe('supervisor tools across independent MCP clients (mock callback receiver)', () => {
  it('runs external trigger → supervisor claim/dispatch → worker claim/finish through HTTP', async () => {
    const { WorkflowCoordinator } = await import('../src/workflows.js');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-http-chain-'));
    const bodies: Array<Record<string, any>> = [];
    const events = new EventRuntime({ storePath: path.join(dir, 'events.sqlite'), validateCallback: async () => {},
      sender: async (_sub, body) => {const data = JSON.parse(body);bodies.push(data);return {ok:true,status:200,body:JSON.stringify({challenge:data.challenge})};} });
    const mcp = createHttpMcpServer({backend:stubBackend(),events});const endpoint = await listen(mcp);
    const connect = async (name:string) => {const client=new Client({name,version:'1'},{versionNegotiation:{mode:{pin:'2026-07-28'}}});await client.connect(new StreamableHTTPClientTransport(endpoint));return client;};
    const supervisor=await connect('supervisor'),worker=await connect('worker');
    const call=async(client:Client,name:string,args:Record<string,unknown>)=>{const result=await client.callTool({name,arguments:args});expect(result.isError).not.toBe(true);return result.structuredContent as any;};
    expect((await supervisor.listTools()).tools.filter(t=>t.name.startsWith('workflow_'))).toHaveLength(4);
    for(const [client,key] of [[supervisor,'s'],[worker,'w']] as const) {
      await call(client,'workflow_manage',{action:'register',key,topic:'http:'+key,role:key==='s'?'supervisor':'worker'});
      await client.request({method:'events/subscribe',params:{name:'workflow.continue',arguments:{topic:'http:'+key},delivery:{mode:'webhook',url:'https://callback.example/'+key,secret:'whsec_'+Buffer.alloc(32,4).toString('base64')},ttlMs:null}},z.object({id:z.string()}).passthrough());
      await call(client,'workflow_manage',{action:'bind',key});
    }
    const root=new WorkflowCoordinator(events).external({target:'s',producer:'external-clock',dedupKey:'one-tick',reason:'time to inspect'});await events.flush(root.eventId);
    const s=await call(supervisor,'workflow_run',{action:'claim',task:'s',dispatch_id:root.dispatchId,runner:'supervisor-chat'});
    const d=await call(supervisor,'workflow_dispatch',{source_task:'s',lease_token:s.leaseToken,target_task:'w',dedup_key:'work1',reason:'target idle and unfinished'});
    await call(supervisor,'workflow_run',{action:'finish',task:'s',lease_token:s.leaseToken,outcome:'idle'});await events.flush(d.eventId);
    const w=await call(worker,'workflow_run',{action:'claim',task:'w',dispatch_id:d.dispatchId,runner:'worker-chat'});
    await call(worker,'workflow_run',{action:'finish',task:'w',lease_token:w.leaseToken,outcome:'completed',checkpoint:'passed-http-work',summary:'mock work done'});
    const result=await call(supervisor,'workflow_status',{task:'w'});expect(result.workflows[0].state).toBe('completed');
    expect(bodies.filter(b=>b.name==='workflow.continue')).toHaveLength(2);
    await supervisor.close();await worker.close();await mcp.close();events.close();await fs.rm(dir,{recursive:true,force:true});
  });
  it('returns the specified callback-verification error code over MCP', async()=>{
    const dir=await fs.mkdtemp(path.join(os.tmpdir(),'workflow-http-invalid-'));
    const events=new EventRuntime({storePath:path.join(dir,'events.sqlite'),validateCallback:async()=>{},sender:async()=>({ok:true,status:200,body:'{"challenge":"wrong"}'})});
    const mcp=createHttpMcpServer({backend:stubBackend(),events}),endpoint=await listen(mcp);
    const client=new Client({name:'invalid-callback',version:'1'},{versionNegotiation:{mode:{pin:'2026-07-28'}}});await client.connect(new StreamableHTTPClientTransport(endpoint));
    await expect(client.request({method:'events/subscribe',params:{name:'workflow.continue',arguments:{topic:'test'},delivery:{mode:'webhook',url:'https://callback.example/a',secret:'whsec_'+Buffer.alloc(32,4).toString('base64')}}},z.object({}).passthrough())).rejects.toMatchObject({code:-32015,data:{reason:'challenge_failed'}});
    await client.close();await mcp.close();events.close();await fs.rm(dir,{recursive:true,force:true});
  });
});

it('keeps ordinary workflow tools callable on a legacy tools/call leg',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'workflow-legacy-tool-'));
 const events=new EventRuntime({storePath:path.join(dir,'events.sqlite'),validateCallback:async()=>{},sender:async()=>({ok:true,status:202,body:''})});
 const mcp=createHttpMcpServer({backend:stubBackend(),events}),endpoint=await listen(mcp);
 const client=new Client({name:'legacy-workflow-tool',version:'1'});await client.connect(new StreamableHTTPClientTransport(endpoint));
 expect(client.getProtocolEra()).toBe('legacy');
 expect((client.getServerCapabilities() as Record<string,unknown>).events).toBeUndefined();
 expect((await client.listTools()).tools.map(t=>t.name)).toContain('workflow_status');
 const result=await client.callTool({name:'workflow_status',arguments:{}});expect(result.isError).not.toBe(true);expect(result.structuredContent).toHaveProperty('workflows');
 await client.close();await mcp.close();events.close();await fs.rm(dir,{recursive:true,force:true});
});
