// test-gaps-5 (#278 fix-loop25, tests only): what verify-pr278 / finish-pr278 checked by hand in Chromium, automated —
//   FP1  one right-side panel at a time, on app.mjs's OWN code (nationChatSide / nationChatOpening / shutDrawer, run from
//        the file's text with the page's real drawerOf / closeDrawer and the real chat): for every drawer kind, a drawer
//        that opens closes the chat; the chat that opens closes the drawer (the welcome is acknowledged); an order being
//        written is set aside, never thrown away; a wide document (report, practice) and the chat stand together; a
//        redraw never closes the chat;
//   FP2  the fog exception on the page's real fog (map/fog.mjs) over 300 random worlds (1–3 own villages, a nation-mate's
//        village, neighbours, seen and unseen camps): only a camp of the viewer's OWN village provinces is named under the
//        fog; its defender count is never in the guide's text or its "Train" line (JA + EN); the win chance and the
//        troops are (from the hidden count); a neighbour under the fog is never named or counted;
//   FP3  the first host's banner says "the camp first" exactly when the guide is at its camp step (and the march is
//        open), and the banner's HTML carries that line (EN + JA).
// Behaviour is not changed here. Key-free: the chat's wallet stand-in cannot sign; no request leaves the test.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setLang } from '../../permutation-server/web/lang.mjs';
import * as chat from '../../permutation-server/web/frontier/hud/nationchat.mjs';
import { drawerOf, closeDrawer, WIDE, STAGE } from '../../permutation-server/web/frontier/hud/drawer.mjs';
import * as FB from '../../permutation-server/web/frontier/hud/firstbattle.mjs';
import { campArrival } from '../../permutation-server/web/frontier/hud/rulebook.mjs';
import * as F from '../../permutation-server/web/frontier/map/fog.mjs';
import * as S from '../../permutation-server/web/frontier/map/survey.mjs';
import { tileHex } from '../../permutation-server/web/frontier/fgeo.mjs';
import { hostId } from '../../permutation-server/web/frontier/faddr.mjs';
import { baseProduction } from '../../permutation-server/web/frontier/fland.mjs';
import { conquestObjective, conquestGuide } from '../../permutation-server/web/frontier/screens/conquestguide.mjs';
import { guideTarget } from '../../permutation-server/web/frontier/hud/guide.mjs';
import { firstHostNextLine, marchOpenFor } from '../../permutation-server/web/frontier/hud/firststeps.mjs';
import { reachedMilestones, renderBanner } from '../../permutation-server/web/frontier/hud/milestones.mjs';

afterEach(() => { setLang('ja'); F.resetFogNow(); });
const CJK = /[぀-ヿ㐀-鿿]/;
const WEB = new URL('../../permutation-server/web/frontier/', import.meta.url);
const src = f => readFileSync(new URL(f, WEB), 'utf8');
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const int = (r, a, b) => a + Math.floor(r() * (b - a + 1));

// ================================================================== FP1: app.mjs's own panel code
/** A minimal DOM for hud/nationchat.mjs (as web-frontier-fix-loop25). */
function fakeDoc() {
  const doc = { activeElement: null, defaultView: null };
  const mk = tag => ({
    tagName: tag.toUpperCase(), attrs: new Map(), children: [], parentNode: null, dataset: {}, listeners: {}, scrollTop: 0, scrollHeight: 0, clientHeight: 0, textContent: '', innerHTML: '', value: '', disabled: false,
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
  });
  doc.createElement = mk;
  doc.body = mk('body');
  doc.getElementById = () => null;
  doc.activeElement = doc.body;
  return doc;
}
const tick = () => new Promise(r => setTimeout(r, 0));

