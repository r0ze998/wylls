// test-gaps-4 (#270 fix-loop24 + verify-pr270): what was checked only on real pages, as properties. Tests only.
//   R1 "Battle report ready" once per MARCH: 400 random pages, each with up to 3 hosts marching again and again (camp,
//      keep, quiet arrivals; local rows with no entry; kept wide expeditions), polls that miss the destination, rows
//      gone in the poll their turn resolved, the "result to collect" line after it — through the page's own path
//      (feed snapshot → diffFeed → pushFeed → the notifier): every resolved march is told exactly once as a report
//      (key report:<host>@<arrival turn>), a host's 2nd and later marches too (verify-pr270's BREAK), nothing else is
//   I1 the .ics holds the viewer's own march: the kept 1× world of verify-pr270 (sent 04:56:37 JST, card "Turn 4 in
//      about 18 min", .ics 05:14:56 JST) as a literal, and 1,000 random rows (entry / local transit / kept expedition
//      with only its own destination — the break verify-pr270 found uncaught) at ×1, ×30 and ×60: DTSTART is the
//      arrival turn's start on the wall clock, in UTC, whatever the computer's time zone; one VEVENT per subject
//   W1 the "While you wait" panel across turn changes (600 random poll sequences of a resting host; the province read
//      behind, missing, or without its host rows for a poll or two): what it last said stands through such polls for
//      at most one turn — never "Nothing to wait for" then — and never longer
//   H1 the nation chat over 300 random sessions of title / wide documents / widths / clicks / Esc / close: the panel
//      is shown exactly when the player left it open and the page allows it; never under the title; focus goes in only
//      when it opens, back to the toggle when the player closes it, and is never left inside a hidden panel
//   F1 a province in a notification is said one way, "Province x,y" / 「州 x,y」 (EN capital P), on 2,000 random
//      own-clash notices and march / keep lines — never by side and ring
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setLang } from '../../permutation-server/web/lang.mjs';
import * as feed from '../../permutation-server/web/frontier/hud/feed.mjs';
import * as notify from '../../permutation-server/web/frontier/hud/notify.mjs';
import * as cal from '../../permutation-server/web/frontier/hud/calendar.mjs';
import * as chat from '../../permutation-server/web/frontier/hud/nationchat.mjs';
import * as waitPanel from '../../permutation-server/web/frontier/hud/waitpanel.mjs';
import { ownClashText } from '../../permutation-server/web/frontier/map/ownclash.mjs';
import { hostId } from '../../permutation-server/web/frontier/faddr.mjs';
import { BELL_SECS, bellStart } from '../../permutation-server/web/frontier/clock.mjs';

const TZ = process.env.TZ;
afterEach(() => { setLang('ja'); if (TZ === undefined) delete process.env.TZ; else process.env.TZ = TZ; });
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const pick = (r, n) => Math.floor(r() * n);
const oneOf = (r, a) => a[pick(r, a.length)];

// ------------------------------------------------------------------ R1
const base = { mode: 'play', holdings: [{ p: 0, q: 0, site: 1, state: 2, tier: 0 }], provinces: new Map() };
/** One host's marches, one after another: `[{arrive, dest, shape, quiet, resolveAt, goneAtResolve, settleAt}]`. */
function plan(r, host, from) {
  const out = [];
  let b = from;
  for (let k = 1 + pick(r, 4); k > 0; k--) {
    const depart = b + pick(r, 3), arrive = depart + 2 + pick(r, 8);
    const resolveAt = arrive + 1 + pick(r, 2);
    out.push({ host, depart, arrive, dest: { p: pick(r, 5) - 2, q: pick(r, 5) - 2, tile: pick(r, 61) }, shape: oneOf(r, ['local', 'entry', 'expedition']),
      quiet: r() < 0.3, resolveAt, goneAtResolve: r() < 0.3, settleAt: r() < 0.6 ? resolveAt + pick(r, 4) : null, endAt: resolveAt + 1 + pick(r, 4) });
    b = out.at(-1).endAt + 1 + pick(r, 3);
  }
  return out;
}
function rowOf(r, m, bell, poll) {
  const resolved = bell >= m.resolveAt;
  // (a local march's own book gives its destination from the departure on; a poll whose turn record was not read has none)
  const dest = poll === 0 || r() < 0.6 ? m.dest : null;
  const facts = { pipeline: resolved ? 'resolved' : bell > m.arrive ? 'revealing' : oneOf(r, [null, 'sealed']), settleReady: m.settleAt !== null && bell >= m.settleAt, slotPresent: bell > m.arrive };
  if (m.shape === 'expedition') return { entry: null, transit: null, dest: null, expedition: { host: m.host, arriveBell: m.arrive, stage: resolved ? 'resolved' : bell >= m.arrive ? 'arrived' : 'marching', dest: m.dest }, facts };
  if (m.shape === 'entry') return { entry: { host: m.host, arriveBell: m.arrive }, transit: null, dest, facts };
  return { entry: null, transit: { slot: 0, state: 1, hostId: m.host, arriveBell: m.arrive }, dest, facts };
}

