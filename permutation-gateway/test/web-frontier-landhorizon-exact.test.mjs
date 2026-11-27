// fix-landhorizon (#272 land logistics horizon, display only; owner answers Q-TG5-1 (a) and Q-TG5-2 (a)):
//   X1  the store's accrual in the projection is the program's Holding store settle (permutation-rules Accrual::settle,
//       pinned to its Rust text) and equals the page's own mirror (fland.mjs) on 6,000 random stores — with the
//       Rust-written settle_upkeep vectors (frontier-abi/vectors/territory-upkeep-b.txt, replayed in
//       web-frontier-land-horizon.test.mjs), both halves of a settle are the program's, so card and chain cannot drift;
//   X2  Q-TG5-1 (a): the page glue reads the exact milli-food store and its carried remainder — the card's turn
//       counts equal an independent settle-by-settle chain simulation on 3,000 lands (no early "unpaid");
//   X3  Q-TG5-2 (a): an unpaid land the due settle pays says "paid at this payment, unpaid again in M turns, let go at
//       M + 24" (EN + JA, card and HUD), with M from the chain simulation;
//   X4  a later settle pays it (still unpaid now), and the 24-turn grace ending first: what the card says then;
//   X5  source pins (the glue reads storeExactAt; the EN table has every new sentence; no "season").
// Key-free: no wallet, no key, no request.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DECAY_AFTER_BELLS, MAX_STEPS, accrueFood, projectHorizon, horizonStatusLines, horizonHudLine, formatHorizonTurns,
} from '../../permutation-server/web/frontier/landhorizon.mjs';
import { storeExactAt, storesAt } from '../../permutation-server/web/frontier/fland.mjs';
import { horizonFromFS } from '../../permutation-server/web/frontier/screens/holding.mjs';
import { setLang } from '../../permutation-server/web/lang.mjs';

const root = rel => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');
const H = 3600n, TURN = 600n;
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const int = (r, a, b) => a + Math.floor(r() * (b - a + 1));

// ------------------------------------------------------------------ an independent chain (written from the Rust)
/** permutation-rules Accrual::settle on BigInt (div_euclid / rem_euclid; grows only under the cap; stops at 0). */
function accrual(s, t) {
  if (t <= s.t0) return;
  const num = s.frac + s.rate * (t - s.t0);
  const rem = ((num % H) + H) % H, gain = (num - rem) / H;
  s.frac = rem; s.t0 = t;
  const v = s.value + gain;
  if (s.rate >= 0n) { if (s.value < s.cap) s.value = v < s.cap ? v : s.cap; } else s.value = v < 0n ? 0n : v;
}
/** frontier-abi territory::settle_upkeep (b) on BigInt. */
function settleUpkeep(pl, now, bell, avail) {
  const dt = now - pl.paidTo > 0n ? now - pl.paidTo : 0n;
  const owed = pl.rate * dt + pl.rem, charge = owed / H, rem = owed % H;
  pl.paidTo = pl.paidTo > now ? pl.paidTo : now;
  let need = charge;
  if (pl.since !== null) { const turn = (pl.rate * TURN + H - 1n) / H; need = charge > turn ? charge : turn; }
  if (need <= avail) { pl.rem = rem; pl.since = null; return { take: charge, paid: true }; }
  const take = charge < avail ? charge : avail;
  pl.rem = take === charge ? rem : 0n;
  if (pl.since === null) pl.since = bell;
  return { take, paid: false };
}
/**
 * The chain from an exact state: the home's food store `{value, frac, rate, cap, t0}` and the land summary; a settle
 * due now first (paidTo < now), then one each turn (wide_territory settle_into: stock_at, settle_upkeep, pay).
 */
