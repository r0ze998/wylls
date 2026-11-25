// The land chip's per-hour figure after a building or a promotion is done (2026-11-16). ClaimLandYield credits
// `yield_for(production, bonus, bells)` with the production of the village AFTER `settle_tiered(now)` (proc/land.rs):
// a finished building or promotion already counts. The strip reads the village the same way (app.mjs settledHolding →
// hud/rulebook.mjs settled), but the chip read the stored record, so its 「毎時 +N」 lagged until an instruction landed
// on the village. Now the chip is given the settled village too. No rule changed; the chip's own formula is unchanged.
// KEY-FREE: no key, nothing signed or sent, no request, nothing stored. Synthetic records only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { landSummary, landYieldPerHour } from '../../permutation-server/web/frontier/land.mjs';
import { settled } from '../../permutation-server/web/frontier/hud/rulebook.mjs';
import { baseProduction } from '../../permutation-server/web/frontier/fland.mjs';

const read = rel => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');
const F = 1, P = 2, Q = 0;
// one village of nation 1 in the province, 5 tiles claimed: 5 × 200 / 1 = 1000 bps (10%)
const FS = { provinces: new Map([[`${P},${Q}`, { province: { p: P, q: Q, siteMirror: [{ state: 1, faction: F }, { state: 0, faction: 0 }] }, land: { claimed: [0, 5, 0, 0, 0, 0], totals: [0, 6, 0, 0, 0, 0] } }]]) };
const village = (tier, queue) => {
  const production = baseProduction(tier).map(BigInt);
  return { p: P, q: Q, site: 0, gen: 0, tile: 30, tier, faction: F, production, upkeep: Array(8).fill(0n), queue,
    stores: production.map(r => ({ value: 1_000_000n, rate: r, cap: 2_000_000_000n, t0: 0n, frac: 0n })) };
};
const BPS = 1000;

test('the program: the yield reads the production after settle_tiered (pinned as text)', () => {
  const src = read('permutation-frontier/src/proc/land.rs');
  assert.match(src, /settle_tiered\(&mut k, now, ore\)\?;\s*let y = fl::yield_for\(k\.production, bonus, bells\);/);
  assert.match(read('frontier-abi/src/land_preview.rs'), /\(v\.max\(0\) as i128 \* bonus_bps as i128 \* bells as i128 \/ \(10_000 \* BELLS_PER_HOUR as i128\)\)\s+as i64/);
});

test('a production building done before now: the chip counts it, as the strip and the program do', () => {
  const h = village(1, [{ kind: 1, arg: 0, delta: 200_000n, doneAt: 400n }]);   // +200 Food an hour, done at t=400
  const raw = landSummary(FS, h, F), now = landSummary(FS, settled(h, 3_600), F);
  assert.equal(raw.bonusPct, 10); assert.equal(now.bonusPct, 10);
  assert.equal(now.perHour, landYieldPerHour(settled(h, 3_600).production, BPS));
  assert.equal(now.perHour - raw.perHour, 20, '10% of the +200 Food the building makes (the record still said the old figure)');
  assert.equal(landSummary(FS, settled(h, 300), F).perHour, raw.perHour, 'not before it is done');
});

test('a promotion done before now: the chip counts the new tier\'s base', () => {
  const h = village(0, [{ kind: 3, arg: 0, delta: 0n, doneAt: 100n }]);
  const s = settled(h, 3_600);
  assert.equal(Number(s.tier), 1);
  assert.equal(landSummary(FS, s, F).perHour, landYieldPerHour(baseProduction(1), BPS));
  assert.ok(landSummary(FS, s, F).perHour > landSummary(FS, h, F).perHour, 'more than the Hamlet\'s figure the record still held');
});

test('nothing finished: the same figure either way', () => {
  const h = village(1, [{ kind: 1, arg: 0, delta: 200_000n, doneAt: 9_000n }]);
  assert.deepEqual(landSummary(FS, settled(h, 3_600), F), landSummary(FS, h, F));
});

test('the page: the chip is given the settled village, the same as the strip (pinned as text)', () => {
  const a = read('permutation-server/web/frontier/app.mjs');
  assert.match(a, /const settledHolding = \(h, now\) => \{ try \{ return h \? settled\(h, now\) : h; \} catch \{ return h; \} \};/);
  // (food-net-caravan, owner Q-LP17-2: the strip is still given the SETTLED village; it is also told the land upkeep
  //  charged to that village, so the food rate it shows is net — the third argument)
  assert.match(a, /hud\.resourceModel\(settledHolding\(hud\.activeHolding\(FS\), now \?\? 0\), now \?\? 0, \{ land: landUpkeepMilli\(FS, hud\.activeHolding\(FS\)\) \}\)/, 'the strip');
  assert.match(a, /const ls = lh \? landSummary\(FS, settledHolding\(lh, now \?\? 0\), lf\) : null, le = lh \? landElsewhere\(FS, lh, lf\) : null;/, 'the chip');
});
