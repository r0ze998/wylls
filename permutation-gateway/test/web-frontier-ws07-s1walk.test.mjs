// Workstream 07 (player experience), connection patch: what an S1 walk meets,
// in the page. The port (frontier/s1walk.mjs) is pinned against vectors the
// rules crate writes (fixtures/s1-walk-v1.json, from
// workstreams/07-player-experience/rust-vectors); the page then plans marches
// and caravans round the palisades that stop them (S1-1E-CONTRACT §2.5), wears
// the S1 forecast's arrival by the towers on its road and builds its clash with
// the program's own model (hud/forecastmodel.mjs), and tells three siege
// refusals before the send.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as W from '../../permutation-server/web/frontier/s1walk.mjs';
import * as CAR from '../../permutation-server/web/frontier/fcaravan.mjs';
import * as S1 from '../../permutation-server/web/frontier/fs1.mjs';
import * as SCR from '../../permutation-server/web/frontier/screens/s1.mjs';
import * as C from '../../permutation-server/web/frontier/controller.mjs';
import * as io from '../../permutation-server/web/frontier/fchainio.mjs';
import { FS } from '../../permutation-server/web/frontier/fstate.mjs';
import { hostId } from '../../permutation-server/web/frontier/faddr.mjs';
import { rulesetFor } from '../../permutation-server/web/sdk/frontier/profile.mjs';
import { Kernel } from '../../permutation-server/web/frontier/wasm.mjs';
import { decode } from '../../permutation-server/web/frontier/fcodec.mjs';
import { fromBase64, toBase64 } from '../../permutation-server/web/sdk/bytes.mjs';
import { forecast } from '../../permutation-server/web/frontier/hud/forecast.mjs';
import { modelForecast } from '../../permutation-server/web/frontier/hud/forecastmodel.mjs';
import { parseEnvelope } from '../../permutation-server/web/frontier/herald.mjs';

const V = JSON.parse(readFileSync(new URL('./fixtures/s1-walk-v1.json', import.meta.url), 'utf8'));
const landsOf = c => c.lands.map(l => ({ p: l.p, q: l.q, passable: BigInt(l.passable), rough: BigInt(l.rough), road: BigInt(l.road), structures: l.structures.map(s => ({ ...s, p: l.p, q: l.q })) }));

test('the port is the rules crate\'s: coverage, wear, the stop rule, watch, march_watch, caravan_watch, fastest_path round palisades', () => {
  assert.deepEqual(W.COVER.map(String), V.coverage);
  for (const [s, b] of V.wearBps) assert.equal(W.wearBps(s), b);
  for (const [v, b, out] of V.wear) assert.equal(W.wear(v, b), out);
  for (const [n, f, e, out] of V.stops) assert.equal(W.stops(V.stances, n, f, !!e), !!out);
  for (const c of V.walks) {
    const lands = landsOf(c), all = lands.flatMap(l => l.structures);
    const watchAt = (p, q) => W.watchOf(W.structuresIn(all, p, q), V.stances, c.faction, c.expelled);
    for (const l of lands) assert.equal(String(watchAt(l.p, l.q).block), c.lands.find(x => x.p === l.p && x.q === l.q).block);
    assert.deepEqual(CAR.fastestPath(c.origin, c.dst, W.avoidingPalisades(lands, watchAt))?.dirs ?? null, c.fastestAvoiding, `case ${c.case}`);
    if (!c.fastest?.length) continue;
    assert.equal(W.marchWatch(c.origin, c.fastest, lands.map(l => ({ ...l, watch: watchAt(l.p, l.q) })), c.cavalry), c.march, `case ${c.case} march`);
    const secs = CAR.stepSecsOf(c.origin, c.fastest, lands, c.caravan.bps);
    assert.equal(W.caravanWatch(W.stepTiles(c.origin, c.fastest).map((s, i) => ({ ...s, atSecs: secs[i] })), watchAt), c.caravan.walked, `case ${c.case} caravan`);
  }
});

// ---------------------------------------------------------------- the page's walks
const ALL = (1n << 61n) - 1n;
const store = units => ({ value: BigInt(units) * 1000n, rate: 0n, cap: 10n ** 12n, t0: 10n ** 12n, frac: 0n });
const holding = (p, q, site, tile, extra = {}) => ({ p, q, site, tile, gen: 1, state: 2, tier: 1, faction: 1, stores: Array.from({ length: 8 }, () => store(1000)), reserve: [300, 0, 0, 0, 0, 0, 0, 0], queue: [], ...extra });
const prov = (p, q, extra = {}) => ({ p, q, layoutVersion: 2, passableMask: ALL, roughMask: 0n, roadMask: 0n, siteCount: 2, sites: [5, 6], siteMirror: [], camp: { state: 1, tile: 7 }, resolvedNext: 10, structures: [], forts: [], caravans: [], entries: [], conquest: Array.from({ length: 12 }, () => ({ kind: 0, flags: 0 })), ...extra });
const world = (extra = {}) => ({ mode: 'play', nowBell: 100, chain: { now: () => 1000 }, citizen: { faction: 1, vaults: 0, towers: 0, palisades: 0, forts: 0, caravans: 4, voted: [0, 0, 0, 0] },
  holdings: [holding(0, 0, 0, 30), holding(1, 0, 2, 20)], activeHolding: 0, provinces: new Map(), s1: { caravans: { moving: [], vaults: [] }, structures: { structures: [], sightings: [] }, nations: null }, ...extra });

