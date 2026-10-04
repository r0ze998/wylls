// Goal progress (contract §2.2): one pure function per goal, 0..100, computed by CODE from public facts, the
// AI's ledger and its episodes. Goals marked (M) read the ledger or the episodes (memory-based); every
// persona has at least one. Progress is shown on the card and in the MEMORY block; the model picks `goal_id`
// per decision but never sets progress.
//
//   goalProgress(goalKey, input) -> integer 0..100
//   allProgress(persona, input)  -> {G1: n, G2: n, ...}
//
// input = { bellNow, facts, ledger, episodes }   (episodes: an array of episode objects)
// facts (all optional, default 0 / empty; the mind fills them from the situation and its own step log):
//   combat_hosts, marches_today, camps_cleared (total; default: the camp_cleared_own episodes), camps_cleared_today,
//   walls (wall points), home_troops, home_troops_day_start, bells_with_army_home_today, bells_elapsed_today,
//   home_army_bells [bell...] (bells at whose step an own combat army was at home), home_troops_series [[bell, troops]...],
//   builds_today, tier (0 hamlet .. 3 stronghold), buildings, explores_today, neighbour_talks_today,
//   motions_this_period, motion_target_nations [f...], neighbour_tags [tag...],
//   own_marches [{bell, kind: 'camp'|'field'|'village', nation?, ratio?}]
// "No obligation yet" scores 100 for the (M) goals that count obligations met: nothing is outstanding.
const pct = x => Math.max(0, Math.min(100, Math.round(x)));
const ratio = (n, d) => (d > 0 ? pct((100 * n) / d) : 100);
const eps = (episodes, ...kinds) => (episodes ?? []).filter(e => kinds.includes(e.kind) && !e.redacted);
const num = (facts, k) => Number(facts?.[k] ?? 0);

/** success / fail / pending tally -> 0..100 (pending ones are not counted; none counted -> 100). */
const tally = (success, fail) => ratio(success, success + fail);

export const GOALS = {
  // conqueror
  two_armies: ({ facts }) => pct(num(facts, 'combat_hosts') * 50),
  march_daily: ({ facts }) => (num(facts, 'marches_today') >= 1 ? 100 : 0),
  clear_three_camps: ({ facts, episodes }) => pct((100 * (facts?.camps_cleared ?? eps(episodes, 'camp_cleared_own').length)) / 3),
  answer_camp_taken: ({ bellNow, episodes }) => { // (M) a camp another nation cleared first -> clear a camp within 24 bells
    const mine = eps(episodes, 'camp_cleared_own');
    let ok = 0, bad = 0;
    for (const e of eps(episodes, 'camp_taken_by')) {
      if (mine.some(c => c.bell >= e.bell && c.bell <= e.bell + 24)) ok++;
      else if (bellNow > e.bell + 24) bad++;
    }
    return tally(ok, bad);
  },
  // guardian
  walls_600: ({ facts }) => pct(num(facts, 'walls') / 6),
  home_floor_half: ({ facts }) => {
    const h0 = num(facts, 'home_troops_day_start');
    return h0 <= 0 ? 100 : pct((100 * num(facts, 'home_troops')) / (0.5 * h0));
  },
  army_home_every_bell: ({ facts }) => ratio(num(facts, 'bells_with_army_home_today'), num(facts, 'bells_elapsed_today')),
  meet_threats: ({ bellNow, facts, episodes }) => { // (M) a combat army at home when a remembered threat arrives
    const home = new Set(facts?.home_army_bells ?? []);
    let ok = 0, bad = 0;
    for (const e of eps(episodes, 'threat')) {
      const a = e.facts?.arrive_bell;
      if (!Number.isFinite(a) || a >= bellNow) continue; // not arrived yet: pending
      if (home.has(a)) ok++; else bad++;
    }
    return tally(ok, bad);
  },
  // diplomat
  talk_neighbours: ({ facts }) => pct(num(facts, 'neighbour_talks_today') * 50),
  move_option: ({ facts }) => (num(facts, 'motions_this_period') >= 1 ? 100 : 0),
  trust_neighbours: ({ facts, ledger }) => { // (M) trust >= 0 with every neighbour it holds no open grievance against
    const open = new Set((ledger?.grievances ?? []).filter(g => !g.answered).map(g => g.against));
    const tags = facts?.neighbour_tags ?? Object.keys(ledger?.trust?.citizens ?? {});
    const considered = tags.filter(t => !open.has(t));
    const ok = considered.filter(t => { const e = ledger?.trust?.citizens?.[t]; return !e || e.t_code + e.t_model >= 0; }).length;
    return ratio(ok, considered.length);
  },
  build_three: ({ facts }) => pct((100 * num(facts, 'builds_today')) / 3),
  // avenger
  answer_grievances: ({ bellNow, ledger }) => { // (M) every grievance answered by a march that reaches the wrongdoer within 12 bells
    let ok = 0, bad = 0;
    for (const g of ledger?.grievances ?? []) {
      if (g.answered) { if ((g.answered_bell ?? g.bell) - g.bell <= 12) ok++; else bad++; }
      else if (bellNow - g.bell > 12) bad++;
    }
    return tally(ok, bad);
  },
  home_half: ({ facts }) => {
    const h0 = num(facts, 'home_troops_day_start');
    return h0 <= 0 ? 100 : pct((100 * num(facts, 'home_troops')) / (0.5 * h0));
  },
  move_grievance_option: ({ facts, ledger }) => { // (M) a council option aimed at a nation it holds a grievance against
    const nations = new Set((ledger?.grievances ?? []).filter(g => !g.answered && g.nation !== null && g.nation !== undefined).map(g => g.nation));
    if (!nations.size) return 100;
    return (facts?.motion_target_nations ?? []).some(n => nations.has(n)) ? 100 : 0;
  },
  // founder
  tier_up_three_builds: ({ facts }) => pct((Math.min(num(facts, 'tier'), 1) * 50) + (Math.min(num(facts, 'buildings'), 3) / 3) * 50),
  explore_daily: ({ facts }) => (num(facts, 'explores_today') >= 1 ? 100 : 0),
  reach_town: ({ facts }) => (num(facts, 'tier') >= 1 ? 100 : 0),
  recover_from_loss: ({ bellNow, facts, episodes }) => { // (M) home troops back to their earlier level within 24 bells of a loss
    const series = [...(facts?.home_troops_series ?? [])].sort((a, b) => a[0] - b[0]);
    let ok = 0, bad = 0;
    for (const e of eps(episodes, 'attacked_own', 'clash_own_loss')) {
      const before = [...series].reverse().find(([b]) => b < e.bell);
      if (!before) continue;
      if (series.some(([b, t]) => b >= e.bell && b <= e.bell + 24 && t >= before[1])) ok++;
      else if (bellNow > e.bell + 24) bad++;
    }
    return tally(ok, bad);
  },
  // opportunist
  clear_two_camps_daily: ({ facts }) => pct(num(facts, 'camps_cleared_today') * 50),
  strike_the_mover: ({ bellNow, facts, episodes }) => { // (M) a march at an open-field army of nation X within 12 bells of a remembered threat / camp_taken_by naming X
    const marches = (facts?.own_marches ?? []).filter(m => m.kind === 'field');
    let ok = 0, bad = 0;
    for (const e of eps(episodes, 'threat', 'camp_taken_by')) {
      const x = e.facts?.nation;
      if (x === undefined || x === null) continue;
      if (marches.some(m => m.nation === x && m.bell >= e.bell && m.bell <= e.bell + 12)) ok++;
      else if (bellNow > e.bell + 12) bad++;
    }
    return tally(ok, bad);
  },
  raid_weak_stacks: ({ facts }) => ((facts?.own_marches ?? []).some(m => m.kind === 'field' && m.ratio === 'favourable') ? 100 : 0),
};

