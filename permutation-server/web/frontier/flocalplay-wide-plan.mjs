// LOCAL PLAY, TEST-ONLY — the PLANNER of a wide village's own host (Q-W2, owner t385u 2026-11-19 22:32 JST 「おすすめで」:
// wide-land interior marches and wide keep capture in LOCAL TEST only): one decision a turn — WideTrain Spearmen,
// WideMuster a host, or WideDepart it wide -> wide onto a neighbouring province's keep over passable tiles, sealed to
// T(arrive). The SAME planner serves the page's wide village card (controller `wide-host-plan`) and the operator AI
// residents (gateway local-play-operator-wide-host.mjs); each gives it its own reads:
//   read(addresses)      → Uint8Array | null per address (the relay's read-only `frontier-local-play-act-wide-read-v1`)
//   herald               → the page's herald client (season, wideRoute)
//   chainNow()           → the chain's unix time (s); chainRate() → the TEST clock's rate (1, 10…60)
// It decides only; the act is sent by the caller as a page-signed local act (flocalplay-wide-host.mjs). Nothing is a
// new rule: every check here is the page's or the program's, and the program judges everything again.
import { tipOptions, departMargin } from './fmarch.mjs';
import { seasonClock, bellAt } from './clock.mjs';
import { worldIdOf, ringPosition } from './map/wide.mjs';
import { traceWideDirections, canonicalWideProvinceKey, unpackWidePlain } from './fexpedition-seal.mjs';
import { evaluateOutboundRoute } from './fexpedition-route.mjs';
import { parseOutboundRouteCaptures } from './fexpedition-route-read.mjs';
import { sealWideRequest } from './seal-wide.mjs';
import { WIDE_TRAIN, WIDE_MUSTER, WIDE_DEPART, wideVillageAccounts, readWideHolding, readWideProvince, wideHostsIn, prepareWideOutboundPlain } from './flocalplay-wide-host.mjs';
import { wideProvinceAddress } from './flocalplay-wide.mjs';
import { fromHex, toHex } from '../sdk/bytes.mjs';

export const WIDE_HOST_SCHEMA = 'frontier-local-play-wide-host-v1';
/** At most this many wide -> wide marches per resident (a TEST world: enough to contest a keep). */
export const WIDE_DEPARTS_MAX = 2;
/** The troops a resident raises before it marches (whole Spearmen). */
export const WIDE_HOST_TROOPS = 300;
/** The longest path searched (hex steps; the program allows 32 and 4 provinces). */
export const WIDE_HOST_PATH_MAX = 24;
export const ARRIVAL_SLACK_BELLS = 2;
/** The fewest troops a host marches with (the program's MIN_HOST_TROOPS, whole Spearmen; the province records thousandths). */
export const WIDE_MIN_HOST_TROOPS = 100;
const MIN_HOST_MILLI = WIDE_MIN_HOST_TROOPS * 1000;
const STATE_FINAL = 2;

const fail = (code, detail) => { throw Object.assign(new Error(detail ? `${code}: ${detail}` : code), { code }); };
const ring = (p, q) => ringPosition(BigInt(p), BigInt(q)).ring;
const dist = (a, b) => { const dp = BigInt(a.p) - BigInt(b.p), dq = BigInt(a.q) - BigInt(b.q), ds = -dp - dq; const ab = x => (x < 0n ? -x : x); return Number([ab(dp), ab(dq), ab(ds)].reduce((x, y) => (x > y ? x : y))); };

/** The opened wide provinces next to a wide village (province distance 1), nearest-first order is irrelevant: all six. */
export function neighbourTargets(village, wideTargets) {
  return (wideTargets ?? []).map(t => ({ p: String(t.p), q: String(t.q) }))
    .filter(t => { try { return ring(t.p, t.q) >= 129n && dist(village, t) === 1; } catch { return false; } });
}

/**
 * A path (pure) from `origin` (`{p, q, tile}`) onto tile `destTile` of province `dest`, over tiles of the origin and
 * destination provinces whose `passable` bit is set in `lands` (Map key → land); breadth-first, so the shortest.
 * → `{directions, tile}` or null.
 */
