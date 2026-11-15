// Local play only: the Reveal of a departure this page sealed (flocalplay-depart.mjs keeps the seal's plaintext and
// salt in memory, by host, transit slot and commit). The player asks for it explicitly; nothing reveals by itself.
//
//   the kept seal ──▶ POST /gw/f/local-play/reveal/context   a fresh read at ONE confirmed slot of the accounts this
//                     page derives itself: the transit, the village, the destination Province, the clash inputs, the
//                     arrival day and the four arrival slots, with a recent blockhash
//     ──▶ checked here, every byte that matters: the transit is this host's, at this slot, with this seal's root and
//         this wallet's Citizen; the destination is opened, seeded and of this world; the bell's clash inputs are not
//         latched; the arrival slot the program will admit into is worked out from the four slots as they are
//     ──▶ the page's own ExpeditionReveal (fexpedition-reveal.mjs), signed by the memory-only wallet
//     ──▶ POST /gw/f/local-play/reveal/submit   ONCE
//     ──▶ POST /gw/f/local-play/reveal/status   as often as asked: the only reconciliation
//
// The same gate as the local-play departure (localDepartAllowed): local play with its verified identity, localnet,
// a loopback page and relay, the identity's own live memory-only wallet. No public cluster, no stored key.
//
// The admission slot is never assumed: with a free slot and nobody of this Citizen or host in the four, the program
// fills the first free one, and that is the slot named. A case that needs the program's ranking (this Citizen already
// in the four, or all four taken) is refused here, unsent: the ranking is not mirrored in this file.
//
// What "revealed" means here: the chain confirmed the Reveal transaction. The march is then IN the destination's
// arrival slot and waits for the destination to be gathered, resolved and settled, which this file neither does nor
// claims. The seal's record is kept (never dropped), marked `revealed` once the chain has confirmed it. An outcome
// that is not known is `unknown`: it is asked about by its first signature, never signed or sent again.
import { localDepartReveals, loopbackRelay } from './flocalplay-depart.mjs';
import { buildExpeditionReveal, revealAddresses, revealMessage } from './fexpedition-reveal.mjs';
import { unpackWidePlain, decodeWideProvinceKey } from './fexpedition-seal.mjs';
import { commitWide } from './seal-wide.mjs';
import { ringPosition, worldIdOf } from './map/wide.mjs';
import { withSeed, seedOf, hostId } from './faddr.mjs';
import { decode as decodeAccount, effectiveStatus, windowAt } from './fcodec.mjs';
import { revealClose, seedRound } from './clock.mjs';
import { originalHostRef } from './fexpedition.mjs';
import { LOCAL_PLAY_PROGRAM_VERSION } from './flocalplay.mjs';
import { parseTransaction, wireTransaction } from '../sdk/solana-tx.mjs';
import { decode, encode } from '../sdk/base58.mjs';
import { fromBase64, toBase64, toHex } from '../sdk/bytes.mjs';
import { sha256 } from '../sdk/sha256.mjs';

export const LOCAL_REVEAL_CONTEXT_SCHEMA = 'frontier-local-play-reveal-context-v1';
export const LOCAL_REVEAL_SUBMIT_SCHEMA = 'frontier-local-play-reveal-submit-v1';
export const LOCAL_REVEAL_STATUS_SCHEMA = 'frontier-local-play-reveal-status-v1';
export const LOCAL_REVEAL_CONTEXT_PATH = '/gw/f/local-play/reveal/context';
export const LOCAL_REVEAL_SUBMIT_PATH = '/gw/f/local-play/reveal/submit';
export const LOCAL_REVEAL_STATUS_PATH = '/gw/f/local-play/reveal/status';
const PATHS = [LOCAL_REVEAL_CONTEXT_PATH, LOCAL_REVEAL_SUBMIT_PATH, LOCAL_REVEAL_STATUS_PATH];
export const LOCAL_REVEAL_MAX_BYTES = 64 * 1024;
export const LOCAL_REVEAL_TIMEOUT_MS = 30_000;
// Isolated real-SBF local play matches itest/local_keeper.rs::budget, not legacy Season caps.
export const LOCAL_REVEAL_BUDGET = Object.freeze({ cuLimit: 1_400_000, loadedLimit: 64 * 1024 * 1024 });
const LOCAL_REVEAL_HEAP = 256 * 1024;
// The records read (frontier-abi world_index: expedition_transport, expedition_bridge, march::wide_transit,
// arrival::wide_arrival_slot; v2 province). Only the fields named here are read; the program authenticates the rest.
const BRIDGE = Object.freeze({ LEN: 336, MAGIC: 'PSWLEXP1', VERSION: 2, SLOT: 9, T: 16, OWNER: 304 });
const TRANSIT = Object.freeze({ STATE: 1, FACTION: 3, HOST: 8, ORIGIN_KEY: 64, ORIGIN_TILE: 114, ARRIVE_BELL: 172, DEP_MASS: 184, SEAL_ROOT: 200 });
/** march::MarchState: the states a transit can be revealed in, and the others by name. */
const STATE = Object.freeze({ 0: 'RevealTransitFree', 1: null, 2: null, 3: 'RevealHostDestroyedAtOrigin', 4: 'RevealAlreadyGathered' });
const SLOT = Object.freeze({ LEN: 288, MAGIC: 'PSFXWASL', SEASON: 8, FAMILY: 16, FACTION: 19, I: 20, STANCE: 22, TILE: 23, RETREAT_BPS: 24, TRANSIT_SLOT: 28, BELL: 32, WORLD: 40, SORT_KEY: 72, HOST: 96, CITIZEN: 152, DEP_MASS: 184 });
const PROVINCE = Object.freeze({ LEN: 4864, MAGIC: 'PSFXWPV1', TAIL: 4736, REGION: 71, RESOLVED_NEXT: 72 });
const CLOCK_SYSVAR = 'SysvarC1ock11111111111111111111111111111111';
const SYSVAR_OWNER = 'Sysvar1111111111111111111111111111111111111';
const ARCHIVE_ENTRIES = 72;

