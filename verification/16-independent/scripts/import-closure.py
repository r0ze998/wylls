# ⑯: static import closure of browser pages (HTML <script type=module src> and inline imports, then ESM imports),
# and the files in it that name a key or signing API. Args: root page...
import re, sys, os
root = sys.argv[1]; pages = sys.argv[2:]
IMP = re.compile(r"""(?:import\s+(?:[^'"]*?\s+from\s+)?|import\(\s*|export\s+[^'"]*?\s+from\s+)['"]([^'"]+)['"]""")
SRC = re.compile(r"""<script[^>]+src=['"]([^'"]+)['"]""")
KEY = re.compile(r"Keypair\.(generate|fromSeed|fromSecretKey)|generateKey(Pair)?\b|subtle\.(sign|generateKey|importKey|deriveKey|deriveBits)|\bnacl\b|ed25519\.(sign|getPublicKey|utils)|secp256k1\.(sign|getPublicKey)|randomPrivateKey|randomSecretKey|\.signMessage\(|signTransaction\(|partialSign\(")
seen, todo = set(), []
for p in pages:
    full = os.path.join(root, p.lstrip('/'))
    html = open(full, encoding='utf-8').read()
    base = os.path.dirname(full)
    for s in SRC.findall(html) + IMP.findall(html):
        todo.append(os.path.normpath(os.path.join(base, s)) if not s.startswith('/') else os.path.join(root, s.lstrip('/')))
while todo:
    f = todo.pop()
    if f in seen or not os.path.isfile(f): continue
    seen.add(f)
    src = open(f, encoding='utf-8', errors='replace').read()
    for s in IMP.findall(src):
        if s.startswith('.') or s.startswith('/'):
            todo.append(os.path.normpath(os.path.join(os.path.dirname(f), s)) if s.startswith('.') else os.path.join(root, s.lstrip('/')))
hits = []
for f in sorted(seen):
    for i, line in enumerate(open(f, encoding='utf-8', errors='replace'), 1):
        if KEY.search(line) and not line.lstrip().startswith(('//', '*', '/*')):
            hits.append(f"{os.path.relpath(f, root)}:{i}: {line.strip()[:140]}")
print(f"{len(seen)} modules in the closure"); print('\n'.join(hits) if hits else 'no key or signing API named')
