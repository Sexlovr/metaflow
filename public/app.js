// app.js — META//FLOW frontend. Vanilla SPA, no deps.
(() => {
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const API = '';
let TOKEN = localStorage.getItem('mf_token') || '';
let STATUS = null;
let activityHistory = [];
let currentMode = localStorage.getItem('mf_mode') || 'fast';

// ---------- tiny helpers ----------
async function api(path, opts = {}) {
  const res = await fetch(API + path, {
    ...opts,
    headers: {
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      ...(TOKEN ? { 'Authorization': 'Bearer ' + TOKEN } : {}),
      ...(opts.headers || {}),
    },
  });
  if (res.status === 401 && path !== '/api/login') { showLogin(); throw new Error('auth'); }
  return res;
}
function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  $('#toastRoot').appendChild(el);
  setTimeout(() => el.remove(), 4200);
}
function fmtTime(t) {
  const d = new Date(t);
  return d.toTimeString().slice(0, 8);
}
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- auth ----------
function showLogin() {
  localStorage.removeItem('mf_token');
  TOKEN = '';
  $('#loginGate').classList.remove('hidden');
  $('#app').classList.add('hidden');
}
$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#loginError').textContent = '';
  try {
    const res = await api('/api/login', { method: 'POST', body: JSON.stringify({ password: $('#loginPassword').value }) });
    const obj = await res.json();
    if (!res.ok) { $('#loginError').textContent = obj.error || 'wrong password'; return; }
    TOKEN = obj.token;
    localStorage.setItem('mf_token', TOKEN);
    enterApp();
  } catch (err) {
    $('#loginError').textContent = 'connection failed';
  }
});
function enterApp() {
  $('#loginGate').classList.add('hidden');
  $('#app').classList.remove('hidden');
  route();
  pollStatus();
}

