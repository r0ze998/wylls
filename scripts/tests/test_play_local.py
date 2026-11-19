#!/usr/bin/env python3
"""scripts/play-local.sh: argument parsing and refusals (no build, no port, no world).

  python3 -I scripts/tests/test_play_local.py

Every case runs the real script with --print-plan (prints the resolved settings and exits before any check or
build) or with an argument it must refuse before that point. PLAY_LOCAL_STATE points at a temp dir so nothing is
written into the checkout.
"""
import os, re, subprocess, sys, tempfile, unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
SCRIPT = os.path.join(ROOT, 'scripts', 'play-local.sh')
TMP = tempfile.mkdtemp(prefix='play-local-test-')


def read(path):
    with open(path, encoding='utf-8') as f:
        return f.read()


def run(*args, env_extra=None):
    env = {k: v for k, v in os.environ.items() if k not in ('SOLANA_URL', 'SOLANA_RPC_URL', 'ANCHOR_PROVIDER_URL')}
    env.update({'PLAY_LOCAL_STATE': TMP, 'LANG': 'en_US.UTF-8', 'LC_ALL': ''})
    env.update(env_extra or {})
    p = subprocess.run(['bash', SCRIPT, *args], capture_output=True, text=True, env=env, timeout=30)
    return p.returncode, p.stdout, p.stderr


def kept_state(port=41920, ai=2, sha='ab' * 32, two=None):
    """A state dir holding one kept world as play-local writes it (play-local.conf + last-kept), and nothing else.
    `two`: None writes no `two=` line (a world kept before --two existed), else its value."""
    st = tempfile.mkdtemp(prefix='play-local-state-')
    world = os.path.join(st, 'kept', '20261119-000000')
    os.makedirs(world)
    with open(os.path.join(world, 'play-local.conf'), 'w') as f:
        extra = '' if two is None else f'two={two}\n'
        f.write(f'# test\ncreated=20261119-000000\ncommit=0000000\nport={port}\nai={ai}\n{extra}sha256={sha}\n')
    with open(os.path.join(st, 'last-kept'), 'w') as f:
        f.write(world + '\n')
    return st, world


def plan(*args, **kw):
    code, out, err = run('--print-plan', *args, **kw)
    assert code == 0, (code, out, err)
    return dict(line.split('=', 1) for line in out.splitlines() if '=' in line)


class Defaults(unittest.TestCase):
    def test_defaults(self):
        p = plan()
        self.assertEqual(p['cluster'], 'localnet')
        self.assertEqual(p['test_only'], 'yes')
        self.assertEqual((p['ai'], p['speed'], p['minutes'], p['port'], p['world_port']), ('2', 'natural', '90', '41920', '41924'))
        self.assertEqual(p['ports'], '41920-41941')  # 2 worlds x 5 + 2 x 4 operator relays from 41924
        self.assertEqual((p['world'], p['mode']), ('kept', 'fresh'))
        self.assertEqual(p['build'], 'when-changed')
        self.assertTrue(p['data'].startswith(TMP + '/kept/'))

    def test_default_is_a_kept_world(self):
        line = plan()['launcher']
        for w in ['--world-preset local-natural-v1', '--economy page-signed-v1', '--march-trial local-march-trial-v1',
                  '--continuous local-continuous-v1', '--persist local-persist-v1', '--operator-residents 2',
                  '--port 41920', '--world-port 41924', '--world-ttl-minutes 90']:
            self.assertIn(w, line)
        # (the launcher refuses persistence with the capture demo: none of the demo's words)
        for bad in ['--capture-demo', '--demo-scale', '--world-option', '--herald-output', 'devnet', 'mainnet', 'keypair']:
            self.assertNotIn(bad, line)

    def test_launcher_line_is_test_only_capture_demo(self):
        p = plan('--demo')
        self.assertEqual((p['world'], p['speed']), ('demo', '60'))
        self.assertTrue(p['data'].startswith(TMP + '/worlds/'))
        line = p['launcher']
        self.assertNotIn('--persist', line)
        self.assertNotIn('--continuous', line)
        for w in ['--world-preset local-natural-v1', '--economy page-signed-v1', '--march-trial local-march-trial-v1',
                  '--capture-demo capture-demo-v1', '--demo-scale 60', '--world-option land-preview-v1',
                  '--herald-output compact-v2', '--operator-residents 2', '--port 41920', '--world-port 41924',
                  '--world-ttl-minutes 90']:
            self.assertIn(w, line)
        for bad in ['devnet', 'mainnet', 'testnet', 'keypair', '--external-residents', '--contest-pair', 'api.']:
            self.assertNotIn(bad, line)
        self.assertIn('/deploy-localnet-land-sbf/permutation_frontier.so', line)
        self.assertIn('/frontier-node/target/debug/localnet-natural-play', line)


