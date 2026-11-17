// The march order from the S1 map golden's host, before sealing (⑲, 2026-11-08): the router's own answers
// (frontier-node/crates/herald/tests/golden/ws19-map-growth-s1.json, cqfixture::growth) decoded by the page's
// herald.mjs, then the composer's pre-seal check fmarch.checkMarch from the wallet's host on (4,0) tile 0 to
// (5,0) tile 0 at the grown stage. The Season is CreateSeason's write of MC_LOCAL_7D (min_lead 2, max_lead 72,
// the program's validate pins both), so the arrival window is [now + 2, now + 72]; a zero-window Season (the
// golden before this fix) leaves no arrival bell and the check refuses ArrivalBell.
// Key-free: no seal, no Worker, no signature. checkMarch, arrivalWindow and tipOptions are pure; seal.mjs is
// imported for constants only (sealMarch is never called). The route is workstream 8's planRoute answer
// (growth-route.mjs ROUTE, pinned there against frontier-v3.wasm).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHerald } from '../../permutation-server/web/frontier/herald.mjs';
import { seasonAddresses } from '../../permutation-server/web/frontier/faddr.mjs';
import { arrivalWindow, checkMarch, tipOptions, planRoute, RETREAT_CHOICES } from '../../permutation-server/web/frontier/fmarch.mjs';
import * as Wasm from '../../permutation-server/web/frontier/wasm.mjs';
import { kernelFile } from '../../permutation-server/web/frontier/fconquest.mjs';
import { tileHex } from '../../permutation-server/web/frontier/fgeo.mjs';
import { PRESETS } from '../../permutation-server/web/sdk/frontier/abi-v2-presets.mjs';
import { checkBeacon } from '../../permutation-server/web/frontier/seal.mjs';
import { ROUTE } from './fixtures/frontier/growth-route.mjs';

const M1 = JSON.parse(readFileSync(new URL('../../frontier-node/crates/herald/tests/golden/ws19-map-growth.json', import.meta.url), 'utf8'));

const S1 = JSON.parse(readFileSync(new URL('../../frontier-node/crates/herald/tests/golden/ws19-map-growth-s1.json', import.meta.url), 'utf8'));

function heraldAt(stage, patch = a => a) {
  const answers = S1.stages[stage];
  const f = async url => {
    const path = new URL(url, 'http://h').pathname;
    const a = patch(answers[path] ?? { status: 404, body: { ok: false, code: 'NotFound' } }, path);
    const body = a.body?.b64 !== undefined ? Buffer.from(a.body.b64, 'base64') : JSON.stringify(a.body);
    return new Response(body, { status: a.status });
  };
  const h = createHerald({ fetch: f, seasonId: S1.season });
  h.pin(S1.season, seasonAddresses(S1.program, BigInt(S1.season)));
  return h;
}

/** The composer's inputs at `nowBell` from the herald's answers. */
async function orderAt(h, nowBell) {
  const s = await h.season();
  assert.ok(s.ok, s.code);
  const me = await h.me(S1.wallet);
  assert.ok(me.ok, me.code);
  const pv = await h.province(4, 0);
  assert.ok(pv.ok, pv.code);
  const host = pv.province.entries.find(e => String(e.id) === S1.host);
  assert.ok(host, 'the wallet\'s host is in (4,0)');
  const tip = tipOptions(s.season)[0].lamports;
  return {
    season: s.season, nowBell, now: Number(s.season.genesisTs) + nowBell * 600, resolvedNext: pv.province.resolvedNext,
    holding: me.holdings[0], province: pv.province, host, dest: { p: 5, q: 0, tile: 0 },
    route: { ...ROUTE, path: null }, earliest: null, stance: 0, retreat: { choice: RETREAT_CHOICES[0].id }, tip,
  };
}

test('the S1 Season carries the profile\'s lead window: min_lead 2, max_lead 72', async () => {
  const s = await heraldAt('grown').season();
  assert.ok(s.ok, s.code);
  assert.equal(s.season.minLead, 2);
  assert.equal(s.season.maxLead, 72);
  assert.deepEqual(arrivalWindow(s.season, 0), { min: 2, max: 72 });
});

test('grown: the order from (4,0) tile 0 to (5,0) tile 0 passes every pre-seal check for an arrival bell in the window', async () => {
  const m = await orderAt(heraldAt('grown'), 0);
  for (const arriveBell of [2, 3, 72]) assert.deepEqual(checkMarch({ ...m, arriveBell }), [], `arrive ${arriveBell}`);
  for (const arriveBell of [0, 1, 73]) assert.deepEqual(checkMarch({ ...m, arriveBell }), ['ArrivalBell'], `arrive ${arriveBell}`);
});

