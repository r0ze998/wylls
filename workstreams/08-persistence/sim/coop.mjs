// Cooperation harness (../18-coop-victory.ja.md). A small daily supply-chain model to check that
// an evaluation can tell real cooperation from dependence, monopoly, exclusion and inflated counts.
//
// IMPORTANT: workstream 1's international supply network and cooperative victory candidates were
// not available. Nothing here is their design. The objective rules below are PROBES: generic
// stand-ins used only to check that each measure moves the way it should in each case. When
// workstream 1's candidate arrives, it replaces the probe rules (19-coop-inputs.ja.md lists what
// is needed); the measures stay.
//
//   CMP   competitive probe: a nation's demand may only be served by its own nation's members
//   TRD   trade probe: any nation's members may serve any demand; no shared reward
//   COOP  cooperative probe: TRD plus a shared pool per delivered unit, split by `allocation`
//
// One step is one day. Three separately owned functions make one delivered unit: extraction
// ('mine'), a facility ('fac') and transport ('haul'). No central tower, no nation-specific
// resource or mandatory role is modelled (not decided).

import { draw, drawInt } from './rng.mjs';

export const STAGES = ['mine', 'fac', 'haul'];

export const COOP_BASE = {
  nations: 6,
  perNation: 6,
  days: 28,
  primaryCap: 10, // units/day in the participant's own function, assumption
  secondaryCap: 1, // units/day in the other two functions (capacity per function is ~1.2x demand), assumption
  primaryCost: 1, // per unit, assumption
  secondaryCost: 2.2, // per unit outside one's function, assumption
  haulPerDist: 0.4, // transport cost per unit per nation-step (ring distance, like neighbouring wedges)
  demand: 20, // units each nation wants a day, assumption
  value: 10, // what a delivered unit is worth to the nation that receives it, assumption
  markupBase: 0.1, // price = cost x (1 + base + power x the provider's share of eligible spare capacity), assumption
  markupPower: 1.5,
  incumbency: 0, // price discount a buyer gives its previous partner in a stage (0 = none)
  soloRate: 0.3, // outside option: per unit of own primary capacity a day, without trading, assumption
  objective: 'TRD', // 'CMP' | 'TRD' | 'COOP'
  sharedPool: 2, // COOP only: shared reward per delivered unit
  allocation: 'value', // COOP only: 'value' (by price share) | 'equal' (per chain member) | 'trades' (by recorded trades)
  creditMode: 'once', // 'once': a unit's credit is split across goals | 'each': counted in full for every goal
  // An ASSUMED decision rule, off by default: a provider serves another nation's buyer only if its
  // margin (price - cost, plus its expected share of the shared pool under COOP) is at least
  // foreignThreshold x cost. It stands for "helping a rival nation has a cost to me". Without it,
  // no one decides anything the shared pool could change, so COOP only redistributes.
  foreignThreshold: 0,
  // leaving (the same families as 5-6; nothing measured)
  quitModel: null, // null | 'flat' | 'relative' | 'decline'
  quitHazard: 0,
};

const ringDist = (a, b, n) => Math.min(Math.abs(a - b), n - Math.abs(a - b));

/**
 * Participants from a spec list:
 * { nation, primary, cap?, owner?, joinDay?, exitDay?, policy?: 'trade'|'solo', cartel?: id,
 *   wash?: partnerId, raiseAt?: { day, factor }, newcomer?: true }
 */
export function createCoop(params, specs, seed) {
  const P = { ...COOP_BASE, ...params };
  const parts = specs.map((s, id) => {
    const cap = {};
    const cost = {};
    for (const st of STAGES) {
      const prim = st === s.primary;
      cap[st] = s.cap?.[st] ?? (prim ? P.primaryCap : P.secondaryCap);
      cost[st] = prim ? P.primaryCost : P.secondaryCost;
    }
    return {
      id,
      owner: s.owner ?? id,
      nation: s.nation,
      primary: s.primary,
      cap,
      cost,
      joinDay: s.joinDay ?? 0,
      exitDay: s.exitDay ?? Infinity,
      policy: s.policy ?? 'trade',
      cartel: s.cartel ?? null,
      wash: s.wash ?? null,
      raiseAt: s.raiseAt ?? null,
      newcomer: !!s.newcomer,
      selfDeal: !!s.alt, // one person's accounts route a unit through each other
      markupFactor: 1,
      left: false,
      // ledgers
      revenue: 0,
      costPaid: 0,
      surplus: 0,
      shared: 0,
      solo: 0,
      trades: 0,
      washTrades: 0,
      units: 0,
      partners: new Map(), // partner owner -> units traded together
      buyers: new Map(), // buyer nation -> units
      firstTradeDay: null,
      daily: [],
    };
  });
  return { P, seed, parts, day: 0, log: [], cartels: new Set(parts.filter((p) => p.cartel !== null).map((p) => p.cartel)) };
}

