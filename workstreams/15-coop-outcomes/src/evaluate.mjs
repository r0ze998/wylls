// evaluate(ruleset, input, {window}) → verdict for one evaluation window.
// Pure: the same ruleset and the same input (in any order, with any
// repetition) give the same verdict and the same `verdictHash`.
//
// The world does not end. The input is one continuous log; an evaluation
// window (`input.windows`, supplied by whoever defines war periods; this
// evaluator defines none) is only the span whose achievements are judged.
// Closing a window ends nothing in the world: goods, structures, caravans
// in transit and unfinished projects carry on, and the next window sees them.
//
// The verdict keeps apart, and never converts between:
//   achievements  goals judged, with reasons and the evidence ids
//   scores        the competitive standing at the window's close (keeps, territory)
//   resources     goods per resource up to the close (never summed across resources)
//   prize         variant A only: the legacy season-end rule, as a compatibility
//                 check; B and C decide no prize (the war period's tally is undecided)
//
// `diagnostics` (duplicates seen, how far the input was from canonical order)
// depends on how the input was delivered, so it is outside the hash.
import { canonical, hashOf } from './canon.mjs';
import { RESOURCES } from './contract.mjs';
import { gapsBefore, normalize } from './ledger.mjs';
import { buildWorld, goodsBalance, snapshotOf } from './world.mjs';
import { judgeJoint, judgeNational, judgePersonal, keepBells, KINDS_OF, membersAt, windowView } from './goals.mjs';

export const EVALUATOR = Object.freeze({ name: 'ws15-coop-eval', version: '0.2.0', contract: 1 });

/** The input as hashed: the state, the windows and the normalized events (order and duplicates do not matter). */
export function inputHashOf(input) {
  const { events } = normalize(input.events, input.state.streams);
  return hashOf({ state: input.state, windows: windowsOf(input), events });
}

/**
 * The evaluation windows `[opensAt, endsAt)`: `input.windows`, else the
 * legacy single `state.period`. They are inputs: the evaluator neither
 * chooses their length nor repeats them.
 */
export function windowsOf(input) {
  const ws = input.windows ?? (input.state.period ? [{ id: input.state.period.id, opensAt: input.state.period.opensAt, endsAt: input.state.period.endsAt, optionsAt: input.state.period.optionsAt }] : []);
  if (new Set(ws.map(w => w.id)).size !== ws.length) throw new Error('evaluation windows: duplicate id');
  const sorted = [...ws].sort((a, b) => a.opensAt - b.opensAt);
  for (let i = 0; i < sorted.length; i++) {
    const w = sorted[i];
    if (!(Number.isSafeInteger(w.opensAt) && Number.isSafeInteger(w.endsAt) && w.opensAt < w.endsAt)) throw new Error(`window ${w.id}: bad bounds`);
    if (i && sorted[i - 1].endsAt > w.opensAt) throw new Error(`window ${w.id} overlaps ${sorted[i - 1].id}`);
  }
  return sorted;
}

