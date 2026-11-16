// The holding projection against the rules' Holding (Lane C, 2026-11-16; WRITTEN, NOT RUN — all new test runs were
// paused when this was written, so these cases are paper cases until the coordinator lets them run).
// P1: after a completion or dormancy the page set every rate to production − upkeep; the rules' Holding
//     (permutation-rules holding.rs full_rates / limited_rates / lent_arms / dry_at) also takes the S1 workshops' ore
//     and wood (ORE_PER_ARM 2, WOOD_PER_ARM 1), leaves lent copies out, and runs the workshops limited from the moment
//     an input would go below 0.
// P2: at a promotion the page took the S1 ore base from the map's terrain reading (the M1 base 15 while unread); the
//     program uses the terrain ore stored on the holding (holding2 TERRAIN_ORE, proc/holding.rs terrain_ore).
// Every expected figure below is worked by hand from the Rust (milli-units per hour unless said).
// Pure data: imports fland.mjs and fs1.mjs; the Rust is read as text.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { projectedHolding, storesAt } from '../../permutation-server/web/frontier/fland.mjs';
import { setS1, setOreExtraProvider } from '../../permutation-server/web/frontier/fs1.mjs';
import { RESOURCE_ORDER } from '../../permutation-server/web/frontier/resources.mjs';

const read = rel => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');
const T0 = 1_000_000;
const R = n => RESOURCE_ORDER.indexOf(n);
const S1 = { layoutVersion: 2, programVersion: 4 };
const CAP0 = 2_000_000n;   // Hamlet storage cap, milli
// a holding whose recorded rates are `rates` (what the program last set), production/upkeep as given
const village = ({ production, rates, values = Array(8).fill(100_000n), queue = [], tier = 0, ...rest }) => ({
  p: 2, q: 0, site: 1, tile: 10, tier, lastOwnerAction: T0, walls: 0, foodShortfall: 0n,
  production: production.map(BigInt), upkeep: Array(8).fill(0n), queue,
  stores: rates.map((rate, i) => ({ value: BigInt(values[i]), rate: BigInt(rate), cap: CAP0, t0: BigInt(T0), frac: 0n })),
  ...rest,
});
const perHour = (h, t, name) => storesAt(h, t, RESOURCE_ORDER)[R(name)].perHour;
const value = (h, t, name) => storesAt(h, t, RESOURCE_ORDER)[R(name)].value;
const withS1 = fn => { setS1(S1); try { fn(); } finally { setS1(null); setOreExtraProvider(null); } };