test('before growth there is no route, and a zero-window Season leaves no arrival bell (the old golden)', async () => {
  const m = await orderAt(heraldAt('grown'), 0);
  assert.deepEqual(checkMarch({ ...m, route: null, arriveBell: 3 }), ['NoPath']);
  // The Season bytes with MIN_LEAD (@276) and MAX_LEAD (@277) zeroed, as the fixture wrote them before.
  const zero = heraldAt('grown', (a, path) => {
    if (path !== '/h/season') return a;
    const b = Buffer.from(a.body.bytes_b64, 'base64');
    b[276] = 0; b[277] = 0;
    return { ...a, body: { ...a.body, bytes_b64: b.toString('base64') } };
  });
  const z = await orderAt(zero, 0);
  // Zero leads: the only bell is the departure bell itself; the page's earliest bell for a real route (the kernel's
  // earliest_arrival_bell for its secs, after departure) is past it, so no arrival bell is left and Seal stays off.
  assert.deepEqual(arrivalWindow(z.season, 0), { min: 0, max: 0 });
  for (const earliest of [1, 3]) {
    const w = arrivalWindow(z.season, 0, earliest);
    assert.ok(w.min > w.max, `earliest ${earliest}: empty window ${JSON.stringify(w)}`);
    for (const arriveBell of [0, 1, 2, 3, 72]) assert.ok(checkMarch({ ...z, earliest, arriveBell }).includes('ArrivalBell'), `zero window, earliest ${earliest}, arrive ${arriveBell}`);
  }
  // The profile's window with the same earliest bells: from the earliest bell to now + 72.
  for (const earliest of [1, 3]) {
    assert.deepEqual(arrivalWindow(m.season, 0, earliest), { min: Math.max(2, earliest), max: 72 });
    assert.deepEqual(checkMarch({ ...m, earliest, arriveBell: Math.max(2, earliest) }), []);
    assert.deepEqual(checkMarch({ ...m, earliest, arriveBell: Math.max(2, earliest) - 1 }), ['ArrivalBell']);
  }
});

// The beacon (app.mjs: FS.beacon = checkBeacon({drand: record.drand, seasonPkHash: season.quicknetPkHash,
// cluster: record.cluster, seasonNetwork: season.network})): read-only decode of public bytes, nothing sealed.
const beaconOf = (record, season) => checkBeacon({ drand: record.drand, seasonPkHash: season.quicknetPkHash, cluster: record.cluster, seasonNetwork: season.network });

test('the beacon: both goldens are quicknet (no NotQuicknet banner); the old zero-beacon Season is refused', async () => {
  for (const stage of ['before', 'extended', 'opened', 'grown']) {
    const s = await heraldAt(stage).season();
    assert.ok(s.ok, s.code);
    assert.deepEqual(beaconOf(s.record, s.season).ok, true, stage);
    assert.equal(beaconOf(s.record, s.season).kind, 'quicknet', stage);
  }
  for (const stage of ['S0', 'S1', 'S2']) {
    const a = M1.stages[stage]['/h/season'];
    const f = async () => new Response(JSON.stringify(a.body), { status: a.status });
    const h = createHerald({ fetch: f, seasonId: M1.season });
    const s = await h.season();
    assert.ok(s.ok, s.code);
    assert.equal(beaconOf(s.record, s.season).kind, 'quicknet', `M1 ${stage}`);
  }
  // Negative: the S1 Season as the golden had it before 2dd66100 (NETWORK 0, no pk hash), and a pk hash of
  // another key with NETWORK 2.
  const patched = edit => heraldAt('grown', (a, path) => {
    if (path !== '/h/season') return a;
    const b = Buffer.from(a.body.bytes_b64, 'base64');
    edit(b);
    return { ...a, body: { ...a.body, bytes_b64: b.toString('base64') } };
  });
  const old = await patched(b => { b[180] = 0; b.fill(0, 184, 216); }).season();
  assert.deepEqual(beaconOf(old.record, old.season), { ok: false, code: 'NotQuicknet' });
  const other = await patched(b => { b[184] ^= 0xff; }).season();
  assert.deepEqual(beaconOf(other.record, other.season), { ok: false, code: 'PkHashMismatch' });
  const s = await heraldAt('grown').season();
  assert.deepEqual(beaconOf({ ...s.record, drand: { ...s.record.drand, publicKey: '00'.repeat(96) } }, s.season), { ok: false, code: 'NotQuicknet' });
});

