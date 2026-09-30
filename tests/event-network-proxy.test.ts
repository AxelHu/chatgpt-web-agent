import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import net, { type AddressInfo } from 'node:net';
import { execFileSync } from 'node:child_process';
import type { TLSSocket } from 'node:tls';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { callbackProxy, pinnedHttpsPost, resolveProxyDns, resolvePublicCallback, type CallbackNetworkOptions } from '../src/event-network.js';

let cert: Buffer, key: Buffer, certDir: string;
const cleanup: Array<()=>Promise<void>>=[];
beforeAll(()=>{
  certDir=fs.mkdtempSync(path.join(os.tmpdir(),'callback-proxy-cert-'));
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-sha256','-days','1',
    '-subj','/CN=callback.test','-addext','subjectAltName=DNS:callback.test',
    '-keyout',path.join(certDir,'key.pem'),'-out',path.join(certDir,'cert.pem')],{stdio:'ignore'});
  key=fs.readFileSync(path.join(certDir,'key.pem'));cert=fs.readFileSync(path.join(certDir,'cert.pem'));
});
afterAll(()=>fs.rmSync(certDir,{recursive:true,force:true}));
afterEach(async()=>{for(const fn of cleanup.splice(0).reverse())await fn();});

async function listen(server:http.Server|https.Server) {
  const sockets=new Set<net.Socket>();
  server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>{});});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  cleanup.push(async()=>{
    for(const s of sockets)s.destroy();
    await new Promise<void>(resolve=>server.close(()=>resolve()));
  });
  return {port:(server.address() as AddressInfo).port,sockets};
}

async function fixture(mode:'echo'|'redirect'|'large'|'drop'|'stall'|'trickle'|'reject-proxy'|'destination-failover'='echo') {
  const connects:Array<{target:string;headers:http.IncomingHttpHeaders}>=[];
  const requests:Array<{url:string;host:string;servername:string;body:string;headers:http.IncomingHttpHeaders}>=[];
  const upstreams=new Set<net.Socket>();
  const dest=https.createServer({key,cert},(req,res)=>{
    let body='';req.on('data',c=>body+=c);req.on('end',()=>{
      requests.push({url:req.url||'',host:req.headers.host||'',servername:(req.socket as TLSSocket).servername||'',body,headers:req.headers});
      if(mode==='drop'){req.socket.destroy();return;}
      if(mode==='redirect'){res.writeHead(302,{location:'https://127.0.0.1/forbidden'});res.end();return;}
      if(mode==='large'){res.end('x'.repeat(70*1024));return;}
      res.writeHead(200,{'content-type':'application/json'});res.end(body);
    });
  });
  dest.on('tlsClientError',()=>{});
  const target=await listen(dest);
  const proxy=http.createServer((_req,res)=>{res.writeHead(405);res.end();});
  proxy.on('connect',(req,socket,head)=>{
    connects.push({target:req.url||'',headers:req.headers});
    if(mode==='destination-failover'&&connects.length===1){
      socket.write('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n');
      socket.resume();socket.on('end',()=>socket.end());return;
    }
    if(mode==='stall'||mode==='trickle'){
      // Consume EOF so a destroyed client is observable on this half-open
      // server-side CONNECT socket rather than stuck in the paused read buffer.
      socket.resume();socket.on('end',()=>socket.end());
      if(mode==='trickle'){
        const timer=setInterval(()=>socket.write('X'),60);
        socket.once('close',()=>clearInterval(timer));
      }
      return;
    }
    if(mode==='reject-proxy'){
      socket.write('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n');
      socket.resume();socket.on('end',()=>socket.end());return;
    }
    const upstream=net.connect(target.port,'127.0.0.1');upstreams.add(upstream);
    upstream.on('close',()=>upstreams.delete(upstream));upstream.on('error',()=>socket.destroy());
    socket.on('close',()=>upstream.destroy());
    upstream.once('connect',()=>{
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if(head.length)upstream.write(head);
      socket.pipe(upstream);upstream.pipe(socket);
    });
  });
  const relay=await listen(proxy);
  cleanup.push(async()=>{for(const s of upstreams)s.destroy();});
  const options:CallbackNetworkOptions={
    proxyEnv:{HTTPS_PROXY:`http://127.0.0.1:${relay.port}`},ca:cert,
    lookup:async()=>[{address:'8.8.8.8',family:4}],timeoutMs:2000,connectTimeoutMs:1000,
  };
  return {options,connects,requests,relay};
}

