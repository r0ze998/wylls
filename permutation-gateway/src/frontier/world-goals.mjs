// The world's goals in a continuous world (docs/design/win-conditions/01-proposal.ja.md, PR #191 rev 2; owner r0ze
// 2026-11-24 01:04 JST accepted every recommendation): four permanent goals without a deadline — flag keeps
// (hegemony), world-first technology, wonder, unexplored mark. FIRST SLICE: only the flag keeps are judged, off chain,
// and NO money moves: the prize a nation would have won is computed from a SIMULATED vault and shown as such.
//
// The judge is a pure function of public chain state (the same pattern as ⑮'s judge: read only, anyone who reads the
// same accounts gets the same answer):
//
//   designate   flag keeps = 2 per nation (nations × 2), drawn from each nation's own non-heartland keeps, border keeps
//               first, ordered by sha256(seed ‖ round ‖ p ‖ q) — the seed is the Season's drand-derived GENESIS_SEED
//               (round 1) and a hash of it with the round and the bell of the last achievement afterwards.
//   progress    per nation: flag keeps held now, and held long enough — a keep counts from max(its since_bell, the bell
//               the round was posted) and is "held long" once `holdBells` bells have passed since then.
//   achieve     a nation holding `need` (half of the flag keeps, rounded up) flag keeps, each held long, achieves the
//               round at the bell the need-th of them reached its hold time. Two nations at the same bell: a tie.
//   points      the contribution ledger of achievements.mjs (capture 10, reinforcement 1 per 100 troops up to 10 per
//               keep, prize-params.json) over the achieving nation's flag keeps held long, at the achievement read.
//   prize       (SIMULATED) the hegemony vault's payout share goes to the nation(s); inside a nation, in proportion to
//               the points of eligible members (permutation-prize share_amount: floor, dust stays in the vault).
//               Operator AI residents earn points and titles like people but receive no money: their points leave the
//               denominator (Q17 b). Eligible = a person with a (simulated) valid pass, a member `memberBells` before
//               the achievement. No eligible member: the nation's part stays in the vault.
import { createHash } from 'node:crypto';

export const WORLD_GOALS_KIND = 'world-goals';
export const WORLD_GOALS_VERSION = 1;
export const FLAG_KEEPS_RULESET = 'flag-keeps-v1';
export const NATIONS = 6;
/** A turn (bell) is 10 minutes of the chain's clock: 144 bells = 24 hours. */
export const BELLS_PER_DAY = 144;
/** Keep flags bit 0 (frontier-abi province.rs FLAG_HEARTLAND_SAFE): never contested. */
export const KEEP_FLAG_HEARTLAND = 1;
export const NO_FACTION = 255;
/** Axial neighbours of a province. */
export const PROVINCE_DIRS = Object.freeze([[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]]);

/** The four goals; only the flag keeps are live in this slice. */
export const GOAL_KINDS = Object.freeze([
  Object.freeze({ id: 'flag-keeps', kind: 'hegemony', live: true }),
  Object.freeze({ id: 'world-first-tech', kind: 'science', live: false }),
  Object.freeze({ id: 'wonder', kind: 'construction', live: false }),
  Object.freeze({ id: 'unexplored-mark', kind: 'exploration', live: false }),
]);

/**
 * The rules of the flag keeps (§4.1, Q21; prize §7, Q13–Q17, Q19). Every value is the owner-accepted recommendation;
 * `holdBells`, `memberBells` and `need` may be overridden for a TEST world only (the launcher's TEST flags).
 */
export const FLAG_KEEPS_DEFAULTS = Object.freeze({
  perNation: 2,
  need: null, // null: half of the flag keeps, rounded up
  holdBells: BELLS_PER_DAY,
  memberBells: BELLS_PER_DAY,
  contribution: Object.freeze({ capturePoints: 10, reinforcementPer100Troops: 1, reinforcementMaxPerKeep: 10 }),
  // (SIMULATED vault: what a 30-day pass would have paid in — E2, 25 test USDC, 80 % to the prize; while only the
  //  hegemony goal is built, every kind's share of the prize is kept for it — §7.2; one achievement pays 30 % of it)
  prize: Object.freeze({ simulated: true, asset: 'test USDC', decimals: 6, passFee: 25_000_000, prizeBps: 8000, hegemonyBps: 10_000, payoutBps: 3000, minPayout: 10_000 }),
});

