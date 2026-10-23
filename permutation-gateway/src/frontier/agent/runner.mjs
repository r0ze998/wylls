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

/** Resources and units in kernel order (web fland.mjs / wasm.mjs); a store's value is in thousandths. */
export const RESOURCES = Object.freeze(['Food', 'Wood', 'Stone', 'Ore', 'Horses', 'Gold', 'Science', 'Influence']);
export const UNITS = Object.freeze(['Spearman', 'Archer', 'Horseman', 'Pikeman', 'Crossbowman', 'Knight', 'Scout', 'Settler']);
export const TIERS = Object.freeze(['Hamlet', 'Village', 'Town', 'Stronghold']);
/**
 * What the model is told an action costs (informational: the program decides; web fland.mjs BUILD_ITEMS and
 * trainingCost, the conquest table). A building's first copy; later copies cost more. Training is paid per
 * started batch of 100 troops. Walls (item 6) and tier-ups are not offered.
 */
export const CATALOG = Object.freeze({
  build: Object.freeze([
    { item: 0, produces: 'Food', per_hour: 12, cost: { Wood: 80, Stone: 40 } },
    { item: 1, produces: 'Wood', per_hour: 10, cost: { Food: 40, Stone: 40 } },
    { item: 2, produces: 'Stone', per_hour: 8, cost: { Food: 40, Wood: 80 } },
    { item: 3, produces: 'Ore', per_hour: 6, cost: { Food: 40, Wood: 80, Stone: 20 } },
    { item: 4, produces: 'Gold', per_hour: 6, cost: { Food: 40, Wood: 60, Stone: 40 } },
    { item: 5, produces: 'Science', per_hour: 3, cost: { Wood: 60, Stone: 60, Gold: 20 } },
  ].map(Object.freeze)),
  train: Object.freeze([6, 7, 6, 12, 14, 16].map((pc, unit) => Object.freeze({ unit, name: UNITS[unit], cost_per_100: { Food: 60, Ore: Math.floor(20 * pc / 6), Gold: Math.floor(10 * pc / 6) } }))),
});
const QUEUE_KINDS = ['', 'building', 'upkeep', 'tier-up', 'walls'];
const num = v => Number(v ?? 0);
const named = (names, values, scale = 1) => { const o = {}; values.forEach((v, i) => { const n = Math.floor(num(v) / scale); if (n) o[names[i]] = n; }); return o; };
/** A host id's site and generation (web faddr.mjs hostParts: index << 44 | site << 40 | gen << 32 | seq). */
const hostSiteGen = id => { const x = BigInt(id); return { site: Number((x >> 40n) & 0xfn), gen: Number((x >> 32n) & 0xffn) }; };

/**
 * The one derived line of the state: hostile troops in the province (other
 * factions' hosts and a camp) against the troops at home (garrison, reserve,
 * own hosts). Present only when something hostile is there; the bench showed
 * the model reading a threat from the raw lists alone too seldom (§12.2).
 */
export function threatOf(state) {
  const others = state.province?.other_hosts ?? [];
  const hostile = others.reduce((s, h) => s + (h.troops ?? 0), 0) + (state.province?.camp?.troops ?? 0);
  if (!hostile) return null;
  const home = (state.garrison ?? 0) + Object.values(state.reserve_troops ?? {}).reduce((s, n) => s + n, 0) + (state.hosts ?? []).reduce((s, h) => s + (h.troops ?? 0), 0);
  return { hostile_troops: hostile, troops_at_home: home, outnumbered: hostile > home };
}

/**
 * The village as the model may see it: whole numbers from the decoded
 * Holding (stores projected to `now` as the owner's page projects them:
 * value + rate × elapsed, capped), the province's hosts and camp, the
 * Citizen's vigil. Nothing private: these are the herald's public records.
 * `province` and `citizen` may be null (then those parts are left out).
 */
