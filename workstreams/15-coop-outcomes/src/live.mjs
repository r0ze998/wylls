// The production wiring of the evaluator (owner decision 2026-11-18, ⑮ = B):
// the evaluator JUDGES co-op achievements and the result is shown as TITLES
// and CHRONICLE LINES only. No win, score, prize or season-end effect; inputs
// carry across evaluation windows (carryInputs: true, docs/07 M5); ruleset C is
// frozen (its code stays in rulesets.mjs for comparison, it is not reachable
// from here) and A is the legacy compatibility check only.
//
// Pure: no I/O. ①'s board (workstreams/01-national-strategy/coop/board.mjs,
// `/coop/outcomes`) reads the herald's `/h/events` pages and its own records,
// and passes them in. The same inputs give the same output (and the same
// `verdictHash`), so anyone holding the same records can replay it.
//
// What the live records can judge today (2026-11-18), and why:
//   - the S1 log gives caravans (sent, arrived, raided), structures, keeps and
//     fort garrisons; every Citizen tag is an actor (`tag:<u64>`), its nation
//     read from the records that state it (JOIN, CARAVAN_SENT, VAULT_BUILT)
//   - ①'s requests open a project only when their goal maps to a goal of B
//     (GOAL_MAP). ①'s only goal, `crossing-storehouse-v1` (a vault), has no
//     counterpart in B (whose joint goal is a fort): mapping one is a rule
//     decision, not made here (reported as blocked on the owner)
//   - so in the live world the personal goal P-raider and the national goals
//     can be judged; joint/supplier/founder/cross-user need a mapped goal
//   - (2026-11-22, owner decision 11:56 on Q1-⑮) ①'s board's proof that a request REACHED its requested amount
//     (`fulfilled`, contract ws01-fulfilled v1, coop/export.mjs fulfilmentsForEvaluators) feeds P-board-helper, the
//     「依頼に応えた」 title: to each deliverer of another nation whose own proven lower bound counted. GOAL_MAP stays
//     empty: the request's vault is still no project of B. The line is shown to its holder only (audience 'subject')
import { RULESETS } from './rulesets.mjs';
import { evaluate } from './evaluate.mjs';
import { hashOf } from './canon.mjs';
import { fromS1Records } from './adapters/s1-chain.mjs';
import { fromWs01Board } from './adapters/ws01.mjs';

/** The decision this module implements. */
export const PRODUCTION = Object.freeze({
  variant: 'B',
  decided: '2026-11-18',
  carryInputs: true,
  effects: 'titles-and-chronicle-only',
  frozen: Object.freeze(['C']),
  legacyOnly: Object.freeze(['A']),
});

/** What an outcome changes elsewhere: nothing. Every consumer can check this. */
export const NO_EFFECT = Object.freeze({ win: 'none', score: 'none', prize: 'none', seasonEnd: 'none' });

/** ①'s goal id → a goal of ruleset B. Empty: no mapping is decided (blocked on the owner). */
export const GOAL_MAP = Object.freeze({});

/** The six nations of S1 (decided: six, fixed); a faction byte f ≥ 6 is no nation. */
export const NATIONS = Object.freeze(['n0', 'n1', 'n2', 'n3', 'n4', 'n5']);
const nationOfFaction = f => (Number.isInteger(Number(f)) && Number(f) >= 0 && Number(f) < 6 ? `n${Number(f)}` : null);

/** The log's mark for a record written before the first turn (u32::MAX). */
const NO_TURN = 0xffffffff;

/**
 * The ruleset production uses. Only B, and only as decided: it throws instead of
 * returning anything that could end a window early, decide a prize, or drop carried inputs.
 */
export function productionRuleset() {
  const r = RULESETS[PRODUCTION.variant];
  if (!r || r.variant !== 'B') throw new Error('ws15 live: production ruleset must be B');
  if (r.carryInputs !== true) throw new Error('ws15 live: ruleset B must carry inputs across windows');
  if (r.prize !== null) throw new Error('ws15 live: ruleset B must decide no prize');
  if (r.close?.kind !== 'schedule') throw new Error('ws15 live: ruleset B must not close a window on an achievement');
  return r;
}

