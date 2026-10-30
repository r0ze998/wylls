// evaluate(ruleset, input) → verdict. Pure: the same ruleset and the same
// input (in any order, with any repetition) give the same verdict and the
// same `verdictHash`. The verdict keeps four things apart and never converts
// one into another:
//
//   achievements  goals judged, with reasons and the evidence ids
//   scores        the competitive standing (keeps, territory)
//   resources     goods per resource (never summed across resources)
//   prize         who the existing prize rule names; no new money
//
// `diagnostics` (duplicates seen, how far the input was from canonical order)
// depends on how the input was delivered, so it is outside the hash.
import { canonical, hashOf } from './canon.mjs';
import { RESOURCES } from './contract.mjs';
import { normalize } from './ledger.mjs';
import { buildWorld } from './world.mjs';
import { judgeJoint, judgeNational, judgePersonal, keepBells, membersAt } from './goals.mjs';

export const EVALUATOR = Object.freeze({ name: 'ws15-coop-eval', version: '0.1.0', contract: 0 });

/** The input as hashed: the state and the normalized events (order and duplicates do not matter). */
export function inputHashOf(input) {
  const { events } = normalize(input.events, input.state.streams);
  return hashOf({ state: input.state, events });
}

export function evaluate(ruleset, input, { asOf = null } = {}) {
  const { state } = input;
  const norm = normalize(input.events, state.streams ?? {});
  const jointGoals = Object.fromEntries(ruleset.joint.map(g => [g.id, g]));
  const endsAt = state.period.endsAt;
  const run = closeAt => {
    const W = buildWorld({ state, events: norm.events, taint: norm.taint, closeAt, costs: ruleset.costs, jointGoals });
    const ctx = { periodId: state.period.id, slotBy: ruleset.slotBy };
    const joint = ruleset.joint.map(g => judgeJoint(W, g, ctx));
    return { W, joint, ctx };
  };
  // Pass 1 at the scheduled end; in variant C a joint achievement moves the close, and pass 2 runs at it.
  let pass = run(endsAt);
  let closedBy = 'schedule';
  let trigger = null;
  if (ruleset.close.kind === 'joint-chapter') {
    const j = pass.joint.find(x => x.goal === ruleset.close.goal);
    if (j?.status === 'achieved') {
      const at = Math.min(endsAt, j.achievedAt + ruleset.close.noticeBells);
      trigger = { goal: j.goal, project: j.project, achievedAt: j.achievedAt, noticeBells: ruleset.close.noticeBells };
      if (at < endsAt) { pass = run(at); closedBy = `joint:${j.goal}`; }
    } else if (j?.status === 'indeterminate') {
      trigger = { goal: j.goal, status: 'indeterminate' };
    }
  }
  const { W, joint, ctx } = pass;
  const national = ruleset.national ? judgeNational(W, ruleset.national, joint, ctx) : [];
  const personal = judgePersonal(W, ruleset.personal, joint, ctx);
  const period = {
    id: state.period.id, opensAt: state.period.opensAt, endsAt, closeAt: W.closeAt, closedBy,
    status: trigger?.status === 'indeterminate' ? 'close_indeterminate' : 'closed',
    trigger, scope: ruleset.scope,
  };
  // Options are judged on the world as it stood at that bell (later events unseen).
  const optionsAt = at => {
    const Wq = buildWorld({ state, events: norm.events.filter(e => e.at <= at), taint: norm.taint, closeAt: W.closeAt, costs: ruleset.costs, jointGoals });
    const jq = ruleset.joint.map(g => judgeJoint(Wq, g, ctx));
    const nq = ruleset.national ? judgeNational(Wq, ruleset.national, jq, ctx) : [];
    return { at, byActor: optionsOf(Wq, ruleset, jq, nq, judgePersonal(Wq, ruleset.personal, jq, ctx), at) };
  };
  const scores = scoresOf(W, norm);
  const prize = prizeOf(W, scores, ruleset);
  const verdict = {
    evaluator: EVALUATOR,
    ruleset: { id: ruleset.id, version: ruleset.version, variant: ruleset.variant, hash: hashOf(ruleset) },
    inputHash: hashOf({ state, events: norm.events }),
    identity: {
      basis: 'model labels (actor.cluster, actor.nation)',
      productionGuarantee: false,
      note: '「独立した参加者」は模型のラベルで数える。本番のチェーンでは同じ人の別アカウントを見分けられず、この判定は別人であることを保証しない',
    },
    records: { conflicts: norm.notes.conflicts, rejected: norm.notes.rejected, gaps: norm.notes.gaps, refused: W.outcomes.filter(o => !o.ok).map(o => ({ id: o.id, kind: o.kind, code: o.code })) },
    period,
    achievements: { joint, national, personal },
    awards: awardsOf(joint, national, personal, ctx),
    scores,
    resources: resourcesOf(W),
    prize,
    options: optionsAt(asOf ?? state.period.optionsAt ?? Math.floor((state.period.opensAt + W.closeAt) / 2)),
  };
  const verdictHash = hashOf(verdict);
  return { ...verdict, verdictHash, diagnostics: { duplicates: norm.notes.duplicates, inputInversions: norm.notes.inputInversions } };
}

