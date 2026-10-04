// The run report (contract section 10.1; unit AC9): every metric of the report, from PUB, the mind's /v1/metrics snapshot,
// the brain's counters and RUNS.md. Offline and read-only: it reads files (or one GET of /v1/metrics when --mind is given)
// and writes only the report. Local test chain only.
//
//   node citizens/report.mjs --ai-dir .local/frontier/ai/<run id> [--runs docs/frontier/ai-citizens/RUNS.md]
//        [--metrics FILE|http://127.0.0.1:41980 --token-file F] [--public-only] [--out report.json] [--md report.md]
//
// What it reads, in order of authority:
//   PUB      minds/<bell>.json (+ minds/late), open/<bell>.json (the release job's opened records), memory/<tag>/episodes.json,
//            roster.json, commitments.json, anchors/commit.json, council/*.json, talk/*.json, metrics/latest.json
//   STATE    records.jsonl (the mind's private journal: the choice and the candidates of a SEALED decision, its host ids).
//            Operator side only; every number that needs it says so ("private") and `--public-only` turns it off.
//   FLEET    fleet/ai-brain.json (steps, answers by mode, GET counters when the brain wrote them), census/summary.json
//   RUNS.md  every run, aborted ones included
//
// Y (contract 10.1, G12) = the number of model marches whose decision record was OPENED (section 7.2) and which produced a
// CLASH. `y_strict` is that. `y_clash_without_opening` is a different, labelled number: model marches whose army has a public
// clash_own_* episode (created only when an own army fought, contract 5.2) but whose record was never opened: it is what a
// run reads before the release job (wave B) exists, and it is NOT Y. Neither is ever rounded up.
//
// A reflection that the validator refused is the validator working, not a failed choice: reflections are listed on their own
// line and are not in the valid-choice rate (integ-A-NOTES section 14 asked this unit to filter them).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const readJson = (f, fallback = null) => {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; }
};
const listDir = (d) => { try { return fs.readdirSync(d); } catch { return []; } };
const num = (x) => (Number.isFinite(x) ? x : null);
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const pct = (k, n) => (n > 0 ? Math.round((1000 * k) / n) / 10 : null);

/** Wilson score interval (95 %), in percent. */
export function wilson(k, n, z = 1.96) {
  if (!n) return null;
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.round(1000 * Math.max(0, c - h)) / 10, Math.round(1000 * Math.min(1, c + h)) / 10];
}

export const KEY_KINDS = ['attacked_own', 'camp_taken_by', 'threat'];
export const GATE_CLOSED = new Set(['below_gate', 'budget', 'season_end', 'not_ready']);
export const MODEL_KINDS = new Set(['session', 'reaction', 'motion', 'ballot']);
export const FALLBACK_REASONS = (r) => r.startsWith('invalid:') || ['timeout', 'llm_error', 'late', 'v6_all_refused'].includes(r);
/** Intents the autopilot's economy produces (contract 3.6 "kept"); a duty is anything that is neither economy nor a march. */
export const ECONOMY_INTENTS = new Set(['harvest', 'build', 'train', 'muster', 'explore', 'walls', 'tier_up', 'tierup']);
export const MARCH_INTENTS = new Set(['depart', 'march', 'recall']);

// ---------------------------------------------------------------- RUNS.md
/** Every run of RUNS.md: the RUN and END lines (JSON), nothing else. */
export function parseRuns(text) {
  const runs = new Map();
  const order = [];
  for (const line of String(text ?? '').split('\n')) {
    const m = /^(RUN|END) (\{.*\})\s*$/.exec(line);
    if (!m) continue;
    let j;
    try { j = JSON.parse(m[2]); } catch { continue; }
    if (!j.run_id) continue;
    if (!runs.has(j.run_id)) { runs.set(j.run_id, { run_id: j.run_id }); order.push(j.run_id); }
    const r = runs.get(j.run_id);
    if (m[1] === 'RUN') Object.assign(r, { start_unix: j.start_unix ?? null, arm: j.arm ?? null, rep: j.rep ?? null, commitments_sha256: j.commitments_sha256 ?? null, configs: j.configs ?? null });
    else Object.assign(r, { end_unix: j.end_unix ?? null, status: j.status ?? null, detail: j.detail ?? null });
  }
  return order.map((id) => {
    const r = runs.get(id);
    return { status: 'no END line: aborted or still running', ...r, status_source: r.end_unix ? 'END line' : 'none' };
  });
}