describe('callback HTTPS proxy, real CONNECT and TLS',()=>{
  it('CONNECT pins the public IP while Host, SNI and TLS identity use the original domain',async()=>{
    const f=await fixture();const body=JSON.stringify({type:'verification',challenge:'unique-challenge'});
    const headers={'content-type':'application/json','webhook-signature':'test-only-signature','webhook-id':'verify-test'};
    const r=await pinnedHttpsPost('https://callback.test/path?private=value',body,headers,f.options);
    expect(r).toMatchObject({ok:true,status:200,body});
    expect(f.connects).toHaveLength(1);expect(f.connects[0]!.target).toBe('8.8.8.8:443');
    expect(JSON.stringify(f.connects)).not.toContain('test-only-signature');
    expect(JSON.stringify(f.connects)).not.toContain('private=value');
    expect(f.requests).toMatchObject([{host:'callback.test',servername:'callback.test',url:'/path?private=value',body}]);
    expect(f.requests[0]!.headers['webhook-signature']).toBe('test-only-signature');
  });
  it('honors lowercase HTTPS proxy from the operator environment',async()=>{
    const f=await fixture();f.options.proxyEnv={https_proxy:f.options.proxyEnv!.HTTPS_PROXY,HTTPS_PROXY:'http://127.0.0.1:1'};
    expect((await pinnedHttpsPost('https://callback.test/','{}',{},f.options)).ok).toBe(true);
  });
  it('retains the non-default original Host port and pins that destination port',async()=>{
    const f=await fixture();await pinnedHttpsPost('https://callback.test:8443/','{}',{},f.options);
    expect(f.connects[0]!.target).toBe('8.8.8.8:8443');expect(f.requests[0]!.host).toBe('callback.test:8443');
  });
  it('rejects untrusted certificates without exposing webhook data',async()=>{
    const f=await fixture();delete f.options.ca;
    await expect(pinnedHttpsPost('https://callback.test/','private-body',{'webhook-signature':'private-signature'},f.options)).rejects.toBeDefined();
    expect(f.requests).toHaveLength(0);expect(JSON.stringify(f.connects)).not.toContain('private');
  });
  it('rejects a certificate for a different original hostname',async()=>{
    const f=await fixture();await expect(pinnedHttpsPost('https://other.test/','private-body',{},f.options)).rejects.toMatchObject({code:'ERR_TLS_CERT_ALTNAME_INVALID'});
    expect(f.requests).toHaveLength(0);
  });
  it('never follows callback redirects through the proxy',async()=>{
    const f=await fixture('redirect');const r=await pinnedHttpsPost('https://callback.test/','{}',{},f.options);
    expect(r.status).toBe(302);expect(f.connects).toHaveLength(1);expect(f.requests).toHaveLength(1);
  });
  it('never connects a private callback via an otherwise trusted local proxy',async()=>{
    const f=await fixture();f.options.lookup=async()=>[{address:'127.0.0.1',family:4}];
    await expect(pinnedHttpsPost('https://callback.test/','{}',{},f.options)).rejects.toThrow('non_public_callback');
    expect(f.connects).toHaveLength(0);
  });
  it('rejects mixed DNS answers before opening the proxy tunnel',async()=>{
    const f=await fixture();f.options.lookup=async()=>[{address:'8.8.8.8',family:4},{address:'10.0.0.1',family:4}];
    await expect(pinnedHttpsPost('https://callback.test/','{}',{},f.options)).rejects.toThrow('non_public_callback');expect(f.connects).toHaveLength(0);
  });
  it('does not retry another IP after a POST may have reached the TLS endpoint',async()=>{
    const f=await fixture('drop');f.options.lookup=async()=>[{address:'8.8.8.8',family:4},{address:'1.1.1.1',family:4}];
    await expect(pinnedHttpsPost('https://callback.test/','{}',{},f.options)).rejects.toBeDefined();
    expect(f.connects).toHaveLength(1);expect(f.requests).toHaveLength(1);
  });
  it('bounds the response size',async()=>{
    const f=await fixture('large');await expect(pinnedHttpsPost('https://callback.test/','{}',{},f.options)).rejects.toThrow('callback_response_too_large');
    expect(f.requests).toHaveLength(1);
  });
  it('does not fall back to direct transport when the configured proxy rejects CONNECT',async()=>{
    const f=await fixture('reject-proxy');f.options.timeoutMs=200;
    await expect(pinnedHttpsPost('https://callback.test/','{}',{},f.options)).rejects.toBeDefined();
    await new Promise(r=>setTimeout(r,300));expect(f.relay.sockets.size).toBe(0);
    expect(f.connects).toHaveLength(1);expect(f.requests).toHaveLength(0);
  });
  it('tries the next validated IP for proxy destination failures before any callback TLS or POST',async()=>{
    const f=await fixture('destination-failover');
    f.options.lookup=async()=>[{address:'8.8.8.8',family:4},{address:'1.1.1.1',family:4}];
    const r=await pinnedHttpsPost('https://callback.test/','{}',{},f.options);
    expect(r.ok).toBe(true);expect(f.connects.map(c=>c.target)).toEqual(['8.8.8.8:443','1.1.1.1:443']);
    expect(f.requests).toHaveLength(1);
  });
  it('bounds and cleans up stalled CONNECT requests',async()=>{
    const f=await fixture('stall');f.options.timeoutMs=300;f.options.connectTimeoutMs=150;
    await expect(pinnedHttpsPost('https://callback.test/','{}',{},f.options)).rejects.toBeDefined();
    await new Promise(r=>setTimeout(r,200));
    expect(f.relay.sockets.size).toBe(0);
  });
  it('enforces an absolute deadline even if CONNECT keeps receiving bytes',async()=>{
    const f=await fixture('trickle');f.options.timeoutMs=250;f.options.connectTimeoutMs=2000;
    const start=Date.now();
    await expect(pinnedHttpsPost('https://callback.test/','{}',{},f.options)).rejects.toBeDefined();
    expect(Date.now()-start).toBeLessThan(1500);
    await new Promise(r=>setTimeout(r,150));expect(f.relay.sockets.size).toBe(0);
  });
});

