// Goals judged on the world model (world.mjs). Three tracks, judged apart:
//
//   joint     a structure that several nations supply, that is built, and
//             that members of several nations then use (three stages, each
//             with its own verdict); see `judgeJoint`
//   national  one goal per nation, its target scaled by the nation's size
//   personal  goals any member can reach on their own, cooperative or not
//
// A contribution is credited only when goods that arrived (verified) went
// into a project and the project was completed: delivering or trading alone
// is never a reason. Resources are never added together; progress is a
// per-resource table and, where one number is shown, the scarcest share.
import { countsAs, worstQty } from './world.mjs';
import { gapsBefore } from './ledger.mjs';

/** Record kinds each kind of verdict could be changed by (a gap in a stream that may carry one undecides it). */
const ACTORS = ['actor.join', 'actor.move', 'actor.expel'];
const GOODS = [...ACTORS, 'lot.produce', 'ship.send', 'ship.arrive', 'ship.raid', 'ship.lost', 'project.open', 'contribute', 'build.complete', 'structure.seized', 'use'];
export const KINDS_OF = Object.freeze({
  joint: GOODS, build_use: GOODS, joint_share: GOODS, supplier: GOODS, founder: GOODS,
  cross_user: [...ACTORS, 'build.complete', 'structure.seized', 'use', 'project.open'],
  hold_bells: [...ACTORS, 'keep.set'],
  raider: [...ACTORS, 'ship.send', 'ship.raid', 'ship.arrive', 'ship.lost'],
  scout: [...ACTORS, 'tower.sighting', 'tower.report.used'],
  prize: ['keep.set', 'territory.counter'],
});
/** A verdict decided at bell `at` is undecided when a gap could hide a record that changes it. */
function undecide(W, r, at, kinds) {
  const gaps = gapsBefore(W.gapFrom, at, kinds);
  if (!gaps.length || r.status === 'indeterminate' || r.status === 'not_offered' || r.status === 'not_awarded') return r;
  return { ...r, status: 'indeterminate', decidedAt: at, reasons: [...r.reasons, R('missing_records', [], { streams: gaps, was: r.status })] };
}

const R = (code, evidence = [], detail = undefined) => ({ code, evidence: [...new Set(evidence)].sort(), ...(detail === undefined ? {} : { detail }) });
const sortBy = (k) => (a, b) => (a[k] < b[k] ? -1 : a[k] > b[k] ? 1 : 0);
/**
 * Goals are judged in one evaluation window `[opensAt, closeAt)` at a time
 * (`V`, a view of the world with the window's bounds; the world itself has
 * none). Goods, structures and unfinished projects come from the whole
 * history; only what is decided inside the window is credited to it.
 */
export const windowView = (W, w, carryInputs = true) => Object.assign(Object.create(W), { opensAt: w.opensAt, closeAt: w.closeAt, windowId: w.id, carryInputs,
  // Nations that existed before the close (later ones are not part of this window).
  nations: W.nations.filter(n => (W.nationSince?.[n] ?? -Infinity) < w.closeAt) });
const inWindow = (V, at) => at >= V.opensAt && at < V.closeAt;
/** After the window closed, or after the project's own deadline (inclusive). */
const lateFor = (V, p, at) => at >= V.closeAt || (p.deadline !== null && at > p.deadline);

const withOriginClusters = (W, p) => ({ ...p, inputs: p.inputs.map(i => ({ ...i, origin: { ...i.origin, cluster: W.actors.get(i.origin.actor)?.cluster ?? i.origin.actor } })) });

const share = (have, need) => (need ? Math.min(10_000, Math.floor((have * 10_000) / need)) : 10_000);

/**
 * The credit of a project's inputs: in canonical order, each resource is
 * filled up to its requirement by inputs whose quantity is known (exact or
 * lower bound); the rest is surplus, unverified or late.
 */
