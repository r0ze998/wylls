// fix-loop27 (loop-play27 N-1..N-3), text only, EN + JA (no rule changed):
//  N-1  the land horizon card said "you can support 1 more tiles" — singular for 1 (JA unchanged: 「あと 1 マス」).
//  N-2  the nation chat's status line ("Sent", a refusal, "Waiting for the wallet…") kept the language it was written in
//       after switching languages; it now keeps how to word it and is redrawn with the rest of the panel.
//  N-3  at 41 tiles the card said "next tile: 18 ore" and below it "You have less than 10 ore …": below 10 ore with a
//       dearer next tile, the one reason line now names the next tile's price.
// Key-free: the chat's stand-in wallet has an address only (no signer), so opening the chat stops at NoWallet.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setLang, L } from '../../permutation-server/web/lang.mjs';
import * as chat from '../../permutation-server/web/frontier/hud/nationchat.mjs';
import { horizonStatusLines } from '../../permutation-server/web/frontier/landhorizon.mjs';

afterEach(() => setLang('ja'));
const web = f => readFileSync(new URL(`../../permutation-server/web/${f}`, import.meta.url), 'utf8');

test('N-1: "1 more tile" (singular), "2 more tiles"; JA as before', () => {
  setLang('en');
  const room = n => L`いまの土地は、この食料の生産で維持できます。いまの距離なら、あと ${n} マスまで維持できます（最大 ${40} マス）。`;
  assert.equal(room(1), 'Your current land can be supported indefinitely by this food production. At the current distance you can support 1 more tile (up to 40 tiles).');
  assert.match(room(2), /support 2 more tiles \(up to 40 tiles\)\.$/);
  assert.match(room('1,000'), /support 1,000 more tiles/);
  assert.doesNotMatch(room(1), /\b1 more tiles\b/);
  for (const n of [2, 36]) assert.doesNotMatch(room(n), /\b\d+ more tile \(/);
  setLang('ja');
  assert.equal(room(1), 'いまの土地は、この食料の生産で維持できます。いまの距離なら、あと 1 マスまで維持できます（最大 40 マス）。');
  // the card's own line goes through that entry
  assert.ok(web('frontier/landhorizon.mjs').includes('L`いまの土地は、この食料の生産で維持できます。いまの距離なら、あと ${fmtNum(room)} マスまで維持できます（最大 ${fmtNum(max)} マス）。`'));
  assert.equal(typeof horizonStatusLines, 'function');
});

test('N-3: one reason line under "Claim a tile", the price that applies', () => {
  const src = web('frontier/screens/holding.mjs');
  assert.ok(src.includes('tileShort: ore < TERRITORY_V1.cost.base && tilePrice <= TERRITORY_V1.cost.base'), 'the 10 sentence only when the next tile costs 10');
  assert.ok(src.includes('tilePriceShort: ore < tilePrice && tilePrice > TERRITORY_V1.cost.base'), 'the price sentence whenever the next tile costs more');
  setLang('en');
  assert.equal(L`鉱石が次の1マスの値段（${18}）に足りないので、いまは「1マス取る」を押せません。`, 'You have less ore than the next tile costs (18), so "Claim a tile" cannot be pressed for now.');
});

function fakeDoc() {
  const doc = { activeElement: null, defaultView: null };
  const mk = tag => {
    const e = { tagName: tag.toUpperCase(), attrs: new Map(), children: [], parentNode: null, dataset: {}, listeners: {}, scrollTop: 0, scrollHeight: 0, clientHeight: 0, textContent: '', innerHTML: '', value: '', disabled: false,
      get hidden() { return this.attrs.has('hidden'); }, set hidden(v) { if (v) this.attrs.set('hidden', ''); else this.attrs.delete('hidden'); },
      setAttribute(k, v) { this.attrs.set(k, String(v)); }, getAttribute(k) { return this.attrs.get(k) ?? null; }, hasAttribute(k) { return this.attrs.has(k); },
      append(...c) { for (const x of c) { if (typeof x !== 'object') continue; x.parentNode = this; this.children.push(x); } },
      replaceChildren(...c) { this.children = []; this.append(...c); },
      insertBefore(x, ref) { x.parentNode = this; const i = this.children.indexOf(ref); this.children.splice(i < 0 ? this.children.length : i, 0, x); },
      remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(y => y !== this); },
      contains(x) { for (let n = x; n; n = n.parentNode) if (n === this) return true; return false; },
      addEventListener(t, f) { (this.listeners[t] ??= []).push(f); },
      fire(t, ev = {}) { for (const f of this.listeners[t] ?? []) f({ preventDefault() {}, ...ev }); },
      focus() { doc.activeElement = this; }, blur() {},
      querySelector() { return null; }, classList: { toggle() {}, add() {}, remove() {} },
    };
    return e;
  };
  doc.createElement = mk; doc.body = mk('body'); doc.getElementById = () => null; doc.activeElement = doc.body;
  return doc;
}
const tick = () => new Promise(r => setTimeout(r, 0));
const findBy = (n, f) => { if (f(n)) return n; for (const c of n.children ?? []) { const x = findBy(c, f); if (x) return x; } return null; };

test('N-2: the chat status line follows a language change', async () => {
  setLang('en');
  const doc = fakeDoc(), anchor = doc.createElement('div');
  doc.body.append(anchor);
  doc.defaultView = { innerWidth: 1280, addEventListener() {}, removeEventListener() {} };
  const fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, world: '7', program: 'P', turn: 5 }) });
  const ref = chat.installNationChat({ anchor, host: doc.body, doc, fetch, storage: { getItem: () => null, setItem() {} }, WebSocket: function () {},
    timers: { setInterval: () => 1, clearInterval() {}, setTimeout: () => 1, clearTimeout() {} },
    state: () => ({ wallet: { address: 'MeWallet1111' }, nation: 1, world: 7, program: 'P' }) });
  await tick(); await tick();
  const toggle = anchor.parentNode.children.find(x => x.attrs.get('id') === 'nchat-toggle');
  const panel = doc.body.children.find(x => x.attrs.get('id') === 'nchat-panel');
  const gate = findBy(panel, x => x.attrs?.get('class') === 'nchat-open');
  const status = findBy(panel, x => x.attrs?.get('class') === 'nchat-status');
  assert.ok(toggle && gate && status, 'mounted');
  toggle.fire('click'); gate.fire('click');
  for (let i = 0; i < 4; i++) await tick();
  const en = status.textContent;
  assert.equal(en, chat.codeText('NoWallet'), 'EN first');
  assert.match(en, /^[\x20-\x7e]+$/, 'English words');
  setLang('ja');
  const ja = status.textContent;
  assert.notEqual(ja, en, 'redrawn in Japanese');
  assert.equal(ja, chat.codeText('NoWallet'), 'JA after the switch');
  setLang('en');
  assert.equal(status.textContent, en, 'and back');
  ref.stop();
  // every status the panel writes is a wording (a function), so every one follows the language; '' clears
  const src = web('frontier/hud/nationchat.mjs');
  const calls = src.match(/\bsay\((?!t\b).{0,9}/g) ?? [];
  assert.ok(calls.length >= 10, String(calls.length));
  for (const c of calls) assert.ok(c.startsWith('say(() =>') || c.startsWith("say('')"), c);
  assert.ok(src.includes('say(() => L`送りました`)'), 'the "Sent" of LP27');
  assert.ok(src.includes('if (said) status.textContent = said();'), 'labels() redraws it');
});
