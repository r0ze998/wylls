// Notices outside the page and the calendar file (pt-notify; owner 2026-11-26 15:48 Q-PT-8 a+b, Q-PT-10):
// which feed line is which event, the defaults (ON: attacked, battle report ready), how a new event is told
// (front: the feed's card; behind: a system notification if allowed, else the title's count), one notice per event,
// the permission asked only from a press, and an .ics built from the player's own state (RFC 5545 shape, EN + JA).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setLang } from '../../permutation-server/web/lang.mjs';
import * as notify from '../../permutation-server/web/frontier/hud/notify.mjs';
import * as cal from '../../permutation-server/web/frontier/hud/calendar.mjs';
import { hostId } from '../../permutation-server/web/frontier/faddr.mjs';
import { BELL_SECS } from '../../permutation-server/web/frontier/clock.mjs';

const WEB = new URL('../../permutation-server/web/frontier/', import.meta.url);
const src = f => readFileSync(new URL(f, WEB), 'utf8');
const memStore = () => { const m = new Map(); return { get: k => m.get(k) ?? null, set: (k, v) => { m.set(k, v); return true; }, m }; };
const env0 = (o = {}) => {
  const shown = [];
  let title = 'Wylls';
  return { shown, focused: () => !!o.focused, permission: () => o.permission ?? 'default', show: (t, opts) => shown.push({ t, ...opts }), title: () => title, setTitle: s => { title = s; } };
};

test('Q-PT-10 defaults: attacked and battle report ON, the rest opt-in; nothing enabled until the player says so', () => {
  const st = memStore();
  const p = notify.loadNotify(st);
  assert.deepEqual(p.on, { attacked: true, report: true, incoming: false, hostReady: false, upkeep: false, keepHeld: false });
  assert.equal(p.enabled, false);
  st.set(notify.NOTIFY_KEY, '{"v":1,"enabled":"yes","on":{"attacked":false,"report":7,"bogus":true}}');
  const q = notify.loadNotify(st);
  assert.equal(q.enabled, false, 'a damaged flag is not enabled');
  assert.equal(q.on.attacked, false);
  assert.equal(q.on.report, true, 'a damaged field reads as the default');
  assert.ok(!('bogus' in q.on));
  st.set(notify.NOTIFY_KEY, 'not json');
  assert.deepEqual(notify.loadNotify(st).on, notify.NOTIFY_DEFAULTS);
  const r = notify.saveNotify(st, { enabled: true, on: { hostReady: true } });
  assert.equal(r.enabled, true);
  assert.equal(r.on.hostReady, true);
  assert.equal(notify.saveNotify(st, { on: { attacked: false } }).enabled, true, 'a patch keeps the rest');
});

