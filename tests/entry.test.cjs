'use strict';
// node --test tests/: entry.cjs with test doubles of the add-on modules (tests/fixtures/addon).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ADDON = path.join(__dirname, 'fixtures', 'addon');
const entry = require('../image/rootfs/opt/woowtechbot-podman/entry.cjs');
const { ConfigError } = entry;

const made = [];
function tmpdir(prefix) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); made.push(dir); return dir; }
test.after(() => { for (const dir of made) fs.rmSync(dir, { recursive: true, force: true }); });

const noSecrets = () => '';
// Built from parts so the repo's credential scan does not flag this fake token.
const TOKEN = ['wtbha1', '12345678-1234-1234-1234-123456789abc', 'A'.repeat(43)].join('.');

test('defaults give the HA add-on default options and leave the optional ones out', () => {
  assert.deepEqual(entry.buildOptions({}, noSecrets), {
    public_url: '', ingress_origin: 'http://127.0.0.1', llm_gw_enabled: false, llm_gw_upstream: '',
    llm_gw_max_tokens: 32000, apporo_odoo_mcp_url: '', woow_prod_odoo_mcp_url: '',
  });
});

test('every setting maps to its add-on option', () => {
  const secrets = { 'woowtechbot-signin-relay-token': TOKEN, 'woowtechbot-signin-access-client-secret': 's3cr3t',
    'woowtechbot-apporo-odoo-mcp-url': 'https://apun-mcp-odoo.example.io/private_x/mcp' };
  const options = entry.buildOptions({
    WTB_PUBLIC_URL: 'https://bot.example.com', WTB_PUBLISHED_URL: 'https://apps.example.net',
    WTB_FIRST_ADMIN_EMAIL: 'admin@example.com', WTB_SIGNIN_RELAY_URL: 'https://relay.example.com/api/woowtechbot/signin-mail',
    WTB_SIGNIN_ACCESS_CLIENT_ID: 'abc.access', WTB_LLM_GW_ENABLED: 'TRUE', WTB_LLM_GW_UPSTREAM: 'https://llm.example.com',
    WTB_LLM_GW_MAX_TOKENS: '64000',
  }, name => secrets[name] || '');
  assert.equal(options.ingress_origin, 'https://bot.example.com');
  assert.equal(options.published_url, 'https://apps.example.net');
  assert.equal(options.first_admin_email, 'admin@example.com');
  assert.equal(options.signin_relay_token, TOKEN);
  assert.equal(options.signin_access_client_secret, 's3cr3t');
  assert.equal(options.signin_access_client_id, 'abc.access');
  assert.equal(options.apporo_odoo_mcp_url, 'https://apun-mcp-odoo.example.io/private_x/mcp');
  assert.equal(options.woow_prod_odoo_mcp_url, '');
  assert.equal(options.llm_gw_enabled, true);
  assert.equal(options.llm_gw_max_tokens, 64000);
});

test('the ingress origin is the bot origin without path', () => {
  assert.equal(entry.buildOptions({ WTB_PUBLIC_URL: 'http://192.168.1.5:18799' }, noSecrets).ingress_origin, 'http://192.168.1.5:18799');
});

test('schema problems are all reported with their setting names', () => {
  assert.throws(() => entry.buildOptions({
    WTB_PUBLIC_URL: 'ftp://x', WTB_LLM_GW_ENABLED: 'yes', WTB_LLM_GW_MAX_TOKENS: '0', WTB_FIRST_ADMIN_EMAIL: 'nobody',
  }, noSecrets), error => {
    assert.ok(error instanceof ConfigError);
    for (const key of ['WTB_PUBLIC_URL', 'WTB_LLM_GW_ENABLED', 'WTB_LLM_GW_MAX_TOKENS', 'WTB_FIRST_ADMIN_EMAIL']) {
      assert.match(error.message, new RegExp(key));
    }
    return true;
  });
});

