// Key-free tests of the wide-economy fixture model against the five committed original recordings.
// Node built-ins only. Nothing is signed, sent or written; every mutation is made on a private copy.
//
// The literal expectations below were decoded independently from the raw bytes (resource order Food Wood Stone Ore Horses
// Gold Science Influence; milli-units as decimal strings). They are recordings of single host dispatches: a Build or Train
// dispatch also settles EARLIER queued work and accrues lazily, so a before/after difference is not an isolated price.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CASE_NAMES, FILE_NAMES, FILE_KEYS, FIXTURE_DIR, EXPECTED, PROGRAM_B58, WALLET_A_B58, SYNTHETIC_CAPTURE, PROVINCE,
  buildCase, loadCase, decodeReceipt, ModelError,
} from '../screens/wide-economy-fixture/model.mjs';
import { MANIFEST } from '../screens/wide-economy-fixture/manifest.mjs';
import { selectedWide, wideSlots } from '../../permutation-server/web/frontier/fwide.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = join(ROOT, ...FIXTURE_DIR.split('/'));
const KEYS = Object.keys(FILE_KEYS);

const disk = async (name, file) => Uint8Array.from(await readFile(join(BIN, name, file)));
const files = async name => Object.fromEntries(await Promise.all(Object.entries(FILE_KEYS).map(async ([k, f]) => [k, await disk(name, f)])));
const copy = f => Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v.slice()]));
const hex = b => Buffer.from(b).toString('hex');
const sha = b => createHash('sha256').update(b).digest('hex');
const code = c => e => e instanceof ModelError && e.code === c;
const anyModelError = e => e instanceof ModelError;
const notPin = e => e instanceof ModelError && e.code !== 'PinMismatch';
/** Pins computed from the (possibly mutated) given files, so a test reaches the deeper checks past the static manifest. */
const repin = (name, f) => ({ [name]: Object.fromEntries(Object.entries(FILE_KEYS).map(([k, file]) => [file, sha(f[k])])) });
const build = (name, f) => buildCase(name, f, { pins: repin(name, f) });

const DATA = { harvest: 'daff0103' + '000000000000', building: 'daff0103' + '010000000000', wall: 'daff0103' + '010600000000',
  tier: 'daff0103' + '010700000000', train: 'daff0103' + '02000a000000' };

// ---- independently decoded raw expectations (exact decimal strings of stored milli-units)
const RESOURCES = ['Food', 'Wood', 'Stone', 'Ore', 'Horses', 'Gold', 'Science', 'Influence'];
const PRE_VALUES = Array(8).fill('1900000');
const POST_VALUES = {
  harvest: [2000000, 2000000, 2000000, 2000000, 1900000, 2000000, 2000000, 1900000],
  building: [2000000, 1920000, 1960000, 2000000, 1900000, 2000000, 2000000, 1900000],
  wall: [2000000, 2000000, 1700000, 2000000, 1900000, 2000000, 2000000, 1900000],
  tier: [2000000, 1000000, 1400000, 2000000, 1900000, 1700000, 2000000, 1900000],
  train: [3236000, 2810000, 2540000, 2520000, 1900000, 2376000, 2056000, 1900000],
};
const EMPTY_Q = ['0', '0', '0', '0']; // kind, arg, doneAt, delta
const Q0 = {
  harvest: { pre: EMPTY_Q, post: EMPTY_Q },
  building: { pre: EMPTY_Q, post: ['1', '0', '1800180000', '12000'] },
  wall: { pre: ['1', '0', '1800180000', '12000'], post: ['4', '0', '1800275400', '100'] },
  tier: { pre: ['4', '0', '1800275400', '100'], post: ['3', '0', '1800369000', '0'] },
  train: { pre: ['3', '0', '1800369000', '0'], post: EMPTY_Q },
};
const TIER = { harvest: ['0', '0'], building: ['0', '0'], wall: ['0', '0'], tier: ['0', '0'], train: ['0', '1'] };
const WALLS = { harvest: ['0', '0'], building: ['0', '0'], wall: ['0', '0'], tier: ['0', '100'], train: ['100', '100'] };
const RESERVE_ZERO = Array(8).fill('0');
const RESERVE = {
  harvest: { pre: RESERVE_ZERO, post: RESERVE_ZERO }, building: { pre: RESERVE_ZERO, post: RESERVE_ZERO },
  wall: { pre: RESERVE_ZERO, post: RESERVE_ZERO }, tier: { pre: RESERVE_ZERO, post: RESERVE_ZERO },
  train: { pre: RESERVE_ZERO, post: ['10', '0', '0', '0', '0', '0', '0', '0'] },
};
const RECEIPT = { harvest: [147, '1800088200'], building: [291, '1800174600'], wall: [435, '1800261000'], tier: [579, '1800347400'], train: [723, '1800433800'] };
const KIND = { harvest: 'Economy', building: 'Economy', wall: 'EconomyMirror', tier: 'EconomyMirror', train: 'Economy' };

