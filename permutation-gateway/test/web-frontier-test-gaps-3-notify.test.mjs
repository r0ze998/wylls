// test-gaps-3 (#262 notifications + .ics): what verify-pr262 checked live, as properties.
//   N1 the notifier over 400 random pages (random feed lines from every source, duplicates from two sources, random
//      focus / permission / switches per read): the first look is no news; a line is told at most once; one event key
//      at most once per DEDUP_BELLS turns; a told event's kind was switched on and its channel is channelFor's; every
//      system notice is a 'system' record with its key as tag; the title's count is the number of notices told behind
//      since the tab came to the front, written "(n) Wylls" (never twice); lines about others, summaries and the away
//      summary's past are never told; and a new line of a switched-on kind whose key was not told lately IS told
//   N2 the preferences: any stored value (random JSON, junk, a refusing storage) reads as the Q-PT-10 defaults plus
//      only the valid booleans, never enabled unless stored so; a saved patch reads back
//   N3 the .ics: folding keeps every physical line ≤ 75 octets, never splits a character, and unfolds to the line;
//      text escaping round-trips; DTSTART/DTEND are UTC (`Z`) and the same file whatever the computer's time zone
//      (Tokyo, Los Angeles, Chatham +12:45, UTC); the event time = the panel's wall time for the same chain time
//      (calendar wallMsOf = screens/shell.mjs wallOf) at ×1 and ×60
//   N4 (fix-tg3 made these real tests; were todo D-test-gaps-3-2/3) the .ics report time is the wait panel's report time; the
//      calendar writes no time while a fast clock's pace is unknown (the panel says none then)
import test from 'node:test';
import assert from 'node:assert/strict';
import { setLang } from '../../permutation-server/web/lang.mjs';
import * as notify from '../../permutation-server/web/frontier/hud/notify.mjs';
import * as cal from '../../permutation-server/web/frontier/hud/calendar.mjs';
import { reportEtaAt } from '../../permutation-server/web/frontier/hud/firstbattle.mjs';
import { wallOf, setChainNow } from '../../permutation-server/web/frontier/screens/shell.mjs';
import { setTermsPace } from '../../permutation-server/web/frontier/seasonterms.mjs';
import { BELL_SECS, bellEnd } from '../../permutation-server/web/frontier/clock.mjs';

function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const pick = (r, n) => Math.floor(r() * n);
const oneOf = (r, a) => a[pick(r, a.length)];

// ------------------------------------------------------------------ N1
/** A random feed line of one of the page's sources (hud/feed.mjs ids), sometimes the same event from another source. */
function line(r, n, bell) {
  const p = pick(r, 3), q = pick(r, 3), m = pick(r, 4);
  const L = [
    () => ({ id: `kp:keep_contest:${p},${q}:${bell}:${n}`, kind: 'keep', side: oneOf(r, ['defend', 'attack']), p, q, bell }),
    () => ({ id: `al:keep_contest:${n}`, kind: 'keep', bell, p, q, notice: { kind: 'attacked', key: `contest:${p},${q}` } }),
    () => ({ id: `kp:keep_taken:${p},${q}:${bell}:${n}`, kind: 'keep', side: oneOf(r, ['loss', 'gain', 'other']), p, q, bell }),
    () => ({ id: `rs:m${m}`, kind: oneOf(r, ['battle', 'march']), bell }),
    () => ({ id: `st:m${m}`, kind: 'march', bell }),
    () => ({ id: `cl:${p},${q}:${bell}:${n}`, kind: 'battle', attacked: r() < 0.6, p, q, bell, battle: { bell } }),
    () => ({ id: `tr:${p},${q}:${n}`, kind: 'territory', lost: r() < 0.5, bell }),
    () => ({ id: `hg:${p},${q}:${n}`, kind: 'holding', lost: r() < 0.5, p, q, bell }),
    () => ({ id: `in:${p},${q}:${bell}`, kind: 'march', bell }),
    () => ({ id: `hr:h${m}:${bell}`, kind: 'march', bell }),
    () => ({ id: `up:${bell}`, kind: 'territory', bell }),
    () => ({ id: `cl:${p},${q}:${bell}:q${n}`, kind: 'battle', attacked: true, quiet: true, p, q, bell }),
    () => ({ id: `sum:${bell}:${n}`, kind: 'summary', bell }),
    () => ({ id: `aw:${n}`, kind: 'holding', bell, awayOf: { kind: oneOf(r, ['SIEGE_DECLARED', 'CARAVAN_RAIDED', 'CAPTURE_SETTLED']), tone: oneOf(r, ['loss', 'gain']), seq: n, bell: bell - pick(r, 30), at: { p, q } } }),
  ];
  return oneOf(r, L)();
}

