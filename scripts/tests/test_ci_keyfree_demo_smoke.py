#!/usr/bin/env python3
"""scripts/ci/check-ci-keyfree.py: the walletless demo smoke rule (#309, Q-FDW-1 = B; test-gaps-10).

  python3 scripts/tests/test_ci_keyfree_demo_smoke.py      (needs PyYAML, as the checker does; not -I: CI installs it
                                                          with pip --user, which -I would hide)

finish-pr309 N6 proved this rule by hand: `--act` and `npm run smoke` lines were added to the ci.yml step and the checker
exited 1. Here every case is a small workflow file in a temp dir, and the real checker runs on it (no key, no network,
no browser). The three `expectedFailure` cases are lines that DO run a signing smoke but pass the checker today
(D-test-gaps-10-1, inbox 2026-11-28-1524-test-gaps-10-questions.md, Q-TG10-1). They are not fixed here (tests only).
"""
import os, subprocess, sys, tempfile, unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
CHECKER = os.path.join(ROOT, 'scripts', 'ci', 'check-ci-keyfree.py')
TMP = tempfile.mkdtemp(prefix='ci-keyfree-test-')
APPROVED_IF = "github.event_name == 'workflow_dispatch' && inputs.key_tests == 'approved'"


def workflow(run, job='walletless-demo', job_if=None, step_name='smoke'):
    lines = ['on: [push, pull_request]', 'jobs:', f'  {job}:', '    runs-on: ubuntu-24.04']
    if job_if:
        lines.append(f'    if: "{job_if}"')
    lines += ['    steps:', f'      - name: {step_name}', '        run: |']
    lines += ['          ' + l for l in run.split('\n')]
    path = os.path.join(TMP, f'w{len(os.listdir(TMP))}.yml')
    with open(path, 'w', encoding='utf-8') as f:
        f.write('\n'.join(lines) + '\n')
    return path


def check(*paths):
    p = subprocess.run([sys.executable, CHECKER, *paths], capture_output=True, text=True, timeout=60)
    return p.returncode, p.stdout + p.stderr


class DemoSmokeRule(unittest.TestCase):
    def assertRefused(self, run, **kw):
        code, out = check(workflow(run, **kw))
        self.assertEqual(code, 1, out)
        self.assertIn('demo smoke without --pre-join', out)

    def assertAllowed(self, run, **kw):
        code, out = check(workflow(run, **kw))
        self.assertEqual(code, 0, out)

    def test_the_real_workflows_pass(self):
        code, out = check(os.path.join(ROOT, '.github/workflows/ci.yml'), os.path.join(ROOT, '.github/workflows/pages-demo.yml'))
        self.assertEqual(code, 0, out)

    def test_pre_join_lines_are_allowed(self):
        self.assertAllowed('node smoke.mjs --dir dist-pages --origin "$ORIGIN" --prefix "$BASE" --path "$entry" --lang "$lang" $view --pre-join')
        # (a flag followed straight by `;` is not read as --pre-join: a false refusal, the safe side; ci.yml puts it last on its line)
        self.assertAllowed("for v in '' --mobile; do node smoke.mjs --pre-join $v; done")
        self.assertRefused("for v in '' --mobile; do node smoke.mjs $v --pre-join; done")
        self.assertAllowed('node ./smoke.mjs --pre-join --mobile')
        # a comment line naming the smoke runs nothing
        self.assertAllowed('# node smoke.mjs --act\nnode build.mjs')

    def test_signing_runs_are_refused_N6(self):
        for run in ['node smoke.mjs --lang en',                       # joins: a session key, signed orders
                    'node smoke.mjs --pre-join --act',                  # N6
                    'node smoke.mjs --loop --pre-join',
                    'node permutation-gateway/demo/smoke.mjs --act',
                    'npm run smoke',                                    # N6
                    'node smoke-save.mjs --lang en',                    # joins and signs; it has no --pre-join
                    'node smoke-save.mjs --pre-join --act',
                    'node build.mjs\nnode smoke.mjs --pre-join\nnode smoke.mjs --act']:
            with self.subTest(run=run):
                self.assertRefused(run)

    def test_every_offending_line_is_named(self):
        code, out = check(workflow('node smoke.mjs --act\nnode smoke.mjs --pre-join\nnpm run smoke'))
        self.assertEqual(code, 1)
        self.assertIn('2 key-using step(s)', out)

    def test_only_key_tests_may_sign(self):
        # the manual key-tests job (exactly the approved condition) may run the full smoke
        self.assertAllowed('node smoke.mjs --lang en --loop', job='key-tests', job_if=APPROVED_IF)
        # any other job, even with the same condition, may not
        self.assertRefused('node smoke.mjs --lang en --loop', job='demo-full', job_if=APPROVED_IF)
        # a key-tests job without the exact condition is refused on its own
        code, out = check(workflow('node smoke.mjs --pre-join', job='key-tests'))
        self.assertEqual(code, 1, out)
        self.assertIn('job key-tests must have exactly', out)

    # ---- D-test-gaps-10-1: lines that run a signing smoke and pass the checker today (found by this test, not fixed)

    @unittest.expectedFailure
    def test_gap_backslash_continuation_hides_act(self):
        # the shell runs `node smoke.mjs --pre-join --act`; the checker reads the two lines apart
        self.assertRefused('node smoke.mjs --pre-join \\\n  --act')

    @unittest.expectedFailure
    def test_gap_quoted_script_name(self):
        self.assertRefused('node "smoke.mjs" --act')

    @unittest.expectedFailure
    def test_gap_pre_join_only_in_a_trailing_comment(self):
        self.assertRefused('node smoke.mjs --lang en # --pre-join')


if __name__ == '__main__':
    unittest.main(verbosity=2)
