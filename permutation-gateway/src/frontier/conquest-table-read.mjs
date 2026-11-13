// READ-ONLY verification of the three accounts a siege reservation is read from, each as its OWN family, mirroring
// the ABI's own readers (cited per function). Pure: bytes in, facts out; no RPC, no key, no send. Used by
// local-play-conquest-orders.mjs only. Anything that does not hold throws a code: the caller refuses the whole read.
//
//   wideProvinceIdentity   frontier-abi/src/world_index/land.rs `WideProvince::read` (720–798): the WIDE family —
//                          4,864 bytes, magic PSFXWPV1, layout version 3, a 128-byte trailer at 4,736
//   citizenIdentity        frontier-abi/src/v2/layout/player.rs: Citizen v2 — 384 bytes, magic PSF1CITZ, layout 2,
//                          WALLET @ 64, CITIZEN_TAG @ 208, SLOTS @ 187
//   conquestTable          frontier-abi/src/world_index/conquest.rs `WideConquest::read`, `WideConquestEntry::validate`,
//                          `Reservation::validate`, `validate_paired` (776–802): header, the twelve site entries in
//                          full, the reservation region, and the Province's conquest record of every site
//
// Identity decoders are the page's existing ones (fexpedition-seal.mjs `decodeWideProvinceKey` / `decodeWideHostRef`,
// faddr.mjs `hostId`), not offsets written again here. The region decoder is conquest-reservations.mjs (checked
// against the ABI codec's vectors). NOT compared with an account read from a chain yet.
import { decodeReservationRegion, CONQUEST_TABLE_SIZE, RESERVATION_REGION_OFFSET, RESERVATION_RECORD_SIZE } from './conquest-reservations.mjs';
import { decodeWideProvinceKey, decodeWideHostRef } from '../../../permutation-server/web/frontier/fexpedition-seal.mjs';
import { hostId } from '../../../permutation-server/web/frontier/faddr.mjs';
import { decodeWideHoldingBytes, citizenBindings } from '../../../permutation-server/web/frontier/fwide.mjs';
import { decodePrefix } from '../../../permutation-server/web/frontier/fcodec.mjs';
import { encode } from '../../../permutation-server/web/sdk/base58.mjs';

export const WIDE_PROVINCE_SIZE = 4864, WIDE_PROVINCE_TRAILER = 4736, WIDE_LAYOUT_VERSION = 3, WIDE_LAND_FAMILY_VERSION = 1;
export const WIDE_PROVINCE_STATUS_OPENED = 1, WIDE_PROVINCE_READINESS_REQUIRED = 1 | 2 | 4 | 8;
export const PROVINCE_CONQUEST_OFFSET = 4096, CONQUEST_RECORD_SIZE = 32;
export const CITIZEN_SIZE = 384, CITIZEN_LAYOUT_VERSION = 2, CITIZEN_WALLET_OFFSET = 64, CITIZEN_SLOTS_OFFSET = 187, CITIZEN_TAG_OFFSET = 208;
const HOST_ID_INVALID = 0xffff_ffff_ffff_ffffn;
// conquest record (frontier-abi v2/layout/province.rs `conquest`): kinds, flags, the Free City target
const KIND_NONE = 0, KIND_SIEGE = 1, KIND_CAPTURE_DUE = 3, FLAG_HELD = 1, FLAG_NEUTRAL = 8, FLAG_CREDITED = 16, FLAG_SLOT_OWED = 32, FLAG_PENDING = 64;
const BARRED_ALL = 0xfe, BARRED_NONE = 0xff, TARGET_FREE_CITY = 3;

