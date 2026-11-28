#!/usr/bin/env python3
"""scripts/ci/check-ci-keyfree.py read as the shell reads it (#323 fix-tg10 + verify-pr323); test-gaps-13, tests only.

  python3 scripts/tests/test_ci_keyfree_shell_forms.py      (needs PyYAML, as the checker does)

test_ci_keyfree_demo_smoke.py holds the forms #323 fixed. Here: the verifier's other forms (verify-pr323 forms.py, run by
hand until now), the shell reader's own functions, every workflow file in the repo, and — as `expectedFailure` — forms
that DO run a key-using check and still pass the checker (Q-TG13-5, reports/test-gaps-13.md; not fixed here). When the
checker learns one, unittest reports "unexpected success": move it to the refused list. No key, network or browser.
"""
import glob, importlib.util, os, subprocess, sys, tempfile, unittest
import yaml

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
CHECKER = os.path.join(ROOT, 'scripts', 'ci', 'check-ci-keyfree.py')
TMP = tempfile.mkdtemp(prefix='ci-keyfree-forms-')
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('check_ci_keyfree', CHECKER)
ck = importlib.util.module_from_spec(spec); spec.loader.exec_module(ck)
APPROVED_IF = "github.event_name == 'workflow_dispatch' && inputs.key_tests == 'approved'"


def findings(step, job=None, name='walletless-demo'):
    """The real checker's findings for a workflow with one job of one step."""
    step = {'name': 'x', 'run': step} if isinstance(step, str) else step
    wf = {'on': ['push', 'pull_request'], 'jobs': {name: {'runs-on': 'ubuntu-24.04', **(job or {}), 'steps': [step]}}}
    path = os.path.join(TMP, f'w{len(os.listdir(TMP))}.yml')
    with open(path, 'w', encoding='utf-8') as f:
        yaml.safe_dump(wf, f)
    return ck.check(path)


