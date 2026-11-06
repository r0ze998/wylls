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
            text = '\n'.join(str(st.get(k, '')) for k in ('run', 'uses', 'name'))
            for pat, why in FORBIDDEN:
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