const fail = code => { throw Object.assign(new Error(code), { code }); };
const check = (ok, code) => { if (!ok) fail(code); };
const hex = b => Buffer.from(b).toString('hex');
const zero = b => b.every(x => x === 0);
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const ascii = s => [...s].map(c => c.charCodeAt(0));
const view = b => new DataView(b.buffer, b.byteOffset, b.byteLength);
/** The chained header every account here starts with: magic 0, Season id 8 (u64), layout version 16 (u16). */
const header = (b, magic, seasonId, version, code) => check(same([...b.subarray(0, 8)], ascii(magic)) && view(b).getBigUint64(8, true) === BigInt(seasonId) && view(b).getUint16(16, true) === version, code);

/**
 * A wide Province's identity from its own bytes, as `WideProvince::read`: exact size; the WIDE magic, this Season,
 * layout version 3; trailer family version 1, status OPENED, readiness exactly REQUIRED, reserved bytes zero; the
 * legacy identity fields of the prefix (P, Q, RING) zero; a canonical sort key of ring ≥ 129 whose wedge is the
 * prefix's; a ring seed that is not zero; and the world and the full signed coordinate equal to `key` (the 50-byte
 * province key the request names, hex). → `{world, p, q}`.
 */
export function wideProvinceIdentity(bytes, { seasonId, key }) {
  check(bytes instanceof Uint8Array && bytes.length === WIDE_PROVINCE_SIZE, 'WideProvinceSize');
  const T = WIDE_PROVINCE_TRAILER, v = view(bytes);
  header(bytes, 'PSFXWPV1', seasonId, WIDE_LAYOUT_VERSION, 'WideProvinceHeader');
  check(v.getUint16(T, true) === WIDE_LAND_FAMILY_VERSION && bytes[T + 2] === WIDE_PROVINCE_STATUS_OPENED && bytes[T + 3] === WIDE_PROVINCE_READINESS_REQUIRED, 'WideProvinceTrailer');
  check(zero(bytes.subarray(T + 53, T + 56)) && zero(bytes.subarray(T + 104, T + 128)), 'WideProvinceTrailer');
  check(v.getInt16(64, true) === 0 && v.getInt16(66, true) === 0 && v.getUint16(68, true) === 0, 'WideProvinceLegacyIdentity');
  // (the existing strict key decoder: version tag, a real world, a canonical sort key within bounds)
  const want = (() => { try { return decodeWideProvinceKey(key); } catch { return fail('WideProvinceKey'); } })();
  const world = hex(bytes.subarray(T + 4, T + 36)), sort = bytes.subarray(T + 36, T + 53);
  let got; try { got = decodeWideProvinceKey('01' + world + hex(sort)); } catch { fail('WideProvinceCoord'); }
  check(BigInt(got.ring) >= 129n && bytes[70] === sort[8], 'WideProvinceCoord');
  check(!zero(bytes.subarray(T + 64, T + 96)), 'WideProvinceSeed');
  check(got.world === want.world, 'WideProvinceWorld');
  check(got.p === want.p && got.q === want.q, 'WideProvinceCoord');
  return Object.freeze({ world: got.world, p: got.p, q: got.q });
}

/**
 * This wallet's Citizen from its own bytes: exact size, the Citizen magic, this Season, layout version 2; the wallet
 * written in it is `wallet` (32 bytes); its tag is the first eight bytes of its own address `address` (32 bytes).
 * → `{slots}` (the slot byte).
 */
export function citizenIdentity(bytes, { seasonId, wallet, address }) {
  check(bytes instanceof Uint8Array && bytes.length === CITIZEN_SIZE, 'CitizenSize');
  header(bytes, 'PSF1CITZ', seasonId, CITIZEN_LAYOUT_VERSION, 'CitizenHeader');
  check(wallet instanceof Uint8Array && wallet.length === 32 && same(bytes.subarray(CITIZEN_WALLET_OFFSET, CITIZEN_WALLET_OFFSET + 32), wallet), 'CitizenWallet');
  check(address instanceof Uint8Array && address.length === 32 && same(bytes.subarray(CITIZEN_TAG_OFFSET, CITIZEN_TAG_OFFSET + 8), address.subarray(0, 8)), 'CitizenTag');
  return Object.freeze({ slots: bytes[CITIZEN_SLOTS_OFFSET] });
}

