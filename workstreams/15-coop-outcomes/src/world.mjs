// Applies normalized events to a model of the world: who is in which nation,
// which lots of goods exist and who holds them, caravans, projects (material
// inputs), structures (completion) and their uses, keeps and raids. Each
// event gets an outcome `{id, ok, code}`; nothing is credited here, the goals
// read this model (goals.mjs).
//
// The world has no end. It knows no evaluation window: nothing in it expires,
// closes or resets when a window (a war period, an evaluation period) ends.
// Windows are applied only when goals are judged. The model can be saved at
// any bell (`snapshotOf`) and resumed from it (`buildWorld({resume})`): a
// resumed world equals one replayed from the start.
//
// Goods are lots: a lot has one resource, a quantity, a holder and an origin
// (the holder it had when it entered the world, or was produced). A lot is
// drawn down when it is sent or put into a project, so the same goods can be
// consumed once only, however often they changed hands.
import { tainted } from './ledger.mjs';
import { RESOURCES, qtyKindOf } from './contract.mjs';

/**
 * A lot's path (the lot it started as, then the caravans it came through) is
 * for reading, not for judging: the origin is kept apart. Goods in a world
 * that never ends can hop forever, so a path keeps its first entry and the
 * last `PATH_KEEP` hops; `hops` counts them all.
 */
export const PATH_KEEP = 16;
const extend = (path, ...xs) => [path[0], ...[...path.slice(1), ...xs].slice(-PATH_KEEP)];

/** How a quantity is known, from best to worst. */
const TRUST = ['chain', 'derived', 'chain_lower_bound', 'unverified'];
export const worst = (a, b) => (TRUST.indexOf(a) > TRUST.indexOf(b) ? a : b);
/** `exact`, `lower_bound` or `none`: what a quantity of that trust may count as. */
export const countsAs = v => (v === 'chain' || v === 'derived' ? 'exact' : v === 'chain_lower_bound' ? 'lower_bound' : 'none');
/** Quantity kinds from most to least certain (`zero` creates no goods, so it never reaches a lot). */
const QTY_ORDER = ['exact', 'lower_bound', 'unknown'];
export const worstQty = (a, b) => (QTY_ORDER.indexOf(a) > QTY_ORDER.indexOf(b) ? a : b);
const qtyOfTrust = v => (countsAs(v) === 'exact' ? 'exact' : countsAs(v) === 'lower_bound' ? 'lower_bound' : 'unknown');

/** The bell a world state describes: a snapshot's, else the state's (`state.at`, or the legacy `state.period.opensAt`). */
export const stateAt = state => state.at ?? state.period?.opensAt ?? 0;

/**
 * Builds the model from `state` (the world at some bell, not the start of a
 * period) or from a saved snapshot (`resume`), then the events. `costs`: the
 * structures' material requirements; `jointGoals`: the ruleset's joint goals
 * by id (their requirements apply to their projects).
 */
