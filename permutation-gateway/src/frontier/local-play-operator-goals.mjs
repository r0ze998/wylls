// LOCAL PLAY, TEST-ONLY — operator AI residents and the world's goals (docs/design/win-conditions/01-proposal.ja.md §10
// F4 「運営の AI 住民が旗の砦を狙うように」, §8 AI = players, §9 anti-snowball): the DECISION side, key-free, pure.
//
// The flag-keeps judge (local-play-world-goals.mjs, #198) posts, per round, which keeps carry the flag; a war resident
// (local-play-operator-war.mjs) picks its march targets by strength and distance only. This module tells it what the
// posting means FOR ITS NATION, using only what that nation's player view shows (the 「世界の目標」 card, hud/worldgoals.mjs,
// under the fog of war of map/fog.mjs):
//   - the posting itself (round, need, hold time, the flag keeps and the nation each was drawn for) — public;
//   - every nation's count of flag keeps held and held long — public on the card (its nations line);
//   - each flag keep's holder, contender and siege progress ONLY as the resident's fogged keeps show it (map/fog.mjs
//     fogKeeps over the resident's own survey: its villages and hosts, its nation's held provinces): live in sight,
//     the last-known holder (never a contest) when seen before, nothing when never seen. The nation's own keeps are
//     always known (as on the page). The judge's answer carries every flag's live holder: it is NOT read here.
//   - never another nation's `reachAt` (the card does not show it).
//
// The weighting (fixed, no randomness; a run is reproducible per world seed):
//   defend-flag  an own flag keep under contest by another nation: defended before any other keep (the existing defence
//                rule otherwise: nearest first).
//   stop-rival   a flag keep held by a nation that is close to completing the round (holds ≥ need − 1 flag keeps): its
//                attack score + STOP_RIVAL_BONUS (above the best ordinary score, so it is chosen over ordinary attacks
//                when in reach and strong enough). The attack's safety (≥ MIN_HOST, ≥ ATTACK_RATIO × the garrison) is
//                unchanged: a weak host is never sent at a flag.
//   flag         any other flag keep held by another nation that the resident sees: + FLAG_BONUS (a tie-breaker between
//                attacks of about the same strength — ordinary war otherwise).
// Anti all-in (§9, the brief's "no all-in on flags"): a resident with FLAG_MARCH_CAP of its own marches already on flag
// keeps (marching or holding, its memory's `targets`) gets no attack weight for flags until one ends — its other hosts
// fight the ordinary war. Defence is never capped (it was the first rule before this module too).
// References compared (see reports/flag-keeps-ai.md): 0 A.D. Petra victoryManager (victory-condition entities guarded as
// "critical"), Unciv MotivationToAttackAutomation (score table this adds a bonus to), TripleA/Athena Crisis requests to
// rank victory targets first — here as a bounded bonus, not an override, so ordinary war remains.
import { NATIONS } from './world-goals.mjs';

/** Added to the attack score of a flag keep held by a nation close to completing (above strengthScore's best, 20). */
export const STOP_RIVAL_BONUS = 25;
/** Added to the attack score of any other seen flag keep held by another nation (below one strength step, 10 → 20). */
export const FLAG_BONUS = 3;
/** A resident's own marches on flag keeps at once before flags weigh nothing more for its attacks. */
export const FLAG_MARCH_CAP = 1;

const nation = f => Number.isInteger(f) && f >= 0 && f < NATIONS;
const int = Number.isSafeInteger;
const key = (p, q) => `${p},${q}`;

/**
 * What the resident of nation `faction` may know of the posting: `{round, need, holdBells, flags: [{p, q, nation,
 * holder, contender, progress, seen}], nations: [{nation, held, heldLong}]}` or null (no posting / a bad answer).
 * `answer`: the judge's `GET …/goals/state` body; `seenKeeps`: Map "p,q" → keep as map/fog.mjs fogKeeps gives it for
 * this resident (a keep with `fog: 'memory'` is last-known; absent = never seen).
 */
