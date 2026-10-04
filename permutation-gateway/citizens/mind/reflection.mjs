// The reflection job (contract sections 3.2 W-REFLECT, 3.4, 4.4 last paragraph, 4.7, 5.3). Optional: the first memory
// feature to cut (`memory.reflection: false` or simply not starting this job; ledger, episodes, retrieval, `mem`
// citations, the card's memory block, M11 and the probe do not depend on it).
//
// The mind (AC1a) emits {type: 'reflect_due', tag, index, bell, slot} at the first step at or after bell mod
// reflect_every == 0 (slot >= 1). This job subscribes to it and, per AI and slot:
//   1. gathers the previous summary, the ledger digest, the goals and the top 12 episodes since the last accepted summary
//      (importance x recency), renders the reflection prompt (prompt.renderReflection: summary and episodes are wrapped as
//      <memory> data, section 4.7);
//   2. runs ONE model call through mind.llmJob (scheduler: earliest deadline first, kind "reflection", deadline
//      bell_start(b + 12), max_tokens 512, the pinned request shape, V0, one retry on a V0-V1 failure);
//   3. applies the reflection validator (speech.checkSummary, section 4.7: English, no handle or [bell N] imitation, no
//      imperative aimed at the AI, every coordinate, bell and number in the window's episodes, the V5 checks). A refused
//      answer is discarded whole: the previous summary stays, no goal op and no trust delta is applied, `reflection_refused`
//      is counted by rule. An accepted summary is sanitised as a summary, stored (STATE/summary/<tag>/<bell>.txt), published
//      live (PUB/memory/<tag>/summary.json, labelled model-written) and its sha256 enters memory_hash;
//   4. applies the answer's goal ops (the only place goal ops come from) and trust deltas (the ledger clips them);
//   5. leaves one decision record of kind "reflection" (request body stored for the M9 replay; the summary itself is never
//      replayed and never claimed deterministic).
// It uses no session or reaction budget. A reflection with no episode in its window is skipped and counted (nothing to
// summarise; the model would only invent).
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, renameSync, existsSync, readFileSync } from 'node:fs';
import { buildReflectionSchema, validateReflectionShape } from './schema.mjs';
import { canonicalJson, sha256Canonical } from './records.mjs';
import { ledgerState } from './views.mjs';

export const REFLECT_WINDOW = 12;
export const REFLECT_DEADLINE_BELLS = 12;
const HALF_LIFE = 72;
const sha256hex = (...parts) => {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest('hex');
};

/** importance x 0.5^((bell_now - bell) / 72), the retrieval score without the focus bonus (section 5.2). */
export const episodeWeight = (e, bellNow) => (e.importance ?? 1) * 0.5 ** ((bellNow - e.bell) / HALF_LIFE);

/** The window: episodes created after `since` and before `bellNow`, best first (weight desc, bell desc, id asc), at most `n`. */
export function reflectionWindow(episodes, { bellNow, since = -1, n = REFLECT_WINDOW } = {}) {
  return [...episodes]
    .filter((e) => (e.created_bell ?? e.bell) > since && (e.created_bell ?? e.bell) < bellNow)
    .sort((a, b) => episodeWeight(b, bellNow) - episodeWeight(a, bellNow) || b.bell - a.bell || (a.id < b.id ? -1 : 1))
    .slice(0, n);
}

