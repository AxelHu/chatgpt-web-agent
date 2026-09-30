import { promises as dns } from 'node:dns';
import https from 'node:https';
import net from 'node:net';
import ipaddr from 'ipaddr.js';

export type CallbackResponse = { ok: boolean; status: number; body: string; retryAfterMs?: number };
export type AddressLookup = (host: string) => Promise<Array<{ address: string; family: number }>>;
export function isPublicAddress(address: string): boolean {
  try { return ipaddr.parse(address).range() === 'unicast'; } catch { return false; }
}
export async function resolvePublicCallback(value: string, lookup: AddressLookup = host => dns.lookup(host, { all: true, verbatim: true })) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('invalid_callback_url');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = net.isIP(host) ? [{ address: host, family: net.isIP(host) }] : await lookup(host);
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

/** Validate at connection time, pin DNS, verify TLS, never redirect.
 * Fail over only BEFORE TLS establishes a connection. After a request may have
 * reached the service, a persisted same-ID outbox retry handles ambiguity. */
export async function pinnedHttpsPost(value: string, body: string, headers: Record<string, string>): Promise<CallbackResponse> {
  const signal = AbortSignal.timeout(10_000);
  const resolution = await Promise.race([
    resolvePublicCallback(value),
    new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(new Error('callback_timeout')), { once: true })),
  ]);
  const { url, host, addresses } = resolution;
  return tryValidatedAddresses(addresses,target=>new Promise<CallbackResponse>((resolve,reject)=>{
    let connected=false;
    const request=https.request({
      hostname:host,port:url.port||443,path:url.pathname+url.search,
      servername:net.isIP(host)?undefined:host,method:'POST',signal,family:target.family,
      headers:{...headers,'content-length':String(Buffer.byteLength(body))},
      lookup:((_host:string,_options:unknown,callback:(error:NodeJS.ErrnoException|null,address:string,family:number)=>void)=>callback(null,target.address,target.family)) as never,
    },response=>{
      const chunks:Buffer[]=[];let size=0;
      response.on('error',reject);
      response.on('data',(chunk:Buffer)=>{
        size+=chunk.length;if(size>64*1024){response.destroy(new Error('callback_response_too_large'));return;}chunks.push(chunk);
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
    const connectTimer=setTimeout(()=>{if(!connected)request.destroy(new CallbackConnectionError());},2000);
    request.on('socket',socket=>socket.once('secureConnect',()=>{connected=true;clearTimeout(connectTimer);}));
    request.on('close',()=>clearTimeout(connectTimer));
    request.on('error',(error:NodeJS.ErrnoException)=>{
      clearTimeout(connectTimer);
      const retryable=error instanceof CallbackConnectionError || ['ECONNREFUSED','ENETUNREACH','EHOSTUNREACH','ETIMEDOUT'].includes(error.code??'');
      reject(!connected&&retryable&&!signal.aborted?new CallbackConnectionError():error);
    });
    request.end(body);
  }));
}