export function creditInputs(p, V) {
  const need = { ...p.requires };
  const lines = [];
  const per = {};
  for (const r of Object.keys(p.requires).sort()) per[r] = { required: p.requires[r], credited: 0, lowerBound: 0, unverified: 0, surplus: 0, late: 0, lo: 0, hi: 0, hiOpen: false };
  for (const i of [...p.inputs].sort(sortBy('at'))) {
    const t = per[i.resource];
    // The quantity kind of the input (④'s quantity contract §3): exact, lower bound [b, b+1), unknown [0, q+1).
    const qk = worstQty(i.qtyKind ?? 'exact', countsAs(i.verified) === 'none' ? 'unknown' : countsAs(i.verified));
    const kind = qk === 'unknown' ? 'none' : qk;
    let code = null;
    let credited = 0;
    if (lateFor(V, p, i.at)) { t.late += i.qty; code = 'late'; }
    else if (V.carryInputs === false && i.at < V.opensAt) { t.late += i.qty; code = 'before_window'; }
    else if (kind === 'none') { t.unverified += i.qty; t.hi += i.qty + 1; t.hiOpen = true; code = 'unverified_qty'; }
    else {
      t.lo += i.qty;
      t.hi += i.qty + (kind === 'lower_bound' ? 1 : 0);
      if (kind === 'lower_bound') t.hiOpen = true;
      credited = Math.min(i.qty, need[i.resource]);
      need[i.resource] -= credited;
      t.credited += credited;
      if (kind === 'lower_bound') t.lowerBound += credited;
      if (i.qty > credited) { t.surplus += i.qty - credited; code = credited ? 'surplus' : 'surplus'; }
      if (kind === 'lower_bound' && !code) code = 'lower_bound';
    }
    lines.push({ input: i.id, actor: i.actor, nation: i.nation, cluster: i.cluster, origin: i.origin, resource: i.resource, qty: i.qty, credited, code, evidence: i.evidence, tainted: i.tainted });
  }
  // Per resource (④ §4): met when the lower bounds reach the requirement; short when even the upper
  // bound cannot (an open bound is never reached); otherwise undecided.
  for (const t of Object.values(per)) {
    t.shareBps = share(t.credited, t.required);
    t.status = t.lo >= t.required ? 'met' : (t.hiOpen ? t.hi <= t.required : t.hi < t.required) ? 'short' : 'undecided';
  }
  const met = Object.values(per).every(t => t.credited >= t.required);
  const undecided = !met && Object.values(per).every(t => t.status !== 'short');
  const scarcestBps = Math.min(...Object.values(per).map(t => t.shareBps));
  return { per, lines, met, undecided, scarcestBps };
}

/** Maximum matching of nations to distinct clusters (`edges`: nation → clusters), deterministic. */
function matchDistinct(edges) {
  const owner = new Map();
  const nations = Object.keys(edges).sort();
  const tryNation = (n, seen) => {
    for (const c of [...edges[n]].sort()) {
      if (seen.has(c)) continue;
      seen.add(c);
      if (!owner.has(c) || tryNation(owner.get(c), seen)) { owner.set(c, n); return true; }
    }
    return false;
  };
  for (const n of nations) tryNation(n, new Set());
  const out = {};
  for (const [c, n] of owner) out[n] = c;
  return out;
}

/**
 * Which nations took a real part in a project's inputs: a nation counts when
 * one independent participant (a cluster: one person as far as the model's
 * labels know) is credited at least `minShareBps` of the requirement of at
 * least one resource. With `attribution: 'origin'`, goods count for the
 * nation they came from, so shipping one's own goods to others does not make
 * them contributors.
 */
export function diversityOf(credit, requires, { minShareBps, attribution }) {
  const by = {};
  for (const l of credit.lines) {
    if (!l.credited) continue;
    const nation = attribution === 'origin' ? l.origin.nation : l.nation;
    const cluster = attribution === 'origin' ? clusterOfOrigin(l) : l.cluster;
    if (nation === null) continue;
    const k = `${nation}\u0000${cluster}\u0000${l.resource}`;
    by[k] = (by[k] ?? 0) + l.credited;
  }
  const edges = {};
  for (const [k, q] of Object.entries(by)) {
    const [nation, cluster, resource] = k.split('\u0000');
    if (q * 10_000 >= minShareBps * requires[resource]) (edges[nation] ??= new Set()).add(cluster);
  }
  const matched = matchDistinct(edges);
  return { qualifying: Object.keys(matched).sort(), matched, candidates: Object.keys(edges).sort() };
}
const clusterOfOrigin = l => l.origin.cluster ?? l.origin.actor;

