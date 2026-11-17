// The READ-ONLY reservation read of the local-play relay (local-play-conquest-orders.mjs) and the family readers it
// rests on (conquest-table-read.mjs).
//
// SELF-OWNED, MEMORY-ONLY: no chain, no relay process, no wallet key, no network. The table is the ABI codec's own
// vector (docs/integration/CLAUDE-CONQUEST-RESERVATION-VECTORS-20261112.json); the wide Province and the Citizen are
// built here from the ABI layouts as read (land.rs, player.rs), and for the end-to-end read the vector's world and one
// Citizen are rewritten to this test's own. So this shows the checks agree with the ABI source and its vectors — NOT
// with accounts read from a real chain. Runs under the no-key guard.
//
// HISTORICAL TABLE VERSION: that vector file was written by the earlier artefact's codec — a 2,688-byte table whose
// header says layout version 1. The current program writes version 2 and the route reads version 2 only. So every
// table read here passes the explicit historical option (`historicalV1` / `historicalTableV1`), which no route can
// pass; the bytes are NOT rewritten to say 2. What these tests keep showing is the structure below the header
// (entries, records, pairing, the read's answer). The current version on real bytes: frontier-conquest-v2-evidence.test.mjs.
const HIST = Object.freeze({ historicalV1: true });
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as T from '../src/frontier/conquest-table-read.mjs';
import { createConquestOrdersRead, CONQUEST_ORDERS_ROUTE, CONQUEST_ORDERS_REQUEST_SCHEMA, CONQUEST_ORDERS_SCHEMA } from '../src/frontier/local-play-conquest-orders.mjs';
import { createLocalPlayConquest, CONQUEST_OPEN_CONDITIONS } from '../src/frontier/local-play-conquest.mjs';
import { LocalPlayError, LOCAL_PLAY_PROGRAM, LOCAL_PLAY_RULESET_HASH } from '../src/frontier/local-play-relay.mjs';
import { ConquestPrepareError } from '../src/frontier/conquest-prepare.mjs';
import { seasonPda, withSeed, seedOf } from '../../permutation-server/web/frontier/faddr.mjs';
import { worldIdOf } from '../../permutation-server/web/frontier/map/wide.mjs';
import { canonicalOriginalHostRef } from '../../permutation-server/web/frontier/fexpedition-seal.mjs';
import { canonicalDeclareSiegeRoles } from '../../permutation-server/web/frontier/fconquest-identity.mjs';
import { canonicalExpeditionAccounts } from '../../permutation-server/web/frontier/fexpedition-identity.mjs';
import { siegeOrderModel } from '../../permutation-server/web/frontier/fconquest-order.mjs';
import { encode, decode } from '../../permutation-server/web/sdk/base58.mjs';

const V = JSON.parse(readFileSync(new URL('../../docs/integration/CLAUDE-CONQUEST-RESERVATION-VECTORS-20261112.json', import.meta.url), 'utf8'));
const unhex = s => Uint8Array.from(s.match(/../g) ?? [], x => parseInt(x, 16));
const hex = b => Buffer.from(b).toString('hex');
const VT = unhex(V.table.table_hex), VKEY = V.table.province_key_hex, SEASON_ID = 11;
const ascii = (b, s, at = 0) => { for (let i = 0; i < s.length; i++) b[at + i] = s.charCodeAt(i); };
const put = (b, f) => { const c = Uint8Array.from(b); f(c, new DataView(c.buffer)); return c; };

/** A wide Province (land.rs layout) of province key `key`, whose conquest records are the ones `table` pairs with. */
function province(key, table) {
  const b = new Uint8Array(4864), v = new DataView(b.buffer), k = unhex(key), Tr = 4736;
  ascii(b, 'PSFXWPV1'); v.setBigUint64(8, BigInt(SEASON_ID), true); v.setUint16(16, 3, true);
  b[70] = k[41];                                   // prefix WEDGE = the sort key's wedge
  v.setUint16(Tr, 1, true); b[Tr + 2] = 1; b[Tr + 3] = 15;
  b.set(k.subarray(1, 33), Tr + 4); b.set(k.subarray(33, 50), Tr + 36); b.fill(0x5a, Tr + 64, Tr + 96);
  const pending = new Set();
  for (let i = 0; i < 8; i++) { const o = 1664 + i * 128; if (table[o] === 1) pending.add(table[o + 1]); }
  for (let s = 0; s < 12; s++) {
    const e = table.subarray(128 + s * 128, 256 + s * 128), at = 4096 + s * 32;
    if (e.some(x => x !== 0)) { b.set(e.subarray(0, 16), at); b.set(e.subarray(104, 112), at + 16); } else b[at + 2] = pending.has(s) ? 64 : 0;
  }
  return b;
}
/** A Citizen v2 (player.rs layout) of `wallet` at `address`, with slot byte `slots`. */
function citizen(wallet, address, slots) {
  const b = new Uint8Array(384), v = new DataView(b.buffer);
  ascii(b, 'PSF1CITZ'); v.setBigUint64(8, BigInt(SEASON_ID), true); v.setUint16(16, 2, true);
  b.set(decode(wallet), 64); b[187] = slots; b.set(decode(address).subarray(0, 8), 208);
  for (let i = 0; i < 3; i++) b[168 + i * 6 + 5] = 255;   // (HOLDING @ 168: three six-byte refs; generation 0xFF = an EMPTY inventory slot)
  return b;
}
const throwsCode = (f, code) => assert.throws(f, e => e?.code === code, code);