class Flags(unittest.TestCase):
    def test_ai(self):
        self.assertNotIn('--operator-residents', plan('--ai', '0')['launcher'])
        self.assertEqual(plan('--ai', '0')['ports'], '41920-41933')
        self.assertIn('--operator-residents 4', plan('--ai', '4')['launcher'])
        for bad in ['5', '-1', 'two', '', '1.5', '99']:
            code, _, err = run('--print-plan', '--ai', bad)
            self.assertEqual(code, 2, (bad, err))

    def test_speed_and_minutes(self):
        self.assertIn('--demo-scale 10', plan('--demo', '--speed', '10')['launcher'])
        self.assertEqual(run('--print-plan', '--speed', '30')[0], 2)  # a kept world has no compressed clock
        self.assertIn('--world-ttl-minutes 45', plan('--minutes', '45')['launcher'])
        for bad in ['9', '61', '0', 'x']:
            self.assertEqual(run('--print-plan', '--demo', '--speed', bad)[0], 2, bad)
        for bad in ['14', '241', 'x']:
            self.assertEqual(run('--print-plan', '--minutes', bad)[0], 2, bad)

    def test_port(self):
        p = plan('--port', '41972')
        self.assertEqual((p['world_port'], p['ports']), ('41976', '41972-41993'))
        self.assertEqual(plan('--port', '41000', '--ai', '0')['ports'], '41000-41013')
        for bad in ['40999', '41990', '42000', '41900', '41904', '41950', 'abc', '4192x']:
            code, _, err = run('--print-plan', '--port', bad)
            self.assertEqual(code, 2, (bad, err))
        # 41970 is refused by the relay: --port 41950 with residents spans 41950-41971
        self.assertIn('41970', run('--print-plan', '--port', '41950')[2])
        self.assertEqual(run('--print-plan', '--port', '41956', '--ai', '0')[0], 0)  # 41956-41969 clear of 41970

    def test_lang(self):
        self.assertEqual(plan('--lang', 'ja')['lang'], 'ja')
        self.assertEqual(plan('--lang', 'en')['lang'], 'en')
        self.assertEqual(plan(env_extra={'LANG': 'ja_JP.UTF-8'})['lang'], 'ja')
        self.assertEqual(run('--print-plan', '--lang', 'fr')[0], 2)
        code, _, err = run('--print-plan', '--lang', 'ja', '--ai', '9')
        self.assertEqual(code, 2)
        self.assertIn('0〜4', err)  # the refusal is in the chosen language

    def test_build_flags(self):
        self.assertEqual(plan('--rebuild')['build'], 'always')
        self.assertEqual(plan('--no-build')['build'], 'never')
        self.assertEqual(run('--print-plan', '--rebuild', '--no-build')[0], 2)
        self.assertEqual(plan('--no-open')['open'], 'no')
        self.assertEqual(plan('--fresh')['mode'], 'fresh')

    def test_unknown_and_missing_values(self):
        for args in (['--bogus'], ['--ai'], ['--port'], ['--ai', '--fresh'], ['-x'], ['devnet']):
            code, _, err = run('--print-plan', *args)
            self.assertEqual(code, 2, (args, err))

    def test_help(self):
        code, out, _ = run('--help')
        self.assertEqual(code, 0)
        for w in ['--ai N', '--fresh', '--resume', '--lang ja|en', '--port BASE', 'TEST-ONLY']:
            self.assertIn(w, out)


