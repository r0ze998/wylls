// Wake events and the delta gate (contract sections 3.2 and 3.3). Pure decision logic plus the little
// state it needs (last session bell per AI, reactions already granted in a bell). Budgets live in the
// AI's ledger counters (section 5.1: counters {day, sessions, reactions, messages, marches}).
// No clock, no network: the caller passes the bell and the wake codes it collected.

export const DEFAULT_GATE = {
  weights: { 'W-PULSE': 3, 'W-CLASH': 4, 'W-THREAT': 2, 'W-READY': 1, 'W-QUEUE': 1, 'W-DM': 2, 'W-HALL': 1, 'W-CALL': 3 },
  threat_big_bonus: 1,
  pulse: 24,
  threshold: 3,
  strong: 6,
  min_gap: 2,
  social_cap: 2,
};
export const DEFAULT_BUDGETS = { sessions: 8, reactions: 6, reflection: 2, reactions_per_bell_global: 4 };
export const DAY_BELLS = 144;

const SOCIAL = ['W-DM', 'W-HALL'];
const REACTION_WAKES = ['W-DM', 'W-HALL', 'W-CALL'];

/** Roll the per-day counters when the game day changes (day = floor(bell / 144)). Mutates and returns the counters. */
export function rollCounters(counters, bell) {
  const day = Math.floor(bell / DAY_BELLS);
  if (counters.day !== day) {
    counters.day = day;
    counters.sessions = 0;
    counters.reactions = 0;
    counters.messages = 0;
    counters.marches = 0;
    counters.reflections = 0;
    counters.motions = 0;
  }
  for (const k of ['sessions', 'reactions', 'messages', 'marches', 'reflections', 'motions']) counters[k] ??= 0;
  return counters;
}

/** Normalise the wake list the watcher/social/brain delivered: strings or {code, big}. */
export function normaliseWakes(list) {
  const out = new Map();
  for (const w of list ?? []) {
    const code = typeof w === 'string' ? w : w?.code;
    if (typeof code !== 'string') continue;
    const prev = out.get(code) ?? { code, big: false };
    if (w && typeof w === 'object' && w.big) prev.big = true;
    out.set(code, prev);
  }
  return [...out.values()];
}

export function createGate({ gate = {}, budgets = {}, endBellGuard = 2 } = {}) {
  const cfg = { ...DEFAULT_GATE, ...gate, weights: { ...DEFAULT_GATE.weights, ...(gate.weights ?? {}) } };
  const bud = { ...DEFAULT_BUDGETS, ...budgets };
  const lastSession = new Map(); // tag -> bell of the last session
  const reactionsInBell = new Map(); // bell -> n granted across all AIs

  function score(wakes) {
    let s = 0;
    let social = 0;
    for (const w of wakes) {
      let weight = cfg.weights[w.code] ?? 0;
      if (w.code === 'W-THREAT' && w.big) weight += cfg.threat_big_bonus;
      if (SOCIAL.includes(w.code)) social += weight;
      else s += weight;
    }
    return s + Math.min(cfg.social_cap, social);
  }

  /**
   * One gate decision for one AI at one bell.
   * input: {tag, bell, endBell, ready: boolean (roster dealt and a final village), wakes: [...], counters}
   * returns {mode: 'session'|'reaction'|'autopilot', reason, score, wake: [codes]}
   * reason for autopilot: season_end | not_ready | below_gate | budget. The caller records the decision
   * (noteSession / noteReaction) only when it actually attempts the model.
   */
  function decide({ tag, bell, endBell, ready, wakes, counters }) {
    rollCounters(counters, bell);
    const all = [...normaliseWakes(wakes)];
    const last = lastSession.has(tag) ? lastSession.get(tag) : bell - cfg.pulse;
    if (bell - last >= cfg.pulse && !all.some((w) => w.code === 'W-PULSE')) all.push({ code: 'W-PULSE', big: false });
    const codes = all.map((w) => w.code);
    const s = score(all);
    if (Number.isFinite(endBell) && bell >= endBell - endBellGuard) return { mode: 'autopilot', reason: 'season_end', score: s, wake: codes };
    if (!ready) return { mode: 'autopilot', reason: 'not_ready', score: s, wake: codes };
    const sessionsLeft = bud.sessions - counters.sessions;
    if (s >= cfg.threshold && sessionsLeft > 0 && (bell - last >= cfg.min_gap || s >= cfg.strong)) {
      return { mode: 'session', reason: 'ok', score: s, wake: codes };
    }
    const reactionWake = codes.some((c) => REACTION_WAKES.includes(c));
    if (reactionWake) {
      const left = bud.reactions - counters.reactions;
      const bellCount = reactionsInBell.get(bell) ?? 0;
      if (left > 0 && bellCount < bud.reactions_per_bell_global) return { mode: 'reaction', reason: 'ok', score: s, wake: codes };
      return { mode: 'autopilot', reason: 'budget', score: s, wake: codes };
    }
    if (s >= cfg.threshold && sessionsLeft <= 0) return { mode: 'autopilot', reason: 'budget', score: s, wake: codes };
    return { mode: 'autopilot', reason: 'below_gate', score: s, wake: codes };
  }

  return {
    config: cfg,
    budgets: bud,
    decide,
    score,
    noteSession(tag, bell, counters) {
      lastSession.set(tag, bell);
      counters.sessions += 1;
    },
    noteReaction(bell, counters) {
      counters.reactions += 1;
      reactionsInBell.set(bell, (reactionsInBell.get(bell) ?? 0) + 1);
      for (const b of reactionsInBell.keys()) if (b < bell - 3) reactionsInBell.delete(b);
    },
    lastSessionBell: (tag) => lastSession.get(tag) ?? null,
    /** restart support: the mind restores `last` from its records */
    restore(tag, bell) {
      lastSession.set(tag, bell);
    },
  };
}