const u32le = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const i32le = n => { const b = Buffer.alloc(4); b.writeInt32LE(n | 0); return b; };
const hex = b => Buffer.from(b).toString('hex');
const sha256 = (...parts) => createHash('sha256').update(Buffer.concat(parts.map(p => Buffer.from(p)))).digest();
const keyOf = (p, q) => `${p},${q}`;
const isNation = f => Number.isInteger(f) && f >= 0 && f < NATIONS;

/** The need of a round with `k` flag keeps: half, rounded up (6 of 12), unless overridden. */
export const needOf = (k, rules = FLAG_KEEPS_DEFAULTS) => (Number.isInteger(rules.need) && rules.need > 0 ? Math.min(rules.need, k) : Math.ceil(k / 2));

/** The seed of round `round` (1-based): round 1 the Season's seed; later rounds a hash of it, the round and the bell of the last achievement. */
export function roundSeed(genesisSeed, round, lastAchievedBell = 0) {
  const g = Buffer.from(genesisSeed);
  if (g.length !== 32) throw new Error('genesis seed must be 32 bytes');
  return round === 1 ? hex(g) : hex(sha256('wylls-flag-keeps-round', g, u32le(round), u32le(lastAchievedBell)));
}

/** The order of a keep in a round: sha256(seed ‖ round ‖ p ‖ q), as hex. */
export const rankOf = (seedHex, round, p, q) => hex(sha256(Buffer.from(seedHex, 'hex'), u32le(round), i32le(p), i32le(q)));

/**
 * The keeps of the chain, as the judge reads them: `[{p, q, holder, since, heartland, troops, tile, contender}]` (one
 * per Province with a keep). Normalises the decoded Province accounts' KEEP[0].
 */
export function keepFromProvince(province) {
  const k = province.KEEP[0];
  if (Number(k.TILE) === 0xff) return null;
  return { p: Number(province.P), q: Number(province.Q), ring: Number(province.RING), holder: Number(k.HOLDER), since: Number(k.SINCE_BELL), heartland: (Number(k.FLAGS) & KEEP_FLAG_HEARTLAND) !== 0,
    troops: Number(k.TROOPS), tile: Number(k.TILE), contender: Number(k.CONTENDER), progress: Number(k.PROGRESS), required: Number(k.REQUIRED) };
}

/** Whether a keep borders a province held by another nation (an open neighbour whose keep has another holder). */
export function isBorder(keep, byKey) {
  return PROVINCE_DIRS.some(([dp, dq]) => { const n = byKey.get(keyOf(keep.p + dp, keep.q + dq)); return n && n.holder !== keep.holder; });
}

/**
 * Designate the flag keeps of a round: for every nation that holds a non-heartland keep, `perNation` of its own keeps,
 * border keeps first, then by `rankOf`. → `[{p, q, nation, border, rank}]` sorted by (nation, rank).
 */
export function designate({ keeps, seed, round, perNation = FLAG_KEEPS_DEFAULTS.perNation }) {
  const byKey = new Map(keeps.map(k => [keyOf(k.p, k.q), k]));
  const out = [];
  for (let n = 0; n < NATIONS; n++) {
    const mine = keeps.filter(k => k.holder === n && !k.heartland).map(k => ({ p: k.p, q: k.q, nation: n, border: isBorder(k, byKey), rank: rankOf(seed, round, k.p, k.q) }));
    mine.sort((a, b) => (a.border === b.border ? (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0) : a.border ? -1 : 1));
    out.push(...mine.slice(0, perNation));
  }
  return out;
}

/** The bell a held flag keep counts from: its holder's since_bell, but never before the round was posted. */
export const countFrom = (keep, postedBell) => Math.max(keep.since, postedBell);

/**
 * The progress of every nation on the round's flags at `bell`: `[{nation, held, heldLong, need, reachAt, keeps:
 * [{p, q, since, from, longAt}]}]` — `reachAt`: the bell at which the nation reaches the need if it keeps what it holds
 * (null when it holds fewer than the need).
 */