test('the gateway needs an upstream when it is on', () => {
  assert.throws(() => entry.buildOptions({ WTB_LLM_GW_ENABLED: 'true' }, noSecrets), /WTB_LLM_GW_UPSTREAM/);
});

test('multi-line values are refused, also in secrets', () => {
  assert.throws(() => entry.buildOptions({ WTB_SIGNIN_ACCESS_CLIENT_ID: 'a\nb' }, noSecrets), /single line/);
  assert.throws(() => entry.buildOptions({}, name => name.endsWith('relay-token') ? 'a\nb' : ''), /single line/);
});

test('turns: default 3, auto, a range check', () => {
  assert.equal(entry.turnsMaxRunning({}), '3');
  assert.equal(entry.turnsMaxRunning({ WTB_TURNS_MAX_RUNNING: 'auto' }), 'auto');
  assert.equal(entry.turnsMaxRunning({ WTB_TURNS_MAX_RUNNING: '5' }), '5');
  assert.throws(() => entry.turnsMaxRunning({ WTB_TURNS_MAX_RUNNING: '0' }), ConfigError);
  assert.throws(() => entry.turnsMaxRunning({ WTB_TURNS_MAX_RUNNING: '65' }), ConfigError);
});

test('the server name: empty keeps the app default, a name is passed on, bad ones are refused', () => {
  assert.equal(entry.serverName({}), '');
  assert.equal(entry.serverName({ WTB_SERVER_NAME: '  woowtechbot-家裡  ' }), 'woowtechbot-家裡');
  assert.equal(entry.addonEnvironment({}, '3', 'my-bot').OMB_SERVER_NAME, 'my-bot');
  assert.equal(entry.addonEnvironment({}, '3').OMB_SERVER_NAME, undefined);
  assert.throws(() => entry.serverName({ WTB_SERVER_NAME: 'x'.repeat(65) }), ConfigError);
  assert.throws(() => entry.serverName({ WTB_SERVER_NAME: 'a\nb' }), ConfigError);
  assert.throws(() => entry.serverName({ WTB_SERVER_NAME: 'a\tb' }), ConfigError);
});

test('the add-on gets no WTB_ or WOOW_WTB_ variables, and the turn limit', () => {
  const env = entry.addonEnvironment({ WTB_PUBLIC_URL: 'x', WOOW_WTB_PORT: '1', TZ: 'Asia/Taipei', OMB_X: '1' }, '3');
  assert.deepEqual(env, { TZ: 'Asia/Taipei', OMB_X: '1', OMB_TURNS_MAX_RUNNING: '3' });
  assert.equal(entry.addonEnvironment({}, 'auto').OMB_TURNS_MAX_RUNNING, undefined);
});

test('the add-on validators run and name the setting', () => {
  const base = entry.buildOptions({ WTB_PUBLIC_URL: 'https://bot.example.com' }, noSecrets);
  entry.validateWithAddon(base, ADDON);
  assert.throws(() => entry.validateWithAddon({ ...base, public_url: 'https://bot.example.com/path' }, ADDON), /WTB_PUBLIC_URL/);
  assert.throws(() => entry.validateWithAddon({ ...base, published_url: 'https://x.bot.example.com' }, ADDON), /WTB_PUBLISHED_URL/);
  assert.throws(() => entry.validateWithAddon({ ...base, signin_relay_url: 'https://relay.example.com/api/woowtechbot/signin-mail' }, ADDON),
    /WTB_SIGNIN_RELAY_URL.*both/);
  assert.throws(() => entry.validateWithAddon({ ...base, apporo_odoo_mcp_url: 'https://h/x' }, ADDON), /odoo-mcp-url/);
});

test('secrets: missing is empty, one trailing newline is dropped', () => {
  const dir = tmpdir('wtb-secrets-');
  fs.writeFileSync(path.join(dir, 'woowtechbot-signin-relay-token'), TOKEN + '\n');
  assert.equal(entry.readSecret('woowtechbot-signin-relay-token', dir), TOKEN);
  assert.equal(entry.readSecret('woowtechbot-apporo-odoo-mcp-url', dir), '');
});

