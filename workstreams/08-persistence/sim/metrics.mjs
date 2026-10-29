// Per-run measurements. Each function reads a finished world and returns
// plain numbers; aggregation across seeds happens in run.mjs.

import { gini, hhi, topShare, mean } from './stats.mjs';
import { wealth } from './world.mjs';

const DAY = 24;

function cohort(w, name) {
  return w.agents.filter((a) => a.cohort === name);
}

function firstAfter(times, t0) {
  for (const t of times) if (t >= t0) return t;
  return null;
}

function contribIn(a, fromT, toT) {
  let s = 0;
  for (const [day, v] of a.contribByDay) {
    const t = day * DAY;
    if (t >= fromT && t < toT) s += v;
  }
  return s;
}

/** Newcomers: from the hour they wanted to join. */
export function newcomers(w, name) {
  const out = [];
  for (const a of cohort(w, name)) {
    const t0 = a.plannedJoinT;
    const first = firstAfter(a.contribTimes, t0);
    out.push({
      firstOpH: first === null ? Infinity : first - t0,
      waitToFoundH: a.joinT === null ? Infinity : a.joinT - t0,
      kinds24: a.snapshots['kinds@24'] ?? 0,
      kinds72: a.snapshots['kinds@72'] ?? 0,
      contrib7d: contribIn(a, t0, t0 + 7 * DAY),
    });
  }
  return out;
}

/** Reference: what a day-1 player contributes per 7 days in the same window. */
export function day1Contrib7d(w, fromT) {
  const xs = cohort(w, 'day1').filter((a) => a.sessions === 2).map((a) => contribIn(a, fromT, fromT + 7 * DAY));
  return mean(xs);
}

export function concentration(w) {
  const per = w.periodResults;
  const units = per.slice(0, w.P.periods); // the last snapshot repeats the final unit
  const rows = units.map((r) => ({
    giniWealth: gini(r.wealth),
    top10: top10(r.wealth),
    militaryHHI: hhi(r.military),
    fortHHI: hhi(r.fortHours),
    winner: r.winner,
    winnerShare: topShare(r.fortHours),
  }));
  let repeats = 0;
  for (let i = 1; i < rows.length; i++) if (rows[i].winner !== null && rows[i].winner === rows[i - 1].winner) repeats++;
  const firstWinner = rows[0].winner;
  const laterShares = units.slice(1).map((r) => {
    const tot = r.fortHours.reduce((s, x) => s + x, 0);
    return tot > 0 && firstWinner !== null ? r.fortHours[firstWinner] / tot : NaN;
  });
  // the last-placed nation of a unit: its fort share in the next unit (1/6 = back to even)
  const bottomNext = [];
  const winners = new Set();
  for (let i = 0; i < units.length; i++) {
    if (rows[i].winner !== null) winners.add(rows[i].winner);
    if (i + 1 >= units.length) continue;
    const f = units[i].fortHours;
    const last = f.indexOf(Math.min(...f));
    const tot = units[i + 1].fortHours.reduce((s, x) => s + x, 0);
    if (tot > 0) bottomNext.push(units[i + 1].fortHours[last] / tot);
  }
  return {
    lastGini: rows[rows.length - 1].giniWealth,
    lastTop10: rows[rows.length - 1].top10,
    meanMilitaryHHI: mean(rows.map((r) => r.militaryHHI)),
    meanFortHHI: mean(rows.map((r) => r.fortHHI)),
    meanWinnerShare: mean(rows.map((r) => r.winnerShare)),
    winnerRepeat: repeats / Math.max(1, rows.length - 1),
    firstWinnerLaterShare: mean(laterShares.filter((x) => Number.isFinite(x))),
    bottomNextShare: mean(bottomNext),
    distinctWinners: winners.size,
    lastMilitaryTop: topShare(units[units.length - 1].military),
  };
}

function top10(xs) {
  const s = [...xs].sort((a, b) => b - a);
  const k = Math.max(1, Math.round(s.length / 10));
  const tot = s.reduce((a, b) => a + b, 0);
  return tot > 0 ? s.slice(0, k).reduce((a, b) => a + b, 0) / tot : NaN;
}

