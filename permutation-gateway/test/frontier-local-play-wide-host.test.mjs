// TEST-ONLY wide -> wide marches (wide-depart-local, Q-W2 owner t385u): the wide village's own Train, Muster and Depart
// as page-signed local acts — the pure parts, key-free. No process, no port, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { seasonAddresses } from '../../permutation-server/web/frontier/faddr.mjs';
import { worldIdOf } from '../../permutation-server/web/frontier/map/wide.mjs';
import { decode } from '../../permutation-server/web/sdk/base58.mjs';
import {
  WIDE_TRAIN, WIDE_MUSTER, WIDE_DEPART, WIDE_HOST_ACTS, wideVillageAccounts, wideHostRef, wideHostAlias, wideHostIntent, wideHostInstruction,
  wideHostMessage, readWideProvince, readWideHolding, wideHostsIn, prepareWideOutboundPlain,
} from '../../permutation-server/web/frontier/flocalplay-wide-host.mjs';
import { neighbourTargets, passablePath } from '../../permutation-server/web/frontier/flocalplay-wide-plan.mjs';
import { LOCAL_ACT_NAMES, localActIntentOf, localActMessage as pageMessage } from '../../permutation-server/web/frontier/flocalplay-act.mjs';
import { LOCAL_ACT_COMMANDS, localActIntent, localActMessage as relayMessage, LOCAL_ACT_WIDE_READ_SCHEMA } from '../src/frontier/local-play-act.mjs';
import { evaluateOutboundRoute } from '../../permutation-server/web/frontier/fexpedition-route.mjs';
import { traceWideDirections, canonicalWideProvinceKey, unpackWidePlain } from '../../permutation-server/web/frontier/fexpedition-seal.mjs';
import { fromHex, toHex } from '../../permutation-server/web/sdk/bytes.mjs';

// (the itest expedition_play fixture identity; the Rust side printed these with itest wide_depart parity_print)
const PROGRAM = '5fQPsn8hoaVddFG26cWQ5QFdqxWtUPNaZ9zH2E6LYzFn', SEASON_ID = '11';
const SEASON = seasonAddresses(PROGRAM, SEASON_ID).season;
const WORLD = worldIdOf(SEASON, PROGRAM);
const WALLET = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';
const BLOCKHASH = '4sGjMW1sUnHzSxGspuhpqLDx6wiyjNtZAMdL4VZHirAn';
const village = { p: '130', q: '-1', site: 4 };

test('the wide accounts, the host reference and its alias are the Rust ABI\'s (itest wide_depart parity_print)', () => {
  assert.equal(SEASON, '7pshbHEvHUftsEcrGUPb9FoVXWmV1gEs1R1cZCGXjSCt');
  const a = wideVillageAccounts({ programId: PROGRAM, seasonId: SEASON_ID, world: WORLD, village });
  assert.equal(a.holding, '5EtbQ8buHtvvbY15QmwtMnhsxrPtC6ZUZJP38wH7ejJE');
  assert.equal(a.roster, 'DULG5c1eLfCrQLZcULyaaKGnvTRt9t6tcLCKBxA7PfxU');
  assert.equal(a.transits[2], 'Fc8aoQKnGFkNSG9L8uyBGzFDLMiXG7mm4qwaLd2WGz3P');
  assert.equal(a.province, '4cbQ7NUZRW2qG5USCBB6o7Huhw4quWMnkqHPbHSUQsY5');
  const host = wideHostRef({ world: WORLD, p: '130', q: '-1', site: 4, gen: 1, seq: 2 });
  assert.equal(host, '01c125eafbbe1563c4fde011a2e0a72b7f240480b0d65cf87d0c7a0c1bda24e5f70000000000000082050000000000000081040102000000');
  assert.equal(wideHostAlias(host), 13084875854677356326n);
  assert.ok(wideHostAlias(host) >= 1n << 63n, 'the alias bit');
});