function chain(st, n = MAX_STEPS) {
  const s = { value: BigInt(st.value), frac: BigInt(st.frac), rate: BigInt(st.prod), cap: BigInt(st.cap), t0: BigInt(st.t0) };
  const pl = { rate: BigInt(st.upkeep), paidTo: BigInt(st.paidTo), rem: BigInt(st.remainder), since: st.since == null ? null : BigInt(st.since) };
  const was = pl.since !== null;
  let unpaidAt = null, paidAt = null, againAt = null;
  const step = k => {
    const t = BigInt(st.now) + BigInt(k) * TURN;
    accrual(s, t);
    const x = settleUpkeep(pl, t, BigInt(st.bell + k), s.value);
    s.value -= x.take;
    if (!was) { if (!x.paid && unpaidAt === null) unpaidAt = k; return; }
    if (paidAt === null) { if (x.paid) paidAt = k; return; }
    if (!x.paid && againAt === null) againAt = k;
  };
  if (BigInt(st.paidTo) < BigInt(st.now)) step(0);
  for (let k = 1; k <= n && !(was ? againAt !== null : unpaidAt !== null); k++) step(k);
  return { unpaidAt, paidAt, againAt };
}

// ------------------------------------------------------------------ X1
test('X1 the projection accrues the store as the program does (Accrual::settle, pinned) and as the page mirror does (6,000 stores)', () => {
  const rs = root('permutation-rules/src/frontier/holding.rs');
  for (const line of [
    'let num = self.frac as i128 + self.rate as i128 * (t - self.t0) as i128;',
    'let gain = num.div_euclid(HOUR as i128);',
    'self.frac = num.rem_euclid(HOUR as i128) as i64;',
    'if self.value < self.cap {',
    'self.value = v.min(self.cap as i128) as Milli;',
  ]) assert.ok(rs.includes(line), `holding.rs still says: ${line}`);
  // the program reads the home's food for the land settle through stock_at (a settle) and pays with pay
  const wt = root('permutation-frontier/src/proc/wide_territory.rs');
  assert.ok(wt.includes('h.stock_at(now)[r as usize]'), 'settle_into reads Holding::stock_at');
  assert.ok(wt.includes('h.pay(now_ts, &cost)'), 'and pays with Holding::pay');
  const r = rng(101);
  let capped = 0, negative = 0;
  for (let i = 0; i < 6_000; i++) {
    const cap = [2_000_000, 6_000_000][int(r, 0, 1)];
    const value = int(r, 0, 3) === 0 ? cap + int(r, -2_000, 2_000) : int(r, 0, cap);
    const rate = int(r, 0, 4) === 0 ? -int(r, 1, 90_000) : int(r, 0, 120_000);
    const frac = int(r, 0, 3599), dt = int(r, 0, 4) === 0 ? int(r, 1, 599) : 600 * int(r, 1, 3);
    const s = { value: BigInt(Math.max(0, value)), frac: BigInt(frac), rate: BigInt(rate), cap: BigInt(cap), t0: 0n };
    accrual(s, BigInt(dt));
    const got = accrueFood(Math.max(0, value), rate, dt, cap, frac);
    const why = JSON.stringify({ value, rate, frac, dt, cap });
    assert.deepEqual([got.stockMilli, got.frac], [Number(s.value), Number(s.frac)], why);
    // the page's own Holding mirror (fland.mjs settleAccrual via storeExactAt) says the same
    const store = { value: String(Math.max(0, value)), frac: String(frac), rate: String(rate), cap: String(cap), t0: '1000' };
    const hold = { stores: [store, store, store, store] };
    const x = storeExactAt(hold, 1000 + dt, 0);
    assert.deepEqual([x.value, x.frac], [Number(s.value), Number(s.frac)], `fland ${why}`);
    if (value >= cap && rate > 0) capped++;
    if (rate < 0) negative++;
  }
  assert.ok(capped > 100 && negative > 500, `cap (${capped}) and shrinking (${negative}) stores reached`);
});

