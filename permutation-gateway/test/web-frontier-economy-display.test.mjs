// Lane C (2026-11-16): the economy figures the page shows, against the Rust rules they mirror. A display
// regression only: the program decides every number, and nothing here changes a page or a rules file.
//
// The page computes these figures in the browser (frontier/fland.mjs, fs1.mjs, hud/rulebook.mjs, hud/hud.mjs,
// hud/hand.mjs, screens/holding.mjs, fconquest.mjs, map/sprites.mjs): the 収穫 button's 毎時 +N (the sum of what
// the stores gain in an hour), the resource strip's rate per store, each building's next-copy cost, time and
// yield, the promotion card, training costs per unit and per rules version, the S1 workshop, arms and terrain
// ore, the settler's cost and the caps of the stores' projection. The authority is permutation-rules
// (src/frontier/catalog.rs, arms.rs, holding.rs, src/units.rs); this test reads those tables as TEXT (no Rust
// build), rebuilds each figure from them, and checks the page's own functions give the same figure for every
// tier and every unit the page shows. Each figure's English (the words the page puts round it) is checked for
// British spelling and for the play screen's banned words.
//
// Every figure checked, and the one mismatch found, are listed in docs/integration/CLAUDE-LANE-C-ECONOMY-DISPLAY-20261116.md.
// A real mismatch is a `todo` test naming its entry there. E1 was fixed on the integration branch (fland.mjs
// projectedHolding, 2026-11-16): its test is an ordinary test now.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setLang, L, fmtNum } from '../../permutation-server/web/lang.mjs';
import { RESOURCES, TIERS } from '../../permutation-server/web/frontier/fi18n.mjs';
import * as fland from '../../permutation-server/web/frontier/fland.mjs';
import * as fs1 from '../../permutation-server/web/frontier/fs1.mjs';
import * as rb from '../../permutation-server/web/frontier/hud/rulebook.mjs';
import { resourceModel, resourceTitle } from '../../permutation-server/web/frontier/hud/hud.mjs';
import { harvestModel } from '../../permutation-server/web/frontier/hud/hand.mjs';
import { costWords, unitStrength } from '../../permutation-server/web/frontier/hud/orderparts.mjs';
import { settlerCost } from '../../permutation-server/web/frontier/fconquest.mjs';
import { RESOURCE_ORDER } from '../../permutation-server/web/frontier/resources.mjs';

afterEach(() => { setLang('ja'); fs1.setS1(null); fs1.setOreExtraProvider(null); });

// ------------------------------------------------------------------ the Rust tables, read as text
const ROOT = new URL('../../', import.meta.url);
const rs = f => readFileSync(new URL(`permutation-rules/src/${f}`, ROOT), 'utf8');
const web = f => readFileSync(new URL(`permutation-server/web/frontier/${f}`, ROOT), 'utf8');
const CATALOG = rs('frontier/catalog.rs'), ARMS_RS = rs('frontier/arms.rs'), HOLDING_RS = rs('frontier/holding.rs'), UNITS_RS = rs('units.rs');

/** `const NAME: T = expr;` → the expression's text. */
const constText = (src, name) => {
  const m = src.match(new RegExp(`pub const ${name}\\s*:[^=]+=\\s*([^;]+);`));
  assert.ok(m, `pub const ${name} is in the Rust source`);
  return m[1].trim();
};
/** An integer expression of the Rust source: literals with `_`, `*`, `+`, `/`, and the named constants it uses. */
const NAMED = { HOUR: 3_600, MILLI: 1_000 };
function intExpr(text, src = CATALOG) {
  let t = text.replace(/(\d)_(?=\d)/g, '$1');
  t = t.replace(/\b[A-Z][A-Z0-9_]+\b/g, name => String(NAMED[name] ?? rsInt(src, name)));
  assert.match(t, /^[\d\s*+\-/()]+$/, `a plain integer expression: ${text}`);
  // (Rust integer division: every `/` in these tables is between non-negative integers)
  return Function(`"use strict"; return (${t.replace(/(\d+)\s*\/\s*(\d+)/g, 'Math.trunc($1 / $2)')});`)();
}
const rsInt = (src, name) => intExpr(constText(src, name), src);
/** `pub const NAME: [T; N] = [a, b, …];` → numbers (a named constant inside is resolved). */
const rsArray = (src, name) => constText(src, name).replace(/^\[|\]$/g, '').split(',').map(s => s.trim()).filter(Boolean).map(s => intExpr(s, src));
/** The body of `fn name(` up to its closing brace at the indentation of the `fn`. */
function fnBody(src, name) {
  const at = src.search(new RegExp(`fn ${name}\\s*\\(`));
  assert.ok(at >= 0, `fn ${name} is in the Rust source`);
  const indent = src.slice(src.lastIndexOf('\n', at) + 1, at).match(/^\s*/)[0];
  const end = src.indexOf(`\n${indent}}`, at);
  return src.slice(at, end);
}
const TIER_NAMES = ['Hamlet', 'Town', 'City', 'Stronghold'];
/** A `match self/t { Tier::A | Tier::B => expr, … }` function → its value for each tier, in tier order (raw text). */
function tierArms(src, name) {
  const body = fnBody(src, name), out = [];
  for (const m of body.matchAll(/((?:Tier::\w+\s*\|\s*)*Tier::\w+)\s*=>\s*([^\n]+?),?\s*\n/g)) {
    for (const t of m[1].match(/Tier::(\w+)/g)) out[TIER_NAMES.indexOf(t.slice(6))] = m[2].trim().replace(/,$/, '');
  }
  assert.equal(out.filter(x => x !== undefined).length, 4, `${name} names every tier`);
  return out;
}

