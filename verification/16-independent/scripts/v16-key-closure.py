# ⑯: static key-reach audit of Node test files. For each test file, follow EVERY relative import (src/ included,
# unlike scripts/ci/scan-node-key-tests.mjs which stays in the test directory) and report whether any module in the
# closure names a key API. Reads files only; runs nothing. Args: tree_root key_list package_dir...
import os, re, sys
root, keylist, *pkgs = sys.argv[1:]
IMP = re.compile(r"""(?:import\s+(?:[^'"]*?\s+from\s+)?|import\(\s*|export\s+[^'"]*?\s+from\s+|require\(\s*)['"](\.{1,2}/[^'"]+)['"]""")
KEY = re.compile(r"Keypair\.generate|Keypair\.fromSeed|Keypair\.fromSecretKey|generateKeyPair|generateKey\(|createPrivateKey|subtle\.(sign|generateKey|importKey)|signTransaction|signMessage|\.sign\(|partialSign|ed25519\.|secp256k1\.|nacl|keygen|secretKey|privateKey|keyFromSeed")
listed = {l.strip() for l in open(os.path.join(root, keylist)) if l.strip() and not l.startswith('#')}
def closure(f):
    seen, todo = set(), [f]
    while todo:
        x = todo.pop()
        if x in seen or not os.path.isfile(x): continue
        seen.add(x)
        try: src = open(x, encoding='utf-8', errors='replace').read()
        except Exception: continue
        for s in IMP.findall(src):
            p = os.path.normpath(os.path.join(os.path.dirname(x), s))
            for c in (p, p + '.mjs', p + '.js', os.path.join(p, 'index.mjs')):
                if os.path.isfile(c): todo.append(c); break
    return seen
for pkg in pkgs:
    base = os.path.join(root, pkg)
    tests = []
    for d, _, fs in os.walk(base):
        if 'node_modules' in d: continue
        tests += [os.path.join(d, f) for f in fs if f.endswith('.test.mjs')]
    gaps, direct_unlisted = [], 0
    for t in sorted(tests):
        rel = os.path.relpath(t, root)
        if rel in listed: continue
        hits = []
        for m in sorted(closure(t)):
            if m == t: continue
            for i, line in enumerate(open(m, encoding='utf-8', errors='replace'), 1):
                s = line.strip()
                if s.startswith(('//', '*', '/*')): continue
                if KEY.search(line): hits.append(f"{os.path.relpath(m, root)}:{i}"); break
        if hits: gaps.append((rel, hits[:3]))
    print(f"== {pkg}: {len(tests)} test files, {sum(1 for t in tests if os.path.relpath(t, root) in listed)} listed, {len(gaps)} unlisted whose import closure names a key API")
    for rel, h in gaps: print(f"   {rel}  <- {', '.join(h)}")
