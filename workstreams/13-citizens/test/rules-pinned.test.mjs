// The test world's figures are the game's: each is read back from its source here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { src } from './helpers.mjs';
import * as R from '../world/rules.mjs';

const rustConst = (text, name) => { const m = new RegExp(`pub const ${name}: [^=]+= ([^;]+);`).exec(text); assert.ok(m, name); return m[1].replace(/_/g, ''); };
const arr = s => s.replace(/[[\]\s]/g, '').split(',').map(Number);

test('starter kit, base production and the Hamlet cap are the Rust rules\'', () => {
  const cat = src('permutation-rules/src/frontier/catalog.rs');
  assert.deepEqual([...R.STARTER_KIT], arr(rustConst(cat, 'STARTER_KIT')));
  assert.deepEqual([...R.BASE_PROD], arr(rustConst(cat, 'BASE_PROD')));
  assert.match(src('permutation-rules/src/frontier/holding.rs'), /Tier::Hamlet => 2_000 \* MILLI/);
  assert.equal(R.HAMLET_CAP, 2000);
});

test('caravan speed and fee, the flat hex, the action bucket', () => {
  const car = src('permutation-rules/src/frontier/caravan.rs');
  assert.equal(R.CARAVAN_SLOW_BPS, Number(rustConst(car, 'CARAVAN_SLOW_BPS')));
  assert.equal(R.CARAVAN_FEE, Number(rustConst(car, 'CARAVAN_FEE')));
  assert.equal(R.FLAT_HEX_SECS, Number(rustConst(src('permutation-rules/src/frontier/travel.rs'), 'FLAT_HEX_SECS')));
  const p = src('frontier-abi/src/presets.rs');
  assert.match(p, /bucket_rate_per_h: 30,/);
  assert.match(p, /bucket_burst: 60,/);
  assert.deepEqual(R.BUCKET, { perHour: 30, burst: 60 });
  assert.equal(R.RELAY_PER_DAY, 40);
});

test('pledge-only goods never move, and a 5-hex road takes 2 bells', () => {
  assert.ok(!R.MOVABLE.includes('Science') && !R.MOVABLE.includes('Influence'));
  assert.equal(R.caravanBells({ q: 0, r: 0 }, { q: 5, r: -2 }), 2);
  assert.equal(R.BELL_SECS, 600);
});