const RESOURCE = (() => {
  const m = HOLDING_RS.match(/pub enum Resource \{([^}]+)\}/);
  return m[1].split(',').map(s => s.trim()).filter(Boolean);
})();
const R = name => RESOURCE.indexOf(name);
const RUST = {
  BASE_PROD: rsArray(CATALOG, 'BASE_PROD'),
  TIER_BONUS: tierArms(CATALOG, 'tier_bonus_pct').map(x => intExpr(x)),
  TIER_UP: tierArms(CATALOG, 'tier_up').map(x => {
    if (x === 'None') return null;
    const m = x.match(/^Some\(\(\[([^\]]+)\],\s*([^)]+)\)\)$/);
    return { cost: m[1].split(',').map(s => intExpr(s.trim())), secs: intExpr(m[2]) };
  }),
  STORE_CAP: tierArms(HOLDING_RS, 'storage_cap').map(x => intExpr(x, HOLDING_RS)),
  QUEUE_SLOTS: tierArms(HOLDING_RS, 'queue_slots').map(x => intExpr(x, HOLDING_RS)),
  WORKED_RADIUS: tierArms(HOLDING_RS, 'worked_radius').map(x => intExpr(x, HOLDING_RS)),
  BUILDINGS: [...constText(CATALOG, 'BUILDINGS').matchAll(/Building\s*\{\s*resource:\s*Resource::(\w+),\s*per_hour:\s*(\d+),\s*cost:\s*\[([^\]]+)\]/g)]
    .map(m => ({ resource: m[1], perHour: Number(m[2]), cost: m[3].split(',').map(s => intExpr(s.trim())) })),
  TROOP_COST_PER_100: rsArray(CATALOG, 'TROOP_COST_PER_100'),
  TROOP_COST_BASE_PROD: rsInt(CATALOG, 'TROOP_COST_BASE_PROD'),
  TRAIN_PROD_COST_V2: rsArray(CATALOG, 'TRAIN_PROD_COST_V2'),
  UNIT_STATS: [...UNITS_RS.slice(UNITS_RS.indexOf('pub const UNIT_STATS')).matchAll(/\bu\((\w+),\s*(\w+),\s*(\d+),\s*(\d+),\s*(\d+),\s*(\d+),/g)].slice(0, 8)
    .map(m => ({ unit: m[1], cls: m[2], tier: Number(m[3]), strength: Number(m[4]), move: Number(m[5]), prod: Number(m[6]) })),
  WALL_STEP: rsInt(CATALOG, 'WALL_STEP'), WALL_COST_STONE: rsInt(CATALOG, 'WALL_COST_STONE'), WALL_SECS: rsInt(CATALOG, 'WALL_SECS'),
  MAX_WALLS: rsInt(HOLDING_RS, 'MAX_WALLS'), MAX_COPIES: rsInt(CATALOG, 'MAX_COPIES'),
  MAX_PRODUCTION_PER_HOUR: rsInt(HOLDING_RS, 'MAX_PRODUCTION_PER_HOUR'), MAX_UPKEEP_PER_HOUR: rsInt(HOLDING_RS, 'MAX_UPKEEP_PER_HOUR'),
  SETTLER_COST: rsArray(CATALOG, 'SETTLER_COST'),
  // arms.rs (S1)
  ARMS: RESOURCE.indexOf(constText(ARMS_RS, 'ARMS').replace('Resource::', '')),
  WORKSHOP_ORE_PER_HOUR: rsInt(ARMS_RS, 'WORKSHOP_ORE_PER_HOUR'), WORKSHOP_WOOD_PER_HOUR: rsInt(ARMS_RS, 'WORKSHOP_WOOD_PER_HOUR'),
  WORKSHOP_ARMS_PER_HOUR: rsInt(ARMS_RS, 'WORKSHOP_ARMS_PER_HOUR'), ITEM_WORKSHOP: rsInt(ARMS_RS, 'ITEM_WORKSHOP'),
  WORKSHOP_COST: rsArray(ARMS_RS, 'WORKSHOP_COST'), TRAIN_ARMS_PER_100: rsArray(ARMS_RS, 'TRAIN_ARMS_PER_100'),
  SIEGE_ARMS: rsInt(ARMS_RS, 'SIEGE_ARMS'), ORE_BASE_PER_HOUR: rsInt(ARMS_RS, 'ORE_BASE_PER_HOUR'), ORE_TERRAIN_MAX: rsInt(ARMS_RS, 'ORE_TERRAIN_MAX'),
  ORE_PER_HILLS: rsInt(ARMS_RS, 'ORE_PER_HILLS'), ORE_PER_MOUNTAIN: rsInt(ARMS_RS, 'ORE_PER_MOUNTAIN'), ORE_PER_IRON: rsInt(ARMS_RS, 'ORE_PER_IRON'),
  ORE_RADIUS: rsInt(ARMS_RS, 'ORE_RADIUS'),
};

