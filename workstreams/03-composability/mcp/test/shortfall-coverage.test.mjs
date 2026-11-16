// WRITTEN, NOT RUN (2026-11-17, under an execution pause): no part of this file has been executed. It imports
// src/game.mjs, which imports permutation-server/web/frontier modules (herald, faddr, fland, fcaravan, fplay) — the same
// closure the existing ③ tests load through the server; that closure was not re-checked for this file, so it is NOT
// claimed key-free: run it only through the repository's key-free guard once runs are allowed again.
//
// check_resource_shortfall tells "no storehouse can help" apart from "the storehouses are not known":
//   C1 the caravan feed not read: storehouseSources [] with storehouseCoverage 'unavailable'
//   C2 some storehouses with unknown stores: 'partial', listed in storehousesUnknown, never counted as 0
//   C3 every storehouse read and none holds a short resource: [] with 'complete'
//   C4 the village's need / have / short / hours and `enough` are the same in every case
//   C5 the tool description names the three cases
// Views are plain objects (Game.shortfall reads view.resources, view.village.stores, view.places, view.feedOk).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Game } from '../src/game.mjs';

const R = ['Food', 'Wood', 'Stone', 'Ore', 'Arms', 'Gold', 'Science', 'Influence'];
const stores = have => R.map((r, i) => ({ resource: r, have: have[i] ?? 0, perHour: i === 2 ? 10 : 0, cap: 1000 }));
const village = { kind: 'holding', placeId: 'holding:1,1,0', stores: stores([0, 0, 100]) };
const vault = (id, have) => ({ kind: 'vault', placeId: id, known: Array.isArray(have), stores: Array.isArray(have) ? stores(have) : null });
const goal = { kind: 'amounts', amounts: { Stone: 300 } };
const view = (places, feedOk) => ({ resources: R, village, places: [village, ...places], feedOk });

test('C1 the feed not read: unavailable, not "none can help"', () => {
  const s = Game.shortfall(view([], false), goal);
  assert.deepEqual([s.storehouseSources, s.storehouseCoverage, s.storehousesUnknown], [[], 'unavailable', []]);
});

test('C2 some storehouses unknown: partial, listed, not counted', () => {
  const s = Game.shortfall(view([vault('vault:1,1,33', [0, 0, 400]), vault('vault:2,2,33', null)], true), goal);
  assert.equal(s.storehouseCoverage, 'partial');
  assert.deepEqual(s.storehousesUnknown, ['vault:2,2,33']);
  assert.deepEqual(s.storehouseSources, [{ placeId: 'vault:1,1,33', covers: [{ resource: 'Stone', available: 400, short: 200 }] }]);
});

test('C3 all read, none holds it: complete and empty', () => {
  const s = Game.shortfall(view([vault('vault:1,1,33', [5, 5, 0])], true), goal);
  assert.deepEqual([s.storehouseSources, s.storehouseCoverage, s.storehousesUnknown], [[], 'complete', []]);
});

test('C4 the village rows do not depend on the storehouses', () => {
  const a = Game.shortfall(view([], false), goal), b = Game.shortfall(view([vault('vault:1,1,33', [0, 0, 400])], true), goal);
  assert.deepEqual([a.rows, a.enough], [b.rows, b.enough]);
  assert.deepEqual(a.rows, [{ resource: 'Stone', need: 300, have: 100, short: 200, perHour: 10, hoursByProduction: 20 }]);
});

test('C5 the tool description names the cases', () => {
  const tools = readFileSync(new URL('../src/tools.mjs', import.meta.url), 'utf8');
  assert.match(tools, /storehouseCoverage says whether the storehouses were read \(complete\), partly \(partial/);
  assert.match(tools, /an empty storehouseSources means none can help only when complete/);
});