const fail = code => { throw Object.assign(new Error(code), { code }); };
const check = (ok, code) => { if (!ok) fail(code); };
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const exact = (x, keys) => object(x) && Object.keys(x).length === keys.length && keys.every(k => Object.hasOwn(x, k));
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const address = v => { try { const b = decode(v); return typeof v === 'string' && v.length <= 44 && b.length === 32 && encode(b) === v; } catch { return false; } };
const uintText = v => typeof v === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(v);
const codeOf = (e, fallback) => (typeof e?.code === 'string' && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(e.code) ? e.code : fallback);
const latin = b => String.fromCharCode(...b);

/** The held seal this page could reveal: the newest one whose departure was signed for sending and that the chain has not confirmed revealed. Null when there is none. */
export function localRevealCandidate(fs) {
  const list = localDepartReveals(fs).filter(r => r.signature && !r.revealed);
  return list.length ? list.at(-1) : null;
}
/** Why a held seal cannot be revealed at all (before anything is read), or null. */
export function localRevealRecordProblem(record) {
  if (!record || !record.signature) return 'RevealSealMissing';
  if (!(record.plain instanceof Uint8Array) || record.plain.length !== 136 || !(record.salt instanceof Uint8Array) || record.salt.length !== 32) return 'RevealSealMissing';
  if (!(record.ctHash instanceof Uint8Array) || record.ctHash.length !== 32 || !(record.sealRoot instanceof Uint8Array) || record.sealRoot.length !== 32) return 'RevealSealIncomplete';
  if (!address(record.holding) || !Number.isInteger(record.transitSlot) || record.transitSlot < 0 || record.transitSlot > 3) return 'RevealSealIncomplete';
  if (!same([...sha256(commitWide(record.plain, record.salt), record.ctHash)], [...record.sealRoot]) || toHex(commitWide(record.plain, record.salt)) !== record.commit) return 'RevealSealMismatch';
  return null;
}

/**
 * The identity a reveal is made under, taken ONCE at the check and compared at every later step (never re-read from
 * the page for building): the program, the Season, its id, the cluster, the wallet, the live memory-only signer
 * itself (the session), and the deployment the page verified when it connected: local play's own program version
 * (flocalplay.mjs) and that Season's ruleset hash. The Season READ for a reveal must be of that same deployment.
 * A page whose identity is another one afterwards is another check, whatever its gate says.
 */
export function localRevealPin(fs, signer) {
  const i = fs?.localPlay;
  check(object(i) && address(i.programId) && address(i.seasonAddress) && address(i.address) && uintText(String(i.seasonId)) && i.cluster === 'localnet', 'LocalRevealIdentity');
  check(!!signer && signer.destroyed === false && signer.address === i.address, 'LocalRevealSigner');
  const ruleset = rulesetOf(fs);
  check(fs.season?.programVersion === LOCAL_PLAY_PROGRAM_VERSION && ruleset !== null, 'LocalRevealDeployment');
  return Object.freeze({ programId: i.programId, seasonAddress: i.seasonAddress, seasonId: String(i.seasonId), cluster: i.cluster, address: i.address, signer, programVersion: LOCAL_PLAY_PROGRAM_VERSION, ruleset });
}
const rulesetOf = fs => { const r = fs?.season?.rulesetHash, h = r instanceof Uint8Array && r.length === 32 ? toHex(r) : r; return typeof h === 'string' && /^[0-9a-f]{64}$/.test(h) && h !== '0'.repeat(64) ? h : null; };
const pinHolds = (pin, fs, signer) => {
  const i = fs?.localPlay;
  return object(i) && i.programId === pin.programId && i.seasonAddress === pin.seasonAddress && String(i.seasonId) === pin.seasonId && i.cluster === pin.cluster
    && i.address === pin.address && signer === pin.signer && signer.destroyed === false && signer.address === pin.address
    && fs.season?.programVersion === pin.programVersion && rulesetOf(fs) === pin.ruleset;
};

/** The accounts every reveal of `record` reads first (derived here from the kept seal and the pinned identity; no region or nation is needed for these). */
export function localRevealAccounts(record, pin) {
  const typed = unpackWidePlain(record.plain);
  const a = revealAddresses({ program: pin.programId, season: pin.seasonAddress, holding: record.holding, transitSlot: record.transitSlot,
    faction: 0, arriveBell: record.arriveBell, destKey: typed.dest, destRegion: 0 });
  return { typed, fixed: [a.transit, record.holding, a.destProvince, a.inputs, a.arrivalDay, pin.seasonAddress, CLOCK_SYSVAR] };
}
/** The accounts that depend on what the first ones say (the transit's nation, the destination's region): the four arrival slots, THE anchor, its archive, the region's beacon log. */
export function localRevealDependent(record, pin, typed, faction, destRegion) {
  const a = revealAddresses({ program: pin.programId, season: pin.seasonAddress, holding: record.holding, transitSlot: record.transitSlot,
    faction, arriveBell: record.arriveBell, destKey: typed.dest, destRegion });
  return { slots: a.slots, anchor: a.anchor, archive: a.archive, beaconLog: a.beaconLog };
}

