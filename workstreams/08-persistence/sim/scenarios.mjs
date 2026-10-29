// Populations. Every scenario contains the same probe cohorts so the
// proposals can be compared on the same people:
//   day1      – joins at hour 0, sessions/day from params.sessionLadder
//   ai        – always-on agents
//   mid       – joins on day 5 of the second competitive unit
//   late      – joins on day 12 of the second unit (after the code's join close)
//   returner  – a day-1 player away for 10 days from day 2 of the second unit
//   defeated  – a day-1 player whose village is defeated on day 4 of the second unit
// Exploit scenarios add flagged agents on top.

const DAY = 24;

function base(P, opts = {}) {
  const specs = [];
  const U = P.periodDays * DAY; // the second unit starts at U
  for (let n = 0; n < P.nations; n++) {
    const humans = opts.humans?.[n] ?? P.sessionLadder;
    for (const s of humans) specs.push({ nation: n, kind: 'human', cohort: 'day1', joinT: 0, sessionsPerDay: s });
    const ais = opts.ais?.[n] ?? P.aiPerNation;
    for (let i = 0; i < ais; i++) specs.push({ nation: n, kind: 'ai', cohort: 'ai', joinT: 0 });
    specs.push({ nation: n, kind: 'human', cohort: 'mid', joinT: U + 5 * DAY, sessionsPerDay: 2 });
    specs.push({ nation: n, kind: 'human', cohort: 'late', joinT: U + 12 * DAY, sessionsPerDay: 2 });
    specs.push({ nation: n, kind: 'human', cohort: 'returner', joinT: 0, sessionsPerDay: 2, absence: [U + 2 * DAY, U + 12 * DAY] });
    specs.push({ nation: n, kind: 'human', cohort: 'defeated', joinT: 0, sessionsPerDay: 2, forcedDefeatT: U + 4 * DAY, behaviour: 'coop' });
  }
  return specs;
}

const LADDER_SMALL = [1, 2, 3];

function withAlts(P, stash) {
  const specs = base(P);
  const U = P.periodDays * DAY;
  for (let m = 0; m < 2; m++) {
    const mainIdx = specs.length;
    specs.push({ nation: 0, kind: 'human', cohort: 'abuser', joinT: 0, sessionsPerDay: 4, behaviour: 'coop', flags: stash ? { altMain: true } : {} });
    for (let k = 0; k < 3; k++) {
      specs.push({ nation: 0, kind: 'human', cohort: 'alt', joinT: U + k * 3 * DAY, sessionsPerDay: 4, behaviour: 'turtle', owner: mainIdx, flags: { alt: true } });
    }
  }
  return specs;
}

export const SCENARIOS = {
  standard: {
    id: 'standard',
    label: '標準（6国×人8・AI2）',
    populate: (P) => base(P),
  },
  small_nation: {
    id: 'small_nation',
    label: '少人数の国（国5は人3）',
    focusNation: 5,
    populate: (P) => base(P, { humans: { 5: LADDER_SMALL } }),
  },
  ai_heavy: {
    id: 'ai_heavy',
    label: '常時稼働AIが多い国（国5は人2・AI8）',
    focusNation: 5,
    populate: (P) => base(P, { humans: { 5: [2, 4] }, ais: { 5: 8 } }),
  },
  dominant: {
    id: 'dominant',
    label: '先行して強い国（国0は人+4・初期物資2倍）',
    focusNation: 0,
    populate: (P) => {
      const specs = base(P);
      for (let i = 0; i < 4; i++) specs.push({ nation: 0, kind: 'human', cohort: 'day1', joinT: 0, sessionsPerDay: 4 });
      for (const s of specs) if (s.nation === 0 && s.joinT === 0) s.starterMult = 2;
      return specs;
    },
  },
  // ---- exploits
  alts: {
    id: 'alts',
    label: '複数アカウントで保護を使う（国0の2人が、保護中の自分の別村3つへ物資を退避）',
    populate: (P) => withAlts(P, true),
  },
  alts_control: {
    id: 'alts_control',
    label: '対照：同じ別村を持つが、退避はしない',
    populate: (P) => withAlts(P, false),
  },
  alts_none: {
    id: 'alts_none',
    label: '対照：同じ2人が別村を持たない',
    populate: (P) => {
      const specs = base(P);
      for (let m = 0; m < 2; m++) specs.push({ nation: 0, kind: 'human', cohort: 'abuser', joinT: 0, sessionsPerDay: 4, behaviour: 'coop' });
      return specs;
    },
  },
  churn: {
    id: 'churn',
    label: '退出と再参加の繰り返し（各国1人）',
    populate: (P) => {
      const specs = base(P);
      for (let n = 0; n < P.nations; n++) specs.push({ nation: n, kind: 'human', cohort: 'churner', joinT: 0, sessionsPerDay: 3, behaviour: 'raider', flags: { churn: true } });
      return specs;
    },
  },
  churn_control: {
    id: 'churn_control',
    label: '対照：同じ人が繰り返さない',
    populate: (P) => {
      const specs = base(P);
      for (let n = 0; n < P.nations; n++) specs.push({ nation: n, kind: 'human', cohort: 'churner', joinT: 0, sessionsPerDay: 3, behaviour: 'raider' });
      return specs;
    },
  },
  kingmaker: {
    id: 'kingmaker',
    label: '意図的な資源移転（国5の全員が区切り前48hに首位国へ送る）',
    populate: (P) => {
      const specs = base(P);
      for (const s of specs) if (s.nation === 5) s.flags = { ...(s.flags || {}), kingmaker: true };
      return specs;
    },
  },
  feeder: {
    id: 'feeder',
    label: '意図的な資源移転（国1のAI6体が1人の村へ貢ぐ）',
    focusNation: 1,
    populate: (P) => {
      const specs = base(P);
      const main = specs.findIndex((s) => s.nation === 1 && s.kind === 'human' && s.cohort === 'day1');
      specs[main].cohort = 'fed';
      for (let i = 0; i < 6; i++) specs.push({ nation: 1, kind: 'ai', cohort: 'feeder', joinT: 0, behaviour: 'turtle', flags: { feeder: { to: main } } });
      return specs;
    },
  },
  feeder_control: {
    id: 'feeder_control',
    label: '対照：同じAI6体が普通に遊ぶ',
    focusNation: 1,
    populate: (P) => {
      const specs = base(P);
      const main = specs.findIndex((s) => s.nation === 1 && s.kind === 'human' && s.cohort === 'day1');
      specs[main].cohort = 'fed';
      for (let i = 0; i < 6; i++) specs.push({ nation: 1, kind: 'ai', cohort: 'feeder', joinT: 0, behaviour: 'turtle' });
      return specs;
    },
  },
};