// ---------- routing ----------
function route() {
  const hash = (location.hash || '#/chat').replace('#/', '');
  const view = hash.split('/')[0] || 'chat';
  $$('.view').forEach((v) => v.classList.add('hidden'));
  const el = $('#view-' + view);
  if (el) el.classList.remove('hidden');
  $$('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.view === view));
  if (view === 'dashboard') loadDashboard();
  if (view === 'accounts') loadAccounts();
  if (view === 'logs') loadLogs();
  if (view === 'conversations') loadConversations();
  if (view === 'settings') loadSettings();
}
window.addEventListener('hashchange', route);

// ---------- status polling ----------
async function pollStatus() {
  try {
    const res = await api('/api/status');
    STATUS = await res.json();
    $('#connPill').classList.remove('err');
    $('#connPill').classList.add('ok');
    $('#connText').textContent = STATUS.pool.idle + '/' + STATUS.pool.accounts + ' lanes idle';
    $('#poolBadge').textContent = STATUS.pool.accounts;
    activityHistory.push({ t: Date.now(), busy: STATUS.pool.busy, total: STATUS.totals.requests });
    if (activityHistory.length > 120) activityHistory.shift();
    if (!$('#view-dashboard').classList.contains('hidden')) updateDashboard(STATUS);
  } catch {
    $('#connPill').classList.add('err');
    $('#connPill').classList.remove('ok');
    $('#connText').textContent = 'offline';
  }
  setTimeout(pollStatus, 4000);
}

// ---------- chat: local sessions ----------
let threads = JSON.parse(localStorage.getItem('mf_threads') || '[]');
let activeThread = localStorage.getItem('mf_active') || null;
function saveThreads() {
  localStorage.setItem('mf_threads', JSON.stringify(threads.slice(0, 40)));
}
function getThread() {
  let t = threads.find((x) => x.id === activeThread);
  if (!t) {
    t = { id: 't' + Date.now().toString(36), title: 'New session', messages: [] };
    threads.unshift(t);
    activeThread = t.id;
    saveThreads();
  }
  return t;
}
function renderThreadList() {
  $('#threadList').innerHTML = threads.map((t) =>
    `<div class="thread-item ${t.id === activeThread ? 'active' : ''}" data-id="${t.id}">${esc(t.title)}</div>`
  ).join('');
  $$('#threadList .thread-item').forEach((el) =>
    el.addEventListener('click', () => {
      activeThread = el.dataset.id;
      localStorage.setItem('mf_active', activeThread);
      renderThreadList();
      renderMessages();
    }));
}
$('#newThreadBtn').addEventListener('click', () => {
  activeThread = null;
  localStorage.removeItem('mf_active');
  const t = getThread();
  renderThreadList();
  renderMessages();
});

function renderMessages() {
  const t = getThread();
  $('#chatTitle').textContent = t.title;
  const box = $('#messages');
  const empty = $('#chatEmpty');
  empty.classList.toggle('hidden', t.messages.length > 0);
  box.innerHTML = t.messages.map((m) => messageHtml(m)).join('');
  bindThinkingToggles(box);
  updateContextMeter();
  scrollChat();
}
function messageHtml(m) {
  if (m.role === 'user') {
    return `<div class="msg user"><div class="msg-avatar">Y</div><div class="msg-body"><div class="msg-role">You</div><div class="msg-bubble">${esc(m.content)}</div></div></div>`;
  }
  const think = m.think
    ? `<div class="thinking-block"><div class="thinking-head">thought process</div><div class="thinking-body">${esc(m.think)}</div></div>`
    : '';
  const meta = m.meta
    ? `<div class="msg-meta"><span class="meta-${m.meta.finish && m.meta.finish !== 'complete' ? 'cut' : 'ok'}">${m.meta.finish && m.meta.finish !== 'complete' ? '⚠ cut (' + esc(m.meta.finish) + ')' : '✓ shredded'}</span><span>${m.meta.mode}</span><span>${Math.round(m.meta.latency_ms / 100) / 10}s</span><span>${esc(m.meta.account || '')}</span></div>`
    : '';
  return `<div class="msg assistant"><div class="msg-avatar">M</div><div class="msg-body"><div class="msg-role">Meta AI</div>${think}<div class="msg-bubble">${esc(m.content)}</div>${meta}</div></div>`;
}
function bindThinkingToggles(scope) {
  scope.querySelectorAll('.thinking-head').forEach((h) =>
    h.addEventListener('click', () => h.parentElement.classList.toggle('open')));
}
function scrollChat() {
  const sc = $('#chatScroll');
  sc.scrollTop = sc.scrollHeight;
}
function updateContextMeter() {
  const t = getThread();
  const chars = t.messages.reduce((n, m) => n + (m.content || '').length, 0) + $('#composerInput').value.length;
  const meter = $('#contextMeter');
  meter.innerHTML = `<b>${chars.toLocaleString()}</b> chars context`;
  meter.className = 'context-meter ' + (chars > 24000 ? 'doc' : chars > 12000 ? 'hot' : '');
  meter.title = chars > 24000 ? 'rides as document attachment (~500k token capacity)' : 'inline in message';
}

// ---------- chat: streaming ----------
let streaming = false;
$('#sendBtn').addEventListener('click', sendMessage);
$('#composerInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});
$('#composerInput').addEventListener('input', (e) => {
  const el = e.target;
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 180) + 'px';
  updateContextMeter();
});
$$('.mode-pill').forEach((p) =>
  p.addEventListener('click', () => {
    $$('.mode-pill').forEach((x) => x.classList.remove('active'));
    p.classList.add('active');
    currentMode = p.dataset.mode;
    localStorage.setItem('mf_mode', currentMode);
  }));

async function sendMessage() {
  if (streaming) return;
  const input = $('#composerInput');
  const text = input.value.trim();
  if (!text) return;
  const t = getThread();
  t.messages.push({ role: 'user', content: text });
  if (t.title === 'New session') { t.title = text.slice(0, 34); renderThreadList(); }
  input.value = '';
  input.style.height = 'auto';
  renderMessages();
  saveThreads();

  streaming = true;
  $('#sendBtn').disabled = true;
  const model = currentMode === 'think' ? 'meta-thinking' : 'meta-instant';

  // optimistic assistant bubble with typing dots
  const box = $('#messages');
  const wrap = document.createElement('div');
  wrap.className = 'msg assistant';
  wrap.innerHTML = `<div class="msg-avatar">M</div><div class="msg-body"><div class="msg-role">Meta AI</div><div class="msg-bubble"><span class="typing"><span></span><span></span><span></span></span></div></div>`;
  box.appendChild(wrap);
  $('#chatEmpty').classList.add('hidden');
  scrollChat();

  let answer = '';
  let think = '';
  let meta = null;
  const bubble = wrap.querySelector('.msg-bubble');
  let thinkBlock = null;

  try {
    const res = await fetch(API + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + TOKEN },
      body: JSON.stringify({ model, messages: t.messages, stream: true }),
    });
    if (!res.ok || !res.body) {
      const err = await res.text();
      throw new Error(err.slice(0, 200) || 'upstream error');
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let lastRender = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (!chunk.startsWith('data: ')) continue;
        const payload = chunk.slice(6).trim();
        if (payload === '[DONE]') continue;
        try {
          const obj = JSON.parse(payload);
          const delta = obj.choices && obj.choices[0] && obj.choices[0].delta;
          if (delta && delta.reasoning_content) {
            think += delta.reasoning_content;
            if (!thinkBlock) {
              thinkBlock = document.createElement('div');
              thinkBlock.className = 'thinking-block open';
              thinkBlock.innerHTML = '<div class="thinking-head">thinking…</div><div class="thinking-body"></div>';
              thinkBlock.querySelector('.thinking-head').addEventListener('click', () => thinkBlock.classList.toggle('open'));
              wrap.querySelector('.msg-body').insertBefore(thinkBlock, bubble);
            }
            thinkBlock.querySelector('.thinking-body').textContent = think;
          }
          if (delta && delta.content) {
            answer += delta.content;
            const now = Date.now();
            if (now - lastRender > 40) {
              lastRender = now;
              bubble.innerHTML = esc(answer) + '<span class="stream-caret"></span>';
              scrollChat();
            }
          }
          if (obj.meta) {
            meta = obj.meta;
            if (typeof obj.meta.final_answer === 'string') {
              answer = obj.meta.final_answer;
              bubble.textContent = answer;
            }
          }
        } catch {}
      }
    }
    bubble.textContent = answer || '(empty response)';
    if (thinkBlock) {
      thinkBlock.querySelector('.thinking-head').textContent = 'thought process';
      thinkBlock.classList.remove('open');
    }
    if (meta) {
      const m = document.createElement('div');
      m.className = 'msg-meta';
      const cut = meta.finish && meta.finish !== 'complete';
      m.innerHTML = `<span class="meta-${cut ? 'cut' : 'ok'}">${cut ? '⚠ cut (' + esc(meta.finish) + ')' : '✓ shredded'}</span><span>${meta.mode}</span><span>${Math.round(meta.latency_ms / 100) / 10}s</span><span>${esc(meta.account || '')}</span>`;
      wrap.querySelector('.msg-body').appendChild(m);
    }
    t.messages.push({ role: 'assistant', content: answer, think, meta });
    saveThreads();
  } catch (e) {
    bubble.textContent = '✖ ' + e.message;
    bubble.style.color = 'var(--err)';
  }
  streaming = false;
  $('#sendBtn').disabled = false;
  updateContextMeter();
  scrollChat();
}

