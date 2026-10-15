import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// Test-only browser fixture. No Shopify/OpenAI requests, credentials, or purchases.
const asset = fileURLToPath(new URL('../../extensions/sales-assistant/assets/sales-assistant.js', import.meta.url));
const uiAsset = fileURLToPath(new URL('../../extensions/sales-assistant/assets/sales-assistant-ui.js', import.meta.url));
let price = '20.00';
let quantity = 0;
let consentRevocations = 0;
const counters = { loader: 0, uiModule: 0, bootstrap: 0, chat: 0, verify: 0, add: 0, change: 0, avatarModule: 0, avatarStart: 0, avatarResult: 0, avatarEnd: 0, avatarRespond: 0 };
const events = [];
const sessions = new Map();
let avatar = { sequence: 0, ended: true, userText: '' };
let mockAvatarBundle;
async function avatarBundle() {
  if (!mockAvatarBundle) {
    const result = await build({ entryPoints: [fileURLToPath(new URL('../../apps/widget/src/tavus.ts', import.meta.url))], bundle: true, write: false, format: 'esm', platform: 'browser', plugins: [{ name: 'synthetic-daily', setup(builder) { builder.onResolve({ filter: /^@daily-co\/daily-js$/ }, () => ({ path: fileURLToPath(new URL('./mock-daily.mjs', import.meta.url)) })); } }] });
    mockAvatarBundle = result.outputFiles[0].text;
  }
  return mockAvatarBundle;
}
const variant = () => ({ id: 'gid://shopify/ProductVariant/123', legacyId: '123', title: 'Test size · 30 units', price: { amount: price, currencyCode: 'EUR' }, availableForSale: true, currentlyNotInStock: false, quantityRule: { minimum: 1, maximum: 20, increment: 1 } });
const cart = () => ({ item_count: quantity, currency: 'EUR', total_price: quantity * Math.round(Number(price) * 100), items: quantity ? [{ key: '123:fixture-line', variant_id: 123, product_id: 100, title: 'Synthetic test product · 30 units', quantity, final_line_price: quantity * Math.round(Number(price) * 100) }] : [] });
const avatarResponse = () => ({ text: 'Ελεγμένη συνθετική απάντηση για δοκιμή εμφάνισης. Δεν συνδέεται με πραγματικό προϊόν ή πάροχο avatar.', products: [{ id: 'gid://shopify/Product/100', title: 'Synthetic test product', handle: 'synthetic-test-product', url: '/products/synthetic-test-product', imageUrl: null, variants: [variant()], requiresSellingPlan: false }], facts: [{ id: 'fixture-fact', text: 'TEST FIXTURE · No real product claims.', source: 'Local test harness' }] });
const send = (response, data, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(data)); };
async function body(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) { length += chunk.length; if (length > 32_768) throw new Error('Request too large'); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString() || '{}');
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || '/', 'http://127.0.0.1:3101');
    const path = url.pathname;
    if (request.method === 'GET' && path === '/__fixture/mobile') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(`<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>TEST FIXTURE · 390 × 844 viewport</title><style>body{margin:24px;background:#eceee9;color:#213e2d;font:16px/1.5 system-ui,sans-serif}h1{font-size:22px}iframe{display:block;width:390px;height:844px;border:0;background:white;box-shadow:0 0 0 1px #a8b6a5}a{color:#174c38}</style></head><body><h1>TEST FIXTURE · Fixed 390 × 844 viewport</h1><p>Synthetic catalog only. No Shopify connection or real purchases. The inner frame uses the actual storefront widget.</p><p><a href="/">Full-size fixture</a></p><iframe id="mobile-fixture" title="Synthetic mobile storefront fixture" width="390" height="844" src="/?locale=el"></iframe></body></html>`); return;
    }
    if (request.method === 'GET' && path === '/sales-assistant.js') {
      counters.loader++;
      response.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' }); response.end(await readFile(asset)); return;
    }
    if (request.method === 'GET' && path === '/sales-assistant-ui.js') {
      counters.uiModule++;
      response.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' }); response.end(await readFile(uiAsset)); return;
    }
    if (request.method === 'GET' && path === '/sales-assistant-avatar.js') {
      counters.avatarModule++; response.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' }); response.end(await avatarBundle()); return;
    }
    if (request.method === 'POST' && path === '/__fixture/avatar/respond') {
      const input = await body(request); avatar = { sequence: avatar.sequence + 1, ended: false, userText: typeof input.text === 'string' ? input.text.slice(0, 1500) : '' }; counters.avatarRespond++; send(response, { ok: true }); return;
    }
    if (request.method === 'GET' && path === '/__fixture/state') {
      send(response, { counters, cartQuantity: quantity, livePrice: price, consentRevocations, eventNames: events }); return;
    }
    if (request.method === 'POST' && path === '/__fixture/reset') {
      quantity = 0; price = '20.00'; consentRevocations = 0; events.length = 0; sessions.clear(); avatar = { sequence: 0, ended: true, userText: '' };
      for (const key of Object.keys(counters)) counters[key] = 0;
      send(response, { ok: true }); return;
    }
    if (request.method === 'POST' && path === '/__fixture/price') { price = price === '20.00' ? '21.00' : '20.00'; send(response, { price }); return; }
    if (request.method === 'GET' && (path === '/cart.js' || path === '/el/cart.js')) { send(response, cart()); return; }
    if (request.method === 'POST' && /\/(?:el\/)?cart\/add\.js$/.test(path)) {
      const input = await body(request);
      if (String(input.items?.[0]?.id) !== '123' || !Number.isInteger(input.items[0].quantity)) { send(response, { error: 'invalid fixture item' }, 422); return; }
      quantity += input.items[0].quantity; counters.add++; send(response, cart()); return;
    }
    if (request.method === 'POST' && /\/(?:el\/)?cart\/change\.js$/.test(path)) {
      const input = await body(request);
      if (input.id !== '123:fixture-line' || !Number.isInteger(input.quantity)) { send(response, { error: 'invalid fixture line' }, 422); return; }
      quantity = input.quantity; counters.change++; send(response, cart()); return;
    }
    const endpoint = /^\/apps\/sales-agent(?:-control|-avatar)?(\/.*)$/.exec(path)?.[1];
    if (request.method === 'POST' && endpoint) {
      const input = await body(request);
      if (endpoint === '/bootstrap') {
        counters.bootstrap++;
        const conversationId = crypto.randomUUID();
        const assignment = input.analyticsConsent ? path.includes('sales-agent-control') ? 'control' : 'assistant' : 'untracked';
        const token = `fixture-${conversationId}`;
        sessions.set(token, { analyticsConsent: input.analyticsConsent, assignment });
        send(response, { token, conversationId, assignment, experimentId: 'fixture-v1', brand: 'TEST · Shopping assistant', enabled: true, knowledgeVersion: 'fixture-v1', ...(path.includes('sales-agent-avatar') ? { avatar: { provider: 'tavus', previewOnly: true, maxDurationSeconds: 180 } } : {}) }); return;
      }
      const session = sessions.get(input.token);
      if (!session) { send(response, { error: 'fixture session missing' }, 401); return; }
      if (endpoint === '/consent') { session.analyticsConsent = false; consentRevocations++; send(response, { ok: true }); return; }
      if (endpoint === '/events') { if (session.analyticsConsent) for (const event of input.events || []) events.push(event.name); send(response, { ok: true }); return; }
      if (session.assignment === 'control') { send(response, { error: 'control arm' }, 403); return; }
      if (endpoint === '/avatar/start') {
        if (input.accessCode !== 'test-only') { send(response, { error: 'synthetic code required' }, 403); return; }
        counters.avatarStart++; avatar = { sequence: 0, ended: false, userText: '' };
        send(response, { sessionId: 'synthetic-session', conversationId: 'synthetic-conversation', conversationUrl: 'https://fixture.daily.co/not-a-real-room', meetingToken: 'synthetic-token', expiresAt: new Date(Date.now() + 180000).toISOString() }); return;
      }
      if (endpoint === '/avatar/result') { counters.avatarResult++; send(response, { sequence: avatar.sequence, ended: avatar.ended, ...(avatar.sequence > input.after ? { response: avatarResponse(), userText: avatar.userText } : {}) }); return; }
      if (endpoint === '/avatar/end') { counters.avatarEnd++; avatar.ended = true; send(response, { ok: true }); return; }
      if (endpoint === '/chat') {
        counters.chat++;
        send(response, {
          text: input.locale === 'el' ? 'Δοκιμαστικό προϊόν από συνθετικό κατάλογο. Δεν πραγματοποιούνται πραγματικές αγορές.' : 'This synthetic product tests the widget. No real purchases are possible.',
          products: [{ id: 'gid://shopify/Product/100', title: 'Synthetic test product', handle: 'synthetic-test-product', url: '/products/synthetic-test-product', imageUrl: null, variants: [variant()], requiresSellingPlan: false }],
          facts: [{ id: 'fixture-fact', text: 'TEST FIXTURE · No real product claims.', source: 'Local test harness' }],
          pendingAction: { kind: 'add', variantId: variant().id, quantity: 1 },
        }); return;
      }
      if (endpoint === '/variants/verify') { counters.verify++; send(response, { variant: variant(), requiresSellingPlan: false }); return; }
      send(response, { error: 'unknown fixture endpoint' }, 404); return;
    }
    if (request.method === 'GET') {
      const control = url.searchParams.get('arm') === 'control';
      const greek = url.searchParams.get('locale') !== 'en';
      const consent = url.searchParams.get('consent') !== 'no';
      const avatarMock = url.searchParams.get('avatar') === 'mock';
      const themeRole = url.searchParams.get('theme') === 'main' ? 'main' : 'unpublished';
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(`<!doctype html><html lang="${greek ? 'el' : 'en'}"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>TEST FIXTURE · Sales assistant</title><style>
body{margin:0;background:#f4f5f0;color:#213e2d;font:16px/1.55 system-ui,sans-serif}.banner{background:#78360c;color:#fff;padding:12px 24px;font-weight:750}main{max-width:980px;margin:auto;padding:36px 24px 140px}h1{font-size:42px;line-height:1.15;max-width:660px}h2{font-size:19px}a{color:#174c38}button{padding:10px 16px;min-height:44px;background:white;border:1px solid #a8b6a5;border-radius:8px;cursor:pointer;font:inherit}.controls{display:flex;align-items:center;gap:14px;flex-wrap:wrap;background:#e4ebdf;padding:20px;border-radius:14px}.tile{margin-top:28px;background:#fff;padding:24px;border-radius:16px;border:1px solid #d9e1d3}pre{font-size:13px;white-space:pre-wrap;overflow-wrap:anywhere}label{display:flex;align-items:center;gap:8px}input{width:20px;height:20px}nav{display:flex;gap:18px;flex-wrap:wrap}.note{font-size:14px;color:#506451}
/* Regression: real themes hide empty light-DOM divs, including shadow hosts. */
div:empty{display:none!important}
</style></head><body><div class="banner">TEST FIXTURE · Synthetic catalog · No Shopify connection · No real purchases</div><main><nav><a href="/?locale=el">Greek assistant</a><a href="/?locale=en">English assistant</a><a href="/?arm=control">Control arm</a><a href="/?consent=no">Without analytics consent</a></nav><h1>Test the actual storefront assistant</h1><p>This page loads the built theme extension asset. Its API and cart are local synthetic test endpoints.</p><div class="controls"><label><input id="consent" type="checkbox" ${consent ? 'checked' : ''}>Analytics consent</label><button id="reset" type="button">Reset fixture</button><button id="price" type="button">Change live test price</button><button id="refresh" type="button">Refresh test evidence</button></div><div class="tile"><h2>Fixture evidence</h2><p class="note">Only event names, request counts and DOM visibility checks appear here; message text and session tokens are omitted. A deliberately hostile empty-div rule must hide its probe while leaving the treatment launcher visible before and after opening the panel.</p><pre id="evidence" aria-live="polite">Loading…</pre><div id="empty-theme-probe"></div></div><div class="tile"><h2>Suggested checks</h2><p>Open the assistant, send a test query, confirm add, change quantity, and remove the item. Escape should close the dialog and return focus to its launcher. Control arm should hide the launcher. With consent disabled, shopping should work with no new analytics events.</p><p>To test price changes, first display a product card, close the assistant, change the test price here, then reopen and confirm add. The first click must update the card without mutating the cart.</p></div></main>
<script>
window.Shopify={routes:{root:'${greek ? '/el/' : '/'}'},customerPrivacy:{analyticsProcessingAllowed:()=>document.getElementById('consent').checked},analytics:{publish:(name,data)=>{document.dispatchEvent(new CustomEvent('fixture:published',{detail:{name,assignment:data.assignment}}));return true;}}};
document.getElementById('consent').addEventListener('change',()=>document.dispatchEvent(new CustomEvent('visitorConsentCollected',{detail:{analyticsAllowed:window.Shopify.customerPrivacy.analyticsProcessingAllowed()}})));
function visibilityEvidence(){
  const host=document.querySelector('[data-sales-agent]');const launcher=host?.shadowRoot?.querySelector('.launcher');const dialog=host?.shadowRoot?.querySelector('dialog');
  const visible=element=>!!element&&element.getClientRects().length>0&&getComputedStyle(element).display!=='none'&&getComputedStyle(element).visibility!=='hidden';
  return {emptyThemeRuleActive:getComputedStyle(document.getElementById('empty-theme-probe')).display==='none',hostStillEmpty:host?.matches(':empty')??false,hostDisplay:host?getComputedStyle(host).display:null,launcherVisible:visible(launcher),dialogOpen:dialog?.open??false,dialogVisible:visible(dialog)};
}
async function evidence(){document.getElementById('evidence').textContent=JSON.stringify({...await(await fetch('/__fixture/state')).json(),visibility:visibilityEvidence()},null,2);}
document.getElementById('refresh').onclick=evidence;
document.getElementById('reset').onclick=async()=>{await fetch('/__fixture/reset',{method:'POST'});location.reload();};
document.getElementById('price').onclick=async()=>{await fetch('/__fixture/price',{method:'POST'});await evidence();};
document.addEventListener('sales-agent:cart-updated',evidence);setInterval(evidence,1500);evidence();
</script>${avatarMock ? '<p style="padding:16px">SYNTHETIC AVATAR MODE · Code: test-only. Canvas placeholder only; no Tavus, camera or microphone connection.</p>' : ''}<div data-sales-agent data-ui-url="/sales-assistant-ui.js" data-avatar-url="/sales-assistant-avatar.js" data-theme-role="${themeRole}" data-endpoint="/apps/sales-agent${control ? '-control' : avatarMock ? '-avatar' : ''}" data-root="${greek ? '/el/' : '/'}" data-country="GR" data-locale="${greek ? 'el' : 'en'}"></div><script src="/sales-assistant.js" defer></script></body></html>`); return;
    }
    send(response, { error: 'unknown fixture route' }, 404);
  } catch { send(response, { error: 'fixture request failed' }, 500); }
});
server.listen(3101, '127.0.0.1', () => { process.stdout.write('TEST FIXTURE ONLY: http://127.0.0.1:3101/\n'); });