test('R1 "Battle report ready" exactly once per march, every march of every host (400 random pages, the page\'s own feed → notifier path)', () => {
  setLang('en');
  let marches = 0, quiet = 0, gone = 0, settled = 0, seconds = 0;
  for (let seed = 1; seed <= 400; seed++) {
    const r = rng(2700 + seed);
    const hosts = Array.from({ length: 1 + pick(r, 3) }, (_, i) => String(7 + i));
    const all = hosts.flatMap(h => plan(r, h, 20 + pick(r, 5)));
    const last = Math.max(...all.map(m => m.endAt)) + 8;
    const st = { focused: false, title: 'Wylls' };
    const shown = [];
    const env = { focused: () => st.focused, permission: () => 'granted', show: (t, o) => shown.push({ t, ...o }), title: () => st.title, setTitle: s => { st.title = s; } };
    const prefs = { v: 1, enabled: true, on: { ...notify.NOTIFY_DEFAULTS } };
    const n = notify.createNotifier({ env, prefs: () => prefs });
    let list = [], prev = null;
    n.observe(list, { bell: 19 });
    const told = [];
    for (let bell = 20; bell <= last; bell++) {
      for (let poll = 0, polls = 1 + pick(r, 3); poll < polls; poll++) {
        st.focused = r() < 0.3;
        const rows = [], chronicle = [];
        for (const m of all) {
          if (bell < m.depart || bell > m.endAt) continue;
          if (m.goneAtResolve && bell >= m.resolveAt) continue;   // (the row left the list in the poll its turn was resolved)
          rows.push(rowOf(r, m, bell, bell === m.depart ? 0 : 1));
        }
        for (const m of all) if (m.quiet && bell >= m.resolveAt) chronicle.push({ record: { name: 'CLASH', p: m.dest.p, q: m.dest.q, bell: m.arrive, engagements: 0, fates: { x: 1 } } });
        const snap = feed.snapshot({ ...base, nowBell: bell, marches: rows, chronicle }, 0, prev);
        list = feed.pushFeed(list, feed.diffFeed(prev, snap));
        prev = snap;
        for (const o of n.observe(list, { bell })) told.push({ ...o, focused: st.focused });
      }
    }
    const reports = told.filter(o => o.kind === 'report');
    for (const m of all) {
      const key = `report:${m.host}@${m.arrive}`;
      const mine = reports.filter(o => o.key === key);
      assert.equal(mine.length, 1, `seed ${seed}: the march of host ${m.host} arriving turn ${m.arrive} (${m.shape}${m.quiet ? ', quiet' : ''}${m.goneAtResolve ? ', row gone' : ''}) told ${mine.length} times`);
      assert.equal(mine[0].channel, mine[0].focused ? 'toast' : 'system', 'in front: the feed\'s card; behind: a system notice');
      marches++; quiet += m.quiet; gone += m.goneAtResolve; settled += m.settleAt !== null;
      seconds += all.filter(x => x.host === m.host).indexOf(m) > 0;
    }
    assert.equal(reports.length, all.length, `seed ${seed}: no other report`);
    assert.deepEqual(shown.map(s => s.tag).sort(), reports.filter(o => o.channel === 'system').map(o => `wylls:${o.key}`).sort(), 'a system notice per report told behind, its march\'s key the tag');
    for (const s of shown) assert.match(s.t, /^Battle report ready — Wylls$/);
    // the feed keeps one result line per march (the lines are the march's, not the host's)
    for (const m of all) assert.equal(list.filter(x => x.id === feed.marchLineId('rs', m.host, m.arrive)).length, 1, `seed ${seed}: one result line`);
  }
  assert.ok(marches > 1500 && quiet > 300 && gone > 300 && settled > 600 && seconds > 800, JSON.stringify({ marches, quiet, gone, settled, seconds }));
});