/** Titles, reasons (EN + JA), per goal of ruleset B. Words follow ⑦'s rules (a step is a turn; no internal words). */
export const TITLES = Object.freeze({
  'J-north-fort': {
    title: { ja: '北方の砦の共同建設者', en: 'Co-builder of the Northern Fort' },
    reason: { ja: '三つ以上の国の材料で砦が完成し、二つ以上の国の人に使われた。その材料を届けた', en: 'A fort was completed with materials from three or more nations and used by people of two or more nations; their materials went into it' },
  },
  'N-build-use': {
    title: { ja: '人のための建物の国', en: 'Nation that builds for others' },
    reason: { ja: '国の建物が完成し、ほかの人に使われた', en: 'One of the nation\'s buildings was completed and used by someone else' },
  },
  'N-hold': {
    title: { ja: '砦を守り通した国', en: 'Nation that held its keeps' },
    reason: { ja: '砦を持ち続けたターンが、国の人数に応じた目標に届いた', en: 'Held keeps for as many turns as its target, scaled by its size' },
  },
  'N-joint-share': {
    title: { ja: '共同の砦の参加国', en: 'Partner nation in a joint fort' },
    reason: { ja: '共同の砦に、条件を満たす国として材料を入れた', en: 'Put materials into a joint fort as a qualifying nation' },
  },
  'P-supplier': {
    title: { ja: '材料の届け手', en: 'Supplier' },
    reason: { ja: '完成した計画に、自分の材料を最小量以上入れた（資源ごとに数え、合計しない）', en: 'Put at least the minimum of one resource of their own into a completed plan (each resource counted on its own)' },
  },
  'P-cross-user': {
    title: { ja: '他国の建物の利用者', en: 'Guest of another nation' },
    reason: { ja: 'ほかの国の人の建物を使った', en: 'Used a building of someone from another nation' },
  },
  'P-founder': {
    title: { ja: '計画の発起人', en: 'Founder' },
    reason: { ja: '開いた計画が、ほかの二人以上の材料で完成した', en: 'A plan they opened was completed with materials from two or more others' },
  },
  'P-raider': {
    title: { ja: '他国の隊商を襲った者', en: 'Raider of foreign caravans' },
    reason: { ja: 'ほかの国の隊商から、一つの資源で最小量以上を奪った（国内の襲撃は数えない）', en: 'Took at least the minimum of one resource from another nation\'s caravans (raids at home do not count)' },
  },
  'P-scout': {
    title: { ja: '物見', en: 'Scout' },
    reason: { ja: '物見櫓の目撃が、ほかの人に使われた', en: 'A sighting from their watchtower was used by someone else' },
  },
  'P-board-helper': {
    title: { ja: '依頼に応えた', en: 'Answered a request' },
    reason: { ja: 'ほかの国の人の協力の依頼に、自分の隊商で荷を届け、その依頼が依頼量に届いた（数えた量の下限で証明）', en: 'Delivered goods by their own caravan to a co-op request from someone of another nation, and the request reached its amount (proven by the lower bound counted)' },
  },
});

/** Who may see an entry on the page: 'subject' = only the player it names (the request title); others: everyone. */
export const AUDIENCE = Object.freeze({ 'P-board-helper': 'subject' });

/** ①'s fulfilled-request proof (coop/export.mjs fulfilmentsForEvaluators) that this module reads. */
export const WS01_FULFILLED_V = 1;

/** The line every entry carries: what a title is, and what it is not. */
export const RECORD_ONLY = Object.freeze({ ja: '称号と記録だけ。勝敗・得点・賞金には関わらない', en: 'A title and a record only: it does not affect who wins, scores or prizes' });

/** Records whose `owner_tag` / `captor_tag` is a Citizen the S1 adapter names (other kinds use the field otherwise). */
const ACTOR_KINDS = new Set(['CARAVAN_SENT', 'CARAVAN_SETTLED', 'CARAVAN_RAIDED', 'STRUCTURE_BUILT', 'STRUCTURE_SEIZED', 'FORT_GARRISONED', 'VAULT_BUILT']);
const placeKey = pl => `place:${pl.kind}:${pl.p},${pl.q},${pl.site}`;

/**
 * The evaluator's input from the live records.
 *   rows       the herald's `/h/events` rows read from the start, in order: `{seq, bell, sig, record}`
 *              (`record`: the page's decoder's output, null for a kind it does not read) or
 *              `{seq, bad: true}` (a body that could not be decoded: left out, so it is a gap)
 *   season     `{genesisTs, bellSecs}` (the herald's `/h/season`), for ①'s request times
 *   board      ①'s board as `boardForEvaluators` gives it (ws01-board v1), or null
 *   tagOf      wallet (base58 or 32 bytes) → Citizen tag (decimal string), or null when unknown
 *   nowBell    the present turn: the one evaluation window is [0, max(nowBell, latest record's turn) + 1) unless `windows` is given
 * → `{input, notes}`.
 */
