# Static load-time audit of the game page's module graph (read-only: reads git blobs at REV, parses them with
# tree-sitter's JavaScript grammar; executes no project code, no node, no browser).
#
# For every module reachable by static imports from frontier/app.mjs (the only <script> of frontier/index.html):
#   - every top-level statement that runs when the module is evaluated (anything but import/export-from, function and
#     class declarations without static initialisers; const/let/var initialisers and `export default <expr>` count);
#   - every call / new / await evaluated by those statements (calls inside function bodies defined there are NOT
#     evaluated at load and are not listed, except when the load-time code itself calls that function);
#   - transitively, for each load-time call to a function of this module or an imported one, every call in that
#     function's body (conservative: nested closures included), across modules, to a fixed depth;
#   - any of those calls whose callee name is a key entry, sealMarch, or `new (Shared)Worker`.
import sys, os, json, subprocess
import tree_sitter_javascript as tsj
from tree_sitter import Language, Parser

REV = sys.argv[1]
WEB = 'permutation-server/web'
P = Parser(Language(tsj.language()))
KEY_NAMES = {'keyFromSeed', 'publicKeyOf', 'preflight', 'derive', 'restore', 'importBackup', 'enableDevWallet', 'devWallet',
             'sealMarch', 'sessionOf', 'signMessage', 'signTransaction', 'generateKey', 'generateKeyPair', 'deriveBits',
             'deriveKey', 'importKey', 'unwrapKey', 'sign', 'partialSign', 'remember'}
WORKERS = {'Worker', 'SharedWorker'}
FN_TYPES = {'function_declaration', 'function_expression', 'arrow_function', 'method_definition', 'generator_function_declaration', 'generator_function', 'class_body'}

cache = {}
def blob(path):
    if path not in cache:
        r = subprocess.run(['git', 'show', f'{REV}:{path}'], capture_output=True)
        cache[path] = r.stdout if r.returncode == 0 else None
    return cache[path]
def text(src, n): return src[n.start_byte:n.end_byte].decode('utf8', 'replace')
def resolve(frm, spec):
    if spec.startswith('/'): return os.path.normpath(WEB + spec)
    if spec.startswith('.'): return os.path.normpath(os.path.join(os.path.dirname(frm), spec))
    return None
def strval(src, n):
    t = text(src, n)
    return t[1:-1] if len(t) >= 2 and t[0] in '\'"' else None

mods = {}
def parse(path):
    if path in mods: return mods[path]
    src = blob(path)
    if src is None: mods[path] = None; return None
    tree = P.parse(src)
    m = {'src': src, 'root': tree.root_node, 'error': tree.root_node.has_error, 'imports': {}, 'deps': [], 'dyn': [], 'fns': {}, 'exports': {}}
    mods[path] = m
    for st in tree.root_node.children:
        if st.type == 'import_statement':
            srcn = st.child_by_field_name('source'); dep = resolve(path, strval(src, srcn)) if srcn else None
            if dep: m['deps'].append(dep)
            for c in st.children:
                if c.type == 'import_clause':
                    for x in c.children:
                        if x.type == 'identifier': m['imports'][text(src, x)] = (dep, 'default')
                        elif x.type == 'namespace_import':
                            ids = [y for y in x.children if y.type == 'identifier']
                            if ids: m['imports'][text(src, ids[-1])] = (dep, '*')
                        elif x.type == 'named_imports':
                            for sp in x.children:
                                if sp.type == 'import_specifier':
                                    nm = sp.child_by_field_name('name'); al = sp.child_by_field_name('alias')
                                    m['imports'][text(src, al or nm)] = (dep, text(src, nm))
        elif st.type == 'export_statement':
            srcn = st.child_by_field_name('source')
            if srcn:
                dep = resolve(path, strval(src, srcn))
                if dep: m['deps'].append(dep)
                for c in st.children:
                    if c.type == 'export_clause':
                        for sp in c.children:
                            if sp.type == 'export_specifier':
                                nm = sp.child_by_field_name('name'); al = sp.child_by_field_name('alias')
                                m['exports'][text(src, al or nm)] = ('reexport', dep, text(src, nm))
                    if c.type == '*': m['exports'].setdefault('*', []).append(dep) if isinstance(m['exports'].get('*'), list) else m['exports'].__setitem__('*', [dep])
            decl = st.child_by_field_name('declaration')
            if decl: register_decl(m, decl, exported=True)
            for c in st.children:
                if c.type == 'export_clause' and not srcn:
                    for sp in c.children:
                        if sp.type == 'export_specifier':
                            nm = sp.child_by_field_name('name'); al = sp.child_by_field_name('alias')
                            m['exports'][text(src, al or nm)] = ('local', text(src, nm))
        else:
            register_decl(m, st, exported=False)
    # dynamic imports with a literal: listed, not followed (they run when their caller runs)
    def walk(n):
        if n.type == 'call_expression' and n.child_by_field_name('function') is not None and n.child_by_field_name('function').type == 'import':
            args = n.child_by_field_name('arguments')
            lit = [a for a in (args.children if args else []) if a.type == 'string']
            m['dyn'].append((n.start_point[0] + 1, resolve(path, strval(src, lit[0])) if lit else text(src, n)[:80]))
        for c in n.children: walk(c)
    walk(tree.root_node)
    return m

