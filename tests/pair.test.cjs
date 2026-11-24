'use strict';
// node --test tests/: pair.cjs against a fake owner API with the HA add-on's pairing contract.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wtb-pair-'));
const optionsFile = path.join(tmp, 'options.json');
let state;
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    state.calls.push({ method: req.method, url: req.url, body: chunks.length ? JSON.parse(Buffer.concat(chunks)) : null });
    const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.method === 'GET' && req.url === '/api/auth/pairing') return send(200, { pairings: state.pairings });
    if (req.method === 'GET' && req.url === '/api/auth/sessions') return send(200, { sessions: state.sessions, current: null });
    if (req.method === 'GET' && req.url === '/api/health') return send(200, { app: 'openmausbot', version: '0.1.169' });
    if (req.method === 'GET' && req.url === '/api/instances') return send(200, { instances: state.instances });
    if (req.method === 'DELETE' && req.url.startsWith('/api/auth/sessions/')) {
      const id = decodeURIComponent(req.url.split('/').pop());
      if (!state.sessions.some(s => s.id === id)) return send(404, { error: 'no such session' });
      state.sessions = state.sessions.filter(s => s.id !== id);
      return send(200, { ok: true });
    }
    if (req.method === 'DELETE') {
      const id = decodeURIComponent(req.url.split('/').pop());
      state.pairings = state.pairings.filter(p => p.id !== id);
      return send(200, {});
    }
    if (req.method === 'POST') return send(200, state.mint(JSON.parse(Buffer.concat(chunks))));
    send(404, {});
  });
});

let pair;
test.before(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  process.env.WTB_OWNER_API = `http://127.0.0.1:${server.address().port}`;
  process.env.WTB_ADDON_DIR = path.join(__dirname, 'fixtures', 'addon');
  process.env.WTB_OPTIONS_FILE = optionsFile;
  pair = require('../image/rootfs/opt/woowtechbot-podman/pair.cjs');
});
test.after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });
test.beforeEach(() => {
  fs.writeFileSync(optionsFile, JSON.stringify({ public_url: 'https://bot.example.com' }));
  state = {
    calls: [],
    pairings: [
      { id: 'old-browser', label: 'Podman browser', expiresAt: Date.now() + 1000 },
      { id: 'ha-phone', label: 'HA phone', expiresAt: Date.now() + 1000 },
    ],
    mint: body => ({ id: 'new-1', code: 'ABCD-EFGH-JKLM', expiresAt: Date.now() + body.ttlMs,
      inviteUrl: 'openmausbot://pair?server=https%3A%2F%2Fbot.example.com&code=ABCD-EFGH-JKLM' }),
    sessions: [{ id: 'sess-1', label: 'Pixel Tablet', scopes: ['admin', 'client'], createdAt: 1, lastSeenAt: 2,
      expiresAt: 3, tokenHash: 'f'.repeat(64) }],
    instances: [
      { instanceId: 'claude', displayName: 'Claude', snapshot: { state: 'available', authenticated: false } },
      { instanceId: 'openai', displayName: 'OpenAI', snapshot: { state: 'available' } },
      { instanceId: 'grok', displayName: 'Grok', snapshot: { state: 'unavailable' } },
      { instanceId: 'hermes', displayName: 'Hermes', driverKind: 'hermesAgent', models: { default: '', options: [] },
        snapshot: { state: 'available', authenticated: true } },
    ],
  };
});

function capture() {
  let text = '';
  return { stdout: { isTTY: false, write: s => { text += s; } }, text: () => text };
}

