#!/usr/bin/env python3
"""scripts/ci/flag-off.py (test-gaps-13): the guard itself.

  python3 scripts/tests/test_flag_off.py      (needs PyYAML and Python 3.11+ tomllib, as `flag-off.py check` does)

Every way a later change could turn ⑪(b) `declarative-effects` (#317) or the ⑥ chain link (#329) on, or take the guard
out of ci.yml, is made on a small copy of the tree in a temp dir, and the real script must name it. No build, no key,
no network; nothing in the checkout is written.
"""
import os, shutil, subprocess, sys, tempfile, unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
CI = '.github/workflows/ci.yml'
RULES, MOD = 'permutation-rules/Cargo.toml', 'permutation-rules/src/frontier/mod.rs'
EFFECTS = 'permutation-rules/src/frontier/effects.rs'
CHAIN = 'workstreams/06-creation/src/chainlink/'
POISON = '        run: python3 scripts/ci/flag-off.py poison rust\n'


def tracked():
    out = subprocess.run(['git', 'ls-files', '-z'], cwd=ROOT, capture_output=True, check=True).stdout
    return [f for f in out.decode().split('\0') if f]


def wanted(f):
    return (f.endswith('Cargo.toml') or f.startswith('.github/workflows/') or f.startswith(CHAIN)
            or f.startswith('scripts/build-') or f.startswith('workstreams/06-creation/proto/')
            or f in (MOD, EFFECTS, 'scripts/ci/flag-off.py', 'workstreams/06-creation/src/registry.mjs',
                     'permutation-server/web/frontier/app.mjs', 'permutation-gateway/demo/package.json'))


def git(d, *a):
    subprocess.run(['git', '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', *a], cwd=d, check=True, capture_output=True)


class Tree(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.base = tempfile.mkdtemp(prefix='flag-off-test-')
        cls.proto = os.path.join(cls.base, 'proto')
        for f in filter(wanted, tracked() + ['scripts/ci/flag-off.py']):
            os.makedirs(os.path.dirname(os.path.join(cls.proto, f)), exist_ok=True)
            shutil.copyfile(os.path.join(ROOT, f), os.path.join(cls.proto, f))
        git(cls.proto, 'init', '-q'); git(cls.proto, 'add', '-A'); git(cls.proto, 'commit', '-qm', 'x')

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.base, ignore_errors=True)

    def setUp(self):
        self.d = os.path.join(self.base, self.id().split('.')[-1])
        shutil.copytree(self.proto, self.d)

    def read(self, f):
        with open(os.path.join(self.d, f), encoding='utf-8') as h:
            return h.read()

    def write(self, f, s):
        os.makedirs(os.path.dirname(os.path.join(self.d, f)), exist_ok=True)
        with open(os.path.join(self.d, f), 'w', encoding='utf-8') as h:
            h.write(s)
        git(self.d, 'add', '-A')

    def sub(self, f, old, new, count=1):
        s = self.read(f)
        self.assertGreaterEqual(s.count(old), 1, f'{f} has {old!r}')
        self.write(f, s.replace(old, new, count))

    def run_script(self, *a, env=None, cwd=None):
        e = {k: v for k, v in os.environ.items() if k != 'CI'}
        e.update(env or {})
        p = subprocess.run([sys.executable, os.path.join(self.d, 'scripts/ci/flag-off.py'), *a], cwd=cwd or self.d, capture_output=True, text=True, env=e, timeout=120)
        return p.returncode, p.stdout + p.stderr

    def named(self, want):
        """The check fails with `want` in a finding; then the copy is put back for the next case."""
        code, out = self.run_script('check')
        self.assertEqual(code, 1, out)
        self.assertIn(want, out)
        git(self.d, 'reset', '-q', '--hard')

    def job(self, name):
        """(start, end) of a job's text in ci.yml."""
        s = self.read(CI)
        i = s.index(f'\n  {name}:\n')
        import re
        m = re.compile(r'\n  [a-z0-9-]+:\n').search(s, i + 5)
        return i, (m.start() if m else len(s))

    def sub_job(self, name, old, new):
        s, (i, j) = self.read(CI), self.job(name)
        self.assertIn(old, s[i:j], f'job {name}')
        self.write(CI, s[:i] + s[i:j].replace(old, new, 1) + s[j:])