// ---------------------------------------------------------------- loading a run
export function loadRun(aiDir, { privateOk = true } = {}) {
  const pub = path.join(aiDir, 'pub');
  const state = path.join(aiDir, 'state');
  const run = { aiDir, pub, state, bells: [], records: [], opened: new Map(), episodes: new Map(), episodesByTag: new Map(), roster: readJson(path.join(pub, 'roster.json')), commitments: readJson(path.join(pub, 'commitments.json')), private: false };
  const mindFiles = listDir(path.join(pub, 'minds')).map((f) => /^(\d+)\.json$/.exec(f)).filter(Boolean).map((m) => Number(m[1])).sort((a, b) => a - b);
  const byId = new Map();
  for (const b of mindFiles) {
    const j = readJson(path.join(pub, 'minds', `${b}.json`));
    if (!j?.records) continue;
    run.bells.push(b);
    for (const r of j.records) { byId.set(r.id, { ...r, tx: [...(r.tx ?? [])], from_file_bell: b }); }
  }
  for (const f of listDir(path.join(pub, 'minds/late'))) {
    const j = readJson(path.join(pub, 'minds/late', f));
    for (const e of j?.entries ?? []) {
      if (e.record && !byId.has(e.record.id)) { byId.set(e.record.id, { ...e.record, tx: [...(e.record.tx ?? [])], late_add: true }); continue; }
      const r = byId.get(e.id ?? e.record?.id);
      if (r) for (const t of e.tx ?? []) if (!r.tx.some((x) => x.sig && x.sig === t.sig)) r.tx.push(t);
    }
  }
  for (const f of listDir(path.join(pub, 'open'))) {
    const j = readJson(path.join(pub, 'open', f));
    for (const o of j?.records ?? j?.opened ?? []) run.opened.set(o.id, { ...o, opened_in_file: f });
  }
  if (privateOk && fs.existsSync(path.join(state, 'records.jsonl'))) {
    run.private = true;
    const priv = new Map();
    for (const l of fs.readFileSync(path.join(state, 'records.jsonl'), 'utf8').split('\n')) {
      if (!l.trim()) continue;
      let j;
      try { j = JSON.parse(l); } catch { continue; }
      if (j.op === 'add') priv.set(j.entry.id, { full: j.entry.full, priv: j.entry.priv, opened: false });
      else if (j.op === 'opened' && priv.has(j.id)) priv.get(j.id).opened = true;
    }
    run.privateById = priv;
  }
  // roster: tag -> {index, faction, persona}
  run.aiByTag = new Map((run.roster?.ai ?? []).map((a) => [a.tag, a]));
  for (const d of listDir(path.join(pub, 'memory'))) {
    const j = readJson(path.join(pub, 'memory', d, 'episodes.json'));
    if (!j?.episodes) continue;
    run.episodesByTag.set(j.tag ?? d, j.episodes);
    for (const e of j.episodes) run.episodes.set(`${j.tag ?? d}:${e.id}`, e);
  }
  // one view per record
  for (const r of byId.values()) run.records.push(decisionView(run, r));
  run.records.sort((a, b) => a.bell - b.bell || a.index - b.index);
  return run;
}

/** One record with the best-known choice: the opened record, else the private one (labelled), else the public form. */
function decisionView(run, r) {
  const opened = run.opened.get(r.id) ?? null;
  const priv = run.privateById?.get(r.id) ?? null;
  let choice = null;
  let retrieved = null;
  let candidates = null;
  let choiceSource = null;
  if (!r.sealed && r.choice) { choice = r.choice; retrieved = r.retrieved ?? null; choiceSource = 'public'; }
  if (opened?.choice) { choice = opened.choice; retrieved = opened.retrieved ?? retrieved; candidates = opened.candidates ?? null; choiceSource = 'opened'; }
  else if (priv?.full?.choice) { choice = priv.full.choice; retrieved = priv.full.retrieved ?? retrieved; candidates = priv.priv?.candidates ?? null; choiceSource ??= 'private'; if (r.sealed) choiceSource = 'private'; }
  const ai = run.aiByTag.get(r.ai) ?? null;
  return {
    id: r.id, bell: r.bell, index: r.index ?? ai?.index ?? null, tag: r.ai, persona: ai?.persona ?? null, kind: r.kind, mode: r.mode, reason: r.reason, sealed: Boolean(r.sealed),
    release_bell: r.release_bell ?? null, wake: r.wake ?? [], tx: r.tx ?? [], latency_ms: r.latency_ms ?? null, slack_ms: r.deadline_slack_ms ?? null, attempts: r.attempts ?? null,
    public: r.public ?? null, choice, retrieved, candidates, choice_source: choiceSource, opened: Boolean(opened), opened_in: opened?.opened_in_file ?? null,
    destinations: opened?.destinations ?? null, intended: priv?.priv?.intended ?? null, late_add: Boolean(r.late_add),
  };
}

// ---------------------------------------------------------------- the sections
const sentTx = (d) => d.tx.filter((t) => t.status === 'sent');
const isHoldOrAutopilot = (d) => {
  const ids = d.choice?.ids;
  if (!ids?.length) return false;
  const kindOf = (id) => d.candidates?.find((c) => c.id === id)?.kind ?? (id === 'c1' ? 'autopilot' : id === 'c2' ? 'hold' : null);
  return ids.every((id) => ['autopilot', 'hold'].includes(String(kindOf(id)).split(':')[0]));
};

