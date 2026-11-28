#!/usr/bin/env python3
"""Fails when a CI job that a push or pull request can start would run a
key-using check (owner rule, 2026-11-06), or when the key-tests job could
start without the manual approval. Read-only; no network.

  python3 scripts/ci/check-ci-keyfree.py [.github/workflows/ci.yml ...]
"""
import re, shlex, sys, yaml

FORBIDDEN = [
    (r'svm-tests', 'LiteSVM suite'),
    (r'build-(frontier|prize|program)\.sh', 'SBF build (cargo-build-sbf may write a program keypair)'),
    (r'cargo-build-sbf|cargo build-sbf', 'SBF build'),
    (r'release\.anza\.xyz', 'Agave install (only the SBF builds need it)'),
    (r'(^|\s)npm test(\s|$)|npm run test', 'full Node suite (includes listed key tests)'),
    (r'cargo test[^\n]*--workspace', 'frontier-node workspace tests (test payers, test-beacon key)'),
    (r'solana-keygen|solana program deploy|solana-test-validator', 'key or validator CLI'),
]
APPROVED_IF = "github.event_name == 'workflow_dispatch' && inputs.key_tests == 'approved'"

# Format and lint steps (2026-11-21): `cargo fmt --check` reads source and
# `cargo clippy` compiles every target but runs none, so no test, and no key
# code in a test, is executed (the same reasoning as frontier-node's lints).
# A step whose `run` is nothing but such lines may name a LiteSVM crate
# (svm-tests): that one pattern is waived for it, every other pattern still
# applies. Anything else on a line (cargo test, a script, `&&`, `;`, a pipe)
# makes the step an ordinary one again.
LINT_LINE = re.compile(
    r'^cargo (fmt( --all| -p [\w-]+)? -- --check'
    r'|clippy --locked( --workspace| -p [\w-]+)?( --features [\w,-]+)? --all-targets -- -D warnings)$')

# The one owner-approved exception (Q-FDW-1 = B, r0ze 2026-11-28 08:30, inbox 2026-11-28-0830-r0ze-fdw1-answer.md;
# docs/ci/KEY-FREE-CI.ja.md): the walletless demo's browser smoke (permutation-gateway/demo/smoke.mjs) may run in a
# push/PR job ONLY as `--pre-join`. The page then derives the PUBLIC key of its Dev Wallet from the sample world's fixed
# seed (permutation-gateway/screens/world.mjs DEV_SEED, 32 × 0x11; no chain, no funds) and stops at the start button.
# The only signature is the page's load-time Ed25519 test (src/boot.mjs cryptoCheck: throwaway seed 32 × 0x07, fixed
# text "Wylls demo preflight", at most once per load; Q-FDW-2 = A, r0ze 2026-11-28 11:50): smoke.mjs counts it apart
# (0 or 1) and requires 0 other signatures and no private key from another seed. Any other smoke.mjs run signs (joining makes
# a session key, orders are signed): every line that runs smoke.mjs outside key-tests must carry --pre-join and none of
# --act / --loop.
# `npm run smoke` / `npm run-script smoke` (permutation-gateway/demo/package.json: "smoke": "node smoke.mjs") and the
# other demo smokes (smoke-save.mjs joins and signs; it has no --pre-join, so any run of it here fails) count too.
# Q-TG10-1 = a (r0ze 2026-11-28 19:45, inbox 2026-11-28-1524-test-gaps-10-questions.md; fix-tg10): the rule reads the
# run text the way the shell does, not line by line. `\`-newline continuations are joined, a `# …` comment (at a word
# start, outside quotes) is dropped to the end of its line, and the text is cut into commands at newlines and at
# `;` `&` `|` outside quotes. Each command that names a demo smoke is then split into words (quotes removed), so
# `node "smoke.mjs" --act`, `node smoke.mjs --pre-join \` + `--act`, and `node smoke.mjs --lang en # --pre-join` are
# runs without --pre-join (or with --act). Also refused (fix-tg10): a smoke command whose words come from somewhere the
# checker cannot read — `$(…)`, backticks, `<(…)`, `${{ … }}`, eval, xargs — and any --act / --loop / --claim word
# anywhere in a step that runs a smoke or in the workflow/job/step `env:` values (variable indirection:
# `F=--act; node smoke.mjs --pre-join $F`). `X=smoke.mjs` counts as naming the smoke (`node $X …`).
# NOT caught (documented in docs/ci/KEY-FREE-CI.ja.md): a script name or flag built at run time from pieces
# (`node "${N}.mjs"` with N=smoke; `--$A` with A=act; `F=--a""ct` outside the smoke command — inside it the quotes are
# removed and --act is seen), flags written to $GITHUB_ENV by
# another step from computed text, and flags in a file the smoke reads (it reads none today). Review covers those.
# `npm run smoke` passes flags to smoke.mjs only after `--` (`npm run smoke --pre-join` runs a signing smoke).
SMOKE_RUN = re.compile(r'(^|[\s/"\'=])smoke(-[\w-]+)?\.mjs(["\']?)(\s|$)|(^|\s)npm (run|run-script) ["\']?smoke["\']?(\s|$)')
SIGNING_FLAGS = ('--act', '--loop', '--claim')       # each needs a joined player (smoke.mjs); --claim since #306
SIGNING_FLAG = re.compile(r'(^|[\s=\'"(])--(act|loop|claim)(?=$|[\s\'")=;&|])')
OPAQUE = re.compile(r'\$\(|`|<\(|\$\{\{|(^|\s)(eval|xargs)(\s|$)')

