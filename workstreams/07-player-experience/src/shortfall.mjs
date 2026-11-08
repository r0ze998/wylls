// Workstream 07, brief item 2: "足りない" turned into choices — wait, grow,
// carry, ask — compared at one moment: when the SAME needed amounts are ALL
// there. Not "when the first caravan lands" and not "when one resource is
// ready": a promotion needing 1,613 stone is not ready when 900 arrive.
//
// Every time here is the page's own projection of the village
// (fland.mjs projectedHolding and accrualAt: the program's settle — accrual,
// caps, buildings finishing in queue order), with one change per option:
//   wait   nothing changes
//   grow   the next copy of a building that makes a short resource is paid
//          now (rulebook.mjs buildOffers: the program's cost for that copy,
//          its build time after the queue) and adds its rate when done
//          (fland.mjs queue kind 1). Its cost is taken from the same stores,
//          so a building that costs what is short can make it later, and
//          the comparison shows it.
//   carry  a caravan from another of the viewer's places (caravan-preview.mjs:
//          arrival, tower wear) adds its worn cargo at its arrival; the
//          program credits a village above its cap (holding.rs Accrual::add
//          "may exceed the cap"), so a caravan can bring what waiting cannot
//   both   a caravan and one more building, for what the caravan leaves short
//   ask    a request to the nation. When and whether it comes depends on
//          other people: no time is given, ever (the nation's table is
//          workstream 1's; here it is a labelled mock)
// What none of them may count: amounts beyond the store's cap while
// waiting, a negative net rate (upkeep above production) that never fills,
// the season's end, a raid on the way (a risk, told beside the time, never
// subtracted from it), and the workshop's arms (its ore and wood use is not
// in the page's projection; said as not computed).
import { projectedHolding, accrualAt, buildItemOf } from '../../../permutation-server/web/frontier/fland.mjs';
import { buildOffers, settled } from '../../../permutation-server/web/frontier/hud/rulebook.mjs';
import { RESOURCE_ORDER } from '../../../permutation-server/web/frontier/resources.mjs';
import { wear } from './s1walk.mjs';

const HOUR = 3600;
/** The resource each build item 0–5 makes (fland.mjs BUILD_ITEMS); the workshop (8) is left out, see above. */
export const MAKERS = Object.freeze([0, 1, 2, 3, 4, 5].map(i => ({ item: i, r: RESOURCE_ORDER.indexOf(buildItemOf(i).resource), perHour: buildItemOf(i).perHour })));

const milli = x => BigInt(Math.round(x)) * 1000n;
/** The stores of `h` at `t` (milli, BigInt) by the page's projection. */
export const storesAt = (h, t) => projectedHolding(h, t).stores.map(a => accrualAt(a, t));

/**
 * The earliest chain second in [from, until] at which every `need` (milli by
 * resource; 0 for none) is there, by `valueAt(t)` (the projection, or withCargo's),
 * or null. Monotone in t while every needed rate is
 * not negative, which the caller checks.
 */
export function readyAt(h, need, from, until, valueAt = t => storesAt(h, t)) {
  const ok = t => { const s = valueAt(t); return need.every((n, r) => n <= 0n || s[r] >= n); };
  if (ok(from)) return from;
  if (!ok(until)) return null;
  let lo = from, hi = until;
  while (hi - lo > 1) { const mid = Math.floor((lo + hi) / 2); if (ok(mid)) hi = mid; else lo = mid; }
  return hi;
}

/**
 * The stores of `h` with `cargo` (milli by resource) credited at `at`, as the program does it (holding.rs: `add`
 * may lift a store over its cap; a store at or over its cap then accrues no more): before `at` the projection, after
 * it the credited value growing as the projection grew, up to the cap, and not at all once it is at or over it.
 */
export function withCargo(h, at, cargo) {
  const before = storesAt(h, at), caps = projectedHolding(h, at).stores.map(a => BigInt(a.cap));
  return t => {
    const s = storesAt(h, t);
    if (t < at) return s;
    return s.map((v, r) => {
      const c = cargo[r] ?? 0n;
      if (c <= 0n) return v;
      const v0 = before[r] + c;
      if (v0 >= caps[r]) return v0;
      const grown = v0 + (v - before[r]);
      return grown < caps[r] ? grown : caps[r];
    });
  };
}