export function villageState({ holding, province = null, citizen = null, site, now }) {
  const h = holding;
  const t = BigInt(Math.floor(num(now)));
  const stores = {};
  for (let i = 0; i < RESOURCES.length; i++) {
    const a = h.STORES[i];
    const v = BigInt(a.VALUE), rate = BigInt(a.RATE), cap = BigInt(a.CAP), t0 = BigInt(a.T0);
    let x = t > t0 ? v + (rate * (t - t0)) / 3600n : v;
    if (x < 0n) x = 0n;
    if (rate >= 0n && x > cap) x = v < cap ? cap : v;
    const n = Number(x / 1000n);
    if (n) stores[RESOURCES[i]] = n;
  }
  const queue = [];
  let free = 0;
  for (const q of h.QUEUE) {
    if (num(q.KIND) === 0) { free++; continue; }
    const kind = QUEUE_KINDS[num(q.KIND)] ?? 'work';
    const done = Number(BigInt(q.DONE_AT) - t);
    queue.push({ what: num(q.KIND) === 1 ? `${RESOURCES[num(q.ARG)] ?? 'a'} building` : kind, done_in_s: done > 0 ? done : 0 });
  }
  const out = {
    tier: TIERS[num(h.TIER)] ?? String(h.TIER),
    stores, store_cap: Number(BigInt(h.STORES[0].CAP) / 1000n),
    production_per_hour: named(RESOURCES, h.PRODUCTION, 1000),
    upkeep_per_hour: named(RESOURCES, h.UPKEEP, 1000),
    queue, free_queue_slots: free,
    walls: num(h.WALLS),
    reserve_troops: named(UNITS, h.RESERVE),
    marches_out: h.TRANSIT.filter(x => num(x.STATE) !== 0).length,
  };
  if (num(h.FOOD_SHORTFALL) > 0) out.food_shortfall = num(h.FOOD_SHORTFALL);
  if (BigInt(h.SHIELD_UNTIL) > t) out.shielded_for_s = Number(BigInt(h.SHIELD_UNTIL) - t);
  if (province) {
    const mine = [], others = [];
    for (const e of province.ENTRIES) {
      const st = num(e.STATE);
      if (st < 1 || st > 3) continue;
      const { site: es, gen } = hostSiteGen(e.ID);
      const host = { unit: UNITS[num(e.UNIT)] ?? num(e.UNIT), troops: num(e.TROOPS) };
      if (es === site && gen === num(h.GEN)) mine.push(host); else others.push({ ...host, faction: num(e.FACTION) });
    }
    const mirror = province.SITE_MIRROR?.[site];
    out.garrison = mirror ? num(mirror.GARRISON) : 0;
    out.hosts = mine;
    const camp = province.CAMP?.[0] ?? province.CAMP;
    out.province = { other_hosts: others, camp: camp && num(camp.STATE) !== 0 ? { troops: num(camp.TROOPS) } : null };
    const threat = threatOf(out);
    if (threat) out.threat = threat;
  }
  if (citizen) out.vigil_start_min = num(citizen.VIGIL_START_MIN);
  return out;
}

/**
 * Whether the stores of `state` (villageState) cover `choice` by the catalog: a building's first-copy cost and a
 * free queue slot, a training's cost per started batch. Informational (the program decides); the decider uses it
 * to refuse an answer that would only be refused on chain. Without a state, or for other actions, true.
 */
export function affordable(choice, state) {
  if (!choice || !state?.stores) return true;
  const have = r => state.stores[r] ?? 0;
  if (choice.name === 'Build') {
    const it = CATALOG.build.find(b => b.item === choice.fields?.item);
    return !!it && (state.free_queue_slots ?? 1) > 0 && Object.entries(it.cost).every(([r, v]) => have(r) >= v);
  }
  if (choice.name === 'Train') {
    const u = CATALOG.train.find(x => x.unit === choice.fields?.unit);
    if (!u || !(choice.fields?.n >= 1)) return false;
    const k = Math.ceil(choice.fields.n / 100);
    return Object.entries(u.cost_per_100).every(([r, v]) => have(r) >= v * k);
  }
  return true;
}

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
    let holding = null, decoded = null;
    for (const h of me.holdings ?? []) {
      if (!h?.bytes_b64) continue;
      const bytes = Buffer.from(h.bytes_b64, 'base64');
      try {
        const d = decodeAccount('Holding', bytes);
        if (Number(d.P) === p && Number(d.Q) === q && Number(d.SITE) === site) { holding = accountDigest('Holding', bytes); decoded = d; break; }
      } catch { /* not a holding */ }
    }
    const cb = me.citizen?.bytes_b64 ? Buffer.from(me.citizen.bytes_b64, 'base64') : null;
    const citizen = cb ? accountDigest('Citizen', cb) : null;
    // (the province: its account over the fields that mean an arrival, a camp, a site taken; and the arrival slots' keys, not their bytes.
    //  The herald's /h/province/{p},{q}/latest carries the account as `bytes` (base64) next to `slots`; older shapes are read too.)
    const pb = province?.bytes ?? province?.bytes_b64 ?? province?.province?.bytes_b64 ?? province?.province?.bytes ?? null;
    const prov = pb ? sha(accountDigest('Province', Buffer.from(pb, 'base64')) + '|' + (province.slots ?? []).map(s => s.key ?? '').sort().join(',')) : null;
    let state = null;
    if (decoded) {
      const dp = (() => { try { return pb ? decodeAccount('Province', Buffer.from(pb, 'base64')) : null; } catch { return null; } })();
      const dc = (() => { try { return cb ? decodeAccount('Citizen', cb) : null; } catch { return null; } })();
      try { state = villageState({ holding: decoded, province: dp, citizen: dc, site, now: latestUnix }); } catch { state = null; }
    }
    return { ok: true, bell, latestUnix, holding, province: prov, citizen, state };
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
  if (Number.isInteger(view.historySeq) && Number.isInteger(last.historySeq)) {
    // The view carries the last 50 lines only: compare the ledger's sequence, never the list's length (which stops growing at 50).
    if ((view.history ?? []).some(h => h.seq > last.historySeq && h.type === 'action' && h.source !== 'ai')) out.push('result');
  } else if ((view.historyLength ?? view.history?.length ?? 0) !== last.historyLength && (view.history ?? []).slice(last.historyLength ?? 0).some(h => h.type === 'action' && h.source !== 'ai')) out.push('result');
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

