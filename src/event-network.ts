import { promises as dns } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls, { type ConnectionOptions, type TLSSocket } from 'node:tls';
import ipaddr from 'ipaddr.js';

export type CallbackResponse = { ok: boolean; status: number; body: string; retryAfterMs?: number };
export type AddressLookup = (host: string) => Promise<Array<{ address: string; family: number }>>;
export function isPublicAddress(address: string): boolean {
  try { return ipaddr.parse(address).range() === 'unicast'; } catch { return false; }
}
export async function resolvePublicCallback(value: string, lookup?: AddressLookup, env: NodeJS.ProcessEnv = process.env) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('invalid_callback_url');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const proxy = callbackProxy(url, env);
  const resolver = lookup ?? (proxy
    ? (name: string) => resolveProxyDns(name, proxy)
    : (name: string) => dns.lookup(name, { all: true, verbatim: true }));
  const addresses = net.isIP(host) ? [{ address: host, family: net.isIP(host) }] : await resolver(host);
  if (!addresses.length || addresses.some(a => !isPublicAddress(a.address))) throw new Error('non_public_callback');
  return { url, host, addresses };
}
class CallbackConnectionError extends Error { constructor() {super('callback_connection_failed');} }
export async function tryValidatedAddresses<T>(addresses:Array<{address:string;family:number}>, attempt:(address:{address:string;family:number})=>Promise<T>):Promise<T> {
  for(let i=0;i<addresses.length;i++) {
    try{return await attempt(addresses[i]!);}catch(error){if(!(error instanceof CallbackConnectionError)||i===addresses.length-1)throw error;}
  }
  throw new CallbackConnectionError();
}
/** Public only for deterministic transport tests, not a tool-level retry flag. */
export function connectionFailure(): Error { return new CallbackConnectionError(); }

/** Configuration belongs to the server operator, never to event payloads.
 * Evaluate NO_PROXY against the original hostname before replacing it with a
 * validated IP; otherwise hostname exclusions would silently stop working. */
export function callbackProxy(url: URL, env: NodeJS.ProcessEnv): string | undefined {
  const raw = env.https_proxy || env.HTTPS_PROXY;
  if (!raw) return undefined;
  let proxy: URL;
  try { proxy = new URL(raw); } catch { throw new Error('invalid_callback_proxy'); }
  if (!['http:', 'https:'].includes(proxy.protocol) || /[\r\n]/.test(raw) || proxy.hash ||
      proxy.pathname !== '/' || proxy.search) throw new Error('invalid_callback_proxy');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const port = url.port || '443';
  for (const entry of (env.no_proxy || env.NO_PROXY || '').split(/[\s,]+/).filter(Boolean)) {
    if (entry === '*') return undefined;
    const match = entry.toLowerCase().match(/^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/);
    if (!match || (match[2] && match[2] !== port)) continue;
    const pattern = match[1]!.replace(/^\[|\]$/g, '');
    if (pattern.startsWith('*.') || pattern.startsWith('.')) {
      const suffix = pattern.replace(/^\*?\./, '');
      if (host === suffix || host.endsWith('.' + suffix)) return undefined;
    } else if (host === pattern) return undefined;
  }
  return proxy.href;
}

/** Injection points are constructor-side tests/configuration, not MCP fields.
 * They never permit disabling TLS identity checks or accepting private IPs. */
export type CallbackNetworkOptions = {
  proxyEnv?: NodeJS.ProcessEnv;
  lookup?: AddressLookup;
  ca?: ConnectionOptions['ca'];
  timeoutMs?: number;
  connectTimeoutMs?: number;
};

/** Use a normal CONNECT ClientRequest with an explicit owner for each socket.
 * This avoids Node 22's native proxy-agent pre-assignment cleanup edge cases. */
