#!/usr/bin/env python3
"""Flag-off guard (test-gaps-13): the features merged OFF stay out of everything that ships.

  python3 scripts/ci/flag-off.py check              static rules (who may name or enable a flag; CI wiring)
  python3 scripts/ci/flag-off.py poison [rust|js]   replace every flag-off source by one that cannot be built or loaded
  python3 scripts/ci/flag-off.py poison-bites ...   run the command; succeed only if it FAILS on the poison message
  python3 scripts/ci/flag-off.py same-tree A B      two directories hold the same files with the same bytes

Why poison and not only hashes. A flag-off module that nothing links adds no byte to a program, a WASM kernel or a
bundle even with its flag ON, so a hash alone cannot say the flag is off; and the program's .so cannot be built in a
push/PR job at all (KEY-FREE-CI: cargo-build-sbf only in key-tests). So the push/PR jobs that build what ships run
`poison` right after checkout, then do exactly what they did before:
  - a build that reads a flag-off source (feature turned on in any manifest, by unification or by a cfg that was
    dropped; a JS import; a copy into the bundle) stops on the poison, or carries its marker;
  - a build that passes did not read it, so its output is what the same tree gives without the feature. The WASM jobs
    compare theirs with the committed modules' hashes, the rules job with the ruleset hash goldens, the demo job with
    the bundle it built before the poison (same-tree): all byte for byte.
`poison` edits the checkout: it runs only when CI=true, or with --force on files git shows as unmodified
(undo: `git checkout -- <file>` for each file it names).
"""
import hashlib, os, re, subprocess, sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
MARK = 'WYLLS-FLAG-OFF-POISON'

RUST_FEATURE = 'declarative-effects'                                  # ⑪(b), #317: permutation-rules, off by default
RUST_SOURCES = ['permutation-rules/src/frontier/effects.rs']
JS_DIR = 'workstreams/06-creation/src/chainlink'                      # ⑥ chain link, #329: off unless exactly "1"
JS_SWITCHES = ('WYLLS_CREATION_CHAINLINK', 'wylls.creation.chainlink', 'chainlink=')
# what only ⑥'s chain link says (permutation-server's own `chainlink` module, the legacy game's, is something else)
JS_NAMES = JS_SWITCHES + ('src/chainlink/', 'PSF6CENT', 'PSF6CVER', 'chainLinkEnabled', 'LinkedRegistry')

# The push/PR jobs that build what ships, and which kinds they poison. `check` holds ci.yml to this table: the poison
# step comes before the job's first build, has no `if:`, and may not fail softly.
POISONED_JOBS = {
    'program': ['rust'],                    # rules tests (ruleset hash goldens), v9 program, server
    'frontier-program': ['rust'],           # ABI, the Frontier program with every shipped feature set
    'frontier-node': ['rust'],              # keeper, herald, verifier, operator, play-local builds
    'frontier-wasm': ['rust'],              # the three kernels = the Linux hash recorded for the committed modules
    'frontier-wasm-reference': ['rust'],    # the three kernels = the committed modules, byte for byte
    'prize-program': ['rust'],
    'exec-native': ['rust'],
    'walletless-demo': ['rust', 'js'],      # after the first bundle; the second must equal it
}
# The only jobs that may build the feature, as host tests.
FEATURE_JOBS = {'frontier-previews', 'workstream-crates'}
# The Frontier program's shipped feature sets that frontier-program checks on the poisoned tree (the sets
# scripts/build-frontier*.sh pass to cargo-build-sbf; `check` compares the two lists).
SHIPPED_FEATURES_STEP = 'Flag-off: every program feature set the build scripts ship compiles without the flag-off sources'


def git_files():
    out = subprocess.run(['git', 'ls-files', '-z'], cwd=ROOT, capture_output=True, check=True).stdout
    return [f for f in out.decode().split('\0') if f]


def js_sources():
    return sorted(f for f in git_files() if f.startswith(JS_DIR + '/') and f.endswith('.mjs'))


def text(rel, root=None):
    try:
        with open(os.path.join(root or ROOT, rel), encoding='utf-8') as f:
            return f.read()
    except (UnicodeDecodeError, FileNotFoundError, IsADirectoryError):
        return ''


# ------------------------------------------------------------------ static rules

