// fs1.mjs seasonBase takes the terrain ore stored on the holding first (Lane C P3, 2026-11-16; WRITTEN, NOT RUN — all
// new test runs were paused when this was written, so these are paper cases until the coordinator lets them run).
// The program counts a village's buildings against arms::base_production(tier, terrain_ore) with the terrain ore
// stored on the Holding (proc/holding.rs copy_number, settle_tiered; holding2 TERRAIN_ORE). The page took the ore base
// from the map's reading only, so with the map unread copyNumber fell back to the M1 base (15,000) and read a village
// with stored ore 13,000 and one mine (19,000) as having no mine.
// Every expected figure is worked by hand from the Rust. Imports fs1.mjs and its readers (rulebook, onboarding, board,
// fland), as web-frontier-uplift.test.mjs does; the Rust is read as text.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setS1, setOreExtraProvider, seasonBase, storedTerrainOre } from '../../permutation-server/web/frontier/fs1.mjs';
import { baseProduction, storesAt } from '../../permutation-server/web/frontier/fland.mjs';
import { copyNumber } from '../../permutation-server/web/frontier/hud/rulebook.mjs';
import { hasBuilt } from '../../permutation-server/web/frontier/onboarding.mjs';
import { buildingsOf } from '../../permutation-server/web/frontier/map/board.mjs';
import { RESOURCE_ORDER } from '../../permutation-server/web/frontier/resources.mjs';

const read = rel => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');
const ORE = 3, MINE = 3;          // the Ore slot; the mine is build item 3 (6 ore an hour)
const S1 = { layoutVersion: 2, programVersion: 4 }, M1 = { layoutVersion: 1, programVersion: 1 };
const h = (ore, extra = {}) => ({ p: 2, q: -2, tile: 41, tier: 0, production: [0, 0, 0, ore, 0, 0, 0, 0].map(BigInt), queue: [], ...extra });
const withS1 = fn => { setS1(S1); try { fn(); } finally { setOreExtraProvider(null); setS1(M1); } };