test('options go to the run dir with mode 0600 and /data/options.json links to them', () => {
  const root = tmpdir('wtb-write-');
  const runDir = path.join(root, 'run'), dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir);
  fs.writeFileSync(path.join(dataDir, 'options.json'), '{"old":true}');
  const target = entry.writeOptions({ public_url: '' }, { runDir, dataDir, checkTmpfs: false });
  assert.equal(fs.statSync(target).mode & 0o777, 0o600);
  assert.equal(fs.statSync(runDir).mode & 0o777, 0o700);
  assert.ok(fs.lstatSync(path.join(dataDir, 'options.json')).isSymbolicLink());
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'options.json'), 'utf8')), { public_url: '' });
  entry.writeOptions({ public_url: 'x' }, { runDir, dataDir, checkTmpfs: false });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'options.json'), 'utf8')), { public_url: 'x' });
  assert.deepEqual(fs.readdirSync(runDir), ['options.json']);
});

test('credentials are written to a tmpfs only', () => {
  const dir = tmpdir('wtb-tmpfs-');
  const real = fs.realpathSync(dir);
  entry.assertTmpfs(dir, `tmpfs ${real} tmpfs rw 0 0\n`);
  assert.throws(() => entry.assertTmpfs(dir, `/dev/sda1 ${real} ext4 rw 0 0\n`), ConfigError);
});

test('--check exits 78 with the setting names, before anything is written', () => {
  const { spawnSync } = require('node:child_process');
  const root = tmpdir('wtb-check-');
  const env = { PATH: process.env.PATH, WTB_ADDON_DIR: ADDON, WTB_SECRETS_DIR: root, WTB_RUN_DIR: path.join(root, 'run'),
    WTB_DATA_DIR: root, WTB_LLM_GW_MAX_TOKENS: 'many' };
  const bad = spawnSync(process.execPath, [require.resolve('../image/rootfs/opt/woowtechbot-podman/entry.cjs'), '--check'], { env, encoding: 'utf8' });
  assert.equal(bad.status, 78);
  assert.match(bad.stderr, /WTB_LLM_GW_MAX_TOKENS/);
  assert.equal(fs.existsSync(path.join(root, 'run')), false);
  const good = spawnSync(process.execPath, [require.resolve('../image/rootfs/opt/woowtechbot-podman/entry.cjs'), '--check'],
    { env: { ...env, WTB_LLM_GW_MAX_TOKENS: '32000' }, encoding: 'utf8' });
  assert.equal(good.status, 0, good.stderr);
});

test('the Hermes gateway is found by its command line and ended', async () => {
  const proc = fs.mkdtempSync(path.join(os.tmpdir(), 'wtb-proc-'));
  const add = (pid, ...args) => { fs.mkdirSync(path.join(proc, pid)); fs.writeFileSync(path.join(proc, pid, 'cmdline'), args.join('\0') + '\0'); };
  add('7', '/opt/hermes/.venv/bin/python', '-m', 'hermes_cli.main', '--profile', 'default', 'gateway', 'run', '--quiet', '--idle-exit');
  add('8', '/opt/hermes/.venv/bin/python', '/opt/hermes/.venv/bin/hermes', 'acp');
  add('9', 'node', '-e', 'gateway run hermes_cli.main');
  fs.mkdirSync(path.join(proc, '10'));
  fs.mkdirSync(path.join(proc, 'self'));
  assert.deepEqual(entry.hermesGateways(proc), [7]);

  const sent = [];
  let left = [7];
  await entry.stopHermes({ list: () => left, kill: (pid, signal) => { sent.push([pid, signal]); setTimeout(() => { left = []; }, 150); }, seconds: 5 });
  assert.deepEqual(sent, [[7, 'SIGTERM']]);
  const started = Date.now();
  await entry.stopHermes({ list: () => [7], kill: () => { throw new Error('ESRCH'); }, seconds: 0.3 });
  assert.ok(Date.now() - started < 3000, 'a gateway that does not end is not waited for forever');
});
