// The world model: villages (agents), six nations, victory forts, joint
// operations, raids, occupation, re-founding, map rings and the boundary
// between competitive units. One tick is one hour.
//
// Agents follow assumed behaviour models (params.mjs BEHAVIOURS). They are
// not predictions of real players.

import { draw, drawInt, pickWeighted } from './rng.mjs';
import { BEHAVIOURS, MIXES } from './params.mjs';
import { createGeo, resetGeo, assignHome, leaveHome, hexDistance, routeHostility, spawnConditions, objectiveProvinces } from './geo.mjs';

const DAY = 24;

// ---------------------------------------------------------------- set-up

export function createWorld(params, proposal, scenario, seed) {
  const P = { ...params, ...(scenario.params || {}) };
  const periodLen = P.periodDays * DAY;
  const w = {
    P,
    prop: proposal,
    scenario,
    seed,
    t: 0,
    periodLen,
    horizon: periodLen * P.periods,
    period: 0,
    agents: [],
    nations: [],
    forts: [],
    theater: 0,
    caravans: [],
    rings: 0,
    ops: [],
    ledger: { starter: 0, produced: 0, consumed: 0, upkeep: 0, burned: 0, reset: 0, voided: 0, returned: 0, refund: 0 },
    periodResults: [],
    boundaryRights: [],
    events: { raids: 0, raidSuccess: 0, occupations: 0, intercepts: 0, captures: 0, quits: 0, returns: 0, freqDrops: 0 },
    demob: [], // per boundary: { period, byAgent: Map(id -> troops disbanded) }
    pending: [], // agents waiting to (re)found: { id, at }
  };
  for (let n = 0; n < P.nations; n++) {
    w.nations.push({ id: n, opOffset: drawInt(seed, 'opOffset', 24, n), fortHours: 0, op: null, stock: 0 });
  }
  if (P.geo) w.geo = createGeo(P);
  openTheater(w);
  const specs = scenario.populate(P, seed);
  for (const s of specs) addAgent(w, s);
  return w;
}

function addAgent(w, s) {
  const { P, seed } = w;
  const id = w.agents.length;
  let behaviour = s.behaviour;
  if (!behaviour) {
    const mix = MIXES[P.behaviourMix];
    const u = draw(seed, 'behaviour', id);
    behaviour = u < mix.coop ? 'coop' : u < mix.coop + mix.raider ? 'raider' : 'turtle';
  }
  const sessions = s.kind === 'ai' ? 24 : s.sessionsPerDay ?? 2;
  const a = {
    id,
    kind: s.kind,
    cohort: s.cohort,
    behaviour,
    flags: s.flags || {},
    owner: s.owner ?? id, // the real person behind the account (alts share an owner)
    starterMult: s.starterMult ?? 1,
    sessions,
    baseSessions: sessions, // the plan at the start; `sessions` can drop later (freqDrop)
    sessionOffset: drawInt(seed, 'sessionOffset', 24, id),
    absence: s.absence || null,
    forcedDefeatT: s.forcedDefeatT ?? null,
    plannedJoinT: s.joinT,
    homeNation: s.nation,
    nation: s.nation,
    active: false,
    joinT: null, // first founding
    foundT: null, // latest founding (join or re-found)
    loc: null,
    goods: 0,
    troops: 0,
    farms: 0,
    tower: false,
    workshop: false,
    uncollected: 0,
    protectedUntil: -1,
    protectionHours: 0,
    starterKits: 0,
    refoundsThisPeriod: 0,
    lastProtectionPeriod: -1,
    firstContribT: null,
    firstContribAfterFound: null,
    contribValue: 0,
    contribCount: 0,
    contribKinds: new Set(),
    contribTimes: [],
    contribByDay: new Map(),
    raidedLoss: 0,
    defeats: [],
    history: [], // persistent record, never reset
    snapshots: {}, // keyed observations for metrics
    standing: false,
    lastOnline: -1,
    proxy: !!s.proxy, // a human whose village is run by an always-on agent between sessions
    rerollGroup: !!s.rerollGroup, // marked for the spawn re-roll comparison (with or without re-rolls)
    quit: false,
    quitT: null,
    returnT: null,
    quits: 0,
    returns: 0,
    opsSeen: 0, // operations of the own nation while active
    opsExposed: 0, // ... of which the owner was online at least once in the commitment window
    demobLost: 0,
  };
  w.agents.push(a);
  w.pending.push({ id, at: s.joinT, first: true });
  return a;
}

// ---------------------------------------------------------------- map

function slotsUsed(w, nation, loc) {
  let n = 0;
  for (const a of w.agents) if (a.active && a.nation === nation && a.loc === loc) n++;
  return n;
}

function place(w, a, placement) {
  const { P } = w;
  const interiorFree = slotsUsed(w, a.nation, 'interior') < P.interiorSlots;
  const borderFree = slotsUsed(w, a.nation, 'border') < P.borderSlots;
  let loc;
  if (placement === 'interior' && interiorFree) loc = 'interior';
  else if (placement === 'any') {
    // current shape: no reserved interior; a newcomer takes a free slot, inner first if any
    const u = draw(w.seed, 'placeAny', a.id, w.t);
    loc = interiorFree && u < 0.5 ? 'interior' : borderFree ? 'border' : interiorFree ? 'interior' : 'ring';
  } else loc = borderFree ? 'border' : interiorFree ? 'interior' : 'ring';
  if (loc === 'ring') {
    const ringUsed = slotsUsed(w, a.nation, 'ring');
    if (ringUsed >= P.ringSlots * w.rings) w.rings++;
  }
  a.loc = loc;
  // code shape: OpenRing needs some wedge with occupied/open >= theta (55 % in the first 3 days, then 65 %)
  const theta = w.t - periodStart(w) < 72 ? P.ringThetaEarly : P.ringThetaLate;
  const open = P.interiorSlots + P.borderSlots + P.ringSlots * w.rings;
  let occupied = 0;
  for (const b of w.agents) if (b.active && b.nation === a.nation) occupied++;
  if (occupied >= theta * open) w.rings++;
}

// ---------------------------------------------------------------- founding

function periodStart(w) {
  return w.period * w.periodLen;
}

function chooseNation(w, a) {
  const { P } = w;
  if (a.kind === 'ai' || P.newcomerNation === 'assigned') return a.homeNation;
  const u = draw(w.seed, 'nationChoice', a.id, w.t);
  if (P.newcomerNation === 'balanced') {
    let best = 0;
    let bestN = Infinity;
    for (const n of w.nations) {
      const c = w.agents.filter((b) => b.active && b.nation === n.id && b.kind === 'human').length;
      if (c < bestN) {
        bestN = c;
        best = n.id;
      }
    }
    return best;
  }
  // bandwagon: weight by this period's fort-hours
  const weights = w.nations.map((n) => 1 + n.fortHours);
  return pickWeighted(weights, u);
}