/** The relay's `context` answer for `addresses`: `{contextSlot, blockhash, accounts: Map address → {owner, data} | null}`, or throws. */
export function localRevealContext(value, addresses) {
  check(exact(value, ['context_slot', 'blockhash', 'accounts']) && uintText(value.context_slot), 'BadLocalRevealContext');
  const b = value.blockhash;
  check(exact(b, ['hash', 'last_valid_block_height', 'context_slot']) && address(b.hash) && uintText(b.last_valid_block_height) && uintText(b.context_slot)
    && BigInt(b.context_slot) >= BigInt(value.context_slot), 'BadLocalRevealContext');
  check(Array.isArray(value.accounts) && value.accounts.length === addresses.length, 'BadLocalRevealContext');
  const accounts = new Map();
  value.accounts.forEach((row, i) => {
    check(exact(row, ['address', 'owner', 'data_b64']) && row.address === addresses[i], 'BadLocalRevealContext');
    if (row.owner === null) { check(row.data_b64 === null, 'BadLocalRevealContext'); accounts.set(row.address, null); return; }
    check(address(row.owner) && typeof row.data_b64 === 'string', 'BadLocalRevealContext');
    let data; try { data = fromBase64(row.data_b64); } catch { fail('BadLocalRevealContext'); }
    check(toBase64(data) === row.data_b64, 'BadLocalRevealContext');
    accounts.set(row.address, { owner: row.owner, data });
  });
  return { contextSlot: value.context_slot, blockhash: b.hash, lastValidBlockHeight: b.last_valid_block_height, accounts };
}

const sortKey = (p, q) => { const r = ringPosition(BigInt(p), BigInt(q)), b = new Uint8Array(17), v = new DataView(b.buffer); v.setBigUint64(0, r.ring, false); b[8] = r.wedge; v.setBigUint64(9, r.pos, false); return b; };
const zero = (b, at, len) => b.subarray(at, at + len).every(x => x === 0);
const decoded = (kind, data, seasonId, code) => { try { return decodeAccount(kind, data, { seasonId, profile: 2 }); } catch { fail(code); } };
/** An account of `ctx` that this reveal reads: absent in the answer (not asked) is a changed fact, never "not there". */
const read = (ctx, at) => { const x = ctx.accounts.get(at); check(x !== undefined, 'RevealFactsChanged'); return x; };

/**
 * One arrival slot's record: the fields the reveal's admission depends on, validated one by one (after
 * expedition_transport ArrivalSlot::read and the handler's identity checks). A selected-field validation, not the
 * program's whole parser: what it does not check, the program still refuses. Throws RevealSlotMismatch.
 */
function slotRecord(s, { program, seasonId, dest, arriveBell, faction, i }) {
  check(s.owner === program, 'RevealSlotMismatch');
  const b = s.data, v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  check(b.length === SLOT.LEN && latin(b.subarray(0, 8)) === SLOT.MAGIC && v.getBigUint64(SLOT.SEASON, true).toString() === seasonId, 'RevealSlotMismatch');
  const family = v.getUint16(SLOT.FAMILY, true);
  check(family === 1 || family === 2, 'RevealSlotMismatch');
  check(zero(b, 29, 3) && zero(b, 36, 4) && zero(b, 89, 7) && zero(b, 281, 7) && (family === 2 ? zero(b, 190, 2) : zero(b, 188, 4)), 'RevealSlotMismatch');
  check(toHex(b.subarray(SLOT.WORLD, SLOT.WORLD + 32)) === dest.world && same([...b.subarray(SLOT.SORT_KEY, SLOT.SORT_KEY + 17)], [...sortKey(dest.p, dest.q)])
    && v.getUint32(SLOT.BELL, true) === arriveBell && b[SLOT.FACTION] === faction && b[SLOT.I] === i, 'RevealSlotMismatch');
  const citizen = b.subarray(SLOT.CITIZEN, SLOT.CITIZEN + 32);
  check(citizen.some(x => x !== 0), 'RevealSlotMismatch');
  return { family, host: toHex(b.subarray(SLOT.HOST, SLOT.HOST + 56)), citizen: encode(citizen), transitSlot: b[SLOT.TRANSIT_SLOT], depMass: v.getUint32(SLOT.DEP_MASS, true),
    tile: b[SLOT.TILE], stance: b[SLOT.STANCE], retreatBps: v.getUint16(SLOT.RETREAT_BPS, true) };
}

