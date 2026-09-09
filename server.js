// server.js — Meta AI proxy + control-plane server.
// Standalone Node (no deps). Serves the web UI from public/ and exposes:
//   OpenAI-compat: POST /v1/chat/completions (SSE + JSON), GET /v1/models
//   Admin API:     /api/status /api/accounts /api/logs /api/config /api/cleanup /api/login
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const lib = require('./meta_lib.js');

const PORT = parseInt(process.env.PORT || '3117', 10);
const HOST = process.env.HOST || '0.0.0.0'; // 0.0.0.0 for Railway/Spaces; set HOST=127.0.0.1 locally if desired
const DATA = __dirname;
const DATA_DIR = process.env.DATA_DIR || DATA;

// ---------- persistent state ----------
const statePath = DATA_DIR + '/state.json';
const state = {
  adminPassword: process.env.ADMIN_PASSWORD || 'meta-admin',
  apiKey: process.env.API_KEY || '',
  enrollKey: process.env.ENROLL_KEY || '',
  attachMessage: 'continue as {{char}}',
  corsEnabled: true,
  autoDelete: true,
  defaultMode: 'fast',
  attachThreshold: 24000, // chars — above this, history rides as a document
  quietMs: 5000,
  hardMs: 180000,
};
const accounts = []; // {id,label,cookie,token,stats,cooldownUntil,busy,lastUsed,addedAt}
const logs = [];    // ring buffer
const sessions = new Map(); // adminToken -> {created}

function saveState() {
  try {
    fs.writeFileSync(statePath, JSON.stringify({
      state,
      accounts: accounts.map(a => ({ id: a.id, label: a.label, cookie: a.cookie, token: a.token, stats: a.stats, cooldownUntil: a.cooldownUntil, addedAt: a.addedAt })),
    }, null, 1));
  } catch {}
}
function loadState() {
  try {
    const d = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    Object.assign(state, d.state || {});
    for (const a of d.accounts || []) {
      accounts.push({ ...a, busy: false, lastUsed: 0 });
    }
  } catch {}
}
function logEvent(o) {
  logs.unshift({ t: Date.now(), ...o });
  if (logs.length > 300) logs.length = 300;
}

// ---------- account pool ----------
function seedFirstAccount() {
  if (accounts.length) return;
  // seed from the live-verified session files if present
  try {
    const cookie = process.env.SEED_COOKIE || fs.readFileSync(DATA + '/../meta_cookies.txt', 'utf8').trim();
    const token = process.env.SEED_TOKEN || fs.readFileSync(DATA + '/../ecto1_token.txt', 'utf8').trim();
    if (cookie && token) {
      accounts.push({
        id: crypto.randomUUID(), label: 'primary', cookie, token,
        stats: { requests: 0, successes: 0, failures: 0, deleted: 0 },
        cooldownUntil: 0, busy: false, lastUsed: 0, addedAt: Date.now(),
      });
      saveState();
      logEvent({ ev: 'account-seeded', label: 'primary' });
    }
  } catch {}
}

function pickAccount() {
  const now = Date.now();
  const ready = accounts.filter(a => !a.busy && (a.cooldownUntil || 0) < now);
  if (!ready.length) return null;
  ready.sort((a, b) => (a.lastUsed || 0) - (b.lastUsed || 0));
  return ready[0];
}

function acquireAccount(timeoutMs = 90000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tryPick = () => {
      const acc = pickAccount();
      if (acc) { acc.busy = true; resolve(acc); return; }
      if (Date.now() - start > timeoutMs) { reject(new Error('no idle account available')); return; }
      setTimeout(tryPick, 400);
    };
    tryPick();
  });
}

function releaseAccount(acc) {
  acc.busy = false;
  acc.lastUsed = Date.now();
  saveState();
}

async function ensureToken(acc) {
  if (acc.token) return acc.token;
  acc.token = await lib.mintToken(acc.cookie);
  saveState();
  return acc.token;
}