/** The joint goal `g` judged on every project opened for it. */
export function judgeJoint(W, g, ctx) {
  const projects = [...W.projects.values()].filter(p => p.goal === g.id && p.openedAt < W.closeAt).sort(sortBy('id'));
  const results = projects.map(p => judgeProject(W, g, p, ctx));
  const achieved = results.filter(r => r.status === 'achieved').sort((a, b) => a.achievedAt - b.achievedAt || (a.project < b.project ? -1 : 1));
  // A project achieved in an earlier window is that window's; it is not achieved again here.
  const best = achieved[0] ?? results.find(r => r.status === 'indeterminate') ?? results.find(r => r.status === 'not_achieved') ?? results[0] ?? null;
  // An undecided project could have been achieved earlier: the goal is achieved, but not certainly when.
  const whenUncertain = !!achieved[0] && results.some(r => r.status === 'indeterminate');
  const empty = undecide(W, { status: 'not_achieved', reasons: [R('causality', [], 'この目標の計画が一つも開かれていない')] }, W.closeAt, KINDS_OF.joint);
  return {
    goal: g.id, track: 'joint', label: g.label,
    status: best ? best.status : empty.status,
    achievedAt: achieved[0]?.achievedAt ?? (best?.status === 'achieved_earlier' ? best.achievedAt : null),
    achievedAtUncertain: whenUncertain,
    project: best?.project ?? null,
    reasons: best ? best.reasons : empty.reasons,
    projects: results,
  };
}