/** A full 56-byte host reference of `world`: the strict decoder; a real generation; within ring 128 a representable legacy host id. `holding`: seq must be 0. */
function hostRef(b, world, { holding }) {
  let h; try { h = decodeWideHostRef(hex(b)); } catch { fail('ConquestHostRef'); }
  check(h.world === world && h.gen !== 0 && h.gen !== 255 && (!holding || h.seq === 0), 'ConquestHostRef');
  if (BigInt(h.ring) < 129n) check(hostId({ p: Number(h.p), q: Number(h.q), site: h.site, gen: h.gen, seq: h.seq }) !== HOST_ID_INVALID, 'ConquestHostRef');
  return h;
}

/**
 * The conquest table of the province `key` (hex) from its bytes, with that province's own bytes (already identified
 * by `wideProvinceIdentity`), as the program reads them together:
 *   header    2,688 bytes, magic PSFXWCQ1, this Season, version 2 (see below), reserved zero, the 50-byte key of THIS province
 *   entries   each of the twelve site entries, if present, in full (`WideConquestEntry::validate`): slot 2 or 3, a
 *             Citizen whose tag it carries, a source Holding reference of this world when its kind needs one, the
 *             kind's own fields (siege / capture due / slot owed), reserved bytes zero; one (Citizen, slot) per entry
 *   records   the reservation region; each record's host reference and actor tag; no entry holds the (Citizen, slot)
 *             of a record that still holds its slot
 *   pairing   for EVERY site (`validate_paired`): with an entry, the Province's conquest record equals the entry's
 *             prefix byte for byte; without one, it is the canonical idle record whose only flag is PENDING, set
 *             exactly while a PENDING record names the site
 * → `{records}` (as `decodeReservationRegion`).
 *
 * The table's layout VERSION (u16 at 16) is exactly `CONQUEST_TABLE_VERSION` (2): the 2,688-byte table of the
 * conquest lane as the current program writes and reads it (it refuses a version-1 table; there is no migration).
 * Nothing else is read: not the 1,664-byte version-1 table of a program without the lane (refused by size), and not
 * a 2,688-byte table whose header says version 1.
 * `historicalV1: true` is for ONE purpose — checking the SAVED evidence of the earlier artefact
 * (`CONQUEST_ARTIFACT_HISTORICAL`), which wrote 2,688 bytes under version 1. It then accepts exactly version 1 and
 * refuses version 2. No route passes it (the relay cannot be started with it); it is not a compatibility mode.
 */
