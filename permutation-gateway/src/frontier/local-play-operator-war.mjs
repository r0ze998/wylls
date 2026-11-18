// LOCAL PLAY, TEST-ONLY — operator AI residents at war (owner t359u, 2026-11-19: march / siege / capture in the real
// local world, same rules): the DECISION side, key-free, pure. Nothing here reads, signs or sends.
//
// A war resident is still an ordinary participant (local-play-operator-policy.mjs): its own wallet, its own relay, the
// page's own commands. What it adds is the page's own march — Depart, sealed and sent by the page's own code
// (fmarch.mjs sendMarch through flocalplay-march.mjs) — aimed by the page's own target finder (fkeepreach.mjs
// reachableKeeps: keeps of other nations a march can reach, and the resident's own nation's keeps under contest).
// In this lane "siege" and "capture" ARE the keep contest of the rules (permutation-rules keep.rs `advance`): a host of
// exactly one hostile nation on a keep's tile counts one turn per resolved turn; a defender of the holding nation on
// the tile breaks it; at `required` (72) the keep is taken. A village siege (DeclareSiege) has no local-play route; it
// is never asked for here.
//
// The rule, one action per resident per turn (owner Q16-2), every choice ordered by a fixed key (no randomness; the
// world's own seed decides the map, so a run is reproducible per seed):
//   1. defend  — a ready host and an own keep under contest it can reach: march there (Hold).
//   2. attack  — a ready host strong enough for a reachable foreign keep (host troops ≥ ATTACK_RATIO × the keep's
//                garrison, and ≥ MIN_HOST): march to the best one (score: strength step table, then travel time,
//                then place) — the strength-ratio step table of Unciv's MotivationToAttackAutomation, the "march only
//                when ≥ 1.5× the defence" margin of frontier-sim's campaign bots (sim_campaign.rs GROUP_MARGIN).
//   3. muster  — no ready host that can attack, and the village's reserve has at least MUSTER_MIN troops: form a host
//                of the whole reserve (keepBack troops stay home), at most MAX_HOSTS hosts.
//   4. train   — otherwise Train TRAIN_BATCH (a refused Train cools down, as in the base rotation).
//   5. economy — the base rotation (Harvest / Build) when nothing above applies.
// A host standing on a foreign keep's tile is holding it: it is never moved while that keep is contested by its nation.
// Hosts that left the home province are only ordered again once they are back and ready (the page's own rule: a host
// departs from where it stands; this resident only marches hosts it can see at home or on a keep it no longer needs).

export const OPERATOR_WAR_MODE = 'operator-war-v1';
/** A war world takes at most this many operator residents (two per nation). */
export const OPERATOR_WAR_MAX = 12;
/** The rules' smallest host (permutation-rules host.rs MIN_HOST_TROOPS). */
export const MIN_HOST = 100;
/** March on a foreign keep only with at least this many times its garrison (frontier-sim GROUP_MARGIN 1.5). */
export const ATTACK_RATIO = 1.5;
/** Muster once the reserve holds this many troops (a host this size beats a fresh keep's guard of 100 by the ratio). */
export const MUSTER_MIN = 300;
/** Troops one Train asks for. */
export const TRAIN_BATCH = 100;
/** At most this many hosts per resident at once. */
export const MAX_HOSTS = 3;
/** A war resident's refused Train / Muster / Depart waits this many turns before it is asked for again. */
export const WAR_COOLDOWN_BELLS = 3;
/** Troops left at home when mustering. */
export const KEEP_BACK = 0;

/** Strength step table (Unciv MotivationToAttackAutomation, integer form): ratio in hundredths → score. */
export function strengthScore(hostTroops, guardTroops) {
  const g = Math.max(1, Number(guardTroops) || 0);
  const r = Math.floor((Number(hostTroops) * 100) / g);
  if (r >= 500) return 20;
  if (r >= 200) return 10;
  if (r >= 140) return 4;
  if (r >= 120) return 2;
  return -5;
}

/** Whether `host` (whole troops) may march on a keep guarded by `guard` (whole troops). */
export function strongEnough(hostTroops, guardTroops) {
  return Number(hostTroops) >= MIN_HOST && Number(hostTroops) * 2 >= Math.ceil(ATTACK_RATIO * 2 * Math.max(0, Number(guardTroops) || 0));
}