// ------------------------------------------------------------------ X2 the page glue on exact numbers
const T0 = 1_786_000_000;
/** An FS as the page holds it: the first village (food store in milli-food with its carried remainder) and the land. */
function fsOf(x) {
  const store = (v, f, rate) => ({ value: String(v), frac: String(f), rate: String(rate), cap: String(x.cap), t0: String(x.t0) });
  return {
    holdings: [{ p: 0, q: 0, site: 0, order: 1, stores: [store(x.value, x.frac, x.prod), store(0, 0, 0), store(0, 0, 0), store(0, 0, 0)] }],
    chain: { now: () => x.now }, nowBell: x.bell,
    ownLand: { citizen: `x${x.value}-${x.frac}-${x.tiles}-${x.paidTo}-${x.now}-${x.since}`, player: { tiles: x.tiles, upkeepMilliPerHour: x.upkeep, paidTo: x.paidTo, remainder: x.remainder, unpaidSince: x.since, hist: [x.tiles] } },
  };
}
function randomPage(r, { unpaid = false } = {}) {
  const tiles = int(r, 5, 90), upkeep = tiles * 990;
  const prod = int(r, 0, 2) ? int(r, 5, 80) * 1000 : upkeep - int(r, 1, 700);
  const paidTo = T0 + int(r, 0, 600), now = paidTo + int(r, 0, 599);
  // the keeper's pass settles the home with the land: food t0 = paidTo (alignLandClock's consistent case)
  return {
    value: int(r, 0, 2) ? int(r, 0, 30_000) : int(r, 0, 600_000), frac: int(r, 0, 3599), prod, cap: 2_000_000, t0: paidTo,
    tiles, upkeep, paidTo, now, bell: 700, remainder: int(r, 0, 3599), since: unpaid ? 700 - int(r, 0, 23) : null,
  };
}

test('X2 Q-TG5-1 (a): on the chain\'s exact store the card\'s turns until unpaid equal the chain\'s (3,000 lands, none early)', () => {
  const r = rng(2272);
  let n = 0, diffWhole = 0;
  for (let i = 0; i < 3_000; i++) {
    const x = randomPage(r);
    const h = horizonFromFS(fsOf(x)), o = chain(x);
    assert.ok(h, 'a land and a first village: a projection');
    const why = JSON.stringify(x);
    if (o.unpaidAt === null) {
      assert.equal(h.turnsUntilUnpaid, null, why);
      assert.ok(h.sustainable || h.beyondTurns === MAX_STEPS, why);
    } else {
      assert.equal(h.turnsUntilUnpaid, o.unpaidAt, why);
      assert.equal(h.turnsUntilRelease, o.unpaidAt + DECAY_AFTER_BELLS, why);
    }
    // the whole-food read (storesAt, what the glue used before) would have been off here
    const whole = storesAt(fsOf(x).holdings[0], x.now, ['Food', 'Wood', 'Stone', 'Ore'])[0].value * 1000;
    if (whole !== storeExactAt(fsOf(x).holdings[0], x.now, 0).value) diffWhole++;
    n++;
  }
  assert.ok(diffWhole > n / 2, `the exact store differs from whole food in ${diffWhole}/${n} lands (the case this fixes)`);
  // the report's fixed case: 0.182 food (182 milli-food, 433/3600 carried), 51 tiles, 47 food/h, 36 s after the pass —
  // the chain pays the settle due now; the card said "This payment will leave the land unpaid" (0 whole food)
  const one = { value: 182, frac: 433, prod: 47_000, cap: 2_000_000, t0: T0, tiles: 51, upkeep: 51 * 990, paidTo: T0, now: T0 + 36, bell: 700, remainder: 0, since: null };
  const h1 = horizonFromFS(fsOf(one)), o1 = chain(one);
  assert.ok(o1.unpaidAt > 0, `the chain pays now (first unpaid turn ${o1.unpaidAt})`);
  assert.equal(h1.turnsUntilUnpaid, o1.unpaidAt);
  setLang('en');
  try { assert.doesNotMatch(horizonStatusLines(h1, 60).join(' '), /This payment will leave the land unpaid/); } finally { setLang('ja'); }
});

// ------------------------------------------------------------------ X3 / X4 paid again
const project = x => projectHorizon({
  stockMilli: x.value, stockFrac: x.frac, productionMilliPerHour: x.prod, capMilli: x.cap, upkeepMilliPerHour: x.upkeep,
  paidTo: x.paidTo, remainder: x.remainder, unpaidSince: x.since, nowTs: x.now, nowBell: x.bell, tiles: x.tiles, hist: [x.tiles],
});
const turns = (lang, n, rate) => { setLang(lang); return formatHorizonTurns(n, rate); };

