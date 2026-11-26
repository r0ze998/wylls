// fix-loop24 (loop-play24 BREAK-1/2/3 + the wait panel's flicker), page only:
//   BREAK-1 the nation chat opens only where it can be seen (never under the title; beside a wide document only with room),
//           the keyboard goes in only then and comes back to the toggle on close;
//   BREAK-2 a local march row carries its destination from the departure on (the local sender's own seal record), so the
//           calendar file lists it (arrival + report);
//   BREAK-3 a march's report is told even when one poll read its row without a destination, and for every own march kind
//           (a quiet arrival, a kept wide expedition); a province in a notification is said one way, "Province x,y";
//   flicker  the "While you wait" panel keeps a standing host's timer through the settling seconds of each turn.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setLang } from '../../permutation-server/web/lang.mjs';
import * as book from '../../permutation-server/web/frontier/marchbook.mjs';
import * as feed from '../../permutation-server/web/frontier/hud/feed.mjs';
import * as notify from '../../permutation-server/web/frontier/hud/notify.mjs';
import * as cal from '../../permutation-server/web/frontier/hud/calendar.mjs';
import * as place from '../../permutation-server/web/frontier/hud/place.mjs';
import * as chat from '../../permutation-server/web/frontier/hud/nationchat.mjs';
import * as waitPanel from '../../permutation-server/web/frontier/hud/waitpanel.mjs';
import { hostId } from '../../permutation-server/web/frontier/faddr.mjs';
import { BELL_SECS } from '../../permutation-server/web/frontier/clock.mjs';

const WEB = new URL('../../permutation-server/web/frontier/', import.meta.url);
const src = f => readFileSync(new URL(f, WEB), 'utf8');

// ------------------------------------------------------------------ BREAK-2: the destination of a local march
test('BREAK-2: the seal record of a live transit is found by host, slot, arrival turn and seal root — and only one', () => {
  const e = (x = {}) => ({ host: '77', transitSlot: 1, arriveBell: 40, sealRoot_hex: 'ab'.repeat(32), state: 'landed', ...x });
  const t = { slot: 1, hostId: 77n, arriveBell: 40, sealRoot: 'AB'.repeat(32) };
  assert.equal(book.entryOfTransit([e()], t)?.host, '77');
  assert.equal(book.entryOfTransit([e({ sealRoot_hex: 'cd'.repeat(32) })], t), null, 'another seal root is another seal');
  assert.equal(book.entryOfTransit([e({ state: 'failed' })], t)?.host, '77', 'a send marked failed that landed anyway is the one (its root matches)');
  assert.equal(book.entryOfTransit([e({ state: 'failed' })], { ...t, sealRoot: '' }), null, 'without a root, a failed entry is not taken');
  assert.equal(book.entryOfTransit([e({ arriveBell: 41 })], t), null);
  assert.equal(book.entryOfTransit([e({ transitSlot: 2 })], t), null);
  assert.equal(book.entryOfTransit([e(), e()], { ...t, sealRoot: '' }), null, 'two candidates: none');
  assert.equal(book.entryOfTransit(null, t), null);
});

test('BREAK-2: the march rows read the destination this device sent — before the arrival turn, not only after (source)', () => {
  const c = src('controller.mjs');
  assert.ok(c.includes('function sentMarchDest(t, scope) {'));
  assert.ok(c.includes('const s = localMarchSenderNow(), e = book.entryOfTransit(book.loadBook(s.storage, s.bookKey), t);'), 'the local sender\'s own book');
  assert.ok(c.includes('return ownMarchDest(t, scope) ?? t.dest ?? null;'), 'then the order record, then the gathered transit');
  assert.ok(c.includes('    const dest = sentMarchDest(t, at.scope);\n    if (!dest) continue;'), 'the arrived march\'s facts');
  assert.ok(c.includes('dest = lf?.dest ?? sentMarchDest(t, at.scope);'), 'and the row itself, from the departure on');
  assert.ok(!c.includes('dest = lf?.dest ?? t.dest;'), 'the row no longer waits for the arrival turn to know where it goes');
});

