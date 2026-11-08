// Workstream 07: the world does not end with a period (the project's direction). The page says this program's end
// turn as the program's — an old-style season's — and never as the world ending or starting over; the world's
// continuity and the war period (戦期) are said apart, and only from what their owners register (hud/worldclock.mjs);
// and the page's own state — the away summary's mark, its book of caravans, an arrival — goes on across a period's
// boundary and across a restart, with nothing told twice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LOGS } from '../../permutation-server/web/sdk/frontier/abi-v2-logs.mjs';
import { toBase64 } from '../../permutation-server/web/sdk/bytes.mjs';
import { decodeRecord } from '../../permutation-server/web/frontier/flog.mjs';
import * as T from '../../permutation-server/web/frontier/seasonterms.mjs';
import * as WC from '../../permutation-server/web/frontier/hud/worldclock.mjs';
import * as RS from '../../permutation-server/web/frontier/hud/returnsum.mjs';
import * as RW from '../../permutation-server/web/frontier/hud/returnwords.mjs';
import * as RR from '../../permutation-server/web/frontier/hud/awayread.mjs';
import enPlay from '../../permutation-server/web/lang/en-frontier-play.mjs';
import enFrontier from '../../permutation-server/web/lang/en-frontier.mjs';
import { setLang } from '../../permutation-server/web/lang.mjs';

const G = 1_800_000_000;
const FSat = bell => ({ season: { genesisTs: G, endBell: 2016, joinCloseBell: 1512 }, clock: { genesisTs: G }, chain: { now: () => G + bell * 600 + 1 } });

test('with nothing registered, the page says only the program\'s facts: its end turn, as an old-style season\'s, never the world\'s', () => {
  setLang('ja');
  assert.deepEqual(WC.worldLines(FSat(100)), [], 'no "the world goes on" and no war period from a guess');
  assert.equal(WC.renderWorldLines(FSat(100)), '');
  assert.match(T.deadlineLine(FSat(100)), /このプログラム（旧方式のシーズン）が新しい命令を受け付けるのは第2,016ターンまでです/);
  assert.match(T.deadlineLine(FSat(2100)), /このプログラム（旧方式のシーズン）は第2,016ターンで新しい命令の受付を終えました/);
  for (const t of [T.deadlineLine(FSat(100)), T.deadlineLine(FSat(2100)), T.wrongStatusWhy(FSat(2100), 'build')]) assert.doesNotMatch(t, /世界が終わ|世界は終わ|リセット|作り直|シーズンは終わり|シーズンは第[\d,]+ターンで終わ/);
});

test('when 04/08 register that the world goes on, the end turn is not said and WrongStatus is not put down to it; the world\'s line and the war period\'s stand apart', () => {
  setLang('ja');
  const off1 = WC.registerWorldSource('continuity', () => ({ continuous: true }));
  const off2 = WC.registerWorldSource('warPeriod', () => ({ fromBell: 2017, toBell: 3024 }));
  try {
    assert.doesNotMatch(T.deadlineLine(FSat(2100)), /このプログラム|第2,016ターン/);
    assert.equal(T.wrongStatusWhy(FSat(2100), 'build'), null);
    const lines = WC.worldLines(FSat(2100));
    assert.deepEqual(lines.map(x => x.key), ['world', 'warPeriod']);
    assert.equal(lines[0].text, '世界：期間の区切りで終わったり作り直したりしません');
    assert.equal(lines[1].text, '戦期：第2,017〜3,024ターン。集計の方法は未決定です（世界はこの区切りで終わりません）', 'no tally or prize is made up');
    assert.match(String(WC.renderWorldLines(FSat(2100))), /<li data-key="world">[^<]*<\/li><li data-key="warPeriod">/);
  } finally { off1(); off2(); }
  const off3 = WC.registerWorldSource('warPeriod', () => ({ fromBell: 1, toBell: 9, label: '第一戦期', tally: '州の保持時間' }));
  try { assert.equal(WC.worldLines(FSat(5))[0].text, '第一戦期：第1〜9ターン。集計：州の保持時間（世界はこの区切りで終わりません）'); } finally { off3(); }
  const bad = WC.registerWorldSource('continuity', () => { throw new Error('x'); });
  try { assert.deepEqual(WC.worldLines(FSat(5)), []); assert.match(T.deadlineLine(FSat(5)), /このプログラム/); } finally { bad(); }
  assert.throws(() => WC.registerWorldSource('season', () => null), TypeError);
});

