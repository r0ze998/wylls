// fix-loop25 (owner r0ze 2026-11-27 09:00, inbox 2026-11-27-0900-r0ze-0900-answers.md items 1 and 5; loop-play25), page only:
//   Q-LP25-1 (a) / BREAK-1  one right-side panel at a time: opening the chat closes the side drawer, a side drawer that
//                           opens closes the chat (the unread badge goes on counting); the keyboard goes somewhere sensible;
//   Q-PM2-1 (a)             the march-first guide may name the camp of the player's OWN village's province even under the
//                           fog — only that province, only the camp's position and that it fights; the rest stays fogged;
//   BREAK-2                 the first host's banner says "the camp first", as the guide does at the same moment (EN + JA).
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setLang } from '../../permutation-server/web/lang.mjs';
import * as chat from '../../permutation-server/web/frontier/hud/nationchat.mjs';
import { drawerOf, closeDrawer, WIDE, STAGE } from '../../permutation-server/web/frontier/hud/drawer.mjs';
import * as FB from '../../permutation-server/web/frontier/hud/firstbattle.mjs';
import * as F from '../../permutation-server/web/frontier/map/fog.mjs';
import * as S from '../../permutation-server/web/frontier/map/survey.mjs';
import { tileHex } from '../../permutation-server/web/frontier/fgeo.mjs';
import { hostId } from '../../permutation-server/web/frontier/faddr.mjs';
import { baseProduction } from '../../permutation-server/web/frontier/fland.mjs';
import { conquestObjective, conquestGuide } from '../../permutation-server/web/frontier/screens/conquestguide.mjs';
import { guideTarget } from '../../permutation-server/web/frontier/hud/guide.mjs';
import { firstHostNext, firstHostNextLine } from '../../permutation-server/web/frontier/hud/firststeps.mjs';
import { reachedMilestones } from '../../permutation-server/web/frontier/hud/milestones.mjs';

afterEach(() => { setLang('ja'); F.resetFogNow(); });
const CJK = /[぀-ヿ㐀-鿿]/;
const WEB = new URL('../../permutation-server/web/frontier/', import.meta.url);
const src = f => readFileSync(new URL(f, WEB), 'utf8');
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const oneOf = (r, xs) => xs[Math.floor(r() * xs.length)];

// ================================================================== Q-LP25-1 (a): one right-side panel at a time
test('sideDrawerKey: no key for no drawer, a wide document or the nation stage; a redraw keeps the key; a new kind, selection or order is a new key', () => {
  const tok = chat.objectTokens();
  const k = (d, x = {}) => chat.sideDrawerKey(d, { wide: WIDE, stage: STAGE, token: tok, ...x });
  assert.equal(k(null), null);
  for (const kind of WIDE) assert.equal(k({ kind }), null, `${kind} is a wide document (the fix-loop24 rule)`);
  for (const kind of STAGE) assert.equal(k({ kind }), null, `${kind} stands at the foot of the map`);
  for (const kind of ['hosts', 'holding', 'territory', 'marches', 'more', 'guide', 'join', 'wait', 'home', 'inspect', 'march', 'spectate']) assert.notEqual(k({ kind }), null, kind);
  const sel = { p: 1 }, sel2 = { p: 1 }, ord = { host: 'h' }, ord2 = { host: 'h' };
  assert.equal(k({ kind: 'inspect' }, { selected: sel }), k({ kind: 'inspect' }, { selected: sel }), 'the same selection: the same key');
  assert.notEqual(k({ kind: 'inspect' }, { selected: sel }), k({ kind: 'inspect' }, { selected: sel2 }), 'a new choice (a new object, even of equal content)');
  assert.notEqual(k({ kind: 'march' }, { compose: ord }), k({ kind: 'march' }, { compose: ord2 }), 'another order');
  assert.equal(k({ kind: 'hosts' }, { selected: sel }), k({ kind: 'hosts' }, { selected: sel2 }), 'a tab ignores the map\'s selection');
  // the order's destination: a place chosen for an order set aside under the chat is an opening (the card comes back)
  const o3 = { host: 'h' };
  const before = k({ kind: 'march' }, { compose: o3 });
  o3.dest = { p: 1, q: 2, tile: 3 };
  assert.notEqual(k({ kind: 'march' }, { compose: o3 }), before);
  assert.equal(k({ kind: 'march' }, { compose: o3 }), k({ kind: 'march' }, { compose: o3 }), 'a redraw of the same order and place');
  assert.deepEqual(chat.drawerOpened(null, 'hosts'), { opened: true, key: 'hosts' });
  assert.deepEqual(chat.drawerOpened('hosts', 'hosts'), { opened: false, key: 'hosts' }, 'a redraw is no opening');
  assert.deepEqual(chat.drawerOpened('hosts', null), { opened: false, key: null }, 'a closing is no opening');
  assert.deepEqual(chat.drawerOpened('hosts', 'territory'), { opened: true, key: 'territory' });
});

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