function judgeProject(W, g, p, ctx) {
  // Origin clusters resolved on a copy (judging never changes the world).
  p = withOriginClusters(W, p);
  const credit = creditInputs(p, W);
  const reasons = [];
  let indeterminate = false;
  const ev = [];
  // Stage 1: material inputs.
  const inputs = { met: credit.met, perResource: credit.per, scarcestBps: credit.scarcestBps };
  if (!credit.met) {
    const short = Object.entries(credit.per).filter(([, t]) => t.credited < t.required);
    reasons.push(R('stage_inputs', p.inputs.map(i => i.id), Object.fromEntries(short.map(([r, t]) => [r, { required: t.required, credited: t.credited, upper: t.hi, upperOpen: t.hiOpen, unverified: t.unverified, late: t.late, status: t.status }]))));
    if (credit.undecided) {
      indeterminate = true;
      const unknown = p.inputs.filter(i => countsAs(i.verified) === 'none' || i.qtyKind === 'unknown').map(i => i.id);
      reasons.push(R(unknown.length ? 'unverified_qty' : 'qty_undecided', unknown.length ? unknown : p.inputs.map(i => i.id)));
    }
  }
  for (const l of credit.lines) if (l.code === 'late') reasons.push(R('late', [l.input]));
  // Stage 2: construction completed.
  const c = p.completed;
  const cLate = !!c && lateFor(W, p, c.at);
  const completion = { done: !!c && !cLate, at: c && !cLate ? c.at : null, structure: c?.structure ?? null, shortAtCompletion: c?.shortAtCompletion ?? [] };
  if (!completion.done) reasons.push(R('stage_completion', c ? [c.id] : [], cLate ? 'late' : undefined));
  // Stage 3: actual use by members of enough nations (distinct people as far as labels go).
  const s = c ? W.structures.get(c.structure) : null;
  const uses = (s?.uses ?? []).filter(u => u.at < W.closeAt && g.use.hows.includes(u.how) && u.at <= s.builtAt + g.use.windowBells);
  const valid = uses.filter(u => !u.seized && u.nation !== null);
  const rejectedUses = (s?.uses ?? []).filter(u => !valid.includes(u)).map(u => ({ id: u.id, code: u.seized ? 'seized' : u.at >= W.closeAt ? 'after_close' : !g.use.hows.includes(u.how) ? 'not_required' : u.nation === null ? 'not_member' : 'use_window' }));
  let usedAt = null;
  const seenN = {};
  for (const u of [...valid].sort(sortBy('at'))) {
    (seenN[u.nation] ??= new Set()).add(u.cluster);
    if (usedAt === null && Object.keys(matchDistinct(seenN)).length >= g.use.minNations) usedAt = u.at;
  }
  const useNations = Object.keys(matchDistinct(seenN)).sort();
  const use = { met: usedAt !== null, at: usedAt, nations: useNations, uses: valid.map(u => u.id), rejected: rejectedUses };
  if (!use.met) reasons.push(R('stage_use', valid.map(u => u.id), { nations: useNations, need: g.use.minNations }));
  for (const u of rejectedUses) reasons.push(R(u.code, [u.id]));
  // Diversity of the inputs.
  const div = diversityOf(credit, p.requires, g);
  const diversity = { met: div.qualifying.length >= g.minNations, qualifying: div.qualifying, candidates: div.candidates, need: g.minNations, attribution: g.attribution };
  if (!diversity.met) reasons.push(R('diversity', credit.lines.filter(l => l.credited).map(l => l.input), { qualifying: div.qualifying, need: g.minNations }));
  // Taint: any record the verdict stands on may follow a missing record.
  const standsOn = [...credit.lines.filter(l => l.credited), ...valid];
  if (standsOn.some(x => x.tainted) || c?.tainted) { indeterminate = true; reasons.push(R('missing_records', standsOn.filter(x => x.tainted).map(x => x.input ?? x.id))); }
  ev.push(...p.evidence);
  const all = inputs.met && completion.done && use.met && diversity.met;
  let status = indeterminate ? 'indeterminate' : all ? 'achieved' : 'not_achieved';
  const achievedAt0 = all && !indeterminate ? Math.max(completion.at, use.at) : null;
  if (status === 'achieved' && achievedAt0 < W.opensAt) { status = 'achieved_earlier'; reasons.push(R('earlier_window', [], { achievedAt: achievedAt0 })); }
  const gaps = gapsBefore(W.gapFrom, achievedAt0 ?? W.closeAt, KINDS_OF.joint);
  if (gaps.length && status !== 'indeterminate') { reasons.push(R('missing_records', [], { streams: gaps, was: status })); status = 'indeterminate'; }
  const credits = credit.lines.filter(l => l.credited).map(l => ({ actor: l.actor, cluster: l.cluster, nation: l.nation, originNation: l.origin.nation, resource: l.resource, credited: l.credited, input: l.input }));
  const nationShareBps = {};
  for (const l of credits) {
    const t = (nationShareBps[l.nation] ??= {});
    t[l.resource] = (t[l.resource] ?? 0) + share(l.credited, p.requires[l.resource]);
  }
  return {
    project: p.id, steward: p.steward, structure: p.structure, status,
    achievedAt: status === 'achieved' || status === 'achieved_earlier' ? achievedAt0 : null,
    stages: { inputs, completion, use, diversity },
    credits, nationShareBps,
    reasons: status === 'achieved' ? [R('achieved', [...ev, c.id, ...use.uses])] : reasons,
  };
}

/** Members of each nation at bell `at` (not expelled), from the actors' histories. */
export function membersAt(W, at) {
  const out = {};
  for (const n of W.nations) out[n] = [];
  for (const a of W.actors.values()) {
    const h = [...a.history].filter(x => x.at <= at).pop();
    if (h?.nation) (out[h.nation] ??= []).push(a.id);
  }
  for (const n of Object.keys(out)) out[n].sort();
  return out;
}

