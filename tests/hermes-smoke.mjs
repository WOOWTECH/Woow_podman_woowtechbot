// tests/hermes-smoke.mjs: the Hermes engine in the built image, run by tests/hermes.sh inside a
// throwaway container without network, as the bots' account. A scripted model service on the
// container's own loopback answers Hermes, so no account, no key and no real model is used. Prints
// check names, counts and seconds only.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';

const BASE = 'http://127.0.0.1:8799';
const MODEL = 'loopback-model';
const reply = `HERMES-LOOPBACK-${randomUUID()}`;
const seconds = {};
let stage = 'start';
let asked = 0;        // model requests that carried tools: the bot's own turns
let catalog = [];     // the bot tools Hermes looks up with tool_search (it lists few tools outright)
let steps = [];       // what the scripted model does before it answers: one tool call each
let results = [];     // the tool results it was given back
let messageId = '';   // the user message of the turn

async function timed(name, work) {
  const started = Date.now();
  const value = await work();
  seconds[name] = Math.round((Date.now() - started) / 100) / 10;
  return value;
}
function hermes(...args) {
  const run = spawnSync('hermes', args, { encoding: 'utf8', timeout: 180000, stdio: ['ignore', 'pipe', 'pipe'] });
  assert.ok(!run.error && run.status === 0, `hermes ${args[0]} ${args[1] || ''}: exit ${run.status}`);
  return run.stdout.trim();
}
async function api(method, route, body, want = 200) {
  const res = await fetch(BASE + route, { method, signal: AbortSignal.timeout(180000),
    headers: { 'content-type': 'application/json', connection: 'close' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  assert.equal(res.status, want, `${method} ${route.split('?')[0]}`);
  return res.json();
}
async function engine() {
  const { instances } = await api('GET', '/api/instances');
  const found = instances.filter(entry => entry.driverKind === 'hermesAgent');
  assert.equal(found.length, 1);
  return { state: found[0].snapshot?.state, models: (found[0].models?.options || []).map(option => option.id) };
}
// what the Cockpit page and scripts/pair.sh would say about it
function shownAsReady() {
  const run = spawnSync('node', ['/opt/woowtechbot-podman/pair.cjs', 'state'], { encoding: 'utf8', timeout: 60000 });
  return JSON.parse(run.stdout).engines.find(entry => entry.id === 'hermes')?.ready;
}

// An OpenAI-compatible chat service: lists one model, does the steps of the turn, then answers.
const service = http.createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const json = value => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); };
  if (req.method === 'GET') return json({ object: 'list', data: [{ id: MODEL, object: 'model', context_length: 128000 }] });
  const body = JSON.parse(raw || '{}');
  const tools = (body.tools || []).map(tool => tool.function).filter(Boolean);
  let message = { role: 'assistant', content: 'ok' };
  let finish_reason = 'stop';
  if (tools.length) {
    asked += 1;
    catalog = [...(tools.find(tool => tool.name === 'tool_search')?.description || '').matchAll(/^- (\S+?):/gm)].map(m => m[1]);
    results = (body.messages || []).filter(entry => entry.role === 'tool').map(entry =>
      typeof entry.content === 'string' ? entry.content : JSON.stringify(entry.content));
    message.content = reply;
    const call = steps.shift()?.();
    if (call) {
      finish_reason = 'tool_calls';
      message = { role: 'assistant', content: null, tool_calls: [{ index: 0, id: `call_${asked}`, type: 'function',
        function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] };
    }
  }
  const base = { id: 'x', created: 1, model: MODEL };
  if (!body.stream) {
    return json({ ...base, object: 'chat.completion', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      choices: [{ index: 0, message, finish_reason }] });
  }
  res.setHeader('content-type', 'text/event-stream');
  for (const [delta, finish] of [[message, null], [{}, finish_reason]]) {
    res.write(`data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
  }
  res.end('data: [DONE]\n\n');
});

try {
  assert.equal(process.env.HOME, '/data');
  assert.notEqual(process.getuid(), 0);

  stage = 'version';
  const version = await timed('version', async () => hermes('--version'));
  assert.ok(version.includes('Hermes Agent v0.22.5') && version.includes('bf0203a7'), 'not the reviewed release');

  stage = 'read-only install';
  assert.equal(fs.statSync('/opt/hermes').uid, 0);
  for (const dir of ['/opt/hermes', '/opt/hermes/.venv', '/opt/hermes/tools']) {
    assert.throws(() => fs.accessSync(dir, fs.constants.W_OK), `${dir} is writable`);
  }
  assert.ok(!fs.readdirSync('/opt/hermes/tools').some(name => name.startsWith('chromium')), 'the browser package is there');
  assert.ok(!JSON.parse(fs.readFileSync('/opt/hermes/tools/facts.json', 'utf8')).packages.chromium);
  assert.ok(fs.existsSync('/opt/hermes/LICENSE'));

  stage = 'usage statistics are off';
  for (const key of ['enabled', 'send']) assert.equal(hermes('config', 'get', `telemetry.shared_metrics.${key}`), 'false');

  // Out of the box Hermes borrows (and rewrites) Claude Code's sign-in; this image must not let it.
  const claude = '/data/.claude/.credentials.json';
  fs.mkdirSync('/data/.claude', { recursive: true });
  const signIn = JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-not-a-token', refreshToken: 'sk-ant-ort01-not-a-token',
    expiresAt: 1000, scopes: ['user:inference'], subscriptionType: 'max' } });
  fs.writeFileSync(claude, signIn, { mode: 0o600 });

  stage = 'not set up: offered no model';
  assert.equal(process.env.HERMES_ACP_MODELS_TIMEOUT_MS, '60000');
  await api('POST', '/api/instances/hermes/refresh-models', {});
  assert.deepEqual(await engine(), { state: 'available', models: [] });
  assert.equal(shownAsReady(), false);

  stage = 'set up';
  await new Promise((resolve, reject) => { service.once('error', reject); service.listen(0, '127.0.0.1', resolve); });
  for (const [key, value] of [['model.provider', 'custom'], ['model.base_url', `http://127.0.0.1:${service.address().port}/v1`],
    ['model.api_key', 'not-a-key'], ['model.default', MODEL]]) hermes('config', 'set', key, value);
  await timed('refresh', () => api('POST', '/api/instances/hermes/refresh-models', {}));
  const now = await engine();
  assert.equal(now.state, 'available');
  assert.ok(now.models.includes('hermes-default'));
  assert.equal(shownAsReady(), true);

  stage = 'bot';
  const { bot } = await api('POST', '/api/bots', { name: 'Hermes smoke', useDefaults: false,
    settings: { computer: 'off', browser: false, mcpServers: [] },
    modelSelection: { instanceId: 'hermes', model: 'hermes-default' }, requireAvailableModel: true }, 201);
  const turn = (name, text) => timed(name, async () => {
    stage = name;
    const before = asked;
    const thread = `/api/threads/${bot.threadId}/messages?limit=100`;
    await api('POST', `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text }, 202);
    messageId = (await api('GET', thread)).messages.findLast(message => message.role === 'user').id;
    for (const end = Date.now() + 240000; ;) {
      const { messages } = await api('GET', thread);
      const mine = messages.slice(messages.findLastIndex(message => message.role === 'user') + 1);
      const done = mine.find(message => message.turnTerminal);
      if (done && asked > before) {
        assert.equal(done.turnSucceeded, true);
        assert.ok(done.text.includes(reply));
        return mine;
      }
      assert.ok(Date.now() < end, 'the turn did not end');
      await sleep(300);
    }
  });
  await turn('firstTurn', 'Smoke, first message.');
  await turn('secondTurn', 'Smoke, second message.');

  // Hermes uses the bot's own tools, which it finds with tool_search: an uploaded Big5 file is read with
  // document_read, and a file made in its shell is attached with attach_file.
  const botTool = (name, args) => {
    const full = catalog.find(entry => entry.endsWith(`__${name}`));
    assert.ok(full, `${name} is not in the tool catalog`);
    return { name: 'tool_call', arguments: { calls: [{ name: full, arguments: args }] } };
  };
  stage = 'upload';
  const big5 = spawnSync('iconv', ['-f', 'UTF-8', '-t', 'BIG5'], { input: '品名,金額\n蘋果,120\n香蕉,80\n' }).stdout;
  const upload = await fetch(`${BASE}/api/files?name=big5.csv&uploadId=${randomUUID()}`, { method: 'POST', body: big5,
    headers: { 'content-type': 'text/csv', connection: 'close' } });
  assert.equal(upload.status, 201);
  const { path: uploaded } = await upload.json();
  const made = () => results.join('\n').match(/\/data\/\S*?made-by-hermes\.txt/)?.[0];
  steps = [
    () => botTool('document_read', { message_id: messageId, reference: 'big5.csv' }),
    () => ({ name: 'terminal', arguments: { command: 'echo made > made-by-hermes.txt && realpath made-by-hermes.txt' } }),
    () => botTool('attach_file', { path: made() }),
  ];
  const answered = await turn('toolTurn', `Smoke, read the file and attach one.\n\n<attached-file path="${uploaded}" name="big5.csv" />`);
  stage = 'the bot tools work from Hermes';
  assert.ok(results.some(text => text.includes('蘋果') && text.includes('120')), 'document_read did not read the Big5 file');
  assert.ok(made(), 'the shell made no file');
  const attached = answered.flatMap(message => message.files || message.attachments || []).map(entry => entry.name);
  assert.deepEqual(attached, ['made-by-hermes.txt']);
  for (const name of ['publish_app', 'coordinate_bots']) botTool(name);

  stage = "Claude Code's sign-in is left alone";
  assert.equal(fs.readFileSync(claude, 'utf8'), signIn);
  const signIns = hermes('auth', 'list');
  assert.match(signIns, /External CLI logins \(Codex CLI, Claude Code\) are not adopted/);
  assert.doesNotMatch(signIns, /anthropic|claude_code/i);
  assert.doesNotMatch(hermes('status'), /anthropic|claude/i);
  spawnSync('hermes', ['config', 'set', 'auth.adopt_external_logins', 'true'], { timeout: 60000 });
  assert.equal(hermes('config', 'get', 'auth.adopt_external_logins').toLowerCase(), 'false', 'a user could turn it on');

  console.log(JSON.stringify({ ok: true, version: 'v0.22.5', modelsBeforeSetUp: 0, modelsAfterSetUp: now.models.length,
    turns: 3, claudeSignInTouched: false, botTools: catalog.filter(name => name.startsWith('mcp__')).length, attached, realModel: false, seconds }));
} catch (error) {
  console.error(`FAILED at "${stage}": ${String(error?.message ?? error).slice(0, 300)} ${JSON.stringify({ asked, botTools: catalog.length, results: results.map(text => text.slice(0, 160)).slice(-3), seconds })}`);
  process.exitCode = 1;
} finally {
  service.closeAllConnections();
  service.close();
}