export function flagSight({ answer, faction, seenKeeps }) {
  const fk = answer?.flagKeeps;
  if (!answer || answer.ok !== true || answer.kind !== 'world-goals' || !fk || !Array.isArray(fk.flags) || !int(fk.need) || fk.need < 1) return null;
  const flags = [];
  for (const f of fk.flags) {
    if (!f || !int(f.p) || !int(f.q)) continue;
    const k = seenKeeps?.get?.(key(f.p, f.q)) ?? null;
    if (!k) { flags.push(Object.freeze({ p: f.p, q: f.q, nation: f.nation, holder: null, contender: null, progress: 0, seen: 'never' })); continue; }
    const memory = k.fog === 'memory';
    flags.push(Object.freeze({ p: f.p, q: f.q, nation: f.nation, holder: nation(k.holder) ? k.holder : null,
      contender: !memory && nation(k.contender) && k.contender !== k.holder ? k.contender : null, progress: memory ? 0 : Number(k.progress ?? 0), seen: memory ? 'memory' : 'live' }));
  }
  const nations = (Array.isArray(fk.progress) ? fk.progress : []).filter(x => x && nation(x.nation) && int(x.held) && int(x.heldLong))
    .map(x => Object.freeze({ nation: x.nation, held: x.held, heldLong: x.heldLong }));
  return Object.freeze({ round: fk.round, need: fk.need, holdBells: fk.holdBells, flags: Object.freeze(flags), nations: Object.freeze(nations), faction });
}

/** The nations (not `faction`) close to completing: held ≥ need − 1 (and ≥ 1). → Set. */
export function closeRivals(sight, faction) {
  const out = new Set();
  if (!sight) return out;
  for (const x of sight.nations) if (x.nation !== faction && x.held >= Math.max(1, sight.need - 1)) out.add(x.nation);
  return out;
}

/**
 * The weights of the flag keeps for one resident: Map "p,q" → `{goal: 'defend-flag' | 'stop-rival' | 'flag', bonus}`.
 * `busy`: how many of the resident's own marches are already on flag keeps (FLAG_MARCH_CAP: no attack weight then).
 */
export function flagWeights(sight, faction, { busy = 0 } = {}) {
  const out = new Map();
  if (!sight || !nation(faction)) return out;
  const rivals = closeRivals(sight, faction);
  const attackOk = busy < FLAG_MARCH_CAP;
  for (const f of sight.flags) {
    if (f.holder === faction) {
      if (nation(f.contender) && f.contender !== faction) out.set(key(f.p, f.q), Object.freeze({ goal: 'defend-flag', bonus: 0 }));
      continue;
    }
    if (!attackOk || !nation(f.holder)) continue;
    out.set(key(f.p, f.q), rivals.has(f.holder) ? Object.freeze({ goal: 'stop-rival', bonus: STOP_RIVAL_BONUS, rival: f.holder }) : Object.freeze({ goal: 'flag', bonus: FLAG_BONUS }));
  }
  return out;
}

/** How many of a resident's live march targets (memory.targets: "p,q" → bell until) are flag keeps of the posting. */
export function flagMarches(targets, sight, nowBell) {
  if (!sight || !targets) return 0;
  const flags = new Set(sight.flags.map(f => key(f.p, f.q)));
  return Object.entries(targets).filter(([k, until]) => flags.has(k) && int(until) && until >= nowBell).length;
}

/** The judge's answer from the launcher, or null. `url`: loopback only. */
export async function readGoals(url, { fetch: f = (...a) => globalThis.fetch(...a) } = {}) {
  if (typeof url !== 'string' || !/^http:\/\/(127\.0\.0\.1|localhost):\d{4,5}\/goals-world\/\d{5}\/goals\/state$/.test(url)) return null;
  try {
    const r = await f(url, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) return null;
    const j = await r.json();
    return j?.ok === true && j.kind === 'world-goals' ? j : null;
  } catch { return null; }
}
