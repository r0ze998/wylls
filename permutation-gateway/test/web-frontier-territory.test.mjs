import test from 'node:test';
import assert from 'node:assert/strict';
import { createTerritory, resolveTerritory, settleHomeTerritory, territorySnapshot, UNCLAIMED } from '../screens/territory.mjs';
import { kernel } from '../screens/kernel.mjs';
import { resolveArgs } from '../../permutation-server/web/frontier/screens/report.mjs';
import { hostId } from '../../permutation-server/web/frontier/faddr.mjs';
import * as R from '../screens/rules.mjs';
import * as W from '../screens/world.mjs';
import { createLive } from '../screens/liveworld.mjs';

const bell = 42;
const empty = () => ({ p: 2, q: 0, resolvedNext: bell, siteCount: 0, sites: [], siteMirror: [], passableMask: (1n << 61n) - 1n,
  entries: [], camp: { tile: 50, state: 0, troops: 0, gen: 0 } });
const army = (id, faction, tile = 30, extra = {}) => ({ id: BigInt(id), faction, tile, unit: 0, troops: 600_000, fromBell: bell + 1, state: 1, ...extra });
const fresh = () => { const pv = empty(); return { pv, state: createTerritory(pv) }; };

test('server ownership waits for arrival resolution; an empty tile is secured and kept after departure', () => {
  const { pv, state } = fresh();
  assert.equal(territorySnapshot(state).owners[30], UNCLAIMED);
  pv.entries = [army(1, 2)];
  const arrived = resolveTerritory(state, pv, bell);
  assert.equal(arrived.owners[30], 2);
  assert.deepEqual(arrived.changes, [{ tile: 30, from: UNCLAIMED, to: 2, bell, hostId: '1', reason: 'arrival' }]);
  pv.entries[0].state = 3;
  const left = resolveTerritory(state, pv, bell + 1);
  assert.equal(left.owners[30], 2);
  assert.deepEqual(left.changes, []);
  assert.deepEqual(left.history, arrived.changes, 'history survives a later quiet bell for slower clients');
  assert.deepEqual(left.totals, [0, 0, 1, 0, 0, 0]);
});

test('same-bell opposing survivors do not decide ownership by array order; all dead leaves the former owner', () => {
  const { pv, state } = fresh(); state.owners[30] = 3;
  pv.entries = [army(1, 1), army(2, 2)];
  assert.equal(resolveTerritory(state, pv, bell).owners[30], 3);
  pv.entries.reverse();
  assert.equal(resolveTerritory(state, pv, bell + 1).owners[30], 3);
  pv.entries.forEach(e => { e.troops = 0; e.state = 0; });
  assert.equal(resolveTerritory(state, pv, bell + 2).owners[30], 3);
});

test('civilians, queued musters, impassable tiles, and a live neutral camp cannot acquire fields', () => {
  const { pv, state } = fresh(); pv.passableMask &= ~(1n << 32n); pv.camp.state = 1;
  pv.entries = [army(1, 1, 30, { unit: 6 }), army(2, 2, 31, { state: 2 }), army(3, 3, 32), army(4, 4, 50)];
  assert.deepEqual(resolveTerritory(state, pv, bell).totals, [0, 0, 0, 0, 0, 0]);
});

test('new homes are owned immediately and field capture never overwrites a village account', () => {
  const { pv, state } = fresh(); pv.siteCount = 1; pv.sites = [30]; pv.siteMirror = [{ state: 1, faction: 2 }];
  settleHomeTerritory(state, pv);
  assert.equal(territorySnapshot(state).owners[30], 2);
  pv.entries = [army(1, 1)];
  assert.equal(resolveTerritory(state, pv, bell).owners[30], 2);
});

test('a pushed-back survivor cannot claim its retreat tile on this or later quiet bells', () => {
  const { pv, state } = fresh(); pv.entries = [army(1, 1, 31)];
  assert.equal(resolveTerritory(state, pv, bell, { withdrawnHostIds: [1n] }).owners[31], UNCLAIMED);
  assert.equal(resolveTerritory(state, pv, bell + 1).owners[31], UNCLAIMED);
  assert.equal(resolveTerritory(state, pv, bell + 2, { arrivedHostIds: [1n] }).owners[31], 1);
});

test('repeated resolution cannot double-claim, historical snapshots stay immutable, and gaps are refused', () => {
  const { pv, state } = fresh(); pv.entries = [army(1, 1)];
  const a = resolveTerritory(state, pv, bell);
  pv.entries = [army(2, 2)];
  assert.deepEqual(resolveTerritory(state, pv, bell), a);
  assert.throws(() => resolveTerritory(state, pv, bell + 2), /gap/);
  const b = resolveTerritory(state, pv, bell + 1, { battleTiles: [30] });
  assert.equal(a.owners[30], 1); assert.equal(b.owners[30], 2);
  assert.equal(b.changes[0].reason, 'battle');
  b.owners[30] = 5;
  assert.equal(territorySnapshot(state).owners[30], 2);
});