/** Bells each nation held each keep inside `[from, to)`, from the keep history. */
export function keepBells(W, from, to) {
  const out = {};
  const byKeep = {};
  for (const h of W.keepHistory) (byKeep[h.keep] ??= []).push(h);
  for (const hs of Object.values(byKeep)) {
    hs.sort((a, b) => a.at - b.at);
    hs.forEach((h, i) => {
      const a = Math.max(from, h.at);
      const b = Math.min(to, hs[i + 1]?.at ?? to);
      if (b > a && h.nation) out[h.nation] = (out[h.nation] ?? 0) + (b - a);
    });
  }
  return out;
}

/** National goals: one per nation, chosen by the nation's vote (`nation.goal`) or the ruleset's default. */
export function judgeNational(W, nationalRules, joint, ctx) {
  // Members just before the close (the window is half-open).
  const members = membersAt(W, W.closeAt - 1);
  const sizes = Object.values(members).map(m => m.length).filter(Boolean);
  const mean = sizes.length ? sizes.reduce((a, b) => a + b, 0) / sizes.length : 1;
  const out = [];
  for (const n of W.nations) {
    const vote = W.nationGoals.filter(x => x.nation === n && x.at < W.closeAt).pop();
    const chosen = vote?.goal ?? nationalRules.default;
    const g = nationalRules.goals.find(x => x.id === chosen);
    if (!g) { out.push({ goal: chosen, track: 'national', subject: n, status: 'not_achieved', reasons: [R('goal_not_in_ruleset', vote ? [vote.id] : [])] }); continue; }
    const size = members[n]?.length ?? 0;
    const scale = size ? size / mean : 0;
    out.push({ ...undecide(W, judgeNationGoal(W, g, n, scale, size, joint), W.closeAt, KINDS_OF[g.kind] ?? GOODS), goal: g.id, track: 'national', subject: n, members: size });
  }
  return out;
}

function judgeNationGoal(W, g, n, scale, size, joint) {
  if (!size) return { status: 'not_achieved', target: null, reasons: [R('not_member', [], '国に人がいない')] };
  if (g.kind === 'build_use') {
    const target = Math.max(1, Math.ceil(g.base * scale));
    // A structure counts in the window where it is first used by someone else (built in time for its project).
    const firstUse = s => s.uses.filter(u => !u.seized && u.cluster !== W.actors.get(s.steward)?.cluster).map(u => u.at).sort((a, b) => a - b)[0];
    const done = [...W.structures.values()].filter(s => s.nation === n && !lateFor({ closeAt: Infinity }, W.projects.get(s.project), s.builtAt) &&
      firstUse(s) !== undefined && inWindow(W, firstUse(s))).sort(sortBy('id'));
    const tainted = done.some(s => W.projects.get(s.project).completed.tainted || s.uses.some(u => u.tainted));
    const ok = done.length >= target;
    return { status: tainted ? 'indeterminate' : ok ? 'achieved' : 'not_achieved', target, have: done.length,
      reasons: [R(ok ? 'achieved' : 'stage_use', done.flatMap(s => s.evidence), { structures: done.map(s => s.id), target })] };
  }
  if (g.kind === 'hold_bells') {
    const target = Math.max(1, Math.ceil(g.base * scale));
    const have = keepBells(W, W.opensAt, W.closeAt)[n] ?? 0;
    const tainted = W.keepHistory.some(h => h.tainted && h.at < W.closeAt);
    return { status: tainted ? 'indeterminate' : have >= target ? 'achieved' : 'not_achieved', target, have,
      reasons: [R(have >= target ? 'achieved' : 'hold_short', W.keepHistory.filter(h => h.nation === n && h.id !== 'state').map(h => h.id), { bells: have, target })] };
  }
  if (g.kind === 'joint_share') {
    const hit = joint.flatMap(j => j.projects.filter(p => p.status === 'achieved' && p.stages.diversity.qualifying.includes(n)).map(p => ({ goal: j.goal, project: p.project })));
    const ind = joint.some(j => j.status === 'indeterminate');
    return { status: hit.length ? 'achieved' : ind ? 'indeterminate' : 'not_achieved', target: 1, have: hit.length,
      reasons: [R(hit.length ? 'achieved' : 'diversity', [], { projects: hit })] };
  }
  return { status: 'not_achieved', reasons: [R('goal_not_in_ruleset')] };
}