export function decisionsSection(run, metrics) {
  const recs = run.records;
  const by = (f) => recs.reduce((m, r) => { const k = f(r); m[k] = (m[k] ?? 0) + 1; return m; }, {});
  const reflections = recs.filter((r) => r.kind === 'reflection');
  const modelDecisions = recs.filter((r) => MODEL_KINDS.has(r.kind) && r.reason !== 'no_time');
  const valid = [];
  const fallback = [];
  const v6 = [];
  for (const r of modelDecisions) {
    if (r.mode === 'model') {
      // a session needs >= 1 chosen game action (or hold / autopilot) that survived V6: a sent tx, or a hold / autopilot choice
      if (r.kind === 'session' && !isHoldOrAutopilot(r) && sentTx(r).length === 0) v6.push(r);
      else valid.push(r);
    } else if (FALLBACK_REASONS(r.reason)) fallback.push(r);
  }
  const fallbackAll = [...fallback, ...v6];
  const gateOpen = recs.filter((r) => r.kind !== 'reflection' && !GATE_CLOSED.has(r.reason));
  const noTime = recs.filter((r) => r.reason === 'no_time');
  const feedLag = recs.filter((r) => r.reason === 'feed_lag');
  const n = modelDecisions.length;
  const lat = metrics?.latency ?? {};
  const slackNeg = sum(Object.values(lat).map((x) => x.slack_negative ?? 0));
  const latN = sum(Object.values(lat).map((x) => x.n ?? 0));
  return {
    records: recs.length,
    by_kind: by((r) => r.kind), by_mode: by((r) => r.mode), by_reason: by((r) => r.reason),
    gate_open: gateOpen.length,
    model_decisions: n,
    valid_choices: valid.length,
    valid_rate_pct: pct(valid.length, n),
    valid_rate_ci95_pct: wilson(valid.length, n),
    g1_threshold: { pct: 95, min_n: 300, met: n >= 300 && valid.length / n >= 0.95, underpowered: n < 300, note: n < 300 ? `n = ${n} < 300: underpowered; the interval above is the only honest statement` : null },
    fallbacks: { total: fallbackAll.length, rate_pct: pct(fallbackAll.length, n), by_reason: fallbackAll.reduce((m, r) => { const k = r.mode === 'model' ? 'v6_all_refused' : r.reason; m[k] = (m[k] ?? 0) + 1; return m; }, {}), g2_max_pct: 5 },
    dropped_for_time: { n: noTime.length, share_of_gate_open_pct: pct(noTime.length, gateOpen.length), g2_max_pct: 3 },
    feed_lag: { n: feedLag.length, share_of_gate_open_pct: pct(feedLag.length, gateOpen.length), note: feedLag.length ? 'the gate opened a session and the mind refused it because the feed had not yet vouched for bell - 1; these steps ran the autopilot' : null },
    reflections: { n: reflections.length, ok: reflections.filter((r) => r.mode === 'model').length, refused_or_failed: reflections.filter((r) => r.mode !== 'model').length, by_reason: reflections.reduce((m, r) => { m[r.reason] = (m[r.reason] ?? 0) + 1; return m; }, {}), note: 'listed on their own; not in the valid-choice rate' },
    latency_ms_by_kind: lat,
    g3: { latency_samples: latN, slack_negative: slackNeg, share_with_slack_ge_0_pct: latN ? pct(latN - slackNeg, latN) : null, note: 'from the mind\'s own latency windows (llama call time and slack to the deadline); "0 decisions executed after bell_start(b+1)" needs the chain and is not read here' },
  };
}

export function byModelSection(run, metrics) {
  const groups = metrics?.groups ?? {};
  const perAi = [];
  let sm = 0, sa = 0;
  for (const [tag, a] of run.aiByTag) {
    const g = groups[`ai:${tag}`] ?? {};
    const m = g.actions_by_model ?? 0;
    const au = g.actions_by_autopilot ?? 0;
    sm += m; sa += au;
    perAi.push({ index: a.index, tag, persona: a.persona, actions_by_model: m, actions_by_autopilot: au, by_model_share_pct: pct(m, m + au), decisions: g.decisions ?? 0, valid: g.valid ?? 0, model_marches: g.model_marches ?? 0, decisions_citing_memory: g.decisions_citing_memory ?? 0, messages: g.messages ?? 0 });
  }
  // the same, read from the records' tx (every sent action of a record of that mode)
  const rm = sum(run.records.filter((r) => r.mode === 'model').map((r) => sentTx(r).length));
  const ra = sum(run.records.filter((r) => r.mode !== 'model').map((r) => sentTx(r).length));
  const intents = {};
  for (const r of run.records) for (const t of sentTx(r)) { const k = `${r.mode === 'model' ? 'model' : 'autopilot'}:${t.intent}`; intents[k] = (intents[k] ?? 0) + 1; }
  const econ = sum(run.records.filter((r) => r.mode !== 'model').map((r) => sentTx(r).filter((t) => ECONOMY_INTENTS.has(t.intent)).length));
  return {
    per_ai: perAi,
    total: { actions_by_model: sm, actions_by_autopilot: sa, by_model_share_pct: pct(sm, sm + sa), source: 'the mind\'s counters (the Wyll card stats): every action sent in a step whose decision had mode "model"' },
    from_records_tx: { actions_in_model_records: rm, actions_in_autopilot_records: ra, by_model_share_pct: pct(rm, rm + ra), intents_by_mode: intents },
    autopilot_economy_share: { economy_actions_in_autopilot_records: econ, all_actions: rm + ra, share_pct: pct(econ, rm + ra), g2_note: 'reported next to the fallback rate', economy_intents: [...ECONOMY_INTENTS] },
    caveat: 'an action in a model-mode step may be a duty or an autopilot economy action the brain sent in the same step: the by:model share is an upper bound on model-chosen actions. model_marches below is the exact count of marches.',
  };
}

/** Host ids of a model march: the opened record's destinations, else the private record's chosen march candidates. */
function hostIdsOf(d) {
  const ids = new Set();
  for (const x of d.destinations ?? []) if (x.host_id != null) ids.add(String(x.host_id));
  if (!ids.size && d.choice?.ids && d.candidates) {
    for (const id of d.choice.ids) {
      const c = d.candidates.find((x) => x.id === id);
      if (c && String(c.kind).split(':')[0] === 'march' && c.facts?.host_id != null) ids.add(String(c.facts.host_id));
    }
  }
  if (!ids.size) for (const e of d.intended ?? []) if (e.host_id != null) ids.add(String(e.host_id));
  return [...ids];
}