async function mountChat({ onOpen }) {
  setLang('en');
  const doc = fakeDoc(), anchor = doc.createElement('div');
  doc.body.append(anchor);
  doc.defaultView = { innerWidth: 1280, addEventListener() {}, removeEventListener() {} };
  const fetch = async url => ({ ok: true, status: 200, json: async () => (String(url).endsWith('/h/chat/read') ? { ok: true, messages: [] } : { ok: true, world: '7', program: 'P', turn: 5 }) });
  function WS() { this.readyState = 1; this.send = () => {}; this.close = () => {}; }
  const ref = chat.installNationChat({ anchor, host: doc.body, doc, fetch, storage: { getItem: () => null, setItem() {} }, WebSocket: WS,
    timers: { setInterval: () => 1, clearInterval() {}, setTimeout: () => 1, clearTimeout() {} },
    state: () => ({ wallet: { address: 'MeWallet1111' }, nation: 1, world: 7, program: 'P' }), onOpen, focusDrawer: () => {} });
  await tick(); await tick();
  const toggle = anchor.parentNode.children.find(x => x.attrs.get('id') === 'nchat-toggle');
  return { ref, toggle };
}

/** A text block of app.mjs from `start` to the end of the function that `endFn` opens (brace-matched). */
function appBlock(start, endFn) {
  const text = src('app.mjs');
  const a = text.indexOf(start), b = text.indexOf(endFn, a);
  assert.ok(a > 0 && b >= a, `app.mjs still has ${start.slice(0, 40)} … ${endFn}`);
  let depth = 0;
  for (let i = text.indexOf(') {', b) + 2; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) return text.slice(a, i + 1);
  }
  throw new Error('unbalanced');
}
/** app.mjs's one-panel rule, as written there, bound to an FS and a mounted chat. */
function appPanels(FS) {
  const rule = appBlock('const sideTokens = objectTokens();', 'function nationChatOpening() {');
  const shut = appBlock('function shutDrawer({ focus = false } = {}) {', 'function shutDrawer(');
  const make = new Function('FS', 'drawerOf', 'closeDrawer', 'sideDrawerKey', 'objectTokens', 'drawerOpened', 'WIDE', 'STAGE', 'deps', `
    let nationChatRef = null;
    const { clearInspection, clearOutbound, hand, endPick, ackHomeGrant, ACTIONS, invalidate, $, handEl } = deps;
    ${shut}
    ${rule}
    return { nationChatSide, nationChatOpening, setRef: r => { nationChatRef = r; }, deps };`);
  const deps = {
    clearInspection() {}, clearOutbound() {}, endPick() { deps.picksEnded++; }, picksEnded: 0, invalidate() {}, $: () => null, handEl: null,
    hand: { subjectOf: () => null },
    ackHomeGrant: () => { const h = FS.homeGrant; FS.homeGrant = null; return h ?? null; }, // controller.mjs ackHomeGrant (its storage note aside)
    ACTIONS: { tab: ({ tab }) => { FS.tab = tab; } },
  };
  return make(FS, drawerOf, closeDrawer, chat.sideDrawerKey, chat.objectTokens, chat.drawerOpened, WIDE, STAGE, deps);
}
const OPENERS = {
  hosts: FS => { FS.tab = 'hosts'; }, holding: FS => { FS.tab = 'holding'; }, territory: FS => { FS.tab = 'territory'; },
  marches: FS => { FS.tab = 'marches'; }, more: FS => { FS.tab = 'more'; },
  inspect: FS => { FS.tab = 'map'; FS.selected = { p: 1, q: 0, tile: 3 }; FS.inspectOpen = true; },
  guide: FS => { FS.tab = 'map'; FS.guideOpen = true; },
  home: FS => { FS.homeGrant = { p: 0, q: 0, site: 0 }; },
  // (an order being written, with the first village's welcome still pending behind it: the order comes first, drawer.mjs)
  march: FS => { FS.tab = 'map'; FS.compose = { host: { id: 'h1' }, dest: null }; FS.homeGrant = { p: 0, q: 0, site: 0 }; },
  report: FS => { FS.report = { p: 1, q: 0 }; },
  practice: FS => { FS.practice = { id: 'p' }; },
};
async function session() {
  const FS = { mode: 'play', tab: 'map', selected: null, compose: null, inspectOpen: false, guideOpen: false, holdings: [{ p: 0, q: 0, tile: 1 }], land: { stage: 'final' }, citizen: { faction: 1 } };
  const app = appPanels(FS);
  const m = await mountChat({ onOpen: () => app.nationChatOpening() });
  app.setRef(m.ref);
  const render = () => { const d = drawerOf(FS); app.nationChatSide(d); m.ref.place(); return d; };
  render();
  return { FS, app, m, render };
}

