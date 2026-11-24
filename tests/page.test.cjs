'use strict';
// node --test tests/: static checks of the Cockpit page (cockpit/page) that a browser test would only
// find one at a time: every element the script uses exists, Cockpit's content security policy allows
// everything the page does, and the page, the installer and the helper agree on their paths.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const dir = path.join(__dirname, '..', 'cockpit', 'page');
const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(dir, 'bot.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
const installer = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'cockpit-page.sh'), 'utf8');
const helper = fs.readFileSync(path.join(__dirname, '..', 'cockpit', 'woowtech-cockpit-woowtechbot'), 'utf8');
const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]));

test('every element the script uses is in the page', () => {
  const used = new Set();
  for (const m of js.matchAll(/(?:\$\(|text\()\s*["`]([^"`]+)["`]/g)) {
    for (const kind of ['browser', 'phone']) used.add(m[1].replace('${kind}', kind));
  }
  const missing = [...used].filter(id => !ids.has(id));
  assert.deepEqual(missing, []);
  assert.ok(used.size > 40, `found ${used.size} ids`);
});

test('nothing the content security policy of Cockpit blocks', () => {
  assert.doesNotMatch(html, /<script(?![^>]*\ssrc=)/, 'no inline scripts');
  assert.doesNotMatch(html, /\son[a-z]+=/i, 'no inline event handlers');
  assert.doesNotMatch(html, /\sstyle=/i, 'no inline styles');
  assert.doesNotMatch(js, /\.style\.|innerHTML|insertAdjacentHTML|eval\(|new Function/, 'no inline styles or HTML from strings');
  const sources = [...html.matchAll(/\s(?:src|href)="([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(sources.filter(s => /^[a-z]+:/i.test(s)), [], 'nothing from other sites');
  assert.equal(manifest['content-security-policy'], undefined, 'the default policy is enough');
});

test('the page is for administrators, under Tools', () => {
  assert.equal(manifest.tools.index.label, 'woowtechbot');
  assert.equal(manifest.requires.cockpit, '362');
  const gate = manifest.conditions[0]['path-exists'];
  assert.match(installer, new RegExp(`GATE_DIR=\\$ETC/admins[\\s\\S]*GATE=\\$GATE_DIR/visible`));
  assert.equal(gate, '/etc/woowtech-cockpit/woowtechbot/admins/visible');
  assert.match(installer, /^ETC=\/etc\/woowtech-cockpit\/woowtechbot$/m);
  assert.match(helper, /^CONFIG = Path\('\/etc\/woowtech-cockpit\/woowtechbot\/config.json'\)$/m);
  assert.match(installer, /^HELPER=\/usr\/local\/libexec\/woowtech-cockpit-woowtechbot$/m);
  assert.match(js, /const HELPER = "\/usr\/local\/libexec\/woowtech-cockpit-woowtechbot";/);
  assert.match(js, /superuser: "require"/, 'the helper runs only with administrative access');
});

test('the page installs exactly its files', () => {
  const files = installer.match(/^PAGE_FILES=\(([^)]*)\)$/m)[1].split(/\s+/).sort();
  assert.deepEqual(files, fs.readdirSync(dir).sort());
});
