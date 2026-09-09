// meta_lib.js — Meta AI DGW protocol library (consolidated from the reverse-engineering work).
// Everything here was live-verified against gateway.meta.ai on 2026-09-09.
const fs = require('fs');
const tls = require('tls');
const crypto = require('crypto');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';
const GATEWAY = 'wss://gateway.meta.ai/ws/clippy';
const TPL_DIR = __dirname;

// ---------- protobuf codec (BigInt-safe, order-preserving, byte-faithful) ----------
function readVarint(b, i) {
  let v = 0n, shift = 0n;
  while (true) {
    const x = b[i++];
    v |= BigInt(x & 0x7f) << shift;
    if (!(x & 0x80)) break;
    shift += 7n;
    if (shift > 63n) throw new Error('varint too long');
  }
  return [v, i];
}
function encVarint(v) {
  v = BigInt(v);
  const out = [];
  while (true) {
    let x = Number(v & 0x7fn);
    v >>= 7n;
    if (v === 0n) { out.push(x); break; }
    out.push(x | 0x80);
  }
  return Buffer.from(out);
}
function parse(b) {
  const nodes = []; let i = 0;
  while (i < b.length) {
    const [tag, ni] = readVarint(b, i); i = ni;
    const field = Number(tag >> 3n), wt = Number(tag & 7n);
    if (field === 0) throw new Error('field 0');
    if (wt === 0) { const [v, nj] = readVarint(b, i); i = nj; nodes.push({ field, wt, val: v }); }
    else if (wt === 1) { nodes.push({ field, wt, bytes: Buffer.from(b.subarray(i, i + 8)) }); i += 8; }
    else if (wt === 5) { nodes.push({ field, wt, bytes: Buffer.from(b.subarray(i, i + 4)) }); i += 4; }
    else if (wt === 2) {
      const [ln, nj] = readVarint(b, i); i = nj;
      nodes.push({ field, wt, bytes: Buffer.from(b.subarray(i, i + Number(ln))) }); i += Number(ln);
    } else throw new Error('wt ' + wt);
  }
  return nodes;
}
function serialize(nodes) {
  const parts = [];
  for (const n of nodes) {
    const tag = encVarint((BigInt(n.field) << 3n) | BigInt(n.wt));
    if (n.wt === 0) parts.push(tag, encVarint(n.val));
    else if (n.wt === 2) parts.push(tag, encVarint(n.bytes.length), n.bytes);
    else parts.push(tag, n.bytes);
  }
  return Buffer.concat(parts);
}
const get = (nodes, f) => nodes.find(n => n.field === f);

// ---------- modes ----------
const MODES = {
  fast: { num: 1000n, str: 'MODE_FAST', gql: 'think_fast' },
  think: { num: 1001n, str: 'mode_thinking', gql: 'think_hard' },
};

// ---------- templates ----------
const TPL = {
  connect: fs.readFileSync(TPL_DIR + '/conn556_00.bin'),      // 0f header frame
  cont: fs.readFileSync(TPL_DIR + '/conn556_01.bin'),         // 0d continuation (streams!)
  newconv: fs.readFileSync(TPL_DIR + '/verbatim_0d.bin'),     // 0d new-conversation shape (12.4 flag)
};
const ATT_B64 = fs.readFileSync(TPL_DIR + '/attachment_frame.b64', 'utf8').trim();
const OLD_CONV = 'c2b68610-de1c-48a0-8992-fc67922aae10';
const ATT_OLD_CONV = '26c48338-2f5d-424c-b65d-cba913339da50';

function envelopeOf(frame) {
  const brace = frame.indexOf(0x7b);
  return { brace, env: JSON.parse(frame.subarray(brace).toString('utf8')) };
}
function reframe(env, reqId, proto, seq) {
  const envKey = Object.keys(env)[0];
  env[envKey] = reqId;
  env.payload = proto.toString('base64');
  const json = JSON.stringify(env);
  const len = Buffer.byteLength(json) + 2;
  const hdr = Buffer.from([0x0d, 0x00, 0x00, len & 0xff, (len >> 8) & 0xff, 0x00, seq, 0x80]);
  return Buffer.concat([hdr, Buffer.from(json, 'utf8')]);
}

