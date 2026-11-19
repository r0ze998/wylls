// Local play only (TEST-ONLY wide world; fix-wide-breaks BREAK-1 and BREAK-3): what became of the expeditions this
// page sent into the wide land. An expedition (the version-2 wrapper: ExpeditionDepart → SettleOrigin → Reveal →
// Gather → resolve → SettleMember) keeps its host in a BRIDGE transit record, and the village's inline transit slot
// holds only its marker (state 4). The page's ordinary march list reads inline transits of states 1–3 and the legacy
// provinces, so an expedition was in no list at all: 「進軍中の軍勢はいません」 / "No hosts yet" while the host was
// away, and nothing after it stood in the wide province. And the world's runner reveals an expedition itself (from the
// public round), so the page never learnt that the seal it kept was opened: its reveal strip offered 「封を開ける」 for
// good (→ RevealTransitMissing once settled).
//
//   the seals this page kept (flocalplay-depart.mjs localDepartReveals: host, transit slot, arrival turn, plaintext)
//     ──▶ ONE read per seal through the loopback relay's existing reveal/context route (a read: owner and bytes of
//         the accounts this page derives itself): the bridge transit, the arrival's clash inputs and the nation's four
//         arrival slots of that turn
//     ──▶ expeditionFacts (pure): which of them stand, our host's arrival slot, our row of the clash inputs (present,
//         fate, troops after) and whether it was settled
//     ──▶ expeditionStage (pure): sent → marching → arrived → revealed → resolved → settled
//
// Nothing is built, signed or sent here. A seal found in an arrival slot, in the clash inputs, or whose transit is gone
// after its arrival turn is marked `revealed` (by the chain), as checkLocalReveal marks it on RevealAlreadyIn, so the
// reveal strip lets it go. Reads that fail leave the last facts as they were (never "nothing happened").
import { localDepartReveals } from './flocalplay-depart.mjs';
import { LOCAL_REVEAL_CONTEXT_PATH, LOCAL_REVEAL_CONTEXT_SCHEMA, localRevealContext, postLocalReveal } from './flocalplay-reveal.mjs';
import { revealAddresses } from './fexpedition-reveal.mjs';
import { unpackWidePlain, decodeWideProvinceKey } from './fexpedition-seal.mjs';
import { toHex } from '../sdk/bytes.mjs';

/** The deployed fate codes (frontier-abi world_index::arrival::wide_arrival). */
export const EXPEDITION_FATES = Object.freeze({ 1: 'stays', 2: 'withdrew', 3: 'bounced', 4: 'retreated', 5: 'destroyed' });
/** The records read, by the fields named here only (frontier-abi expedition_bridge, march::wide_transit, arrival). */
const BRIDGE = Object.freeze({ LEN: 336, MAGIC: 'PSWLEXP1', T: 16, STATE: 1 });
const INPUTS = Object.freeze({ MAGIC: 'PSFXWCLI', FLAGS: 18, RESOLVED: 2, SETTLED_MASK: 36, ARRIVALS: 320, ROW: 112, FACTION: 102, PRESENT: 106, FATE: 107, TROOPS_AFTER: 108, DEP_MASS: 88 });
const SLOT = Object.freeze({ MAGIC: 'PSFXWASL', HOST: 96 });
const latin = b => String.fromCharCode(...b);
const own = (x, program) => !!x && x.owner === program;

/** The accounts one seal's facts are read from (derived here from the kept seal; the nation is the page's Citizen's). */
export function expeditionAccounts(record, { programId, seasonAddress }, faction) {
  const typed = unpackWidePlain(record.plain);
  const a = revealAddresses({ program: programId, season: seasonAddress, holding: record.holding, transitSlot: record.transitSlot, faction,
    arriveBell: record.arriveBell, destKey: typed.dest, destRegion: 0 });
  return { typed, addresses: [a.transit, a.inputs, ...a.slots] };
}

/**
 * The facts of one kept seal from one context read (pure): `{transit: 'open'|'gone', transitState, slotI, present,
 * fate, troopsAfter, depMass, resolved, settled}`. Only records owned by the program and of the expected magic count.
 */
