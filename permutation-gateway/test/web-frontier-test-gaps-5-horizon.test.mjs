// test-gaps-5 (#272 land logistics horizon, tests only): what verify-pr272 checked by hand or in one live world —
//   LH1  an independent port of frontier-abi `settle_upkeep` (b) (pinned to the Rust text, replayed on all 200 shared
//        vectors) is the oracle for everything below;
//   LH2  3,000 random lands: the projection (turns until unpaid / release, sustainable, "more than", already unpaid,
//        letting, paid again) equals a direct settle-by-settle simulation on the oracle and the chain's own food accrual;
//   LH3  the card and HUD sentences (EN + JA, ×1 / ×30 / ×60 / unknown pace) say exactly the oracle's turn counts and
//        the real-time conversion (turns × 600 s ÷ pace);
//   LH4  net ≥ 0: "up to M tiles" is the largest land at the farthest distance the oracle keeps paid for good;
//   LH5  the page glue (horizonFromFS) on the chain's exact store is never LATER than the chain;
//   LH6/LH7 (todo, D-test-gaps-5-1 / -2): two real display bugs the oracle found, pinned as expected failures.
// Behaviour is not changed here. Key-free: no wallet, no key, no request.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DECAY_AFTER_BELLS, MAX_STEPS, projectHorizon, horizonStatusLines, horizonHudLine, formatHorizonTurns,
} from '../../permutation-server/web/frontier/landhorizon.mjs';
import { horizonFromFS, ownLandHorizonBlock } from '../../permutation-server/web/frontier/screens/holding.mjs';
import { TERRITORY_V1 } from '../../permutation-server/web/frontier/flocalplay-territory.mjs';
import { setLang } from '../../permutation-server/web/lang.mjs';

const root = rel => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');
const HOUR = 3600n, TURN = 600n;
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const int = (r, a, b) => a + Math.floor(r() * (b - a + 1));

// ------------------------------------------------------------------ the oracle (written from territory.rs, not from landhorizon.mjs)
/** frontier-abi world_index::territory::settle_upkeep, line by line, on BigInt. `pl` = {rate, paidTo, rem, since}. */
function rustSettle(pl, nowTs, nowBell, available) {
  const rate = pl.rate;
  const dt = nowTs - pl.paidTo > 0n ? nowTs - pl.paidTo : 0n;
  const owed = rate * dt + pl.rem;
  const charge = owed / HOUR, rem = owed % HOUR;
  pl.paidTo = pl.paidTo > nowTs ? pl.paidTo : nowTs;
  let need = charge;
  if (pl.since !== null) { const turn = (rate * TURN + HOUR - 1n) / HOUR; need = charge > turn ? charge : turn; }
  const have = available > 0n ? available : 0n;
  if (need <= have) { pl.rem = rem; pl.since = null; return { take: charge, paid: true }; }
  const take = charge < have ? charge : have;
  pl.rem = take === charge ? rem : 0n;
  if (pl.since === null) pl.since = nowBell;
  return { take, paid: false };
}
/** The village's food store between two reads (Holding::settle for a rate ≥ 0: carried sub-unit remainder, capped). */
function accrue(s, t) {
  if (t <= s.t0) return;
  const num = s.frac + s.rate * (t - s.t0), rem = num % HOUR, next = s.value + (num - rem) / HOUR;
  s.frac = rem; s.t0 = t;
  if (s.value < s.cap) s.value = next < s.cap ? next : s.cap;
}
/**
 * The chain, settle by settle: a settle due now (paidTo < now) first, then one each turn (the keeper's pass at the
 * bell). Returns the first unpaid turn (of a paid land), the first paid turn (of an unpaid one) and, after that,
 * the next unpaid turn, within `n` turns.
 */
