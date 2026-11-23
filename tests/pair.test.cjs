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
test.after(() => server.close());
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