// ---------- frame builders ----------
function buildConnectFrame(conv) {
  return Buffer.from(TPL.connect.toString('binary').split(OLD_CONV).join(conv), 'binary');
}

function buildMsgFrame({ text, conv, mode = 'fast', seq = 0, ten1, ten3 }) {
  const { env } = envelopeOf(TPL.cont);
  const reqId = crypto.randomUUID();
  const msgId = crypto.randomUUID();
  const now = BigInt(Date.now());
  const top = parse(Buffer.from(env.payload, 'base64'));
  const msgPart = get(top, 2);
  const partNodes = parse(msgPart.bytes);
  get(partNodes, 2).bytes = Buffer.from(text, 'utf8');
  const mid = get(partNodes, 1);
  const midNodes = parse(mid.bytes);
  get(midNodes, 1).bytes = Buffer.from(msgId, 'utf8');
  const mid2 = get(midNodes, 2);
  const mid2Nodes = parse(mid2.bytes);
  get(mid2Nodes, 2).val = now;
  get(mid2Nodes, 3).val = now * 4194304n + BigInt(Math.floor(Math.random() * 4096));
  mid2.bytes = serialize(mid2Nodes);
  mid.bytes = serialize(midNodes);
  const reqMsg = get(top, 1);
  const reqNodes = parse(reqMsg.bytes);
  get(reqNodes, 6).bytes = Buffer.from(reqId, 'utf8');
  {
    const n = get(reqNodes, 5);
    if (n && n.wt === 2) {
      const sub = parse(n.bytes);
      for (const c of sub) if (c.wt === 0) c.val = now;
      n.bytes = serialize(sub);
    }
  }
  {
    const n = get(reqNodes, 10);
    if (n && n.wt === 2) {
      const sub = parse(n.bytes);
      if (get(sub, 1)) get(sub, 1).bytes = Buffer.from(ten1 || crypto.randomUUID(), 'utf8');
      if (get(sub, 3)) get(sub, 3).bytes = Buffer.from(ten3 || crypto.randomUUID(), 'utf8');
      n.bytes = serialize(sub);
    }
  }
  {
    const inner = get(reqNodes, 1);
    const inNodes = parse(inner.bytes);
    const modeCont = get(inNodes, 12);
    const mcNodes = parse(modeCont.bytes);
    const modePair = get(mcNodes, 3);
    const mpNodes = parse(modePair.bytes);
    if (get(mpNodes, 1)) get(mpNodes, 1).val = MODES[mode].num;
    if (get(mpNodes, 2)) get(mpNodes, 2).bytes = Buffer.from(MODES[mode].str, 'utf8');
    modePair.bytes = serialize(mpNodes);
    modeCont.bytes = serialize(mcNodes);
    inner.bytes = serialize(inNodes);
  }
  reqMsg.bytes = serialize(reqNodes);
  msgPart.bytes = serialize(partNodes);
  let out = serialize(top);
  out = Buffer.from(out.toString('binary').split(OLD_CONV).join(conv), 'binary');
  return { frame: reframe(env, reqId, out, seq), reqId, msgId };
}