export function nationShare(w, n) {
  const units = w.periodResults.slice(0, w.P.periods);
  return mean(
    units.map((r) => {
      const tot = r.fortHours.reduce((s, x) => s + x, 0);
      return tot > 0 ? r.fortHours[n] / tot : 0;
    }),
  );
}

/** Defeat probes and every other defeat in the run. */
export function defeats(w, name = 'defeated') {
  const out = [];
  for (const a of cohort(w, name)) {
    const d = a.defeats.find((x) => x.cause === 'forced');
    if (!d) continue;
    out.push({
      lostFrac: d.wealth > 0 ? (d.wealth - (d.after ?? 0)) / d.wealth : NaN,
      toContribH: d.contribT === null ? Infinity : d.contribT - d.t,
      to50H: d.recoveredT === null ? Infinity : d.recoveredT - d.t,
    });
  }
  return out;
}

export function organicDefeats(w) {
  let n = 0;
  for (const a of w.agents) n += a.defeats.filter((d) => d.cause === 'occupied').length;
  return n;
}

export function returners(w) {
  const out = [];
  for (const a of cohort(w, 'returner')) {
    const s0 = a.snapshots.absenceStart;
    const s1 = a.snapshots.absenceEnd;
    if (!s0 || !s1) continue;
    const back = firstAfter(a.contribTimes, a.absence[1]);
    out.push({
      lossFrac: s0.wealth > 0 ? Math.max(0, (s0.wealth - s1.wealth) / s0.wealth) : NaN,
      farmsKept: s0.farms > 0 ? s1.farms / s0.farms : NaN,
      defeatedWhileAway: s1.defeatsDuring > 0 ? 1 : 0,
      toContribH: back === null ? Infinity : back - a.absence[1],
    });
  }
  return out;
}

/** Contribution per day by sessions/day among day-1 humans, relative to always-on AI. */
export function connection(w) {
  const groups = new Map();
  const days = w.horizon / DAY;
  for (const a of w.agents) {
    if (a.cohort !== 'day1' && a.cohort !== 'ai') continue;
    const key = a.kind === 'ai' ? 'ai' : String(a.sessions);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ perDay: a.contribValue / days, raided: a.raidedLoss / days });
  }
  // relative to the most connected humans (12 sessions/day); the AI figure is shown separately
  const ref = mean(groups.get('12')?.map((x) => x.perDay) ?? []);
  const out = {};
  for (const [k, xs] of groups) out[k] = { perDay: mean(xs.map((x) => x.perDay)), rel: mean(xs.map((x) => x.perDay)) / ref, raidedPerDay: mean(xs.map((x) => x.raided)) };
  return out;
}

export function rights(w) {
  const b = w.boundaryRights;
  const sum = (k) => b.reduce((s, r) => s + r[k], 0);
  return {
    boundaries: b.length,
    caravanValue: sum('caravanValue'),
    troopsInFlight: sum('troopsInFlight'),
    fortSupply: sum('fortSupply'),
    garrisons: sum('garrisons'),
    openOps: sum('openOps'),
    voided: sum('voided'),
    returned: sum('returned'),
  };
}

/** Wealth of everything an owner controls at the end of unit k (0-based). */
export function ownerWealth(w, cohortName, k) {
  const r = w.periodResults[k];
  const owners = new Map();
  for (const a of w.agents) {
    if (a.cohort !== cohortName) continue;
    owners.set(a.id, 0);
  }
  for (const a of w.agents) {
    if (owners.has(a.owner)) owners.set(a.owner, owners.get(a.owner) + (r.wealthById[a.id] || 0));
  }
  return [...owners.values()];
}

export function churners(w) {
  return cohort(w, 'churner').map((a) => ({ kits: a.starterKits, protH: a.protectionHours, contrib: a.contribValue, endWealth: a.active ? wealth(w, a) : 0 }));
}

export function fed(w) {
  const a = cohort(w, 'fed')[0];
  const r = w.periodResults[w.P.periods - 1];
  const all = Object.entries(r.wealthById).map(([id, v]) => v);
  const rank = all.filter((v) => v > r.wealthById[a.id]).length + 1;
  return { wealth: r.wealthById[a.id], rank, n: all.length, farms: a.farms };
}
