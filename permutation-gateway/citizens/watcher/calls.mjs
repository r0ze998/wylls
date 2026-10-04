// AC6: the Strike Order ("Call" in code, section 0.4): the tile and the invited hosts fixed at the close (section 6.5 step 6) and the
// strike result at S + 2 (step 7). The council store (AC4) draws the nonce, publishes `call_commit`, hands the Call to members and
// opens it at S + 2; this file supplies what only the watcher can read: the immutable herald files of bell C0 + 5 and, after the
// strike, the REVEAL and CLASH records.
//
// Pure part (vectors in test/citizens-watcher-calls.test.mjs):
//   tileFor({kind, pv, faction, strikeBell, hint})     the tile of the target: strike = the largest enemy stack, camp = the camp tile,
//                                                      raid = the village tile; the hint (the tile at C0 - 2) when the file shows none
//   invitedOrder({hosts, voterTags, limit})            the faction's resident combat hosts, ordered (1) owners whose ballot chose the
//                                                      winner, (2) troops desc, ties by host id; the first six
//   strikeResult({...})                                present, bounced, displaced armies and the clash at (p, q, tile, S)
// Job part: createCalls(...) -> {closeCall(f, k), sealPending(bell), resultStep(bell)}.
//
// Nothing here is published before its time: the target and the tile reach only the council store (members read them by a signed
// read); the result is written at S + 2 when the Call opens.
import { ball, largestEnemyStack, bestRaidVillage, mapLimit, MILLI } from './council_gen.mjs';
import { SCOUT, STATE_ROSTER } from './feed.mjs';
import { MAX_INVITED } from '../social/council.mjs';

export const INVITE_RADIUS = 2;
const idCompare = (a, b) => { const x = BigInt(a), y = BigInt(b); return x < y ? -1 : x > y ? 1 : 0; };

/** The tile of the Call from the province envelope of bell C0 + 5, or the hint when the file shows nothing there. Returns an integer or null. */
export function tileFor({ kind, pv, faction, strikeBell, hint = null }) {
  const fallback = Number.isInteger(hint?.tile) ? hint.tile : null;
  if (!pv) return fallback;
  if (kind === 'strike') {
    const s = largestEnemyStack(pv, faction);
    return s ? s.tile : fallback;
  }
  if (kind === 'camp') return pv.camp && Number.isInteger(pv.camp.tile) && pv.camp.state === 1 ? pv.camp.tile : fallback;
  if (kind === 'raid') {
    const v = bestRaidVillage(pv, faction, strikeBell);
    return v ? v.tile : fallback;
  }
  return fallback;
}

/**
 * The invited list: `hosts` = [{id, owner, troops}] (the faction's resident combat hosts within 2 provinces of the target, from the files
 * of bell C0 + 5), `voterTags` = the citizen tags whose ballot chose the winner. Order: voters first, then troops desc, then host id;
 * the first `limit` (six: more than the four arrival slots, to allow for unready hosts). Returns decimal host id strings.
 */
export function invitedOrder({ hosts, voterTags = new Set(), limit = MAX_INVITED }) {
  const voted = voterTags instanceof Set ? voterTags : new Set(voterTags);
  return [...hosts]
    .sort((a, b) => (voted.has(a.owner) ? 0 : 1) - (voted.has(b.owner) ? 0 : 1) || Number(b.troops) - Number(a.troops) || idCompare(a.id, b.id))
    .slice(0, limit)
    .map(h => String(h.id));
}

const FATE_BOUNCED = new Set(['Bounced', 'BouncedUnranked']);

/**
 * The strike result (section 6.5 step 7). `reveals` = the REVEAL rows with arrive = S for the Call's province (any nation); `detail` =
 * the clash with before/after troops per fighter (feed.clashDetail) or null. Present = the nation's armies that arrived (bounced or
 * displaced ones count as present and are listed separately). The clash part reports the engaged fighters on the Call's tile.
 */
export function strikeResult({ faction, p, q, tile, strikeBell, reveals, detail }) {
  const mine = reveals.filter(r => r.faction === faction);
  const fighters = detail?.fighters ?? [];
  const byId = new Map(fighters.map(f => [String(f.id), f]));
  const bounced = mine.filter(r => FATE_BOUNCED.has(byId.get(String(r.host_id))?.fate)).map(r => String(r.host_id));
  const displaced = mine.filter(r => Number(r.displace) > 0 || (r.displaced_host && r.displaced_host !== '0')).map(r => String(r.host_id));
  let clash = null;
  if (detail) {
    const onTile = fighters.filter(f => f.tile === tile);
    const engaged = onTile.filter(f => f.engaged);
    const lost = {};
    for (const f of engaged) {
      if (f.lost == null || !Number.isInteger(f.faction)) continue;
      lost[f.faction] = (lost[f.faction] ?? 0) + Math.floor(f.lost / MILLI);
    }
    clash = { p, q, tile, bell: strikeBell, engagements: detail.engagements ?? 0, fighters_on_tile: onTile.length, engaged_on_tile: engaged.length, lost };
  }
  return {
    present: mine.length, present_hosts: mine.map(r => String(r.host_id)).sort(idCompare),
    bounced: bounced.length, bounced_hosts: bounced.sort(idCompare),
    displaced: displaced.length, displaced_hosts: displaced.sort(idCompare),
    clash,
  };
}