// ------------------------------------------------------------------ the Rust formulas, each pinned to its text first
const has = (src, fn, piece) => assert.ok(fnBody(src, fn).replace(/\s+/g, ' ').includes(piece), `${fn} still reads: ${piece}`);
has(CATALOG, 'base_production', 'BASE_PROD[r] * (100 + tier_bonus_pct(t)) / 100 * MILLI');
has(ARMS_RS, 'base_production', 'b[Resource::Ore as usize] = terrain_ore.max(0) * (100 + catalog::tier_bonus_pct(t)) / 100;');
has(ARMS_RS, 'ore_around', 'Some((ORE_BASE_PER_HOUR + extra.min(ORE_TERRAIN_MAX)) * MILLI)');
has(HOLDING_RS, 'duplicate_cost', 'let k = n.saturating_sub(1) as u64;');
has(HOLDING_RS, 'duplicate_cost', 'base.checked_mul(2 + k * k)');
has(HOLDING_RS, 'duplicate_cost', 'Some(x) => Some(x / 2)');
has(CATALOG, 'build_secs', '3_600 + 1_800 * n as i64');
for (const fn of ['train', 'train_v2']) {
  has(CATALOG, fn, 'let k = n.div_ceil(100) as i64;');
  has(CATALOG, fn, 'c[Resource::Food as usize] = milli(k.checked_mul(TROOP_COST_PER_100[0])?)?;');
  has(CATALOG, fn, 'milli(k.checked_mul(TROOP_COST_PER_100[1])?.checked_mul(pc)? / TROOP_COST_BASE_PROD)?;');
  has(CATALOG, fn, 'milli(k.checked_mul(TROOP_COST_PER_100[2])?.checked_mul(pc)? / TROOP_COST_BASE_PROD)?;');
}
has(CATALOG, 'train', 'let pc = stats(unit_of(unit)?).prod_cost as i64;');
has(CATALOG, 'train_v2', 'let pc = train_prod_cost_v2(unit)?;');
has(ARMS_RS, 'train_v3', 'let mut c = train_v2(unit, n)?;');
has(ARMS_RS, 'train_v3', 'c[ARMS as usize] = k.checked_mul(per)?.checked_mul(MILLI)?;');

/** catalog::base_production(t), milli per hour, by resource. */
const rBase = t => RUST.BASE_PROD.map(b => Math.trunc((b * (100 + RUST.TIER_BONUS[t])) / 100) * 1000);
/** arms::base_production(t, terrain_ore): the tier's base with the ore replaced by the terrain ore under the tier bonus. */
const rBaseS1 = (t, terrainOre) => rBase(t).map((v, r) => (r === R('Ore') ? Math.trunc((Math.max(0, terrainOre) * (100 + RUST.TIER_BONUS[t])) / 100) : v));
/** arms ore_around's value for a terrain part `extra` (units): milli per hour. */
const rTerrainOre = extra => (RUST.ORE_BASE_PER_HOUR + Math.min(extra, RUST.ORE_TERRAIN_MAX)) * 1000;
/** holding::duplicate_cost(base, n), whole units. */
const rDup = (base, n) => Math.trunc((base * (2 + (Math.max(1, n) - 1) ** 2)) / 2);
const rBuildSecs = n => 3_600 + 1_800 * n;
/** train / train_v2 / arms::train_v3 by the page's program version (1: M1, 3: MC, 4: S1), whole units. */
function rTrain(unit, n, version) {
  if (n < 1 || unit > 6) return null;
  const pc = version >= 3 ? RUST.TRAIN_PROD_COST_V2[unit] : RUST.UNIT_STATS[unit].prod;
  const k = Math.ceil(n / 100), [food, ore, gold] = RUST.TROOP_COST_PER_100, c = Array(8).fill(0);
  c[R('Food')] = food * k;
  c[R('Ore')] = Math.trunc((ore * k * pc) / RUST.TROOP_COST_BASE_PROD);
  c[R('Gold')] = Math.trunc((gold * k * pc) / RUST.TROOP_COST_BASE_PROD);
  if (version >= 4) c[RUST.ARMS] = RUST.TRAIN_ARMS_PER_100[unit] * k;
  return c;
}
const sumUnits = milli => milli.reduce((a, v) => a + v, 0) / 1000;