test('the allowlist names are the five original cases and eight files', () => {
  assert.deepEqual([...CASE_NAMES], ['harvest', 'building', 'wall', 'tier', 'train']);
  assert.equal(FILE_NAMES.length, 8);
  assert.deepEqual(Object.values(FILE_KEYS), [...FILE_NAMES]);
  assert.deepEqual(EXPECTED.train, { kind: 'Train', unit: 0, n: 10 });
});

test('the static manifest pins exactly the 40 originals (independent node:crypto hash)', async () => {
  assert.deepEqual(Object.keys(MANIFEST), [...CASE_NAMES]);
  for (const c of CASE_NAMES) {
    assert.deepEqual(Object.keys(MANIFEST[c]).sort(), [...FILE_NAMES].sort(), c);
    for (const f of FILE_NAMES) {
      assert.match(MANIFEST[c][f], /^[0-9a-f]{64}$/, `${c}/${f}`);
      assert.equal(MANIFEST[c][f], sha(await disk(c, f)), `${c}/${f} differs from the checked-in original`);
    }
  }
});

for (const name of CASE_NAMES) {
  test(`${name}: original bytes map through the real parser, read-only and captured-unverified`, async () => {
    const f = await files(name);
    const snapshot = Object.fromEntries(Object.entries(f).map(([k, v]) => [k, hex(v)]));
    const c = buildCase(name, f);
    for (const [k, v] of Object.entries(f)) assert.equal(hex(v), snapshot[k], `${k} was mutated`);

    assert.equal(c.pins.program, PROGRAM_B58);
    assert.equal(c.pins.wallet, WALLET_A_B58);
    assert.equal(c.pins.seasonId, '11');
    assert.equal(c.verification, 'captured-unverified');
    assert.equal(c.synthetic.slot, '0');
    assert.equal(c.synthetic.archiveSequence, '0');
    assert.ok(c.synthetic.note.en && c.synthetic.note.ja);
    assert.equal(c.synthetic, SYNTHETIC_CAPTURE);
    assert.deepEqual({ ...c.hashPins }, { ...MANIFEST[name] });
    assert.ok(c.pinNote.en && c.pinNote.ja);

    assert.equal(c.receipt.structuralOnly, true);
    assert.deepEqual({ ...c.receipt.receipt.action }, { ...EXPECTED[name] });
    assert.equal(c.instructionDataHex, DATA[name]);
    assert.equal(c.receipt.kindName, KIND[name]);
    assert.equal(c.receipt.size, KIND[name] === 'Economy' ? 184 : 225);
    assert.equal(c.receipt.links.at(-1).entity, 2);

    for (const phase of ['before', 'after']) {
      const { FS, holding } = c[phase];
      assert.deepEqual(FS.holdings, [], 'no fake legacy village');
      assert.equal(FS.readOnly, true);
      assert.equal(FS.executable, false);
      assert.equal(FS.verification, 'captured-unverified');
      assert.equal(FS.wideStatus, 'ready');
      assert.equal(FS.chain, undefined, 'no chain timer');
      assert.equal(FS.tab, 'holding');
      const sel = selectedWide(FS);
      assert.ok(sel, 'selectWide chose the slot');
      assert.equal(sel.holding, holding);
      assert.equal(holding.wide, true);
      assert.equal(holding.readOnly, true);
      assert.equal(holding.executable, false);
      assert.equal(holding.capture.verification, 'captured-unverified');
      assert.equal(holding.capture.slot, 0n);
      assert.equal(holding.capture.archiveSequence, 0n);
      assert.equal(holding.ownerCitizen, c.pins.citizenAddress);
      assert.equal(holding.world, c.pins.world);
      assert.equal(holding.capture.address, c.pins.holdingAddress);
      assert.ok(wideSlots(FS).some(s => s.status === 'captured-unverified'));
    }
    assert.equal(c.before.holding.key, c.after.holding.key);
    assert.equal(c.receipt.key.world, c.pins.world);
    assert.equal(c.receipt.key.p, c.before.holding.p);
    assert.equal(c.receipt.key.q, c.before.holding.q);
    assert.equal(c.receipt.key.site, c.before.holding.site);
    assert.equal(c.receipt.key.generation, c.before.holding.generation);

    // province: identity metadata of the exact wide layout, equal before and after
    for (const pm of [c.province.before, c.province.after]) {
      assert.equal(pm.structuralOnly, true);
      assert.equal(pm.size, 4864);
      assert.equal(pm.magic, 'PSFXWPV1');
      assert.equal(pm.layoutVersion, 3);
      assert.equal(pm.familyVersion, 1);
      assert.equal(pm.season, '11');
      assert.equal(pm.world, c.pins.world);
    }
    assert.equal(c.province.before.sortKey, c.province.after.sortKey);

    assert.equal(c.diff.arithmetic, 'none');
    for (const s of c.diff.stores) for (const v of [...Object.values(s.before), ...Object.values(s.after)]) assert.equal(typeof v, 'string');
  });

  test(`${name}: the raw recorded before/after strings match the independently decoded bytes`, async () => {
    const c = buildCase(name, await files(name));
    const d = c.diff;
    assert.deepEqual(d.stores.map(s => s.resource), RESOURCES);
    assert.deepEqual(d.stores.map(s => s.before.value), PRE_VALUES, 'pre values');
    assert.deepEqual(d.stores.map(s => s.after.value), POST_VALUES[name].map(String), 'post values');

    assert.equal(d.queue.length, 4);
    const q = (i, side) => [d.queue[i][side].kind, d.queue[i][side].arg, d.queue[i][side].doneAt, d.queue[i][side].delta];
    assert.deepEqual(q(0, 'before'), Q0[name].pre, 'queue 0 before');
    assert.deepEqual(q(0, 'after'), Q0[name].post, 'queue 0 after');
    for (const i of [1, 2, 3]) for (const side of ['before', 'after']) assert.deepEqual(q(i, side), EMPTY_Q, `queue ${i} ${side}`);

    assert.deepEqual([d.scalars.tier.before, d.scalars.tier.after], TIER[name], 'tier');
    assert.deepEqual([d.scalars.walls.before, d.scalars.walls.after], WALLS[name], 'walls');
    assert.equal(d.reserve.length, 8);
    assert.deepEqual(d.reserve.map(r => r.before), RESERVE[name].pre, 'reserve before');
    assert.deepEqual(d.reserve.map(r => r.after), RESERVE[name].post, 'reserve after');

    assert.equal(c.receipt.bell, RECEIPT[name][0]);
    assert.equal(c.receipt.receipt.now, RECEIPT[name][1]);
  });
}

