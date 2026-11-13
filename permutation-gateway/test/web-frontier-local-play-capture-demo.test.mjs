// The page's side of the TEST-ONLY capture demo: the address word, the start answer's scale, and the session notice's
// fourth line (the synthetic clock and the test participants, said all session). No key is made here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { localCaptureDemoPage, launcherCaptureDemo } from '../../permutation-server/web/frontier/flocalplay.mjs';
import { mountSessionNotice } from '../../permutation-server/web/frontier/flocalplay-session.mjs';
import { setLang } from '../../permutation-server/web/lang.mjs';

function stubDocument() {
  const all = [], doc = {};
  const make = tag => {
    const listeners = {};
    const el = { tag, className: '', textContent: '', id: '', hidden: false, disabled: false, type: '', dataset: {}, attrs: {}, children: [], parent: null, listeners,
      setAttribute(k, v) { el.attrs[k] = v; }, append(...xs) { for (const x of xs) { x.parent = el; el.children.push(x); } }, addEventListener(k, f) { (listeners[k] ??= []).push(f); },
      click() { for (const f of listeners.click ?? []) f(); return true; } };
    all.push(el); return el;
  };
  const body = make('body');
  return Object.assign(doc, { body, createElement: make, byClass: c => all.filter(e => e.className.split(' ').includes(c)) });
}
const loc = q => ({ href: `http://localhost:41920/frontier/frontier/index.html?${q}`, hostname: 'localhost' });
const cfg = { mode: 'play', dev: true };

test('the address: demo=capture counts only on a launcher page', () => {
  assert.equal(localCaptureDemoPage(cfg, loc('localPlay=1&launcher=1&world=natural&march=trial&demo=capture')), true);
  assert.equal(localCaptureDemoPage(cfg, loc('localPlay=1&launcher=1&world=natural&march=trial')), false, 'without the word');
  assert.equal(localCaptureDemoPage(cfg, loc('localPlay=1&launcher=1&demo=other')), false, 'only the exact word');
  assert.equal(localCaptureDemoPage(cfg, loc('localPlay=1&demo=capture')), false, 'not a launcher page: never');
  assert.equal(localCaptureDemoPage(cfg, { href: 'not a url', hostname: 'localhost' }), false);
  assert.equal(localCaptureDemoPage(cfg, { href: 'http://example.com/x?localPlay=1&launcher=1&demo=capture', hostname: 'example.com' }), false, 'not a loopback page: never');
});

test('the start answer: exactly {scale} with a whole number 10..60, or nothing (a mismatch is refused by the gate)', () => {
  assert.equal(launcherCaptureDemo({ scale: 20 }), 20);
  for (const v of [undefined, null, {}, { scale: 9 }, { scale: 61 }, { scale: '20' }, { scale: 20.5 }, { scale: 20, extra: 1 }, [20], 20]) assert.equal(launcherCaptureDemo(v), null, JSON.stringify(v));
});

test('the session notice: a fourth line on a demo world only, naming the synthetic clock\'s scale and the test participants', () => {
  setLang('ja');
  const plain = stubDocument();
  mountSessionNotice({ doc: plain, win: {} });
  assert.equal(plain.byClass('local-play-session-point').length, 3, 'a natural world: three lines, as before');
  assert.equal(plain.byClass('local-play-session-demo').length, 0);
  const d = stubDocument();
  mountSessionNotice({ doc: d, win: {}, demo: 20 });
  const lines = d.byClass('local-play-session-point');
  assert.equal(lines.length, 4);
  assert.match(lines[3].textContent, /試験用の攻略デモ/);
  assert.match(lines[3].textContent, /20 倍の合成時計/);
  assert.match(lines[3].textContent, /試験参加者/);
  for (const bad of [9, 61, '20', null]) { const x = stubDocument(); mountSessionNotice({ doc: x, win: {}, demo: bad }); assert.equal(x.byClass('local-play-session-point').length, 3, String(bad)); }
  setLang('en');
  const e = stubDocument();
  mountSessionNotice({ doc: e, win: {}, demo: 30 });
  assert.match(e.byClass('local-play-session-demo')[0].textContent, /test capture demo: its clock is a synthetic one running 30 times faster/);
  setLang('ja');
});