// Resolve a real shared WASM battle, apply its actual fates to the roster,
// then let the server's territory layer see only those survivors.
function battlefield({ defenders = 200, attackers = 2000, retreat = null, simultaneous = false } = {}) {
  const pv = empty(), ids = [0, 1].map(site => hostId({ p: 2, q: 0, site, gen: 0, seq: 1 }));
  const fighter = (i, troops) => ({ id: ids[i], faction: i, unit: 0, tile: 30, troops: troops * 1000, stamina: 120, posture: i ? 1 : 0, retreatBps: i ? retreat : null, dealtBps: 10000 });
  const defender = fighter(0, defenders), attacker = fighter(1, attackers);
  const residents = simultaneous ? [] : [defender], arrivals = simultaneous ? [defender, attacker] : [attacker];
  pv.entries = simultaneous ? [] : [{ ...army(ids[0], 0), fromBell: 1, troops: defenders * 1000, staminaValue: 120, staminaBell: 1, readyBell: 1, pendOp: 0 }];
  pv.entries.push(...Array.from({ length: 56 - pv.entries.length }, () => ({ state: 0, id: 0n })));
  const state = createTerritory(pv); state.owners[30] = 0;
  const args = { province: { p: 2, q: 0 }, bell, seed: new Uint8Array(32).fill(17), terrain: { terrain: Array(61).fill(0), resource: Array(61).fill(null), sites: Array(12).fill(0), siteCount: 0 },
    residents, arrivals, garrisons: [], relations: 0n, occupancy: { pending: Array(8).fill(0), storageFree: 56 } };
  const r = resolveArgs(kernel(), args); assert.ok(r.ok, r.why ?? 'shared WASM resolution');
  R.applyOutcome(pv, { bell, residents, arrivals, garrisons: [], arrPos: arrivals.map((_, i) => i), camp: pv.camp }, r.outcome);
  R.settleBell(pv, bell);
  const territory = resolveTerritory(state, pv, bell, { battleTiles: [30], arrivedHostIds: r.outcome.fighters.filter(f => f.arrival && f.fate.kind === 'Stays').map(f => f.id), withdrawnHostIds: r.outcome.fighters.filter(f => f.fate.kind !== 'Stays').map(f => f.id) });
  return { territory, outcome: r.outcome };
}

test('a real WASM battle awards the enemy field to the surviving winner', () => {
  const r = battlefield();
  assert.ok(r.outcome.engagements > 0);
  assert.equal(r.territory.owners[30], 1);
  assert.equal(r.territory.changes[0].reason, 'battle');
});

test('a real WASM retreat preserves the defender; simultaneous arrivals use the battle winner', () => {
  const retreat = battlefield({ defenders: 3000, attackers: 100, retreat: 10000 });
  assert.equal(retreat.territory.owners[30], 0);
  assert.ok(retreat.outcome.fighters.some(f => f.arrival && f.fate.kind !== 'Stays'));
  assert.equal(battlefield({ simultaneous: true }).territory.owners[30], 1);
});

test('live-world herald exposes server state and a frozen territory snapshot of each resolved bell', async () => {
  const world = createLive({ viewer: await W.viewer(), neighbours: false, paused: true, territory: true });
  const read = suffix => world.herald(`/h/province/${W.HOME.p},${W.HOME.q}/${suffix}`, new URL('http://127.0.0.1')).body;
  const a = read('latest');
  assert.equal(a.sampleTerritory.authority, 'local-preview');
  assert.equal(a.sampleTerritory.owners[W.HOME.tile], 0);
  assert.equal(a.sampleTerritory.owners.length, 61);
  world.advance();
  const latest = read('latest'), closed = read(latest.sampleTerritory.bell);
  assert.deepEqual(closed.sampleTerritory, latest.sampleTerritory);
  const copy = structuredClone(closed.sampleTerritory);
  world.advance();
  assert.deepEqual(read(copy.bell).sampleTerritory, copy);
});


test('the legacy sample does not advertise or serve arrival-control payloads by default', async () => {
  const world = createLive({ viewer: await W.viewer(), neighbours: false, paused: true });
  assert.equal(world.summary().territory, undefined);
  const record = world.herald('/h/season', new URL('http://127.0.0.1')).body;
  assert.equal(record.sample.territory, undefined);
  const env = world.herald(`/h/province/${W.HOME.p},${W.HOME.q}/latest`, new URL('http://127.0.0.1')).body;
  assert.equal(env.sampleTerritory, undefined);
});
