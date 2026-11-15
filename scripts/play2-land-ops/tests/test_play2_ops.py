#!/usr/bin/env python3 -I
"""Single tests of play2_ops.py (v2) against DUMMY targets only: a `python3 -c sleep` whose argv looks like the
launcher's. No launcher, no world, no port. Every process signalled is one this test started (by its pid)."""
import json, os, signal, subprocess, sys, tempfile, time, unittest

OPS = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'play2_ops.py')
sys.path.insert(0, os.path.dirname(OPS))
import play2_ops as P  # noqa: E402

ROOT = '/nonexistent/play2-test-root'


class Case(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(dir=os.environ.get('OPS_TEST_TMP') or None)
        self.data = os.path.join(self.tmp, 'data')
        self.state = os.path.join(self.tmp, 'state'); os.mkdir(self.state)
        self.kids = []

    def tearDown(self):
        for p in self.kids:
            if p.poll() is None:
                p.kill(); p.wait()

    def dummy(self, data=None, root=ROOT):
        p = subprocess.Popen([sys.executable, '-I', '-c', 'import time; time.sleep(60)',
                              '/x/local-play-launcher.mjs', '--root', root, '--data', data or self.data])
        self.kids.append(p); time.sleep(0.3)
        return p

    def ops(self, role, target, start=None, **kw):
        args = [sys.executable, '-I', OPS, role, '--state', self.state, '--log', os.path.join(self.tmp, role + '.jsonl'),
                '--target-pid', str(target.pid), '--target-start', start or P.lstart_of(target.pid), '--root', ROOT,
                '--data', self.data, '--t0', str(kw.pop('t0', int(time.time()))), '--interval', '0.2', '--peer-grace', '1']
        for k, v in kw.items():
            args += ['--' + k.replace('_', '-'), str(v)]
        p = subprocess.Popen(args); self.kids.append(p)
        return p

    def log(self, role):
        try:
            return [json.loads(l) for l in open(os.path.join(self.tmp, role + '.jsonl'))]
        except FileNotFoundError:
            return []

    def wait_dead(self, p, s=8):
        end = time.time() + s
        while time.time() < end and p.poll() is None:
            time.sleep(0.1)
        return p.poll() is not None

    def pair(self, target, **wkw):
        g = self.ops('guard', target, **{k: v for k, v in wkw.items() if k in ('free_floor_bytes', 'limit_bytes')})
        w = self.ops('watchdog', target, deadline=wkw.get('deadline', int(time.time()) + 600))
        end = time.time() + 5
        while time.time() < end and not (os.path.exists(os.path.join(self.state, 'guard.armed')) and os.path.exists(os.path.join(self.state, 'watchdog.armed'))):
            time.sleep(0.1)
        return g, w

    # -------------------------------------------------------------- tests
    def test_arm_both_and_limits_only_tighten(self):
        t = self.dummy()
        g, w = self.pair(t, free_floor_bytes=1, limit_bytes=10 ** 12)  # asks to relax: must be clamped
        ga = json.load(open(os.path.join(self.state, 'guard.armed')))
        wa = json.load(open(os.path.join(self.state, 'watchdog.armed')))
        self.assertEqual(ga['floor'], 21 * 1024 ** 3)
        self.assertEqual(ga['limit'], 110 * 1024 ** 2)
        self.assertLessEqual(wa['deadline'], wa['end'] - 300)
        self.assertLessEqual(ga['end'] - int(ga['end'] - 9000), 9000)
        self.assertIsNone(t.poll(), 'nothing fired on a healthy run')

    def test_total_output_over_limit_stops_target(self):
        os.makedirs(os.path.join(self.data, 'w1')); os.makedirs(os.path.join(self.data, 'w2'))
        # two worlds of 60 MiB apparent size each (sparse): together over 110 MiB though each is under
        for w in ('w1', 'w2'):
            with open(os.path.join(self.data, w, 'big'), 'wb') as f: f.truncate(60 * 1024 ** 2)
        t = self.dummy()
        self.pair(t)
        self.assertTrue(self.wait_dead(t), 'target stopped')
        self.assertTrue(any(r.get('why') == 'total output >= limit' and r.get('signal') == 2 for r in self.log('guard')))

    def test_free_floor_checked_with_no_world(self):
        t = self.dummy()  # self.data does not exist at all
        self.pair(t, free_floor_bytes=10 ** 18)  # a stricter floor than any disk: must fire
        self.assertTrue(self.wait_dead(t))
        self.assertTrue(any(r.get('why') == 'free < floor' for r in self.log('guard')))

    def test_refuses_to_arm_for_another_data_dir(self):
        t = self.dummy(data='/elsewhere/data')
        g = self.ops('guard', t)
        g.wait(5)
        self.assertEqual(g.returncode, 5)
        self.assertFalse(os.path.exists(os.path.join(self.state, 'guard.armed')))
        self.assertIsNone(t.poll(), 'not signalled')

    def test_refuses_a_reused_pid(self):
        t = self.dummy()
        g = self.ops('guard', t, start='Mon Jan  1 00:00:00 2001')
        g.wait(5)
        self.assertEqual(g.returncode, 5)
        self.assertIsNone(t.poll())

    def test_identity_rechecked_right_before_signal(self):
        t = self.dummy()
        r = P.Run(type('A', (), dict(role='guard', free_floor_bytes=0, limit_bytes=0, t0=int(time.time()),
                                     log=os.path.join(self.tmp, 'direct.jsonl'), target_pid=t.pid,
                                     target_start='Mon Jan  1 00:00:00 2001', root=ROOT, data=self.data))())
        self.assertFalse(r.signal_target(signal.SIGINT, 'test'))
        self.assertIsNone(t.poll(), 'a start-time mismatch is never signalled')

    def test_watchdog_deadline_sigint(self):
        t = self.dummy()
        self.pair(t, deadline=int(time.time()) + 2)
        self.assertTrue(self.wait_dead(t, 10))
        self.assertTrue(any(r.get('why') == 'deadline' and r.get('signal') == 2 for r in self.log('watchdog')))

    def test_deadline_cannot_pass_the_window(self):
        t = self.dummy()
        t0 = int(time.time())
        w = self.ops('watchdog', t, t0=t0, deadline=t0 + 4 * 3600)
        end = time.time() + 5
        while time.time() < end and not os.path.exists(os.path.join(self.state, 'watchdog.armed')): time.sleep(0.1)
        self.assertEqual(json.load(open(os.path.join(self.state, 'watchdog.armed')))['deadline'], t0 + 145 * 60)

    def test_guard_gone_watchdog_stops_target(self):
        t = self.dummy()
        g, w = self.pair(t)
        g.kill(); g.wait()  # our own child, by its pid
        self.assertTrue(self.wait_dead(t, 10))
        self.assertTrue(any(r.get('why') == 'guard gone' for r in self.log('watchdog')))

    def test_watchdog_gone_guard_stops_target(self):
        t = self.dummy()
        g, w = self.pair(t)
        w.kill(); w.wait()
        self.assertTrue(self.wait_dead(t, 10))
        self.assertTrue(any(r.get('why') == 'watchdog gone' for r in self.log('guard')))

    def test_target_exit_ends_both(self):
        t = self.dummy()
        g, w = self.pair(t)
        t.terminate(); t.wait()
        self.assertTrue(self.wait_dead(g) and self.wait_dead(w))


START = os.path.join(os.path.dirname(OPS), 'play2-start.sh')
EXAMPLE = os.path.join(os.path.dirname(OPS), 'play2.conf.example')


class Starter(unittest.TestCase):
    """The starter stops on its config (or, for the untouched template, on its first file check): none of these reaches
    the port/process checks, let alone the arming or the launcher."""
    def run_start(self, *args, conf=None):
        if conf is not None:
            fd, path = tempfile.mkstemp(suffix='.conf', dir=os.environ.get('OPS_TEST_TMP') or None)
            os.write(fd, conf.encode()); os.close(fd)
            args = ('--config', path) + args
        r = subprocess.run(['zsh', START, *args], capture_output=True, text=True, timeout=30)
        return r.returncode, r.stdout + r.stderr

    def test_no_config_stops(self):
        code, out = self.run_start('--preflight-only')
        self.assertEqual(code, 3); self.assertIn('no --config given', out)

    def test_unedited_template_stops(self):
        code, out = self.run_start('--config', EXAMPLE, '--preflight-only')
        self.assertEqual(code, 3); self.assertIn('STOP', out); self.assertNotIn('preflight ok', out)

    def test_missing_key_stops(self):
        conf = ''.join(l for l in open(EXAMPLE) if not l.startswith('DATA_DIR='))
        code, out = self.run_start('--preflight-only', conf=conf)
        self.assertEqual(code, 3); self.assertIn('DATA_DIR missing', out)

    def test_relative_path_stops(self):
        conf = open(EXAMPLE).read().replace('DATA_DIR=/ABSOLUTE/PATH/TO/a-new-records-directory', 'DATA_DIR=relative/dir')
        code, out = self.run_start('--preflight-only', conf=conf)
        self.assertEqual(code, 3); self.assertIn('DATA_DIR is not absolute', out)

    def test_shell_characters_stop(self):
        conf = open(EXAMPLE).read().replace('DATA_DIR=/ABSOLUTE/PATH/TO/a-new-records-directory', 'DATA_DIR=/tmp/x;touch_y')
        code, out = self.run_start('--preflight-only', conf=conf)
        self.assertEqual(code, 3); self.assertIn('shell character', out)

    def test_unknown_key_and_short_sha_stop(self):
        code, out = self.run_start('--preflight-only', conf=open(EXAMPLE).read() + 'EXTRA=1\n')
        self.assertEqual(code, 3); self.assertIn('unknown config key EXTRA', out)
        conf = open(EXAMPLE).read().replace('SHA_HERALD=' + '0' * 64, 'SHA_HERALD=cd5a9281')
        code, out = self.run_start('--preflight-only', conf=conf)
        self.assertEqual(code, 3); self.assertIn('SHA_HERALD is not a full sha256', out)


if __name__ == '__main__':
    unittest.main(verbosity=2)