const G = 1_800_000_000;
function calFS({ bell = 100, marches } = {}) {
  const chainNow = G + bell * BELL_SECS + 30;
  return { clock: { genesisTs: G }, chain: { now: () => chainNow, rate: 60 }, nowBell: bell, citizen: { faction: 0 }, holdings: [], provinces: new Map(), marches };
}
test('BREAK-2: a local march row (no book entry, its transit and the destination it was sent to) is in the calendar file', () => {
  setLang('en');
  const nowMs = Date.UTC(2026, 10, 27, 3, 0, 0);
  const local = { entry: null, transit: { slot: 0, state: 1, hostId: '9001', arriveBell: 107 }, dest: { p: -1, q: 1, tile: 30 }, facts: { pipeline: null } };
  const evs = cal.calendarEvents(calFS({ marches: [local] }), { nowMs });
  assert.deepEqual(evs.map(e => e.kind).sort(), ['marchArrival', 'reportDue']);
  assert.equal(evs.find(e => e.kind === 'marchArrival').uid, 'marchArrival-9001@wylls.invalid');
  assert.match(evs.find(e => e.kind === 'marchArrival').title.en, /Province -1,1/);
  // deliberate break: the same row as loop-play24 saw it (dest null) has no events — what the fix supplies
  assert.deepEqual(cal.calendarEvents(calFS({ marches: [{ ...local, dest: null }] }), { nowMs }), []);
  // a kept wide expedition (no entry, its marker gone): by its own host, arrival and destination
  const exp = { entry: null, transit: null, dest: { p: -128, q: 66, tile: 3 }, expedition: { host: '9002', arriveBell: 110, stage: 'marching', dest: { p: -128, q: 66, tile: 3 } }, facts: { pipeline: null } };
  const ex = cal.calendarEvents(calFS({ marches: [exp] }), { nowMs });
  assert.deepEqual(ex.map(e => e.kind).sort(), ['marchArrival', 'reportDue']);
  assert.equal(ex[0].uid.split('@')[0].endsWith('9002'), true);
  assert.deepEqual(cal.calendarEvents(calFS({ marches: [{ ...exp, expedition: { ...exp.expedition, stage: 'settled' } }] }), { nowMs }), [], 'a settled expedition has no timers');
});

// ------------------------------------------------------------------ BREAK-3: the report is told
const base = { mode: 'play', holdings: [{ p: 0, q: 0, site: 1, state: 2, tier: 0 }], chronicle: [], provinces: new Map() };
const row = (bell, x) => ({ entry: null, transit: { slot: 0, state: 1, hostId: '7', arriveBell: 74 }, facts: { pipeline: null }, ...x, nowBell: undefined });
const snapAt = (nowBell, marches, prev, extra = {}) => feed.snapshot({ ...base, nowBell, marches, ...extra }, 0, prev);