/** Keeps per nation when the period closed, and territory bells (the chain's counters, else derived from keep holding). */
function scoresOf(W, norm) {
  const keeps = {};
  for (const n of W.nations) keeps[n] = 0;
  for (const v of W.keepsAtClose.values()) if (v.nation) keeps[v.nation] = (keeps[v.nation] ?? 0) + 1;
  const counters = W.territoryAtClose;
  const derived = !Object.keys(counters).length;
  const territory = derived ? keepBells(W, W.opensAt, W.closeAt) : counters;
  for (const n of W.nations) territory[n] ??= 0;
  const tainted = [...W.keepsAtClose.values()].some(v => v.tainted) || W.keepHistory.some(h => h.tainted && h.at <= W.closeAt);
  return { keeps, territory, territorySource: derived ? 'derived from keep holding (model; the program counts TERRITORY_BELLS)' : 'territory.counter events', tainted };
}

/** The existing prize rule (variant A's), read at the period's close: most keeps; tie → territory; still tied → shared. */
function prizeOf(W, scores, ruleset) {
  const max = Math.max(0, ...Object.values(scores.keeps));
  let top = W.nations.filter(n => scores.keeps[n] === max);
  let rule = 'most keeps';
  if (top.length > 1) {
    const t = Math.max(...top.map(n => scores.territory[n] ?? 0));
    top = top.filter(n => (scores.territory[n] ?? 0) === t);
    rule = top.length > 1 ? 'tie on keeps and territory: shared' : 'tie on keeps: more territory';
  }
  return {
    source: 'baseline rule (permutation-prize winners(); the program itself is not run here)',
    status: scores.tainted ? 'indeterminate' : 'decided',
    winners: top, rule, countedAt: W.closeAt,
    newMoney: 0, fromAchievements: 0,
    note: '達成・得点は賞金に換算しない。共同達成は賞金の額も受取国の決め方も変えない（数える時刻は案 C で変わりうる）',
  };
}

/** Goods per resource. Nothing here is added across resources. */
function resourcesOf(W) {
  const out = {};
  for (const r of RESOURCES) out[r] = { sent: 0, arrived: { exact: 0, lowerBound: 0, unverified: 0 }, arrivedLate: 0, raidedTaken: 0, raidedBurned: 0, lost: 0, inputs: 0, inProjects: {} };
  for (const s of W.ships.values()) {
    const t = out[s.resource];
    t.sent += s.qty;
    if (s.state === 'lost') t.lost += s.qty;
  }
  for (const l of W.lots.values()) {
    if (!l.ship || l.raided) continue;
    const t = out[l.resource];
    const amount = arrivedQty(W, l);
    if (l.late) t.arrivedLate += amount;
    else if (l.verified === 'unverified') t.arrived.unverified += amount;
    else if (l.verified === 'chain_lower_bound') t.arrived.lowerBound += amount;
    else t.arrived.exact += amount;
  }
  for (const r of W.raids) { out[r.resource].raidedTaken += r.taken; out[r.resource].raidedBurned += r.burned; }
  for (const p of W.projects.values()) for (const i of p.inputs) {
    out[i.resource].inputs += i.qty;
    out[i.resource].inProjects[p.id] = (out[i.resource].inProjects[p.id] ?? 0) + i.qty;
  }
  return out;
}
/** A lot's quantity at arrival (lots are drawn down later; the ship's parts say what arrived). */
function arrivedQty(W, l) {
  const consumed = [...W.projects.values()].flatMap(p => p.inputs).filter(i => i.lot === l.id).reduce((s, i) => s + i.qty, 0);
  const sentOn = [...W.ships.values()].flatMap(s => s.parts).filter(p => p.lot === l.id).reduce((s, p) => s + p.qty, 0);
  return l.qty + consumed + sentOn;
}

