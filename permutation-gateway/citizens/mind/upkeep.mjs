// Memory upkeep the mind runs once per decision step (integ-A review; contract 2.1 rule 1, 2.1 model cap, 2.2).
// AC2 built the rules (ledger.advanceDay, ledger.decay, setGoalProgress, goals.allProgress) and unit-tested them; nothing
// called them. This module is the call site, and the producer of the facts the goal functions read.
//
//   createUpkeep({roster, allProgress}) -> {run({own, doc, bell, request}), REQUIRES}
//
// run():
//   1. advanceDay: on the first step of a game day the trust decays toward 0 (by temperament, once per missed day, at most
//      10) and the day's model deltas (`model_today`, the +-15 per handle per game day cap) and counters reset;
//   2. step log: for every step of an AI with a final village the log keeps (bell, an own combat army at home?) and
//      (bell, home troops), kept in the ledger document under `upkeep` (capped); these are the facts a goal like
//      "keep an army at home every bell" or "recover from a loss" reads;
//   3. goal progress: computed BY CODE with goals.allProgress from the facts below, the ledger and the episodes. A goal whose
//      facts have no producer here gets `null` ("not computed"), never a 0 that looks like a measurement.
// Facts come from the brain's situation and own_marches, the AI's own episodes and its own step log. Nothing here reads
// another AI's state. Counts are of STEPS (the bots step at the start of each bell), not of measured seconds.
import { allProgress as defaultAllProgress } from '../persona/goals.mjs';

const DAY_BELLS = 144;
const LOG_CAP = 400;
const TIER = { hamlet: 0, town: 1, city: 2, stronghold: 3 };

/** The fact names each goal function reads, besides the ledger and the episodes. A goal is computed only when all are produced. */
export const REQUIRES = Object.freeze({
  two_armies: ['combat_hosts'],
  march_daily: ['marches_today'],
  clear_three_camps: [],
  answer_camp_taken: [],
  walls_600: ['walls'],
  home_floor_half: ['home_troops', 'home_troops_day_start'],
  army_home_every_bell: ['bells_with_army_home_today', 'bells_elapsed_today'],
  meet_threats: ['home_army_bells'],
  talk_neighbours: ['neighbour_talks_today'],
  move_option: ['motions_this_period'],
  trust_neighbours: [],
  build_three: ['builds_today'],
  answer_grievances: [],
  home_half: ['home_troops', 'home_troops_day_start'],
  move_grievance_option: ['motion_target_nations'],
  tier_up_three_builds: ['tier', 'buildings'],
  explore_daily: ['explores_today'],
  reach_town: ['tier'],
  recover_from_loss: ['home_troops_series'],
  clear_two_camps_daily: ['camps_cleared_today'],
  strike_the_mover: ['own_marches_field'],
  raid_weak_stacks: ['own_marches_field'],
});

const dayOf = (bell) => Math.floor(bell / DAY_BELLS);

/** The facts this module can produce for one step. `log` is the AI's step log (already updated for this step). */
export function factsFor({ me, request, episodes, bell, dayStart, log }) {
  const day = dayOf(bell);
  const hosts = me?.hosts ?? [];
  const home = me?.home ?? {};
  const combat = hosts.filter((h) => h.unit !== 'scout');
  const todayStart = day * DAY_BELLS;
  const camps = (episodes ?? []).filter((e) => e.kind === 'camp_cleared_own' && !e.redacted && e.bell >= todayStart);
  const marches = (request?.own_marches ?? []).filter((m) => Number.isFinite(m.depart_bell) && m.depart_bell >= todayStart);
  const stepsToday = (log?.steps_today ?? 0);
  const facts = {
    combat_hosts: combat.length,
    marches_today: marches.length,
    camps_cleared_today: camps.length,
    walls: Number(home.walls ?? 0),
    home_troops: Number(me?.home_troops ?? 0),
    // the brain's H0 first (the mind rolls its own `day_start` later in the step, so on a day's first step it is yesterday's)
    home_troops_day_start: Number(me?.home_troops_day_start ?? dayStart?.home_troops ?? 0),
    bells_with_army_home_today: log?.home_bells_today ?? 0,
    bells_elapsed_today: stepsToday,
    home_army_bells: log?.home_army_bells ?? [],
    home_troops_series: log?.home_troops_series ?? [],
  };
  if (home.tier in TIER) facts.tier = TIER[home.tier];
  return facts;
}

export function createUpkeep({ roster = null, allProgress = defaultAllProgress, onError = () => {} } = {}) {
  const nationOf = (tag) => roster?.byTag?.(tag)?.faction ?? null;
  const stats = { steps: 0, days: 0, computed: 0, not_computed: 0, errors: 0 };

  function run({ own, doc, bell, request }) {
    try {
      const me = request?.situation?.me;
      const ledger = own?.ledger;
      if (!ledger || !me || !Number.isFinite(bell)) return null;
      const day = dayOf(bell);
      // 1. the day rolls: decay by temperament, reset the day's model deltas and counters
      const t = own.persona?.temperament;
      if (t && Number.isFinite(t.grudge) && ledger.advanceDay) {
        const rolled = ledger.advanceDay(day, { temperament: { grudge: t.grudge, loyalty: t.loyalty ?? 50 }, ownNation: me.faction ?? own.faction, nationOf });
        if (rolled) stats.days++;
      }
      // 2. the step log (only an AI with a final village is playing)
      if (me.home?.final !== true) return null;
      const log = (doc.upkeep ??= { day, steps_today: 0, home_bells_today: 0, home_army_bells: [], home_troops_series: [], last_bell: -1 });
      if (log.day !== day) Object.assign(log, { day, steps_today: 0, home_bells_today: 0 });
      if (bell > log.last_bell) {
        const home = me.home;
        const atHome = (me.hosts ?? []).some((h) => h.unit !== 'scout' && !h.in_transit && h.at?.p === home.p && h.at?.q === home.q);
        log.steps_today += 1;
        if (atHome) {
          log.home_bells_today += 1;
          log.home_army_bells.push(bell);
          if (log.home_army_bells.length > LOG_CAP) log.home_army_bells.splice(0, log.home_army_bells.length - LOG_CAP);
        }
        log.home_troops_series.push([bell, Number(me.home_troops ?? 0)]);
        if (log.home_troops_series.length > LOG_CAP) log.home_troops_series.splice(0, log.home_troops_series.length - LOG_CAP);
        log.last_bell = bell;
      }
      // 3. goal progress
      const persona = own.persona;
      if (persona?.goals?.length && ledger.setGoalProgress) {
        const facts = factsFor({ me, request, episodes: own.episodes?.list?.() ?? [], bell, dayStart: doc.day_start, log });
        const input = { bellNow: bell, facts, ledger: ledger.snapshot(), episodes: own.episodes?.list?.() ?? [] };
        const have = new Set(Object.keys(facts));
        const out = {};
        for (const g of persona.goals) {
          const need = REQUIRES[g.key];
          if (!need || need.some((k) => !have.has(k))) {
            out[g.id] = null;
            stats.not_computed++;
            continue;
          }
          out[g.id] = allProgress({ goals: [g] }, input)[g.id];
          stats.computed++;
        }
        ledger.setGoalProgress(out);
      }
      stats.steps++;
      return true;
    } catch (e) {
      stats.errors++;
      onError(e);
      return null;
    }
  }
  return { run, stats, REQUIRES };
}