// ---------- dashboard ----------
let logsCache = [];
async function loadDashboard() {
  try {
    const [s, l] = await Promise.all([api('/api/status').then((r) => r.json()), api('/api/logs').then((r) => r.json())]);
    updateDashboard(s);
    logsCache = l.logs || [];
    renderRecentEvents();
  } catch {}
}
function updateDashboard(s) {
  $('#stRequests').textContent = s.totals.requests.toLocaleString();
  const total = s.totals.successes + s.totals.failures;
  $('#stSuccess').textContent = total ? Math.round((s.totals.successes / total) * 100) + '%' : '—';
  $('#stSuccessFoot').textContent = s.totals.successes + ' ok · ' + (s.totals.partials || 0) + ' cut · ' + s.totals.failures + ' fail';
  const completions = logsCache.filter((x) => x.ev === 'completion');
  const avg = completions.length ? completions.reduce((t, x) => t + (x.ms || 0), 0) / completions.length : 0;
  $('#stLatency').textContent = avg ? (Math.round(avg / 100) / 10) + 's' : '—';
  $('#stDeleted').textContent = s.totals.deleted.toLocaleString();
  renderPoolHealth(s);
  drawChart();
}
function renderPoolHealth(s) {
  const el = $('#poolHealth');
  el.innerHTML = s.pool.accounts
    ? `<div class="pool-row"><span class="pool-dot ${s.pool.idle ? 'idle' : 'busy'}"></span><div class="pool-name">${s.pool.idle} idle · ${s.pool.busy} busy</div><div class="pool-stats">${s.totals.requests} total req</div></div>`
    : '<div class="pool-row"><span class="pool-dot dead"></span><div class="pool-name">No accounts — add one</div></div>';
}
function renderRecentEvents() {
  const rows = logsCache.slice(0, 14).map((l) => {
    const cls = (/delet|success|ok/.test(l.ev) && !(l.finish && l.finish !== 'complete')) ? 'ok' : /fail|error|timeout/.test(l.ev + ' ' + (l.finish || '') + ' ' + (l.result || '')) ? 'err' : /upload|session/.test(l.ev) ? 'info' : 'warn';
    const det = l.ev === 'completion'
      ? `${l.account} · ${l.mode} · ${Math.round((l.ms || 0) / 100) / 10}s · ${(l.answerChars || 0)} chars${l.attached ? ' · doc' : ''}`
      : l.ev === 'conversation-deleted' ? l.conv.slice(0, 8)
      : l.ev === 'doc-upload' ? `${Math.round((l.size || 0) / 1000)}kb → ${l.mediaId}`
      : JSON.stringify(l).slice(0, 90);
    return `<div class="event-row ${cls}"><span class="event-time">${fmtTime(l.t)}</span><span class="event-tag">${esc(l.ev)}</span><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(det)}</span></div>`;
  }).join('');
  $('#recentEvents').innerHTML = rows || '<div class="event-row info"><span>No events yet — send a chat.</span></div>';
}
function drawChart() {
  const c = $('#activityChart');
  if (!c) return;
  const dpr = window.devicePixelRatio || 1;
  const w = c.clientWidth || 500;
  c.width = w * dpr;
  c.height = 180 * dpr;
  const ctx = c.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, 180);
  const hist = activityHistory.slice(-60);
  if (hist.length < 2) return;
  const maxBusy = Math.max(1, ...hist.map((h) => h.busy));
  const step = w / (hist.length - 1);
  // grid
  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  for (let i = 0; i <= 3; i++) {
    const y = 20 + (140 / 3) * i;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
  }
  // busy area
  const grad = ctx.createLinearGradient(0, 0, 0, 180);
  grad.addColorStop(0, 'rgba(34,211,238,0.5)');
  grad.addColorStop(1, 'rgba(34,211,238,0.02)');
  ctx.beginPath();
  ctx.moveTo(0, 180);
  hist.forEach((h, i) => {
    const y = 180 - (h.busy / maxBusy) * 130 - 8;
    ctx.lineTo(i * step, y);
  });
  ctx.lineTo(w, 180);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();
  // line
  ctx.beginPath();
  hist.forEach((h, i) => {
    const y = 180 - (h.busy / maxBusy) * 130 - 8;
    i ? ctx.lineTo(i * step, y) : ctx.moveTo(0, y);
  });
  ctx.strokeStyle = '#22d3ee';
  ctx.lineWidth = 1.8;
  ctx.stroke();
}