// ------------------------------------------------------------------ the palisade case: the kernel's route with `blocked`
// tests/golden/ws19-map-growth-s1-palisade.json (cqfixture::growth::palisade_case): one palisade of faction 2 at
// (4,0) tile 6 on 8's route. The real rules module (frontier-v3.wasm, loaded as growth-route.test.mjs does, sha256
// checked) plans (4,0) t0 → (5,0) t0 for unit 0 with the golden's seeds, without and with that hex blocked.
const S1P = JSON.parse(readFileSync(new URL('../../frontier-node/crates/herald/tests/golden/ws19-map-growth-s1-palisade.json', import.meta.url), 'utf8'));
let kernel = null;
before(async () => {
  const file = kernelFile({ layoutVersion: 2, programVersion: 4 });
  const dir = new URL('../../permutation-server/web/frontier/wasm/', import.meta.url);
  const bytes = readFileSync(new URL(file, dir));
  const published = readFileSync(new URL(`${file}.sha256`, dir), 'utf8').trim().split(/\s+/)[0];
  kernel = await Wasm.loadKernel({ url: file, sha256Hex: published, ruleset: PRESETS.ruleset_hash_v3,
    fetch: async () => ({ ok: true, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) }) });
});

// What the kernel answers (pinned): with the palisade's hex blocked the route goes round it; without, it is 8's ROUTE.
const AROUND = Object.freeze({ dirs: [5, 0, 0, 1, 0, 1, 1, 0, 1, 1], pathLen: 10, hexes: 10, secs: 1320, provinces: [{ p: 4, q: 0 }, { p: 5, q: 0 }] });
const DIRS = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]]; // fgeo DIRECTIONS
const walkHexes = (from, dirs) => { let { q, r } = tileHex(from.p, from.q, from.tile); return dirs.map(d => { q += DIRS[d][0]; r += DIRS[d][1]; return `${q},${r}`; }); };

test('palisade case: the kernel plans round the palisade the structures feed names; the order still passes every pre-seal check', async () => {
  const rec = S1P.stages.palisade['/h/season'].body;
  const seeds = rec.rings.map(r => ({ ring: r.d, seed: r.seed }));
  const from = { p: 4, q: 0, tile: 0 }, to = { p: 5, q: 0, tile: 0 };
  const at = S1P.palisade;
  const hex = tileHex(at.p, at.q, at.tile);
  assert.deepEqual(hex, { q: 33, r: -16 });
  const pick = r => r.ok ? { dirs: r.route.dirs, pathLen: r.route.pathLen, hexes: r.route.hexes, secs: r.route.secs, provinces: r.route.provinces } : r;
  // Without the palisade: 8's route, and its walk enters the palisade's hex.
  const free = planRoute(kernel, { from, to, unit: 0, seeds });
  assert.deepEqual(pick(free), { dirs: ROUTE.dirs, pathLen: ROUTE.pathLen, hexes: ROUTE.hexes, secs: ROUTE.secs, provinces: ROUTE.provinces });
  assert.ok(walkHexes(from, free.route.dirs).includes(`${hex.q},${hex.r}`), '8\'s route walks through (4,0) tile 6');
  // With it blocked (what palisadeHexesOf gives a faction-1 viewer from the feeds): round it, never entering it.
  const around = planRoute(kernel, { from, to, unit: 0, seeds, blocked: [hex] });
  assert.deepEqual(pick(around), AROUND);
  assert.ok(!walkHexes(from, around.route.dirs).includes(`${hex.q},${hex.r}`), 'the re-planned walk avoids the palisade');
  assert.equal(walkHexes(from, around.route.dirs).at(-1), (() => { const d = tileHex(5, 0, 0); return `${d.q},${d.r}`; })());
  // The composer's pre-seal check with that route from the golden's host (bell 0): clean for an arrival in the window.
  const h = (() => {
    const f = async url => {
      const a = S1P.stages.palisade[new URL(url, 'http://h').pathname] ?? { status: 404, body: { ok: false, code: 'NotFound' } };
      return new Response(JSON.stringify(a.body), { status: a.status });
    };
    const x = createHerald({ fetch: f, seasonId: S1P.season });
    x.pin(S1P.season, seasonAddresses(S1P.program, BigInt(S1P.season)));
    return x;
  })();
  const m = await orderAt(h, 0);
  assert.deepEqual(checkMarch({ ...m, route: { ...around.route, path: null }, arriveBell: 3 }), []);
});