test('X3 Q-TG5-2 (a): an unpaid land the due settle pays — "paid at this payment, unpaid again in M turns, let go at M + 24" (EN + JA)', () => {
  // the case from test-gaps-5 LH7: 73 tiles, 40 food/h, 300 food came in, unpaid since 5 turns ago
  const st = { value: 300_000, frac: 0, prod: 40_000, cap: 2_000_000, t0: 1_786_000_300, tiles: 73, upkeep: 73 * 990, paidTo: 1_786_000_000, now: 1_786_000_300, bell: 200, remainder: 0, since: 195 };
  const o = chain(st), h = project(st);
  assert.equal(o.paidAt, 0, 'the chain: the due settle pays');
  assert.ok(o.againAt > 40 && o.againAt < 70, `unpaid again in ${o.againAt}`);
  assert.equal(h.paidAgain, true); assert.equal(h.unpaidAlready, false); assert.equal(h.turnsUntilPaid, 0);
  assert.equal(h.turnsUntilUnpaid, o.againAt); assert.equal(h.turnsUntilRelease, o.againAt + DECAY_AFTER_BELLS);
  const M = o.againAt, R = M + DECAY_AFTER_BELLS;
  try {
    for (const rate of [1, 60]) {
      setLang('en');
      const card = horizonStatusLines(h, rate).join('\n'), hud = horizonHudLine(h, rate);
      assert.equal(card, `This payment pays the land upkeep, and the land is no longer unpaid. If nothing changes, upkeep goes unpaid again in ${turns('en', M, rate)}. Tiles start being let go 24 turns after that (in ${turns('en', R, rate)}).`);
      setLang('en');
      assert.equal(hud, `This payment pays the land. Unpaid again in ${turns('en', M, rate)}. Tiles start being let go in ${turns('en', R, rate)}.`);
      setLang('ja');
      const cj = horizonStatusLines(h, rate).join('\n'), hj = horizonHudLine(h, rate);
      assert.equal(cj, `今の支払いで土地の維持費が払われ、未払いは終わります。このままなら、未払いはまた ${turns('ja', M, rate)} 後に始まります。土地の手放しは、その 24 ターン後（${turns('ja', R, rate)} 後）に始まります。`);
      setLang('ja');
      assert.equal(hj, `今の支払いで払われます。また未払いまで ${turns('ja', M, rate)}。手放しまで ${turns('ja', R, rate)}。`);
      for (const s of [card, hud, cj, hj]) { assert.doesNotMatch(s, /season|シーズン/i); assert.doesNotMatch(s, /leave the land unpaid|未払いが始まります。土地/); }
      setLang('en'); assert.doesNotMatch(card + hud, /[぀-ヿ㐀-鿿]/, 'no Japanese left in English');
    }
  } finally { setLang('ja'); }
  // paid now, and the store then lasts beyond the horizon: "more than"
  const far = { ...st, value: 1_999_000, prod: 72_260, cap: 2_000_000 };
  const hf = project(far);
  assert.equal(hf.paidAgain, true); assert.equal(hf.turnsUntilUnpaid, null); assert.equal(hf.beyondTurns, MAX_STEPS);
  setLang('en');
  try {
    assert.match(horizonStatusLines(hf, 1)[0], /^This payment pays the land upkeep, and the land is no longer unpaid\. Food production is below the land upkeep, but the stored food pays it for more than 2,000 turns/);
    assert.match(horizonHudLine(hf, 1), /^This payment pays the land\. Unpaid again in more than 2,000 turns/);
  } finally { setLang('ja'); }
});

