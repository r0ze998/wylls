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
 * `createWideHostPlanner({herald, read, chainNow, chainRate})` → `{decide(identity, memory, {wideTargets, villages})}`:
 * `{decision}` (one act for this turn) or `{why}`. `identity`: `{programId, seasonAddress}`; `memory`: the caller's
 * own counters (`wideDeparts`, `wideHostUntil`, `decisions`, `wideTrainN`); `villages`: `[{p, q, site}]`.
 */
export function createWideHostPlanner({ herald, read, chainNow, chainRate = () => 1 }) {
  async function decide(id, memory, { wideTargets, villages }) {
    if (!villages?.length) return { why: 'no wide village yet' };
    if ((memory.wideDeparts ?? 0) >= WIDE_DEPARTS_MAX) return { why: `${WIDE_DEPARTS_MAX} wide marches sent` };
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
      if (holding.state !== STATE_FINAL) return { why: `the wide village ${village.p},${village.q} is not final yet` };
      const hosts = wideHostsIn({ world, village, holding, province });
      const open = tb.filter(Boolean).length;
      if (!hosts.length) {
        if (open) return { why: 'its host is away (a march is open)' };
        if ((memory.wideDeparts ?? 0) > 0) return { why: 'its host left: the march settles' };
        if (holding.reserve[0] >= 100) {
          return { decision: { name: WIDE_MUSTER, v: { wide: village }, fields: { unit: 0, troops: Math.min(holding.reserve[0], WIDE_HOST_TROOPS), tile: holding.tile }, wideHostAct: true,
            why: `a host of ${Math.min(holding.reserve[0], WIDE_HOST_TROOPS)} Spearmen at the wide village ${village.p},${village.q}` } };
        }
        // (the cost is per started batch of 100 — fland trainingCost — so a smaller batch saves nothing: 100)
        const n = 100;
        return { decision: { name: WIDE_TRAIN, v: { wide: village }, fields: { unit: 0, n }, wideHostAct: true, why: `train ${n} Spearmen at the wide village ${village.p},${village.q} (reserve ${holding.reserve[0]})` } };
      }
      const host = hosts.find(h => h.entry.state === 1 && h.entry.pendOp === 0 && h.entry.readyBell <= nowBell && h.entry.troops >= 100_000);
      if (!host) return { why: `its host is forming or resting (${hosts.map(h => `state ${h.entry.state} op ${h.entry.pendOp} ready ${h.entry.readyBell}`).join('; ')})` };
      if (province.resolvedNext + 1 < nowBell) return { why: `the province is resolved to ${province.resolvedNext}, the turn is ${nowBell}: the runner catches it up first` };
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