test('FP1 every drawer kind, on app.mjs\'s own code: a side drawer that opens closes the chat; a wide document stands beside it; a redraw closes nothing', async () => {
  for (const [kind, open] of Object.entries(OPENERS)) {
    const { FS, m, render } = await session();
    m.toggle.fire('click');
    assert.equal(m.ref.isOpen, true, `${kind}: the chat is open`);
    open(FS);
    const d = render();
    assert.equal(d?.kind, kind, `the opener opens ${kind}`);
    const side = !WIDE.has(kind) && !STAGE.has(kind);
    assert.equal(m.ref.isOpen, !side, `${kind}: ${side ? 'a side drawer closes the chat' : 'a wide document stands beside the chat'}`);
    // the drawer keeps being drawn: no further change to the chat
    for (let i = 0; i < 3; i++) { render(); assert.equal(m.ref.isOpen, !side, `${kind}: a redraw changes nothing`); }
    // the chat opened again over the drawer, then the drawer redrawn: the chat stays (its opening was the last word)
    if (side) {
      m.toggle.fire('click');
      render(); render();
      assert.equal(m.ref.isOpen, true, `${kind}: after the chat reopens, redraws keep it open`);
    }
  }
});

test('FP1 every drawer kind, on app.mjs\'s own code: the chat that opens closes the side drawer (the welcome acknowledged); an order is set aside, not lost; a wide document stays', async () => {
  for (const [kind, open] of Object.entries(OPENERS)) {
    const { FS, app, m, render } = await session();
    open(FS);
    assert.equal(render()?.kind, kind);
    const order = FS.compose, picks = app.deps.picksEnded;
    m.toggle.fire('click');
    assert.equal(m.ref.isOpen, true, `${kind}: the chat opens`);
    const d = render();
    assert.equal(m.ref.isOpen, true, `${kind}: the drawer write after the chat's opening did not close it`);
    if (kind === 'march') {
      assert.equal(d?.kind, 'march', 'the order is set aside under the chat (frontier.css hides it), still there');
      assert.equal(FS.compose, order, 'the same order object: nothing typed is lost');
      assert.equal(app.deps.picksEnded, picks, 'the order\'s destination pick on the map is not ended (shutDrawer is not run)');
      assert.ok(FS.homeGrant, 'the welcome waiting behind the order is not acknowledged by the chat');
      m.toggle.fire('click');
      assert.equal(render()?.kind, 'march', 'the chat closed: the order card stands again');
      assert.equal(FS.compose, order);
    } else if (WIDE.has(kind)) {
      assert.equal(d?.kind, kind, `${kind} is a wide document: it stays beside the chat`);
    } else {
      assert.equal(d, null, `${kind}: the chat's opening closed the drawer (as its own × does)`);
      if (kind === 'home') assert.equal(FS.homeGrant, null, 'the welcome was acknowledged (it does not come back by itself)');
    }
  }
  // the chat's own CSS keeps an order set aside out of sight and out of reach (pinned)
  assert.ok(src('frontier.css').includes('body[data-nchat="open"] .panel[data-drawer="open"][data-doc=""] { visibility: hidden; pointer-events: none; }'));
});

test('FP1 300 random sessions on app.mjs\'s own code: never a side drawer and the chat drawn together; an order never lost', async () => {
  const r = rng(278);
  let overlaps = 0, steps = 0;
  const kinds = Object.keys(OPENERS);
  for (let s = 0; s < 300; s++) {
    const { FS, m, render } = await session();
    for (let i = 0; i < 25; i++) {
      const a = r();
      const order = FS.compose;
      if (a < 0.35) OPENERS[kinds[int(r, 0, kinds.length - 1)]](FS);
      else if (a < 0.65) m.toggle.fire('click');
      else if (a < 0.75) closeDrawer(FS);
      else if (a < 0.8) FS.compose = null;
      else if (a < 0.85) FS.report = null;
      if (a >= 0.35 && a < 0.65 && order) assert.equal(FS.compose, order, 'the chat\'s opening never throws an order away');
      const d = render();
      const side = chat.sideDrawerKey(d, { wide: WIDE, stage: STAGE }) !== null;
      const drawn = side && !(m.ref.isOpen && d.kind === 'march');
      if (m.ref.isOpen && drawn) overlaps++;
      steps++;
    }
  }
  assert.equal(overlaps, 0);
  assert.equal(steps, 7_500);
});