// ---------- core: one chat completion ----------
async function runCompletion({ messages, model, stream, onDelta, onThink, acc }) {
  const mode = /think|pro|reason/i.test(model) ? 'think' : 'fast';
  const prompt = lib.messagesToPrompt(messages);
  const conv = crypto.randomUUID();

  const token = await ensureToken(acc);
  const s = new lib.MetaSession(conv, token);
  await s.connect();
  logEvent({ ev: 'session-open', conv, account: acc.label, mode });

  let result;
  acc.stats.requests++;
  try {
    const opts = { quietMs: state.quietMs + (mode === 'think' ? 4000 : 0), hardMs: state.hardMs, onDelta, onThink };
    if (prompt.length > state.attachThreshold) {
      // big context → document attachment path (verified to ~2MB)
      const mediaId = await lib.uploadDocument({
        cookie: acc.cookie, token,
        data: Buffer.from(prompt, 'utf8'),
        filename: 'context.txt', mime: 'text/plain',
      });
      logEvent({ ev: 'doc-upload', conv, mediaId, size: prompt.length, account: acc.label });
      result = await s.askAttach(
        state.attachMessage || 'continue as {{char}}',
        mediaId, 'text/plain', 'context.txt', mode, { ...opts, quietMs: 25000 },
      );
    } else {
      result = await s.ask(prompt, mode, opts);
    }
  } catch (e) {
    acc.stats.failures++;
    saveState();
    throw e;
  } finally {
    // auto-delete the conversation (incognito-equivalent)
    if (state.autoDelete) {
      try {
        const ok = await lib.deleteConversation(acc.cookie, conv);
        if (ok) { acc.stats.deleted++; logEvent({ ev: 'conversation-deleted', conv, account: acc.label }); }
      } catch {}
    }
    s.close();
  }
  const fin = result.finish || (result.timeout ? 'timeout' : 'complete');
  if (fin === 'complete') acc.stats.successes++;
  else if (fin === 'partial') acc.stats.partials = (acc.stats.partials || 0) + 1;
  else acc.stats.failures++;
  logEvent({
    ev: 'completion', conv, account: acc.label, mode, ms: result.ms,
    answerChars: (result.answer || '').length, frames: result.frames,
    finish: result.finish || (result.timeout ? 'timeout' : 'complete'), attached: prompt.length > state.attachThreshold,
  });
  saveState();
  return { ...result, conv, mode, finish: result.finish || (result.timeout ? 'timeout' : 'complete') };
}