def toml_rules(rel, data):
    """Findings for one parsed Cargo.toml."""
    bad, own = [], rel == 'permutation-rules/Cargo.toml'
    for name, items in (data.get('features') or {}).items():
        if name == RUST_FEATURE:
            if not own or items:
                bad.append(f'{rel}: [features] {RUST_FEATURE} may only be the empty definition in permutation-rules')
            continue
        for it in items:
            if it.split('/')[-1] == RUST_FEATURE:
                bad.append(f'{rel}: feature `{name}` turns {RUST_FEATURE} on')

    def deps(table, where, dev):
        for dep, spec in (table or {}).items():
            if isinstance(spec, dict) and RUST_FEATURE in (spec.get('features') or []):
                if not (dev and rel == 'workstreams/11-extensions/ext-kernel/Cargo.toml' and where == 'dev-dependencies'):
                    bad.append(f'{rel}: [{where}] {dep} turns {RUST_FEATURE} on')
    def tables(d, prefix):
        deps(d.get('dependencies'), prefix + 'dependencies', False)
        deps(d.get('build-dependencies'), prefix + 'build-dependencies', False)
        deps(d.get('dev-dependencies'), prefix + 'dev-dependencies', True)
    tables(data, '')
    tables(data.get('workspace') or {}, 'workspace.')
    for cfg, d in (data.get('target') or {}).items():
        tables(d, f'target.{cfg}.')
    for section in ('package', 'workspace'):
        meta = ((data.get(section) or {}).get('metadata') or {})
        if RUST_FEATURE in repr(meta):
            bad.append(f'{rel}: [{section}.metadata] names {RUST_FEATURE}')
    return bad


# Files that may say the Rust feature's name, besides Cargo.toml (parsed above), ci.yml (per job, below) and docs.
RUST_NAMERS = {
    'permutation-rules/src/frontier/effects.rs', 'permutation-rules/src/frontier/mod.rs',
    'permutation-rules/tests/frontier_shared.rs', 'workstreams/11-extensions/ext-kernel/tests/kernel_slice.rs',
    'scripts/ci/flag-off.py', 'scripts/tests/test_flag_off.py',
}
JS_NAMERS = {'scripts/ci/flag-off.py', 'scripts/tests/test_flag_off.py', 'scripts/ci/node-key-reviewed.txt'}
JS_IMPORTERS = {'workstreams/06-creation/proto/app.mjs', 'workstreams/06-creation/proto/e2e-chainlink.mjs'}
SKIP_TEXT = re.compile(r'\.(md|png|jpe?g|webp|gif|wasm|gz|so|bin|ico|woff2?|mp3|ogg|wav|pdf|lock)$', re.I)


def static_findings(root=None, files=None, workflows=None):
    import tomllib
    root = root or ROOT
    files = files if files is not None else git_files()
    bad = []
    for rel in files:
        if rel.endswith('Cargo.toml') or rel.endswith('.cargo/config.toml') or rel.endswith('.cargo/config'):
            src = text(rel, root)
            if rel.endswith('Cargo.toml'):
                try:
                    bad += toml_rules(rel, tomllib.loads(src))
                except tomllib.TOMLDecodeError as e:
                    bad.append(f'{rel}: unreadable ({e})')
            elif RUST_FEATURE in src:
                bad.append(f'{rel}: names {RUST_FEATURE}')
            continue
        if SKIP_TEXT.search(rel) or rel.startswith('docs/') or rel.startswith('.github/workflows/'):
            continue
        src = text(rel, root)
        if (RUST_FEATURE in src or RUST_FEATURE.replace('-', '_') in src) and rel not in RUST_NAMERS:
            bad.append(f'{rel}: names the flag-off feature {RUST_FEATURE}')
        if re.search(r'(^|\s)--all-features(\s|$)', src, re.M) and re.search(r'\.(sh|mjs|js|py|json|ya?ml)$', rel) and rel not in RUST_NAMERS:
            bad.append(f'{rel}: --all-features turns every flag-off feature on')
        in06 = rel.startswith('workstreams/06-creation/')
        if not in06 and rel not in JS_NAMERS and any(n in src for n in JS_NAMES):
            bad.append(f'{rel}: names the ⑥ chain link outside workstreams/06-creation')
        if in06 and not rel.startswith(JS_DIR + '/') and not rel.startswith('workstreams/06-creation/test/chainlink-') \
                and rel not in JS_IMPORTERS and re.search(r'''(from|import)\s*\(?\s*["'][^"']*chainlink/''', src):
            bad.append(f'{rel}: imports src/chainlink (only {sorted(JS_IMPORTERS)} and test/chainlink-* may)')
        if in06 and rel.endswith('package.json') and any(s in src for s in JS_SWITCHES):
            bad.append(f'{rel}: turns the ⑥ chain link on')
    # the one cfg line, directly on the one module line
    mod = text('permutation-rules/src/frontier/mod.rs', root)
    gate = f'#[cfg(feature = "{RUST_FEATURE}")]\npub mod effects;\n'
    if mod.count(gate) != 1 or mod.count(RUST_FEATURE) != 1 or len(re.findall(r'\bmod effects\b', mod)) != 1:
        bad.append('permutation-rules/src/frontier/mod.rs: `pub mod effects;` must stand once, directly under its cfg, and nothing else may read the feature')
    flag = text(JS_DIR + '/flag.mjs', root)
    if flag.count('=== "1"') != 3 or len(re.findall(r'return true;', flag)) != 3 or not flag.rstrip().endswith('return false;\n}'):
        bad.append(f'{JS_DIR}/flag.mjs: three exact `=== "1"` switches and `return false` at the end')
    bad += workflow_findings(root, files if workflows is None else workflows)
    return bad


