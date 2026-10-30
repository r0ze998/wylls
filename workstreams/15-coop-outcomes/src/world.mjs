// Applies normalized events to a model of the world: who is in which nation,
// which lots of goods exist and who holds them, caravans, projects (material
// inputs), structures (completion) and their uses, keeps and raids. Each
// event gets an outcome `{id, ok, code}`; nothing is credited here, the goals
// read this model (goals.mjs).
//
// Goods are lots: a lot has one resource, a quantity, a holder and an origin
// (the holder it had when it entered the period, or was produced). A lot is
// drawn down when it is sent or put into a project, so the same goods can be
// consumed once only, however often they changed hands.
import { tainted } from './ledger.mjs';

/** How a quantity is known, from best to worst. */
const TRUST = ['chain', 'derived', 'chain_lower_bound', 'unverified'];
const worst = (a, b) => (TRUST.indexOf(a) > TRUST.indexOf(b) ? a : b);
/** `exact`, `lower_bound` or `none`: what a quantity of that trust may count as. */
export const countsAs = v => (v === 'chain' || v === 'derived' ? 'exact' : v === 'chain_lower_bound' ? 'lower_bound' : 'none');

/**
 * Builds the model. `closeAt` is the bell the period closes at for this
 * pass (the scheduled end, or a joint chapter's close in variant C); `costs`
 * the structures' material requirements; `jointGoals` the ruleset's joint
 * goals by id (their requirements apply to their projects).
 */
