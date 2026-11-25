// test-gaps-territory (2026-11-26; tests only, no behaviour changed): what the verifiers of #231 #235 #242 #243 #244
// checked by hand or only live, as key-free unit tests.
//  1. The page's land upkeep (flocalplay-territory.mjs decodeTerritoryPlayer → upkeepMilliPerHour, the number the card,
//     the top bar and the net food show) charges what the PROGRAM charges: replayed over the shared Rust vectors
//     frontier-abi/vectors/territory-upkeep-b.txt (frontier-abi writes them from settle_upkeep; the program's and the
//     verifier's settle_into replay them too).
//  2. The net food a screen shows (landfood.mjs withLand) is how the first village's store moves while the land is paid:
//     village food − the program's charge, within one milli-food (the charge's sub-unit remainder).
//  3. The unpaid countdown the card shows (ownLandView turnsLeft) is the kernel's: 24 − (bell − unpaid_since), never
//     below 0, and it only goes down while partial settles keep the first unpaid bell (Q-LP17-1 (b), #243).
//  4. No "season" in the English of any territory / land / upkeep / food / caravan string (seasons abolished, owner
//     2026-11-23 22:42; verify-pr231/243 checked the cards by eye at each print).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import * as T from '../../permutation-server/web/frontier/flocalplay-territory.mjs';
import * as K from '../../permutation-server/web/frontier/territory-rules.mjs';
import * as LF from '../../permutation-server/web/frontier/landfood.mjs';
import EN_CORE from '../../permutation-server/web/lang/en-core.mjs';
import EN_DRAWERS from '../../permutation-server/web/lang/en-drawers.mjs';
import EN_FRONTIER_AGENT from '../../permutation-server/web/lang/en-frontier-agent.mjs';
import EN_FRONTIER_HAND from '../../permutation-server/web/lang/en-frontier-hand.mjs';
import EN_FRONTIER_PLAY from '../../permutation-server/web/lang/en-frontier-play.mjs';
import EN_FRONTIER_PROTO_HAND from '../../permutation-server/web/lang/en-frontier-proto-hand.mjs';
import EN_FRONTIER from '../../permutation-server/web/lang/en-frontier.mjs';
import EN_INSPECTOR from '../../permutation-server/web/lang/en-inspector.mjs';
import EN_LOBBY from '../../permutation-server/web/lang/en-lobby.mjs';
import EN_PAGES from '../../permutation-server/web/lang/en-pages.mjs';
import EN_PLAY from '../../permutation-server/web/lang/en-play.mjs';

const EN_TABLES = { 'en-core.mjs': EN_CORE, 'en-drawers.mjs': EN_DRAWERS, 'en-frontier-agent.mjs': EN_FRONTIER_AGENT, 'en-frontier-hand.mjs': EN_FRONTIER_HAND, 'en-frontier-play.mjs': EN_FRONTIER_PLAY, 'en-frontier-proto-hand.mjs': EN_FRONTIER_PROTO_HAND, 'en-frontier.mjs': EN_FRONTIER, 'en-inspector.mjs': EN_INSPECTOR, 'en-lobby.mjs': EN_LOBBY, 'en-pages.mjs': EN_PAGES, 'en-play.mjs': EN_PLAY };

const repo = f => new URL(`../../${f}`, import.meta.url);

/** The shared vectors: `n0 d0 n1 d1 paid_to remainder since now_ts now_bell avail | charge paid since_after remainder_after paid_to_after`. */
const VECTORS = readFileSync(repo('frontier-abi/vectors/territory-upkeep-b.txt'), 'utf8').split('\n')
  .filter(l => l.trim() && !l.startsWith('#'))
  .map(l => {
    const n = l.split(/\s+/).filter(t => t && t !== '|').map(BigInt);
    assert.equal(n.length, 15, l);
    const [n0, d0, n1, d1, paidTo, remainder, since, nowTs, nowBell, avail, charge, paid, sinceAfter, remainderAfter, paidToAfter] = n;
    const opt = x => (x < 0n ? null : Number(x));
    return { n0: Number(n0), d0: Number(d0), n1: Number(n1), d1: Number(d1), paidTo, remainder, since: opt(since), nowTs,
      nowBell: Number(nowBell), avail, charge, paid: paid === 1n, sinceAfter: opt(sinceAfter), remainderAfter, paidToAfter };
  });