test('the wide Province is read as the WIDE family: the legacy family, another Season, world or place, or a malformed trailer is refused', () => {
  const ok = province(VKEY, VT), opts = { seasonId: SEASON_ID, key: VKEY };
  assert.deepEqual(T.wideProvinceIdentity(ok, opts), { world: V.table.world_hex, p: '129', q: '0' });
  assert.equal(ok.length, T.WIDE_PROVINCE_SIZE); assert.equal(T.WIDE_LAYOUT_VERSION, 3);
  const bad = (f, code) => throwsCode(() => T.wideProvinceIdentity(put(ok, f), opts), code);
  // size: the legacy Province's 4,736 bytes, one byte short or long
  for (const n of [4736, 4863, 4865, 0]) throwsCode(() => T.wideProvinceIdentity(ok.slice(0, n).length === n ? ok.slice(0, n) : new Uint8Array(n), opts), 'WideProvinceSize');
  throwsCode(() => T.wideProvinceIdentity(new Uint8Array(4865), opts), 'WideProvinceSize'); throwsCode(() => T.wideProvinceIdentity(null, opts), 'WideProvinceSize');
  // header: the legacy magic, the v2 layout version, another Season
  bad(b => ascii(b, 'PSF1PROV'), 'WideProvinceHeader'); bad(b => ascii(b, 'PSFXWRS1'), 'WideProvinceHeader');
  for (const lv of [2, 1, 4]) bad((b, v) => v.setUint16(16, lv, true), 'WideProvinceHeader');
  bad((b, v) => v.setBigUint64(8, 12n, true), 'WideProvinceHeader');
  throwsCode(() => T.wideProvinceIdentity(ok, { seasonId: 12, key: VKEY }), 'WideProvinceHeader');
  // trailer: family version, status, readiness (missing a bit, or an extra one), reserved bytes
  bad((b, v) => v.setUint16(4736, 2, true), 'WideProvinceTrailer'); bad(b => { b[4738] = 0; }, 'WideProvinceTrailer'); bad(b => { b[4738] = 2; }, 'WideProvinceTrailer');
  for (const r of [0, 7, 14, 31]) bad(b => { b[4739] = r; }, 'WideProvinceTrailer');
  bad(b => { b[4736 + 53] = 1; }, 'WideProvinceTrailer'); bad(b => { b[4736 + 104] = 1; }, 'WideProvinceTrailer'); bad(b => { b[4863] = 1; }, 'WideProvinceTrailer');
  // a legacy identity written into the prefix (P, Q or RING)
  bad((b, v) => v.setInt16(64, 129, true), 'WideProvinceLegacyIdentity'); bad((b, v) => v.setInt16(66, -1, true), 'WideProvinceLegacyIdentity'); bad((b, v) => v.setUint16(68, 129, true), 'WideProvinceLegacyIdentity');
  // the coordinate: a wedge that is not the sort key's, a non-canonical sort key, a ring within the legacy disk
  bad(b => { b[70] = (b[70] + 1) % 6; }, 'WideProvinceCoord'); bad(b => { b[4736 + 36 + 8] = 6; }, 'WideProvinceCoord');
  bad((b, v) => { v.setBigUint64(4736 + 36, 128n, false); }, 'WideProvinceCoord');
  bad(b => b.fill(0, 4736 + 64, 4736 + 96), 'WideProvinceSeed');
  // another world, another place (same world), the mirrored place: each a real province, none this request's
  bad(b => { b[4736 + 4] ^= 1; }, 'WideProvinceWorld'); bad(b => b.fill(0, 4736 + 4, 4736 + 36), 'WideProvinceCoord');
  const other = (p, q) => hex(unhex(canonicalDeclareKey(V.table.world_hex, p, q)));
  for (const [p, q] of [['130', '0'], ['-129', '0'], ['129', '-1'], ['0', '129']]) throwsCode(() => T.wideProvinceIdentity(ok, { seasonId: SEASON_ID, key: other(p, q) }), 'WideProvinceCoord');
  // a negative province is a province: its own Province is accepted for its own key
  const neg = other('-129', '0'); assert.deepEqual(T.wideProvinceIdentity(province(neg, new Uint8Array(2688)), { seasonId: SEASON_ID, key: neg }), { world: V.table.world_hex, p: '-129', q: '0' });
  throwsCode(() => T.wideProvinceIdentity(ok, { seasonId: SEASON_ID, key: 'zz' }), 'WideProvinceKey');
});
/** The canonical 50-byte key of (p, q) in `world`, by the page's own derivation (the request path). */
function canonicalDeclareKey(world, p, q) {
  const k = unhex(canonicalExpeditionAccounts(source({ standing: { p, q } })).standing_key); k.set(unhex(world), 1); return hex(k);
}