function simulate(st, n = MAX_STEPS) {
  const pl = { rate: BigInt(st.upkeep), paidTo: BigInt(st.paidTo), rem: BigInt(st.remainder), since: st.since == null ? null : BigInt(st.since) };
  const s = { value: BigInt(st.stock), frac: BigInt(st.frac ?? 0), rate: BigInt(st.prod), cap: BigInt(st.cap), t0: BigInt(st.t0 ?? st.now) };
  const was = pl.since !== null;
  let unpaidAt = null, paidAt = null, againAt = null;
  const step = k => {
    const t = BigInt(st.now) + BigInt(k) * TURN;
    accrue(s, t);
    const x = rustSettle(pl, t, BigInt(st.bell + k), s.value);
    s.value -= x.take;
    if (!was && !x.paid && unpaidAt === null) unpaidAt = k;
    if (was && x.paid && paidAt === null) paidAt = k;
    if (was && paidAt !== null && !x.paid && againAt === null) againAt = k;
  };
  if (BigInt(st.paidTo) < BigInt(st.now)) step(0);
  for (let k = 1; k <= n; k++) step(k);
  return { unpaidAt, paidAt, againAt, sinceEnd: pl.since };
}
const project = st => projectHorizon({
  stockMilli: st.stock, productionMilliPerHour: st.prod, capMilli: st.cap, upkeepMilliPerHour: st.upkeep, paidTo: st.paidTo,
  remainder: st.remainder, unpaidSince: st.since, nowTs: st.now, nowBell: st.bell, tiles: st.tiles, hist: st.hist,
});
const tileCost = d => TERRITORY_V1.upkeep.flat + TERRITORY_V1.upkeep.perDistance * Math.max(0, d - TERRITORY_V1.upkeep.freeDistance);

/** A random first-village land: tiles over 1–3 distance buckets, a food rate around or off its upkeep, a store, a clock. */
function randomLand(r) {
  const hist = Array(64).fill(0);
  let tiles = 0, upkeep = 0;
  for (let b = int(r, 1, 3); b > 0; b--) { const d = int(r, 0, 7), n = int(r, 1, 50); hist[d] += n; tiles += n; upkeep += n * tileCost(d); }
  const kind = int(r, 0, 5);
  const prod = kind === 0 ? upkeep + int(r, 0, 5_000) : kind === 1 ? Math.max(0, upkeep - int(r, 1, 400)) : int(r, 1, 90) * 1000;
  const cap = [2_000_000, 6_000_000, 15_000_000][int(r, 0, 2)];
  const stock = [int(r, 0, 20_000), int(r, 0, 400_000), int(r, 0, cap)][int(r, 0, 2)];
  const now = 1_786_000_000 + int(r, 0, 99_999), bell = 400 + int(r, 0, 200);
  const unpaid = int(r, 0, 3) === 0;
  return {
    tiles, hist, upkeep, prod, cap, stock, now, bell, remainder: int(r, 0, 3599),
    paidTo: int(r, 0, 1) ? now : now - int(r, 1, 599),
    since: unpaid ? bell - int(r, 0, 40) : null,
  };
}

// ------------------------------------------------------------------ LH1
const VECTORS = root('frontier-abi/vectors/territory-upkeep-b.txt').split('\n').filter(l => l.trim() && !l.startsWith('#'))
  .map(l => l.split(/\s+/).filter(t => t && t !== '|').map(BigInt));

test('LH1 the oracle is the program\'s settle_upkeep: pinned to territory.rs, and all 200 shared vectors replay exactly', () => {
  const rs = root('frontier-abi/src/world_index/territory.rs');
  for (const line of [
    'let dt = (now_ts as i128 - pl.paid_to as i128).max(0);',
    'let charge = owed_ms / HOUR;',
    'let rem = (owed_ms % HOUR) as u64;',
    'pl.paid_to = pl.paid_to.max(now_ts);',
    '.map(|v| (v + HOUR - 1) / HOUR)',
    'charge.max(turn)',
    'if need <= available.max(0) {',
    'let take = charge.min(have);',
    'pl.remainder = if take == charge { rem } else { 0 };',
    'if pl.unpaid_since.is_none() {',
    'pl.unpaid_since = Some(now_bell);',
  ]) assert.ok(rs.includes(line), `territory.rs still says: ${line}`);
  assert.equal(VECTORS.length, 200);
  let short = 0, reserve = 0;
  for (const v of VECTORS) {
    const [n0, d0, n1, d1, paidTo, rem, since, nowTs, nowBell, avail, charge, paid, sinceAfter, remAfter, paidToAfter] = v;
    const rate = n0 * BigInt(tileCost(Number(d0))) + n1 * BigInt(tileCost(Number(d1)));
    const pl = { rate, paidTo, rem, since: since < 0n ? null : since };
    const x = rustSettle(pl, nowTs, nowBell, avail);
    assert.deepEqual([x.take, x.paid ? 1n : 0n, pl.since ?? -1n, pl.rem, pl.paidTo], [charge, paid, sinceAfter, remAfter, paidToAfter], v.join(' '));
    if (!x.paid) short++;
    if (since >= 0n && !x.paid && avail >= (rate * (nowTs - paidTo > 0n ? nowTs - paidTo : 0n) + rem) / HOUR) reserve++;
  }
  assert.ok(short > 20 && reserve > 0, `the vectors reach the short (${short}) and the one-turn-reserve (${reserve}) branches`);
});