test('the intents are closed: a wide village (ring 129+) only, the ABI\'s ranges, the host of this village', () => {
  assert.deepEqual(WIDE_HOST_ACTS, [WIDE_TRAIN, WIDE_MUSTER, WIDE_DEPART]);
  for (const n of WIDE_HOST_ACTS) { assert.ok(LOCAL_ACT_NAMES.includes(n)); assert.ok(LOCAL_ACT_COMMANDS.includes(n)); }
  assert.equal(wideHostIntent(WIDE_TRAIN, { wide: village }, { unit: 0, n: 100 }).fields.n, 100);
  assert.throws(() => wideHostIntent(WIDE_TRAIN, { wide: { p: '12', q: '-1', site: 4 } }, { unit: 0, n: 100 }), /LocalActShape/, 'a legacy province');
  assert.throws(() => wideHostIntent(WIDE_TRAIN, { wide: village }, { unit: 7, n: 100 }), /LocalActShape/, 'the Settler is not trained here');
  assert.throws(() => wideHostIntent(WIDE_TRAIN, { wide: village }, { unit: 0, n: 0 }), /LocalActShape/);
  assert.throws(() => wideHostIntent(WIDE_MUSTER, { wide: village }, { unit: 0, troops: 100, tile: 61 }), /LocalActShape/);
  assert.throws(() => wideHostIntent(WIDE_MUSTER, { wide: { ...village, site: 12 } }, { unit: 0, troops: 100, tile: 3 }), /LocalActShape/);
  const host = wideHostRef({ world: WORLD, p: '130', q: '-1', site: 4, gen: 1, seq: 0 });
  const f = { host, transit_slot: 0, arrive_bell: 200, tip: '5000', commit: '00'.repeat(32), seal: '11'.repeat(264) };
  assert.equal(wideHostIntent(WIDE_DEPART, { wide: village, standing: { p: '130', q: '-1' } }, f).fields.arrive_bell, 200);
  assert.throws(() => wideHostIntent(WIDE_DEPART, { wide: village, standing: { p: '128', q: '-1' } }, f), /LocalActShape/, 'standing on the legacy disk: the boundary');
  assert.throws(() => wideHostIntent(WIDE_DEPART, { wide: { ...village, site: 5 } , standing: { p: '130', q: '-1' } }, f), /LocalActShape/, 'another site\'s host');
  assert.throws(() => wideHostIntent(WIDE_DEPART, { wide: village, standing: { p: '130', q: '-1' } }, { ...f, transit_slot: 4 }), /LocalActShape/);
  assert.throws(() => wideHostIntent(WIDE_DEPART, { wide: village, standing: { p: '130', q: '-1' } }, { ...f, seal: '11'.repeat(263) }), /LocalActShape/);
  assert.throws(() => wideHostIntent(WIDE_DEPART, { wide: village, standing: { p: '130', q: '-1' } }, { ...f, tip: '-1' }), /LocalActShape/);
  assert.throws(() => localActIntent({ name: 'WideDepart', subject: { wide: village }, fields: f }, { wallet: WALLET }), /invalid local-play command request/);
});

test('the three instructions have the wide tables\' accounts and data (0xDA, the envelope ops 3 and 1, the legacy Depart shape)', () => {
  const t = wideHostInstruction(wideHostIntent(WIDE_TRAIN, { wide: village }, { unit: 0, n: 300 }), { programId: PROGRAM, seasonId: SEASON_ID, wallet: WALLET, world: WORLD });
  assert.equal(toHex(t.data), 'daff0103' + '02' + '00' + '2c010000');
  assert.deepEqual(t.keys.map(k => [k.isSigner, k.isWritable]), [[true, false], [true, true], [false, false], [false, true], [false, true], [false, false]]);
  const m = wideHostInstruction(wideHostIntent(WIDE_MUSTER, { wide: village }, { unit: 0, troops: 300, tile: 30 }), { programId: PROGRAM, seasonId: SEASON_ID, wallet: WALLET, world: WORLD });
  assert.equal(toHex(m.data), 'daff0101' + '00' + '2c010000' + '1e');
  assert.equal(m.keys.length, 8);
  assert.deepEqual(m.keys.slice(4, 7).map(k => k.isWritable), [true, true, true]);
  const a = wideVillageAccounts({ programId: PROGRAM, seasonId: SEASON_ID, world: WORLD, village });
  assert.deepEqual(m.keys.slice(4, 7).map(k => k.pubkey), [a.holding, a.province, a.roster]);
  const host = wideHostRef({ world: WORLD, p: '130', q: '-1', site: 4, gen: 1, seq: 0 });
  const f = { host, transit_slot: 2, arrive_bell: 0x01020304, tip: '7000', commit: 'ab'.repeat(32), seal: 'cd'.repeat(264) };
  const d = wideHostInstruction(wideHostIntent(WIDE_DEPART, { wide: village, standing: { p: '131', q: '-1' } }, f), { programId: PROGRAM, seasonId: SEASON_ID, wallet: WALLET, world: WORLD });
  assert.equal(d.data.length, 1 + 56 + 1 + 4 + 8 + 32 + 264);
  assert.equal(d.data[0], 0xda); assert.equal(toHex(d.data.slice(1, 57)), host); assert.equal(d.data[57], 2);
  assert.equal(toHex(d.data.slice(58, 62)), '04030201'); assert.equal(toHex(d.data.slice(62, 70)), '581b000000000000');
  assert.equal(d.keys.length, 13, 'wide_ix::DEPART: 13 accounts');
  assert.deepEqual(d.keys.slice(8, 12).map(k => k.isWritable), [false, false, true, false], 'exactly the departing slot is writable');
  assert.deepEqual(d.keys.slice(8, 12).map(k => k.pubkey), a.transits);
  assert.equal(d.keys[7].pubkey, a.province, 'the holding\'s own province');
  assert.notEqual(d.keys[5].pubkey, a.province, 'the standing province is where the host stands');
});