export function evaluate(ruleset, input, { window = null, asOf = null, world = null } = {}) {
  const { state } = input;
  const windows = windowsOf(input);
  const w = window === null ? windows[windows.length - 1] : windows.find(x => x.id === window);
  if (!w) throw new Error(`no evaluation window ${window}`);
  const norm = world?.norm ?? normalize(input.events, state.streams ?? {});
  const jointGoals = Object.fromEntries(ruleset.joint.map(g => [g.id, g]));
  const build = events => buildWorld({ state, events, taint: norm.taint, gapFrom: norm.gapFrom, costs: ruleset.costs, jointGoals });
  // The world is built once from the whole log; each window is a view of it.
  const W = world?.W ?? build(norm.events);
  const ctx = { periodId: w.id, slotBy: ruleset.slotBy };
  const judge = closeAt => {
    const V = windowView(W, { ...w, closeAt }, ruleset.carryInputs !== false);
    return { V, joint: ruleset.joint.map(g => judgeJoint(V, g, ctx)) };
  };
  // Variant C (comparison only): a joint achievement closes this evaluation window early.
  let pass = judge(w.endsAt);
  let closedBy = 'schedule';
  let trigger = null;
  if (ruleset.close.kind === 'joint-window') {
    const j = pass.joint.find(x => x.goal === ruleset.close.goal);
    if (j?.status === 'achieved' && j.achievedAtUncertain) {
      // Another project of the goal is undecided and might have closed the window earlier.
      trigger = { goal: j.goal, status: 'indeterminate', achievedAt: j.achievedAt, reason: 'close_undecided' };
    } else if (j?.status === 'achieved') {
      const at = Math.min(w.endsAt, j.achievedAt + ruleset.close.noticeBells);
      trigger = { goal: j.goal, project: j.project, achievedAt: j.achievedAt, noticeBells: ruleset.close.noticeBells };
      if (at < w.endsAt) { pass = judge(at); closedBy = `joint:${j.goal}`; }
    } else if (j?.status === 'indeterminate') {
      trigger = { goal: j.goal, status: 'indeterminate' };
    }
  }
  const { V, joint } = pass;
  const national = ruleset.national ? judgeNational(V, ruleset.national, joint, ctx) : [];
  const personal = judgePersonal(V, ruleset.personal, joint, ctx);
  const win = {
    id: w.id, opensAt: w.opensAt, endsAt: w.endsAt, closeAt: V.closeAt, closedBy,
    status: trigger?.status === 'indeterminate' ? 'close_indeterminate' : 'closed',
    // C closing early leaves the rest of the given window judged by no window (reported, not filled in).
    unevaluated: V.closeAt < w.endsAt ? { from: V.closeAt, to: w.endsAt } : null,
    trigger, scope: ruleset.scope,
  };
  // The world at the window's close (events before it): what carries on into the next window.
  const Wc = world ? world.worldAt(V.closeAt, false) : build(norm.events.filter(e => e.at < V.closeAt));
  const balance = goodsBalance(Wc);
  // Options are judged on the world as it stood at that bell (later events unseen). The world goes on
  // after a window closes, so options never shrink to waiting.
  const optionsAt = at => {
    const Wq = windowView(world ? world.worldAt(at, true) : build(norm.events.filter(e => e.at <= at)), { ...w, closeAt: V.closeAt }, ruleset.carryInputs !== false);
    const jq = ruleset.joint.map(g => judgeJoint(Wq, g, ctx));
    const nq = ruleset.national ? judgeNational(Wq, ruleset.national, jq, ctx) : [];
    return { at, inWindow: at >= w.opensAt && at < V.closeAt, byActor: optionsOf(Wq, ruleset, jq, nq, judgePersonal(Wq, ruleset.personal, jq, ctx), at) };
  };
  const scores = scoresOf(V);
  scores.status = scores.tainted || gapsBefore(V.gapFrom, V.closeAt, KINDS_OF.prize).length || win.status !== 'closed' ? 'indeterminate' : 'decided';
  const verdict = {
    evaluator: EVALUATOR,
    ruleset: { id: ruleset.id, version: ruleset.version, variant: ruleset.variant, status: ruleset.status, hash: hashOf(ruleset) },
    inputHash: hashOf({ state, windows, events: norm.events }),
    identity: {
      basis: 'model labels (actor.cluster, actor.nation)',
      productionGuarantee: false,
      note: '「独立した参加者」は模型のラベルで数える。本番のチェーンでは同じ人の別アカウントを見分けられず、この判定は別人であることを保証しない',
    },
    records: { conflicts: norm.notes.conflicts, rejected: norm.notes.rejected, gaps: norm.notes.gaps, refused: W.outcomes.filter(o => !o.ok).map(o => ({ id: o.id, kind: o.kind, code: o.code })) },
    window: win,
    world: {
      ends: false,
      note: '評価期間を閉じても世界は終わらない。荷・建物・移動中の隊商・未完成の計画・記録は次の評価期間に引き継がれる',
      atClose: { at: V.closeAt, goods: balance, inTransit: [...Wc.ships.values()].filter(s => s.state === 'moving').map(s => s.id).sort(), openProjects: [...Wc.projects.values()].filter(p => !p.completed).map(p => p.id).sort(), digest: hashOf(snapshotOf(Wc)) },
    },
    achievements: { joint, national, personal },
    awards: awardsOf(joint, national, personal, ctx),
    scores,
    resources: resourcesOf(Wc),
    prize: prizeOf(V, scores, ruleset, win),
    options: optionsAt(asOf ?? w.optionsAt ?? Math.floor((w.opensAt + V.closeAt) / 2)),
  };
  const verdictHash = hashOf(verdict);
  return { ...verdict, verdictHash, diagnostics: { duplicates: norm.notes.duplicates, inputInversions: norm.notes.inputInversions } };
}

/**
 * Every window of the input, judged over one world, and the checks at each
 * boundary between windows: goods balance per resource, and that a world
 * saved at the boundary and resumed (a restart) reaches the same state as
 * one replayed from the start.
 */