test('a Build or Train case settles earlier queued work: wall queues, tier settles the wall, train settles the tier', async () => {
  // Stated as recorded facts of the five originals (not a rule): the wall dispatch leaves walls at 0 and queues kind 4;
  // the tier dispatch's walls go 0 -> 100 while tier stays 0; the train dispatch's tier goes 0 -> 1 and reserve 0 -> 10.
  const wall = buildCase('wall', await files('wall')), tier = buildCase('tier', await files('tier')), train = buildCase('train', await files('train'));
  assert.deepEqual([wall.diff.scalars.walls.before, wall.diff.scalars.walls.after], ['0', '0']);
  assert.equal(wall.diff.queue[0].after.kind, '4');
  assert.deepEqual([tier.diff.scalars.walls.before, tier.diff.scalars.walls.after], ['0', '100']);
  assert.deepEqual([tier.diff.scalars.tier.before, tier.diff.scalars.tier.after], ['0', '0']);
  assert.deepEqual([train.diff.scalars.tier.before, train.diff.scalars.tier.after], ['0', '1']);
  assert.deepEqual([train.diff.reserve[0].before, train.diff.reserve[0].after], ['0', '10']);
});

test('loadCase reads through a reader and matches buildCase', async () => {
  const c = await loadCase('harvest', disk);
  assert.equal(c.name, 'harvest');
  await assert.rejects(() => loadCase('nope', disk), code('UnknownCase'));
});