BUILDS = re.compile(r'\b(cargo|build-wasm\.sh|build-frontier|build-prize|build-program|npm|npx|node build\.mjs|\w[\w-]*\.sh)\b')
POISON_LINE = re.compile(r'^python3 scripts/ci/flag-off\.py poison ([a-z ]+)$')


def shipped_feature_sets(root, files):
    """Feature lists scripts/build-frontier.sh accepts (what it hands to cargo-build-sbf)."""
    src = text('scripts/build-frontier.sh', root)
    sets = set()
    case = src[src.index('case "$feature" in'):]
    case = case[:case.index('esac')]
    for m in re.finditer(r'^\s*(""\|)?([a-z0-9|-]+)\)', case, re.M):
        sets |= set(m.group(2).split('|'))
    for f in sorted(f for f in files if re.fullmatch(r'scripts/build-frontier-[\w-]+\.sh', f)):   # (each lane's own script)
        sets |= set(re.findall(r'--features[ =]"?([a-z0-9,-]+)', text(f, root)))
    if 'rights-test-beacon' in sets:                                  # a script name for two cargo features
        sets.remove('rights-test-beacon')
        sets |= set(re.findall(r'rights-test-beacon\) args\+=\(--features "([a-z,-]+)"\)', src)) or {'rights-test-beacon'}
    return sets


def workflow_findings(root, files):
    import yaml
    bad = []
    for rel in sorted(f for f in files if f.startswith('.github/workflows/')):
        src = text(rel, root)
        wf = yaml.safe_load(src) or {}
        for name, job in (wf.get('jobs') or {}).items():
            whole = yaml.safe_dump(job, allow_unicode=True)
            if RUST_FEATURE in whole and not (rel.endswith('/ci.yml') and name in FEATURE_JOBS):
                bad.append(f'{rel}: job {name} names {RUST_FEATURE} (only {sorted(FEATURE_JOBS)} build it, as host tests)')
            if '--all-features' in whole:
                bad.append(f'{rel}: job {name}: --all-features')
            if any(s in whole for s in JS_SWITCHES):
                bad.append(f'{rel}: job {name} turns the ⑥ chain link on')
        if any(s in yaml.safe_dump(wf.get('env') or {}) for s in JS_SWITCHES):
            bad.append(f'{rel}: env turns the ⑥ chain link on')
        if not rel.endswith('/ci.yml'):
            continue
        jobs = wf.get('jobs') or {}
        for name, kinds in POISONED_JOBS.items():
            steps = (jobs.get(name) or {}).get('steps') or []
            at = [i for i, s in enumerate(steps) if 'flag-off.py poison ' in str(s.get('run', ''))]
            if not at:
                bad.append(f'{rel}: job {name} does not poison the flag-off sources')
                continue
            s = steps[at[0]]
            first = str(s.get('run', '')).strip().splitlines()[0].strip()
            m = POISON_LINE.match(first)
            if not m or sorted(m.group(1).split()) != sorted(kinds):
                bad.append(f'{rel}: job {name}: the poison step must start with `python3 scripts/ci/flag-off.py poison {" ".join(kinds)}`')
            if s.get('if') is not None or s.get('continue-on-error') or s.get('working-directory') or (jobs[name].get('continue-on-error')) or jobs[name].get('if'):
                bad.append(f'{rel}: job {name}: the poison step (and its job) may not be conditional or allowed to fail')
            before = [b for b in steps[:at[0]] if BUILDS.search(re.sub(r'rustup [^\n]*', '', str(b.get('run', ''))))]
            allowed = 1 if name == 'walletless-demo' else 0      # the demo's first bundle is the one compared against
            if len(before) > allowed:
                bad.append(f'{rel}: job {name}: "{before[allowed].get("name")}" builds before the poison')
            after = '\n'.join(str(b.get('run', '')) + str(b.get('uses', '')) for b in steps[at[0] + 1:])
            if re.search(r'git (checkout|restore|reset|stash)|actions/checkout', after):
                bad.append(f'{rel}: job {name}: a later step restores the checkout')
        demo = '\n'.join(str(s.get('run', '')) for s in (jobs.get('walletless-demo') or {}).get('steps') or [])
        if 'flag-off.py same-tree dist dist-flag-off' not in demo:
            bad.append(f'{rel}: job walletless-demo does not compare the poisoned bundle with the first one')
        step = [s for s in (jobs.get('frontier-program') or {}).get('steps') or [] if s.get('name') == SHIPPED_FEATURES_STEP]
        run = str(step[0].get('run', '')) if step else ''
        for want in sorted(shipped_feature_sets(root, files)):
            if not re.search(rf'(^|\s){re.escape(want)}(\s|$)', run, re.M):
                bad.append(f'{rel}: frontier-program: shipped feature set `{want}` is not checked on the poisoned tree')
        prev = '\n'.join(str(s.get('run', '')) for s in (jobs.get('frontier-previews') or {}).get('steps') or [])
        if 'flag-off.py poison-bites ' not in prev:
            bad.append(f'{rel}: frontier-previews no longer proves that the poison stops a flag-on build')
    return bad