export const CONQUEST_TABLE_VERSION = 2, CONQUEST_TABLE_VERSION_HISTORICAL = 1;
/** The SBF artefacts (sha256) whose written bytes are kept as evidence: the current one (table version 2) and the earlier one (2,688 bytes, version 1; history only). */
export const CONQUEST_ARTIFACT_CURRENT = 'e6bfe8c206caeb840531a64e9df497a2e4fc2c1224521e474700d774f4d961de';
export const CONQUEST_ARTIFACT_HISTORICAL = '87b19e9ed1073f0e18fcab274d22e8015c896afdd5cbab98b223475f60456db3';
export function conquestTable(bytes, province, { seasonId, key, historicalV1 = false }) {
  check(historicalV1 === false || historicalV1 === true, 'ConquestTableVersion');
  check(bytes instanceof Uint8Array && bytes.length === CONQUEST_TABLE_SIZE, 'ConquestTableSize');
  check(same([...bytes.subarray(0, 8)], ascii('PSFXWCQ1')) && view(bytes).getBigUint64(8, true) === BigInt(seasonId) && zero(bytes.subarray(18, 32))
    && zero(bytes.subarray(82, 88)) && zero(bytes.subarray(124, 128)), 'ConquestTableHeader');
  check(view(bytes).getUint16(16, true) === (historicalV1 ? CONQUEST_TABLE_VERSION_HISTORICAL : CONQUEST_TABLE_VERSION), 'ConquestTableVersion');
  check(hex(bytes.subarray(32, 82)) === key, 'ConquestTableProvince');
  const world = hex(bytes.subarray(33, 65));
  check(province instanceof Uint8Array && province.length === WIDE_PROVINCE_SIZE, 'WideProvinceSize');
  const entryAt = i => bytes.subarray(128 + i * 128, 256 + i * 128), entries = [];
  for (let i = 0; i < 12; i++) {
    const e = entryAt(i);
    if (zero(e)) { entries.push(null); continue; }
    const v = view(e), [kind, faction, flags, progress, required, target] = e, slot = e[112], bell = v.getUint32(12, true), declared = v.getUint32(114, true);
    const citizen = e.subarray(16, 48), source = zero(e.subarray(48, 104)) ? null : hostRef(e.subarray(48, 104), world, { holding: true });
    check((slot === 2 || slot === 3) && !zero(citizen) && same(e.subarray(104, 112), citizen.subarray(0, 8)) && e[113] < 254 && zero(e.subarray(118, 128)), 'ConquestEntry');
    const vigils = zero(e.subarray(6, 12));
    if (kind === KIND_SIEGE || kind === KIND_CAPTURE_DUE) {
      check(source !== null && target === ((slot << 4) | TARGET_FREE_CITY) && faction < 6 && vigils, 'ConquestEntry');
      if (kind === KIND_SIEGE) check(bell === declared && flags === (FLAG_HELD | FLAG_NEUTRAL) && required !== 0 && progress < required, 'ConquestEntry');
      else check(flags === FLAG_CREDITED && progress === 0 && required === 0 && bell > declared, 'ConquestEntry');
    } else if (kind === KIND_NONE) {
      check(flags === FLAG_SLOT_OWED && required === slot && source === null && target === 0 && progress === 0 && vigils && faction === BARRED_NONE && bell === 0, 'ConquestEntry');
    } else fail('ConquestEntry');
    const who = encode(citizen);
    check(!entries.some(x => x !== null && x.citizen === who && x.slot === slot), 'ConquestEntrySlot');
    // (what a verified entry says, for the read: its kind in words, whose it is, its slot, and the kind's own numbers)
    entries.push(Object.freeze({ site: i, kind: kind === KIND_SIEGE ? 'siege' : kind === KIND_CAPTURE_DUE ? 'capture_due' : 'slot_owed', citizen: who, slot,
      progress, required, bell, declarationBell: declared }));
  }
  let records; try { records = decodeReservationRegion(bytes); } catch (e) { fail(typeof e?.code === 'string' ? e.code : 'ConquestTableRecords'); }
  for (const r of records) {
    const raw = bytes.subarray(RESERVATION_REGION_OFFSET + r.index * RESERVATION_RECORD_SIZE, RESERVATION_REGION_OFFSET + (r.index + 1) * RESERVATION_RECORD_SIZE);
    hostRef(raw.subarray(48, 104), world, { holding: false });
    check(same(raw.subarray(104, 112), raw.subarray(16, 24)), 'ConquestRecordActor');
    if (r.status === 'pending' || !r.slotRentReleased) check(!entries.some(x => x !== null && x.citizen === r.citizen && x.slot === r.slot), 'ConquestRecordSlot');
  }
  for (let site = 0; site < 12; site++) {
    const p = province.subarray(PROVINCE_CONQUEST_OFFSET + site * CONQUEST_RECORD_SIZE, PROVINCE_CONQUEST_OFFSET + (site + 1) * CONQUEST_RECORD_SIZE), e = entryAt(site);
    if (entries[site] !== null) {
      // (the entry's prefix: its sixteen rule bytes, its actor tag, a zero src)
      check(same(p.subarray(0, 16), e.subarray(0, 16)) && same(p.subarray(16, 24), e.subarray(104, 112)) && zero(p.subarray(24, 32)), 'ConquestPairing');
    } else {
      const pending = records.some(r => r.status === 'pending' && r.site === site);
      check(p[0] === KIND_NONE && (p[1] < 6 || p[1] === BARRED_ALL || p[1] === BARRED_NONE) && p[2] === (pending ? FLAG_PENDING : 0) && p[3] === 0 && p[4] === 0 && p[5] === 0
        && zero(p.subarray(6, 12)) && zero(p.subarray(16, 32)), 'ConquestPairing');
    }
  }
  return Object.freeze({ records, entries: Object.freeze(entries) });
}