function found(w, a, first) {
  const { P, prop } = w;
  const rule = first ? prop.newcomer : prop.rejoin;
  if (first) {
    a.nation = a.plannedJoinT === 0 ? a.homeNation : chooseNation(w, a);
  } else if (prop.switching && P.switchProb > 0 && draw(w.seed, 'switch', a.id, w.t) < P.switchProb) {
    a.nation = leadingNation(w);
  }
  a.active = true;
  if (first && a.joinT === null) a.joinT = w.t;
  a.foundT = w.t;
  a.firstContribAfterFound = null;
  const elapsed = (w.t - periodStart(w)) / w.periodLen;
  const catchUp = first ? 1 + (rule.catchUp || 0) * elapsed * 3 : 1;
  const head = first && w.period === 0 ? a.starterMult : 1;
  let goods = Math.round(P.starterGoods * catchUp * head);
  let farms = P.starterFarms;
  if (!first) {
    const ruins = a.ruins || 0;
    farms = Math.max(farms, Math.round(ruins * (rule.keepFarmsFrac || 0)));
    goods += Math.round((a.ruinsValue || 0) * (rule.salvageFrac || 0));
    a.ruins = 0;
    a.ruinsValue = 0;
  }
  a.goods = goods;
  a.troops = P.starterTroops;
  a.farms = farms;
  a.tower = false;
  a.workshop = false;
  a.uncollected = 0;
  a.starterKits++;
  w.ledger.starter += goods;
  if (first && a.flags.alt && P.altFoundCost > 0) {
    // the person behind the account pays in full for each extra village (checked in processPending)
    spend(w, w.agents[a.owner], P.altFoundCost);
    a.altCostPaid = (a.altCostPaid || 0) + P.altFoundCost;
    a.altWaitH = (a.altWaitH || 0) + (w.t - Math.max(a.plannedJoinT, periodStart(w)));
  }
  place(w, a, rule.placement);
  if (w.geo) {
    a.loc = 'geo';
    assignHome(w, a);
  }
  // protection: once per period for re-founding; newcomers always get it on their first founding
  let prot = rule.protectionH || 0;
  if (first && rule.lateExtraH && w.t - periodStart(w) > rule.lateAfterH) prot += rule.lateExtraH;
  if (!first && rule.oncePerPeriod && a.lastProtectionPeriod === w.period) prot = 0;
  if (w.scenario.protectionOncePerOwner && !first) {
    // owner-level limit (only works while one person = one account)
    const owner = a.owner;
    if (w.agents.some((b) => b.owner === owner && b.id !== a.id && b.lastProtectionPeriod === w.period)) prot = 0;
  }
  if (prot > 0) {
    a.protectedUntil = w.t + prot;
    a.lastProtectionPeriod = w.period;
  } else a.protectedUntil = -1;
  a.history.push({ t: w.t, kind: first ? 'found' : 'refound', nation: a.nation, loc: a.loc });
}

function leadingNation(w) {
  let best = 0;
  for (const n of w.nations) if (n.fortHours > w.nations[best].fortHours) best = n.id;
  return best;
}

function joinAllowed(w) {
  const d = w.prop.joinDeadlineDay;
  if (d === null || d === undefined) return true;
  return w.t - periodStart(w) < d * DAY;
}

function processPending(w) {
  const keep = [];
  for (const p of w.pending) {
    const a = w.agents[p.id];
    if (p.at > w.t) {
      keep.push(p);
      continue;
    }
    if (!p.first && !w.prop.rejoin.allowedInPeriod) {
      keep.push({ ...p, at: periodStart(w) + w.periodLen }); // waits for the next competitive unit
      continue;
    }
    if (p.first && !joinAllowed(w)) {
      keep.push({ ...p, at: periodStart(w) + w.periodLen });
      continue;
    }
    if (p.first && a.flags.alt && w.P.altFoundCost > 0 && w.agents[a.owner].goods < w.P.altFoundCost) {
      keep.push({ ...p, at: w.t + 1 }); // the owner cannot pay yet: try again next hour
      continue;
    }
    found(w, a, p.first);
  }
  w.pending = keep;
}

// ---------------------------------------------------------------- presence

export function isOnline(w, a, t = w.t) {
  if (a.quit) return false;
  if (a.absence && t >= a.absence[0] && t < a.absence[1]) return false;
  if (a.kind === 'ai' || a.proxy) {
    const every = Math.max(1, Math.round(24 / w.P.aiActsPerDay));
    return t % every === 0;
  }
  const hour = t % DAY;
  const day = Math.floor(t / DAY);
  // planned sessions drift by up to ±sessionJitter hours from day to day
  const J = w.P.sessionJitter;
  for (let k = 0; k < a.sessions; k++) {
    const jitter = J > 0 ? drawInt(w.seed, 'jitter', 2 * J + 1, a.id, day, k) - J : 0;
    const start = (((Math.floor(a.sessionOffset + (k * DAY) / a.sessions) + jitter) % DAY) + DAY) % DAY;
    if (hour === start) {
      return draw(w.seed, 'skip', a.id, day, k) >= w.P.sessionSkip;
    }
  }
  return false;
}

// ---------------------------------------------------------------- economy

function farmCost(w, a) {
  return Math.round(w.P.farmBaseCost * w.P.farmCostGrowth ** a.farms);
}

function hourlyEconomy(w) {
  const { P, prop } = w;
  for (const a of w.agents) {
    if (!a.active) continue;
    const dormant = w.t - Math.max(a.lastOnline, a.foundT) >= P.dormantAfterH;
    if (dormant && a.protectedUntil > w.t) a.protectedUntil = w.t;
    const rate = a.farms * P.farmYield * (dormant ? P.dormantProduction : 1);
    a.uncollected = Math.min(rate * P.collectCapHours, a.uncollected + rate);
    let cost = a.troops * P.troopUpkeep;
    if (prop.upkeep && a.farms > prop.upkeep.freeFarms) {
      cost += prop.upkeep.rate * (a.farms - prop.upkeep.freeFarms) ** prop.upkeep.exp;
    }
    // upkeep is paid from uncollected production first, then from stock
    const fromU = Math.min(a.uncollected, cost);
    a.uncollected -= fromU;
    cost -= fromU;
    w.ledger.upkeep += fromU; // counted as produced-and-consumed
    w.ledger.produced += fromU;
    const fromG = Math.min(a.goods, cost);
    a.goods -= fromG;
    w.ledger.upkeep += fromG;
    cost -= fromG;
    if (cost > 0 && a.troops > 0) a.troops = Math.max(0, a.troops - Math.ceil(a.troops * 0.02));
  }
}

function collect(w, a) {
  const got = Math.floor(a.uncollected);
  a.uncollected -= got;
  a.goods += got;
  w.ledger.produced += got;
}