test('which feed line is which event (and the same event from two sources has one key)', () => {
  const of = notify.noticeOf;
  assert.deepEqual(of({ id: 'kp:keep_taken:9', side: 'loss', p: 1, q: 2 }), { kind: 'attacked', key: 'keeplost:1,2' });
  assert.deepEqual(of({ id: 'kp:keep_taken:9', side: 'gain', p: 1, q: 2 }), { kind: 'keepHeld', key: 'keepwon:1,2' });
  assert.equal(of({ id: 'kp:keep_taken:9', side: null, p: 1, q: 2 }), null, 'a capture among others');
  assert.deepEqual(of({ id: 'kp:keep_contest:3', side: 'defend', p: 1, q: 2 }), { kind: 'attacked', key: 'contest:1,2' });
  assert.equal(of({ id: 'kp:keep_contest:3', side: 'attack', p: 1, q: 2 }), null, 'our own attack is no attack on us');
  assert.equal(of({ id: 'kp:keep_broken:3', side: 'defend', p: 1, q: 2 }), null);
  assert.equal(of({ id: 'tr:1,2,5,10,0,1,battle' }), null, 'land gained');
  assert.equal(of({ id: 'tr:1,2,5,10,0,1,battle', lost: true }).kind, 'attacked');
  assert.equal(of({ id: 'hg:1,2,3:40', p: 1, q: 2 }), null, 'a provisional village pushed out');
  assert.deepEqual(of({ id: 'hg:1,2,3:40', p: 1, q: 2, lost: true }), { kind: 'attacked', key: 'lost:1,2' });
  assert.equal(of({ id: 'cl:1,2,40', kind: 'battle', p: 1, q: 2, battle: { bell: 40 } }), null, 'a clash before its report says a host of ours fought');
  assert.equal(of({ id: 'cl:1,2,40', kind: 'battle', p: 1, q: 2, battle: { bell: 40 }, attacked: true }).kind, 'attacked');
  assert.equal(of({ id: 'cl:1,2,40', kind: 'battle', quiet: true, attacked: true }), null, 'others\' battle');
  assert.deepEqual(of({ id: 'rs:77', kind: 'battle' }), { kind: 'report', key: 'report:77' });
  // (fix-loop24, BREAK-3: every own march's result is a report — an arrival nobody stood against has its report too)
  assert.deepEqual(of({ id: 'rs:77', kind: 'march' }), { kind: 'report', key: 'report:77' }, 'arrived, no battle: its report is ready too');
  assert.deepEqual(of({ id: 'st:77', kind: 'march' }), { kind: 'report', key: 'report:77' }, 'the result to collect is the same event as the report');
  assert.equal(of({ id: 'in:40,1,2', kind: 'incoming' }).kind, 'incoming');
  assert.equal(of({ id: 'sum:40', kind: 'summary' }), null);
  assert.equal(of({ id: 'aw:5', kind: 's1', awayOf: { kind: 'CARAVAN_RAIDED', tone: 'loss', seq: 5 } }).kind, 'attacked');
  assert.equal(of({ id: 'aw:5', kind: 's1', awayOf: { kind: 'CARAVAN_RAIDED', tone: 'gain', seq: 5 } }), null, 'our own raid');
  assert.deepEqual(of({ id: 'aw:6', kind: 's1', awayOf: { kind: 'SIEGE_DECLARED', seq: 6, at: { p: 3, q: 4 } } }), { kind: 'attacked', key: 'siege:3,4' });
  assert.equal(of({ id: 'aw:7', kind: 's1', awayOf: { kind: 'VAULT_SEIZED', tone: 'loss', seq: 7 } }).kind, 'attacked');
  assert.equal(of({ id: 'aw:8', kind: 's1', awayOf: { kind: 'CAPTURE_SETTLED', tone: 'loss', seq: 8, at: { p: 3, q: 4 } } }).key, 'lost:3,4');
});

test('how a new event is told: front → the card only; behind → system if allowed and on, else the title count; off → nothing', () => {
  const prefs = { enabled: true, on: { ...notify.NOTIFY_DEFAULTS } };
  assert.equal(notify.channelFor({ kind: 'attacked', prefs, focused: true, permission: 'granted' }), 'toast');
  assert.equal(notify.channelFor({ kind: 'attacked', prefs, focused: false, permission: 'granted' }), 'system');
  assert.equal(notify.channelFor({ kind: 'attacked', prefs, focused: false, permission: 'denied' }), 'badge');
  assert.equal(notify.channelFor({ kind: 'attacked', prefs, focused: false, permission: 'unsupported' }), 'badge');
  assert.equal(notify.channelFor({ kind: 'attacked', prefs: { ...prefs, enabled: false }, focused: false, permission: 'granted' }), 'badge', 'allowed but turned off here');
  assert.equal(notify.channelFor({ kind: 'incoming', prefs, focused: false, permission: 'granted' }), null, 'opt-in kind left off');
  assert.equal(notify.badgeTitle('Wylls', 2), '(2) Wylls');
  assert.equal(notify.badgeTitle('(2) Wylls', 3), '(3) Wylls');
  assert.equal(notify.badgeTitle('(3) Wylls', 0), 'Wylls');
  assert.equal(notify.badgeTitle('Wylls', 120), '(99+) Wylls');
});

