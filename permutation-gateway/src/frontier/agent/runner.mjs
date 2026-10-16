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
import { randomUUID } from 'node:crypto';
import { AgentError, ERR, MODES } from './contract.mjs';

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
export function promptOf(view, names) {
  const spent = Object.entries(view.balance.spent).map(([k, v]) => `${k} ${v}`).join(', ');
  const recent = view.history.slice(-8).filter(h => h.type === 'action' || h.type === 'spend').map(h => `${h.type}:${h.name ?? h.category}${h.status ? ':' + h.status : ''}`).join(' ');
  return [
    { role: 'system', content: 'You run one village in Wylls for its owner within a fixed budget. Choose exactly one action from the list, or "rest". Answer in JSON only.' },
    { role: 'user', content: JSON.stringify({ village: view.village, allowed: names, fields: Object.fromEntries(names.map(n => [n, CANDIDATES[n]])),
      balance: { available: view.balance.available, spent }, policy: view.policy.budget, recent }) },
  ];
}

/**
 * A model decider over citizens/mind/llm.mjs `createLlm(...)`. `alias`,
 * `maxTokens`, `deadlineMs` as the AI citizens use them. Charged per call.
 */
export function llmDecider({ llm, alias = llm.alias, maxTokens = 160, deadlineMs = 30_000, seed = 7 }) {
  return {
    name: `model:${alias}`, free: false,
    async decide(view) {
      const names = Object.keys(CANDIDATES).filter(n => view.policy.allowed.includes(n));
      if (!names.length) return null;
      const body = { model: alias, messages: promptOf(view, names), temperature: 0, top_k: 1, seed, cache_prompt: false, max_tokens: maxTokens, stream: false,
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
export async function runOnce(gateway, agentId, decider, { fallback = ruleDecider(), now = Date.now, tick = now() } = {}) {
  const view = gateway.view(agentId);
  if (view.mode !== MODES.AUTO) return { agentId, decided: null, charged: '0', skipped: 'manual' };
  const key = `${agentId}:${view.modeEpoch}:${tick}`;
  let choice = null;
  let charged = '0';
  let by = decider.name;
  try {
    const m = await gateway.meterInference(agentId, () => decider.decide(view), { key: `${key}:infer`, free: decider.free === true, model: decider.name });
    charged = m.charged;
    if (m.ok) choice = m.result?.choice !== undefined ? m.result.choice : m.result;
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
  const result = await gateway.submit({ agentId, source: 'ai', idempotencyKey: key, policyVersion: view.policy.version, modeEpoch: view.modeEpoch, action: { name: choice.name, holding: view.village, fields: choice.fields ?? {} } }, { runner: true });
  return { agentId, decided: choice.name, charged, by, result };
}

/** Ticks every agent in auto mode every `tickMs`; one tick at a time. */
export class AgentScheduler {
  constructor({ gateway, decider = ruleDecider(), tickMs = 30_000, now = Date.now, log = () => {} }) {
    Object.assign(this, { gateway, decider, tickMs, now, log });
    this.timer = null;
    this.running = null;
  }

  async tick() {
    if (this.running) return this.running;
    this.running = (async () => {
      const out = [];
      for (const rec of this.gateway.ledger.agents()) {
        if (rec.mode !== MODES.AUTO) continue;
        try {
          const r = await runOnce(this.gateway, rec.agentId, this.decider, { now: this.now });
          out.push(r);
          if (r.decided) this.log(`agent runner: ${rec.agentId} ${r.decided} by ${r.by} → ${r.result.status}${r.result.error ? ` (${r.result.error.code})` : ''}, charged ${r.charged}`);
        } catch (e) {
          out.push({ agentId: rec.agentId, error: String(e?.message ?? e) });
          this.log(`agent runner: ${rec.agentId} tick failed: ${e.message}`);
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