test('a browser code revokes only this tool\'s earlier browser code and asks for the HA scopes', async () => {
  const out = capture();
  assert.equal(await pair.run(['browser'], { stdout: out.stdout }), 0);
  const deletes = state.calls.filter(c => c.method === 'DELETE').map(c => c.url);
  assert.deepEqual(deletes, ['/api/auth/pairing/old-browser']);
  const post = state.calls.find(c => c.method === 'POST');
  assert.deepEqual(post.body, { label: 'Podman browser', ttlMs: 600000, scopes: ['admin', 'client'] });
  assert.match(out.text(), /ABCD-EFGH-JKLM/);
  assert.match(out.text(), /https:\/\/bot\.example\.com\/pair#code=ABCD-EFGH-JKLM/);
  assert.ok(state.pairings.some(p => p.id === 'ha-phone'), 'codes made elsewhere are left alone');
});

test('without a public URL the browser link uses the local entrance and the phone is refused', async () => {
  fs.writeFileSync(optionsFile, JSON.stringify({ public_url: '' }));
  const out = capture();
  await pair.run(['browser', '--local-origin', 'http://127.0.0.1:18799'], { stdout: out.stdout });
  assert.match(out.text(), /http:\/\/127\.0\.0\.1:18799\/pair#code=/);
  const json = capture();
  await pair.run(['browser', '--json', '--local-origin', 'http://127.0.0.1:18799'], { stdout: json.stdout });
  assert.equal(JSON.parse(json.text()).url, 'http://127.0.0.1:18799/pair#code=ABCD-EFGH-JKLM', 'the JSON link uses the local entrance too');
  await assert.rejects(pair.run(['phone'], { stdout: capture().stdout }), err => err.code === 2 && /WTB_PUBLIC_URL/.test(err.message));
  assert.equal(state.calls.filter(c => c.method === 'POST').length, 2, 'no phone code was made');
});

test('a phone code shows the server, the code and, on a terminal, a QR code', async () => {
  const out = capture();
  await pair.run(['phone'], { stdout: out.stdout });
  assert.match(out.text(), /伺服器網址：https:\/\/bot\.example\.com/);
  assert.match(out.text(), /ABCD-EFGH-JKLM/);
  assert.doesNotMatch(out.text(), /▀/, 'no QR when not on a terminal');
  const qr = pair.terminalQr('openmausbot://pair?x', process.env.WTB_ADDON_DIR);
  assert.match(qr, /▀/);
  assert.equal(qr.split('\n').length, Math.ceil((3 + 8) / 2));
});

test('a phone code without the app invite is revoked and refused', async () => {
  state.mint = body => ({ id: 'bad-1', code: 'X', expiresAt: Date.now() + body.ttlMs, inviteUrl: 'https://evil.example/' });
  await assert.rejects(pair.run(['phone'], { stdout: capture().stdout }), /手機配對連結/);
  assert.ok(state.calls.some(c => c.method === 'DELETE' && c.url.endsWith('/bad-1')));
});

test('a code that lives longer than 10 minutes is revoked and refused', async () => {
  state.mint = () => ({ id: 'long-1', code: 'X', expiresAt: Date.now() + 60 * 60 * 1000 });
  await assert.rejects(pair.run(['browser'], { stdout: capture().stdout }), /沒能產生/);
  assert.ok(state.calls.some(c => c.method === 'DELETE' && c.url.endsWith('/long-1')));
});

test('cancel all revokes only this tool\'s codes', async () => {
  state.pairings.push({ id: 'old-phone', label: 'Podman phone', expiresAt: Date.now() + 1000 });
  const out = capture();
  await pair.run(['cancel', 'all'], { stdout: out.stdout });
  assert.deepEqual(state.pairings.map(p => p.id), ['ha-phone']);
  assert.match(out.text(), /已取消 2 組/);
});

test('list shows labels, never codes, and --json gives the same rows', async () => {
  const out = capture();
  await pair.run(['list'], { stdout: out.stdout });
  assert.match(out.text(), /Podman browser/);
  const json = capture();
  await pair.run(['list', '--json'], { stdout: json.stdout });
  assert.deepEqual(JSON.parse(json.text()).map(p => p.id), ['old-browser', 'ha-phone']);
});

test('a phone code as JSON carries the invite and a locally drawn QR', async () => {
  const out = capture();
  await pair.run(['phone', '--json'], { stdout: out.stdout });
  const result = JSON.parse(out.text());
  assert.equal(result.server, 'https://bot.example.com');
  assert.ok(result.inviteUrl.startsWith('openmausbot://pair?'));
  assert.match(result.qrSvg, /^<svg/);
});

test('unknown commands are refused with the usage', async () => {
  await assert.rejects(pair.run(['steal'], { stdout: capture().stdout }), err => err.code === 2);
});

test('an administrator of the Cockpit page gets codes of their own', async () => {
  state.pairings.push({ id: 'alice-old', label: 'Cockpit browser (alice)', expiresAt: Date.now() + 1000 },
    { id: 'bob-1', label: 'Cockpit browser (bob)', expiresAt: Date.now() + 1000 });
  await pair.run(['browser', '--json', '--by', 'alice'], { stdout: capture().stdout });
  const post = state.calls.find(c => c.method === 'POST');
  assert.equal(post.body.label, 'Cockpit browser (alice)');
  assert.deepEqual(state.calls.filter(c => c.method === 'DELETE').map(c => c.url), ['/api/auth/pairing/alice-old']);
  assert.deepEqual(state.pairings.map(p => p.id).sort(), ['bob-1', 'ha-phone', 'old-browser'],
    'the command line\'s, HA\'s and other administrators\' codes stay');
  const out = capture();
  await pair.run(['cancel', 'all', '--json', '--by', 'bob'], { stdout: out.stdout });
  assert.deepEqual(JSON.parse(out.text()), { cancelled: 1 });
  assert.deepEqual(state.pairings.map(p => p.id).sort(), ['ha-phone', 'old-browser']);
});

test('an account name that could not be one is refused before anything is made', async () => {
  for (const by of ['a/b', 'a b', '-x', '.x', 'x'.repeat(33)]) {
    await assert.rejects(pair.run(['browser', '--by', by], { stdout: capture().stdout }), err => err.code === 2, by);
  }
  assert.equal(state.calls.length, 0);
});

test('options can come anywhere and their values are never commands', () => {
  assert.deepEqual(pair.parseArgs(['--by', 'list', 'browser', '--json']),
    { command: 'browser', target: undefined, json: true, localOrigin: '', by: 'list', extra: false });
  assert.equal(pair.parseArgs(['cancel', '--local-origin', 'phone', 'all']).target, 'all');
  assert.equal(pair.parseArgs(['browser', '--steal']).extra, true);
  assert.equal(pair.parseArgs(['cancel', 'all', 'more']).extra, true);
});

test('a JSON code carries the server time, so the page counts down by it', async () => {
  const out = capture();
  await pair.run(['browser', '--json'], { stdout: out.stdout });
  const result = JSON.parse(out.text());
  assert.ok(Math.abs(result.now - Date.now()) < 5000);
  assert.equal(result.qrSvg, null, 'a browser code needs no QR');
});

test('a code that cannot be shown is cancelled', async () => {
  state.mint = body => ({ id: 'long-qr', code: 'ABCD-EFGH-JKLM', expiresAt: Date.now() + body.ttlMs,
    inviteUrl: 'openmausbot://pair?' + 'x'.repeat(3000) });
  await assert.rejects(pair.run(['phone', '--json'], { stdout: capture().stdout }), /已經取消/);
  assert.ok(state.calls.some(c => c.method === 'DELETE' && c.url.endsWith('/long-qr')));
});

test('devices lists the signed-in devices without their tokens', async () => {
  const out = capture();
  await pair.run(['devices'], { stdout: out.stdout });
  assert.match(out.text(), /Pixel Tablet\s+管理員/);
  assert.match(out.text(), /裝置代號：sess-1/);
  const json = capture();
  await pair.run(['devices', '--json'], { stdout: json.stdout });
  const [device] = JSON.parse(json.text());
  assert.equal(device.label, 'Pixel Tablet');
  assert.equal(device.tokenHash, undefined);
});

test('signout signs out one known device', async () => {
  await assert.rejects(pair.run(['signout', 'nobody'], { stdout: capture().stdout }), /找不到這台裝置/);
  assert.ok(!state.calls.some(c => c.method === 'DELETE'), 'an unknown device is not even tried');
  await assert.rejects(pair.run(['signout', '../x'], { stdout: capture().stdout }), err => err.code === 2);
  await assert.rejects(pair.run(['signout'], { stdout: capture().stdout }), err => err.code === 2);
  const out = capture();
  await pair.run(['signout', 'sess-1', '--json'], { stdout: out.stdout });
  assert.deepEqual(JSON.parse(out.text()), { signedOut: 'sess-1', label: 'Pixel Tablet' });
  assert.deepEqual(state.sessions, []);
});

test('state is what the Cockpit page shows, and never a code', async () => {
  fs.writeFileSync(optionsFile, JSON.stringify({ public_url: 'https://bot.example.com/', published_url: 'https://apps.example.net',
    signin_relay_url: 'https://relay.example.com/api/woowtechbot/signin-mail' }));
  state.pairings.push({ id: 'mine', label: 'Cockpit phone (alice)', expiresAt: Date.now() + 1000, code: 'SECRET-CODE' });
  const out = capture();
  await pair.run(['state', '--by', 'alice'], { stdout: out.stdout });
  const view = JSON.parse(out.text());
  assert.equal(view.version, '0.1.169');
  assert.equal(view.publicUrl, 'https://bot.example.com');
  assert.equal(view.publishedUrl, 'https://apps.example.net');
  assert.equal(view.emailReady, false, 'the relay needs its token too');
  assert.deepEqual(view.engines, [{ id: 'claude', name: 'Claude', ready: false }, { id: 'openai', name: 'OpenAI', ready: true },
    { id: 'hermes', name: 'Hermes', ready: false }], 'Hermes without a model is not ready');
  state.instances.at(-1).models.options.push({ id: 'hermes-default' });
  const later = capture();
  await pair.run(['state'], { stdout: later.stdout });
  assert.equal(JSON.parse(later.text()).engines.at(-1).ready, true);
  assert.deepEqual(view.pending.map(p => [p.id, p.kind]), [['old-browser', null], ['ha-phone', null], ['mine', 'phone']]);
  assert.deepEqual(view.devices.map(d => d.id), ['sess-1']);
  assert.doesNotMatch(out.text(), /SECRET-CODE|tokenHash/);
  await assert.rejects(pair.run(['state', 'extra'], { stdout: capture().stdout }), err => err.code === 2);
});
