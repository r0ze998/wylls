"""Check a GitBook folder: SUMMARY links, relative links, images, anchors, tags."""
import os, re, sys, unicodedata
from urllib.parse import unquote

root = sys.argv[1]
errors, warns = [], []
md_files = []
for d, _, fs in os.walk(root):
    for f in fs:
        if f.endswith('.md'):
            md_files.append(os.path.relpath(os.path.join(d, f), root))

def slug(h):
    # GitBook-like slug: lowercase, strip punctuation except - and unicode letters, spaces -> -
    h = h.strip().lower()
    h = re.sub(r'[`*_]', '', h)
    out = []
    for ch in h:
        cat = unicodedata.category(ch)
        if ch in ' -':
            out.append('-')
        elif cat[0] in 'LN':
            out.append(ch)
    return re.sub('-+', '-', ''.join(out)).strip('-')

headings = {}
for f in md_files:
    text = open(os.path.join(root, f), encoding='utf-8').read()
    hs = set()
    for m in re.finditer(r'^#{1,6}\s+(.*)$', text, re.M):
        hs.add(slug(m.group(1)))
    headings[f] = hs

link_re = re.compile(r'(!?)\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)')
in_code = re.compile(r'```.*?```', re.S)
for f in md_files:
    text = open(os.path.join(root, f), encoding='utf-8').read()
    text_nc = in_code.sub('', text)
    for m in link_re.finditer(text_nc):
        target = m.group(3)
        if re.match(r'^[a-z]+://', target) or target.startswith('mailto:'):
            continue
        path, _, anchor = target.partition('#')
        base = os.path.dirname(f)
        tgt = os.path.normpath(os.path.join(base, unquote(path))) if path else f
        if not os.path.exists(os.path.join(root, tgt)):
            errors.append(f'{f}: missing target {target}')
            continue
        if anchor:
            warns.append(f'{f}: anchor link (avoid; GitBook slugs for Japanese headings vary) {target}')

summary = open(os.path.join(root, 'SUMMARY.md'), encoding='utf-8').read()
listed = [m.group(3).partition('#')[0] for m in link_re.finditer(summary)]
for f in md_files:
    if f == 'SUMMARY.md':
        continue
    c = listed.count(f)
    if c != 1:
        errors.append(f'SUMMARY: {f} listed {c} times')

allowed = {'検証する候補','決定済み', '提案', '未決定', 'main で確認', '別ブランチ', '照合待ち', '仮', '実装あり'}
for f in md_files:
    text = open(os.path.join(root, f), encoding='utf-8').read()
    for m in re.finditer(r'【([^】]+)】', text):
        tag = m.group(1)
        head = re.split(r'[：:]', tag)[0].strip()
        if head not in allowed:
            warns.append(f'{f}: tag {tag}')

print(f'files: {len(md_files)}')
print('ERRORS:', len(errors)); [print('  ', e) for e in errors]
print('WARNINGS:', len(warns)); [print('  ', w) for w in warns]
sys.exit(1 if errors else 0)