/** A mounted chat with a herald that answers (key-free: the wallet stand-in cannot sign). */
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
  const wallet = { address: 'MeWallet1111' };   // (no signing here: the read/unread path is in web-frontier-fix-loop25-chat-read.test.mjs)
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

test('BREAK-1: the player opening the chat asks the page to close its side drawer (once, on opening only), and the keyboard goes into the chat', async () => {
  let opens = 0;
  const { doc, toggle, panel } = await mountChat({ onOpen: () => opens++ });
  toggle.focus(); toggle.fire('click');
  assert.equal(panel.hidden, false);
  assert.equal(opens, 1, 'opening: the page closes its drawer');
  assert.ok(panel.contains(doc.activeElement), 'the keyboard is in the chat');
  toggle.fire('click');
  assert.equal(panel.hidden, true);
  assert.equal(opens, 1, 'closing asks nothing of the page');
  assert.equal(doc.activeElement, toggle);
  // deliberate break: a chat without the hook (fix-loop24) leaves the drawer standing — what loop-play25 saw
  const before = src('hud/nationchat.mjs');
  assert.ok(before.includes("    if (!open) { try { onOpen(); } catch (e) { console.error('frontier nation chat:', e); } }\n    show(!open);"));
});

test('BREAK-1: a side drawer that opens closes the chat; the keyboard goes to the drawer only when it was in the chat (the unread badge: web-frontier-fix-loop25-chat-read.test.mjs)', async () => {
  let toDrawer = 0;
  const { doc, ref, toggle, panel } = await mountChat({ focusDrawer: () => toDrawer++ });
  toggle.fire('click');
  assert.ok(panel.contains(doc.activeElement), 'the keyboard is in the chat');
  assert.equal(ref.yieldToDrawer(), true);
  assert.equal(panel.hidden, true);
  assert.equal(ref.isOpen, false);
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(doc.body.dataset.nchat, undefined);
  assert.equal(toDrawer, 1, 'the keyboard was in the chat: it goes to the drawer');
  assert.ok(!panel.contains(doc.activeElement), 'never left inside the hidden panel');
  assert.equal(ref.yieldToDrawer(), false, 'a closed chat: nothing to yield');
  toggle.fire('click');
  const tab = doc.createElement('button'); doc.body.append(tab); tab.focus();
  ref.yieldToDrawer();
  assert.equal(doc.activeElement, tab, 'a press outside the chat keeps the keyboard where it is');
  assert.equal(toDrawer, 1);
});

test('BREAK-1: a chat set aside (the title, a narrow report) that a drawer\'s opening closed does not come back by itself', async () => {
  const { doc, ref, toggle, panel } = await mountChat();
  toggle.fire('click');
  doc.body.dataset.title = 'up'; ref.place();
  assert.equal(panel.hidden, true, 'set aside under the title');
  ref.yieldToDrawer();
  delete doc.body.dataset.title; ref.place();
  assert.equal(panel.hidden, true, 'closed for good: the drawer that opened stands alone');
  // without the drawer the set-aside chat comes back, as before (fix-loop24)
  toggle.fire('click');
  doc.body.dataset.title = 'up'; ref.place();
  delete doc.body.dataset.title; ref.place();
  assert.equal(panel.hidden, false);
});

/**
 * The page's rule as app.mjs applies it (nationChatSide / nationChatOpening), on the page's own drawerOf and closeDrawer:
 * 400 random sessions of presses and redraws. The invariant: never the chat and a drawable side drawer at once. The one
 * drawer the chat's opening keeps — an order being written — is set aside (drawn only while the chat is closed).
 */