/** The ranges of each candidate's fields in the strict schema (the catalog's items and units; a vigil minute of the day). */
const FIELD_RANGES = Object.freeze({
  Train: { unit: { enum: CATALOG.train.map(u => u.unit) }, n: { minimum: 1, maximum: 10_000 } },
  Build: { item: { enum: CATALOG.build.map(b => b.item) } },
  SetVigil: { start_min: { minimum: 0, maximum: 1439 } },
});

/**
 * The JSON schema the model must answer with: one of `names`, its fields, a one-line reason.
 * `strict` (opt-in, --agent-llm-strict-schema; off by default so the measured runs keep their setup):
 * one branch per action with its required fields and their ranges, so a grammar-constrained server
 * cannot produce a missing field or an out-of-catalog unit. Whether the stores can pay stays the
 * decider's check (affordable()); the program stays the rule.
 */
export function decisionSchema(names, { strict = false } = {}) {
  if (strict) {
    const branch = (action, fields) => ({ type: 'object', additionalProperties: false, required: ['action', 'fields', 'reason'],
      properties: { action: { const: action }, fields, reason: { type: 'string', maxLength: 200 } } });
    const fieldsOf = n => {
      const spec = CANDIDATES[n];
      const props = Object.fromEntries(Object.keys(spec).map(k => [k, { type: 'integer', ...(FIELD_RANGES[n]?.[k] ?? { minimum: 0 }) }]));
      return { type: 'object', additionalProperties: false, required: Object.keys(spec), properties: props };
    };
    return { anyOf: [...names.map(n => branch(n, fieldsOf(n))), branch('rest', { type: 'object', additionalProperties: false, properties: {} })] };
  }
  return {
    type: 'object', additionalProperties: false, required: ['action', 'fields', 'reason'],
    properties: {
      action: { type: 'string', enum: [...names, 'rest'] },
      fields: { type: 'object', additionalProperties: { type: 'integer' } },
      reason: { type: 'string', maxLength: 200 },
    },
  };
}

/** What each candidate does, in the model's terms (the program is the rule; this is the summary the AI citizens get). */
export const ACTION_NOTES = Object.freeze({
  Harvest: 'touch the village: settles production into the stores and keeps the village from going dormant (5 days without an owner action); nothing else happens; free',
  Build: 'start one building (item from the catalog) in a free queue slot; pays its cost now from the stores; takes hours; a second copy of the same building costs more',
  Train: 'train n troops (n >= 1, best a multiple of 100: the price is per started batch of 100) of a unit (0-5) at home now, paid from the stores (Food, Ore, Gold); they wait in the reserve and defend; to train nothing, rest',
  SetVigil: 'set the daily hour (start_min, minutes from UTC midnight, 0-1439) when the owner is awake to defend; takes effect after a day; once a week',
});

