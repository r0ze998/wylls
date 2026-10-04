// Validation layers V2 (menu) and V3 (caps) of contract section 4.5, and the glue that applies V5/V5b
// (speech, owned by AC1b) to a decision's `say` and `why`. V0 (transport) and V1 (shape) are in api.mjs
// and schema.mjs. Every function here is pure: it never calls the model, the clock or the network.
import { maxSayFor, kindBase } from './schema.mjs';

export const DEFAULT_CAPS = { march_share: 0.6, day_share: 0.6, home_floor: 0.4, marches_per_day: 4, exempt_below: 200 };

export const candHostId = (c) => c.host_id ?? c.facts?.host_id ?? c.facts?.host ?? c.host ?? null;
const isMarch = (c) => kindBase(c.kind) === 'march';
const isMoving = (c) => ['march', 'recall'].includes(kindBase(c.kind));

/** messages_cap = 6 + round(sociability / 25), at most 10 per game day (section 2.1). */
export function messagesCap(persona) {
  const soc = persona?.temperament?.sociability ?? 50;
  return Math.min(10, 6 + Math.round(soc / 25));
}

/**
 * V2. `value` passed V1. Returns {ok, error, chosen, params, stray, mem:{ids, dropped}}.
 *  - ids exist; autopilot and hold only alone; params values allowed (missing params default to the first
 *    allowed value); params for an id that was not chosen are stray: dropped and counted (llama's grammar
 *    cannot tie params to choose, step-0 measured 4 of 60 answers with stray params, section 4.4 note);
 *  - at most one march or recall per host; builds (build and walls) at most the free queue slots;
 *  - `mem` handles outside the retrieved set are dropped and counted (a dropped handle never invalidates).
 */
export function checkMenu(value, { candidates, handles = {}, queueFree = null }) {
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const choose = value.choose;
  for (const id of choose) if (!byId.has(id)) return { ok: false, error: `unknown id ${id}` };
  for (const id of choose) {
    const k = kindBase(byId.get(id).kind);
    if ((k === 'autopilot' || k === 'hold') && choose.length > 1) return { ok: false, error: `${k} must be chosen alone` };
  }
  const params = {};
  let stray = 0;
  for (const [id, p] of Object.entries(value.params ?? {})) {
    if (!choose.includes(id)) {
      stray += 1;
      continue;
    }
    const allowed = byId.get(id).params ?? {};
    for (const [name, v] of Object.entries(p)) {
      if (!(name in allowed) || !allowed[name].includes(v)) return { ok: false, error: `param ${name} of ${id} not allowed` };
    }
  }
  for (const id of choose) {
    const allowed = byId.get(id).params ?? {};
    const given = value.params?.[id] ?? {};
    const out = {};
    for (const [name, values] of Object.entries(allowed)) out[name] = name in given ? given[name] : values[0];
    if (Object.keys(out).length) params[id] = out;
  }
  const hosts = new Map();
  for (const id of choose) {
    const c = byId.get(id);
    if (!isMoving(c)) continue;
    const h = candHostId(c);
    if (h == null) continue;
    if (hosts.has(h)) return { ok: false, error: `more than one march for host ${h}` };
    hosts.set(h, id);
  }
  if (queueFree != null) {
    const builds = choose.filter((id) => ['build', 'walls'].includes(kindBase(byId.get(id).kind))).length;
    if (builds > queueFree) return { ok: false, error: `${builds} builds chosen, ${queueFree} queue slots free` };
  }
  const memIds = [];
  let dropped = 0;
  const seen = new Set();
  for (const h of value.mem ?? []) {
    if (typeof h !== 'string' || !Object.hasOwn(handles, h) || seen.has(h)) {
      dropped += 1;
      continue;
    }
    seen.add(h);
    memIds.push(handles[h]);
  }
  return { ok: true, chosen: [...choose], params, stray, mem: { ids: memIds, handles: [...seen], dropped } };
}

