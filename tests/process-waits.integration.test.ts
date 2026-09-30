import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { Client,StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { describe,expect,it } from 'vitest';
import { Webhook } from 'standardwebhooks';
import { EventRuntime } from '../src/events.js';
import { WorkflowCoordinator } from '../src/workflows.js';
import { createExecRuntimeServer } from '../src/exec-runtime-server.js';
import { createExecRuntimeBackend,ExecRuntimeClientBackend } from '../src/backend/exec-runtime-client.js';
import { createHttpMcpServer } from '../src/http-server.js';
import type { BridgeConfig } from '../src/config.js';

describe.sequential('real background process → local MCP timer → signed mock callback',()=>{
 it.each([
  ['silent success',"node -e \"setTimeout(()=>process.exit(0),300)\"",0,false],
  ['nonzero exit',"node -e \"setTimeout(()=>{console.log('watcher-original-log');process.exit(7)},300)\"",7,false],
  ['overall timeout',"node -e \"setTimeout(()=>process.exit(0),5000)\"",null,true],
 ] as const)('%s survives disconnect and resumes exactly once',async(label,command,exitCode,timedOut)=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'process-event-real-'));
  const config:BridgeConfig={workspaceDir:dir,workspaceOnly:true,toolAllowlist:new Set(['exec','process']),maxOutputChars:10000,
   execRuntime:{socketPath:path.join(dir,'runtime.sock'),requestTimeoutMs:5000},execSecurity:'full',execAsk:'off'};
  const runtime=createExecRuntimeServer(createExecRuntimeBackend(config),config.execRuntime.socketPath);
  const received:Array<Record<string,any>>=[];
  const events=new EventRuntime({storePath:path.join(dir,'events.sqlite'),validateCallback:async()=>{},sender:async(s,body,headers)=>{
   new Webhook(s.delivery.secret).verify(body,headers);
   const p=JSON.parse(body);if(p.type!=='verification') received.push(p);
   return {ok:true,status:200,body:JSON.stringify(p.type==='verification'?{challenge:p.challenge}:{})};
  }});
  const backend=new ExecRuntimeClientBackend(config,new Set(['exec','process']));
  const server=createHttpMcpServer({backend,events});let client:Client|undefined;
  try {
   await runtime.listen();await new Promise<void>(resolve=>server.server.listen(0,'127.0.0.1',resolve));
   const endpoint=new URL('http://127.0.0.1:'+(server.server.address() as AddressInfo).port+'/mcp');
   const connect=async()=>{const c=new Client({name:'real-process-test',version:'1'},{versionNegotiation:{mode:{pin:'2026-07-28'}}});await c.connect(new StreamableHTTPClientTransport(endpoint));return c;};
   client=await connect();
   await events.subscribe('local-tunnel-user',{name:'workflow.continue',arguments:{topic:'real-process'},delivery:{mode:'webhook',url:'https://callback.example/'+randomUUID(),secret:'whsec_'+Buffer.alloc(32,3).toString('base64')},ttlMs:null});
   await client.callTool({name:'workflow_manage',arguments:{action:'register',key:'worker',topic:'real-process',role:'worker',workspace:dir}});
   await client.callTool({name:'workflow_manage',arguments:{action:'bind',key:'worker'}});
   const started=await client.callTool({name:'exec',arguments:{command,background:true,timeoutSeconds:timedOut?1:10}});
   const sessionId=(started.structuredContent as {sessionId:string}).sessionId;expect(sessionId).toBeTruthy();
   const watched=await client.callTool({name:'workflow_manage',arguments:{action:'watch_process',key:'worker',session_id:sessionId}});expect(watched.isError).not.toBe(true);
   // No Chat/client polling during the wait. Only the server's local timer runs.
   await client.close();client=undefined;
   const deadline=Date.now()+12000;
   while(!received.length&&Date.now()<deadline) await new Promise(r=>setTimeout(r,100));
   expect(received).toHaveLength(1);
   const data=received[0]!.data;const observation=JSON.parse(data.summary);
   expect(data.trigger_reason).toBe(timedOut?'process.timed_out':exitCode===0?'process.completed':'process.failed');
   if(exitCode!==null)expect(observation.exitCode).toBe(exitCode);
   client=await connect();
   const log=await client.callTool({name:'process',arguments:{action:'poll',sessionId,timeout:0}});
   if(label==='nonzero exit')expect(JSON.stringify(log.content)).toContain('watcher-original-log');
   const c=new WorkflowCoordinator(events),run=c.status('worker').runs[0]!;
   const lease=c.claim({task:'worker',dispatchId:run.id,runner:'replacement-client'});expect(lease.claimed).toBe(true);
   c.finish({task:'worker',leaseToken:lease.leaseToken!,outcome:'completed'});
   expect(events.db.count('outbox')).toBe(1);
  } finally {await client?.close();await server.close();await runtime.close();events.close();await fs.rm(dir,{recursive:true,force:true});}
 },25000);
});