function harness(chatRef, { broken = false } = {}) {
  const tok = chat.objectTokens();
  const FS = { mode: 'play', tab: 'map', selected: null, compose: null, inspectOpen: false, guideOpen: false, holdings: [{ p: 0, q: 0, tile: 1 }], land: { stage: 'final' }, citizen: { faction: 1 } };
  let key = null;
  const keyOf = d => chat.sideDrawerKey(d, { selected: FS.selected, compose: FS.compose, wide: WIDE, stage: STAGE, token: tok });
  const render = () => { const d = drawerOf(FS); const x = chat.drawerOpened(key, keyOf(d)); key = x.key; if (x.opened && !broken) chatRef.yieldToDrawer(); chatRef.place(); return d; };
  const opening = () => { const d = drawerOf(FS); if (!broken && keyOf(d) !== null && d.kind !== 'march') closeDrawer(FS); key = keyOf(drawerOf(FS)); };
  return { FS, render, opening };
}

test('BREAK-1 property: 400 random sessions — the chat and a side drawer are never shown together; the order being written is never lost (deliberate break: without the rule they overlap)', async () => {
  const run = async (broken, seed) => {
    const r = rng(seed);
    let overlaps = 0, steps = 0, kept = 0, yields = 0;
    for (let s = 0; s < 400; s++) {
      let h = null;
      const m = await mountChat({ onOpen: () => h.opening() });
      h = harness(m.ref, { broken });
      h.render();
      for (let i = 0; i < 30; i++) {
        const a = oneOf(r, ['tab', 'tab', 'select', 'compose', 'chat', 'chat', 'chat', 'close', 'redraw', 'redraw', 'report', 'guide', 'composeDone']);
        const wasOpen = m.ref.isOpen;
        if (a === 'tab') h.FS.tab = oneOf(r, ['hosts', 'holding', 'territory', 'marches', 'more']);
        else if (a === 'select') { h.FS.tab = 'map'; h.FS.selected = { p: 1, q: 0, tile: 3 }; h.FS.inspectOpen = true; }
        else if (a === 'compose') { h.FS.tab = 'map'; h.FS.compose = { host: { id: String(i) } }; }
        else if (a === 'composeDone') h.FS.compose = null;
        else if (a === 'guide') { h.FS.tab = 'map'; h.FS.guideOpen = true; }
        else if (a === 'report') h.FS.report = h.FS.report ? null : { p: 1, q: 0 };
        else if (a === 'close') closeDrawer(h.FS);
        else if (a === 'chat') { const c = h.FS.compose; m.toggle.fire('click'); if (c) assert.equal(h.FS.compose, c, 'the chat\'s opening never throws an order away'); }
        const d = h.render();
        if (!wasOpen && m.ref.isOpen) kept += h.FS.compose ? 1 : 0;
        if (wasOpen && !m.ref.isOpen && a !== 'chat') yields++;
        steps++;
        const side = chat.sideDrawerKey(d, { wide: WIDE, stage: STAGE }) !== null;
        // drawn: a side drawer, unless it is the order set aside under the open chat (frontier.css)
        const drawn = side && !(m.ref.isOpen && d.kind === 'march' && !broken);
        if (m.ref.isOpen && drawn) overlaps++;
      }
    }
    return { overlaps, steps, kept, yields };
  };
  const ok = await run(false, 2511);
  assert.equal(ok.overlaps, 0, JSON.stringify(ok));
  assert.ok(ok.steps === 12000 && ok.kept > 50 && ok.yields > 300, JSON.stringify(ok));
  const bad = await run(true, 2511);
  assert.ok(bad.overlaps > 500, `the deliberate break overlaps: ${JSON.stringify(bad)}`);
});