// ------------------------------------------------------------------ LH2
/** What the card must say for `st`, from the oracle (null for the two todo cases below: paid-again with net < 0). */
function expected(st) {
  const o = simulate(st);
  const net = st.prod - st.upkeep;
  if (st.since == null) {
    if (o.unpaidAt === null) return net >= 0 ? { branch: 'sustainable' } : { branch: 'beyond' };
    return { branch: o.unpaidAt === 0 ? 'unpaid-now' : 'unpaid-later', unpaid: o.unpaidAt, release: o.unpaidAt + DECAY_AFTER_BELLS };
  }
  if (o.paidAt === null) {
    const release = Math.max(0, st.since + DECAY_AFTER_BELLS - st.bell);
    return { branch: release === 0 ? 'letting' : 'already', release };
  }
  return { branch: net >= 0 ? 'paid-again-sustainable' : 'paid-again-short', paidAt: o.paidAt, again: o.againAt };
}

test('LH2 3,000 random lands: the projection equals a direct settle-by-settle simulation (every branch reached)', () => {
  const r = rng(272);
  const seen = {};
  for (let i = 0; i < 3_000; i++) {
    const st = randomLand(r);
    const e = expected(st), h = project(st), why = JSON.stringify({ st: { ...st, hist: undefined }, e });
    seen[e.branch] = (seen[e.branch] ?? 0) + 1;
    switch (e.branch) {
      case 'sustainable':
        assert.equal(h.sustainable, true, why); assert.equal(h.turnsUntilUnpaid, null, why); assert.equal(h.beyondTurns, null, why); break;
      case 'beyond':
        assert.equal(h.sustainable, false, why); assert.equal(h.turnsUntilUnpaid, null, why); assert.equal(h.beyondTurns, MAX_STEPS, why); break;
      case 'unpaid-now': case 'unpaid-later':
        assert.equal(h.sustainable, false, why); assert.equal(h.unpaidAlready, false, why);
        assert.equal(h.turnsUntilUnpaid, e.unpaid, why); assert.equal(h.turnsUntilRelease, e.release, why); break;
      case 'already': case 'letting':
        assert.equal(h.unpaidAlready, true, why); assert.equal(h.turnsUntilRelease, e.release, why);
        assert.equal(h.letting, e.branch === 'letting', why); break;
      default:
        // paid again (the settle due now or a later one pays): the turn it pays is the oracle's; the card's sentence for
        // this case is LH7 (todo)
        assert.equal(h.unpaidAlready, false, why); assert.equal(h.turnsUntilPaid, e.paidAt, why);
        if (e.branch === 'paid-again-sustainable') assert.equal(h.sustainable, true, why);
    }
  }
  for (const b of ['sustainable', 'beyond', 'unpaid-now', 'unpaid-later', 'already', 'letting', 'paid-again-sustainable', 'paid-again-short']) {
    assert.ok((seen[b] ?? 0) >= 10, `branch ${b} reached ${seen[b] ?? 0} times (${JSON.stringify(seen)})`);
  }
});

// ------------------------------------------------------------------ LH3
const SPAN = {
  en: { s: 'seconds', m: 'minutes', h: 'hours', d: 'days' },
  ja: { s: '秒', m: '分', h: '時間', d: '日' },
};
/** Seconds in words, written here from the rule (under 90 s in seconds, under 90 min in minutes, under 48 h in hours). */
function span(lang, secs) {
  const s = Math.max(0, Math.round(secs)), u = SPAN[lang];
  const [n, k] = s < 90 ? [s, 's'] : s < 5_400 ? [Math.round(s / 60), 'm'] : s < 172_800 ? [Math.round(s / 3600), 'h'] : [Math.round(s / 86_400), 'd'];
  return `${n.toLocaleString('en-US')} ${u[k]}`;
}
/** "N turns (…)" as the card must say it at pace `rate` (1, a fast clock, or null = not known yet). */
function turnsWords(lang, n, rate) {
  const N = n.toLocaleString('en-US'), game = span(lang, n * 600);
  if (lang === 'en') {
    const t = `${N} ${n === 1 ? 'turn' : 'turns'}`;
    if (rate == null) return `${t} (about ${game} of game time)`;
    if (rate > 1) return `${t} (about ${game} of game time, in this world about ${span(lang, (n * 600) / rate)} of real time)`;
    return `${t} (about ${game})`;
  }
  if (rate == null) return `${N} ターン（ゲーム内で約 ${game}）`;
  if (rate > 1) return `${N} ターン（ゲーム内で約 ${game}、この世界では実時間で約 ${span(lang, (n * 600) / rate)}）`;
  return `${N} ターン（約 ${game}）`;
}