test('the Citizen is read as itself: size, magic, layout, Season, the wallet written in it, its own tag', () => {
  const wallet = encode(new Uint8Array(32).fill(21)), address = encode(Uint8Array.from({ length: 32 }, (_, i) => i + 3)), ok = citizen(wallet, address, 0x14);
  const opts = { seasonId: SEASON_ID, wallet: decode(wallet), address: decode(address) };
  assert.deepEqual(T.citizenIdentity(ok, opts), { slots: 0x14 });
  const bad = (f, code) => throwsCode(() => T.citizenIdentity(put(ok, f), opts), code);
  for (const n of [383, 385, 1280, 4864]) throwsCode(() => T.citizenIdentity(new Uint8Array(n), opts), 'CitizenSize');
  bad(b => ascii(b, 'PSF1HOLD'), 'CitizenHeader'); bad((b, v) => v.setUint16(16, 3, true), 'CitizenHeader'); bad((b, v) => v.setUint16(16, 1, true), 'CitizenHeader'); bad((b, v) => v.setBigUint64(8, 1n, true), 'CitizenHeader');
  bad(b => { b[64] ^= 1; }, 'CitizenWallet'); bad(b => { b[95] ^= 1; }, 'CitizenWallet');
  throwsCode(() => T.citizenIdentity(ok, { ...opts, wallet: decode(encode(new Uint8Array(32).fill(22))) }), 'CitizenWallet');
  bad(b => { b[208] ^= 1; }, 'CitizenTag'); bad(b => { b[215] ^= 1; }, 'CitizenTag');
  throwsCode(() => T.citizenIdentity(ok, { ...opts, address: decode(encode(new Uint8Array(32).fill(9))) }), 'CitizenTag');
});