test('BREAK-3: a keep march read once without its destination is still told when resolved (the destination stays known)', () => {
  setLang('en');
  const d = { p: -1, q: 1, tile: 30 };
  const s1 = snapAt(70, [row(70, { dest: d })], null);
  const s2 = snapAt(75, [row(75, { dest: null, facts: { pipeline: 'revealing' } })], s1);   // a poll whose turn record was not read
  assert.deepEqual(s2.marches.get('7').dest, d, 'the destination stays with the same march');
  const s3 = snapAt(76, [row(76, { dest: null, facts: { pipeline: 'resolved' } })], s2);
  const told = feed.diffFeed(s2, s3);
  const rs = told.find(x => x.id === 'rs:7@74');
  assert.ok(rs, 'the report line is told');
  assert.deepEqual(notify.noticeOf(rs), { kind: 'report', key: 'report:7@74' }, '…and it is a "Battle report ready" event');
  // the row gone in the same poll its turn ended: told by the "row gone" path, with the kept destination
  const gone = feed.diffFeed(s2, snapAt(76, [], s2));
  assert.equal(gone.filter(x => x.id === 'rs:7@74').length, 1);
  // deliberate break: a snapshot made without the previous one (the destination not carried) tells nothing
  const s2b = snapAt(75, [row(75, { dest: null, facts: { pipeline: 'revealing' } })], null);
  assert.equal(feed.diffFeed(s2b, snapAt(76, [], s2b)).filter(x => x.id === 'rs:7@74').length, 0);
  // a later march of the same host to elsewhere starts afresh (the kept destination belongs to arrival turn 74 only)
  const later = snapAt(80, [{ ...row(80, { dest: null }), transit: { slot: 0, state: 1, hostId: '7', arriveBell: 90 } }], s3);
  assert.equal(later.marches.get('7').dest, null);
});

test('BREAK-3: every own report kind is a "Battle report ready" event — a quiet arrival, a kept wide expedition', () => {
  assert.deepEqual(notify.noticeOf({ id: 'rs:7', kind: 'march', text: 'x' }), { kind: 'report', key: 'report:7' });
  assert.deepEqual(notify.noticeOf({ id: 'rs:7', kind: 'battle', text: 'x' }), { kind: 'report', key: 'report:7' });
  const exp = st => ({ entry: null, transit: null, dest: { p: -128, q: 66, tile: 3 }, expedition: { host: '55', arriveBell: 40, stage: st, dest: { p: -128, q: 66, tile: 3 } }, facts: { nowBell: 41, pipeline: null } });
  const a = snapAt(41, [exp('arrived')], null), b = snapAt(42, [exp('resolved')], a);
  assert.equal(b.marches.get('55').pipeline, 'resolved');
  const told = feed.diffFeed(a, b).filter(x => x.id === 'rs:55@40');
  assert.equal(told.length, 1, 'the expedition\'s result is told once');
  assert.equal(notify.noticeOf(told[0]).kind, 'report');
  assert.equal(feed.diffFeed(b, snapAt(43, [exp('settled')], b)).filter(x => x.id === 'rs:55@40').length, 0, 'not twice');
});