def shell_commands(text):
    """The run text cut into commands as sh reads it: continuations joined, comments dropped, split at newline ; & |
    outside quotes (a parenthesis is kept in the word; the word check strips it)."""
    out, cur, q, i, n = [], [], None, 0, len(text)
    def flush():
        c = ''.join(cur).strip()
        if c:
            out.append(c)
        cur.clear()
    while i < n:
        c = text[i]
        if q == "'":
            cur.append(c); q = None if c == "'" else q; i += 1; continue
        if c == '\\' and i + 1 < n:
            if text[i + 1] == '\n':
                i += 2; continue                       # a continuation: the next line is the same command
            cur += [c, text[i + 1]]; i += 2; continue
        if q == '"':
            cur.append(c); q = None if c == '"' else q; i += 1; continue
        if c in '\'"':
            q = c; cur.append(c); i += 1; continue
        if c == '#' and (not cur or cur[-1] in ' \t;&|('):
            while i < n and text[i] != '\n':
                i += 1                                 # a comment, to the end of the line
            continue
        if c in '\n;&|':
            flush(); i += 1; continue
        cur.append(c); i += 1
    flush()
    return out

def words(cmd):
    try:
        ws = shlex.split(cmd, posix=True)
    except ValueError:
        return None                                    # unbalanced quotes: unreadable, refused
    return [w.strip('(){}') for w in ws]

def demo_smoke_bad(step, env_text=''):
    cmds = shell_commands(str(step.get('run', '')))
    runs = [c for c in cmds if SMOKE_RUN.search(c)]
    bad = []
    for c in runs:
        ws = words(c)
        if ws is not None and 'npm' in ws and not any(SMOKE_RUN.search(' ' + w) and w.endswith('.mjs') for w in ws):
            # `npm run smoke --pre-join` gives --pre-join to npm, not to smoke.mjs: only words after `--` reach it
            passed = ws[ws.index('--') + 1:] if '--' in ws else []
        else:
            passed = ws or []
        if ws is None or OPAQUE.search(c) or '--pre-join' not in passed or any(f in ws for f in SIGNING_FLAGS):
            bad.append(c)
    if runs and not bad and (any(SIGNING_FLAG.search(c) for c in cmds) or SIGNING_FLAG.search(env_text)):
        bad.append('[--act/--loop/--claim set elsewhere in the step or its env] ' + runs[0])
    return bad

def lint_only(step):
    if step.get('uses'):
        return False
    lines = [l.strip() for l in str(step.get('run', '')).splitlines()]
    lines = [l for l in lines if l and not l.startswith('#')]
    return bool(lines) and all(LINT_LINE.match(l) for l in lines)

def check(path):
    wf = yaml.safe_load(open(path))
    bad = []
    env_of = lambda d: ' '.join(f'{k}={v}' for k, v in ((d or {}).get('env') or {}).items()) if isinstance((d or {}).get('env'), dict) else str((d or {}).get('env') or '')
    for name, job in (wf.get('jobs') or {}).items():
        manual = (job.get('if') or '').strip() == APPROVED_IF
        if name == 'key-tests':
            if not manual:
                bad.append(f'{path}: job key-tests must have exactly `if: {APPROVED_IF}`')
            continue
        for st in job.get('steps') or []:
            text = '\n'.join(str(st.get(k, '')) for k in ('run', 'uses', 'name', 'working-directory'))
            for l in demo_smoke_bad(st, ' '.join((env_of(wf), env_of(job), env_of(st)))):
                bad.append(f'{path}: job {name}, step "{st.get("name") or l[:40]}": demo smoke without --pre-join (or with --act/--loop/--claim, or words the checker cannot read) signs: `{l[:120]}`')
            waived = lint_only(st)
            for pat, why in FORBIDDEN:
                if waived and pat == r'svm-tests':
                    continue
                if re.search(pat, text) and not (st.get('name') or '').startswith('#'):
                    bad.append(f'{path}: job {name}, step "{st.get("name") or st.get("run", "")[:40]}": {why}')
    return bad

if __name__ == '__main__':
    paths = sys.argv[1:] or ['.github/workflows/ci.yml']
    bad = [b for p in paths for b in check(p)]
    for b in bad:
        print(b, file=sys.stderr)
    print(f'{len(bad)} key-using step(s) outside the manual key-tests job' if bad else 'ok: push/PR jobs are key-free by this check')
    sys.exit(1 if bad else 0)