def register_decl(m, st, exported):
    src = m['src']
    if st.type in ('function_declaration', 'generator_function_declaration'):
        nm = st.child_by_field_name('name'); m['fns'][text(src, nm)] = st
        if exported: m['exports'][text(src, nm)] = ('local', text(src, nm))
    elif st.type == 'class_declaration':
        nm = st.child_by_field_name('name')
        if nm is not None:
            m['fns'][text(src, nm)] = st
            if exported: m['exports'][text(src, nm)] = ('local', text(src, nm))
    elif st.type in ('lexical_declaration', 'variable_declaration'):
        for d in st.children:
            if d.type == 'variable_declarator':
                nm = d.child_by_field_name('name'); val = d.child_by_field_name('value')
                if nm is not None and nm.type == 'identifier':
                    if val is not None and val.type in ('arrow_function', 'function_expression', 'function'):
                        m['fns'][text(src, nm)] = val
                    if exported: m['exports'][text(src, nm)] = ('local', text(src, nm))

def calls_in(m, node, skip_fn_bodies):
    """Call/new/await nodes evaluated in `node`. skip_fn_bodies: do not enter function bodies (load-time view)."""
    out = []
    def walk(n, top):
        if skip_fn_bodies and not top and n.type in FN_TYPES: return
        if n.type == 'class_declaration' or n.type == 'class':
            # class bodies: only static fields / static blocks run at load
            body = n.child_by_field_name('body')
            if skip_fn_bodies and body is not None:
                for mem in body.children:
                    t = text(m['src'], mem)
                    if mem.type in ('field_definition', 'class_static_block') and (t.startswith('static') or mem.type == 'class_static_block'):
                        walk(mem, True)
                return
        if n.type in ('call_expression', 'new_expression', 'await_expression'):
            out.append(n)
        for c in n.children: walk(c, False)
    walk(node, True)
    return out

def callee(m, n):
    src = m['src']
    if n.type == 'await_expression': return ('await', None, text(src, n)[:100])
    f = n.child_by_field_name('function') if n.type == 'call_expression' else n.child_by_field_name('constructor')
    if f is None: return ('?', None, text(src, n)[:100])
    if f.type == 'identifier': return ('id', text(src, f), None)
    if f.type == 'member_expression':
        obj = f.child_by_field_name('object'); prop = f.child_by_field_name('property')
        return ('member', (text(src, obj), text(src, prop)), None)
    return ('expr', None, text(src, f)[:100])

def resolve_fn(path, name, depth=0):
    """(module path, function node) of `name` as seen from module `path`, following imports and re-exports."""
    m = parse(path)
    if m is None or depth > 8: return None
    if name in m['fns']: return (path, m['fns'][name])
    if name in m['imports']:
        dep, nm = m['imports'][name]
        return resolve_export(dep, nm, depth + 1) if dep and nm not in ('*',) else None
    return None
def resolve_export(path, name, depth=0):
    m = parse(path) if path else None
    if m is None or depth > 8: return None
    e = m['exports'].get(name)
    if e and e[0] == 'local': return resolve_fn(path, e[1], depth + 1)
    if e and e[0] == 'reexport': return resolve_export(e[1], e[2], depth + 1)
    for dep in (m['exports'].get('*') or []):
        r = resolve_export(dep, name, depth + 1)
        if r: return r
    return None

