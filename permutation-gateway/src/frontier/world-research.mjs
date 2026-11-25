// World goal ② "world-first technology" (design 01 §4.2/§5/§7, plan docs/design/win-conditions/02-research-plan.ja.md;
// owner r0ze 2026-11-25 08:56 JST: every Q-RS-1..10 recommendation). The judge is a pure function of public chain state,
// the flag keeps' pattern (world-goals.mjs): read only, anyone who reads the same accounts gets the same answer.
//
//   read      the world's research record and the six nations' (7 accounts; web/frontier/flocalplay-research.mjs
//             decoders) — and, for the contribution ledger, the PSR1 receipts the program logs on every pledge.
//   posting   the techs of the world's era (≤ the rule's open eras) that no nation knows yet; its sha256 (the canonical
//             JSON of the table, the costs and the rule) is published with it.
//   achieve   per tech, the nation(s) with the earliest learned bell in their own records — the same bell is a tie
//             (design 01 §3.2) — checked against the world record's first bell and first nations. A mismatch STOPS
//             the judge for that tech with the reason (`ResearchMismatch`), it never guesses.
//   points    per citizen, the science it pledged to that tech (receipts up to the learn), summed, then ÷ 10 rounded
//             down (Q-RS-10 (d)). Operator AI residents earn points and titles like people, no money (Q17 (b)).
//   prize     (SIMULATED, no money moves) the science vault = 20 % of what the passes paid into the prize (design 01 §7.2;
//             the kinds not built yet go to hegemony); one achievement pays 5 % (era 1), 10 % (era 2), 20 % (era 3) of it,
//             split as the flag keeps' (world-goals.mjs splitPrize: eligible persons by points).
//   fog       Q-RS-9 (1) (b): every nation's KNOWN techs and the world-first records are public; the pledged totals
//             ("how far") are given for the asking nation only (`viewOf(…, nation)`), the flag keeps' line.
import { createHash } from 'node:crypto';
import { NATIONS, TECHS, RESEARCH_V1, TECH_COUNT, costV1, othersDiscounting, refusalOf, decodeResearchReceipt } from '../../../permutation-server/web/frontier/flocalplay-research.mjs';
import { FLAG_KEEPS_DEFAULTS, splitPrize, units } from './world-goals.mjs';

export const RESEARCH_RULESET = 'research-v1';
/** The judge's rules (owner-accepted defaults of design 01 §7; `memberBells` as the flag keeps'). */
export const RESEARCH_DEFAULTS = Object.freeze({
  memberBells: FLAG_KEEPS_DEFAULTS.memberBells,
  // (§7.2: hegemony 40 %, science 20 %, construction 20 %, exploration 20 %; the two not built yet go to hegemony → 80 / 20)
  prize: Object.freeze({ ...FLAG_KEEPS_DEFAULTS.prize, scienceBps: 2000, hegemonyBpsWithScience: 8000, payoutBpsByEra: Object.freeze([500, 1000, 2000]) }),
});

const hex = b => Buffer.from(b).toString('hex');
const sha256 = s => hex(createHash('sha256').update(s).digest());
const isNation = n => Number.isInteger(n) && n >= 0 && n < NATIONS;

/** The posting of the world's era: `{era, techs: [{id, key, era, cost}], hash}` (cost: the first nation's, undiscounted). */
export function postingOf(world) {
  const techs = TECHS.filter(t => t.era <= world.era && t.era <= RESEARCH_V1.openEras && world.techs[t.id].firstBell === null)
    .map(t => ({ id: t.id, key: t.key, era: t.era, cost: costV1(t.id, 0) }));
  const posting = { kind: 'world-first-tech', ruleset: RESEARCH_RULESET, rule: world.rule, era: world.era, techs: techs.map(t => [t.id, t.cost]) };
  return { era: world.era, techs, hash: sha256(JSON.stringify(posting)) };
}

/**
 * The world firsts: `[{tech, key, era, bell, nations}]` (nations sorted), from the nations' own learned bells, checked
 * against the world record. → `{firsts, problems: [{tech, why}]}`.
 */