test('the rules read: workshop inputs, lent copies, the dry moment, and settle_tiered on the stored terrain ore', () => {
  const rules = read('permutation-rules/src/frontier/holding.rs');
  assert.match(rules, /const CONVERSION_INPUTS: \[\(usize, i64\); 2\] = \[\s*\(Resource::Ore as usize, ORE_PER_ARM\),\s*\(Resource::Wood as usize, WOOD_PER_ARM\),\s*\];/);
  assert.match(rules, /fn full_rates\(&self, dormant: bool\)/);
  assert.match(rules, /fn limited_rates\(&self, dormant: bool\)/);
  assert.match(rules, /let dry = self\.dry_at\(\)\.filter\(\|&x\| x <= now\);/);
  const arms = read('permutation-rules/src/frontier/arms.rs');
  assert.match(arms, /pub const WORKSHOP_ORE_PER_HOUR: i64 = 8;/);
  assert.match(arms, /pub const WORKSHOP_WOOD_PER_HOUR: i64 = 4;/);
  assert.match(arms, /pub const WORKSHOP_ARMS_PER_HOUR: i64 = 4;/);
  assert.match(arms, /b\[Resource::Ore as usize\] = terrain_ore\.max\(0\) \* \(100 \+ catalog::tier_bonus_pct\(t\)\) \/ 100;/);
  const proc = read('permutation-frontier/src/proc/holding.rs');
  assert.match(proc, /touch\(&mut h, now, terrain_ore\(&hd\)\?\)\?;/, 'the owner touch settles on the stored terrain ore');
  assert.match(proc, /pub fn terrain_ore\(d: &\[u8\]\) -> R<i64> \{\s*Ro\(d\)\.i64\(H2::TERRAIN_ORE\)/);
});

test('P1: a completion keeps the workshops\' ore and wood use (one workshop, nothing lent)', () => withS1(() => {
  // production: ore 13 (terrain), wood 30, arms 4 (one workshop). Full rates: ore 13 − 4×2 = 5, wood 30 − 4×1 = 26, arms 4.
  const production = [40_000, 30_000, 20_000, 13_000, 4_000, 15_000, 5_000, 0];
  const rates = [40_000, 26_000, 20_000, 5_000, 4_000, 15_000, 5_000, 0];
  const h = village({ production, rates, queue: [{ kind: 1, arg: R('Food'), delta: 10_000, doneAt: T0 + 10 }] });
  const t = T0 + 20;
  assert.equal(perHour(h, t, 'Food'), 50, 'the finished farm: 40 + 10');
  assert.equal(perHour(h, t, 'Ore'), 5, 'the workshop still uses 8 ore (the page showed 13)');
  assert.equal(perHour(h, t, 'Wood'), 26, 'and 4 wood (the page showed 30)');
  assert.equal(perHour(h, t, 'Horses'), 4, 'arms 4');
}));

test('P1: lent workshops make nothing here and use none of its inputs', () => withS1(() => {
  // two workshops (arms production 8), one lent: own 4. Ore 13 − 4×2 = 5, wood 30 − 4 = 26, arms 8 − (8 − 4) = 4.
  const production = [40_000, 30_000, 20_000, 13_000, 8_000, 15_000, 5_000, 0];
  const rates = [40_000, 26_000, 20_000, 5_000, 4_000, 15_000, 5_000, 0];
  const h = village({ production, rates, lentWorkshops: 1, queue: [{ kind: 1, arg: R('Food'), delta: 10_000, doneAt: T0 + 10 }] });
  const t = T0 + 20;
  assert.equal(perHour(h, t, 'Ore'), 5);
  assert.equal(perHour(h, t, 'Wood'), 26);
  assert.equal(perHour(h, t, 'Horses'), 4, 'the page showed 8');
}));

test('P1: the workshops run limited from the moment the ore would go below 0', () => withS1(() => {
  // ore 4 (no terrain), one workshop: full ore −4 an hour from 2 ore (2,000 milli) → dry after 2000×3600/4000 = 1800 s.
  // Limited from T0+1800: share = min(4000×10000/8000, min(30000×10000/4000, 10000)) = 5000 (half speed):
  //   ore 4000 − 8000×5000/10000 = 0; wood 30000 − 4000×5000/10000 = 28000; arms 4000 − (4000 − 2000) = 2000.
  // At T0+3600: arms 1800 s × 4000/h + 1800 s × 2000/h = 2000 + 1000 = 3000 milli (3; the page showed 4);
  //   wood 100 + (13000 + 14000)/1000 = 127 (the page showed 126); ore 0.
  const production = [40_000, 30_000, 20_000, 4_000, 4_000, 15_000, 5_000, 0];
  const rates = [40_000, 26_000, 20_000, -4_000, 4_000, 15_000, 5_000, 0];
  const values = [100_000, 100_000, 100_000, 2_000, 0, 100_000, 100_000, 100_000];
  const h = village({ production, rates, values });
  const t = T0 + 3600;
  assert.equal(value(h, t, 'Horses'), 3);
  assert.equal(value(h, t, 'Wood'), 127);
  assert.equal(value(h, t, 'Ore'), 0);
  assert.equal(perHour(h, t, 'Ore'), 0);
  assert.equal(perHour(h, t, 'Wood'), 28);
  assert.equal(perHour(h, t, 'Horses'), 2);
  // before the dry moment nothing changes
  assert.equal(perHour(h, T0 + 1799, 'Horses'), 4);
  // a holding already running limited (its rates are not the full ones) stays so until the next rate change
  const limited = village({ production, rates: [40_000, 28_000, 20_000, 0, 2_000, 15_000, 5_000, 0], values: [100_000, 100_000, 100_000, 0, 0, 100_000, 100_000, 100_000] });
  assert.equal(perHour(limited, T0 + 3600, 'Horses'), 2);
}));

test('P1: a holding with no arms production gets the plain net rates, as before', () => {
  setS1(null);
  const production = [40_000, 30_000, 20_000, 15_000, 0, 15_000, 5_000, 0];
  const h = village({ production, rates: production, queue: [{ kind: 1, arg: R('Ore'), delta: 6_000, doneAt: T0 + 10 }] });
  const s = storesAt(h, T0 + 20, RESOURCE_ORDER);
  assert.deepEqual(s.map(x => x.perHour), [40, 30, 20, 21, 0, 15, 5, 0]);
});

test('P2: a promotion uses the terrain ore stored on the holding, read map or not', () => withS1(() => {
  // terrainOre 13,000 (4 + 9). Hamlet → Village: ore base 13000×100/100 = 13000 → 13000×150/100 = 19500, so +6500.
  // The page took the M1 base while the map was unread (15000 → 22000, +7000: 20 an hour) or the map's reading.
  const production = [40_000, 30_000, 20_000, 13_000, 0, 15_000, 5_000, 0];
  const mk = () => village({ production, rates: production, terrainOre: 13_000n, queue: [{ kind: 3, arg: 0, delta: 0, doneAt: T0 + 10 }] });
  assert.equal(perHour(mk(), T0 + 20, 'Ore'), 19.5, 'map unread');
  setOreExtraProvider(() => 20);   // a map reading that differs from the stored one (4 + 20 = 24 an hour)
  assert.equal(perHour(mk(), T0 + 20, 'Ore'), 19.5, 'the stored terrain ore, not the map');
  assert.equal(projectedHolding(mk(), T0 + 20).tier, 1);
  // the other entries take the Village bonus: food 40 → 60
  assert.equal(perHour(mk(), T0 + 20, 'Food'), 60);
}));