test('the conquest table with its Province: the ABI vector is accepted whole; a wrong header, entry, record or pairing is refused', () => {
  const P = province(VKEY, VT), opts = { seasonId: SEASON_ID, key: VKEY, ...HIST };
  const got = T.conquestTable(VT, P, opts);
  assert.deepEqual(got.records.map(r => ({ ...r })), V.table.records.map(r => r.fable_decoder_expected));
  const bad = (f, code, prov = null) => { const t = put(VT, f); throwsCode(() => T.conquestTable(t, prov ? prov(t) : P, opts), code); };
  const paired = t => province(VKEY, t);   // (a Province that agrees with the mutated table: so the refusal is the table's own)
  // header
  throwsCode(() => T.conquestTable(VT.slice(0, 1664), P, opts), 'ConquestTableSize');
  bad(b => ascii(b, 'PSFXWCE1'), 'ConquestTableHeader'); bad((b, v) => v.setBigUint64(8, 12n, true), 'ConquestTableHeader'); bad((b, v) => v.setUint16(16, 2, true), 'ConquestTableVersion');   // (under the historical option; the version has its own code)
  bad(b => { b[20] = 1; }, 'ConquestTableHeader'); bad(b => { b[125] = 1; }, 'ConquestTableHeader');
  throwsCode(() => T.conquestTable(VT, P, { seasonId: 12, key: VKEY, ...HIST }), 'ConquestTableHeader');
  // the version: WITHOUT the historical option this version-1 vector is refused (the route's reading); with it, a version-2 header is
  throwsCode(() => T.conquestTable(VT, P, { seasonId: SEASON_ID, key: VKEY }), 'ConquestTableVersion');
  throwsCode(() => T.conquestTable(VT, P, { seasonId: SEASON_ID, key: VKEY, historicalV1: false }), 'ConquestTableVersion');
  throwsCode(() => T.conquestTable(put(VT, b => { b[16] = 2; }), P, opts), 'ConquestTableVersion');
  for (const v of [0, 3, 255]) for (const o of [opts, { seasonId: SEASON_ID, key: VKEY }]) throwsCode(() => T.conquestTable(put(VT, b => { b[16] = v; }), P, o), 'ConquestTableVersion');
  for (const o of [opts, { seasonId: SEASON_ID, key: VKEY }]) throwsCode(() => T.conquestTable(put(VT, b => { b[17] = 1; }), P, o), 'ConquestTableVersion');
  for (const h of [1, 0, 'true', null, {}]) throwsCode(() => T.conquestTable(VT, P, { seasonId: SEASON_ID, key: VKEY, historicalV1: h }), 'ConquestTableVersion');
  // a 1,664-byte table (the layout of a program without the lane) is refused by size, with or without the option
  for (const o of [opts, { seasonId: SEASON_ID, key: VKEY }]) throwsCode(() => T.conquestTable(VT.slice(0, 1664), P, o), 'ConquestTableSize');
  // the table of another world or another place is not this province's
  bad(b => { b[33] ^= 1; }, 'ConquestTableProvince'); bad(b => { b[81] ^= 1; }, 'ConquestTableProvince');
  // the site 9 entry (a siege): each field the ABI validates
  const E = 128 + 9 * 128;
  assert.equal(VT[E], 1, 'the vector\'s applied reservation is a siege entry at site 9');
  bad(b => { b[E + 112] = 1; }, 'ConquestEntry', paired); bad(b => { b[E + 112] = 4; }, 'ConquestEntry', paired);
  bad(b => { b[E + 104] ^= 1; }, 'ConquestEntry', paired); bad(b => b.fill(0, E + 16, E + 48), 'ConquestEntry', paired);
  bad(b => { b[E + 113] = 254; }, 'ConquestEntry', paired); bad(b => { b[E + 127] = 1; }, 'ConquestEntry', paired);
  bad(b => { b[E] = 2; }, 'ConquestEntry', paired); bad(b => { b[E] = 4; }, 'ConquestEntry', paired);
  bad(b => { b[E + 2] = 1; }, 'ConquestEntry', paired); bad(b => { b[E + 3] = b[E + 4]; }, 'ConquestEntry', paired); bad(b => { b[E + 4] = 0; }, 'ConquestEntry', paired);
  bad(b => { b[E + 5] = 3; }, 'ConquestEntry', paired); bad(b => { b[E + 1] = 6; }, 'ConquestEntry', paired); bad(b => { b[E + 6] = 1; }, 'ConquestEntry', paired);
  bad((b, v) => v.setUint32(E + 12, v.getUint32(E + 114, true) + 1, true), 'ConquestEntry', paired);
  bad(b => b.fill(0, E + 48, E + 104), 'ConquestEntry', paired);                                   // a siege with no source
  // its source Holding reference: another world, a host seq, no generation, a bad key tag, a site out of range
  bad(b => { b[E + 49] ^= 1; }, 'ConquestHostRef', paired); bad(b => { b[E + 48 + 52] = 1; }, 'ConquestHostRef', paired);
  bad(b => { b[E + 48 + 51] = 0; }, 'ConquestHostRef', paired); bad(b => { b[E + 48 + 51] = 255; }, 'ConquestHostRef', paired);
  bad(b => { b[E + 48] = 2; }, 'ConquestHostRef', paired); bad(b => { b[E + 48 + 50] = 12; }, 'ConquestHostRef', paired);
  // a second entry holding the same (Citizen, slot)
  bad(b => b.set(b.slice(E, E + 128), 128 + 10 * 128), 'ConquestEntrySlot', paired);
  // the entry's OTHER valid kinds are accepted too (with the Province that pairs with them):
  //   CAPTURE_DUE — credited, no progress or requirement, due at a bell after the declaration, the source kept
  const due = put(VT, (b, v) => { b[E] = 3; b[E + 2] = 16; b[E + 3] = 0; b[E + 4] = 0; v.setUint32(E + 12, v.getUint32(E + 114, true) + 36, true); });
  assert.equal(T.conquestTable(due, paired(due), opts).records.length, 5, 'a CAPTURE_DUE entry');
  //   slot owed — kind none, the slot-owed flag, the slot as its requirement, no source, no target, barred to nobody, no bell
  const owed = put(VT, (b, v) => { b[E] = 0; b[E + 1] = 0xff; b[E + 2] = 32; b[E + 3] = 0; b[E + 4] = b[E + 112]; b[E + 5] = 0; v.setUint32(E + 12, 0, true); b.fill(0, E + 48, E + 104); });
  assert.equal(T.conquestTable(owed, paired(owed), opts).records.length, 5, 'a slot-owed entry');
  //   and each of them refuses its own wrong fields
  const wrong = (base, f, code = 'ConquestEntry') => { const t = put(base, f); throwsCode(() => T.conquestTable(t, paired(t), opts), code); };
  wrong(due, b => { b[E + 2] = 9; }); wrong(due, b => { b[E + 3] = 1; }); wrong(due, b => { b[E + 4] = 1; }); wrong(due, (b, v) => v.setUint32(E + 12, v.getUint32(E + 114, true), true)); wrong(due, b => b.fill(0, E + 48, E + 104));
  wrong(owed, b => { b[E + 2] = 0; }); wrong(owed, b => { b[E + 4] = 5 - b[E + 112]; }); wrong(owed, b => { b[E + 1] = 0; }); wrong(owed, b => { b[E + 5] = 3; }); wrong(owed, (b, v) => v.setUint32(E + 12, 1, true));
  wrong(owed, b => b.set(VT.slice(E + 48, E + 104), E + 48));                                        // slot owed, yet a source
  // records: the region's own shape, then each record's host and actor tag
  const R0 = 1664, R3 = 1664 + 3 * 128;
  bad(b => { b[R0] = 3; }, 'ReservationRecordStatus', paired); bad(b => { b[R0 + 5] = 3; }, 'ReservationRecordDone', paired);
  bad(b => { b[R0 + 49] ^= 1; }, 'ConquestHostRef', paired); bad(b => { b[R0 + 48 + 51] = 0; }, 'ConquestHostRef', paired);
  bad(b => { b[R0 + 48] = 0; }, 'ConquestHostRef', paired); bad(b => { b[R0 + 48 + 50] = 12; }, 'ConquestHostRef', paired); bad(b => { b[R0 + 48 + 33 + 8] = 6; }, 'ConquestHostRef', paired);
  bad(b => { b[R0 + 104] ^= 1; }, 'ConquestRecordActor', paired);
  // a record still holding the (Citizen, slot) an entry holds
  bad(b => { b.set(b.slice(E + 16, E + 48), R3 + 16); b.set(b.slice(E + 104, E + 112), R3 + 104); b[R3 + 3] = b[E + 112]; }, 'ConquestRecordSlot', paired);
  // pairing with the Province, site by site
  const prov = f => () => put(P, f), C = s => 4096 + s * 32;
  const pair = (f, code = 'ConquestPairing') => throwsCode(() => T.conquestTable(VT, put(P, f), opts), code);
  assert.equal(P[C(1) + 2], 64); assert.equal(P[C(7) + 2], 64); assert.equal(P[C(0) + 2], 0);
  pair(b => { b[C(1) + 2] = 0; });                    // a PENDING record names site 1, the Province does not say so
  pair(b => { b[C(0) + 2] = 64; });                   // the Province says pending, no record names site 0
  pair(b => { b[C(1) + 2] = 64 | 32; }); pair(b => { b[C(0) + 2] = 4; });   // flags must be exactly 0 or 64
  pair(b => { b[C(0)] = 1; }); pair(b => { b[C(0) + 1] = 6; }); pair(b => { b[C(0) + 3] = 1; }); pair(b => { b[C(0) + 4] = 1; }); pair(b => { b[C(0) + 5] = 1; });
  pair(b => { b[C(0) + 6] = 1; }); pair(b => { b[C(0) + 16] = 1; }); pair(b => { b[C(0) + 24] = 1; });
  for (const f of [0, 5, 0xfe, 0xff]) T.conquestTable(VT, put(P, b => { b[C(0) + 1] = f; }), opts);   // (valid idle factions)
  // the entry's site: the Province record must be the entry's prefix, byte for byte (not skipped)
  pair(b => { b[C(9) + 3] ^= 1; }); pair(b => { b[C(9) + 16] ^= 1; }); pair(b => { b[C(9) + 24] = 1; }); pair(b => b.fill(0, C(9), C(9) + 32));
  throwsCode(() => T.conquestTable(VT, P.slice(0, 4736), opts), 'WideProvinceSize');
  void prov;
});

