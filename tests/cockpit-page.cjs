'use strict';
// tests/cockpit-page.cjs: the woowtechbot page in a real Cockpit, with a real browser. Run it with
// tests/cockpit-lab.sh test, which sets LAB_URL, LAB_STATE, LAB_NAME, LAB_PODMAN and LAB_VERSION.
// Needs playwright-core (NODE_PATH) and a Chromium (PLAYWRIGHT_CHROMIUM_EXECUTABLE). Passwords are
// read from LAB_STATE and never printed; the screenshots in LAB_STATE/shots show lab codes only.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { chromium } = require('playwright-core');

const base = process.env.LAB_URL;
const state = process.env.LAB_STATE;
const version = process.env.LAB_VERSION;
const podman = (process.env.LAB_PODMAN || 'podman').split(' ');
const name = process.env.LAB_NAME;
const shots = path.join(state, 'shots');
fs.mkdirSync(shots, { recursive: true, mode: 0o700 });
const password = account => fs.readFileSync(path.join(state, `${account}.pass`), 'utf8').trim();
const CODE = /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/;
const steps = [];
const codes = [];
const step = (text, detail) => { steps.push(detail === undefined ? text : `${text}: ${detail}`); };
const check = (condition, message) => { if (!condition) throw new Error(message); };

// lab ARGS [input]: a command in the lab "host"; bot ARGS: the same as the bot's account
function lab(args, input) {
  const result = spawnSync(podman[0], [...podman.slice(1), 'exec', '-i', name, ...args], { input, encoding: 'utf8', timeout: 120000 });
  return { status: result.status, out: result.stdout || '', err: result.stderr || '' };
}
function bot(args, input) {
  return lab(['runuser', '-u', 'botowner', '--', 'env', '-i', 'PATH=/usr/bin:/bin', 'HOME=/home/botowner',
    'XDG_RUNTIME_DIR=/run/user/1203', 'DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1203/bus', ...args], input);
}
// A device redeems a code, as the app does; the code goes in on stdin.
function redeem(code, label) {
  const script = 'let s="";process.stdin.on("data",d=>s+=d).on("end",async()=>{const r=await fetch("http://127.0.0.1:8799/api/auth/pair",' +
    '{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({code:s.trim(),label:process.argv[1]})});' +
    'process.stdout.write(String(r.status))})';
  return bot(['podman', 'exec', '-i', 'woowtechbot', 'node', '-e', script, label], code).out;
}

async function login(browser, account) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, locale: 'en-US', viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.locator('#login-user-input').fill(account);
  await page.locator('#login-password-input').fill(password(account));
  await page.locator('#login-button').click();
  await page.waitForURL('**/system', { timeout: 90000 });
  return { context, page };
}

async function manifests(page) {
  const response = await page.request.get(`${base}/cockpit/@localhost/manifests.json`);
  check(response.ok(), `manifests.json: ${response.status()}`);
  return Object.keys(await response.json());
}

async function openPage(page) {
  await page.goto(`${base}/woowtechbot`, { waitUntil: 'domcontentloaded' });
  const iframe = page.locator('iframe[src*="/woowtechbot/index.html"]');
  await iframe.waitFor({ state: 'attached', timeout: 60000 });
  const frame = await (await iframe.elementHandle()).contentFrame();
  await frame.waitForLoadState('domcontentloaded');
  return frame;
}

async function adminAccess(page, on, account) {
  const indicator = page.getByRole('button', { name: /^(Limited access|Administrative access)$/ });
  await indicator.waitFor({ timeout: 60000 });
  const limited = /Limited/.test(await indicator.textContent());
  if (on && limited) {
    await indicator.click();
    await page.locator('#switch-to-admin-access-password').fill(password(account));
    await page.getByRole('button', { name: /^Authenticate$/ }).click();
    await page.locator('#switch-to-admin-access-password').waitFor({ state: 'detached', timeout: 60000 });
  } else if (!on && !limited) {
    await indicator.click();
    await page.getByRole('button', { name: /^Limit access$/ }).click();
  }
  await page.getByRole('button', { name: on ? /^Administrative access$/ : /^Limited access$/ }).waitFor({ timeout: 60000 });
}