test('N1 the notifier: one notice per event, the switches and channels obeyed, the title count exact (400 random pages)', () => {
  setLang('en');
  let told = 0, system = 0, badges = 0, suppressed = 0;
  for (let seed = 1; seed <= 400; seed++) {
    const r = rng(seed);
    const st = { focused: false, permission: 'default', title: 'Wylls' };
    const shown = [];
    const env = { focused: () => st.focused, permission: () => st.permission, show: (t, o) => shown.push({ t, ...o }), title: () => st.title, setTitle: s => { st.title = s; } };
    let prefs = { v: 1, enabled: false, on: { ...notify.NOTIFY_DEFAULTS } };
    const n = notify.createNotifier({ env, prefs: () => prefs });
    const feed = [];
    let id = 0, bell = 50 + pick(r, 100);
    for (let i = 0; i < 3; i++) feed.unshift(line(r, id++, bell));
    assert.deepEqual(n.observe(feed, { bell }), [], 'the first look is no news');
    const seenIds = new Set(feed.map(x => x.id));
    const startBell = bell;
    const lastTold = new Map(), toldIds = new Set();
    let behind = 0;
    for (let read = 0; read < 30; read++) {
      bell += pick(r, 3);
      st.focused = r() < 0.3;
      st.permission = oneOf(r, ['granted', 'denied', 'default', 'unsupported']);
      if (r() < 0.2) prefs = { v: 1, enabled: r() < 0.5, on: Object.fromEntries(notify.NOTIFY_KINDS.map(k => [k, r() < 0.6])) };
      if (st.focused && r() < 0.5) { n.clearBadge(); behind = 0; }
      const fresh = [];
      for (let k = pick(r, 5); k > 0; k--) { const x = line(r, id++, bell); feed.unshift(x); fresh.push(x); }
      if (r() < 0.1) feed.unshift(feed[pick(r, feed.length)]); // a line seen again (the same id)
      const shownBefore = shown.length;
      const out = n.observe(feed, { bell });
      // the model: in order of arrival, a new line whose event's kind is on and whose key was not told lately is told
      const want = [];
      const recent = new Map(lastTold);
      for (const x of fresh) {
        // (a line id the page already showed is not new, whatever it says: the notifier keys on the feed's ids)
        if (seenIds.has(x.id)) continue;
        seenIds.add(x.id);
        const ev = notify.noticeOf(x);
        if (!ev) continue;
        if (x.awayOf && x.awayOf.bell < startBell) continue;
        if (!prefs.on[ev.kind]) { suppressed++; continue; }
        const last = recent.get(ev.key);
        if (last !== undefined && bell - last < notify.DEDUP_BELLS) { suppressed++; continue; }
        recent.set(ev.key, bell);
        want.push({ key: ev.key, kind: ev.kind, id: x.id, channel: notify.channelFor({ kind: ev.kind, prefs, focused: st.focused, permission: st.permission }) });
      }
      assert.deepEqual(out.map(o => ({ key: o.key, kind: o.kind, id: o.id, channel: o.channel })), want, `seed ${seed} read ${read}`);
      for (const o of out) {
        assert.ok(!toldIds.has(o.id), 'a line is told once');
        toldIds.add(o.id);
        const last = lastTold.get(o.key);
        assert.ok(last === undefined || o.at - last >= notify.DEDUP_BELLS, `seed ${seed}: ${o.key} told again within ${notify.DEDUP_BELLS} turns`);
        lastTold.set(o.key, o.at);
        if (o.channel === 'toast') assert.equal(st.focused, true);
        if (o.channel === 'system') assert.ok(prefs.enabled && st.permission === 'granted' && !st.focused);
        if (o.channel !== 'toast') behind++;
        told++; system += o.channel === 'system'; badges += o.channel === 'badge';
      }
      const sys = shown.slice(shownBefore);
      assert.deepEqual(sys.map(s => s.tag), out.filter(o => o.channel === 'system').map(o => `wylls:${o.key}`), 'every system notice is a system record, its key the tag');
      for (const s of sys) assert.match(s.t, / — Wylls$/);
      assert.equal(n.badge(), behind, 'the count = notices told behind since the tab came to the front');
      assert.equal(st.title, behind ? `(${behind > 99 ? '99+' : behind}) Wylls` : 'Wylls');
    }
  }
  assert.ok(told > 2000 && system > 200 && badges > 500 && suppressed > 500, `exercised: ${told} told (${system} system, ${badges} count), ${suppressed} held back`);
});