class Static(Tree):
    def test_the_copy_and_the_real_tree_pass(self):
        code, out = self.run_script('check')
        self.assertEqual(code, 0, out)
        p = subprocess.run([sys.executable, os.path.join(ROOT, 'scripts/ci/flag-off.py'), 'check'], capture_output=True, text=True)
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)

    def test_a_manifest_cannot_turn_the_rust_feature_on(self):
        self.sub(RULES, 'default = []', 'default = ["declarative-effects"]'); self.named('feature `default` turns declarative-effects on')
        self.sub(RULES, 'land-preview = []', 'land-preview = ["declarative-effects"]'); self.named('feature `land-preview` turns')
        self.sub(RULES, 'declarative-effects = []', 'declarative-effects = ["std"]'); self.named('may only be the empty definition')
        self.sub('permutation-frontier/Cargo.toml', '"permutation-rules/land-preview"', '"permutation-rules/land-preview", "permutation-rules/declarative-effects"')
        self.named('permutation-frontier/Cargo.toml: feature `land-preview` turns')
        dep = 'permutation-rules = { path = "../permutation-rules" }'
        self.sub('permutation-frontier/Cargo.toml', dep, dep.replace(' }', ', features = ["declarative-effects"] }')); self.named('[dependencies] permutation-rules turns')
        for table in ('build-dependencies', 'dev-dependencies', "target.'cfg(target_os = \"solana\")'.dependencies", 'workspace.dependencies'):
            self.write('x/Cargo.toml', f'[package]\nname = "x"\n[{table}]\npermutation-rules = {{ path = "../permutation-rules", features = ["declarative-effects"] }}\n')
            self.named('x/Cargo.toml: [')
        self.sub('workstreams/11-extensions/ext-kernel/Cargo.toml', '[dependencies]', '[dependencies]\nrules2 = { package = "permutation-rules", path = "../../../permutation-rules", features = ["declarative-effects"] }')
        self.named('[dependencies] rules2 turns')

    def test_the_cfg_stays_on_the_module(self):
        self.sub(MOD, '#[cfg(feature = "declarative-effects")]\n', ''); self.named('must stand once, directly under its cfg')
        self.sub(MOD, '#[cfg(feature = "declarative-effects")]', '#[cfg(any(feature = "declarative-effects", feature = "land-preview"))]'); self.named('must stand once')
        self.sub(MOD, '#[cfg(feature = "declarative-effects")]', '#[cfg(not(feature = "declarative-effects"))]'); self.named('must stand once')
        self.write(MOD, self.read(MOD) + '\n#[cfg(feature = "declarative-effects")]\npub const X: u8 = 1;\n'); self.named('must stand once')

    def test_no_script_source_or_workflow_names_it(self):
        self.sub('scripts/build-frontier.sh', '"") ;;\n    rights', '"") args+=(--features permutation-rules/declarative-effects) ;;\n    rights'); self.named('scripts/build-frontier.sh: names the flag-off feature')
        self.write('scripts/x.sh', 'cargo build --all-features\n'); self.named('--all-features')
        self.write('.cargo/config.toml', '[alias]\nb = "build --features declarative-effects"\n'); self.named('.cargo/config.toml: names')
        self.write('permutation-frontier/src/x.rs', '#[cfg(feature = "declarative-effects")] fn f() {}\n'); self.named('permutation-frontier/src/x.rs: names')
        self.sub_job('frontier-wasm', 'cargo fmt -- --check', 'cargo fmt -- --check\n          cargo build --features permutation-rules/declarative-effects'); self.named('job frontier-wasm names declarative-effects')
        self.sub_job('frontier-node', 'cargo fmt', 'cargo check --all-features\n          cargo fmt'); self.named('job frontier-node: --all-features')
        self.write('.github/workflows/new.yml', 'on: push\njobs:\n  a:\n    runs-on: x\n    steps:\n      - run: cargo build --features declarative-effects\n'); self.named('new.yml: job a names')

    def test_the_chain_link_stays_in_its_prototype_and_off(self):
        self.sub('permutation-server/web/frontier/app.mjs', '\n', "\nimport '../../../workstreams/06-creation/src/chainlink/flag.mjs';\n"); self.named('app.mjs: names the ⑥ chain link outside')
        self.write('permutation-gateway/demo/src/x.mjs', 'export const M = "PSF6CENT";\n'); self.named('demo/src/x.mjs: names the ⑥ chain link outside')
        self.write('scripts/x.sh', 'export WYLLS_CREATION_CHAINLINK=1\n'); self.named('scripts/x.sh: names the ⑥ chain link outside')
        self.sub('workstreams/06-creation/src/registry.mjs', '\nimport ', '\nimport { LinkedRegistry } from "./chainlink/linked.mjs";\nimport '); self.named('registry.mjs: imports src/chainlink')
        self.sub(CHAIN + 'flag.mjs', 'env[FLAG_ENV] === "1"', 'env[FLAG_ENV]'); self.named('three exact')
        self.sub(CHAIN + 'flag.mjs', '  return false;\n}', '  return true;\n}'); self.named('three exact')
        self.sub_job('creation06', 'runs-on: ubuntu-24.04', 'runs-on: ubuntu-24.04\n    env:\n      WYLLS_CREATION_CHAINLINK: "1"'); self.named('job creation06 turns the ⑥ chain link on')

    def test_ci_keeps_the_poison_first_in_every_shipping_job(self):
        for name in ('program', 'frontier-program', 'frontier-node', 'frontier-wasm', 'frontier-wasm-reference', 'prize-program', 'exec-native'):
            self.sub_job(name, POISON, '        run: "true"\n'); self.named(f'job {name} does not poison')
        self.sub_job('frontier-wasm', POISON, POISON + '        continue-on-error: true\n'); self.named('may not be conditional or allowed to fail')
        self.sub_job('frontier-wasm', POISON, POISON + "        if: github.event_name == 'push'\n"); self.named('may not be conditional')
        self.sub_job('frontier-wasm', 'poison rust\n', 'poison rust || true\n'); self.named('must start with')
        self.sub_job('frontier-wasm', 'poison rust\n', 'poison js\n'); self.named('must start with')
        self.sub_job('frontier-wasm', '      - uses: actions/checkout@v7\n', '      - uses: actions/checkout@v7\n      - name: early\n        run: scripts/build-wasm.sh --check\n'); self.named('"early" builds before the poison')
        self.sub_job('frontier-node', 'cargo fmt', 'git checkout -- .\n          cargo fmt'); self.named('a later step restores the checkout')
        self.sub_job('walletless-demo', 'flag-off.py same-tree dist dist-flag-off', 'flag-off.py same-tree dist dist'); self.named('does not compare the poisoned bundle')
        self.sub_job('walletless-demo', 'poison rust js', 'poison rust'); self.named('job walletless-demo: the poison step must start with')
        self.sub_job('frontier-program', ' devnet-playable-sbf ', ' '); self.named('shipped feature set `devnet-playable-sbf` is not checked')
        self.sub('scripts/build-frontier.sh', '""|trace|', '""|world4-sbf|trace|'); self.named('shipped feature set `world4-sbf` is not checked')
        self.write('scripts/build-frontier-world4-sbf.sh', 'cargo-build-sbf --features world4-lane-sbf -- --locked\n'); self.named('shipped feature set `world4-lane-sbf` is not checked')
        self.sub_job('frontier-previews', 'flag-off.py poison-bites ', 'flag-off.py '); self.named('no longer proves that the poison stops')