/** Why waiting cannot fill a resource: its cap is below the need, or its rate is not positive. */
function blocker(h, r, need, now) {
  const a = projectedHolding(h, now).stores[r];
  if (BigInt(a.cap) < need) return { r, why: 'AboveCap', cap: Number(BigInt(a.cap) / 1000n) };
  if (BigInt(a.rate) <= 0n) return { r, why: 'NoRate', perHour: Number(BigInt(a.rate)) / 1000 };
  return null;
}

/**
 * The comparison. `h`: the viewer's village (decoded Holding); `need`: whole
 * units by resource; `now`, `endTs` (chain seconds: the season's end);
 * `sources`: places a caravan could come from, `[{id, label, have (whole by
 * resource), preview (caravan-preview.mjs result for this village)}]`.
 * → `{have, short: [{r, missing}], options: [{kind, ready (chain s) | null,
 * blocked: [...], costs, gives, partial?, risk?, notes: [...]}]}`; the options
 * sorted by ready (null last).
 */
export function compareRemedies({ h, need, now, endTs, sources = [], s1 = false, faction = 0 }) {
  const needM = need.map(n => milli(n ?? 0));
  const have = storesAt(h, now);
  const short = needM.map((n, r) => ({ r, missing: n > have[r] ? Number((n - have[r] + 999n) / 1000n) : 0 })).filter(x => x.missing > 0);
  const until = Math.max(now, Math.floor(endTs));
  const opts = [];
  // ---- wait
  {
    const blocked = short.map(s => blocker(h, s.r, needM[s.r], now)).filter(Boolean);
    const ready = blocked.length ? null : readyAt(h, needM, now, until);
    opts.push({ kind: 'wait', ready, blocked, costs: null, notes: [] });
  }
  // ---- grow: one more of a building that makes a short resource
  const sh = settled(h, now);
  const haveWhole = have.map(v => Number(v / 1000n));
  const offers = buildOffers(sh, { now, have: haveWhole, s1, faction });
  for (const s of short) {
    const m = MAKERS.find(x => x.r === s.r);
    if (!m) { opts.push({ kind: 'grow', r: s.r, ready: null, blocked: [{ r: s.r, why: s1 && s.r === 4 ? 'WorkshopNotComputed' : 'NoMaker' }], notes: [] }); continue; }
    const o = offers.find(x => x.item === m.item);
    const base = { kind: 'grow', r: s.r, item: m.item, n: o?.n, costs: o?.cost ?? null, gives: { r: s.r, perHour: m.perHour, from: o ? now + o.doneIn : null }, secs: o?.secs };
    if (!o || o.blocks.length) { opts.push({ ...base, ready: null, blocked: (o?.blocks ?? ['Unknown']).map(why => ({ why, ...(why === 'Insufficient' ? { short: o.short } : {}) })), notes: [] }); continue; }
    // the next copy paid now (the program settles, then takes the cost), its rate from when it is done
    const g = structuredClone(sh);
    g.stores = g.stores.map((a, r) => {
      const v = accrualAt(a, now), c = milli(o.cost[r] ?? 0);
      return { ...a, value: v - c, t0: BigInt(now), frac: 0n };
    });
    g.queue = [...(g.queue ?? []).filter(Boolean), { kind: 1, arg: m.r, delta: m.perHour * 1000, doneAt: BigInt(now + o.doneIn) }];
    const blocked = short.filter(x => x.r !== s.r).map(x => blocker(g, x.r, needM[x.r], now)).filter(Boolean);
    const capped = blocker(g, s.r, needM[s.r], now + o.doneIn + 1);
    const ready = blocked.length || capped?.why === 'AboveCap' ? null : readyAt(g, needM, now, until);
    opts.push({ ...base, ready, blocked: [...blocked, ...(capped?.why === 'AboveCap' ? [capped] : [])], notes: (o.cost[s.r] ?? 0) > 0 ? ['CostsWhatIsShort'] : [], village: g });
  }
  const grown = opts.filter(o => o.kind === 'grow' && o.village);
  // ---- carry: a caravan from another place, its worn cargo at its arrival
  for (const src of sources) {
    const pv = src.preview;
    if (!pv?.ok) { opts.push({ kind: 'carry', source: src.id, label: src.label, ready: null, blocked: [{ why: pv?.why ?? 'NoRoad' }], notes: [] }); continue; }
    const bps = pv.wear?.bps ?? 0;
    // what to load: the missing amount, raised so that what arrives after the towers' wear covers it, at most what is there
    const load = needM.map((n, r) => {
      const miss = n > have[r] ? n - have[r] : 0n;
      if (miss === 0n) return 0n;
      let x = bps > 0 ? (miss * 10000n + BigInt(10000 - bps) - 1n) / BigInt(10000 - bps) : miss;
      x = ((x + 999n) / 1000n) * 1000n;
      const there = milli(src.have?.[r] ?? 0);
      return x < there ? x : there;
    });
    const arrives = load.map(x => wear(x, bps));
    const at = pv.arrive.ts;
    const valueAt = withCargo(h, at, arrives);
    const partial = short.some(s => arrives[s.r] + have[s.r] < needM[s.r]);
    // the rest still has to come by waiting: if waiting cannot bring it, the caravan alone does not make the need
    const restBlocked = partial ? short.filter(s => arrives[s.r] + have[s.r] < needM[s.r]).map(s => blocker(h, s.r, needM[s.r] - arrives[s.r], now)).filter(Boolean) : [];
    let ready = restBlocked.length ? null : readyAt(h, needM, now, until, valueAt);
    // (above the cap, only what lands at once counts: the store grows no more there — say the cap, not the season's end)
    if (ready === null && !restBlocked.length) for (const s2 of short) { const cap = BigInt(projectedHolding(h, at).stores[s2.r].cap); if (needM[s2.r] > cap && have[s2.r] + arrives[s2.r] < needM[s2.r]) restBlocked.push({ r: s2.r, why: 'AboveCap', cap: Number(cap / 1000n) }); }
    opts.push({ kind: 'carry', source: src.id, label: src.label, ready, arrive: { ts: at, bell: pv.arrive.bell, bellIfLate: pv.arrive.bellIfLate }, blocked: restBlocked,
      load: load.map(x => Number(x / 1000n)), arrives: arrives.map(x => Number(x / 1000n)), wear: bps, partial,
      risk: { knownTurns: pv.turns.filter(t => t.known.length).length, unknown: !!pv.unknown, turns: pv.turns.length }, notes: [...(partial ? ['Partial'] : []), ...(bps ? ['Worn'] : [])] });
    // ---- both: this caravan, and one more building for what it leaves short (the building paid now, the cargo at its arrival)
    if (partial) for (const g of grown) {
      const rest = short.filter(x => arrives[x.r] + have[x.r] < needM[x.r] && x.r !== g.r).map(x => blocker(g.village, x.r, needM[x.r] - arrives[x.r], now)).filter(Boolean);
      const r2 = rest.length ? null : readyAt(g.village, needM, now, until, withCargo(g.village, at, arrives));
      opts.push({ kind: 'both', source: src.id, label: src.label, r: g.r, item: g.item, costs: g.costs, ready: r2, blocked: rest, arrive: { ts: at, bell: pv.arrive.bell }, arrives: arrives.map(x => Number(x / 1000n)), wear: bps, notes: [] });
    }
  }
  // ---- ask: no time, by design
  opts.push({ kind: 'ask', ready: null, blocked: [], mock: true, notes: ['DependsOnOthers'] });
  // a time the season's end cuts off is said as such (none of the blocks above, and still not there by the end)
  for (const o of opts) if (o.ready === null && o.kind !== 'ask' && !(o.blocked ?? []).length && !o.notes.includes('AfterSeasonEnd')) o.notes.push('AfterSeasonEnd');
  for (const o of opts) delete o.village;
  const order = { wait: 0, grow: 1, carry: 2, both: 3, ask: 4 };
  opts.sort((a, b) => (a.ready === null) - (b.ready === null) || (a.ready ?? 0) - (b.ready ?? 0) || order[a.kind] - order[b.kind]);
  return { have: have.map(v => Number(v / 1000n)), need, short, options: opts };
}

export const HOURS = s => s / HOUR;