// ================================================================== FP2: the fog exception on the page's real fog
const GEN = 1_000_000;
const CLOCK = { genesisTs: GEN, drand: { genesis: 0, period: 3 }, margin: 60, window: () => 600 };
const SEASON = { programVersion: 3, layoutVersion: 2, endBell: 4294967295, bellSecs: 600, minLead: 2, maxLead: 72, conquestParams: { keepBells: 72 } };
const HOME = { p: 2, q: 0 }, HOME_TILE = 20;
const HID = hostId({ p: HOME.p, q: HOME.q, site: 2, gen: 0, seq: 1 });
const HOST = { id: HID, unit: 0, troops: 300, ...HOME, tile: HOME_TILE };
const village = (p, q, site, order) => ({ p, q, site, gen: 0, tile: 20 + site, faction: 0, state: 2, order, tier: 0, flags: 0, production: baseProduction(0), upkeep: Array(8).fill(0n), stores: [], reserve: Array(8).fill(0), queue: [],
  transit: [{ state: 0 }], explore: { state: 0 }, lastOwnerAction: 1000n, finalTs: 1n, shieldUntil: 0n });
const mirror = (mate = false) => Array.from({ length: 12 }, (_, i) => ({ state: mate && i === 0 ? 1 : 0, faction: 0, gen: 0, garrison: 0 }));
const prov = (p, q, camp, entries = [], mate = false) => ({ province: { p, q, resolvedNext: 10, entries, ticketCohorts: [], siteCount: 12, sites: [20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31], siteMirror: mirror(mate),
  camp: camp ? { state: 1, tile: camp.tile, troops: camp.troops, gen: 0 } : null } });
const NEAR = [[2, 0], [3, 0], [1, 0], [2, 1], [2, -1], [3, -1], [1, 1], [4, 0], [0, 0], [2, 2]];

/**
 * A random world around the home province (2,0): 1–3 own villages (the first at home), maybe a nation-mate's village,
 * camps in up to 7 provinces with distinct defender counts, the host formed or not. The page's real fog: in sight only
 * the village tile and the camps picked as surveyed.
 */