export function createReflection({
  mind, prompt, stores, views, speech, metrics, records, clock, roster, config = {}, renderPersona = null, nameOf = null, nationName = null,
  sealed = null, season = 0, stateDir = null, now = Date.now,
} = {}) {
  for (const [k, v] of Object.entries({ mind, prompt, stores, views, speech, metrics, records, clock, roster })) {
    if (!v) throw new Error(`createReflection: ${k} is required`);
  }
  const enabled = config.memory?.reflection !== false;
  const maxTokens = config.llm?.max_tokens?.reflection ?? 512;
  const allowPrevious = config.memory?.summary_allow_previous === true;
  const listeners = [];
  const emit = (ev) => {
    for (const f of listeners) {
      try {
        f(ev);
      } catch {
        metrics.inc('listener_error');
      }
    }
  };
  const inflight = new Set();
  const donePath = stateDir ? `${stateDir}/reflections.json` : null;
  const done = new Set();
  if (donePath && existsSync(donePath)) {
    try {
      for (const k of JSON.parse(readFileSync(donePath, 'utf8'))) done.add(k);
    } catch {
      /* a half-written marker file only means one reflection may run twice after a restart */
    }
  }
  const markDone = (key) => {
    done.add(key);
    if (!donePath) return;
    mkdirSync(stateDir, { recursive: true });
    const tmp = `${donePath}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify([...done].sort()));
    renameSync(tmp, donePath);
  };
  let stopped = false;
  let started = false;

  const nm = (tag) => nameOf?.(tag)?.en ?? `citizen ${String(tag).slice(0, 6)}`;
  const personaGoals = (own) => (own.persona?.goals ?? []).map((g) => ({ id: g.id, text: typeof g.text === 'string' ? g.text : g.text?.en ?? '' }));

  /** The relations the reflection may change trust for: the strongest 5 citizens of the ledger and every nation entry, as handles. */
  function relationsOf(doc) {
    const citizens = Object.entries(doc.trust?.citizens ?? {})
      .map(([tag, v]) => ({ tag, total: Math.max(-100, Math.min(100, (v.t_code ?? 0) + (v.t_model ?? 0))), code: v.t_code ?? 0, model: v.t_model ?? 0 }))
      .sort((a, b) => Math.abs(b.total) - Math.abs(a.total) || (a.tag < b.tag ? -1 : 1))
      .slice(0, 5)
      .map((c, i) => ({ ...c, handle: `C${i + 1}` }));
    const nations = Object.entries(doc.trust?.nations ?? {}).map(([f, v]) => ({ f: Number(f), total: Math.max(-100, Math.min(100, (v.t_code ?? 0) + (v.t_model ?? 0))), code: v.t_code ?? 0, model: v.t_model ?? 0 }));
    return { citizens, nations };
  }

  function ledgerDigest(doc, rel) {
    const sgn = (n) => (n > 0 ? `+${n}` : String(n));
    const lines = [`Game day ${doc.day ?? 0}.`];
    for (const c of rel.citizens) lines.push(`${c.handle} ${nm(c.tag)}: trust ${sgn(c.total)} (code ${sgn(c.code)}, model ${sgn(c.model)})`);
    for (const n of rel.nations) lines.push(`N${n.f}: trust ${sgn(n.total)} (code ${sgn(n.code)}, model ${sgn(n.model)})`);
    const open = (doc.grievances ?? []).filter((g) => !g.answered);
    lines.push(`Open grievances: ${open.length}.`);
    for (const g of open.slice(0, 3)) lines.push(`  against ${String(g.against).startsWith('nation:') ? `nation ${String(g.against).slice(7)}` : nm(g.against)} since bell ${g.bell}`);
    return lines.join('\n');
  }

  function sealedForSummary(own) {
    const list = sealed?.list?.(own.tag) ?? [];
    const out = list.map((e) => ({
      pq: e.pq,
      names: [...(e.names ?? []), ...(e.nations ?? []).flatMap((n) => [nationName?.(n, 'en'), nationName?.(n, 'ja')]).filter(Boolean)],
      nations: e.nations ?? [],
      numbers: e.numbers ?? [],
      kinds: e.target_kind ? [e.target_kind] : [],
    }));
    const call = views.memberView(own.faction)?.call;
    if (call) out.push({ pq: [call.p, call.q], names: [], numbers: [] });
    return { sealed: out, inFlight: list.some((e) => e.via !== 'call') };
  }

  function buildRecord({ own, bell, mode, reason, shown, rendered, llmUsed, attempts, accepted, refusal, summarySha, finishedMs, deadlineMs, t0, ops, trusts }) {
    const doc = ledgerState(own.ledger);
    return {
      v: 2,
      ai: own.tag,
      index: own.index,
      bell,
      kind: 'reflection',
      mode,
      reason,
      wake: ['W-REFLECT'],
      gate_score: 0,
      sealed: false,
      release_bell: null,
      obs_digest: null,
      situation_hash: sha256Canonical({}),
      candidates_hash: sha256Canonical([]),
      memory_hash: sha256hex(canonicalJson(doc), shown.map((e) => e.id).join(','), summarySha ?? own.summary?.sha256 ?? ''),
      inbox_root: sha256hex(''),
      prompt_hash: rendered ? sha256Canonical(rendered.messages) : null,
      request_hash: llmUsed?.r ? sha256hex(llmUsed.r.request_body) : null,
      output_hash: llmUsed?.r?.content != null ? sha256hex(llmUsed.r.content) : null,
      attempts: attempts ?? 0,
      seed: llmUsed?.seed ?? null,
      choice: { ids: [], params: {}, council: null, goal_id: null, mem: [] },
      retrieved: shown.map((e) => e.id),
      public: { say: [], why: null, why_withheld: null },
      reflection: { accepted, refused: refusal ?? null, summary_sha256: accepted ? summarySha : null, goal_ops: ops ?? 0, trust: trusts ?? 0 },
      commit: null,
      latency_ms: llmUsed?.r?.latency_ms ?? now() - t0,
      deadline_slack_ms: deadlineMs != null ? deadlineMs - finishedMs : null,
      quota_left: null,
      tx: [],
    };
  }

  /** Run one reflection. Returns {status: 'ok'|'refused'|'failed'|'skipped', reason?, record_id?}. */
  async function run({ tag, bell, slot = null }) {
    const t0 = now();
    const key = `${tag}:${slot ?? bell}`;
    if (!enabled) return { status: 'skipped', reason: 'disabled' };
    if (done.has(key)) return { status: 'skipped', reason: 'done' };
    const entry = roster.byTag(tag);
    if (!entry) return { status: 'skipped', reason: 'not_on_roster' };
    if (!clock.hasAnchor()) {
      metrics.incGroup('reflection_skipped', 'no_clock');
      return { status: 'skipped', reason: 'no_clock' };
    }
    const own = views.ownState(tag, bell);
    const doc = ledgerState(own.ledger);
    const since = own.summary?.bell ?? -1;
    const eps = typeof own.episodes?.list === 'function' ? own.episodes.list() : [];
    const shown = reflectionWindow(eps, { bellNow: bell, since });
    if (!shown.length) {
      markDone(key);
      metrics.incGroup('reflection_skipped', 'no_episodes');
      return { status: 'skipped', reason: 'no_episodes' };
    }
    const deadlineMs = clock.bellStartReal(bell + REFLECT_DEADLINE_BELLS);
    const rel = relationsOf(doc);
    const goals = (doc.goals ?? []).map((g) => ({ ...g, text: personaGoals(own).find((p) => p.id === g.id)?.text ?? '' }));
    const rendered = prompt.renderReflection({
      bell,
      previousSummary: own.summary ?? null,
      ledgerDigest: ledgerDigest(doc, rel),
      goals,
      episodes: shown.map((e) => ({ bell: e.bell, text: e.text?.en ?? '' })),
      ownState: own,
      persona: renderPersona ? renderPersona(own.persona, 'en') : '',
    });
    const people = rel.citizens.length
      ? `\n\nPEOPLE (use these handles in trust.who; N0..N5 are nations): ${rel.citizens.map((c) => `${c.handle} ${nm(c.tag)}`).join('; ')}`
      : '\n\nPEOPLE: none named. trust must be empty or use N0..N5 for nations.';
    const messages = [rendered.messages[0], { role: 'user', content: rendered.messages[1].content + people }];
    const spec = { goalIds: goals.map((g) => g.id), who: [...rel.citizens.map((c) => c.handle), 'N0', 'N1', 'N2', 'N3', 'N4', 'N5'] };
    const schema = buildReflectionSchema(spec);
    metrics.inc('model_decisions');
    metrics.inc('reflections_run');
    metrics.incGroup(`ai:${tag}`, 'decisions');
    const res = await mind.llmJob({
      kind: 'reflection', index: own.index, bell, deadlineMs, messages, schemaName: 'reflection', schema, maxTokens,
      check: (parsed) => {
        const v1 = validateReflectionShape(parsed, spec);
        return v1.ok ? { ok: true, value: v1.value } : { ok: false, layer: 'V1', why: v1.errors[0] };
      },
    });
    const finishedMs = now();
    markDone(key);
    const finish = (mode, reason, extra) => {
      const rec = buildRecord({ own, bell, mode, reason, shown, rendered: { messages }, llmUsed: res.llm, attempts: res.attempts, finishedMs, deadlineMs, t0, ...extra });
      const { id } = records.add(rec, { candidates: [], situation: {}, remembered: [], intended: [], social: {} });
      if (res.llm?.r?.request_body) records.saveRequest(id, res.llm.r.request_body);
      metrics.inc('decisions_total');
      return id;
    };
    if (res.status === 'fail') {
      metrics.incGroup('fallback_reason', res.reason);
      metrics.incGroup('reflection_failed', res.reason);
      metrics.inc('decisions_autopilot');
      metrics.incGroup('autopilot_reason', res.reason);
      const id = finish('autopilot', res.reason, { accepted: false });
      return { status: 'failed', reason: res.reason, record_id: id };
    }
    const sc = sealedForSummary(own);
    const verdict = speech.checkSummary(res.value.summary, { episodes: shown.map((e) => `${e.text?.en ?? ''} ${e.text?.ja ?? ''}`), previous: own.summary?.text ?? null, allowPrevious, sealed: sc.sealed, inFlight: sc.inFlight });
    if (!verdict.ok) {
      metrics.inc('reflection_refused');
      metrics.incGroup('reflection_refused_by', verdict.reason);
      metrics.incGroup('fallback_reason', 'invalid:V5b');
      metrics.inc('decisions_autopilot');
      metrics.incGroup('autopilot_reason', 'invalid:V5b');
      const id = finish('autopilot', 'invalid:V5b', { accepted: false, refusal: verdict.reason });
      emit({ type: 'reflection_refused', tag, bell, reason: verdict.reason, word: verdict.word ?? null, record_id: id });
      return { status: 'refused', reason: verdict.reason, record_id: id };
    }
    // accepted: store and publish the summary, then the goal ops and trust deltas the same answer carried
    const saved = stores.summary.save(tag, bell, verdict.text);
    const ledger = own.ledger;
    let ops = 0;
    for (const op of res.value.goal_ops) {
      const ok = typeof ledger.goalOp === 'function' ? ledger.goalOp(op) : applyGoalOpFallback(doc, op);
      if (ok) ops += 1;
    }
    const byHandle = Object.fromEntries(rel.citizens.map((c) => [c.handle, c.tag]));
    const deltas = [];
    for (const t of res.value.trust) {
      const who = /^N\d$/.test(t.who) ? `nation:${t.who.slice(1)}` : byHandle[t.who];
      if (who) deltas.push({ who, delta: t.delta });
    }
    if (deltas.length && typeof ledger.applyModelDeltas === 'function') ledger.applyModelDeltas(deltas, { bell });
    stores.save?.(tag);
    stores.publish?.(tag);
    metrics.inc('summaries_published');
    metrics.inc('decisions_model');
    metrics.inc('valid_choices');
    metrics.incGroup(`ai:${tag}`, 'valid');
    metrics.latency('reflection', res.llm.r.latency_ms, deadlineMs - finishedMs);
    const id = finish('model', 'ok', { accepted: true, summarySha: saved?.sha256 ?? sha256hex(verdict.text), ops, trusts: deltas.length });
    emit({ type: 'summary_saved', tag, bell, sha256: saved?.sha256 ?? null, record_id: id });
    return { status: 'ok', record_id: id, summary: { bell, sha256: saved?.sha256 ?? null }, goal_ops: ops, trust: deltas.length };
  }

  function applyGoalOpFallback(doc, { op, id }) {
    const g = (doc.goals ?? []).find((x) => x.id === id);
    if (!g) return false;
    if (op === 'drop') g.status = 'dropped';
    else if (op === 'resume') g.status = 'active';
    return true;
  }

  function enqueue(ev) {
    if (stopped) return null;
    const p = run(ev)
      .catch((e) => {
        metrics.incGroup('reflection_failed', 'exception');
        return { status: 'failed', reason: 'exception', detail: String(e?.message ?? e).slice(0, 120) };
      })
      .finally(() => inflight.delete(p));
    inflight.add(p);
    return p;
  }

  return {
    run,
    enqueue,
    /** Subscribe to the mind's reflect_due events. The mind has no unsubscribe: stop() makes this job ignore them. */
    start() {
      if (started || !enabled) return false;
      started = true;
      mind.subscribe((ev) => {
        if (ev?.type === 'reflect_due') enqueue(ev);
      });
      return true;
    },
    stop() {
      stopped = true;
    },
    /** Resolves when no reflection is running (tests). */
    async idle() {
      while (inflight.size) await Promise.allSettled([...inflight]);
    },
    subscribe: (fn) => listeners.push(fn),
    enabled,
  };
}
