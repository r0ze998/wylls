#!/usr/bin/env python3 -I
"""Fresh-clone static audit of a commit's Git tree (read-only: git ls-tree / git show). Every literal reference must
resolve to a TRACKED file or directory of that commit — so a local untracked or ignored file cannot hide a gap.
Usage: fresh-clone-audit.py <repo> <commit>"""
import posixpath as pp, re, subprocess, sys, json
repo, commit = sys.argv[1], sys.argv[2]
files = subprocess.run(['git', '-C', repo, 'ls-tree', '-r', '--name-only', commit], capture_output=True, text=True, check=True).stdout.split('\n')
files = [f for f in files if f]
tracked = set(files)
dirs = set()
for f in files:
    d = pp.dirname(f)
    while d and d not in dirs:
        dirs.add(d); d = pp.dirname(d)
show = lambda f: subprocess.run(['git', '-C', repo, 'show', f'{commit}:{f}'], capture_output=True).stdout.decode('utf-8', 'replace')
WEB = 'permutation-server/web'
JS_ROOTS = (WEB + '/', 'permutation-gateway/src/', 'permutation-gateway/test/', 'permutation-gateway/screens/', 'scripts/')
missing, checked, dynamic = [], 0, 0
def exists(path):
    return path in tracked or path in dirs
def check(src, ref, path, kind):
    global checked
    checked += 1
    if not exists(path):
        missing.append({'from': src, 'ref': ref, 'resolved': path, 'kind': kind})

js_import = re.compile(r"""(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"]([^'"\n]+)['"]""")
js_url = re.compile(r"""new URL\(\s*['"]([^'"\n]+)['"]\s*,\s*import\.meta\.url\s*\)""")
for f in files:
    if not f.startswith(JS_ROOTS) or '/node_modules/' in f or not f.endswith(('.mjs', '.js')):
        continue
    src = show(f)
    base = pp.dirname(f)
    for m in js_import.finditer(src):
        ref = m.group(1)
        if ref.startswith(('./', '../')):
            check(f, ref, pp.normpath(pp.join(base, ref)), 'import')
        elif ref.startswith('/') and f.startswith('permutation-gateway/screens/'):
            check(f, ref, pp.normpath(WEB + ref), 'page-import')     # in-page import, served from the web root
        elif ref.startswith('/') and f.startswith(WEB + '/'):
            check(f, ref, pp.normpath(WEB + ref), 'web-abs-import')
    for m in js_url.finditer(src):
        ref = m.group(1)
        if '${' in ref:
            dynamic += 1; continue
        check(f, ref, pp.normpath(pp.join(base, ref)), 'url')
html_ref = re.compile(r"""(?:src|href)=["']([^"'#?:]+)["']""")
for f in files:
    if not (f.startswith(WEB + '/') and f.endswith('.html')):
        continue
    for m in html_ref.finditer(show(f)):
        ref = m.group(1)
        if not ref or ref.startswith(('http', '//', 'data', 'mailto')):
            continue
        path = pp.normpath(WEB + ref) if ref.startswith('/') else pp.normpath(pp.join(pp.dirname(f), ref))
        check(f, ref, path, 'html')
cargo_path = re.compile(r"""\bpath\s*=\s*["']([^"']+)["']""")
for f in files:
    if not f.endswith('Cargo.toml'):
        continue
    for m in cargo_path.finditer(show(f)):
        ref = m.group(1)
        check(f, ref, pp.normpath(pp.join(pp.dirname(f), ref)), 'cargo-path')
rs_inc = re.compile(r"""include_(?:str|bytes)!\(\s*["']([^"']+)["']\s*\)""")
for f in files:
    if not f.endswith('.rs'):
        continue
    for m in rs_inc.finditer(show(f)):
        ref = m.group(1)
        if ref.startswith('/') or 'concat!' in ref or 'env!' in ref:
            dynamic += 1; continue
        check(f, ref, pp.normpath(pp.join(pp.dirname(f), ref)), 'include')
print(json.dumps({'commit': commit, 'tracked': len(files), 'checked': checked, 'dynamic_skipped': dynamic, 'missing': missing}, ensure_ascii=False, indent=1))