test('BREAK-1 wiring (source pins): app.mjs follows every drawer write; the chat\'s opening shuts the drawer but keeps an order; the order is set aside in CSS; the heading takes the keyboard', () => {
  const app = src('app.mjs');
  assert.ok(app.includes("import { installNationChat, sideDrawerKey, objectTokens, drawerOpened } from './hud/nationchat.mjs';"));
  assert.match(app, /if \(el\.dataset\.doc !== doc\) el\.dataset\.doc = doc;\n  \}\n(?:  \/\/ .*\n)*  nationChatSide\(d\);\n  nationChatPlace\(\);/);
  assert.ok(app.includes('const sideKeyOf = d => sideDrawerKey(d, { selected: FS.selected, compose: FS.compose, wide: WIDE, stage: STAGE, token: sideTokens });'));
  assert.ok(app.includes("  if (sideKeyOf(d) !== null && d.kind !== 'march') shutDrawer({ focus: false });\n  // (what stands now is what the chat opened over: not a drawer that opened)\n  sideKeyNow = sideKeyOf(drawerOf(FS));"));
  assert.ok(app.includes('state: nationChatState, onOpen: nationChatOpening, focusDrawer: focusDrawerHead });'));
  assert.ok(app.includes("    if (!t.hasAttribute('tabindex')) t.setAttribute('tabindex', '-1');\n    t.focus?.({ preventScroll: true });"));
  const css = src('frontier.css');
  assert.ok(css.includes('body[data-nchat="open"] .panel[data-drawer="open"][data-doc=""] { visibility: hidden; pointer-events: none; }'));
  // the fix-loop24 rules stand as they were (title; beside a wide document)
  assert.ok(css.includes('body[data-title="up"] .nchat-toggle, body[data-title="up"] .nchat-panel { display: none; }'));
  // the chat's own text stays as text (no markup): the two icons only
  const c = src('hud/nationchat.mjs');
  assert.deepEqual([...c.matchAll(/innerHTML = (.*);/g)].length, 2);
});

// ================================================================== Q-PM2-1 (a): the own province's camp under the fog
const HOME = { p: 2, q: 0 };
const GEN = 1_000_000;
const CLOCK = { genesisTs: GEN, drand: { genesis: 0, period: 3 }, margin: 60, window: () => 600 };
const SEASON = { programVersion: 3, layoutVersion: 2, endBell: 4294967295, bellSecs: 600, minLead: 2, maxLead: 72, conquestParams: { keepBells: 72 } };
const HID = hostId({ p: HOME.p, q: HOME.q, site: 2, gen: 0, seq: 1 });
const VILLAGE = { ...HOME, site: 2, gen: 0, tile: 20, faction: 0, state: 2, order: 1, tier: 0, flags: 0, production: baseProduction(0), upkeep: Array(8).fill(0n), stores: [], reserve: Array(8).fill(0), queue: [],
  transit: [{ state: 0 }], explore: { state: 0 }, lastOwnerAction: 1000n, finalTs: 1n, shieldUntil: 0n };
const entry = { id: HID, unit: 0, state: 1, tile: 20, troops: 300000, staminaValue: 120, staminaBell: 10, readyBell: 10, pendOp: 0, fromBell: 10, faction: 0 };
const mirror = (n = 0) => Array.from({ length: 12 }, (_, i) => ({ state: i < n ? 1 : 0, faction: 0, gen: 0, garrison: 0 }));
const prov = (p, q, c, entries = [], villages = 0) => ({ province: { p, q, resolvedNext: 10, entries, ticketCohorts: [], siteCount: 12, sites: [20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31], siteMirror: mirror(villages),
  camp: c ? { state: 1, tile: c.tile, troops: c.troops, gen: 0 } : null } });
const OWN = { ...HOME, troops: 156, tile: 8 }, NEXT = { p: 3, q: 0, troops: 120, tile: 30 }, MATE = { p: 1, q: 0, troops: 110, tile: 30 };
function world({ camps = [OWN, NEXT], ownVillages = 0, extra = {} } = {}) {
  const provinces = new Map([[`${HOME.p},${HOME.q}`, prov(HOME.p, HOME.q, camps.find(c => c.p === HOME.p && c.q === HOME.q) ?? null, [entry], ownVillages)]]);
  for (const c of camps) if (!(c.p === HOME.p && c.q === HOME.q)) provinces.set(`${c.p},${c.q}`, prov(c.p, c.q, c));
  return { mode: 'play', season: SEASON, clock: CLOCK, citizen: { faction: 0, arrivals: 0 }, holdings: [VILLAGE], nowBell: 10, chain: { now: () => GEN + 10 * 600 + 100 }, land: { stage: 'final' }, inFlight: 0,
    provinces, conquest: { status: 'ready', keeps: new Map(), events: [] }, marches: [], orders: [], ui: { dismissed: [] }, terrainOf: () => null, ...extra };
}
const host = { id: HID, unit: 0, troops: 300, ...HOME, tile: 20 };
const fogAll = () => false;