// ------------------------------------------------------------------ N2
test('N2 the preferences: any stored value reads as the defaults plus valid booleans; never enabled unless stored so', () => {
  const r = rng(262);
  const junk = () => oneOf(r, [null, true, 0, 1, 'on', '', [], {}, { v: 1 }, { v: 2, enabled: true }, 'x', -1]);
  for (let i = 0; i < 2000; i++) {
    const v = r() < 0.8 ? { v: r() < 0.7 ? 1 : junk(), enabled: r() < 0.5 ? r() < 0.5 : junk(), on: r() < 0.8 ? Object.fromEntries([...notify.NOTIFY_KINDS, 'other'].filter(() => r() < 0.6).map(k => [k, r() < 0.6 ? r() < 0.5 : junk()])) : junk() } : junk();
    const raw = r() < 0.1 ? '{not json' : JSON.stringify(v);
    const got = notify.loadNotify({ get: () => raw });
    const want = { ...notify.NOTIFY_DEFAULTS };
    if (v && typeof v === 'object' && v.v === 1 && v.on && typeof v.on === 'object' && raw !== '{not json') for (const k of notify.NOTIFY_KINDS) if (typeof v.on[k] === 'boolean') want[k] = v.on[k];
    assert.deepEqual(got.on, want, raw);
    assert.equal(got.enabled, raw !== '{not json' && !!v && v.v === 1 && v.enabled === true, raw);
    assert.deepEqual(Object.keys(got.on), [...notify.NOTIFY_KINDS]);
  }
  // nothing stored, a storage that throws: the defaults (Q-PT-10: attacked + report on), not enabled
  for (const s of [null, {}, { get: () => { throw new Error('denied'); } }]) assert.deepEqual(notify.loadNotify(s), { v: 1, enabled: false, on: { ...notify.NOTIFY_DEFAULTS } });
  assert.deepEqual(Object.entries(notify.NOTIFY_DEFAULTS).filter(([, on]) => on).map(([k]) => k), ['attacked', 'report']);
  // patches read back; a storage that refuses to write keeps the old ones
  const m = new Map(), store = { get: k => m.get(k) ?? null, set: (k, v) => m.set(k, v) };
  let model = notify.loadNotify(store);
  for (let i = 0; i < 300; i++) {
    const patch = { ...(r() < 0.4 ? { enabled: r() < 0.5 } : {}), on: Object.fromEntries(notify.NOTIFY_KINDS.filter(() => r() < 0.3).map(k => [k, r() < 0.5])) };
    model = { v: 1, enabled: patch.enabled ?? model.enabled, on: { ...model.on, ...patch.on } };
    assert.deepEqual(notify.saveNotify(store, patch), model);
    assert.deepEqual(notify.loadNotify(store), model);
  }
  const ro = { get: k => m.get(k) ?? null, set: () => { throw new Error('quota'); } };
  notify.saveNotify(ro, { enabled: !model.enabled });
  assert.deepEqual(notify.loadNotify(ro), model);
});

// ------------------------------------------------------------------ N3
const G = 1_800_000_000;
function fixtureFS({ rate = 1, bell = 100, accelerated = rate !== 1, rateKnown = true } = {}) {
  const chainNow = G + bell * BELL_SECS + 30;
  return {
    clock: { genesisTs: G, window: () => 600, margin: 60 },
    chain: { now: () => chainNow, rate, accelerated, rateKnown },
    nowBell: bell,
    citizen: { faction: 0 },
    holdings: [],
    provinces: new Map(),
    marches: [{ entry: { host: 'h77', arriveBell: bell + 3 }, dest: { p: 2, q: 0 }, facts: { pipeline: 'sealed' } }],
  };
}
const unfold = s => s.replace(/\r\n /g, '');
const unescape = s => s.replace(/\\(n|N|\\|;|,)/g, (_, c) => (c === 'n' || c === 'N' ? '\n' : c));