const text = async (frame, id) => (await frame.locator(`#${id}`).textContent()).trim();
const shown = (frame, id, timeout = 90000) => frame.locator(`#${id}`).waitFor({ state: 'visible', timeout });
const says = (frame, id, pattern, timeout = 90000) =>
  frame.locator(`#${id}`).filter({ hasText: pattern }).waitFor({ state: 'visible', timeout });

(async () => {
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined;
  const browser = await chromium.launch({ executablePath });
  let failed = null;
  try {
    // A user who is not an administrator does not get the page at all.
    {
      const { context, page } = await login(browser, 'labviewer');
      check(!(await manifests(page)).includes('woowtechbot'), 'labviewer was offered the page');
      const direct = await page.request.get(`${base}/cockpit/@localhost/woowtechbot/manifest.json`);
      check(direct.status() === 404, `labviewer read the page's files: ${direct.status()}`);
      const overview = await (await page.locator('iframe[src*="/system/index.html"]').elementHandle()).contentFrame();
      const spawned = await overview.evaluate(() => window.cockpit.spawn(['/usr/local/libexec/woowtech-cockpit-woowtechbot', 'state'],
        { superuser: 'require', err: 'message' }).then(() => 'ran', error => error.problem || error.message));
      check(spawned !== 'ran', 'labviewer ran the helper');
      step('labviewer: no page, its files 404, the helper refused', spawned);
      await context.close();
    }

    const { context, page } = await login(browser, 'labadmin');
    check((await manifests(page)).includes('woowtechbot'), 'labadmin was not offered the page');
    check(await page.locator('a[href="/woowtechbot"]').count() > 0, 'the page is not in the menu');
    let frame = await openPage(page);
    await shown(frame, 'access-note');
    check(await frame.locator('#content').isHidden(), 'content shown without administrative access');
    step('labadmin, limited access: the page asks for administrative access');

    await adminAccess(page, true, 'labadmin');
    await says(frame, 'status-badge', '運作中');
    check((await text(frame, 'fact-podman')).includes('botowner'), 'the account is not shown');
    check((await text(frame, 'fact-version')).startsWith(version), `version: ${await text(frame, 'fact-version')}`);
    check((await text(frame, 'fact-engines')) === 'Claude 未登入、Codex 已登入', `engines: ${await text(frame, 'fact-engines')}`);
    check((await text(frame, 'fact-public')) === 'https://bot.lab.example', 'public address');
    check((await frame.locator('#open-bot').getAttribute('href')) === 'https://bot.lab.example/', 'open link');
    step('administrative access on: the status loads by itself', `${await text(frame, 'fact-version')}; ${await text(frame, 'fact-engines')}`);
    await page.screenshot({ path: path.join(shots, 'status.png'), fullPage: true });

    await frame.locator('#browser-generate').click();
    await shown(frame, 'browser-secret');
    let code = await frame.locator('#browser-code').inputValue();
    codes.push(code);
    check(CODE.test(code), 'browser code format');
    check((await frame.locator('#browser-open').getAttribute('href')) === `https://bot.lab.example/pair#code=${code}`, 'pair link');
    check((await frame.locator('#browser-open').getAttribute('target')) === '_blank', 'the link opens a new tab');
    await says(frame, 'browser-countdown', /^剩餘 (09|10):\d\d$/, 15000);
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
    await frame.locator('#browser-copy-code').click();
    await says(frame, 'feedback', /已複製配對碼|不允許複製/, 15000);
    step('browser code made, link and countdown shown, copy', await text(frame, 'feedback'));

    // Leaving the page forgets the code; coming back offers to cancel it.
    frame = await openPage(page);
    await says(frame, 'browser-state', '還沒使用的配對碼');
    check(await frame.locator('#browser-secret').isHidden(), 'the code is shown again after leaving');
    check(!(await frame.content()).includes(code), 'the code is still in the page');
    await frame.locator('#browser-cancel').click();
    await says(frame, 'browser-state', '已取消');
    check(!bot(['podman', 'exec', 'woowtechbot', 'node', '/opt/woowtechbot-podman/pair.cjs', 'list', '--json']).out.includes('labadmin'),
      'the cancelled code is still pending');
    step('back on the page: the code is gone from the screen and can be cancelled');

    await frame.locator('#browser-generate').click();
    await shown(frame, 'browser-secret');
    code = await frame.locator('#browser-code').inputValue();
    codes.push(code);
    check(redeem(code, 'Lab Browser') === '200', 'redeem');
    check(redeem(code, 'Again') === '401', 'a code works only once');
    await says(frame, 'browser-state', '配對完成：「Lab Browser」已登入。', 60000);
    await frame.locator('#devices-body tr', { hasText: 'Lab Browser' }).waitFor({ timeout: 30000 });
    step('a device uses the code: the page says so and lists the device');

    await frame.locator('#phone-generate').click();
    await shown(frame, 'phone-secret');
    const phoneCode = await frame.locator('#phone-code').inputValue();
    codes.push(phoneCode);
    check(CODE.test(phoneCode), 'phone code format');
    check((await frame.locator('#phone-address').inputValue()) === 'https://bot.lab.example', 'server address');
    check((await frame.locator('#phone-qr').getAttribute('src')).startsWith('data:image/svg+xml'), 'QR image');
    check((await frame.locator('#phone-open').getAttribute('href')).startsWith('openmausbot://pair?'), 'app link');
    const labels = JSON.parse(bot(['podman', 'exec', 'woowtechbot', 'node', '/opt/woowtechbot-podman/pair.cjs', 'list', '--json']).out)
      .map(p => p.label);
    check(labels.includes('Cockpit phone (labadmin)'), `labels: ${labels}`);
    await page.screenshot({ path: path.join(shots, 'phone.png'), fullPage: true });
    step('phone code: QR, address, code and app link; the code is labelled with the administrator', labels.join(', '));

    await frame.locator('#devices-body tr', { hasText: 'Lab Browser' }).getByRole('button', { name: '登出 Lab Browser' }).click();
    await shown(frame, 'signout-dialog', 15000);
    await frame.locator('#signout-confirm').click();
    await says(frame, 'feedback', '已登出「Lab Browser」');
    await frame.locator('#devices-body tr', { hasText: 'Lab Browser' }).waitFor({ state: 'detached', timeout: 30000 });
    step('sign-out of a device from the list');

    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(shots, 'phone-width.png'), fullPage: true });
    await page.setViewportSize({ width: 1280, height: 900 });

    await adminAccess(page, false, 'labadmin');
    await shown(frame, 'access-note', 60000);
    check(await frame.locator('#content').isHidden(), 'content still shown after limiting access');
    check(!(await frame.content()).includes(phoneCode), 'the phone code is still in the page');
    step('administrative access off: the page hides everything and forgets the codes');

    const audit = lab(['journalctl', '-t', 'woowtech-cockpit-woowtechbot', '--no-pager', '-o', 'cat']).out.trim().split('\n');
    check(audit.some(line => line === 'by=labadmin action=pair-browser result=ok'), `audit: ${audit}`);
    const leaks = lab(['sh', '-c', 'f=$(mktemp); cat > "$f"; journalctl --no-pager -o cat | grep -c -F -f "$f"; rm -f "$f"'], codes.join('\n')).out.trim();
    check(leaks === '0', `codes in the journal: ${leaks}`);
    step('audit log names the administrator and holds no code', `${audit.length} lines`);
    await context.close();
  } catch (error) {
    failed = String(error && error.message || error).split('\n')[0];
  } finally {
    await browser.close();
  }
  console.log(JSON.stringify({ ok: !failed, error: failed || undefined, steps }, null, 2));
  process.exit(failed ? 1 : 0);
})();