export function marchesSection(run) {
  const marches = [];
  for (const d of run.records) {
    if (d.mode !== 'model') continue;
    const departs = sentTx(d).filter((t) => MARCH_INTENTS.has(t.intent));
    if (!departs.length) continue;
    const hosts = hostIdsOf(d);
    const clashes = [];
    for (const e of run.episodesByTag.get(d.tag) ?? []) {
      if (!['clash_own_win', 'clash_own_loss'].includes(e.kind)) continue;
      const h = (e.src ?? []).filter((s) => s.startsWith('host:')).map((s) => s.slice(5));
      if (h.some((x) => hosts.includes(x))) clashes.push({ episode: e.id, kind: e.kind, bell: e.bell, created_bell: e.created_bell, host: h.find((x) => hosts.includes(x)), camp: e.facts?.camp ?? null, lost_own: e.facts?.lost_own ?? null, lost_enemy: e.facts?.lost_enemy ?? null });
    }
    marches.push({ record: d.id, bell: d.bell, index: d.index, tag: d.tag, persona: d.persona, departs: departs.length, release_bell: d.release_bell, opened: d.opened, hosts_known: hosts.length > 0, hosts_source: d.destinations?.length ? 'opened record' : d.candidates ? 'private record' : null, clashes });
  }
  const opened = marches.filter((m) => m.opened);
  const yStrict = opened.filter((m) => m.clashes.length).length;
  const noHosts = marches.filter((m) => !m.hosts_known).length;
  const yUnopened = marches.filter((m) => m.hosts_known && m.clashes.length).length;
  return {
    model_marches_sent: marches.length,
    opened: opened.length,
    y_strict: yStrict,
    y_strict_definition: 'model marches whose decision record was opened (section 7.2) and which produced a CLASH (contract 10.1, G12); counted as found, never rounded up',
    g12_met: yStrict >= 1,
    y_clash_without_opening: yUnopened,
    y_clash_without_opening_note: 'NOT Y: model marches whose army has a public clash_own_* episode (created only when an own army fought), matched by host id through the private record; the record was not opened. The episode stands in for the clash report row (engaged: true), which needs the herald.',
    clash_results: { win: marches.filter((m) => m.clashes.some((c) => c.kind === 'clash_own_win')).length, loss: marches.filter((m) => m.clashes.some((c) => c.kind === 'clash_own_loss')).length },
    marches_without_known_host: noHosts,
    marches,
  };
}

export function memorySection(run, metrics) {
  const kindsPerAi = [];
  const allKinds = {};
  for (const [tag, eps] of run.episodesByTag) {
    const k = eps.reduce((m, e) => { m[e.kind] = (m[e.kind] ?? 0) + 1; allKinds[e.kind] = (allKinds[e.kind] ?? 0) + 1; return m; }, {});
    kindsPerAi.push({ tag, index: run.aiByTag.get(tag)?.index ?? null, episodes: eps.length, by_kind: k });
  }
  kindsPerAi.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  const known = run.records.filter((d) => d.choice && d.retrieved && d.mode === 'model' && MODEL_KINDS.has(d.kind));
  const hasKey = (d) => d.retrieved.some((id) => KEY_KINDS.includes(run.episodes.get(`${d.tag}:${id}`)?.kind));
  const citing = known.filter((d) => (d.choice.mem ?? []).length > 0);
  const keyDecisions = known.filter(hasKey);
  const keyCiting = keyDecisions.filter((d) => (d.choice.mem ?? []).length > 0);
  const composition = {};
  for (const d of known) for (const id of d.retrieved) { const k = run.episodes.get(`${d.tag}:${id}`)?.kind ?? 'unknown'; composition[k] = (composition[k] ?? 0) + 1; }
  const ages = [];
  const citedKinds = {};
  for (const d of citing) for (const id of d.choice.mem) {
    const e = run.episodes.get(`${d.tag}:${id}`);
    if (!e) continue;
    ages.push(d.bell - e.bell);
    citedKinds[e.kind] = (citedKinds[e.kind] ?? 0) + 1;
  }
  const g = metrics?.groups ?? {};
  const c = metrics?.counters ?? {};
  const unknownChoice = run.records.filter((d) => d.mode === 'model' && MODEL_KINDS.has(d.kind) && !d.choice).length;
  const summaries = listDir(path.join(run.pub, 'memory')).filter((d) => fs.existsSync(path.join(run.pub, 'memory', d, 'summary.json'))).length;
  return {
    episodes_total: sum(kindsPerAi.map((x) => x.episodes)),
    episodes_by_kind: allKinds,
    episodes_by_ai: kindsPerAi,
    decisions_with_known_choice_and_retrieved_set: known.length,
    decisions_with_unknown_choice: unknownChoice,
    unknown_choice_note: unknownChoice ? 'a sealed decision shows no choice, retrieved set or cited ids until it is opened: they were read from the private record when --public-only is not set' : null,
    retrieved_composition: composition,
    decisions_citing_memory: { from_records: citing.length, from_mind_counter: c.decisions_citing_memory ?? null, of_model_decisions_with_known_choice: known.length, share_pct: pct(citing.length, known.length) },
    citation_among_key_kind_decisions: { n_with_key_episode_retrieved: keyDecisions.length, n_citing_at_least_one: keyCiting.length, share_pct: pct(keyCiting.length, keyDecisions.length), key_kinds: KEY_KINDS, note: 'a citation shows the line was shown and named, not that the choice rested on it (5.7)' },
    cited_episode_kinds: citedKinds,
    cited_episode_ages_bells: { n: ages.length, max: ages.length ? Math.max(...ages) : null, min: ages.length ? Math.min(...ages) : null, older_than_72: ages.filter((a) => a > 72).length, all: ages.sort((a, b) => a - b), earlier_in_the_season_may_be_said: ages.some((a) => a > 72), mind_metric: metrics?.memory?.cited_episode_ages ?? null },
    mem_dropped: c.mem_dropped ?? 0,
    feed_lag: c.feed_lag ?? 0,
    why_withheld_by_rule: g.why_withheld ?? {},
    speech_drops_by_reason: g.speech_drop ?? {},
    say_withheld: c.say_withheld ?? 0,
    pact_word_and_uncited_claim_withholds: Object.fromEntries(Object.entries(g.speech_drop ?? {}).filter(([k]) => /pact|memory/.test(k))),
    reflections: { due: c.reflect_due ?? 0, ran: c.reflections_run ?? c.reflection_ok ?? null, refused: c.reflection_refused ?? null, skipped: c.reflection_skipped ?? null, summaries_published: summaries },
    relevance_spot_check: 'not run here: the integrator reads 20 opened decisions against the rubric fixed before reading (G14 (b))',
    probe: 'see citizens/probe/memory.mjs (its result is not a number of this report)',
  };
}