/**
 * The facts of a reveal, from the kept seal, the pinned identity and ONE fresh context: every check that can be made
 * here before a signature, as the program's own handler makes them (wide_expedition_reveal.rs `stage`), at the
 * chain's own time (the Clock sysvar of the same read). → `{transit, destRegion, targetI, facts}` (what
 * buildExpeditionReveal takes, and a short text of the facts a later read is compared with), or throws a code:
 *   RevealSeason… / RevealClockMissing        the Season is not this one (address, id, the verified program version
 *                                             and ruleset), not running, or over for this arrival
 *   RevealTransit… / RevealSealRootMismatch   the departure is not on the chain as this seal's, or is past revealing
 *   RevealHolding…                            the village is not the canonical one of this host (address, issuance,
 *                                             owner, its own marker of this departure)
 *   RevealDestination…                        the destination Province
 *   RevealWindowClosed / RevealArchived       THE anchor's reveal window is over (time or beacon round), or the bell
 *                                             is archived. No anchor yet is NOT a refusal: a reveal may precede it
 *   RevealLatchClosed                         the bell's clash inputs exist, or the destination is resolved past it
 *   RevealAlreadyIn                           an arrival slot holds exactly this departure (this host, Citizen,
 *                                             transit slot, mass and committed orders): the reveal is on the chain
 *   RevealAdmissionMismatch                   a slot names this host but not this departure: nothing is concluded
 *   RevealAdmissionContested                  the slot depends on the program's ranking (not mirrored): nothing sent
 * Not mirrored (the chain refuses them itself, and that failure is shown as a failure): the route's own inspection
 * and the shield of a held destination tile.
 */
