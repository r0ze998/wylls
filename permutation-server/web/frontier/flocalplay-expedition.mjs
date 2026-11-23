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
import { seasonAddresses } from './faddr.mjs';

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
 * (verify-pr176) Which of the page's villages has the Holding account `address` (a kept expedition's `record.holding`,
 * written by fexpedition-compose.mjs as `seasonAddresses(program, seasonId).of('Holding', h)`): its index in
 * `fs.holdings`, or -1. The page's holding objects carry no address of their own — the decoded record has none — so
 * it is derived here the same way. (w2-wipeout matched `h.address`, never set live: the expedition card's
 * 「村で次の軍勢を作る」 never showed, and the slot marker was always read from the active village.)
 */
export function holdingIndexOf(fs, address) {
  if (typeof address !== 'string' || !address) return -1;
  const program = fs?.localPlay?.programId ?? fs?.record?.programId ?? null, seasonId = fs?.season?.seasonId;
  if (!program || seasonId === undefined || seasonId === null) return -1;
  let a; try { a = seasonAddresses(program, String(seasonId)); } catch { return -1; }
  return (fs.holdings ?? []).findIndex(h => { try { return !!h && a.of('Holding', { p: h.p, q: h.q, site: h.site }) === address; } catch { return false; } });
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
    const holdingIndex = holdingIndexOf(fs, record.holding);
    const holding = (fs.holdings ?? [])[holdingIndex] ?? (fs.holdings ?? []).find(h => h?.address === record.holding) ?? (fs.holdings ?? [])[fs.activeHolding ?? 0] ?? null;
    const marker = holding?.transit?.[record.transitSlot] ?? null;
    const transit = marker && marker.state === 4 && marker.arriveBell === record.arriveBell
      ? { slot: record.transitSlot, state: 4, hostId: marker.hostId, arriveBell: marker.arriveBell, dest: null } : null;
    const origin = transit ? { p: marker.originP, q: marker.originQ, tile: marker.originTile } : record.origin ?? null;
    const got = m.get(record.commit) ?? null, stage = expeditionStage(record, got?.facts ?? null, nowBell);
    rows.push({ expedition: { stage, fate: got?.facts?.fate ?? null, troopsAfter: got?.facts?.troopsAfter ?? null, depMass: got?.facts?.depMass ?? null,
      host: record.host, transitSlot: record.transitSlot, arriveBell: record.arriveBell, dest, origin, commit: record.commit,
      // (w2-wipeout: the village that sent it — the card's 「次の軍勢」 press opens that village)
      holding: record.holding ?? null, holdingIndex,
      // (fix-loop9, LP9-2: the hold of the keep it stands on, when followed — readExpeditionHolds)
      hold: holdsOf.get(fs)?.get(record.commit) ?? null },
    entry: null, transit, dest, region: null, facts: { nowBell, pipeline: null, slotPresent: stage === 'revealed', settleReady: false }, record: null, slot: null, env: null, unread: null });
  }
  return rows;
}

/** The kept expeditions whose host stands in the wide land now (settled with fate Stays): `[{dest, troops, arriveBell}]`. */
export const standingExpeditions = (fs, seals = localDepartReveals) => expeditionRows(fs, seals).filter(r => r.expedition.stage === 'settled' && r.expedition.fate === 'stays'
  // (fix-loop9, LP9-2: a host followed off its keep — beaten, the hold lost — no longer stands there)
  && !(r.expedition.hold?.outcome === 'lost' && r.expedition.hold.why === 'gone'))
  .map(r => ({ dest: r.expedition.dest, troops: r.expedition.troopsAfter, arriveBell: r.expedition.arriveBell, host: r.expedition.host }));
/**
 * (fix-loop10, LP10-2) The kept expeditions that hold or took a wide keep (a followed hold that was not lost):
 * `[{dest, arriveBell}]` — what a later host of the same player on that keep joined, not began.
 */
export const holdingExpeditions = (fs, seals = localDepartReveals) => expeditionRows(fs, seals)
  .filter(r => r.expedition.hold && r.expedition.hold.outcome !== 'lost' && r.expedition.dest)
  // (verify-pr175: a keep the expedition took and another nation holds again is no hold of the player's — a host that
  //  takes it later takes it alone)
  .filter(r => !Number.isInteger(r.expedition.hold.keepLostAt))
  .map(r => ({ dest: r.expedition.dest, arriveBell: r.expedition.arriveBell }));
/** Whether any kept expedition is still under way (not settled): its host is away. */
export const expeditionsAway = (fs, seals = localDepartReveals) => expeditionRows(fs, seals).some(r => r.expedition.stage !== 'settled');