/** What the model sees: the agent's public view, trimmed, and the village as the herald shows everyone. Never a key, a token or a secret. */
export function promptOf(view, names, obs = null, { catalog: cat = CATALOG, reverseStores = false } = {}) {
  const spent = Object.entries(view.balance.spent).map(([k, v]) => `${k} ${v}`).join(', ');
  const recent = view.history.slice(-8).filter(h => h.type === 'action' || h.type === 'spend').map(h => `${h.type}:${h.name ?? h.category}${h.status ? ':' + h.status : ''}`).join(' ');
  const catalog = {};
  if (names.includes('Build')) catalog.build = cat.build;
  if (names.includes('Train')) catalog.train = cat.train;
  // (reverseStores: the bench's order check only — the stores object with its keys in reverse order; the relay never sets it)
  const state = obs?.state && reverseStores ? { ...obs.state, stores: Object.fromEntries(Object.entries(obs.state.stores).reverse()) } : obs?.state;
  return [
    { role: 'system', content: 'You run one village in Wylls for its owner within a fixed budget. You are asked only when something changed. Choose exactly one action from the list, or "rest" when nothing is worth doing now. '
      + 'Spend the stores on what the village needs. Defence first: when state.threat says the village is outnumbered (hostile troops in the province, fewer at home) and a batch is affordable, train before anything else. Otherwise build when the stores cover a building and a queue slot is free; rest when nothing useful is affordable or everything needed is already under way. Fields are whole numbers; never spend more than the stores hold. Answer in JSON only.' },
    { role: 'user', content: JSON.stringify({ village: view.village, allowed: names, fields: Object.fromEntries(names.map(n => [n, CANDIDATES[n]])), actions: Object.fromEntries(names.map(n => [n, ACTION_NOTES[n]])),
      ...(Object.keys(catalog).length ? { catalog } : {}), ...(state ? { state } : {}),
      balance: { available: view.balance.available, spent }, policy: view.policy.budget, recent, ...(obs ? { turn: obs.bell ?? null, why: obs.triggers ?? [] } : {}) }) },
  ];
}

/**
 * A model decider over citizens/mind/llm.mjs `createLlm(...)`. `alias`,
 * `maxTokens`, `deadlineMs` as the AI citizens use them. Charged per call.
 */