/**
 * V3. Applies the caps of section 4.5 to the chosen marches in choice order and drops the offending ones.
 *  (a) sum of this decision's march troops <= 60 % of home_troops
 *  (b) day cap: sum of model-chosen march troops today <= 60 % of H0, unless H0 < 200
 *  (c) home floor: home_troops - this decision's marches >= 40 % of H0, unless H0 < 200
 *  (d) at most 4 model-chosen marches per game day
 * recall candidates are not marches for the caps (they bring an arrived host home). The Strike-Order
 * flagged march is a model-chosen march and is capped like any other.
 * returns {kept, dropped:[{id, rule}], sent, marches, capsNow:{march_troops_left, home_floor}}
 * capsNow is the allowance at the START of this decision (the wire fixture: 1,000 home troops, nothing marched
 * today -> march_troops_left 600, home_floor 400, beside a 500-troop march in the same answer). The brain's V6
 * checks this decision's marches against it, so it must not already count them.
 */
export function applyCaps({ chosen, candidates, homeTroops, dayStart, marchesToday, caps = DEFAULT_CAPS }) {
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const h0 = dayStart?.home_troops ?? homeTroops;
  const exempt = h0 < caps.exempt_below;
  const modelToday = dayStart?.march_troops_model ?? 0;
  const kept = [];
  const dropped = [];
  let sent = 0;
  let keptMarches = 0;
  for (const id of chosen) {
    const c = byId.get(id);
    if (!c || !isMarch(c)) {
      kept.push(id);
      continue;
    }
    const t = Number(c.troops ?? c.facts?.troops ?? 0);
    let rule = null;
    if (sent + t > caps.march_share * homeTroops) rule = 'a';
    else if (!exempt && modelToday + sent + t > caps.day_share * h0) rule = 'b';
    else if (!exempt && homeTroops - (sent + t) < caps.home_floor * h0) rule = 'c';
    else if (marchesToday + keptMarches + 1 > caps.marches_per_day) rule = 'd';
    if (rule) dropped.push({ id, rule });
    else {
      kept.push(id);
      sent += t;
      keptMarches += 1;
    }
  }
  const dayLeft = exempt ? Infinity : Math.max(0, Math.floor(caps.day_share * h0) - modelToday);
  const nowLeft = Math.max(0, Math.floor(caps.march_share * homeTroops));
  return {
    kept,
    dropped,
    sent,
    marches: keptMarches,
    capsNow: { march_troops_left: Math.min(dayLeft, nowLeft), home_floor: exempt ? 0 : Math.ceil(caps.home_floor * h0) },
  };
}

/**
 * Apply V5 to `say` (drop the message only) and V5b to `why` (replace by the code string). `speech` is
 * AC1b's checker: checkSay(text, ctx) and checkWhy(text, ctx), each returning {ok, text, reason}.
 * ctx carries everything a check may need: {kind, channel, lang, facts, episodeTexts, sealed, mem (ids cited),
 * untrusted (texts shown in the prompt), inFlight}. Returns {say: [{...message, text}], why, why_withheld, drops: {reason: n}}.
 */
export function applySpeech({ value, speech, ctx, messagesLeft, kind }) {
  const drops = {};
  const bump = (r) => {
    drops[r] = (drops[r] ?? 0) + 1;
  };
  const say = [];
  const maxSay = maxSayFor(kind);
  for (const m of value.say.slice(0, maxSay)) {
    if (say.length >= messagesLeft) {
      bump('message_budget');
      continue;
    }
    const r = speech.checkSay(m.text, { ...ctx, channel: m.channel, to: m.to });
    if (!r.ok) {
      bump(r.reason ?? 'speech');
      continue;
    }
    say.push({ ...m, text: r.text });
  }
  let why = value.why;
  let whyWithheld = null;
  const w = speech.checkWhy(value.why, ctx);
  if (!w.ok) {
    whyWithheld = w.reason ?? 'speech';
    why = `(reason withheld by the checker: ${whyWithheld})`;
    bump(`why:${whyWithheld}`);
  } else why = w.text;
  return { say, why, why_withheld: whyWithheld, drops };
}