// ---------- accounts ----------
async function loadAccounts() {
  try {
    const obj = await api('/api/accounts').then((r) => r.json());
    renderAccounts(obj.accounts || []);
    if (obj.enrollKey) {
      const keyBox = document.querySelector('#enrollKeyBox');
      if (keyBox) keyBox.textContent = obj.enrollKey;
      const cmd = document.querySelector('#enrollCmd');
      if (cmd) {
        const url = location.origin;
        const script = location.protocol === 'https:' ? 'harvest.js' : 'harvest.js';
        cmd.textContent = 'node harvest.js ' + url + ' ' + obj.enrollKey;
        cmd.title = 'click to copy';
        cmd.onclick = () => { navigator.clipboard.writeText(cmd.textContent); toast('Command copied', 'ok'); };
      }
    }
  } catch {}
}
function renderAccounts(list) {
  $('#accountList').innerHTML = list.map((a) => `
    <div class="account-card ${a.busy ? 'busy' : ''}">
      <div class="account-head">
        <div class="account-ident">${esc((a.label || '?')[0].toUpperCase())}</div>
        <div>
          <div class="account-name">${esc(a.label)}</div>
          <div class="account-sub">${a.hasToken ? esc(a.tokenPreview) : 'no token — will mint on next use'}</div>
        </div>
        <div class="account-status">
          <span class="pool-dot ${a.busy ? 'busy' : 'idle'}" title="${a.busy ? 'busy' : 'idle'}"></span>
        </div>
      </div>
      <div class="account-stats">
        <div class="astat"><b>${a.stats.requests}</b><span>req</span></div>
        <div class="astat"><b>${a.stats.successes}</b><span>ok</span></div>
        <div class="astat"><b>${a.stats.failures}</b><span>err</span></div>
        <div class="astat d"><b>${a.stats.deleted}</b><span>shred</span></div>
      </div>
      <div class="account-actions">
        <button class="btn" data-act="refresh" data-id="${a.id}">↻ Mint token</button>
        <button class="btn" data-act="test" data-id="${a.id}">⚡ Test</button>
        <button class="btn btn-danger" data-act="remove" data-id="${a.id}">Remove</button>
      </div>
    </div>`).join('') || '<p class="view-note">No accounts yet.</p>';
  $$('#accountList [data-act]').forEach((b) =>
    b.addEventListener('click', async () => {
      const id = b.dataset.id;
      const act = b.dataset.act;
      if (act === 'remove') {
        if (!confirm('Remove this account from the pool?')) return;
        await api('/api/accounts/' + id, { method: 'DELETE' });
        loadAccounts();
        return;
      }
      b.textContent = act === 'refresh' ? '…minting' : '…testing';
      b.disabled = true;
      try {
        const res = await api('/api/accounts/' + id + '/' + act, { method: 'POST' });
        const obj = await res.json();
        toast(act === 'refresh'
          ? (obj.ok ? 'Token minted: ' + obj.token : 'Mint failed: ' + obj.error)
          : (obj.ok ? 'PING-OK in ' + Math.round(obj.latency_ms / 100) / 10 + 's ✓' : 'Test failed: ' + (obj.answer || obj.error)), obj.ok ? 'ok' : 'err');
      } catch (e) { toast('Request failed', 'err'); }
      loadAccounts();
    }));
}
$('#addAccountBtn').addEventListener('click', () => $('#addAccountModal').classList.remove('hidden'));
$('#accCancel').addEventListener('click', () => $('#addAccountModal').classList.add('hidden'));
$('#accSave').addEventListener('click', async () => {
  $('#accError').textContent = '';
  try {
    const res = await api('/api/accounts', {
      method: 'POST',
      body: JSON.stringify({ label: $('#accLabel').value.trim(), cookie: $('#accCookie').value.trim() }),
    });
    const obj = await res.json();
    if (!res.ok) { $('#accError').textContent = obj.error; return; }
    $('#addAccountModal').classList.add('hidden');
    $('#accLabel').value = '';
    $('#accCookie').value = '';
    toast('Account added — minting token on first use', 'ok');
    loadAccounts();
  } catch { $('#accError').textContent = 'request failed'; }
});