test('N3 the .ics: folding, escaping, UTC times in every time zone, and the panel\'s wall time for the same moment', () => {
  const r = rng(5545);
  const chars = ['a', 'Z', ' ', ',', ';', '\\', ':', 'é', 'あ', '砦', '😀', '́', 'ﾊ', '\n'];
  const dec = new TextDecoder('utf-8', { fatal: true }), enc = new TextEncoder();
  for (let i = 0; i < 3000; i++) {
    let s = '';
    for (let k = pick(r, 200); k > 0; k--) s += oneOf(r, chars);
    const e = cal.icsEscape(s);
    assert.equal(unescape(e), s, 'escaping round-trips');
    assert.doesNotMatch(e, /\n|(?<!\\),|(?<!\\);/, 'no raw newline, comma or semicolon');
    const lineText = `DESCRIPTION:${e}`;
    const f = cal.icsFold(lineText);
    const parts = f.split('\r\n');
    parts.forEach((p, j) => {
      const bytes = enc.encode(p);
      assert.ok(bytes.length <= 75, `a physical line of ${bytes.length} octets`);
      if (j > 0) assert.equal(p[0], ' ', 'a continuation starts with one space');
      assert.equal(dec.decode(bytes), p, 'no character split');
    });
    assert.equal(unfold(f), lineText, 'unfolds to the line');
  }
  // UTC date-times, the same file in any time zone (the name is the browser's local time)
  const was = process.env.TZ;
  try {
    for (let i = 0; i < 500; i++) {
      const ms = Math.floor(r() * 4_102_444_800_000);
      const t = cal.icsTime(ms);
      assert.match(t, /^\d{8}T\d{6}Z$/);
      const back = Date.UTC(+t.slice(0, 4), +t.slice(4, 6) - 1, +t.slice(6, 8), +t.slice(9, 11), +t.slice(11, 13), +t.slice(13, 15));
      assert.equal(back, Math.floor(ms / 1000) * 1000);
    }
    setLang('en');
    const nowMs = Date.UTC(2026, 10, 26, 8, 30, 0);
    const files = new Set(), names = new Set();
    for (const tz of ['UTC', 'Asia/Tokyo', 'America/Los_Angeles', 'Pacific/Chatham']) {
      process.env.TZ = tz;
      files.add(cal.icsText(cal.calendarEvents(fixtureFS(), { nowMs }), { nowMs }));
      names.add(cal.icsFileName(nowMs));
    }
    assert.equal(files.size, 1, 'the file is the same in every time zone');
    assert.equal(names.size, 4, 'the file name is local time');
    // verify-pr262: notified 17:39:18 JST → DTSTART:20261126T083918Z
    assert.equal(cal.icsTime(Date.UTC(2026, 10, 26, 8, 39, 18)), '20261126T083918Z');
    process.env.TZ = 'Asia/Tokyo';
    assert.equal(new Date(Date.UTC(2026, 10, 26, 8, 39, 18)).getHours(), 17);
  } finally { if (was === undefined) delete process.env.TZ; else process.env.TZ = was; }
  // the event time = the panel's wall time for the same chain time, at ×1 and ×60 (both from the chain's now)
  for (const rate of [1, 60]) {
    for (let i = 0; i < 200; i++) {
      const FS = fixtureFS({ rate, bell: 50 + pick(r, 500) });
      const nowMs = 1_790_000_000_000 + pick(r, 1e9);
      setTermsPace(() => rate);
      setChainNow(() => FS.chain.now());
      const t = FS.chain.now() + 1 + pick(r, 40_000);
      const panel = wallOf(t, null, nowMs);
      assert.ok(Math.abs(cal.wallMsOf(FS, t, nowMs) - panel * 1000) <= 1, `×${rate}: .ics ${cal.wallMsOf(FS, t, nowMs)} vs panel ${panel * 1000}`);
      for (const e of cal.calendarEvents(FS, { nowMs })) assert.ok(e.startMs > nowMs);
    }
  }
  setTermsPace(() => 1);
  setChainNow(null);
});

// ------------------------------------------------------------------ N4 (fix-tg3: owner-default Q-TG3-2 (a), Q-TG3-3 — were todo)
test('N4a the .ics report time = the wait panel\'s report time for the same march (fix-tg3, Q-TG3-2 (a))', () => {
  const FS = fixtureFS();
  setTermsPace(() => 1);
  setChainNow(() => FS.chain.now());
  try {
    const nowMs = 1_790_000_000_000;
    const ev = cal.calendarEvents(FS, { nowMs }).find(e => e.kind === 'reportDue');
    const panelAt = reportEtaAt(FS.clock, FS.marches[0].entry.arriveBell);
    assert.ok(ev, 'a report event');
    assert.equal(panelAt - bellEnd(G, 103), 720, 'the panel: the turn\'s end + window 600 + margin 60 + 60 s');
    assert.equal(ev.startMs, Math.round(wallOf(panelAt, null, nowMs) * 1000), '.ics = the panel\'s wall time of reportEtaAt');
    assert.equal(cal.REPORT_LAG_SECS, undefined, 'no calendar-only lag');
  } finally { setTermsPace(() => 1); setChainNow(null); }
});

test('N4b a fast clock whose pace is not known yet: the calendar writes no time (the panel says none) (fix-tg3, Q-TG3-3)', () => {
  const FS = fixtureFS({ rate: 1, accelerated: true, rateKnown: false });
  setTermsPace(() => null);
  setChainNow(() => FS.chain.now());
  try {
    assert.equal(wallOf(FS.chain.now() + 600), null, 'the panel: no wall time while the pace is unknown');
    assert.equal(cal.calendarBlocked(FS), 'paceUnknown');
    assert.deepEqual(cal.calendarEvents(FS, { nowMs: 1_790_000_000_000 }), [], 'the calendar does not guess either');
  } finally { setTermsPace(() => 1); setChainNow(null); }
});
