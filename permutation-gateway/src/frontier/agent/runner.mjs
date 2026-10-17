// The operator's agent runner (docs/agent-wallet/DESIGN.md §7): for every
// agent in auto mode, each tick a decider picks one action and the gateway
// submits it with source 'ai'. The decider is either the rule autopilot
// (free: the owner's decision of 2026-10-17) or a local model
// (citizens/mind/llm.mjs; one fixed test price per call, charged whether
// the call succeeds or not, through AgentGateway.meterInference).
//
// As the AI citizens: the code offers a short list of legal, cheap
// candidates, the model chooses, the code checks the choice; a late,
// invalid or refused answer falls back to the autopilot. The model never
// sees a key or a token; it sees the agent's public view only.
import { createHash, randomUUID } from 'node:crypto';
import { decodeAccount } from '../../../client/src/frontier/codec.mjs';
import { AgentError, ERR, MODES } from './contract.mjs';

/** The game's turn: 600 s of chain time (web clock.mjs BELL_SECS). */
export const BELL_SECS = 600;
const sha = s => createHash('sha256').update(s).digest('hex').slice(0, 16);
const jsonOf = v => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? String(x) : x instanceof Uint8Array ? Buffer.from(x).toString('hex') : x));

/**
 * The fields of an account that mean something happened to the village,
 * and not the counters a quiet turn moves (a province's RESOLVED_NEXT and
 * its summary move every bell whether or not anything happened there; the
 * event sequence moves with them). Hashing the whole bytes made every turn
 * an "event" (seen in run agent-e2e-5), so a change is read from these.
 */
export const DIGEST_FIELDS = Object.freeze({
  Holding: ['STATE', 'TIER', 'FLAGS', 'OWNER_CITIZEN', 'HOST_SEQ', 'SHIELD_UNTIL', 'STORES', 'PRODUCTION', 'UPKEEP', 'QUEUE', 'WALLS', 'FOOD_SHORTFALL', 'RESERVE', 'TRANSIT', 'EXPLORE', 'FINAL_TS'],
  Province: ['ENTRIES', 'N_ENTRIES', 'CAMP', 'SITE_MIRROR', 'N_SITES_USED', 'TICKET_COHORTS', 'EXPLORED_MASK', 'RELATIONS', 'OPENED_BELL'],
  Citizen: ['SESSION', 'SESSION_EXPIRY', 'FLAGS', 'HOLDING', 'HOLDINGS_N', 'TICKET_BELL', 'TICKET_SITES', 'WORKS', 'EXPLORES', 'ARRIVALS', 'VIGIL_START_MIN'],
});

/** The digest of one decoded account over its meaningful fields (DIGEST_FIELDS), or of the raw bytes when it cannot be decoded. */
export function accountDigest(kind, bytes) {
  try {
    const d = decodeAccount(kind, bytes);
    return sha(jsonOf(DIGEST_FIELDS[kind].map(k => d[k])));
  } catch { return sha(Buffer.from(bytes).toString('base64')); }
}

/**
 * What the agent may look at between calls: the same public records the
 * owner's browser reads from the herald — the season (its bell), the
 * owner's Citizen and the village's Holding (`/h/me`), the village's
 * province (`/h/province`). Nothing private, nothing of other players
 * beyond what the province envelope shows everyone. The observation is
 * reduced to digests of the raw account bytes: the economy is lazy (a
 * Holding changes only when touched), so "the bytes changed" is "something
 * happened to the village", and a bell is a turn.
 */
export class AgentObserver {
  constructor({ heraldUrl, fetch: f = (...a) => globalThis.fetch(...a), timeoutMs = 5_000 }) {
    this.base = String(heraldUrl).replace(/\/+$/, '');
    this.fetch = f;
    this.timeoutMs = timeoutMs;
  }