// ------------------------------------------------------------------ (fix-loop9, LP9-2) the hold of a wide keep
// loop-play9: an expedition of 1,189 landed on the keep tile of a wide province (fate Stays), held it 72 turns and TOOK
// it on chain at turn 550 — and the page said nothing: the march entry stayed 「留まる：…（兵 1,189）」, no count, no
// 「奪いました」. Like fix-loop7 did for a wide village's own march (flocalplay-wide-plan.mjs followWideHold), a kept
// expedition that stays on the destination province's KEEP tile is followed to its end: the page reads that one province
// — the province its own host stands in (the fog rule holds: nothing of a province without a host of the viewer's) —
// and says the hold's count, then taken or lost. A capture turns the holding host into the keep's garrison, so it leaves
// the province's entries: the keep held by the viewer's nation is the capture, not a loss.

const holdsOf = new WeakMap();
/** The followed holds of kept expeditions: Map `commit` → `{to, tile, progress, required, since, outcome, why?, holder?, at}`. */
export const expeditionHoldsOf = fs => { let m = holdsOf.get(fs); if (!m) { m = new Map(); holdsOf.set(fs, m); } return m; };

/**
 * One step of an expedition's hold (pure): from the last hold `prev` (or null), the expedition's destination `dest`
 * `{p, q, tile}`, the destination province as read (`{entries, keep}`, flocalplay-wide-host.mjs readWideProvince) and the
 * viewer's nation. → the hold, or null when the expedition does not stand on that province's keep.
 */
export function followExpeditionHold(prev, { dest, province, faction, nowBell }) {
  const k = province?.keep ?? null;
  // (fix-loop10, LP10-5: a TAKEN keep's garrison is the keep record's own count — whole troops, as read at `garrisonAt` —
  //  while the keep is still the viewer's nation's. loop-play10: the card said （兵 1,289）, the strength the host left
  //  with; the chain garrison was 644 — a capture leaves half of the holding host in the keep, world_index/resolve.rs)
  // (verify-pr175: the keep seen as another nation's again → `keepLostAt`, once; the garrison record stops there, with its
  //  turn, and holdingExpeditions no longer counts this expedition as holding the keep)
  if (prev?.outcome === 'taken' && !Number.isInteger(prev.keepLostAt) && k && dest && k.tile === dest.tile && k.holder !== faction) return { ...prev, keepLostAt: nowBell };
  if (prev?.outcome === 'taken') return !Number.isInteger(prev.keepLostAt) && k && dest && k.tile === dest.tile && k.holder === faction && Number.isInteger(k.troops) && (prev.garrison !== k.troops)
    ? { ...prev, garrison: k.troops, garrisonAt: nowBell } : prev;
  if (prev?.outcome) return prev;                       // (an ended hold stays ended: said once and kept)
  if (!k || !dest || k.tile !== dest.tile) return prev ?? null;
  const to = { p: String(dest.p), q: String(dest.q) };
  const stands = (province.entries ?? []).some(e => e.faction === faction && e.tile === k.tile && e.state >= 1 && e.state <= 3);
  const required = k.required ?? prev?.required ?? null;
  if (k.holder === faction) return { to, tile: k.tile, progress: required, required, since: prev?.since ?? nowBell, outcome: 'taken', at: nowBell, ...(Number.isInteger(k.troops) ? { garrison: k.troops, garrisonAt: nowBell } : {}) };
  if (k.contender === faction) return { to, tile: k.tile, progress: k.progress, required: k.required, since: prev?.since ?? nowBell, outcome: null, at: nowBell };
  if (prev) return { ...prev, outcome: 'lost', why: stands ? 'held-by-other' : 'gone', holder: k.holder, at: nowBell };
  // (standing on the keep, the count not started yet: the arrival turn's own resolve starts it)
  return stands ? { to, tile: k.tile, progress: 0, required: k.required, since: nowBell, outcome: null, at: nowBell, waiting: true } : null;
}

/**
 * Read the destination province of every kept expedition that stays on its keep and whose hold has not ended (one read
 * each; `read(addresses)` → bytes | null, the relay's wide read; `parse` readWideProvince; `address(p, q)` the wide
 * province's address). A failed read keeps the last hold. → the holds map.
 */
export async function readExpeditionHolds(fs, { read, parse, address, faction, nowBell, seals = localDepartReveals }) {
  const holds = expeditionHoldsOf(fs);
  if (typeof read !== 'function' || typeof parse !== 'function' || !Number.isInteger(faction)) return holds;
  for (const r of expeditionRows(fs, seals)) {
    const x = r.expedition;
    if (x.stage !== 'settled' || x.fate !== 'stays' || !x.dest) continue;
    const prev = holds.get(x.commit) ?? null;
    // (fix-loop10, LP10-5: a taken keep is still read — its garrison is the chain's, now — a lost hold is not)
    if (prev?.outcome && (prev.outcome !== 'taken' || Number.isInteger(prev.keepLostAt))) continue;
    let province;
    try { const [b] = await read([address(String(x.dest.p), String(x.dest.q))]); if (!b) continue; province = parse(b); } catch { continue; }
    const h = followExpeditionHold(prev, { dest: x.dest, province, faction, nowBell });
    if (h) holds.set(x.commit, h);
  }
  return holds;
}

