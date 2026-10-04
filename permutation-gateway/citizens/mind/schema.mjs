// Answer schema (contract section 4.4) and the V1 shape validator (section 4.5), hand-written, no
// dependencies. Two jobs:
//   buildAnswerSchema(spec)  -> the JSON schema sent to llama-server as response_format (per request:
//                               the candidate enum, the memory handle enum and the speech menu are
//                               this prompt's, so constrained decoding cannot emit another id).
//   validateShape(obj, spec) -> V1: the same rules checked on the parsed answer. llama.cpp's grammar
//                               does not enforce uniqueItems (measured in step 0), so uniqueness, the
//                               alone-rules and the clipping live here, not in the grammar.
// A spec is plain data built by prompt.mjs from the request and the memory attach:
//   { kind: 'session'|'reaction'|'motion'|'ballot', goalIds: ['G1'..], candidateIds: ['c1'..],
//     paramsByCandidate: {c4: {stance: [...], retreat: [...], timing: [...]}}, handles: ['M1'..],
//     who: ['C1'.., 'N0'..] (trust targets), direct: ['C1'..] (say.to targets; default = who),
//     channels: ['world','nation','direct'], maxSay: n (budget override), motionOptions: [0..3], ballotOptions: [0..3] }

export const SAY_MAX_CODEPOINTS = 280;
export const WHY_MAX_CODEPOINTS = 200;
export const SUMMARY_MAX_CODEPOINTS = 1200;
export const TRUST_STEP = 10;

const MAX_SAY = { session: 2, reaction: 2, motion: 1, ballot: 0 };

export function maxSayFor(kind) {
  return MAX_SAY[kind] ?? 0;
}

const cp = (s) => [...String(s)].length;

/** A candidate kind is the contract's table entry verbatim: autopilot, hold, march, recall:<handle>, build:<item>, walls, train:<unit>, muster:<unit>, explore:<handle>. */
export const kindBase = (kind) => String(kind ?? '').split(':')[0];

function enumOf(values) {
  return { enum: [...values] };
}

function trustSchema(spec) {
  const who = spec.who ?? [];
  if (!who.length) return { type: 'array', maxItems: 0 };
  return {
    type: 'array',
    maxItems: 3,
    items: {
      type: 'object',
      properties: { who: enumOf(who), delta: { type: 'integer', minimum: -TRUST_STEP, maximum: TRUST_STEP } },
      required: ['who', 'delta'],
      additionalProperties: false,
    },
  };
}

function sayMax(spec) {
  return Math.min(maxSayFor(spec.kind), spec.maxSay ?? 99);
}

function saySchema(spec) {
  const max = sayMax(spec);
  if (max === 0) return { type: 'array', maxItems: 0 };
  const channels = (spec.channels ?? ['world', 'nation']).filter((c) => c !== 'direct');
  const directTargets = spec.direct ?? spec.who ?? [];
  const direct = (spec.channels ?? []).includes('direct') && directTargets.length > 0;
  const text = { type: 'string', minLength: 1, maxLength: SAY_MAX_CODEPOINTS };
  const variants = [];
  if (channels.length) {
    variants.push({
      type: 'object',
      properties: { channel: enumOf(channels), text },
      required: ['channel', 'text'],
      additionalProperties: false,
    });
  }
  if (direct) {
    variants.push({
      type: 'object',
      properties: { channel: enumOf(['direct']), to: enumOf(directTargets), text },
      required: ['channel', 'to', 'text'],
      additionalProperties: false,
    });
  }
  if (!variants.length) return { type: 'array', maxItems: 0 };
  return { type: 'array', maxItems: max, items: variants.length === 1 ? variants[0] : { anyOf: variants } };
}

function chooseSchema(spec) {
  if (spec.kind !== 'session') return { type: 'array', maxItems: 0 };
  return { type: 'array', minItems: 1, maxItems: 3, items: enumOf(spec.candidateIds ?? []) };
}

function paramsSchema(spec) {
  const props = {};
  for (const [id, p] of Object.entries(spec.paramsByCandidate ?? {})) {
    const inner = {};
    for (const [name, values] of Object.entries(p)) inner[name] = enumOf(values);
    if (Object.keys(inner).length) {
      props[id] = { type: 'object', properties: inner, required: Object.keys(inner), additionalProperties: false };
    }
  }
  return { type: 'object', properties: props, additionalProperties: false };
}