export function progressOf({ flags, keeps, bell, postedBell, rules = FLAG_KEEPS_DEFAULTS }) {
  const byKey = new Map(keeps.map(k => [keyOf(k.p, k.q), k]));
  const need = needOf(flags.length, rules);
  const out = [];
  for (let n = 0; n < NATIONS; n++) {
    const held = flags.map(f => byKey.get(keyOf(f.p, f.q))).filter(k => k && k.holder === n)
      .map(k => { const from = countFrom(k, postedBell); return { p: k.p, q: k.q, since: k.since, from, longAt: from + rules.holdBells }; })
      .sort((a, b) => a.longAt - b.longAt || a.p - b.p || a.q - b.q);
    const heldLong = held.filter(k => k.longAt <= bell).length;
    out.push({ nation: n, held: held.length, heldLong, need, reachAt: need > 0 && held.length >= need ? held[need - 1].longAt : null, keeps: held });
  }
  return out;
}

/** The achievement at `bell`, if any: `{bell, nations}` — the nations whose reachAt ≤ bell, at the earliest such bell. */
export function achievementOf(progress, bell) {
  const done = progress.filter(x => x.reachAt !== null && x.reachAt <= bell);
  if (!done.length) return null;
  const at = Math.min(...done.map(x => x.reachAt));
  return { bell: at, nations: done.filter(x => x.reachAt === at).map(x => x.nation).sort((a, b) => a - b) };
}

/**
 * Points per wallet from ledger lines (achievements.mjs Deriver `captureLines` / `reinforcementLines` shape), for the
 * achieving nation(s): capture `capturePoints` per line; reinforcement floor(troops × per100 / 100), capped per
 * (wallet, keep). Lines of another nation's member (a supplier from elsewhere) earn nothing. → `{byWallet: Map(wallet →
 * {nation, points, lines})}`.
 */
export function pointsOf(lines, { nations, rules = FLAG_KEEPS_DEFAULTS }) {
  const c = rules.contribution;
  const used = new Map(), byWallet = new Map();
  for (const l of lines) {
    if (!l.wallet || !nations.includes(l.nation)) continue;
    let pts = 0;
    if (l.kind === 'capture') pts = c.capturePoints;
    else if (l.kind === 'reinforcement') {
      if (l.detail?.supplierNation !== undefined && l.detail.supplierNation !== l.nation) continue;
      const k = `${l.wallet}:${l.province.p},${l.province.q}`;
      pts = Math.min(Math.floor(l.quantity * c.reinforcementPer100Troops / 100), Math.max(0, c.reinforcementMaxPerKeep - (used.get(k) ?? 0)));
      used.set(k, (used.get(k) ?? 0) + pts);
    }
    const w = byWallet.get(l.wallet) ?? { nation: l.nation, points: 0, lines: [] };
    w.points += pts; w.lines.push({ kind: l.kind, p: l.province.p, q: l.province.q, quantity: l.quantity, points: pts, bell: l.bell, signatures: l.signatures ?? [] });
    byWallet.set(l.wallet, w);
  }
  return { byWallet };
}

/** permutation-prize `share_amount`: floor(floor(prize / nations) × points / total). BigInt in, BigInt out. */
export function shareAmount(prize, shareNations, points, total) {
  if (shareNations <= 0n || total <= 0n || points > total) return null;
  return (prize / shareNations) * points / total;
}

/**
 * The SIMULATED vault before round `round`: what every person member's 30-day pass would have paid in (one pass per
 * person member — the pass is not built yet, so every person counts as holding one), less what earlier achievements
 * would have paid out. → BigInt base units.
 */
export function simulatedVault({ people, paidOut = 0n, rules = FLAG_KEEPS_DEFAULTS }) {
  const P = rules.prize;
  const inflow = BigInt(people) * BigInt(P.passFee) * BigInt(P.prizeBps) / 10_000n * BigInt(P.hegemonyBps) / 10_000n;
  return inflow > paidOut ? inflow - paidOut : 0n;
}

/**
 * Who gets what of a (SIMULATED) payout: `members` = `[{wallet, nation, joinBell, operator, external}]` of the world,
 * `points` = pointsOf(...).byWallet. → `{payout, perNation, rows: [{wallet, nation, kind, points, eligible, why, amount}],
 * returned}` (BigInt base units; `returned`: what stays in the vault — dust, payouts under the minimum, and the part of
 * a nation with no eligible member).
 */
