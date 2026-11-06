// ⑭ central tower: a toy model for comparing what the tower at the Concord
// could do. NOT the game's rules and not evidence of fun: a deterministic,
// seeded abstraction of villages, barter requests and caravans, so three
// cases can be run from the same initial state and their facts compared.
//
//   A  baseline   the tower does nothing (the state at 4cd901de: art only)
//   B  board      the tower is a public notice board: a request posted there
//                 is seen by every nation; goods still go village to village
//   C  relay      the tower hosts a vault built jointly (threshold, deadline,
//                 optional refund) that holds standing offers anyone may swap;
//                 goods travel to and from the centre
//
// One action list serves both the AI villages and the human in the clickable
// prototype (`optionsFor` → `apply`), so a human choice and an AI choice cost
// the same. Every number is a placeholder in `DEFAULTS` and can be switched.
// The model only records facts (`sim.facts`); it never decides who won.
//
// The world does not end. `days` is how long an observer watches, not a
// season: `extend` watches longer, and nothing is reset or closed when it
// stops. A period boundary (`periodHours`, ⑧/④ not received) is recorded as
// a fact only; villages, goods, caravans, offers, claims and the tower carry
// on across it. The whole state is plain data (`snapshot` / `restore`), so a
// run can be stopped and resumed (a restart) without acting twice.
import { ringProvinces, ringOf, trip, provinceSteps, RULES } from './geometry.mjs';
import { placeVillages } from './adapters.mjs';

export const RES = Object.freeze(['food', 'wood', 'stone', 'ore']);   // four of the rules' eight resources (holding.rs)
export const CASES = Object.freeze(['A', 'B', 'C']);
export const CASE_NAMES = Object.freeze({ A: '基準：目印のみ', B: '掲示の塔（情報だけ集まる）', C: '中継の倉（物が集まる）' });
export const ROLES = Object.freeze(['give', 'pledge', 'carry', 'escort', 'upkeep']);

/** Every number here is provisional [仮] and switchable. */
export const DEFAULTS = Object.freeze({
  seed: 1,
  case: 'A',
  days: 14,                       // how long to watch (an observation window, not a season or a period)
  periodHours: null,              // a period boundary every this many hours (undecided: ⑧/④ not received); recorded as a fact, nothing resets
  nations: [10, 10, 6, 6, 3, 3],  // villages per nation: two large, two middle, two small
  placement: 'compact',           // 'compact': rings 2..3 (S1_LOCAL_14D heartland); 'dispersed': ⑧ placeholder
  lateShare: 0.2, lateDay: 5,     // late joiners
  poorShare: 0.25, poorIncome: 0.4,
  sessionsPerDay: [2, 4, 6],      // how often a player looks in (one is drawn per village)
  actionsPerSession: 2,
  strongIncome: 3, weakIncome: 0.6,       // units per hour of a resource the nation's land is rich / poor in
  oreRichNations: 2,                      // ore comes from hills and mountains: only some nations are rich in it
  landMix: 0.3,                           // chance a village's land differs from its nation's typical land (resources are biased inside a nation too)
  growCost: { food: 20, wood: 20, stone: 20, ore: 10 },
  reserveFactor: 1.5,             // what a village keeps back before it calls something surplus
  tradeAmount: 15,
  requestVisibility: 'nation',    // ① not received: 'nation' assumes a request is seen in its own nation only; 'world' if ① already shows all
  lossPerProvince: 0.01,          // a caravan lost per province crossed (accidents, small raids)
  raidLoss: 0.35,                 // extra loss near the centre while a hostile raider is active there
  raidHours: 6,
  saboteurs: 2, sabotage: 'brink', sabotageAt: 0.8,   // 'brink': only near completion; 'always'
  selfishShare: 0.2,              // never joins the tower; uses what is open
  leavers: 3, leaveDay: 7,        // contributors who leave mid-way
  alliance: null,                 // e.g. [0, 1]: these nations deal only with each other
  monopolist: null,               // e.g. 0: this nation pours into the tower, escorts only its own, raids others at the centre
  // B
  boardWaitHours: 6,              // a request goes to the board after this long unanswered in its nation
  boardFee: { food: 2 },
  boardExposure: 0.03,            // extra loss for a publicly posted need (raiders read the board)
  // C
  stageNeed: [{ wood: 8, stone: 8, food: 4 }, { wood: 6, stone: 10, ore: 2, food: 4 }, { stone: 12, ore: 4, food: 6 }], // per village in the world
  stageDays: 4,
  refund: 'refund',               // 'refund': unmet by the deadline → contributions become claims, progress resets; 'keep': progress stays, no deadline
  access: 'open',                 // 'open': anyone may use the relay; 'contributors': only those who delivered something
  relayCap: [0, 8, 16, 28],       // swaps per day by completed stages
  upkeepFood: 12,                 // food per day; without it the relay goes dormant
  escortHours: 6, escortCut: 0.3, escortCap: 0.8,
  towerWill: 0.6,                 // share of cooperative villages willing to work on the tower at all
  pledgeAmount: 15, carryLoad: 15,
  rules: RULES,
});

