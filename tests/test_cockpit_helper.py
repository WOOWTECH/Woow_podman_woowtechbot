"""python3 -m unittest tests/test_cockpit_helper.py: the Cockpit page's root helper.

The helper runs here as the current account (it switches accounts only when it runs as root), with a
fake podman and systemctl. The fake podman runs the real pair.cjs against tests/cockpit-lab/fake-app.cjs,
so the helper, the pairing tool and the app contract are tested together."""
import importlib.machinery
import importlib.util
import json
import os
from pathlib import Path
import pwd
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.request

REPO = Path(__file__).resolve().parent.parent
HELPER = REPO / 'cockpit' / 'woowtech-cockpit-woowtechbot'
NODE = shutil.which('node')
ME = pwd.getpwuid(os.getuid()).pw_name
INSPECT = [{
    'Config': {'Labels': {'io.woowtech.app': 'woowtechbot', 'org.opencontainers.image.version': '0.1.7-rc.14-3'}},
    'State': {'Status': 'running', 'Health': {'Status': 'healthy'}, 'StartedAt': '2026-11-24T13:35:23.676893393+08:00'},
    'ImageName': 'localhost/woowtechbot-podman:0.1.7-rc.14-3',
    'NetworkSettings': {'Ports': {'8080/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '18799'}], '8081/tcp': None}},
}]
FAKE_PODMAN = '''#!/bin/bash
printf '%s\\n' "$*" >> {log}
case $1 in
  --version) echo "podman version 4.9.3" ;;
  container)
    [[ $2 == inspect && $3 == woowtechbot && -f {inspect} ]] || {{ echo "Error: no such container woowtechbot" >&2; exit 125; }}
    cat {inspect} ;;
  exec)
    [[ $2 == woowtechbot && $3 == node && $4 == /opt/woowtechbot-podman/pair.cjs ]] || exit 125
    shift 4
    if [[ -f {flags}/hang ]]; then echo $$ > {flags}/pid; exec sleep 30; fi
    if [[ -f {flags}/flood ]]; then head -c 2000000 /dev/zero | tr '\\0' x; exit 0; fi
    if [[ -f {flags}/old ]]; then echo '用法：scripts/pair.sh browser | phone | list | cancel browser|phone|all' >&2; exit 2; fi
    exec env WTB_OWNER_API={api} WTB_ADDON_DIR={addon} WTB_OPTIONS_FILE={options} WTB_SERVER_NAME=lab-bot {node} {pair} "$@" ;;
  *) exit 125 ;;
esac
'''
FAKE_SYSTEMCTL = '#!/bin/sh\nprintf "ActiveState=active\\nSubState=running\\nNRestarts=0\\nLoadState=loaded\\n"\n'


def load_helper():
    loader = importlib.machinery.SourceFileLoader('cockpit_helper_under_test', str(HELPER))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


@unittest.skipUnless(NODE, 'node is needed for pair.cjs and the fake app')
class HelperTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix='wtb-helper-'))
        cls.app = subprocess.Popen([NODE, str(REPO / 'tests/cockpit-lab/fake-app.cjs')], stdout=subprocess.PIPE, text=True,
                                   env={'PATH': os.environ.get('PATH', ''), 'WTB_FAKE_OWNER_PORT': '0',
                                        'WTB_FAKE_PUBLIC_URL': 'https://bot.example.com'})
        cls.api = f'http://127.0.0.1:{cls.app.stdout.readline().strip()}'

    @classmethod
    def tearDownClass(cls):
        cls.app.terminate()
        cls.app.wait(10)
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(dir=self.tmp))
        self.flags = self.dir / 'flags'
        self.flags.mkdir()
        (self.dir / 'bin').mkdir()
        self.log = self.dir / 'podman.log'
        self.inspect = self.dir / 'inspect.json'
        self.inspect.write_text(json.dumps(INSPECT))
        options = self.dir / 'options.json'
        options.write_text(json.dumps({'public_url': 'https://bot.example.com', 'published_url': 'https://apps.example.net',
                                       'first_admin_email': 'a@example.com'}))
        podman = self.dir / 'bin/podman'
        podman.write_text(FAKE_PODMAN.format(log=self.log, inspect=self.inspect, flags=self.flags, api=self.api,
                                             addon=REPO / 'tests/fixtures/addon', options=options, node=NODE,
                                             pair=REPO / 'image/rootfs/opt/woowtechbot-podman/pair.cjs'))
        systemctl = self.dir / 'bin/systemctl'
        systemctl.write_text(FAKE_SYSTEMCTL)
        for f in (podman, systemctl):
            f.chmod(0o755)
        runtime = self.dir / 'run' / str(os.getuid())
        runtime.mkdir(parents=True)
        (runtime / 'bus').touch()
        config = self.dir / 'config.json'
        config.write_text(json.dumps({'owner': ME}))
        config.chmod(0o644)
        self.h = load_helper()
        self.h.CONFIG, self.h.TRUSTED_UID, self.h.RUNTIME = config, os.getuid(), str(self.dir / 'run' / '{uid}')
        self.h.PODMAN, self.h.SYSTEMCTL = str(podman), str(systemctl)
        self.h.LOCKS, self.h.SERVICES_PAGE = self.dir / 'locks', self.dir / 'no-services-page'
        self.h.is_root = lambda: True
        self.by = 'alice'
        self.h.caller = lambda: self.by
        self.audits = []
        self.h.audit = lambda by, action, result: self.audits.append((by, action, result))
        self.clear_app()

    def clear_app(self):
        for entry in self.fetch('/api/auth/pairing')['pairings']:
            self.fetch(f'/api/auth/pairing/{entry["id"]}', 'DELETE')
        for entry in self.fetch('/api/auth/sessions')['sessions']:
            self.fetch(f'/api/auth/sessions/{entry["id"]}', 'DELETE')

    def fetch(self, route, method='GET', body=None):
        data = json.dumps(body).encode() if body is not None else None
        request = urllib.request.Request(self.api + route, data=data, method=method,
                                         headers={'content-type': 'application/json'})
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                return json.loads(response.read())
        except urllib.error.HTTPError as error:
            return {'status': error.code}

    def labels(self):
        return sorted(entry['label'] for entry in self.fetch('/api/auth/pairing')['pairings'])

    def main(self, *argv):
        return self.h.main(list(argv))

    def test_refuses_without_administrative_access(self):
        self.h.is_root = lambda: False
        with self.assertRaisesRegex(self.h.BotError, '管理員存取權限'):
            self.main('state')

    def test_state_shows_the_container_the_app_and_no_code(self):
        self.main('pair', 'browser')
        state = self.main('state')
        self.assertEqual(state['owner'], ME)
        self.assertEqual(state['by'], 'alice')
        self.assertEqual(state['podman'], '4.9.3')
        self.assertEqual(state['container']['status'], 'running')
        self.assertEqual(state['container']['local'], 'http://127.0.0.1:18799')
        self.assertEqual(state['container']['startedAt'], 1795498523676)
        self.assertEqual(state['container']['version'], '0.1.7-rc.14-3')
        self.assertEqual(state['unit']['active'], 'active')
        app = state['app']
        self.assertEqual(app['serverName'], 'lab-bot')
        self.assertEqual((app['publicUrl'], app['publishedUrl']), ('https://bot.example.com', 'https://apps.example.net'))
        self.assertEqual((app['adminEmailConfigured'], app['emailReady']), (True, False))
        self.assertEqual(app['engines'], [{'id': 'claude', 'name': 'Claude', 'ready': False},
                                          {'id': 'codex', 'name': 'Codex', 'ready': True}])
        self.assertEqual([(p['label'], p['kind']) for p in app['pending']], [('Cockpit browser (alice)', 'browser')])
        self.assertNotIn('code', json.dumps(state).lower().replace('codex', ''))
        self.assertFalse(state['servicesPage'])

    def test_state_without_the_container(self):
        self.inspect.unlink()
        state = self.main('state')
        self.assertIsNone(state['container'])
        self.assertIsNone(state['app'])

    def test_a_container_of_another_project_is_refused(self):
        other = json.loads(json.dumps(INSPECT))
        other[0]['Config']['Labels'] = {}
        self.inspect.write_text(json.dumps(other))
        with self.assertRaisesRegex(self.h.BotError, '不是這個專案'):
            self.main('state')

    def test_pair_browser_and_phone(self):
        browser = self.main('pair', 'browser')['pairing']
        self.assertRegex(browser['code'], r'^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$')
        self.assertEqual(browser['url'], f'https://bot.example.com/pair#code={browser["code"]}')
        self.assertIsNone(browser['qrSvg'])
        phone = self.main('pair', 'phone')['pairing']
        self.assertTrue(phone['inviteUrl'].startswith('openmausbot://pair?'))
        self.assertTrue(phone['qrSvg'].startswith('<svg'))
        self.assertEqual(phone['server'], 'https://bot.example.com')
        self.assertTrue(abs(phone['now'] - time.time() * 1000) < 60000)
        log = self.log.read_text()
        for code in (browser['code'], phone['code']):
            self.assertNotIn(code, log, 'a code never goes on a command line')
        self.assertIn('--by alice', log)
        self.assertEqual(self.audits, [('alice', 'pair-browser', 'ok'), ('alice', 'pair-phone', 'ok')])

    def test_each_administrator_has_their_own_codes(self):
        first = self.main('pair', 'browser')['pairing']
        self.by = 'bob'
        self.main('pair', 'browser')
        self.assertEqual(self.labels(), ['Cockpit browser (alice)', 'Cockpit browser (bob)'])
        self.by = 'alice'
        again = self.main('pair', 'browser')['pairing']
        self.assertNotEqual(first['id'], again['id'])
        self.assertEqual(self.labels(), ['Cockpit browser (alice)', 'Cockpit browser (bob)'], 'only alice\'s old code was replaced')
        self.assertEqual(self.main('cancel', 'browser'), {'cancelled': 1})
        self.assertEqual(self.labels(), ['Cockpit browser (bob)'])

    def test_a_used_code_becomes_a_device_that_can_be_signed_out(self):
        pairing = self.main('pair', 'phone')['pairing']
        self.assertEqual(self.fetch('/api/auth/pair', 'POST', {'code': pairing['code'], 'label': 'Pixel'})['ok'], True)
        state = self.main('poll')
        self.assertEqual(state['app']['pending'], [])
        device = state['app']['devices'][0]
        self.assertEqual((device['label'], device['scopes']), ('Pixel', ['admin', 'client']))
        self.assertNotIn('token', json.dumps(state))
        self.assertEqual(self.main('signout', device['id']), {'signedOut': device['id'], 'label': 'Pixel'})
        self.assertEqual(self.main('poll')['app']['devices'], [])
        with self.assertRaisesRegex(self.h.BotError, '找不到這台裝置'):
            self.main('signout', device['id'])
        self.assertEqual(self.audits[-1], ('alice', f'signout-{device["id"][:8]}', 'failed'))

    def test_bad_requests_are_refused(self):
        for argv in ([], ['pair'], ['pair', 'tablet'], ['cancel', 'all'], ['state', 'x'], ['signout'],
                     ['signout', '-rf'], ['signout', '../x'], ['signout', 'a b'], ['signout', 'x' * 65], ['rm', 'x']):
            with self.subTest(argv=argv), self.assertRaisesRegex(self.h.BotError, '不支援'):
                self.main(*argv)

    def test_an_older_bot_image_is_explained(self):
        (self.flags / 'old').touch()
        state = self.main('state')
        self.assertIsNone(state['app'])
        self.assertIn('版本比頁面舊', state['appError'])
        with self.assertRaisesRegex(self.h.BotError, '版本比頁面舊'):
            self.main('pair', 'browser')

    def test_one_change_at_a_time(self):
        self.h.LOCKS.mkdir(mode=0o700)
        import fcntl
        with open(self.h.LOCKS / 'alice-browser', 'w') as held:
            fcntl.flock(held, fcntl.LOCK_EX)
            with self.assertRaisesRegex(self.h.BotError, '上一個操作還在進行'):
                self.main('pair', 'browser')
        self.assertEqual(self.labels(), [])
        self.main('pair', 'browser')

    def test_a_hanging_command_is_stopped(self):
        (self.flags / 'hang').touch()
        self.h.TIMEOUT = 1
        started = time.monotonic()
        with self.assertRaisesRegex(self.h.BotError, '逾時'):
            self.main('poll')
        self.assertLess(time.monotonic() - started, 15)
        pid = int((self.flags / 'pid').read_text())
        for _ in range(50):
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                break
            time.sleep(0.1)
        else:
            self.fail('the command still runs')

    def test_too_much_output_is_refused(self):
        (self.flags / 'flood').touch()
        with self.assertRaisesRegex(self.h.BotError, '過大'):
            self.main('poll')

    def test_the_settings_file_must_be_safe(self):
        config = self.h.CONFIG
        config.chmod(0o666)
        with self.assertRaisesRegex(self.h.BotError, '不可讓其他帳號寫入'):
            self.main('state')
        config.chmod(0o644)
        for content, message in ((json.dumps({'owner': 'root'}), '一般帳號'), (json.dumps({'owner': 'no-such-user-x'}), '找不到'),
                                 (json.dumps({'owner': 'a b'}), '帳號名稱'), ('[', '格式不正確'), (json.dumps({}), '格式不正確')):
            with self.subTest(content=content):
                config.write_text(content)
                with self.assertRaisesRegex(self.h.BotError, message):
                    self.main('state')
        link = config.with_name('link.json')
        link.symlink_to(config)
        self.h.CONFIG = link
        with self.assertRaisesRegex(self.h.BotError, '符號連結'):
            self.main('state')

    def test_the_caller(self):
        h = load_helper()
        loginuid = self.dir / 'loginuid'
        loginuid.write_text(str(os.getuid()))
        self.assertEqual(h.caller(loginuid, {}), ME)
        loginuid.write_text('4294967295')
        self.assertEqual(h.caller(loginuid, {'SUDO_UID': str(os.getuid())}), ME)
        self.assertEqual(h.caller(loginuid, {'SUDO_UID': '0'}), 'root')
        self.assertEqual(h.caller(self.dir / 'missing', {'PKEXEC_UID': 'x'}), 'root')

    def test_one_json_object_when_run_as_a_program(self):
        if os.geteuid() == 0:
            self.skipTest('needs a non-root account')
        result = subprocess.run([sys.executable, '-I', str(HELPER), 'state'], capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(json.loads(result.stdout), {'error': '請先在 Cockpit 頂端開啟「管理員存取權限」。'})


if __name__ == '__main__':
    unittest.main()