test('the notifier: the first look is no news, one notice per event, a system notice behind, the count when refused', () => {
  setLang('ja');
  const prefs = { enabled: true, on: { ...notify.NOTIFY_DEFAULTS } };
  const env = env0({ permission: 'granted' });
  const n = notify.createNotifier({ env, prefs: () => prefs });
  const old = [{ id: 'kp:keep_taken:1', side: 'loss', p: 0, q: 1, text: 'old' }];
  assert.deepEqual(n.observe(old, { bell: 100 }), [], 'what was there when the page opened');
  // a contest told by the keep events, then by the herald's alert: one notice
  let feed = [{ id: 'kp:keep_contest:4', side: 'defend', p: 1, q: 2, text: '砦が攻められた' }, ...old];
  let got = n.observe(feed, { bell: 101 });
  assert.equal(got.length, 1);
  assert.equal(got[0].channel, 'system');
  assert.equal(env.shown.length, 1);
  assert.equal(env.shown[0].tag, 'wylls:contest:1,2', 'the tag lets the browser replace, not stack, the same event');
  assert.equal(env.shown[0].body, '砦が攻められた');
  assert.match(env.shown[0].t, /攻撃を受けました — Wylls/);
  assert.equal(env.title(), '(1) Wylls');
  feed = [{ id: 'al:keep_contest:4', notice: { kind: 'attacked', key: 'contest:1,2' }, text: 'x' }, ...feed];
  assert.deepEqual(n.observe(feed, { bell: 101 }), [], 'the same event from another source');
  assert.ok(n.toldRecently('contest:1,2', 103));
  assert.ok(!n.toldRecently('contest:1,2', 101 + notify.DEDUP_BELLS));
  // the same line again (feed re-render) is never told twice
  assert.deepEqual(n.observe(feed, { bell: 102 }), []);
  // an opt-in kind left off: nothing
  feed = [{ id: 'in:110,1,2', kind: 'incoming', text: 'y' }, ...feed];
  assert.deepEqual(n.observe(feed, { bell: 102 }), []);
  // a report ready, and its result to collect later: one notice
  feed = [{ id: 'rs:9', kind: 'battle', text: 'z' }, ...feed];
  assert.equal(n.observe(feed, { bell: 103 }).length, 1);
  feed = [{ id: 'st:9', kind: 'march', text: 'z2' }, ...feed];
  assert.deepEqual(n.observe(feed, { bell: 104 }), []);
  assert.equal(n.badge(), 2);
  n.clearBadge();
  assert.equal(env.title(), 'Wylls');
  // the away summary of what happened before the page opened is no event of now
  feed = [{ id: 'aw:3', kind: 's1', awayOf: { kind: 'VAULT_SEIZED', tone: 'loss', seq: 3, bell: 90 }, text: 'w' }, ...feed];
  assert.deepEqual(n.observe(feed, { bell: 104 }), []);
  feed = [{ id: 'aw:4', kind: 's1', awayOf: { kind: 'VAULT_SEIZED', tone: 'loss', seq: 4, bell: 104 }, text: 'w2' }, ...feed];
  assert.equal(n.observe(feed, { bell: 104 }).length, 1);
});

test('the notifier: in front, a toast only (no system notice, no count); refused permission, the count only', () => {
  const prefs = { enabled: true, on: { ...notify.NOTIFY_DEFAULTS } };
  const front = env0({ focused: true, permission: 'granted' });
  const a = notify.createNotifier({ env: front, prefs: () => prefs });
  a.observe([], { bell: 1 });
  assert.equal(a.observe([{ id: 'rs:1', kind: 'battle', text: 'r' }], { bell: 2 })[0].channel, 'toast');
  assert.equal(front.shown.length, 0);
  assert.equal(front.title(), 'Wylls');
  const denied = env0({ permission: 'denied' });
  const b = notify.createNotifier({ env: denied, prefs: () => prefs });
  b.observe([], { bell: 1 });
  assert.equal(b.observe([{ id: 'rs:1', kind: 'battle', text: 'r' }], { bell: 2 })[0].channel, 'badge');
  assert.equal(denied.shown.length, 0);
  assert.equal(denied.title(), '(1) Wylls');
});