export function firstsOf(world, nations) {
  const firsts = [], problems = [];
  for (let t = 0; t < TECH_COUNT; t++) {
    const learned = nations.filter(Boolean).map(n => ({ nation: n.nation, bell: n.techs[t].learnedBell })).filter(x => x.bell !== null);
    const w = world.techs[t];
    if (!learned.length) {
      if (w.firstBell !== null || w.knownBy.length) problems.push({ tech: t, why: 'ResearchMismatch: the world record names a learner no nation record has' });
      continue;
    }
    const bell = Math.min(...learned.map(x => x.bell));
    const at = learned.filter(x => x.bell === bell).map(x => x.nation).sort((a, b) => a - b);
    const known = learned.map(x => x.nation).sort((a, b) => a - b);
    if (w.firstBell !== bell || JSON.stringify(w.firstNations) !== JSON.stringify(at) || JSON.stringify(w.knownBy) !== JSON.stringify(known)) {
      problems.push({ tech: t, why: 'ResearchMismatch: the world record and the nations\' records disagree' });
      continue;
    }
    firsts.push({ tech: t, key: TECHS[t].key, era: TECHS[t].era, bell, nations: at });
  }
  return { firsts, problems };
}

/**
 * What a viewer of nation `viewer` (or null: a spectator) may see — Q-RS-9 (1) (b). → `{era, eraBell, startBell, paused,
 * techs: [{id, key, era, open, firstBell, firstNations, knownBy, mine?: {known, pledged, cost, left, learnedBell,
 * refusal}}]}`.
 */
export function viewOf(world, nations, viewer = null, { bell = null } = {}) {
  const mine = isNation(viewer) ? nations[viewer] : null;
  return {
    era: world.era, eraBell: world.eraBell, startBell: world.startBell, paused: world.paused, rule: world.rule, openEras: RESEARCH_V1.openEras,
    techs: TECHS.map(t => {
      const w = world.techs[t.id];
      const row = { id: t.id, key: t.key, era: t.era, open: t.era <= world.era && t.era <= RESEARCH_V1.openEras, firstBell: w.firstBell, firstNations: w.firstNations, knownBy: w.knownBy };
      if (mine) {
        const others = othersDiscounting(w, viewer, bell);
        const cost = costV1(t.id, others), m = mine.techs[t.id];
        row.mine = { known: m.known, pledged: m.pledged, cost, left: m.known ? 0 : Math.max(0, cost - m.pledged), learnedBell: m.learnedBell, refusal: refusalOf(t.id, world.era, mine.known) };
      }
      return row;
    }),
  };
}

/** The tech the operator AI pledges to (plan §8): of the techs its nation may pledge, the least left to pay; ties the lower id. */
export function aiTechOf(view) {
  const open = (view?.techs ?? []).filter(t => t.mine && t.mine.refusal === null);
  if (!open.length) return null;
  open.sort((a, b) => a.mine.left - b.mine.left || a.id - b.id);
  return open[0];
}

/** The PSR1 receipts of transaction logs (`Program data: <b64> <b64>` lines). */
export function receiptsOfLogs(logs) {
  const out = [];
  for (const line of Array.isArray(logs) ? logs : []) {
    const m = /^Program data: (\S+) (\S+)$/.exec(String(line));
    if (!m) continue;
    try { const r = decodeResearchReceipt([new Uint8Array(Buffer.from(m[1], 'base64')), new Uint8Array(Buffer.from(m[2], 'base64'))]); if (r) out.push(r); } catch { /* not a receipt */ }
  }
  return out;
}

/**
 * Points of an achieved tech: the pledge receipts of `tech` by the achieving nation(s), at or before `bell`, summed per
 * citizen then ÷ 10 (rounded down). `citizenWallet(citizen bytes)` → wallet or null. → Map(wallet → {nation, points,
 * science, lines}).
 */