test('the Rust read: copy_number and settle_tiered take the stored terrain ore; holding_base_production reads 0 as none', () => {
  const proc = read('permutation-frontier/src/proc/holding.rs');
  assert.match(proc, /let base = arms::base_production\(h\.tier, terrain_ore\)\[bd\.resource as usize\];/);
  assert.match(proc, /let built = \(h\.production\[r\]\.saturating_sub\(base\)\)\.max\(0\) \/ per\.max\(1\);/);
  assert.match(proc, /u32::try_from\(built \+ queued \+ 1\)/);
  assert.match(proc, /pub fn terrain_ore\(d: &\[u8\]\) -> R<i64> \{\s*Ro\(d\)\.i64\(H2::TERRAIN_ORE\)/);
  const arms = read('permutation-rules/src/frontier/arms.rs');
  assert.match(arms, /b\[Resource::Ore as usize\] = terrain_ore\.max\(0\) \* \(100 \+ catalog::tier_bonus_pct\(t\)\) \/ 100;/);
  assert.match(arms, /pub fn holding_base_production\(t: Tier, terrain_ore: i64\) -> \[i64; RESOURCES\] \{\s*if terrain_ore > 0 \{/);
});

test('P3: stored ore 13,000 and one mine (19,000), map unread: one mine built, the next is the second', () => withS1(() => {
  const v = h(19_000, { terrainOre: 13_000n });
  // Rust: (19000 − 13000) / 6000 = 1 built, + 0 queued + 1 = 2. The page read (19000 − 15000) / 6000 = 0 → 1.
  assert.equal(copyNumber(v, MINE), 2);
  assert.equal(buildingsOf(v)[MINE], 1, 'the village picture draws the mine (was 0: ore not known)');
  assert.equal(hasBuilt(v), true, 'the guide sees the building (was false: ore not known)');
  // terrain ore alone is not a building
  const bare = h(13_000, { terrainOre: 13_000n });
  assert.equal(copyNumber(bare, MINE), 1);
  assert.equal(buildingsOf(bare)[MINE], 0);
  assert.equal(hasBuilt(bare), false);
}));

test('P3: the stored value goes before a map reading, registered or passed', () => withS1(() => {
  setOreExtraProvider(() => 20);   // the map says 4 + 20 = 24,000
  const v = h(19_000, { terrainOre: 13_000n });
  assert.equal(copyNumber(v, MINE), 2);
  assert.equal(buildingsOf(v, { oreExtra: 20 })[MINE], 1, 'explicit oreExtra: the stored value still decides (the program has no other)');
  assert.equal(hasBuilt(v), true);
}));

test('P3: the tier bonus applies to the stored value (× (100 + bonus) / 100, truncated)', () => withS1(() => {
  // Village (+50%): 13000 × 150 / 100 = 19500; one mine → 25500 → copy 2
  assert.equal(copyNumber(h(25_500, { tier: 1, terrainOre: 13_000n }), MINE), 2);
  // Town (+100%): 26000; two mines → 38000 → 2 built → copy 3
  assert.equal(copyNumber(h(38_000, { tier: 2, terrainOre: 13_000n }), MINE), 3);
  assert.equal(buildingsOf(h(38_000, { tier: 2, terrainOre: 13_000n }))[MINE], 2);
  // Stronghold (+175%): 13001 × 275 / 100 = 35752 (35752.75 truncated)
  assert.equal(seasonBase(baseProduction(3), h(0, { tier: 3, terrainOre: 13_001n }), { bonusPct: 175 })[ORE], 35_752n);
}));

test('the existing contracts hold: M1/MC, no stored value, 0 or a non-integer, a Number from a fixture', () => {
  setS1(M1);
  const m1 = baseProduction(0);
  assert.deepEqual(seasonBase(m1, h(19_000, { terrainOre: 13_000n })), m1, 'off S1: the tier base unchanged');
  withS1(() => {
    // no stored value: the map's reading as before, else unknown
    assert.equal(seasonBase(m1, { tile: 30 }, { oreExtra: 9 })[ORE], 13_000n);
    assert.equal(seasonBase(m1, h(19_000))[ORE], null);
    // 0 (reserved bytes) and shapes that are not an i64 are no stored value
    for (const terrainOre of [0n, -5n, 0, '13000', 1.5, null, undefined]) {
      assert.equal(storedTerrainOre({ terrainOre }), null, String(terrainOre));
      assert.equal(seasonBase(m1, h(19_000, { terrainOre }), { oreExtra: 9 })[ORE], 13_000n, `${String(terrainOre)}: the map`);
      assert.equal(seasonBase(m1, h(19_000, { terrainOre }))[ORE], null, `${String(terrainOre)}: unknown`);
    }
    // a hand-built fixture's Number is read like the decoded BigInt
    assert.equal(storedTerrainOre({ terrainOre: 13_000 }), 13_000n);
    assert.equal(copyNumber(h(19_000, { terrainOre: 13_000 }), MINE), 2);
    // the other entries are the tier's base whatever is stored
    assert.deepEqual(seasonBase(m1, h(0, { terrainOre: 13_000n })).filter((_, i) => i !== ORE), m1.filter((_, i) => i !== ORE));
  });
});

test('paper effect on fland.projectedHolding (candidate code, unchanged): a promotion takes the stored ore too', () => withS1(() => {
  // Hamlet → Village with stored 13000: ore 13000 → 19500 (the page with the map unread went 15000 → 22000: 20/h)
  const T0 = 1_000_000, production = [40_000, 30_000, 20_000, 13_000, 0, 15_000, 5_000, 0];
  const v = { ...h(0), production: production.map(BigInt), upkeep: Array(8).fill(0n), terrainOre: 13_000n, lastOwnerAction: T0,
    queue: [{ kind: 3, arg: 0, delta: 0, doneAt: T0 + 10 }],
    stores: production.map(r => ({ value: 100_000n, rate: BigInt(r), cap: 2_000_000n, t0: BigInt(T0), frac: 0n })) };
  assert.equal(storesAt(v, T0 + 20, RESOURCE_ORDER)[ORE].perHour, 19.5);
}));