/** Personal goals, per member: one award per goal, period and independent participant (slot). */
export function judgePersonal(W, personalRules, joint, ctx) {
  const out = [];
  const actors = [...W.actors.values()].sort(sortBy('id'));
  // Credit lines of every completed project (joint or not): the same input may serve several goals.
  const credited = [];
  for (const p of [...W.projects.values()].sort(sortBy('id'))) {
    // Projects completed in this window: an input counts in the window its project was completed in, once.
    if (!p.completed || !inWindow(W, p.completed.at) || lateFor(W, p, p.completed.at)) continue;
    for (const l of creditInputs(withOriginClusters(W, p), W).lines) if (l.credited) credited.push({ ...l, project: p.id });
  }
  for (const g of personalRules) {
    if (g.kind === 'scout' && !W.sightings.size) {
      out.push({ goal: g.id, track: 'personal', subject: null, status: 'not_offered', reasons: [R('no_sighting_source')] });
      continue;
    }
    if (g.kind === 'board_helper' && !W.board.length) {
      out.push({ goal: g.id, track: 'personal', subject: null, status: 'not_offered', reasons: [R('goal_not_in_ruleset', [], '掲示板（⑭の塔の案 B）の事実がないので、この目標は出さない')] });
      continue;
    }
    const slots = new Map();
    for (const a of actors) {
      const r0 = judgePersonalGoal(W, g, a, credited);
      if (!r0) continue;
      const r = undecide(W, r0, W.closeAt, KINDS_OF[g.kind] ?? GOODS);
      const slot = `${g.id}|${ctx.periodId}|${ctx.slotBy === 'cluster' ? a.cluster : a.id}`;
      if (r.status === 'achieved' && slots.has(slot)) {
        out.push({ goal: g.id, track: 'personal', subject: a.id, status: 'not_awarded', slot, reasons: [R('same_slot', r.reasons.flatMap(x => x.evidence), { holder: slots.get(slot) })] });
        continue;
      }
      if (r.status === 'achieved') slots.set(slot, a.id);
      out.push({ goal: g.id, track: 'personal', subject: a.id, slot, ...r });
    }
    // Someone with no record seen may have one behind a gap.
    const hidden = gapsBefore(W.gapFrom, W.closeAt, KINDS_OF[g.kind] ?? GOODS);
    if (hidden.length) out.push({ goal: g.id, track: 'personal', subject: null, status: 'indeterminate', reasons: [R('missing_records', [], { streams: hidden, note: '記録の見えない人も、欠落の中で達成しているかもしれない' })] });
  }
  return out;
}

