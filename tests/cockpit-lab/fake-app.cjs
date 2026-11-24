'use strict';
// tests/cockpit-lab/fake-app.cjs: a stand-in for the app inside the bot's container, for the Cockpit
// page tests. It answers the owner API routes pair.cjs uses with the contract of the real app
// (OpenMausBot 0.1.169, as the HA add-on runs it): one-time codes that are listed without the code,
// signed-in devices without tokens, the health and AI connection lists. POST /api/auth/pair redeems a
// code the way a device does, so a test can pair without a phone.
//
//   WTB_FAKE_OWNER_PORT     owner API port on 127.0.0.1 (default 8799; 0 = any, printed on stdout)
//   WTB_FAKE_ENTRANCE_PORT  a small entrance page on 0.0.0.0 (default: none)
//   WTB_FAKE_PUBLIC_URL     the address in phone invitations (default https://bot.example.com)
const http = require('node:http');
const crypto = require('node:crypto');

const PUBLIC = process.env.WTB_FAKE_PUBLIC_URL || 'https://bot.example.com';
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const pairings = [];
const sessions = [];
const engines = [
  { instanceId: 'claude', displayName: 'Claude', snapshot: { state: 'available', authenticated: false } },
  { instanceId: 'codex', displayName: 'Codex', snapshot: { state: 'available', authenticated: true } },
  { instanceId: 'grok', displayName: 'Grok', snapshot: { state: 'unavailable', reason: 'not installed' } },
];

function code() {
  const bytes = crypto.randomBytes(12);
  const chars = [...bytes].map(b => ALPHABET[b % ALPHABET.length]).join('');
  return `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8)}`;
}
function prune() {
  for (let i = pairings.length - 1; i >= 0; i--) if (pairings[i].expiresAt <= Date.now()) pairings.splice(i, 1);
}
function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}
async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  try { return JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { return {}; }
}

const owner = http.createServer(async (req, res) => {
  prune();
  const { pathname } = new URL(req.url, 'http://127.0.0.1');
  let m;
  if (req.method === 'GET' && pathname === '/api/health') return send(res, 200, { app: 'openmausbot', version: '0.1.169-fake' });
  if (req.method === 'GET' && pathname === '/api/instances') return send(res, 200, { instances: engines });
  if (req.method === 'GET' && pathname === '/api/auth/pairing') {
    return send(res, 200, { publicUrl: PUBLIC, pairings: pairings.map(({ id, label, scopes, createdAt, expiresAt }) =>
      ({ id, label, scopes, createdAt, expiresAt })) });
  }
  if (req.method === 'POST' && pathname === '/api/auth/pairing') {
    const input = await body(req);
    const entry = { id: crypto.randomUUID(), code: code(), label: String(input.label || '').trim().slice(0, 80),
      scopes: Array.isArray(input.scopes) ? input.scopes : ['client'], createdAt: Date.now(),
      expiresAt: Date.now() + (Number.isInteger(input.ttlMs) ? input.ttlMs : 600000) };
    pairings.push(entry);
    // The real app's invitation carries its own one-time token, not the code.
    const inviteUrl = `openmausbot://pair?address=${encodeURIComponent(PUBLIC)}&token=omb_pair_${crypto.randomBytes(32)
      .toString('base64url')}&name=${encodeURIComponent(process.env.WTB_SERVER_NAME || 'woowtechbot')}`;
    return send(res, 200, { id: entry.id, code: entry.code, expiresAt: entry.expiresAt, inviteUrl });
  }
  if (req.method === 'DELETE' && (m = pathname.match(/^\/api\/auth\/pairing\/([\w-]+)$/))) {
    const i = pairings.findIndex(p => p.id === m[1]);
    if (i < 0) return send(res, 404, { error: 'no such pairing code' });
    pairings.splice(i, 1);
    return send(res, 200, { ok: true });
  }
  if (req.method === 'POST' && pathname === '/api/auth/pair') {
    const input = await body(req);
    const i = pairings.findIndex(p => p.code === input.code);
    if (i < 0) return send(res, 401, { error: 'invalid or expired pairing code' });
    const [used] = pairings.splice(i, 1);
    const now = Date.now();
    const session = { id: crypto.randomUUID(), label: String(input.label || used.label || 'Unnamed device').slice(0, 80),
      scopes: used.scopes, createdAt: now, lastSeenAt: now, expiresAt: now + 30 * 86400000 };
    sessions.push(session);
    return send(res, 200, { ok: true, session: { id: session.id, label: session.label } });
  }
  if (req.method === 'GET' && pathname === '/api/auth/sessions') return send(res, 200, { sessions, current: null });
  if (req.method === 'DELETE' && (m = pathname.match(/^\/api\/auth\/sessions\/([\w-]+)$/))) {
    const i = sessions.findIndex(s => s.id === m[1]);
    if (i < 0) return send(res, 404, { error: 'no such session' });
    sessions.splice(i, 1);
    return send(res, 200, { ok: true });
  }
  send(res, 404, { error: 'not found' });
});

owner.listen(Number(process.env.WTB_FAKE_OWNER_PORT ?? 8799), '127.0.0.1', () => {
  process.stdout.write(`${owner.address().port}\n`);
});
if (process.env.WTB_FAKE_ENTRANCE_PORT) {
  http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('woowtechbot (fake app for the Cockpit page tests)\n');
  }).listen(Number(process.env.WTB_FAKE_ENTRANCE_PORT), '0.0.0.0');
}
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => process.exit(0));