export function passablePath(world, origin, dest, destTile, lands, { max = WIDE_HOST_PATH_MAX } = {}) {
  const okey = canonicalWideProvinceKey({ world, p: String(origin.p), q: String(origin.q) });
  const dkey = canonicalWideProvinceKey({ world, p: String(dest.p), q: String(dest.q) });
  const seen = new Set([`${origin.p},${origin.q},${origin.tile}`]);
  let frontier = [[]];
  for (let depth = 0; depth < max; depth++) {
    const next = [];
    for (const dirs of frontier) for (let k = 0; k < 6; k++) {
      const nd = [...dirs, k];
      let e; try { e = traceWideDirections({ world, origin, directions: nd }).endpoint; } catch { continue; }
      if (e.key !== okey && e.key !== dkey) continue;
      const id = `${e.p},${e.q},${e.tile}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const l = lands.get(e.key);
      if (!l || (l.passable & (1n << BigInt(e.tile))) === 0n) continue;
      if (e.key === dkey && e.tile === destTile) return { directions: nd, tile: e.tile };
      next.push(nd);
    }
    frontier = next;
    if (!frontier.length) break;
  }
  return null;
}

/**
 * (fix-loop7, LP7-5) The hold of a keep by this page's own last wide → wide march, followed to its end: from the previous
 * memory `prev` (or null) and the planner's latest `march` (marchState). `{to: {p, q}, progress, required, since,
 * outcome: null | 'taken' | 'lost', why?: 'gone' | 'held-by-other', at?: turn}` or `prev` unchanged. Only what this
 * page's own host learns (its own march, standing on the keep's tile, reading the destination province it went to): the
 * fog rules hold — nothing is read of a province the player has no host in. loop-play7: the card stopped at
 * 「占拠中です：20 / 72 ターン」 and never said whether the keep was taken.
 */
export function followWideHold(prev, march) {
  const m = march;
  if (!m?.to) return prev ?? null;
  // (verify-pr137: the same MARCH, not only the same keep — a later march onto the keep a lost hold was about, the
  //  planner's second wide march, starts its own hold instead of repeating the first one's 「奪えませんでした」)
  const arrive = Number.isInteger(m.arrive) ? m.arrive : null;
  const same = prev?.to && String(prev.to.p) === String(m.to.p) && String(prev.to.q) === String(m.to.q)
    && (prev.arrive === undefined || prev.arrive === null || arrive === null || prev.arrive === arrive);
  const base = same ? prev : null;
  if (base?.outcome) return base;            // (an ended hold stays ended: taken or lost is said once and kept)
  const to = { p: String(m.to.p), q: String(m.to.q) };
  // (fix-loop10, LP10-2) WHOSE hold this is. loop-play10: the village's second march (100 troops, arrival 427) went onto a
  //  keep the player's own EXPEDITION had held since turn ~360; the keep was taken at 433 and the card said 「州 … の砦を
  //  奪いました」 as if these 100 had. `shared`: the nation's hold of this keep was running before this host arrived —
  //  'nation' when the count is ahead of this host's own turns there (first sight), 'expedition' when a kept expedition
  //  of the player's stands in that province and arrived no later (markWideHoldExpedition below, the page's own records).
  //  `already`: the keep was the nation's when the host was first seen standing there, untouched (state 1, the troops it
  //  left with: a capture's donor is retired with what the garrison left it — world_index/resolve.rs).
  const ahead = k => arrive !== null && Number.isInteger(m.nowBell) && Number(k?.progress ?? 0) > Math.max(0, m.nowBell - arrive) + 2;
  const whose = (h, k) => { const shared = base?.shared ?? (ahead(k) ? 'nation' : null); return shared ? { ...h, shared } : h; };
  const mark = h => (arrive === null ? h : { ...h, arrive });
  // (the capture: the keep is the village nation's. Its holding host became the garrison and left the province's
  //  entries, so this is seen as 'gone' — fix-loop7 live run, turn 451 — or, if a host still stands there, as 'stands')
  if (base && m.keep && m.keep.holder === m.faction && ['stands', 'gone', 'settling'].includes(m.phase)) {
    return mark(whose({ to, progress: base.required ?? m.keep.required ?? null, required: base.required ?? m.keep.required ?? null, since: base.since, outcome: 'taken', at: m.nowBell }, null));
  }
  if (m.phase === 'stands' && m.keep) {
    const k = m.keep;
    if (k.holder === m.faction) {
      const untouched = !base && m.state === 1 && Number.isFinite(Number(m.sent)) && m.sent !== null && Number(m.troops) === Number(m.sent);
      const h = whose({ to, progress: base?.required ?? k.required ?? null, required: base?.required ?? k.required ?? null, since: base?.since ?? m.nowBell, outcome: 'taken', at: m.nowBell }, null);
      return mark(untouched ? { ...h, already: true } : h);
    }
    if (k.contender === m.faction) return mark(whose({ to, progress: k.progress, required: k.required, since: base?.since ?? m.nowBell, outcome: null }, base ? null : k));
    // (the host stands, but its nation no longer contends the keep: another took over the contest, or the count was reset)
    if (base) return { ...base, outcome: 'lost', why: 'held-by-other', holder: k.holder, at: m.nowBell };
    return null;
  }
  // (the host that held the keep's tile is no longer there: beaten off, the hold ended without the capture)
  if (m.phase === 'gone' && base) return { ...base, outcome: 'lost', why: 'gone', at: m.nowBell };
  // (still on its way or being decided: the same march's hold as it was; another march has none yet)
  return base;
}

/**
 * (fix-loop10, LP10-2) Mark a followed hold as shared with the player's own EXPEDITION: `expeditions` are the kept
 * expeditions standing in the wide land (flocalplay-expedition.mjs standingExpeditions: `[{dest: {p, q}, arriveBell}]`);
 * one in the hold's province that arrived no later than this march held the keep first. → the hold (the same object when
 * nothing changes; pure).
 */
export function markWideHoldExpedition(hold, expeditions = []) {
  if (!hold?.to || hold.shared === 'expedition') return hold ?? null;
  const arrive = Number.isInteger(hold.arrive) ? hold.arrive : null;
  const first = (expeditions ?? []).some(x => x?.dest && String(x.dest.p) === String(hold.to.p) && String(x.dest.q) === String(hold.to.q)
    && (arrive === null || !Number.isInteger(x.arriveBell) || x.arriveBell <= arrive));
  return first ? { ...hold, shared: 'expedition' } : hold;
}

/**
 * `createWideHostPlanner({herald, read, chainNow, chainRate})` → `{decide(identity, memory, {wideTargets, villages})}`:
 * `{decision}` (one act for this turn) or `{why}`. `identity`: `{programId, seasonAddress}`; `memory`: the caller's
 * own counters (`wideDeparts`, `wideHostUntil`, `decisions`, `wideTrainN`); `villages`: `[{p, q, site}]`.
 */
export function createWideHostPlanner({ herald, read, chainNow, chainRate = () => 1 }) {
  /**
   * (fix-loop6, LP6-5) The last wide → wide march of this page (`m`: `{to: {p, q, tile, holder}, arrive, troops}`, kept by
   * the page when it sent it): `{...m, phase}` — 'out' before its arrival turn; then, from the destination province's
   * record: 'stands' (a host of this village stands there: `troops`, and the keep's `keep` {holder, contender, progress,
   * required} and this village's `faction`), 'settling' (its transit is still open: the arrival is being decided),
   * 'gone' (no host of it there and nothing open), 'unread' (the province record was not read).
   */
  async function marchState({ m, nowBell, open, world, village, holding, seasonAddr, program }) {
    if (!m?.to || !Number.isInteger(m.arrive)) return null;
    if (nowBell < m.arrive) return { ...m, phase: 'out', nowBell };
    let dp = null;
    try { const [db] = await read([wideProvinceAddress(seasonAddr, program, m.to.p, m.to.q)]); dp = db ? readWideProvince(db) : null; } catch { dp = null; }
    if (!dp) return { ...m, phase: 'unread', nowBell };
    const there = wideHostsIn({ world, village, holding, province: dp });
    if (there.length) {
      const k = dp.keep;
      // (fix-loop10, LP10-2: `sent` the troops it left with and `state` its entry's state — an untouched host on a keep that
      //  is already its nation's did not take it)
      return { ...m, phase: 'stands', nowBell, troops: Math.floor(there[0].entry.troops / 1000), sent: m.troops ?? null, state: there[0].entry.state, faction: holding.faction,
        keep: k ? { holder: k.holder, contender: k.contender, progress: k.progress, required: k.required } : null };
    }
    // (fix-loop7, LP7-5: the destination's keep rides along when no host of this village stands there. A capture turns the
    //  holding host into the keep's garrison — it leaves the province's entries — so 'gone' with the keep now held by the
    //  village's nation is the capture, not a loss: verify-run fix-loop7, turn 451, keep holder = own nation, garrison 42)
    const k = dp.keep;
    return { ...m, phase: open ? 'settling' : 'gone', nowBell, faction: holding.faction,
      keep: k ? { holder: k.holder, contender: k.contender, progress: k.progress, required: k.required } : null };
  }
  async function decide(id, memory, { wideTargets, villages }) {
    if (!villages?.length) return { why: 'no wide village yet' };
    // (fix-loop9, LP9-1: at the cap the last march is still followed — its result is said — and the card says why no
    //  further march is planned, instead of 「いまは送れる一手がありません。」 alone)
    const capped = (memory.wideDeparts ?? 0) >= WIDE_DEPARTS_MAX;
    if (capped && !memory.lastWideDepart) return { why: `${WIDE_DEPARTS_MAX} wide marches sent`, wait: 'cap', cap: WIDE_DEPARTS_MAX };
    if ((memory.wideHostUntil ?? -1) > (memory.decisions ?? 0)) return { why: 'waiting for the last wide act to settle' };
    const program = id?.programId, seasonAddr = id?.seasonAddress;
    if (!program || !seasonAddr) return { why: 'the relay has not named its program and season yet' };
    const s = await herald.season();
    if (!s.ok) return { why: `season: ${s.code}` };
    const season = s.season, record = s.record, seasonId = String(season.seasonId);
    const world = worldIdOf(seasonAddr, program);
    const nowTs = await chainNow(), rate = chainRate(), nowBell = bellAt(seasonClock(season).genesisTs, nowTs);
    for (const v of villages) {
      const village = { p: String(v.p), q: String(v.q), site: v.site };
      const acc = wideVillageAccounts({ programId: program, seasonId, world, village });
      const [hb, pb, ...tb] = await read([acc.holding, acc.province, ...acc.transits]);
      if (!hb || !pb) continue;
      const holding = readWideHolding(hb), province = readWideProvince(pb);
      if (holding.state !== STATE_FINAL) return { why: `the wide village ${village.p},${village.q} is not final yet`, wait: 'village' };
      // (fix-loop5, L5-1) a province that has not caught up with the chain refuses EVERY act of its village (the
      //  muster's NotResident in loop-play5, 120–180 turns behind for ~40 min): nothing is planned — nothing is sent —
      //  until the runner has caught it up. `lag` lets the page say how far behind it is and wait by itself.
      if (province.resolvedNext + 1 < nowBell) return { why: `the province is resolved to ${province.resolvedNext}, the turn is ${nowBell}: the runner catches it up first`, wait: 'lag', lag: nowBell - province.resolvedNext };
      const hosts = wideHostsIn({ world, village, holding, province });
      const open = tb.filter(Boolean).length;
      if (capped) {
        const march = await marchState({ m: memory.lastWideDepart, nowBell, open: open > 0, world, village, holding, seasonAddr, program });
        // (a march still on its way, being decided or holding is followed as before; only an ended one is the cap's)
        if (march && ['out', 'settling', 'unread', 'stands'].includes(march.phase)) return { why: 'its host left: the march settles', wait: 'march', march };
        return { why: `${WIDE_DEPARTS_MAX} wide marches sent`, wait: 'cap', cap: WIDE_DEPARTS_MAX, ...(march ? { march } : {}) };
      }
      if (!hosts.length) {
        // (fix-loop6, LP6-5: where the march is — on its way, arrived and standing on the keep, settling, or gone — read
        //  from the destination province the host itself went to; loop-play6: 70+ turns of "its host is away" only)
        const march = (open || (memory.wideDeparts ?? 0) > 0) && memory.lastWideDepart
          ? await marchState({ m: memory.lastWideDepart, nowBell, open: open > 0, world, village, holding, seasonAddr, program }) : null;
        if (open) return { why: 'its host is away (a march is open)', wait: 'march', ...(march ? { march } : {}) };
        // (verify-pr173, D-verify-pr137-3: an ENDED march — its host is not at the destination and nothing is open: it
        //  became the keep's garrison on a capture, or it was destroyed — leaves the village with no host at all. The
        //  village raises a new one, as after a lost march (LP9-1 `rebuild`: offered once by the card, not sent by itself;
        //  the cap above still counts). Before, this waited for ever; a tab press hid it by wiping the page's memory —
        //  the march count with it — until loop-play10 LP10-1 kept that memory.)
        if ((memory.wideDeparts ?? 0) > 0 && march?.phase !== 'gone') return { why: 'its host left: the march settles', wait: 'march', ...(march ? { march } : {}) };
        if ((memory.wideDeparts ?? 0) > 0) {
          const after = { march, home: { hosts: 0, troops: 0 }, rebuild: true };
          if (holding.reserve[0] >= WIDE_MIN_HOST_TROOPS) {
            const troops = Math.min(holding.reserve[0], WIDE_HOST_TROOPS);
            return { ...after, decision: { name: WIDE_MUSTER, v: { wide: village }, fields: { unit: 0, troops, tile: holding.tile }, wideHostAct: true, rebuild: true,
              why: `a new host of ${troops} Spearmen at the wide village ${village.p},${village.q} (its last host did not come back from ${march.to?.p},${march.to?.q})` } };
          }
          return { ...after, decision: { name: WIDE_TRAIN, v: { wide: village }, fields: { unit: 0, n: 100 }, wideHostAct: true, rebuild: true,
            why: `train 100 Spearmen at the wide village ${village.p},${village.q} toward a new host (reserve ${holding.reserve[0]}; its last host did not come back from ${march.to?.p},${march.to?.q})` } };
        }
        if (holding.reserve[0] >= 100) {
          return { decision: { name: WIDE_MUSTER, v: { wide: village }, fields: { unit: 0, troops: Math.min(holding.reserve[0], WIDE_HOST_TROOPS), tile: holding.tile }, wideHostAct: true,
            why: `a host of ${Math.min(holding.reserve[0], WIDE_HOST_TROOPS)} Spearmen at the wide village ${village.p},${village.q}` } };
        }
        // (the cost is per started batch of 100 — fland trainingCost — so a smaller batch saves nothing: 100)
        const n = 100;
        return { decision: { name: WIDE_TRAIN, v: { wide: village }, fields: { unit: 0, n }, wideHostAct: true, why: `train ${n} Spearmen at the wide village ${village.p},${village.q} (reserve ${holding.reserve[0]})` } };
      }
      const host = hosts.find(h => h.entry.state === 1 && h.entry.pendOp === 0 && h.entry.readyBell <= nowBell && h.entry.troops >= MIN_HOST_MILLI);
      // (fix-loop9, LP9-1: a host under the march minimum never marches — its troops do not grow, and a local page cannot
      //  dissolve it — so waiting for it waited for ever: loop-play9, a beaten host came home with 87 of 100 and the card
      //  said 「軍勢が整列中か休んでいます。」 from turn ~426 to 600. When EVERY host here is under the minimum, the village
      //  raises a new one (the program allows several hosts of one nation in a province: proc/wide.rs muster_as,
      //  FACTION_CAP): train up to the minimum, then muster. The last march's result rides along so the card says it.)
      if (!host && hosts.every(h => h.entry.troops < MIN_HOST_MILLI)) {
        const march = (memory.wideDeparts ?? 0) > 0 && memory.lastWideDepart
          ? await marchState({ m: memory.lastWideDepart, nowBell, open: open > 0, world, village, holding, seasonAddr, program }) : null;
        if (open) return { why: 'its host is away (a march is open)', wait: 'march', ...(march ? { march } : {}) };
        const home = { hosts: hosts.length, troops: hosts.reduce((a, h) => a + Math.floor(h.entry.troops / 1000), 0) };
        const after = { ...(march ? { march } : {}), home, rebuild: true };
        if (holding.reserve[0] >= WIDE_MIN_HOST_TROOPS) {
          const troops = Math.min(holding.reserve[0], WIDE_HOST_TROOPS);
          return { ...after, decision: { name: WIDE_MUSTER, v: { wide: village }, fields: { unit: 0, troops, tile: holding.tile }, wideHostAct: true, rebuild: true,
            why: `a new host of ${troops} Spearmen at the wide village ${village.p},${village.q} (the ${home.troops} at home are under the march minimum ${WIDE_MIN_HOST_TROOPS})` } };
        }
        const n = 100;
        return { ...after, decision: { name: WIDE_TRAIN, v: { wide: village }, fields: { unit: 0, n }, wideHostAct: true, rebuild: true,
          why: `train ${n} Spearmen at the wide village ${village.p},${village.q} toward a new host (reserve ${holding.reserve[0]}; the ${home.troops} at home are under the march minimum ${WIDE_MIN_HOST_TROOPS})` } };
      }
      if (!host) return { why: `its host is forming or resting (${hosts.map(h => `state ${h.entry.state} op ${h.entry.pendOp} ready ${h.entry.readyBell}`).join('; ')})`, wait: 'host' };
      const slot = tb.findIndex(x => x === null);
      if (slot < 0) return { why: 'all four transit records are open' };
      // the neighbours: a keep held by another nation first
      const near = neighbourTargets(village, wideTargets);
      if (!near.length) return { why: 'no opened wide province next to the village' };
      // (one province per read: the page's local-act answers are capped at 16 KiB)
      const nb = [];
      for (const t of near) nb.push((await read([wideProvinceAddress(seasonAddr, program, t.p, t.q)]))[0]);
      const rows = near.map((t, i) => ({ t, pv: nb[i] ? readWideProvince(nb[i]) : null })).filter(x => x.pv?.keep);
      rows.sort((a, b) => Number(a.pv.keep.holder === holding.faction) - Number(b.pv.keep.holder === holding.faction) || (a.t.p + a.t.q < b.t.p + b.t.q ? -1 : 1));
      const origin = { p: village.p, q: village.q, tile: host.entry.tile };
      const source = { program, season: seasonAddr, seasonId, world, unit: host.entry.unit, faction: holding.faction, holdingFlags: 0, origin };
      const departTs = Math.floor(nowTs) + departMargin(rate);
      const tried = [];
      for (const { t, pv } of rows.slice(0, 3)) {
        const places = [t, village].map(x => Object.freeze({ key: canonicalWideProvinceKey({ world, p: x.p, q: x.q }), p: x.p, q: x.q }));
        let lands;
        try {
          const rr = await herald.wideRoute({ places, signal: AbortSignal.timeout(8000) });
          if (!rr?.ok) { tried.push(`${t.p},${t.q}: ${rr?.code ?? 'route'}`); continue; }
          lands = parseOutboundRouteCaptures(rr.json, { source, places }).lands;
        } catch (e) { tried.push(`${t.p},${t.q}: ${e.code ?? 'route'}`); continue; }
        const path = passablePath(world, origin, t, pv.keep.tile, lands);
        if (!path) { tried.push(`${t.p},${t.q}: no passable path to the keep tile ${pv.keep.tile}`); continue; }
        const probe = evaluateOutboundRoute({ source, directions: path.directions, lands, season, departTs, arriveBell: null, wideOrigin: true });
        if (probe.code !== 'ArrivalRequired' || !Number.isInteger(probe.min)) { tried.push(`${t.p},${t.q}: ${probe.code}`); continue; }
        const arriveBell = Math.min(probe.min + ARRIVAL_SLACK_BELLS, probe.max);
        const judged = evaluateOutboundRoute({ source, directions: path.directions, lands, season, departTs, arriveBell, wideOrigin: true });
        if (!judged.ok) { tried.push(`${t.p},${t.q}: ${judged.code}`); continue; }
        const prepared = prepareWideOutboundPlain({ world, host: host.ref, origin, directions: path.directions, arriveBell });
        const sealed = sealWideRequest({ plain: unpackWidePlain(fromHex(prepared.plainHex)), host: host.ref, arriveBell, clock: seasonClock(season), drand: record.drand,
          seasonPkHash: season.quicknetPkHash, seasonNetwork: season.network, cluster: record.cluster });
        if (!sealed.ok) return { why: `seal: ${sealed.code}` };
        const tip = String(tipOptions(season)[0].lamports);
        // (TEST PROBE, local evidence only: a caller that sets `memory.badSealProbe` gets ONE byte of the seal's masked
        //  body flipped — its IBE point stays valid, so the Depart's syntax check passes and the program's settlement
        //  judges it a bad seal (judge_wide's FO check: seal code 1 or 2). The AI residents never set it.)
        let sealHex = toHex(sealed.seal);
        if (memory.badSealProbe === true) { const b = fromHex(sealHex); b[110] ^= 0x01; sealHex = toHex(b); memory.badSealProbe = 'sent'; }
        return { decision: { name: WIDE_DEPART, v: { wide: village, standing: { p: village.p, q: village.q } },
          fields: { host: host.ref, transit_slot: slot, arrive_bell: arriveBell, tip, commit: toHex(sealed.commit), seal: sealHex }, wideHostAct: true, badSealProbe: memory.badSealProbe === 'sent' && sealHex !== toHex(sealed.seal),
          to: { p: t.p, q: t.q, tile: pv.keep.tile, holder: pv.keep.holder, keepTroops: pv.keep.troops }, from: origin, troops: Math.floor(host.entry.troops / 1000), nowBell,
          why: `the host (${Math.floor(host.entry.troops / 1000)} troops) marches wide -> wide from ${village.p},${village.q} onto the keep of ${t.p},${t.q} (tile ${pv.keep.tile}, held by nation ${pv.keep.holder}), arriving turn ${arriveBell}` } };
      }
      return { why: `no march planned (${tried.join('; ') || 'no neighbour with a keep'})` };
    }
    return { why: 'no wide village is readable yet' };
  }

  return Object.freeze({ decide });
}