test('off S1 nobody is stopped; on S1 the viewer\'s walker reads the structures, the stances and the expelled flag', () => {
  S1.setS1(null);
  assert.equal(W.walkerOf(world()), null);
  S1.setS1({ layoutVersion: 2, programVersion: 4 });
  try {
    const pal = { kind: 2, p: 0, q: 0, tile: 31, faction: 3 };
    const fs = world({ s1: { structures: { structures: [pal] }, nations: null } });
    assert.deepEqual(W.palisadeHexesOf(fs), [W.blockedHexes([pal], null, 1, false)[0]]);
    const pass = Array.from({ length: 6 }, (_, n) => Array.from({ length: 6 }, (_, f) => (n === 3 && f === 1 ? 1 : 0)));
    assert.deepEqual(W.palisadeHexesOf({ ...fs, s1: { ...fs.s1, nations: { stances: pass } } }), [], 'a nation at passage toward the viewer stops nothing');
    assert.equal(W.palisadeHexesOf({ ...fs, s1: { structures: { structures: [{ ...pal, faction: 1 }] } }, citizen: { ...fs.citizen, expelledSince: 5n } }).length, 1, 'an expelled village is stopped by its own nation');
  } finally { S1.setS1(null); }
});

test('a caravan is sent round a palisade that stops it, where the fastest road would have been refused (Path)', async () => {
  const saved = { ...FS };
  const sent = [];
  const A = JSON.parse(readFileSync(new URL('./fixtures/s1-addresses-v1.json', import.meta.url), 'utf8'));
  io.setPin({ programId: A.program, cluster: 'localnet', seasonId: A.seasonId, rulesetHash: rulesetFor(3) });
  S1.setS1({ layoutVersion: 2, programVersion: 4 });
  try {
    const provinces = new Map();
    for (const c of CAR.landsWanted({ p: 0, q: 0 }, { p: 1, q: 0 })) provinces.set(`${c.p},${c.q}`, { province: prov(c.p, c.q) });
    const lands = [...provinces.values()].map(e => CAR.landOfProvince(e.province));
    const plain = CAR.fastestPath({ p: 0, q: 0, tile: 30 }, { p: 1, q: 0, tile: 20 }, lands);
    const on = W.stepTiles({ p: 0, q: 0, tile: 30 }, plain.dirs)[2];
    const pal = { kind: 2, p: on.p, q: on.q, tile: on.tile, faction: 3 };
    Object.assign(FS, world({ provinces, s1: { caravans: { moving: [], vaults: [] }, structures: { structures: [pal], sightings: [] }, nations: null } }), { wallet: { address: 'Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr' }, session: { publicKey: A.program, sign: async () => new Uint8Array(64) }, notice: null, inFlight: 0 });
    C.useTransport({ submit: async req => { sent.push(req); return { ok: false, code: 'Stop' }; } });
    await C.FORMS['s1-caravan']({ elements: { src: { value: '0' }, dst: { value: '1' }, c1: { value: '120' } } });
    assert.equal(sent.length, 1);
    const dirs = []; const b = sent[0].fields.path;
    for (let i = 0; i < sent[0].fields.steps; i++) { const bit = 3 * i; dirs.push(((b[bit >> 3] | ((b[(bit >> 3) + 1] ?? 0) << 8)) >> (bit % 8)) & 7); }
    assert.notDeepEqual(dirs, plain.dirs, 'not the road through the palisade');
    assert.ok(!W.stepTiles({ p: 0, q: 0, tile: 30 }, dirs).some(s => s.p === pal.p && s.q === pal.q && s.tile === pal.tile));
    const watchAt = (p, q) => W.watchOf(W.structuresIn([pal], p, q), null, 1, false);
    const secs = CAR.stepSecsOf({ p: 0, q: 0, tile: 30 }, plain.dirs, lands);
    assert.equal(W.caravanWatch(W.stepTiles({ p: 0, q: 0, tile: 30 }, plain.dirs).map((s, i) => ({ ...s, atSecs: secs[i] })), watchAt), 'blocked', 'the old road is one the program refuses');
  } finally {
    C.useTransport(null); S1.setS1(null);
    Object.assign(FS, saved);
  }
});

