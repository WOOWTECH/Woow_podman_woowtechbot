'use strict';
// node --test tests/: brand.cjs on a copy of the base image's index.html and web manifest with the icons of
// image/brand: tests/fixtures/brand is from ghcr.io/woowtech/amd64-woowtechbot:0.1.7-rc.14 (MausBot title),
// tests/fixtures/brand/rc20 from 0.1.7-rc.20 (the base this edition runs: already woowtechbot).
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const script = path.join(__dirname, '..', 'image', 'rootfs', 'opt', 'woowtechbot-podman', 'brand.cjs');
const icons = path.join(__dirname, '..', 'image', 'brand');
const fixtures = path.join(__dirname, 'fixtures', 'brand');
const { ICONS, VERSION } = require(script);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wtb-brand-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

let n = 0;
function dist(from = fixtures) {
  const dir = path.join(tmp, String(n++));
  fs.mkdirSync(dir);
  for (const file of ['index.html', 'manifest.webmanifest']) fs.copyFileSync(path.join(from, file), path.join(dir, file));
  for (const file of Object.keys(ICONS)) fs.copyFileSync(path.join(icons, file), path.join(dir, file));
  return dir;
}
const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
const read = (dir, file) => fs.readFileSync(path.join(dir, file), 'utf8');
const changed = (a, b) => a.split('\n').filter((line, i) => line !== b.split('\n')[i]);

test('the icons in image/brand are the pinned ones', () => {
  const r = run('--check', dist());
  assert.doesNotMatch(r.stderr, /is not the woowtech bot icon|is missing/);
});

test('the 0.1.7-rc.20 base already has the name: only the icon addresses change', () => {
  const rc20 = path.join(fixtures, 'rc20');
  const dir = dist(rc20);
  const r = run(dir);
  assert.equal(r.status, 0, r.stderr);
  const html = read(dir, 'index.html'), base = read(rc20, 'index.html');
  assert.match(html, /<meta name="apple-mobile-web-app-title" content="woowtechbot" \/>/);
  assert.equal(changed(html, base).length, 2, 'the two icon links');
  assert.ok(html.includes(`href="./app-icon.svg?v=${VERSION}"`));
  assert.ok(html.includes(`href="./apple-touch-icon.png?v=${VERSION}"`));
  assert.equal(changed(read(dir, 'manifest.webmanifest'), read(rc20, 'manifest.webmanifest')).length, 2);
  assert.equal(run('--check', dir).status, 0);
  assert.match(run(dir).stdout, /already in place/);
});

test('applies to the rc.14 base files: iPhone name and versioned icon addresses, nothing else', () => {
  const dir = dist();
  const r = run(dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`icons in place \\(v=${VERSION}\\)`));
  const html = read(dir, 'index.html'), base = read(fixtures, 'index.html');
  assert.match(html, /<meta name="apple-mobile-web-app-title" content="woowtechbot" \/>/);
  assert.doesNotMatch(html, /OpenMausBot/);
  assert.ok(html.includes(`href="./app-icon.svg?v=${VERSION}"`));
  assert.ok(html.includes(`href="./apple-touch-icon.png?v=${VERSION}"`));
  assert.ok(html.includes('location.pathname.match(/^\\/api\\/hassio_ingress\\/'), 'the HA ingress base script stays');
  assert.equal(html.split('\n').length, base.split('\n').length);
  assert.equal(changed(html, base).length, 3);
  const manifest = JSON.parse(read(dir, 'manifest.webmanifest'));
  assert.deepEqual(manifest.icons.map(icon => icon.src), [`./app-icon-192.png?v=${VERSION}`, `./app-icon-512.png?v=${VERSION}`]);
  assert.equal(manifest.name, 'woowtechbot');
  assert.equal(changed(read(dir, 'manifest.webmanifest'), read(fixtures, 'manifest.webmanifest')).length, 2);
  assert.equal(run('--check', dir).status, 0);
});

test('a second run changes nothing', () => {
  const dir = dist();
  assert.equal(run(dir).status, 0);
  const html = read(dir, 'index.html'), manifest = read(dir, 'manifest.webmanifest');
  const r = run(dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /already in place/);
  assert.equal(read(dir, 'index.html'), html);
  assert.equal(read(dir, 'manifest.webmanifest'), manifest);
});

test('--check fails on the unbranded base', () => {
  const r = run('--check', dist());
  assert.equal(r.status, 1);
  assert.match(r.stderr, /home screen name is not woowtechbot/);
});

test('refuses a wrong or missing icon and leaves the pages alone', () => {
  const dir = dist();
  fs.writeFileSync(path.join(dir, 'app-icon-512.png'), 'not the icon');
  let r = run(dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /app-icon-512\.png is not the woowtech bot icon/);
  assert.equal(read(dir, 'index.html'), read(fixtures, 'index.html'));
  fs.rmSync(path.join(dir, 'app-icon-512.png'));
  r = run(dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /app-icon-512\.png is missing/);
});

test('stops when a new base no longer has what it edits', () => {
  for (const [file, from, to, why] of [
    ['index.html', /<meta name="apple-mobile-web-app-title"[^>]*>\n/, '', /no single apple-mobile-web-app-title/],
    ['index.html', 'href="./apple-touch-icon.png"', 'href="./touch.png"', /does not link apple-touch-icon\.png once/],
    ['manifest.webmanifest', '"./app-icon-192.png"', '"./icon-192.png"', /does not list app-icon-192\.png once/],
  ]) {
    const dir = dist();
    const before = read(dir, file).replace(from, to);
    fs.writeFileSync(path.join(dir, file), before);
    const r = run(dir);
    assert.equal(r.status, 1, file);
    assert.match(r.stderr, why);
    assert.equal(read(dir, file), before, 'nothing written');
  }
});

test('a page without index.html is an error, not a crash', () => {
  const dir = dist();
  fs.rmSync(path.join(dir, 'index.html'));
  const r = run(dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^brand: ENOENT/);
});

test('usage', () => {
  assert.equal(run().status, 2);
  assert.equal(run('--check').status, 2);
  assert.equal(run('a', 'b').status, 2);
});