export function liveInput({ rows = [], season = null, board = null, fulfilled = null, tagOf = () => null, nowBell = 0, windows = null, goalMap = GOAL_MAP }) {
  const worldBell = b => (Number(b) >= NO_TURN ? 0 : Number(b));
  const decoded = rows.filter(r => !r.bad && r.record);
  const nation = new Map();   // actor → nation, first record that states it
  const setNation = (actor, n) => { if (actor && n && !nation.has(actor)) nation.set(actor, n); };
  const actors = new Set();
  const actorOfTag = t => (t === null || t === undefined ? null : `tag:${BigInt(t).toString()}`);
  const actorOfWallet = w => { const t = tagOf(w); return t === null || t === undefined ? null : actorOfTag(t); };
  for (const { record: r } of decoded) {
    if (r.name === 'JOIN') { const a = actorOfWallet(r.wallet); if (a) { actors.add(a); setNation(a, nationOfFaction(r.faction)); } }
    if (r.name === 'CARAVAN_SENT' || r.name === 'VAULT_BUILT') { const a = actorOfTag(r.owner_tag); actors.add(a); setNation(a, nationOfFaction(r.faction)); }
  }
  // A raid the log calls domestic was by someone of the victim's nation (a raider may never have sent a caravan).
  const senderNation = new Map(decoded.filter(x => x.record.name === 'CARAVAN_SENT').map(x => [`${x.record.owner_tag}:${x.record.seq}`, nationOfFaction(x.record.faction)]));
  for (const { record: r } of decoded) {
    if (r.name === 'CARAVAN_RAIDED') {
      const a = actorOfTag(r.raider_tag); actors.add(a); actors.add(actorOfTag(r.owner_tag));
      if (Number(r.domestic)) setNation(a, senderNation.get(`${r.owner_tag}:${r.seq}`) ?? nation.get(actorOfTag(r.owner_tag)) ?? null);
    }
    if (ACTOR_KINDS.has(r.name)) for (const f of ['owner_tag', 'captor_tag']) if (r[f] !== undefined) actors.add(actorOfTag(r[f]));
  }
  // ①'s board: only requests whose goal maps to a goal of B open a project.
  const bellOf = t => (season && Number(season.bellSecs) > 0 ? Math.max(0, Math.floor((Number(t) - Number(season.genesisTs)) / Number(season.bellSecs))) : 0);
  let w1 = { events: [], linkResolver: () => () => null, rejected: [] };
  if (board) {
    for (const q of board.requests ?? []) { const a = actorOfWallet(q.requester); if (a) actors.add(a); for (const l of q.links ?? []) { const b = actorOfWallet(l.responder); if (b) actors.add(b); } }
    w1 = fromWs01Board(board, {
      projectOf: q => (Object.hasOwn(goalMap, q.goalId) ? { project: `req:${q.id}`, goal: goalMap[q.goalId], steward: q.requester } : null),
      actorOf: actorOfWallet,
      bellOf,
    });
  }
  const f1 = fulfilledEvents(fulfilled, { rows: decoded, actorOfWallet, worldBell });
  for (const e of f1.events) { actors.add(e.actor); for (const d of e.deliverers) actors.add(d.actor); }
  const opened = new Set(w1.events.filter(e => e.kind === 'project.open').map(e => e.project));
  const link = w1.linkResolver(() => null);
  const sent = new Map();
  const resolve = {
    actorOfTag,
    // A caravan linked to a mapped request goes to its project; any other goes to the place (who keeps it there is not read).
    destination: (pl, tag, s, ctx) => { const hit = link(pl, tag, s, ctx); return hit && opened.has(hit.project) ? hit : { actor: placeKey(pl), kind: Number(pl.kind) === 2 ? 'storehouse' : 'village' }; },
    projectOfStructure: () => null,
    cargoSent: (t, s) => sent.get(`${t}:${s}`) ?? null,
  };
  const s1 = fromS1Records(decoded.map(x => ({ seq: x.seq, sig: x.sig, record: x.record })), resolve, { worldBell });
  // The sender's stock is not in this model: a caravan's cargo enters the world at its send.
  const events = s1.events.map(e => (e.kind === 'ship.send' ? { ...e, fromOutside: true } : e));
  // A record the page does not read holds its position (it is not a gap); a body that could not be decoded is a gap.
  for (const r of rows) if (!r.bad && !r.record) events.push({ id: `chain:${r.seq}:0`, stream: 'chain', seq: Number(r.seq), sub: 0, at: worldBell(r.bell ?? 0), kind: 'position', verified: 'chain' });
  events.push(...w1.events, ...f1.events);
  const ids = [...actors].filter(Boolean).sort();
  const first = rows.length ? Number(rows[0].seq) : 0;
  const state = {
    world: { id: 'live' },
    nations: [...NATIONS],
    actors: ids.map(id => ({ id, nation: nation.get(id) ?? null, kind: 'human' })),
    lots: [], keeps: [],
    streams: { chain: { from: first }, ws01: { from: 0 }, 'ws01-fulfilled': { from: 0, kinds: ['request.fulfilled'] } },
  };
  // The one window runs to the present turn: the clock's, or the latest record's when the clock reads earlier (a record
  // is never from the future; a herald whose season clock has not started still has its records judged).
  const lastBell = rows.reduce((m, r) => (!r.bad && Number.isFinite(Number(r.bell)) && Number(r.bell) < NO_TURN ? Math.max(m, Number(r.bell)) : m), 0);
  const input = { state, windows: windows ?? [{ id: 'world-so-far', opensAt: 0, endsAt: Math.max(Number(nowBell) || 0, lastBell) + 1 }], events };
  return { input, notes: { unresolved: s1.unresolved, skipped: s1.skipped.length, rejected: w1.rejected, bad: rows.filter(r => r.bad).map(r => String(r.seq)), fulfilled: f1.held } };
}