export function expeditionFacts(record, programId, faction, accounts, addresses) {
  const [transitAt, inputsAt, ...slotsAt] = addresses;
  const t = accounts.get(transitAt) ?? null;
  const open = own(t, programId) && t.data.length === BRIDGE.LEN && latin(t.data.subarray(0, 8)) === BRIDGE.MAGIC;
  const out = { transit: open ? 'open' : 'gone', transitState: open ? t.data[BRIDGE.T + BRIDGE.STATE] : null, slotI: null, present: false, fate: null, troopsAfter: null, depMass: null, resolved: false, settled: false };
  slotsAt.forEach((at, i) => {
    const s = accounts.get(at) ?? null;
    if (own(s, programId) && s.data.length >= SLOT.HOST + 56 && latin(s.data.subarray(0, 8)) === SLOT.MAGIC && toHex(s.data.subarray(SLOT.HOST, SLOT.HOST + 56)) === record.host) out.slotI = i;
  });
  const c = accounts.get(inputsAt) ?? null;
  if (own(c, programId) && c.data.length >= INPUTS.ARRIVALS + 24 * INPUTS.ROW && latin(c.data.subarray(0, 8)) === INPUTS.MAGIC) {
    const v = new DataView(c.data.buffer, c.data.byteOffset, c.data.byteLength);
    out.resolved = (c.data[INPUTS.FLAGS] & INPUTS.RESOLVED) !== 0;
    for (let k = 0; k < 24; k++) {
      const o = INPUTS.ARRIVALS + k * INPUTS.ROW;
      if (toHex(c.data.subarray(o, o + 56)) !== record.host || c.data[o + INPUTS.FACTION] !== faction) continue;
      out.present = c.data[o + INPUTS.PRESENT] === 1;
      const fate = c.data[o + INPUTS.FATE];
      out.fate = EXPEDITION_FATES[fate] ?? null;
      out.troopsAfter = v.getUint32(o + INPUTS.TROOPS_AFTER, true);
      out.depMass = v.getUint32(o + INPUTS.DEP_MASS, true);
      out.settled = (v.getUint32(INPUTS.SETTLED_MASK, true) & (1 << k)) !== 0;
      break;
    }
  }
  return out;
}

/**
 * Where an expedition stands (pure), from its kept seal's arrival turn, its last facts (or null) and the turn now:
 *   'sent'      signed for sending; no bridge transit read yet
 *   'marching'  the bridge transit stands and its arrival turn has not come
 *   'arrived'   the arrival turn came; not yet in an arrival slot (the runner reveals it from the public round)
 *   'revealed'  in an arrival slot: waiting for the arrival turn to be gathered and resolved
 *   'resolved'  the clash inputs have its row and a fate: waiting for the member settlement
 *   'settled'   its row was settled (or its transit is gone after the arrival with a fate known)
 *   'unknown'   its transit is gone after the arrival turn and no row of it was read
 */
export function expeditionStage(record, facts, nowBell) {
  if (!facts) return 'sent';
  if (facts.fate && (facts.settled || facts.transit === 'gone')) return 'settled';
  if (facts.fate && facts.resolved) return 'resolved';
  if (facts.slotI !== null || facts.present) return 'revealed';
  if (facts.transit === 'open') return nowBell >= record.arriveBell ? 'arrived' : 'marching';
  return nowBell > record.arriveBell ? 'unknown' : 'sent';
}

/** Whether the chain shows the seal opened (an arrival slot, the clash inputs, or its transit gone after the arrival). */
export const chainRevealed = (record, facts, nowBell) => !!facts && (facts.slotI !== null || facts.present || !!facts.fate || (facts.transit === 'gone' && nowBell > record.arriveBell));

const factsOf = new WeakMap();
/** The last facts read for each kept seal: Map `commit` → `{facts, bell}`. */
export const expeditionFactsOf = fs => { let m = factsOf.get(fs); if (!m) { m = new Map(); factsOf.set(fs, m); } return m; };

/**
 * Read the facts of every kept seal that was signed for sending (one context read each, at most 6 accounts). `deps`:
 * `relay` (the loopback relay origin), `pin` `{programId, seasonAddress}`, `faction`, `nowBell`, `post` (postLocalReveal),
 * `seals` (localDepartReveals; a stand-in in tests).
 * A seal found opened on the chain is marked `revealed` (BREAK-3). A failed read keeps the last facts. → the facts map.
 */
