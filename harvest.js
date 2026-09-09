// harvest.js — one-command account enrollment: pulls the full meta.ai cookie jar
// (httpOnly included) from a local Chrome CDP session, mints the ecto1 token from
// YOUR residential IP, and enrolls the account on a deployed META//FLOW proxy.
//
// usage:  node harvest.js <proxy-url> <enroll-key> [chrome-debug-port] [label]
//   e.g.:  node harvest.js https://metaflow-production-f4bb.up.railway.app abc123... 9222 burner-1
//
// Requires: Chrome running with --remote-debugging-port=<port> and a meta.ai tab
// where you are logged in (any tab works — cookies are browser-wide).
const fs = require('fs');

const PROXY = process.argv[2];
const KEY = process.argv[3];
const CDP_PORT = parseInt(process.argv[4] || '9222', 10);
const LABEL = process.argv[5] || ('browser-' + Date.now().toString(36));
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';

if (!PROXY || !KEY) {
  console.error('usage: node harvest.js <proxy-url> <enroll-key> [chrome-debug-port] [label]');
  process.exit(2);
}

async function getCookieJar() {
  const v = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`).then(r => r.json());
  const list = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then(r => r.json());
  const t = list.find(x => x.type === 'page' && x.url.includes('meta.ai'));
  let target = t;
  if (!target) {
    // no meta.ai tab — use the first page tab (cookies are browser-wide)
    target = list.find(x => x.type === 'page');
    if (!target) throw new Error('no page tab found on CDP port ' + CDP_PORT + ' — open meta.ai in that Chrome');
    console.log('note: no meta.ai tab found, using tab:', (target.url || '').slice(0, 60));
  }
  const ws = new WebSocket(v.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  function send(method, params, sessionId) {
    return new Promise((resolve, reject) => {
      const mid = ++id;
      pending.set(mid, { resolve, reject });
      ws.send(JSON.stringify({ id: mid, method, params, ...(sessionId ? { sessionId } : {}) }));
      setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); reject(new Error('timeout ' + method)); } }, 20000);
    });
  }
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
    }
  };
  const { sessionId } = await send('Target.attachToTarget', { targetId: target.id, flatten: true });
  await send('Network.enable', {}, sessionId).catch(() => {});
  const { cookies } = await send('Network.getCookies', { urls: ['https://www.meta.ai/', 'https://meta.ai/'] }, sessionId);
  try { ws.close(); } catch {}
  const jar = cookies.map(c => c.name + '=' + c.value).join('; ');
  const names = cookies.map(c => c.name);
  if (!names.includes('ecto_1_sess') || !names.includes('datr')) {
    throw new Error('cookie jar missing ecto_1_sess/datr (not logged in?): ' + names.join(','));
  }
  return jar;
}

async function mintToken(jar) {
  const res = await fetch('https://www.meta.ai/', {
    headers: { 'Cookie': jar, 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9' },
  });
  const html = await res.text();
  const m = html.match(/ecto1:[A-Za-z0-9_-]+/);
  if (!m) throw new Error('token mint failed (status ' + res.status + ') — run from a residential IP with a valid session');
  return m[0];
}

(async () => {
  console.log('[1/3] pulling cookie jar from Chrome CDP :' + CDP_PORT + ' …');
  const jar = await getCookieJar();
  console.log('      jar OK (' + jar.length + ' chars)');
  console.log('[2/3] minting ecto1 token from this IP …');
  const token = await mintToken(jar);
  console.log('      token OK (' + token.slice(0, 16) + '…)');
  console.log('[3/3] enrolling on ' + PROXY + ' …');
  const res = await fetch(PROXY.replace(/\/$/, '') + '/api/enroll', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: KEY, label: LABEL, cookie: jar, token }),
  });
  const body = await res.text();
  if (!res.ok) { console.error('      ENROLL FAILED:', res.status, body.slice(0, 200)); process.exit(1); }
  console.log('      ✓', body);
  console.log('done — account is live on the proxy.');
  process.exit(0);
})().catch(e => { console.error('HARVEST FAILED:', e.message); process.exit(1); });