// ------------------------------------------------------------------ I1
const G = 1_800_000_000;
const parseIcs = text => {
  const unfolded = text.replace(/\r\n /g, '');
  return unfolded.split('BEGIN:VEVENT\r\n').slice(1).map(b => Object.fromEntries(b.split('\r\n').filter(l => l.includes(':') && l !== 'END:VEVENT' && l !== 'END:VCALENDAR').map(l => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 1)])));
};
const utcOf = t => Date.UTC(+t.slice(0, 4), +t.slice(4, 6) - 1, +t.slice(6, 8), +t.slice(9, 11), +t.slice(11, 13), +t.slice(13, 15));
const tokyo = ms => new Date(ms).toLocaleString('en-GB', { timeZone: 'Asia/Tokyo', hour12: false });

test('I1 verify-pr270 kept 1×: a camp march sent 04:56:37 JST arriving turn 4 → DTSTART 20261126T201456Z (05:14:56 JST), its report after it', () => {
  setLang('en');
  // the world's chain clock: turn 4 begins 1,099 s after the moment the march was sent (the card said "about 18 min")
  const sentMs = Date.UTC(2026, 10, 26, 19, 56, 37);           // 04:56:37 JST on 11-27
  const genesis = 1_000_000_000, arrive = 4;
  const chainNow = bellStart(genesis, arrive) - 1099;
  const FS = { clock: { genesisTs: genesis }, chain: { now: () => chainNow, rate: 1 }, nowBell: 2, citizen: { faction: 0 }, holdings: [], provinces: new Map(),
    marches: [{ entry: null, transit: { slot: 0, state: 1, hostId: '9001', arriveBell: arrive }, dest: { p: -1, q: 2, tile: 13 }, facts: { pipeline: null } }] };
  for (const tz of ['Asia/Tokyo', 'UTC', 'America/Los_Angeles']) {
    process.env.TZ = tz;
    const text = cal.icsText(cal.calendarEvents(FS, { nowMs: sentMs }), { nowMs: sentMs });
    const ev = parseIcs(text);
    const arrival = ev.find(e => e.UID === 'marchArrival-9001@wylls.invalid');
    assert.ok(arrival, `${tz}: the own march is in the file`);
    assert.equal(arrival.DTSTART, '20261126T201456Z', tz);
    assert.equal(tokyo(utcOf(arrival.DTSTART)), '27/11/2026, 05:14:56', 'in Asia/Tokyo: 05:14:56, as the calendar app shows it');
    assert.match(arrival.SUMMARY.replace(/\\,/g, ','), /^Wylls: march arrives at Province -1,2 \//);
    const rep = ev.find(e => e.UID === 'reportDue-9001@wylls.invalid');
    assert.ok(rep && utcOf(rep.DTSTART) > utcOf(arrival.DTSTART), 'the report after the arrival');
  }
});

test('I1 1,000 random own marches at ×1 / ×30 / ×60: DTSTART = the arrival turn\'s start on the wall clock (UTC); one event per subject; resolved ones gone', () => {
  setLang('en');
  const r = rng(2701);
  let seen = 0, exp = 0;
  process.env.TZ = 'Asia/Tokyo';
  for (let i = 0; i < 1000; i++) {
    const rate = oneOf(r, [1, 30, 60]), bell = 50 + pick(r, 500), chainNow = G + bell * BELL_SECS + pick(r, 600);
    const nowMs = 1_795_000_000_000 + pick(r, 1e9);
    const rows = [];
    for (let k = 1 + pick(r, 3); k > 0; k--) {
      const host = String(9000 + rows.length), arrive = bell + pick(r, 12) - 2, dest = { p: pick(r, 9) - 4, q: pick(r, 9) - 4, tile: pick(r, 61) };
      const resolved = r() < 0.2;
      const shape = oneOf(r, ['entry', 'local', 'expedition']);
      rows.push(shape === 'entry' ? { entry: { host, arriveBell: arrive }, dest, facts: { pipeline: resolved ? 'resolved' : null } }
        : shape === 'local' ? { entry: null, transit: { slot: 0, state: 1, hostId: host, arriveBell: arrive }, dest, facts: { pipeline: resolved ? 'resolved' : null } }
          // (a kept wide expedition: its marker gone, its destination only its own — verify-pr270's uncaught break)
          : { entry: null, transit: null, dest: null, expedition: { host, arriveBell: arrive, stage: resolved ? 'resolved' : 'marching', dest }, facts: { pipeline: null } });
      rows.at(-1).want = { host, arrive, resolved, shape };
    }
    const FS = { clock: { genesisTs: G }, chain: { now: () => chainNow, rate }, nowBell: bell, citizen: { faction: 0 }, holdings: [], provinces: new Map(), marches: rows };
    const ev = parseIcs(cal.icsText(cal.calendarEvents(FS, { nowMs }), { nowMs }));
    const uids = ev.map(e => e.UID);
    assert.equal(new Set(uids).size, uids.length, 'one VEVENT per subject');
    for (const { want } of rows) {
      const a = ev.find(e => e.UID === `marchArrival-${want.host}@wylls.invalid`);
      const startMs = Math.round(nowMs + ((bellStart(G, want.arrive) - chainNow) * 1000) / rate);
      if (want.resolved || startMs <= nowMs) { assert.equal(a, undefined, `#${i}: a resolved or past arrival is not listed`); continue; }
      assert.ok(a, `#${i}: the ${want.shape} march of ${want.host} is in the file`);
      assert.match(a.DTSTART, /^\d{8}T\d{6}Z$/);
      assert.equal(utcOf(a.DTSTART), Math.floor(startMs / 1000) * 1000, `#${i} ×${rate}: DTSTART is the arrival turn's start on the wall clock`);
      seen++; exp += want.shape === 'expedition';
    }
  }
  assert.ok(seen > 800 && exp > 200, `${seen} arrivals (${exp} expeditions)`);
});

// ------------------------------------------------------------------ W1
function waitFS({ bell, kind, readyBell }) {
  const holding = { p: 1, q: 0, site: 2, gen: 0, tier: 0, state: 2, transit: [], reserve: [0, 0, 0, 0, 0, 0], queue: [] };
  const id = hostId({ p: 1, q: 0, site: 2, gen: 0, seq: 1 });
  const entries = kind === 'empty' ? [] : [{ id, state: 1, unit: 0, tile: 5, troops: 353_000, staminaValue: 74, staminaBell: bell, readyBell, pendOp: 0, fromBell: 0 }];
  const province = { p: 1, q: 0, entries, layoutVersion: 2, resolvedNext: kind === 'behind' ? bell - 3 : bell, sites: [], siteMirror: [] };
  return { mode: 'play', clock: { genesisTs: G }, chain: { now: () => G + bell * BELL_SECS + 2, rate: 60 }, nowBell: bell, season: null, citizen: { faction: 0 }, holdings: [holding], activeHolding: 0,
    provinces: kind === 'gone' ? new Map() : new Map([['1,0', { province }]]), marches: [], ui: {} };
}
const hostTimers = m => m.timers.filter(t => String(t.id).startsWith('host:'));

test('W1 the wait panel keeps what it said through a turn change\'s settling polls — never "Nothing to wait for" then — and for one turn at most (600 sequences)', () => {
  setLang('en');
  const r = rng(2702);
  let held = 0, dropped = 0, plain = 0;
  for (let s = 0; s < 600; s++) {
    let bell = 50 + pick(r, 50), keep = null, lastRaw = null;
    const readyBell = bell + 20 + pick(r, 40);
    for (let poll = 0; poll < 40; poll++) {
      bell += oneOf(r, [0, 0, 0, 1, 1, 2]);
      if (bell >= readyBell) break;
      const kind = poll === 0 ? 'ok' : oneOf(r, ['ok', 'ok', 'behind', 'gone', 'empty']);
      const FS = waitFS({ bell, kind, readyBell });
      const raw = waitPanel.waitModel(FS);
      const st = waitPanel.steadyWaitModel(FS, keep, raw);
      keep = st.keep;
      const out = String(waitPanel.renderWaitPanel(FS, st.shown, { open: true }));
      if (hostTimers(raw).length) { lastRaw = bell; plain++; assert.deepEqual(st.shown.timers, raw.timers, 'fresh data is shown as it is'); continue; }
      assert.ok(kind === 'gone' || kind === 'empty', `s${s}: a resting host with its rows read has a timer (${kind})`);
      if (lastRaw !== null && bell - lastRaw <= 1) {
        held++;
        assert.deepEqual(hostTimers(st.shown).map(t => t.kind), ['hostMarch'], `s${s} poll ${poll}: held through the settling poll`);
        assert.doesNotMatch(out, /Nothing to wait for/);
      } else {
        dropped++;
        assert.deepEqual(hostTimers(st.shown), [], `s${s} poll ${poll}: never held more than a turn (last data turn ${lastRaw}, now ${bell})`);
      }
    }
  }
  assert.ok(held > 1000 && dropped > 300 && plain > 3000, JSON.stringify({ held, dropped, plain }));
});

// ------------------------------------------------------------------ H1
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
const findBy = (n, f) => { if (f(n)) return n; for (const c of n.children ?? []) { const x = findBy(c, f); if (x) return x; } return null; };
const tick = () => new Promise(r => setTimeout(r, 0));

test('H1 the nation chat over 300 random sessions: shown exactly when left open and allowed, never under the title; the keyboard goes in on open, back on close, never left in a hidden panel', async () => {
  setLang('en');
  const r = rng(2703);
  const counts = { open: 0, close: 0, esc: 0, parked: 0, back: 0, refused: 0 };
  for (let s = 0; s < 300; s++) {
    const doc = fakeDoc(), anchor = doc.createElement('div');
    doc.body.append(anchor);
    doc.defaultView = { innerWidth: oneOf(r, [390, 1024, 1280, 1920]), addEventListener() {}, removeEventListener() {} };
    const fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, world: '7', program: 'P' }) });
    const ref = chat.installNationChat({ anchor, host: doc.body, doc, fetch, storage: { getItem: () => null, setItem() {} }, WebSocket: function () {},
      timers: { setInterval: () => 1, clearInterval() {}, setTimeout: () => 1, clearTimeout() {} },
      state: () => ({ wallet: { address: 'W' }, nation: 1, world: 7, program: 'P' }) });
    await tick(); await tick();
    const toggle = anchor.parentNode.children.find(x => x.attrs.get('id') === 'nchat-toggle');
    const panel = doc.body.children.find(x => x.attrs.get('id') === 'nchat-panel');
    const closeBtn = findBy(panel, x => x.attrs?.get('class') === 'nchat-close');
    assert.ok(toggle && panel && closeBtn);
    const other = doc.createElement('button');
    doc.body.append(other);
    let want = false;   // the player's own choice: left open or closed
    const allowed = () => chat.chatPlacement(doc.body, doc.defaultView.innerWidth).panel;
    const check = (what) => {
      const shown = want && allowed();
      assert.equal(panel.hidden, !shown, `s${s} ${what}: panel ${panel.hidden ? 'hidden' : 'shown'} (left open ${want}, allowed ${allowed()})`);
      if (doc.body.dataset.title === 'up') assert.ok(toggle.hidden && panel.hidden, `s${s} ${what}: nothing of the chat with the title`);
      assert.equal(toggle.hidden, !allowed(), `s${s} ${what}: the toggle goes with the panel (no dead key)`);
      assert.equal(toggle.getAttribute('aria-expanded'), String(shown));
      assert.equal(doc.body.dataset.nchat, shown ? 'open' : undefined);
      if (panel.hidden) assert.ok(!panel.contains(doc.activeElement), `s${s} ${what}: no focus left inside a hidden panel`);
    };
    check('start');
    for (let step = 0; step < 25; step++) {
      const a = oneOf(r, ['title', 'title', 'doc', 'doc', 'width', 'click', 'click', 'click', 'esc', 'close', 'focusOther', 'focusIn']);
      const wasShown = !panel.hidden;
      if (a === 'title') { if (doc.body.dataset.title === 'up') delete doc.body.dataset.title; else doc.body.dataset.title = 'up'; ref.place(); if (wasShown && panel.hidden) counts.parked++; if (!wasShown && !panel.hidden) counts.back++; }
      else if (a === 'doc') { doc.body.dataset.doc = doc.body.dataset.doc === 'wide' ? '' : 'wide'; ref.place(); if (wasShown && panel.hidden) counts.parked++; if (!wasShown && !panel.hidden) counts.back++; }
      else if (a === 'width') { doc.defaultView.innerWidth = oneOf(r, [390, 1024, 1099, 1100, 1280, 1920]); ref.place(); }
      else if (a === 'click') {
        // (a press on a hidden toggle: a stale handler, a script — it must not open anything the page does not allow)
        const ok = allowed();
        toggle.focus(); toggle.fire('click');
        want = ok ? !wasShown : false;
        if (!ok) counts.refused++;
        else if (want) { counts.open++; assert.ok(panel.contains(doc.activeElement), `s${s}: opened, the keyboard goes in`); }
        else { counts.close++; assert.equal(doc.activeElement, toggle, `s${s}: closed by the toggle, the keyboard stays on it`); }
      } else if (a === 'esc') {
        if (wasShown) { panel.fire('keydown', { key: 'Escape' }); want = false; counts.esc++; assert.equal(doc.activeElement, toggle, `s${s}: Esc gives the keyboard back to the toggle`); }
      } else if (a === 'close') {
        if (wasShown) { closeBtn.focus(); closeBtn.fire('click'); want = false; counts.close++; assert.equal(doc.activeElement, toggle, `s${s}: closed, back to the toggle`); }
      } else if (a === 'focusOther') { other.focus(); }
      else if (a === 'focusIn') { if (wasShown) closeBtn.focus(); }
      // a place() that only follows the page never pulls the keyboard out of what the page focused
      if ((a === 'title' || a === 'doc' || a === 'width') && doc.activeElement === other) assert.equal(doc.activeElement, other);
      check(`${step}:${a}`);
    }
    ref.stop();
  }
  assert.ok(counts.open > 300 && counts.close > 200 && counts.esc > 50 && counts.parked > 100 && counts.back > 50 && counts.refused > 100, JSON.stringify(counts));
});