export function buildWorld({ state, events, taint = {}, gapFrom = {}, costs, jointGoals, resume = null }) {
  const W = resume ? restore(resume) : fresh(state);
  W.gapFrom = gapFrom;
  const out = (e, ok, code = null, extra = {}) => W.outcomes.push({ id: e.id, kind: e.kind, at: e.at, ok, code, tainted: tainted(taint, e), ...extra });
  const nationOf = id => W.actors.get(id)?.nation ?? null;
  const flow = r => W.flow[r];

  for (const e of events) {
    // A record already applied (before a snapshot, or delivered again after a restart) is not applied twice.
    // Several events derived from one record (`sub`) share its position and arrive together.
    const current = W.current?.[e.stream] === e.seq;
    if (!current && hasPos(W.applied[e.stream], e.seq)) { out(e, false, 'replayed'); continue; }
    if (e.at < W.at) { out(e, false, 'causality'); continue; }
    W.applied[e.stream] = addPos(W.applied[e.stream] ?? [], e.seq);
    (W.current ??= {})[e.stream] = e.seq;
    W.at = e.at;
    switch (e.kind) {
      case 'actor.join': {
        const a = W.actors.get(e.actor);
        if (!W.nations.includes(e.nation)) { W.nations = [...W.nations, e.nation].sort(); W.nationSince[e.nation] = e.at; }
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
        if (W.lots.has(e.lot) || W.names.has(e.lot) || W.spentLots.has(e.lot) || e.lot.includes('#')) { out(e, false, 'conflict'); break; }
        placeLot(W, { id: e.lot, owner: e.owner, resource: e.resource, qty: e.qty, verified: e.verified, origin: { actor: e.owner, nation: nationOf(e.owner) }, path: [e.lot], at: e.at, evidence: [e.id], tainted: tainted(taint, e) });
        flow(e.resource).produced += e.qty;
        out(e, true);
        break;
      }
      case 'ship.send': {
        if (W.ships.has(e.ship) || W.settledShips.has(e.ship)) { out(e, false, 'conflict'); break; }
        // A caravan addressed to a project (`project:<id>`, ①'s request board) goes to its steward
        // and, on arrival, counts as the sender's input into it.
        const project = typeof e.to === 'string' && e.to.startsWith('project:') ? W.projects.get(e.to.slice(8)) : null;
        if (typeof e.to === 'string' && e.to.startsWith('project:') && !project) { out(e, false, 'causality'); break; }
        // `fromOutside`: the record proves the caravan left with this cargo, but the evaluator does not
        // hold the sender's stock (①'s and ④'s outputs carry no stock). The goods enter the model at
        // the send, from the sender; nothing is produced or drawn from another holding.
        const parts = e.fromOutside
          ? { ok: true, parts: [{ lot: null, qty: e.qty, origin: { actor: e.from, nation: nationOf(e.from) }, path: [`outside:${e.ship}`], hops: 0, verified: e.verified, qtyKind: 'exact' }] }
          : draw(W, e.from, e.resource, e.qty, e.lot);
        if (!parts.ok) { out(e, false, parts.code); break; }
        if (e.fromOutside) flow(e.resource).enteredAtSend += e.qty;
        flow(e.resource).sent += e.qty;
        W.ships.set(e.ship, { id: e.ship, from: e.from, to: project ? project.steward : e.to, project: project?.id ?? null, fromNation: nationOf(e.from), resource: e.resource, qty: e.qty, parts: parts.parts, state: 'moving', sentAt: e.at, verified: e.verified, evidence: [e.id], tainted: tainted(taint, e) });
        out(e, true);
        break;
      }
      case 'ship.arrive': {
        const s = W.ships.get(e.ship);
        if (!s) { out(e, false, W.settledShips.has(e.ship) ? 'already_settled' : 'causality'); break; }
        if (s.state !== 'moving') { out(e, false, 'already_settled'); break; }
        if (e.qty > s.qty) { out(e, false, 'qty_exceeds_sent'); break; }
        s.state = 'arrived'; s.arrivedAt = e.at;
        s.evidence.push(e.id);
        const v = worst(s.verified, e.verified);
        const qk = qtyKindOf(e);
        if (qk === 'zero') s.knownZero = true;
        // The arrived quantity is taken from the ship's parts in order; any shortfall was lost on the way.
        flow(s.resource).lost += s.qty - e.qty;
        flow(s.resource).arrived[countsAs(v) === 'exact' ? 'exact' : countsAs(v) === 'lower_bound' ? 'lowerBound' : 'unverified'] += e.qty;
        let left = e.qty;
        s.parts.forEach((p, i) => {
          const q = Math.min(left, p.qty);
          left -= q;
          // Goods arriving for a project are put in at once; others join the holder's goods of the same kind.
          // The fraction a lower bound or unknown amount may hide (< 1 unit per arrival, ④ §3) rides with the
          // goods as `slack`, once per arrival (on its first part) plus what the sent goods already carried.
          const lotKind = worstQty(worstQty(qk, p.qtyKind ?? 'exact'), qtyOfTrust(worst(v, p.verified)));
          const slack = (p.slack ?? 0) + (i === 0 && lotKind !== 'exact' ? 1 : 0);
          if (q > 0) placeLot(W, { id: `${s.id}#${i}`, owner: s.to, resource: s.resource, qty: q, verified: worst(v, p.verified), qtyKind: lotKind, slack, origin: p.origin, path: extend(p.path, s.id), hops: (p.hops ?? 0) + 1, at: e.at, ship: s.id, evidence: [...s.evidence], tainted: s.tainted || tainted(taint, e) }, !s.project);
        });
        const p = s.project ? W.projects.get(s.project) : null;
        if (p && !p.completed) {
          const a = W.actors.get(s.from);
          s.parts.forEach((part, i) => {
            const l = W.lots.get(`${s.id}#${i}`);
            if (!l || !(l.resource in p.requires) || !p.requires[l.resource]) return;
            p.inputs.push({ id: `${e.id}/${i}`, at: e.at, lotAt: l.at, actor: s.from, nation: s.fromNation, cluster: a?.cluster ?? s.from, lot: l.id, resource: l.resource, qty: l.qty, verified: l.verified, qtyKind: l.qtyKind ?? 'exact', slack: l.slack ?? 0, origin: l.origin, path: l.path, evidence: [...l.evidence], tainted: !!l.tainted });
            l.qty = 0;
            spend(W, l);
          });
        }
        settle(W, s);
        out(e, true, p?.completed ? 'project_closed' : v === 'unverified' ? 'unverified_qty' : v === 'chain_lower_bound' ? 'lower_bound' : null, { ship: s.id });
        break;
      }
      case 'ship.raid': {
        const s = W.ships.get(e.ship);
        if (!s) { out(e, false, W.settledShips.has(e.ship) ? 'already_settled' : 'causality'); break; }
        if (s.state !== 'moving') { out(e, false, 'already_settled'); break; }
        if (e.taken + e.burned > s.qty) { out(e, false, 'qty_exceeds_sent'); break; }
        s.state = 'raided'; s.raidedAt = e.at;
        const victimNation = s.fromNation;
        const raiderNation = nationOf(e.raider);
        flow(s.resource).burned += e.burned;
        flow(s.resource).raidedTaken += e.taken;
        flow(s.resource).lost += s.qty - e.taken - e.burned;
        let left = e.taken;
        s.parts.forEach((p, i) => {
          const q = Math.min(left, p.qty);
          left -= q;
          // Taken goods keep their origin: a raid cannot launder another nation's goods into one's own.
          if (q > 0) placeLot(W, { id: `${s.id}#raid${i}`, owner: e.raider, resource: s.resource, qty: q, verified: worst(worst(s.verified, e.verified), p.verified), qtyKind: p.qtyKind ?? 'exact', slack: p.slack ?? 0, origin: p.origin, path: extend(p.path, s.id, 'raid'), hops: (p.hops ?? 0) + 1, at: e.at, ship: s.id, raided: true, evidence: [...s.evidence, e.id], tainted: s.tainted || tainted(taint, e) });
        });
        W.raids.push({ id: e.id, ship: s.id, raider: e.raider, raiderNation, victim: s.from, victimNation, resource: s.resource, taken: e.taken, burned: e.burned, at: e.at, domestic: raiderNation !== null && raiderNation === victimNation, tainted: tainted(taint, e) });
        settle(W, s);
        out(e, true);
        break;
      }
      case 'ship.lost': {
        const s = W.ships.get(e.ship);
        if (!s) { out(e, false, W.settledShips.has(e.ship) ? 'already_settled' : 'causality'); break; }
        if (s.state !== 'moving') { out(e, false, 'already_settled'); break; }
        s.state = 'lost';
        // `cause: 'unconfirmed'`: it settled elsewhere with no raid record (④'s DestinationMismatch). Nobody is named.
        if (e.cause) s.cause = e.cause;
        flow(s.resource).lost += s.qty;
        settle(W, s);
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
        // A project's own deadline is the project's; it is not tied to any evaluation window.
        W.projects.set(e.project, { id: e.project, goal: e.goal, joint: !!joint, untracked, structure, requires, steward: e.steward, stewardNation: nationOf(e.steward), openedAt: e.at, deadline: e.deadline ?? null, inputs: [], completed: null, evidence: [e.id], tainted: tainted(taint, e) });
        out(e, true, untracked ? 'goal_not_in_ruleset' : null);
        break;
      }
      case 'contribute': {
        const p = W.projects.get(e.project);
        const l = lotOf(W, e.lot);
        if (p && !l && W.names.has(e.lot)) { out(e, false, 'insufficient'); break; }
        if (!p || !l) { out(e, false, 'causality'); break; }
        if (l.owner !== e.actor) { out(e, false, 'not_owner'); break; }
        if (!(l.resource in p.requires) || !p.requires[l.resource]) { out(e, false, 'not_required'); break; }
        if (e.qty > namedLeft(W, e.lot, l)) { out(e, false, 'insufficient'); break; }
        if (p.completed) { out(e, false, 'project_closed'); break; }
        l.qty -= e.qty;
        useName(W, e.lot, e.qty);
        const a = W.actors.get(e.actor);
        // A lot's slack goes with its first draw, so splitting it never multiplies the fraction.
        const slack = l.slack ?? 0;
        l.slack = 0;
        spend(W, l);
        p.inputs.push({ id: e.id, slack, at: e.at, lotAt: l.at, actor: e.actor, nation: a?.nation ?? null, cluster: a?.cluster ?? e.actor, lot: l.id, resource: l.resource, qty: e.qty, verified: worst(l.verified, e.verified), qtyKind: worstQty(l.qtyKind ?? 'exact', qtyOfTrust(worst(l.verified, e.verified))), origin: l.origin, path: l.path, evidence: [...(l.evidence ?? []), e.id], tainted: !!l.tainted || tainted(taint, e) });
        out(e, true);
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
        for (const i of p.inputs) have[i.resource] = (have[i.resource] ?? 0) + i.qty;
        const short = Object.entries(p.requires).filter(([r, q]) => (have[r] ?? 0) < q).map(([r]) => r);
        p.completed = { at: e.at, structure: e.structure, id: e.id, shortAtCompletion: short, tainted: tainted(taint, e) };
        W.structures.set(e.structure, { id: e.structure, project: p.id, kind: p.structure, steward: p.steward, nation: p.stewardNation, builtAt: e.at, seizedAt: null, uses: [], evidence: [e.id] });
        out(e, true, short.length ? 'inputs_incomplete' : null);
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
        s.uses.push({ id: e.id, at: e.at, actor: e.actor, nation: a?.nation ?? null, cluster: a?.cluster ?? e.actor, how: e.how, qty: e.qty ?? null, seized, tainted: tainted(taint, e) });
        out(e, true, seized ? 'seized' : null);
        break;
      }
      case 'keep.set': {
        W.keepHistory.push({ keep: e.keep, nation: e.nation, at: e.at, id: e.id, tainted: tainted(taint, e) });
        out(e, true);
        break;
      }
      case 'territory.counter': {
        W.territoryHistory.push({ nation: e.nation, bells: e.bells, at: e.at, id: e.id });
        out(e, true);
        break;
      }
      case 'nation.goal': {
        W.nationGoals.push({ nation: e.nation, goal: e.goal, at: e.at, id: e.id });
        out(e, true);
        break;
      }
      case 'tower.request.posted': case 'tower.request.taken': case 'tower.request.fulfilled': {
        // ⑭'s notice board, kept as reported (model facts): posting is not a sighting, taking is a send.
        W.towerInput = true;
        const k = String(e.req);
        const b = W.board.find(x => x.req === k) ?? (W.board.push({ req: k, posted: null, taken: [], fulfilled: null }), W.board[W.board.length - 1]);
        const a = W.actors.get(e.actor);
        const rec = { id: e.id, at: e.at, actor: e.actor, nation: a?.nation ?? e.nation ?? null, cluster: a?.cluster ?? e.actor, cross: e.cross ?? null, verified: e.verified, tainted: tainted(taint, e),
          // ⑭ v1 names both sides: the poster on a take, the responder on a fulfilment.
          ...(e.poster !== undefined ? { poster: e.poster } : {}), ...(e.responder !== undefined ? { responder: e.responder } : {}) };
        if (e.kind === 'tower.request.posted') b.posted ??= rec;
        else if (e.kind === 'tower.request.taken') b.taken.push(rec);
        else b.fulfilled ??= rec;
        out(e, true, e.verified === 'model' ? 'model_only' : null);
        break;
      }
      case 'tower.relay.swap': {
        W.towerInput = true;
        W.relaySwaps.push({ id: e.id, at: e.at, actor: e.actor, cross: e.cross ?? null, verified: e.verified });
        out(e, true, e.verified === 'model' ? 'model_only' : null);
        break;
      }
      case 'model.boundary': {
        // Kept and reported; nothing closes, resets or settles here.
        W.modelBoundaries.push({ id: e.id, index: e.index, at: e.at, verified: e.verified });
        out(e, true, 'model_only');
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
        s.usedBy.push({ id: e.id, actor: e.actor, cluster: a?.cluster ?? e.actor, at: e.at, tainted: tainted(taint, e) });
        out(e, true);
        break;
      }
      case 'position': break;
      default: out(e, false, 'unknown_kind');
    }
  }
  return W;
}