/**
 * ①'s fulfilled requests → `request.fulfilled` events (stream 'ws01-fulfilled', verified 'derived').
 *   fulfilled  `{v: 1, kind: 'ws01-fulfilled', requests: [{id, requester, need, deliverers: [{responder, counted,
 *              arrivals: [{caravanKey, signature}]}]}]}` or null
 * Re-checked here, not taken on trust: every requested resource's counted lower bounds add up to its amount; a
 * deliverer counts only with a positive lower bound of a requested resource. The turn is the latest of the counted
 * arrivals' CARAVAN_SETTLED records in the herald's rows (matched by signature): a request whose arrivals the rows do
 * not show yet waits (`held`), so the title never dates from a turn the public records cannot show.
 */
export function fulfilledEvents(fulfilled, { rows = [], actorOfWallet, worldBell = b => Number(b) }) {
  const events = [], held = [];
  if (!fulfilled) return { events, held };
  if (fulfilled.v !== WS01_FULFILLED_V || fulfilled.kind !== 'ws01-fulfilled' || !Array.isArray(fulfilled.requests)) return { events, held: [{ why: 'not ws01-fulfilled v1' }] };
  const settledAt = new Map();
  for (const r of rows) if (r.sig && r.record?.name === 'CARAVAN_SETTLED') settledAt.set(String(r.sig), worldBell(r.bell ?? 0));
  const int = v => Number.isSafeInteger(v) && v >= 0;
  const list = [];
  for (const q of fulfilled.requests) {
    const need = q?.need && typeof q.need === 'object' ? Object.fromEntries(Object.entries(q.need).filter(([, n]) => int(n) && n > 0)) : {};
    const requester = actorOfWallet(q?.requester);
    if (typeof q?.id !== 'string' || !Object.keys(need).length || !requester) { held.push({ request: q?.id ?? null, why: 'request or requester unknown' }); continue; }
    const byActor = new Map(), sigs = [];
    for (const d of q.deliverers ?? []) {
      const actor = actorOfWallet(d?.responder);
      const counted = Object.fromEntries(Object.entries(d?.counted ?? {}).filter(([r, v]) => Object.hasOwn(need, r) && int(v) && v > 0));
      if (!actor || !Object.keys(counted).length) continue;
      const c = byActor.get(actor) ?? {};
      for (const [r, v] of Object.entries(counted)) c[r] = (c[r] ?? 0) + v;
      byActor.set(actor, c);
      for (const a of d.arrivals ?? []) sigs.push(String(a?.signature ?? ''));
    }
    const total = {};
    for (const c of byActor.values()) for (const [r, v] of Object.entries(c)) total[r] = (total[r] ?? 0) + v;
    if (!Object.entries(need).every(([r, n]) => (total[r] ?? 0) >= n)) { held.push({ request: q.id, why: 'counted lower bounds below the requested amount' }); continue; }
    if (!sigs.length || sigs.some(x => !settledAt.has(x))) { held.push({ request: q.id, why: 'arrival not in the herald rows yet' }); continue; }
    const at = Math.max(...sigs.map(x => settledAt.get(x)));
    list.push({ at, req: q.id, actor: requester, need, deliverers: [...byActor].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)).map(([actor, counted]) => ({ actor, counted })), sigs: [...new Set(sigs)].sort() });
  }
  list.sort((x, y) => x.at - y.at || (x.req < y.req ? -1 : x.req > y.req ? 1 : 0));
  list.forEach((x, i) => events.push({ id: `ws01-fulfilled:${x.req}`, stream: 'ws01-fulfilled', seq: i, at: x.at, kind: 'request.fulfilled', verified: 'derived',
    req: x.req, actor: x.actor, need: x.need, deliverers: x.deliverers, src: { signatures: x.sigs } }));
  return { events, held };
}

