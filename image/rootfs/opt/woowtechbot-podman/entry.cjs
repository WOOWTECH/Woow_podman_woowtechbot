#!/usr/bin/env node
'use strict';
// entry.cjs: Podman entry point for the woowtechbot Home Assistant add-on image.
//
// On Home Assistant the Supervisor writes /data/options.json from the add-on options and checks
// them against config.yaml before the add-on starts. Podman has no Supervisor, so this file does
// both jobs and then runs the add-on's own /opt/omb-addon/supervisor.cjs unchanged:
//
//   1. read the WTB_* settings (the env file Quadlet passes) and the optional podman secrets
//      mounted under /run/secrets/woowtechbot-*;
//   2. check them the way the Supervisor checks config.yaml (types, ranges, url, email), then
//      with the add-on's own validators, so a bad value stops here with the setting's name;
//   3. write the options to a private tmpfs and link /data/options.json to it, so credentials
//      never land in the data volume or in its backups;
//   4. start supervisor.cjs without the WTB_* variables and pass signals and the exit code on.
//
//   node entry.cjs           validate, write, run the add-on (the container command)
//   node entry.cjs --check   validate only, write nothing; exit 0, or 78 with the problems
//   node entry.cjs --self-test   check that this image has the add-on modules entry.cjs uses
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const EX_CONFIG = 78;
const ADDON = process.env.WTB_ADDON_DIR || '/opt/omb-addon';
const SECRETS = process.env.WTB_SECRETS_DIR || '/run/secrets';
const RUN_DIR = process.env.WTB_RUN_DIR || '/run/woowtechbot';
const DATA_DIR = process.env.WTB_DATA_DIR || '/data';

// The add-on options that hold credentials come from podman secrets, never from the env file.
const SECRET_OPTIONS = Object.freeze({
  signin_relay_token: 'woowtechbot-signin-relay-token',
  signin_access_client_secret: 'woowtechbot-signin-access-client-secret',
  apporo_odoo_mcp_url: 'woowtechbot-apporo-odoo-mcp-url',
  woow_prod_odoo_mcp_url: 'woowtechbot-woow-prod-odoo-mcp-url',
  android_push_credential: 'woowtechbot-android-push-credential',
});

class ConfigError extends Error {}

function readSecret(name, dir = SECRETS) {
  const file = path.join(dir, name);
  let value;
  try { value = fs.readFileSync(file, 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw new ConfigError(`secret ${name}: cannot be read`);
  }
  // podman stores what `podman secret create` got; a trailing newline from `echo` is not part of it
  return value.replace(/\r?\n$/, '');
}

function text(env, key) {
  const value = env[key];
  if (value === undefined) return '';
  if (/[\r\n\0]/.test(value)) throw new ConfigError(`${key}: must be a single line`);
  return value.trim();
}

function isHttpUrl(value) {
  try { return ['http:', 'https:'].includes(new URL(value).protocol); } catch { return false; }
}

// buildOptions(env, secret) -> the add-on options object, the same keys and types the HA
// Supervisor writes. Unset optional settings are left out, as the Supervisor does (it rejects an
// explicit null). Throws ConfigError with every problem it found.
function buildOptions(env, secret = name => readSecret(name)) {
  const problems = [];
  const get = (key, fallback = '') => {
    try { return text(env, key) || fallback; } catch (error) { problems.push(error.message); return fallback; }
  };
  const options = {};

  const publicUrl = get('WTB_PUBLIC_URL');
  options.public_url = publicUrl;
  if (publicUrl && !isHttpUrl(publicUrl)) problems.push('WTB_PUBLIC_URL: must be an http(s) URL');
  // The add-on requires ingress_origin (HA's own address). Podman has no Ingress and never
  // publishes port 8099, so the bot's own origin stands in; without one, a loopback origin.
  options.ingress_origin = publicUrl && isHttpUrl(publicUrl) ? new URL(publicUrl).origin : 'http://127.0.0.1';

  const published = get('WTB_PUBLISHED_URL');
  if (published) {
    if (!isHttpUrl(published)) problems.push('WTB_PUBLISHED_URL: must be an http(s) URL');
    options.published_url = published;
  }
  const email = get('WTB_FIRST_ADMIN_EMAIL');
  if (email) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) problems.push('WTB_FIRST_ADMIN_EMAIL: must be one email address');
    options.first_admin_email = email;
  }
  const relay = get('WTB_SIGNIN_RELAY_URL');
  if (relay) {
    if (!isHttpUrl(relay)) problems.push('WTB_SIGNIN_RELAY_URL: must be an http(s) URL');
    options.signin_relay_url = relay;
  }
  const accessId = get('WTB_SIGNIN_ACCESS_CLIENT_ID');
  if (accessId) options.signin_access_client_id = accessId;

  const enabled = get('WTB_LLM_GW_ENABLED', 'false').toLowerCase();
  if (!['true', 'false'].includes(enabled)) problems.push('WTB_LLM_GW_ENABLED: must be true or false');
  options.llm_gw_enabled = enabled === 'true';
  options.llm_gw_upstream = get('WTB_LLM_GW_UPSTREAM');
  const maxTokens = get('WTB_LLM_GW_MAX_TOKENS', '32000');
  if (!/^\d{1,7}$/.test(maxTokens) || Number(maxTokens) < 1 || Number(maxTokens) > 1000000) {
    problems.push('WTB_LLM_GW_MAX_TOKENS: must be a whole number from 1 to 1000000');
  }
  options.llm_gw_max_tokens = Number(maxTokens);
  if (options.llm_gw_enabled && !isHttpUrl(options.llm_gw_upstream)) {
    problems.push('WTB_LLM_GW_UPSTREAM: required as an http(s) URL when WTB_LLM_GW_ENABLED=true');
  }

  const androidPushEnabled = get('WTB_ANDROID_PUSH_ENABLED', 'false').toLowerCase();
  if (!['true', 'false'].includes(androidPushEnabled)) problems.push('WTB_ANDROID_PUSH_ENABLED: must be true or false');
  options.android_push_enabled = androidPushEnabled === 'true';
  options.android_push_relay_url = get('WTB_ANDROID_PUSH_RELAY_URL');

  for (const [option, name] of Object.entries(SECRET_OPTIONS)) {
    let value = '';
    try { value = secret(name); } catch (error) { problems.push(error.message); }
    if (/[\r\n\0]/.test(value)) problems.push(`secret ${name}: must be a single line`);
    // The two Odoo options default to "" in config.yaml; the relay credentials have no default.
    if (value || option.endsWith('_odoo_mcp_url')) options[option] = value.trim();
  }
  if (problems.length) throw new ConfigError(problems.join('\n'));
  return options;
}

