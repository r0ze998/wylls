// WRITTEN, NOT RUN (Lane C, 2026-11-17): no part of this file has been executed. It imports src/game.mjs, whose static
// closure (76 files, read, not run) reaches permutation-server/web/frontier/fland.mjs and web/lang.mjs (subjects of
// refused tests) and files that name key APIs (fplay.mjs, session.mjs, the vendored noble curves). It is therefore NOT
// claimed independent or key-free: whether and how it may run is the coordinator's decision, through the repository's
// key-free guard only, never by another route.
//
// check_resource_shortfall's hoursByProduction (decision C, 2026-11-17): short / perHour, not rounded.
//   H1 a small shortfall with fast production is a positive number, never 0 (0.1 h rounding gave 0: short 1 at 40/h)
//   H2 exact cases keep their values: 200 at 10/h → 20 (shortfall-coverage C4), 500 at 20/h → 25, 100 at 40/h → 2.5
//   H3 unchanged meanings: nothing short → 0; no production (perHour 0 or below) → null; `enough` from `short`
// Views are plain objects (Game.shortfall reads view.resources, view.village.stores, view.places, view.feedOk).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../src/game.mjs';

const R = ['Food', 'Wood', 'Stone', 'Ore', 'Arms', 'Gold', 'Science', 'Influence'];
const stores = (have, perHour) => R.map((r, i) => ({ resource: r, have: have[i] ?? 0, perHour: perHour[i] ?? 0, cap: 100000 }));
const view = (have, perHour) => ({ resources: R, village: { kind: 'holding', placeId: 'holding:1,1,0', stores: stores(have, perHour) }, places: [], feedOk: true });
const row = (s, r) => s.rows.find(x => x.resource === r);

test('H1 short 1 with fast production: a positive number of hours, never 0', () => {
  for (const [perHour, hours] of [[40, 1 / 40], [21, 1 / 21], [1000, 1 / 1000]]) {
    const s = Game.shortfall(view([99], [perHour]), { kind: 'amounts', amounts: { Food: 100 } });
    const f = row(s, 'Food');
    assert.equal(f.short, 1);
    assert.equal(f.hoursByProduction, hours, `perHour ${perHour}`);
    assert.ok(f.hoursByProduction > 0, 'never the "nothing short" value 0');
    assert.equal(s.enough, false);
  }
});

test('H2 exact cases keep their values (no rounding needed)', () => {
  const s = Game.shortfall(view([0, 0, 100, 0], [0, 0, 10, 0]), { kind: 'amounts', amounts: { Stone: 300 } });
  assert.deepEqual(row(s, 'Stone'), { resource: 'Stone', need: 300, have: 100, short: 200, perHour: 10, hoursByProduction: 20 });
  assert.equal(row(Game.shortfall(view([0, 0, 0], [0, 0, 20]), { kind: 'amounts', amounts: { Stone: 500 } }), 'Stone').hoursByProduction, 25);
  assert.equal(row(Game.shortfall(view([0], [40]), { kind: 'amounts', amounts: { Food: 100 } }), 'Food').hoursByProduction, 2.5);
});

test('H3 unchanged meanings: nothing short is 0, no production is null, enough follows short', () => {
  const none = Game.shortfall(view([500], [40]), { kind: 'amounts', amounts: { Food: 100 } });
  assert.equal(row(none, 'Food').short, 0);
  assert.equal(row(none, 'Food').hoursByProduction, 0);
  assert.equal(none.enough, true);
  for (const perHour of [0, -5]) {
    const s = Game.shortfall(view([0], [perHour]), { kind: 'amounts', amounts: { Food: 100 } });
    assert.equal(row(s, 'Food').hoursByProduction, null, `perHour ${perHour}`);
    assert.equal(s.enough, false);
  }
});

test('H1/H3 a fractional rate: hours × rate gives back the shortfall (within floating point)', () => {
  const s = Game.shortfall(view([0], [0.3]), { kind: 'amounts', amounts: { Food: 3 } });
  const f = row(s, 'Food');
  assert.ok(f.hoursByProduction > 0);
  assert.ok(Math.abs(f.hoursByProduction * f.perHour - f.short) < 1e-9);
});