/** A territory summary record (frontier-abi territory_player layout: UNPAID @19, CITIZEN_TAG @84, TILES @92, EXCESS_SUM @96, PAID_TO @104, UNPAID_SINCE @120, HIST @176). */
function summaryBytes({ tiles, excess, hist = [], since = null }) {
  const b = new Uint8Array(320), v = new DataView(b.buffer);
  b.set([...'PSFXWTU1'].map(c => c.charCodeAt(0))); b[18] = 1;
  v.setBigUint64(84, 77n, true); v.setUint32(92, tiles, true); v.setBigUint64(96, BigInt(excess), true);
  if (since !== null) { b[19] = 1; v.setUint32(120, since, true); }
  for (const [bucket, n] of hist) v.setUint16(176 + 2 * bucket, v.getUint16(176 + 2 * bucket, true) + n, true);
  return b;
}
/** A case for a message (bigints as text). */
const show = c => JSON.stringify(c, (_, x) => (typeof x === 'bigint' ? String(x) : x));
const FREE = T.TERRITORY_V1.upkeep.freeDistance;
const excessOf = c => c.n0 * Math.max(0, c.d0 - FREE) + c.n1 * Math.max(0, c.d1 - FREE);
const playerOf = (c, since = c.sinceAfter) =>
  T.decodeTerritoryPlayer(summaryBytes({ tiles: c.n0 + c.n1, excess: excessOf(c), hist: [[Math.min(c.d0, 63), c.n0], [Math.min(c.d1, 63), c.n1]], since }));

test('the shared vectors are there and the abi layout offsets this test writes are the Rust ones', () => {
  assert.equal(VECTORS.length, 200, 'frontier-abi writes 200 cases');
  const abi = readFileSync(repo('frontier-abi/src/world_index/territory.rs'), 'utf8');
  for (const [name, at] of [['UNPAID', 19], ['CITIZEN_TAG', 84], ['TILES', 92], ['EXCESS_SUM', 96], ['PAID_TO', 104], ['UNPAID_SINCE', 120], ['HIST', 176]]) {
    assert.match(abi, new RegExp(`\\b${name} @ ${at} :`), name);
  }
});

test('the page\'s upkeep per hour is the rate the program charged in every shared vector', () => {
  let paid = 0;
  for (const c of VECTORS) {
    const p = playerOf(c);
    const distances = [...Array(c.n0).fill(c.d0), ...Array(c.n1).fill(c.d1)];
    // the kernel mirror (per-tile sum) and the summary's closed form agree
    assert.equal(p.upkeepMilliPerHour, K.upkeepPerHour(T.TERRITORY_V1.upkeep, distances), show(c));
    // what settle_upkeep owed over [paid_to, now] with the carried remainder, at the page's rate
    const dt = c.nowTs > c.paidTo ? c.nowTs - c.paidTo : 0n;
    const owedMs = BigInt(p.upkeepMilliPerHour) * dt + c.remainder;
    const owed = owedMs / 3600n;
    if (c.paid) {
      paid++;
      assert.equal(c.charge, owed, `paid: the program took exactly the page's rate × time (${show(c)})`);
      assert.equal(c.remainderAfter, owedMs % 3600n, 'and carried the same remainder');
    } else {
      // Q-LP17-1 (b): a short settle takes what the store holds, at most the owed amount
      const have = c.avail > 0n ? c.avail : 0n;
      assert.equal(c.charge, owed < have ? owed : have);
    }
  }
  assert.ok(paid >= 40, `${paid} paid cases`);
});

