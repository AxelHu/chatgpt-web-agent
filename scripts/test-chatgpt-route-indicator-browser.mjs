import assert from 'node:assert/strict';
import {readFileSync, writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {chromium} from 'playwright';

// All HTML, IDs and responses are synthetic. Every network request is fulfilled
// locally; this suite does not use an account or establish live-site acceptance.
const source = readFileSync(process.env.ROUTE_INDICATOR_SCRIPT || new URL('../userscripts/chatgpt-route-indicator.user.js', import.meta.url), 'utf8');
const A='11111111-1111-1111-1111-111111111111';
const B='22222222-2222-2222-2222-222222222222';
const badge='[data-chatgpt-actual-route="true"]';
const msg=(id,model,extra={},role='assistant')=>({id,author:{role},create_time:id==='a'?1:2,content:{content_type:'text',parts:[]},metadata:{model_slug:model,turn_exchange_id:`turn-${id}`,...extra}});
const payload=(messages,id)=>({...(id?{conversation_id:id}:{}),mapping:Object.fromEntries(messages.map(m=>[m.id,{message:m}]))});
const legacy=(id,attrs='')=>`<article data-turn-id="turn-${id}"><div data-message-author-role="assistant" data-message-id="${id}" ${attrs}><p>Synthetic reply ${id}</p></div></article>`;
const modern=(id,attrs='')=>`<article data-turn="assistant" data-turn-id="turn-${id}"><div data-message-id="${id}" ${attrs}><p>Synthetic reply ${id}</p></div></article>`;
const report={version:source.match(/@version\s+(.+)/)?.[1].trim(),sha256:createHash('sha256').update(source).digest('hex'),at:new Date().toISOString(),mode:'synthetic Chromium DOM/network regression, not a live ChatGPT acceptance test',checks:0,cases:[]};
const eq=(actual,expected,note)=>{assert.equal(actual,expected,note);report.checks++};
const ok=(value,note)=>{assert.ok(value,note);report.checks++};
const cases=[];
const test=(name,spec,run)=>cases.push({name,spec,run});
const snapshot=page=>page.evaluate(()=>({labels:[...document.querySelectorAll('[data-chatgpt-actual-route="true"]')].map(n=>({id:n.parentElement.closest('[data-message-id]')?.dataset.messageId||null,text:n.textContent,parent:n.parentElement.tagName})),pill:document.getElementById('chatgpt-route-indicator-host')?.shadowRoot?.getElementById('pill')?.textContent,focused:document.getElementById('chatgpt-route-indicator-host')?.shadowRoot?.getElementById('pill')?.dataset.focusedMessageId,version:document.getElementById('chatgpt-route-indicator-host')?.dataset.scriptVersion}));
async function waitLabel(page,id,text){await page.waitForFunction(({id,text})=>[...document.querySelectorAll('[data-chatgpt-actual-route="true"]')].some(n=>(id===null||n.parentElement.closest('[data-message-id]')?.dataset.messageId===id)&&n.textContent.includes(text)),{id,text},{timeout:4500})}
async function waitPill(page,text){await page.waitForFunction(text=>document.getElementById('chatgpt-route-indicator-host')?.shadowRoot?.getElementById('pill')?.textContent.includes(text),text,{timeout:4500})}
const common=[msg('a','gpt-6-pro',{resolved_model_slug:'gpt-6-pro'}),msg('b','gpt-6-luna')];

test('legacy model labels and viewport', {html:legacy('a','style="height:800px"')+legacy('b','style="height:800px"'),messages:common},async({page})=>{
 await waitLabel(page,'a','GPT-6 Pro / Astra');eq((await snapshot(page)).labels.length,2,'one badge per old-style message');
 await page.locator('[data-message-id="b"]').scrollIntoViewIfNeeded();await waitPill(page,'GPT-6 Luna');eq((await snapshot(page)).focused,'b','floating follows the second reply');
});
test('article markers without legacy author marker', {html:modern('a')+modern('b'),messages:common},async({page})=>{
 await waitLabel(page,'a','GPT-6 Pro / Astra');await waitLabel(page,'b','GPT-6 Luna');eq((await snapshot(page)).labels.length,2,'both new wrappers have inline labels');
});
test('metadata-only message IDs exclude users and tools', {html:'<section data-message-id="a">Reply</section><section data-message-id="u">User</section><section data-message-id="t">Tool</section>',messages:[...common,msg('u','gpt-6-sol',{},'user'),msg('t','gpt-6-sol',{},'tool')]},async({page})=>{
 await waitLabel(page,'a','GPT-6 Pro / Astra');eq((await snapshot(page)).labels.length,1,'author role comes from exact assistant metadata');
});
test('hybrid wrappers are deduplicated', {html:'<article data-turn="assistant" data-message-id="a"><div data-message-author-role="assistant" data-message-id="a">Reply</div></article>',messages:common},async({page})=>{
 await waitLabel(page,'a','GPT-6 Pro / Astra');eq((await snapshot(page)).labels.length,1,'nested same-message markers do not duplicate a label');
});
test('different phases in one turn keep exact models', {html:'<article data-turn="assistant" data-turn-id="shared"><div data-message-id="a">Reasoning</div><div data-message-id="b">Final</div></article>',messages:[msg('a','gpt-6-pro',{turn_exchange_id:'shared'}),msg('b','gpt-6-luna',{turn_exchange_id:'shared'})]},async({page})=>{
 await waitLabel(page,'a','GPT-6 Pro / Astra');await waitLabel(page,'b','GPT-6 Luna');eq((await snapshot(page)).labels.length,2,'the container does not add a third global label');
});
test('message identity and concrete DOM model on ancestor', {html:'<div data-message-id="a" data-message-model-slug="gpt-6-sol"><div data-message-role="assistant">Reply</div></div>',messages:[]},async({page})=>{
 await waitLabel(page,'a','GPT-6 Sol');eq((await snapshot(page)).labels.length,1,'ancestor ID/model preserved');await waitPill(page,'GPT-6 Sol');
});
test('turn-only wrapper uses unambiguous exchange evidence', {html:'<article data-turn="assistant" data-turn-id="turn-a">Reply</article>',messages:common},async({page})=>{
 await waitLabel(page,null,'GPT-6 Pro / Astra');ok(!(await snapshot(page)).labels[0].text.includes('Luna'),'not latest model from another turn');
});
test('ambiguous turn-only wrapper stays unknown', {html:'<article data-turn="assistant" data-turn-id="shared">Reply</article>',messages:[msg('a','gpt-6-pro',{turn_exchange_id:'shared'}),msg('b','gpt-6-luna',{turn_exchange_id:'shared'})]},async({page,requests})=>{
 await page.waitForFunction(()=>document.querySelector('[data-chatgpt-actual-route="true"]'));await page.waitForTimeout(550);
 eq((await snapshot(page)).labels[0].text,'actual model: unknown · unavailable','mixed concrete models are not guessed');ok(requests.some(r=>r.url.includes('/backend-api/')),'metadata was fetched before the assertion');
});
test('unmatched layout must not show global latest model', {html:'<div>Unrecognized reply container</div>',messages:common},async({page})=>{
 await waitPill(page,'no reply matched');await page.waitForTimeout(550);eq((await snapshot(page)).labels.length,0);ok(!(await snapshot(page)).pill.includes('GPT-6'),'no misleading global-model fallback');
});
test('React replacement restores one label', {html:modern('a'),messages:common},async({page})=>{
 await waitLabel(page,'a','GPT-6 Pro / Astra');await page.evaluate(()=>{const old=document.querySelector('[data-message-id="a"]');const n=document.createElement('div');n.dataset.messageId='a';n.textContent='Replacement';old.replaceWith(n)});
 await waitLabel(page,'a','GPT-6 Pro / Astra');eq((await snapshot(page)).labels.length,1);
});
test('site badge removal restores label without duplication', {html:modern('a'),messages:common},async({page})=>{
 await waitLabel(page,'a','GPT-6 Pro / Astra');await page.locator(badge).evaluate(n=>n.remove());await waitLabel(page,'a','GPT-6 Pro / Astra');eq((await snapshot(page)).labels.length,1);
});
test('attribute-only message ID reuse and role change', {html:modern('a'),messages:common},async({page})=>{
 await waitLabel(page,'a','GPT-6 Pro / Astra');await page.evaluate(()=>{document.querySelector('[data-message-id]').dataset.messageId='b'});await waitLabel(page,'b','GPT-6 Luna');
 await page.evaluate(()=>{document.querySelector('article').dataset.turn='user'});await page.waitForFunction(()=>!document.querySelector('[data-chatgpt-actual-route="true"]'));eq((await snapshot(page)).labels.length,0,'orphan badge removed after author changes');
});
test('attribute-only turn ID reuse', {html:'<article data-turn="assistant" data-turn-id="turn-a">Reply</article>',messages:common},async({page})=>{
 await waitLabel(page,null,'GPT-6 Pro / Astra');await page.evaluate(()=>{document.querySelector('article').dataset.turnId='turn-b'});await waitLabel(page,null,'GPT-6 Luna');eq((await snapshot(page)).labels.length,1);
});
test('continuous streaming cannot starve rendering', {html:modern('a','data-message-model-slug="gpt-6-pro"'),messages:[]},async({page})=>{
 await waitLabel(page,'a','GPT-6 Pro / Astra');const during=await page.evaluate(()=>new Promise(resolve=>{const n=document.querySelector('[data-message-id]');n.dataset.messageModelSlug='gpt-6-luna';let ticks=0,seen=false;const timer=setInterval(()=>{n.querySelector('p').textContent='stream '+(++ticks);document.dispatchEvent(new Event('scroll'));if(ticks<25&&n.querySelector('[data-chatgpt-actual-route]')?.textContent.includes('GPT-6 Luna'))seen=true;if(ticks===35){clearInterval(timer);resolve(seen)}},20)}));ok(during,'new model renders before continuous mutations stop');
});
test('nested scroll viewport excludes clipped replies', {html:'<div id="scroller" style="height:220px;overflow:auto">'+modern('a','style="height:450px"')+modern('b','style="height:450px"')+'</div>',messages:common},async({page})=>{
 await waitLabel(page,'a','GPT-6 Pro / Astra');await waitPill(page,'GPT-6 Pro / Astra');eq((await snapshot(page)).focused,'a','clipped lower reply is not selected');
 await page.evaluate(()=>{document.querySelector('#scroller').scrollTop=470});await waitPill(page,'GPT-6 Luna');eq((await snapshot(page)).focused,'b');
});
test('display contents message retains visible focus', {html:modern('a','style="display:contents"'),messages:common},async({page})=>{
 await waitLabel(page,'a','GPT-6 Pro / Astra');await waitPill(page,'GPT-6 Pro / Astra');eq((await snapshot(page)).focused,'a');
});
test('hidden message is not used as floating fallback', {html:modern('a','style="display:none"'),messages:common},async({page})=>{
 await waitLabel(page,'a','GPT-6 Pro / Astra');await waitPill(page,'no reply matched');eq((await snapshot(page)).focused,'');
});
test('same-count SPA navigation updates bindings', {html:modern('same'),response:({url})=>payload([msg('same',url.pathname.endsWith(B)?'gpt-6-luna':'gpt-6-pro')])},async({page})=>{
 await waitLabel(page,'same','GPT-6 Pro / Astra');await page.evaluate(id=>history.pushState({},'',`/c/${id}`),B);await waitLabel(page,'same','GPT-6 Luna');eq((await snapshot(page)).labels.length,1);
});
for(const kind of ['JSON','SSE'])test(`late ${kind} response from old chat is discarded`, {html:modern('same'),response:({url,state})=>{
 if(url.searchParams.has('late'))return new Promise(resolve=>{state.release=()=>resolve(kind==='SSE'?{sse:`data: ${JSON.stringify(payload([msg('same','gpt-6-sol')]))}\n\n`}:payload([msg('same','gpt-6-sol')]))});
 return payload([msg('same',url.pathname.endsWith(B)?'gpt-6-luna':'gpt-6-pro')]);
}},async({page,state})=>{
 await waitLabel(page,'same','GPT-6 Pro / Astra');await page.evaluate(({A,kind})=>{window.pending=fetch(kind==='SSE'?'/backend-api/conversation-stream?late=1':`/backend-api/conversation/${A}?late=1`).then(r=>r.text())},{A,kind});
 await page.waitForTimeout(30);await page.evaluate(id=>history.pushState({},'',`/c/${id}`),B);await waitLabel(page,'same','GPT-6 Luna');ok(typeof state.release==='function','delayed old-chat response captured');state.release();await page.evaluate(()=>window.pending);await page.waitForTimeout(150);ok((await snapshot(page)).labels[0].text.includes('GPT-6 Luna'),'late model cannot overwrite current chat');
});
test('background GET for another conversation is ignored', {html:modern('a'),response:({url})=>payload([msg('a',url.pathname.endsWith(B)?'gpt-6-luna':'gpt-6-pro')])},async({page})=>{
 await waitLabel(page,'a','GPT-6 Pro / Astra');await page.evaluate(id=>fetch(`/backend-api/conversation/${id}`).then(r=>r.json()),B);await page.waitForTimeout(120);ok((await snapshot(page)).labels[0].text.includes('GPT-6 Pro / Astra'));
});
test('SSE is observed without consuming original response', {html:modern('a'),response:({url})=>url.pathname.endsWith('-stream')?{sse:`data: ${JSON.stringify(payload([msg('a','gpt-6-sol')]))}\n\ndata: [DONE]\n\n`}:payload([])},async({page})=>{
 const response=await page.evaluate(()=>fetch('/backend-api/conversation-stream',{method:'POST',body:'synthetic-request'}).then(r=>r.text()));ok(response.endsWith('data: [DONE]\n\n'),'app sees complete unchanged stream');await waitLabel(page,'a','GPT-6 Sol');
});
test('resolved-only and cancelled responses remain honest', {html:modern('a')+modern('b'),messages:[msg('a',undefined,{resolved_model_slug:'gpt-6-pro'}),msg('b','gpt-6-luna',{reasoning_status:'reasoning_cancelled'})]},async({page})=>{
 await waitLabel(page,'a','unknown · resolved route: GPT-6 Pro / Astra');await waitLabel(page,'b','GPT-6 Luna · cancelled');eq((await snapshot(page)).labels.length,2);
});
test('user prose and code lookalikes do not get labels', {html:modern('a')+'<article data-turn="user"><div data-message-role="assistant" data-message-id="b">Quoted markup</div></article><pre><code data-message-role="assistant" data-message-id="c">Code sample</code></pre>',messages:[...common,msg('c','gpt-6-sol')]},async({page})=>{
 await waitLabel(page,'a','GPT-6 Pro / Astra');eq((await snapshot(page)).labels.length,1,'no labels inside user/quoted code');
});
test('idle rendering does not trigger repeated fallback traffic', {html:modern('a'),messages:common},async({page,requests})=>{
 await waitLabel(page,'a','GPT-6 Pro / Astra');const before=requests.filter(r=>r.url.includes('/backend-api/')).length;await page.waitForTimeout(3300);eq(requests.filter(r=>r.url.includes('/backend-api/')).length,before,'own badges do not create a refresh loop');eq(await page.evaluate(()=>localStorage.length+sessionStorage.length),0,'no persistent storage');
});

test('turn node with exact assistant message ID', {html:'<section data-turn-id="a">Reply with ID on turn</section>',messages:common},async({page})=>{
 await waitLabel(page,null,'GPT-6 Pro / Astra');eq((await snapshot(page)).labels.length,1);
});
test('flex column badge must not grow to message height', {html:modern('a','style="display:flex;flex-direction:column;height:300px"'),messages:common},async({page})=>{
 await waitLabel(page,'a','GPT-6 Pro / Astra');const geometry=await page.locator(badge).evaluate(n=>({height:n.getBoundingClientRect().height,top:n.getBoundingClientRect().top,contentBottom:n.parentElement.querySelector('p').getBoundingClientRect().bottom}));
 ok(geometry.height<35,'badge retains text height rather than 100% column height');ok(geometry.top>=geometry.contentBottom,'label is below reply text');
});
test('short clipped response cannot steal floating focus', {html:'<div id="scroller" style="height:240px;overflow:auto">'+modern('a','style="height:260px"')+modern('b','style="height:35px"')+'</div>',messages:common},async({page})=>{
 await waitLabel(page,'a','GPT-6 Pro / Astra');await waitPill(page,'GPT-6 Pro / Astra');eq((await snapshot(page)).focused,'a','short off-scrollport response excluded even inside window viewport');
});
test('long conversation keeps one badge per assistant', {html:Array.from({length:160},(_,i)=>modern('long-'+i)).join(''),messages:Array.from({length:160},(_,i)=>msg('long-'+i,i%2?'gpt-6-luna':'gpt-6-pro'))},async({page})=>{
 await waitLabel(page,'long-159','GPT-6 Luna');eq((await snapshot(page)).labels.length,160);await page.locator('[data-message-id="long-159"]').scrollIntoViewIfNeeded();await waitPill(page,'GPT-6 Luna');
});

test('new conversation transition before stream headers', {html:modern('a'),startPath:'/',response:({url,state})=>url.pathname==='/backend-api/conversation'?new Promise(resolve=>{state.release=()=>resolve({sse:`data: ${JSON.stringify(payload([msg('a','gpt-6-sol')],A))}\n\n`})}):payload([])},async({page,state})=>{
 await page.evaluate(()=>{window.creation=fetch('/backend-api/conversation',{method:'POST',body:'synthetic-new-chat'}).then(r=>r.text())});await page.waitForTimeout(30);
 await page.evaluate(id=>history.pushState({},'',`/c/${id}`),A);ok(typeof state.release==='function');state.release();await page.evaluate(()=>window.creation);await waitLabel(page,'a','GPT-6 Sol');
});
test('new conversation preserves metadata already observed', {html:modern('a'),startPath:'/',response:({url})=>url.pathname==='/backend-api/conversation'?{sse:`data: ${JSON.stringify(payload([msg('a','gpt-6-sol')],A))}\n\n`}:payload([])},async({page})=>{
 await page.evaluate(()=>fetch('/backend-api/conversation',{method:'POST',body:'synthetic-new-chat'}).then(r=>r.text()));await waitLabel(page,'a','GPT-6 Sol');
 await page.evaluate(id=>history.pushState({},'',`/c/${id}`),A);await page.waitForTimeout(180);ok((await snapshot(page)).labels[0].text.includes('GPT-6 Sol'),'initial stream metadata survives its own new-conversation URL');
});

test('new conversation stream cannot adopt unrelated navigation', {html:modern('a'),startPath:'/',response:({url,state})=>url.pathname==='/backend-api/conversation'?new Promise(resolve=>{state.release=()=>resolve({sse:`data: ${JSON.stringify(payload([msg('a','gpt-6-sol')],A))}\n\n`})}):payload([msg('a','gpt-6-luna')],B)},async({page,state})=>{
 await page.evaluate(()=>{window.creation=fetch('/backend-api/conversation',{method:'POST',body:'synthetic-new-chat'}).then(r=>r.text())});await page.waitForTimeout(30);
 await page.evaluate(id=>history.pushState({},'',`/c/${id}`),B);await waitLabel(page,'a','GPT-6 Luna');state.release();await page.evaluate(()=>window.creation);await page.waitForTimeout(150);ok((await snapshot(page)).labels[0].text.includes('GPT-6 Luna'),'creation proof must match the actual destination ID');
});

const browser=await chromium.launch({headless:true});
try {
 for(const {name,spec,run} of cases){
  if(process.env.ROUTE_TEST_CASE&&!name.includes(process.env.ROUTE_TEST_CASE))continue;
  const context=await browser.newContext({viewport:{width:1100,height:780}});const page=await context.newPage();const errors=[],requests=[],state={};const result={name,ok:false};
  page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>requests.push({url:r.url(),method:r.method()}));
  await page.route('**/*',async route=>{
   const url=new URL(route.request().url());
   if(url.pathname.startsWith('/backend-api/')){
    const data=spec.response?await spec.response({url,state}):payload(spec.messages||[]);
    await route.fulfill({contentType:data.sse?'text/event-stream':'application/json',body:data.sse||JSON.stringify(data)}).catch(()=>{});return;
   }
   await route.fulfill({contentType:'text/html',body:`<!doctype html><html><head><title>Synthetic route test</title></head><body>${spec.html}</body></html>`});
  });
  try {
   await page.addInitScript({content:source});await page.goto(`https://chatgpt.com${spec.startPath || `/c/${A}`}`);
   await run({page,context,requests,state});eq(errors.length,0,'no page errors');eq(requests.filter(r=>new URL(r.url).origin!=='https://chatgpt.com').length,0,'no cross-origin traffic');result.ok=true;
  } catch(e){result.error=e.message;result.snapshot=await snapshot(page).catch(()=>null);result.pageErrors=errors}
  finally {state.release?.();await context.close();report.cases.push(result);console.log(JSON.stringify(result))}
 }
} finally {await browser.close()}
report.ok=report.cases.length>0&&report.cases.every(t=>t.ok);report.scenarios=report.cases.length;
if(process.env.ROUTE_TEST_REPORT)writeFileSync(process.env.ROUTE_TEST_REPORT,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({ok:report.ok,version:report.version,scenarios:report.scenarios,checks:report.checks,failed:report.cases.filter(t=>!t.ok).map(t=>t.name)}));
if(!report.ok)process.exitCode=1;
