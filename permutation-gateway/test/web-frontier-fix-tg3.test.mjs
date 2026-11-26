// fix-tg3 — owner-default answers to test-gaps-3's Q-TG3-1..3 (recommended options, nothing live: the herald change is
// not deployed and nation chat is not on devnet). Key-free: nothing is signed, no wallet, no network.
//   T1 (Q-TG3-1 (a)) the nation chat's "empty" / "trim" rule is ONE rule on the page and the herald: explicit lists
//      (no language's own trim), shared vectors (frontier-node/crates/herald/tests/vectors/chat-invisible.json, which the
//      herald's lib test `invisible_rule_is_the_vectors` checks too), every Unicode scalar value in five templates.
//   T2 (Q-TG3-2 (a)) the .ics report time is the wait panel's figure (firstbattle reportEtaAt), the only estimate.
//   T3 (Q-TG3-3) the .ics times follow the panel's pace (seasonterms termsRate via screens/shell.mjs wallOf): none while
//      a fast clock's pace is unknown ("never a guess"), the launcher's stated pace when it gives one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setLang } from '../../permutation-server/web/lang.mjs';
import * as chat from '../../permutation-server/web/frontier/hud/nationchat.mjs';
import * as cal from '../../permutation-server/web/frontier/hud/calendar.mjs';
import { reportEtaAt } from '../../permutation-server/web/frontier/hud/firstbattle.mjs';
import { wallOf, setChainNow } from '../../permutation-server/web/frontier/screens/shell.mjs';
import { setTermsPace } from '../../permutation-server/web/frontier/seasonterms.mjs';
import { BELL_SECS, bellEnd, bellStart } from '../../permutation-server/web/frontier/clock.mjs';
import { build, render, FILE, LETTER, TEMPLATES } from '../../frontier-node/crates/herald/tests/vectors/make-chat-invisible.mjs';

const ROOT = new URL('../../', import.meta.url);
const src = p => readFileSync(new URL(p, ROOT), 'utf8');
const rangesOf = pred => {
  const out = [];
  for (let u = 0; u < 0x110000; u++) {
    if (u >= 0xD800 && u <= 0xDFFF) continue;
    if (!pred(String.fromCodePoint(u))) continue;
    const l = out[out.length - 1];
    if (l && l[1] === u - 1) l[1] = u; else out.push([u, u]);
  }
  return out;
};
/** A `pub const NAME: &[(u32, u32)] = &[...]` of chat.rs, read as numbers. */
function rustRanges(text, name) {
  const m = text.match(new RegExp(`pub const ${name}: &\\[\\(u32, u32\\)\\] = &\\[([\\s\\S]*?)\\];`));
  assert.ok(m, `chat.rs has ${name}`);
  return [...m[1].matchAll(/\((0x[0-9A-Fa-f]+),\s*(0x[0-9A-Fa-f]+)\)/g)].map(x => [Number(x[1]), Number(x[2])]);
}