function buildAttachFrame({ text, conv, mediaId, mime = 'text/plain', filename = 'context.txt', mode = 'fast', seq = 0 }) {
  // base = continuation template (my session, streams reliably) + f3 attachment injected
  const { env } = envelopeOf(TPL.cont);
  const reqId = crypto.randomUUID();
  const msgId = crypto.randomUUID();
  const now = BigInt(Date.now());
  const top = parse(Buffer.from(env.payload, 'base64'));

  // attachment f3 subtree from the captured attachment frame
  const attRaw = Buffer.from(ATT_B64, 'base64');
  const { env: attEnv } = envelopeOf(attRaw);
  const attTop = parse(Buffer.from(attEnv.payload, 'base64'));
  const theirPart = parse(get(attTop, 2).bytes);
  const f3 = get(theirPart, 3);
  const their24 = get(theirPart, 4);
  if (f3 && f3.wt === 2) {
    const f3Nodes = parse(f3.bytes);
    const f3n1 = get(f3Nodes, 1);
    if (f3n1 && f3n1.wt === 2) {
      const inner1 = parse(f3n1.bytes);
      const entId = get(inner1, 1);
      if (entId && entId.wt === 0) entId.val = BigInt(mediaId);
      f3n1.bytes = serialize(inner1);
    }
    for (const c of f3Nodes) if (c.wt === 2 && c.bytes.toString('utf8') === 'image/png') c.bytes = Buffer.from(mime, 'utf8');
    for (const c of f3Nodes) if (c.wt === 2 && c.bytes.toString('utf8') === 'student_card.png') c.bytes = Buffer.from(filename, 'utf8');
    f3.bytes = serialize(f3Nodes);
  }

  const msgPart = get(top, 2);
  const partNodes = parse(msgPart.bytes);
  get(partNodes, 2).bytes = Buffer.from(text, 'utf8');
  const mid = get(partNodes, 1);
  const midNodes = parse(mid.bytes);
  get(midNodes, 1).bytes = Buffer.from(msgId, 'utf8');
  const mid2 = get(midNodes, 2);
  const mid2Nodes = parse(mid2.bytes);
  get(mid2Nodes, 2).val = now;
  get(mid2Nodes, 3).val = now * 4194304n + BigInt(Math.floor(Math.random() * 4096));
  mid2.bytes = serialize(mid2Nodes);
  mid.bytes = serialize(midNodes);
  const out2 = [];
  for (const c of partNodes) {
    if (c.field === 3) continue;
    out2.push(c);
    if (c.field === 2 && f3) out2.push(f3);
  }
  if (their24) {
    const idx = out2.findIndex(c => c.field === 4);
    if (idx >= 0) out2[idx] = their24; else out2.push(their24);
  }
  msgPart.bytes = serialize(out2);

  const reqMsg = get(top, 1);
  const reqNodes = parse(reqMsg.bytes);
  get(reqNodes, 6).bytes = Buffer.from(reqId, 'utf8');
  {
    const n = get(reqNodes, 5);
    if (n && n.wt === 2) {
      const sub = parse(n.bytes);
      for (const c of sub) if (c.wt === 0) c.val = now;
      n.bytes = serialize(sub);
    }
  }
  {
    const inner = get(reqNodes, 1);
    const inNodes = parse(inner.bytes);
    const modeCont = get(inNodes, 12);
    const mcNodes = parse(modeCont.bytes);
    const modePair = get(mcNodes, 3);
    const mpNodes = parse(modePair.bytes);
    if (get(mpNodes, 1)) get(mpNodes, 1).val = MODES[mode].num;
    if (get(mpNodes, 2)) get(mpNodes, 2).bytes = Buffer.from(MODES[mode].str, 'utf8');
    modePair.bytes = serialize(mpNodes);
    modeCont.bytes = serialize(mcNodes);
    inner.bytes = serialize(inNodes);
  }
  reqMsg.bytes = serialize(reqNodes);
  let out = serialize(top);
  out = Buffer.from(out.toString('binary').split(OLD_CONV).join(conv), 'binary');
  return { frame: reframe(env, reqId, out, seq), reqId, msgId };
}