test('BREAK-3/4: a province in a notification is said one way — 「州 x,y」 / "Province x,y" — and a keep as its keep', () => {
  setLang('en');
  assert.equal(place.noticeProvince(-1, 1), 'Province -1,1');
  assert.equal(place.noticeKeep(-1, 1), 'the keep of Province -1,1');
  const overviews = new Map([['r', { provinces: [{ p: -1, q: 1, keepTile: 30 }] }]]);
  assert.equal(feed.destPlace({ overviews, provinces: new Map() }, { p: -1, q: 1, tile: 30 }), 'the keep of Province -1,1');
  assert.equal(feed.destPlace({ overviews, provinces: new Map() }, { p: -1, q: 1, tile: 12 }), 'Province -1,1', 'a plain tile: its province, not its terrain');
  assert.equal(feed.destPlace({ provinces: new Map() }, { p: 2, q: 0 }), 'Province 2,0');
  const camp = new Map([['2,0', { province: { p: 2, q: 0, camp: { state: 1, tile: 9 } } }]]);
  assert.match(feed.destPlace({ provinces: camp }, { p: 2, q: 0, tile: 9 }), /camp/i, 'a camp by its name');
  // the keep events and the battle lines: the same form in EN (capital P) and JA
  const ev = { kind: 'keep_contest', seq: 1, bell: 30, p: -1, q: 1, from: 3, to: 1 };
  const s0 = feed.snapshot({ ...base, nowBell: 30, marches: [], citizen: { faction: 3 }, conquest: { events: [] }, overviews: new Map() }, 0, null);
  const s1 = feed.snapshot({ ...base, nowBell: 30, marches: [], citizen: { faction: 3 }, conquest: { events: [ev] }, overviews: new Map() }, 0, s0);
  const line = feed.diffFeed(s0, s1).find(x => x.kind === 'keep');
  assert.match(line.words.en, /the keep of Province -1,1/);
  assert.match(line.words.ja, /州 -1,1 の砦/);
  for (const w of Object.values(line.words)) assert.doesNotMatch(w, /方面|side \(ring|province -?\d/);
  // the herald's alerts use the page's notice names (app.mjs notifyNames)
  assert.ok(src('app.mjs').includes('  province: (p, q) => noticeProvince(p, q),'));
  // the feed module no longer names a province by side and ring
  assert.doesNotMatch(src('hud/feed.mjs'), /provinceName\(/);
  setLang('ja');
  assert.equal(place.noticeProvince(-1, 1), '州 -1,1');
});

// ------------------------------------------------------------------ BREAK-1: the chat where it can be seen
function fakeDoc() {
  const doc = { activeElement: null, defaultView: null };
  const mk = tag => {
    const e = { tagName: tag.toUpperCase(), attrs: new Map(), children: [], parentNode: null, dataset: {}, listeners: {}, scrollTop: 0, scrollHeight: 0, textContent: '', innerHTML: '', value: '', disabled: false,
      get hidden() { return this.attrs.has('hidden'); }, set hidden(v) { if (v) this.attrs.set('hidden', ''); else this.attrs.delete('hidden'); },
      setAttribute(k, v) { this.attrs.set(k, String(v)); }, getAttribute(k) { return this.attrs.get(k) ?? null; },
      append(...c) { for (const x of c) { if (typeof x !== 'object') continue; x.parentNode = this; this.children.push(x); } },
      replaceChildren(...c) { this.children = []; this.append(...c); },
      insertBefore(x, ref) { x.parentNode = this; const i = this.children.indexOf(ref); this.children.splice(i < 0 ? this.children.length : i, 0, x); },
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
async function mountChat({ width = 1280 } = {}) {
  setLang('en');
  const doc = fakeDoc(), anchor = doc.createElement('div');
  doc.body.append(anchor);
  doc.defaultView = { innerWidth: width, addEventListener() {}, removeEventListener() {} };
  const fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, world: '7', program: 'P' }) });
  const ref = chat.installNationChat({ anchor, host: doc.body, doc, fetch, storage: { getItem: () => null, setItem() {} }, WebSocket: function () {},
    timers: { setInterval: () => 1, clearInterval() {}, setTimeout: () => 1, clearTimeout() {} },
    state: () => ({ wallet: { address: 'W' }, nation: 1, world: 7, program: 'P' }) });
  await tick(); await tick();
  const toggle = anchor.parentNode.children.find(x => x.attrs.get('id') === 'nchat-toggle');
  const panel = doc.body.children.find(x => x.attrs.get('id') === 'nchat-panel');
  return { doc, ref, toggle, panel };
}

test('BREAK-1: the placement rule — no chat with the title; beside a wide document only with room (≥ 1100 px)', () => {
  const b = d => ({ dataset: d });
  assert.deepEqual(chat.chatPlacement(b({ title: 'up' }), 1920), { toggle: false, panel: false });
  assert.deepEqual(chat.chatPlacement(b({ doc: 'wide' }), 1280), { toggle: true, panel: true });
  assert.deepEqual(chat.chatPlacement(b({ doc: 'wide' }), 1024), { toggle: false, panel: false }, 'no dead Chat key while the panel may not open');
  assert.deepEqual(chat.chatPlacement(b({}), 390), { toggle: true, panel: true });
  assert.equal(chat.CHAT_BESIDE_DOC_MIN, 1100);
  // the stylesheet: hidden with the title, the document moved left beside the open panel at the same width
  const css = src('frontier.css');
  assert.ok(css.includes('body[data-title="up"] .nchat-toggle, body[data-title="up"] .nchat-panel { display: none; }'));
  assert.match(css, /@media \(min-width: 1100px\) \{\n  body\[data-nchat="open"\] \.panel\[data-doc="wide"\] \{ left: calc\(/);
  // the page tells the chat when the title or a wide document comes and goes
  const app = src('app.mjs');
  assert.match(app, /for \(const el of \[\$\('frontier'\), \$\('tabs'\)\]\) if \(el\) el\.inert = up;\n  nationChatPlace\(\);/);
  assert.match(app, /if \(el\.dataset\.doc !== doc\) el\.dataset\.doc = doc;\n  \}\n  nationChatPlace\(\);/);
});

test('BREAK-1: under the title the toggle is hidden and nothing opens; the keyboard never goes into a hidden panel', async () => {
  const { doc, ref, toggle, panel } = await mountChat();
  assert.equal(toggle.hidden, false, 'shown on the game screen');
  doc.body.dataset.title = 'up'; ref.place();
  assert.equal(toggle.hidden, true, 'not with the title (Q-LP24-2 (a))');
  toggle.fire('click');
  assert.equal(panel.hidden, true, 'a press (a stale handler, a script) does not open it under the title');
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.ok(!panel.contains(doc.activeElement), 'the focus is not in the panel');
  delete doc.body.dataset.title; ref.place();
  assert.equal(toggle.hidden, false);
  ref.stop();
});

test('BREAK-1: opened, the keyboard goes in; closed (button or Esc), it comes back to the toggle; no trap', async () => {
  const { doc, ref, toggle, panel } = await mountChat();
  toggle.focus(); toggle.fire('click');
  assert.equal(panel.hidden, false);
  assert.equal(doc.body.dataset.nchat, 'open', 'the page knows the panel is open (the document moves aside)');
  assert.ok(panel.contains(doc.activeElement), 'the focus goes in');
  panel.fire('keydown', { key: 'Escape' });
  assert.equal(panel.hidden, true);
  assert.equal(doc.activeElement, toggle, 'Esc gives the focus back to the toggle');
  assert.equal(doc.body.dataset.nchat, undefined);
  toggle.fire('click');
  panel.fire('keydown', { key: 'Tab' });
  assert.equal(panel.hidden, false, 'Tab is not taken: nothing in the panel listens for it to hold the focus');
  assert.ok(!src('hud/nationchat.mjs').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n').match(/key === 'Tab'|inert/), 'no focus trap');
  ref.stop();
});

test('BREAK-1: a wide document on a narrow screen sets the open panel aside and it comes back when the document closes', async () => {
  const { doc, ref, toggle, panel } = await mountChat({ width: 1024 });
  toggle.focus(); toggle.fire('click');
  assert.equal(panel.hidden, false);
  const inside = doc.activeElement;
  assert.ok(panel.contains(inside));
  doc.body.dataset.doc = 'wide'; ref.place();
  assert.equal(panel.hidden, true, 'set aside: it would cover the practice sheet\'s result');
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.ok(!panel.contains(doc.activeElement), 'a focus left inside the hidden panel is let go');
  doc.body.dataset.doc = ''; ref.place();
  assert.equal(panel.hidden, false, 'back when the document closes');
  // wide enough: it stays open beside the document
  doc.defaultView.innerWidth = 1280; doc.body.dataset.doc = 'wide'; ref.place();
  assert.equal(panel.hidden, false);
  // set aside again on a narrow screen: the toggle steps aside with it (no dead key), and both come back
  doc.defaultView.innerWidth = 1024; ref.place();
  assert.equal(panel.hidden, true);
  assert.equal(toggle.hidden, true, 'no Chat key that could not open anything');
  doc.body.dataset.doc = ''; ref.place();
  assert.equal(toggle.hidden, false);
  assert.equal(panel.hidden, false, 'back as the player left it');
  // closed by the player: it stays closed through a document opening and closing
  toggle.fire('click');
  assert.equal(panel.hidden, true);
  doc.body.dataset.doc = 'wide'; ref.place(); doc.body.dataset.doc = ''; ref.place();
  assert.equal(panel.hidden, true, 'nothing reopens unasked');
  ref.stop();
});

// ------------------------------------------------------------------ the wait panel's flicker
function waitFS({ resolvedNext, bell = 50, readyBell = 58, stamina = 74 } = {}) {
  const holding = { p: 1, q: 0, site: 2, gen: 0, tier: 0, state: 2, transit: [], reserve: [0, 0, 0, 0, 0, 0], queue: [] };
  const id = hostId({ p: 1, q: 0, site: 2, gen: 0, seq: 1 });
  const entries = [{ id, state: 1, unit: 0, tile: 5, troops: 353_000, staminaValue: stamina, staminaBell: bell, readyBell, pendOp: 0, fromBell: 0 }];
  const province = { p: 1, q: 0, entries, layoutVersion: 2, resolvedNext, sites: [], siteMirror: [] };
  return { mode: 'play', clock: { genesisTs: G }, chain: { now: () => G + bell * BELL_SECS + 2, rate: 60 }, nowBell: bell, season: null, citizen: { faction: 0 }, holdings: [holding], activeHolding: 0,
    provinces: new Map([['1,0', { province }]]), marches: [], ui: {} };
}
test('flicker: a resting host keeps its timer in the first seconds of a turn (its province still settling the turn)', () => {
  setLang('en');
  const settled = waitPanel.waitModel(waitFS({ resolvedNext: 50 }));
  const settling = waitPanel.waitModel(waitFS({ resolvedNext: 47 }));   // resolvedNext + 1 < nowBell: keephand waitOf says 'settling'
  const hostT = m => m.timers.filter(t => t.id.startsWith('host:')).map(t => [t.kind, t.turn]);
  assert.deepEqual(hostT(settled), [['hostMarch', 58]]);
  assert.deepEqual(hostT(settling), [['hostMarch', 58]], 'the same timer while the province catches up — no "Nothing to wait for"');
  assert.doesNotMatch(String(waitPanel.renderWaitPanel(waitFS({ resolvedNext: 47 }), settling, { open: true })), /Nothing to wait for/);
  // a host already rested: ready in both moments
  const ready = waitPanel.waitModel(waitFS({ resolvedNext: 47, readyBell: 0 }));
  assert.deepEqual(hostT(ready), [['hostReady', undefined]]);
  assert.equal(waitPanel.settledWait(waitFS({ resolvedNext: 47 }), null), null);
});
test('flicker: what the panel said stands until new data is in (steadyWaitModel), never longer than one turn', () => {
  const FS = waitFS({ resolvedNext: 50 });
  const full = waitPanel.waitModel(FS);
  const st1 = waitPanel.steadyWaitModel(FS, null, full);
  assert.equal(st1.shown, full);
  const empty = { timers: [], suggestions: [], soonest: null };
  const behind = waitFS({ resolvedNext: 47, bell: 51 });
  assert.deepEqual(waitPanel.steadyWaitModel(behind, st1.keep, empty).shown.timers, full.timers, 'kept while the province is behind');
  const caughtUp = waitFS({ resolvedNext: 51, bell: 51 });
  assert.deepEqual(waitPanel.steadyWaitModel(caughtUp, st1.keep, empty).shown.timers, [], 'new data in: the empty answer is shown');
  const later = waitFS({ resolvedNext: 47, bell: 53 });
  assert.deepEqual(waitPanel.steadyWaitModel(later, st1.keep, empty).shown.timers, [], 'not more than a turn');
  // the host between its march's report and home (--wide ×60: 4 empty samples): the report line stands a moment longer
  const withReport = { key: st1.keep.key, bell: 50, model: { timers: [{ id: 'report', kind: 'report', at: 1 }], suggestions: [], soonest: null } };
  assert.deepEqual(waitPanel.steadyWaitModel(caughtUp, withReport, empty).shown.timers.map(t => t.kind), ['report']);
  assert.deepEqual(waitPanel.steadyWaitModel(waitFS({ resolvedNext: 53, bell: 53 }), withReport, empty).shown.timers, [], 'not past a turn');
  assert.ok(src('app.mjs').includes('const st = waitPanel.steadyWaitModel(F, F === FS ? waitSteady : null, waitPanel.waitModel(F, { offer }));'));
});

// ------------------------------------------------------------------ verify-pr270: found live on the PR head
test('verify-pr270: a host\'s SECOND march is told too — its lines are the march\'s (host @ arrival turn), not the host\'s', () => {
  setLang('en');
  const d1 = { p: 1, q: -2, tile: 50 }, d2 = { p: -1, q: 1, tile: 50 };
  const mk = (arriveBell, dest, pipeline) => ({ entry: null, transit: { slot: 0, state: 1, hostId: '7', arriveBell }, dest, facts: { pipeline } });
  // the host's first march (the camp), told; then the same host's keep march (loop-play24 BREAK-3: 353 Spearmen after the camp)
  const a = snapAt(54, [mk(55, d1, null)], null), b = snapAt(57, [mk(55, d1, 'resolved')], a);
  const first = feed.diffFeed(a, b).filter(x => x.id.startsWith('rs:'));
  assert.deepEqual(first.map(x => x.id), ['rs:7@55']);
  const c = snapAt(60, [], b), e = snapAt(70, [mk(74, d2, null)], c), f = snapAt(76, [mk(74, d2, 'resolved')], e);
  const second = feed.diffFeed(e, f).filter(x => x.id.startsWith('rs:'));
  assert.deepEqual(second.map(x => x.id), ['rs:7@74'], 'the second march has a line of its own');
  // the feed keeps both (pushFeed drops a known id) and the notices tell both ("Battle report ready" twice, a report each)
  const list = feed.pushFeed(feed.pushFeed([], first), second);
  assert.equal(list.filter(x => x.id.startsWith('rs:7')).length, 2, 'deliberate break: with `rs:${host}` the second line is dropped here');
  assert.notEqual(notify.noticeOf(first[0]).key, notify.noticeOf(second[0]).key);
  // the same march's result line and its "result to collect" line are still ONE event
  assert.equal(notify.noticeOf({ id: feed.marchLineId('st', '7', 74), kind: 'march' }).key, notify.noticeOf(second[0]).key);
});

test('verify-pr270: a host whose march has arrived (transit not settled yet) shows its own rest, not "Nothing to wait for"', () => {
  setLang('en');
  const FS = waitFS({ resolvedNext: 56, bell: 57, readyBell: 56, stamina: 5 });
  const h = FS.holdings[0], id = FS.provinces.get('1,0').province.entries[0].id;
  h.transit = [{ slot: 0, state: 2, hostId: id, arriveBell: 55, sealRoot: '' }];
  const m = waitPanel.waitModel(FS);
  const hostT = m.timers.filter(t => t.id.startsWith('host:'));
  assert.equal(hostT.length, 1, JSON.stringify(m.timers));
  assert.equal(hostT[0].kind, 'hostMarch');
  assert.equal(hostT[0].turn, 57 + 74 - 5, 'short of stamina: from the turn it has the 74 a departure takes');
  assert.doesNotMatch(String(waitPanel.renderWaitPanel(FS, m, { open: true })), /Nothing to wait for/);
  // before its arrival turn has passed it is a march, not a rest (the report line above says it)
  h.transit[0].arriveBell = 58;
  assert.equal(waitPanel.waitModel(FS).timers.filter(t => t.id.startsWith('host:')).length, 0);
});