// ------------------------------------------------------------------ T1
test('T1 chat: one "empty" / "trim" rule on the page and the herald (shared vectors, every scalar value)', () => {
  const v = JSON.parse(readFileSync(FILE, 'utf8'));
  // the vectors are the page's rule as it is now (stale file = the generator was not re-run)
  assert.equal(readFileSync(FILE, 'utf8'), render(build()), 'chat-invisible.json = make-chat-invisible.mjs on the page\'s rule');
  // the herald's lists are the same numbers (its lib test also checks every code against this file)
  const rs = src('frontier-node/crates/herald/src/chat.rs');
  assert.deepEqual(rustRanges(rs, 'TRIM_RANGES'), v.trim, 'chat.rs TRIM_RANGES = the vectors');
  assert.deepEqual(rustRanges(rs, 'INVISIBLE_RANGES'), v.invisible, 'chat.rs INVISIBLE_RANGES = the vectors');
  // neither side's own trim decides any more
  const tp = rs.slice(rs.indexOf('pub fn text_problem('), rs.indexOf('/// Top-level names'));
  assert.doesNotMatch(tp, /\.trim\(\)/, 'chat.rs text_problem uses no str::trim');
  const page = src('permutation-server/web/frontier/hud/nationchat.mjs');
  const tpj = page.slice(page.indexOf('export function textProblem('), page.indexOf('export function codeText('));
  assert.doesNotMatch(tpj, /\.trim\(\)/, 'nationchat textProblem uses no String#trim');
  assert.match(page, /const t = trimText\(text\.value\);/, 'the page trims what it sends by the same list');
  assert.doesNotMatch(page, /text\.value\.trim\(\)/);
  // the lists are what they say: trim = JS trim ∪ Rust char::is_whitespace (Unicode White_Space); invisible =
  // Default_Ignorable_Code_Point ∪ U+2800
  const ws = rangesOf(ch => ch.trim() === '' || /^\p{White_Space}$/u.test(ch));
  assert.deepEqual(chat.TRIM_RANGES.map(r => [...r]), ws, `trim = JS trim ∪ White_Space (Unicode ${process.versions.unicode})`);
  const di = rangesOf(ch => /^\p{Default_Ignorable_Code_Point}$/u.test(ch) || ch === '⠀');
  assert.deepEqual(chat.INVISIBLE_RANGES.map(r => [...r]), di, `invisible = Default_Ignorable ∪ U+2800 (Unicode ${process.versions.unicode})`);
  // every scalar value: the page's code in every template = the file's (an independent re-derivation of the runs)
  const letterAt = new Map();
  for (const [a, b, k] of v.outcomes) for (const u of [a, b, Math.floor((a + b) / 2)]) letterAt.set(u, k);
  let checked = 0;
  for (const [a, b, k] of v.outcomes) {
    for (let u = a; u <= b; u += Math.max(1, Math.floor((b - a) / 64))) {
      if (u >= 0xD800 && u <= 0xDFFF) continue;
      const ch = String.fromCodePoint(u);
      const got = TEMPLATES.map(t => LETTER[chat.textProblem([...t].map(x => (x === 'c' ? ch : x)).join(''))]).join('');
      assert.equal(got, k, `U+${u.toString(16)} in ${TEMPLATES}`);
      checked++;
    }
  }
  assert.ok(checked > 1000);
  // the hand cases (Q-TG3-1): invisible-only texts are empty, U+FEFF trimmed on both sides, invisibles inside kept
  for (const { text, code } of v.cases) assert.equal(chat.textProblem(text), code, JSON.stringify(text));
  for (const t of ['﻿', '​', '⁠', 'ㅤ', '⠀', '​⁠ㅤ⠀']) assert.equal(chat.textProblem(t), 'EmptyText', JSON.stringify(t));
  assert.equal(chat.textProblem('﻿hi'), 'UntrimmedText');
  assert.equal(chat.trimText(' ﻿hi\u0085 '), 'hi');
  assert.equal(chat.trimText('​hi'), '​hi', 'an invisible character is no space: kept');
  // and a refused-empty text says so in both languages
  setLang('en');
  assert.equal(chat.codeText('EmptyText'), 'Write something before you send.');
  setLang('ja');
  assert.equal(chat.codeText('EmptyText'), '何か書いてから送ってください');
});

// ------------------------------------------------------------------ calendar fixture
const G = 1_800_000_000;
function fixtureFS({ rate = 1, bell = 100, accelerated = rate !== 1, rateKnown = true, arrive = bell + 3, window = 600, margin = 60 } = {}) {
  const chainNow = G + bell * BELL_SECS + 30;
  return {
    clock: { genesisTs: G, window: () => window, margin },
    chain: { now: () => chainNow, rate, accelerated, rateKnown },
    nowBell: bell,
    citizen: { faction: 0 },
    holdings: [],
    provinces: new Map(),
    marches: [{ entry: { host: 'h77', arriveBell: arrive }, dest: { p: 2, q: 0 }, facts: { pipeline: 'sealed' } }],
  };
}
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }

// ------------------------------------------------------------------ T2
test('T2 .ics: the report time IS the wait panel\'s (reportEtaAt), at every pace, window and margin', () => {
  const r = rng(2622);
  assert.equal(cal.REPORT_LAG_SECS, undefined, 'no calendar-only lag any more');
  assert.doesNotMatch(src('permutation-server/web/frontier/hud/calendar.mjs'), /REPORT_LAG|\+ 90\b/);
  try {
    for (const pace of [1, 1.04, 30, 60]) {
      for (let i = 0; i < 150; i++) {
        const bell = 50 + Math.floor(r() * 500), arrive = bell + 1 + Math.floor(r() * 40);
        const FS = fixtureFS({ rate: pace, bell, arrive, window: [600, 300, 120, 0][i % 4], margin: [60, 30, 0][i % 3] });
        setTermsPace(() => pace);
        setChainNow(() => FS.chain.now());
        const nowMs = 1_790_000_000_000 + Math.floor(r() * 1e9);
        const ev = cal.calendarEvents(FS, { nowMs }).find(e => e.kind === 'reportDue');
        const at = reportEtaAt(FS.clock, arrive);
        assert.equal(at, bellEnd(G, arrive) + FS.clock.window() + FS.clock.margin + 60);
        assert.ok(ev, 'a report event');
        assert.equal(ev.startMs, Math.round(wallOf(at, null, nowMs) * 1000), `×${pace}: the .ics report = the panel's wall time of reportEtaAt`);
      }
    }
    // at the natural clock with the rules' 600 s window: 720 s after the arrival turn (was 90 s: ~10½ min early)
    setTermsPace(() => 1);
    const FS = fixtureFS();
    setChainNow(() => FS.chain.now());
    const nowMs = 1_790_000_000_000;
    const ev = cal.calendarEvents(FS, { nowMs }).find(e => e.kind === 'reportDue');
    assert.equal(ev.startMs - nowMs, (bellEnd(G, 103) + 720 - FS.chain.now()) * 1000);
    // a clock without a window (none read): no report time is made up
    const bare = fixtureFS();
    bare.clock = { genesisTs: G };
    assert.ok(!cal.calendarEvents(bare, { nowMs }).some(e => e.kind === 'reportDue'), 'no window known → no report event');
    assert.ok(cal.calendarEvents(bare, { nowMs }).some(e => e.kind === 'marchArrival'), 'the arrival still is');
  } finally { setTermsPace(() => 1); setChainNow(null); }
});

// ------------------------------------------------------------------ T3
test('T3 .ics: the panel\'s pace — no times while a fast clock\'s pace is unknown, the stated pace when given', () => {
  const nowMs = 1_790_000_000_000;
  try {
    // ×60 world, pace not measured, no stated pace: the panel says no clock time, the calendar writes none
    const FS = fixtureFS({ rate: 1, accelerated: true, rateKnown: false });
    setTermsPace(() => null);
    setChainNow(() => FS.chain.now());
    assert.equal(wallOf(FS.chain.now() + 600), null, 'the panel: no wall time');
    assert.equal(cal.calendarBlocked(FS), 'paceUnknown');
    assert.deepEqual(cal.calendarEvents(FS, { nowMs }), [], 'the calendar: no guess either');
    assert.equal(cal.wallMsOf(FS, FS.chain.now() + 600, nowMs), null);
    // the launcher states ×60 (app.mjs setTermsPace uses it while the measured pace is unknown): both say ×60
    setTermsPace(() => 60);
    assert.equal(cal.calendarBlocked(FS), null);
    const evs = cal.calendarEvents(FS, { nowMs });
    const arr = evs.find(e => e.kind === 'marchArrival');
    assert.equal(arr.startMs, Math.round(wallOf(bellStart(G, 103), null, nowMs) * 1000));
    assert.equal(arr.startMs, nowMs + Math.round((bellStart(G, 103) - FS.chain.now()) * 1000 / 60), '×60, not the placeholder ×1');
    // random paces: every event's time = the panel's wall time of the same chain moment (or none, when the panel has none)
    const r = rng(33);
    for (let i = 0; i < 400; i++) {
      const pace = [1, 1.04, 30, 60, null][i % 5];
      const F = fixtureFS({ rate: pace ?? 1, accelerated: pace !== 1, rateKnown: pace !== null, bell: 40 + Math.floor(r() * 300) });
      setTermsPace(() => pace);
      setChainNow(() => F.chain.now());
      const t = F.chain.now() + 1 + Math.floor(r() * 30_000);
      const panel = wallOf(t, null, nowMs);
      const mine = cal.wallMsOf(F, t, nowMs);
      if (panel === null) { assert.equal(mine, null); assert.deepEqual(cal.calendarEvents(F, { nowMs }), []); } else assert.equal(mine, Math.round(panel * 1000));
    }
    // a stopped world still says 'stopped' (rate 0), whatever the pace function answers
    setTermsPace(() => 1);
    assert.equal(cal.calendarBlocked(fixtureFS({ rate: 0, accelerated: true })), 'stopped');
  } finally { setTermsPace(() => 1); setChainNow(null); }
  // the More drawer says why (JA + EN), with no "season"
  const app = src('permutation-server/web/frontier/app.mjs');
  assert.match(app, /blocked === 'paceUnknown' \? L`この世界の時計の速さを測っています。速さが分かるまで、予定の時刻は出しません。`/);
  const en = src('permutation-server/web/lang/en-frontier-play.mjs');
  const line = en.split('\n').find(l => l.includes('この世界の時計の速さを測っています。'));
  assert.ok(line && /Measuring how fast this world's clock runs/.test(line) && !/season/i.test(line));
});