test('the watch: herald alerts, a host ready again and unpaid upkeep are news only after a first read', () => {
  setLang('ja');
  const names = { village: (p, q, s) => `村${p}${q}${s}`, province: (p, q) => `州${p}${q}` };
  const w = notify.createWatch();
  assert.deepEqual(w.alerts(null, names), [], 'not a conquest world');
  assert.deepEqual(w.alerts([{ v: 1, kind: 'horn', bell: 5, p: 1, q: 2, site: 3, faction: 2, seq: '7' }], names), [], 'the first read is what was so');
  const fresh = w.alerts([{ v: 1, kind: 'horn', bell: 5, p: 1, q: 2, site: 3, faction: 2, seq: '7' }, { v: 1, kind: 'captured', bell: 9, p: 1, q: 2, site: 3, faction: 2, seq: '8' }, { v: 1, kind: 'liberated', bell: 9, p: 1, q: 2, site: 3, seq: '9' }], names);
  assert.equal(fresh.length, 1, 'only the new one, and a liberation is no attack');
  assert.equal(fresh[0].id, 'al:captured:8');
  assert.deepEqual(fresh[0].notice, { kind: 'attacked', key: 'lost:1,2' });
  assert.match(fresh[0].words.ja, /村123を.+に奪われました（ターン 9）/);
  assert.match(fresh[0].words.en, /^.+ took 村123 \(turn 9\)$/, 'English words (the stub names the place in Japanese)');
  assert.deepEqual(w.hosts([{ id: 1, ready: true, village: 'A', p: 0, q: 0 }], 10), [], 'first read');
  assert.deepEqual(w.hosts([{ id: 1, ready: true, village: 'A' }, { id: 2, ready: true, village: 'A' }], 11), [], 'a host first seen ready was just mustered');
  assert.deepEqual(w.hosts([{ id: 1, ready: false, busy: true, village: 'A' }, { id: 2, ready: true, village: 'A' }, { id: 3, ready: false, busy: false, village: 'A' }], 12), []);
  const back = w.hosts([{ id: 1, ready: true, village: 'A', p: 0, q: 0 }, { id: 2, ready: true, village: 'A' }, { id: 3, ready: true, village: 'A' }], 13);
  // (host 3 only waited for its muster — not busy —: a host just formed is not "ready again"; live, pt-notify)
  assert.equal(back.length, 1);
  assert.equal(back[0].id, 'hr:1:13');
  assert.deepEqual(notify.noticeOf(back[0]), { kind: 'hostReady', key: 'hr:1:13' });
  assert.deepEqual(w.upkeep(null, 1), []);
  assert.deepEqual(w.upkeep({ unpaid: false }, 2), []);
  const up = w.upkeep({ unpaid: true, turnsLeft: 4 }, 3);
  assert.equal(up.length, 1);
  assert.equal(notify.noticeOf(up[0]).kind, 'upkeep');
  assert.deepEqual(w.upkeep({ unpaid: true, turnsLeft: 3 }, 4), [], 'still unpaid: told once');
});

test('the words: every kind has a label and a title in both languages; English has no Japanese and no "season"', () => {
  for (const l of ['ja', 'en']) {
    setLang(l);
    for (const k of notify.NOTIFY_KINDS) {
      for (const s of [notify.KIND_LABEL[k](), notify.KIND_TITLE[k]()]) {
        assert.ok(s.length > 2);
        if (l === 'en') assert.doesNotMatch(s, /[぀-ヿ一-鿿]/, s);
        assert.doesNotMatch(s, /season|シーズン/i);
      }
    }
    for (const st of ['granted', 'denied', 'default', 'unsupported']) for (const en of [true, false]) {
      const s = notify.permissionText(st, en);
      if (l === 'en') assert.doesNotMatch(s, /[぀-ヿ一-鿿]/, s);
    }
  }
  setLang('ja');
});

