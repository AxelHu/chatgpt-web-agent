/** Read-only verification against the configured local HTTP MCP endpoint. */
import assert from 'node:assert/strict';
import { Client,StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { z } from 'zod';
const endpoint=new URL(process.argv[2]??'http://127.0.0.1:18790/mcp');
assert(['127.0.0.1','localhost','[::1]'].includes(endpoint.hostname),'Live probe is loopback only');
const client=new Client({name:'process-events-live-surface',version:'1'}, {versionNegotiation:{mode:{pin:'2026-07-28'}}});
try {
 await client.connect(new StreamableHTTPClientTransport(endpoint));
 const tools=(await client.listTools()).tools;
 const actions=(name:string)=>((tools.find(t=>t.name===name)?.inputSchema.properties as Record<string,{enum?:string[]}>|undefined)?.action?.enum??[]);
 assert(actions('workflow_manage').includes('watch_process'));
 assert(actions('workflow_manage').includes('cancel_process_wait'));
 assert(actions('workflow_run').includes('wait_process'));
 assert(!tools.find(t=>t.name==='workflow_dispatch')?.description?.includes('no-progress feedback are rejected'));
 const events=await client.request({method:'events/list',params:{}},z.object({events:z.array(z.object({name:z.string()}).passthrough())}));
 assert(events.events.some(e=>e.name==='workflow.continue'));
 const status=await client.callTool({name:'workflow_status',arguments:{}});
 assert(!status.isError);
 const state=status.structuredContent as {workflows?:unknown[];processWaits?:unknown[];counts?:unknown};
 const health=await(await fetch(new URL('/healthz',endpoint))).json();
 console.log(JSON.stringify({ok:true,health,toolCount:tools.length,manageActions:actions('workflow_manage'),runActions:actions('workflow_run'),eventNames:events.events.map(e=>e.name),workflowCount:state.workflows?.length,processWaitCount:state.processWaits?.length,counts:state.counts}));
} finally {await client.close();}