function randomFogWorld(r, { formed = true, weak = 0.25 } = {}) {
  const provs = [...NEAR].sort(() => r() - 0.5);
  const own = [[2, 0], ...provs.filter(([p, q]) => !(p === 2 && q === 0)).slice(0, int(r, 0, 2))];
  const rest = NEAR.filter(([p, q]) => !own.some(([a, b]) => a === p && b === q));
  const mate = r() < 0.5 ? rest[int(r, 0, rest.length - 1)] : null;
  const counts = new Set();
  const troopsOf = () => { let n; do n = r() >= weak ? int(r, 101, 249) : int(r, 401, 899); while (counts.has(n) || n % 50 === 0); counts.add(n); return n; }; // (not a round count: the guide asks for hundreds of troops)
  const camps = NEAR.filter(() => r() < 0.6).map(([p, q]) => ({ p, q, tile: [8, 30, 44][int(r, 0, 2)], troops: troopsOf(), seen: r() < 0.35 }));
  const holdings = own.map(([p, q], i) => village(p, q, 2 + i, i + 1));
  const entry = { id: HID, unit: 0, state: 1, tile: HOME_TILE, troops: 300000, staminaValue: 120, staminaBell: 10, readyBell: 10, pendOp: 0, fromBell: 10, faction: 0 };
  const provinces = new Map();
  for (const [p, q] of NEAR) {
    const c = camps.find(x => x.p === p && x.q === q) ?? null;
    provinces.set(`${p},${q}`, prov(p, q, c, p === HOME.p && q === HOME.q && formed ? [entry] : [], mate && mate[0] === p && mate[1] === q));
  }
  const FS = { mode: 'play', season: SEASON, clock: CLOCK, citizen: { faction: 0, arrivals: 0 }, holdings, nowBell: 10, chain: { now: () => GEN + 10 * 600 + 100 }, land: { stage: 'final' }, inFlight: 0,
    provinces, conquest: { status: 'ready', keeps: new Map(), events: [] }, marches: [], orders: [], ui: { dismissed: [] }, terrainOf: () => null };
  // the real fog view: the village tile, and the camps picked as surveyed
  const anchors = [{ ...tileHex(HOME.p, HOME.q, HOME_TILE), radius: 0, level: S.L3, kind: 'host' }]
    .concat(camps.filter(c => c.seen).map(c => ({ ...tileHex(c.p, c.q, c.tile), radius: 0, level: S.L3, kind: 'host' })))
    .map(a => ({ q: a.q, r: a.r, radius: a.radius, level: a.level, kind: a.kind }));
  const survey = S.buildSurvey({ ringsOpen: 4, anchors });
  survey.rev = 1; survey.ownHosts = new Set(); survey.faction = 0;
  F.createFogger({ storage: { get: () => null, set: () => true } })({ active: true, survey, overviews: new Map(), viewer: 0, terrainOf: () => null, memKey: `w${r()}` });
  for (const c of camps) c.inSight = F.viewTile(c.p, c.q, c.tile, 2);
  return { FS, camps, own, mate };
}
/** The number `n` as a whole number in the text (grouped or not), not as part of another number. */
const saysNumber = (text, n) => new RegExp(`(?<![\\d,.])${n.toLocaleString('en-US').replace(',', ',?')}(?![\\d,]*\\d)`).test(text);

test('FP2 300 random worlds on the page\'s real fog: under the fog only a camp of the viewer\'s own village provinces is named, never with its defenders; the win chance and troops are said; no fogged neighbour leaks (JA + EN)', () => {
  const r = rng(2780);
  const tally = { foggedOwn: 0, foggedWeak: 0, seen: 0, none: 0 };
  for (let i = 0; i < 300; i++) {
    F.resetFogNow();
    const { FS, camps, own } = randomFogWorld(r, { weak: i % 5 === 0 ? 1 : 0.25 });
    const isOwn = (p, q) => own.some(([a, b]) => a === p && b === q);
    const g = guideTarget(FS);
    const texts = {};
    for (const lang of ['ja', 'en']) { setLang(lang); texts[lang] = conquestObjective(FS).text; }
    setLang('ja');
    const all = texts.ja + '\n' + texts.en, why = JSON.stringify({ own, camps, g });
    assert.doesNotMatch(texts.en, CJK, why);
    assert.doesNotMatch(all, /season|シーズン/i, why);
    // no camp under the fog outside the own provinces is ever named, nor its count said
    for (const c of camps.filter(x => !x.inSight && !isOwn(x.p, x.q))) {
      assert.ok(!(g?.kind === 'march' && g.p === c.p && g.q === c.q), `fogged neighbour ${c.p},${c.q} is never the target: ${why}`);
      assert.ok(!saysNumber(all, c.troops), `fogged neighbour's ${c.troops} defenders never said: ${why}\n${all}`);
    }
    // the guide's pick (its own call: the page's fog test and ownProvinceOf), and the target its press opens
    const choice = FB.campChoice(FS, HOST, { seen: (p, q, t) => F.viewTile(p, q, t, 2), own: FB.ownProvinceOf(FS), rough: () => true });
    if (!choice) { tally.none++; assert.notEqual(g?.kind, 'march', why); continue; }
    const c = camps.find(x => x.p === choice.camp.p && x.q === choice.camp.q && x.tile === choice.camp.tile);
    assert.ok(c, why);
    if (g?.kind === 'march') assert.deepEqual([g.p, g.q, g.tile], [c.p, c.q, c.tile], why);
    if (c.inSight) { tally.seen++; assert.equal(choice.camp.fogged, undefined, why); continue; }
    assert.ok(isOwn(c.p, c.q), `a fogged pick is in an own village's province: ${why}`);
    assert.equal(choice.camp.fogged, true, why);
    tally.foggedOwn++;
    // its defenders: never; its place: said (the fog sentence); the odds and troops: from the hidden count
    assert.ok(!saysNumber(all, c.troops), `the fogged camp's ${c.troops} defenders are not said:\n${all}`);
    assert.match(texts.en, /under the fog \(its defenders show once it is in sight\)/, texts.en);
    assert.match(texts.ja, /霧の中でも場所だけを示しています/, texts.ja);
    const odds = campArrival({ unit: 0, troops: 300, campTroops: c.troops, rough: true }).odds;
    assert.equal(choice.winnable, odds === 'good', why);
    if (odds === 'good') assert.match(texts.en, /Your host \(300 Spearmen\) should win even with bad luck\./, texts.en);
    else { tally.foggedWeak++; assert.match(texts.en, /^If your host \(300 Spearmen\) attacks the nearest barbarian camp \([^)]+\), /, texts.en); assert.match(texts.en, /\d[\d,]* Spearmen/, texts.en); }
  }
  assert.ok(tally.foggedOwn >= 50 && tally.seen >= 25 && tally.foggedWeak >= 3, JSON.stringify(tally));
});