export function evaluateSeries(ruleset, input, { restartCheck = 'all' } = {}) {
  const { state } = input;
  const norm = normalize(input.events, state.streams ?? {});
  const jointGoals = Object.fromEntries(ruleset.joint.map(g => [g.id, g]));
  const build = (events, resume = null) => buildWorld({ state, events, resume, taint: norm.taint, gapFrom: norm.gapFrom, costs: ruleset.costs, jointGoals });
  const W = build(norm.events);
  // The world at a bell is resumed from the latest saved checkpoint before it, so the cost of a
  // window does not grow with the length of the history before it.
  const ev = norm.events;
  const firstAt = t => { let lo = 0, hi = ev.length; while (lo < hi) { const m = (lo + hi) >> 1; if (ev[m].at < t) lo = m + 1; else hi = m; } return lo; };
  const checkpoints = [];
  const worldAt = (t, inclusive) => {
    const cp = checkpoints.filter(c => c.t <= t).pop();
    const from = cp ? firstAt(cp.t) : 0;
    const to = inclusive ? firstAt(t + 1) : firstAt(t);
    const Wt = build(ev.slice(from, to), cp?.snap ?? null);
    if (!inclusive && !checkpoints.some(c => c.t === t)) { checkpoints.push({ t, snap: snapshotOf(Wt) }); checkpoints.sort((a, b) => a.t - b.t); }
    return Wt;
  };
  const windows = windowsOf(input);
  const verdicts = [];
  const boundaries = [];
  const finalDigest = hashOf(snapshotOf(W));
  windows.forEach((w, i) => {
    if (i) {
      const before = worldAt(w.opensAt, false);
      const check = restartCheck === 'all' || (typeof restartCheck === 'number' && i % restartCheck === 0);
      const resumed = check ? build(ev.slice(firstAt(w.opensAt)), snapshotOf(before)) : null;
      boundaries.push({
        at: w.opensAt,
        goods: goodsBalance(before),
        balanced: Object.values(goodsBalance(before)).every(x => x.balanced),
        inTransit: [...before.ships.values()].filter(s => s.state === 'moving').map(s => s.id).sort(),
        openProjects: [...before.projects.values()].filter(p => !p.completed).map(p => p.id).sort(),
        restartMatches: check ? hashOf(snapshotOf(resumed)) === finalDigest : null,
      });
    }
    verdicts.push(evaluate(ruleset, input, { window: w.id, world: { norm, W, worldAt } }));
  });
  // Spans between windows are judged by no window: an achievement reached there is credited nowhere.
  // Reported, not filled in (where windows fall is not this evaluator's decision).
  const uncovered = windows.slice(1).map((w, i) => ({ from: windows[i].endsAt, to: w.opensAt })).filter(g => g.from < g.to);
  return { verdicts, boundaries, uncovered, finalDigest, worldEnds: false };
}

/** Keeps per nation at the window's close, and territory bells (the chain's counters, else derived from keep holding). */
function scoresOf(V) {
  const holder = new Map();
  for (const h of [...V.keepHistory].filter(h => h.at < V.closeAt).sort((a, b) => a.at - b.at)) holder.set(h.keep, h);
  const keeps = {};
  for (const n of V.nations) keeps[n] = 0;
  for (const h of holder.values()) if (h.nation) keeps[h.nation] = (keeps[h.nation] ?? 0) + 1;
  // The chain's territory counters are cumulative: the window's territory is the counter at the close
  // less the counter when the window opened.
  const counterAt = t => { const c = {}; for (const x of [...V.territoryHistory].filter(x => x.at < t).sort((a, b) => a.at - b.at)) c[x.nation] = x.bells; return c; };
  const atClose = counterAt(V.closeAt);
  const atOpen = counterAt(V.opensAt);
  const counters = Object.fromEntries(Object.entries(atClose).map(([n, b]) => [n, b - (atOpen[n] ?? 0)]));
  const derived = !Object.keys(counters).length;
  const territory = derived ? keepBells(V, V.opensAt, V.closeAt) : counters;
  for (const n of V.nations) territory[n] ??= 0;
  const tainted = V.keepHistory.some(h => h.tainted && h.at < V.closeAt);
  return { keeps, territory, territorySource: derived ? 'derived from keep holding in the window (model; the program counts TERRITORY_BELLS)' : 'territory.counter events', tainted, leaderAtClose: leaderOf(V, keeps, territory) };
}