/** A real fog view (map/fog.mjs): only the village's own tile is in sight; nothing else was ever surveyed. */
function fogOn(FS) {
  const h = tileHex(HOME.p, HOME.q, 20);
  const survey = S.buildSurvey({ ringsOpen: 4, anchors: [{ q: h.q, r: h.r, radius: 0, level: S.L3, kind: 'host' }] });
  survey.rev = 1; survey.ownHosts = new Set(); survey.faction = 0;
  const storage = { get: () => null, set: () => true };
  F.createFogger({ storage })({ active: true, survey, overviews: new Map(), viewer: 0, terrainOf: () => null, memKey: 'w' });
  assert.equal(F.viewTile(HOME.p, HOME.q, 20, 2), true, 'the village tile is in sight');
  assert.equal(F.viewTile(OWN.p, OWN.q, OWN.tile, 2), false, 'the own province\'s camp tile is under the fog');
  assert.equal(F.viewTile(NEXT.p, NEXT.q, NEXT.tile, 2), false, 'the neighbour\'s camp tile is under the fog');
  return FS;
}

test('ownProvinceOf: the provinces of the viewer\'s OWN villages (FS.holdings) — not a neighbour, not a nation-mate\'s village', () => {
  const own = FB.ownProvinceOf(world());
  assert.equal(own(HOME.p, HOME.q), true);
  for (const [p, q] of [[3, 0], [1, 0], [2, 1], [2, -1], [-2, 0], [0, 0]]) assert.equal(own(p, q), false, `${p},${q}`);
  assert.equal(FB.ownProvinceOf({ holdings: [] })(2, 0), false);
  assert.equal(FB.ownProvinceOf({})(2, 0), false);
  assert.equal(FB.ownProvinceOf({ holdings: [{ p: '2', q: 0 }] })(2, 0), false, 'only real coordinates');
  // a nation-mate's village is in the province record, never in FS.holdings: not the viewer's own
  const s = world({ camps: [OWN, MATE] });
  s.provinces.get('1,0').province.siteMirror[0] = { state: 1, faction: 0, gen: 0, garrison: 0 };
  assert.equal(FB.ownProvinceOf(s)(1, 0), false);
});