class Poison(Tree):
    def test_poison_replaces_every_source_only_in_ci_and_only_clean_files(self):
        code, out = self.run_script('poison')
        self.assertNotEqual(code, 0); self.assertIn('CI only', out)
        self.assertNotIn('POISON', self.read(EFFECTS))
        self.write(EFFECTS, self.read(EFFECTS) + '// my work\n')
        code, out = self.run_script('poison', 'rust', '--force')
        self.assertNotEqual(code, 0); self.assertIn('has changes; not touched', out); self.assertIn('// my work', self.read(EFFECTS))
        git(self.d, 'reset', '-q', '--hard')
        code, out = self.run_script('poison', 'rust', env={'CI': 'true'})
        self.assertEqual(code, 0, out)
        self.assertTrue(self.read(EFFECTS).startswith('compile_error!("WYLLS-FLAG-OFF-POISON'))
        self.assertNotIn('POISON', self.read(CHAIN + 'flag.mjs'))
        code, out = self.run_script('poison', 'rust', 'js', env={'CI': 'true'})
        self.assertEqual(code, 0, out)
        names = sorted(os.listdir(os.path.join(self.d, CHAIN)))
        self.assertEqual(names, ['catalog.mjs', 'flag.mjs', 'linked.mjs', 'localchain.mjs', 'record.mjs'])
        for n in names:
            self.assertIn('throw new Error("WYLLS-FLAG-OFF-POISON', self.read(CHAIN + n))

    def test_a_moved_source_fails_instead_of_poisoning_nothing(self):
        os.rename(os.path.join(self.d, EFFECTS), os.path.join(self.d, EFFECTS + '2'))
        code, out = self.run_script('poison', 'rust', env={'CI': 'true'})
        self.assertNotEqual(code, 0); self.assertIn('no such file', out)

    def test_poison_bites_needs_the_poison_message_and_a_failure(self):
        sh = lambda s: ('poison-bites', 'sh', '-c', s)
        code, out = self.run_script(*sh('echo WYLLS-FLAG-OFF-POISON; exit 1'))
        self.assertNotEqual(code, 0); self.assertIn('the tree is not poisoned', out)
        self.run_script('poison', 'rust', env={'CI': 'true'})
        self.assertEqual(self.run_script(*sh('echo WYLLS-FLAG-OFF-POISON >&2; exit 101'))[0], 0)
        for s in ('echo WYLLS-FLAG-OFF-POISON; exit 0', 'echo another error; exit 101'):
            code, out = self.run_script(*sh(s))
            self.assertNotEqual(code, 0); self.assertIn('the guard proves nothing', out)

    def test_same_tree(self):
        a, b = os.path.join(self.d, 'a'), os.path.join(self.d, 'b')
        for d in (a, b):
            os.makedirs(os.path.join(d, 's'))
            for i in range(120):
                with open(os.path.join(d, 's', f'{i}.js'), 'w') as f:
                    f.write(str(i))
        code, out = self.run_script('same-tree', a, b)
        self.assertEqual(code, 0, out); self.assertIn('120 files, byte-identical', out)
        with open(os.path.join(b, 's', '7.js'), 'w') as f: f.write('8')
        code, out = self.run_script('same-tree', a, b); self.assertNotEqual(code, 0); self.assertIn('differs: s/7.js', out)
        with open(os.path.join(b, 's', '7.js'), 'w') as f: f.write('7')
        with open(os.path.join(b, 'extra'), 'w') as f: f.write('')
        code, out = self.run_script('same-tree', a, b); self.assertNotEqual(code, 0); self.assertIn('differs: extra', out)
        os.remove(os.path.join(b, 'extra'))
        for d in (a, b):
            with open(os.path.join(d, 'copied.mjs'), 'w') as f: f.write('// WYLLS-FLAG-OFF-POISON')
        code, out = self.run_script('same-tree', a, b); self.assertNotEqual(code, 0); self.assertIn('carries the flag-off poison', out)
        os.makedirs(os.path.join(self.d, 'e1')); os.makedirs(os.path.join(self.d, 'e2'))
        code, out = self.run_script('same-tree', os.path.join(self.d, 'e1'), os.path.join(self.d, 'e2')); self.assertNotEqual(code, 0); self.assertIn('not a bundle', out)


if __name__ == '__main__':
    unittest.main(verbosity=2)