/**
 * The wide Holding standing at the position of site `site` of the province `key` (hex), from its own bytes: the
 * page's existing strict decoder (`decodeWideHoldingBytes`, written as `WideHolding::read`: size, magic, layout 3,
 * family 1, status founded, reserved zero, no legacy identity, a canonical coordinate past the legacy disk, site < 12,
 * generation 1..254, inventory slot 2 or 3), and then that it is THIS place's: this Season, this world, this
 * coordinate and this site. The address was derived from the place; bytes that name another place are not its Holding.
 * → `{owner, slot, generation}` (the owner Citizen's address; the Citizen inventory slot it occupies).
 */
export function wideHoldingAt(bytes, { seasonId, key, site }) {
  let d; try { d = decodeWideHoldingBytes(bytes); } catch { fail('WideHoldingBytes'); }
  const h = d.identity;
  let want; try { want = decodeWideProvinceKey(key); } catch { fail('WideProvinceKey'); }
  check(h.season === String(seasonId), 'WideHoldingSeason');
  check(h.world === want.world, 'WideHoldingWorld');
  check(String(h.p) === want.p && String(h.q) === want.q && h.site === site, 'WideHoldingPlace');
  check(!zero(h.ownerCitizenBytes), 'WideHoldingOwner');
  // (the Holding's own state and faction, through the Holding layout table: 1 provisional, 2 final, 3 released)
  return Object.freeze({ owner: encode(h.ownerCitizenBytes), slot: h.inventorySlot, generation: h.generation, state: Number(d.economy.state), faction: Number(d.economy.faction) });
}
/** Holding states (frontier-abi layout/player.rs): a held Holding is PROVISIONAL or FINAL; RELEASED is not held. */
export const HOLDING_STATE_PROVISIONAL = 1, HOLDING_STATE_FINAL = 2, HOLDING_STATE_RELEASED = 3;
/** Province site mirror states used here (frontier-abi layout/province.rs, v2): a Holding stands there / a genesis Free City. */
export const SITE_STATE_HOLDING = 1, SITE_STATE_FREE_CITY = 5;

/**
 * The Citizen's inventory as its own bytes say it: the binding of each of the three slots (`empty` | `legacy` |
 * `wide` | `malformed`, by the page's own `citizenBindings`) and the Citizen's faction. → `{bindings, faction}`.
 */
export function citizenInventory(bytes) {
  let c; try { c = decodePrefix('Citizen', Buffer.from(bytes), { profile: 2 }); } catch { fail('CitizenSize'); }
  let bindings; try { bindings = citizenBindings(c); } catch { fail('CitizenBindings'); }
  return Object.freeze({ bindings, faction: Number(c.faction) });
}

/** The Province's mirror of one site, by the layout table (`SITE_MIRROR`): `{state, faction, order, generation}`. */
export function provinceSiteMirror(bytes, site) {
  let p; try { p = decodePrefix('Province', Buffer.from(bytes), { profile: 2 }); } catch { fail('WideProvinceSize'); }
  const m = p.siteMirror?.[site];
  check(Number.isInteger(site) && site >= 0 && site < 12 && site < Number(p.siteCount) && m !== undefined, 'WideProvinceSite');
  return Object.freeze({ state: Number(m.state), faction: Number(m.faction), order: Number(m.order), generation: Number(m.gen) });
}