export function buildWorld({ state, events, taint, gapFrom = {}, closeAt, costs, jointGoals }) {
  const W = {
    closeAt, gapFrom,
    opensAt: state.period.opensAt,
    actors: new Map(), lots: new Map(), ships: new Map(), projects: new Map(), structures: new Map(),
    keeps: new Map(), keepHistory: [], keepsAtClose: null, territory: {}, territoryAtClose: null,
    nationGoals: {}, sightings: new Map(), raids: [], outcomes: [], towerInput: false,
    nations: (state.nations ?? []).map(n => (typeof n === 'string' ? n : n.id)).sort(),
  };
  for (const a of state.actors ?? []) {
    W.actors.set(a.id, { id: a.id, nation: a.nation ?? null, cluster: a.cluster ?? a.id, kind: a.kind ?? 'human', joinedAt: a.joinedAt ?? state.period.opensAt, expelled: false, history: [{ at: state.period.opensAt, nation: a.nation ?? null }] });
  }
  for (const l of state.lots ?? []) {
    const owner = W.actors.get(l.owner);
    W.lots.set(l.lot, { id: l.lot, owner: l.owner, resource: l.resource, qty: l.qty, verified: l.verified ?? 'chain', origin: { actor: l.owner, nation: owner?.nation ?? null }, path: [l.lot], at: state.period.opensAt });
  }
  for (const k of state.keeps ?? []) {
    W.keeps.set(k.keep, { nation: k.nation, since: state.period.opensAt });
    W.keepHistory.push({ keep: k.keep, nation: k.nation, at: state.period.opensAt, id: 'state' });
  }
  Object.assign(W.territory, state.territory ?? {});

  const out = (e, ok, code = null, extra = {}) => W.outcomes.push({ id: e.id, kind: e.kind, at: e.at, ok, code, tainted: tainted(taint, e), ...extra });
  const nationOf = id => W.actors.get(id)?.nation ?? null;
  const snapshot = () => {
    if (W.keepsAtClose) return;
    W.keepsAtClose = new Map([...W.keeps].map(([k, v]) => [k, { ...v }]));
    W.territoryAtClose = { ...W.territory };
  };

  for (const e of events) {
    if (e.at > closeAt) snapshot();
    const late = e.at > closeAt;
    switch (e.kind) {
      case 'actor.join': {
        const a = W.actors.get(e.actor);
        if (!W.nations.includes(e.nation)) W.nations = [...W.nations, e.nation].sort();
        if (a) { a.nation = e.nation; a.expelled = false; a.history.push({ at: e.at, nation: e.nation }); }
        else W.actors.set(e.actor, { id: e.actor, nation: e.nation, cluster: e.cluster ?? e.actor, kind: e.actorKind ?? 'human', joinedAt: e.at, expelled: false, history: [{ at: e.at, nation: e.nation }] });
        out(e, true);
        break;
      }
      case 'actor.move': case 'actor.expel': {
        const a = W.actors.get(e.actor);
        if (!a) { out(e, false, 'causality'); break; }
        a.nation = e.kind === 'actor.move' ? e.nation : null;
        a.expelled = e.kind === 'actor.expel';
        a.history.push({ at: e.at, nation: a.nation });
        out(e, true);
        break;
      }
      case 'lot.produce': {
        // `#` is reserved for lots the evaluator names (arrivals, raids).
        if (W.lots.has(e.lot) || e.lot.includes('#')) { out(e, false, 'conflict'); break; }
        W.lots.set(e.lot, { id: e.lot, owner: e.owner, resource: e.resource, qty: e.qty, verified: e.verified, origin: { actor: e.owner, nation: nationOf(e.owner) }, path: [e.lot], at: e.at, evidence: [e.id] });
        out(e, true);
        break;
      }
      case 'ship.send': {
        if (W.ships.has(e.ship)) { out(e, false, 'conflict'); break; }
        // A caravan addressed to a project (`project:<id>`, ①'s request board) goes to its steward
        // and, on arrival, counts as the sender's input into it.
        const project = typeof e.to === 'string' && e.to.startsWith('project:') ? W.projects.get(e.to.slice(8)) : null;
        if (typeof e.to === 'string' && e.to.startsWith('project:') && !project) { out(e, false, 'causality'); break; }
        const parts = draw(W, e.from, e.resource, e.qty, e.lot);
        if (!parts.ok) { out(e, false, parts.code); break; }
        W.ships.set(e.ship, { id: e.ship, from: e.from, to: project ? project.steward : e.to, project: project?.id ?? null, fromNation: nationOf(e.from), resource: e.resource, qty: e.qty, parts: parts.parts, state: 'moving', sentAt: e.at, verified: e.verified, evidence: [e.id], tainted: tainted(taint, e) });
        out(e, true);
        break;
      }
      case 'ship.arrive': {
        const s = W.ships.get(e.ship);
        if (!s) { out(e, false, 'causality'); break; }
        if (s.state !== 'moving') { out(e, false, 'already_settled'); break; }
        if (e.qty > s.qty) { out(e, false, 'qty_exceeds_sent'); break; }
        s.state = 'arrived'; s.arrivedAt = e.at; s.late = late;
        s.evidence.push(e.id);
        const v = worst(s.verified, e.verified);
        // The arrived quantity is taken from the ship's parts in order; any shortfall was lost on the way.
        let left = e.qty;
        s.parts.forEach((p, i) => {
          const q = Math.min(left, p.qty);
          left -= q;
          if (q > 0) W.lots.set(`${s.id}#${i}`, { id: `${s.id}#${i}`, owner: s.to, resource: s.resource, qty: q, verified: worst(v, p.verified), origin: p.origin, path: [...p.path, s.id], at: e.at, ship: s.id, late, evidence: [...s.evidence], tainted: s.tainted || tainted(taint, e) });
        });
        const p = s.project ? W.projects.get(s.project) : null;
        if (p && !p.completed) {
          const a = W.actors.get(s.from);
          s.parts.forEach((part, i) => {
            const l = W.lots.get(`${s.id}#${i}`);
            if (!l || !(l.resource in p.requires) || !p.requires[l.resource]) return;
            p.inputs.push({ id: `${e.id}/${i}`, at: e.at, actor: s.from, nation: s.fromNation, cluster: a?.cluster ?? s.from, lot: l.id, resource: l.resource, qty: l.qty, verified: l.verified, origin: l.origin, path: l.path, late: e.at > p.deadline, lotLate: !!l.late, evidence: [...l.evidence], tainted: !!l.tainted });
            l.qty = 0;
          });
        }
        out(e, true, late ? 'late' : p?.completed ? 'project_closed' : v === 'unverified' ? 'unverified_qty' : v === 'chain_lower_bound' ? 'lower_bound' : null, { ship: s.id });
        break;
      }
      case 'ship.raid': {
        const s = W.ships.get(e.ship);
        if (!s) { out(e, false, 'causality'); break; }
        if (s.state !== 'moving') { out(e, false, 'already_settled'); break; }
        if (e.taken + e.burned > s.qty) { out(e, false, 'qty_exceeds_sent'); break; }
        s.state = 'raided'; s.raidedAt = e.at;
        const victimNation = s.fromNation;
        const raiderNation = nationOf(e.raider);
        let left = e.taken;
        s.parts.forEach((p, i) => {
          const q = Math.min(left, p.qty);
          left -= q;
          // Taken goods keep their origin: a raid cannot launder another nation's goods into one's own.
          if (q > 0) W.lots.set(`${s.id}#raid${i}`, { id: `${s.id}#raid${i}`, owner: e.raider, resource: s.resource, qty: q, verified: worst(worst(s.verified, e.verified), p.verified), origin: p.origin, path: [...p.path, s.id, 'raid'], at: e.at, ship: s.id, raided: true, late, evidence: [...s.evidence, e.id], tainted: s.tainted || tainted(taint, e) });
        });
        W.raids.push({ id: e.id, ship: s.id, raider: e.raider, raiderNation, victim: s.from, victimNation, resource: s.resource, taken: e.taken, burned: e.burned, at: e.at, domestic: raiderNation !== null && raiderNation === victimNation, late, tainted: tainted(taint, e) });
        out(e, true, late ? 'after_close' : null);
        break;
      }
      case 'ship.lost': {
        const s = W.ships.get(e.ship);
        if (!s) { out(e, false, 'causality'); break; }
        if (s.state !== 'moving') { out(e, false, 'already_settled'); break; }
        s.state = 'lost';
        out(e, true);
        break;
      }
      case 'project.open': {
        if (W.projects.has(e.project)) { out(e, false, 'conflict'); break; }
        if (!W.actors.has(e.steward)) { out(e, false, 'causality'); break; }
        const joint = jointGoals[e.goal];
        const structure = joint?.structure ?? e.structure;
        const requires = joint?.requires ?? costs[structure];
        if (!requires) { out(e, false, 'goal_not_in_ruleset'); break; }
        // A goal this ruleset does not judge (variant A has none) still opens: the goods move in the world.
        const untracked = !joint && e.goal !== 'own';
        W.projects.set(e.project, { id: e.project, goal: e.goal, joint: !!joint, untracked, structure, requires, steward: e.steward, stewardNation: nationOf(e.steward), openedAt: e.at, deadline: Math.min(e.deadline ?? Infinity, closeAt), inputs: [], completed: null, evidence: [e.id], tainted: tainted(taint, e), late });
        out(e, true, late ? 'after_close' : untracked ? 'goal_not_in_ruleset' : null);
        break;
      }
      case 'contribute': {
        const p = W.projects.get(e.project);
        const l = W.lots.get(e.lot);
        if (!p || !l) { out(e, false, 'causality'); break; }
        if (l.owner !== e.actor) { out(e, false, 'not_owner'); break; }
        if (!(l.resource in p.requires) || !p.requires[l.resource]) { out(e, false, 'not_required'); break; }
        if (e.qty > l.qty) { out(e, false, 'insufficient'); break; }
        if (p.completed) { out(e, false, 'project_closed'); break; }
        l.qty -= e.qty;
        const a = W.actors.get(e.actor);
        const input = { id: e.id, at: e.at, actor: e.actor, nation: a?.nation ?? null, cluster: a?.cluster ?? e.actor, lot: l.id, resource: l.resource, qty: e.qty, verified: worst(l.verified, e.verified), origin: l.origin, path: l.path, late: e.at > p.deadline, lotLate: !!l.late, evidence: [...(l.evidence ?? []), e.id], tainted: !!l.tainted || tainted(taint, e) };
        p.inputs.push(input);
        out(e, true, input.late ? 'late' : null);
        break;
      }
      case 'build.complete': {
        const p = W.projects.get(e.project);
        if (!p) { out(e, false, 'causality'); break; }
        if (p.completed) { out(e, false, 'project_closed'); break; }
        if (W.structures.has(e.structure)) { out(e, false, 'conflict'); break; }
        if ((e.by ?? p.steward) !== p.steward) { out(e, false, 'not_steward'); break; }
        if (e.structureKind !== undefined && e.structureKind !== p.structure) { out(e, false, 'wrong_structure'); break; }
        // The program builds from what the steward holds; inputs short of the requirement mean
        // the structure stands on goods this evaluator cannot trace to the project.
        const have = {};
        for (const i of p.inputs) if (!i.late) have[i.resource] = (have[i.resource] ?? 0) + i.qty;
        const short = Object.entries(p.requires).filter(([r, q]) => (have[r] ?? 0) < q).map(([r]) => r);
        p.completed = { at: e.at, structure: e.structure, id: e.id, late: e.at > p.deadline, shortAtCompletion: short, tainted: tainted(taint, e) };
        W.structures.set(e.structure, { id: e.structure, project: p.id, kind: p.structure, steward: p.steward, nation: p.stewardNation, builtAt: e.at, seizedAt: null, uses: [], evidence: [e.id] });
        out(e, true, short.length ? 'inputs_incomplete' : p.completed.late ? 'late' : null);
        break;
      }
      case 'structure.seized': {
        const s = W.structures.get(e.structure);
        if (!s) { out(e, false, 'causality'); break; }
        if (s.seizedAt === null) { s.seizedAt = e.at; s.seizedBy = e.by; }
        out(e, true);
        break;
      }
      case 'use': {
        const s = W.structures.get(e.structure);
        if (!s || s.builtAt > e.at) { out(e, false, 'causality'); break; }
        const a = W.actors.get(e.actor);
        const seized = s.seizedAt !== null && s.seizedAt <= e.at;
        s.uses.push({ id: e.id, at: e.at, actor: e.actor, nation: a?.nation ?? null, cluster: a?.cluster ?? e.actor, how: e.how, qty: e.qty ?? null, seized, late, tainted: tainted(taint, e) });
        out(e, true, seized ? 'seized' : late ? 'after_close' : null);
        break;
      }
      case 'keep.set': {
        const prev = W.keeps.get(e.keep);
        W.keeps.set(e.keep, { nation: e.nation, since: e.at, tainted: tainted(taint, e) });
        W.keepHistory.push({ keep: e.keep, nation: e.nation, from: prev?.nation ?? null, at: e.at, id: e.id, tainted: tainted(taint, e) });
        out(e, true, late ? 'after_close' : null);
        break;
      }
      case 'territory.counter': {
        W.territory[e.nation] = e.bells;
        out(e, true, late ? 'after_close' : null);
        break;
      }
      case 'nation.goal': {
        if (!late) W.nationGoals[e.nation] = { goal: e.goal, id: e.id };
        out(e, !late, late ? 'after_close' : null);
        break;
      }
      case 'tower.sighting': {
        W.towerInput = true;
        W.sightings.set(e.sighting, { id: e.sighting, tower: e.tower, actor: e.actor, at: e.at, usedBy: [], evidence: [e.id], tainted: tainted(taint, e) });
        out(e, true);
        break;
      }
      case 'tower.report.used': {
        W.towerInput = true;
        const s = W.sightings.get(e.sighting);
        if (!s) { out(e, false, 'causality'); break; }
        const a = W.actors.get(e.actor);
        s.usedBy.push({ id: e.id, actor: e.actor, cluster: a?.cluster ?? e.actor, at: e.at, late, tainted: tainted(taint, e) });
        out(e, true, late ? 'after_close' : null);
        break;
      }
      case 'position': break;
      default: out(e, false, 'unknown_kind');
    }
  }
  snapshot();
  return W;
}

/**
 * Takes `qty` of `resource` from `owner`'s lots (the named `lot`, else the
 * oldest first): `{ok, parts}` with each part's lot, quantity, origin and
 * path, or `{ok: false, code}` when they do not hold that much.
 */
function draw(W, owner, resource, qty, lotId) {
  const lots = lotId !== undefined
    ? [W.lots.get(lotId)].filter(Boolean)
    : [...W.lots.values()].filter(l => l.owner === owner && l.resource === resource && l.qty > 0).sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));
  if (lotId !== undefined) {
    const l = lots[0];
    if (!l) return { ok: false, code: 'causality' };
    if (l.owner !== owner) return { ok: false, code: 'not_owner' };
    if (l.resource !== resource) return { ok: false, code: 'malformed' };
  }
  if (lots.reduce((s, l) => s + l.qty, 0) < qty) return { ok: false, code: 'insufficient' };
  const parts = [];
  let left = qty;
  for (const l of lots) {
    if (!left) break;
    const q = Math.min(left, l.qty);
    l.qty -= q;
    left -= q;
    parts.push({ lot: l.id, qty: q, origin: l.origin, path: l.path, verified: l.verified });
  }
  return { ok: true, parts };
}