export function splitPrize({ vault, nations, members, points, bell, rules = FLAG_KEEPS_DEFAULTS }) {
  const P = rules.prize;
  const payout = vault * BigInt(P.payoutBps) / 10_000n;
  const share = BigInt(nations.length);
  const rows = [];
  let paid = 0n;
  for (const n of nations) {
    const inNation = members.filter(m => m.nation === n);
    const who = inNation.map(m => {
      const kind = m.operator ? 'operator-ai' : m.external ? 'external-ai' : 'person';
      const why = m.operator ? 'operator-ai' : m.external ? 'external-ai-legal-review' : !(Number.isInteger(m.joinBell) && m.joinBell + rules.memberBells <= bell) ? 'member-too-recent' : null;
      return { wallet: m.wallet, nation: n, kind, points: points.get(m.wallet)?.points ?? 0, eligible: why === null, why };
    });
    // (a point-earner the member list missed — a line names the wallet but its Citizen was not read: counted, not paid)
    for (const [wallet, x] of points) if (x.nation === n && !who.some(w => w.wallet === wallet)) who.push({ wallet, nation: n, kind: 'unknown', points: x.points, eligible: false, why: 'not-a-member-read' });
    const eligible = who.filter(w => w.eligible);
    const total = eligible.reduce((a, w) => a + BigInt(w.points), 0n);
    // (all eligible points zero: an equal split among the eligible members — the current provisional fallback)
    const mode = total > 0n ? 'points' : eligible.length ? 'equal' : 'none';
    for (const w of who) {
      let amount = 0n;
      if (w.eligible && mode === 'points') amount = shareAmount(payout, share, BigInt(w.points), total);
      else if (w.eligible && mode === 'equal') amount = shareAmount(payout, share, 1n, BigInt(eligible.length));
      if (amount < BigInt(P.minPayout)) amount = 0n;
      paid += amount;
      rows.push({ ...w, mode, amount });
    }
  }
  return { payout, nationPart: share > 0n ? payout / share : 0n, rows, paid, returned: payout - paid };
}

/** Base units as a decimal string (6 decimals, trailing zeros dropped). */
export function units(v, decimals = FLAG_KEEPS_DEFAULTS.prize.decimals) {
  const s = BigInt(v).toString().padStart(decimals + 1, '0');
  return `${s.slice(0, -decimals)}.${s.slice(-decimals)}`.replace(/\.?0+$/, '') || '0';
}

/** The sha256 of a posting (its canonical JSON): published with the round, never changed after. */
export const postingHash = posting => hex(sha256(JSON.stringify(posting)));

/**
 * One step of the judge over its own kept state `st` (null at first) and a reading of the chain `r` = `{bell, keeps,
 * genesisSeed (32 bytes)}`. Posts round 1 at the first reading, detects an achievement and posts the next round. →
 * `{state, achieved: null | {round, bell, nations, flags}}` — the caller adds the ledger and the prize to an achievement
 * (`settle`), which needs more reads. Pure.
 */
export function step(st, r, rules = FLAG_KEEPS_DEFAULTS) {
  let state = st ?? { round: 0, rounds: [], history: [] };
  if (state.round === 0) state = postRound(state, r, 1, r.bell, 0, rules);
  const cur = state.rounds.at(-1);
  const progress = progressOf({ flags: cur.flags, keeps: r.keeps, bell: r.bell, postedBell: cur.postedBell, rules });
  const a = achievementOf(progress, r.bell);
  if (!a) return { state, achieved: null, progress };
  const achieved = { round: cur.round, bell: a.bell, readBell: r.bell, nations: a.nations, flags: cur.flags,
    counted: progress.filter(x => a.nations.includes(x.nation)).flatMap(x => x.keeps.filter(k => k.longAt <= a.bell).map(k => ({ ...k, nation: x.nation }))) };
  const next = postRound(state, r, cur.round + 1, r.bell, a.bell, rules);
  return { state: next, achieved, progress: progressOf({ flags: next.rounds.at(-1).flags, keeps: r.keeps, bell: r.bell, postedBell: next.rounds.at(-1).postedBell, rules }) };
}

function postRound(state, r, round, postedBell, lastAchievedBell, rules) {
  const seed = roundSeed(r.genesisSeed, round, lastAchievedBell);
  const flags = designate({ keeps: r.keeps, seed, round, perNation: rules.perNation });
  const posting = { kind: 'flag-keeps', ruleset: FLAG_KEEPS_RULESET, round, postedBell, seed, need: needOf(flags.length, rules), holdBells: rules.holdBells, flags: flags.map(f => ({ p: f.p, q: f.q, nation: f.nation })) };
  return { ...state, round, rounds: [...state.rounds, { round, postedBell, seed, flags, need: posting.need, holdBells: rules.holdBells, hash: postingHash(posting), posting }] };
}
