// Wylls A/B prototype: replaying a play log and measuring it.
//
// A log holds the version, the seed, the bots' policies and the player's
// actions round by round. Everything else (the bots' moves, every battle)
// is recomputed here, so a log can be checked: the replay must end in the
// same state hash the game recorded.
(function (root) {
  'use strict';
  const E = root.WyllsEngine || (typeof require !== 'undefined' ? require('./engine.js') : null);
  const B = root.WyllsBots || (typeof require !== 'undefined' ? require('./bots.js') : null);

  const LOG_VERSION = 1;
  const MILITARY = { muster: 1, depart: 1, dissolve: 1, garrison: 1 };
  // A response that moves troops (not training or mustering, which follow
  // income and so differ between versions on their own).
  const MOVE = { depart: 1, dissolve: 1 };
  const PLAYER = 0;

  function stateHash(s) {
    const core = { bell: s.bell, round: s.round, nations: s.nations, hosts: s.hosts, keeps: s.keeps, pending: s.pending };
    return E.h32(JSON.stringify(core)).toString(16).padStart(8, '0');
  }

  function newLog(opts) {
    return {
      app: 'wylls-ab-proto',
      logVersion: LOG_VERSION,
      rulesVersion: E.RULES_VERSION,
      variant: opts.variant,
      seed: String(opts.seed),
      policies: opts.policies,
      rounds: opts.rounds || E.ROUNDS,
      participant: opts.participant || '',
      session: opts.session || {},
      startedAt: opts.startedAt || null,
      endedAt: null,
      turns: [], // [{ round, ms, actions: [{ ms, a, ok, err }] }]
      survey: null,
      hashes: [], // state hash after each round
      result: null,
    };
  }

  // Replay a log. Returns { states, reports, ok, mismatch }.
  // `states[r]` is the state at the start of round r (before anyone acts).
  function replay(log, opts) {
    const keepStates = !opts || opts.keepStates !== false;
    const s = E.newGame({ variant: log.variant, seed: log.seed, policies: log.policies });
    const states = [];
    const reports = [];
    const results = [];
    let mismatch = null;
    for (const t of log.turns) {
      if (s.over) break;
      if (keepStates) states.push(E.clone(s));
      const bots = B.decideAll(s);
      const res = [];
      for (const x of t.actions) {
        const r = E.apply(s, PLAYER, x.a);
        res.push(r.ok);
        if (r.ok !== x.ok && !mismatch) mismatch = { round: t.round, action: x.a, logged: x.ok, replayed: r.ok };
      }
      results.push(res);
      reports.push(E.advance(s, bots));
      const h = stateHash(s);
      if (log.hashes[t.round] && log.hashes[t.round] !== h && !mismatch) mismatch = { round: t.round, hash: h, logged: log.hashes[t.round] };
    }
    if (keepStates) states.push(E.clone(s));
    return { states, reports, final: s, ok: !mismatch, mismatch, results };
  }

  // What an opponent did that the round report showed the player.
  // `threat`: aimed at the player's own places — an enemy started taking
  // one of the player's keeps, took one, or arrived at a place the player
  // held (a keep or the village). `departed`: any enemy departure (the
  // first draft's trigger; kept as a secondary measure, see
  // docs/01-HYPOTHESES.ja.md, change log).
  function triggers(report) {
    const threat = [];
    let departed = false;
    for (const e of report.events) {
      if (e.t === 'departed' && e.owner !== PLAYER) departed = true;
      if (e.t === 'contest' && e.holder === PLAYER && e.contender !== PLAYER) threat.push('contest_on_mine');
      if (e.t === 'captured' && e.from === PLAYER) threat.push('keep_lost');
      if (e.t === 'arrived' && e.owner !== PLAYER && e.destHolder === PLAYER) threat.push('arrived_at_mine');
    }
    return { threat, departed };
  }

  function median(xs) {
    if (!xs.length) return 0;
    const v = xs.slice().sort((a, b) => a - b);
    const m = Math.floor(v.length / 2);
    return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
  }

  // The measures named in docs/01-HYPOTHESES.ja.md, from a log and its replay.
  function measure(log, rep) {
    const r = rep || replay(log, { keepStates: false });
    const byType = {};
    let failed = 0;
    let idle = 0;
    let military = 0;
    let moveRounds = 0;
    let threatRounds = 0; let threatMoves = 0;
    let otherRounds = 0; let otherMoves = 0;
    let departRounds = 0; let departMoves = 0;
    let quietRounds = 0; let quietMoves = 0;
    const plan = [];
    log.turns.forEach((t, i) => {
      const okActs = t.actions.filter(x => x.ok);
      failed += t.actions.length - okActs.length;
      for (const x of okActs) byType[x.a.type] = (byType[x.a.type] || 0) + 1;
      if (okActs.length === 0) idle += 1;
      if (okActs.some(x => MILITARY[x.a.type])) military += 1;
      const move = okActs.some(x => MOVE[x.a.type]);
      if (move) moveRounds += 1;
      if (i === 0) return; // nothing was reported before the first round
      const tr = triggers(r.reports[i - 1]);
      if (tr.threat.length) { threatRounds += 1; if (move) threatMoves += 1; } else { otherRounds += 1; if (move) otherMoves += 1; }
      if (tr.departed) { departRounds += 1; if (move) departMoves += 1; } else { quietRounds += 1; if (move) quietMoves += 1; }
      if (typeof t.ms === 'number') plan.push(t.ms);
    });
    if (log.turns.length && typeof log.turns[0].ms === 'number') plan.unshift(log.turns[0].ms);
    const rate = (a, b) => (b ? a / b : null);
    const s = r.final;
    const me = s.nations[PLAYER];
    let battles = 0;
    for (const rp of r.reports) for (const c of rp.clashes) if (c.start[PLAYER] != null) battles += 1;
    return {
      variant: log.variant,
      seed: log.seed,
      participant: log.participant,
      rounds: log.turns.length,
      finished: !!s.over,
      replayOk: r.ok,
      actions: Object.values(byType).reduce((a, b) => a + b, 0),
      byType,
      failedActions: failed,
      idleRounds: idle,
      militaryRounds: military,
      moveRounds,
      // Primary reaction measure: how much more often the player moved
      // troops right after a threat to their own places than otherwise.
      threatRounds,
      threatMoveRate: rate(threatMoves, threatRounds),
      otherMoveRate: rate(otherMoves, otherRounds),
      reactionLift: threatRounds && otherRounds ? threatMoves / threatRounds - otherMoves / otherRounds : null,
      // Secondary (first draft): after any enemy departure vs. not.
      departRounds,
      departMoveRate: rate(departMoves, departRounds),
      quietMoveRate: rate(quietMoves, quietRounds),
      marches: me.stats.marches,
      battles,
      captures: me.stats.captures,
      keepsLost: me.stats.lost,
      finalKeeps: E.keepsHeld(s, PLAYER),
      won: !!(s.winner && s.winner.nations.includes(PLAYER)),
      planMsTotal: plan.reduce((a, b) => a + b, 0),
      planMsMedian: median(plan),
    };
  }

  // One CSV row per log, in the column order of sheets/measures.csv.
  const CSV_COLUMNS = ['participant', 'game', 'label', 'variant', 'seed', 'rounds', 'finished', 'replayOk', 'actions', 'failedActions',
    'idleRounds', 'militaryRounds', 'moveRounds', 'threatRounds', 'threatMoveRate', 'otherMoveRate', 'reactionLift',
    'departRounds', 'departMoveRate', 'quietMoveRate', 'marches', 'battles', 'captures', 'keepsLost', 'finalKeeps', 'won',
    'planMinutes', 'planSecMedian'];
  const fix = x => (x == null ? '' : x.toFixed(3));
  function csvRow(log, m) {
    const v = Object.assign({}, m, {
      threatMoveRate: fix(m.threatMoveRate), otherMoveRate: fix(m.otherMoveRate), reactionLift: fix(m.reactionLift),
      departMoveRate: fix(m.departMoveRate), quietMoveRate: fix(m.quietMoveRate),
      game: (log.session && log.session.game) || '',
      label: (log.session && log.session.label) || '',
      planMinutes: (m.planMsTotal / 60000).toFixed(1),
      planSecMedian: (m.planMsMedian / 1000).toFixed(1),
    });
    return CSV_COLUMNS.map(c => {
      const x = v[c] == null ? '' : String(v[c]);
      return /[",\n]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x;
    }).join(',');
  }

  const api = { LOG_VERSION, stateHash, newLog, replay, measure, triggers, MILITARY, MOVE, CSV_COLUMNS, csvRow };
  root.WyllsMetrics = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
