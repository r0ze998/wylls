// The launcher world's standing notice (flocalplay-session.mjs): a display only. Stand-in document and window; nothing
// is generated, imported, started or sent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { mountSessionNotice, SESSION_NOTICE_ID } from '../../permutation-server/web/frontier/flocalplay-session.mjs';
import { setLang, lang } from '../../permutation-server/web/lang.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
function stubDocument() {
  const all = [];
  const make = tag => {
    const el = { tag, className: '', textContent: '', id: '', hidden: false, dataset: {}, attrs: {}, children: [], parent: null,
      setAttribute(k, v) { el.attrs[k] = v; }, append(...xs) { for (const x of xs) { x.parent = el; el.children.push(x); } } };
    all.push(el); return el;
  };
  const body = make('body');
  return { body, createElement: make, all, byClass: c => all.filter(e => e.className.split(' ').includes(c)), inBody: e => { for (let x = e; x; x = x.parent) if (x === body) return true; return false; } };
}
const points = doc => doc.byClass('local-play-session-point').map(e => e.textContent);

test('mounted once per document, in the page\'s language, with no time made up', () => {
  const before = lang();
  try {
    setLang('ja');
    const doc = stubDocument(), win = new EventTarget();
    const a = mountSessionNotice({ doc, win }), b = mountSessionNotice({ doc, win });
    assert.equal(a, b, 'a second mount returns the first');
    const boxes = doc.all.filter(e => e.id === SESSION_NOTICE_ID); assert.equal(boxes.length, 1); assert.ok(doc.inBody(boxes[0]));
    assert.equal(boxes[0].attrs.role, 'status');
    const said = points(doc).join('\n');
    for (const part of [/鍵はこのページのメモリにだけ/, /このページでは確認できません/, /既定は開始から2時間/, /進行は保存されません/]) assert.match(said, part);
    assert.doesNotMatch(said, /[0-9]{1,2}:[0-9]{2}|残り/, 'no end time, no time left');
    setLang('en');
    assert.match(points(doc).join('\n'), /cannot confirm when the world ends/); assert.match(doc.byClass('local-play-session-title')[0].textContent, /About this test world/);
    a.unmount();
  } finally { setLang(before); }
});

test('destroyed: the points give way to one line, again after the page comes back from the cache; nothing else changes', () => {
  const doc = stubDocument(), win = new EventTarget();
  const n = mountSessionNotice({ doc, win });
  assert.equal(n.isDestroyed(), false); assert.equal(doc.byClass('local-play-session-gone')[0].hidden, true);
  n.destroyed();
  assert.equal(n.isDestroyed(), true); assert.equal(doc.byClass('local-play-session-points')[0].hidden, true); assert.equal(doc.byClass('local-play-session-gone')[0].hidden, false);
  doc.byClass('local-play-session-gone')[0].hidden = true;          // (as if the restored page lost the state)
  win.dispatchEvent(new Event('pageshow'));
  assert.equal(doc.byClass('local-play-session-gone')[0].hidden, false, 'shown again on pageshow');
  n.unmount();
});

test('unmount removes the element and both listeners: later language switches and pageshow change nothing; a new mount is fresh', () => {
  const before = lang();
  try {
    setLang('ja');
    const doc = stubDocument(), win = new EventTarget();
    const n = mountSessionNotice({ doc, win });
    const title = doc.byClass('local-play-session-title')[0];
    n.unmount(); n.unmount();
    assert.ok(!doc.inBody(title), 'detached');
    setLang('en'); assert.equal(title.textContent, 'この試験世界について', 'the language listener is gone');
    n.destroyed(); win.dispatchEvent(new Event('pageshow'));
    assert.equal(doc.byClass('local-play-session-gone')[0].hidden, true, 'a destroyed() after unmount and a pageshow do nothing');
    const again = mountSessionNotice({ doc, win });
    assert.notEqual(again, n, 'after unmount a new mount is a new notice');
    assert.equal(doc.all.filter(e => e.id === SESSION_NOTICE_ID && doc.inBody(e)).length, 1);
    again.unmount();
  } finally { setLang(before); }
});

test('the notice\'s CSS never gets in the way of the game: hidden parts stay hidden, no pointer events, under every control layer, at the top', () => {
  const css = readFileSync(path.join(here, '../../permutation-server/web/frontier/flocalplay.css'), 'utf8');
  const game = readFileSync(path.join(here, '../../permutation-server/web/frontier/frontier.css'), 'utf8');
  const rule = sel => { const i = css.indexOf(`${sel} {`); assert.ok(i >= 0, `rule ${sel}`); return css.slice(i, css.indexOf('}', i)); };
  // a [hidden] part (the points after the key is gone, the "gone" line before) is hidden even though .points sets display:grid
  assert.match(css, /#local-play-session \[hidden\] \{ display: none !important; \}/);
  assert.match(rule('#local-play-session .local-play-session-points'), /display: grid/, '(the grid that the [hidden] rule overrides)');
  const box = rule('#local-play-session');
  assert.match(box, /pointer-events: none/, 'never takes a click or a tap');
  assert.match(box, /position: fixed; top:/); assert.doesNotMatch(box, /bottom:/, 'not on the bottom bar');
  const z = Number(box.match(/z-index: (\d+)/)[1]);
  const layer = sel => Number(game.match(new RegExp(`(?:^|\\n)\\s*${sel.replace('.', '\\.')}[^{]*\\{[^}]*?z-index: (\\d+)`))[1]);
  for (const sel of ['.tabs', '.hand', '.panel', '.feed']) assert.ok(z < layer(sel), `under ${sel} (${layer(sel)})`);
  assert.ok(z < 18, 'under the small-screen feed (18) and sheet panel (22) too');
  // small screens: narrower and smaller, still at the top and still without pointer events
  assert.match(css, /@media \(max-width: 720px\) \{ #local-play-session \{ top:[^}]*max-width: calc\(100vw - 16px\)/);
});

test('no document: nothing mounted; the module has no timer, request, storage or key', () => {
  assert.equal(mountSessionNotice({ doc: null, win: null }), null);
  const src = readFileSync(path.join(here, '../../permutation-server/web/frontier/flocalplay-session.mjs'), 'utf8');
  for (const word of ['setInterval', 'setTimeout', 'fetch(', 'XMLHttpRequest', 'localStorage', 'sessionStorage', 'indexedDB', 'createEphemeralWallet', '/local-play/', 'sign']) {
    assert.ok(!src.replace(/\/\/.*$/gm, '').includes(word), `no ${word}`);
  }
});