function fresh(state) {
  const t0 = stateAt(state);
  const W = {
    at: t0, startedAt: t0, applied: {},
    actors: new Map(), lots: new Map(), ships: new Map(), projects: new Map(), structures: new Map(),
    keepHistory: [], territoryHistory: [], nationGoals: [], sightings: new Map(), raids: [], outcomes: [], towerInput: false, board: [], relaySwaps: [], modelBoundaries: [],
    nations: (state.nations ?? []).map(n => (typeof n === 'string' ? n : n.id)).sort(),
    settledShips: new Set(), spentLots: new Set(), names: new Map(), fungible: new Map(), newest: new Map(), nationSince: {},
    flow: Object.fromEntries(RESOURCES.map(r => [r, { initial: 0, produced: 0, enteredAtSend: 0, sent: 0, arrived: { exact: 0, lowerBound: 0, unverified: 0 }, raidedTaken: 0, burned: 0, lost: 0 }])),
  };
  for (const a of state.actors ?? []) {
    W.actors.set(a.id, { id: a.id, nation: a.nation ?? null, cluster: a.cluster ?? a.id, kind: a.kind ?? 'human', joinedAt: a.joinedAt ?? t0, expelled: false, history: [{ at: t0, nation: a.nation ?? null }] });
  }
  for (const l of state.lots ?? []) {
    const owner = W.actors.get(l.owner);
    placeLot(W, { id: l.lot, owner: l.owner, resource: l.resource, qty: l.qty, verified: l.verified ?? 'chain', origin: { actor: l.owner, nation: owner?.nation ?? null }, path: [l.lot], at: t0 });
    W.flow[l.resource].initial += l.qty;
  }
  for (const k of state.keeps ?? []) W.keepHistory.push({ keep: k.keep, nation: k.nation, at: t0, id: 'state' });
  for (const [nation, bells] of Object.entries(state.territory ?? {})) W.territoryHistory.push({ nation, bells, at: t0, id: 'state' });
  return W;
}