/** Awards: one per slot (goal × period × independent participant). Non-monetary records. */
function awardsOf(joint, national, personal, ctx) {
  const out = [];
  for (const j of joint) {
    if (j.status !== 'achieved') continue;
    const p = j.projects.find(x => x.project === j.project);
    const seen = new Set();
    for (const c of p.credits) {
      if (seen.has(c.actor)) continue;
      seen.add(c.actor);
      out.push({ slot: `${j.goal}|${ctx.periodId}|${c.actor}`, goal: j.goal, track: 'joint', beneficiary: c.actor, basis: 'credited input into the completed and used structure' });
    }
  }
  for (const n of national) if (n.status === 'achieved') out.push({ slot: `${n.goal}|${ctx.periodId}|${n.subject}`, goal: n.goal, track: 'national', beneficiary: n.subject, basis: 'nation' });
  for (const p of personal) if (p.status === 'achieved') out.push({ slot: p.slot, goal: p.goal, track: 'personal', beneficiary: p.subject, basis: 'participant' });
  return out.sort((a, b) => (a.slot < b.slot ? -1 : 1));
}

/**
 * Claims against a verdict's awards: each claim `{slot, beneficiary}` must
 * name an award, once. A second claim on a slot is refused (`same_slot`);
 * several slots for one fact (joint, national and personal) are legitimate.
 */
export function checkClaims(verdict, claims) {
  const awards = new Map(verdict.awards.map(a => [a.slot, a]));
  const taken = new Set();
  return claims.map(c => {
    const a = awards.get(c.slot);
    if (!a || a.beneficiary !== c.beneficiary) return { ...c, ok: false, code: 'not_awarded' };
    if (taken.has(c.slot)) return { ...c, ok: false, code: 'same_slot' };
    taken.add(c.slot);
    return { ...c, ok: true, code: null };
  });
}

/**
 * What each participant can still do at bell `at`, by category. `wait` and
 * `follow` (put goods into a project someone else leads) are the passive
 * ones; `lead`, `compete`, `oppose`, `personal` and `move` are independent.
 * `goal` names the goal of this ruleset the option can reach (none in A).
 */
function optionsOf(W, ruleset, joint, national, personal, at) {
  const open = at < W.closeAt;
  const members = membersAt(W, at);
  const nationOf = id => Object.keys(members).find(n => members[n].includes(id)) ?? null;
  const out = {};
  const holds = id => new Set([...W.lots.values()].filter(l => l.owner === id && l.qty > 0).map(l => l.resource));
  for (const a of [...W.actors.values()].sort((x, y) => (x.id < y.id ? -1 : 1))) {
    const n = nationOf(a.id);
    const mine = holds(a.id);
    const o = [{ kind: 'wait', category: 'wait', goal: null }];
    if (open) {
      for (const p of [...W.projects.values()].filter(p => !p.completed && p.steward !== a.id && p.deadline > at).sort((x, y) => (x.id < y.id ? -1 : 1))) {
        const useful = Object.keys(p.requires).filter(r => mine.has(r));
        if (useful.length) o.push({ kind: 'contribute', category: 'follow', project: p.id, resources: useful.sort(), goal: p.joint ? p.goal : null });
      }
      for (const j of joint) if (j.status !== 'achieved') o.push({ kind: 'open-project', category: 'lead', goal: j.goal });
      if (ruleset.national) o.push({ kind: 'build-own', category: 'lead', goal: national.find(x => x.subject === n)?.goal ?? null });
      if (n) o.push({ kind: 'contest-keeps', category: 'compete', goal: null, reward: 'prize via the nation (baseline rule)' });
      const foreignMoving = [...W.ships.values()].filter(s => s.state === 'moving' && s.fromNation !== n);
      if (foreignMoving.length) o.push({ kind: 'raid', category: 'oppose', ships: foreignMoving.map(s => s.id).sort(), goal: ruleset.personal.find(g => g.kind === 'raider')?.id ?? null });
      const foreignOpen = [...W.projects.values()].filter(p => !p.completed && p.stewardNation !== n);
      if (foreignOpen.length) o.push({ kind: 'obstruct-project', category: 'oppose', projects: foreignOpen.map(p => p.id).sort(), goal: null });
      const foreignBuilt = [...W.structures.values()].filter(s => s.nation !== n && s.seizedAt === null);
      const pg = id => ruleset.personal.find(g => g.kind === id);
      if (pg('cross_user') && foreignBuilt.length && !personal.some(p => p.goal === pg('cross_user').id && p.subject === a.id && p.status === 'achieved')) o.push({ kind: 'use-foreign-structure', category: 'personal', goal: pg('cross_user').id, structures: foreignBuilt.map(s => s.id).sort() });
      if (pg('scout') && W.towerInput) o.push({ kind: 'report-sighting', category: 'personal', goal: pg('scout').id });
      o.push({ kind: 'move-nation', category: 'move', goal: null });
    }
    const independent = o.filter(x => x.category !== 'wait' && x.category !== 'follow');
    out[a.id] = { nation: n, options: o, independent: independent.length, independentWithGoal: independent.filter(x => x.goal).length };
  }
  return out;
}

export { canonical };