test('the page and the relay build the same message for each act (the relay\'s byte-for-byte rebuild)', () => {
  const identity = { programId: PROGRAM, seasonAddress: SEASON, address: WALLET };
  const pins = { program: PROGRAM, season: SEASON, seasonId: SEASON_ID, wallet: WALLET, rulesetHash: '00'.repeat(32) };
  const host = wideHostRef({ world: WORLD, p: '130', q: '-1', site: 4, gen: 1, seq: 0 });
  const cases = [
    [WIDE_TRAIN, { wide: village }, { unit: 0, n: 100 }],
    [WIDE_MUSTER, { wide: village }, { unit: 0, troops: 100, tile: 12 }],
    [WIDE_DEPART, { wide: village, standing: { p: '130', q: '-1' } }, { host, transit_slot: 0, arrive_bell: 222, tip: '5000', commit: '01'.repeat(32), seal: '02'.repeat(264) }],
  ];
  for (const [name, v, fields] of cases) {
    const intent = localActIntentOf(name, v, fields, WALLET);
    const page = pageMessage(intent, identity, pins.rulesetHash, BLOCKHASH);
    const relayIntent = localActIntent({ name, subject: JSON.parse(JSON.stringify(intent.subject)), fields: JSON.parse(JSON.stringify(intent.fields)) }, { wallet: WALLET });
    const relay = relayMessage(relayIntent, pins, BLOCKHASH).message;
    assert.equal(toHex(page), toHex(relay), name);
    assert.equal(toHex(page), toHex(wideHostMessage(intent, { programId: PROGRAM, seasonId: SEASON_ID, wallet: WALLET, world: WORLD, blockhash: BLOCKHASH, loadedLimit: 67108864 })), name);
  }
  assert.equal(LOCAL_ACT_WIDE_READ_SCHEMA, 'frontier-local-play-act-wide-read-v1');
});

test('a wide village\'s hosts are read out of its province\'s entry table by their aliases; the keep and the cursor too', () => {
  const pv = new Uint8Array(4864), v = new DataView(pv.buffer);
  v.setUint32(72, 321, true);
  const ref0 = wideHostRef({ world: WORLD, p: '130', q: '-1', site: 4, gen: 1, seq: 0 });
  const ref1 = wideHostRef({ world: WORLD, p: '130', q: '-1', site: 4, gen: 1, seq: 1 });
  const put = (i, id, state, troops, tile) => { const o = 1064 + i * 48; v.setBigUint64(o, id, true); pv[o + 8] = 3; pv[o + 9] = 0; pv[o + 10] = tile; pv[o + 11] = state; v.setUint32(o + 12, troops, true); };
  put(3, wideHostAlias(ref1), 1, 300_000, 17);
  put(5, 12345n, 1, 100_000, 2);   // another holding's host
  pv[4480] = 30; pv[4481] = 2; pv[4482] = 0xff; pv[4484] = 72; v.setUint32(4488, 50, true);
  const province = readWideProvince(pv);
  assert.equal(province.resolvedNext, 321);
  assert.deepEqual(province.keep, { tile: 30, holder: 2, contender: 0xff, progress: 0, required: 72, troops: 50 });
  const hb = new Uint8Array(1344), hv = new DataView(hb.buffer);
  hb[69] = 1; hb[70] = 17; hb[71] = 2; hb[112] = 3; hv.setUint32(132, 2, true); hv.setUint32(720, 40, true);
  const holding = readWideHolding(hb);
  assert.deepEqual([holding.gen, holding.tile, holding.state, holding.faction, holding.hostSeq, holding.reserve[0]], [1, 17, 2, 3, 2, 40]);
  const hosts = wideHostsIn({ world: WORLD, village, holding, province });
  assert.deepEqual(hosts.map(h => [h.seq, h.ref, h.entry.index, h.entry.troops, h.entry.tile]), [[1, ref1, 3, 300_000, 17]]);
  assert.equal(hosts.find(h => h.ref === ref0), undefined, 'seq 0 has no entry: dissolved or away');
  const none = new Uint8Array(4864); none[4480] = 0xff;
  assert.equal(readWideProvince(none).keep, null);
});