test('pins: any changed byte in any of the eight snapshots of the chosen case is refused', async () => {
  for (const name of CASE_NAMES) {
    const base = await files(name);
    for (const k of KEYS) {
      const f = copy(base); f[k][f[k].length >> 1] ^= 0x01;
      assert.throws(() => buildCase(name, f), code('PinMismatch'), `${name}/${k}`);
    }
  }
});

test('pins: a stale snapshot of another case with the same identity is refused', async () => {
  const all = Object.fromEntries(await Promise.all(CASE_NAMES.map(async n => [n, await files(n)])));
  let swapped = 0;
  for (const name of CASE_NAMES) for (const other of CASE_NAMES) {
    if (other === name) continue;
    for (const k of KEYS) {
      if (hex(all[other][k]) === hex(all[name][k])) continue; // byte-identical files are the same file, not a stale one
      const f = copy(all[name]); f[k] = all[other][k].slice();
      assert.throws(() => buildCase(name, f), code('PinMismatch'), `${name}/${k} <- ${other}`);
      swapped++;
    }
  }
  assert.ok(swapped > 0);
});

test('pins: a missing, partial or malformed pin set is refused', async () => {
  const f = await files('harvest');
  assert.throws(() => buildCase('harvest', f, { pins: {} }), code('PinMismatch'));
  assert.throws(() => buildCase('harvest', f, { pins: { harvest: { ...MANIFEST.harvest, 'extra.bin': '0'.repeat(64) } } }), code('PinMismatch'));
  const short = { ...MANIFEST.harvest }; delete short['record.bin'];
  assert.throws(() => buildCase('harvest', f, { pins: { harvest: short } }), code('PinMismatch'));
  assert.throws(() => buildCase('harvest', f, { pins: { harvest: { ...MANIFEST.harvest, 'record.bin': 'zz' } } }), code('PinMismatch'));
  assert.throws(() => buildCase('harvest', f, { pins: { harvest: MANIFEST.building } }), code('PinMismatch'));
});

test('a receipt of another case is refused (stale / swapped)', async () => {
  const f = await files('harvest');
  f.record = (await files('building')).record;
  assert.throws(() => buildCase('harvest', f), code('PinMismatch'));
  assert.throws(() => build('harvest', f), code('WrongCase'));
});