// ---------- HTTP plumbing ----------
function corsHeaders() {
  if (!state.corsEnabled) return {};
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { ...corsHeaders(), 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
async function readBody(req, limit = 60 * 1024 * 1024) {
  let size = 0; const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error('body too large');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}
function auth(req) {
  const h = req.headers['authorization'] || '';
  const token = h.replace(/^Bearer\s+/i, '').trim();
  return token && sessions.has(token) ? sessions.get(token) : null;
}
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
const PUB = path.join(DATA, 'public');
function serveStatic(res, urlPath) {
  let p = urlPath === '/' ? '/index.html' : urlPath;
  p = p.split('?')[0];
  const file = path.normalize(path.join(PUB, p));
  if (!file.startsWith(PUB)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

// ---------- request handler ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }
  try {
    // --- public: login ---
    if (p === '/api/login' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString('utf8'));
      if (body.password !== state.adminPassword) { json(res, 401, { error: 'bad password' }); return; }
      const token = crypto.randomBytes(24).toString('hex');
      sessions.set(token, { created: Date.now() });
      json(res, 200, { token });
      return;
    }

    // --- OpenAI-compatible (accept admin bearer too) ---
    if (p === '/v1/models' && req.method === 'GET') {
      json(res, 200, { object: 'list', data: [
        { id: 'meta-instant', object: 'model', owned_by: 'meta-ai', meta: { mode: 'fast', engine: 'Muse Spark (instant)' } },
        { id: 'meta-thinking', object: 'model', owned_by: 'meta-ai', meta: { mode: 'think', engine: 'Muse Spark (thinking)' } },
      ] });
      return;
    }

    if (p === '/v1/chat/completions' && req.method === 'POST') {
      if (state.apiKey) {
        const h = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim();
        if (!h || (h !== state.apiKey && !sessions.has(h))) { json(res, 401, { error: 'invalid api key (set Authorization: Bearer <key>)' }); return; }
      }
      const body = JSON.parse((await readBody(req)).toString('utf8'));
      const messages = body.messages || [];
      const model = body.model || 'meta-instant';
      const stream = !!body.stream;
      if (!messages.length) { json(res, 400, { error: 'messages required' }); return; }
      let acc;
      try { acc = await acquireAccount(); }
      catch (e) { json(res, 503, { error: e.message }); return; }

      const id = 'chatcmpl-' + crypto.randomBytes(8).toString('hex');
      const created = Math.floor(Date.now() / 1000);

      if (!stream) {
        try {
          const r = await runCompletion({ messages, model, stream: false, acc });
          releaseAccount(acc);
          json(res, 200, {
            id, object: 'chat.completion', created, model,
            choices: [{ index: 0, message: { role: 'assistant', content: r.answer || '' }, finish_reason: r.finish === 'complete' ? 'stop' : 'length' }],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
            meta: { conversation: r.conv, mode: r.mode, latency_ms: r.ms, account: acc.label },
          });
        } catch (e) {
          releaseAccount(acc);
          acc.stats.failures++; saveState();
          json(res, 502, { error: 'upstream failure: ' + e.message });
        }
        return;
      }

      // streaming (SSE)
      res.writeHead(200, {
        ...corsHeaders(),
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      let clientGone = false;
      req.on('close', () => { clientGone = true; });
      const send = (obj) => { if (!clientGone) res.write('data: ' + JSON.stringify(obj) + '\n\n'); };
      send({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
      try {
        const r = await runCompletion({
          messages, model, stream: true, acc,
          onThink: (d) => send({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { reasoning_content: d }, finish_reason: null }] }),
        });
        // authoritative answer, replayed in paced chunks (Meta's raw answer deltas are
        // tail-fragments out of order — buffering guarantees correct SSE assembly)
        const finalAnswer = r.answer || '';
        const chunkSize = Math.max(28, Math.ceil(finalAnswer.length / 150));
        for (let i = 0; i < finalAnswer.length; i += chunkSize) {
          if (clientGone) break;
          send({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { content: finalAnswer.slice(i, i + chunkSize) }, finish_reason: null }] });
          await new Promise(rr => setTimeout(rr, 45));
        }
        const finReason = r.finish === 'complete' ? 'stop' : 'length';
        send({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {}, finish_reason: finReason }], meta: { conversation: r.conv, mode: r.mode, latency_ms: r.ms, account: acc.label, deleted: state.autoDelete, final_answer: finalAnswer, finish: r.finish } });
      } catch (e) {
        send({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { content: '\n[proxy error: ' + e.message + ']' }, finish_reason: 'stop' }] });
      }
      res.write('data: [DONE]\n\n');
      res.end();
      releaseAccount(acc);
      return;
    }

    // --- enrollment (key auth + CORS): used by the CDP harvester / bookmarklet ---
    // /api/enroll preflight handled by the global OPTIONS catch-all + corsHeaders
    if (p === '/api/enroll' && req.method === 'POST') {
      let body = {};
      try { body = JSON.parse((await readBody(req)).toString('utf8')); } catch {}
      if (!state.enrollKey || body.key !== state.enrollKey) { json(res, 401, { error: 'bad enroll key' }); return; }
      const cookie = (body.cookie || '').trim();
      if (!cookie || !/ecto_1_sess/.test(cookie)) { json(res, 400, { error: 'cookie must contain ecto_1_sess' }); return; }
      const acc = { id: crypto.randomUUID(), label: body.label || ('harvested-' + Date.now().toString(36)), cookie,
        token: body.token && body.token.startsWith('ecto1:') ? body.token : null,
        stats: { requests: 0, successes: 0, failures: 0, deleted: 0 }, cooldownUntil: 0, busy: false, lastUsed: 0, addedAt: Date.now() };
      accounts.push(acc); saveState();
      logEvent({ ev: 'account-enrolled', label: acc.label, hasToken: !!acc.token });
      json(res, 200, { ok: true, id: acc.id, label: acc.label });
      return;
    }

    // --- admin API (session-token auth) ---
    const sess = auth(req);
    if (p.startsWith('/api/') && !sess) { json(res, 401, { error: 'auth required' }); return; }

    if (p === '/api/status' && req.method === 'GET') {
      json(res, 200, {
        ok: true, version: '1.0.0',
        pool: {
          accounts: accounts.length,
          idle: accounts.filter(a => !a.busy && (a.cooldownUntil || 0) < Date.now()).length,
          busy: accounts.filter(a => a.busy).length,
        },
        totals: accounts.reduce((t, a) => ({ requests: t.requests + a.stats.requests, successes: t.successes + a.stats.successes, partials: t.partials + (a.stats.partials || 0), failures: t.failures + a.stats.failures, deleted: t.deleted + a.stats.deleted }), { requests: 0, successes: 0, partials: 0, failures: 0, deleted: 0 }),
        config: { ...state, adminPassword: undefined, apiKey: undefined, hasApiKey: !!state.apiKey, enrollKey: undefined },
        live: { openRequests: accounts.filter(a => a.busy).length },
      });
      return;
    }

    if (p === '/api/accounts' && req.method === 'GET') {
      json(res, 200, { enrollKey: state.enrollKey, accounts: accounts.map(a => ({
        id: a.id, label: a.label, hasToken: !!a.token, tokenPreview: a.token ? a.token.slice(0, 14) + '…' : null,
        stats: a.stats, busy: a.busy, cooldownUntil: a.cooldownUntil, lastUsed: a.lastUsed, addedAt: a.addedAt,
        cookieNames: a.cookie.split(';').map(c => c.split('=')[0].trim()).filter(Boolean),
      })) });
      return;
    }

    if (p === '/api/accounts' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString('utf8'));
      const cookie = (body.cookie || '').trim();
      if (!cookie || !/ecto_1_sess/.test(cookie)) { json(res, 400, { error: 'cookie must contain ecto_1_sess (paste the full Cookie header from meta.ai)' }); return; }
      const acc = { id: crypto.randomUUID(), label: body.label || ('account-' + (accounts.length + 1)), cookie, token: body.token || null,
        stats: { requests: 0, successes: 0, failures: 0, deleted: 0 }, cooldownUntil: 0, busy: false, lastUsed: 0, addedAt: Date.now() };
      accounts.push(acc); saveState();
      logEvent({ ev: 'account-added', label: acc.label });
      json(res, 200, { ok: true, id: acc.id });
      return;
    }

    if (p.startsWith('/api/accounts/') && req.method === 'POST') {
      const parts = p.split('/');
      const id = parts[3], action = parts[4];
      const acc = accounts.find(a => a.id === id);
      if (!acc) { json(res, 404, { error: 'account not found' }); return; }
      if (action === 'refresh') {
        try { acc.token = await lib.mintToken(acc.cookie); saveState(); json(res, 200, { ok: true, token: acc.token.slice(0, 18) + '…' }); }
        catch (e) { json(res, 502, { error: e.message }); }
        return;
      }
      if (action === 'test') {
        try {
          const token = await ensureToken(acc);
          const s = new lib.MetaSession(crypto.randomUUID(), token);
          await s.connect();
          const r = await s.ask('Reply with exactly: PING-OK', 'fast', { quietMs: 8000, hardMs: 60000 });
          s.close();
          const ok = /PING-OK/i.test(r.answer || '');
          json(res, 200, { ok, answer: (r.answer || '').slice(0, 80), latency_ms: r.ms });
        } catch (e) { json(res, 502, { error: e.message }); }
        return;
      }
      json(res, 400, { error: 'unknown action' });
      return;
    }

    if (p.startsWith('/api/accounts/') && req.method === 'DELETE') {
      const id = p.split('/')[3];
      const i = accounts.findIndex(a => a.id === id);
      if (i < 0) { json(res, 404, { error: 'not found' }); return; }
      if (accounts[i].busy) { json(res, 409, { error: 'account busy' }); return; }
      logEvent({ ev: 'account-removed', label: accounts[i].label });
      accounts.splice(i, 1); saveState();
      json(res, 200, { ok: true });
      return;
    }

    if (p === '/api/logs' && req.method === 'GET') {
      json(res, 200, { logs: logs.slice(0, 150) });
      return;
    }

    if (p === '/api/config' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString('utf8'));
      if (body.rotateEnrollKey) { state.enrollKey = crypto.randomBytes(16).toString('hex'); }
      for (const k of ['autoDelete', 'defaultMode', 'attachThreshold', 'quietMs', 'hardMs', 'apiKey', 'attachMessage', 'corsEnabled']) {
        if (k in body) state[k] = body[k];
      }
      for (const k of ['attachThreshold', 'quietMs', 'hardMs']) {
        state[k] = parseInt(state[k], 10) || state[k];
      }
      if (typeof body.adminPassword === 'string' && body.adminPassword.length >= 4) {
        state.adminPassword = body.adminPassword;
        sessions.clear();
      }
      saveState();
      json(res, 200, { ok: true, config: state });
      return;
    }

    if (p === '/api/conversations' && req.method === 'GET') {
      const acc = pickAccount() || accounts[0];
      if (!acc) { json(res, 404, { error: 'no accounts' }); return; }
      const r = await lib.gql('427f069509772a50889bc9173207ad67', {}, acc.cookie);
      let convs = [];
      try {
        const obj = JSON.parse(r.text.slice(r.text.indexOf('{"data"')));
        convs = (obj.data.conversations.edges || []).map(e => ({ id: e.node.id, title: e.node.title, ts: e.node.lastSendMessageTimestampMs }));
      } catch {}
      json(res, 200, { conversations: convs });
      return;
    }

    if (p.startsWith('/api/conversations/') && p.endsWith('/delete') && req.method === 'POST') {
      const id = decodeURIComponent(p.split('/')[3]);
      const acc = pickAccount() || accounts[0];
      if (!acc) { json(res, 404, { error: 'no accounts' }); return; }
      const ok = await lib.deleteConversation(acc.cookie, id);
      logEvent({ ev: 'conversation-deleted', conv: id, account: acc.label, via: 'api' });
      json(res, 200, { ok, id });
      return;
    }

    if (p === '/api/cleanup' && req.method === 'POST') {
      const acc = pickAccount() || accounts[0];
      if (!acc) { json(res, 404, { error: 'no accounts' }); return; }
      const r = await lib.gql('427f069509772a50889bc9173207ad67', {}, acc.cookie);
      let deleted = 0, failed = 0;
      try {
        const obj = JSON.parse(r.text.slice(r.text.indexOf('{"data"')));
        for (const e of obj.data.conversations.edges || []) {
          const ok = await lib.deleteConversation(acc.cookie, e.node.id);
          ok ? deleted++ : failed++;
          await new Promise(r2 => setTimeout(r2, 300));
        }
      } catch {}
      logEvent({ ev: 'cleanup', deleted, failed });
      json(res, 200, { deleted, failed });
      return;
    }

    // --- static ---
    if (req.method === 'GET') { serveStatic(res, p); return; }
    json(res, 404, { error: 'not found' });
  } catch (e) {
    try { json(res, 500, { error: e.message }); } catch {}
  }
});

loadState();
if (!state.enrollKey) { state.enrollKey = crypto.randomBytes(16).toString('hex'); saveState(); }
seedFirstAccount();
server.listen(PORT, HOST, () => {
  console.log('Meta Proxy listening on http://' + HOST + ':' + PORT);
  console.log('accounts:', accounts.length, '| autoDelete:', state.autoDelete, '| attachThreshold:', state.attachThreshold);
});