/**
 * createCalls({feed, social, roster, census, hintOf, stats, onError, onResult})
 *   hintOf(f, k, option) -> {tile}|null  (the option's tile at C0 - 2, from the council job)
 *   onResult({faction, period, result, call}) is called once when a result is written (the chronicle line)
 */
export function createCalls({ feed, social, roster, census, hintOf = () => null, stats = {}, onError = () => {}, onResult = () => {}, fetchLimit = 8 } = {}) {
  const council = social?.council ?? null;
  const bump = (k, n = 1) => { stats[k] = (stats[k] ?? 0) + n; };
  const resultTried = new Set();

  /**
   * Fix the Call of nation f, period k: `{tile, invited}` or null when the herald files of bell C0 + 5 are not served yet (the
   * council store then leaves the Call unsealed and `sealPending` retries every tick until S - 1).
   */
  async function closeCall(f, k) {
    const w = council?.winner?.(f, k);
    if (!w?.adopted) return null;
    const bell = w.c0 + 5;
    const strikeBell = w.c0 + 6 + (council.config?.strike_lead ?? 6);
    const around = ball(w.p, w.q, INVITE_RADIUS);
    const files = new Map();
    let missing = 0;
    await mapLimit(around, fetchLimit, async c => {
      let pv = null;
      try { pv = await feed.provinceAt(c.p, c.q, bell); } catch (e) { onError(e); }
      if (pv) files.set(`${c.p},${c.q}`, pv); else missing++;
    });
    const target = files.get(`${w.p},${w.q}`) ?? null;
    // the files of bell C0 + 5 appear about two bells after it. Until the log is three bells past it, every file counts (a missing one
    // may only be late: the target's and its neighbours'); after that a province still missing is taken as absent (no such
    // province, or none served) and the Call is fixed with what is there (the tile then falls back to the hint)
    const waited = (feed.headBell?.() ?? -1) >= bell + 3;
    if (!waited && (!target || missing > 0)) return null;
    const hint = hintOf(f, k, w.option);
    const tile = tileFor({ kind: w.kind, pv: target, faction: f, strikeBell, hint });
    if (!Number.isInteger(tile)) { bump('call_no_tile'); return null; }
    const voterTags = new Set();
    for (const wallet of w.voters?.[w.option] ?? []) { const t = census.tagOfWallet(wallet); if (t) voterTags.add(t); }
    const hosts = [];
    for (const pv of files.values()) {
      for (const h of pv.hosts ?? []) if (h.state === STATE_ROSTER && h.unit !== SCOUT && h.faction === f) hosts.push({ id: h.id, owner: h.owner, troops: h.troops });
    }
    const invited = invitedOrder({ hosts, voterTags });
    return { tile, invited, meta: { bell, provinces: files.size, missing, voters: voterTags.size, hosts: hosts.length } };
  }

  /** Retry the sealing of an adopted Call whose files were not ready at the close, until S - 1. */
  async function sealPending(bell) {
    if (!council?.latest) return;
    for (const f of new Set(roster.ai.map(a => a.faction))) {
      const P = council.latest(f);
      if (!P?.outcome?.adopted || P.call) continue;
      const S = P.c0 + 6 + (council.config?.strike_lead ?? 6);
      if (bell >= S) { bump('call_unsealed_too_late'); continue; }
      let fixed = null;
      try { fixed = await closeCall(f, P.period); } catch (e) { bump('call_seal_errors'); onError(e); }
      if (fixed && Number.isInteger(fixed.tile)) {
        try { council.seal(f, P.period, { tile: fixed.tile, invited: fixed.invited }); bump('calls_sealed_late'); } catch (e) { bump('call_seal_errors'); onError(e); }
      }
    }
  }

  /** The strike result of one period, from the public log, once the feed is complete through S + 2. Writes it into the council file. */
  async function result(f, k) {
    const P = council?.periodOf?.(f, k);
    if (!P?.call || !P.openFile) return null;
    if (P.result) return P.result;
    const { p, q, tile, strike_bell: S } = P.call;
    if ((feed.completeThrough?.() ?? -1) < S + 2) return null;
    const reveals = [];
    for (let b = S - 1; b <= S + 3; b++) {
      for (const ev of feed.events(b)) if (ev.kind === 'REVEAL' && ev.arrive === S && ev.p === p && ev.q === q) reveals.push(ev);
    }
    let detail = null;
    try { detail = await feed.clashDetail(p, q, S); } catch (e) { onError(e); }
    const res = strikeResult({ faction: f, p, q, tile, strikeBell: S, reveals, detail });
    council.setResult(f, k, res);
    bump('strike_results');
    onResult({ faction: f, period: k, result: res, call: { p, q, tile, kind: P.call.kind, strike_bell: S, option: P.call.option } });
    return res;
  }

  /** Write the result of every opened Call that has none yet. */
  async function resultStep() {
    if (!council?.latest) return;
    for (const f of new Set(roster.ai.map(a => a.faction))) {
      const P = council.latest(f);
      if (!P?.call || !P.openFile || P.result) continue;
      const id = `${f}|${P.period}`;
      if (resultTried.has(id) && (feed.completeThrough?.() ?? -1) < P.call.strike_bell + 2) continue;
      try { if (await result(f, P.period)) resultTried.add(id); } catch (e) { bump('result_errors'); onError(e); }
    }
  }

  return { closeCall, sealPending, result, resultStep };
}