// ------------------------------------------------------------------ the read itself (stub runner, this test's own world)
const WALLET = encode(Uint8Array.from({ length: 32 }, (_, i) => 200 - i)), SEASON = seasonPda(LOCAL_PLAY_PROGRAM, SEASON_ID)[0], WORLD = worldIdOf(SEASON, LOCAL_PLAY_PROGRAM);
const cfg = (over = {}) => ({ localPlay: true, rpc: 'http://127.0.0.1:41964', program: LOCAL_PLAY_PROGRAM, season: SEASON, wallet: WALLET,
  rulesetHash: LOCAL_PLAY_RULESET_HASH, prepareBin: '/nonexistent/frontier-experimental-expedition-depart-prepare', cuLimit: '400000', loadedLimit: '1048576', ...over });
function source(over = {}) {
  return { schema: 'frontier-original-expedition-request-v1', operation: 'inspect', cluster: 'localnet', program: LOCAL_PLAY_PROGRAM, season: SEASON,
    deployment: { program_version: '18436', ruleset_hash: LOCAL_PLAY_RULESET_HASH },
    host: canonicalOriginalHostRef({ world: WORLD, p: '128', q: '0', site: 1, gen: 2, seq: 0 }),
    original_owner: withSeed(SEASON, seedOf('Citizen', { wallet: WALLET }), LOCAL_PLAY_PROGRAM), standing: { p: '129', q: '0' }, min_slot: '80', wallet: WALLET, payer: WALLET, ...over };
}
const ROLES = canonicalDeclareSiegeRoles(source(), 0), AT = n => ROLES.find(r => r.name === n).address;
const CITIZEN_AT = AT('citizen'), KEY = canonicalExpeditionAccounts(source()).standing_key;
/** The vector's table moved into THIS test's world, with the vector's Citizen A (records 0 and 3) made this wallet's Citizen. A synthetic rewrite. */
function ownTable() {
  return put(VT, b => {
    const w = unhex(WORLD);
    b.set(w, 33);
    for (let s = 0; s < 12; s++) { const o = 128 + s * 128; if (b.subarray(o, o + 128).some(x => x !== 0) && b.subarray(o + 48, o + 104).some(x => x !== 0)) b.set(w, o + 49); }
    for (let i = 0; i < 8; i++) { const o = 1664 + i * 128; if (b.subarray(o, o + 128).some(x => x !== 0)) b.set(w, o + 49); }
    for (const i of [0, 3]) { const o = 1664 + i * 128, c = decode(CITIZEN_AT); b.set(c, o + 16); b.set(c.subarray(0, 8), o + 104); }
  });
}
const acct = (bytes, over = {}) => (bytes === null ? null : { owner: LOCAL_PLAY_PROGRAM, executable: false, lamports: 1, data: [Buffer.from(bytes).toString('base64'), 'base64'], ...over });
function harness({ table = ownTable(), prov = undefined, cit = citizen(WALLET, CITIZEN_AT, 0x14), wrap = x => x, city = { p: '129', q: '0', site: 3, tile: 43 }, slot = 77 } = {}) {
  const calls = [];
  // (with a city the read asks a fourth account: the wide Holding position of the city's site — absent here)
  const values = () => wrap([acct(table), acct(prov === undefined ? province(KEY, table ?? new Uint8Array(2688)) : prov), acct(cit), ...(city === null ? [] : [null])]);
  const rpc = async (method, params) => { calls.push({ method, params }); return { result: { context: { slot }, value: values() } }; };
  return { calls, read: createConquestOrdersRead({ cfg: cfg(), city, rpc, historicalTableV1: true }) };
}
const body = (over = {}) => ({ schema: CONQUEST_ORDERS_REQUEST_SCHEMA, source_request: source(over) });
const refused = (p, code) => assert.rejects(p, e => (e instanceof LocalPlayError || e instanceof ConquestPrepareError) && e.code === code, code);