it('keeps a real process wait through MCP server and event-store replacement',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'process-event-restart-'));
 const config:BridgeConfig={workspaceDir:dir,workspaceOnly:true,toolAllowlist:new Set(['exec','process']),maxOutputChars:10000,
  execRuntime:{socketPath:path.join(dir,'runtime.sock'),requestTimeoutMs:5000},execSecurity:'full',execAsk:'off'};
 const runtime=createExecRuntimeServer(createExecRuntimeBackend(config),config.execRuntime.socketPath);
 const received:Array<Record<string,any>>=[];
 const options={storePath:path.join(dir,'events.sqlite'),validateCallback:async()=>{},sender:async(_s:unknown,body:string)=>{const p=JSON.parse(body);if(p.type!=='verification')received.push(p);return {ok:true,status:200,body:JSON.stringify(p.type==='verification'?{challenge:p.challenge}:{})};}};
 let events=new EventRuntime(options);
 const backend=new ExecRuntimeClientBackend(config,new Set(['exec','process']));
 let server=createHttpMcpServer({backend,events});
 try {
  await runtime.listen();await new Promise<void>(r=>server.server.listen(0,'127.0.0.1',r));
  await events.subscribe('local-tunnel-user',{name:'workflow.continue',arguments:{topic:'restart'},delivery:{mode:'webhook',url:'https://callback.example/restart',secret:'whsec_'+Buffer.alloc(32,3).toString('base64')},ttlMs:null});
  let c=new WorkflowCoordinator(events);c.register({key:'worker',topic:'restart',role:'worker'});c.bind('worker');
  const started=await backend.callTool('exec',{command:`node -e "setTimeout(()=>console.log('survived-http-restart'),1300)"`,background:true},{callId:'real-restart-start'});
  const sessionId=(started.structuredContent as {sessionId:string}).sessionId;
  const {ProcessWaitDriver}=await import('../src/process-waits.js');
  await new ProcessWaitDriver(c,backend).register({task:'worker',sessionId});
  await server.close();events.close();
  events=new EventRuntime(options);c=new WorkflowCoordinator(events);
  expect(c.status('worker').workflows[0]?.state).toBe('waiting');
  server=createHttpMcpServer({backend,events});await new Promise<void>(r=>server.server.listen(0,'127.0.0.1',r));
  const deadline=Date.now()+10000;while(!received.length&&Date.now()<deadline)await new Promise(r=>setTimeout(r,100));
  expect(received).toHaveLength(1);expect(received[0]!.data.trigger_reason).toBe('process.completed');
  const log=await backend.callTool('process',{action:'poll',sessionId,timeout:0},{callId:'read-after-server-restart'});
  expect(JSON.stringify(log.content)).toContain('survived-http-restart');
 } finally {await server.close();await runtime.close();events.close();await fs.rm(dir,{recursive:true,force:true});}
},20000);