test('missing, truncated and wrongly sized inputs are refused', async () => {
  const base = await files('harvest');
  for (const k of KEYS) {
    const missing = copy(base); delete missing[k];
    assert.throws(() => buildCase('harvest', missing), code('MissingFile'), k);
    const empty = copy(base); empty[k] = new Uint8Array(0);
    assert.throws(() => buildCase('harvest', empty), code('MissingFile'), `${k} empty`);
    const cut = copy(base); cut[k] = cut[k].slice(0, cut[k].length - 1);
    assert.throws(() => buildCase('harvest', cut), code('PinMismatch'), `${k} truncated`);
    assert.throws(() => build('harvest', cut), notPin, `${k} truncated (repinned)`);
    const grown = copy(base); grown[k] = Uint8Array.from([...grown[k], 0]);
    assert.throws(() => buildCase('harvest', grown), code('PinMismatch'), `${k} grown`);
    assert.throws(() => build('harvest', grown), notPin, `${k} grown (repinned)`);
  }
  assert.throws(() => buildCase('nope', base), code('UnknownCase'));
});

test('foreign data is refused even when re-pinned: another owner, world or season', async () => {
  const base = await files('harvest');
  for (const k of ['holdingPre', 'holdingPost']) {
    const o = copy(base); o[k][72] ^= 0xff; // owner Citizen bytes
    assert.throws(() => build('harvest', o), notPin, `${k} owner`);
    const w = copy(base); w[k][1288] ^= 0xff; // trailer world (1280 + 8)
    assert.throws(() => build('harvest', w), notPin, `${k} world`);
  }
  const s = copy(base); s.season[8] ^= 0xff;
  assert.throws(() => build('harvest', s), notPin, 'season id');
  const wrongPair = copy(base); wrongPair.holdingPost = new Uint8Array(1344);
  assert.throws(() => build('harvest', wrongPair), notPin);
});

test('receipt structure: every malformed field is refused', async () => {
  const ordinary = (await files('harvest')).record;
  assert.equal(decodeReceipt(ordinary).structuralOnly, true);
  const bad = (mut, label, src = ordinary) => {
    const b = src.slice(); mut(b);
    assert.throws(() => decodeReceipt(b), anyModelError, label);
  };
  bad(b => { b[0] = 0x81; }, 'version');
  bad(b => { b[1] = 17; }, 'kind');
  bad(b => { b[1] = b[1] === 15 ? 16 : 15; }, 'kind vs size');
  bad(b => { b[6] = 2; }, 'key version');
  bad(b => { b[58] = 1; }, 'key seq');
  bad(b => { b[62] = 2; }, 'receipt version');
  bad(b => { b[77] = 2; }, 'final bool');
  bad(b => { b[142] = 2; }, 'link count');
  bad(b => { b[143] = 1; }, 'link order');
  assert.throws(() => decodeReceipt(ordinary.slice(0, 183)), anyModelError, 'truncated');
  assert.throws(() => decodeReceipt(Uint8Array.from([...ordinary, 0])), anyModelError, 'grown');
  assert.throws(() => decodeReceipt(null), anyModelError);
  const h = (await files('harvest')).record, bld = (await files('building')).record, trn = (await files('train')).record;
  bad(b => { b[64] = 1; }, 'Harvest padding', h);
  bad(b => { b[68] = 1; }, 'Harvest padding tail', h);
  bad(b => { b[64] = 9; }, 'Build item', bld);
  bad(b => { b[66] = 1; }, 'Build padding', bld);
  bad(b => { b[64] = 7; }, 'Train unit', trn);
  bad(b => { b[65] = 0; b[66] = 0; b[67] = 0; b[68] = 0; }, 'Train zero count', trn);
  bad(b => { b[63] = 3; }, 'action tag', h);
});