test('FP2 before the host is formed, the "Train" line names the fogged own camp without its defenders, and never a fogged neighbour (150 worlds, JA + EN)', () => {
  const r = rng(2781);
  let train = 0;
  for (let i = 0; i < 150; i++) {
    F.resetFogNow();
    const { FS, camps, own } = randomFogWorld(r, { formed: false });
    const isOwn = (p, q) => own.some(([a, b]) => a === p && b === q);
    setLang('ja'); const ja = conquestObjective(FS);
    setLang('en'); const en = conquestObjective(FS);
    setLang('ja');
    if (ja.id !== 'train') continue;
    train++;
    const all = `${ja.text}\n${en.text}`;
    for (const c of camps.filter(x => !x.inSight)) assert.ok(!saysNumber(all, c.troops), `fogged camp ${c.p},${c.q} (own: ${isOwn(c.p, c.q)}): ${c.troops} not said\n${all}`);
    if (/under the fog, so its defenders are not in sight/.test(en.text)) assert.ok(camps.some(c => !c.inSight && isOwn(c.p, c.q)), en.text);
  }
  assert.ok(train >= 75, `${train} train lines`);
});

// ================================================================== FP3: the banner and the guide agree
test('FP3 the first host\'s banner says "the camp first" exactly when the guide is at its camp step and the march is open; its HTML carries the line (EN + JA, 250 worlds)', () => {
  const r = rng(2782);
  const tally = { camp: 0, other: 0 };
  for (let i = 0; i < 250; i++) {
    F.resetFogNow();
    const { FS } = randomFogWorld(r);
    if (r() < 0.3) FS.ui.dismissed = ['ob:skip:camp'];
    if (r() < 0.3) { FS.localPlay = true; FS.localMarch = { open: r() < 0.5 }; }
    const m = reachedMilestones(FS).find(x => x.kind === 'first-host');
    assert.ok(m, 'the formed host is a first-host milestone');
    const step = conquestGuide(FS)?.current;
    const want = step === 'camp' && marchOpenFor(FS);
    assert.equal(m.next === 'camp', want, JSON.stringify({ step, open: marchOpenFor(FS), next: m.next }));
    for (const lang of ['en', 'ja']) {
      setLang(lang);
      const banner = String(renderBanner(m, 0));
      if (want) assert.ok(banner.includes(firstHostNextLine('camp')), `${lang}: ${banner}`);
      else assert.ok(!banner.includes(firstHostNextLine('camp')), `${lang}: ${banner}`);
      if (lang === 'en') { assert.doesNotMatch(banner.replace(/<[^>]+>/g, ''), CJK); assert.doesNotMatch(banner, /season/i); }
    }
    setLang('ja');
    tally[want ? 'camp' : 'other']++;
  }
  assert.ok(tally.camp >= 60 && tally.other >= 60, JSON.stringify(tally));
});