function develop(w, a) {
  const { P } = w;
  const b = BEHAVIOURS[a.behaviour];
  const target = b.troopsPerFarm * a.farms;
  if (a.troops < target) {
    const n = Math.min(target - a.troops, Math.floor((a.goods * 0.5) / P.troopPrice));
    if (n > 0) {
      a.troops += n;
      spend(w, a, n * P.troopPrice);
    }
  }
  const fc = farmCost(w, a);
  if (a.goods >= fc * 1.2) {
    a.farms++;
    spend(w, a, fc);
  }
  if (!a.tower && a.farms >= 3 && a.goods >= P.towerCost * 1.5) {
    a.tower = true;
    spend(w, a, P.towerCost);
  }
  if (!a.workshop && a.farms >= 4 && a.goods >= P.workshopCost * 1.5) {
    a.workshop = true;
    spend(w, a, P.workshopCost);
  }
  const g = w.prop.newcomer.endsOnFarms;
  if (g && a.farms >= g && a.protectedUntil > w.t) a.protectedUntil = w.t;
}

function spend(w, a, x) {
  a.goods -= x;
  w.ledger.consumed += x;
}

// ---------------------------------------------------------------- forts and operations

function openTheater(w) {
  const { P } = w;
  const th = w.theater;
  // per-nation distance multiplier: a rotating theater sits closer to some nations than others
  let dist = w.nations.map((n) => (w.prop.forts.rotateTheater ? [0.7, 1.0, 1.3][drawInt(w.seed, 'theaterDist', 3, th, n.id)] : 1.0));
  if (w.prop.forts.rotateTheater === 'underdog' && w.periodResults.length) {
    // the new region opens nearest to the nations that held the least in the unit just ended
    const last = w.periodResults[w.periodResults.length - 1].fortHours;
    const order = [...last.keys()].sort((x, y) => last[x] - last[y] || x - y);
    dist = w.nations.map((n) => {
      const rank = order.indexOf(n.id);
      return rank < 2 ? 0.7 : rank < 4 ? 1.0 : 1.3;
    });
  }
  if (w.geo) {
    for (const prov of objectiveProvinces(P.objectiveLayout, P.homeRingMax + 1)) {
      w.forts.push({ id: w.forts.length, theater: th, holder: null, garrison: new Map(), supply: 0, supplyBy: new Map(), dist, prov });
    }
    return;
  }
  for (let i = 0; i < P.forts; i++) {
    w.forts.push({ id: w.forts.length, theater: th, holder: null, garrison: new Map(), supply: 0, supplyBy: new Map(), dist });
  }
}

function scoringForts(w) {
  return w.forts.filter((f) => f.theater === w.theater);
}

function garrisonSize(f) {
  let s = 0;
  for (const v of f.garrison.values()) s += v;
  return s;
}

function travelTime(w, a, fort) {
  const { P } = w;
  if (w.geo && a.prov && fort.prov) return Math.max(1, Math.round(hexDistance(a.prov, fort.prov) * P.hoursPerProvince));
  const base = a.loc === 'interior' ? P.travelInterior : a.loc === 'border' ? P.travelBorder : P.travelRing;
  return Math.max(1, Math.round(base * fort.dist[a.nation]));
}

function openOps(w) {
  const hour = w.t % DAY;
  for (const n of w.nations) {
    if (n.op || hour !== n.opOffset) continue;
    const forts = scoringForts(w);
    const own = forts.filter((f) => f.holder === n.id);
    const others = forts.filter((f) => f.holder !== n.id);
    let target;
    let mode;
    const u = draw(w.seed, 'opMode', n.id, w.t);
    if (others.length && (own.length === 0 || u < 0.5)) {
      mode = 'attack';
      if (w.geo) {
        // a nation picks the objective its members can reach: garrison plus the members' median distance
        const members = w.agents.filter((a) => a.active && a.nation === n.id && a.prov);
        const cost = (f) => garrisonOrNeutral(w, f) + w.P.distanceWeight * median(members.map((a) => hexDistance(a.prov, f.prov)));
        target = others.reduce((m, f) => (cost(f) < cost(m) ? f : m));
      } else target = others.reduce((m, f) => (garrisonOrNeutral(w, f) < garrisonOrNeutral(w, m) ? f : m));
    } else {
      mode = 'defend';
      target = own.reduce((m, f) => (garrisonSize(f) < garrisonSize(m) ? f : m));
    }
    if (w.P.rushHours > 0 && periodStart(w) + w.periodLen - w.t <= w.P.rushHours && others.length) {
      // anticipating the cut: always attack (assumed behaviour, sensitivity only)
      mode = 'attack';
      target = others.reduce((m, f) => (garrisonOrNeutral(w, f) < garrisonOrNeutral(w, m) ? f : m));
    }
    for (const a of w.agents) {
      if (!a.active || a.nation !== n.id || a.kind !== 'human') continue;
      a.opsSeen++;
      for (let h = 0; h < w.P.opWindowHours; h++) {
        if (isOnline(w, a, w.t + h)) {
          a.opsExposed++;
          break;
        }
      }
    }
    const resolveDelay = w.geo ? w.P.geoResolveDelay : Math.ceil(w.P.travelInterior * 1.3);
    const mk = (f, m) => {
      const op = { id: w.ops.length, nation: n.id, mode: m, fort: f.id, opensT: w.t, closesT: w.t + w.P.opWindowHours, resolveT: w.t + w.P.opWindowHours + resolveDelay, troops: new Map(), supply: new Map(), watch: 0, craft: 0, escorts: 0, contributors: new Set() };
      w.ops.push(op);
      return op;
    };
    n.op = mk(target, mode);
    n.side = [];
    if (w.geo && w.P.opMode === 'local') {
      // local operations: every objective that is the nearest one for at least `localMin` members
      // gets its own operation (attack if another nation holds it or it is neutral, else defend)
      const members = w.agents.filter((a) => a.active && a.nation === n.id && a.prov);
      const count = new Map();
      for (const a of members) {
        const f = forts.reduce((m, x) => (hexDistance(a.prov, x.prov) < hexDistance(a.prov, m.prov) ? x : m));
        count.set(f.id, (count.get(f.id) || 0) + 1);
      }
      for (const f of forts) {
        if (f.id === target.id || (count.get(f.id) || 0) < w.P.localMin) continue;
        n.side.push(mk(f, f.holder === n.id ? 'defend' : 'attack'));
      }
    }
    if (w.geo) {
      for (const a of w.agents) {
        if (!a.active || a.nation !== n.id || a.kind !== 'human' || !a.prov) continue;
        a.opsReachSeen = (a.opsReachSeen || 0) + 1;
        const best = Math.min(...openOpsOf(n).map((o) => travelTime(w, a, w.forts[o.fort])));
        if (best <= w.P.opWindowHours + resolveDelay) a.opsReach = (a.opsReach || 0) + 1;
      }
    }
    if (w.P.standingOrders) {
      for (const a of w.agents) {
        if (a.active && a.nation === n.id && a.standing && a.goods >= w.P.supplyLot) {
          sendSupply(w, a, n.op, w.P.supplyLot, true);
        }
      }
    }
  }
}