export function pointsOfReceipts(receipts, { tech, nations, bell, citizenWallet }) {
  const sum = new Map();
  for (const r of receipts) {
    if (r.kind !== 'pledge' || r.tech !== tech || !nations.includes(r.nation) || r.bell > bell) continue;
    const wallet = citizenWallet(r.citizen) ?? `citizen:${hex(r.citizen)}`;
    const w = sum.get(wallet) ?? { nation: r.nation, science: 0, lines: [] };
    w.science += r.amount; w.lines.push({ kind: 'pledge', tech, amount: r.amount, bell: r.bell });
    sum.set(wallet, w);
  }
  const out = new Map();
  for (const [wallet, w] of sum) out.set(wallet, { ...w, points: Math.floor(w.science / RESEARCH_V1.sciencePerPoint) });
  return out;
}

/** The SIMULATED science vault before an achievement: 20 % of what the person members' passes paid in, less paid out. */
export function scienceVault({ people, paidOut = 0n, rules = RESEARCH_DEFAULTS }) {
  const P = rules.prize;
  const inflow = BigInt(people) * BigInt(P.passFee) * BigInt(P.prizeBps) / 10_000n * BigInt(P.scienceBps) / 10_000n;
  return inflow > paidOut ? inflow - paidOut : 0n;
}

/**
 * Settle one world first: the points, the members, the simulated vault and its split. → the history entry (BigInts as
 * decimal strings). The prize ledger shape follows the flag keeps' (and permutation-prize's AttestAchieve inputs:
 * the kind, the goal (tech), the winning nations, the bell, the evidence hash = sha256 of this entry's judged facts).
 */
export function settleFirst({ first, receipts, members, operators = [], externals = [], paidOut = 0n, citizenWallet, rules = RESEARCH_DEFAULTS }) {
  const points = pointsOfReceipts(receipts, { tech: first.tech, nations: first.nations, bell: first.bell, citizenWallet });
  const tagged = members.map(m => ({ ...m, operator: operators.includes(m.wallet), external: externals.includes(m.wallet) }));
  const people = tagged.filter(m => !m.operator && !m.external).length;
  const vault = scienceVault({ people, paidOut, rules });
  const payoutBps = rules.prize.payoutBpsByEra[first.era - 1];
  const split = splitPrize({ vault, nations: first.nations, members: tagged, points, bell: first.bell, rules: { ...rules, prize: { ...rules.prize, payoutBps } } });
  const facts = { kind: 'science', ruleset: RESEARCH_RULESET, tech: first.tech, era: first.era, bell: first.bell, nations: first.nations };
  return {
    kind: 'science', goal: first.key, tech: first.tech, era: first.era, bell: first.bell, nations: first.nations,
    attest: { kind: 'science', goalId: first.tech, nations: first.nations, bell: first.bell, evidenceHash: sha256(JSON.stringify(facts)) },
    ledger: [...points].map(([wallet, w]) => ({ wallet, nation: w.nation, points: w.points, science: w.science, operator: operators.includes(wallet), lines: w.lines })),
    prize: { simulated: true, asset: rules.prize.asset, decimals: rules.prize.decimals, people, payoutBps, vaultBefore: vault, payout: split.payout, nationPart: split.nationPart, paid: split.paid, returned: split.returned, vaultAfter: vault - split.paid,
      rows: split.rows.map(r => ({ ...r, amountText: units(r.amount) })) },
  };
}

/**
 * One step of the research judge over its kept state `st` (null at first) and a reading `{world, nations}`. → `{state,
 * fresh: [first]}`: the world firsts not yet in the history (the caller settles each, which needs the receipts).
 */
export function researchStep(st, { world, nations }) {
  const state = st ?? { history: [] };
  const { firsts, problems } = firstsOf(world, nations);
  const done = new Set(state.history.map(h => h.tech));
  return { state, fresh: firsts.filter(f => !done.has(f.tech)).sort((a, b) => a.bell - b.bell || a.tech - b.tech), firsts, problems, posting: postingOf(world) };
}