const MAPS = ['actors', 'lots', 'ships', 'projects', 'structures', 'sightings'];

/**
 * The world saved at its current bell: plain data, nothing about any window.
 * Outcomes (the per-event log) are not part of the world and are not saved.
 */
export function snapshotOf(W, at = W.at) {
  if (at < W.at) throw new Error('snapshot before the world\'s last event');
  const out = { version: 1, at, startedAt: W.startedAt, applied: W.applied };
  for (const k of MAPS) out[k] = [...W[k].values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const k of ['keepHistory', 'territoryHistory', 'nationGoals', 'raids', 'nations', 'flow', 'towerInput', 'board', 'relaySwaps']) out[k] = W[k];
  // Saved only when present, so a world without them keeps its digest.
  if (W.modelBoundaries.length) out.modelBoundaries = W.modelBoundaries;
  out.settledShips = [...W.settledShips].sort();
  out.spentLots = [...W.spentLots].sort();
  out.names = [...W.names].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  out.fungible = [...W.fungible].sort();
  out.newest = [...W.newest].sort();
  out.nationSince = W.nationSince;
  return structuredClone(out);
}

function restore(snap) {
  if (snap.version !== 1) throw new Error(`world snapshot version ${snap.version}`);
  const s = structuredClone(snap);
  const W = { at: s.at, startedAt: s.startedAt, applied: s.applied, outcomes: [], settledShips: new Set(s.settledShips), spentLots: new Set(s.spentLots), names: new Map(s.names), fungible: new Map(s.fungible), newest: new Map(s.newest), nationSince: s.nationSince };
  for (const k of MAPS) W[k] = new Map(s[k].map(x => [x.id, x]));
  for (const k of ['keepHistory', 'territoryHistory', 'nationGoals', 'raids', 'nations', 'flow', 'towerInput', 'board', 'relaySwaps', 'modelBoundaries']) W[k] = s[k] ?? (k === 'board' || k === 'relaySwaps' || k === 'modelBoundaries' ? [] : s[k]);
  return W;
}