class Refusals(unittest.TestCase):
    def test_non_test_cluster_refused(self):
        for c in ['devnet', 'mainnet', 'mainnet-beta', 'testnet', 'https://api.devnet.solana.com', 'Localnet', 'local']:
            code, out, err = run('--print-plan', '--cluster', c)
            self.assertEqual(code, 4, (c, out, err))
            self.assertIn('TEST only', err)
            self.assertEqual(out, '')
        self.assertEqual(plan('--cluster', 'localnet')['cluster'], 'localnet')

    def test_remote_rpc_env_refused(self):
        for v in ['SOLANA_URL', 'SOLANA_RPC_URL', 'ANCHOR_PROVIDER_URL']:
            for u in ['https://api.devnet.solana.com', 'https://api.mainnet-beta.solana.com', 'http://10.0.0.1:8899',
                      'http://localhost.evil.example:8899']:
                code, _, err = run('--print-plan', env_extra={v: u})
                self.assertEqual(code, 4, (v, u, err))
            self.assertEqual(run('--print-plan', env_extra={v: 'http://127.0.0.1:8899'})[0], 0)

    def test_resume_without_a_kept_world_is_refused(self):
        launcher = read(os.path.join(ROOT, 'permutation-gateway/src/frontier/local-play-launcher.mjs'))
        self.assertTrue("'persist'" in launcher and "'continuous'" in launcher)  # PR #38 is on this main
        st = tempfile.mkdtemp(prefix='play-local-empty-')
        code, out, err = run('--print-plan', '--resume', env_extra={'PLAY_LOCAL_STATE': st})
        self.assertEqual(code, 5, err)
        self.assertIn('no kept world', err)
        self.assertEqual(out, '')
        self.assertEqual(run('--print-plan', '--fresh', '--resume')[0], 2)
        self.assertEqual(run('--print-plan', '--resume', '--fresh')[0], 2)
        self.assertEqual(run('--print-plan', '--resume', '--demo')[0], 2)  # a demo world is never kept

    def test_random_map_is_opt_in_and_only_for_a_new_world(self):
        # (without the flag: the launcher line is as before, the map is the fixed one, and the plan says so)
        p = plan()
        self.assertEqual(p['map'], 'fixed')
        self.assertNotIn('--fresh-map', p['launcher'])
        for extra in [(), ('--fresh',), ('--demo',), ('--demo', '--speed', '30'), ('--ai', '0')]:
            p = plan('--random-map', *extra)
            self.assertEqual(p['map'], 'fresh', extra)
            self.assertEqual(p['launcher'].count('--fresh-map local-fresh-map-v1'), 1, extra)
        # (a kept world keeps the map it was made with: never with --resume, in either order, before any write)
        st, _ = kept_state()
        for args in [('--random-map', '--resume'), ('--resume', '--random-map')]:
            code, out, err = run('--print-plan', *args, env_extra={'PLAY_LOCAL_STATE': st})
            self.assertEqual((code, out), (2, ''), args)
            self.assertIn('--random-map', err)
        self.assertEqual(plan('--resume', env_extra={'PLAY_LOCAL_STATE': st})['map'], 'fixed')
        # (the word is the launcher's own, read from its source; the help names the flag)
        self.assertIn("FRESH_MAP_MODE = 'local-fresh-map-v1'", read(os.path.join(ROOT, 'permutation-gateway/src/frontier/local-play-launcher.mjs')))
        self.assertIn('--random-map', run('--help')[1])

    def test_wide_is_opt_in_memory_only_and_alone(self):
        # (without the flag: no wide land on the launcher line)
        self.assertNotIn('--wide-land', plan()['launcher'])
        for extra in [(), ('--ai', '0'), ('--random-map',), ('--minutes', '240')]:
            p = plan('--wide', *extra)
            self.assertEqual((p['world'], p['speed'], p['mode']), ('wide', 'natural', 'fresh'), extra)
            line = p['launcher']
            self.assertEqual(line.count('--wide-land local-wide-land-v1'), 1, extra)
            # (a memory-only world of its own: not kept, not the demo, not the land preview)
            for bad in ['--continuous', '--persist', '--capture-demo', '--demo-scale', '--world-option']:
                self.assertNotIn(bad, line, extra)
            self.assertTrue(p['data'].startswith(TMP + '/worlds/'), extra)
        # (never with the demo, a resume, a kept world's --fresh or the demo's --speed, in either order, before any write)
        st, _ = kept_state()
        for args in [('--wide', '--demo'), ('--demo', '--wide'), ('--wide', '--fresh'), ('--wide', '--speed', '30'), ('--wide', '--two'), ('--two', '--wide')]:
            code, out, err = run('--print-plan', *args)
            self.assertEqual((code, out), (2, ''), args)
            self.assertIn('--wide', err)
        code, out, err = run('--print-plan', '--wide', '--resume', env_extra={'PLAY_LOCAL_STATE': st})
        self.assertEqual((code, out), (2, ''))
        # (the word is the launcher's own, read from its source; the help names the flag; the herald serves the wide view)
        self.assertIn("WIDE_LAND_MODE = 'local-wide-land-v1'", read(os.path.join(ROOT, 'permutation-gateway/src/frontier/local-play-launcher.mjs')))
        self.assertIn('--wide ', run('--help')[1])
        self.assertIn('-p herald --features land-preview,wide-world-experimental', read(SCRIPT))

    def test_resume_reopens_the_last_kept_world(self):
        st, world = kept_state(port=41930, ai=1)
        p = plan('--resume', env_extra={'PLAY_LOCAL_STATE': st})
        self.assertEqual((p['world'], p['mode'], p['data']), ('kept', 'resume', world))
        self.assertEqual((p['port'], p['ai'], p['world_port']), ('41930', '1', '41934'))  # the kept world's, not the defaults
        self.assertIn('--persist local-persist-v1', p['launcher'])
        self.assertIn('--continuous local-continuous-v1', p['launcher'])
        self.assertIn('--operator-residents 1', p['launcher'])
        self.assertIn(f'--data {world}', p['launcher'])
        # (the same values given explicitly are fine)
        self.assertEqual(plan('--resume', '--port', '41930', '--ai', '1', env_extra={'PLAY_LOCAL_STATE': st})['port'], '41930')

    def test_resume_refuses_another_port_or_ai(self):
        st, _ = kept_state(port=41960, ai=2)
        code, _, err = run('--print-plan', '--resume', '--port', '41920', env_extra={'PLAY_LOCAL_STATE': st})
        self.assertEqual(code, 5, err)
        self.assertIn('41960', err)
        code, _, err = run('--print-plan', '--resume', '--ai', '0', env_extra={'PLAY_LOCAL_STATE': st})
        self.assertEqual(code, 5, err)

    def test_two_people_in_one_world(self):
        # (B16, fix-b14-b16: the launcher's contest pair, on a kept world or the demo)
        self.assertEqual(plan()['players'], 'one')
        self.assertNotIn('--contest-pair', plan()['launcher'])
        for extra in ((), ('--demo',)):
            p = plan('--two', *extra)
            self.assertEqual(p['players'], 'two')
            self.assertIn('--contest-pair contest-pair-v1', p['launcher'])
            self.assertEqual(p['ports'], '41920-41941', 'the pair takes the second world slot: no more ports')
        # a kept pair resumes as a pair, with or without --two; a world of one never becomes a pair
        st, _ = kept_state(two=1)
        self.assertIn('--contest-pair contest-pair-v1', plan('--resume', env_extra={'PLAY_LOCAL_STATE': st})['launcher'])
        self.assertEqual(plan('--resume', '--two', env_extra={'PLAY_LOCAL_STATE': st})['players'], 'two')
        for two in (None, 0):
            st, _ = kept_state(two=two)
            self.assertEqual(plan('--resume', env_extra={'PLAY_LOCAL_STATE': st})['players'], 'one')
            code, _, err = run('--print-plan', '--resume', '--two', env_extra={'PLAY_LOCAL_STATE': st})
            self.assertEqual(code, 5, err)
            self.assertIn('--two', err)

    def test_resume_with_a_dangling_pointer_is_refused(self):
        st, world = kept_state()
        os.remove(os.path.join(world, 'play-local.conf'))
        self.assertEqual(run('--print-plan', '--resume', env_extra={'PLAY_LOCAL_STATE': st})[0], 5)

    def test_print_plan_writes_no_kept_world(self):
        st = tempfile.mkdtemp(prefix='play-local-plan-')
        plan(env_extra={'PLAY_LOCAL_STATE': st})
        self.assertEqual(os.listdir(st), [])

    def test_refusals_happen_before_any_write(self):
        before = set(os.listdir(TMP))
        run('--cluster', 'devnet')
        run('--ai', '7')
        self.assertEqual(set(os.listdir(TMP)), before)