test('LH3 the card and HUD sentences say the oracle\'s turn counts and the real-time conversion (EN + JA, ×1 / ×30 / ×60 / unknown pace)', () => {
  const r = rng(6001);
  let checked = 0;
  try {
    for (let i = 0; i < 1_500; i++) {
      const st = randomLand(r), e = expected(st);
      if (e.branch.startsWith('paid-again')) continue;
      const h = project(st);
      for (const lang of ['en', 'ja']) for (const rate of [1, 30, 60, null]) {
        setLang(lang);
        const card = horizonStatusLines(h, rate).join('\n'), hud = horizonHudLine(h, rate);
        const why = `${lang} ×${rate} ${e.branch} ${JSON.stringify(e)}\ncard: ${card}\nhud: ${hud}`;
        assert.ok(card.length > 0 && hud.length > 0, `never a blank card or HUD: ${why}`);
        assert.doesNotMatch(card + hud, /season|シーズン/i, why);
        if (lang === 'en') assert.doesNotMatch(card + hud, /[぀-ヿ㐀-鿿]/, why);
        if (e.unpaid !== undefined) {
          if (e.unpaid > 0) { assert.ok(card.includes(turnsWords(lang, e.unpaid, rate)), why); assert.ok(hud.includes(turnsWords(lang, e.unpaid, rate)), why); }
          assert.ok(card.includes(turnsWords(lang, e.release, rate)), why);
          if (e.unpaid > 0) assert.ok(hud.includes(turnsWords(lang, e.release, rate)), why);
        }
        if (e.branch === 'already') { assert.ok(card.includes(turnsWords(lang, e.release, rate)), why); assert.ok(hud.includes(turnsWords(lang, e.release, rate)), why); }
        if (e.branch === 'beyond') { assert.ok(card.includes(turnsWords(lang, MAX_STEPS, rate)), why); assert.ok(hud.includes(turnsWords(lang, MAX_STEPS, rate)), why); }
        // no other turn count is said: every "N turns" / 「N ターン」 in the card is one of the oracle's
        const said = [...card.matchAll(lang === 'en' ? /([\d,]+) turns?\b/g : /([\d,]+) ターン/g)].map(m => Number(m[1].replace(/,/g, '')));
        const allowed = new Set([e.unpaid, e.release, e.branch === 'beyond' ? MAX_STEPS : undefined, DECAY_AFTER_BELLS].filter(x => x !== undefined));
        for (const n of said) assert.ok(allowed.has(n), `${n} turns is not the oracle's: ${why}`);
        checked++;
      }
    }
  } finally { setLang('ja'); }
  assert.ok(checked > 8_000, `${checked} sentences checked`);
  // the conversion itself, at the edges of each unit (independent of the random lands)
  for (const lang of ['en', 'ja']) {
    setLang(lang);
    for (const n of [1, 8, 9, 143, 287, 288, 2_000]) for (const rate of [1, 30, 60, null]) assert.equal(formatHorizonTurns(n, rate), turnsWords(lang, n, rate), `${lang} ${n} ×${rate}`);
  }
  setLang('ja');
});

