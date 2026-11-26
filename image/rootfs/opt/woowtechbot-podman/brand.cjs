#!/usr/bin/env node
'use strict';
// brand.cjs: the woowtech bot icons in the web app, as in the PaaS edition. The HA add-on image has them
// since 0.1.7-rc.19 (0.1.7-rc.14 still shipped the MausBot ones). This script runs while the image is built:
//   - it checks that /app/dist/ carries the four woowtech bot icons, so a base that goes back to MausBot
//     icons stops the build instead of reaching the host;
//   - index.html: the home screen name on iPhones (apple-mobile-web-app-title) is woowtechbot;
//   - rc.20 and older receive the existing shared icon hash; rc.21 and newer already have PaaS artwork
//     content hashes on each icon and on the manifest, which this checker preserves byte for byte.
//   brand.cjs <dist>          apply; fails when the files are not as expected (a new base changed them)
//   brand.cjs --check <dist>  only check that it is applied
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// sha256 of image/brand: byte for byte what the PaaS edition serves (image/brand/README.md).
const ICONS = {
  'app-icon.svg': 'd9f7d603282c81a3a6645cbffdd4427ac1c5613d71fe1b994c6bb79689ab5f39',
  'app-icon-192.png': '18e0662796488c75f37a1f9962886d422f001d0abe1271ddc23042eeca259ca1',
  'app-icon-512.png': '5f13e4046b1014d25c5689da4a47cacba3bf7ef5223df08d237985315cb69c6e',
  'apple-touch-icon.png': '217fe540639eabae893ba14d284d913f2bd31b76a545d1d1612ef56ef3f8e1ac',
};
const VERSION = crypto.createHash('sha256').update(Object.values(ICONS).join('')).digest('hex').slice(0, 10);
const contentHash = bytes => crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 12);
const NAME = 'woowtechbot';
const TITLE = /<meta name="apple-mobile-web-app-title" content="[^"]*" \/>/g;
const HREFS = ['app-icon.svg', 'apple-touch-icon.png'];
const SRCS = ['app-icon-192.png', 'app-icon-512.png'];
const quote = s => s.replace(/[.?]/g, '\\$&');
const ref = (file, attr, v) => new RegExp(`${attr}"(\\.?/)${quote(file)}${v ? quote(`?v=${v}`) : ''}"`, 'g');

class BrandError extends Error {}
const fail = message => { throw new BrandError(message); };
const count = (text, re) => (text.match(re) || []).length;
const files = dist => ({ index: path.join(dist, 'index.html'), manifest: path.join(dist, 'manifest.webmanifest') });

function checkIcons(dist) {
  for (const [file, want] of Object.entries(ICONS)) {
    let got;
    try { got = crypto.createHash('sha256').update(fs.readFileSync(path.join(dist, file))).digest('hex'); } catch { fail(`${file} is missing`); }
    if (got !== want) fail(`${file} is not the woowtech bot icon`);
  }
}

// Problems with the applied state, or none.
function problems(dist) {
  const { index, manifest } = files(dist);
  const html = fs.readFileSync(index, 'utf8');
  const found = [];
  const titles = html.match(TITLE) || [];
  if (titles.length !== 1 || !titles[0].includes(`content="${NAME}"`)) found.push('the iPhone home screen name is not woowtechbot');
  let json, manifestText;
  try { manifestText = fs.readFileSync(manifest, 'utf8'); json = JSON.parse(manifestText); } catch { found.push('manifest.webmanifest is not valid JSON'); return found; }
  if (json.name !== NAME || json.short_name !== NAME) found.push('the web manifest name is not woowtechbot');
  const srcs = (json.icons || []).map(icon => icon.src);
  const hasSrc = (file, version) => srcs.some(src => /^\.?\//.test(src) && src.replace(/^\.?\//, '') === `${file}?v=${version}`);
  const contentVersioned = HREFS.every(file => count(html, ref(file, 'href=', ICONS[file].slice(0, 12))) === 1)
    && count(html, ref('manifest.webmanifest', 'href=', contentHash(manifestText))) === 1
    && SRCS.every(file => hasSrc(file, ICONS[file].slice(0, 12)));
  if (!contentVersioned) {
    for (const file of HREFS) if (count(html, ref(file, 'href=', VERSION)) !== 1) found.push(`index.html does not ask for ${file}?v=${VERSION}`);
    for (const file of SRCS) if (!hasSrc(file, VERSION)) found.push(`the web manifest does not ask for ${file}?v=${VERSION}`);
  }
  return found;
}

function versionLabel(dist) {
  const html = fs.readFileSync(files(dist).index, 'utf8');
  return html.includes(`app-icon.svg?v=${ICONS['app-icon.svg'].slice(0, 12)}`) ? 'per-file SHA256' : `v=${VERSION}`;
}

function apply(dist) {
  checkIcons(dist);
  if (!problems(dist).length) return 'already in place';
  const { index, manifest } = files(dist);
  let html = fs.readFileSync(index, 'utf8');
  if (count(html, TITLE) !== 1) fail('index.html has no single apple-mobile-web-app-title: the base changed, look before building');
  html = html.replace(TITLE, `<meta name="apple-mobile-web-app-title" content="${NAME}" />`);
  for (const file of HREFS) {
    if (count(html, ref(file, 'href=')) !== 1) fail(`index.html does not link ${file} once: the base changed, look before building`);
    html = html.replace(ref(file, 'href='), (_, prefix) => `href="${prefix}${file}?v=${VERSION}"`);
  }
  let text = fs.readFileSync(manifest, 'utf8');
  for (const file of SRCS) {
    if (count(text, ref(file, '"src": ')) !== 1) fail(`manifest.webmanifest does not list ${file} once: the base changed, look before building`);
    text = text.replace(ref(file, '"src": '), (_, prefix) => `"src": "${prefix}${file}?v=${VERSION}"`);
  }
  fs.writeFileSync(index, html);
  fs.writeFileSync(manifest, text);
  const left = problems(dist);
  if (left.length) fail(left.join('; '));
  return 'in place';
}

function main(argv) {
  const checkOnly = argv[0] === '--check';
  const dist = checkOnly ? argv[1] : argv[0];
  if (!dist || argv.length > (checkOnly ? 2 : 1)) {
    process.stderr.write('usage: brand.cjs [--check] <dist>\n');
    return 2;
  }
  try {
    if (checkOnly) {
      checkIcons(dist);
      const found = problems(dist);
      if (found.length) fail(found.join('; '));
      process.stdout.write(`brand: woowtech bot icons in place (${versionLabel(dist)})\n`);
    } else {
      process.stdout.write(`brand: woowtech bot icons ${apply(dist)} (${versionLabel(dist)})\n`);
    }
    return 0;
  } catch (err) {
    if (!(err instanceof BrandError) && err.code !== 'ENOENT') throw err;
    process.stderr.write(`brand: ${err.message}\n`);
    return 1;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { ICONS, VERSION, main };