test('Q-PM2-1 (a): under the fog the own province\'s camp is a candidate, marked fogged; the neighbour\'s camp is not (deliberate break: an exception that took neighbours names it)', () => {
  const s = world();
  // before fix-loop25 (no exception): nothing under the fog is ever chosen
  assert.equal(FB.campChoice(s, host, { seen: fogAll, rough: () => false }), null);
  const own = FB.ownProvinceOf(s);
  const c = FB.campChoice(s, host, { seen: fogAll, own, rough: () => false });
  assert.deepEqual(c.camp, { p: HOME.p, q: HOME.q, tile: 8, troops: 156, fogged: true });
  assert.equal(c.winnable, true);
  assert.deepEqual(FB.fightingCampsInSight(s, host, { seen: fogAll, own }).map(x => [x.p, x.q, x.fogged]), [[2, 0, true]], 'the neighbour under the fog is not listed');
  // in sight it is an ordinary camp (no mark)
  assert.equal(FB.campChoice(s, host, { seen: () => true, own, rough: () => false }).camp.fogged, undefined);
  // the neighbour's camp is nearer to win? not offered while fogged: only the own one
  const onlyNext = world({ camps: [NEXT] });
  assert.equal(FB.campChoice(onlyNext, host, { seen: fogAll, own: FB.ownProvinceOf(onlyNext), rough: () => false }), null, 'no own camp: nothing under the fog');
  // DELIBERATE BREAK: an exception that also took the neighbouring provinces would name the neighbour's camp
  const broken = (p, q) => Math.max(Math.abs(p - HOME.p), Math.abs(q - HOME.q), Math.abs(p - HOME.p + q - HOME.q)) <= 1;
  assert.deepEqual(FB.campChoice(onlyNext, host, { seen: fogAll, own: broken, rough: () => false })?.camp, { p: 3, q: 0, tile: 30, troops: 120, fogged: true }, 'the break is caught');
  // the guide's callers use the one helper, never their own rule
  for (const f of ['screens/conquestguide.mjs', 'hud/guide.mjs']) {
    const t = src(f);
    for (const l of t.split('\n').filter(x => /campChoice\(FS|campsSittingOut\(FS|fightingCampsInSight\(FS/.test(x))) assert.match(l, /own(: ownProvinceOf\(FS\))?[ ,}]/, `${f}: ${l.trim().slice(0, 80)}`);
  }
});

test('Q-PM2-1 (a): only a camp that FIGHTS (#265) and that the march REACHES (#273/#277) — the exception changes neither', () => {
  // the own province holds 12 villages: its camp sits every battle out — named as passed by, never the pick
  const full = world({ camps: [OWN], ownVillages: 12 });
  const own = FB.ownProvinceOf(full);
  assert.equal(FB.campChoice(full, host, { seen: fogAll, own, rough: () => false }), null);
  assert.deepEqual(FB.campsSittingOut(full, host, { seen: fogAll, own }).map(x => [x.p, x.q, x.garrisons, x.fogged]), [[2, 0, 12, true]]);
  // the march card's route question says no: not named
  const s = world({ camps: [OWN] });
  assert.equal(FB.campChoice(s, host, { seen: fogAll, own: FB.ownProvinceOf(s), rough: () => false, reach: () => false }), null);
  assert.equal(FB.campChoice(s, host, { seen: fogAll, own: FB.ownProvinceOf(s), rough: () => false, reach: () => true })?.camp.fogged, true);
});

test('Q-PM2-1 (a) on the page\'s own fog: the guide names the own province\'s camp without its defenders, its press routes there, and the fog view is unchanged (JA + EN)', () => {
  const s = fogOn(world());
  const before = JSON.stringify([F.viewTile(OWN.p, OWN.q, OWN.tile, 2), F.viewTile(OWN.p, OWN.q, OWN.tile, 1), F.viewTile(NEXT.p, NEXT.q, NEXT.tile, 2)]);
  setLang('ja');
  const o = conquestObjective(s);
  assert.equal(o.id, 'camp');
  assert.equal(o.go.act, 'ob-go', 'the camp is the first battle');
  assert.match(o.text, /^最初の戦いは、/);
  assert.match(o.text, /この野営地はあなたの村の州にあるため、霧の中でも場所だけを示しています（守り手の数は、見えるところまで近づくとわかります）。/);
  assert.doesNotMatch(o.text, /守り手 156/, 'the defenders are not said under the fog');
  assert.doesNotMatch(o.text, /120/, 'nothing of the neighbour');
  // the press: the march card on that camp (app.mjs guideGo → dest-quick: no fog gate on a destination)
  assert.deepEqual(guideTarget(s), { step: 'camp', kind: 'march', p: HOME.p, q: HOME.q, tile: 8, host: String(HID) });
  // nothing was unfogged: the camp's tile and the neighbour's stay as they were
  assert.equal(JSON.stringify([F.viewTile(OWN.p, OWN.q, OWN.tile, 2), F.viewTile(OWN.p, OWN.q, OWN.tile, 1), F.viewTile(NEXT.p, NEXT.q, NEXT.tile, 2)]), before);
  setLang('en');
  const en = conquestObjective(s);
  assert.doesNotMatch(en.text, CJK);
  assert.doesNotMatch(en.text, /season/i);
  assert.match(en.text, /^Make your first battle the barbarian camp of .+\. This camp stands in your village's province, so the guide shows where it is even under the fog \(its defenders show once it is in sight\)\. Your host \(300 Spearmen\) should win even with bad luck\./);
  assert.doesNotMatch(en.text, /156/);
  // in sight (no fog view): the ordinary line with its defenders, as before
  F.resetFogNow();
  setLang('ja');
  assert.match(conquestObjective(world()).text, /守り手 156/);
});

test('Q-PM2-1 (a): with too few troops the fogged camp\'s line gives the odds and the troops to add, still without its defenders (JA + EN)', () => {
  const weak = world({ camps: [{ ...OWN, troops: 400 }] });
  weak.provinces.get('2,0').province.entries = [{ ...entry, troops: 150000 }];
  const s = fogOn(weak);
  const o = conquestObjective(s);
  assert.equal(o.go.act, 'cg-go');
  assert.match(o.text, /^いちばん近い蛮族の野営地（[^、）]+）を、いまの軍勢（槍兵 150）で攻めると、勝ち目は(低い|五分)です。/);
  assert.doesNotMatch(o.text, /守り手 400/);
  assert.match(o.text, /霧の中でも場所だけを示しています/);
  setLang('en');
  const en = conquestObjective(s);
  assert.doesNotMatch(en.text, CJK);
  assert.match(en.text, /^If your host \(150 Spearmen\) attacks the nearest barbarian camp \([^)]+\), /);
  assert.doesNotMatch(en.text, /400 defenders/);
});

test('Q-PM2-1 (a): before the host is formed, "Train" names the fogged own camp without its defenders (JA + EN); the march card\'s list and the map are unchanged (source pins)', () => {
  const s = fogOn(world({ extra: {} }));
  s.provinces.get('2,0').province.entries = [];
  s.holdings = [{ ...VILLAGE, reserve: Array(8).fill(0) }];
  const o = conquestObjective(s);
  if (o.id === 'train') {
    assert.match(o.text, /最初の戦いは、あなたの村の州にある蛮族の野営地です（霧の中なので守り手の数は見えません）。/);
    setLang('en');
    assert.match(conquestObjective(s).text, /Your first battle is the barbarian camp in your village's province \(under the fog, so its defenders are not in sight\)\./);
  } else assert.fail(`expected the train step, got ${o.id}`);
  // the march card's "Nearby destinations" keep the fog cut (the exception is the guide's only)
  const ctl = src('controller.mjs');
  assert.ok(ctl.includes("if (camp?.state === 1 && viewTile(env.province.p, env.province.q, camp.tile, 2)) out.push({ kind: 'camp'"));
  // the fog module is not touched by the exception: it never reads holdings for vision
  assert.doesNotMatch(src('map/fog.mjs'), /ownProvinceOf/);
  assert.doesNotMatch(src('hud/firstbattle.mjs'), /from '\.\.\/map\/fog\.mjs'/, 'the exception decides nothing of the map');
});

// ================================================================== BREAK-2: the first host's banner
test('BREAK-2: firstHostNext — the camp first while the guide is at its camp step; the keep lines as before otherwise', () => {
  assert.equal(firstHostNext({ troops: 200, need: 300, marchOpen: true, campFirst: true }), 'camp');
  assert.equal(firstHostNext({ troops: 200, need: null, marchOpen: true, campFirst: true }), 'camp');
  assert.equal(firstHostNext({ troops: 200, need: 300, marchOpen: false, campFirst: true }), null, 'march closed: the guide says why');
  assert.equal(firstHostNext({ troops: 200, need: 300, marchOpen: true }), 'addTroops');
  assert.equal(firstHostNext({ troops: 400, need: 300, marchOpen: true }), 'seeKeeps');
  assert.equal(firstHostNext({ troops: 200, need: 300, marchOpen: false }), 'growToward');
  setLang('ja');
  assert.equal(firstHostNextLine('camp'), '次の目標：まず近くの蛮族の野営地へ進軍する（ガイドが案内します）');
  setLang('en');
  assert.equal(firstHostNextLine('camp'), 'Next goal: march on a nearby barbarian camp first (the guide shows the way)');
  assert.doesNotMatch(firstHostNextLine('camp'), /keep|season/i);
});

test('BREAK-2: the banner of the first host standing, at the moment the guide says "camp" (the loop-play25 world): both name the camp', () => {
  const s = world();
  assert.equal(conquestGuide(s)?.current, 'camp');
  const m = reachedMilestones(s).find(x => x.kind === 'first-host');
  assert.equal(m?.next, 'camp');
  setLang('en');
  assert.match(conquestObjective(s).text, /barbarian camp/);
  assert.match(firstHostNextLine(m.next, { unit: m.unit, need: m.need }), /barbarian camp first/);
  // once the camp step is skipped, the banner speaks of keeps again
  const skipped = world({ extra: { ui: { dismissed: ['ob:skip:camp'] } } });
  assert.notEqual(conquestGuide(skipped)?.current, 'camp');
  assert.notEqual(reachedMilestones(skipped).find(x => x.kind === 'first-host')?.next, 'camp');
  // the wiring: the milestone asks the guide (source pin)
  assert.ok(src('hud/milestones.mjs').includes("try { campFirst = conquestGuide(FS)?.current === 'camp'; } catch { campFirst = false; }"));
});