export function goalProgress(goalKey, input) {
  const f = GOALS[goalKey];
  if (!f) throw new Error(`unknown goal ${goalKey}`);
  return f({ bellNow: 0, facts: {}, ledger: null, episodes: [], ...input });
}
export function allProgress(persona, input) {
  const out = {};
  for (const g of persona.goals) out[g.id] = goalProgress(g.key, input);
  return out;
}

// ---- goals_served (contract 4.3; v1.3 R7: this file is the ONE source) -------------------------------------------------
// Which kinds of candidate action advance which goal, keyed by goal KEY (so a goal that two personas share, "two_armies" or
// "build_three", is defined once). The mind's memory attach reads goalsServed() below and holds no table of its own; the
// test `citizens-ac10a-goals-served` fails if a goal key of the library has no entry here, if an entry names a goal that no
// persona has, or if the attach and this function disagree. The kind is the base kind of a candidate ("march", "build",
// "explore" for "march:camp", "build:wood", "explore:H2"). An empty list means "no action kind advances this goal" (a goal
// that is met by talking, motions or waiting, not by a candidate).
export const GOAL_SERVES = Object.freeze({
  // conqueror
  two_armies: Object.freeze(['train', 'muster']),
  march_daily: Object.freeze(['march']),
  clear_three_camps: Object.freeze(['march']),
  answer_camp_taken: Object.freeze(['march']),
  // guardian
  walls_600: Object.freeze(['walls']),
  home_floor_half: Object.freeze(['hold', 'train']),
  army_home_every_bell: Object.freeze(['hold', 'recall', 'muster']),
  meet_threats: Object.freeze(['recall']),
  // diplomat
  talk_neighbours: Object.freeze([]),
  move_option: Object.freeze([]),
  trust_neighbours: Object.freeze([]),
  build_three: Object.freeze(['build']),
  // avenger
  answer_grievances: Object.freeze(['march']),
  home_half: Object.freeze(['hold', 'recall']),
  move_grievance_option: Object.freeze([]),
  // founder
  tier_up_three_builds: Object.freeze(['build', 'walls']),
  explore_daily: Object.freeze(['explore']),
  reach_town: Object.freeze(['build']),
  recover_from_loss: Object.freeze(['hold', 'train']),
  // opportunist
  clear_two_camps_daily: Object.freeze(['march']),
  strike_the_mover: Object.freeze(['march']),
  raid_weak_stacks: Object.freeze(['march']),
});

/** The base kind of a candidate kind: "march:camp" -> "march". */
export const baseKind = kind => String(kind ?? '').split(':')[0];

/**
 * goalsServed(persona, candidate) -> ["G2", "G3", ...] in goal order: the ids of the persona's goals that this candidate's kind
 * advances. `persona.goals` is [{id, key, ...}] (the dealt persona of deal.mjs `personaOf`); a persona without goals, or a goal
 * without a known key, serves nothing.
 */
export function goalsServed(persona, candidate) {
  const kind = baseKind(candidate?.kind);
  return (persona?.goals ?? []).filter(g => g && Object.hasOwn(GOAL_SERVES, g.key) && GOAL_SERVES[g.key].includes(kind)).map(g => g.id);
}