class Check(unittest.TestCase):
    def test_missing_tools_are_listed_not_installed(self):
        home = tempfile.mkdtemp(prefix='play-local-home-')  # no ~/.local/share/solana, no platform-tools
        code, out, err = run('--check-only', '--port', '41972', env_extra={'PATH': '/usr/bin:/bin:/usr/sbin:/sbin', 'HOME': home})
        self.assertEqual(code, 3, (out, err))
        self.assertIn('installs nothing', out)
        for w in ['Node.js >= 20', 'rustup', 'cargo-build-sbf 3.1.9', 'platform-tools v1.52']:
            self.assertIn(w, out)
        self.assertNotIn('== 2/4', out)  # never reaches the build
        # nothing installed into HOME (macOS system tools may create ~/Library caches; that is not this script)
        self.assertEqual([d for d in os.listdir(home) if d != 'Library'], [])

    def test_no_listener_at_all_does_not_end_the_check(self):
        # lsof exits 1 when nothing is listening (a fresh CI runner); under pipefail that once ended the check, exit 1
        home = tempfile.mkdtemp(prefix='play-local-home-')
        fake = tempfile.mkdtemp(prefix='play-local-bin-')
        with open(os.path.join(fake, 'lsof'), 'w') as f:
            f.write('#!/bin/sh\nexit 1\n')
        os.chmod(os.path.join(fake, 'lsof'), 0o755)
        code, out, err = run('--check-only', '--port', '41972', env_extra={'PATH': fake + ':/usr/bin:/bin:/usr/sbin:/sbin', 'HOME': home})
        self.assertEqual(code, 3, (out, err))
        self.assertIn('installs nothing', out)


class Static(unittest.TestCase):
    def test_script_never_installs_or_deploys(self):
        src = read(SCRIPT)
        code = '\n'.join(l for l in src.splitlines() if not l.lstrip().startswith('#'))
        # install hints are printed (inside quotes after "→"), never executed
        for bad in [r'^\s*(sudo|brew|apt|apt-get|rustup toolchain install|npm install)\b',
                    r'solana program deploy', r'solana-keygen', r'solana airdrop', r'--url\s+(devnet|mainnet)']:
            self.assertIsNone(re.search(bad, code, re.M), bad)
        self.assertIn('placeholder', src)  # the SBF out dir gets a key placeholder before cargo-build-sbf

    def test_bash_syntax(self):
        self.assertEqual(subprocess.run(['bash', '-n', SCRIPT]).returncode, 0)


if __name__ == '__main__':
    unittest.main(verbosity=2)
