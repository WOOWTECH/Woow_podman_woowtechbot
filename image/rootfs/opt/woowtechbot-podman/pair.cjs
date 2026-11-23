#!/usr/bin/env node
'use strict';
// pair.cjs: one-time pairing codes for the host administrator. Runs inside the container through
// scripts/pair.sh (podman exec), so only someone who can run podman as the service account can
// use it; that account is this edition's administrator, as an HA administrator is on HA.
//
// It follows the HA add-on's administrator page (pairing-portal.cjs): codes come from the app's
// loopback owner API, last 10 minutes, work once, carry the admin and client scopes, and making a
// new code of a kind first revokes this tool's unused code of that kind. A phone code needs the
// public URL, and its QR encodes the app's openmausbot://pair? invite locally.
//
//   pair.cjs browser [--local-origin URL] [--json]
//   pair.cjs phone [--json]
//   pair.cjs list [--json]
//   pair.cjs cancel browser|phone|all
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const TTL = 10 * 60 * 1000;
const OWNER = new URL(process.env.WTB_OWNER_API || 'http://127.0.0.1:8799');
const ADDON = process.env.WTB_ADDON_DIR || '/opt/omb-addon';
const OPTIONS = process.env.WTB_OPTIONS_FILE || '/data/options.json';
const LABELS = Object.freeze({ browser: 'Podman browser', phone: 'Podman phone' });
const MAX_PENDING = 64;

class PairError extends Error {
  constructor(message, code = 1) { super(message); this.code = code; }
}

// Only the pairing routes of the owner API, with a deadline and a response size limit.
function owner(method, route, body) {
  if (!/^\/api\/auth\/pairing(?:\/[\w-]+)?$/.test(route)) throw new Error('invalid owner route');
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => { if (!settled) { settled = true; clearTimeout(deadline); error ? reject(error) : resolve(value); } };
    const fail = () => finish(new PairError('woowtechbot 還沒準備好，請稍後再試（容器剛啟動時需要約 1 分鐘）。'));
    const req = http.request({ host: OWNER.hostname, port: OWNER.port, path: route, method,
      headers: { 'content-type': 'application/json' } }, res => {
      const chunks = []; let size = 0;
      res.on('data', chunk => { size += chunk.length; if (size > 256000) { fail(); req.destroy(); } else chunks.push(chunk); });
      res.on('error', fail);
      res.on('end', () => {
        try { finish(null, { status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString() || '{}') }); }
        catch { fail(); }
      });
    });
    req.on('error', fail);
    const deadline = setTimeout(() => { fail(); req.destroy(); }, 5000);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

function publicUrl() {
  try {
    const value = JSON.parse(fs.readFileSync(OPTIONS, 'utf8')).public_url;
    return typeof value === 'string' && value ? new URL(value).origin : '';
  } catch { return ''; }
}

async function pending() {
  const live = await owner('GET', '/api/auth/pairing');
  if (live.status !== 200 || !Array.isArray(live.body.pairings)) throw new PairError('暫時無法讀取配對狀態，請稍後再試。');
  return live.body.pairings;
}

async function revoke(entries) {
  for (const entry of entries) {
    const result = await owner('DELETE', '/api/auth/pairing/' + encodeURIComponent(entry.id));
    if (![200, 404].includes(result.status)) throw new PairError('舊的配對碼還沒取消，請再試一次。');
  }
}

async function mint(kind, { now = Date.now } = {}) {
  const server = publicUrl();
  if (kind === 'phone' && !server) {
    throw new PairError('手機配對需要手機連得到的網址：請先在 ~/.config/woowtechbot/woowtechbot.env 填入 WTB_PUBLIC_URL，再執行 scripts/install.sh。', 2);
  }
  let live = await pending();
  await revoke(live.filter(entry => entry.label === LABELS[kind]));
  live = live.filter(entry => entry.label !== LABELS[kind]);
  if (live.length >= MAX_PENDING) throw new PairError('尚未使用的配對碼太多，請先取消一些再試。');
  const minted = await owner('POST', '/api/auth/pairing', { label: LABELS[kind], ttlMs: TTL, scopes: ['admin', 'client'] });
  const entry = minted.body || {};
  if (minted.status !== 200 || !/^[\w-]+$/.test(entry.id || '') || typeof entry.code !== 'string' ||
      !Number.isFinite(entry.expiresAt) || entry.expiresAt <= now() || entry.expiresAt > now() + TTL + 5000) {
    if (/^[\w-]+$/.test(entry.id || '')) await revoke([entry]);
    throw new PairError('沒能產生有效的配對碼，請稍後再試。');
  }
  if (kind === 'phone' && (typeof entry.inviteUrl !== 'string' || !entry.inviteUrl.startsWith('openmausbot://pair?'))) {
    await revoke([entry]);
    throw new PairError('手機配對連結還沒準備好，請稍後再試。');
  }
  return { id: entry.id, kind, code: entry.code, expiresAt: entry.expiresAt, server,
    inviteUrl: kind === 'phone' ? entry.inviteUrl : null };
}

