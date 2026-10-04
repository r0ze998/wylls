// The mind (contract sections 3, 4.1, 4.4, 4.5, 5.5, 5.6, 7.2, 8.1): POST /v1/decide, POST /v1/outcome,
// the council calls (motion, ballot) the watcher drives, and the decision records they leave.
// createMind(deps) holds the logic; createMindHttp(mind, {token}) is the thin HTTP layer for 127.0.0.1:41980.
//
// One decide step, in order (section 3.1 steps 3 and 5 are the brain's):
//   parse -> idempotency cache per (index, bell) -> clock -> own state, day counters, H0 -> sealed-set prune
//   -> gate (wakes, budgets, season end, roster) -> feed_lag check -> memory attach + prompt render
//   -> scheduler (EDF, admission) -> llama call (json_schema, T = 0, one retry on V0-V2) -> V3 caps -> V5/V5b speech
//   -> ledger (trust, counters, standing) -> sealed commitment if a march is intended -> record -> answer.
// A gate-closed or failed step answers mode "autopilot" with the reason; it still leaves exactly one record.
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync, renameSync, existsSync, readFileSync } from 'node:fs';
import { buildRequestBody, mindSeed } from './llm.mjs';
import { buildAnswerSchema, validateShape, kindBase } from './schema.mjs';
import { checkMenu, applyCaps, applySpeech, messagesCap, DEFAULT_CAPS } from './validate.mjs';
import { liveStanding, updateStanding, declinedPeriods } from './standing.mjs';
import { rollCounters, normaliseWakes, DAY_BELLS } from './gate.mjs';
import { sha256Canonical, canonicalJson } from './records.mjs';
import { ledgerState } from './views.mjs';

export class HttpError extends Error {
  constructor(status, code, msg) {
    super(msg ?? code);
    this.status = status;
    this.code = code;
  }
}

const sha256hex = (...parts) => {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest('hex');
};
const dayOf = (bell) => Math.floor(bell / DAY_BELLS);
const isInt = (v) => Number.isInteger(v);
const CAND_ID = /^c\d{1,2}$/;
const SEALING_KINDS = ['march', 'recall'];
const LANG_JA = /[぀-ヿ㐀-鿿]/;

/** Validate the POST /v1/decide body (section 4.1) and return a normalised copy. Throws HttpError 400. */
export function parseDecide(req) {
  const bad = (m) => new HttpError(400, 'BadRequest', m);
  if (!req || typeof req !== 'object') throw bad('body is not an object');
  if (req.v !== 1) throw bad('v must be 1');
  const ai = req.ai;
  if (!ai || !isInt(ai.index) || typeof ai.tag !== 'string' || !/^[0-9a-f]{16}$/.test(ai.tag) || typeof ai.wallet !== 'string') throw bad('ai {index, wallet, tag} required');
  if (!isInt(req.bell) || req.bell < 0) throw bad('bell');
  if (!isInt(req.deadline_unix_ms)) throw bad('deadline_unix_ms');
  if (!req.situation || typeof req.situation !== 'object' || !req.situation.me) throw bad('situation.me required');
  if (!Array.isArray(req.candidates) || req.candidates.length > 12) throw bad('candidates: array of at most 12');
  const ids = new Set();
  for (const c of req.candidates) {
    if (!c || typeof c.id !== 'string' || !CAND_ID.test(c.id) || ids.has(c.id)) throw bad('candidate ids must be unique c1..c12');
    ids.add(c.id);
    if (typeof c.kind !== 'string') throw bad('candidate kind');
  }
  return {
    v: 1,
    ai: { index: ai.index, wallet: ai.wallet, tag: ai.tag },
    bell: req.bell,
    now_game: req.now_game,
    scale: req.scale ?? 10,
    deadline_unix_ms: req.deadline_unix_ms,
    wake_hints: (req.wake_hints ?? []).filter((h) => h === 'W-READY' || h === 'W-QUEUE'),
    obs_digest: req.obs_digest ?? null,
    situation: req.situation,
    candidates: req.candidates,
    own_marches: Array.isArray(req.own_marches) ? req.own_marches : [],
    autopilot: req.autopilot ?? { summary: '', has_military: false, departs: [] },
  };
}