export function brainSection(fleetDir, run) {
  const j = readJson(path.join(fleetDir, 'ai-brain.json'));
  if (!j) return { available: false, note: 'no fleet/ai-brain.json: the brain counters (steps, no_session, GETs per step) are not available' };
  const c = j.counters ?? {};
  const steps = c.steps ?? null;
  const first = (c.answers_model ?? 0) + (c.answers_autopilot ?? 0);
  const noSession = c.no_session ?? (steps != null ? steps - first : null);
  const getKeys = Object.keys(c).filter((k) => /(^|_)gets($|[_:])/.test(k)); // integ-B: the brain's counters are named `gets:digest`, `gets:me`, ... (the old pattern missed the colon)
  const gets = getKeys.length ? sum(getKeys.map((k) => c[k])) : null;
  const ai = j.ai_bots ?? run.aiByTag.size;
  return {
    available: true,
    brain_steps: steps,
    steps_per_ai: steps != null && ai ? Math.round((10 * steps) / ai) / 10 : null,
    no_session: noSession,
    no_session_source: c.no_session != null ? 'brain counter no_session' : 'derived: steps - (answers_model + answers_autopilot); the brain wrote no no_session counter in this run',
    first_call_answers: first,
    answers_reused_same_bell: c.answers_reused ?? null,
    records_in_pub: run.records.length,
    steps_equal_records_plus_no_session: steps != null && noSession != null ? steps === run.records.length + noSession : null,
    model_marches_sent_brain: c.model_marches_sent ?? null,
    reobserved: c.reobserved ?? null,
    quota_floor_skips: c.quota_floor_skips ?? null,
    quota_starved_bells: c.quota_starved_bells ?? null,
    gets_per_step: gets != null && steps ? { gets, per_step: Math.round((100 * gets) / steps) / 100, per_step_per_ai: null, keys: getKeys, note: 'the brain\'s own extra GETs; gets:reobserve is a lower bound; the first observation of a step and the script bots\' GETs are not counted' } : null,
    gets_note: gets == null ? 'not measured in this run: the brain wrote no GET counter (no key matching "gets" in fleet/ai-brain.json); the herald load during the run is not measured either' : null,
    follow_window: { script_bots: c.follow_window_script_bots ?? null, ai_bots: c.follow_window_ai_bots ?? null },
    counters: c,
    timeline: j.timeline ?? null,
  };
}

export function personaSection(run, metrics) {
  const out = {};
  for (const [tag, a] of run.aiByTag) {
    const g = metrics?.groups?.[`ai:${tag}`] ?? {};
    const p = (out[a.persona ?? 'unknown'] ??= { ai: 0, decisions: 0, model_marches: 0, messages: 0, actions_by_model: 0, actions_by_autopilot: 0 });
    p.ai += 1; p.decisions += g.decisions ?? 0; p.model_marches += g.model_marches ?? 0; p.messages += g.messages ?? 0; p.actions_by_model += g.actions_by_model ?? 0; p.actions_by_autopilot += g.actions_by_autopilot ?? 0;
  }
  for (const p of Object.values(out)) p.march_rate_per_model_decision_pct = pct(p.model_marches, p.decisions);
  return out;
}

export function socialSection(run) {
  const councilFiles = listDir(path.join(run.pub, 'council')).filter((f) => /^\d+-\d+\.json$/.test(f));
  const talkFiles = listDir(path.join(run.pub, 'talk')).filter((f) => /^\d+\.json$/.test(f));
  let messages = 0;
  const origin = {};
  for (const f of talkFiles) {
    const j = readJson(path.join(run.pub, 'talk', f));
    for (const r of j?.records ?? []) { if (r.bytes_b64 || r.text) messages += 1; }
  }
  const periods = [];
  for (const f of councilFiles) {
    const j = readJson(path.join(run.pub, 'council', f));
    if (!j) continue;
    periods.push({ file: f, period: j.period, faction: j.faction, options_hash: j.options_hash ?? null, adopted: j.adopted ?? null, ballots_cast: j.ballots_cast ?? null, tally_split: j.tally_split ?? null, result: j.result ? { present: j.result.present ?? null, bounced: j.result.bounced ?? null } : null });
  }
  return { talk_files: talkFiles.length, messages_in_talk_files: messages, council_files: councilFiles.length, council_periods: periods, origin, note: councilFiles.length ? null : 'no council file: in wave A the watcher was a stub and no council ran; motions, ballots, Strike Orders, declines and chronicle lines are not measured here' };
}