async function openProxyTunnel(proxyValue:string, target:string, port:number, signal:AbortSignal):Promise<net.Socket> {
  signal.throwIfAborted();
  const proxy=new URL(proxyValue);
  const authority=`${net.isIP(target)===6?'['+target+']':target}:${port}`;
  const headers:Record<string,string>={host:authority};
  if(proxy.username||proxy.password)headers['proxy-authorization']='Basic '+Buffer.from(
    decodeURIComponent(proxy.username)+':'+decodeURIComponent(proxy.password)).toString('base64');
  return new Promise((resolve,reject)=>{
    const request=(proxy.protocol==='https:'?https:http).request({
      protocol:proxy.protocol,hostname:proxy.hostname.replace(/^\[|\]$/g,''),
      port:proxy.port||(proxy.protocol==='https:'?443:80),method:'CONNECT',
      path:authority,headers,signal,agent:false,maxHeaderSize:16*1024,
    });
    request.once('connect',(response,socket,head)=>{
      if(response.statusCode!==200||head.length){
        socket.destroy();
        reject(response.statusCode===502||response.statusCode===504
          ?new CallbackConnectionError():new Error('callback_proxy_rejected'));
        return;
      }
      if(signal.aborted){socket.destroy();reject(new Error('callback_timeout'));return;}
      // TLS is installed immediately by the caller; retain an error observer
      // for the tiny handoff window and after a failed TLS handshake.
      socket.on('error',()=>{});
      resolve(socket);
    });
    request.once('response',response=>{response.destroy();request.destroy();reject(new Error('callback_proxy_rejected'));});
    request.once('error',reject);
    request.end();
  });
}

async function connectTls(host:string,port:number,identity:string,proxy:string|undefined,
  signal:AbortSignal,connectTimeout:number,ca?:ConnectionOptions['ca']):Promise<TLSSocket> {
  const deadline=new AbortController();
  const timer=setTimeout(()=>deadline.abort(),connectTimeout);
  const connecting=AbortSignal.any([signal,deadline.signal]);
  let raw:net.Socket|undefined;
  let socket:TLSSocket|undefined;
  try {
    connecting.throwIfAborted();
    if(proxy)raw=await openProxyTunnel(proxy,host,port,connecting);
    connecting.throwIfAborted();
    socket=tls.connect({
      ...(raw?{socket:raw}:{host,port}),
      servername:net.isIP(identity)?undefined:identity,
      rejectUnauthorized:true,ca,
      // For literal IP callbacks the identity is the same validated IP.
      checkServerIdentity:(_name,cert)=>tls.checkServerIdentity(identity,cert),
    });
    const secure=socket;
    await new Promise<void>((resolve,reject)=>{
      const abort=()=>{secure.destroy();reject(new Error('callback_timeout'));};
      const done=()=>{connecting.removeEventListener('abort',abort);resolve();};
      secure.once('secureConnect',done);
      secure.once('error',error=>{connecting.removeEventListener('abort',abort);reject(error);});
      if(connecting.aborted)abort();else connecting.addEventListener('abort',abort,{once:true});
    });
    signal.throwIfAborted();
    return secure;
  } catch(error) {
    socket?.destroy();raw?.destroy();
    const code=(error as NodeJS.ErrnoException).code;
    if(!signal.aborted&&(deadline.signal.aborted||error instanceof CallbackConnectionError||
      ['ECONNREFUSED','ENETUNREACH','EHOSTUNREACH','ETIMEDOUT'].includes(code??'')))throw new CallbackConnectionError();
    throw error;
  } finally {clearTimeout(timer);}
}

/** TLS must already be established before any webhook header or body is sent.
 * Post-handshake errors are never converted into pre-connection retry errors. */
