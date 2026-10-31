#!/usr/bin/env python3
"""
Artifact（claude.ai 上の公開ページ）向けに、ソースを変換して出力する。
  python3 scripts/build-artifact.py <出力ディレクトリ>

変換内容（Artifact のページ規約への対応。ソース自体は変更しない）:
  - index.html: <html><head><body> を外し、CSS/JS/SVG を埋め込んだ断片にする
  - contact.html: 完全な HTML のまま、CSS/JS を埋め込む
  - 印刷ボタンを除去（ビューア内では window.print() が動かないため）
  - 初期表示で隠れる .reveal を常時表示にする
"""
import base64, re, sys, pathlib

root = pathlib.Path(__file__).resolve().parent.parent
out = pathlib.Path(sys.argv[1]); out.mkdir(parents=True, exist_ok=True)
rd = lambda p: (root / p).read_text(encoding="utf-8")

css = rd("assets/css/style.css")
js_cfg, js_main, js_contact = rd("assets/js/site-config.js"), rd("assets/js/main.js"), rd("assets/js/contact.js")
svg_b64 = base64.b64encode((root / "assets/img/hero-cassette.svg").read_bytes()).decode()

publish_css = """
/* --- Artifact 用の上書き --- */
.reveal { opacity: 1 !important; transform: none !important; }
.site-header { top: env(safe-area-inset-top, 0px); }
body::before { content: ""; position: fixed; inset: 0 0 auto; height: env(safe-area-inset-top, 0px); z-index: 101; background: var(--ink); }
"""

def sub_once(s, old, new):
    assert old in s, old[:50]
    return s.replace(old, new, 1)

def strip_print(s):
    s = re.sub(r'\s*<button class="btn btn--ghost btn--small" type="button" id="print-checklist">.*?</button>', '', s, flags=re.S)
    s = sub_once(s, "お見積もりは、内訳と作業範囲が分かる形でお出しするよう努めます。このページは印刷して社内共有にもお使いいただけます。", "お見積もりは、内訳と作業範囲が分かる形でお出しするよう努めます。チェックリストはコピーして社内共有にもお使いいただけます。")
    return s

def inline_assets(s, with_contact):
    s = sub_once(s, '<link rel="stylesheet" href="assets/css/style.css">', "<style>\n" + css + publish_css + "</style>")
    scripts = f"<script>{js_cfg}</script>\n<script>{js_main}</script>\n" + (f"<script>{js_contact}</script>\n" if with_contact else "")
    s = re.sub(r'<script src="assets/js/site-config.js"></script>\s*<script src="assets/js/main.js"></script>\s*(<script src="assets/js/contact.js"></script>)?', lambda m: scripts, s)
    assert 'src="assets/js' not in s
    s = re.sub(r'\s*<link rel="icon"[^>]*>', '', s)
    s = s.replace('src="assets/img/hero-cassette.svg"', f'src="data:image/svg+xml;base64,{svg_b64}"')
    return s

# --- index（断片）---
idx = strip_print(inline_assets(rd("index.html"), with_contact=False))
head = re.search(r"<head>(.*?)</head>", idx, re.S).group(1)
body = re.search(r"<body[^>]*>(.*)</body>", idx, re.S).group(1)
head = re.sub(r"<meta charset[^>]*>|<meta name=\"viewport\"[^>]*>|<link rel=\"preconnect\"[^>]*>|<meta name=\"theme-color\"[^>]*>", "", head)
head = re.sub(r"<title>.*?</title>", "<title>真 −SHIN− エアコンクリーニング</title>", head, flags=re.S)
body_class = "document.body.classList.add('has-sp-cta');"
body = sub_once(body, "<script>" + js_cfg, "<script>" + body_class + "\n" + js_cfg)
(out / "index.html").write_text(head.strip() + "\n" + body.strip() + "\n", encoding="utf-8")

# --- contact（完全な HTML）---
ct = inline_assets(rd("contact.html"), with_contact=True)
ct = sub_once(ct, "<title>見積もり・ご相談｜真 −SHIN−（法人向けエアコンクリーニング）</title>", "<title>見積もり・ご相談｜真 −SHIN−</title>")
(out / "contact.html").write_text(ct, encoding="utf-8")
for f in ("index.html", "contact.html"):
    print(f, (out / f).stat().st_size, "bytes")