test('X4 unpaid lands on random stores: paid / unpaid-again / release turns equal the chain; a later payment and an earlier release say so', () => {
  const r = rng(4004);
  const seen = { now: 0, later: 0, graceFirst: 0, stuck: 0, sustainable: 0 };
  try {
    for (let i = 0; i < 3_000; i++) {
      const x = randomPage(r, { unpaid: true });
      const o = chain(x), h = horizonFromFS(fsOf(x));
      const why = JSON.stringify({ x, o });
      const grace = Math.max(0, x.since + DECAY_AFTER_BELLS - x.bell);
      assert.equal(h.turnsUntilPaid, o.paidAt, why);
      if (o.paidAt === null) {
        seen.stuck++;
        assert.equal(h.unpaidAlready, true, why); assert.equal(h.turnsUntilRelease, grace, why);
        continue;
      }
      if (x.prod >= x.upkeep) { seen.sustainable++; assert.equal(h.sustainable, true, why); continue; }
      assert.equal(h.paidAgain, true, why);
      assert.equal(h.turnsUntilUnpaid, o.againAt, why);
      if (o.againAt !== null) assert.equal(h.turnsUntilRelease, o.againAt + DECAY_AFTER_BELLS, why);
      setLang('en');
      const card = horizonStatusLines(h, 60).join('\n'), hud = horizonHudLine(h, 60);
      assert.ok(card && hud, `never blank: ${why}`);
      assert.doesNotMatch(card + hud, /leave the land unpaid/, why);
      if (o.paidAt === 0) {
        seen.now++;
        assert.match(card, /^This payment pays the land upkeep/, why);
        if (o.againAt !== null) assert.ok(card.includes(`unpaid again in ${turns('en', o.againAt, 60)}`), why);
      } else if (grace > o.paidAt) {
        seen.later++;
        setLang('en');
        assert.ok(card.startsWith(`Upkeep is already unpaid. If nothing changes, the payment in ${turns('en', o.paidAt, 60)} pays it`), `${card}\n${why}`);
        setLang('en');
        assert.ok(hud.startsWith(`Land upkeep is unpaid. Paid in ${turns('en', o.paidAt, 60)}.`), `${hud}\n${why}`);
      } else {
        // the 24-turn grace ends before the paying settle: the release comes first (and is all the card promises)
        seen.graceFirst++;
        setLang('en');
        assert.equal(card, grace === 0 ? 'Upkeep is already unpaid. Your farthest tiles are being let go.' : `Upkeep is already unpaid. If nothing changes, tiles start being let go in ${turns('en', grace, 60)}.`, why);
      }
    }
  } finally { setLang('ja'); }
  for (const k of Object.keys(seen)) assert.ok(seen[k] >= 5, `${k} reached ${seen[k]} times (${JSON.stringify(seen)})`);
});

// ------------------------------------------------------------------ X5
test('X5 source pins: the glue reads the exact store; every new sentence has its English; no "season"', () => {
  const glue = root('permutation-server/web/frontier/screens/holding.mjs');
  const fn = glue.slice(glue.indexOf('export function horizonFromFS'), glue.indexOf('export function ownLandHorizonBlock'));
  assert.match(fn, /storeExactAt\(settled\(payer, now\), now, RESOURCE_ORDER\.indexOf\('Food'\)\)/);
  assert.match(fn, /stockFrac: food\.frac/);
  assert.doesNotMatch(fn, /storesAt\(/, 'the whole-food read is not used for the projection');
  const lh = root('permutation-server/web/frontier/landhorizon.mjs'), en = root('permutation-server/web/lang/en-frontier.mjs');
  const keys = [...lh.matchAll(/L`([^`]*)`/g)].map(m => { let i = 0; return m[1].replace(/\$\{[^}]*\}/g, () => `{${i++}}`); });
  assert.ok(keys.length >= 25);
  for (const k of keys) assert.ok(en.includes(`'${k}'`), `English for: ${k}`);
  for (const k of keys) assert.doesNotMatch(k, /シーズン/);
  const block = en.slice(en.indexOf('// fix-landhorizon (Q-TG5-2 (a))'), en.indexOf("  '物流の見通し'"));
  assert.ok(block.split('\n').length >= 9, 'the new English block');
  assert.doesNotMatch(block, /season|シーズン/i);
  assert.doesNotMatch(lh.replace(/seasonterms\.mjs/g, ''), /season/i, 'the module says nothing of a season (its import aside)');
});