function garrisonOrNeutral(w, f) {
  return f.holder === null ? w.P.neutralGarrison : garrisonSize(f);
}

function record(w, a, kind, value) {
  a.contribValue += value;
  a.contribCount++;
  a.contribKinds.add(kind);
  a.contribTimes.push(w.t);
  const day = Math.floor(w.t / DAY);
  a.contribByDay.set(day, (a.contribByDay.get(day) || 0) + value);
  if (a.firstContribT === null) a.firstContribT = w.t;
  if (a.firstContribAfterFound === null) {
    a.firstContribAfterFound = w.t;
    a.history.push({ t: w.t, kind: 'first_contribution_since_found', what: kind });
  }
}

function sendSupply(w, a, op, amount, standing = false) {
  const fort = w.forts[op.fort];
  a.goods -= amount;
  const tt = travelTime(w, a, fort);
  if (w.geo) {
    const st = (w.supplyStats ||= { sent: 0, lost: 0, n: 0, hours: 0 });
    st.sent += amount;
    st.n++;
    st.hours += tt;
  }
  w.caravans.push({ from: a.id, nation: a.nation, op: op.id, fort: fort.id, goods: amount, arriveT: w.t + tt, kind: 'supply', standing });
}

/** The operations a nation has open (the primary one and, in local mode, the side ones). */
export function openOpsOf(n) {
  return [n.op, ...(n.side || [])].filter(Boolean);
}

function contribute(w, a) {
  const n = w.nations[a.nation];
  let op = n.op;
  if (w.geo && n.side && n.side.length && a.prov) {
    // local operations: join the nearest one
    op = openOpsOf(n).reduce((m, o) => (hexDistance(a.prov, w.forts[o.fort].prov) < hexDistance(a.prov, w.forts[m.fort].prov) ? o : m));
  }
  if (!op || w.t >= op.closesT || op.contributors.has(a.id)) return;
  const { P } = w;
  const b = BEHAVIOURS[a.behaviour];
  const fort = w.forts[op.fort];
  let did = false;
  const supply = Math.floor((a.goods * b.supplyFrac) / P.supplyLot) * P.supplyLot;
  if (supply >= P.supplyLot) {
    sendSupply(w, a, op, supply);
    did = true;
  }
  const rush = w.P.rushHours > 0 && periodStart(w) + w.periodLen - w.t <= w.P.rushHours && a.behaviour !== 'turtle';
  const send = Math.floor(a.troops * (rush ? 1 : b.sendTroops));
  if (send >= P.minTroopsToSend) {
    a.troops -= send;
    const tt = travelTime(w, a, fort);
    w.caravans.push({ from: a.id, nation: a.nation, op: op.id, fort: fort.id, troops: send, arriveT: w.t + tt, kind: 'troops' });
    did = true;
  } else if (a.troops >= 3 && w.caravans.some((c) => c.nation === a.nation && c.kind === 'supply')) {
    op.escorts++;
    record(w, a, 'escort', 10);
    did = true;
  }
  if (a.tower) {
    op.watch++;
    record(w, a, 'watch', 10);
    did = true;
  }
  if (a.workshop && a.goods >= 40) {
    spend(w, a, 40);
    op.craft++;
    record(w, a, 'craft', 40);
    did = true;
  }
  if (did) op.contributors.add(a.id);
}

function arrivals(w) {
  const keep = [];
  for (const c of w.caravans) {
    if (c.arriveT > w.t) {
      keep.push(c);
      continue;
    }
    const a = w.agents[c.from];
    if (c.kind === 'transfer') {
      if (maybeIntercept(w, c)) continue;
      const to = w.agents[c.to];
      to.goods += c.goods;
      if (w.P.receiptEndsProtection && to.protectedUntil > w.t && to.owner !== undefined) to.protectedUntil = w.t;
      continue;
    }
    const op = w.ops[c.op];
    const open = w.t <= op.resolveT && !op.resolved;
    if (c.kind === 'supply') {
      if (maybeIntercept(w, c)) continue;
      if (open) {
        op.supply.set(a.id, (op.supply.get(a.id) || 0) + c.goods);
        record(w, a, 'supply', c.goods);
      } else {
        // late: returned to the sender (or lost if the village is gone)
        if (a.active) a.goods += c.goods;
        else {
          w.ledger.voided += c.goods;
        }
      }
    } else if (c.kind === 'troops') {
      if (open) {
        op.troops.set(a.id, (op.troops.get(a.id) || 0) + c.troops);
        record(w, a, 'troops', c.troops * w.P.troopPrice);
      } else if (a.active) a.troops += c.troops;
    }
  }
  w.caravans = keep;
}

function maybeIntercept(w, c) {
  const { P } = w;
  let raiders = [];
  for (const b of w.agents) {
    if (b.active && b.nation !== c.nation && b.behaviour === 'raider' && b.troops >= P.raidMinTroops && isOnline(w, b)) raiders.push(b);
  }
  if (raiders.length === 0) return false;
  const others = w.agents.filter((b) => b.active && b.nation !== c.nation).length || 1;
  const pressure = Math.min(1, (3 * raiders.length) / others);
  const op = c.op !== undefined ? w.ops[c.op] : null;
  const shield = op ? Math.min(0.8, 0.2 * op.escorts) : 0;
  let route = 1;
  if (w.geo) {
    const src = w.agents[c.from].prov;
    const dst = c.kind === 'transfer' ? w.agents[c.to].prov : w.forts[c.fort]?.prov;
    if (src && dst) {
      const h = routeHostility(w, src, dst, c.nation);
      route = P.routeBase + P.routeHostile * h;
      c.hostility = h;
    }
  }
  const p = P.interceptBase * P.raidPower * pressure * (1 - shield) * route;
  if (draw(w.seed, 'intercept', c.from, w.t, c.goods | 0) >= p) return false;
  const r = raiders[drawInt(w.seed, 'interceptor', raiders.length, c.from, w.t)];
  const take = Math.floor(c.goods * 0.5);
  r.goods += take;
  w.ledger.burned += c.goods - take;
  w.ledger.consumed += c.goods - take;
  w.agents[c.from].raidedLoss += c.goods;
  w.events.intercepts++;
  if (w.geo && c.kind === 'supply' && w.supplyStats) w.supplyStats.lost += c.goods;
  return true;
}

function closeOps(w) {
  for (const n of w.nations) {
    const due = [n.op, ...(n.side || [])].filter((op) => op && w.t >= op.resolveT);
    if (!due.length) continue;
    if (n.op && due.includes(n.op)) n.op = null;
    if (n.side) n.side = n.side.filter((op) => !due.includes(op));
    for (const op of due) resolveOp(w, n, op);
  }
}