test('a wide -> wide march: the neighbours, the passable path onto the keep tile, the plaintext (ring 129+ at both ends)', () => {
  const near = neighbourTargets({ p: '130', q: '-1' }, [{ p: '131', q: '-1' }, { p: '130', q: '-2' }, { p: '132', q: '-1' }, { p: '128', q: '-1' }, { p: '130', q: '-1' }]);
  assert.deepEqual(near, [{ p: '131', q: '-1' }, { p: '130', q: '-2' }]);
  const origin = { p: '130', q: '-1', tile: 30 }, dest = { p: '131', q: '-1' };
  const okey = canonicalWideProvinceKey({ world: WORLD, ...dest }), hkey = canonicalWideProvinceKey({ world: WORLD, p: '130', q: '-1' });
  const all = (1n << 61n) - 1n;
  const lands = new Map([[okey, { passable: all }], [hkey, { passable: all }]]);
  const path = passablePath(WORLD, origin, dest, 30, lands);
  assert.ok(path && path.directions.length > 0 && path.directions.length <= 24);
  const end = traceWideDirections({ world: WORLD, origin, directions: path.directions }).endpoint;
  assert.deepEqual([end.p, end.q, end.tile], ['131', '-1', 30]);
  // (every tile of the destination impassable but the keep's own: still reached only through passable tiles — here none)
  const blocked = new Map([[okey, { passable: 1n << 30n }], [hkey, { passable: 0n }]]);
  assert.equal(passablePath(WORLD, origin, dest, 30, blocked, { max: 10 }), null);
  const host = wideHostRef({ world: WORLD, p: '130', q: '-1', site: 4, gen: 1, seq: 0 });
  const plain = prepareWideOutboundPlain({ world: WORLD, host, origin, directions: path.directions, arriveBell: 300 });
  const u = unpackWidePlain(fromHex(plain.plainHex));
  assert.equal(u.host, host); assert.equal(u.arriveBell, 300); assert.equal(u.destTile, 30);
  assert.equal(u.dest, okey);
  assert.throws(() => prepareWideOutboundPlain({ world: WORLD, host, origin: { p: '128', q: '-1', tile: 30 }, directions: [1], arriveBell: 300 }), e => e.code === 'WideOriginRequired');
});

test('the route evaluator keeps refusing a wide origin by default (`wideOrigin` opens only the wide -> wide judgement)', () => {
  const r = evaluateOutboundRoute({ source: { program: PROGRAM, season: SEASON, seasonId: SEASON_ID, world: WORLD, unit: 0, faction: 3, holdingFlags: 0, origin: { p: '130', q: '-1', tile: 30 } },
    directions: [0, 0], lands: new Map(), season: { seasonId: SEASON_ID, status: 3, minLead: 2, maxLead: 72, endBell: 1008, stances: new Array(36).fill(0) }, departTs: 0, arriveBell: null });
  assert.equal(r.code, 'OriginalOriginRequired');
  const w = evaluateOutboundRoute({ source: { program: PROGRAM, season: SEASON, seasonId: SEASON_ID, world: WORLD, unit: 0, faction: 3, holdingFlags: 0, origin: { p: '130', q: '-1', tile: 30 } },
    directions: [0, 0], lands: new Map(), season: { seasonId: SEASON_ID, status: 3, minLead: 2, maxLead: 72, endBell: 1008, stances: new Array(36).fill(0) }, departTs: 0, arriveBell: null, wideOrigin: true });
  assert.notEqual(w.code, 'OriginalOriginRequired');
  assert.notEqual(w.code, 'WideOriginRequired');
  void decode;
});