export function commitmentsSection(run) {
  const c = run.commitments;
  if (!c) return { available: false };
  const anchors = readJson(path.join(run.pub, 'anchors/commit.json'));
  const f = (v) => (v == null ? 'unmeasured' : v);
  return {
    available: true, run_id: c.run_id, season_id: c.season_id, deck: c.personas?.deck ?? null,
    model_sha256: f(c.model?.sha256), llama_tree_sha256: f(c.server?.tree_sha256), request_shape: c.server?.request_shape ?? null,
    code_git_commit: c.code?.git_commit ?? null, slots: c.slots?.length ?? null,
    commit_memo: anchors?.status ?? null,
    note: 'a field printed "unmeasured" was not measured by the run script (a smoke run may leave AI_MODEL and AI_LLAMA_DIR unset): such a run is not cited for audit claims. The model sha256 here is the pinned constant if the field was filled without AI_MODEL; verify-minds M1 is what measures it.',
  };
}

/**
 * FB1 (A2): closed bells against anchored bells, read from the files of PUB (talk, minds, anchors). A closed bell is one with a talk or a
 * minds file; an anchored bell has an anchor file with a signature, a gap an anchor file with `anchor_gap`. `closed_without_anchor_file`
 * names the bells that have neither (the old run script left the last bell there); `closed_after_index` the closed bells above the
 * `last_bell` of the registrar's season-end index (bells the closer closed after the index was written). Nothing is measured on the chain
 * here: that an anchor memo is on the chain and says the right text is verify-minds M3.
 */
export function anchorsSection({ pub }) {
  const nums = (d) => listDir(path.join(pub, d)).map((f) => /^(\d+)\.json$/.exec(f)).filter(Boolean).map((m) => Number(m[1]));
  const closed = [...new Set([...nums('talk'), ...nums('minds')])].sort((a, b) => a - b);
  const anchorBells = nums('anchors').sort((a, b) => a - b);
  let anchored = 0, gaps = 0;
  for (const b of anchorBells) { if (readJson(path.join(pub, 'anchors', `${b}.json`))?.anchor_gap) gaps += 1; else anchored += 1; }
  const have = new Set(anchorBells);
  const withoutFile = closed.filter((b) => !have.has(b));
  const idx = readJson(path.join(pub, 'anchors/index.json'));
  const last = idx?.last_bell ?? null;
  const after = last === null ? [] : closed.filter((b) => b > last);
  const note = `${closed.length} closed bells; ${anchored} anchored, ${gaps} anchor_gap${withoutFile.length ? `; ${withoutFile.length} closed with no anchor file (${withoutFile.join(', ')})` : ''}${after.length ? `; closed after the season-end index (last_bell ${last}): ${after.join(', ')}` : ''}. Whether each memo is on the chain with the right text is verify-minds M3, not read here.`;
  return { closed_bells: closed.length, anchored, gaps, closed_without_anchor_file: withoutFile, index_last_bell: last, index_present: idx !== null, closed_after_index: after, every_closed_bell_has_an_anchor_or_gap: withoutFile.length === 0, note };
}

// ---------------------------------------------------------------- the report
export function buildReport({ aiDir, runsFile = null, metricsFile = null, metrics = null, privateOk = true, now = null } = {}) {
  const run = loadRun(aiDir, { privateOk });
  const m = metrics ?? readJson(metricsFile ?? path.join(run.pub, 'metrics/latest.json'), null);
  const decisions = decisionsSection(run, m);
  const report = {
    v: 1,
    kind: 'run-report',
    generated_by: 'citizens/report.mjs (AC9)',
    local_test_chain_only: true,
    ai_dir: path.basename(aiDir),
    run_id: run.commitments?.run_id ?? path.basename(aiDir),
    sources: { public: true, private_records: run.private, metrics_snapshot: m ? { bell: m.bell ?? null, uptime_s: m.uptime_s ?? null } : null, public_only_flag: !privateOk, minds_files: run.bells.length, first_bell: run.bells[0] ?? null, last_bell: run.bells.at(-1) ?? null },
    commitments: commitmentsSection(run),
    anchors: anchorsSection(run),
    runs_listed: runsFile && fs.existsSync(runsFile) ? parseRuns(fs.readFileSync(runsFile, 'utf8')) : null,
    roster: { ai: run.roster?.ai?.length ?? 0, deck: run.roster?.deck ?? null, by_persona: [...run.aiByTag.values()].reduce((o, a) => { o[a.persona] = (o[a.persona] ?? 0) + 1; return o; }, {}) },
    decisions,
    by_model: byModelSection(run, m),
    marches: marchesSection(run),
    memory: memorySection(run, m),
    brain: brainSection(path.join(aiDir, 'fleet'), run),
    personas: personaSection(run, m),
    social: socialSection(run),
    census: readJson(path.join(aiDir, 'census/summary.json')),
    mind_counters: m?.counters ?? null,
    scheduler: m?.scheduler ?? null,
    not_measured: [
      'llama tokens per second and RSS (no field in the mind snapshot)',
      'MC and playtest load at run time (the Mac load is recorded by hand next to each latency)',
      'quota left at every model decision and quota-starved bells per AI (the brain counts quota_starved_bells in total only)',
      'hostile acts, collisions, grievances opened and answered, strike results (they need the council and the herald; not read here)',
    ],
    does_not_show: [
      'human playtest results, traction, working money, strength of the AI against rule bots, or that the model wants or intends anything',
      'that a cited episode was the reason for a choice (a citation shows the line was shown and named)',
      'exact replay of model output beyond the M9 samples verify-minds checks',
    ],
  };
  if (now) report.generated_unix = now;
  // consistency lines a reader can check
  report.checks = {
    brain_first_call_answers_equal_records: report.brain.available ? report.brain.first_call_answers === decisions.records : null,
    records_equal_metrics_decisions_total: m?.counters?.decisions_total != null ? m.counters.decisions_total === decisions.records : null,
    model_marches_equal_mind_counter: m?.counters?.model_marches != null ? m.counters.model_marches === report.marches.model_marches_sent : null,
    every_closed_bell_has_an_anchor_or_gap: report.anchors.every_closed_bell_has_an_anchor_or_gap,
    model_marches_equal_brain_counter: report.brain.available && report.brain.model_marches_sent_brain != null ? report.brain.model_marches_sent_brain === report.marches.model_marches_sent : null,
  };
  return report;
}

