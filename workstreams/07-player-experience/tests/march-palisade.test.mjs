// Workstream 07: a march planned through a palisade that stops it. The program
// refuses such a walk at Reveal (reveal.rs `walk`: a step into a stopping
// palisade's tile is `Path`; S1-1E-CONTRACT §2.5), and the contract asks
// every client to plan around it. The kernel's planner can: it takes the
// hexes to avoid (`blocked`). The page passes none.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Kernel } from '../../../permutation-server/web/frontier/wasm.mjs';
import { planRoute } from '../../../permutation-server/web/frontier/fmarch.mjs';
import { blockedHexes, marchWatch, watchOf, stepTiles, KIND_PALISADE } from '../src/s1walk.mjs';

const WEB = new URL('../../../permutation-server/web/frontier/', import.meta.url);
const src = p => readFileSync(new URL(p, WEB), 'utf8');
const k = new Kernel((await WebAssembly.instantiate(readFileSync(new URL('wasm/frontier-v3.wasm', WEB)), {})).instance.exports);
const seeds = [1, 2, 3].map(ring => ({ ring, seed: Array.from({ length: 32 }, (_, i) => (i * 7 + ring) & 0xff).map(x => x.toString(16).padStart(2, '0')).join('') }));
const from = { p: 1, q: 0, tile: 30 }, to = { p: 1, q: 0, tile: 34 };

const CONTRACT = readFileSync(new URL('../../../docs/frontier/stage1e/S1-1E-CONTRACT.md', import.meta.url), 'utf8');

test('the planner\'s fastest road meets a stopping palisade; given its hex, the planner goes round it', () => {
  const plain = planRoute(k, { from, to, unit: 0, seeds });
  assert.equal(plain.ok, true);
  const on = stepTiles(from, plain.route.dirs)[1];
  const structures = [{ kind: KIND_PALISADE, p: on.p, q: on.q, tile: on.tile, faction: 3 }];
  const lands = [{ p: 1, q: 0, rough: 0n, road: 0n, watch: watchOf(structures, null, 0, false) }];
  assert.equal(marchWatch(from, plain.route.dirs, lands), 'blocked', 'the program would refuse this walk at Reveal');
  const round = planRoute(k, { from, to, unit: 0, seeds, blocked: blockedHexes(structures, null, 0, false) });
  assert.equal(round.ok, true);
  assert.notEqual(marchWatch(from, round.route.dirs, lands), 'blocked');
  assert.ok(round.route.dirs.length >= plain.route.dirs.length);
  // the walker's own nation's palisade, and one at passage toward it, stop nothing
  assert.deepEqual(blockedHexes([{ ...structures[0], faction: 0 }], null, 0, false), []);
  const pass = Array.from({ length: 6 }, (_, n) => Array.from({ length: 6 }, (_, f) => (n === 3 && f === 0 ? 1 : 0)));
  assert.deepEqual(blockedHexes(structures, pass, 0, false), []);
  assert.equal(blockedHexes([{ ...structures[0], faction: 0 }], null, 0, true).length, 1, 'an expelled village is stopped by its own nation');
});