// ---------- logs ----------
async function loadLogs() {
  try {
    const obj = await api('/api/logs').then((r) => r.json());
    logsCache = obj.logs || [];
    renderLogs();
  } catch {}
}
function renderLogs() {
  $('#logTable').innerHTML = logsCache.map((l) => {
    const cls = (/delet|success|ok/.test(l.ev) && !(l.finish && l.finish !== 'complete')) ? 'ok' : /fail|error|timeout|partial/.test(l.ev + ' ' + (l.finish || '')) ? 'err' : /upload|session|open|enroll/.test(l.ev) ? 'info' : 'warn';
    const det = JSON.stringify(l).slice(1, -1);
    return `<div class="log-row ${cls}" title="${esc(JSON.stringify(l))}"><span class="log-time">${fmtTime(l.t)}</span><span class="log-ev">${esc(l.ev)}</span><span class="log-detail">${esc(det)}</span></div>`;
  }).join('') || '<p class="view-note">No events yet.</p>';
}
setInterval(() => {
  if (!$('#view-logs').classList.contains('hidden') && $('#logsAuto').checked) loadLogs();
  if (!$('#view-dashboard').classList.contains('hidden')) loadDashboard();
}, 5000);

// ---------- conversations ----------
async function loadConversations() {
  const el = $('#convList');
  el.innerHTML = '<p class="view-note">loading…</p>';
  try {
    const obj = await api('/api/conversations').then((r) => r.json());
    el.innerHTML = (obj.conversations || []).map((c) => `
      <div class="conv-row">
        <div class="conv-title">${esc(c.title || '(untitled)')}</div>
        <div class="conv-id">${esc(c.id)}</div>
        <button class="btn" data-conv="${c.id}">Shred</button>
      </div>`).join('') || '<p class="view-note" style="color:var(--ok)">✓ Account is clean — zero conversations on the server.</p>';
    el.querySelectorAll('[data-conv]').forEach((b) =>
      b.addEventListener('click', async () => {
        b.textContent = '…';
        b.disabled = true;
        try {
          await api('/api/conversations/' + encodeURIComponent(b.dataset.conv) + '/delete', { method: 'POST' });
          toast('Conversation shredded', 'ok');
        } catch { toast('Shred failed', 'err'); }
        loadConversations();
      }));
  } catch { el.innerHTML = '<p class="view-note">failed to load</p>'; }
}
$('#cleanupBtn').addEventListener('click', async () => {
  if (!confirm('Delete ALL conversations on the account?')) return;
  const obj = await api('/api/cleanup', { method: 'POST', body: '{}' }).then((r) => r.json());
  toast(`Shredded ${obj.deleted} conversations${obj.failed ? ', ' + obj.failed + ' failed' : ''}`, obj.failed ? '' : 'ok');
  loadConversations();
});
$('#dangerCleanup').addEventListener('click', () => {
  location.hash = '#/conversations';
  $('#cleanupBtn').click();
});