function councilSchema(spec) {
  if (spec.kind === 'motion') {
    return {
      type: 'object',
      properties: { motion: enumOf(spec.motionOptions ?? [0, 1, 2, 3]) },
      required: ['motion'],
      additionalProperties: false,
    };
  }
  if (spec.kind === 'ballot') {
    return {
      type: 'object',
      properties: { ballot: enumOf(spec.ballotOptions ?? [0, 1, 2, 3]) },
      required: ['ballot'],
      additionalProperties: false,
    };
  }
  return { type: 'null' };
}

function memSchema(spec) {
  const handles = spec.handles ?? [];
  if (!handles.length) return { type: 'array', maxItems: 0 };
  return { type: 'array', maxItems: Math.min(3, handles.length), items: enumOf(handles) };
}

/** The response_format body for one session, reaction, motion or ballot call. */
export function buildAnswerSchema(spec) {
  const properties = {
    goal_id: enumOf(spec.goalIds ?? ['G1', 'G2', 'G3', 'G4']),
    choose: chooseSchema(spec),
    params: paramsSchema(spec),
    say: saySchema(spec),
    council: councilSchema(spec),
    trust: trustSchema(spec),
    mem: memSchema(spec),
    why: { type: 'string', minLength: 1, maxLength: WHY_MAX_CODEPOINTS },
  };
  return {
    type: 'object',
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

/** The reflection answer (section 4.4 last paragraph). */
export function buildReflectionSchema(spec) {
  const goalIds = spec.goalIds ?? ['G1', 'G2', 'G3', 'G4'];
  const properties = {
    summary: { type: 'string', minLength: 1, maxLength: SUMMARY_MAX_CODEPOINTS },
    goal_ops: {
      type: 'array',
      maxItems: 2,
      items: {
        type: 'object',
        properties: { op: enumOf(['progress', 'drop', 'resume']), id: enumOf(goalIds) },
        required: ['op', 'id'],
        additionalProperties: false,
      },
    },
    trust: trustSchema(spec),
    mem: { type: 'array', maxItems: 0 },
  };
  return { type: 'object', properties, required: Object.keys(properties), additionalProperties: false };
}

/** response_format request field (request_shape "response_format", pinned in the commitments). */
export function responseFormat(name, schema) {
  return { type: 'json_schema', json_schema: { name, strict: true, schema } };
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function fail(errors, msg) {
  errors.push(msg);
}

/**
 * V1 for a session/reaction/motion/ballot answer. Returns {ok, errors, value}. `value` is a
 * normalised copy (unknown keys are an error; trust deltas are not clipped here, the ledger clips
 * per handle per game day). Never throws.
 */
export function validateShape(obj, spec) {
  const errors = [];
  if (!isObj(obj)) return { ok: false, errors: ['answer is not an object'], value: null };
  const allowed = ['goal_id', 'choose', 'params', 'say', 'council', 'trust', 'mem', 'why'];
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) fail(errors, `unknown key ${k}`);
  for (const k of allowed) if (!(k in obj)) fail(errors, `missing key ${k}`);
  if (errors.length) return { ok: false, errors, value: null };

  const goalIds = spec.goalIds ?? ['G1', 'G2', 'G3', 'G4'];
  if (!goalIds.includes(obj.goal_id)) fail(errors, 'goal_id not in the goal enum');

  // choose
  if (!Array.isArray(obj.choose)) fail(errors, 'choose is not an array');
  else {
    if (obj.choose.length > 3) fail(errors, 'choose has more than 3 ids');
    if (spec.kind === 'session' && obj.choose.length === 0) fail(errors, 'choose is empty in a session');
    if (spec.kind !== 'session' && obj.choose.length > 0) fail(errors, `choose must be empty in a ${spec.kind}`);
    if (new Set(obj.choose).size !== obj.choose.length) fail(errors, 'choose has duplicate ids');
    for (const id of obj.choose) {
      if (typeof id !== 'string') fail(errors, 'choose item is not a string');
    }
  }

  // params
  if (!isObj(obj.params)) fail(errors, 'params is not an object');
  else {
    for (const [id, p] of Object.entries(obj.params)) {
      if (!isObj(p)) fail(errors, `params.${id} is not an object`);
    }
  }

  // say
  const maxSay = sayMax(spec);
  if (!Array.isArray(obj.say)) fail(errors, 'say is not an array');
  else {
    if (obj.say.length > maxSay) fail(errors, `say has more than ${maxSay} items`);
    const channels = spec.channels ?? ['world', 'nation'];
    for (const m of obj.say) {
      if (!isObj(m)) {
        fail(errors, 'say item is not an object');
        continue;
      }
      if (!channels.includes(m.channel)) fail(errors, 'say channel not in the menu');
      if (m.channel === 'direct') {
        if (!(spec.direct ?? spec.who ?? []).includes(m.to)) fail(errors, 'say direct target not in the menu');
      } else if ('to' in m) fail(errors, 'say.to only with channel direct');
      if (typeof m.text !== 'string' || cp(m.text) < 1 || cp(m.text) > SAY_MAX_CODEPOINTS) {
        fail(errors, 'say text length out of 1..280');
      }
    }
  }

  // council
  if (spec.kind === 'motion') {
    if (!isObj(obj.council) || !(spec.motionOptions ?? [0, 1, 2, 3]).includes(obj.council.motion)) {
      fail(errors, 'council.motion missing or not in the menu');
    }
  } else if (spec.kind === 'ballot') {
    if (!isObj(obj.council) || !(spec.ballotOptions ?? [0, 1, 2, 3]).includes(obj.council.ballot)) {
      fail(errors, 'council.ballot missing or not in the menu');
    }
  } else if (obj.council !== null) fail(errors, 'council must be null outside motion and ballot calls');

  // trust
  if (!Array.isArray(obj.trust)) fail(errors, 'trust is not an array');
  else {
    if (obj.trust.length > 3) fail(errors, 'trust has more than 3 items');
    for (const t of obj.trust) {
      if (!isObj(t) || !(spec.who ?? []).includes(t.who)) fail(errors, 'trust.who not in the menu');
      else if (!Number.isInteger(t.delta) || Math.abs(t.delta) > TRUST_STEP) fail(errors, 'trust.delta not an integer in -10..10');
    }
  }

  // mem (handles are checked against the retrieved set in V2: an unknown handle is dropped, not a V1 failure)
  if (!Array.isArray(obj.mem)) fail(errors, 'mem is not an array');
  else {
    if (obj.mem.length > 3) fail(errors, 'mem has more than 3 handles');
    for (const h of obj.mem) if (typeof h !== 'string') fail(errors, 'mem item is not a string');
  }

  // why
  if (typeof obj.why !== 'string' || cp(obj.why) < 1 || cp(obj.why) > WHY_MAX_CODEPOINTS) {
    fail(errors, 'why length out of 1..200');
  }

  return errors.length ? { ok: false, errors, value: null } : { ok: true, errors, value: obj };
}

/** V1 for the reflection answer. */
export function validateReflectionShape(obj, spec) {
  const errors = [];
  if (!isObj(obj)) return { ok: false, errors: ['answer is not an object'], value: null };
  for (const k of Object.keys(obj)) if (!['summary', 'goal_ops', 'trust', 'mem'].includes(k)) fail(errors, `unknown key ${k}`);
  for (const k of ['summary', 'goal_ops', 'trust', 'mem']) if (!(k in obj)) fail(errors, `missing key ${k}`);
  if (errors.length) return { ok: false, errors, value: null };
  if (typeof obj.summary !== 'string' || cp(obj.summary) < 1 || cp(obj.summary) > SUMMARY_MAX_CODEPOINTS) {
    fail(errors, 'summary length out of 1..1200');
  }
  const goalIds = spec.goalIds ?? ['G1', 'G2', 'G3', 'G4'];
  if (!Array.isArray(obj.goal_ops) || obj.goal_ops.length > 2) fail(errors, 'goal_ops is not an array of at most 2');
  else {
    for (const g of obj.goal_ops) {
      if (!isObj(g) || !['progress', 'drop', 'resume'].includes(g.op) || !goalIds.includes(g.id)) fail(errors, 'goal_ops item invalid');
    }
  }
  if (!Array.isArray(obj.trust) || obj.trust.length > 3) fail(errors, 'trust is not an array of at most 3');
  else {
    for (const t of obj.trust) {
      if (!isObj(t) || !(spec.who ?? []).includes(t.who)) fail(errors, 'trust.who not in the menu');
      else if (!Number.isInteger(t.delta) || Math.abs(t.delta) > TRUST_STEP) fail(errors, 'trust.delta not an integer in -10..10');
    }
  }
  if (!Array.isArray(obj.mem)) fail(errors, 'mem is not an array');
  return errors.length ? { ok: false, errors, value: null } : { ok: true, errors, value: obj };
}
