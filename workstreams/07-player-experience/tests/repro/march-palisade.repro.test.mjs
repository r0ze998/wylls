// REPRO (workstream 07): these tests pin a defect AS THE BASE PAGE HAS IT (a997a756, before patches/). They pass
// on the base and are EXPECTED TO FAIL once the patch that fixes the defect is applied. They are evidence, not part of
// any regular suite: the regular tests are ../*.test.mjs here and permutation-gateway/test/web-frontier-ws07-*.test.mjs
// in the patches (INTEGRATION.ja.md §2).
// Workstream 07: a march planned through a palisade that stops it. The program
// refuses such a walk at Reveal (reveal.rs `walk`: a step into a stopping
// palisade's tile is `Path`; S1-1E-CONTRACT §2.5), and the contract asks
// every client to plan around it. The kernel's planner can: it takes the
// hexes to avoid (`blocked`). The page passes none.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Kernel } from '../../../../permutation-server/web/frontier/wasm.mjs';
import { planRoute } from '../../../../permutation-server/web/frontier/fmarch.mjs';
import { blockedHexes, marchWatch, watchOf, stepTiles, KIND_PALISADE } from '../../src/s1walk.mjs';

const WEB = new URL('../../../../permutation-server/web/frontier/', import.meta.url);
const src = p => readFileSync(new URL(p, WEB), 'utf8');
const k = new Kernel((await WebAssembly.instantiate(readFileSync(new URL('wasm/frontier-v3.wasm', WEB)), {})).instance.exports);
const seeds = [1, 2, 3].map(ring => ({ ring, seed: Array.from({ length: 32 }, (_, i) => (i * 7 + ring) & 0xff).map(x => x.toString(16).padStart(2, '0')).join('') }));
const from = { p: 1, q: 0, tile: 30 }, to = { p: 1, q: 0, tile: 34 };

const CONTRACT = readFileSync(new URL('../../../../docs/frontier/stage1e/S1-1E-CONTRACT.md', import.meta.url), 'utf8');

test('REPRO: no caller of the march planner gives it the palisades (app.mjs, controller.mjs, fkeepreach.mjs)', () => {
  const calls = ['app.mjs', 'controller.mjs', 'fkeepreach.mjs'].flatMap(f => (src(f).match(/planRoute\((?:k|kernel), \{[^}]*\}[^)]*\)/g) ?? []).map(c => [f, c]));
  assert.equal(calls.length, 3, JSON.stringify(calls));
  for (const [f, c] of calls) assert.doesNotMatch(c, /blocked/, `${f}: ${c}`);
  assert.match(CONTRACT, /`fastest_path` callers \(keeper, clients\) remove the stopped palisade\s+tiles from the passable mask/);
});