function resolveOp(w, n, op) {
  op.resolved = true;
  const f = w.forts[op.fort];
  let troops = 0;
  for (const v of op.troops.values()) troops += v;
  let supply = 0;
  for (const v of op.supply.values()) supply += v;
  if (f.theater !== w.theater) {
    // the theater moved while the operation was open: troops go home, supply returns
    for (const [id, v] of op.troops) if (w.agents[id].active) w.agents[id].troops += v;
    for (const [id, v] of op.supply) returnGoods(w, id, v);
    return;
  }
  if (op.mode === 'defend') {
    if (f.holder === n.id) {
      for (const [id, v] of op.troops) f.garrison.set(id, (f.garrison.get(id) || 0) + v);
      f.supply += supply;
      for (const [id, v] of op.supply) f.supplyBy.set(id, (f.supplyBy.get(id) || 0) + v);
    } else {
      for (const [id, v] of op.troops) if (w.agents[id].active) w.agents[id].troops += v;
      for (const [id, v] of op.supply) returnGoods(w, id, v);
    }
    return;
  }
  if (troops === 0) {
    for (const [id, v] of op.supply) returnGoods(w, id, v);
    return;
  }
  // attack: the nation's own stock tops up what members delivered
  if (n.stock > 0) {
    const top = Math.min(n.stock, Math.max(0, troops * 2 - supply));
    n.stock -= top;
    supply += top;
  }
  const supplyFactor = 0.6 + 0.4 * Math.min(1, supply / (troops * 2));
  const S = troops * supplyFactor * (1 + 0.03 * Math.min(10, op.watch + op.craft));
  const D = garrisonOrNeutral(w, f) * w.P.fortDefence * (f.supply > 0 ? 1.1 : 1.0);
  w.ledger.consumed += supply; // consumed in the attack
  const s = S * (0.8 + 0.4 * draw(w.seed, 'opS', op.id));
  const d = D * (0.8 + 0.4 * draw(w.seed, 'opD', op.id));
  if (s > d) {
    w.events.captures++;
    const keepFrac = 1 - (0.5 * d) / (s + d);
    f.garrison = new Map();
    for (const [id, v] of op.troops) f.garrison.set(id, Math.round(v * keepFrac));
    const wasNeutral = f.holder === null;
    f.holder = n.id;
    if (wasNeutral && f.supply > 0) {
      n.stock += f.supply; // stock left in a neutral fort goes to whoever takes it
    } else {
      // supply stored by the previous holder is captured (burned)
      w.ledger.burned += f.supply;
      w.ledger.consumed += f.supply;
    }
    f.supply = 0;
    f.supplyBy = new Map();
  } else {
    for (const [id, v] of op.troops) if (w.agents[id].active) w.agents[id].troops += Math.round(v * 0.4);
    const loss = (0.3 * s) / (s + d);
    for (const [id, v] of f.garrison) f.garrison.set(id, Math.round(v * (1 - loss)));
  }
}

function returnGoods(w, id, v) {
  const a = w.agents[id];
  if (a.active) {
    a.goods += v;
    w.ledger.returned += v;
  } else w.ledger.voided += v;
}

function fortUpkeep(w) {
  for (const f of scoringForts(w)) {
    if (f.holder === null) continue;
    w.nations[f.holder].fortHours++;
    const g = garrisonSize(f);
    const need = g * 0.02;
    if (f.supply >= need) {
      f.supply -= need;
      w.ledger.consumed += need;
    } else {
      w.ledger.consumed += f.supply;
      f.supply = 0;
      for (const [id, v] of f.garrison) f.garrison.set(id, Math.max(0, v - Math.ceil(v * 0.003)));
    }
  }
}

// ---------------------------------------------------------------- raids and occupation

const EXPOSURE = { interior: 0.3, border: 1.0, ring: 1.2, geo: 1.0 };
const DEFENCE = { interior: 1.5, border: 1.0, ring: 0.8, geo: 1.0 };

function maybeRaid(w, a) {
  const { P } = w;
  const b = BEHAVIOURS[a.behaviour];
  if (a.troops < P.raidMinTroops) return;
  if (a.protectedUntil > w.t && w.prop.newcomer.onAttack === 'blocked') return;
  if (draw(w.seed, 'raidRoll', a.id, w.t) >= Math.min(0.95, b.raid * P.raidPower)) return;
  const cands = [];
  const weights = [];
  for (const d of w.agents) {
    if (!d.active || d.nation === a.nation || d.protectedUntil > w.t) continue;
    if (d.owner === a.owner) continue;
    if (w.geo && hexDistance(a.prov, d.prov) > w.P.raidRange) continue;
    cands.push(d);
    weights.push(EXPOSURE[d.loc] * (d.goods + 1) / (d.troops * DEFENCE[d.loc] + 5));
  }
  const i = pickWeighted(weights, draw(w.seed, 'raidTarget', a.id, w.t));
  if (i === null) return;
  raid(w, a, cands[i]);
}

function raid(w, a, d) {
  const { P } = w;
  w.events.raids++;
  if (a.protectedUntil > w.t && w.prop.newcomer.onAttack === 'ends') a.protectedUntil = w.t; // attacking ends protection
  const att = Math.floor(a.troops * 0.6);
  let def = d.troops * DEFENCE[d.loc];
  if (w.geo && w.P.allyHelp > 0) {
    // neighbours of the same nation lend part of their home guard (automatic defence, decided line)
    let help = 0;
    for (const b of w.agents) {
      if (!b.active || b.id === d.id || b.nation !== d.nation || !b.prov) continue;
      if (hexDistance(b.prov, d.prov) > 1 || b.troops <= 0) continue;
      help += b.troops * w.P.allyHelp;
      if (b.firstAidT === undefined) b.firstAidT = w.t;
    }
    if (help > 0) {
      def += help;
      if (d.firstAidT === undefined) d.firstAidT = w.t;
      w.events.aids = (w.events.aids || 0) + 1;
    }
  }
  const s = att * (0.7 + 0.6 * draw(w.seed, 'raidS', a.id, w.t));
  const r = def * (0.7 + 0.6 * draw(w.seed, 'raidD', a.id, w.t));
  const success = s > r;
  const attLoss = Math.round((att * def) / (att + def + 1e-9) * (success ? 0.4 : 0.7));
  const defLoss = Math.round((d.troops * att) / (att + def + 1e-9) * (success ? 0.6 : 0.2));
  a.troops -= attLoss;
  d.troops = Math.max(0, d.troops - defLoss);
  if (!success) return;
  w.events.raidSuccess++;
  const cellar = w.prop.cellarFrac ?? w.P.cellarFrac;
  const exposed = Math.max(0, d.goods * (1 - cellar));
  const loot = Math.floor(Math.min(att * P.raidCarryPerTroop, exposed * P.raidLootFrac));
  d.goods -= loot;
  a.goods += loot;
  d.raidedLoss += loot;
  d.history.push({ t: w.t, kind: 'raided', by: a.id, loot });
  if (d.troops <= 1 && att - attLoss >= P.occupyMinAttackers) {
    const p = d.loc === 'interior' ? P.occupyProb * 0.3 : P.occupyProb;
    if (draw(w.seed, 'occupy', d.id, w.t) < p) {
      // the attacker takes part of what remains
      const take = Math.floor(d.goods * 0.5);
      a.goods += take;
      d.goods -= take;
      defeat(w, d, 'occupied', a.id);
    }
  }
}