/** mulberry32: a small seeded generator. */
export function rng(seed) { return rngFrom({ a: seed >>> 0 }); }
/** The same generator over a state object the snapshot carries (`{a}`). */
function rngFrom(st) {
  return () => { st.a = (st.a + 0x6d2b79f5) >>> 0; let t = st.a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const CONCORD = Object.freeze({ p: 0, q: 0 });
const zero = () => ({ food: 0, wood: 0, stone: 0, ore: 0 });
const sum = o => RES.reduce((s, r) => s + (o[r] ?? 0), 0);
const affords = (store, cost) => RES.every(r => store[r] >= (cost[r] ?? 0));
const spend = (store, cost) => RES.forEach(r => { store[r] -= cost[r] ?? 0; });
const add = (store, goods) => RES.forEach(r => { store[r] += goods[r] ?? 0; });
const round2 = x => Math.round(x * 100) / 100;

/** The provinces a straight line between two provinces crosses (cube lerp on the province grid). */
export function provinceLine(a, b) {
  const n = provinceSteps(a, b), out = [];
  const ax = a.p + 1e-6, az = a.q + 1e-6, bx = b.p + 1e-6, bz = b.q + 1e-6;
  for (let i = 0; i <= n; i++) {
    const t = n === 0 ? 0 : i / n;
    const x = ax + (bx - ax) * t, z = az + (bz - az) * t, y = -x - z;
    let rx = Math.round(x), ry = Math.round(y), rz = Math.round(z);
    const dx = Math.abs(rx - x), dy = Math.abs(ry - y), dz = Math.abs(rz - z);
    if (dx > dy && dx > dz) rx = -ry - rz; else if (dy <= dz) rz = -rx - ry;
    out.push({ p: rx, q: rz });
  }
  return out;
}

// ---------------------------------------------------------------- world

/** The initial state: identical for every case with the same seed and world parameters. */
export function createSim(input = {}) {
  const P = { ...DEFAULTS, ...input, growCost: { ...DEFAULTS.growCost, ...(input.growCost ?? {}) } };
  const R = rng(P.seed);
  const nationRes = nationLands(P, R);
  const villages = [];
  const placed = placeVillages(P, R);   // ⑧ adapter: [{nation, prov}]
  for (const at of placed) {
    const id = villages.length;
    const poor = R() < P.poorShare, late = R() < P.lateShare;
    const spd = P.sessionsPerDay[Math.floor(R() * P.sessionsPerDay.length)];
    const land = R() < P.landMix ? shuffle(RES.slice(), R).slice(0, 2) : nationRes[at.nation];
    const income = {};
    for (const r of RES) income[r] = (land.includes(r) ? P.strongIncome : P.weakIncome) * (poor ? P.poorIncome : 1) * (0.85 + 0.3 * R());
    villages.push({
      id, name: `${'甲乙丙丁戊己'[at.nation]}${id}`, nation: at.nation, prov: at.prov, ring: ringOf(at.prov.p, at.prov.q),
      land, poor, late, spd, phase: Math.floor(R() * 24), profile: 'coop', towerWill: R() < P.towerWill,
      joinTick: late ? P.lateDay * 24 : 0, leaveTick: null, present: !late, left: false,
      store: { food: 30, wood: 30, stone: 30, ore: 10 }, income, level: 0,
      slots: {}, roles: {}, trades: 0, crossTrades: 0, delivered: 0, lostGoods: 0, sends: 0, relayUses: 0, claims: zero(), contributed: zero(),
    });
  }
  // behaviour profiles: drawn after placement so the land and the people are the same in every case
  const shuffled = shuffle(villages.map(v => v.id), R);
  let k = 0;
  for (let i = 0; i < P.saboteurs && k < shuffled.length; i++) villages[shuffled[k++]].profile = 'saboteur';
  const nSelfish = Math.round(P.selfishShare * villages.length);
  for (let i = 0; i < nSelfish && k < shuffled.length; i++) villages[shuffled[k++]].profile = 'selfish';
  for (let i = 0; i < P.leavers && k < shuffled.length; i++) { const v = villages[shuffled[k++]]; v.leaveTick = P.leaveDay * 24; v.towerWill = true; v.leaver = true; }
  if (P.monopolist !== null && P.monopolist !== undefined) for (const v of villages) if (v.nation === P.monopolist && v.profile === 'coop') v.towerWill = true;
  const rngState = { a: ((P.seed * 2654435761) >>> 0) >>> 0 };
  const sim = {
    P, case: P.case, tick: 0, until: P.days * 24, villages, nationRes,
    // live objects: finished ones leave these lists (their history stays in `facts`)
    requests: [], caravans: [], facts: [], raids: [], escorts: [], pledges: [],
    nextId: { req: 0, offer: 0, pledge: 0, caravan: 0 },
    tower: { stage: 0, stageOpen: P.case === 'C' ? 0 : null, deadline: P.case === 'C' ? P.stageDays * 24 : null, progress: zero(), stock: zero(), ledger: [], offers: [], swapsToday: 0, dormant: false, completedAt: [], lapses: 0 },
    traffic: {}, rngState, rand: rngFrom(rngState),
    // goods ledger: what entered and left the world (checked by `ledgerGap`)
    flow: { initial: villages.reduce((s, v) => s + sum(v.store), 0), income: 0, grow: 0, build: 0, upkeep: 0, fee: 0, escort: 0, lost: 0, forfeited: 0, dispatched: 0, arrived: 0 },
    stats: { posted: 0, done: 0 },
    control: null, pending: null,
  };
  fact(sim, 'world.created', null, { case: P.case, villages: villages.length, placement: P.placement });
  return sim;
}

function shuffle(a, R) { const b = a.slice(); for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(R() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; }

/** Which resources each nation's land is rich in: ore in only `oreRichNations` of them; two rich resources each. */
function nationLands(P, R) {
  const n = P.nations.length, oreRich = new Set(shuffle([...Array(n).keys()], R).slice(0, P.oreRichNations));
  return [...Array(n).keys()].map(i => {
    const pool = ['food', 'wood', 'stone'];
    const first = pool[i % 3];
    return oreRich.has(i) ? [first, 'ore'] : [first, pool[(i + 1) % 3]];
  });
}

function fact(sim, kind, v, data = {}) {
  sim.facts.push({ t: sim.tick, kind, actor: v ? v.id : null, nation: v ? v.nation : null, ...data });
}

// ---------------------------------------------------------------- helpers

const isAlliance = (sim, a, b) => !sim.P.alliance || (sim.P.alliance.includes(a) === sim.P.alliance.includes(b));
const dealsWith = (sim, a, b) => a === b || isAlliance(sim, a, b);
export const surplus = (sim, v, r) => v.store[r] - (sim.P.growCost[r] ?? 0) * sim.P.reserveFactor;
export const shortfall = (sim, v, r) => Math.max(0, (sim.P.growCost[r] ?? 0) - v.store[r]);
const online = (sim, v) => v.present && !v.left && ((sim.tick + v.phase) % Math.round(24 / v.spd) === 0);

function hostileAt(sim, nation) {
  return sim.raids.some(r => r.until > sim.tick && (r.only === null || r.only !== nation));
}
function escortCut(sim, nation) {
  const n = sim.escorts.filter(e => e.until > sim.tick && (e.only === null || e.only === nation)).length;
  return Math.min(sim.P.escortCap, n * sim.P.escortCut);
}

/** The cost and risk of one caravan from `from` to `to` for village `v` (used by the AI, the UI and dispatch alike). */
export function route(sim, v, from, to, { publicNeed = false } = {}) {
  const tr = trip(from, to, { rules: sim.P.rules });
  const line = provinceLine(from, to);
  const nearCentre = line.some(x => ringOf(x.p, x.q) <= 1);
  let survive = Math.pow(1 - sim.P.lossPerProvince, tr.provinces);
  if (publicNeed) survive *= 1 - sim.P.boardExposure;
  if (nearCentre && hostileAt(sim, v.nation)) survive *= 1 - sim.P.raidLoss * (1 - escortCut(sim, v.nation));
  const waitH = (tr.sends - 1) * (24 / v.spd);
  return { ...tr, line, nearCentre, hours: Math.max(1, Math.ceil(tr.minutes / 60 + waitH)), risk: round2(1 - survive) };
}

/** Sends goods; `arrival` ({kind, ...}) says what happens when they come (see `arrive`): data, not a closure, so a caravan survives a snapshot. */
function dispatch(sim, v, from, to, goods, arrival, opts = {}) {
  const rt = route(sim, v, from, to, opts);
  v.sends += rt.sends;
  for (const x of rt.line) { const key = `${x.p},${x.q}`; sim.traffic[key] = (sim.traffic[key] ?? 0) + sum(goods); }
  const lost = sim.rand() < rt.risk;
  sim.flow.dispatched++;
  sim.caravans.push({ id: sim.nextId.caravan++, owner: v.id, at: sim.tick + rt.hours, goods, lost, arrival, toCentre: to.p === 0 && to.q === 0, fromCentre: from.p === 0 && from.q === 0, nearCentre: rt.nearCentre });
  return rt;
}
const reqOf = (sim, id) => sim.requests.find(q => q.id === id);
const offerOf = (sim, id) => sim.tower.offers.find(o => o.id === id);
const pledgeOf = (sim, id) => sim.pledges.find(p => p.id === id);
const ledgerOf = (t, id) => t.ledger.find(e => e[0] === id);

/** A caravan arrives (`ok`: it was not lost on the way). */
function arrive(sim, c) {
  const ok = !c.lost, a = c.arrival, P = sim.P, t = sim.tower;
  sim.flow.arrived++;
  if (!ok) sim.flow.lost += sum(c.goods);
  switch (a.kind) {
    case 'help': {
      const q = reqOf(sim, a.req), v = sim.villages[a.helper], poster = sim.villages[q.poster];
      if (!ok) { q.state = 'failed'; v.lostGoods += q.amount; fact(sim, 'caravan.lost', v, { req: q.id }); return; }
      add(poster.store, c.goods);
      if (q.fake || poster.left) { q.state = 'defaulted'; fact(sim, 'request.defaulted', poster, { req: q.id, helper: v.id }); return; }
      q.state = 'delivered'; q.payDue = true; return;
    }
    case 'pay': {
      const q = reqOf(sim, a.req), poster = sim.villages[q.poster], helper = sim.villages[q.helper];
      if (ok && !helper.left) { add(helper.store, c.goods); q.state = 'done'; sim.stats.done++; poster.trades++; helper.trades++; if (poster.nation !== helper.nation) { poster.crossTrades++; helper.crossTrades++; } fact(sim, q.boardedAt !== undefined ? 'tower.board_fulfilled' : 'request.fulfilled', poster, { req: q.id, cross: poster.nation !== helper.nation }); }
      else { if (ok) sim.flow.lost += sum(c.goods); q.state = 'failed'; poster.lostGoods += sum(c.goods); fact(sim, 'caravan.lost', poster, { req: q.id }); }
      return;
    }
    case 'claim': {
      const v = sim.villages[c.owner];
      if (ok) add(v.store, c.goods); else { v.lostGoods += sum(c.goods); fact(sim, 'caravan.lost', v, { claim: true }); }
      return;
    }
    case 'tower': deliverToTower(sim, sim.villages[a.owner], c.goods, ok, a.stageAt, a.carrier === null ? null : sim.villages[a.carrier]); return;
    case 'offer': {
      const o = offerOf(sim, a.offer), v = sim.villages[c.owner];
      if (ok) { o.state = 'open'; fact(sim, 'tower.relay_offer', v, { offer: o.id }); } else { o.state = 'lost'; v.lostGoods += P.tradeAmount; fact(sim, 'caravan.lost', v, { relay: true }); }
      return;
    }
    case 'swapPay': {
      const o = offerOf(sim, a.offer), v = sim.villages[c.owner], owner = sim.villages[o.owner];
      if (!ok) { o.state = 'open'; v.lostGoods += o.amount; fact(sim, 'caravan.lost', v, { relay: true }); return; }
      o.state = 'filled'; o.paid = c.goods; o.taker = v.id;
      fact(sim, 'tower.relay_swap', v, { offer: o.id, cross: owner.nation !== v.nation, contributor: sum(v.contributed) > 0 });
      dispatch(sim, v, CONCORD, v.prov, { [o.has]: o.amount }, { kind: 'swapGet', cross: owner.nation !== v.nation, amount: o.amount });
      return;
    }
    case 'swapGet': {
      const v = sim.villages[c.owner];
      if (ok) { add(v.store, c.goods); v.trades++; if (a.cross) v.crossTrades++; } else { v.lostGoods += a.amount; fact(sim, 'caravan.lost', v, { relay: true }); }
      return;
    }
    case 'collect': {
      const v = sim.villages[c.owner];
      if (ok) { add(v.store, c.goods); v.trades++; if (a.cross) v.crossTrades++; } else { v.lostGoods += a.amount; fact(sim, 'caravan.lost', v, { relay: true }); }
      return;
    }
  }
  throw new Error(`unknown arrival ${a.kind}`);
}

// ---------------------------------------------------------------- options (shared by the AI and the human)

/**
 * What village `v` may do in one action slot now: [{id, kind, label, detail, ...}].
 * The AI's policy and the clickable prototype both pick from this list.
 */
export function optionsFor(sim, v) {
  const P = sim.P, out = [];
  if (!v.present || v.left) return out;
  if (affords(v.store, P.growCost)) out.push({ id: 'grow', kind: 'grow', label: '自分の村を育てる', detail: `費用 ${costText(P.growCost)}` });
  // answer a visible request (barter)
  for (const q of sim.requests) {
    if (q.state !== 'open' || q.poster === v.id) continue;
    const poster = sim.villages[q.poster];
    if (!visibleTo(sim, q, v)) continue;
    if (surplus(sim, v, q.want) < q.amount) continue;
    const rt = route(sim, v, v.prov, poster.prov, { publicNeed: q.scope === 'world' });
    out.push({ id: `help:${q.id}`, kind: 'help', req: q.id, label: `${poster.name} の依頼に応える（${q.want}→${q.give} ${q.amount}）`, detail: tripText(rt) + (poster.nation !== v.nation ? '・他国' : ''), cross: poster.nation !== v.nation, rt });
  }
  // post a request for what keeps the village from growing
  const mine = sim.requests.filter(q => q.poster === v.id && q.state === 'open');
  const need = RES.filter(r => shortfall(sim, v, r) > 0).sort((a, b) => shortfall(sim, v, b) - shortfall(sim, v, a))[0];
  const give = RES.filter(r => r !== need).sort((a, b) => surplus(sim, v, b) - surplus(sim, v, a))[0];
  if (need && give && surplus(sim, v, give) >= P.tradeAmount && !mine.some(q => q.want === need)) {
    out.push({ id: `post:${need}:${give}`, kind: 'post', want: need, give, label: `依頼を出す（${need} を求め ${give} を渡す）`, detail: P.requestVisibility === 'world' ? '全員に見える' : '自国に見える' });
  }
  if (sim.case === 'B') for (const q of mine) if (q.scope !== 'world' && affords(v.store, P.boardFee)) {
    out.push({ id: `board:${q.id}`, kind: 'board', req: q.id, label: `依頼を塔に掲げる（${q.want}）`, detail: `手数料 ${costText(P.boardFee)}・全国に見える・需要が公開される` });
  }
  if (sim.case === 'C') towerOptions(sim, v, out, need, give);
  if (v.profile === 'saboteur' || isMonopolist(sim, v)) {
    out.push({ id: 'raid', kind: 'raid', label: '中央付近で荷を襲う', detail: `${P.raidHours}時間・中央を通る荷の損失 +${Math.round(P.raidLoss * 100)}%` });
    out.push({ id: 'fake', kind: 'fake', label: '払う気のない依頼を出す', detail: '応えた相手が荷を失う' });
  }
  out.push({ id: 'idle', kind: 'idle', label: '何もしない', detail: '' });
  return out;
}

const isMonopolist = (sim, v) => sim.P.monopolist !== null && sim.P.monopolist !== undefined && v.nation === sim.P.monopolist;
function costText(c) { return RES.filter(r => c[r]).map(r => `${r}${c[r]}`).join(' '); }
function tripText(rt) { return `${rt.hexes}マス・${rt.sends}回の発送・約${rt.hours}時間・損失見込み${Math.round(rt.risk * 100)}%`; }
function visibleTo(sim, q, v) {
  const poster = sim.villages[q.poster];
  if (!dealsWith(sim, poster.nation, v.nation)) return false;
  if (q.scope === 'world' || sim.P.requestVisibility === 'world') return true;
  return poster.nation === v.nation;
}
const needOf = (sim, stageIdx) => {
  const per = sim.P.stageNeed[stageIdx]; const n = sim.villages.length, o = zero();
  for (const r of RES) o[r] = Math.round((per?.[r] ?? 0) * n);
  return o;
};
export function stageFraction(sim) {
  const t = sim.tower; if (t.stageOpen === null || t.stage >= sim.P.stageNeed.length) return 1;
  const need = needOf(sim, t.stage), tot = sum(need);
  return tot ? RES.reduce((s, r) => s + Math.min(t.progress[r], need[r]), 0) / tot : 1;
}
export const relayActive = sim => sim.case === 'C' && sim.tower.stage > 0 && !sim.tower.dormant;

function towerOptions(sim, v, out, need, give) {
  const P = sim.P, t = sim.tower;
  const building = t.stageOpen !== null && t.stage < P.stageNeed.length;
  if (building && v.profile !== 'selfish' && v.profile !== 'saboteur') {
    const nd = needOf(sim, t.stage);
    const wanted = RES.filter(r => t.progress[r] < nd[r]);
    const rt = route(sim, v, v.prov, CONCORD);
    for (const r of wanted) if (surplus(sim, v, r) >= P.pledgeAmount) {
      out.push({ id: `give:${r}`, kind: 'tower', role: 'give', res: r, label: `塔の建設に ${r} を自分で運ぶ`, detail: tripText(rt), rt });
      out.push({ id: `pledge:${r}`, kind: 'tower', role: 'pledge', res: r, label: `塔の建設に ${r} を差し出す（運ぶのは他の人）`, detail: '村に置いて運び手を待つ' });
    }
    const pl = sim.pledges.filter(x => x.state === 'open' && !sim.villages[x.from].left).sort((a, b) => provinceSteps(sim.villages[a.from].prov, v.prov) - provinceSteps(sim.villages[b.from].prov, v.prov))[0];
    if (pl) { const rt2 = route(sim, v, sim.villages[pl.from].prov, CONCORD); out.push({ id: `carry:${pl.id}`, kind: 'tower', role: 'carry', pledge: pl.id, label: `${sim.villages[pl.from].name} の差し出した荷を塔へ運ぶ`, detail: tripText(rt2), rt: rt2 }); }
  }
  if ((building || relayActive(sim)) && v.profile !== 'saboteur' && v.store.food >= 4) {
    out.push({ id: 'escort', kind: 'tower', role: 'escort', label: '中央への道を護衛する', detail: `${P.escortHours}時間・food 4・${isMonopolist(sim, v) ? '自国の荷だけ' : '誰の荷でも'}` });
  }
  if (t.stage > 0 && v.profile !== 'saboteur' && v.store.food >= P.upkeepFood && t.stock.food < P.upkeepFood * 2) {
    out.push({ id: 'upkeep', kind: 'tower', role: 'upkeep', label: '中継の倉の維持費（food）を運ぶ', detail: tripText(route(sim, v, v.prov, CONCORD)) });
  }
  if (sum(v.claims) > 0) out.push({ id: 'claim', kind: 'claim', label: '返金分を中央から引き取る', detail: tripText(route(sim, v, CONCORD, v.prov)) });
  if (relayActive(sim) && mayUseRelay(sim, v) && t.swapsToday < P.relayCap[Math.min(t.stage, P.relayCap.length - 1)]) {
    if (need) {
      const offer = t.offers.find(o => o.state === 'open' && o.has === need && o.owner !== v.id && surplus(sim, v, o.wants) >= o.amount && dealsWith(sim, sim.villages[o.owner].nation, v.nation));
      if (offer) out.push({ id: `swap:${offer.id}`, kind: 'relay', offer: offer.id, label: `中継の倉で交換（${offer.wants}→${need} ${offer.amount}）`, detail: tripText(route(sim, v, v.prov, CONCORD)) + '・往復' });
    }
    if (need && give && surplus(sim, v, give) >= P.tradeAmount && !t.offers.some(o => o.owner === v.id && o.state === 'open')) {
      out.push({ id: `offer:${give}:${need}`, kind: 'relay', label: `中継の倉に置いて待つ（${give} を置き ${need} を求める）`, detail: tripText(route(sim, v, v.prov, CONCORD)) });
    }
  }
  const ready = t.offers.find(o => o.owner === v.id && o.state === 'filled');
  if (ready) out.push({ id: `collect:${ready.id}`, kind: 'relay', offer: ready.id, label: '中継の倉から交換済みの荷を引き取る', detail: tripText(route(sim, v, CONCORD, v.prov)) });
}
const mayUseRelay = (sim, v) => sim.P.access === 'open' || sum(v.contributed) > 0;

// ---------------------------------------------------------------- applying a choice

export function apply(sim, v, opt) {
  const P = sim.P, t = sim.tower;
  v.slots[opt.kind] = (v.slots[opt.kind] ?? 0) + 1;
  switch (opt.kind) {
    case 'grow': spend(v.store, P.growCost); sim.flow.grow += sum(P.growCost); v.level++; fact(sim, 'village.grew', v, { level: v.level }); break;
    case 'post': {
      const q = { id: sim.nextId.req++, poster: v.id, want: opt.want, give: opt.give, amount: P.tradeAmount, tick: sim.tick, scope: P.requestVisibility === 'world' ? 'world' : 'nation', state: 'open', fake: false };
      sim.requests.push(q); sim.stats.posted++; fact(sim, 'request.posted', v, { req: q.id, scope: q.scope }); break;
    }
    case 'fake': {
      const q = { id: sim.nextId.req++, poster: v.id, want: 'ore', give: 'food', amount: P.tradeAmount, tick: sim.tick, scope: sim.case === 'B' ? 'world' : (P.requestVisibility === 'world' ? 'world' : 'nation'), state: 'open', fake: true };
      sim.requests.push(q); fact(sim, 'request.posted', v, { req: q.id, scope: q.scope }); break;
    }
    case 'board': {
      const q = reqOf(sim, opt.req); spend(v.store, P.boardFee); sim.flow.fee += sum(P.boardFee); q.scope = 'world'; q.boardedAt = sim.tick;
      fact(sim, 'tower.board_post', v, { req: q.id }); break;
    }
    case 'help': {
      const q = reqOf(sim, opt.req), poster = sim.villages[q.poster];
      q.state = 'taken'; q.helper = v.id;
      const goods = { [q.want]: q.amount }; spend(v.store, goods);
      fact(sim, q.boardedAt !== undefined ? 'tower.board_taken' : 'request.taken', v, { req: q.id, cross: poster.nation !== v.nation });
      dispatch(sim, v, v.prov, poster.prov, goods, { kind: 'help', req: q.id, helper: v.id }, { publicNeed: q.scope === 'world' });
      break;
    }
    case 'tower': towerApply(sim, v, opt); break;
    case 'claim': {
      const goods = { ...v.claims }; v.claims = zero();
      fact(sim, 'tower.claim_withdrawn', v, { amount: sum(goods) });
      dispatch(sim, v, CONCORD, v.prov, goods, { kind: 'claim' });
      break;
    }
    case 'relay': relayApply(sim, v, opt); break;
    case 'raid': {
      sim.raids.push({ by: v.id, until: sim.tick + P.raidHours, only: isMonopolist(sim, v) ? v.nation : null });
      fact(sim, 'centre.raid', v, { stage: t.stage, fraction: round2(stageFraction(sim)) }); break;
    }
    case 'idle': break;
  }
}

function towerApply(sim, v, opt) {
  const P = sim.P, t = sim.tower;
  v.roles[opt.role] = (v.roles[opt.role] ?? 0) + 1;
  if (opt.role === 'give' || opt.role === 'upkeep') {
    const r = opt.role === 'upkeep' ? 'food' : opt.res, n = opt.role === 'upkeep' ? P.upkeepFood : P.pledgeAmount;
    const goods = { [r]: n }; spend(v.store, goods);
    const stageAt = t.stage;
    dispatch(sim, v, v.prov, CONCORD, goods, { kind: 'tower', owner: v.id, stageAt: opt.role === 'upkeep' ? 'upkeep' : stageAt, carrier: null });
    fact(sim, 'tower.sent', v, { role: opt.role, res: r, amount: n });
  } else if (opt.role === 'pledge') {
    const goods = { [opt.res]: P.pledgeAmount }; spend(v.store, goods);
    sim.pledges.push({ id: sim.nextId.pledge++, from: v.id, goods, state: 'open', tick: sim.tick });
    fact(sim, 'tower.pledged', v, { res: opt.res, amount: P.pledgeAmount });
  } else if (opt.role === 'carry') {
    const pl = pledgeOf(sim, opt.pledge), from = sim.villages[pl.from];
    pl.state = 'carried';
    const stageAt = t.stage;
    dispatch(sim, v, from.prov, CONCORD, pl.goods, { kind: 'tower', owner: from.id, stageAt, carrier: v.id });
    fact(sim, 'tower.carried', v, { for: from.id, amount: sum(pl.goods) });
  } else if (opt.role === 'escort') {
    v.store.food -= 4; sim.flow.escort += 4;
    sim.escorts.push({ by: v.id, until: sim.tick + P.escortHours, only: isMonopolist(sim, v) ? v.nation : null });
    fact(sim, 'tower.escort', v, {});
  }
}

function deliverToTower(sim, owner, goods, ok, stageAt, carrier = null) {
  const t = sim.tower;
  if (!ok) { owner.lostGoods += sum(goods); fact(sim, 'caravan.lost', carrier ?? owner, { tower: true, for: owner.id }); return; }
  if (stageAt === 'upkeep') { add(t.stock, goods); fact(sim, 'tower.upkeep_delivered', carrier ?? owner, { amount: sum(goods) }); return; }
  add(owner.contributed, goods);
  // goods for the open stage are held in `progress`, apart from the stock that pays upkeep (they must not be used twice);
  // goods for a stage that closed while they travelled go to the stock
  if (stageAt === t.stage && t.stageOpen !== null && t.stage < sim.P.stageNeed.length) {
    add(t.progress, goods);
    let led = ledgerOf(t, owner.id); if (!led) { led = [owner.id, zero()]; t.ledger.push(led); } add(led[1], goods);
  } else add(t.stock, goods);
  fact(sim, 'tower.contribution', owner, { amount: sum(goods), carrier: carrier ? carrier.id : null, stage: t.stage });
  checkStage(sim);
}

function checkStage(sim) {
  const t = sim.tower, P = sim.P;
  if (t.stageOpen === null || t.stage >= P.stageNeed.length) return;
  const need = needOf(sim, t.stage);
  if (RES.every(r => t.progress[r] >= need[r])) {
    // the stage uses what it needs; what was brought beyond that joins the stock
    for (const r of RES) t.stock[r] += t.progress[r] - need[r];
    sim.flow.build += sum(need); t.stage++; t.completedAt.push(sim.tick);
    fact(sim, 'tower.stage_completed', null, { stage: t.stage, contributors: t.ledger.length, nations: new Set(t.ledger.map(e => sim.villages[e[0]].nation)).size });
    t.progress = zero(); t.ledger = [];
    if (t.stage < P.stageNeed.length) { t.stageOpen = sim.tick; t.deadline = sim.tick + P.stageDays * 24; fact(sim, 'tower.stage_opened', null, { stage: t.stage + 1 }); }
    if (t.dormant) { t.dormant = false; }
  }
}

function relayApply(sim, v, opt) {
  const P = sim.P, t = sim.tower;
  if (opt.id.startsWith('offer:')) {
    const [, give, need] = opt.id.split(':');
    const goods = { [give]: P.tradeAmount }; spend(v.store, goods);
    const o = { id: sim.nextId.offer++, owner: v.id, has: give, wants: need, amount: P.tradeAmount, state: 'travelling' };
    t.offers.push(o);
    dispatch(sim, v, v.prov, CONCORD, goods, { kind: 'offer', offer: o.id });
  } else if (opt.id.startsWith('swap:')) {
    const o = offerOf(sim, opt.offer);
    o.state = 'swapping'; t.swapsToday++;
    const pay = { [o.wants]: o.amount }; spend(v.store, pay);
    v.relayUses++;
    dispatch(sim, v, v.prov, CONCORD, pay, { kind: 'swapPay', offer: o.id });
  } else if (opt.id.startsWith('collect:')) {
    const o = offerOf(sim, opt.offer); o.state = 'collected'; v.relayUses++;
    const taker = sim.villages[o.taker];
    dispatch(sim, v, CONCORD, v.prov, o.paid, { kind: 'collect', cross: taker.nation !== v.nation, amount: o.amount });
  }
}

// ---------------------------------------------------------------- the AI's choice

/** The AI picks from the same options a human would see, by profile and situation. */
export function choose(sim, v, opts) {
  const by = k => opts.filter(o => o.kind === k);
  const R = sim.rand;
  if (v.profile === 'saboteur') {
    const raid = opts.find(o => o.id === 'raid');
    if (raid && sim.case === 'C' && (sim.P.sabotage === 'always' || stageFraction(sim) >= sim.P.sabotageAt || relayActive(sim))) return raid;
    if (raid && sim.case !== 'C' && R() < 0.3) return raid;
    const fake = opts.find(o => o.id === 'fake');
    if (fake && R() < 0.5) return fake;
  }
  if (isMonopolist(sim, v) && sim.case === 'C' && R() < 0.25) { const raid = opts.find(o => o.id === 'raid'); if (raid) return raid; }
  const grow = opts.find(o => o.id === 'grow');
  if (grow) return grow;
  const claim = opts.find(o => o.kind === 'claim'); if (claim) return claim;
  const collect = opts.find(o => o.id.startsWith('collect:')); if (collect) return collect;
  // answer a request: the nearest, low risk first
  const helps = by('help').filter(o => o.rt.risk < 0.3).sort((a, b) => a.rt.hours - b.rt.hours);
  if (helps.length && (v.profile !== 'selfish' || helps[0].rt.sends === 1)) return helps[0];
  const swap = opts.find(o => o.id.startsWith('swap:')); if (swap) return swap;
  const post = by('post')[0]; if (post) return post;
  const board = by('board').find(o => sim.tick - reqOf(sim, o.req).tick >= sim.P.boardWaitHours); if (board) return board;
  const offer = opts.find(o => o.id.startsWith('offer:'));
  if (offer && sim.requests.some(q => q.poster === v.id && q.state === 'open' && sim.tick - q.tick >= sim.P.boardWaitHours)) return offer;
  if (sim.case === 'C' && v.towerWill && v.profile === 'coop') {
    const tw = by('tower');
    const upkeep = tw.find(o => o.role === 'upkeep'); if (upkeep && R() < 0.5) return upkeep;
    // the role follows the situation: goods and few sessions → pledge; goods and time → give; no goods → carry or escort
    const gives = tw.filter(o => o.role === 'give'), pledges = tw.filter(o => o.role === 'pledge'), carry = tw.find(o => o.role === 'carry'), escort = tw.find(o => o.role === 'escort');
    if (gives.length && (v.spd <= 2 || gives[0].rt.sends > 1) && pledges.length) return pledges[0];
    if (gives.length && R() < 0.8) return gives[Math.floor(R() * gives.length)];
    if (carry && (v.poor || !gives.length) && carry.rt.risk < 0.4) return carry;
    if (escort && (sim.raids.some(r => r.until > sim.tick) || R() < 0.15)) return escort;
  }
  return opts.find(o => o.id === 'idle');
}

// ---------------------------------------------------------------- the clock

/**
 * One hour: income, arrivals, the tower's day, then each online village's
 * actions. If the human-controlled village is online, the hour stops there
 * (`sim.pending`) and its options are returned; `applyControlled` finishes it.
 */
export function step(sim) {
  const P = sim.P, t = sim.tower;
  if (sim.pending) return optionsFor(sim, sim.villages[sim.pending.v]);
  if (sim.tick >= sim.until) return null;
  // a period boundary is a fact; nothing is reset, closed or settled here
  if (P.periodHours && sim.tick > 0 && sim.tick % P.periodHours === 0) fact(sim, 'period.boundary', null, { index: sim.tick / P.periodHours });
  for (const v of sim.villages) {
    if (!v.present && !v.left && sim.tick >= v.joinTick) { v.present = true; fact(sim, 'village.joined', v, { late: v.late }); }
    if (v.present && !v.left && v.leaveTick !== null && sim.tick >= v.leaveTick) leave(sim, v);
    if (v.present && !v.left) for (const r of RES) { v.store[r] += v.income[r]; sim.flow.income += v.income[r]; }
  }
  // arrivals
  const due = sim.caravans.filter(c => c.at <= sim.tick);
  sim.caravans = sim.caravans.filter(c => c.at > sim.tick);
  for (const c of due) arrive(sim, c);
  // barter: the poster pays on arrival (automatic: it was promised)
  for (const q of sim.requests) if (q.payDue) {
    q.payDue = false; const poster = sim.villages[q.poster], helper = sim.villages[q.helper];
    const pay = { [q.give]: Math.min(q.amount, Math.max(0, poster.store[q.give])) }; spend(poster.store, pay);
    dispatch(sim, poster, poster.prov, helper.prov, pay, { kind: 'pay', req: q.id });
  }
  // the tower's day
  if (sim.case === 'C') {
    if (sim.tick % 24 === 0) {
      t.swapsToday = 0;
      if (t.stage > 0) {
        if (t.stock.food >= P.upkeepFood) { t.stock.food -= P.upkeepFood; sim.flow.upkeep += P.upkeepFood; if (t.dormant) { t.dormant = false; fact(sim, 'tower.awake', null, {}); } }
        else if (!t.dormant) { t.dormant = true; fact(sim, 'tower.dormant', null, { stage: t.stage }); }
      }
    }
    if (t.stageOpen !== null && t.stage < P.stageNeed.length && sim.tick >= t.deadline && P.refund === 'refund') lapse(sim);
  }
  // requests expire after a day unanswered
  for (const q of sim.requests) if (q.state === 'open' && sim.tick - q.tick > 24) q.state = 'expired';
  prune(sim);
  // actions
  let mine = null;
  for (const v of sim.villages) {
    if (!online(sim, v)) continue;
    if (sim.control === v.id) { mine = v; continue; }
    for (let i = 0; i < P.actionsPerSession; i++) apply(sim, v, choose(sim, v, optionsFor(sim, v)));
  }
  if (mine) { sim.pending = { v: mine.id, left: P.actionsPerSession }; return optionsFor(sim, mine); }
  sim.tick++;
  return null;
}

/** The controlled village's choice; returns its next options, or null when its session (and the hour) is over. */
export function applyControlled(sim, optId) {
  if (!sim.pending) return null;
  const v = sim.villages[sim.pending.v];
  const opt = optionsFor(sim, v).find(o => o.id === optId) ?? { id: 'idle', kind: 'idle' };
  apply(sim, v, opt);
  if (--sim.pending.left > 0) return optionsFor(sim, v);
  sim.pending = null; sim.tick++;
  return null;
}

/** Run to `sim.until` (the observer stops; the world does not end); with `untilControl`, stop at the controlled village's next turn and return its options. */
export function run(sim, { untilControl = false } = {}) {
  while (sim.tick < sim.until || sim.pending) {
    const o = step(sim);
    if (!o) continue;
    if (untilControl) return o;
    const v = sim.villages[sim.pending.v];
    applyControlled(sim, choose(sim, v, o).id);
  }
  return null;
}

// ---------------------------------------------------------------- the tower's deadline, leaving

function lapse(sim) {
  const t = sim.tower, P = sim.P;
  t.lapses++;
  fact(sim, 'tower.stage_lapsed', null, { stage: t.stage + 1, fraction: round2(stageFraction(sim)), contributors: t.ledger.length });
  for (const [id, goods] of t.ledger) {
    const v = sim.villages[id];
    if (v.left) { add(t.stock, goods); continue; }  // a claim of someone who left stays in the tower, as stock
    add(v.claims, goods);
    fact(sim, 'tower.refund_claim', v, { amount: sum(goods) });
  }
  t.progress = zero(); t.ledger = []; t.stageOpen = sim.tick; t.deadline = sim.tick + P.stageDays * 24;
  fact(sim, 'tower.stage_opened', null, { stage: t.stage + 1, retry: true });
}

function leave(sim, v) {
  v.left = true;
  for (const q of sim.requests) if (q.poster === v.id && q.state === 'open') q.state = 'cancelled';
  for (const p of sim.pledges) if (p.from === v.id && p.state === 'open') { p.state = 'void'; sim.flow.forfeited += sum(p.goods); }
  for (const o of sim.tower.offers) if (o.owner === v.id && o.state === 'open') o.state = 'abandoned';
  fact(sim, 'village.left', v, { contributed: sum(v.contributed) });
}

// ---------------------------------------------------------------- continuity: live state, snapshot, the goods ledger

const DONE_REQ = new Set(['done', 'failed', 'defaulted', 'expired', 'cancelled']);
const DONE_OFFER = new Set(['lost', 'collected']);
const DONE_PLEDGE = new Set(['carried', 'void']);
/** Finished objects leave the live lists, so live state stays bounded however long the world runs. Their history is in `facts`. */
function prune(sim) {
  sim.requests = sim.requests.filter(q => !DONE_REQ.has(q.state));
  sim.tower.offers = sim.tower.offers.filter(o => !DONE_OFFER.has(o.state));
  sim.pledges = sim.pledges.filter(p => !DONE_PLEDGE.has(p.state));
  sim.raids = sim.raids.filter(r => r.until > sim.tick);
  sim.escorts = sim.escorts.filter(e => e.until > sim.tick);
}

/** Watch `hours` more. The world was never ended, so nothing has to be reopened. */
export function extend(sim, hours) { sim.until += hours; return sim; }

/** The whole state as text (a restart point). */
export function snapshot(sim) {
  const { rand, ...rest } = sim;
  return JSON.stringify(rest);
}
/** A sim from a snapshot: it continues exactly where the snapshot was taken. */
export function restore(text) {
  const sim = JSON.parse(text);
  sim.rand = rngFrom(sim.rngState);
  return sim;
}

/** Live object counts (to check that a long-running world does not pile them up). */
export const liveSizes = sim => ({ requests: sim.requests.length, caravans: sim.caravans.length, offers: sim.tower.offers.length, pledges: sim.pledges.length, raids: sim.raids.length, escorts: sim.escorts.length, ledger: sim.tower.ledger.length });

/** Goods held anywhere now: village stores, the tower's stock and stage progress… */
export function holdings(sim) {
  let h = 0;
  for (const v of sim.villages) h += sum(v.store) + sum(v.claims);
  h += sum(sim.tower.stock) + sum(sim.tower.progress);
  for (const c of sim.caravans) h += sum(c.goods);
  for (const p of sim.pledges) if (p.state === 'open') h += sum(p.goods);
  for (const o of sim.tower.offers) {
    if (o.state === 'open' || o.state === 'swapping' || o.state === 'abandoned') h += o.amount;
    else if (o.state === 'filled') h += sum(o.paid);
  }
  return h;
}
/** initial + income − (everything spent, lost or forfeited) − holdings: 0 when no good was made or lost unseen. */
export function ledgerGap(sim) {
  const f = sim.flow;
  return f.initial + f.income - f.grow - f.build - f.upkeep - f.fee - f.escort - f.lost - f.forfeited - holdings(sim);
}

// ---------------------------------------------------------------- facts out

/** Read-only summary of what happened: facts and measurements, no verdict. */
export function summarize(sim) {
  const V = sim.villages, P = sim.P;
  const mean = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
  const group = f => V.filter(f);
  const lv = a => round2(mean(a.map(v => v.level)));
  const towerActs = v => ROLES.reduce((s, r) => s + (v.roles[r] ?? 0), 0);
  const participants = V.filter(v => towerActs(v) > 0 || v.relayUses > 0 || (v.slots.board ?? 0) > 0);
  const contributors = V.filter(v => sum(v.contributed) > 0 || towerActs(v) > 0);
  // logistics: share of goods-province traffic in rings 0..1 against their share of the land villages live in
  let all = 0, inner = 0, centre = 0;
  for (const [k, n] of Object.entries(sim.traffic)) { const [p, q] = k.split(',').map(Number); all += n; if (ringOf(p, q) <= 1) inner += n; if (p === 0 && q === 0) centre += n; }
  const maxRing = Math.max(...V.map(v => v.ring));
  const innerArea = 7 / (1 + 3 * maxRing * (maxRing + 1));
  // role diversity among tower workers
  const roleTotals = {}; for (const v of V) for (const r of ROLES) roleTotals[r] = (roleTotals[r] ?? 0) + (v.roles[r] ?? 0);
  const rt = Object.values(roleTotals).reduce((s, x) => s + x, 0);
  const entropy = rt ? -Object.values(roleTotals).filter(x => x > 0).reduce((s, x) => s + (x / rt) * Math.log2(x / rt), 0) : 0;
  const workers = V.filter(v => towerActs(v) > 0);
  const monotony = mean(workers.map(v => Math.max(...ROLES.map(r => v.roles[r] ?? 0)) / towerActs(v)));
  // concentration by nation of what went into the tower (HHI) and of who used it
  const byNation = (f) => { const s = P.nations.map(() => 0); for (const v of V) s[v.nation] += f(v); const tot = s.reduce((a, b) => a + b, 0); return { shares: s.map(x => round2(tot ? x / tot : 0)), hhi: round2(tot ? s.reduce((a, x) => a + (x / tot) ** 2, 0) : 0) }; };
  const swaps = sim.facts.filter(f => f.kind === 'tower.relay_swap');
  const ringBand = r => (r <= 2 ? 'near' : r <= 4 ? 'mid' : 'far');
  const bands = {}; for (const b of ['near', 'mid', 'far']) { const g = group(v => ringBand(v.ring) === b); if (g.length) bands[b] = { villages: g.length, level: lv(g), trades: round2(mean(g.map(v => v.trades))), cross: round2(mean(g.map(v => v.crossTrades))), sendsPerTrade: round2(mean(g.filter(v => v.trades).map(v => v.sends / v.trades))), towerShare: 0 }; }
  const towerTot = sum(V.reduce((a, v) => { add(a, v.contributed); return a; }, zero()));
  for (const b of Object.keys(bands)) bands[b].towerShare = round2(towerTot ? group(v => ringBand(v.ring) === b).reduce((s, v) => s + sum(v.contributed), 0) / towerTot : 0);
  const big = Math.max(...P.nations), small = Math.min(...P.nations);
  return {
    case: sim.case, seed: P.seed, villages: V.length,
    level: { all: lv(V), near: bands.near?.level ?? null, far: bands.far?.level ?? null, bigNation: lv(group(v => P.nations[v.nation] === big)), smallNation: lv(group(v => P.nations[v.nation] === small)), late: lv(group(v => v.late)), poor: lv(group(v => v.poor)), selfish: lv(group(v => v.profile === 'selfish')), nonParticipants: lv(V.filter(v => !participants.includes(v) && v.profile !== 'saboteur')), participants: lv(participants) },
    bands,
    trades: { done: sim.stats.done + swaps.length, cross: V.reduce((s, v) => s + v.crossTrades, 0) / 2, requestsPosted: sim.stats.posted, requestsDone: sim.stats.done, boardPosts: sim.facts.filter(f => f.kind === 'tower.board_post').length, boardDone: sim.facts.filter(f => f.kind === 'tower.board_fulfilled').length, defaulted: sim.facts.filter(f => f.kind === 'request.defaulted').length, relaySwaps: swaps.length, relaySwapsCross: swaps.filter(s => s.cross).length, relaySwapsByNonContributors: swaps.filter(s => !s.contributor).length },
    logistics: { innerShare: round2(all ? inner / all : 0), innerAreaShare: round2(innerArea), centreShare: round2(all ? centre / all : 0), lostCaravans: sim.facts.filter(f => f.kind === 'caravan.lost').length, lostNearCentre: sim.facts.filter(f => f.kind === 'caravan.lost' && (f.tower || f.relay || f.claim)).length },
    tower: sim.case !== 'C' ? null : { stages: sim.tower.stage, completedDay: sim.tower.completedAt.map(t => round2(t / 24)), lapses: sim.tower.lapses, dormantEvents: sim.facts.filter(f => f.kind === 'tower.dormant').length, contributors: contributors.length, contributorNations: new Set(contributors.map(v => v.nation)).size, contributionByNation: byNation(v => sum(v.contributed)), useByNation: byNation(v => v.relayUses), roles: roleTotals, roleEntropyBits: round2(entropy), roleEntropyMaxBits: round2(Math.log2(ROLES.length)), meanMonotony: round2(monotony), freeRideShare: round2(swaps.length ? swaps.filter(s => !s.contributor).length / swaps.length : 0), raids: sim.facts.filter(f => f.kind === 'centre.raid').length, raidsAtBrink: sim.facts.filter(f => f.kind === 'centre.raid' && f.fraction >= P.sabotageAt).length, claimsLeft: round2(V.reduce((s, v) => s + sum(v.claims), 0)) },
    slots: Object.fromEntries(['grow', 'help', 'post', 'board', 'tower', 'relay', 'claim', 'raid', 'fake', 'idle'].map(k => [k, V.reduce((s, v) => s + (v.slots[k] ?? 0), 0)])),
    participants: participants.length,
  };
}