// ------------------------------------------------------------------ a village as the page reads it
const T0 = 1_000_000;
const S1_SEASON = { layoutVersion: 2, programVersion: 4 };
function village(tier, production, { queue = [], tile = 30 } = {}) {
  const cap = BigInt(RUST.STORE_CAP[tier]);
  return { p: 2, q: 0, site: 3, gen: 1, tile, tier, flags: 0, walls: 0, queue, lastOwnerAction: undefined, foodShortfall: 0n,
    production: production.map(BigInt), upkeep: production.map(() => 0n),
    stores: production.map(v => ({ value: 0n, rate: BigInt(v), cap, t0: BigInt(T0), frac: 0n })) };
}

// ================================================================== the tables the page mirrors
test('the tables the page mirrors are the rules\' own: production, tiers, buildings, units, training, walls, S1', () => {
  assert.deepEqual([...RESOURCE_ORDER], RESOURCE, 'resources in the kernel\'s order (holding.rs Resource)');
  assert.deepEqual([...fland.UNIT_ORDER], RUST.UNIT_STATS.map(u => u.unit), 'units in the kernel\'s order (units.rs UNIT_STATS)');
  assert.deepEqual([...fland.BASE_PROD], RUST.BASE_PROD, 'catalog.rs BASE_PROD');
  assert.deepEqual([...fland.TIER_BONUS_PCT], RUST.TIER_BONUS, 'catalog.rs tier_bonus_pct');
  assert.deepEqual([...rb.STORE_CAP], RUST.STORE_CAP.map(v => v / 1000), 'holding.rs Tier::storage_cap (units)');
  assert.deepEqual([...rb.QUEUE_SLOTS], RUST.QUEUE_SLOTS, 'holding.rs Tier::queue_slots');
  assert.deepEqual([...rb.WORKED_RADIUS], RUST.WORKED_RADIUS, 'holding.rs Tier::worked_radius');
  // two page copies of the promotion: fland TIER_UPGRADES and rulebook TIER_UP
  for (let t = 0; t < 4; t++) {
    const want = RUST.TIER_UP[t];
    assert.deepEqual(rb.TIER_UP[t] && { cost: [...rb.TIER_UP[t].cost], secs: rb.TIER_UP[t].secs }, want, `rulebook TIER_UP[${TIER_NAMES[t]}]`);
    assert.deepEqual(fland.TIER_UPGRADES[t] ? { cost: [...fland.TIER_UPGRADES[t].cost], secs: fland.TIER_UPGRADES[t].secs } : null, want, `fland TIER_UPGRADES[${TIER_NAMES[t]}]`);
  }
  assert.equal(RUST.BUILDINGS.length, 6);
  RUST.BUILDINGS.forEach((b, item) => {
    const p = fland.BUILD_ITEMS[item];
    assert.deepEqual({ item: p.item, resource: p.resource, perHour: p.perHour, cost: [...p.cost] }, { item, ...b }, `catalog.rs BUILDINGS[${item}]`);
  });
  assert.equal(fland.BUILD_ITEMS[6].resource, 'Walls', 'item 6 is the walls (catalog.rs ITEM_WALLS)');
  assert.deepEqual({ step: rb.WALLS.step, stone: rb.WALLS.stone, secs: rb.WALLS.secs, max: rb.WALLS.max }, { step: RUST.WALL_STEP, stone: RUST.WALL_COST_STONE, secs: RUST.WALL_SECS, max: RUST.MAX_WALLS });
  assert.equal(rb.MAX_COPIES, RUST.MAX_COPIES);
  RUST.UNIT_STATS.forEach((u, i) => assert.deepEqual({ ...rb.UNIT_STATS[i] }, { unit: u.unit, cls: u.cls, strength: u.strength, move: u.move, prod: u.prod }, `units.rs UNIT_STATS[${u.unit}]`));
  assert.deepEqual({ ...rb.TRAIN_PER_100 }, { food: RUST.TROOP_COST_PER_100[0], ore: RUST.TROOP_COST_PER_100[1], gold: RUST.TROOP_COST_PER_100[2], baseProd: RUST.TROOP_COST_BASE_PROD });
  assert.deepEqual([...fland.TRAIN_PRODUCTION_COST], RUST.UNIT_STATS.slice(0, 7).map(u => u.prod), 'fland TRAIN_PRODUCTION_COST = units.rs prod_cost');
  assert.deepEqual([...fland.TRAIN_PRODUCTION_COST_CQ], RUST.TRAIN_PROD_COST_V2, 'fland TRAIN_PRODUCTION_COST_CQ = catalog.rs TRAIN_PROD_COST_V2');
  // S1 (arms.rs)
  assert.equal(RESOURCE_ORDER[RUST.ARMS], fs1.WORKSHOP.resource, 'arms live in the Horses slot');
  assert.equal(fs1.ARMS, RUST.ARMS);
  assert.deepEqual([...fs1.TRAIN_ARMS_PER_100], RUST.TRAIN_ARMS_PER_100);
  assert.equal(fs1.SIEGE_ARMS, RUST.SIEGE_ARMS);
  assert.equal(fs1.ORE_BASE_PER_HOUR, RUST.ORE_BASE_PER_HOUR);
  assert.deepEqual({ item: fs1.WORKSHOP.item, perHour: fs1.WORKSHOP.perHour, orePerArm: fs1.WORKSHOP.orePerArm, woodPerArm: fs1.WORKSHOP.woodPerArm, cost: [...fs1.WORKSHOP.cost] },
    { item: RUST.ITEM_WORKSHOP, perHour: RUST.WORKSHOP_ARMS_PER_HOUR, orePerArm: RUST.WORKSHOP_ORE_PER_HOUR / RUST.WORKSHOP_ARMS_PER_HOUR, woodPerArm: RUST.WORKSHOP_WOOD_PER_HOUR / RUST.WORKSHOP_ARMS_PER_HOUR, cost: RUST.WORKSHOP_COST });
});