export function capacity(a) {
  return a.farms + a.troops / 10 + a.goods / 100;
}

/** What it would cost to build the village's farms again (farm n costs base x growth^n). */
export function farmValue(w, farms) {
  const { farmBaseCost: b, farmCostGrowth: g } = w.P;
  return g === 1 ? b * farms : (b * (g ** farms - 1)) / (g - 1);
}

/** A village's assets at replacement cost: stock, troops at their training price, buildings at their build cost. */
export function wealth(w, a) {
  return a.goods + a.troops * w.P.troopPrice + farmValue(w, a.farms) + (a.tower ? w.P.towerCost : 0) + (a.workshop ? w.P.workshopCost : 0);
}

function defeat(w, a, cause, by) {
  w.events.occupations++;
  const before = wealth(w, a);
  a.defeats.push({ t: w.t, cause, by, capacity: capacity(a), wealth: before, recoveredT: null, contribT: null, period: w.period, foundT: w.t });
  a.history.push({ t: w.t, kind: 'defeated', cause, by });
  a.defeats[a.defeats.length - 1].after = 0;
  if (a.kind === 'human' && w.P.quitOnDefeat > 0 && draw(w.seed, 'quitOnDefeat', a.id, w.t) < w.P.quitOnDefeat) quit(w, a, 'defeat');
  if (w.prop.defeatMode === 'strip') {
    // the home cannot be taken (code: PlaceHome sits in the unbesiegeable heartland);
    // what is lost is everything beyond it: outposts, stores, garrison
    w.ledger.voided += a.goods;
    a.goods = 0;
    a.troops = Math.floor(a.troops / 2);
    a.farms = Math.min(a.farms, w.P.starterFarms);
    a.tower = false;
    a.workshop = false;
    a.uncollected = 0;
    a.firstContribAfterFound = null;
    a.defeats[a.defeats.length - 1].after = wealth(w, a);
    return;
  }
  a.ruins = a.farms;
  a.ruinsValue = farmValue(w, a.farms);
  w.ledger.voided += a.goods;
  a.goods = 0;
  a.troops = 0;
  a.farms = 0;
  a.tower = false;
  a.workshop = false;
  a.uncollected = 0;
  a.active = false;
  a.protectedUntil = -1;
  a.loc = null;
  leaveHome(w, a);
  const delay = w.prop.rejoin.delayH || 0;
  if (!a.quit) w.pending.push({ id: a.id, at: w.t + delay, first: false });
}

// ---------------------------------------------------------------- leaving, coming back, playing less
//
// None of these rates is measured; they are swept as assumptions (run.mjs 'retention').

function quit(w, a, cause) {
  a.quit = true;
  a.quitT = w.t;
  a.quits++;
  w.events.quits++;
  a.history.push({ t: w.t, kind: 'left', cause });
  w.pending = w.pending.filter((p) => p.id !== a.id);
  const P = w.P;
  if (P.returnProb > 0 && draw(w.seed, 'returns', a.id, w.t) < P.returnProb) {
    const span = Math.max(0, P.returnMaxDays - P.returnMinDays);
    a.returnT = w.t + 24 * (P.returnMinDays + drawInt(w.seed, 'returnDay', span + 1, a.id, w.t));
  } else a.returnT = null;
}

function comeBack(w) {
  for (const a of w.agents) {
    if (!a.quit || a.returnT !== w.t) continue;
    a.quit = false;
    a.returns++;
    w.events.returns++;
    a.history.push({ t: w.t, kind: 'came_back' });
    if (!a.active) {
      // the village is gone (world rebuilt, or occupied and not re-founded): found again
      const fresh = a.joinT === null || w.prop.boundary === 'reset_world';
      w.pending.push({ id: a.id, at: w.t, first: fresh });
    }
  }
}

function dailyChoices(w) {
  const { P } = w;
  if (w.t % DAY !== 0 || (P.quitBase <= 0 && P.quitHazard <= 0 && P.freqDrop <= 0)) return;
  const people = w.agents.filter((a) => a.active && !a.quit && a.kind === 'human' && Object.keys(a.flags).length === 0);
  if (people.length === 0) return;
  const ws = people.map((a) => wealth(w, a)).sort((x, y) => x - y);
  const median = ws[Math.floor(ws.length / 2)] || 1;
  for (const a of people) {
    const now = wealth(w, a);
    a.peakWealth = Math.max(a.peakWealth || 0, now);
    // quitModel 'relative': a village below the median human village feels behind (compares with others)
    // quitModel 'decline':  a village below its own best feels it is losing (compares with itself)
    const deficit = P.quitModel === 'decline' ? Math.max(0, 1 - now / Math.max(1, a.peakWealth)) : Math.max(0, 1 - now / median);
    if (draw(w.seed, 'quitDaily', a.id, w.t) < P.quitBase + P.quitHazard * deficit) {
      quit(w, a, 'behind');
      continue;
    }
    if (a.sessions > 1 && draw(w.seed, 'freqDrop', a.id, w.t) < P.freqDrop * deficit) {
      a.sessions = Math.ceil(a.sessions / 2);
      w.events.freqDrops++;
      a.history.push({ t: w.t, kind: 'plays_less', sessions: a.sessions });
    }
  }
}

// ---------------------------------------------------------------- scenario hooks (exploits)

function exploitActions(w, a) {
  const f = a.flags;
  if (f.altMain && a.goods > 300) {
    // move stock into this owner's protected alt accounts
    const alts = w.agents.filter((b) => b.owner === a.owner && b.id !== a.id && b.active && b.protectedUntil > w.t);
    if (alts.length) {
      const amount = Math.floor((a.goods - 100) / alts.length);
      for (const b of alts) transfer(w, a, b, amount);
    }
  }
  if (f.feeder) {
    const main = w.agents[f.feeder.to];
    if (main.active && a.goods > 60) transfer(w, a, main, a.goods - 40);
  }
  if (f.kingmaker) {
    const tLeft = periodStart(w) + w.periodLen - w.t;
    if (tLeft <= 48) {
      const lead = leadingNation(w);
      if (lead !== a.nation) {
        const target = w.agents.filter((b) => b.active && b.nation === lead).sort((x, y) => y.troops - x.troops)[0];
        if (target && a.goods > 40) transfer(w, a, target, a.goods - 20);
      }
    }
  }
}

