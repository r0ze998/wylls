#!/usr/bin/env python3
"""Fails when a CI job that a push or pull request can start would run a
key-using check (owner rule, 2026-11-06), or when the key-tests job could
start without the manual approval. Read-only; no network.

  python3 scripts/ci/check-ci-keyfree.py [.github/workflows/ci.yml ...]
"""
import re, sys, yaml

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
# seed (permutation-gateway/screens/world.mjs DEV_SEED, 32 × 0x11; no chain, no funds) and stops at the start button:
# nothing is signed (smoke.mjs counts crypto.subtle.sign and requires 0). Any other smoke.mjs run signs (joining makes
# a session key, orders are signed): every line that runs smoke.mjs outside key-tests must carry --pre-join and none of
# --act / --loop.
# `npm run smoke` / `npm run-script smoke` (permutation-gateway/demo/package.json: "smoke": "node smoke.mjs") count too.
SMOKE_RUN = re.compile(r'(^|[\s/])smoke\.mjs(\s|$)|(^|\s)npm (run|run-script) smoke(\s|$)')

def demo_smoke_bad(step):
    lines = [l.strip() for l in str(step.get('run', '')).splitlines()]
    runs = [l for l in lines if l and not l.startswith('#') and SMOKE_RUN.search(l)]
    return [l for l in runs if not re.search(r'(^|\s)--pre-join(\s|$)', l) or re.search(r'(^|\s)--(act|loop)(\s|$)', l)]

def lint_only(step):
    if step.get('uses'):
        return False
    lines = [l.strip() for l in str(step.get('run', '')).splitlines()]
    lines = [l for l in lines if l and not l.startswith('#')]
    return bool(lines) and all(LINT_LINE.match(l) for l in lines)

def check(path):
    wf = yaml.safe_load(open(path))
    bad = []
    for name, job in (wf.get('jobs') or {}).items():
        manual = (job.get('if') or '').strip() == APPROVED_IF
        if name == 'key-tests':
            if not manual:
                bad.append(f'{path}: job key-tests must have exactly `if: {APPROVED_IF}`')
            continue
        for st in job.get('steps') or []:
            text = '\n'.join(str(st.get(k, '')) for k in ('run', 'uses', 'name', 'working-directory'))
            for l in demo_smoke_bad(st):
                bad.append(f'{path}: job {name}, step "{st.get("name") or l[:40]}": demo smoke without --pre-join (or with --act/--loop) signs: `{l[:80]}`')
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