// ================================================================== the figures the page derives
test('a village\'s base production at every tier (M1/MC: catalog::base_production; S1: arms::base_production with its terrain ore)', () => {
  for (let t = 0; t < 4; t++) {
    assert.deepEqual(fland.baseProduction(t).map(Number), rBase(t), `baseProduction(${TIER_NAMES[t]})`);
    for (const extra of [0, 1, 7, 30, 31, 60]) {
      assert.equal(Number(fs1.s1OreBase(extra, RUST.TIER_BONUS[t])), rBaseS1(t, rTerrainOre(extra))[R('Ore')], `s1OreBase(${extra}) at ${TIER_NAMES[t]}`);
    }
  }
  fs1.setS1(S1_SEASON);
  for (let t = 0; t < 4; t++) {
    const page = fs1.seasonBase(fland.baseProduction(t), { tile: 30 }, { oreExtra: 9, bonusPct: RUST.TIER_BONUS[t] }).map(Number);
    assert.deepEqual(page, rBaseS1(t, rTerrainOre(9)), `S1 seasonBase(${TIER_NAMES[t]})`);
  }
  // the map's terrain-ore reading (map/sprites.mjs oreAround) uses the rules' per-tile amounts, radius and cap
  const sprites = web('map/sprites.mjs');
  assert.match(sprites, new RegExp(`export const ORE_RADIUS = ${RUST.ORE_RADIUS};`));
  assert.ok(sprites.includes(`(t.name === 'hills' ? ${RUST.ORE_PER_HILLS} : t.name === 'mountain' ? ${RUST.ORE_PER_MOUNTAIN} : 0) + (t.res === 2 ? ${RUST.ORE_PER_IRON} : 0)`), 'hills, mountain and iron (byte 1 + TileResource::Iron = 2)');
  assert.match(sprites, /total: Math\.min\(ORE_TERRAIN_MAX, total\)/);
  assert.match(sprites, new RegExp(`ORE_TERRAIN_MAX = ${RUST.ORE_TERRAIN_MAX}\\b`));
});

test('the 収穫 button\'s 毎時 +N and the strip\'s rate per store, for a new village of every tier (M1/MC and S1)', () => {
  const cases = [];
  for (let t = 0; t < 4; t++) cases.push({ t, label: TIER_NAMES[t], production: rBase(t) });
  for (let t = 0; t < 4; t++) cases.push({ t, label: `S1 ${TIER_NAMES[t]} (terrain +9)`, production: rBaseS1(t, rTerrainOre(9)) });
  const want = cases.map(c => sumUnits(c.production));
  assert.deepEqual(want.slice(0, 4), [125, 186, 250, 342], 'the rules\' sums (60 + 45 + 30 + 22 + 22 + 7 = 186 at a Town, as proto-hand\'s harvest test says)');
  for (const [i, c] of cases.entries()) {
    const h = village(c.t, c.production);
    const strip = resourceModel(h, T0);
    // the strip: one token per store that produces, each at the rules' rate
    assert.deepEqual(strip.map(s => [s.resource, s.perHour, s.cap]), c.production.map((v, r) => [RESOURCE_ORDER[r], v / 1000, RUST.STORE_CAP[c.t] / 1000]).filter(x => x[1] !== 0), `${c.label}: the strip`);
    const hv = harvestModel({ stores: strip, rawHolding: h, holding: h, now: T0 });
    assert.equal(hv.total, 0, 'nothing has grown at the moment of the record');
    assert.equal(hv.perHour, want[i], `${c.label}: 毎時 +${want[i]}`);
    assert.equal(L`毎時 +${fmtNum(hv.perHour)}`, `毎時 +${fmtNum(want[i])}`);
    // an hour later: what has grown is each store's whole units (the stores keep the thousandths; an S1 ore rate
    // under a tier bonus can be a half: 13 × 150 / 100 = 19.5 an hour, so 毎時 +183.5 and +183 grown)
    const later = harvestModel({ stores: resourceModel(h, T0 + 3_600), rawHolding: h, holding: h, now: T0 + 3_600 });
    const grown = c.production.reduce((a, v) => a + Math.floor(v / 1000), 0);
    assert.equal(later.total, grown, `${c.label}: +${grown} an hour later`);
  }
  // a full store adds nothing to the figure
  const h = village(1, rBase(1));
  h.stores[0].value = BigInt(RUST.STORE_CAP[1]);
  assert.equal(harvestModel({ stores: resourceModel(h, T0), rawHolding: h, holding: h, now: T0 }).perHour, 186 - rBase(1)[0] / 1000);
  assert.ok(web('hud/hand.mjs').includes('L`毎時 +${fmtNum(hv.perHour)}`'), 'the button\'s own words');
});

