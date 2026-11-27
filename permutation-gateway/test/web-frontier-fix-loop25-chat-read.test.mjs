// fix-loop25 (owner Q-LP25-1 (a), loop-play25 BREAK-1): the unread badge of the nation chat goes on counting after a side
// drawer's opening closed the chat. Kept apart from web-frontier-fix-loop25.test.mjs because reading the chat takes one
// wallet signature: the test's stand-in wallet answers signMessage with 64 zero bytes (no key is made, derived or used),
// and the key-free scan (scripts/ci/scan-node-key-tests.mjs) lists any file that names signMessage — so this file runs
// in the key-tests job and locally, the rest of fix-loop25 in the key-free jobs.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setLang } from '../../permutation-server/web/lang.mjs';
import * as chat from '../../permutation-server/web/frontier/hud/nationchat.mjs';

afterEach(() => setLang('ja'));

function fakeDoc() {
  const doc = { activeElement: null, defaultView: null };
  const mk = tag => {
    const e = { tagName: tag.toUpperCase(), attrs: new Map(), children: [], parentNode: null, dataset: {}, listeners: {}, scrollTop: 0, scrollHeight: 0, clientHeight: 0, textContent: '', innerHTML: '', value: '', disabled: false,
      get hidden() { return this.attrs.has('hidden'); }, set hidden(v) { if (v) this.attrs.set('hidden', ''); else this.attrs.delete('hidden'); },
      setAttribute(k, v) { this.attrs.set(k, String(v)); }, getAttribute(k) { return this.attrs.get(k) ?? null; }, hasAttribute(k) { return this.attrs.has(k); },
      append(...c) { for (const x of c) { if (typeof x !== 'object') continue; x.parentNode = this; this.children.push(x); } },
      replaceChildren(...c) { this.children = []; this.append(...c); },
      insertBefore(x, ref) { if (x.parentNode) x.parentNode.children = x.parentNode.children.filter(y => y !== x); x.parentNode = this; const i = this.children.indexOf(ref); this.children.splice(i < 0 ? this.children.length : i, 0, x); },
      replaceWith(x) { const p = this.parentNode; if (!p) return; const i = p.children.indexOf(this); x.parentNode = p; p.children.splice(i, 1, x); },
      get nextSibling() { const p = this.parentNode; if (!p) return null; return p.children[p.children.indexOf(this) + 1] ?? null; },
      get firstChild() { return this.children[0] ?? null; },
      remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(y => y !== this); },
      contains(x) { for (let n = x; n; n = n.parentNode) if (n === this) return true; return false; },
      addEventListener(t, f) { (this.listeners[t] ??= []).push(f); },
      fire(t, ev = {}) { for (const f of this.listeners[t] ?? []) f({ preventDefault() {}, ...ev }); },
      focus() { doc.activeElement = this; }, blur() { if (doc.activeElement === this) doc.activeElement = doc.body; },
      querySelector() { return null; }, classList: { toggle() {}, add() {}, remove() {} },
    };
    return e;
  };
  doc.createElement = mk;
  doc.body = mk('body');
  doc.getElementById = () => null;
  doc.activeElement = doc.body;
  return doc;
}
const tick = () => new Promise(r => setTimeout(r, 0));
const findBy = (n, f) => { if (f(n)) return n; for (const c of n.children ?? []) { const x = findBy(c, f); if (x) return x; } return null; };

/** A mounted chat with a wallet stand-in that "signs" (zero bytes), a herald that answers, and a socket the test drives. */
async function mountChat({ onOpen = () => {}, focusDrawer = () => {} } = {}) {
  setLang('en');
  const doc = fakeDoc(), anchor = doc.createElement('div');
  doc.body.append(anchor);
  doc.defaultView = { innerWidth: 1280, addEventListener() {}, removeEventListener() {} };
  const fetch = async (url) => {
    const body = String(url).endsWith('/h/chat/read') ? { ok: true, messages: [] } : { ok: true, world: '7', program: 'P', turn: 5 };
    return { ok: true, status: 200, json: async () => body };
  };
  const sockets = [];
  function WS() { this.readyState = 1; this.send = () => {}; this.close = () => {}; sockets.push(this); }
  const wallet = { address: 'MeWallet1111', signMessage: async bytes => ({ signature: new Uint8Array(64), signedMessage: bytes }) };
  const ref = chat.installNationChat({ anchor, host: doc.body, doc, fetch, storage: { getItem: () => null, setItem() {} }, WebSocket: WS,
    timers: { setInterval: () => 1, clearInterval() {}, setTimeout: () => 1, clearTimeout() {} },
    state: () => ({ wallet, nation: 1, world: 7, program: 'P' }), onOpen, focusDrawer });
  await tick(); await tick();
  const toggle = anchor.parentNode.children.find(x => x.attrs.get('id') === 'nchat-toggle');
  const panel = doc.body.children.find(x => x.attrs.get('id') === 'nchat-panel');
  const badge = findBy(toggle, x => x.attrs?.get('class') === 'nchat-badge');
  const gate = findBy(panel, x => x.attrs?.get('class') === 'nchat-open');
  const text = findBy(panel, x => x.attrs?.get('id') === 'nchat-text');
  return { doc, ref, toggle, panel, badge, gate, text, sockets };
}
let msgId = 100;
const say = (sock, wallet = 'OtherWallet2') => sock.onmessage({ data: JSON.stringify({ op: 'msg', message: { id: String(++msgId), wallet, turn: 5, text: 'hello' } }) });

test('BREAK-1: a side drawer that opens closes the chat; the unread badge goes on counting; the keyboard goes to the drawer only when it was in the chat', async () => {
  let toDrawer = 0;
  const { doc, ref, toggle, panel, badge, gate, text, sockets } = await mountChat({ focusDrawer: () => toDrawer++ });
  toggle.fire('click');
  gate.fire('click');                       // sign once to read: the socket opens
  for (let i = 0; i < 6; i++) await tick();
  assert.equal(sockets.length, 1, 'reading, live');
  assert.equal(doc.activeElement, text, 'the composer has the keyboard');
  say(sockets[0]);
  assert.equal(badge.hidden, true, 'open: nothing unread');
  // the drawer opens (e.g. the village lands and its welcome opens) while the player types: the chat closes
  assert.equal(ref.yieldToDrawer(), true);
  assert.equal(panel.hidden, true);
  assert.equal(ref.isOpen, false);
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(doc.body.dataset.nchat, undefined);
  assert.equal(toDrawer, 1, 'the keyboard was in the chat: it goes to the drawer');
  assert.ok(!panel.contains(doc.activeElement), 'never left inside the hidden panel');
  // messages go on arriving: the badge counts them (the socket is kept)
  say(sockets[0]); say(sockets[0]);
  assert.equal(badge.hidden, false);
  assert.equal(badge.textContent, '2');
  assert.match(toggle.getAttribute('aria-label'), /2/);
  say(sockets[0], 'MeWallet1111');
  assert.equal(badge.textContent, '2', 'one\'s own words are not unread');
  // a closed chat: nothing to yield
  assert.equal(ref.yieldToDrawer(), false);
  // the player opens it again: the count is read
  toggle.fire('click');
  assert.equal(badge.hidden, true);
  // the drawer opened by a press outside the chat (a tab): the keyboard stays where the press left it
  const tab = doc.createElement('button'); doc.body.append(tab); tab.focus();
  ref.yieldToDrawer();
  assert.equal(doc.activeElement, tab);
  assert.equal(toDrawer, 1);
});

