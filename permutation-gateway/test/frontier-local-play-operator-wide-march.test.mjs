// TEST-ONLY wide march of the operator AI residents (wide-march-local): the pure parts, key-free. No process, no port,
// no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { borderTargets, pathsInto } from '../src/frontier/local-play-operator-wide-march.mjs';
import { createResidentMemory, decideNext, noteOutcome, wideMarchDue, OPERATOR_WIDE_MARCHES, WIDE_MARCH_GAP_BELLS, OPERATOR_COOLDOWN } from '../src/frontier/local-play-operator-policy.mjs';
import { traceWideDirections } from '../../permutation-server/web/frontier/fexpedition-seal.mjs';
import { evaluateOutboundRoute } from '../../permutation-server/web/frontier/fexpedition-route.mjs';
import { worldIdOf } from '../../permutation-server/web/frontier/map/wide.mjs';

const WORLD = 'c125eafbbe1563c4fde011a2e0a72b7f240480b0d65cf87d0c7a0c1bda24e5f7';

test('a rim village borders only the ring-129 provinces next to it; a heartland or wide village borders none', () => {
  const t = [{ p: '62', q: '-129' }, { p: '63', q: '-129' }, { p: '61', q: '-129' }, { p: '62', q: '-130' }, { p: '-62', q: '129' }];
  assert.deepEqual(borderTargets({ p: 62, q: -128 }, t), [{ p: 62, q: -129 }, { p: 63, q: -129 }]);
  assert.deepEqual(borderTargets({ p: 2, q: -1 }, t), []);
  assert.deepEqual(borderTargets({ p: 62, q: -129 }, t), []);
  assert.deepEqual(borderTargets(null, t), []);
});

test('the paths into a wide province are shortest first, end in it and stay in the origin province until then', () => {
  const origin = { p: '62', q: '-128', tile: 54 };
  const paths = pathsInto(WORLD, origin, { p: 62, q: -129 });
  assert.ok(paths.length >= 1 && paths.length <= 4);
  const lens = paths.map(x => x.directions.length);
  assert.deepEqual(lens, [...lens].sort((a, b) => a - b));
  for (const x of paths) {
    const r = traceWideDirections({ world: WORLD, origin, directions: x.directions });
    assert.equal(String(r.endpoint.p), '62'); assert.equal(String(r.endpoint.q), '-129'); assert.equal(r.endpoint.tile, x.tile);
    for (const s of r.steps.slice(0, -1)) assert.deepEqual([String(s.p), String(s.q)], ['62', '-128']);
    assert.equal(r.accountKeys.length, 2);
  }
  assert.deepEqual(pathsInto(WORLD, origin, { p: 62, q: -129 }, { max: 3 }), [], 'no path within 3 steps from tile 54');
});

test('the resident marches when a plan is judged, at most OPERATOR_WIDE_MARCHES, spaced and cooled down after a refusal', () => {
  const m = createResidentMemory(0);
  const view = { joined: true, faction: 4, holding: { p: 62, q: -128, site: 10, tile: 54 } };
  const plan = { host: { id: '1', troops: 110, tile: 54 }, dest: { p: 62, q: -129 }, arriveBell: 200, nowBell: 190, holding: view.holding, destTile: 60, directions: [2] };
  assert.equal(wideMarchDue(m, 190), true);
  const d = decideNext(m, view, { homes: [], wide: { targets: [], canClaim: false, march: plan } });
  assert.equal(d.name, 'WideMarch'); assert.equal(d.plan, plan);
  noteOutcome(m, d, 'landed');
  assert.equal(m.wideMarches, 1); assert.equal(m.wideMarchUntil, 190 + WIDE_MARCH_GAP_BELLS);
  assert.equal(wideMarchDue(m, 190 + WIDE_MARCH_GAP_BELLS), false);
  assert.equal(wideMarchDue(m, 191 + WIDE_MARCH_GAP_BELLS), true);
  noteOutcome(m, d, 'refused');
  assert.equal(m.wideMarches, 1); assert.equal(m.cooldown.WideMarch, m.decisions + OPERATOR_COOLDOWN);
  assert.equal(wideMarchDue(m, 10_000), false, 'cooling down');
  m.cooldown.WideMarch = 0; noteOutcome(m, d, 'unknown');
  assert.equal(m.wideMarches, 2, 'an unknown outcome is counted: never sent twice');
  assert.equal(OPERATOR_WIDE_MARCHES, 2); assert.equal(wideMarchDue(m, 10_000), false, 'the cap');
  // (no plan: the usual rotation)
  assert.notEqual(decideNext(createResidentMemory(0), view, { homes: [], wide: { targets: [], canClaim: false } }).name, 'WideMarch');
});

test('the route observation takes a stored-Seeded Season at or after genesis as Running (the effective status)', () => {
  const program = '5fQPsn8hoaVddFG26cWQ5QFdqxWtUPNaZ9zH2E6LYzFn', seasonAddr = '7pshbHEvHUftsEcrGUPb9FoVXWmV1gEs1R1cZCGXjSCt';
  const season = { seasonId: 11, status: 2, genesisTs: 1000n, minLead: 2, maxLead: 72, endBell: 1008, stances: new Array(36).fill(0) };
  const source = { program, season: seasonAddr, seasonId: '11', world: worldIdOf(seasonAddr, program), unit: 0, faction: 4, holdingFlags: 0, origin: { p: '62', q: '-128', tile: 54 } };
  const code = (s, departTs) => evaluateOutboundRoute({ source, directions: [2], lands: new Map(), season: s, departTs, arriveBell: null }).code;
  assert.equal(code(season, 999), 'SeasonNotRunning', 'Seeded before genesis');
  assert.equal(code(season, 2000), 'WideDestinationRequired', 'Seeded at/after genesis is Running: the next check (the ring) speaks');
  assert.equal(code({ ...season, status: 3 }, 2000), 'WideDestinationRequired');
  assert.equal(code({ ...season, status: 4 }, 2000), 'SeasonNotRunning', 'Ended');
  assert.equal(code(season, 2000.6), 'WideDestinationRequired', 'a fractional departure time (the measured clock rate) is floored, never thrown on');
});

test('a rim village with no host forms one for the wide march first: Train to the minimum, then Muster; cooled after a refusal', () => {
  const m = createResidentMemory(0);
  const view = { joined: true, faction: 4, holding: { p: 62, q: -128, site: 10, tile: 54 } };
  const t = decideNext(m, view, { homes: [], wide: { targets: [], canClaim: false, needHost: { reserve: 40 } } });
  assert.deepEqual([t.name, t.fields], ['Train', { unit: 0, n: 70 }]);
  const u = decideNext(m, view, { homes: [], wide: { targets: [], canClaim: false, needHost: { reserve: 500 } } });
  assert.deepEqual([u.name, u.fields], ['Muster', { unit: 0, troops: 300, tile: 54 }]);
  noteOutcome(m, u, 'refused');
  assert.equal(m.cooldown.WideMuster, m.decisions + OPERATOR_COOLDOWN);
  assert.notEqual(decideNext(m, view, { homes: [], wide: { targets: [], canClaim: false, needHost: { reserve: 500 } } }).name, 'Muster', 'cooling down');
  // (no tile known: never guessed)
  const v = decideNext(createResidentMemory(0), { ...view, holding: { p: 62, q: -128, site: 10 } }, { homes: [], wide: { targets: [], canClaim: false, needHost: { reserve: 500 } } });
  assert.notEqual(v.name, 'Muster');
});