export function localRevealFacts(record, pin, ctx) {
  const { typed, fixed } = localRevealAccounts(record, pin);
  const [transitAt, holdingAt, destAt, inputsAt, , seasonAt, clockAt] = fixed;
  const program = pin.programId, world = worldIdOf(pin.seasonAddress, program);
  // the chain's time and the Season, of this same read
  const clk = read(ctx, clockAt);
  check(!!clk && clk.owner === SYSVAR_OWNER && clk.data.length === 40, 'RevealClockMissing');
  const nowBig = new DataView(clk.data.buffer, clk.data.byteOffset, 40).getBigInt64(32, true);
  check(nowBig > 0n && nowBig < 2n ** 52n, 'RevealClockMissing');
  const now = Number(nowBig);
  const sa = read(ctx, seasonAt); check(!!sa && sa.owner === program, 'RevealSeasonMismatch');
  const season = decoded('Season', sa.data, pin.seasonId, 'RevealSeasonMismatch');
  check(sa.data.length === 2048 && season.layoutVersion === 2, 'RevealSeasonMismatch');
  // (the deployment the page verified: local play's program version and this Season's ruleset, not merely a v2 Season at the address)
  check(season.programVersion === pin.programVersion, 'RevealSeasonVersion');
  check(toHex(season.rulesetHash) === pin.ruleset, 'RevealSeasonRuleset');
  const status = effectiveStatus(season, now);
  check(status === 'Running' || status === 'Ended', 'RevealSeasonNotRunning');
  // the transit: this page's departure, as the program wrote it
  const t = read(ctx, transitAt);
  check(!!t, 'RevealTransitMissing'); check(t.owner === program, 'RevealTransitForeign');
  const b = t.data, v = new DataView(b.buffer, b.byteOffset, b.byteLength), T = BRIDGE.T;
  check(b.length === BRIDGE.LEN && latin(b.subarray(0, 8)) === BRIDGE.MAGIC && b[8] === BRIDGE.VERSION && b[BRIDGE.SLOT] === record.transitSlot
    && zero(b, 10, 6), 'RevealTransitMismatch');
  const state = b[T + TRANSIT.STATE];
  check(Object.hasOwn(STATE, state), 'RevealTransitMismatch'); if (STATE[state]) fail(STATE[state]);
  const hostBytes = b.subarray(T + TRANSIT.HOST, T + TRANSIT.HOST + 56), host = toHex(hostBytes), arriveBell = v.getUint32(T + TRANSIT.ARRIVE_BELL, true);
  const sealRoot = b.subarray(T + TRANSIT.SEAL_ROOT, T + TRANSIT.SEAL_ROOT + 32), depMass = v.getUint32(T + TRANSIT.DEP_MASS, true);
  check(host === record.host && arriveBell === record.arriveBell && typed.host === record.host && typed.arriveBell === record.arriveBell, 'RevealTransitMismatch');
  check(same([...sealRoot], [...record.sealRoot]), 'RevealSealRootMismatch');
  // (the Citizen the departure kept is this wallet's own)
  const citizen = withSeed(pin.seasonAddress, seedOf('Citizen', { wallet: pin.address }), program);
  check(encode(b.subarray(BRIDGE.OWNER, BRIDGE.OWNER + 32)) === citizen, 'RevealTransitOwner');
  const faction = b[T + TRANSIT.FACTION]; check(faction <= 5, 'RevealTransitMismatch');
  const originKey = decodeWideProvinceKey(toHex(b.subarray(T + TRANSIT.ORIGIN_KEY, T + TRANSIT.ORIGIN_KEY + 50)));
  const origin = { p: String(originKey.p), q: String(originKey.q), tile: b[T + TRANSIT.ORIGIN_TILE] };
  if (status === 'Ended') check(arriveBell < season.endBell, 'RevealSeasonEnded');
  // the village: the canonical Holding of this host (address, issuance), its owner, and its own marker of this departure
  const h = read(ctx, holdingAt); check(!!h && h.owner === program, 'RevealHoldingMissing');
  const hold = decoded('Holding', h.data, pin.seasonId, 'RevealHoldingMismatch');
  check(hold.layoutVersion === 2 && withSeed(pin.seasonAddress, seedOf('Holding', { p: hold.p, q: hold.q, site: hold.site }), program) === holdingAt, 'RevealHoldingMismatch');
  const hv = new DataView(hostBytes.buffer, hostBytes.byteOffset, 56), hostGen = hostBytes[51], hostSeq = hv.getUint32(52, true);
  const legacyId = hostId({ p: hold.p, q: hold.q, site: hold.site, gen: hostGen, seq: hostSeq });
  let canonical = null; try { canonical = originalHostRef(world, legacyId.toString()); } catch { canonical = null; }
  check(canonical === host, 'RevealHoldingHost');
  check(Number.isInteger(hold.hostSeq) && hostSeq < hold.hostSeq, 'RevealHoldingIssuance');
  // (as the handler: of the generation that departed, the village's owner is the departure's; a later generation was captured, the departure keeps its owner)
  if (hold.gen === hostGen) check(encode(hold.ownerCitizen) === citizen, 'RevealHoldingOwner');
  const m = hold.transit[record.transitSlot];
  check(!!m && m.state === 4 && m.hostId === legacyId && m.arriveBell === arriveBell && m.depMass === depMass && m.faction === faction
    && same([...m.sealRoot], [...sealRoot]) && m.originTile === origin.tile && String(m.originP) === origin.p && String(m.originQ) === origin.q, 'RevealHoldingMarker');
  // the destination Province: opened, of this world and coordinate, ready and seeded; its region; not resolved past this bell
  const d = read(ctx, destAt); check(!!d, 'RevealDestinationNotOpen'); check(d.owner === program, 'RevealDestinationMismatch');
  const pb = d.data, pv = new DataView(pb.buffer, pb.byteOffset, pb.byteLength), tail = PROVINCE.TAIL, dest = decodeWideProvinceKey(typed.dest);
  check(pb.length === PROVINCE.LEN && latin(pb.subarray(0, 8)) === PROVINCE.MAGIC && pv.getBigUint64(8, true).toString() === pin.seasonId
    && pv.getUint16(16, true) === 3 && pv.getUint16(tail, true) === 1 && pb[tail + 2] === 1, 'RevealDestinationMismatch');
  check(dest.world === world && toHex(pb.subarray(tail + 4, tail + 36)) === dest.world && same([...pb.subarray(tail + 36, tail + 53)], [...sortKey(dest.p, dest.q)]), 'RevealDestinationMismatch');
  check(pb[tail + 3] === 15 && pb.subarray(tail + 64, tail + 96).some(x => x !== 0), 'RevealDestinationNotReady');
  const destRegion = pb[PROVINCE.REGION]; check(destRegion <= 15, 'RevealDestinationMismatch');
  const dep = localRevealDependent(record, pin, typed, faction, destRegion);
  // THE anchor of this bell and region: once it has landed the window is A + W(b), and it is over at the seed round too
  const an = read(ctx, dep.anchor), ar = read(ctx, dep.archive), lg = read(ctx, dep.beaconLog);
  let window = 'before-anchor';
  if (an !== null) {
    check(an.owner === program, 'RevealAnchorMismatch');
    const anchor = decoded('BellAnchor', an.data, pin.seasonId, 'RevealAnchorMismatch');
    check(anchor.bell === arriveBell && anchor.region === destRegion, 'RevealAnchorMismatch');
    const a = Number(anchor.a), close = revealClose(a, Number(windowAt(season, arriveBell)));
    check(Number.isSafeInteger(a) && now < close, 'RevealWindowClosed');
    check(!!lg && lg.owner === program, 'RevealBeaconLogMissing');
    const log = decoded('BeaconLog', lg.data, pin.seasonId, 'RevealBeaconLogMissing');
    check(log.region === destRegion, 'RevealBeaconLogMissing');
    const s = seedRound({ genesis: Number(season.drandGenesis), period: Number(season.drandPeriod) }, close, Number(season.seedMargin));
    check(log.latestRound < BigInt(s), 'RevealWindowClosed');
    window = `anchor:${a}`;
  } else if (ar !== null) {
    check(ar.owner === program, 'RevealArchiveMismatch');
    const archive = decoded('AnchorArchive', ar.data, pin.seasonId, 'RevealArchiveMismatch');
    check(archive.region === destRegion && archive.part === Math.floor(arriveBell / ARCHIVE_ENTRIES), 'RevealArchiveMismatch');
    const i = arriveBell % ARCHIVE_ENTRIES;
    check((archive.tombstone[i >> 3] & (1 << (i & 7))) === 0, 'RevealArchived');
  }
  // the bell's clash inputs: once they exist the arrival is latched and nothing more is admitted; so too once resolved past it
  check(read(ctx, inputsAt) === null, 'RevealLatchClosed');
  check(pv.getUint32(PROVINCE.RESOLVED_NEXT, true) <= arriveBell, 'RevealLatchClosed');
  // the four arrival slots of this destination, bell and nation, as they are: where the program will admit this host
  const slots = dep.slots.map((at, i) => { const s = read(ctx, at); return s === null ? null : slotRecord(s, { program, seasonId: pin.seasonId, dest, arriveBell, faction, i }); });
  const mine = slots.find(s => s && s.host === host);
  if (mine) {
    // (only the exact departure this page holds is "revealed": this Citizen, this transit slot, this mass, these committed orders)
    const exactly = mine.family === 2 && mine.citizen === citizen && mine.transitSlot === record.transitSlot && mine.depMass === depMass
      && mine.tile === typed.destTile && mine.stance === typed.stance && mine.retreatBps === typed.retreatBps;
    fail(exactly ? 'RevealAlreadyIn' : 'RevealAdmissionMismatch');
  }
  // (wide_admit: one arrival a Citizen — a second is a ranking; no free slot — a displacement is a ranking)
  check(!slots.some(s => s && s.citizen === citizen), 'RevealAdmissionContested');
  const targetI = slots.findIndex(s => s === null);
  check(targetI >= 0, 'RevealAdmissionContested');
  const transit = { slot: record.transitSlot, faction, host, arriveBell, sealRoot: Uint8Array.from(sealRoot), origin };
  const facts = JSON.stringify({ host, slot: record.transitSlot, arriveBell, sealRoot: toHex(sealRoot), faction, destRegion, targetI, state, window, taken: slots.map(s => (s ? s.host : null)) });
  return { transit, destRegion, targetI, facts };
}

