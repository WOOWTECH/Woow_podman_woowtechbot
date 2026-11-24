'use strict';
// node --test tests/: the parts of the Hermes engine that need no image: the change to the compiled
// app (image/hermes/patch-app.mjs), the payload step (image/hermes/payload.py) on a small stand-in of
// the official install, and the launcher.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const dir = path.join(__dirname, '..', 'image', 'hermes');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wtb-hermes-'));

// the shapes the compiled app has: bundled (renamed helpers) and as a module
const bundled = 'let a=1;function hermesConfiguredModel(env){let d=null;try{d=hermesConfigDefault(readFileSync132(join172(dir,"config.yaml"),"utf8"))}catch{}}' +
  'function hermesInstalled(cli){return 1}return!options2.length&&!hermesUsesProbedProvider(env)&&hermesInstalled(cli)&&options2.push(1)';
const module_ = `        configuredDefault = hermesConfigDefault(readFileSync(join(dir, "config.yaml"), "utf8"));
function hermesInstalled(cli) {
}
    if (!options.length && !hermesUsesProbedProvider(env) && hermesInstalled(cli)) {`;

test('an installed Hermes is offered only when its settings name a model', async () => {
  const { patch } = await import(path.join(dir, 'patch-app.mjs'));
  const out = patch(bundled);
  assert.ok(out.includes('!hermesUsesProbedProvider(env)&&hermesInstalled(cli)&&hermesNamesModel(env)&&options2.push(1)'));
  assert.ok(out.includes('readFileSync132(join172(env.HERMES_HOME||harnessHome("hermes",env),"config.yaml"),"utf8"))!==null'));
  assert.ok(patch(module_).includes('!hermesUsesProbedProvider(env) && hermesInstalled(cli) && hermesNamesModel(env)) {'));
  // the new function works with the names it was given
  const make = new Function('hermesConfigDefault', 'readFileSync132', 'join172', 'harnessHome',
    `${out.match(/function hermesNamesModel[^\n]*/)[0]}\nreturn hermesNamesModel;`);
  const read = files => make(text => (text ? { model: text } : null), file => { if (!(file in files)) throw new Error('ENOENT'); return files[file]; },
    (a, b) => `${a}/${b}`, () => '/home/.hermes');
  assert.equal(read({ '/home/.hermes/config.yaml': 'm' })({}), true);
  assert.equal(read({ '/elsewhere/config.yaml': 'm' })({ HERMES_HOME: '/elsewhere' }), true);
  assert.equal(read({ '/home/.hermes/config.yaml': '' })({}), false);
  assert.equal(read({})({}), false);
});

test('anything but the expected code stops the build', async () => {
  const { patch } = await import(path.join(dir, 'patch-app.mjs'));
  assert.throws(() => patch(patch(bundled)), /already patched/);
  assert.throws(() => patch(bundled.replace('hermesUsesProbedProvider', 'other')), /exactly once/);
  assert.throws(() => patch(bundled + bundled), /exactly once/);
  assert.throws(() => patch(bundled.replace('"config.yaml"', '"other.yaml"')), /reader/);
});

// A stand-in of the official install: the same names, none of the content.
function official(stamp = {}) {
  const root = tmp();
  const src = path.join(root, 'official');
  const write = (file, text, mode = 0o644) => {
    fs.mkdirSync(path.dirname(path.join(src, file)), { recursive: true });
    fs.writeFileSync(path.join(src, file), text, { mode });
  };
  write('install-stamp.json', JSON.stringify({ baseVersion: '0.22.5', commit: 'bf0203a794a07aac3ff764972ab9087baa4e4f4e', dirty: false, ...stamp }));
  write('tools/facts.json', JSON.stringify({ packages: { chromium: { entry: 'chromium-1208' }, python: { entry: 'python-3.14.9' }, uv: { entry: 'uv' } } }));
  write('tools/chromium-1208/chrome', 'x');
  write('tools/python-3.14.9/bin/python3.14', '#!/bin/sh\n', 0o755);
  write('.venv/pyvenv.cfg', 'home = /usr/local/bin\nversion_info = 3.14.9\n');
  write('.venv/libexec/hermes', '#!/bin/sh\n', 0o755);
  fs.mkdirSync(path.join(src, '.venv/bin'), { recursive: true });
  fs.symlinkSync('/usr/local/bin/python3', path.join(src, '.venv/bin/python'));
  fs.symlinkSync('../libexec/hermes', path.join(src, '.venv/bin/hermes'));
  return { src, dest: path.join(root, 'hermes') };
}
const stage = ({ src, dest }) => spawnSync('python3', ['-I', path.join(dir, 'payload.py'), src, dest], { encoding: 'utf8' });

test('the payload is the official install without its browser, on its own Python', () => {
  const paths = official();
  const run = stage(paths);
  assert.equal(run.status, 0, run.stderr);
  const { dest } = paths;
  assert.ok(!fs.existsSync(path.join(dest, 'tools/chromium-1208')));
  const facts = JSON.parse(fs.readFileSync(path.join(dest, 'tools/facts.json'), 'utf8'));
  assert.deepEqual(Object.keys(facts.packages).sort(), ['python', 'uv']);
  assert.equal(fs.readlinkSync(path.join(dest, '.venv/bin/python')), path.join(dest, 'tools/python-3.14.9/bin/python3.14'));
  assert.equal(fs.readlinkSync(path.join(dest, '.venv/bin/hermes')), '../libexec/hermes');
  assert.equal(fs.readFileSync(path.join(dest, '.venv/pyvenv.cfg'), 'utf8'), `home = ${dest}/tools/python-3.14.9/bin\nversion_info = 3.14.9\n`);
});

test('a release that was not reviewed is refused', () => {
  for (const stamp of [{ baseVersion: '0.22.6' }, { commit: 'f'.repeat(40) }, { dirty: true }]) {
    const paths = official(stamp);
    const run = stage(paths);
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /not the reviewed release/);
    assert.ok(!fs.existsSync(paths.dest));
  }
});

test('the launcher runs the install in the image', () => {
  const text = fs.readFileSync(path.join(dir, 'hermes.sh'), 'utf8');
  assert.match(text, /^exec \/opt\/hermes\/\.venv\/bin\/hermes "\$@"$/m);
  assert.equal(spawnSync('sh', ['-n', path.join(dir, 'hermes.sh')]).status, 0);
});

test('a conversation starts the shared gateway on its own first, once Hermes has a model', () => {
  const root = tmp();
  const log = path.join(root, 'log');
  const python = path.join(root, 'python');
  fs.writeFileSync(python, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${log}\n`, { mode: 0o755 });
  const run = (...args) => {
    fs.rmSync(log, { force: true });
    spawnSync('sh', [path.join(dir, 'hermes.sh'), ...args], { env: { PATH: process.env.PATH, HERMES_HOME: root, HERMES_PYTHON: python } });
    return fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [];
  };
  assert.deepEqual(run('acp'), [], 'no settings yet');
  fs.writeFileSync(path.join(root, 'config.yaml'), 'display:\n  model: x\n');
  assert.deepEqual(run('acp'), [], 'settings without a model');
  fs.writeFileSync(path.join(root, 'config.yaml'), 'model:\n  provider: custom\n');
  assert.deepEqual(run('acp'), ['-I /opt/woowtechbot-podman/hermes/gateway.py']);
  for (const other of [['--version'], ['acp', '--help'], ['auth', 'list'], ['gateway', 'run']]) assert.deepEqual(run(...other), [], other.join(' '));
});
