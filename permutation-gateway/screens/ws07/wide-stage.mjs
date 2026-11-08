// Workstream 07: an OPT-IN rewrite of the fixture viewer's /h/me record that gives the viewer a wide inventory, for
// the whole-page wide-village test only (screens/ws07-wide.screen.mjs). Installed with `srv.meWith(wideMe(viewer))`;
// without it the fixture server answers exactly as world.mjs says (the default stays byte-identical: workstream 04's
// condition, checked by hash in that test).
//
// What it changes, in the 'holding' stage only:
//   - the viewer's Citizen bytes: inventory slot 2 = the wide marker {p 0, q 0, site 12, gen 0}, slot 3 = empty
//     (gen 255). Slot 1 is the fixture's home as it is — {2, 0, 3, gen 0} — which fwide.citizenBindings classes
//     'malformed' (a legacy home has gen ≥ 1 on a chain). Nothing else in the Citizen changes; no host ID, no Holding,
//     no Province, no address changes.
//   - `wideContext` and `wideHoldings`: the read-only captured envelope the herald sends, with slot 2 captured at a far
//     coordinate (past 2^53) and its WideHolding bytes built from public fields only.
// Every address is a public derivation: the Season PDA and the Citizen PDA (world.mjs viewer), the wide Holding's
// with-seed address (fwide.wideHoldingAddress). No key is made, derived or used.
import { encodeAccount as encodeV2 } from '../../../permutation-server/web/sdk/frontier/codec.mjs';
import { decode as fromB58 } from '../../../permutation-server/web/sdk/base58.mjs';
import { toBase64, fromHex, utf8 } from '../../../permutation-server/web/sdk/bytes.mjs';
import { sortKeyOf, wideHoldingAddress, WIDE_HOLDING_SIZE, TRAILER } from '../../../permutation-server/web/frontier/fwide.mjs';
import { worldIdOf, ringPosition, WORLD_DOMAIN } from '../../../permutation-server/web/frontier/map/wide.mjs';
import * as W from '../world.mjs';

/** The far coordinate of the captured wide village (past 2^53, outside the legacy disk). */
export const FAR = Object.freeze({ p: 9007199254740993n, q: -130n, site: 3, gen: 1 });
export const WIDE_MARKER = Object.freeze({ p: 0, q: 0, site: 12, gen: 0 });
const STORE_VALUES = [1220, 815, 662, 305, 122, 90, 40, 20];
const STORE_RATES = [40, 30, 25, 10, 5, 0, 0, 0];

/** WideHolding bytes (frontier-abi `WideHolding::write_identity` layout), as wide-holding-fixture/data.mjs builds them. */
function wideBytes({ p, q, site, gen, slot, owner, world, season }) {
  const prefix = encodeV2('Holding', {
    SEASON_ID: season, SITE: site, GEN: gen, OWNER_CITIZEN: owner, TIER: 1, STATE: 2, WALLS: 250, FACTION: 0, ORDER: 2,
    FOUNDED_TS: 1_799_990_000n, LAST_OWNER_ACTION: 1_800_000_000n, FINAL_TS: 1_799_995_000n, SHIELD_UNTIL: 0n, ESCROW: 123n, FOOD_SHORTFALL: 0n,
    STORES: STORE_VALUES.map((v, i) => ({ VALUE: BigInt(v * 1000), RATE: BigInt(STORE_RATES[i] * 1000), CAP: 6_000_000n, T0: 1_800_000_000n, FRAC: 0n })),
    PRODUCTION: STORE_RATES.map(r => BigInt(r * 1000)), UPKEEP: STORE_RATES.map(() => 0n),
    QUEUE: [{ DONE_AT: 1_800_003_600n, KIND: 1, ARG: 1, DELTA: 10_000n }, ...Array.from({ length: 3 }, () => ({ DONE_AT: 0n, KIND: 0, ARG: 0, DELTA: 0n }))],
    RESERVE: [400, 0, 0, 0, 0, 0, 100, 0],
  }, { profile: 2 });
  const b = new Uint8Array(WIDE_HOLDING_SIZE);
  b.set(prefix, 0);
  const dv = new DataView(b.buffer);
  b.set(utf8('PSFXWHL1'), 0);
  dv.setUint16(16, 3, true);
  dv.setInt16(64, 0, true); dv.setInt16(66, 0, true);
  dv.setUint16(TRAILER.FAMILY_VERSION, 1, true);
  b[TRAILER.STATUS] = 1;
  b[TRAILER.SLOT] = slot;
  dv.setUint16(TRAILER.HOST_IDENTITY, 0, true);
  b[TRAILER.OPEN_TRANSITS] = 0;
  b.set(fromHex(world), TRAILER.WORLD);
  b.set(sortKeyOf(p, q), TRAILER.SORT_KEY);
  return b;
}

/**
 * The rewrite for `viewer` (world.mjs viewer): `(record, stage) → record`. Only the 'holding' stage's record changes.
 * `status`: 'captured' (slot 2 captured at FAR), or 'error' (an envelope of another world: the page must refuse it).
 */
export function wideMe(viewer, { status = 'captured' } = {}) {
  const seasonAddress = viewer.A.season, programId = W.PROGRAM, season = String(W.SEASON_ID);
  const world = worldIdOf(seasonAddress, programId);
  const citizen = W.encode('Citizen', { ...W.citizenValues(viewer, 'holding'),
    holding: [{ p: W.HOME.p, q: W.HOME.q, site: W.HOME.site, gen: W.HOME.gen }, { ...WIDE_MARKER }, { p: 0, q: 0, site: 0, gen: 255 }] });
  const bytes = wideBytes({ ...FAR, slot: 2, owner: fromB58(viewer.citizen), world, season: BigInt(W.SEASON_ID) });
  const holding = {
    world, p: String(FAR.p), q: String(FAR.q), ring: String(ringPosition(FAR.p, FAR.q).ring), site: FAR.site, generation: FAR.gen, inventorySlot: 2, season,
    ownerCitizen: viewer.citizen, hostIdentity: 0, openTransits: 0,
    capture: { address: wideHoldingAddress(seasonAddress, programId, FAR.p, FAR.q, FAR.site), slot: '1000', archiveSequence: '12', postState: 'transaction', verification: 'captured-unverified', bytes_b64: toBase64(bytes) },
  };
  const context = { v: 1, readOnly: true, executable: false, verification: 'captured-unverified', world: status === 'error' ? 'ab'.repeat(32) : world, worldDomain: WORLD_DOMAIN, season,
    citizen: viewer.citizen, latestSlot: '2000', foldedThrough: '40', postState: 'transaction',
    inventory: [{ inventorySlot: 1, binding: 'malformed' }, { inventorySlot: 2, binding: 'wide' }, { inventorySlot: 3, binding: 'empty' }] };
  return (rec, stage) => (stage !== 'holding' || !rec.citizen ? rec
    : { ...rec, citizen: { ...rec.citizen, bytes_b64: Buffer.from(citizen).toString('base64') }, wideContext: context, wideHoldings: [{ inventorySlot: 2, status: 'captured-unverified', holding }] });
}