test('the words the page keeps say no world end or reset: the dial, the conquest card, the map, the quota, the away summary', () => {
  const src = f => readFileSync(new URL(`../../permutation-server/web/frontier/${f}`, import.meta.url), 'utf8');
  assert.match(src('app.mjs'), /L`ターン \$\{fmtNum\(chip\.bell\)\} · 受付終了`/);
  assert.match(src('hud/provstrip.mjs'), /L`この征服戦（旧方式のシーズン）は終わりました`/);
  assert.match(src('map/world.mjs'), /L`ここはいまの地図の外です`/);
  for (const f of ['seasonterms.mjs', 'hud/worldclock.mjs', 'hud/returnwords.mjs', 'hud/provstrip.mjs', 'map/world.mjs', 'hud/dialcard.mjs', 'hud/glossary.mjs']) {
    const strings = [...src(f).matchAll(/L`([^`]*)`/g)].map(m => m[1]);
    for (const s of strings) assert.doesNotMatch(s, /世界が終わ|世界は終わ(?!り)|リセット|新しいシーズンです|シーズンは終わりました|このシーズンの地図/, `${f}: ${s}`);
  }
  const values = [...Object.values(enPlay), ...Object.values(enFrontier)].map(v => (typeof v === 'function' ? v(2, 2, 2, 2) : v));
  for (const v of values) assert.doesNotMatch(v, /\bA new season\. Nothing of the earlier season\b|\bthis season.s map\b|^The season is over$|season's day rolls over/, v);
});

// ---------------------------------------------------------------- the page's own state across a period's boundary and a restart
function body(name, bell, fields = {}) {
  const spec = LOGS.kinds.find(k => k.name === name), parts = [...spec.key, ...spec.payload];
  const b = new Uint8Array(6 + parts.reduce((a, f) => a + f.len, 0) + 1), v = new DataView(b.buffer);
  b[0] = 1; b[1] = spec.kind; v.setUint32(2, bell, true);
  let o = 6;
  for (const f of parts) { const x = fields[f.name]; if (x instanceof Uint8Array) b.set(x.subarray(0, f.len), o); else if (x !== undefined) { if (f.len === 8) v.setBigUint64(o, BigInt(x), true); else if (f.len === 4) v.setInt32(o, Number(x), true); else if (f.len === 2) v.setUint16(o, Number(x), true); else if (f.len === 1) b[o] = Number(x); } o += f.len; }
  return toBase64(b);
}
const cargo = arr => { const b = new Uint8Array(32), v = new DataView(b.buffer); arr.forEach((n, i) => v.setUint32(i * 4, n, true)); return b; };
const ev = (seq, name, bell, f) => ({ seq: String(seq), bell, body_b64: body(name, bell, f) });
const F400 = [400, 0, 0, 0, 0, 0, 0, 0];
// a war period ends at turn 300 (as a source would say); the world, its records and their seq go on through it
const BOUNDARY = 300;
const H = [
  ev(101, 'CARAVAN_SENT', 295, { owner_tag: 5, seq: 2, faction: 1, dst: 1, cargo: cargo(F400) }),
  ev(102, 'SIEGE_DECLARED', 298, { p: 0, q: 0, site: 0, attacker: 3, owner_faction: 1, owner_tag: 5, required: 44 }),
  ev(103, 'CARAVAN_SETTLED', 304, { owner_tag: 5, seq: 2, outcome: 0, dst: 1, cargo: cargo(F400) }),
  ev(104, 'SIEGE_DECLARED', 306, { p: 0, q: 0, site: 0, attacker: 4, owner_faction: 1, owner_tag: 5, required: 40 }),
];
const me = { tag: 5n, faction: 1, holdings: [{ p: 0, q: 0, site: 0 }], hostOf: () => null };
// (the herald as it stands at turn `now`: the records logged so far)
let now = 0;
const herald = { async events(after) { const rows = H.filter(e => e.bell <= now && BigInt(e.seq) > BigInt(after)); return { ok: true, events: rows, next: rows.at(-1)?.seq ?? null, full: false }; } };
const storage = () => { const m = new Map(); return { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) }; };
const look = async (st, nowBell) => {
  now = nowBell;
  const marks = RS.loadMarks(st, '7', 'W');
  const r = await RR.createAwayReader({ events: a => herald.events(a) }).start({ scope: 'g|7|W', from: marks?.confirmedSeq ?? '100' });
  return RS.summarize({ records: r.records, read: { after: r.after, complete: r.complete }, marks, last: RS.loadLast(st), season: '7', wallet: 'W', nowBell, me, rules: { programVersion: 4 } });
};

test('across a period\'s boundary the mark, the book and an arrival go on: a caravan sent before it and settled after it is the same caravan', async () => {
  setLang('ja');
  const st = storage();
  // a look before the boundary, confirmed at seq 102 (turn 298)
  const before = await look(st, 299);
  assert.ok(before.items.some(i => i.seq === '102'));
  assert.equal(before.confirm.toSeq, '102');
  const saved = RS.confirm(st, { seasonId: '7', wallet: 'W', confirm: before.confirm, at: 1 });
  assert.equal(saved.moved, true);
  // after the boundary: the same scope, the same mark — no "new season", nothing before the mark told again
  const after = await look(st, 310);
  assert.equal(after.mode, 'sinceConfirmed');
  assert.deepEqual(after.items.map(i => i.seq).sort(), ['103', '104']);
  assert.ok(after.items.every(i => Number(i.bell) > BOUNDARY), 'only what came after the mark');
  // the caravan sent before the boundary arrives after it. Its send was read before the mark, so the book kept with the
  // mark says who holds it (the viewer), and its send's amount is not at hand: the intake is told, the comparison is not
  const arr = after.items.find(i => i.kind === 'CARAVAN_SETTLED');
  assert.ok(arr, 'the caravan crossing the boundary is still the viewer\'s');
  assert.deepEqual(arr.facts.arrival, { state: 'verifiedIntake', intake: F400, compare: 'sentUnknown' }, 'the intake is known, the comparison is not made up');
  assert.equal(RS.loadMarks(st, '7', 'W').caravans['5:2'], '5', 'the book crossed the boundary with the mark');
});

test('a restart after the boundary reads from the mark again and tells each record once', async () => {
  const st = storage();
  const first = await look(st, 310);
  RS.confirm(st, { seasonId: '7', wallet: 'W', confirm: first.confirm, at: 1 });
  const restarted = await look(st, 311);
  assert.equal(restarted.items.length, 0, 'nothing told twice after a restart');
  assert.deepEqual(restarted.confirm, { ok: false, why: 'nothing' });
  assert.equal(RS.loadMarks(st, '7', 'W').confirmedSeq, '104');
});

test('a different season record (another ID) is said as that, not as the world starting over', () => {
  setLang('ja');
  const s = RS.summarize({ records: [], read: { after: '0' }, marks: null, last: { seasonId: '7', wallet: 'W' }, season: '8', wallet: 'W', nowBell: 5, me });
  assert.equal(s.mode, 'newSeason');
  const t = RW.headText(s);
  assert.match(t, /前に見ていたものとは別のシーズン記録（ID が違う記録）です。前の記録の出来事は、ここには含めていません。/);
  assert.doesNotMatch(t, /新しいシーズンです|リセット|消え/);
});