// A terminal QR made locally (pairing secrets never go to a QR web service): two module rows per
// line with the upper half block, explicit black-on-white colours so dark terminals scan too.
function terminalQr(value, addonDir = ADDON) {
  const QRCode = require(path.join(addonDir, 'vendor/qrcode-terminal/vendor/QRCode'));
  const levels = require(path.join(addonDir, 'vendor/qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel'));
  const qr = new QRCode(-1, levels.M);
  qr.addData(value); qr.make();
  const n = qr.getModuleCount(), quiet = 4;
  const dark = (y, x) => y >= 0 && x >= 0 && y < n && x < n && qr.isDark(y, x);
  const lines = [];
  for (let y = -quiet; y < n + quiet; y += 2) {
    let line = '';
    for (let x = -quiet; x < n + quiet; x++) line += `\x1b[${dark(y, x) ? 30 : 97};${dark(y + 1, x) ? 40 : 107}m▀`;
    lines.push(line + '\x1b[0m');
  }
  return lines.join('\n');
}

function clock(ms) {
  return new Date(ms).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function render(result, { localOrigin = '', tty = false } = {}) {
  const out = [];
  const until = `10 分鐘內有效、只能用一次，${clock(result.expiresAt)} 到期`;
  if (result.kind === 'browser') {
    const base = result.server || localOrigin;
    out.push(`瀏覽器配對碼（${until}）`);
    out.push(`  配對碼：${result.code}`);
    if (base) out.push(`  配對連結：${base}/pair#code=${encodeURIComponent(result.code)}`);
    out.push('在要登入的瀏覽器打開配對連結，就會登入成管理員。');
    if (!result.server) out.push('（還沒設定 WTB_PUBLIC_URL，這個連結只在這台主機或同一個網段能開。）');
  } else {
    out.push(`手機 App 配對（${until}）`);
    out.push('用 MausBot App 掃描下面的 QR Code；或在 App 的「連線至電腦」手動填入：');
    out.push(`  伺服器網址：${result.server}`);
    out.push(`  配對碼：${result.code}`);
    if (tty) out.push('', terminalQr(result.inviteUrl), '');
    else out.push('（不是在終端機裡執行，所以不顯示 QR Code。）');
  }
  out.push(`重新產生會讓這組碼失效；取消：scripts/pair.sh cancel ${result.kind}`);
  return out.join('\n');
}

async function run(argv, { stdout = process.stdout } = {}) {
  const args = argv.filter(a => !a.startsWith('--'));
  const json = argv.includes('--json');
  const localIndex = argv.indexOf('--local-origin');
  const localOrigin = localIndex >= 0 ? argv[localIndex + 1] || '' : '';
  const [command, target] = args.filter(a => a !== localOrigin);
  if (command === 'browser' || command === 'phone') {
    const result = await mint(command);
    if (json) {
      const { qrSvg } = require(path.join(ADDON, 'qr.cjs'));
      const base = command === 'browser' ? result.server || localOrigin : result.server;
      stdout.write(JSON.stringify({ ...result, url: base ? `${base}/pair#code=${encodeURIComponent(result.code)}` : null,
        qrSvg: result.inviteUrl ? qrSvg(result.inviteUrl) : null }) + '\n');
    } else stdout.write(render(result, { localOrigin, tty: Boolean(stdout.isTTY) }) + '\n');
    return 0;
  }
  if (command === 'list') {
    const live = await pending();
    if (json) { stdout.write(JSON.stringify(live.map(({ id, label, scopes, expiresAt }) => ({ id, label, scopes, expiresAt }))) + '\n'); return 0; }
    if (!live.length) { stdout.write('目前沒有尚未使用的配對碼。\n'); return 0; }
    stdout.write('尚未使用的配對碼：\n');
    for (const p of live) stdout.write(`  ${p.label || '(未命名)'}  ${Number.isFinite(p.expiresAt) ? clock(p.expiresAt) + ' 到期' : ''}\n`);
    return 0;
  }
  if (command === 'cancel' && ['browser', 'phone', 'all'].includes(target)) {
    const kinds = target === 'all' ? ['browser', 'phone'] : [target];
    const mine = (await pending()).filter(entry => kinds.some(kind => entry.label === LABELS[kind]));
    await revoke(mine);
    stdout.write(mine.length ? `已取消 ${mine.length} 組配對碼；已經登入的裝置不受影響。\n` : '沒有需要取消的配對碼。\n');
    return 0;
  }
  throw new PairError('用法：scripts/pair.sh browser | phone | list | cancel browser|phone|all', 2);
}

module.exports = { LABELS, PairError, TTL, mint, render, run, terminalQr };
if (require.main === module) {
  run(process.argv.slice(2)).then(code => process.exit(code), error => {
    process.stderr.write((error instanceof PairError ? error.message : `配對失敗：${error.message}`) + '\n');
    process.exit(error instanceof PairError ? error.code : 1);
  });
}