/**
 * A settled caravan (arrived, raided, lost) and an emptied lot leave the live
 * state; their ids stay, so a replayed or reused id is still refused. This
 * keeps the live state to what is still under way in a world that never ends.
 */
function settle(W, s) { W.ships.delete(s.id); W.settledShips.add(s.id); }
function spend(W, l) {
  if (l.qty !== 0) return;
  W.lots.delete(l.id);
  W.spentLots.add(l.id);
  if (W.fungible.get(fungibleKey(l)) === l.id) W.fungible.delete(fungibleKey(l));
}

/**
 * Goods are fungible within a holder, a resource, an origin and a level of
 * trust (as a holding's stock is one balance on chain): a new lot joins an
 * existing one of the same kind, if that one is the holder's newest lot of
 * the resource (so first-in-first-out order and origins are unchanged).
 * Without this the live state would grow with every production and arrival.
 *
 * Every lot id stays a name with what is left under it: a draw by name can
 * take no more than that name was given, merged or not, and an emptied name
 * is refused as `insufficient`.
 */
const fungibleKey = l => `${l.owner}|${l.resource}|${l.origin.actor}|${l.origin.nation}|${l.verified}|${l.qtyKind ?? 'exact'}|${l.tainted ? 1 : 0}`;
const holdingKey = l => `${l.owner}|${l.resource}`;
function placeLot(W, lot, merge = true) {
  const k = fungibleKey(lot);
  const target = merge ? W.lots.get(W.fungible.get(k)) : null;
  const into = target && W.newest.get(holdingKey(lot)) === target.id ? target : null;
  W.names.set(lot.id, { to: into ? into.id : lot.id, left: lot.qty });
  if (!into) {
    W.lots.set(lot.id, lot);
    if (merge) W.fungible.set(k, lot.id);
    W.newest.set(holdingKey(lot), lot.id);
    return lot;
  }
  into.qty += lot.qty;
  into.slack = (into.slack ?? 0) + (lot.slack ?? 0);
  into.at = lot.at;
  into.hops = Math.max(into.hops ?? 0, lot.hops ?? 0);
  into.evidence = [...(into.evidence ?? []), ...(lot.evidence ?? [])].slice(-PATH_KEEP);
  return into;
}
const lotOf = (W, id) => W.lots.get(W.names.get(id)?.to ?? id);
/** What is left under a lot's name (never more than the lot holds). */
const namedLeft = (W, id, l) => Math.min(W.names.get(id)?.left ?? l.qty, l.qty);
function useName(W, id, q) { const n = W.names.get(id); if (n) n.left -= q; }