/** Who leads at the close by the code's rule (most keeps; tie → territory; still tied → all). Information, not a prize. */
function leaderOf(V, keeps, territory) {
  const max = Math.max(0, ...Object.values(keeps));
  let top = V.nations.filter(n => keeps[n] === max);
  let rule = 'most keeps';
  if (top.length > 1) {
    const t = Math.max(...top.map(n => territory[n] ?? 0));
    top = top.filter(n => (territory[n] ?? 0) === t);
    rule = top.length > 1 ? 'tie on keeps and territory: all tied' : 'tie on keeps: more territory';
  }
  return { nations: top, rule };
}

/**
 * The prize. Variant A reads the legacy season-end rule (permutation-prize
 * winners()) as a compatibility check of the old path; it is not a reason
 * to end the world. B and C decide no prize: what a war period tallies and
 * how a prize is handled is undecided.
 */
function prizeOf(V, scores, ruleset, win) {
  const undecided = scores.tainted || gapsBefore(V.gapFrom, V.closeAt, KINDS_OF.prize).length || win.status !== 'closed';
  if (ruleset.prize?.kind !== 'legacy-season-end') {
    return { status: 'not_decided', winners: null, rule: null, newMoney: 0, fromAchievements: 0,
      note: '戦期に何を集計し賞金をどう扱うかは未決定。この評価器は決めない。達成は賞金に換算しない' };
  }
  return {
    source: 'legacy season-end rule (permutation-prize winners(); compatibility check only; the program itself is not run here)',
    status: undecided ? 'indeterminate' : 'decided',
    winners: scores.leaderAtClose.nations, rule: scores.leaderAtClose.rule, countedAt: V.closeAt,
    newMoney: 0, fromAchievements: 0,
    note: '旧経路（シーズン終了→集計）の互換確認。新しい世界を終了させる根拠にしない',
  };
}

/** Goods per resource, from the world's running counters up to the close. Nothing is added across resources. */
function resourcesOf(W) {
  const out = {};
  for (const r of RESOURCES) {
    const f = W.flow[r];
    out[r] = { sent: f.sent, arrived: { ...f.arrived }, raidedTaken: f.raidedTaken, raidedBurned: f.burned, lost: f.lost, inputs: 0, inProjects: {} };
  }
  for (const p of W.projects.values()) for (const i of p.inputs) {
    out[i.resource].inputs += i.qty;
    out[i.resource].inProjects[p.id] = (out[i.resource].inProjects[p.id] ?? 0) + i.qty;
  }
  return out;
}

/** Awards: one per slot (goal × evaluation window × independent participant). Non-monetary records. */
function awardsOf(joint, national, personal, ctx) {
  const out = [];
  for (const j of joint) {
    if (j.status !== 'achieved') continue;
    const p = j.projects.find(x => x.project === j.project);
    // One slot per independent participant, as for personal goals.
    const seen = new Set();
    for (const c of p.credits) {
      const who = ctx.slotBy === 'cluster' ? c.cluster : c.actor;
      if (seen.has(who)) continue;
      seen.add(who);
      out.push({ slot: `${j.goal}|${ctx.periodId}|${who}`, goal: j.goal, track: 'joint', beneficiary: c.actor, basis: 'credited input into the completed and used structure' });
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
  const open = true; // the world goes on: closing a window removes no action
  const members = membersAt(W, at);
  const nationOf = id => Object.keys(members).find(n => members[n].includes(id)) ?? null;
  const out = {};
  const holds = id => new Set([...W.lots.values()].filter(l => l.owner === id && l.qty > 0).map(l => l.resource));
  for (const a of [...W.actors.values()].sort((x, y) => (x.id < y.id ? -1 : 1))) {
    const n = nationOf(a.id);
    const mine = holds(a.id);
    const o = [{ kind: 'wait', category: 'wait', goal: null }];
    if (open) {
      for (const p of [...W.projects.values()].filter(p => !p.completed && p.steward !== a.id && (p.deadline === null || p.deadline > at)).sort((x, y) => (x.id < y.id ? -1 : 1))) {
        const useful = Object.keys(p.requires).filter(r => mine.has(r));
        if (useful.length) o.push({ kind: 'contribute', category: 'follow', project: p.id, resources: useful.sort(), goal: p.joint ? p.goal : null });
      }
      for (const j of joint) if (j.status !== 'achieved' && j.status !== 'achieved_earlier') o.push({ kind: 'open-project', category: 'lead', goal: j.goal });
      if (ruleset.national) o.push({ kind: 'build-own', category: 'lead', goal: national.find(x => x.subject === n)?.goal ?? null });
      if (n) o.push({ kind: 'contest-keeps', category: 'compete', goal: null, reward: 'standing at the window\'s close (prize rule undecided)' });
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