// ---------- TLS WebSocket session (browser-identical handshake) ----------
class MetaSession {
  constructor(conv, token) {
    this.conv = conv || crypto.randomUUID();
    this.token = token;
    this.seq = 0;
    this.frames = 0;
    this.closed = false;
    this.ten1 = crypto.randomUUID();
    this.ten3 = crypto.randomUUID();
  }
  wsUrl() {
    const auth = encodeURIComponent(this.token.startsWith('ecto1:') ? this.token : 'ecto1:' + this.token);
    return GATEWAY +
      '?x-dgw-appid=1522763855473&x-dgw-appversion=1.0.0&x-dgw-authtype=15%3A0' +
      '&x-dgw-version=5&x-dgw-uuid=0&x-dgw-tier=prod' +
      '&Authorization=' + auth +
      '&x-dgw-app-origin=meta.ai&x-dgw-app-clippy-request-id=' + crypto.randomUUID();
  }
  connect() {
    return new Promise((resolve, reject) => {
      const u = new URL(this.wsUrl());
      const key = crypto.randomBytes(16).toString('base64');
      const req = [
        `GET ${u.pathname + u.search} HTTP/1.1`,
        `Host: ${u.host}`,
        'Upgrade: websocket', 'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`, 'Sec-WebSocket-Version: 13',
        'Origin: https://www.meta.ai',
        `User-Agent: ${UA}`,
        'Accept-Language: en-US,en;q=0.9',
        'Cache-Control: no-cache', 'Pragma: no-cache',
        '', ''
      ].join('\r\n');
      this.sock = tls.connect({ host: u.hostname, port: 443, servername: u.hostname }, () => this.sock.write(req));
      this.buf = Buffer.alloc(0);
      this.upgraded = false;
      this.sock.on('error', (e) => { if (!this.upgraded) reject(e); else this.closed = true; });
      this.sock.on('close', () => { this.closed = true; });
      this.sock.on('data', (d) => {
        this.buf = Buffer.concat([this.buf, d]);
        if (!this.upgraded) {
          const idx = this.buf.indexOf('\r\n\r\n');
          if (idx === -1) return;
          const head = this.buf.subarray(0, idx).toString('latin1');
          if (!head.includes(' 101 ')) return reject(new Error('upgrade failed: ' + head.slice(0, 120)));
          this.upgraded = true;
          this.buf = this.buf.subarray(idx + 4);
          this.send(buildConnectFrame(this.conv));
          setTimeout(() => resolve(), 350); // 300ms+ server-side CONNECT debounce
          this.drain();
        } else {
          this.drain();
        }
      });
    });
  }
  send(payload) {
    const mask = crypto.randomBytes(4);
    const masked = Buffer.from(payload);
    for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
    let hdr;
    const len = payload.length;
    if (len < 126) hdr = Buffer.from([0x82, 0x80 | len]);
    else if (len < 65536) { hdr = Buffer.alloc(4); hdr[0] = 0x82; hdr[1] = 0x80 | 126; hdr.writeUInt16BE(len, 2); }
    else { hdr = Buffer.alloc(10); hdr[0] = 0x82; hdr[1] = 0x80 | 127; hdr.writeBigUInt64BE(BigInt(len), 2); }
    this.sock.write(Buffer.concat([hdr, mask, masked]));
  }
  drain() {
    while (true) {
      if (this.buf.length < 2) return;
      const opcode = this.buf[0] & 0x0f;
      const masked = (this.buf[1] & 0x80) !== 0;
      let len = this.buf[1] & 0x7f, off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
      const ml = masked ? 4 : 0;
      if (this.buf.length < off + ml + len) return;
      let p = Buffer.from(this.buf.subarray(off + ml, off + ml + len));
      if (masked) { const mk = this.buf.subarray(off, off + 4); for (let i = 0; i < p.length; i++) p[i] ^= mk[i % 4]; }
      this.buf = this.buf.subarray(off + ml + len);
      if (opcode === 0x9) { this.send(p); continue; }
      if (opcode === 0x8) { this.closed = true; continue; }
      if (opcode !== 0x2 && opcode !== 0x1) continue;
      this.frames++;
      if (this.onFrame) this.onFrame(p);
    }
  }
  // send a chat message; onDelta receives answer text deltas live; resolves at completion
  ask(text, mode = 'fast', opts = {}) {
    const built = buildMsgFrame({ text, conv: this.conv, mode, seq: this.seq++, ten1: this.ten1, ten3: this.ten3 });
    return this.askRaw(built.frame, opts);
  }
  askAttach(text, mediaId, mime, filename, mode = 'fast', opts = {}) {
    const built = buildAttachFrame({ text, conv: this.conv, mediaId, mime, filename, mode, seq: this.seq++ });
    return this.askRaw(built.frame, opts);
  }
  askRaw(frame, opts = {}) {
    const quietMs = opts.quietMs || 5000;
    const hardMs = opts.hardMs || 120000;
    const onDelta = opts.onDelta || null;
    const onThink = opts.onThink || null;
    return new Promise((resolve) => {
      const answerDeltas = [];
      const thinkDeltas = [];
      let finalText = null;
      let sawAnswer = false;
      let streamedLen = 0;
      let lastT = Date.now();
      const started = Date.now();
      const emitAppend = (txt) => {
        if (!txt) return;
        answerDeltas.push(txt);
        sawAnswer = true;
        streamedLen += txt.length;
        if (onDelta) onDelta(txt);
      };
      const emitSnapshot = (txt) => {
        if (!txt || txt.length <= streamedLen) return;
        emitAppend(txt.slice(streamedLen));
      };
      const answerOfFull = (obj) => {
        let out = '';
        for (const s of obj.sections || []) {
          const prim = (s.view_model || {}).primitive || {};
          if ((prim.__typename || '').includes('Thinking')) continue;
          if (typeof prim.text === 'string') out += prim.text;
          else if (typeof prim.snippet === 'string') out += prim.snippet;
        }
        return out;
      };
      this.onFrame = (p) => {
        lastT = Date.now();
        const b = p.indexOf(0x7b);
        if (b < 0) return;
        const txt = p.subarray(b).toString('utf-8');
        if (txt.startsWith('{"seq"')) {
          let obj = null;
          for (let end = txt.length; end > 10; end--) {
            if (txt[end - 1] !== '}') continue;
            try { obj = JSON.parse(txt.slice(0, end)); break; } catch { continue; }
          }
          if (!obj) return;
          if (obj.type === 'full') {
            // snapshots are NOT emitted live (wire sends tail deltas out of order);
            // the authoritative answer is replayed by the server at completion.
          } else if (obj.type === 'patch') {
            for (const op of obj.operations || []) {
              const path = op.path || '';
              if (path.includes('embedded_screens') && path.endsWith('/body')) {
                thinkDeltas.push(op.value || '');
                if (onThink) onThink(op.value || '');
              } else if (/^\/sections\/\d+$/.test(path) && op.op === 'add' && op.value && op.value.view_model) {
                const prim = (op.value.view_model.primitive || {});
                if (!(prim.__typename || '').includes('Thinking')) {
                  emitAppend(prim.text || prim.snippet || '');
                }
              } else if (path.includes('/sections/') && (path.endsWith('/text') || path.endsWith('/snippet'))) {
                emitAppend(op.value || '');
              }
            }
          }
        } else if (txt.startsWith('{"response_id"')) {
          let obj = null;
          for (let end = txt.length; end > 10; end--) {
            if (txt[end - 1] !== '}') continue;
            try { obj = JSON.parse(txt.slice(0, end)); break; } catch { continue; }
          }
          if (!obj) return;
          // final completion snapshot: authoritative answer
          const full = answerOfFull(obj);
          if (full) finalText = full;
        }
      };
      const timer = setInterval(() => {
        const quiet = Date.now() - lastT;
        const elapsed = Date.now() - started;
        if (finalText !== null) {
          clearInterval(timer);
          this.onFrame = null;
          resolve({ answer: finalText, think: thinkDeltas.join(''), frames: this.frames, ms: elapsed, finish: 'complete' });
        } else if (this.frames > 4 && quiet > quietMs * 3 && sawAnswer) {
          // stream went quiet without the completion frame — answer is PARTIAL
          clearInterval(timer);
          this.onFrame = null;
          resolve({ answer: answerDeltas.join(''), think: thinkDeltas.join(''), frames: this.frames, ms: elapsed, finish: 'partial' });
        } else if (elapsed > hardMs || this.closed) {
          clearInterval(timer);
          this.onFrame = null;
          resolve({ answer: answerDeltas.join(''), think: thinkDeltas.join(''), frames: this.frames, ms: elapsed, finish: 'timeout' });
        }
      }, 300);
      this.send(frame);
    });
  }