/** Positions applied per stream, as sorted closed ranges `[[from, to], …]` (a contiguous stream stays one range). */
function hasPos(ranges, x) {
  if (!ranges) return false;
  let lo = 0, hi = ranges.length - 1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (x < ranges[m][0]) hi = m - 1; else if (x > ranges[m][1]) lo = m + 1; else return true; }
  return false;
}
function addPos(ranges, x) {
  const r = [...ranges, [x, x]].sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [a, b] of r) {
    const last = out[out.length - 1];
    if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b); else out.push([a, b]);
  }
  return out;
}

/**
 * Goods accounted per resource (never across resources): what entered the
 * world (`initial + produced`) equals what is held, in transit, put into
 * projects, burned or lost. `balanced` is false if any goods appeared or
 * vanished.
 */
export function goodsBalance(W) {
  const out = {};
  const sum = () => Object.fromEntries(RESOURCES.map(r => [r, 0]));
  const held = sum(), transit = sum(), inProjects = sum();
  for (const l of W.lots.values()) held[l.resource] += l.qty;
  for (const s of W.ships.values()) if (s.state === 'moving') transit[s.resource] += s.qty;
  for (const p of W.projects.values()) for (const i of p.inputs) inProjects[i.resource] += i.qty;
  for (const r of RESOURCES) {
    const f = W.flow[r];
    const entered = f.initial + f.produced + (f.enteredAtSend ?? 0);
    const accounted = held[r] + transit[r] + inProjects[r] + f.burned + f.lost;
    out[r] = { entered, held: held[r], transit: transit[r], inProjects: inProjects[r], burned: f.burned, lost: f.lost, balanced: entered === accounted };
  }
  return out;
}