function transfer(w, from, to, amount) {
  if (amount <= 0) return;
  from.goods -= amount;
  const tt = from.nation === to.nation ? 2 : 4;
  w.caravans.push({ from: from.id, to: to.id, nation: from.nation, goods: amount, arriveT: w.t + tt, kind: 'transfer' });
}

function churn(w, a) {
  // abandon and re-found to collect a fresh starter kit and protection when protection has ended
  if (!a.flags.churn || a.protectedUntil > w.t || a.goods > 150) return;
  if (w.t - a.foundT < 72) return;
  a.history.push({ t: w.t, kind: 'abandoned' });
  w.ledger.voided += a.goods;
  a.goods = 0;
  a.troops = 0;
  a.ruins = a.farms;
  a.ruinsValue = 0;
  a.farms = 0;
  a.active = false;
  a.loc = null;
  leaveHome(w, a);
  w.pending.push({ id: a.id, at: w.t + (w.prop.rejoin.delayH || 0), first: false, churn: true });
}

// ---------------------------------------------------------------- boundary

function snapshotPeriod(w) {
  const forts = w.nations.map((n) => n.fortHours);
  const active = w.agents.filter((a) => a.active);
  w.periodResults.push({
    period: w.period,
    fortHours: forts,
    winner: forts.every((x) => x === 0) ? null : forts.indexOf(Math.max(...forts)),
    wealth: active.map((a) => wealth(w, a)),
    wealthById: Object.fromEntries(w.agents.map((a) => [a.id, a.active ? wealth(w, a) : 0])),
    wealthHuman: active.filter((a) => a.kind === 'human').map((a) => wealth(w, a)),
    military: w.nations.map((n) => {
      let s = 0;
      for (const a of active) if (a.nation === n.id) s += a.troops;
      for (const f of w.forts) for (const [id, v] of f.garrison) if (w.agents[id].nation === n.id) s += v;
      return s;
    }),
    farmsByNation: w.nations.map((n) => active.filter((a) => a.nation === n.id).reduce((s, a) => s + a.farms, 0)),
    activeByNation: w.nations.map((n) => active.filter((a) => a.nation === n.id).length),
  });
}

export function boundary(w) {
  snapshotPeriod(w);
  const { prop } = w;
  const r = prop.rights;
  // what is in flight or deposited at the moment of the cut
  let caravanValue = 0;
  let troopsInFlight = 0;
  for (const c of w.caravans) {
    caravanValue += c.goods || 0;
    troopsInFlight += c.troops || 0;
  }
  let fortSupply = 0;
  let garrisons = 0;
  for (const f of w.forts) {
    fortSupply += f.supply;
    garrisons += garrisonSize(f);
  }
  const standing = w.agents.filter((a) => a.active && a.standing).length;
  const openOpsCount = w.nations.reduce((c, n) => c + (n.op ? 1 : 0), 0);
  const rec = { period: w.period, caravanValue, troopsInFlight, fortSupply, garrisons, standing, openOps: openOpsCount, voided: 0, returned: 0 };

  if (prop.boundary === 'reset_world') {
    const before = w.ledger.voided;
    for (const c of w.caravans) w.ledger.voided += c.goods || 0;
    w.caravans = [];
    for (const n of w.nations) {
      for (const op of openOpsOf(n)) for (const v of op.supply.values()) w.ledger.voided += v;
      n.op = null;
      n.side = [];
    }
    for (const f of w.forts) {
      w.ledger.voided += f.supply;
    }
    for (const n of w.nations) {
      w.ledger.voided += n.stock;
      n.stock = 0;
    }
    w.forts = [];
    w.theater++;
    if (w.geo) {
      resetGeo(w); // a new world: everyone is placed again
      for (const a of w.agents) a.prov = null;
    }
    openTheater(w);
    w.rings = 0;
    const carry = [];
    for (const a of w.agents) {
      if (a.active) {
        w.ledger.reset += a.goods;
        a.history.push({ t: w.t, kind: 'unit_end', farms: a.farms, wealth: wealth(w, a) });
        a.goods = 0;
        a.troops = 0;
        a.farms = 0;
        a.tower = false;
        a.workshop = false;
        a.uncollected = 0;
        a.active = false;
        // a scheduled reset that hits everyone is not counted as the person's own loss, unless
        // quitPeakAcrossResets says the reset itself feels like losing (assumption, swept)
        if (!w.P.quitPeakAcrossResets) a.peakWealth = 0;
        if (!a.quit) carry.push(a.id);
      }
    }
    rec.voided = w.ledger.voided - before;
    w.period++;
    resetScores(w);
    // everyone who was in, or waiting, starts the next unit as a newcomer would on day one
    const waiting = new Set(w.pending.filter((p) => p.at <= w.t + w.periodLen).map((p) => p.id));
    w.pending = w.pending.filter((p) => !carry.includes(p.id) && !(waiting.has(p.id) && !p.first && w.agents[p.id].joinT !== null));
    for (const id of carry) w.pending.push({ id, at: w.t, first: true });
    for (const a of w.agents) {
      if (!a.active && !a.quit && a.joinT !== null && !carry.includes(a.id) && !w.pending.some((p) => p.id === a.id)) {
        w.pending.push({ id: a.id, at: w.t, first: true });
      }
      a.lastProtectionPeriod = -1;
      a.refoundsThisPeriod = 0;
    }
  } else {
    const before = w.ledger.returned;
    const voidBefore = w.ledger.voided;
    if (prop.boundary === 'reset_war') {
      // garrisons go home and forts return to neutral. What was delivered to a fort or to an open
      // operation has already left its sender: by default it is the nation's (r.fortSupply):
      //   'nation'  – moves to the storehouse of the nation that held it (the donee keeps it)
      //   'stay'    – stays in the neutral fort; whoever takes the fort next takes it
      //   'destroy' – lost with the neutralisation
      //   'return'  – handed back to the senders pro rata (needs per-deposit provenance AND a custody
      //               right; only a comparison variant, not a default)
      // Cargo still on the road was never delivered, so it stays its sender's and goes back home.
      for (const f of w.forts) {
        for (const [id, v] of f.garrison) if (w.agents[id].active) w.agents[id].troops += v;
        f.garrison = new Map();
        const holder = f.holder;
        f.holder = null;
        settleFortStock(w, f, holder, r.fortSupply);
      }
      const keep = [];
      for (const c of w.caravans) {
        if (c.kind === 'transfer') keep.push(c);
        else if (c.kind === 'supply') returnGoods(w, c.from, c.goods);
        else if (c.kind === 'troops' && w.agents[c.from].active) w.agents[c.from].troops += c.troops;
      }
      w.caravans = keep;
      for (const n of w.nations) {
        for (const op of openOpsOf(n)) {
          for (const [id, v] of op.troops) if (w.agents[id].active) w.agents[id].troops += v;
          let delivered = 0;
          for (const v of op.supply.values()) delivered += v;
          if (r.fortSupply === 'return') for (const [id, v] of op.supply) returnGoods(w, id, v);
          else if (r.fortSupply === 'destroy') w.ledger.voided += delivered;
          else n.stock += delivered; // delivered to the nation's operation: the nation's
        }
        n.op = null;
        n.side = [];
      }
      if (prop.forts.rotateTheater) {
        w.theater++;
        openTheater(w);
      }
    }
    if (prop.demobilize) {
      // armies stand down to a home guard of `demobilize` troops per farm (at least the starter
      // troops); the rest is disbanded. demobRefund: share of the training price paid back as goods.
      const byAgent = new Map();
      for (const a of w.agents) {
        if (!a.active) continue;
        const keep = Math.max(w.P.starterTroops, Math.round(prop.demobilize * a.farms));
        if (a.troops > keep) {
          const cut = a.troops - keep;
          byAgent.set(a.id, { cut, before: a.troops, behaviour: a.behaviour, kind: a.kind });
          a.troops = keep;
          a.demobLost += cut;
          const refund = Math.floor(cut * w.P.troopPrice * (prop.demobRefund || 0));
          if (refund > 0) {
            a.goods += refund;
            w.ledger.refund += refund;
          }
        }
      }
      const activeCount = w.agents.filter((a) => a.active).length;
      w.demob.push({ period: w.period, byAgent, activeCount });
    }
    rec.returned = w.ledger.returned - before;
    rec.voided = w.ledger.voided - voidBefore;
    w.period++;
    resetScores(w);
    for (const a of w.agents) a.refoundsThisPeriod = 0;
  }
  w.boundaryRights.push(rec);
}