describe('operator proxy selection is independent of callback data',()=>{
  it.each(['*','callback.test','.test','*.test','callback.test:443'])('honors NO_PROXY=%s for the original hostname',NO_PROXY=>{
    expect(callbackProxy(new URL('https://callback.test/path'),{HTTPS_PROXY:'http://127.0.0.1:1080',NO_PROXY})).toBeUndefined();
  });
  it('does not overmatch unrelated domains or ports',()=>{
    const env={HTTPS_PROXY:'http://127.0.0.1:1080',NO_PROXY:'callback.test:444,evilcallback.test,.other.test'};
    expect(callbackProxy(new URL('https://callback.test/'),env)).toBe('http://127.0.0.1:1080/');
  });
  it.each(['socks5://127.0.0.1:1080','not-a-url','http://127.0.0.1:1080/path','http://127.0.0.1:1080/#hash'])('fails closed for invalid proxy config %s',HTTPS_PROXY=>{
    expect(()=>callbackProxy(new URL('https://callback.test/'),{HTTPS_PROXY})).toThrow('invalid_callback_proxy');
  });
});

describe('TLS DNS result handling before a pinned proxy connection',()=>{
  it('queries both families, ignores aliases and deduplicates answers',async()=>{
    const calls:string[]=[];
    const result=await resolveProxyDns('callback.test','http://127.0.0.1:1080',async(host,type,proxy)=>{
      calls.push(type);expect(host).toBe('callback.test');expect(proxy).toBe('http://127.0.0.1:1080');
      return {Status:0,TC:false,Answer:type==='A'
        ?[{type:5,data:'alias.test'},{type:1,data:'1.1.1.1'},{type:1,data:'1.1.1.1'}]
        :[{type:28,data:'2606:4700:4700::1111'}]};
    });
    expect(calls.sort()).toEqual(['A','AAAA']);
    expect(result).toEqual([{address:'1.1.1.1',family:4},{address:'2606:4700:4700::1111',family:6}]);
  });
  it.each([{Status:2},{Status:3},{Status:0,TC:true},{},null])('rejects failed or truncated DNS %j',async result=>{
    await expect(resolveProxyDns('callback.test','http://127.0.0.1:1080',async()=>result)).rejects.toThrow('callback_dns_failed');
  });
  it('allows an empty AAAA set when valid IPv4 answers exist',async()=>{
    const result=await resolveProxyDns('callback.test','http://127.0.0.1:1080',async(_host,type)=>({Status:0,Answer:type==='A'?[{type:1,data:'1.1.1.1'}]:[]}));
    expect(result).toEqual([{address:'1.1.1.1',family:4}]);
  });
  it('rejects malformed answer data and mismatched address families',async()=>{
    await expect(resolveProxyDns('callback.test','http://127.0.0.1:1080',async()=>({Status:0,Answer:'wrong'}))).rejects.toThrow('callback_dns_invalid_answer');
    await expect(resolveProxyDns('callback.test','http://127.0.0.1:1080',async()=>({Status:0,Answer:[{type:1,data:'::1'}]}))).rejects.toThrow('callback_dns_invalid_address');
  });
  it('still rejects private DoH answers at the callback-validation boundary',async()=>{
    const query=async()=>({Status:0,Answer:[{type:1,data:'127.0.0.1'}]});
    await expect(resolvePublicCallback('https://callback.test/',host=>resolveProxyDns(host,'http://127.0.0.1:1080',query),{})).rejects.toThrow('non_public_callback');
  });
  it('fails closed on DNS transport errors rather than consulting system DNS',async()=>{
    await expect(resolveProxyDns('callback.test','http://127.0.0.1:1080',async()=>{throw new Error('dns_transport_failed');})).rejects.toThrow('dns_transport_failed');
  });
});