class Forms(unittest.TestCase):
    def refused(self, runs, why=''):
        for run in runs:
            with self.subTest(run=run):
                got = findings(run)
                self.assertTrue(got, 'passed the checker')
                self.assertIn(why, '\n'.join(got))

    def allowed(self, runs):
        for run in runs:
            with self.subTest(run=run):
                self.assertEqual(findings(run), [])

    def test_a_signing_smoke_however_the_shell_is_made_to_run_it(self):
        self.refused([
            "bash -c 'node smoke.mjs --act' x --pre-join",          # verify-pr323 V3
            'C="node smoke.mjs"; $C --lang en',                     # V8
            'node smoke.mjs --pre-join\t--claim',                   # V13
            'node smoke.mjs\t--act',
            '(node smoke.mjs --act)', '( cd demo && node smoke.mjs )',   # V4
            'sh <<E\nnode smoke.mjs --act\nE',                      # V9
            'echo "node smoke.mjs --act" | sh', 'true | node smoke.mjs',  # V10
            'printf "node smoke.mjs" > r.sh; sh r.sh',
            'LANG=en node smoke.mjs --act', 'env X=1 node smoke.mjs',     # V11
            'npx node smoke.mjs', 'npm exec -c "node smoke.mjs"', 'deno run smoke.mjs', 'node --import ./smoke.mjs x.mjs',  # V12
            'if true; then node smoke.mjs --act; fi', 'true && node smoke.mjs --act', 'false || node smoke.mjs', 'node smoke.mjs --act &',
            'node $PWD/smoke.mjs --act', 'node ./permutation-gateway/demo/smoke.mjs',
            "node smoke.mjs --pre-join '--act'", 'node smoke.mjs --pre-join --a"c"t', 'node smoke.mjs --pre-join --ac\\\nt', 'node smoke.mjs --pre-join --\\act',
            'node smoke.mjs --pre-join=false', 'node smoke.mjs "--pre-join --lang en"', 'node smoke.mjs --lang --pre-joined',
            'node smoke.mjs --pre-join --act=true', 'node smoke.mjs --pre-join\nnode smoke-save.mjs', 'node smoke-goal.mjs --path win', 'node smoke-travelers.mjs --lang en',
            'node smoke.mjs --pre-join <(echo --act)', 'node smoke.mjs --pre-join <(cat flags)', 'node smoke.mjs --pre-join $(cat flags)', 'xargs node smoke.mjs --pre-join < flags',
        ], 'demo smoke without --pre-join')

    def test_every_smoke_script_the_demo_has_is_one_the_rule_sees(self):
        scripts = sorted(os.path.basename(p) for p in glob.glob(os.path.join(ROOT, 'permutation-gateway/demo/smoke*.mjs')))
        self.assertIn('smoke.mjs', scripts); self.assertGreaterEqual(len(scripts), 3)
        self.refused([f'node {s} --lang en' for s in scripts], 'demo smoke without --pre-join')
        with open(os.path.join(ROOT, 'permutation-gateway/demo/package.json'), encoding='utf-8') as f:
            named = [k for k, v in yaml.safe_load(f)['scripts'].items() if 'smoke' in v]
        self.assertTrue(named)
        self.refused([f'npm run {k}' for k in named], 'demo smoke without --pre-join')

    def test_what_stays_allowed(self):
        self.allowed([
            'node smoke.mjs --pre-join', 'node "smoke.mjs" "--pre-join"  # the PR run', "node smoke.mjs '--pre-join' --lang ja",
            'cd demo && node smoke.mjs --lang en --pre-join; echo done', 'for l in en ja; do\n  node smoke.mjs --lang "$l" \\\n    --pre-join\ndone',
            'npm run smoke -- --pre-join', '# node smoke.mjs --act\ntrue', 'true  # node smoke.mjs --act', 'echo no smoke here', 'node check.mjs --act',
            'cargo test --locked -p verify', 'npm ci --ignore-scripts', 'cargo fmt -- --check',
        ])

    def test_the_shell_reader(self):
        sc = ck.shell_commands
        self.assertEqual(sc('a b; c && d || e | f & g\nh'), ['a b', 'c', 'd', 'e', 'f', 'g', 'h'])
        self.assertEqual(sc('a \\\n  b\nc'), ['a   b', 'c'])
        self.assertEqual(sc('a "x; y" \'p | q\' z'), ['a "x; y" \'p | q\' z'])
        self.assertEqual(sc('a # b; c\nd#e "#f" \\# g'), ['a', 'd#e "#f" \\# g'])
        self.assertEqual(sc('a;#c\n(#d\nb'), ['a', '(', 'b'])
        self.assertEqual(sc("a '\\' b; c"), ["a '\\' b", 'c'])       # no escape inside single quotes
        self.assertEqual(sc('a "\\"; b" c; d'), ['a "\\"; b" c', 'd'])  # an escaped quote does not end the string
        self.assertEqual(sc('a "x\\\ny"'), ['a "xy"'])
        self.assertEqual(sc(''), []); self.assertEqual(sc('\n;;\n# only\n'), [])
        self.assertEqual(ck.words('(node "a b" \'c\'d)'), ['node', 'a b', 'cd'])
        self.assertIsNone(ck.words('node "open'))

    def test_the_other_key_checks_stay_out_of_push_and_pr_jobs(self):
        for run, why in [('permutation-frontier/svm-tests/run.sh', 'LiteSVM'), ('scripts/build-frontier.sh --twice', 'SBF build'), ('scripts/build-prize.sh', 'SBF build'),
                         ('scripts/build-program.sh', 'SBF build'), ('cargo build-sbf', 'SBF build'), ('cargo-build-sbf', 'SBF build'),
                         ('sh -c "$(curl -sSfL https://release.anza.xyz/v3.1.9/install)"', 'Agave install'), ('npm test', 'full Node suite'), ('npm ci && npm test', 'full Node suite'),
                         ('npm run test', 'full Node suite'), ('cargo test --locked --workspace', 'frontier-node workspace tests'), ('solana-keygen new', 'key or validator CLI'),
                         ('solana program deploy x.so', 'key or validator CLI'), ('solana-test-validator &', 'key or validator CLI')]:
            self.refused([run], why)
            self.assertEqual(findings(run, job={'if': APPROVED_IF}, name='key-tests'), [], run)
        # a lint-only step may name the LiteSVM crate; one more command on it and it may not
        lint = {'name': 'l', 'working-directory': 'permutation-frontier/svm-tests', 'run': 'cargo fmt -- --check\ncargo clippy --locked --all-targets -- -D warnings\n'}
        self.assertEqual(findings(lint), [])
        for extra in ('cargo test', 'cargo fmt -- --check && cargo test', 'cargo clippy --locked --all-targets -- -D warnings; ./run.sh', 'cargo clippy --locked --all-targets -- -D warnings | tee x'):
            self.assertTrue(findings({**lint, 'run': lint['run'] + extra + '\n'}), extra)

    def test_the_approval_cannot_be_borrowed(self):
        for cond in (None, 'always()', APPROVED_IF + ' || true', "github.event_name == 'workflow_dispatch'"):
            self.assertTrue(findings('true', job={'if': cond} if cond else {}, name='key-tests'), cond)
        # the same `if:` on another job name does not make it key-tests
        self.assertTrue(findings('npm test', job={'if': APPROVED_IF}, name='other'))
        self.assertTrue(findings('node smoke.mjs --act', job={'if': APPROVED_IF}, name='other'))

    def test_every_workflow_file_passes_and_ci_hands_the_push_and_pr_ones_to_the_checker(self):
        files = sorted(glob.glob(os.path.join(ROOT, '.github/workflows/*.y*ml')))
        self.assertGreaterEqual(len(files), 3)
        p = subprocess.run([sys.executable, CHECKER, *files], capture_output=True, text=True, timeout=60)
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        with open(os.path.join(ROOT, '.github/workflows/ci.yml'), encoding='utf-8') as f:
            steps = yaml.safe_load(f)['jobs']['browser-smoke']['steps']
        line = next(l for s in steps for l in str(s.get('run', '')).splitlines() if 'check-ci-keyfree.py' in l)
        for path in files:
            with open(path, encoding='utf-8') as f:
                on = yaml.safe_load(f).get(True) or {}                  # YAML 1.1 reads the key `on` as true
            triggers = set(on if isinstance(on, (list, dict)) else [on])
            if triggers - {'workflow_dispatch'}:
                self.assertIn('.github/workflows/' + os.path.basename(path), line, 'a workflow that starts by itself is not checked in CI')