function turnsMaxRunning(env) {
  const value = (env.WTB_TURNS_MAX_RUNNING || '3').trim();
  if (value !== 'auto' && (!/^\d{1,3}$/.test(value) || Number(value) < 1 || Number(value) > 64)) {
    throw new ConfigError('WTB_TURNS_MAX_RUNNING: must be auto or a whole number from 1 to 64');
  }
  return value;
}

// The label of this server in the apps (OMB_SERVER_NAME), as bot.serverName on PaaS. Empty keeps the
// app's own default, the container's host name.
function serverName(env) {
  const value = text(env, 'WTB_SERVER_NAME');
  if (value.length > 64 || /[\x00-\x1f\x7f]/.test(value)) {
    throw new ConfigError('WTB_SERVER_NAME: must be at most 64 printable characters');
  }
  return value;
}

// validateWithAddon(options, addonDir): run the add-on's own checks, the ones supervisor.cjs and
// launcher.cjs run at start, so a value they would refuse is reported now with its setting name.
const OPTION_SETTING = Object.freeze({
  public_url: 'WTB_PUBLIC_URL', published_url: 'WTB_PUBLISHED_URL', ingress_origin: 'WTB_PUBLIC_URL',
  signin_relay: 'WTB_SIGNIN_RELAY_URL / woowtechbot-signin-relay-token / WTB_SIGNIN_ACCESS_CLIENT_ID',
  hosting: 'WTB_PUBLIC_URL', odoo: 'woowtechbot-*-odoo-mcp-url secrets',
  android_push: 'WTB_ANDROID_PUSH_ENABLED / WTB_ANDROID_PUSH_RELAY_URL / woowtechbot-android-push-credential',
});
function validateWithAddon(options, addonDir = ADDON) {
  const problems = [];
  const run = (label, fn) => { try { fn(); } catch (error) { problems.push(`${OPTION_SETTING[label] || label}: ${error.message}`); } };
  const load = name => require(path.join(addonDir, name));
  run('public_url', () => {
    if (!options.public_url) return;
    const u = new URL(options.public_url);
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.pathname !== '/' || u.search || u.hash) {
      throw new Error('public_url must be an http(s) origin without credentials, path, query or fragment');
    }
  });
  run('ingress_origin', () => load('ingress-path.cjs').ingressOrigin(options.ingress_origin));
  run('published_url', () => load('publication-settings.cjs').publicationSettings(options));
  run('hosting', () => load('hosting-settings.cjs').hostingSettings(options, () => 'x'.repeat(64)));
  run('signin_relay', () => load('mail-settings.cjs').mailSettings(options, {}));
  run('odoo', () => load('odoo-mcp-settings.cjs').odooMcpSettings(options));
  run('android_push', () => load('android-push-settings.cjs').androidPushSettings(options));
  if (problems.length) throw new ConfigError(problems.join('\n'));
}