test('the siege offer holds back the refusals the page can tell: the own village shielded, a busy or owing site', () => {
  const mine = { state: 1, tile: 5, id: hostId({ p: 0, q: 0, site: 0, gen: 1, seq: 3 }), fromBell: 5, unit: 0 };
  const P = (conquest) => prov(0, 0, { siteMirror: [{ state: 1, faction: 2 }, { state: 5, faction: 6 }], entries: [mine], ...(conquest ? { conquest } : {}) });
  const sel = { p: 0, q: 0, idx: 5 };
  assert.deepEqual(SCR.siegeOffer(world({ provinces: new Map([['0,0', { province: P() }]]) }), sel).blocks, []);
  const shielded = world({ provinces: new Map([['0,0', { province: P() }]]), holdings: [holding(0, 0, 0, 30, { shieldUntil: 5000 }), holding(1, 0, 2, 20)] });
  assert.deepEqual(SCR.siegeOffer(shielded, sel).blocks, ['SourceShielded']);
  const busy = [{ kind: 1, flags: 1 }, ...Array.from({ length: 11 }, () => ({ kind: 0, flags: 0 }))];
  assert.deepEqual(SCR.siegeOffer(world({ provinces: new Map([['0,0', { province: P(busy) }]]) }), sel).blocks, ['SiegeBusy']);
  const owed = [{ kind: 0, flags: 1 << 2 }, ...Array.from({ length: 11 }, () => ({ kind: 0, flags: 0 }))];
  assert.deepEqual(SCR.siegeOffer(world({ provinces: new Map([['0,0', { province: P(owed) }]]) }), sel).blocks, ['StakeUnsettled']);
  assert.match(String(SCR.renderS1Tile(shielded, sel)), /保護期間中/);
  assert.match(String(SCR.renderS1Tile(shielded, sel)), /宣言したあとにプログラムが判定すること/);
});

// ---------------------------------------------------------------- the S1 forecast
const FIX = JSON.parse(readFileSync(new URL('./fixtures/uxs1-keep-two-turns.json', import.meta.url), 'utf8'));
const REC = FIX.records['619'], PB = fromBase64(REC.province_before_b64), PV = decode('Province', PB), CI = decode('ClashInputs', fromBase64(REC.inputs_b64));
const ARR = CI.arrivals.find(a => a.present === 1);
const k3 = (async () => new Kernel((await WebAssembly.instantiate(readFileSync(new URL('../../permutation-server/web/frontier/wasm/frontier-v3.wasm', import.meta.url)), {})).instance.exports))();
const composed = (over = {}) => ({ host: { id: String(ARR.hostId), unit: ARR.unit, troops: Math.floor(ARR.troops / 1000), staminaValue: ARR.stamina + 10, staminaBell: 619 }, dest: { p: PV.p, q: PV.q, tile: ARR.tile }, arriveBell: 619, stance: ARR.stance, retreat: 'never', ratio: null, route: { dirs: [] }, ...over });

test('the S1 forecast counts the keep the program fights with (the page\'s own builder did not), and the towers\' wear', async () => {
  const k = await k3;
  assert.deepEqual([forecast(k, composed(), PV, ARR.faction).troops.max], [500], 'the page\'s builder: the host comes out whole');
  const fc = modelForecast(k, composed(), PB, ARR.faction);
  assert.ok(fc.troops.max < 500 && fc.troops.min <= 488, `${fc.troops.min}–${fc.troops.max}; the chain recorded 488`);
  const worn = modelForecast(k, composed(), PB, ARR.faction, { wornBps: 1500 });
  assert.deepEqual(worn.worn, { bps: 1500, before: 500, after: 425 });
  assert.ok(worn.troops.max < fc.troops.max);
});

test('the envelope keeps the Province bytes it decoded; the march wear reads the Provinces the page holds', async () => {
  const env = { v: 1, key: `pv:${PV.p},${PV.q}`, bell: 619, slot: 1, seq: 1, bytes: REC.province_before_b64, slots: [] };
  const parsed = parseEnvelope(env, { seasonId: PV.seasonId, p: PV.p, q: PV.q });
  assert.deepEqual([...parsed.provinceBytes], [...PB]);
  S1.setS1({ layoutVersion: 2, programVersion: 4 });
  try {
    const fs = world({ citizen: { faction: 0 }, provinces: new Map([[`${PV.p},${PV.q}`, { province: PV }]]), s1: { structures: { structures: [{ kind: 1, p: PV.p, q: PV.q, tile: 30, faction: 3 }] }, nations: null } });
    const w = W.marchWearOf(fs, { p: PV.p, q: PV.q, tile: 30 }, { dirs: [0, 0], provinces: [{ p: PV.p, q: PV.q }] }, 0);
    assert.ok(w && w.bps > 0 && w.secs > 0, JSON.stringify(w));
    assert.equal(W.marchWearOf(fs, { p: PV.p, q: PV.q, tile: 30 }, { dirs: [0], provinces: [{ p: 9, q: 9 }] }, 0), null, 'a Province not held: the wear cannot be told');
  } finally { S1.setS1(null); }
  assert.equal(toBase64(parsed.provinceBytes), REC.province_before_b64);
});