// ------------------------------------------------------------------ F1
test('F1 one form for a province in a notification: "Province x,y" / 「州 x,y」 on 2,000 random own-clash notices and march lines', () => {
  const r = rng(2704);
  for (let i = 0; i < 2000; i++) {
    const p = pick(r, 400) - 200, q = pick(r, 400) - 200, bell = pick(r, 9999);
    const me = [{ before: 100 + pick(r, 100), after: pick(r, 100), fate: oneOf(r, ['Stays', 'Retreats']) }];
    const part = { me, keep: r() < 0.5 ? { after: oneOf(r, [0, 3, 40]) } : null };
    for (const lang of ['en', 'ja']) {
      setLang(lang);
      const t = ownClashText({}, { p, q, bell }, part);
      if (lang === 'en') {
        assert.ok(t.includes(`Province ${p},${q}`), t);
        assert.doesNotMatch(t, /\bprovince\b|side|ring/, t);
      } else {
        assert.ok(t.includes(`州 ${p},${q}`), t);
        assert.doesNotMatch(t, /方面|第\d+輪/, t);
      }
    }
  }
  // a march's result line with no name known for the tile: the province, in the same form
  setLang('en');
  const d = { p: -7, q: 12, tile: 30 };
  const row = pipeline => ({ entry: null, transit: { slot: 0, state: 1, hostId: '7', arriveBell: 40 }, dest: d, facts: { pipeline } });
  const a = feed.snapshot({ ...base, nowBell: 39, marches: [row(null)] }, 0, null);
  const b = feed.snapshot({ ...base, nowBell: 41, marches: [row('resolved')] }, 0, a);
  const line = feed.diffFeed(a, b).find(x => x.id === 'rs:7@40');
  assert.match(line.text, /Province -7,12/);
  assert.doesNotMatch(line.text, /\bprovince\b|side|ring/);
});