// ---------- settings ----------
async function loadSettings() {
  try {
    const s = await api('/api/status').then((r) => r.json());
    $('#cfgAutoDelete').checked = !!s.config.autoDelete;
    $('#cfgThreshold').value = s.config.attachThreshold;
    $('#cfgDefaultMode').value = s.config.defaultMode;
    $('#cfgAttachMessage').value = s.config.attachMessage || '';
    $('#cfgCors').checked = !!s.config.corsEnabled;
  } catch {}
}
$('#cfgSave').addEventListener('click', async () => {
  const body = {
    autoDelete: $('#cfgAutoDelete').checked,
    attachThreshold: parseInt($('#cfgThreshold').value || '24000', 10),
    defaultMode: $('#cfgDefaultMode').value,
    attachMessage: $('#cfgAttachMessage').value,
    corsEnabled: $('#cfgCors').checked,
  };
  const pw = $('#cfgPassword').value;
  if (pw) { if (pw.length < 4) { toast('Password too short (min 4)', 'err'); return; } body.adminPassword = pw; }
  const res = await api('/api/config', { method: 'POST', body: JSON.stringify(body) });
  const obj = await res.json();
  if (res.ok) {
    toast('Settings saved' + (pw ? ' — re-login needed' : ''), 'ok');
    $('#cfgPassword').value = '';
    if (pw) showLogin();
  } else toast(obj.error || 'save failed', 'err');
});

// ---------- boot ----------
function boot() {
  // restore mode pill
  $$('.mode-pill').forEach((p) => p.classList.toggle('active', p.dataset.mode === currentMode));
  renderThreadList();
  renderMessages();
  if (TOKEN) {
    // verify session
    api('/api/status').then((res) => { if (res.ok) enterApp(); else showLogin(); }).catch(showLogin);
  } else {
    showLogin();
  }
}
boot();
})();