def key_hit(kind, val, mod=None):
    if kind == 'id': return val in KEY_NAMES or val in WORKERS
    if kind == 'member': return val[1] in KEY_NAMES or val[1] in WORKERS
    return False

def trace(path, node, chain, seen, hits, depth):
    """Every call in a function body (conservative), followed into functions of this module and imported ones."""
    m = parse(path)
    for n in calls_in(m, node, skip_fn_bodies=False):
        kind, val, raw = callee(m, n)
        label = val if kind == 'id' else ('.'.join(val) if kind == 'member' else raw)
        if key_hit(kind, val): hits.append({'chain': chain + [f'{path}:{n.start_point[0]+1} {label}'], 'snippet': text(m['src'], n)[:120]})
        if depth >= 12: continue
        target = None
        if kind == 'id': target = resolve_fn(path, val)
        elif kind == 'member':
            obj, prop = val
            imp = m['imports'].get(obj)
            if imp and imp[1] == '*' and imp[0]: target = resolve_export(imp[0], prop)
        if target and (target[0], target[1].start_byte) not in seen:
            seen.add((target[0], target[1].start_byte))
            trace(target[0], target[1], chain + [f'{path}:{n.start_point[0]+1} {label} -> {target[0]}'], seen, hits, depth + 1)

start = f'{WEB}/frontier/app.mjs'
order, stack = [], [start]
while stack:
    pth = stack.pop()
    if pth in [o for o in order]: continue
    m = parse(pth)
    order.append(pth)
    if m: stack.extend(d for d in m['deps'] if d not in order)

report = {'rev': REV, 'entry': 'frontier/index.html: <script type="module" src="app.mjs"> (its only script)', 'modules': len(order),
          'unreadable': [p for p in order if mods.get(p) is None], 'parse_errors': [p for p in order if mods.get(p) and mods[p]['error']],
          'dynamic_imports': {p: mods[p]['dyn'] for p in order if mods.get(p) and mods[p]['dyn']}, 'load_time': {}, 'key_hits_at_load': []}
for pth in sorted(order):
    m = mods.get(pth)
    if not m: continue
    rows = []
    for st in m['root'].children:
        t = st.type
        if t in ('import_statement', 'comment', 'function_declaration', 'generator_function_declaration', 'empty_statement', 'hash_bang_line'): continue
        node = st
        if t == 'export_statement':
            decl = st.child_by_field_name('declaration'); val = st.child_by_field_name('value')
            if decl is not None and decl.type in ('function_declaration', 'generator_function_declaration'): continue
            if decl is None and val is None: continue   # export { … } / export … from
            node = decl or val
        if node.type in ('lexical_declaration', 'variable_declaration'):
            cs = calls_in(m, node, skip_fn_bodies=True)
            if not cs: continue
        elif node.type == 'class_declaration':
            cs = calls_in(m, node, skip_fn_bodies=True)
            if not cs: continue
        else:
            cs = calls_in(m, node, skip_fn_bodies=True)
        calls = []
        for n in cs:
            kind, val, raw = callee(m, n)
            label = val if kind == 'id' else ('.'.join(val) if kind == 'member' else raw)
            calls.append(label)
            hits = []
            if key_hit(kind, val): hits.append({'chain': [f'{pth}:{n.start_point[0]+1} {label}'], 'snippet': text(m['src'], n)[:120]})
            target = None
            if kind == 'id': target = resolve_fn(pth, val)
            elif kind == 'member':
                imp = m['imports'].get(val[0])
                if imp and imp[1] == '*' and imp[0]: target = resolve_export(imp[0], val[1])
            if target: trace(target[0], target[1], [f'{pth}:{n.start_point[0]+1} {label} -> {target[0]}'], {(target[0], target[1].start_byte)}, hits, 1)
            report['key_hits_at_load'].extend(hits)
        rows.append({'line': st.start_point[0] + 1, 'kind': node.type, 'text': text(m['src'], st).split('\n')[0][:140], 'calls_at_load': calls})
    if rows: report['load_time'][pth.replace(WEB + '/', '')] = rows
print(json.dumps(report, indent=1, ensure_ascii=False))
