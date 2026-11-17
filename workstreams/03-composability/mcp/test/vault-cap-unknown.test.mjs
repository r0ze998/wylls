// game.view: a storehouse whose stores are not known has cap: null, never 0 (Lane C, 2026-11-17). WRITTEN, NOT RUN.
// KEY-FREE: no imports beyond node:test / node:assert / node:fs; game.mjs is read as text (importing it loads
// permutation-server/web/frontier modules, and exercising view needs test/fixture.mjs, which generates keys). A text check
// of one expression: it does not run game.view.
//   K1 known: false (stores not an array) → cap null; stores read → cap as before, Number(v.cap ?? 0)
//   K2 the old unconditional `cap: Number(v.cap ?? 0),` is gone; known and stores are written as before
//   K3 the upstream contract it follows: herald.mjs vaultOf adds stores and cap together, only once the bytes were read
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const game = readFileSync(new URL('../src/game.mjs', import.meta.url), 'utf8');
const herald = readFileSync(new URL('../../../../permutation-server/web/frontier/herald.mjs', import.meta.url), 'utf8');

test('K1 cap is null when the stores are not known, as before when they are', () => {
  assert.ok(game.includes("known: Array.isArray(v.stores), cap: Array.isArray(v.stores) ? Number(v.cap ?? 0) : null,"));
});

test('K2 the unconditional 0 is gone; known and stores are unchanged', () => {
  assert.doesNotMatch(game, /known: Array\.isArray\(v\.stores\), cap: Number\(v\.cap \?\? 0\),/);
  assert.ok(game.includes("stores: Array.isArray(v.stores) ? v.stores.map((n, i) => ({ resource: resources[i], have: Number(n) })) : null"));
});

test('K3 upstream: vaultOf gives stores and cap together, only when the bytes were read (not changed here)', () => {
  assert.ok(herald.includes("...(stores ? { stores, cap: optIntOf(o, 'cap', 0, U32, at) ?? 0 } : {})"));
});