# ------------------------------------------------------------------ poison

def poison(kinds, force):
    if os.environ.get('CI') != 'true' and not force:
        sys.exit('flag-off poison edits the checkout: CI only (or --force on a clean file)')
    todo = []
    if 'rust' in kinds:
        todo += [(f, f'compile_error!("{MARK}: {RUST_FEATURE} is merged OFF");\n') for f in RUST_SOURCES]
    if 'js' in kinds:
        todo += [(f, f'// {MARK}\nthrow new Error("{MARK}: the ⑥ chain link is merged OFF, but this code loads it");\n') for f in js_sources()]
    for rel, body in todo:
        p = os.path.join(ROOT, rel)
        if not os.path.isfile(p):
            sys.exit(f'{rel}: no such file (moved? update scripts/ci/flag-off.py)')
        if MARK in text(rel):
            continue
        if subprocess.run(['git', 'diff', '--quiet', 'HEAD', '--', rel], cwd=ROOT).returncode != 0:
            sys.exit(f'{rel}: has changes; not touched')
        with open(p, 'w', encoding='utf-8') as f:
            f.write(body)
        print(f'poisoned {rel}')


def poison_bites(cmd):
    if MARK not in text(RUST_SOURCES[0]):
        sys.exit('poison-bites: the tree is not poisoned')
    p = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True)
    out = p.stdout + p.stderr
    if p.returncode == 0 or MARK not in out:
        print(out[-4000:], file=sys.stderr)
        sys.exit(f'poison-bites: the flag-on build did not stop on the poison (exit {p.returncode}); the guard proves nothing')
    print('poison-bites: the flag-on build stops on the poison')


def tree(d):
    out = {}
    for base, _, names in os.walk(d):
        for n in names:
            p = os.path.join(base, n)
            with open(p, 'rb') as f:
                b = f.read()
            if MARK.encode() in b:
                sys.exit(f'{p}: carries the flag-off poison (a flag-off source was copied into the output)')
            out[os.path.relpath(p, d)] = hashlib.sha256(b).hexdigest()
    return out


def same_tree(a, b):
    ta, tb = tree(a), tree(b)
    if len(ta) < 100:
        sys.exit(f'{a}: only {len(ta)} files; not a bundle')
    diff = sorted(f for f in ta.keys() | tb.keys() if ta.get(f) != tb.get(f))
    for f in diff[:20]:
        print(f'differs: {f}  {ta.get(f, "absent")[:12]} / {tb.get(f, "absent")[:12]}', file=sys.stderr)
    if diff:
        sys.exit(f'{len(diff)} file(s) differ between {a} and {b}: the output depends on a flag-off source')
    agg = hashlib.sha256(''.join(f'{h}  {f}\n' for f, h in sorted(ta.items())).encode()).hexdigest()
    print(f'same-tree: {len(ta)} files, byte-identical, aggregate sha256 {agg}')


if __name__ == '__main__':
    cmd, args = (sys.argv[1] if len(sys.argv) > 1 else ''), sys.argv[2:]
    if cmd == 'check' and not args:
        bad = static_findings()
        for b in bad:
            print(b, file=sys.stderr)
        print(f'{len(bad)} flag-off finding(s)' if bad else 'ok: the flag-off features are named and enabled only where allowed')
        sys.exit(1 if bad else 0)
    elif cmd == 'poison':
        force = '--force' in args
        kinds = [a for a in args if a != '--force'] or ['rust', 'js']
        if set(kinds) - {'rust', 'js'}:
            sys.exit('poison [rust] [js] [--force]')
        poison(kinds, force)
    elif cmd == 'poison-bites' and args:
        poison_bites(args)
    elif cmd == 'same-tree' and len(args) == 2:
        same_tree(*args)
    else:
        sys.exit(__doc__)