test('the permission is asked only from the player\'s press, never on load', async () => {
  const app = src('app.mjs');
  const asks = [...app.matchAll(/askPermission\(|requestPermission\(/g)].map(m => app.slice(app.lastIndexOf('\n', m.index), m.index));
  assert.equal(asks.length, 1);
  assert.match(asks[0], /'notify-enable': async \(\) =>/);
  assert.match(src('hud/notify.mjs'), /Notification\.permission !== 'default'\) return/);
  // (verify-pr262: the card reads the browser's permission as it is now, not the answer kept from the press)
  assert.match(app, /const st = typeof globalThis\.Notification === 'function' \? globalThis\.Notification\.permission : \(FS\.notifyPermission \?\? 'unsupported'\);/);
  // a stub browser: asking when already decided does not prompt
  let prompted = 0;
  const g = { Notification: Object.assign(function () {}, { permission: 'denied', requestPermission: async () => { prompted++; return 'granted'; } }) };
  assert.equal(await notify.askPermission(g), 'denied');
  assert.equal(prompted, 0);
  g.Notification.permission = 'default';
  assert.equal(await notify.askPermission(g), 'granted');
  assert.equal(prompted, 1);
  assert.equal(await notify.askPermission({}), 'unsupported');
});

test('no new reads and nothing sent: the two modules make no request, the page reads alerts from the /h/me answer it has', () => {
  for (const f of ['hud/notify.mjs', 'hud/calendar.mjs']) {
    const s = src(f).split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
    assert.doesNotMatch(s, /\bfetch\(|XMLHttpRequest|WebSocket|sendBeacon|navigator\.|serviceWorker|PushManager/, f);
  }
  const c = src('controller.mjs');
  assert.ok(c.includes('FS.meAlerts = Array.isArray(me.record?.alerts) ? me.record.alerts : null;'));
  assert.ok(c.includes("if (hidden() && !FS.notifyBackground) await revealTick(); else await refresh();"), 'a hidden tab reads in full only for a player who turned notices on');
  // (only a player who turned notices on — browser notifications or, refused, the title count — keeps a hidden tab reading)
  assert.ok(src('app.mjs').includes('FS.notifyBackground = notifyPrefs.enabled && notify.NOTIFY_KINDS.some(k => notifyPrefs.on[k]);'));
});

// ------------------------------------------------------------------ the calendar
const G = 1_800_000_000; // genesis (chain unix seconds)
function fixtureFS({ rate = 1, bell = 100 } = {}) {
  const chainNow = G + bell * BELL_SECS + 30;
  const holding = { p: 1, q: 0, site: 2, gen: 0, tier: 0, state: 2, transit: [] };
  const id = hostId({ p: 1, q: 0, site: 2, gen: 0, seq: 1 });
  const entries = [{ id, state: 1, unit: 0, tile: 5, troops: 200_000, staminaValue: 20, staminaBell: bell, readyBell: 0, pendOp: 0, fromBell: 0 }];
  const province = { p: 1, q: 0, entries, layoutVersion: 2, resolvedNext: bell, keep: { tile: 30, holder: 3, troops: 1, flags: 0, consolidatedUntilBell: 0, contender: 0, progress: 2, required: 6 } };
  return {
    clock: { genesisTs: G },
    chain: { now: () => chainNow, rate },
    nowBell: bell,
    citizen: { faction: 0 },
    holdings: [holding],
    provinces: new Map([['1,0', { province }]]),
    marches: [{ entry: { host: 'h77', arriveBell: bell + 3 }, dest: { p: 2, q: 0 }, facts: { pipeline: 'sealed' } }],
    ownLand: { player: { tiles: 5, unpaid: true, unpaidSince: bell - 1, upkeepMilliPerHour: 100 } },
  };
}

test('the calendar: the player\'s own timers from the page\'s state, wall times by the chain clock (×1 and ×60)', () => {
  setLang('ja');
  const nowMs = Date.UTC(2026, 10, 26, 6, 0, 0);
  const FS = fixtureFS();
  const evs = cal.calendarEvents(FS, { nowMs });
  const kinds = evs.map(e => e.kind).sort();
  assert.deepEqual(kinds, ['hostReady', 'keepHold', 'marchArrival', 'reportDue', 'upkeep'].sort());
  const chainNow = FS.chain.now();
  const arrival = evs.find(e => e.kind === 'marchArrival');
  assert.equal(arrival.startMs, nowMs + ((G + 103 * BELL_SECS) - chainNow) * 1000);
  assert.equal(arrival.uid, 'marchArrival-h77@wylls.invalid', 'one UID per subject: a newer file moves the event');
  const report = evs.find(e => e.kind === 'reportDue');
  assert.equal(report.startMs, nowMs + ((G + 104 * BELL_SECS + cal.REPORT_LAG_SECS) - chainNow) * 1000);
  const host = evs.find(e => e.kind === 'hostReady');
  const DEPART = 10 + 2 * 32; // fmarch DEPART_STAMINA with MAX_PATH_STEPS 32
  assert.ok(host.bell >= 100 + (DEPART - 20) - 40 && host.bell > 100, 'rests until it can make the longest march');
  for (let i = 1; i < evs.length; i++) assert.ok(evs[i].startMs >= evs[i - 1].startMs, 'soonest first');
  // a fast local world: 60 chain seconds a wall second
  const fast = cal.calendarEvents(fixtureFS({ rate: 60 }), { nowMs });
  const fa = fast.find(e => e.kind === 'marchArrival');
  assert.equal(fa.startMs, nowMs + Math.round(((G + 103 * BELL_SECS) - chainNow) * 1000 / 60));
  // a stopped world: no times
  assert.deepEqual(cal.calendarEvents(fixtureFS({ rate: 0 }), { nowMs }), []);
  assert.equal(cal.calendarBlocked(fixtureFS({ rate: 0 })), 'stopped');
  assert.equal(cal.calendarBlocked({}), 'noClock');
  // the keep: our nation (0) is the contender → capture timer; the holder's view is a fall timer
  const def = fixtureFS();
  def.citizen.faction = 3;
  assert.ok(cal.calendarEvents(def, { nowMs }).some(e => e.kind === 'keepFall'));
  assert.ok(!cal.calendarEvents(def, { nowMs }).some(e => e.kind === 'keepHold'));
  // a resolved march has no timers
  const done = fixtureFS();
  done.marches[0].facts.pipeline = 'resolved';
  assert.ok(!cal.calendarEvents(done, { nowMs }).some(e => e.kind === 'marchArrival' || e.kind === 'reportDue'));
});

test('the .ics: RFC 5545 shape (CRLF, folded at 75 octets, escaped text), both languages in each title, no "season"', () => {
  setLang('en');
  const nowMs = Date.UTC(2026, 10, 26, 6, 0, 0);
  const evs = cal.calendarEvents(fixtureFS(), { nowMs });
  const text = cal.icsText(evs, { nowMs });
  assert.ok(text.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:'));
  assert.ok(text.endsWith('END:VCALENDAR\r\n'));
  assert.doesNotMatch(text.replace(/\r\n/g, ''), /\n/, 'every line ends CRLF');
  for (const line of text.split('\r\n')) assert.ok(new TextEncoder().encode(line).length <= 75, `folded: ${line}`);
  const unfolded = text.replace(/\r\n /g, '');
  assert.equal((unfolded.match(/BEGIN:VEVENT/g) ?? []).length, evs.length);
  assert.equal((unfolded.match(/BEGIN:VALARM/g) ?? []).length, evs.length);
  assert.match(unfolded, /DTSTAMP:20261126T060000Z/);
  const summaries = unfolded.split('\r\n').filter(l => l.startsWith('SUMMARY:'));
  assert.equal(summaries.length, evs.length);
  for (const s of summaries) {
    assert.match(s, /^SUMMARY:Wylls: .+ \/ Wylls：/, 'English first on an English page, then the Japanese');
    assert.match(s, /[぀-ヿ一-鿿]/);
  }
  assert.doesNotMatch(unfolded, /season|シーズン/i);
  assert.match(unfolded, /X-WR-CALNAME:Wylls timers \/ Wylls の予定/);
  // a wallet address, a key or a URL never goes into the file
  assert.doesNotMatch(unfolded, /https?:|[1-9A-HJ-NP-Za-km-z]{32,44}/);
  setLang('ja');
  const ja = cal.icsText(evs, { nowMs }).replace(/\r\n /g, '');
  assert.match(ja, /SUMMARY:Wylls：.+ \/ Wylls: /, 'Japanese first on a Japanese page');
  assert.equal(cal.icsEscape('a,b;c\\d\ne'), 'a\\,b\\;c\\\\d\\ne');
  const folded = cal.icsFold(`SUMMARY:${'あ'.repeat(40)}`);
  assert.ok(folded.split('\r\n ').every(p => new TextEncoder().encode(p).length <= 75));
  assert.equal(folded.replace(/\r\n /g, ''), `SUMMARY:${'あ'.repeat(40)}`, 'never split inside a character');
  assert.match(cal.icsFileName(nowMs), /^wylls-timers-\d{8}-\d{4}\.ics$/);
});