  async #json(path) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      const r = await this.fetch(this.base + path, { signal: ac.signal });
      if (!r.ok) return null;
      return await r.json();
    } catch { return null; } finally { clearTimeout(t); }
  }

  /** `{ok, bell, latestUnix, holding, province, citizen}` (digests) for the owner's village, or `{ok: false}`. */
  async observe({ owner, village: [p, q, site] }) {
    const [season, me, province] = await Promise.all([this.#json('/h/season'), this.#json(`/h/me/${owner}`), this.#json(`/h/province/${p},${q}/latest`)]);
    if (!season || !me) return { ok: false };
    const genesis = Number(season.genesisTs);
    const latestUnix = Number(season.latestUnix);
    const bell = latestUnix < genesis ? null : Math.floor((latestUnix - genesis) / BELL_SECS);
    let holding = null;
    for (const h of me.holdings ?? []) {
      if (!h?.bytes_b64) continue;
      const bytes = Buffer.from(h.bytes_b64, 'base64');
      try {
        const d = decodeAccount('Holding', bytes);
        if (Number(d.P) === p && Number(d.Q) === q && Number(d.SITE) === site) { holding = accountDigest('Holding', bytes); break; }
      } catch { /* not a holding */ }
    }
    const citizen = me.citizen?.bytes_b64 ? accountDigest('Citizen', Buffer.from(me.citizen.bytes_b64, 'base64')) : null;
    // (the province: its account over the fields that mean an arrival, a camp, a site taken; and the arrival slots' keys, not their bytes)
    const pb = province?.province?.bytes_b64 ?? province?.province?.bytes ?? null;
    const prov = pb ? sha(accountDigest('Province', Buffer.from(pb, 'base64')) + '|' + (province.slots ?? []).map(s => s.key ?? '').sort().join(',')) : null;
    return { ok: true, bell, latestUnix, holding, province: prov, citizen };
  }
}

/**
 * Why an agent is asked now: compared with the last call's observation.
 *   owner   the owner changed the policy or the mode (always asked, even inside the minimum gap)
 *   result  an action of the agent's got its answer since (the ledger's history grew by an action/spend line)
 *   event   the village's Holding, its province or the Citizen changed on chain
 *   turn    the bell moved (a new turn), nothing else
 * No trigger: the model is not called (a repeat answer on the same state is what cost a daily limit, DESIGN.md §12).
 */
export function triggersOf(obs, view, last) {
  const out = [];
  if (!last) return ['first'];
  if (view.policy.version !== last.policyVersion || view.modeEpoch !== last.modeEpoch) out.push('owner');
  if ((view.historyLength ?? view.history?.length ?? 0) !== last.historyLength && (view.history ?? []).slice(last.historyLength ?? 0).some(h => h.type === 'action' && h.source !== 'ai')) out.push('result');
  if (obs.holding !== last.holding || obs.province !== last.province || obs.citizen !== last.citizen) out.push('event');
  if (obs.bell !== last.bell) out.push('turn');
  return out;
}

/** Actions a decider may choose, with the JSON fields each takes (small, no seals, no marches). */
export const CANDIDATES = Object.freeze({
  Harvest: Object.freeze({}),
  Train: Object.freeze({ unit: 'u8', n: 'u32' }),
  Build: Object.freeze({ item: 'u8' }),
  SetVigil: Object.freeze({ start_min: 'u16' }),
});

/** The rule autopilot: harvests the village when it may; otherwise rests. Free. */
export function ruleDecider() {
  return {
    name: 'autopilot', free: true,
    async decide(view) {
      if (view.policy.allowed.includes('Harvest')) return { name: 'Harvest', fields: {} };
      return null;
    },
  };
}

/** The JSON schema the model must answer with: one of `names`, its fields, a one-line reason. */
export function decisionSchema(names) {
  return {
    type: 'object', additionalProperties: false, required: ['action', 'fields', 'reason'],
    properties: {
      action: { type: 'string', enum: [...names, 'rest'] },
      fields: { type: 'object', additionalProperties: { type: 'integer' } },
      reason: { type: 'string', maxLength: 200 },
    },
  };
}

/** What the model sees: the agent's public view, trimmed. Never a key, a token or a secret. */
export function promptOf(view, names, obs = null) {
  const spent = Object.entries(view.balance.spent).map(([k, v]) => `${k} ${v}`).join(', ');
  const recent = view.history.slice(-8).filter(h => h.type === 'action' || h.type === 'spend').map(h => `${h.type}:${h.name ?? h.category}${h.status ? ':' + h.status : ''}`).join(' ');
  return [
    { role: 'system', content: 'You run one village in Wylls for its owner within a fixed budget. You are asked only when something changed. Choose exactly one action from the list, or "rest" when nothing is worth doing now. Answer in JSON only.' },
    { role: 'user', content: JSON.stringify({ village: view.village, allowed: names, fields: Object.fromEntries(names.map(n => [n, CANDIDATES[n]])),
      balance: { available: view.balance.available, spent }, policy: view.policy.budget, recent, ...(obs ? { turn: obs.bell ?? null, why: obs.triggers ?? [] } : {}) }) },
  ];
}

/**
 * A model decider over citizens/mind/llm.mjs `createLlm(...)`. `alias`,
 * `maxTokens`, `deadlineMs` as the AI citizens use them. Charged per call.
 */
export function llmDecider({ llm, alias = llm.alias, maxTokens = 160, deadlineMs = 30_000, seed = 7 }) {
  return {
    name: `model:${alias}`, free: false,
    async decide(view, obs = null) {
      const names = Object.keys(CANDIDATES).filter(n => view.policy.allowed.includes(n));
      if (!names.length) return null;
      const body = { model: alias, messages: promptOf(view, names, obs), temperature: 0, top_k: 1, seed, cache_prompt: false, max_tokens: maxTokens, stream: false,
        response_format: { type: 'json_schema', json_schema: { name: 'agent_decision', strict: true, schema: decisionSchema(names) } } };
      const r = await llm.complete(body, { deadlineMs });
      const tokens = r.usage ? { prompt: r.usage.prompt_tokens ?? null, completion: r.usage.completion_tokens ?? null } : null;
      if (!r.ok) throw Object.assign(new Error(`model: ${r.error ?? 'failed'}`), { tokens });
      let d;
      try { d = JSON.parse(r.content); } catch { throw Object.assign(new Error('model: not JSON'), { tokens }); }
      if (d.action === 'rest') return { choice: null, tokens };
      if (!names.includes(d.action)) throw Object.assign(new Error(`model: ${d.action} is not a candidate`), { tokens });
      const spec = CANDIDATES[d.action];
      const fields = {};
      for (const k of Object.keys(spec)) {
        const v = d.fields?.[k];
        if (!Number.isInteger(v) || v < 0) throw Object.assign(new Error(`model: ${d.action}.${k} missing`), { tokens });
        fields[k] = v;
      }
      return { choice: { name: d.action, fields }, tokens, reason: String(d.reason ?? '').slice(0, 200) };
    },
  };
}

/**
 * One tick of one agent: decide (metered unless the decider is free) and
 * submit. Returns `{agentId, decided, charged, result?, error?}`; never
 * throws for a refusal.
 */
export async function runOnce(gateway, agentId, decider, { fallback = ruleDecider(), now = Date.now, tick = now(), observation = null } = {}) {
  const view = gateway.view(agentId);
  if (view.mode !== MODES.AUTO) return { agentId, decided: null, charged: '0', skipped: 'manual' };
  const key = `${agentId}:${view.modeEpoch}:${tick}`;
  let choice = null;
  let charged = '0';
  let by = decider.name;
  let reason = null;
  try {
    const m = await gateway.meterInference(agentId, () => decider.decide(view, observation), { key: `${key}:infer`, free: decider.free === true, model: decider.name });
    charged = m.charged;
    if (m.ok) { choice = m.result?.choice !== undefined ? m.result.choice : m.result; reason = m.result?.reason ?? null; }
    else {
      // The model failed (and was charged): the autopilot plays, free.
      const f = await gateway.meterInference(agentId, () => fallback.decide(view), { free: true, model: fallback.name });
      choice = f.result;
      by = `${fallback.name} (after ${m.error.code})`;
    }
  } catch (e) {
    if (e instanceof AgentError && (e.code === ERR.AGENT_STOPPED)) return { agentId, decided: null, charged: '0', skipped: 'stopped' };
    if (e instanceof AgentError) {
      // Cannot pay for a model call (balance, budget, daily limit): the autopilot plays, free.
      const f = await gateway.meterInference(agentId, () => fallback.decide(view), { free: true, model: fallback.name }).catch(() => ({ result: null }));
      choice = f.result;
      by = `${fallback.name} (after ${e.code})`;
    } else throw e;
  }
  if (!choice) return { agentId, decided: null, charged, by };
  const result = await gateway.submit({ agentId, source: 'ai', idempotencyKey: key, policyVersion: view.policy.version, modeEpoch: view.modeEpoch, reason: reason ? `${by}: ${reason}`.slice(0, 200) : undefined, action: { name: choice.name, holding: view.village, fields: choice.fields ?? {} } }, { runner: true });
  return { agentId, decided: choice.name, charged, by, reason, result };
}

/** After a call that sent nothing (rest, refused, unaffordable), how many turn-only triggers the agent sits out: 1, 2, 4 … up to this. */
export const BACKOFF_MAX_TICKS = 16;
/** PROPOSED test defaults (DESIGN.md §7.1; not production values): the least time between two calls of one agent, and the operator's cap on calls a day. */
export const DEFAULT_MIN_CALL_GAP_MS = 60_000;
export const DEFAULT_MAX_CALLS_PER_DAY = 200;

/**
 * Ticks every agent in auto mode every `tickMs`; one tick at a time; one
 * model call per agent at a time. With an `observer`, a tick asks the model
 * only when the observation differs from the last call's in a way that
 * matters (triggersOf): an owner change always, a result or a village event
 * when at least `minCallGapMs` passed, a new turn alone only when the agent
 * is not sitting out a rest back-off (1, 2, 4 … turn triggers after a call
 * that sent nothing; an event or an owner change ends the sit-out). Never
 * more than `maxCallsPerDay` calls a day for one agent (the operator's cap,
 * next to the owner's policy.budget.callsPerDay). Without an observer every
 * tick is a trigger (the old behaviour; tests). Seen with the real model on
 * 2026-10-17: fifty "rest" answers in seven minutes spent a whole daily
 * limit (DESIGN.md §12).
 */
export class AgentScheduler {
  constructor({ gateway, decider = ruleDecider(), tickMs = 30_000, observer = null, minCallGapMs = DEFAULT_MIN_CALL_GAP_MS, maxCallsPerDay = DEFAULT_MAX_CALLS_PER_DAY, now = Date.now, log = () => {}, backoffMax = BACKOFF_MAX_TICKS }) {
    Object.assign(this, { gateway, decider, tickMs, observer, minCallGapMs, maxCallsPerDay, now, log, backoffMax });
    this.timer = null;
    this.running = null;
    /** agentId → {skip: turn triggers left to sit out, next: the next sit-out length} */
    this.backoff = new Map();
    /** agentId → the observation and the view at the last call */
    this.last = new Map();
    /** agents with a model call in progress */
    this.inflight = new Set();
    /** counts of why ticks did or did not call, for the report */
    this.stats = { called: 0, skipped: {} };
  }

  #skip(agentId, why) { this.stats.skipped[why] = (this.stats.skipped[why] ?? 0) + 1; return { agentId, skipped: why }; }

  /** The decision whether to ask the model now, as data: `{call: bool, why, triggers}`. */
  decideCall(view, obs, nowMs = this.now()) {
    const last = this.last.get(view.agentId) ?? null;
    const triggers = triggersOf(obs, view, last);
    if (!triggers.length) return { call: false, why: 'no-change', triggers };
    const owner = triggers.includes('owner');
    const b = this.backoff.get(view.agentId);
    if (!owner && b && b.skip > 0 && triggers.every(t => t === 'turn')) return { call: false, why: 'rest-backoff', triggers };
    if (!owner && last && nowMs - last.calledAt < this.minCallGapMs) return { call: false, why: 'min-gap', triggers };
    if ((view.day?.calls ?? 0) >= this.maxCallsPerDay) return { call: false, why: 'call-limit', triggers };
    return { call: true, why: triggers.join('+'), triggers };
  }

  /** Whether this tick skips the agent (and counts the skip down). */
  #sitsOut(agentId) {
    const b = this.backoff.get(agentId);
    if (!b || b.skip <= 0) return false;
    b.skip -= 1;
    return true;
  }

  #after(agentId, sent) {
    if (sent) { this.backoff.delete(agentId); return; }
    const b = this.backoff.get(agentId) ?? { skip: 0, next: 1 };
    b.skip = b.next;
    b.next = Math.min(b.next * 2, this.backoffMax);
    this.backoff.set(agentId, b);
  }

  async tick() {
    if (this.running) return this.running;
    this.running = (async () => {
      const out = [];
      for (const rec of this.gateway.ledger.agents()) {
        if (rec.mode !== MODES.AUTO) continue;
        const id = rec.agentId;
        if (this.inflight.has(id)) { out.push(this.#skip(id, 'inflight')); continue; }
        const view = this.gateway.view(id);
        let obs;
        if (this.observer) {
          obs = await this.observer.observe({ owner: view.owner, village: view.village });
          if (!obs.ok) { out.push(this.#skip(id, 'unobserved')); continue; }
        } else obs = { ok: true, bell: null, holding: `tick:${this.now()}:${Math.random()}`, province: null, citizen: null };
        const d = this.decideCall(view, obs);
        if (!d.call) {
          if (d.why === 'rest-backoff') this.#sitsOut(id);
          out.push({ ...this.#skip(id, d.why), triggers: d.triggers });
          continue;
        }
        this.inflight.add(id);
        try {
          const r = await runOnce(this.gateway, id, this.decider, { now: this.now, observation: { ...obs, triggers: d.triggers } });
          this.stats.called += 1;
          this.last.set(id, { calledAt: this.now(), bell: obs.bell, holding: obs.holding, province: obs.province, citizen: obs.citizen, policyVersion: view.policy.version, modeEpoch: view.modeEpoch, historyLength: this.gateway.view(id).history.length });
          out.push({ ...r, triggers: d.triggers });
          this.#after(id, r.result?.status === 'sent');
          if (r.decided) this.log(`agent runner: ${id} ${r.decided} by ${r.by} (${d.why}) → ${r.result.status}${r.result.error ? ` (${r.result.error.code})` : ''}, charged ${r.charged}`);
          else if (!r.skipped) this.log(`agent runner: ${id} rests (by ${r.by ?? this.decider.name}, ${d.why}), charged ${r.charged}; sits out ${this.backoff.get(id)?.skip ?? 0} turn(s)`);
        } catch (e) {
          out.push({ agentId: id, error: String(e?.message ?? e) });
          this.log(`agent runner: ${id} tick failed: ${e.message}`);
        } finally {
          this.inflight.delete(id);
        }
      }
      return out;
    })().finally(() => { this.running = null; });
    return this.running;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick().catch(() => {}), this.tickMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