test('receipt holding key: site < 12, generation 1..254, non-zero world, a real wide ring', async () => {
  const h = (await files('harvest')).record;
  const bad = (mut, label) => { const b = h.slice(); mut(b); assert.throws(() => decodeReceipt(b), anyModelError, label); };
  bad(b => { b[56] = 12; }, 'site 12');
  bad(b => { b[56] = 255; }, 'site 255');
  bad(b => { b[57] = 0; }, 'generation 0');
  bad(b => { b[57] = 255; }, 'generation 255');
  bad(b => { b.fill(0, 7, 39); }, 'zero world');
  bad(b => { b.fill(0, 39, 56); }, 'origin (ring 0, inside the legacy disk)');
  const ok = h.slice(); ok[57] = 254; ok[56] = 11;
  assert.equal(decodeReceipt(ok).key.site, 11);
});

test('receipt action and kind must agree: only Build items 6 and 7 are mirror receipts', async () => {
  const rec = Object.fromEntries(await Promise.all(CASE_NAMES.map(async n => [n, (await files(n)).record])));
  for (const n of CASE_NAMES) assert.equal(decodeReceipt(rec[n]).kindName, KIND[n], n);
  assert.equal(rec.wall.length, 225);
  assert.equal(rec.tier.length, 225);
  const bad = (src, mut, label) => { const b = src.slice(); mut(b); assert.throws(() => decodeReceipt(b), anyModelError, label); };
  // a mirror receipt whose action is not Build 6/7 (a real wall receipt with its action rewritten)
  bad(rec.wall, b => { b[63] = 0; b.fill(0, 64, 69); }, 'Harvest under Mirror');
  bad(rec.wall, b => { b[64] = 0; }, 'Build 0 under Mirror');
  bad(rec.tier, b => { b[64] = 8; }, 'Build 8 under Mirror');
  bad(rec.wall, b => { b[63] = 2; b[64] = 0; b[65] = 10; b[66] = 0; b[67] = 0; b[68] = 0; }, 'Train under Mirror');
  // an ordinary receipt whose action is Build 6/7
  bad(rec.building, b => { b[64] = 6; }, 'Build 6 under Economy');
  bad(rec.building, b => { b[64] = 7; }, 'Build 7 under Economy');
  // the kind byte against the size
  bad(rec.wall, b => { b[1] = 15; }, 'Mirror size with Economy kind');
  bad(rec.harvest, b => { b[1] = 16; }, 'Economy size with Mirror kind');
});

test('receipt of another holding is refused', async () => {
  const f = await files('harvest');
  f.record[56] = (f.record[56] + 1) % 12; // site
  assert.throws(() => build('harvest', f), code('KeyMismatch'));
  const g = await files('harvest');
  g.record[57] = g.record[57] === 1 ? 2 : 1; // generation
  assert.throws(() => build('harvest', g), code('KeyMismatch'));
});

test('a mirror receipt shape (province 1 then holding 2) decodes; the wrong order does not', async () => {
  const src = (await files('wall')).record;
  assert.equal(src.length, 225);
  const m = decodeReceipt(src);
  assert.equal(m.kindName, 'EconomyMirror');
  assert.deepEqual(m.links.map(l => l.entity), [1, 2]);
  const swapped = src.slice(); swapped[143] = 2; swapped[143 + 41] = 1;
  assert.throws(() => decodeReceipt(swapped), anyModelError);
  const holdingOnly = src.slice(); holdingOnly[142] = 1;
  assert.throws(() => decodeReceipt(holdingOnly), anyModelError);
});