test('each building\'s next copy: cost, time and yield for copies 1–4 at every tier, and the S1 workshop', () => {
  const have = Array(8).fill(1e12);
  for (let t = 0; t < 4; t++) for (let n = 1; n <= 4; n++) {
    // n − 1 copies of every building built over the tier's base (and n − 1 workshops)
    const production = rBase(t).slice();
    for (const b of RUST.BUILDINGS) production[R(b.resource)] += (n - 1) * b.perHour * 1000;
    production[RUST.ARMS] += (n - 1) * RUST.WORKSHOP_ARMS_PER_HOUR * 1000;
    const h = village(t, production);
    const offers = rb.buildOffers(h, { now: T0, have, faction: 1, s1: true });
    RUST.BUILDINGS.forEach((b, item) => {
      const o = offers.find(x => x.item === item);
      assert.deepEqual({ n: o.n, cost: o.cost, secs: o.secs, perHour: o.perHour, resource: o.resource },
        { n, cost: b.cost.map(c => rDup(c, n)), secs: rBuildSecs(n), perHour: b.perHour, resource: b.resource }, `${TIER_NAMES[t]}: building ${item}, copy ${n}`);
    });
    const ws = offers.find(x => x.item === RUST.ITEM_WORKSHOP);
    assert.deepEqual({ n: ws.n, cost: ws.cost, secs: ws.secs, perHour: ws.perHour }, { n, cost: RUST.WORKSHOP_COST.map(c => rDup(c, n)), secs: rBuildSecs(n), perHour: RUST.WORKSHOP_ARMS_PER_HOUR }, `${TIER_NAMES[t]}: workshop, copy ${n}`);
    const walls = offers.find(x => x.kind === 'walls');
    assert.deepEqual({ cost: walls.cost, secs: walls.secs }, { cost: [0, 0, RUST.WALL_COST_STONE, 0, 0, 0, 0, 0], secs: RUST.WALL_SECS }, 'walls at the neutral doctrine');
  }
  // the duplicate rule and the build time over every copy the catalog prices
  for (let n = 1; n <= RUST.MAX_COPIES; n++) {
    assert.equal(rb.buildSecs(n), rBuildSecs(n));
    for (const b of [...RUST.BUILDINGS.map(x => x.cost), RUST.WORKSHOP_COST, RUST.SETTLER_COST]) for (const c of b) assert.equal(rb.duplicateCost(c, n), rDup(c, n));
  }
  // S1 with the terrain known: the ore mine's copy counts from the terrain base, not the M1 base
  fs1.setS1(S1_SEASON);
  fs1.setOreExtraProvider(() => 9);
  for (let t = 0; t < 4; t++) {
    const production = rBaseS1(t, rTerrainOre(9));
    production[R('Ore')] += 2 * RUST.BUILDINGS[3].perHour * 1000;
    assert.equal(rb.copyNumber(village(t, production), 3), 3, `S1 ${TIER_NAMES[t]}: two mines built, the next is the third`);
  }
});

test('the promotion card at every tier: cost, time, the base bonus, the store cap, the slots and the land', () => {
  for (let t = 0; t < 4; t++) {
    const p = rb.promotionOffer(village(t, rBase(t)), { now: T0, have: Array(8).fill(1e9) });
    if (!RUST.TIER_UP[t]) { assert.equal(p, null, 'none at the top tier'); continue; }
    assert.deepEqual({ cost: p.cost, secs: p.secs, prodPct: p.gives.prodPct, cap: p.gives.cap, slots: p.gives.slots, radius: p.gives.radius }, {
      cost: RUST.TIER_UP[t].cost, secs: RUST.TIER_UP[t].secs, prodPct: [RUST.TIER_BONUS[t], RUST.TIER_BONUS[t + 1]],
      cap: [RUST.STORE_CAP[t] / 1000, RUST.STORE_CAP[t + 1] / 1000], slots: [RUST.QUEUE_SLOTS[t], RUST.QUEUE_SLOTS[t + 1]], radius: [RUST.WORKED_RADIUS[t], RUST.WORKED_RADIUS[t + 1]],
    }, `${TIER_NAMES[t]} → ${TIER_NAMES[t + 1]}`);
    // (gives.base: the M1/MC catalog's gain; not drawn by the hand's card, which shows the bonus in percent)
    assert.deepEqual(p.gives.base, rBase(t + 1).map((v, r) => (v - rBase(t)[r]) / 1000));
  }
});