  close() { try { this.sock.destroy(); } catch {} }
}

// ---------- graphql (cookie auth) ----------
async function gql(docId, variables, cookie, referer) {
  const res = await fetch('https://www.meta.ai/api/graphql', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'multipart/mixed, application/json',
      'Cookie': cookie,
      'Origin': 'https://www.meta.ai',
      'Referer': referer || 'https://www.meta.ai/',
      'User-Agent': UA,
      'sec-ch-ua': '"Chromium";v="152", "Not?A_Brand";v="24", "Google Chrome";v="152"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
    },
    body: JSON.stringify({ doc_id: docId, variables }),
  });
  const text = await res.text();
  return { status: res.status, text };
}

// ---------- token mint (HTML scrape — VERIFIED) ----------
async function mintToken(cookie) {
  const res = await fetch('https://www.meta.ai/', {
    headers: {
      'Cookie': cookie,
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });
  const html = await res.text();
  const m = html.match(/ecto1:[A-Za-z0-9_-]+/);
  if (!m) throw new Error('no ecto1 token in page (status ' + res.status + ', cookies invalid or challenged?)');
  return m[0];
}

// ---------- rupload document upload — VERIFIED 818KB + 2MB ----------
async function uploadDocument({ cookie, token, data, filename = 'context.txt', mime = 'text/plain' }) {
  const sessionId = crypto.randomUUID();
  const auth = token.startsWith('ecto1:') ? token : 'ecto1:' + token;
  const res = await fetch('https://rupload.meta.ai/gen_ai_document_gen_ai_tenant/' + sessionId, {
    method: 'POST',
    headers: {
      'accept': '*/*',
      'authorization': 'OAuth ' + auth,
      'desired_upload_handler': 'genai_document',
      'ecto_auth_token': 'true',
      'is_abra_user': 'true',
      'offset': '0',
      'origin': 'https://meta.ai',
      'referer': 'https://meta.ai/',
      'user-agent': UA,
      'x-entity-length': String(data.length),
      'x-entity-name': filename,
      'x-entity-type': mime,
      'cookie': cookie,
    },
    body: data,
  });
  const body = await res.text();
  if (res.status !== 200) throw new Error('rupload ' + res.status + ': ' + body.slice(0, 200));
  const parsed = JSON.parse(body);
  if (!parsed.media_id) throw new Error('no media_id in rupload response');
  return parsed.media_id;
}

// ---------- conversation delete — VERIFIED ----------
async function deleteConversation(cookie, convId) {
  const r = await gql('ad35bda8475e29ba4264ef0d6cc0958a', { input: { id: convId } }, cookie);
  try {
    const obj = JSON.parse(r.text);
    return (obj.data && obj.data.deleteConversation && obj.data.deleteConversation.success) || false;
  } catch { return false; }
}

// ---------- OpenAI messages -> Meta prompt ----------
function messagesToPrompt(messages) {
  // Fidelity (chinese-gemini standard): leading system hoists to a top [System] block;
  // mid-conversation system stays INLINE at its exact position; function role renders
  // as Tool; non-text content parts leave an [image attached] marker (never silent drops).
  const leading = [];
  const turns = [];
  let seenTurn = false;
  for (const m of messages) {
    let content = '';
    let hasMedia = false;
    if (typeof m.content === 'string') {
      content = m.content;
    } else if (Array.isArray(m.content)) {
      const texts = [];
      for (const p of m.content) {
        if (p && p.type === 'text' && typeof p.text === 'string') texts.push(p.text);
        else if (p && p.type !== 'text') hasMedia = true;
      }
      content = texts.join('\n');
      if (hasMedia) content = (content ? content + '\n' : '') + '[image attached]';
    }
    if (m.role === 'system' || m.role === 'developer') {
      if (!seenTurn && content) leading.push(content);
      else turns.push('[System] ' + content);
    } else if (m.role === 'user') {
      turns.push('User: ' + content);
      seenTurn = true;
    } else if (m.role === 'assistant') {
      turns.push('Assistant: ' + content);
      seenTurn = true;
    } else if (m.role === 'tool' || m.role === 'function') {
      turns.push('Tool: ' + content);
      seenTurn = true;
    }
  }
  const sysBlock = leading.length ? '[System]\n' + leading.join('\n\n') + '\n\n' : '';
  const body = turns.join('\n\n');
  const prompt = turns.length > 1
    ? sysBlock + body + '\n\n[System]\nContinue the conversation above. Reply ONLY as the Assistant to the last User message. Do not repeat the transcript.'
    : sysBlock + body;
  return prompt;
}

module.exports = {
  MODES, UA, GATEWAY,
  parse, serialize, get, readVarint, encVarint,
  buildConnectFrame, buildMsgFrame, buildAttachFrame,
  MetaSession, gql, mintToken, uploadDocument, deleteConversation, messagesToPrompt,
};