test('the read: one coherent read of three derived accounts → this wallet\'s pending and not-applied orders, and nothing else', async () => {
  const h = harness(), got = await h.read.read(body());
  assert.equal(h.calls.length, 1);
  // (four derived addresses in ONE call: the table, the Province, the Citizen, and the Holding position of the city's site 3)
  const HOLDING_AT = canonicalDeclareSiegeRoles(source(), 3).find(r => r.name === 'target_holding_position').address;
  assert.deepEqual(h.calls[0], { method: 'getMultipleAccounts', params: [[AT('conquest'), AT('target_province'), CITIZEN_AT, HOLDING_AT], { encoding: 'base64', commitment: 'confirmed' }] });
  assert.deepEqual(Object.keys(got), ['schema', 'context_slot', 'program', 'season', 'wallet', 'standing', 'table_address', 'table', 'orders', 'siege']);
  assert.equal(got.siege, null, 'nothing stands at the city\'s site 3 (the vector\'s entry is at site 9): nothing is said');
  assert.deepEqual([got.schema, got.context_slot, got.program, got.season, got.wallet, got.standing, got.table_address, got.table],
    [CONQUEST_ORDERS_SCHEMA, '77', LOCAL_PLAY_PROGRAM, SEASON, WALLET, { p: '129', q: '0' }, AT('conquest'), 'present']);
  // the vector's records of Citizen A: seq 0 (not applied; slot and rent released, resources owed) and seq 5 (pending, bell 40)
  assert.deepEqual(got.orders.map(o => o.seq), [0, 5]);
  const [a, b] = got.orders.map(o => siegeOrderModel(o.facts));
  assert.deepEqual([a.ok, a.phase, a.site, a.orderBell, a.stake, a.slot, a.settled, a.lapsed, a.source, a.reason, a.decidedBell, a.day], [true, 'not_applied', 5, '30', 'held', 'released', false, null, null, null, null, null]);
  assert.deepEqual([b.ok, b.phase, b.site, b.orderBell, b.stake, b.slot, b.settled], [true, 'ordered', 1, '40', 'held', 'held', false]);
  // nothing of the others' records, of the applied reservation (seq 3, now an entry) or of the returned one (seq 4)
  assert.ok(!JSON.stringify(got).match(/started|captured|returned"|"lost"|unresolved/));
  // no table at all: no orders, and nothing more is said; a table with none of this wallet's records: none
  assert.deepEqual((await harness({ table: null }).read.read(body())).orders, []); assert.equal((await harness({ table: null }).read.read(body())).table, 'absent');
  assert.deepEqual((await harness({ table: put(VT, b => b.set(unhex(WORLD), 33)), prov: undefined }).read.read(body()).catch(e => e.code)), 'ConquestPrepareScopeMismatch', '(a table whose hosts are of another world is refused, not emptied)');
  const others = put(ownTable(), b => { for (const i of [0, 3]) { b.fill(9, 1664 + i * 128 + 16, 1664 + i * 128 + 48); b.fill(9, 1664 + i * 128 + 104, 1664 + i * 128 + 112); } });
  assert.deepEqual((await harness({ table: others, cit: null }).read.read(body())).orders, [], 'none of mine: the Citizen is not even needed');
});

test('the read refuses, whole: another scope, a foreign or executable account, a wrong family, a Citizen that does not bear the record out, a failed read', async () => {
  // scope: nothing is read for another wallet, payer, program, Season, cluster, version or ruleset; nor another province than the capability's
  for (const over of [{ wallet: encode(new Uint8Array(32).fill(5)) }, { payer: encode(new Uint8Array(32).fill(5)) }, { cluster: 'devnet' }, { program: SEASON }, { season: LOCAL_PLAY_PROGRAM },
    { deployment: { program_version: '18435', ruleset_hash: LOCAL_PLAY_RULESET_HASH } }, { deployment: { program_version: '18436', ruleset_hash: 'ab'.repeat(32) } }]) {
    const h = harness(); await refused(h.read.read(body(over)), 'LocalPlayScopeMismatch'); assert.equal(h.calls.length, 0);
  }
  for (const standing of [{ p: '130', q: '0' }, { p: '-129', q: '0' }]) { const h = harness(); await refused(h.read.read(body({ standing })), 'ConquestPrepareScopeMismatch'); assert.equal(h.calls.length, 0); }
  for (const bad of [null, {}, { schema: 'x', source_request: source() }, { ...body(), extra: 1 }, { schema: CONQUEST_ORDERS_REQUEST_SCHEMA, source_request: null }]) await refused(harness().read.read(bad), 'LocalPlayInvalidRequest');
  // accounts: another owner, an executable one, a malformed value — for each of the three
  for (const i of [0, 1, 2]) for (const over of [{ owner: SEASON }, { executable: true }, { executable: undefined }, { data: ['AA==', 'base58'] }, { data: 'AA==' }])
    await refused(harness({ wrap: v => v.map((x, k) => (k === i ? { ...x, ...over } : x)) }).read.read(body()), 'ConquestPrepareScopeMismatch');
  // the Province: absent, the legacy family (4,736 bytes / PSF1PROV / layout 2), another Season, world or place
  const good = province(KEY, ownTable());
  await refused(harness({ prov: null }).read.read(body()), 'ConquestPrepareScopeMismatch');
  for (const p of [good.slice(0, 4736), put(good, b => ascii(b, 'PSF1PROV')), put(good, (b, v) => v.setUint16(16, 2, true)), put(good, (b, v) => v.setBigUint64(8, 1n, true)),
    put(good, b => { b[4736 + 4] ^= 1; }), province(canonicalDeclareKey(WORLD, '130', '0'), ownTable()), put(good, b => { b[4739] = 7; }), put(good, (b, v) => v.setInt16(64, 129, true))])
    await refused(harness({ prov: p }).read.read(body()), 'ConquestPrepareScopeMismatch');
  // the table: another province's or Season's, a bad size, a Province that disagrees with it
  for (const t of [put(ownTable(), b => { b[81] ^= 1; }), put(ownTable(), (b, v) => v.setBigUint64(8, 1n, true)), ownTable().slice(0, 1664), put(ownTable(), b => { b[1664 + 5] = 3; })])
    await refused(harness({ table: t, prov: good }).read.read(body()), 'ConquestPrepareScopeMismatch');
  await refused(harness({ prov: put(good, b => { b[4096 + 32 + 2] = 0; }) }).read.read(body()), 'ConquestPrepareScopeMismatch');
  // the Citizen: absent, another kind, another wallet's, a wrong tag, or WITHOUT the reservation mark of the slot a record still holds
  await refused(harness({ cit: null }).read.read(body()), 'ConquestPrepareScopeMismatch');
  const cz = (f, slots = 0x14) => put(citizen(WALLET, CITIZEN_AT, slots), f);
  for (const c of [cz(b => ascii(b, 'PSF1HOLD')), cz(b => { b[64] ^= 1; }), cz(b => { b[208] ^= 1; }), cz((b, v) => v.setUint16(16, 3, true)), cz(() => {}).slice(0, 383),
    cz(() => {}, 0x00), cz(() => {}, 0x10), cz(() => {}, 0x04), cz(() => {}, 0x28)]) await refused(harness({ cit: c }).read.read(body()), 'ConquestPrepareScopeMismatch');
  await harness({ cit: cz(() => {}, 0x3c) }).read.read(body());   // (both slots marked: the record's slot is among them)
  // the runner: an error, no context slot, a short answer, a throw — never read as "absent"
  const failing = rpc => createConquestOrdersRead({ cfg: cfg(), city: null, rpc, historicalTableV1: true }).read(body());
  await refused(failing(async () => { throw new Error('down'); }), 'LocalPlayRpcUnavailable');
  await refused(failing(async () => ({ error: { code: -1 } })), 'LocalPlayRpcUnavailable');
  await refused(failing(async () => ({ result: { value: [null, null, null] } })), 'LocalPlayRpcUnavailable');
  await refused(failing(async () => ({ result: { context: { slot: 5 }, value: [null, null] } })), 'LocalPlayRpcUnavailable');
  await refused(failing(async () => ({ result: { context: { slot: 5 }, value: [null, null, null] } })), 'ConquestPrepareScopeMismatch');   // (the Province itself is absent)
});

test('CLOSED with the conquest routes: no conquest object, no read; the server offers the route only inside it; nothing here signs or sends', () => {
  assert.deepEqual(CONQUEST_OPEN_CONDITIONS, { dispatchPublished: true, addressVectorsVerified: true, heapConfirmed: false, pageBinding: false });
  assert.throws(() => createLocalPlayConquest({ cfg: cfg(), conquestBin: '/operator/bin/frontier-experimental-conquest-prepare' }), /closed \(not established: heapConfirmed, pageBinding\)/);
  // a test build (an explicit dispatch) carries the read as one of the conquest object's own functions
  const built = createLocalPlayConquest({ cfg: cfg(), conquestBin: '/operator/bin/frontier-experimental-conquest-prepare', dispatch: { DeclareSiege: { tag: 0xda, kind: 200, heap: 256 * 1024 } }, rpc: async () => ({ error: {} }) });
  assert.equal(typeof built.orders, 'function'); built.close?.();
  const server = readFileSync(new URL('../src/frontier/local-play-relay-server.mjs', import.meta.url), 'utf8');
  // the listener serves it ONLY inside the conquest block: no conquest object (closed), no such route (404)
  const from = server.indexOf('...(conquest ? {'), block = server.slice(from, server.indexOf('} : {}),', from));
  assert.ok(from > 0 && block.includes('[CONQUEST_ORDERS_ROUTE]: async body => conquest.orders(body),'), 'the route exists only when the conquest object does');
  assert.equal([...server.matchAll(/CONQUEST_ORDERS_ROUTE/g)].length, 2, 'the import and that one line');
  // the launcher's world proxy names exactly this one more path, beside the three conquest routes
  const launcher = readFileSync(new URL('../src/frontier/local-play-launcher.mjs', import.meta.url), 'utf8');
  assert.equal([...launcher.matchAll(/'\/gw\/f\/local-play\/conquest\/[a-z]+'/g)].map(m => m[0]).join(' '), "'/gw/f/local-play/conquest/prepare' '/gw/f/local-play/conquest/submit' '/gw/f/local-play/conquest/status' '/gw/f/local-play/conquest/orders'");
  assert.equal(CONQUEST_ORDERS_ROUTE, 'POST /f/local-play/conquest/orders');
  for (const f of ['local-play-conquest-orders.mjs', 'conquest-table-read.mjs']) {
    const src = readFileSync(new URL(`../src/frontier/${f}`, import.meta.url), 'utf8');
    for (const banned of ['sendTransaction', 'node:child_process', 'spawn(', 'writeFile', 'process.env', 'getAccountInfo', 'simulateTransaction']) assert.ok(!src.includes(banned), `${f}: ${banned}`);
  }
});