export function renderMarkdown(r) {
  const L = [];
  const row = (...c) => `| ${c.join(' | ')} |`;
  const v = (x) => (x == null ? 'n/a' : x);
  L.push(`# AI citizens run report: ${r.run_id}`, '', `Local test chain only (no public network). Generated by ${r.generated_by}. Sources: public files${r.sources.private_records ? ' + the mind\'s private records (operator side; labelled below)' : ' only'}; metrics snapshot at bell ${v(r.sources.metrics_snapshot?.bell)}; ${r.sources.minds_files} closed bells (${v(r.sources.first_bell)} to ${v(r.sources.last_bell)}).`, '');
  const c = r.commitments;
  if (c.available) L.push(`Run \`${c.run_id}\`, season ${c.season_id}, deck ${v(c.deck)}, ${r.roster.ai} AI citizens (${Object.entries(r.roster.by_persona).map(([k, n]) => `${n} ${k}`).join(', ')}). Model sha256: ${c.model_sha256}. llama tree: ${c.llama_tree_sha256}. Commit memo: ${v(c.commit_memo)}. Code commit: ${v(c.code_git_commit)}.`, '');
  L.push('## Anchors (closed bells against anchored bells)', '', r.anchors.note, '');
  const d = r.decisions;
  L.push('## Decisions (G1, G2, G3)', '');
  L.push(`${d.records} decision records; ${d.model_decisions} model decisions (gate open, the mind attempted the model; reflections and dropped-for-time not included); gate-open records ${d.gate_open}.`, '');
  L.push(row('measure', 'value'), row('---', '---'));
  L.push(row('valid choices', `${d.valid_choices} of ${d.model_decisions} (${v(d.valid_rate_pct)} %; 95 % interval ${d.valid_rate_ci95_pct ? d.valid_rate_ci95_pct.join(' to ') : 'n/a'} %)`));
  L.push(row('G1 (>= 95 % with n >= 300)', d.g1_threshold.underpowered ? `underpowered: n = ${d.model_decisions} < 300` : (d.g1_threshold.met ? 'met' : 'not met')));
  L.push(row('fallbacks (invalid, timeout, llm_error, late, v6_all_refused)', `${d.fallbacks.total} (${v(d.fallbacks.rate_pct)} %); by reason ${JSON.stringify(d.fallbacks.by_reason)}; G2 limit ${d.fallbacks.g2_max_pct} %`));
  L.push(row('dropped for time (no_time)', `${d.dropped_for_time.n} (${v(d.dropped_for_time.share_of_gate_open_pct)} % of gate-open); G2 limit ${d.dropped_for_time.g2_max_pct} %`));
  L.push(row('feed_lag (gate open, session refused)', `${d.feed_lag.n} (${v(d.feed_lag.share_of_gate_open_pct)} % of gate-open)`));
  L.push(row('reflections', `${d.reflections.n} records: ${d.reflections.ok} ok, ${d.reflections.refused_or_failed} refused or failed ${JSON.stringify(d.reflections.by_reason)}`));
  L.push(row('by kind / mode / reason', `${JSON.stringify(d.by_kind)} / ${JSON.stringify(d.by_mode)} / ${JSON.stringify(d.by_reason)}`));
  L.push(row('latency (llama call, ms) per kind', Object.entries(d.latency_ms_by_kind).map(([k, x]) => `${k}: n ${x.n}, p50 ${v(x.p50)}, p90 ${v(x.p90)}, p99 ${v(x.p99)}, min slack ${v(x.slack_min)}, negative ${x.slack_negative}`).join('; ') || 'n/a'));
  L.push('');
  const b = r.brain;
  L.push('## Brain steps and records (R5, R6)', '');
  if (b.available) L.push(`${b.brain_steps} brain steps, ${b.no_session} with no mind call (\`no_session\`; ${b.no_session_source}), ${b.records_in_pub} records in PUB; steps = records + no_session: ${v(b.steps_equal_records_plus_no_session)}. ${b.answers_reused_same_bell} same-bell repeats answered from the cache (no new record). GETs per step: ${b.gets_per_step ? `${b.gets_per_step.per_step} (${b.gets_per_step.gets} GETs)` : `not measured (${b.gets_note})`}.`, '');
  else L.push(b.note, '');
  const bm = r.by_model;
  L.push('## By:model share (always printed with the claim)', '');
  L.push(`By:model share ${v(bm.total.by_model_share_pct)} % (${bm.total.actions_by_model} of ${bm.total.actions_by_model + bm.total.actions_by_autopilot} actions sent by AI wallets; ${bm.total.source}). From the records' tx: ${v(bm.from_records_tx.by_model_share_pct)} %. Autopilot economy share ${v(bm.autopilot_economy_share.share_pct)} % (${bm.autopilot_economy_share.economy_actions_in_autopilot_records} of ${bm.autopilot_economy_share.all_actions}). Caveat: ${bm.caveat}`, '');
  L.push(row('AI', 'persona', 'by model', 'by autopilot', 'share %', 'decisions', 'model marches', 'cited memory'), row('---', '---', '---', '---', '---', '---', '---', '---'));
  for (const a of bm.per_ai) L.push(row(a.index, a.persona, a.actions_by_model, a.actions_by_autopilot, v(a.by_model_share_pct), a.decisions, a.model_marches, a.decisions_citing_memory));
  L.push('');
  const m = r.marches;
  L.push('## Model marches and Y (G12)', '');
  L.push(`${m.model_marches_sent} model marches sent; ${m.opened} records opened. **Y (strict) = ${m.y_strict}** (${m.y_strict_definition}). G12 ${m.g12_met ? 'met' : 'not met'}.`, '');
  L.push(`Separate, labelled number (not Y): ${m.y_clash_without_opening} of ${m.model_marches_sent} model marches have a public clash_own_* episode for their army, matched by host id through the private record (${m.clash_results.win} won, ${m.clash_results.loss} lost); ${m.y_clash_without_opening_note}`, '');
  L.push(row('bell', 'AI', 'persona', 'opened', 'clash episode (bell, kind, own lost, enemy lost)'), row('---', '---', '---', '---', '---'));
  for (const x of m.marches) L.push(row(x.bell, x.index, x.persona, x.opened ? 'yes' : 'no', x.clashes.map((c) => `${c.bell} ${c.kind} ${v(c.lost_own)}/${v(c.lost_enemy)}${c.camp ? ' (camp)' : ''}`).join('; ') || 'none found'));
  L.push('');
  const me = r.memory;
  L.push('## Memory measures (5.7, G14)', '');
  L.push(`${me.episodes_total} episodes at the end: ${JSON.stringify(me.episodes_by_kind)}.`);
  L.push(`Decisions citing memory (>= 1 id in choice.mem): ${me.decisions_citing_memory.from_records} of ${me.decisions_citing_memory.of_model_decisions_with_known_choice} model decisions whose choice is known (${v(me.decisions_citing_memory.share_pct)} %; the mind's counter says ${v(me.decisions_citing_memory.from_mind_counter)}). Cited episode kinds: ${JSON.stringify(me.cited_episode_kinds)}.`);
  L.push(`Among decisions whose retrieved set held an attacked_own, camp_taken_by or threat episode: ${me.citation_among_key_kind_decisions.n_citing_at_least_one} of ${me.citation_among_key_kind_decisions.n_with_key_episode_retrieved} cited at least one (${v(me.citation_among_key_kind_decisions.share_pct)} %). ${me.citation_among_key_kind_decisions.note}.`);
  L.push(`Age in bells of every cited episode: max ${v(me.cited_episode_ages_bells.max)}, ${me.cited_episode_ages_bells.older_than_72} older than 72 bells (so "earlier in the season" ${me.cited_episode_ages_bells.earlier_in_the_season_may_be_said ? 'may' : 'may not'} be said); all ${JSON.stringify(me.cited_episode_ages_bells.all)}.`);
  L.push(`Retrieved-set composition (episodes shown, by kind): ${JSON.stringify(me.retrieved_composition)}. mem_dropped ${me.mem_dropped}; feed_lag ${me.feed_lag}; why withheld ${JSON.stringify(me.why_withheld_by_rule)}; say withheld ${me.say_withheld}; reflections ${JSON.stringify(me.reflections)}.`);
  if (me.unknown_choice_note && me.decisions_with_unknown_choice) L.push(`${me.decisions_with_unknown_choice} model decisions have no readable choice (${me.unknown_choice_note}).`);
  L.push('');
  L.push('## Social and council', '', r.social.note ?? `${r.social.council_files} council files, ${r.social.talk_files} talk files.`, '');
  if (r.runs_listed) {
    L.push('## Every run in RUNS.md', '', row('run', 'arm', 'rep', 'status', 'detail'), row('---', '---', '---', '---', '---'));
    for (const x of r.runs_listed) L.push(row(x.run_id, v(x.arm), v(x.rep), x.status, v(x.detail)));
    L.push('');
  }
  L.push('## Checks a reader can redo', '', ...Object.entries(r.checks).map(([k, x]) => `- ${k}: ${x === null ? 'n/a' : x}`), '');
  L.push('## Not measured', '', ...r.not_measured.map((x) => `- ${x}`), '', '## What these numbers do not show', '', ...r.does_not_show.map((x) => `- ${x}`), '');
  return L.join('\n');
}

