// tests/hermes-gateway.mjs: closing one Hermes conversation must not end the gateway that all of them
// share. Run by tests/hermes.sh inside the throwaway container, as the bots' account. It starts and
// closes conversations the way the app does (server/procs.js): a process group of its own, and on
// close SIGTERM to the group and to every descendant, detached or not.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const home = fs.mkdtempSync('/tmp/hermes-gateway-');
fs.writeFileSync(`${home}/config.yaml`, 'model:\n  provider: custom\n  default: m\n  base_url: http://127.0.0.1:9/v1\n  api_key: not-a-key\n');
const env = { ...process.env, HERMES_HOME: home };
const pids = () => fs.readdirSync('/proc').filter(name => /^\d+$/.test(name)).map(Number);
const read = (pid, file) => { try { return fs.readFileSync(`/proc/${pid}/${file}`, 'utf8'); } catch { return ''; } };
const fields = pid => { const text = read(pid, 'stat'); return text.slice(text.lastIndexOf(')') + 2).split(' '); };
const parent = pid => Number(fields(pid)[1]);
const alive = (pid, start) => fields(pid)[19] === start && fields(pid)[0] !== 'Z';
const gateways = () => pids().filter(pid => {
  const args = read(pid, 'cmdline').split('\0');
  return ['hermes_cli.main', 'gateway', 'run'].every(arg => args.includes(arg)) && read(pid, 'environ').includes(`HERMES_HOME=${home}\0`);
});

async function open() {
  const child = spawn('hermes', ['acp'], { env, cwd: home, stdio: ['pipe', 'pipe', 'ignore'], detached: true });
  child.stdin.on('error', () => {});
  let buffer = '';
  const waiting = new Map();
  child.stdout.on('data', chunk => {
    buffer += chunk;
    for (let i; (i = buffer.indexOf('\n')) >= 0; buffer = buffer.slice(i + 1)) {
      try { const message = JSON.parse(buffer.slice(0, i)); waiting.get(message.id)?.(message); } catch { /* not a message */ }
    }
  });
  const ask = (id, method, params) => Promise.race([
    new Promise(resolve => { waiting.set(id, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); }),
    sleep(150000).then(() => { throw new Error(`${method}: no answer`); }),
  ]);
  await ask(1, 'initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } });
  const session = await ask(2, 'session/new', { cwd: home, mcpServers: [] });
  assert.ok(session.result?.sessionId, `session/new: ${JSON.stringify(session.error)}`);
  return child;
}
async function close(child) {
  const tree = [child.pid];
  for (let i = 0; i < tree.length; i += 1) for (const pid of pids()) if (parent(pid) === tree[i] && !tree.includes(pid)) tree.push(pid);
  const captured = tree.map(pid => [pid, fields(pid)[19]]);
  for (const [pid, start] of captured) if (alive(pid, start)) { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
  try { process.kill(-child.pid, 'SIGTERM'); } catch { /* gone */ }
  for (let i = 0; i < 200 && captured.some(([pid, start]) => alive(pid, start)); i += 1) await sleep(50);
}

const first = await open();
const [gateway, ...more] = gateways();
assert.ok(gateway && !more.length, 'exactly one gateway');
assert.equal(parent(gateway), 1, 'the gateway is a child of the conversation that started it');
const second = await open();
assert.deepEqual(gateways(), [gateway], 'the second conversation uses the same gateway');
await close(first);
await sleep(3000);
assert.deepEqual(gateways(), [gateway], 'closing the first conversation ended the gateway');
await close(second);
process.kill(gateway, 'SIGTERM');
console.log(JSON.stringify({ ok: true, gatewayParent: 1, survivesClosedConversation: true }));
process.exit(0);
