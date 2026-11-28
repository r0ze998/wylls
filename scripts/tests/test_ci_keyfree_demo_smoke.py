#!/usr/bin/env python3
"""scripts/ci/check-ci-keyfree.py: the walletless demo smoke rule (#309, Q-FDW-1 = B; test-gaps-10).

  python3 scripts/tests/test_ci_keyfree_demo_smoke.py      (needs PyYAML, as the checker does; not -I: CI installs it
                                                          with pip --user, which -I would hide)

finish-pr309 N6 proved this rule by hand: `--act` and `npm run smoke` lines were added to the ci.yml step and the checker
exited 1. Here every case is a small workflow file in a temp dir, and the real checker runs on it (no key, no network,
no browser). The three `gap` cases (D-test-gaps-10-1) were lines that DO run a signing smoke but passed the checker; they
were `expectedFailure` until Q-TG10-1 = a (r0ze 2026-11-28 19:45) hardened the checker (fix-tg10) and now pass, with the
fix-tg10 forms below them (same-line other command, variable indirection, `$(…)`, npm flags before `--`).
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
        # a flag followed straight by `;` is --pre-join too (D-test-gaps-10-3 was a false refusal; fix-tg10 cuts at `;`)
        self.assertAllowed("for v in '' --mobile; do node smoke.mjs --pre-join $v; done")
        self.assertAllowed("for v in '' --mobile; do node smoke.mjs $v --pre-join; done")
        # the real ci.yml loop shape, continued over lines, a quoted name, a trailing comment after the flag
        self.assertAllowed('for v in \'\' --mobile; do\n  node smoke.mjs --dir dist-pages \\\n    --lang en $v --pre-join\ndone')
        self.assertAllowed('node "smoke.mjs" --pre-join  # the PR run')
        self.assertAllowed('npm run smoke -- --pre-join')
        self.assertAllowed('node smoke.mjs --pre-join --camps --mobile')
        self.assertAllowed('node ./smoke.mjs --pre-join --mobile')
        # a comment line naming the smoke runs nothing
        self.assertAllowed('# node smoke.mjs --act\nnode build.mjs')

    def test_signing_runs_are_refused_N6(self):
        for run in ['node smoke.mjs --lang en',                       # joins: a session key, signed orders
                    'node smoke.mjs --pre-join --act',                  # N6
                    'node smoke.mjs --loop --pre-join',
                    'node permutation-gateway/demo/smoke.mjs --act',
                    'npm run smoke',                                    # N6
                    'node smoke.mjs --pre-join --claim',                # #306 --claim needs a joined player (D-verify-pr315-1)
                    "node 'smoke.mjs' --lang en",
                    'node "./demo/smoke.mjs" --pre-join "--act"',
                    'node smoke-save.mjs --lang en',                    # joins and signs; it has no --pre-join
                    'node smoke-save.mjs --pre-join --act',
                    'node build.mjs\nnode smoke.mjs --pre-join\nnode smoke.mjs --act']:
            with self.subTest(run=run):
                self.assertRefused(run)
                # the command itself is named (not only the step-wide --act/--loop/--claim scan below)
                self.assertNotIn('set elsewhere in the step', check(workflow(run))[1])

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

    # ---- D-test-gaps-10-1: lines that run a signing smoke and passed the checker before fix-tg10 (Q-TG10-1 = a)

    def test_gap_backslash_continuation_hides_act(self):
        # the shell runs `node smoke.mjs --pre-join --act`; the checker used to read the two lines apart
        self.assertRefused('node smoke.mjs --pre-join \\\n  --act')
        self.assertRefused('node smoke.mjs --lang en \\\n  --act \\\n  --pre-join')
        # and a safe run continued over lines is one command (--pre-join on the next line reaches smoke.mjs)
        self.assertAllowed('node smoke.mjs --lang en \\\n  --pre-join')

    def test_gap_quoted_script_name(self):
        self.assertRefused('node "smoke.mjs" --act')
        self.assertRefused('node "permutation-gateway/demo/smoke.mjs" --lang en')

    def test_gap_pre_join_only_in_a_trailing_comment(self):
        self.assertRefused('node smoke.mjs --lang en # --pre-join')
        self.assertRefused('node smoke.mjs --lang en #--pre-join')
        # a `#` inside a word or quotes is not a comment
        self.assertAllowed('node smoke.mjs --path "a#b" --pre-join')

    # ---- fix-tg10's own bad forms

    def test_flag_in_another_command_on_the_same_line(self):
        # the old line-wide search saw --pre-join; the shell runs the smoke without it
        self.assertRefused('node smoke.mjs --lang en; echo --pre-join')
        self.assertRefused('node smoke.mjs --lang en && echo --pre-join')
        self.assertRefused('node smoke.mjs --lang en | tee log --pre-join')

    def test_variable_and_env_indirection(self):
        self.assertRefused('F=--act; node smoke.mjs --pre-join $F')
        self.assertRefused("for v in '' --act; do node smoke.mjs --pre-join $v; done")
        self.assertRefused('S=smoke.mjs\nnode $S --lang en')                        # the name through a variable
        code, out = check(workflow_env('node smoke.mjs --pre-join $EXTRA', step_env={'EXTRA': '--loop'}))
        self.assertEqual(code, 1, out); self.assertIn('set elsewhere in the step or its env', out)
        code, out = check(workflow_env('node smoke.mjs --pre-join $EXTRA', job_env={'EXTRA': '--act'}))
        self.assertEqual(code, 1, out)
        code, out = check(workflow_env('node smoke.mjs --pre-join $EXTRA', wf_env={'EXTRA': '--claim'}))
        self.assertEqual(code, 1, out)
        # an env without a signing flag is fine (ci.yml's BASE / ORIGIN / LIVE_URL)
        code, out = check(workflow_env('node smoke.mjs --pre-join --origin "$ORIGIN"', step_env={'ORIGIN': 'https://x.github.io'}))
        self.assertEqual(code, 0, out)

    def test_words_the_checker_cannot_read(self):
        for run in ['node smoke.mjs --pre-join $(echo --act)',
                    'node smoke.mjs --pre-join `cat flags`',
                    'node smoke.mjs --pre-join ${{ inputs.flags }}',
                    'eval node smoke.mjs --pre-join "$X"',
                    'xargs node smoke.mjs --pre-join < flags',
                    'node smoke.mjs --pre-join "unclosed']:
            with self.subTest(run=run):
                self.assertRefused(run)

    def test_npm_flags_before_the_double_dash_go_to_npm(self):
        self.assertRefused('npm run smoke --pre-join')
        self.assertRefused('npm run-script smoke --pre-join -- --lang en')
        self.assertRefused('npm run smoke -- --pre-join --act')


def workflow_env(run, wf_env=None, job_env=None, step_env=None):
    import yaml
    wf = {'on': ['push', 'pull_request'], 'jobs': {'walletless-demo': {'runs-on': 'ubuntu-24.04', 'steps': [{'name': 'smoke', 'run': run}]}}}
    if wf_env: wf['env'] = wf_env
    if job_env: wf['jobs']['walletless-demo']['env'] = job_env
    if step_env: wf['jobs']['walletless-demo']['steps'][0]['env'] = step_env
    path = os.path.join(TMP, f'w{len(os.listdir(TMP))}.yml')
    with open(path, 'w', encoding='utf-8') as f:
        yaml.safe_dump(wf, f)
    return path


if __name__ == '__main__':
    unittest.main(verbosity=2)