export function createMind(deps) {
  const {
    config, llm, scheduler, gate, records, views, sealed, memoryAttach, prompt, speech, clock, metrics, roster, stores,
    watcher = null, feed = null, upkeep = null, now = Date.now, season = 0, stateDir = null, nameOf = null, nationName = null,
  } = deps;
  const caps = { ...DEFAULT_CAPS, ...(config.caps ?? {}) };
  const maxTokens = config.llm?.max_tokens ?? { session: 384, reaction: 256, reflection: 512, motion: 160, ballot: 160 };
  const alias = config.llm?.alias ?? 'gemma-4-26b-a4b-it';
  const requestShape = config.llm?.request_shape ?? 'response_format';
  const speechLang = config.channel_lang ?? 'ja';
  const decideSlackMs = config.time?.decide_slack_ms ?? 300;
  const cache = new Map();
  const inflight = new Map();
  const lastSituation = new Map(); // tag -> {bell, situation, hostMap} for council calls
  const reflectSeen = new Set();
  const aiStat = (tag, key, n = 1) => metrics.incGroup(`ai:${tag}`, key, n);
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
  if (stateDir) mkdirSync(`${stateDir}/decisions`, { recursive: true });

  const decisionFile = (key) => (stateDir ? `${stateDir}/decisions/${key.replace(':', '-')}.json` : null);
  function persistAnswer(key, answer) {
    const f = decisionFile(key);
    if (!f) return;
    const tmp = `${f}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(answer));
    renameSync(tmp, f);
  }
  function loadAnswer(key) {
    const f = decisionFile(key);
    if (f && existsSync(f)) {
      try {
        return JSON.parse(readFileSync(f, 'utf8'));
      } catch {
        return null;
      }
    }
    return null;
  }

  // ---- helpers ---------------------------------------------------------------------------------
  const quotaLeft = (me) => {
    const q = me?.quota ?? {};
    const xs = [q.bucket_left, q.relay_left].filter((x) => Number.isFinite(x));
    return xs.length ? Math.min(...xs) : null;
  };
  const autopilotId = (cands) => cands.find((c) => kindBase(c.kind) === 'autopilot')?.id ?? null;

  function ensureDayStart(doc, bell, me) {
    const ds = doc.day_start;
    const same = ds && Number.isFinite(ds.bell) && dayOf(ds.bell) === dayOf(bell) && ds.home_troops > 0;
    if (!same) doc.day_start = { bell, home_troops: me.home_troops_day_start ?? me.home_troops ?? 0, march_troops_model: 0 };
  }

  function arriveBellOf(c, params, bell) {
    const f = c.facts ?? {};
    const timing = params?.timing ?? 'earliest';
    if (timing === 'call' && f.strike_bell != null) return f.strike_bell;
    return f.earliest_bell ?? f.strike_bell ?? bell + 2;
  }

  /** Sealed-set entries and release bell for the sends a decision intends (section 7.2, 5.6). */
  function intendedSends({ cands, chosenIds, params, autopilotDeparts, choseAutopilot, bell, member }) {
    const entries = [];
    let release = null;
    let anyMarch = false;
    for (const id of chosenIds) {
      const c = cands.find((x) => x.id === id);
      if (!c || !SEALING_KINDS.includes(kindBase(c.kind))) continue;
      anyMarch = true;
      const arrive = arriveBellOf(c, params[id], bell);
      release = Math.max(release ?? 0, arrive + 1);
      if (kindBase(c.kind) !== 'march') continue; // a recall goes to the own village: nothing secret to seal
      const f = c.facts ?? {};
      const t = f.target ?? {};
      const pqEnt = (c.entities ?? []).find((e) => e.startsWith('pq:'));
      const pq = t.p != null ? [t.p, t.q] : pqEnt ? pqEnt.slice(3).split(',').map(Number) : null;
      if (!pq) continue;
      entries.push({
        host_id: f.host_id != null ? String(f.host_id) : null,
        arrive_bell: arrive,
        pq,
        tile: t.tile ?? null,
        nations: (c.entities ?? []).filter((e) => e.startsWith('nation:')).map((e) => Number(e.slice(7))),
        names: [],
        numbers: [f.enemy_troops, f.hexes].filter((x) => Number.isFinite(x) && x > 0),
        target_kind: f.target_kind ?? null,
        via: 'model',
      });
    }
    if (choseAutopilot) {
      for (const d of autopilotDeparts ?? []) {
        anyMarch = true;
        release = Math.max(release ?? 0, (d.arrive_bell ?? bell + 2) + 1);
        if (d.p != null) entries.push({ host_id: d.host_id != null ? String(d.host_id) : null, arrive_bell: d.arrive_bell ?? bell + 2, pq: [d.p, d.q], tile: d.tile ?? null, nations: [], names: [], numbers: [], target_kind: null, via: d.via ?? 'autopilot' });
      }
    }
    if (member?.call) {
      release = Math.max(release ?? 0, (member.call.strike_bell ?? bell) + 2);
    }
    return { entries, release, sealed: anyMarch || Boolean(member?.call) };
  }

  function sealedForSpeech(own, entries, member) {
    const stored = sealed.list(own.tag);
    const out = [...stored, ...entries];
    if (member?.call) out.push({ pq: [member.call.p, member.call.q], via: 'call' });
    return out.map((e) => ({
      pq: e.pq,
      nations: e.nations ?? [], // integ-A: AC1b's checker also refuses 'nation 3', 'N3' and 国3 (numbers), not only the names
      names: [...(e.names ?? []), ...(e.nations ?? []).map((n) => nationName?.(n, 'en')).filter(Boolean), ...(e.nations ?? []).map((n) => nationName?.(n, 'ja')).filter(Boolean)],
      numbers: e.numbers ?? [],
      kinds: e.target_kind ? [e.target_kind] : [],
    }));
  }

  function talkItems({ say, bell, own, doc, member, itemStart = 0 }) {
    const items = [];
    let item = itemStart;
    for (const m of say) {
      const channel = m.channel === 'world' ? 0 : m.channel === 'nation' ? 1 : 3;
      const seq = own.ledger.nextSeq ? own.ledger.nextSeq('talk', bell) : nextSeqFallback(doc, 'talk', bell);
      const o = { season, bell, seq, channel, kind: 0, ref: 0, origin: 1, lang: LANG_JA.test(m.text) ? 'ja' : 'en', text: m.text, item: item++ };
      if (channel === 1) o.target = own.faction;
      if (channel === 3) o.target = m.__wallet ?? null;
      items.push(o);
    }
    return items;
  }
  function nextSeqFallback(doc, type, bell) {
    doc.seq ??= { talk: 0, ballot: 0 };
    const base = bell * 16;
    const last = doc.seq[type] ?? 0;
    const next = last >= base ? last + 1 : base;
    if (next >= base + 16) throw new Error('more than 16 records of one type in a bell');
    doc.seq[type] = next;
    return next;
  }

  function candidateHostMap(sit) {
    const m = {};
    for (const h of sit.me?.hosts ?? []) m[h.handle] = String(h.host_id);
    return m;
  }

  // ---- the model call (shared by sessions, reactions and council calls) -----------------------------------
  /**
   * Render the prompt, run the llama call under the scheduler and validate V0-V2.
   * Returns {status:'ok', value, menu, rendered, llm} or {status:'fail', reason, rendered?, llm?}.
   */
  async function modelCall({ kind, own, req, bell, deadlineMs, wakes, member, threats, extraFocus = [], council = null }) {
    const doc = ledgerState(own.ledger);
    const pub = views.publicView();
    const rows = pub.inboxRows(own.wallet);
    const hallRows = pub.hallRows(own.faction, 5);
    const inboxTags = [...new Set(rows.map((r) => r.tag).filter(Boolean))];
    const threatNations = [...new Set((threats ?? []).map((t) => t.nation).filter((n) => n != null))];
    const left = messagesCap(own.persona) - (doc.counters?.messages ?? 0);
    const goals = (doc.goals ?? []).filter((g) => g.status !== 'dropped').map((g) => g.id);
    const view = { ...pub, council: () => council ?? pub.council(own.faction) };
    const attach = (budget, handleOf) => {
      return memoryAttach.attach({ ownState: own, request: req, bell, inboxTags, threatNations, budgetTokens: budget, handleOf, extraEntities: extraFocus });
    };
    const rendered = await prompt.render({
      kind, request: req, publicView: view, ownState: own, memberView: member, attach, bell, speechLang, messagesLeft: Math.max(0, left),
      inbox: rows, hall: hallRows, threats, goals: goals.length ? goals : null, memoryBudget: config.memory?.block_tokens ?? 750,
    });
    const schema = buildAnswerSchema(rendered.spec);
    const res = await llmJob({
      kind, index: own.index, bell, deadlineMs, messages: rendered.messages, schemaName: kind, schema, maxTokens: maxTokens[kind] ?? 384,
      onStart: () => {
        if (kind === 'session') gate.noteSession(own.tag, bell, doc.counters);
        else if (kind === 'reaction') gate.noteReaction(bell, doc.counters);
      },
      // V1 (shape) then V2 (menu): a failure of either is retried once with the reason appended
      check: (parsed) => {
        const v1 = validateShape(parsed, rendered.spec);
        if (!v1.ok) return { ok: false, layer: 'V1', why: v1.errors[0] };
        const m = checkMenu(v1.value, { candidates: rendered.candidates, handles: rendered.handles, queueFree: queueFreeOf(req.situation?.me?.queue) });
        if (!m.ok) return { ok: false, layer: 'V2', why: m.error };
        return { ok: true, value: v1.value, menu: m };
      },
    });
    if (res.status === 'fail') return { ...res, rendered };
    const shown = new Set([...rendered.inbox_shown, ...rendered.hall_shown]);
    // FB5 / AC9 F2: the echo list holds what the prompt printed from outside: the texts AND the sender names (a 24-code-point echo of a name)
    const untrusted = [...[...rows, ...hallRows].filter((r) => shown.has(r.id)).map((r) => r.text), ...(rendered.names ?? [])];
    return { ...res, rendered, untrusted };
  }

  /**
   * The generic model job: scheduler admission (EDF, p90), one llama call under the pinned request shape, V0 here,
   * `check(parsed)` for the layers above it, one retry on a V0-V2 failure when time allows. AC1b's reflection job
   * uses it too (kind "reflection", its own schema and check). Returns
   *   {status:'ok', value, menu?, llm:{r, seed, body}, attempts} or {status:'fail', reason, llm?, attempts?, why?}.
   */
  async function llmJob({ kind, index, bell, deadlineMs, messages, schemaName, schema, maxTokens: maxTok, check, onStart = null }) {
    const job = scheduler.submit({
      kind,
      index,
      deadline: deadlineMs,
      run: async ({ signal, deadline }) => {
        onStart?.();
        let msgs = messages;
        let last = null;
        for (let attempt = 0; attempt < 2; attempt++) {
          const seed = mindSeed({ season, index, bell, kind, attempt });
          const body = buildRequestBody({ alias, messages: msgs, schemaName, schema, maxTokens: maxTok, seed, requestShape });
          const remaining = deadline - now();
          if (remaining < 500) return { fail: 'no_time', attempts: attempt + 1, llm: last };
          metrics.inc('llm_calls');
          const r = await llm.complete(body, { deadlineMs: remaining, signal });
          last = { r, seed, body };
          if (!r.ok) return { fail: r.error === 'timeout' || r.error === 'aborted' ? 'timeout' : 'llm_error', llm: last, attempts: attempt + 1 };
          let verdict;
          if (r.finish_reason !== 'stop') verdict = { ok: false, layer: 'V0', why: `the answer was cut off (finish ${r.finish_reason})` };
          else {
            let parsed = null;
            try {
              parsed = JSON.parse(r.content);
            } catch {
              verdict = { ok: false, layer: 'V0', why: 'the answer was not valid JSON' };
            }
            if (!verdict) verdict = check(parsed);
          }
          if (verdict.ok) return { ok: true, value: verdict.value, menu: verdict.menu, llm: last, attempts: attempt + 1 };
          metrics.incGroup('invalid_layer', verdict.layer);
          const canRetry = attempt === 0 && deadline - now() >= 1.2 * scheduler.p50(kind);
          if (!canRetry) return { fail: `invalid:${verdict.layer}`, llm: last, attempts: attempt + 1, why: verdict.why };
          metrics.inc('retries');
          msgs = [messages[0], { role: 'user', content: `${messages[1].content}\n\nYour previous answer was refused: ${verdict.why}. Answer again with one valid JSON object.` }];
        }
        return { fail: 'invalid:V0', llm: last, attempts: 2 };
      },
    });
    const res = await job;
    if (res.status === 'dropped') return { status: 'fail', reason: 'no_time' };
    if (res.status === 'timeout') return { status: 'fail', reason: 'timeout', llm: res.value?.llm };
    if (res.status === 'error') return { status: 'fail', reason: 'llm_error', detail: res.error };
    const v = res.value;
    if (v.fail) return { status: 'fail', reason: v.fail, llm: v.llm, attempts: v.attempts, why: v.why };
    return { status: 'ok', value: v.value, menu: v.menu, llm: v.llm, attempts: v.attempts };
  }

  const queueFreeOf = (q) => (q && Number.isFinite(q.slots) && Number.isFinite(q.busy) ? Math.max(0, q.slots - q.busy) : null);

  // ---- records ------------------------------------------------------------------------------------------
  function buildRecord({ kind, mode, reason, own, R, g, sealedInfo, rendered, out, choice, retrieved, pub, memoryHash, candidatesHash, situationHash, deadlineMs, finishedMs, t0 }) {
    const llmUsed = out?.llm;
    const rec = {
      v: 2,
      ai: own.tag,
      index: own.index,
      bell: R.bell,
      kind,
      mode,
      reason,
      wake: g?.wake ?? [],
      gate_score: g?.score ?? 0,
      sealed: sealedInfo.sealed,
      release_bell: sealedInfo.sealed ? sealedInfo.release : null,
      obs_digest: R.obs_digest,
      situation_hash: situationHash,
      candidates_hash: candidatesHash,
      memory_hash: memoryHash,
      inbox_root: rendered?.inbox_root ?? sha256hex(''),
      prompt_hash: rendered ? sha256Canonical(rendered.messages) : null,
      request_hash: llmUsed?.r ? sha256hex(llmUsed.r.request_body) : null,
      output_hash: llmUsed?.r?.content != null ? sha256hex(llmUsed.r.content) : null,
      attempts: out?.attempts ?? 0,
      seed: llmUsed?.seed ?? null,
      choice,
      retrieved,
      public: pub,
      commit: null,
      latency_ms: llmUsed?.r?.latency_ms ?? (finishedMs - t0),
      deadline_slack_ms: deadlineMs != null ? deadlineMs - finishedMs : null,
      quota_left: quotaLeft(R.situation.me),
      tx: [],
    };
    return rec;
  }

  const emptyChoice = (ids = []) => ({ ids, params: {}, council: null, goal_id: null, mem: [] });
  const emptyPublic = () => ({ say: [], why: null, why_withheld: null });

  // ---- gate-closed or failed step: autopilot ---------------------------------------------------------------
  function autopilotAnswer({ R, own, doc, reason, g, kind = 'autopilot', out = null, rendered = null, member, deadlineMs, t0, mode = 'autopilot' }) {
    const sit = R.situation;
    const apId = autopilotId(R.candidates);
    const departs = R.autopilot?.departs ?? [];
    const sends = intendedSends({ cands: R.candidates, chosenIds: [], params: {}, autopilotDeparts: departs, choseAutopilot: true, bell: R.bell, member });
    const candidatesHash = sha256Canonical(R.candidates);
    const rec = buildRecord({
      kind, mode, reason, own, R, g, sealedInfo: sends, rendered, out,
      choice: emptyChoice(apId ? [apId] : []), retrieved: [], pub: emptyPublic(),
      memoryHash: sha256hex(canonicalJson(ledgerState(own.ledger)), '', ''), candidatesHash, situationHash: sha256Canonical(sit), deadlineMs, finishedMs: now(), t0,
    });
    const { id } = records.add(rec, { candidates: R.candidates, situation: sit, remembered: [], intended: sends.entries, social: {} });
    if (out?.llm?.r) records.saveRequest(id, out.llm.r.request_body);
    metrics.inc('decisions_total');
    metrics.inc('decisions_autopilot');
    metrics.incGroup('autopilot_reason', reason);
    return {
      v: 1,
      decision_id: id,
      mode: 'autopilot',
      reason,
      choice: { ids: apId ? [apId] : [], params: {}, mem: [] },
      standing: liveStanding(doc.standing, R.bell),
      caps: { march_troops_left: null, home_floor: null },
      social: { say: [], motion: null, ballot: null },
    };
  }

  // ---- POST /v1/decide ------------------------------------------------------------------------------------------
  async function decide(rawReq) {
    const R = parseDecide(rawReq);
    const key = `${R.ai.index}:${R.bell}`;
    if (cache.has(key)) {
      metrics.inc('decide_cached');
      return cache.get(key);
    }
    if (inflight.has(key)) {
      metrics.inc('decide_cached');
      return await inflight.get(key);
    }
    const disk = loadAnswer(key);
    if (disk) {
      cache.set(key, disk);
      metrics.inc('decide_cached');
      return disk;
    }
    const p = runDecide(R)
      .then((ans) => {
        cache.set(key, ans);
        persistAnswer(key, ans);
        inflight.delete(key);
        if (cache.size > 5000) cache.delete(cache.keys().next().value);
        return ans;
      })
      .catch((e) => {
        inflight.delete(key);
        throw e;
      });
    inflight.set(key, p);
    return await p;
  }

  async function runDecide(R) {
    const t0 = now();
    clock.observe({ now_game: R.now_game, scale: R.scale }, t0);
    const entry = roster.byIndex(R.ai.index);
    if (!entry || entry.tag !== R.ai.tag || entry.wallet !== R.ai.wallet) throw new HttpError(403, 'NotOnRoster', 'ai is not on the roster');
    const own = views.ownState(R.ai.tag, R.bell);
    const doc = ledgerState(own.ledger);
    doc.counters ??= {};
    rollCounters(doc.counters, R.bell);
    // memory upkeep (integ-A review): trust decay and the daily reset of the model's trust cap on the first step of a game
    // day, the step log and the goal progress (computed by code); never lets a failure reach the decision
    upkeep?.run({ own, doc, bell: R.bell, request: R });
    const sit = R.situation;
    const me = sit.me;
    const ready = roster.ready && me?.home?.final === true;
    if (ready) ensureDayStart(doc, R.bell, me);
    lastSituation.set(own.tag, { bell: R.bell, situation: sit });
    sealed.prune(own.tag, {
      bell: R.bell,
      // without a feed that can say whether the REVEAL is public, an entry is dropped 7 bells after its arrival bell
      // (the release waits for a REVEAL at most 6 bells, section 7.2)
      isPublic: (e) => (feed?.revealed ? Boolean(feed.revealed(e)) : e.arrive_bell != null && R.bell > e.arrive_bell + 7),
      isReleased: (id) => records.getPrivate(id)?.opened === true,
    });
    const member = views.memberView(own.faction);
    sealed.setCall(own.tag, member.call ? { decision_id: 'call', via: 'call', pq: [member.call.p, member.call.q], until_bell: (member.call.strike_bell ?? R.bell) + 2 } : null);

    // W-REFLECT (section 3.2): the first step at or after bell mod reflect_every == 0 asks AC1b's reflection job to run;
    // it is its own job and consumes no session or reaction budget
    if (ready && config.memory?.reflection !== false) {
      const every = config.memory?.reflect_every ?? 72;
      const slot = Math.floor(R.bell / every);
      const k = `${own.tag}:${slot}`;
      if (slot > 0 && !reflectSeen.has(k)) {
        reflectSeen.add(k);
        metrics.inc('reflect_due');
        emit({ type: 'reflect_due', tag: own.tag, index: own.index, bell: R.bell, slot });
      }
    }
    // wakes: the watcher (feed + social + clock events), the brain's hints
    const watcherWakes = watcher?.wakeEvents?.(own.tag, R.bell) ?? [];
    const wakes = normaliseWakes([...watcherWakes, ...R.wake_hints]);
    const threats = watcherWakes.filter((w) => w && typeof w === 'object' && w.code === 'W-THREAT' && w.facts).map((w) => w.facts);
    const g = gate.decide({ tag: own.tag, bell: R.bell, endBell: me.end_bell ?? sit.end_bell, ready, wakes, counters: doc.counters });
    const deadlineMs = R.deadline_unix_ms - decideSlackMs;
    metrics.incGroup('gate', g.mode === 'autopilot' ? `autopilot:${g.reason}` : g.mode);
    if (g.mode === 'autopilot') return finishAutopilot({ R, own, doc, reason: g.reason, g, member, deadlineMs, t0 });
    let cursor = feed?.cursorBell?.();
    if (cursor != null && cursor < R.bell - 1 && feed?.waitCursor) {
      // integ-A: the brain steps at the start of the bell; give the feed a few seconds to vouch for bell - 1 (never past the model's time)
      metrics.inc('feed_wait');
      await feed.waitCursor(R.bell - 1, Math.max(0, Math.min(6000, deadlineMs - now() - 15000)));
      cursor = feed.cursorBell();
    }
    if (cursor != null && cursor < R.bell - 1) {
      metrics.inc('feed_lag');
      return finishAutopilot({ R, own, doc, reason: 'feed_lag', g, member, deadlineMs, t0 });
    }
    const kind = g.mode; // session | reaction
    metrics.inc('model_decisions');
    aiStat(own.tag, 'decisions');
    const out = await modelCall({ kind, own, req: R, bell: R.bell, deadlineMs, wakes, member, threats });
    const finishedMs = now();
    if (out.status === 'fail') {
      metrics.incGroup('fallback_reason', out.reason);
      return finishAutopilot({ R, own, doc, reason: out.reason, g, member, deadlineMs, t0, kind, out, rendered: out.rendered });
    }
    if (finishedMs > R.deadline_unix_ms) {
      metrics.incGroup('fallback_reason', 'late');
      return finishAutopilot({ R, own, doc, reason: 'late', g, member, deadlineMs, t0, kind, out, rendered: out.rendered });
    }
    return finalizeModel({ R, own, doc, g, kind, out, member, deadlineMs, finishedMs, t0, threats });
  }

  function finishAutopilot(a) {
    const ans = autopilotAnswer({ ...a, kind: a.kind ?? 'autopilot' });
    a.out?.llm?.r && metrics.latency(a.kind ?? 'session', a.out.llm.r.latency_ms, a.deadlineMs - now());
    return ans;
  }

  function finalizeModel({ R, own, doc, g, kind, out, member, deadlineMs, finishedMs, t0, threats }) {
    const rendered = out.rendered;
    const value = out.value;
    const cands = rendered.candidates;
    const sit = R.situation;
    const me = sit.me;
    const hostMap = candidateHostMap(sit);
    let chosen = out.menu.chosen;
    const params = out.menu.params;
    if (out.menu.stray) metrics.inc('params_stray_dropped', out.menu.stray);
    if (out.menu.mem.dropped) metrics.inc('mem_dropped', out.menu.mem.dropped);

    // V3 caps
    const capRes = applyCaps({ chosen, candidates: cands, homeTroops: me.home_troops ?? 0, dayStart: doc.day_start, marchesToday: doc.counters.marches ?? 0, caps });
    for (const d of capRes.dropped) metrics.incGroup('v3_drop', d.rule);
    chosen = capRes.kept;
    const memoryHash = sha256hex(canonicalJson(ledgerState(own.ledger)), rendered.retrieved.join(','), own.summary?.sha256 ?? '');
    const candidatesHash = sha256Canonical(cands);
    const situationHash = sha256Canonical(sit);
    if (kind === 'session' && !chosen.length) {
      metrics.incGroup('fallback_reason', 'invalid:V3');
      return finishAutopilot({ R, own, doc, reason: 'invalid:V3', g, member, deadlineMs, t0, kind, out, rendered });
    }

    // what this decision intends to send (marches seal the record and the text of this very decision)
    const choseAutopilot = chosen.length === 1 && kindBase(cands.find((c) => c.id === chosen[0])?.kind) === 'autopilot';
    const sends = intendedSends({ cands, chosenIds: chosen, params, autopilotDeparts: R.autopilot?.departs ?? [], choseAutopilot: choseAutopilot || (kind === 'reaction'), bell: R.bell, member });

    // V5 / V5b on say and why
    const memEpisodes = out.menu.mem.ids.map((id) => own.episodes?.get?.(id)).filter(Boolean);
    const allEpisodes = rendered.retrieved.map((id) => own.episodes?.get?.(id)).filter(Boolean);
    const sealedForText = sealedForSpeech(own, sends.entries, member);
    const speechCtx = {
      kind, lang: speechLang, speechLang,
      promptText: rendered.messages[1].content,
      facts: JSON.stringify(cands.map((c) => c.facts ?? {})),
      episodeTexts: allEpisodes.map((e) => `${e.text?.en ?? ''} ${e.text?.ja ?? ''}`),
      citedTexts: memEpisodes.map((e) => `${e.text?.en ?? ''} ${e.text?.ja ?? ''}`),
      sealed: sealedForText,
      mem: out.menu.mem.ids,
      inFlight: sealed.list(own.tag).some((e) => e.via !== 'call') || sends.entries.length > 0,
      sealedRecord: sends.sealed, // R2: the why of a sealed record is published only at its release
      untrusted: out.untrusted ?? [],
    };
    const messagesLeft = Math.max(0, messagesCap(own.persona) - (doc.counters.messages ?? 0));
    const sp = applySpeech({ value, speech, ctx: speechCtx, messagesLeft, kind });
    for (const [r, n] of Object.entries(sp.drops)) metrics.incGroup('speech_drop', r, n);
    if (sp.why_withheld) metrics.incGroup('why_withheld', sp.why_withheld);
    // direct targets: handle -> wallet
    const people = rendered.people;
    for (const m of sp.say) if (m.channel === 'direct') m.__wallet = people.byHandle[m.to]?.wallet ?? null;
    const sayDirectOk = sp.say.filter((m) => m.channel !== 'direct' || m.__wallet);

    // trust deltas (handles -> tags; N<f> -> nation:<f>)
    const deltas = [];
    for (const t of value.trust ?? []) {
      const who = /^N\d$/.test(t.who) ? `nation:${t.who.slice(1)}` : people.byHandle[t.who]?.tag;
      if (who) deltas.push({ who, delta: t.delta });
    }
    if (deltas.length && typeof own.ledger.applyModelDeltas === 'function') own.ledger.applyModelDeltas(deltas, { bell: R.bell });

    // ledger bookkeeping
    const sealedDecision = sends.sealed;
    const sayKept = sayDirectOk;
    if (sealedDecision && sayKept.length) metrics.inc('say_withheld', sayKept.length);
    const postable = sealedDecision ? [] : sayKept;
    doc.counters.messages = (doc.counters.messages ?? 0) + postable.length;
    doc.counters.marches = (doc.counters.marches ?? 0) + capRes.marches;
    doc.day_start.march_troops_model = (doc.day_start.march_troops_model ?? 0) + capRes.sent;
    updateStanding(doc.standing ??= { reserved: [], declined_calls: [] }, { bell: R.bell, candidates: cands, chosenIds: chosen, hosts: me.hosts ?? [], callPeriod: member.call?.period ?? null });
    const declined = declinedPeriods(cands, chosen, member.call?.period ?? null);
    for (const period of declined) {
      metrics.inc('calls_declined');
      aiStat(own.tag, 'strikes_declined');
      emit({ type: 'call_declined', tag: own.tag, bell: R.bell, period });
    }
    if (out.menu.mem.ids.length) {
      metrics.inc('decisions_citing_memory');
      for (const e of memEpisodes) metrics.citedAge(R.bell - e.bell);
    }
    stores.save?.(own.tag);

    // the answer
    const marchedIds = chosen.filter((id) => kindBase(cands.find((c) => c.id === id)?.kind) === 'march');
    const apId = autopilotId(cands);
    const answerIds = kind === 'reaction' ? (apId ? [apId] : []) : chosen;
    const choice = { ids: kind === 'reaction' ? [] : chosen, params: kind === 'reaction' ? {} : params, council: null, goal_id: value.goal_id, mem: out.menu.mem.ids };
    const pub = { say: sayKept.map((m) => m.text), why: sp.why, why_withheld: sp.why_withheld };
    const rec = buildRecord({
      kind, mode: 'model', reason: 'ok', own, R, g, sealedInfo: sends, rendered, out, choice, retrieved: rendered.retrieved, pub,
      memoryHash, candidatesHash, situationHash, deadlineMs: deadlineMs, finishedMs, t0,
    });
    const items = talkItems({ say: postable, bell: R.bell, own, doc, member });
    stores.save?.(own.tag);
    const remembered = memEpisodes.map((e) => ({ id: e.id, bell: e.bell, text: e.text }));
    const { id } = records.add(rec, {
      candidates: cands, situation: sit, remembered, intended: sends.entries, focus: rendered.focus ?? null,
      social: { talk: items.map((i) => ({ item: i.item, kind: 0, channel: i.channel, target: i.target ?? null, text: i.text, lang: i.lang, ref: 0, bell: i.bell, seq: i.seq })) },
    });
    records.saveRequest(id, out.llm.r.request_body);
    metrics.inc('decisions_total');
    metrics.inc('decisions_model');
    metrics.inc('valid_choices');
    aiStat(own.tag, 'valid');
    metrics.latency(kind, out.llm.r.latency_ms, deadlineMs - finishedMs);
    if (marchedIds.length) {
      metrics.inc('model_marches', marchedIds.length);
      aiStat(own.tag, 'model_marches', marchedIds.length);
    }
    if (postable.length) aiStat(own.tag, 'messages', postable.length);
    if (out.menu.mem.ids.length) aiStat(own.tag, 'decisions_citing_memory');
    if (out.menu.mem.dropped) aiStat(own.tag, 'mem_dropped', out.menu.mem.dropped);
    return {
      v: 1,
      decision_id: id,
      mode: 'model',
      reason: 'ok',
      choice: { ids: answerIds, params: kind === 'reaction' ? {} : params, mem: out.menu.mem.ids },
      standing: liveStanding(doc.standing, R.bell),
      caps: capRes.capsNow,
      social: { say: items, motion: null, ballot: null },
    };
  }

  // ---- POST /v1/outcome -----------------------------------------------------------------------------------
  function outcome(body) {
    if (!body || typeof body.decision_id !== 'string') throw new HttpError(400, 'BadRequest', 'decision_id required');
    const r = records.attachOutcome(body.decision_id, body);
    if (!r.ok) throw new HttpError(404, 'UnknownDecision', r.error);
    const priv = records.getPrivate(body.decision_id);
    // confirmed sends add their targets to the sealed set (section 5.6)
    if (priv) {
      const sentMarch = (body.actions ?? []).some((a) => (a.intent === 'depart' || a.intent === 'march' || a.intent === 'recall') && a.status === 'sent');
      const entries = (priv.priv.intended ?? []).map((e) => ({ ...e, decision_id: body.decision_id }));
      if (sentMarch && entries.length) sealed.add(priv.full.ai, entries);
      metrics.inc('outcomes');
      if (r.late) metrics.inc('outcomes_late');
      const sentN = (body.actions ?? []).filter((x) => x.status === 'sent').length;
      if (sentN) aiStat(priv.full.ai, priv.full.mode === 'model' ? 'actions_by_model' : 'actions_by_autopilot', sentN);
    }
    return { ok: true };
  }

  // ---- POST /v1/brain-stats (AC10a, R5 and R6): the brain's own counters ------------------------------------------------
  // The brain (bots/src/ai) counts, per AI, its steps, the steps that made no mind call (`no_session`: no home holding or no session,
  // contract 3.1, 7.2) and the herald GETs it makes itself, by kind (`gets:<kind>`; R6). Nothing on the mind's side can see these:
  // a no_session step leaves no record. The brain posts its CUMULATIVE counters per AI about once a bell; the mind keeps the latest
  // per AI (a lower `steps` than the stored one is a stale or out-of-order post and is ignored), and /v1/metrics and
  // PUB/metrics/latest.json carry them in `brain` (per AI by tag, and totals), which the report reads (10.1).
  const brain = new Map(); // index -> {tag, counters, bell, received}
  let brainPosts = 0;
  const COUNTER_KEY = /^[a-z][a-z0-9_:.]{0,47}$/;
  function brainStats(body) {
    if (!body || typeof body !== 'object' || body.v !== 1) throw new HttpError(400, 'BadRequest', 'v: 1 required');
    if (!Number.isInteger(body.index)) throw new HttpError(400, 'BadRequest', 'index must be an integer');
    const c = body.counters;
    if (!c || typeof c !== 'object' || Array.isArray(c)) throw new HttpError(400, 'BadRequest', 'counters must be an object');
    const keys = Object.keys(c);
    if (keys.length > 96) throw new HttpError(400, 'BadRequest', 'at most 96 counters');
    for (const k of keys) {
      if (!COUNTER_KEY.test(k)) throw new HttpError(400, 'BadRequest', `counter name ${JSON.stringify(k).slice(0, 60)} is not allowed`);
      if (!Number.isSafeInteger(c[k]) || c[k] < 0) throw new HttpError(400, 'BadRequest', `counter ${k} must be a non-negative integer`);
    }
    const entry = roster.byIndex(body.index);
    if (!entry) throw new HttpError(404, 'UnknownAi', `no AI citizen with index ${body.index}`);
    const prev = brain.get(body.index);
    if (prev && (c.steps ?? 0) < (prev.counters.steps ?? 0)) {
      metrics.inc('brain_stats_stale');
      return { ok: true, applied: false };
    }
    brain.set(body.index, { tag: entry.tag, counters: { ...c }, bell: Number.isInteger(body.bell) ? body.bell : null, received: (prev?.received ?? 0) + 1 });
    brainPosts += 1;
    return { ok: true, applied: true };
  }
  /** The `brain` block of the metrics snapshot: per AI and in total, with GETs per step. Absent until the first post. */
  function brainSnapshot() {
    if (!brain.size) return {};
    const round = (x) => Math.round(x * 1000) / 1000;
    const perAi = {};
    const totals = Object.create(null); // a counter may be named `constructor` or `valueof`: no inherited property may answer for it
    for (const [, e] of [...brain].sort((a, b) => a[0] - b[0])) {
      const getsTotal = Object.entries(e.counters).filter(([k]) => k.startsWith('gets:')).reduce((n, [, v]) => n + v, 0);
      const steps = e.counters.steps ?? 0;
      perAi[e.tag] = { ...e.counters, gets_total: getsTotal, gets_per_step: steps ? round(getsTotal / steps) : null, bell: e.bell, posts: e.received };
      for (const [k, v] of Object.entries(e.counters)) totals[k] = (totals[k] ?? 0) + v;
    }
    const getsTotal = Object.entries(totals).filter(([k]) => k.startsWith('gets:')).reduce((n, [, v]) => n + v, 0);
    const steps = totals.steps ?? 0;
    return {
      brain: {
        ais_reporting: brain.size,
        posts: brainPosts,
        totals: { ...totals, gets_total: getsTotal, gets_per_step: steps ? round(getsTotal / steps) : null, no_session_share: steps ? round((totals.no_session ?? 0) / steps) : null },
        per_ai: perAi,
        note: 'cumulative counters posted by the brain (bots/src/ai); gets:* are herald GETs counted at the brain\'s own call sites, gets:reobserve_* are lower bounds (the files a re-observe returned)',
      },
    };
  }

  // ---- council calls (motion, ballot) driven by the watcher --------------------------------------------------
  /**
   * councilCall({tag, kind: 'motion'|'ballot', period, faction, deadline_unix_ms, bell, options?}) ->
   *   {decision_id, mode, reason, social:{motion, ballot}} . Idempotent per (index, kind, period).
   * The situation is the one the AI's last decide step sent; without one the AI answers autopilot ("not_ready").
   */
  async function councilCall({ tag, kind, period, deadline_unix_ms, bell }) {
    if (kind !== 'motion' && kind !== 'ballot') throw new HttpError(400, 'BadRequest', 'kind must be motion or ballot');
    const entry = roster.byTag(tag);
    if (!entry) throw new HttpError(403, 'NotOnRoster', 'unknown ai');
    const key = `council:${entry.index}:${kind}:${period}`;
    if (cache.has(key)) return cache.get(key);
    if (inflight.has(key)) return inflight.get(key);
    const p = runCouncil({ entry, kind, period, deadline_unix_ms, bell })
      .then((a) => {
        cache.set(key, a);
        inflight.delete(key);
        return a;
      })
      .catch((e) => {
        inflight.delete(key);
        throw e;
      });
    inflight.set(key, p);
    return p;
  }

  async function runCouncil({ entry, kind, period, deadline_unix_ms, bell }) {
    const t0 = now();
    const own = views.ownState(entry.tag, bell);
    const doc = ledgerState(own.ledger);
    doc.counters ??= {};
    rollCounters(doc.counters, bell);
    const last = lastSituation.get(own.tag);
    const council = views.publicView().council(own.faction);
    const member = views.memberView(own.faction);
    const deadlineMs = deadline_unix_ms - decideSlackMs;
    const R = { v: 1, ai: { index: own.index, wallet: own.wallet, tag: own.tag }, bell, obs_digest: null, situation: last?.situation ?? { bell, me: { faction: own.faction } }, candidates: [], own_marches: [], autopilot: { departs: [], summary: '' }, wake_hints: [] };
    const g = { mode: kind, reason: 'ok', score: 0, wake: ['W-COUNCIL'] };
    const fail = (reason, out = null) => {
      const sends = intendedSends({ cands: [], chosenIds: [], params: {}, autopilotDeparts: [], choseAutopilot: false, bell, member });
      const rec = buildRecord({ kind, mode: 'autopilot', reason, own, R, g, sealedInfo: sends, rendered: out?.rendered ?? null, out, choice: emptyChoice(), retrieved: [], pub: emptyPublic(), memoryHash: sha256hex(canonicalJson(ledgerState(own.ledger)), '', ''), candidatesHash: sha256Canonical([]), situationHash: sha256Canonical(R.situation), deadlineMs, finishedMs: now(), t0 });
      const { id } = records.add(rec, { candidates: [], situation: R.situation, remembered: [], intended: [], social: {} });
      metrics.inc('decisions_total');
      metrics.inc('decisions_autopilot');
      metrics.incGroup('autopilot_reason', reason);
      return { decision_id: id, mode: 'autopilot', reason, social: { motion: null, ballot: null } };
    };
    if (!council || !council.options?.length) return fail('not_ready');
    if (!last) return fail('not_ready');
    let cursor = feed?.cursorBell?.();
    if (cursor != null && cursor < bell - 1 && feed?.waitCursor) {
      metrics.inc('feed_wait');
      await feed.waitCursor(bell - 1, Math.max(0, Math.min(6000, deadlineMs - now() - 15000)));
      cursor = feed.cursorBell();
    }
    if (cursor != null && cursor < bell - 1) {
      // integ-B: the watcher asks at the first second of a window bell, when the chain's block time has not crossed the bell boundary and the feed
      // cannot vouch for bell - 1 yet (live: all 5 ballot calls of the I-A smoke came back feed_lag and were final for the period). While there is
      // time left before the deadline this is a retryable error (no record, no cache); only past that is it the autopilot answer.
      if (now() < deadlineMs - 20000) { const e = new Error('feed_lag: retry'); e.retry = true; throw e; }
      metrics.inc('feed_lag');
      return fail('feed_lag');
    }
    metrics.inc('model_decisions');
    aiStat(own.tag, 'decisions');
    const extraFocus = council.options.map((o) => `pq:${o.p},${o.q}`);
    const out = await modelCall({ kind, own, req: R, bell, deadlineMs, wakes: [], member, threats: [], extraFocus, council });
    if (out.status === 'fail') {
      metrics.incGroup('fallback_reason', out.reason);
      return fail(out.reason, out);
    }
    const finishedMs = now();
    const value = out.value;
    const rendered = out.rendered;
    const memEpisodes = out.menu.mem.ids.map((id) => own.episodes?.get?.(id)).filter(Boolean);
    const sends = intendedSends({ cands: [], chosenIds: [], params: {}, autopilotDeparts: [], choseAutopilot: false, bell, member });
    const sealedForText = sealedForSpeech(own, [], member);
    const sp = applySpeech({ value, speech, ctx: { kind, lang: speechLang, speechLang, promptText: rendered.messages[1].content, facts: JSON.stringify(council.options), episodeTexts: rendered.retrieved.map((id) => own.episodes?.get?.(id)).filter(Boolean).map((e) => `${e.text?.en ?? ''} ${e.text?.ja ?? ''}`), sealed: sealedForText, mem: out.menu.mem.ids, inFlight: sealed.list(own.tag).length > 0, sealedRecord: sends.sealed, untrusted: out.untrusted ?? [] }, messagesLeft: Math.max(0, messagesCap(own.persona) - (doc.counters.messages ?? 0)), kind });
    for (const [r, n] of Object.entries(sp.drops)) metrics.incGroup('speech_drop', r, n);
    const opts = new Map(council.options.map((o) => [o.option, o]));
    let social = { motion: null, ballot: null };
    let postable = [];
    const items = [];
    if (kind === 'motion') {
      const option = value.council.motion;
      if (option > 0 && opts.has(option)) {
        const text = sp.say[0]?.text ?? (speechLang === 'ja' ? `選択肢${option}を提案します。` : `I move option ${option}.`);
        const seq = own.ledger.nextSeq ? own.ledger.nextSeq('talk', bell) : nextSeqFallback(doc, 'talk', bell);
        social.motion = { season, bell, seq, channel: 1, target: own.faction, kind: 1, ref: period * 256 + option, origin: 1, lang: LANG_JA.test(text) ? 'ja' : 'en', text, item: 0 };
        items.push({ item: 0, kind: 1, channel: 1, target: own.faction, text, lang: social.motion.lang, ref: social.motion.ref, bell, seq });
        postable = [social.motion];
      }
    } else {
      const option = value.council.ballot;
      const nonce = randomBytes(16).toString('hex');
      social.ballot = { season, period, faction: own.faction, option, candidates_hash: council.candidates_hash ?? null, nonce, origin: 1, item: 0 };
      items.push({ item: 0, type: 'ballot', option, period, nonce });
    }
    const sealedDecision = sends.sealed;
    if (sealedDecision && social.motion) {
      // a decision made while the nation has a live Strike Order is sealed: its public text waits for the release
      metrics.inc('say_withheld');
      social.motion = null;
      postable = [];
    }
    doc.counters.messages = (doc.counters.messages ?? 0) + postable.length;
    stores.save?.(own.tag);
    const choice = { ids: [], params: {}, council: kind === 'motion' ? { motion: value.council.motion } : { ballot: value.council.ballot }, goal_id: value.goal_id, mem: out.menu.mem.ids };
    const rec = buildRecord({ kind, mode: 'model', reason: 'ok', own, R, g, sealedInfo: sends, rendered, out, choice, retrieved: rendered.retrieved, pub: { say: sp.say.map((m) => m.text), why: sp.why, why_withheld: sp.why_withheld }, memoryHash: sha256hex(canonicalJson(ledgerState(own.ledger)), rendered.retrieved.join(','), own.summary?.sha256 ?? ''), candidatesHash: sha256Canonical(council.options), situationHash: sha256Canonical(R.situation), deadlineMs, finishedMs, t0 });
    const social2 = kind === 'ballot' ? { ballot: items.map(({ type, ...b }) => b) } : { talk: items };
    const { id } = records.add(rec, { candidates: council.options, situation: R.situation, remembered: memEpisodes.map((e) => ({ id: e.id, bell: e.bell, text: e.text })), intended: [], focus: rendered.focus ?? null, social: social2 });
    records.saveRequest(id, out.llm.r.request_body);
    metrics.inc('decisions_total');
    metrics.inc('decisions_model');
    metrics.inc('valid_choices');
    aiStat(own.tag, 'valid');
    if (postable.length) aiStat(own.tag, 'messages', postable.length);
    if (out.menu.mem.ids.length) aiStat(own.tag, 'decisions_citing_memory');
    metrics.latency(kind, out.llm.r.latency_ms, deadlineMs - finishedMs);
    return { decision_id: id, mode: 'model', reason: 'ok', social };
  }

  // ---- health, metrics -----------------------------------------------------------------------------------------
  async function health() {
    const up = await llm.health();
    return {
      ok: true,
      llm: { url: llm.url, alias: llm.alias, up },
      queue: scheduler.queueState(),
      roster: { ready: roster.ready, n: roster.ai.length },
      bell: clock.bell(),
      speech: speech?.stub ? 'stub' : 'real', // integ-A: AC1b's checker says stub: false; there is no stub left
    };
  }

  return {
    decide,
    outcome,
    brainStats,
    councilCall,
    llmJob,
    health,
    metrics: () => metrics.snapshot({ bell: clock.bell(), extra: { records: records.stats(), scheduler: scheduler.latencies(), scheduler_counters: scheduler.counters, ...brainSnapshot(), ...(speech?.counts ? { speech: speech.counts() } : {}) } }), // integ-A: AC1b's per-word withhold counts (word-list refusals, uncited memory claims) for 10.1
    subscribe: (fn) => listeners.push(fn),
    lastSituation: (tag) => lastSituation.get(tag) ?? null,
    /** per-AI counters for the Wyll card stats block (section 2.4): decisions, valid, actions_by_model, actions_by_autopilot, model_marches, messages, strikes_declined, decisions_citing_memory, mem_dropped */
    statsOf: (tag) => ({ decisions: 0, valid: 0, actions_by_model: 0, actions_by_autopilot: 0, model_marches: 0, messages: 0, strikes_declined: 0, decisions_citing_memory: 0, mem_dropped: 0, ...metrics.group(`ai:${tag}`) }),
    _cache: cache,
  };
}

// ---- HTTP layer ---------------------------------------------------------------------------------------------------
const MAX_BODY = 512 * 1024;

export function createMindHttp(mind, { token, timingSafeEqual = null } = {}) {
  const tokenBuf = Buffer.from(token ?? '');
  const authOk = (h) => {
    const m = /^Bearer (.+)$/.exec(h ?? '');
    if (!m) return false;
    const got = Buffer.from(m[1]);
    if (got.length !== tokenBuf.length) return false;
    return createHash('sha256').update(got).digest('hex') === createHash('sha256').update(tokenBuf).digest('hex');
  };
  const send = (res, status, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' });
    res.end(body);
  };
  const readBody = (req) =>
    new Promise((resolve, reject) => {
      const chunks = [];
      let n = 0;
      req.on('data', (c) => {
        n += c.length;
        if (n > MAX_BODY) {
          reject(new HttpError(413, 'TooLarge', 'body too large'));
          req.destroy();
        } else chunks.push(c);
      });
      req.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'));
        } catch {
          reject(new HttpError(400, 'BadJson', 'body is not JSON'));
        }
      });
      req.on('error', reject);
    });
  return async function handler(req, res) {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (!authOk(req.headers.authorization)) return send(res, 401, { error: 'Unauthorized', code: 'Unauthorized' });
      if (req.method === 'POST' && url.pathname === '/v1/decide') return send(res, 200, await mind.decide(await readBody(req)));
      if (req.method === 'POST' && url.pathname === '/v1/outcome') return send(res, 200, mind.outcome(await readBody(req)));
      if (req.method === 'POST' && url.pathname === '/v1/brain-stats') return send(res, 200, mind.brainStats(await readBody(req)));
      if (req.method === 'GET' && url.pathname === '/v1/health') return send(res, 200, await mind.health());
      if (req.method === 'GET' && url.pathname === '/v1/metrics') return send(res, 200, mind.metrics());
      return send(res, 404, { error: 'NotFound', code: 'NotFound' });
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.code, code: e.code, detail: e.message });
      return send(res, 500, { error: 'Internal', code: 'Internal', detail: String(e?.message ?? e).slice(0, 200) });
    }
  };
}