test('the strip after a promotion is done, before the next record (M1/MC): the new tier\'s base (catalog::base_production) and cap (doc O1: the program\'s settle_tiered reads arms::base_production)', () => {
  for (let t = 0; t < 3; t++) {
    const h = village(t, rBase(t), { queue: [{ kind: fland.QUEUE_KIND.TIER_UP, arg: 0, delta: 0, doneAt: T0 + 10 }] });
    const s = fland.storesAt(h, T0 + 3_600, RESOURCE_ORDER);
    assert.deepEqual(s.map(x => x.perHour), rBase(t + 1).map(v => v / 1000), `${TIER_NAMES[t]} → ${TIER_NAMES[t + 1]}: rates`);
    assert.ok(s.every(x => x.cap === RUST.STORE_CAP[t + 1] / 1000), 'caps');
  }
  // the projection's clamps are the rules' (holding.rs MAX_PRODUCTION_PER_HOUR, MAX_UPKEEP_PER_HOUR, storage_cap)
  const src = web('fland.mjs');
  assert.ok(src.includes(`clampBig(h.production[i],0n,${RUST.MAX_PRODUCTION_PER_HOUR}n)`), 'production clamp');
  assert.ok(src.includes(`clampBig(h.upkeep[i],0n,${RUST.MAX_UPKEEP_PER_HOUR}n)`), 'upkeep clamp');
  assert.ok(src.includes(`BigInt([${RUST.STORE_CAP.map(v => v / 1000).join(',')}][h.tier])*1000n`), 'caps at a tier-up');
});

test('the strip after a promotion is done on S1: the ore rate rises by the terrain ore\'s bonus (arms::base_production in settle_tiered)', () => {
  fs1.setS1(S1_SEASON);
  fs1.setOreExtraProvider(() => 9);
  for (let t = 0; t < 3; t++) {
    const h = village(t, rBaseS1(t, rTerrainOre(9)), { queue: [{ kind: fland.QUEUE_KIND.TIER_UP, arg: 0, delta: 0, doneAt: T0 + 10 }] });
    const s = fland.storesAt(h, T0 + 3_600, RESOURCE_ORDER);
    assert.equal(s[R('Ore')].perHour, rBaseS1(t + 1, rTerrainOre(9))[R('Ore')] / 1000, `S1 ${TIER_NAMES[t]} → ${TIER_NAMES[t + 1]}: ore an hour`);
  }
});

test('training for every unit the page trains, under M1, MC and S1, for 1 to 30,000 troops (both page copies)', () => {
  for (const version of [1, 3, 4]) for (let unit = 0; unit <= 7; unit++) for (const n of [1, 99, 100, 101, 250, 1_000, 30_000]) {
    const want = rTrain(unit, n, version);
    assert.deepEqual(rb.trainCost(unit, n, version), want, `rulebook trainCost(${fland.UNIT_ORDER[unit]}, ${n}, v${version})`);
    assert.deepEqual(fland.trainingCost(unit, n, version), want, `fland trainingCost(${fland.UNIT_ORDER[unit]}, ${n}, v${version})`);
  }
  // the most the stores pay for: the largest hundred whose cost fits
  const have = [1_000, 0, 0, 500, 120, 300, 0, 0];
  for (const version of [1, 3, 4]) for (let unit = 0; unit <= 6; unit++) {
    let k = 0;
    while (k < 300 && rTrain(unit, (k + 1) * 100, version).every((c, r) => c <= have[r])) k++;
    assert.equal(rb.maxTrain(unit, have, version), k * 100, `maxTrain(${fland.UNIT_ORDER[unit]}, v${version})`);
  }
});

test('the settler\'s cost of the next village (citizen.rs settler_cost = duplicate_cost(SETTLER_COST, n))', () => {
  for (let n = 1; n <= 6; n++) assert.deepEqual(settlerCost(n), RUST.SETTLER_COST.map(c => rDup(c, n)), `with ${n} villages`);
});

// ================================================================== the words round each figure
const CJK = /[぀-ヿ㐀-鿿]/;
const BANNED_EN = /\bbell \d|\bsecret|beacon|settl|\bseeds?\b|site ticket|keeper|lamport/i;
const AMERICAN = /\b(colors?|colored|centers?|centered|neighbor\w*|defenses?|favor\w*|honor\w*|armor\w*|labor\w*|gray|traveled|traveling|meters?|liters?|fulfill|analyze\w*|catalog)\b/i;