export async function readExpeditions(fs, { relay, pin, faction, nowBell, post = postLocalReveal, seals = localDepartReveals }) {
  const m = expeditionFactsOf(fs);
  if (!relay || !pin?.programId || !pin?.seasonAddress || !Number.isInteger(faction)) return m;
  for (const record of seals(fs).filter(r => r.signature)) {
    const prev = m.get(record.commit) ?? null;
    if (prev && expeditionStage(record, prev.facts, nowBell) === 'settled') continue;
    let addresses;
    try { ({ addresses } = expeditionAccounts(record, pin, faction)); } catch { continue; }
    let facts;
    try {
      const ctx = localRevealContext(await post(relay, LOCAL_REVEAL_CONTEXT_PATH, { schema: LOCAL_REVEAL_CONTEXT_SCHEMA, addresses }), addresses);
      facts = expeditionFacts(record, pin.programId, faction, ctx.accounts, addresses);
    } catch { continue; }
    // (a transit read gone BEFORE any open read is not yet landed: keep "sent" until it is seen or the arrival passed)
    m.set(record.commit, { facts, bell: nowBell });
    if (!record.revealed && chainRevealed(record, facts, nowBell)) record.revealed = { signature: null, by: 'chain' };
  }
  return m;
}

/**
 * The page's march rows of its kept expeditions (pure over the store): one per seal signed for sending, newest last:
 * `{expedition: {stage, fate, troopsAfter, depMass, host, transitSlot, arriveBell, dest: {p, q, tile}, origin}, entry: null,
 * transit, dest, facts: {nowBell}}`. `transit` is the village's inline marker of that slot (state 4) while it stands.
 */
export function expeditionRows(fs, seals = localDepartReveals) {
  const m = expeditionFactsOf(fs), nowBell = fs?.nowBell ?? 0, rows = [];
  for (const record of seals(fs).filter(r => r.signature)) {
    let typed, dest;
    try { typed = unpackWidePlain(record.plain); const k = decodeWideProvinceKey(typed.dest); dest = { p: Number(k.p), q: Number(k.q), tile: typed.destTile }; } catch { continue; }
    const holding = (fs.holdings ?? []).find(h => h?.address === record.holding) ?? (fs.holdings ?? [])[fs.activeHolding ?? 0] ?? null;
    const marker = holding?.transit?.[record.transitSlot] ?? null;
    const transit = marker && marker.state === 4 && marker.arriveBell === record.arriveBell
      ? { slot: record.transitSlot, state: 4, hostId: marker.hostId, arriveBell: marker.arriveBell, dest: null } : null;
    const origin = transit ? { p: marker.originP, q: marker.originQ, tile: marker.originTile } : record.origin ?? null;
    const got = m.get(record.commit) ?? null, stage = expeditionStage(record, got?.facts ?? null, nowBell);
    rows.push({ expedition: { stage, fate: got?.facts?.fate ?? null, troopsAfter: got?.facts?.troopsAfter ?? null, depMass: got?.facts?.depMass ?? null,
      host: record.host, transitSlot: record.transitSlot, arriveBell: record.arriveBell, dest, origin, commit: record.commit },
    entry: null, transit, dest, region: null, facts: { nowBell, pipeline: null, slotPresent: stage === 'revealed', settleReady: false }, record: null, slot: null, env: null, unread: null });
  }
  return rows;
}

/** The kept expeditions whose host stands in the wide land now (settled with fate Stays): `[{dest, troops, arriveBell}]`. */
export const standingExpeditions = (fs, seals = localDepartReveals) => expeditionRows(fs, seals).filter(r => r.expedition.stage === 'settled' && r.expedition.fate === 'stays')
  .map(r => ({ dest: r.expedition.dest, troops: r.expedition.troopsAfter, arriveBell: r.expedition.arriveBell, host: r.expedition.host }));
/** Whether any kept expedition is still under way (not settled): its host is away. */
export const expeditionsAway = (fs, seals = localDepartReveals) => expeditionRows(fs, seals).some(r => r.expedition.stage !== 'settled');