// ------------------------------------------------------------------ LH4
test('LH4 net >= 0: "up to M tiles" is the largest land at the farthest distance the oracle keeps paid; one tile more goes unpaid', () => {
  const r = rng(404);
  let checked = 0;
  try {
    for (let i = 0; i < 600; i++) {
      const d = int(r, 0, 9), hist = Array(64).fill(0);
      const tiles = int(r, 1, 60); hist[d] = tiles;
      const cost = tileCost(d), upkeep = tiles * cost;
      const prod = upkeep + int(r, 0, 30 * cost);
      const st = { tiles, hist, upkeep, prod, cap: 2_000_000, stock: int(r, 0, 3_000), now: 1_786_000_000, bell: 500, remainder: 0, paidTo: 1_786_000_000, since: null };
      const h = project(st);
      assert.equal(h.sustainable, true);
      const M = tiles + h.headroom;
      // the oracle: M tiles stay paid for good (from the random store and from an empty one); M + 1 tiles, from an empty
      // store, go unpaid (the food a turn makes is less than the turn's upkeep)
      const at = (n, stock = st.stock) => simulate({ ...st, stock, tiles: n, upkeep: n * cost }, 400);
      assert.equal(at(M).unpaidAt, null, `${M} tiles at distance ${d} on ${prod} milli/h stay paid`);
      assert.equal(at(M, 0).unpaidAt, null, `${M} tiles stay paid from an empty store`);
      assert.notEqual(at(M + 1, 0).unpaidAt, null, `${M + 1} tiles go unpaid (${JSON.stringify({ d, tiles, prod, cost, headroom: h.headroom })})`);
      setLang('en');
      const en = horizonStatusLines(h, 1)[0];
      if (h.headroom > 0) assert.ok(en.includes(`${h.headroom.toLocaleString('en-US')} more tiles (up to ${M.toLocaleString('en-US')} tiles)`) || en.includes(`1 more tile (up to ${M.toLocaleString('en-US')} tiles)`), en);
      else { assert.doesNotMatch(en, /\d more tiles?/, en); assert.match(en, /cannot support any more tiles/, en); }
      setLang('ja');
      const ja = horizonStatusLines(h, 1)[0];
      if (h.headroom > 0) assert.ok(ja.includes(`あと ${h.headroom.toLocaleString('en-US')} マスまで維持できます（最大 ${M.toLocaleString('en-US')} マス）`), ja);
      checked++;
    }
  } finally { setLang('ja'); }
  assert.equal(checked, 600);
});

// ------------------------------------------------------------------ LH5–LH7: the page glue on the chain's exact numbers
const FOOD_T0 = 1_786_000_000;
/** An FS as the page holds it: the first village (store in milli-food with its carried remainder) and the land record. */
function fsOf({ value, frac, prod, tiles, upkeep, paidTo, now, bell, remainder, since = null, hist }) {
  const store = (v, f, rate) => ({ value: String(v), frac: String(f), rate: String(rate), cap: '2000000', t0: String(paidTo) });
  return {
    holdings: [{ p: 0, q: 0, site: 0, order: 1, stores: [store(value, frac, prod), store(0, 0, 0), store(0, 0, 0), store(0, 0, 0)] }],
    chain: { now: () => now }, nowBell: bell,
    ownLand: { citizen: `c${value}-${frac}-${tiles}-${paidTo}-${now}`, player: { tiles, upkeepMilliPerHour: upkeep, paidTo, remainder, unpaidSince: since, hist: hist ?? [tiles] } },
  };
}
/** The chain from the same exact state (the village was settled at paidTo by the keeper's pass: its food t0 = paidTo). */
function chainFrom({ value, frac, prod, tiles, upkeep, paidTo, now, bell, remainder, since = null }) {
  return simulate({ stock: value, frac, t0: paidTo, prod, cap: 2_000_000, upkeep, paidTo, now, bell, remainder, since, tiles });
}
function randomPage(r) {
  const tiles = int(r, 10, 90), upkeep = tiles * 990;
  const prod = int(r, 0, 2) ? int(r, 10, 60) * 1000 : upkeep - int(r, 1, 600);
  const paidTo = FOOD_T0 + int(r, 0, 600);
  return { value: int(r, 0, 400_000), frac: int(r, 0, 3599), prod, tiles, upkeep, paidTo, now: paidTo + int(r, 0, 599), bell: 700, remainder: int(r, 0, 3599) };
}

test('LH5 the page glue (horizonFromFS) on the chain\'s exact store is never later than the chain (the safe side), 2,000 lands', () => {
  const r = rng(5005);
  let n = 0, equal = 0;
  for (let i = 0; i < 2_000; i++) {
    const x = randomPage(r);
    if (x.prod >= x.upkeep) continue;
    const h = horizonFromFS(fsOf(x)), o = chainFrom(x);
    assert.ok(h, 'a land and a first village: a projection');
    const chain = o.unpaidAt ?? Infinity, page = h.turnsUntilUnpaid ?? (h.beyondTurns != null ? Infinity : -1);
    assert.ok(page <= chain, `the card (${page}) is not later than the chain (${chain}): ${JSON.stringify(x)}`);
    if (page === chain) equal++;
    n++;
  }
  assert.ok(n > 1_500 && equal > n / 2, `${equal}/${n} exact`);
});