function activeOn(p, day) {
  return !p.left && day >= p.joinDay && day < p.exitDay;
}

function nationOfCartel(w, cartel) {
  w.cartelNations ||= new Map();
  if (!w.cartelNations.has(cartel)) w.cartelNations.set(cartel, new Set(w.parts.filter((p) => p.cartel === cartel).map((p) => p.nation)));
  return w.cartelNations.get(cartel);
}

/** May provider p serve a unit for buyer nation b, in a chain whose members so far are `chain`? */
function allowed(w, p, b, chain) {
  if (p.policy !== 'trade') return false;
  if (w.P.objective === 'CMP' && p.nation !== b) return false;
  // a fixed coalition deals only with its own members and only for its own nations
  if (p.cartel !== null) {
    if (!nationOfCartel(w, p.cartel).has(b)) return false;
    if (chain.some((c) => c.cartel !== p.cartel)) return false;
  } else if (chain.some((c) => c.cartel !== null)) return false;
  return true;
}

function unitCost(w, p, st, b, chain) {
  let c = p.cost[st];
  if (st === 'haul') {
    // carried from the extraction site through the facility to the buyer
    const mine = chain[0];
    const fac = chain[1];
    const d = ringDist(mine.nation, fac.nation, w.P.nations) + ringDist(fac.nation, b, w.P.nations);
    c += w.P.haulPerDist * d;
  }
  return c;
}

/** Price of provider p holding `share` of the eligible spare capacity in its stage. */
function price(w, p, st, b, chain, share) {
  const markup = (w.P.markupBase + w.P.markupPower * share) * p.markupFactor;
  return unitCost(w, p, st, b, chain) * (1 + markup);
}