/** One bounded POST of JSON to one of the three loopback reveal routes; never a retry, never credentials. A refusal throws its code with `refused`. */
export async function postLocalReveal(origin, path, body, { fetch: fetcher = (...a) => globalThis.fetch(...a), timeoutMs = LOCAL_REVEAL_TIMEOUT_MS } = {}) {
  check(loopbackRelay(origin, null) === origin && PATHS.includes(path), 'LocalRevealRelay');
  const text = JSON.stringify(body);
  check(text.length <= LOCAL_REVEAL_MAX_BYTES, 'LocalRevealRequestTooLarge');
  const timer = new AbortController(), t = setTimeout(() => timer.abort(), timeoutMs);
  try {
    const res = await fetcher(`${origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: text, signal: timer.signal, credentials: 'omit', redirect: 'error', cache: 'no-store' });
    const raw = await res.text();
    check(raw.length <= LOCAL_REVEAL_MAX_BYTES, 'LocalRevealAnswerTooLarge');
    let value; try { value = JSON.parse(raw); } catch { fail('LocalRevealAnswerMalformed'); }
    if (!res.ok) throw Object.assign(new Error('the local-play relay refused'), { code: codeOf(object(value) ? value : null, 'LocalRevealRelayRefused'), refused: true });
    return value;
  } finally { clearTimeout(t); }
}

// ------------------------------------------------------------------ the run
const runs = new WeakMap();
const idle = () => Object.freeze({ status: 'idle', busy: false, host: null, transitSlot: null, commit: null, arriveBell: null, targetI: null, signature: null, code: null, error: null, sent: false, chain: null, slot: null });
const runOf = fs => { let r = runs.get(fs); if (!r) { r = { state: idle(), busy: false, sent: null, checked: null }; runs.set(fs, r); } return r; };
const OPEN = ['unknown', 'submitted'];
/** The reveal's state for the page: `{status, busy, host, transitSlot, commit, arriveBell, targetI, signature, code, error, sent, chain, slot}`. */
export const localRevealOf = fs => runOf(fs).state;
/** Forget a settled reveal's lines. One in flight, or whose outcome is not settled, is not forgotten; the seal's record is never touched. */
export function clearLocalReveal(fs) {
  const r = runOf(fs);
  if (r.busy || OPEN.includes(r.state.status)) return false;
  r.state = idle(); r.sent = null; r.checked = null;
  return true;
}

/** Read the reveal's accounts fresh, under the pinned identity, and judge them. → `{ctx, transit, destRegion, targetI, facts}` or throws a code. */
async function readFresh(record, pin, origin, post) {
  const problem = localRevealRecordProblem(record); if (problem) fail(problem);
  const { fixed, typed } = localRevealAccounts(record, pin);
  // (the slots, the anchor, its archive and the beacon log are of the transit's nation and the destination's region:
  // read once those say which. Two reads at most; the second is the one EVERY check is made on, so every fact is of
  // one slot of the chain, and an answer that lacks an account the second read's own facts name is a changed fact)
  const first = localRevealContext(await post(origin, LOCAL_REVEAL_CONTEXT_PATH, { schema: LOCAL_REVEAL_CONTEXT_SCHEMA, addresses: fixed }), fixed);
  const t = first.accounts.get(fixed[0]), d = first.accounts.get(fixed[2]);
  check(!!t, 'RevealTransitMissing'); check(t.owner === pin.programId, 'RevealTransitForeign'); check(t.data.length === BRIDGE.LEN, 'RevealTransitMismatch');
  check(!!d, 'RevealDestinationNotOpen'); check(d.owner === pin.programId && d.data.length === PROVINCE.LEN, 'RevealDestinationMismatch');
  const faction = t.data[BRIDGE.T + TRANSIT.FACTION], region = d.data[PROVINCE.REGION];
  check(faction <= 5, 'RevealTransitMismatch'); check(region <= 15, 'RevealDestinationMismatch');
  const dep = localRevealDependent(record, pin, typed, faction, region);
  const all = [...fixed, ...dep.slots, dep.anchor, dep.archive, dep.beaconLog];
  const ctx = localRevealContext(await post(origin, LOCAL_REVEAL_CONTEXT_PATH, { schema: LOCAL_REVEAL_CONTEXT_SCHEMA, addresses: all }), all);
  return { ctx, ...localRevealFacts(record, pin, ctx) };
}

/**
 * Step 1, the player's "check": read the reveal's accounts now and say whether it can be made. Nothing is built,
 * signed or sent. → the state: `ready` (with the admission slot the chain's four slots give), or `blocked` with the
 * code of what stands in the way, or `revealed` when an arrival slot holds EXACTLY this departure (then, and only
 * then, the seal's record is marked revealed, the chain having it), or `error`. The identity is pinned here (program,
 * Season, wallet, the live signer) and every later step is held to it. `deps`: `allowed()`, `signer()`, `post`, `changed()`.
 */
export async function checkLocalReveal(fs, { allowed, signer, post = postLocalReveal, changed = () => {} } = {}) {
  const r = runOf(fs);
  if (r.busy || OPEN.includes(r.state.status)) return r.state;
  const record = localRevealCandidate(fs);
  r.busy = true; r.checked = null;
  const base = record ? { host: record.host, transitSlot: record.transitSlot, commit: record.commit, arriveBell: record.arriveBell } : {};
  const put = (status, more = {}) => { r.state = Object.freeze({ ...idle(), ...base, ...more, status, busy: r.busy }); try { changed(); } catch { /* the page's repaint is not this run's */ } return r.state; };
  const end = (status, more) => { r.busy = false; return put(status, more); };
  let pin = null;
  // (the gate AND the pinned identity, asked together: a true gate over another identity is not this reveal's)
  const held = origin => { const a = allowed(); if (!a?.ok) fail(a?.code ?? 'LocalRevealNotAllowed'); check(origin === null || a.relay === origin, 'LocalRevealRelay'); check(pin === null || pinHolds(pin, fs, signer()), 'LocalRevealIdentityChanged'); return a.relay; };
  try {
    const origin = held(null);
    check(!!record, 'RevealSealMissing');
    pin = localRevealPin(fs, signer());
    put('checking');
    let fresh;
    try { fresh = await readFresh(record, pin, origin, post); }
    catch (e) {
      // (an exact arrival of this departure is only believed under the same identity and seal as it was read)
      if (e?.code === 'RevealAlreadyIn') { held(origin); check(localRevealCandidate(fs) === record, 'RevealSealChanged'); record.revealed = record.revealed ?? { signature: null, by: 'chain' }; return end('revealed', { code: 'RevealAlreadyIn' }); }
      throw e;
    }
    // (the check was awaited: the page, its identity and the seal are asked again before anything is said to be ready)
    held(origin);
    check(localRevealCandidate(fs) === record, 'RevealSealChanged');
    r.checked = { record, facts: fresh.facts, origin, pin };
    return end('ready', { targetI: fresh.targetI });
  } catch (e) {
    const code = codeOf(e, 'LocalRevealFailed');
    return end(code.startsWith('Reveal') ? 'blocked' : 'error', code.startsWith('Reveal') ? { code } : { error: code });
  }
}

/**
 * Step 2, the player's explicit "reveal": only after a `ready` check of the same seal. The accounts are read AGAIN,
 * and must say what the check said (the same transit, region, window and admission slot); then the page's own reveal
 * is built from the identity PINNED at the check, signed by that same memory-only wallet and submitted once. The
 * gate, the pinned identity (program, Season, wallet, signer), the seal and the relay are asked again after every
 * wait: after the read, after connect, after the signature, and in the same turn as the POST. `deps`: `allowed()`,
 * `signer()`, `budget()` → `{cuLimit, loadedLimit}` (the isolated local SBF budgets), `post`, `changed()`.
 */
export async function runLocalReveal(fs, { allowed, signer, budget, post = postLocalReveal, changed = () => {} } = {}) {
  const r = runOf(fs);
  if (r.busy || OPEN.includes(r.state.status)) return r.state;
  const checked = r.checked;
  if (r.state.status !== 'ready' || !checked) return r.state;
  r.busy = true; r.sent = null;
  const { record, pin } = checked;
  let base = { host: record.host, transitSlot: record.transitSlot, commit: record.commit, arriveBell: record.arriveBell, targetI: r.state.targetI };
  const put = (status, more = {}) => { base = { ...base, ...more }; r.state = Object.freeze({ ...idle(), ...base, status, busy: r.busy }); try { changed(); } catch { /* not this run's */ } return r.state; };
  const end = (status, more) => { r.busy = false; r.checked = null; return put(status, more); };
  const gate = () => {
    const a = allowed(); if (!a?.ok) fail(a?.code ?? 'LocalRevealNotAllowed');
    check(a.relay === checked.origin, 'LocalRevealRelay');
    check(pinHolds(pin, fs, signer()), 'LocalRevealIdentityChanged');
    check(localRevealCandidate(fs) === record && !record.revealed, 'RevealSealChanged');
    return a.relay;
  };
  try {
    const origin = gate();
    put('reading');
    const fresh = await readFresh(record, pin, origin, post);
    gate();
    // what was checked is what is revealed: another admission slot, region, window or transit state is another check
    check(fresh.facts === checked.facts, 'RevealFactsChanged');
    const wallet = pin.address, w = pin.signer, b = budget();
    const instruction = buildExpeditionReveal({ program: pin.programId, season: pin.seasonAddress, wallet, holding: record.holding, transit: fresh.transit,
      destRegion: fresh.destRegion, targetI: fresh.targetI, reveal: { plain: record.plain, salt: record.salt }, ctHash: record.ctHash });
    const message = revealMessage({ instruction, wallet, recentBlockhash: fresh.ctx.blockhash, cuLimit: b?.cuLimit, loadedLimit: b?.loadedLimit, heapFrame: LOCAL_REVEAL_HEAP });
    put('signing'); gate();
    const account = (await w.wallet.features['standard:connect'].connect()).accounts.find(x => x.address === wallet);
    check(!!account, 'LocalRevealSigner');
    gate();
    const [out] = await w.wallet.features['solana:signTransaction'].signTransaction({ account, transaction: wireTransaction(message, []) });
    gate();
    let tx; try { tx = parseTransaction(Uint8Array.from(out?.signedTransaction ?? [])); } catch { fail('LocalRevealSignedMalformed'); }
    check(same([...tx.message], [...message]) && same(tx.signers, [wallet]) && tx.signatures.length === 1 && tx.signatures[0].some(x => x !== 0), 'LocalRevealSignedOtherMessage');
    let ok = false;
    try { const key = await globalThis.crypto.subtle.importKey('raw', decode(wallet), 'Ed25519', false, ['verify']); ok = await globalThis.crypto.subtle.verify('Ed25519', key, tx.signatures[0], tx.message); } catch { ok = false; }
    check(ok === true, 'LocalRevealSignatureInvalid');
    const signature = encode(tx.signatures[0]), wire = wireTransaction(tx.message, [tx.signatures[0]]);
    put('submitting', { signature });
    // (the repaint above is the page's own code: asked again in this same turn of the loop as the POST)
    check(gate() === origin, 'LocalRevealRelay');
    r.sent = Object.freeze({ origin, signature, record, pin });
    base = { ...base, sent: true }; r.state = Object.freeze({ ...r.state, sent: true });
    let answer;
    try {
      const v = await post(origin, LOCAL_REVEAL_SUBMIT_PATH, { schema: LOCAL_REVEAL_SUBMIT_SCHEMA, transaction_b64: toBase64(wire) });
      check(object(v) && ['submitted', 'unknown'].includes(v.status) && v.signature === signature, 'BadLocalRevealSubmitted');
      answer = v.status;
    } catch (e) {
      // no answer, a refusal or one that cannot be believed: asked about by its signature; never sent again
      r.busy = false; r.checked = null; return put('unknown', { error: codeOf(e, 'LocalRevealOutcomeUnknown') });
    }
    r.busy = false; r.checked = null; put(answer);
    return await reconcileLocalReveal(fs, { allowed, post, changed });
  } catch (e) {
    return end('error', { error: codeOf(e, 'LocalRevealFailed') });
  }
}

/**
 * Ask what became of a reveal whose outcome is not settled: its FIRST signature goes to the status route, and only
 * there. confirmed | finalized → `revealed` (the seal's record is marked, never dropped); failed → `failed` with the
 * chain's own error; pending | processed, no answer, or a refusal → the state stays as it was.
 */
export async function reconcileLocalReveal(fs, { allowed, post = postLocalReveal, changed = () => {} } = {}) {
  const r = runOf(fs);
  if (r.busy || !r.sent || !OPEN.includes(r.state.status)) return r.state;
  const before = r.state;
  r.busy = true;
  const put = (status, more = {}) => { r.state = Object.freeze({ ...before, ...more, status, busy: r.busy }); try { changed(); } catch { /* not this run's */ } return r.state; };
  const end = (status, more) => { r.busy = false; return put(status, more); };
  const a = allowed();
  if (!a?.ok || a.relay !== r.sent.origin) return end(before.status, { error: a?.code ?? 'LocalRevealRelay' });
  // (the status of a signature is only believed for the identity that sent it: another program, Season or wallet is another chain's answer)
  const i = fs?.localPlay, p = r.sent.pin;
  if (!object(i) || i.programId !== p.programId || i.seasonAddress !== p.seasonAddress || String(i.seasonId) !== p.seasonId || i.address !== p.address) return end(before.status, { error: 'LocalRevealIdentityChanged' });
  put(before.status);
  let s;
  try {
    const v = await post(r.sent.origin, LOCAL_REVEAL_STATUS_PATH, { schema: LOCAL_REVEAL_STATUS_SCHEMA, signature: r.sent.signature });
    check(object(v) && v.signature === r.sent.signature && ['pending', 'processed', 'confirmed', 'finalized', 'failed'].includes(v.status), 'BadLocalRevealStatus');
    check((v.status === 'failed') === (v.err !== null && v.err !== undefined), 'BadLocalRevealStatus');
    s = v;
  } catch (e) { return end(before.status, { error: codeOf(e, 'LocalRevealStatusUnavailable') }); }
  const slot = Number.isSafeInteger(s.slot) ? s.slot : null;
  if (s.status === 'failed') { let err = 'Failed'; try { err = (typeof s.err === 'string' ? s.err : JSON.stringify(s.err)).slice(0, 200); } catch { /* kept */ } return end('failed', { code: err, error: null, chain: 'failed', slot }); }
  if (s.status === 'confirmed' || s.status === 'finalized') {
    // the chain has the reveal: the seal's record says so, and stays
    r.sent.record.revealed = { signature: r.sent.signature, by: 'status', chain: s.status, slot };
    return end('revealed', { error: null, code: null, chain: s.status, slot });
  }
  return end(before.status, { error: null, chain: s.status, slot });
}