// D-test-gaps-5-1 (found here; behaviour unchanged): horizonFromFS passes the store as whole food
// (fland.mjs storesAt: value / 1000n, × 1000 again) and drops the store's carried sub-unit remainder (frac). The chain
// pays from the exact milli-food store, so the card says "unpaid in N turns" up to 999 milli-food early: about 1 land in 5
// is 1–13 turns early, and near net 0 (a few milli-food short a turn) tens of turns early or "N turns" where the chain
// lasts beyond MAX_STEPS. Expected to fail until the glue passes the milli store and its remainder.
test('LH6 (todo, D-test-gaps-5-1) the card\'s turn count on the chain\'s exact store equals the chain\'s', { todo: 'D-test-gaps-5-1: horizonFromFS truncates the store to whole food and drops its remainder (inbox test-gaps-5)' }, () => {
  const r = rng(6006);
  const off = [];
  for (let i = 0; i < 2_000; i++) {
    const x = randomPage(r);
    if (x.prod >= x.upkeep) continue;
    const h = horizonFromFS(fsOf(x)), o = chainFrom(x);
    const chain = o.unpaidAt, page = h.turnsUntilUnpaid;
    if (chain !== page) off.push({ chain, page, ...x });
  }
  // a fixed case for the report: 0.182 food (182 milli-food, 433/3600 carried), 51 tiles, 47 food/h, 36 s after the
  // keeper's pass — the chain pays the settle due now and goes unpaid at the next; the card (0 whole food) says "This
  // payment will leave the land unpaid"
  const one = { value: 182, frac: 433, prod: 47_000, tiles: 51, upkeep: 51 * 990, paidTo: FOOD_T0, now: FOOD_T0 + 36, bell: 700, remainder: 0 };
  assert.equal(horizonFromFS(fsOf(one)).turnsUntilUnpaid, chainFrom(one).unpaidAt, JSON.stringify(one));
  assert.deepEqual(off.slice(0, 5), [], `${off.length} lands differ`);
});

// D-test-gaps-5-2 (found here; behaviour unchanged): an UNPAID land whose store now covers the due settle and a turn's
// reserve (food came in: a harvest, a caravan) with production still below upkeep. The chain pays at this settle
// (unpaid_since cleared) and goes unpaid again M turns later. projectHorizon stops at the paying settle with
// turnsUntilUnpaid left at its initial 0, so the card says "This payment will leave the land unpaid. Tiles start being let
// go 24 turns after that" — the opposite of what the settle does.
test('LH7 (todo, D-test-gaps-5-2) an unpaid land the due settle pays again: the card says when it goes unpaid AGAIN, not "this payment leaves it unpaid"', { todo: 'D-test-gaps-5-2: projectHorizon reports turnsUntilUnpaid 0 for a land that the due settle pays (inbox test-gaps-5)' }, () => {
  const st = { tiles: 73, hist: [73], upkeep: 73 * 990, prod: 40_000, cap: 2_000_000, stock: 300_000, now: 1_786_000_300, bell: 200, remainder: 0, paidTo: 1_786_000_000, since: 195 };
  const o = simulate(st);
  assert.equal(o.paidAt, 0, 'the chain: the due settle pays');
  assert.ok(o.againAt > 40 && o.againAt < 70, `and the land goes unpaid again in ${o.againAt} turns`);
  const h = project(st);
  setLang('en');
  try {
    const card = horizonStatusLines(h, 1).join('\n');
    assert.doesNotMatch(card, /This payment will leave the land unpaid/, card);
    assert.equal(h.turnsUntilUnpaid, o.againAt);
    assert.equal(h.turnsUntilRelease, o.againAt + DECAY_AFTER_BELLS);
  } finally { setLang('ja'); }
});

test('LH8 the card block carries the projection\'s sentences under its lead, with the 2nd-village note (wiring of ownLandHorizonBlock)', () => {
  const r = rng(808);
  for (let i = 0; i < 200; i++) {
    const st = randomLand(r), e = expected(st);
    if (e.branch.startsWith('paid-again')) continue;
    const h = project(st);
    const html = String(ownLandHorizonBlock(h, { rate: 60, villageCount: 2, otherFoodMilli: 1000 }));
    for (const line of horizonStatusLines(h, 60)) assert.ok(html.includes(line), `${line}\n${html}`);
    assert.match(html, /2村目以降の食料は/);
  }
});