export function stepCoop(w) {
  const { P, parts } = w;
  const day = w.day;
  for (const p of parts) if (p.raiseAt && p.raiseAt.day === day) p.markupFactor = p.raiseAt.factor;
  const act = parts.filter((p) => activeOn(p, day));
  const left = new Map(parts.map((p) => [p.id, { ...p.cap }]));
  const dayLog = { day, delivered: 0, shortfall: 0, trades: 0, washTrades: 0, crossNationTrades: 0, crossOwnerChains: 0, crossNationChains: 0, decisions: 0, candOwners: 0, chains: [] };
  // outside option for those who do not trade
  for (const p of act) if (p.policy === 'solo') p.solo += P.soloRate * p.cap[p.primary];
  // demand, nation by nation in a daily order
  const order = [...Array(P.nations).keys()].sort((a, b) => draw(w.seed, 'coopOrder', day, a) - draw(w.seed, 'coopOrder', day, b));
  for (const b of order) {
    const members = act.filter((p) => p.nation === b);
    if (members.length === 0) continue;
    for (let u = 0; u < P.demand; u++) {
      const chain = [];
      const prices = [];
      for (const st of STAGES) {
        let best = null;
        let bestP = Infinity;
        const cands = act.filter((p) => left.get(p.id)[st] > 0 && allowed(w, p, b, chain));
        dayLog.decisions++;
        dayLog.candOwners += new Set(cands.map((p) => p.owner)).size;
        const spare = cands.reduce((a, p) => a + left.get(p.id)[st], 0);
        // the same person's other accounts are preferred down the chain (self-dealing, `selfDeal` accounts only)
        const own = chain.length && chain[0].selfDeal ? cands.filter((p) => p.owner === chain[0].owner && !chain.includes(p)) : [];
        for (const p of own.length ? own : cands) {
          let pr = price(w, p, st, b, chain, spare > 0 ? left.get(p.id)[st] / spare : 1);
          if (P.foreignThreshold > 0 && p.nation !== b) {
            const c = unitCost(w, p, st, b, chain);
            const poolShare = P.objective === 'COOP' ? P.sharedPool / 3 : 0;
            if (pr - c + poolShare < P.foreignThreshold * c) continue; // declines to help another nation
          }
          const last = w.lastPartner?.get(`${b}:${st}`);
          if (P.incumbency > 0 && last === p.owner) pr *= 1 - P.incumbency;
          const tie = draw(w.seed, 'coopTie', day, b, u, p.id) * 1e-6;
          if (pr + tie < bestP) {
            bestP = pr + tie;
            best = p;
          }
        }
        if (!best) break;
        chain.push(best);
        prices.push(bestP);
      }
      const total = prices.reduce((a, x) => a + x, 0);
      if (chain.length < 3 || total > P.value) {
        dayLog.shortfall++;
        continue;
      }
      // the deal
      dayLog.delivered++;
      w.lastPartner ||= new Map();
      chain.forEach((p, i) => {
        const st = STAGES[i];
        left.get(p.id)[st]--;
        const c = unitCost(w, p, st, b, chain.slice(0, i));
        p.revenue += prices[i];
        p.costPaid += c;
        p.trades++;
        p.units++;
        p.buyers.set(b, (p.buyers.get(b) || 0) + 1);
        for (const q of chain) if (q.owner !== p.owner) p.partners.set(q.owner, (p.partners.get(q.owner) || 0) + 1);
        if (p.firstTradeDay === null) p.firstTradeDay = day;
        w.lastPartner.set(`${b}:${st}`, p.owner);
        dayLog.trades++;
        if (p.nation !== b) dayLog.crossNationTrades++;
      });
      if (new Set(chain.map((p) => p.owner)).size > 1 && chain.some((p) => p.nation !== b)) dayLog.crossOwnerChains++;
      if (chain.some((p) => p.nation !== b)) dayLog.crossNationChains++;
      // the buyer nation's surplus goes to its members alike (a nation's project)
      const surplus = P.value - total;
      for (const m of members) m.surplus += surplus / members.length;
      dayLog.chains.push({ buyer: b, members: chain.map((p) => p.id), prices });
    }
  }
  // round-trip trades: recorded, nothing moves
  for (const p of act) {
    if (p.wash === null) continue;
    const q = parts[p.wash];
    if (!activeOn(q, day)) continue;
    const k = 5;
    p.trades += k;
    p.washTrades += k;
    dayLog.trades += k;
    dayLog.washTrades += k;
    if (p.nation !== q.nation) dayLog.crossNationTrades += k;
  }
  // the shared pool (COOP probe only)
  if (P.objective === 'COOP' && dayLog.delivered > 0) {
    const pool = P.sharedPool * dayLog.delivered;
    if (P.allocation === 'trades') {
      const tot = act.reduce((a, p) => a + (p.daily.length ? p.trades - p.daily[p.daily.length - 1].trades : p.trades), 0);
      for (const p of act) {
        const t = p.daily.length ? p.trades - p.daily[p.daily.length - 1].trades : p.trades;
        if (tot > 0) p.shared += (pool * t) / tot;
      }
    } else {
      for (const c of dayLog.chains) {
        const sum = c.prices.reduce((a, x) => a + x, 0);
        c.members.forEach((id, i) => {
          const share = P.allocation === 'equal' ? 1 / c.members.length : c.prices[i] / sum;
          parts[id].shared += P.sharedPool * share;
        });
      }
    }
  }
  for (const p of parts) p.daily.push({ day, net: net(p), trades: p.trades, units: p.units });
  dailyLeaving(w, act);
  w.log.push(dayLog);
  w.day++;
}

export function net(p) {
  return p.revenue - p.costPaid + p.surplus + p.shared + p.solo;
}

function dailyLeaving(w, act) {
  const { P } = w;
  if (!P.quitModel || P.quitHazard <= 0) return;
  const today = (p) => {
    const d = p.daily;
    return d.length > 1 ? d[d.length - 1].net - d[d.length - 2].net : d.length ? d[0].net : 0;
  };
  const xs = act.map(today).sort((a, b) => a - b);
  const med = xs[Math.floor(xs.length / 2)] || 1e-9;
  for (const p of act) {
    let gap;
    if (P.quitModel === 'flat') gap = 1;
    else if (P.quitModel === 'relative') gap = Math.max(0, 1 - today(p) / Math.max(1e-9, med));
    else {
      p.best = Math.max(p.best || 0, today(p));
      gap = Math.max(0, 1 - today(p) / Math.max(1e-9, p.best));
    }
    if (draw(w.seed, 'coopQuit', p.id, w.day) < P.quitHazard * gap) {
      p.left = true;
      p.leftDay = w.day;
    }
  }
}

export function runCoop(params, specs, seed) {
  const w = createCoop(params, specs, seed);
  while (w.day < w.P.days) stepCoop(w);
  return w;
}