async function exchange(url:URL,target:string,proxy:string|undefined,method:'GET'|'POST',body:string,
  headers:Record<string,string>,signal:AbortSignal,connectTimeout:number,maxBytes:number,ca?:ConnectionOptions['ca']):Promise<CallbackResponse> {
  const identity=url.hostname.replace(/^\[|\]$/g,'');
  const socket=await connectTls(target,Number(url.port||443),identity,proxy,signal,connectTimeout,ca);
  const agent=new https.Agent({keepAlive:false,maxCachedSessions:0});
  agent.createConnection=()=>socket;
  try {
    signal.throwIfAborted();
    return await new Promise<CallbackResponse>((resolve,reject)=>{
      const request=https.request({
        hostname:target,port:url.port||443,path:url.pathname+url.search,method,agent,signal,
        headers:{...headers,host:url.host,...(method==='POST'?{'content-length':String(Buffer.byteLength(body))}:{})},
        maxHeaderSize:16*1024,
      },response=>{
        const chunks:Buffer[]=[];let size=0;
        response.on('error',reject);
        response.on('data',(chunk:Buffer)=>{
          size+=chunk.length;
          if(size>maxBytes){const error=new Error('callback_response_too_large');reject(error);response.destroy(error);return;}
          chunks.push(chunk);
        });
        response.on('end',()=>{
          const status=response.statusCode??0,retry=response.headers['retry-after'];let retryAfterMs:number|undefined;
          if(typeof retry==='string') {
            const seconds=Number(retry);retryAfterMs=Number.isFinite(seconds)?Math.max(0,seconds*1000):Math.max(0,Date.parse(retry)-Date.now());
            if(!Number.isFinite(retryAfterMs))retryAfterMs=undefined;
          }
          resolve({ok:status>=200&&status<300,status,body:Buffer.concat(chunks).toString('utf8'),retryAfterMs});
        });
      });
      request.once('error',reject);request.end(method==='POST'?body:undefined);
    });
  } finally {socket.destroy();agent.destroy();}
}

/** Only this fixed, TLS-authenticated DNS bootstrap host uses proxy-side DNS.
 * Callback connections still target validated numeric answers. No callback
 * path, signature, challenge or event body is disclosed in the DNS query. */
export type ProxyDnsQuery = (host:string,type:'A'|'AAAA',proxy:string)=>Promise<unknown>;
const queryProxyDns:ProxyDnsQuery=async(host,type,proxy)=>{
  const url=new URL('https://cloudflare-dns.com/dns-query');
  url.searchParams.set('name',host);url.searchParams.set('type',type);
  const result=await exchange(url,'cloudflare-dns.com',proxy,'GET','',
    {accept:'application/dns-json'},AbortSignal.timeout(4000),3000,32*1024);
  if(result.status!==200)throw new Error('callback_dns_http_error');
  try{return JSON.parse(result.body);}catch{throw new Error('callback_dns_invalid_json');}
};

export async function resolveProxyDns(host:string,proxy:string,query:ProxyDnsQuery=queryProxyDns) {
  const results=await Promise.all((['A','AAAA'] as const).map(async type=>{
    const response=await query(host,type,proxy) as {Status?:number;TC?:boolean;Answer?:Array<{type?:number;data?:unknown}>};
    if(!response||response.Status!==0||response.TC)throw new Error('callback_dns_failed');
    if(response.Answer!==undefined&&!Array.isArray(response.Answer))throw new Error('callback_dns_invalid_answer');
    const family=type==='A'?4:6;
    return (response.Answer??[]).filter(r=>r.type===(type==='A'?1:28)).map(r=>{
      if(typeof r.data!=='string'||net.isIP(r.data)!==family)throw new Error('callback_dns_invalid_address');
      return {address:r.data,family};
    });
  }));
  return [...new Map(results.flat().map(r=>[r.address,r])).values()];
}

/** Validate at connection time; pin DNS; authenticate TLS; never redirect. */
export async function pinnedHttpsPost(value:string,body:string,headers:Record<string,string>,options:CallbackNetworkOptions={}):Promise<CallbackResponse> {
  const signal=AbortSignal.timeout(options.timeoutMs??10_000);
  const resolution=await Promise.race([
    resolvePublicCallback(value,options.lookup,options.proxyEnv??process.env),
    new Promise<never>((_,reject)=>signal.addEventListener('abort',()=>reject(new Error('callback_timeout')),{once:true})),
  ]);
  const proxy=callbackProxy(resolution.url,options.proxyEnv??process.env);
  return tryValidatedAddresses(resolution.addresses,target=>exchange(resolution.url,target.address,proxy,'POST',body,headers,
    signal,options.connectTimeoutMs??(proxy?5000:2000),64*1024,options.ca));
}