/**
 * The resident's own hosts that may be ordered now: `[{id, unit, tile, p, q, troops, ready}]` from `hosts` (the page's
 * fland.hostsIn rows, each with its province `p, q`), excluding any host in transit or busy, any host that is holding a
 * foreign keep its nation contests (`holding(host)`), and — as fmarch.checkMarch — any host not past its ready bell or
 * short of the departure stamina.
 */
export function orderableHosts(hosts, { nowBell, departStamina, holdingKey = () => false }) {
  return (hosts ?? []).filter(h => h && h.state === 1 && !h.inTransit && (h.pending ?? 0) === 0 && nowBell >= (h.readyBell ?? 0)
    && (h.stamina ?? 0) >= departStamina && !holdingKey(h))
    .sort((a, b) => b.troops - a.troops || String(a.id).localeCompare(String(b.id)));
}

/**
 * The march to order, or null: from the reachable list (fkeepreach.reachableKeeps rows, each `{p, q, tile, holder,
 * troops, route, origin: {host, troops}, defend?}`) for the orderable hosts. Defence first (nearest), then the attack
 * with the best (strength score, −travel time, p, q). `taken(row)`: a keep another of this resident's hosts is already
 * marching on or holding (never doubled).
 */
export function chooseMarch(rows, { taken = () => false } = {}) {
  const ok = (rows ?? []).filter(r => r && r.origin && !taken(r));
  const defend = ok.filter(r => r.defend).sort((a, b) => a.route.secs - b.route.secs || a.p - b.p || a.q - b.q);
  if (defend.length) return Object.freeze({ kind: 'defend', row: defend[0] });
  const attack = ok.filter(r => !r.defend && strongEnough(r.origin.troops, r.troops))
    .map(r => ({ r, s: strengthScore(r.origin.troops, r.troops) }))
    .sort((a, b) => b.s - a.s || a.r.route.secs - b.r.route.secs || a.r.p - b.r.p || a.r.q - b.r.q);
  return attack.length ? Object.freeze({ kind: 'attack', row: attack[0].r, score: attack[0].s }) : null;
}

/**
 * The war step for one resident with a village, or null (the base rotation then decides): `war = {settling, reserve
 * (whole troops of unit 0 at home), hostCount, march: chooseMarch(…) | null, refused: {Train?, Muster?} cooldown flags}`.
 * → `{name: 'Depart', row, kind}` | `{name: 'Muster', troops}` | `{name: 'Train', n}` | null.
 */
export function warStep(war) {
  if (!war) return null;
  // (the village's province has not settled this turn: a march or a muster would be refused NotResident — the page
  //  waits for the settle too; meanwhile the turn may train)
  if (war.settling) return !war.refused?.Train && (war.reserve ?? 0) < MUSTER_MIN * 2 ? Object.freeze({ name: 'Train', n: TRAIN_BATCH }) : null;
  if (war.march) return Object.freeze({ name: 'Depart', kind: war.march.kind, row: war.march.row });
  const room = (war.hostCount ?? 0) < MAX_HOSTS;
  const musterable = Math.max(0, (war.reserve ?? 0) - KEEP_BACK);
  if (room && musterable >= MUSTER_MIN && !war.refused?.Muster) return Object.freeze({ name: 'Muster', troops: musterable });
  if (!war.refused?.Train && (war.reserve ?? 0) < MUSTER_MIN * 2) return Object.freeze({ name: 'Train', n: TRAIN_BATCH });
  return null;
}

/**
 * One action per resident per turn (owner Q16-2): whether a resident that last acted at `lastBell` may act at
 * `nowBell`. Join is exempt (it has no village and no turn of its own yet), as the relay's rule (PR #62) has it.
 */
export function mayActThisTurn(lastBell, nowBell, name) {
  if (name === 'Join') return true;
  if (!Number.isSafeInteger(nowBell)) return false;
  return !Number.isSafeInteger(lastBell) || nowBell > lastBell;
}

/** Heartland sites for a war resident: the OUTERMOST ring first (nearest the contestable land), then by place. */
export function warHomeOrder(candidates) {
  const ring = (p, q) => Math.max(Math.abs(p), Math.abs(q), Math.abs(p + q));
  return [...(candidates ?? [])].sort((a, b) => ring(b.p, b.q) - ring(a.p, a.q) || a.p - b.p || a.q - b.q || a.site - b.site);
}