export function llmDecider({ llm, alias = llm.alias, maxTokens = 160, deadlineMs = 30_000, seed = 7, promptOptions = {}, strictSchema = false }) {
  return {
    name: `model:${alias}`, free: false,
    async decide(view, obs = null) {
      const names = Object.keys(CANDIDATES).filter(n => view.policy.allowed.includes(n));
      if (!names.length) return null;
      const body = { model: alias, messages: promptOf(view, names, obs, promptOptions), temperature: 0, top_k: 1, seed, cache_prompt: false, max_tokens: maxTokens, stream: false,
        response_format: { type: 'json_schema', json_schema: { name: 'agent_decision', strict: true, schema: decisionSchema(names, { strict: strictSchema }) } } };
      const r = await llm.complete(body, { deadlineMs });
      const tokens = r.usage ? { prompt: r.usage.prompt_tokens ?? null, completion: r.usage.completion_tokens ?? null } : null;
      if (!r.ok) throw Object.assign(new Error(`model: ${r.error ?? 'failed'}`), { tokens });
      let d;
      try { d = JSON.parse(r.content); } catch { throw Object.assign(new Error('model: not JSON'), { tokens }); }
      if (d.action === 'rest') return { choice: null, tokens, reason: String(d.reason ?? '').slice(0, 200) };
      if (!names.includes(d.action)) throw Object.assign(new Error(`model: ${d.action} is not a candidate`), { tokens });
      const spec = CANDIDATES[d.action];
      const fields = {};
      for (const k of Object.keys(spec)) {
        const v = d.fields?.[k];
        if (!Number.isInteger(v) || v < 0) throw Object.assign(new Error(`model: ${d.action}.${k} missing`), { tokens });
        fields[k] = v;
      }
      // Train with no troops is not an action the program takes (the bench saw "Train n=0" for "cannot afford"): invalid, the autopilot plays.
      if (d.action === 'Train' && fields.n < 1) throw Object.assign(new Error('model: Train.n must be at least 1'), { tokens });
      // An answer the stores cannot pay for (the bench saw "Train 100" on Food 20, with the reason admitting it): refused here, not on chain.
      if (obs?.state && !affordable({ name: d.action, fields }, obs.state)) throw Object.assign(new Error(`model: ${d.action} ${JSON.stringify(fields)} is not affordable by the state`), { tokens });
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
  let modelError = null;
  // Why the free autopilot played instead of the model (a model failure, an unaffordable call, a cap): shown to the owner apart from a stop.
  let cause = null;
  try {
    const m = await gateway.meterInference(agentId, () => decider.decide(view, observation), { key: `${key}:infer`, free: decider.free === true, model: decider.name });
    charged = m.charged;
    if (m.ok) { choice = m.result?.choice !== undefined ? m.result.choice : m.result; reason = m.result?.reason ?? null; }
    else {
      // The model failed (and was charged): the autopilot plays, free. The message says why (a refused answer, a timeout), for the log.
      modelError = m.error.message;
      const f = await gateway.meterInference(agentId, () => fallback.decide(view), { free: true, model: fallback.name });
      choice = f.result;
      by = `${fallback.name} (after ${m.error.code})`;
      cause = m.error.code;
    }
  } catch (e) {
    if (e instanceof AgentError && (e.code === ERR.AGENT_STOPPED)) return { agentId, decided: null, charged: '0', skipped: 'stopped' };
    if (e instanceof AgentError) {
      // Cannot pay for a model call (balance, budget, daily limit): the autopilot plays, free.
      const f = await gateway.meterInference(agentId, () => fallback.decide(view), { free: true, model: fallback.name }).catch(() => ({ result: null }));
      choice = f.result;
      by = `${fallback.name} (after ${e.code})`;
      cause = e.code;
    } else throw e;
  }
  const driver = decider.free === true || cause ? 'autopilot' : 'model';
  // One line per decision, paid or free, whatever came of it: what the owner paid for when nothing was sent, and why.
  const decision = { key, by, driver, charged, reason, ...(cause ? { cause } : {}), ...(modelError ? { modelError: String(modelError).slice(0, 200) } : {}) };
  if (!choice) {
    gateway.ledger.recordDecision(agentId, { ...decision, outcome: 'rest' });
    return { agentId, decided: null, charged, by, reason, ...(cause ? { cause } : {}), ...(modelError ? { modelError } : {}) };
  }
  const result = await gateway.submit({ agentId, source: 'ai', idempotencyKey: key, policyVersion: view.policy.version, modeEpoch: view.modeEpoch, reason: reason ? `${by}: ${reason}`.slice(0, 200) : undefined, action: { name: choice.name, holding: view.village, fields: choice.fields ?? {} } }, { runner: true });
  gateway.ledger.recordDecision(agentId, { ...decision, outcome: result.status, action: choice.name, ...(result.signature ? { signature: result.signature } : {}), ...(result.error ? { code: result.error.code } : {}) });
  return { agentId, decided: choice.name, charged, by, reason, result, ...(cause ? { cause } : {}), ...(modelError ? { modelError } : {}) };
}

/** After a call that sent nothing (rest, refused, unaffordable), how many turn-only triggers the agent sits out: 1, 2, 4 … up to this. */
export const BACKOFF_MAX_TICKS = 16;
/** PROPOSED test default (DESIGN.md §7.1): the least time between two calls when the owner changed the policy or the mode (a burst of owner commands is one call per this gap). */
export const DEFAULT_OWNER_CALL_GAP_MS = 10_000;
/** PROPOSED test defaults (DESIGN.md §7.1; not production values): the least time between two calls of one agent, and the operator's cap on calls a day. */
export const DEFAULT_MIN_CALL_GAP_MS = 60_000;
export const DEFAULT_MAX_CALLS_PER_DAY = 200;

/**
 * Ticks every agent in auto mode every `tickMs`; one tick at a time; one
 * model call per agent at a time. With an `observer`, a tick asks the model
 * only when the observation differs from the last call's in a way that
 * matters (triggersOf): an owner change (at most once per `ownerCallGapMs`),
 * a result or a village event when at least `minCallGapMs` passed, a new turn alone only when the agent
 * is not sitting out a rest back-off (1, 2, 4 … turn triggers after a call
 * that sent nothing; an event or an owner change ends the sit-out). Never
 * more than `maxCallsPerDay` calls a day for one agent (the operator's cap,
 * next to the owner's policy.budget.callsPerDay). Without an observer every
 * tick is a trigger (the old behaviour; tests). Seen with the real model on
 * 2026-10-17: fifty "rest" answers in seven minutes spent a whole daily
 * limit (DESIGN.md §12).
 */
export class AgentScheduler {
  constructor({ gateway, decider = ruleDecider(), tickMs = 30_000, observer = null, minCallGapMs = DEFAULT_MIN_CALL_GAP_MS, ownerCallGapMs = DEFAULT_OWNER_CALL_GAP_MS, maxCallsPerDay = DEFAULT_MAX_CALLS_PER_DAY, now = Date.now, log = () => {}, backoffMax = BACKOFF_MAX_TICKS }) {
    Object.assign(this, { gateway, decider, tickMs, observer, minCallGapMs, ownerCallGapMs, maxCallsPerDay, now, log, backoffMax });
    this.timer = null;
    this.running = null;
    /** agentId → {skip: turn triggers left to sit out, next: the next sit-out length} */
    this.backoff = new Map();
    /** agentId → the observation and the view at the last call */
    this.last = new Map();
    /** agents with a model call in progress */
    this.inflight = new Set();
    /** counts of why ticks did or did not call, and what each call came to (sent / refused on chain / failed send / rest, and the autopilot's turns after a failed call), for the report */
    this.stats = { called: 0, skipped: {}, outcomes: { sent: 0, refused: 0, failed: 0, rest: 0, fallback: 0 } };
  }

  #skip(agentId, why) { this.stats.skipped[why] = (this.stats.skipped[why] ?? 0) + 1; return { agentId, skipped: why }; }

  /** The decision whether to ask the model now, as data: `{call: bool, why, triggers}`. */
  decideCall(view, obs, nowMs = this.now()) {
    const last = this.last.get(view.agentId) ?? null;
    const triggers = triggersOf(obs, view, last);
    if (!triggers.length) return { call: false, why: 'no-change', triggers };
    // The caps first: they hold whatever the trigger (an owner change included).
    if ((view.day?.calls ?? 0) >= this.maxCallsPerDay) return { call: false, why: 'call-limit', triggers };
    const owner = triggers.includes('owner');
    const b = this.backoff.get(view.agentId);
    if (!owner && b && b.skip > 0 && triggers.every(t => t === 'turn')) return { call: false, why: 'rest-backoff', triggers };
    if (!owner && last && nowMs - last.calledAt < this.minCallGapMs) return { call: false, why: 'min-gap', triggers };
    // An owner change gets through the minimum gap, but a burst of owner commands is one call per owner gap (the change is not lost: it is still a trigger next tick).
    if (owner && last && nowMs - last.calledAt < this.ownerCallGapMs) return { call: false, why: 'owner-gap', triggers };
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
        // The chain's delegation before a paid call: when the owner took the key back (SetSession) while the server
        // is still in auto, nothing the model decides could be sent, so no call is made (and none is charged).
        // An unreadable delegation is treated the same way: the gateway would have to refuse anyway.
        if (typeof this.gateway.delegation === 'function') {
          const del = await this.gateway.delegation(id).catch(() => null);
          if (!del || del.delegated !== true) { out.push({ ...this.#skip(id, del ? 'not-delegated' : 'delegation-unread'), triggers: d.triggers }); continue; }
        }
        // The Citizen's sponsored transactions for today (shared by the owner's own play and the agent): when none is
        // left, the relay would refuse whatever the model decides, so no call is made (or charged) until the day rolls.
        if (typeof this.gateway.quota === 'function') {
          const q = await this.gateway.quota(id).catch(() => null);
          if (!q || !(q.left > 0)) { out.push({ ...this.#skip(id, q ? 'quota-empty' : 'quota-unread'), triggers: d.triggers }); continue; }
        }
        this.inflight.add(id);
        try {
          const r = await runOnce(this.gateway, id, this.decider, { now: this.now, observation: { ...obs, triggers: d.triggers } });
          this.stats.called += 1;
          const o = this.stats.outcomes;
          if (r.decided) o[r.result?.status === 'sent' ? 'sent' : r.result?.status === 'refused' ? 'refused' : 'failed'] += 1; else if (!r.skipped) o.rest += 1;
          if (typeof r.by === 'string' && r.by.includes('(after ')) o.fallback += 1;
          this.last.set(id, { calledAt: this.now(), bell: obs.bell, holding: obs.holding, province: obs.province, citizen: obs.citizen, policyVersion: view.policy.version, modeEpoch: view.modeEpoch, historyLength: this.gateway.view(id).history.length, historySeq: this.gateway.view(id).historySeq });
          out.push({ ...r, triggers: d.triggers });
          this.#after(id, r.result?.status === 'sent');
          if (r.decided) this.log(`agent runner: ${id} ${r.decided} by ${r.by} (${d.why}) → ${r.result.status}${r.result.error ? ` (${r.result.error.code})` : ''}, charged ${r.charged}${r.modelError ? `; the model: ${r.modelError}` : ''}`);
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