/**
 * Takes `qty` of `resource` from `owner`'s lots (the named `lot`, else the
 * oldest first): `{ok, parts}` with each part's lot, quantity, origin and
 * path, or `{ok: false, code}` when they do not hold that much.
 */
function draw(W, owner, resource, qty, lotId) {
  const lots = lotId !== undefined
    ? [lotOf(W, lotId)].filter(Boolean)
    : [...W.lots.values()].filter(l => l.owner === owner && l.resource === resource && l.qty > 0).sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));
  if (lotId !== undefined) {
    const l = lots[0];
    if (!l) return { ok: false, code: W.names.has(lotId) ? 'insufficient' : 'causality' };
    if (l.owner !== owner) return { ok: false, code: 'not_owner' };
    if (l.resource !== resource) return { ok: false, code: 'malformed' };
    if (qty > namedLeft(W, lotId, l)) return { ok: false, code: 'insufficient' };
    useName(W, lotId, qty);
  }
  if (lots.reduce((s, l) => s + l.qty, 0) < qty) return { ok: false, code: 'insufficient' };
  const parts = [];
  let left = qty;
  for (const l of lots) {
    if (!left) break;
    const q = Math.min(left, l.qty);
    l.qty -= q;
    left -= q;
    parts.push({ lot: l.id, qty: q, origin: l.origin, path: l.path, hops: l.hops ?? 0, verified: l.verified, qtyKind: l.qtyKind ?? 'exact', slack: l.slack ?? 0 });
    l.slack = 0;
    spend(W, l);
  }
  return { ok: true, parts };
}