function judgePersonalGoal(W, g, a, credited) {
  const tainted = xs => xs.some(x => x.tainted);
  if (g.kind === 'supplier') {
    // Own goods only: goods someone else shipped in count for where they came from, not for the holder.
    const all = credited.filter(l => l.actor === a.id);
    if (!all.length) return null;
    const mine = all.filter(l => clusterOfOrigin(l) === a.cluster);
    if (!mine.length) return { status: tainted(all) ? 'indeterminate' : 'not_achieved', perResource: {}, reasons: [R('not_own_goods', all.map(l => l.input))] };
    const per = {};
    for (const l of mine) per[l.resource] = (per[l.resource] ?? 0) + l.credited;
    const hit = Object.entries(per).filter(([r, q]) => q >= (g.minQty[r] ?? Infinity)).map(([r]) => r).sort();
    return { status: tainted(mine) ? 'indeterminate' : hit.length ? 'achieved' : 'not_achieved', perResource: per,
      reasons: [R(hit.length ? 'achieved' : 'below_min', mine.map(l => l.input), { resources: hit, minQty: g.minQty })] };
  }
  if (g.kind === 'cross_user') {
    const uses = [...W.structures.values()].flatMap(s => s.uses.filter(u => u.actor === a.id && inWindow(W, u.at) && !u.seized && u.nation !== null && s.nation !== null && u.nation !== s.nation && u.cluster !== W.actors.get(s.steward)?.cluster).map(u => ({ ...u, structure: s.id })));
    if (!uses.length) return null;
    return { status: tainted(uses) ? 'indeterminate' : 'achieved', reasons: [R('achieved', uses.map(u => u.id), { structures: [...new Set(uses.map(u => u.structure))].sort() })] };
  }
  if (g.kind === 'founder') {
    const ps = [...W.projects.values()].filter(p => p.steward === a.id && p.completed && inWindow(W, p.completed.at) && !lateFor(W, p, p.completed.at));
    if (!ps.length) return null;
    // Others are counted by where the goods came from: one's own goods passed through others do not count.
    const ok = ps.filter(p => new Set(credited.filter(l => l.project === p.id && clusterOfOrigin(l) !== a.cluster).map(clusterOfOrigin)).size >= g.minOthers);
    const t = ps.some(p => p.completed.tainted) || tainted(credited.filter(l => ps.some(p => p.id === l.project)));
    return { status: t ? 'indeterminate' : ok.length ? 'achieved' : 'not_achieved', reasons: [R(ok.length ? 'achieved' : 'diversity', ps.flatMap(p => p.evidence), { projects: ok.map(p => p.id) })] };
  }
  if (g.kind === 'raider') {
    const mine = W.raids.filter(r => r.raider === a.id && inWindow(W, r.at));
    if (!mine.length) return null;
    const per = {};
    for (const r of mine.filter(r => !r.domestic)) per[r.resource] = (per[r.resource] ?? 0) + r.taken;
    const hit = Object.entries(per).filter(([r, q]) => q >= (g.minQty[r] ?? Infinity)).map(([r]) => r).sort();
    return { status: tainted(mine) ? 'indeterminate' : hit.length ? 'achieved' : 'not_achieved', perResource: per,
      reasons: [R(hit.length ? 'achieved' : mine.every(r => r.domestic) ? 'domestic' : 'below_min', mine.map(r => r.id), { resources: hit })] };
  }
  if (g.kind === 'board_helper') {
    // Answering another nation's posted request counts once the exchange has arrived both ways
    // (fulfilled). Posting is not helping; taking alone is a send, not an arrival. Model facts (⑭)
    // are never a fact of the game: they give 'model_only', never 'achieved'.
    const mine = W.board.filter(b => b.taken.some(t => t.actor === a.id));
    if (!mine.length) return null;
    const done = mine.filter(b => b.fulfilled && inWindow(W, b.fulfilled.at) && b.taken.some(t => t.actor === a.id && t.cross === true && t.cluster !== b.posted?.cluster));
    const evidence = mine.flatMap(b => [b.posted?.id, ...b.taken.filter(t => t.actor === a.id).map(t => t.id), b.fulfilled?.id].filter(Boolean));
    if (!done.length) return { status: 'not_achieved', reasons: [R('taken_not_arrived', evidence)] };
    const model = done.some(b => [b.posted, b.fulfilled, ...b.taken].some(x => x && x.verified === 'model'));
    const t = done.some(b => [b.posted, b.fulfilled, ...b.taken].some(x => x?.tainted));
    return { status: t ? 'indeterminate' : model ? 'model_only' : 'achieved', requests: done.map(b => b.req).sort(),
      reasons: [R(model ? 'model_only' : 'achieved', evidence, { requests: done.map(b => b.req).sort() })] };
  }
  if (g.kind === 'scout') {
    const mine = [...W.sightings.values()].filter(s => s.actor === a.id && s.at < W.closeAt);
    if (!mine.length) return null;
    const used = mine.filter(s => s.usedBy.some(u => inWindow(W, u.at) && u.cluster !== a.cluster));
    return { status: tainted([...mine, ...mine.flatMap(s => s.usedBy)]) ? 'indeterminate' : used.length ? 'achieved' : 'not_achieved',
      reasons: [R(used.length ? 'achieved' : 'stage_use', mine.flatMap(s => [...s.evidence, ...s.usedBy.map(u => u.id)]), { sightings: used.map(s => s.id) })] };
  }
  return null;
}