// ---------------------------------------------------------------- CLI
function isMain() {
  try { return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}
if (isMain()) {
  const a = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) { const k = argv[i].slice(2); a[k] = ['public-only'].includes(k) ? true : argv[++i]; }
  if (!a['ai-dir']) { console.error('report: --ai-dir DIR is required'); process.exit(2); }
  let metrics = null;
  if (a.metrics && /^http:/.test(a.metrics)) {
    const { assertLoopbackUrl } = await import('./mind/guards.mjs');
    assertLoopbackUrl(a.metrics, 'metrics url');
    const token = a['token-file'] ? fs.readFileSync(a['token-file'], 'utf8').trim() : null;
    const r = await fetch(`${a.metrics.replace(/\/+$/, '')}/v1/metrics`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
    metrics = await r.json();
  }
  const rep = buildReport({ aiDir: path.resolve(a['ai-dir']), runsFile: a.runs ? path.resolve(a.runs) : null, metricsFile: a.metrics && !/^http:/.test(a.metrics) ? a.metrics : null, metrics, privateOk: !a['public-only'] });
  if (a.out) fs.writeFileSync(a.out, JSON.stringify(rep, null, 2) + '\n');
  const md = renderMarkdown(rep);
  if (a.md) fs.writeFileSync(a.md, md + '\n');
  if (!a.out && !a.md) process.stdout.write(md + '\n');
}