// The options carry credentials: refuse to write them anywhere but a tmpfs.
function assertTmpfs(dir, mounts = fs.readFileSync('/proc/self/mounts', 'utf8')) {
  const real = fs.realpathSync(dir);
  const ok = mounts.split('\n').some(line => {
    const [, mountPoint, type] = line.split(' ');
    return type === 'tmpfs' && mountPoint === real;
  });
  if (!ok) throw new ConfigError(`${dir} is not a private tmpfs mount; refusing to write credentials there`);
}

function writeOptions(options, { runDir = RUN_DIR, dataDir = DATA_DIR, checkTmpfs = true } = {}) {
  fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(runDir, 0o700);
  if (checkTmpfs) assertTmpfs(runDir);
  const target = path.join(runDir, 'options.json');
  const tmp = path.join(runDir, `.options.${process.pid}.json`);
  fs.writeFileSync(tmp, JSON.stringify(options), { mode: 0o600, flag: 'w' });
  fs.renameSync(tmp, target);
  const link = path.join(dataDir, 'options.json');
  let current = null;
  try { current = fs.lstatSync(link); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (current && current.isSymbolicLink() && fs.readlinkSync(link) === target) return target;
  // A regular file here comes from an older layout or an imported HA backup; Podman's settings
  // are the source of truth, and its credentials must not stay in the volume.
  if (current) fs.rmSync(link, { force: true });
  fs.symlinkSync(target, link);
  return target;
}

// The add-on and the bots it runs get the image's environment, not this edition's settings or
// installer knobs (WTB_*, WOOW_WTB_*): they already reached the add-on through options.json.
function addonEnvironment(env, turns, name = '') {
  const out = {};
  for (const [key, value] of Object.entries(env)) if (!/^(WTB_|WOOW_WTB_)/.test(key)) out[key] = value;
  if (turns !== 'auto') out.OMB_TURNS_MAX_RUNNING = turns;
  if (name) out.OMB_SERVER_NAME = name;
  return out;
}

function selfTest(addonDir = ADDON) {
  const want = {
    'supervisor.cjs': null, 'launcher.cjs': null, 'qr.cjs': 'qrSvg',
    'ingress-path.cjs': 'ingressOrigin', 'publication-settings.cjs': 'publicationSettings',
    'hosting-settings.cjs': 'hostingSettings', 'mail-settings.cjs': 'mailSettings',
    'odoo-mcp-settings.cjs': 'odooMcpSettings',
    'android-push-settings.cjs': 'androidPushSettings',
  };
  for (const [file, fn] of Object.entries(want)) {
    const full = path.join(addonDir, file);
    if (!fs.existsSync(full)) throw new Error(`add-on file missing: ${full}`);
    if (fn && typeof require(full)[fn] !== 'function') throw new Error(`${full} no longer exports ${fn}()`);
  }
  for (const user of ['maus', 'woow-mcp']) {
    if (!fs.readFileSync('/etc/passwd', 'utf8').split('\n').some(line => line.startsWith(user + ':'))) {
      throw new Error(`image user ${user} missing`);
    }
  }
}

function main(argv = process.argv.slice(2), env = process.env) {
  const mode = argv[0] || 'run';
  if (mode === '--self-test') { selfTest(); console.log('entry: self-test passed'); return; }
  let options, turns, name;
  try {
    options = buildOptions(env);
    turns = turnsMaxRunning(env);
    name = serverName(env);
    validateWithAddon(options);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    console.error('woowtechbot: the settings are not valid; nothing was started.');
    for (const line of error.message.split('\n')) console.error('  - ' + line);
    console.error('Fix ~/.config/woowtechbot/woowtechbot.env or the podman secrets, then run scripts/install.sh again.');
    process.exit(EX_CONFIG);
  }
  if (mode === '--check') { console.log('woowtechbot: settings OK'); return; }
  if (mode !== 'run') { console.error(`entry: unknown argument ${mode}`); process.exit(2); }
  try { writeOptions(options); } catch (error) {
    console.error(`woowtechbot: ${error.message}`);
    process.exit(EX_CONFIG);
  }
  const child = spawn(process.execPath, [path.join(ADDON, 'supervisor.cjs')], {
    stdio: 'inherit', env: addonEnvironment(env, turns, name),
  });
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    process.on(signal, () => { if (child.exitCode === null) child.kill(signal); });
  }
  child.on('error', error => { console.error(`woowtechbot: cannot start the add-on: ${error.message}`); process.exit(1); });
  child.on('exit', (code, signal) => {
    process.exit(code ?? (signal ? 128 + (os.constants.signals[signal] || 0) : 1));
  });
}

module.exports = {
  EX_CONFIG, SECRET_OPTIONS, ConfigError, addonEnvironment, assertTmpfs, buildOptions, readSecret,
  selfTest, serverName, turnsMaxRunning, validateWithAddon, writeOptions,
};
if (require.main === module) main();