test('each economy figure\'s English is British and free of the play screen\'s banned words', () => {
  // each line as the page writes it (the source must still hold it), then its English with real figures
  const LINES = [
    ['hud/hand.mjs', 'L`毎時 +${fmtNum(hv.perHour)}`', () => L`毎時 +${fmtNum(186)}`],
    ['hud/hand.mjs', 'L`満杯 ${fmtNum(hv.full.length)}`', () => L`満杯 ${fmtNum(2)}`],
    ['hud/hand.mjs', 'L`いまは納めるものがありません（命令のたびに蔵は納められます）。蔵は毎時 +${fmtNum(hv.perHour)} 増えています`', () => L`いまは納めるものがありません（命令のたびに蔵は納められます）。蔵は毎時 +${fmtNum(186)} 増えています`],
    ['hud/hand.mjs', 'L`前の収穫から ${hv.parts.map(x => `${RESOURCES[x.resource]} +${fmtNum(x.n)}`).join(\' · \')}（上の数字にもう入っています）。押すと蔵の記録に納めます`', () => L`前の収穫から ${`${RESOURCES.Food} +${fmtNum(60)}`}（上の数字にもう入っています）。押すと蔵の記録に納めます`],
    ['hud/hand.mjs', 'L`蔵は時間で増えます。押すと蔵の記録に納めます`', () => L`蔵は時間で増えます。押すと蔵の記録に納めます`],
    ['hud/hand.mjs', 'L`${RESOURCES[o.resource]} +${fmtNum(o.perHour)}/時`', () => RUST.BUILDINGS.map(b => L`${RESOURCES[b.resource]} +${fmtNum(b.perHour)}/時`).join(' | ')],
    ['hud/hand.mjs', 'L`守り +100`', () => L`守り +100`],
    ['hud/hand.mjs', 'L`100人`', () => L`100人`],
    ['hud/hand.mjs', 'L`${TIERS[promo.to]}へ：${costWords(promo.cost)}`', () => [1, 2, 3].map(t => L`${TIERS[t]}へ：${costWords(RUST.TIER_UP[t - 1].cost)}`).join(' | ')],
    ['hud/hand.mjs', 'L`村の基本の産出`', () => L`村の基本の産出`],
    ['hud/hand.mjs', 'L`蔵の上限（資源ごと）`', () => L`蔵の上限（資源ごと）`],
    ['hud/hand.mjs', 'L`同時に建てられる数`', () => L`同時に建てられる数`],
    ['hud/hand.mjs', 'L`村のまわり（マス）`', () => L`村のまわり（マス）`],
    ['hud/hand.mjs', 'L`${b}（変わりません）`', () => L`${fmtNum(4)}（変わりません）`],
    ['hud/hud.mjs', 'L`毎時 ${signedResourceRate(r.perHour)}`', () => L`毎時 ${'+60'}`],
    ['hud/hud.mjs', 'L`${signedResourceRate(r.perHour)}/時`', () => L`${'−5'}/時`],
    ['hud/hud.mjs', 'L`合計 ${fmtNum(b.total)} · 毎時 ${signedResourceRate(b.perHour)}`', () => L`合計 ${fmtNum(1_200)} · 毎時 ${'+60'}`],
    ['hud/orderparts.mjs', 'L`費用：${costWords(cost)}`', () => [0, 1, 2, 3, 4, 5, 6].map(u => L`費用：${costWords(rb.trainCost(u, 100, 4))}`).join(' | ')],
    ['hud/orderparts.mjs', 'L`足りない：${short.map(', () => L`足りない：${`${RESOURCES.Ore} ${fmtNum(20)}`}`],
    ['hud/orderparts.mjs', 'L`強さ ${fmtNum(s)}`', () => [0, 1, 2, 3, 4, 5, 6].map(u => unitStrength(u)).join(' | ')],
    ['hud/orderparts.mjs', 'L`費用なし`', () => L`費用なし`],
    ['screens/holding.mjs', 'L`現在の維持費（毎時）`', () => L`現在の維持費（毎時）`],
  ];
  for (const [file, src] of LINES) assert.ok(web(file).includes(src), `${file} still writes ${src}`);
  setLang('en');
  const names = [...RESOURCE_ORDER.map(r => RESOURCES[r]), ...[0, 1, 2, 3].map(t => TIERS[t])];
  for (const t of [...LINES.map(([, , en]) => en()), resourceTitle(resourceModel(village(1, rBase(1)), T0)[0]), ...names]) {
    assert.doesNotMatch(t, CJK, `in English: ${t}`);
    assert.doesNotMatch(t, BANNED_EN, `no banned word: ${t}`);
    assert.doesNotMatch(t, AMERICAN, `British spelling: ${t}`);
  }
  // and the figures survive the English; on S1 the Horses slot is said as arms
  assert.equal(L`毎時 +${fmtNum(186)}`, '+186 per hour');
  assert.equal(L`費用：${costWords(rb.trainCost(3, 100, 4))}`, 'Cost: Food 60 · Ore 40 · Horses 50 · Gold 20');
  fs1.setS1(S1_SEASON);
  const s1Line = L`費用：${costWords(rb.trainCost(3, 100, 4))}`;
  assert.match(s1Line, /^Cost: Food 60 · Ore 40 · Arms 50 · Gold 20$/i, s1Line);
  assert.doesNotMatch(s1Line, BANNED_EN); assert.doesNotMatch(s1Line, AMERICAN);
  assert.equal(L`守り +100`, `Defence +${RUST.WALL_STEP}`);
});