class StillPasses(unittest.TestCase):
    """Q-TG13-5: each of these runs a key-using check in a push/PR job and passes the checker today."""

    def all_refused(self, runs, **kw):
        passed = [r for r in runs if not findings(r, **kw)]
        self.assertEqual(passed, [])

    @unittest.expectedFailure
    def test_gap_the_smoke_name_written_with_quotes_or_a_backslash(self):
        self.all_refused(['node sm"o"ke.mjs --act', "node smoke.m'j's --act", 'node sm\\oke.mjs --act'])

    @unittest.expectedFailure
    def test_gap_the_smoke_name_through_a_glob_or_braces(self):
        self.all_refused(['node smok*.mjs --act', 'node smoke.mj? --act', 'node {smoke,x}.mjs --act'])

    @unittest.expectedFailure
    def test_gap_the_smoke_imported_from_an_inline_script(self):
        self.all_refused(['node -e "import(\'./smoke.mjs\')"', 'node --input-type=module -e "import \'./smoke.mjs\'"'])

    @unittest.expectedFailure
    def test_gap_the_node_suite_in_another_spelling(self):
        self.all_refused(['npm  test', 'npm t', 'npm "test"', 'npm --prefix permutation-gateway test', 'npm run-script test', 'node --run test', 'pnpm test', 'yarn test'])

    @unittest.expectedFailure
    def test_gap_the_workspace_tests_in_another_spelling(self):
        self.all_refused(['cargo test --locked \\\n  --workspace', 'cargo test --all', 'cargo  test --workspace', 'cargo +1.95.0 test --workspace', 'cargo t --workspace'])

    @unittest.expectedFailure
    def test_gap_the_sbf_build_and_solana_in_another_spelling(self):
        self.all_refused(['cargo-build-"sbf"', 'cargo  build-sbf', 'bash scripts/build-front*.sh', 'solana  program deploy x.so', 'solana airdrop 1', 'solana transfer x 1'])

    @unittest.expectedFailure
    def test_gap_steps_whose_command_is_not_in_run(self):
        self.all_refused([{'uses': 'actions/github-script@v7', 'with': {'script': 'await exec.exec("node smoke.mjs --act")'}},
                          {'uses': 'docker://node:20', 'with': {'args': 'node smoke.mjs --act'}},
                          {'shell': 'python', 'run': 'import subprocess; subprocess.run(["node", "smoke.mjs", "--act"])'}])

    @unittest.expectedFailure
    def test_gap_a_step_name_that_starts_with_a_hash_waives_every_rule_but_the_smoke(self):
        self.all_refused([{'name': '# tests', 'run': 'npm test'}, {'name': '#', 'run': 'solana-keygen new'}])

    @unittest.expectedFailure
    def test_gap_the_jobs_default_directory_and_matrix_are_not_read(self):
        self.assertTrue(findings('cargo test', job={'defaults': {'run': {'working-directory': 'permutation-frontier/svm-tests'}}}))
        self.assertTrue(findings('node smoke.mjs --pre-join $X', job={'strategy': {'matrix': {'f': ['--act']}}, 'env': {'X': '${{ matrix.f }}'}}))

    @unittest.expectedFailure
    def test_gap_a_job_that_calls_another_workflow_or_a_local_action(self):
        wf = {'on': ['push'], 'jobs': {'a': {'uses': './.github/workflows/unchecked.yml'}}}
        path = os.path.join(TMP, 'reuse.yml')
        with open(path, 'w', encoding='utf-8') as f:
            yaml.safe_dump(wf, f)
        self.assertTrue(ck.check(path))
        self.assertTrue(findings({'uses': './.github/actions/smoke'}))


if __name__ == '__main__':
    unittest.main(verbosity=2, warnings="ignore")