/**
 * A verdict → the titles and chronicle the page shows. Built from the verdict's
 * awards (one per goal × window × independent participant), never from its
 * scores or prize: those fields are not copied at all.
 */
export function outcomesOf(verdict, input) {
  const atOf = new Map(input.events.map(e => [e.id, e.at]));
  const nationOf = new Map(input.state.actors.map(a => [a.id, a.nation]));
  const A = verdict.achievements;
  const entries = [];
  for (const a of verdict.awards) {
    const t = TITLES[a.goal];
    if (!t) continue;
    let reasons = [];
    let at = null;
    if (a.track === 'joint') { const j = A.joint.find(x => x.goal === a.goal); reasons = j?.reasons ?? []; at = j?.achievedAt ?? null; }
    else if (a.track === 'national') reasons = A.national.find(x => x.goal === a.goal && x.subject === a.beneficiary)?.reasons ?? [];
    else reasons = A.personal.find(x => x.slot === a.slot)?.reasons ?? [];
    const evidence = [...new Set(reasons.flatMap(r => r.evidence ?? []))].sort();
    if (at === null) { const ats = evidence.map(id => atOf.get(id) ?? atOf.get(id.replace(/\/\d+$/, ''))).filter(Number.isInteger); at = ats.length ? Math.max(...ats) : verdict.window.closeAt - 1; }
    // (an achievement belongs to the window that judged it: goods carried in from before it date the window's opening)
    at = Math.min(verdict.window.closeAt - 1, Math.max(verdict.window.opensAt, at));
    const subject = a.track === 'national' ? { kind: 'nation', id: a.beneficiary, nation: a.beneficiary } : { kind: 'actor', id: a.beneficiary, nation: nationOf.get(a.beneficiary) ?? null };
    entries.push({ id: a.slot, goal: a.goal, track: a.track, at, subject, audience: AUDIENCE[a.goal] ?? 'all', title: { ...t.title }, reason: { ...t.reason }, recordOnly: { ...RECORD_ONLY }, evidence: evidence.slice(0, 20) });
  }
  entries.sort((x, y) => y.at - x.at || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  const all = [...A.joint, ...A.national, ...A.personal];
  return {
    v: 1, kind: 'ws15-coop-outcomes',
    ruleset: { id: verdict.ruleset.id, variant: verdict.ruleset.variant, version: verdict.ruleset.version, hash: verdict.ruleset.hash, carryInputs: true },
    window: { id: verdict.window.id, opensAt: verdict.window.opensAt, closeAt: verdict.window.closeAt },
    inputHash: verdict.inputHash, verdictHash: verdict.verdictHash,
    effects: { ...NO_EFFECT },
    entries,
    undecided: all.filter(x => x.status === 'indeterminate').length,
    records: { gaps: verdict.records.gaps.length, refused: verdict.records.refused.length },
  };
}

/** The live records → titles and chronicle, with ruleset B. The single entry point production uses. */
export function evaluateLive(args) {
  const { input, notes } = liveInput(args);
  const verdict = evaluate(productionRuleset(), input);
  const out = outcomesOf(verdict, input);
  return { ...out, notes: { unresolved: notes.unresolved.length, skipped: notes.skipped, rejected: notes.rejected.length, bad: notes.bad.length, fulfilledHeld: notes.fulfilled.length }, outcomesHash: hashOf(out) };
}
