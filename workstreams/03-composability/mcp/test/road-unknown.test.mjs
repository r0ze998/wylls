// WRITTEN, NOT RUN (2026-11-17, under an execution pause): no part of this file has been executed. It imports
// src/game.mjs, which imports permutation-server/web/frontier modules (herald, faddr, fland, fcaravan, fplay) — the same
// closure the existing ③ tests load through the server, not re-checked for this file and NOT claimed key-free: run it
// only through the repository's key-free guard once runs are allowed again. The Game's fetch throws (no network); its
// herald is replaced by a stub whose province() answers the client's failure shapes.
//
// A Province that could not be read is not "no road":
//   R1 network → HeraldUnavailable (retryable, heraldCode network): no plan from a partial map
//   R2 425 TooEarly, HTTP 5xx, BadBody, an inconsistent envelope → HeraldUnavailable with that heraldCode
//   R3 every wanted Province 404 at the herald → Unknown (ProvincesNotFound, the Provinces listed), never NoRoad
//   R4 Game.province keeps the herald's code beside HeraldUnavailable
// Not covered here (needs real Province envelopes): a road found through read Provinces, and NoRoad when every wanted
// Province was read — both unchanged in the code and exercised by the existing play tests' fixture world.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game, GameError } from '../src/game.mjs';

const R = ['Food', 'Wood', 'Stone', 'Ore', 'Arms', 'Gold', 'Science', 'Influence'];
const stores = have => R.map((r, i) => ({ resource: r, have: have[i] ?? 0 }));
const src = { kind: 'vault', placeId: 'vault:0,0,33', p: 0, q: 0, tile: 33, known: true, stores: stores([0, 0, 500]) };
const dst = { kind: 'holding', placeId: 'village:1,0,0', p: 1, q: 0, site: 0, tile: 10, stores: stores([]) };
const view = { resources: R, feedOk: true, places: [dst, src], citizen: { caravans: 0 } };
const cargo = [0, 0, 100, 0, 0, 0, 0, 0];

function game(answer) {
  const g = new Game({ relay: 'http://relay.invalid', herald: 'http://herald.invalid', fetch: async () => { throw new Error('no network in this test'); } });
  g.herald = { province: async () => answer };
  return g;
}
const fail = code => ({ ok: false, code, error: `HTTP ${code}` });
async function refusal(g) { try { await g.plan(view, { from: src.placeId, to: dst.placeId, cargo }); return null; } catch (e) { assert.ok(e instanceof GameError, String(e)); return e; } }

test('R1 network: HeraldUnavailable, not a plan', async () => {
  const e = await refusal(game(fail('network')));
  assert.deepEqual([e.code, e.extra.retryable, e.extra.heraldCode], ['HeraldUnavailable', true, 'network']);
});

test('R2 425, 5xx, unreadable or inconsistent answers: HeraldUnavailable with the code', async () => {
  for (const c of ['TooEarly', 'HTTP503', 'BadBody', 'BadRecord']) {
    const e = await refusal(game(fail(c)));
    assert.deepEqual([e.code, e.extra.heraldCode], ['HeraldUnavailable', c], c);
  }
});

test('R3 every wanted Province 404: Unknown, never NoRoad', async () => {
  const e = await refusal(game(fail('NotFound')));
  assert.equal(e.code, 'Unknown');
  assert.equal(e.extra.reason, 'ProvincesNotFound');
  assert.ok(e.extra.provinces.length > 0 && e.extra.provinces.every(p => /^-?\d+,-?\d+$/.test(p)), JSON.stringify(e.extra.provinces));
  assert.match(e.message, /not proven/);
  assert.doesNotMatch(e.message, /send/);
});

test('R4 Game.province keeps the herald code', async () => {
  try { await game(fail('TooEarly')).province(3, 4); assert.fail('expected a refusal'); } catch (e) {
    assert.deepEqual([e.code, e.extra.heraldCode, e.extra.retryable], ['HeraldUnavailable', 'TooEarly', true]);
  }
});