// ---- province trailer (frontier-abi world_index/land.rs WideProvince::read)
const P = PROVINCE.AT;
test('province: exact wide layout is required, in either phase', async () => {
  const base = await files('harvest');
  for (const k of ['provincePre', 'provincePost']) {
    const bad = (mut, label) => { const f = copy(base); mut(f[k]); assert.throws(() => build('harvest', f), code('BadProvince'), `${k}: ${label}`); };
    bad(b => { b[0] ^= 0x01; }, 'magic');
    bad(b => { b.set(Buffer.from('ABCDEFGH')); }, 'arbitrary printable magic');
    bad(b => { b[P.LAYOUT_VERSION] = 2; }, 'layout version');
    bad(b => { b[P.FAMILY_VERSION] = 2; }, 'family version');
    bad(b => { b[P.STATUS] = 0; }, 'status');
    bad(b => { b[P.READINESS] = 7; }, 'readiness');
    bad(b => { b[P.RSV_53] = 1; }, 'reserved 53');
    bad(b => { b[P.RSV + 5] = 1; }, 'reserved tail');
    bad(b => { b[P.P] = 1; }, 'legacy P');
    bad(b => { b[P.RING] = 1; }, 'legacy ring');
    bad(b => { b[P.WEDGE] ^= 0x01; }, 'wedge');
    bad(b => { b.fill(0, P.RING_SEED, P.RING_SEED + 32); }, 'zero ring seed');
    bad(b => { b.fill(0, P.WORLD, P.WORLD + 32); }, 'zero world');
    bad(b => { b.fill(0, P.SORT_KEY, P.SORT_KEY + 17); }, 'legacy-disk sort key');
    const cut = copy(base); cut[k] = cut[k].slice(0, 4863);
    assert.throws(() => build('harvest', cut), code('BadProvince'), `${k} 4863 B`);
    const grown = copy(base); grown[k] = Uint8Array.from([...grown[k], 0]);
    assert.throws(() => build('harvest', grown), code('BadProvince'), `${k} 4865 B`);
    const legacy = copy(base); legacy[k] = new Uint8Array(4736).fill(1);
    assert.throws(() => build('harvest', legacy), code('BadProvince'), `${k} legacy size`);
  }
});

test('province: a foreign province is refused even when BOTH pre and post agree and the file set is re-pinned', async () => {
  const base = await files('harvest');
  const both = (mut, label) => {
    const f = copy(base); mut(f.provincePre); mut(f.provincePost);
    assert.throws(() => build('harvest', f), code('ProvinceMismatch'), label);
  };
  both(b => { b[P.WORLD + 7] ^= 0x55; }, 'foreign world');
  both(b => { b[P.SEASON_ID] ^= 0x01; }, 'foreign season');
  // a different canonical coordinate: the ring-position field (last 8 sort-key bytes, big-endian) moved by one
  const f = copy(base);
  for (const b of [f.provincePre, f.provincePost]) {
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const pos = v.getBigUint64(P.SORT_KEY + 9, false);
    v.setBigUint64(P.SORT_KEY + 9, pos === 0n ? 1n : pos - 1n, false);
  }
  assert.throws(() => build('harvest', f), anyModelError, 'another coordinate');
  // same-size wrong magic, both phases
  const m = copy(base); for (const b of [m.provincePre, m.provincePost]) b.set(Buffer.from('PSFXWPV2'));
  assert.throws(() => build('harvest', m), code('BadProvince'), 'wrong magic, same size');
});

test('province: pre and post must name the same province', async () => {
  const base = await files('harvest');
  const f = copy(base); f.provincePost[P.WORLD + 3] ^= 0xaa;
  assert.throws(() => build('harvest', f), code('ProvinceMismatch'));
  const s = copy(base); s.provincePre[P.SEASON_ID] ^= 0x01;
  assert.throws(() => build('harvest', s), code('ProvinceMismatch'));
});

test('province metadata is identity only, not a proof', async () => {
  const c = buildCase('wall', await files('wall'));
  assert.deepEqual(Object.keys(c.province.before).sort(),
    ['familyVersion', 'layoutVersion', 'magic', 'openedBell', 'p', 'q', 'region', 'ring', 'season', 'size', 'sortKey', 'structuralOnly', 'wedge', 'world'].sort());
  assert.ok(BigInt(c.province.before.ring) >= 129n);
});

test('a read-only reader never mutates the inputs (receipt decode)', async () => {
  const r = (await files('train')).record;
  const before = hex(r);
  decodeReceipt(r);
  assert.equal(hex(r), before);
});