function settleFortStock(w, f, holder, policy) {
  if (f.supply <= 0) {
    f.supply = 0;
    f.supplyBy = new Map();
    return;
  }
  if (policy === 'return') {
    let left = f.supply;
    let total = 0;
    for (const v of f.supplyBy.values()) total += v;
    for (const [id, v] of f.supplyBy) {
      const share = total > 0 ? Math.floor((f.supply * v) / total) : 0;
      returnGoods(w, id, share);
      left -= share;
    }
    w.ledger.voided += left;
  } else if (policy === 'nation' && holder !== null) {
    w.nations[holder].stock += f.supply;
  } else if (policy === 'stay') {
    return; // the stock stays in the neutral fort (supplyBy is kept only as history)
  } else {
    w.ledger.voided += f.supply;
  }
  f.supply = 0;
  f.supplyBy = new Map();
}

function resetScores(w) {
  for (const n of w.nations) n.fortHours = 0;
}

// ---------------------------------------------------------------- tick

export function step(w) {
  if (w.t > 0 && w.t % w.periodLen === 0) boundary(w);
  comeBack(w);
  processPending(w);
  dailyChoices(w);
  for (const a of w.agents) {
    if (a.forcedDefeatT === w.t && a.active) defeat(w, a, 'forced', null);
  }
  hourlyEconomy(w);
  openOps(w);
  for (const a of w.agents) {
    if (!a.active) continue;
    if (a.protectedUntil > w.t) a.protectionHours++;
    if (!isOnline(w, a)) continue;
    a.lastOnline = w.t;
    collect(w, a);
    if (w.P.standingOrders && a.behaviour !== 'turtle') a.standing = true;
    exploitActions(w, a);
    if (!a.flags.alt && !a.flags.feeder) contribute(w, a);
    if (!a.flags.alt && !a.flags.feeder) maybeRaid(w, a);
    develop(w, a);
    churn(w, a);
  }
  arrivals(w);
  closeOps(w);
  fortUpkeep(w);
  observe(w);
  w.t++;
}

function median(xs) {
  if (!xs.length) return 0;
  const s = [...xs].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}

function observe(w) {
  if (w.geo) {
    for (const a of w.agents) {
      // conditions where a village was first placed, once every village placed in this hour is on the map
      if (a.active && a.foundT === w.t && a.foundT === a.joinT && !a.snapshots.spawn) a.snapshots.spawn = spawnConditions(w, a);
      if (a.active && a.foundT === w.t && w.period > 0 && a.foundT !== a.joinT && w.prop.boundary === 'reset_world' && !a.snapshots[`spawn@${w.period}`]) {
        a.snapshots[`spawn@${w.period}`] = spawnConditions(w, a);
      }
    }
  }
  for (const a of w.agents) {
    if (!a.absence) continue;
    if (w.t === a.absence[0]) a.snapshots.absenceStart = { wealth: a.active ? wealth(w, a) : 0, farms: a.farms };
    if (w.t === a.absence[1]) a.snapshots.absenceEnd = { wealth: a.active ? wealth(w, a) : 0, farms: a.farms, active: a.active, defeatsDuring: a.defeats.filter((d) => d.t >= a.absence[0]).length };
  }
  // per-agent observations at fixed offsets after (re)founding
  for (const a of w.agents) {
    if (!a.active || a.foundT === null) continue;
    const since = w.t - a.foundT;
    if (since === 24 || since === 72) {
      const key = `kinds@${since}`;
      if (!(key in a.snapshots) && a.foundT === a.joinT) a.snapshots[key] = feasibleKinds(w, a);
    }
  }
  // recovery after defeat
  for (const a of w.agents) {
    if (!a.active) continue;
    for (const d of a.defeats) {
      if (d.contribT === null && a.firstContribAfterFound !== null && a.firstContribAfterFound >= d.t) d.contribT = a.firstContribAfterFound;
      if (d.recoveredT === null && w.t > d.t && Math.max(a.foundT, d.foundT) >= d.t && capacity(a) >= 0.5 * d.capacity) d.recoveredT = w.t;
    }
  }
}

/** Contribution kinds this village could execute right now if its owner were online. */
export function feasibleKinds(w, a) {
  const { P } = w;
  let k = 0;
  if (a.goods >= P.supplyLot) k++;
  if (a.troops >= P.minTroopsToSend) k++;
  if (a.troops >= 3) k++; // escort
  if (a.tower) k++;
  if (a.workshop && a.goods >= 40) k++;
  return k;
}

/** Goods that exist right now: in villages, on the road, at open operations, in forts. */
export function goodsInWorld(w) {
  let s = 0;
  for (const a of w.agents) s += a.goods;
  for (const c of w.caravans) s += c.goods || 0;
  for (const n of w.nations) for (const op of openOpsOf(n)) for (const v of op.supply.values()) s += v;
  for (const f of w.forts) s += f.supply;
  for (const n of w.nations) s += n.stock;
  return s;
}

/** What the ledger says should exist. */
export function goodsByLedger(w) {
  const L = w.ledger;
  return L.starter + L.refund + L.produced - L.consumed - L.upkeep - L.voided - L.reset;
}

export function run(params, proposal, scenario, seed) {
  const w = createWorld(params, proposal, scenario, seed);
  while (w.t < w.horizon) step(w);
  snapshotPeriod(w);
  return w;
}