test('the net food shown is how the first village\'s store moves while the land is paid (within one milli-food)', () => {
  let n = 0;
  for (const c of VECTORS.filter(x => x.paid && x.nowTs > x.paidTo && x.n0 + x.n1 > 0)) {
    const p = playerOf(c);
    const home = { p: 65, q: -128, site: 3, order: 1 };
    const fs = { holdings: [home, { p: 64, q: -127, site: 5, order: 2 }], ownLand: { player: p } };
    const milli = LF.landUpkeepMilli(fs, home);
    assert.equal(milli, p.upkeepMilliPerHour, 'the first village pays the land');
    for (const village of [0, 40, 112.5]) {
      const row = LF.withLand({ resource: 'Food', perHour: village }, milli);
      const secs = Number(c.nowTs - c.paidTo);
      // the store over the period: the village's food minus what the program charged
      const store = village * 1000 * secs / 3600 - Number(c.charge);
      const shown = row.perHour * 1000 * secs / 3600;
      // the shown rate is rounded to thousandths of food: allow that over the period, plus the carried remainder
      const slack = 1 + secs / 3600 + Number(c.remainder) / 3600;
      assert.ok(Math.abs(store - shown) <= slack, `${village}/h over ${secs}s: store ${store} vs shown ${shown}`);
    }
    n++;
  }
  assert.ok(n >= 30, `${n} cases`);
});

test('the unpaid countdown is the kernel\'s grace and only goes down while partial settles keep the first unpaid bell', () => {
  for (const c of VECTORS) {
    const v = T.ownLandView(playerOf(c), c.nowBell);
    assert.equal(v.unpaid, c.sinceAfter !== null);
    if (c.sinceAfter === null) { assert.equal(v.turnsLeft, null); continue; }
    assert.equal(v.turnsLeft, Math.max(0, 24 - (c.nowBell - c.sinceAfter)), JSON.stringify({ since: c.sinceAfter, bell: c.nowBell }));
    // a summary already unpaid keeps its first bell (the countdown is never reset by a partial pay)
    if (c.since !== null && !c.paid) assert.equal(c.sinceAfter, c.since);
  }
  // one territory, short every turn from bell 100: 24, 23, … 0, then letting go
  const p = since => T.decodeTerritoryPlayer(summaryBytes({ tiles: 30, excess: 0, hist: [[0, 30]], since }));
  const left = [];
  for (let bell = 100; bell <= 130; bell++) left.push(T.ownLandView(p(100), bell));
  assert.deepEqual(left.slice(0, 25).map(v => v.turnsLeft), Array.from({ length: 25 }, (_, i) => 24 - i));
  assert.ok(left.every((v, i) => i === 0 || v.turnsLeft <= left[i - 1].turnsLeft), 'monotonic');
  assert.deepEqual(left.map(v => v.letting), left.map((_, i) => i >= 24), 'letting go from since + 24');
});

test('no "season" in the English of any territory, land, upkeep, food or caravan string, in every English table', () => {
  const files = readdirSync(repo('permutation-server/web/lang/')).filter(f => /^en-.*\.mjs$/.test(f)).sort();
  assert.deepEqual(Object.keys(EN_TABLES).sort(), files, 'a new English table is imported here too (static imports: the key-test scan follows them)');
  const bad = [];
  let seen = 0;
  for (const [f, t] of Object.entries(EN_TABLES)) {
    if (!t || typeof t !== 'object') continue;
    for (const [ja, en] of Object.entries(t)) {
      if (!/土地|マス|維持費|隊商|食料|手放|領地|領土/.test(ja)) continue;
      seen++;
      if (/シーズン/.test(ja) || /\bseasons?\b/i.test(typeof en === 'function' ? en.toString() : String(en))) bad.push(`${f}: ${ja.slice(0, 40)} → ${String(en).slice(0, 60)}`);
    }
  }
  assert.ok(seen > 300, `${seen} strings checked`);
  assert.deepEqual(bad, [], 'every one of them, listed');
});
