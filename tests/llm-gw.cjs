'use strict';
// Runs as maus inside the throwaway container created by ha-suites.sh llm-gw.
// All requests, keys and replies are synthetic; the upstream only listens on loopback.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const { once } = require('node:events');

function processes(script) {
  return fs.readdirSync('/proc').filter(p => /^\d+$/.test(p)).filter(p => {
    try { return fs.readFileSync(`/proc/${p}/cmdline`, 'utf8').split('\0').includes(script); }
    catch { return false; }
  });
}
const gateway = 'http://127.0.0.1:8092';
const mode = process.argv[2];
const headers = { 'content-type': 'application/json', authorization: 'Bearer synthetic-gw-key' };
const prompt = { model: 'fixture-model', messages: [{ role: 'user', content: 'synthetic-gw-prompt' }] };
const request = (path, body, extra = {}) => fetch(gateway + path, {
  method: 'POST', headers, body, signal: AbortSignal.timeout(5000), ...extra,
});
let checks = 0;
function passed() { checks++; }

async function main() {
  assert(['disabled', 'enabled', 'kill'].includes(mode));
  const gateways = processes('/opt/omb-addon/llm-gw.mjs');
  if (mode === 'kill') {
    assert.equal(gateways.length, 1);
    process.kill(Number(gateways[0]), 'SIGKILL');
    return;
  }
  const apps = processes('/app/dist-server/server-launcher.js');
  assert.equal(apps.length, 1);
  const env = fs.readFileSync(`/proc/${apps[0]}/environ`, 'utf8').split('\0');
  assert(env.includes(`OMB_OPENAI_COMPAT_MAX_TOKENS=${mode === 'disabled' ? 32000 : 1234}`));
  assert(!env.some(e => /^(WTB_|WOOW_WTB_)/.test(e)));
  passed();
  const listeners = ['/proc/net/tcp', '/proc/net/tcp6'].flatMap(file =>
    fs.readFileSync(file, 'utf8').trim().split('\n').slice(1).map(line => line.trim().split(/\s+/))
  ).filter(fields => fields[1].endsWith(':1F9C') && fields[3] === '0A');
  if (mode === 'disabled') {
    assert.equal(gateways.length, 0);
    assert.equal(listeners.length, 0);
    passed();
    console.log(`${checks} integration checks passed (gateway disabled)`);
    return;
  }
  assert.equal(gateways.length, 1);
  const uid = fs.readFileSync(`/proc/${gateways[0]}/status`, 'utf8').match(/^Uid:\s+(\d+)/m)[1];
  assert.equal(Number(uid), process.getuid(), 'the gateway must run as maus');
  assert.deepEqual(listeners.map(fields => fields[1]), ['0100007F:1F9C']);
  assert.equal((await fetch(gateway + '/healthz', { signal: AbortSignal.timeout(5000) })).status, 200);
  passed();

  const seen = [];
  let finishStream;
  let cancelObserved;
  const cancelled = new Promise(resolve => { cancelObserved = resolve; });
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      seen.push({ path: req.url, body: Buffer.concat(chunks).toString(), auth: req.headers.authorization });
      if (req.url.includes('stream=1')) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: first\n\n');
        finishStream = () => res.end('data: [DONE]\n\n');
      } else if (req.url.includes('cancel=1')) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: first\n\n');
        res.on('close', cancelObserved);
      } else {
        res.writeHead(req.url.includes('error=1') ? 429 : 200, {
          'content-type': 'application/json', 'retry-after': '3',
        }).end('{"fixture":true}');
      }
    });
  });
  upstream.listen(18092, '127.0.0.1');
  await once(upstream, 'listening');
  try {
    const chat = await request('/v1/chat/completions?q=synthetic-gw-query', JSON.stringify(prompt));
    assert.equal(chat.status, 200);
    await chat.text();
    assert.equal(seen.at(-1).path, '/prefix/v1/chat/completions?q=synthetic-gw-query');
    assert.equal(seen.at(-1).auth, headers.authorization);
    assert.deepEqual(JSON.parse(seen.at(-1).body), { ...prompt, max_tokens: 1234 });
    passed();
    await (await request('/v1/responses', '{"model":"fixture-model","input":"synthetic-gw-prompt"}')).text();
    assert.equal(JSON.parse(seen.at(-1).body).max_output_tokens, 1234);
    passed();
    for (const [path, field] of [
      ['/v1/chat/completions', 'max_tokens'],
      ['/v1/chat/completions', 'max_completion_tokens'],
      ['/v1/responses', 'max_output_tokens'],
    ]) {
      const body = `{ "model": "fixture-model", "${field}": 7 }`;
      await (await request(path, body)).text();
      assert.equal(seen.at(-1).body, body, 'explicit limits preserve the body byte for byte');
      passed();
    }
    await (await fetch(gateway + '/v1/models', { headers, signal: AbortSignal.timeout(5000) })).text();
    assert.equal(seen.at(-1).path, '/prefix/v1/models');
    assert.equal(seen.at(-1).body, '');
    passed();
    const stream = await request('/v1/chat/completions?stream=1', JSON.stringify({ ...prompt, stream: true }));
    assert.equal(stream.headers.get('content-type'), 'text/event-stream');
    const reader = stream.body.getReader();
    const first = await reader.read();
    assert.equal(Buffer.from(first.value).toString(), 'data: first\n\n');
    finishStream();
    let remaining = '';
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      remaining += Buffer.from(next.value).toString();
    }
    assert.equal(remaining, 'data: [DONE]\n\n');
    assert.equal(JSON.parse(seen.at(-1).body).max_tokens, 1234);
    passed();
    const abort = await request('/v1/responses?cancel=1', '{"stream":true}');
    const abortReader = abort.body.getReader();
    await abortReader.read();
    await abortReader.cancel();
    let timer;
    try {
      await Promise.race([cancelled, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('upstream was not cancelled')), 3000);
      })]);
    } finally { clearTimeout(timer); }
    passed();
    const error = await request('/v1/responses?error=1', '{}');
    assert.equal(error.status, 429);
    assert.equal(error.headers.get('retry-after'), '3');
    assert.equal(await error.text(), '{"fixture":true}');
    passed();
    const before = seen.length;
    const loop = await request('/v1/responses', '{}', { headers: { ...headers, 'x-llm-gw-hop': '1' } });
    assert.equal(loop.status, 508);
    await loop.text();
    assert.equal(seen.length, before);
    passed();
  } finally {
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
  }
  const offline = await request('/v1/responses', '{}');
  assert.equal(offline.status, 502);
  await offline.text();
  passed();
  console.log(`${checks} integration checks passed (gateway enabled)`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
