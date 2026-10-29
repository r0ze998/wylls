/**
 * The definition validator: a manifest checked on its own, against the
 * effect catalog and the world's feature levels. It is a pure function:
 * the same manifest and context give the same findings and facts.
 *
 * Facts are what the machine can say about the manifest — the paper a user
 * reads is written from them (describe.mjs), and the author's structured
 * claims are compared with them (CLAIM_MISMATCH).
 */

import { CAPS, EFFECTS, NOT_COMPOSABLE, SETUP, TRIGGERS } from "./catalog.mjs";
import { finding } from "./codes.mjs";
import { CLAIM_KEYS, PLACE_ID_RE, RELATIONS, afterRefs, shapeIssues, stepOrder } from "./manifest.mjs";
import { isRange } from "./semver.mjs";
import { isPubHex } from "./keys.mjs";
import { GRANT_SOURCE, RESOURCES, TYPES, assignable, isType } from "./types.mjs";
import { canonicalize } from "./canonical.mjs";

const PROMISE_RE = /保証|必ず届|確実に|絶対|guarantee/i;

export function validateDefinition(m, ctx = {}) {
  const features = ctx.features ?? ["base"];
  const F = [];
  const add = (code, path, detail) => F.push(finding(code, path, detail));
  for (const [code, path, detail] of shapeIssues(m)) add(code, path, detail);
  if (F.length) return { findings: F, facts: null };
  if (!isPubHex(m.author)) add("SHAPE", "$.author", { detail: "raw Ed25519 public key in hex" });

  checkParams(m, add);
  checkUses(m, add);
  const steps = checkSteps(m, features, add);
  const trigger = checkTrigger(m, add);
  checkOutputs(m, steps, add);
  const facts = computeFacts(m, steps, trigger);
  checkLimits(m, steps, facts, add);
  if (m.validUntilDay != null && ctx.today != null && ctx.today > m.validUntilDay) {
    add("MANIFEST_EXPIRED", "$.validUntilDay", { today: ctx.today, validUntilDay: m.validUntilDay });
  }
  checkClaims(m, facts, add);
  if (typeof m.note === "string" && PROMISE_RE.test(m.note)) add("NOTE_PROMISE", "$.note", {});
  return { findings: F, facts };
}

// ---------------------------------------------------------------- params

function checkParams(m, add) {
  const names = Object.keys(m.params);
  if (names.length > CAPS.params) add("LIMIT_EXCEEDED", "$.params", { what: "params", max: CAPS.params, got: names.length });
  for (const [name, p] of Object.entries(m.params)) {
    const path = `$.params.${name}`;
    if (!p || typeof p !== "object" || typeof p.type !== "string") { add("SHAPE", path, { detail: "a param is { type, ja?, default?, min?, max?, own? }" }); continue; }
    if (!isType(p.type) || p.type.startsWith("grant:") || p.type.startsWith("result:")) {
      add("TYPE_UNKNOWN", `${path}.type`, { type: p.type, detail: "params are places, numbers or goods; rights and results come through `uses`" });
      continue;
    }
    for (const k of Object.keys(p)) if (!["type", "ja", "default", "min", "max", "own"].includes(k)) add("SHAPE", `${path}.${k}`, { detail: "unknown field" });
    if (p.own !== undefined && !(TYPES[p.type].place && typeof p.own === "boolean")) add("SHAPE", `${path}.own`, { detail: "own is a boolean on place params" });
    if (p.type === "int") {
      for (const k of ["min", "max"]) if (p[k] !== undefined && !(Number.isSafeInteger(p[k]) && p[k] >= 0)) add("SHAPE", `${path}.${k}`, { detail: "non-negative integer" });
      if (p.default !== undefined && !valueFits(p, p.default)) add("PARAM_TYPE", `${path}.default`, { value: p.default });
    } else if (TYPES[p.type].place) {
      if (p.default !== undefined && p.default !== null && !(typeof p.default === "string" && PLACE_ID_RE.test(p.default))) add("PARAM_TYPE", `${path}.default`, { value: p.default });
    } else if (p.type === "goods" && p.default !== undefined && !goodsValue(p.default)) add("PARAM_TYPE", `${path}.default`, { value: p.default });
  }
}

export function valueFits(p, v) {
  if (p.type === "int") return Number.isSafeInteger(v) && v >= (p.min ?? 0) && (p.max === undefined || v <= p.max);
  if (TYPES[p.type]?.place) return typeof v === "string" && PLACE_ID_RE.test(v);
  if (p.type === "goods") return goodsValue(v);
  return false;
}

function goodsValue(v) {
  return v && typeof v === "object" && !Array.isArray(v) && Object.entries(v).every(([r, n]) => RESOURCES.includes(r) && Number.isSafeInteger(n) && n >= 0);
}

// ---------------------------------------------------------------- uses

function checkUses(m, add) {
  const ids = Object.keys(m.uses);
  if (ids.length > CAPS.dependencies) add("LIMIT_EXCEEDED", "$.uses", { what: "dependencies", max: CAPS.dependencies, got: ids.length });
  for (const [id, u] of Object.entries(m.uses)) {
    const path = `$.uses.${id}`;
    if (!u || typeof u !== "object" || !Object.hasOwn(RELATIONS, u.relation)) {
      add("SHAPE", `${path}.relation`, { detail: `one of ${Object.keys(RELATIONS).join(", ")}` });
      continue;
    }
    if (u.relation === "connect") {
      const allowed = ["relation", "target", "grant", "amount", "ja"];
      for (const k of Object.keys(u)) if (!allowed.includes(k)) add("SHAPE", `${path}.${k}`, { detail: "unknown field" });
      if (!Object.hasOwn(GRANT_SOURCE, u.grant)) { add("SHAPE", `${path}.grant`, { detail: `one of ${Object.keys(GRANT_SOURCE).join(", ")}` }); continue; }
      const t = typeOfExpr(u.target, m, `${path}.target`, add);
      if (t && !assignable(t, GRANT_SOURCE[u.grant])) add("GRANT_KIND_MISMATCH", `${path}.target`, { grant: u.grant, target: t, needs: GRANT_SOURCE[u.grant] });
      if (u.amount !== undefined) expectType(u.amount, "int", m, `${path}.amount`, add);
    } else {
      const allowed = ["relation", "manifest", "output", "type", "ja"];
      for (const k of Object.keys(u)) if (!allowed.includes(k)) add("SHAPE", `${path}.${k}`, { detail: "unknown field" });
      const ref = u.manifest;
      if (!ref || !isPubHex(ref.author) || typeof ref.name !== "string" || !isRange(ref.range) || (ref.hash !== undefined && !/^[0-9a-f]{64}$/.test(ref.hash))) {
        add("SHAPE", `${path}.manifest`, { detail: "{ author, name, range, hash? }" });
      }
      if (typeof u.output !== "string") add("SHAPE", `${path}.output`, { detail: "the dependency's output name" });
      if (!(typeof u.type === "string" && u.type.startsWith("result:") && isType(u.type))) add("TYPE_UNKNOWN", `${path}.type`, { type: u.type, detail: "a result type" });
    }
  }
}

// ---------------------------------------------------------------- expressions

/** The type of an expression, or null after reporting why it has none. */
export function typeOfExpr(e, m, path, add) {
  if (Number.isSafeInteger(e)) return e >= 0 ? "int" : (add("TYPE_MISMATCH", path, { detail: "negative" }), null);
  if (!e || typeof e !== "object" || Array.isArray(e)) { add("TYPE_MISMATCH", path, { detail: "not an expression" }); return null; }
  if ("param" in e) {
    const p = m.params[e.param];
    if (!p) { add("REF_UNKNOWN", path, { param: e.param }); return null; }
    if (e.times !== undefined) {
      if (p.type !== "int" || !(Number.isSafeInteger(e.times) && e.times >= 1)) { add("TYPE_MISMATCH", path, { detail: "times applies to an int param, by a positive integer" }); return null; }
      return "int";
    }
    return p.type;
  }
  if ("use" in e) {
    const u = m.uses[e.use];
    if (!u) { add("REF_UNKNOWN", path, { use: e.use }); return null; }
    if (u.relation === "connect") return typeOfExpr(u.target, m, path, () => {});
    return u.type ?? null;
  }
  if ("step" in e) {
    const s = m.steps.find((x) => x.id === e.step);
    const spec = s && EFFECTS[s.effect];
    const o = spec?.outputs[e.out];
    if (!o) { add("REF_UNKNOWN", path, { step: e.step, out: e.out }); return null; }
    return o.type;
  }
  if ("place" in e) {
    if (!(typeof e.place === "string" && PLACE_ID_RE.test(e.place) && TYPES[e.type]?.place)) { add("TYPE_MISMATCH", path, { detail: "{ place: 'vault:…', type }" }); return null; }
    return e.type;
  }
  if ("goods" in e) {
    if (!e.goods || typeof e.goods !== "object") { add("TYPE_MISMATCH", path, { detail: "{ goods: { resource: amount } }" }); return null; }
    let ok = true;
    for (const [r, x] of Object.entries(e.goods)) {
      if (!RESOURCES.includes(r)) { add("TYPE_MISMATCH", `${path}.goods.${r}`, { detail: "unknown resource" }); ok = false; continue; }
      if (expectType(x, "int", m, `${path}.goods.${r}`, add) === null) ok = false;
    }
    return ok ? "goods" : null;
  }
  add("TYPE_MISMATCH", path, { detail: "not an expression" });
  return null;
}

function expectType(e, want, m, path, add) {
  const t = typeOfExpr(e, m, path, add);
  if (t === null) return null;
  if (!assignable(t, want)) { add("TYPE_MISMATCH", path, { expected: want, got: t }); return null; }
  return t;
}

/** The largest value an int expression can take (Infinity if unbounded). */
export function maxOf(e, m) {
  if (Number.isSafeInteger(e)) return e;
  if (e && typeof e === "object" && "param" in e) {
    const p = m.params[e.param];
    const max = p?.max ?? Infinity;
    return max * (e.times ?? 1);
  }
  return Infinity;
}

/** The value of an int expression under `values` (or the params' defaults), or a symbolic text. */
export function evalInt(e, m, values = {}) {
  if (Number.isSafeInteger(e)) return e;
  if (e && typeof e === "object" && "param" in e) {
    const v = values[e.param] ?? m.params[e.param]?.default;
    if (Number.isSafeInteger(v)) return v * (e.times ?? 1);
    return e.times && e.times !== 1 ? `${e.times}×${e.param}` : e.param;
  }
  return "?";
}

export function exprKey(e) {
  try { return canonicalize(e ?? null); } catch { return "?"; }
}

// ---------------------------------------------------------------- steps

function checkSteps(m, features, add) {
  const ids = new Set();
  const good = [];
  m.steps.forEach((s, i) => {
    const path = `$.steps[${i}]`;
    if (ids.has(s.id)) add("SHAPE", `${path}.id`, { detail: "duplicate step id" });
    ids.add(s.id);
    const spec = EFFECTS[s.effect];
    if (!spec) {
      const nc = NOT_COMPOSABLE[s.effect];
      if (nc?.class === "forbidden") add("EFFECT_FORBIDDEN", `${path}.effect`, { effect: s.effect, reason: nc.ja, ref: nc.ref });
      else if (nc) add("EFFECT_UNKNOWN", `${path}.effect`, { effect: s.effect, extension: nc.ja, ref: nc.ref });
      else if (SETUP[s.effect]) add("EFFECT_UNKNOWN", `${path}.effect`, { effect: s.effect, detail: "setup operation: done once outside the steps" });
      else add("EFFECT_UNKNOWN", `${path}.effect`, { effect: s.effect });
      return;
    }
    if (!features.includes(spec.availability)) add("EFFECT_UNAVAILABLE", `${path}.effect`, { effect: s.effect, availability: spec.availability, features });
    for (const k of Object.keys(s)) if (!["id", "effect", "args", "after", "ja"].includes(k)) add("SHAPE", `${path}.${k}`, { detail: "unknown field" });
    for (const k of Object.keys(s.args)) if (!spec.args[k]) add("SHAPE", `${path}.args.${k}`, { detail: `${s.effect} takes ${Object.keys(spec.args).join(", ")}` });
    for (const [name, a] of Object.entries(spec.args)) {
      const apath = `${path}.args.${name}`;
      const e = s.args[name];
      if (e === undefined) { add("TYPE_MISMATCH", apath, { detail: "missing argument", expected: a.type }); continue; }
      if (a.connect) {
        const u = e && typeof e === "object" && "use" in e ? m.uses[e.use] : null;
        if (!u || u.relation !== "connect") { add("TYPE_MISMATCH", apath, { detail: `needs { use: <connect dependency with grant ${a.connect}> }` }); continue; }
        if (u.grant !== a.connect) { add("GRANT_KIND_MISMATCH", apath, { grant: u.grant, needs: a.connect }); continue; }
      }
      const t = expectType(e, a.type, m, apath, add);
      if (t && a.type === "int" && Number.isSafeInteger(e) && (e < (a.min ?? 0) || (a.max !== undefined && e > a.max))) add("TYPE_MISMATCH", apath, { detail: `between ${a.min ?? 0} and ${a.max}` });
    }
    for (const [j, ref] of afterRefs(s).entries()) {
      const apath = `${path}.after[${j}]`;
      if (ref.step !== undefined) { if (!m.steps.some((x) => x.id === ref.step)) add("REF_UNKNOWN", apath, { step: ref.step }); }
      else if (ref.use !== undefined) { if (m.uses[ref.use]?.relation !== "consume") add("REF_UNKNOWN", apath, { detail: "after names a step or a consume dependency", use: ref.use }); }
      else add("SHAPE", apath, { detail: "a step id or { use }" });
    }
    good.push(s);
  });
  if (m.steps.length === 0) add("SHAPE", "$.steps", { detail: "at least one step" });
  const cycle = findStepCycle(m.steps);
  if (cycle) add("STEP_CYCLE", "$.steps", { cycle });
  for (const s of good) checkFlow(m, s, add);
  return good;
}

function stepEdges(s) {
  const out = afterRefs(s).filter((r) => r.step !== undefined).map((r) => r.step);
  for (const e of Object.values(s.args ?? {})) if (e && typeof e === "object" && "step" in e) out.push(e.step);
  return out;
}

function findStepCycle(steps) {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const state = new Map();
  const stack = [];
  const visit = (id) => {
    if (state.get(id) === 2) return null;
    if (state.get(id) === 1) return [...stack.slice(stack.indexOf(id)), id];
    state.set(id, 1);
    stack.push(id);
    for (const next of stepEdges(byId.get(id) ?? { args: {} })) {
      if (!byId.has(next)) continue;
      const c = visit(next);
      if (c) return c;
    }
    stack.pop();
    state.set(id, 2);
    return null;
  };
  for (const s of steps) { const c = visit(s.id); if (c) return c; }
  return null;
}

/** A step that waits for a delivery must take its materials where that delivery lands. */
function checkFlow(m, s, add) {
  const spec = EFFECTS[s.effect];
  if (!spec.takes?.perRun) return; // a caravan may wait for any delivery; only materials must land where they are used
  const takeAt = s.args[spec.takes.place];
  if (takeAt === undefined) return;
  const delivered = {};
  for (const ref of afterRefs(s)) {
    const prev = ref.step !== undefined ? m.steps.find((x) => x.id === ref.step) : null;
    if (!prev || !EFFECTS[prev.effect]) continue;
    const out = Object.values(EFFECTS[prev.effect].outputs)[0];
    if (out.type !== "result:delivery") continue;
    if (exprKey(prev.args[out.at]) !== exprKey(takeAt)) {
      add("FLOW_PLACE_MISMATCH", `$.steps[${m.steps.indexOf(s)}].after`, { step: s.id, waitsFor: prev.id, deliveredTo: prev.args[out.at], takesFrom: takeAt });
      continue;
    }
    const goods = prev.args.cargo?.goods ?? {};
    for (const [r, x] of Object.entries(goods)) {
      const v = evalInt(x, m);
      if (Number.isSafeInteger(v)) delivered[r] = (delivered[r] ?? 0) + v;
    }
  }
  if (!Object.keys(delivered).length) return;
  const runs = evalInt(s.args.runs, m);
  if (!Number.isSafeInteger(runs)) return;
  for (const [r, per] of Object.entries(spec.takes.perRun)) {
    if ((delivered[r] ?? 0) < per * runs) add("FLOW_SHORT", `$.steps[${m.steps.indexOf(s)}]`, { resource: r, delivered: delivered[r] ?? 0, needs: per * runs });
  }
}

function checkTrigger(m, add) {
  const declared = m.trigger ?? "manual";
  const t = TRIGGERS[declared];
  if (!t) { add("SHAPE", "$.trigger", { detail: `one of ${Object.keys(TRIGGERS).join(", ")}` }); return { declared, effective: "manual" }; }
  if (!t.available) add("TRIGGER_UNAVAILABLE", "$.trigger", { trigger: declared, detail: t.ja });
  return { declared, effective: t.available ? declared : "manual" };
}

function checkOutputs(m, steps, add) {
  for (const [name, o] of Object.entries(m.outputs)) {
    const path = `$.outputs.${name}`;
    if (!o || typeof o !== "object" || !o.from) { add("SHAPE", path, { detail: "{ from: { step, out } }" }); continue; }
    typeOfExpr(o.from, m, `${path}.from`, add);
  }
}

// ---------------------------------------------------------------- facts

function computeFacts(m, steps, trigger) {
  const levels = [...new Set(steps.map((s) => EFFECTS[s.effect].availability))];
  const grants = Object.entries(m.uses).filter(([, u]) => u.relation === "connect").map(([dep, u]) => ({ dep, kind: u.grant, target: u.target, amount: u.amount ?? null }));
  const consumes = Object.entries(m.uses).filter(([, u]) => u.relation === "consume").map(([dep, u]) => ({ dep, manifest: u.manifest, output: u.output, type: u.type }));
  let tx = 0, cu = 0, feeLamports = 0, caravans = 0;
  const failures = [];
  const signerSteps = [];
  // Net inputs: goods a run must find in a place before it starts, i.e.
  // what no earlier step of the same run brings there.
  const balance = new Map();
  const inputs = [];
  const bring = (at, goods, kx) => {
    const k = kx === 1 ? 1 : evalInt(kx, m);
    const key = exprKey(at ?? null);
    const b = balance.get(key) ?? {};
    for (const [r, x] of Object.entries(goods ?? {})) b[r] = plus(b[r] ?? 0, times(evalInt(x, m), k));
    balance.set(key, b);
  };
  const need = (at, goods, kx) => {
    const k = kx === 1 ? 1 : evalInt(kx, m);
    const key = exprKey(at ?? null);
    const b = balance.get(key) ?? {};
    const short = {};
    for (const [r, x] of Object.entries(goods ?? {})) {
      const n = times(evalInt(x, m), k);
      const have = b[r] ?? 0;
      if (Number.isSafeInteger(n) && Number.isSafeInteger(have)) {
        if (have >= n) b[r] = have - n;
        else { short[r] = n - have; b[r] = 0; }
      } else short[r] = n;
    }
    balance.set(key, b);
    if (Object.keys(short).length) inputs.push({ at, goods: short });
  };
  for (const s of stepOrder({ steps })) {
    const spec = EFFECTS[s.effect];
    tx += spec.tx; cu += spec.cu; feeLamports += spec.feeLamports;
    if (spec.feeLamports > 0) caravans += 1;
    for (const f of spec.failures) failures.push({ step: s.id, text: f });
    if (s.effect === "caravan.send") { need(s.args.from, s.args.cargo?.goods, 1); bring(s.args.to, s.args.cargo?.goods, 1); }
    if (spec.takes?.perRun) need(s.args[spec.takes.place], spec.takes.perRun, s.args.runs);
    if (spec.makes?.perRun) bring(s.args[spec.makes.place], spec.makes.perRun, s.args.runs);
    if (spec.walletUnlessOwn) {
      const to = s.args[spec.walletUnlessOwn];
      const own = to && typeof to === "object" && "param" in to && m.params[to.param]?.own === true;
      signerSteps.push({ step: s.id, to, signer: own ? "session" : "wallet-unless-own" });
    }
  }
  for (const g of grants) failures.push({ dep: g.dep, text: "接続先が奪われる・閉じると、札は無効になり止まる" });
  for (const c of consumes) failures.push({ dep: c.dep, text: "使う成果の完了記録が台帳で確かめられないと、始まらない" });
  const outputsPerRun = {};
  const deliversTo = [];
  for (const o of Object.values(m.outputs)) {
    const s = m.steps.find((x) => x.id === o.from?.step);
    const spec = s && EFFECTS[s.effect];
    const out = spec?.outputs[o.from.out];
    if (!out) continue;
    if (out.goods === "cargo") addGoods(outputsPerRun, s.args.cargo?.goods, m, 1);
    else if (out.perRun) addGoods(outputsPerRun, out.perRun, m, s.args.runs);
    else outputsPerRun["*"] = out.goods;
    const at = s.args[out.at];
    const where = at && typeof at === "object" ? at.param ?? at.place : undefined;
    if (typeof where === "string") deliversTo.push(where);
  }
  const runsPerDay = m.limits.runsPerDay;
  return {
    levels,
    trigger: trigger.effective,
    declaredTrigger: trigger.declared,
    runsPerDay,
    grants,
    consumes,
    perRun: { tx, cu, feeLamports, caravans, inputs },
    perDay: Number.isSafeInteger(runsPerDay) ? { tx: tx * runsPerDay, cu: cu * runsPerDay, feeLamports: feeLamports * runsPerDay } : null,
    outputsPerRun,
    deliversTo: deliversTo.sort(),
    signer: signerSteps.every((x) => x.signer === "session") ? "session" : "wallet-unless-own",
    signerSteps,
    failures,
    placeRules: placeRules(m, steps),
  };
}

function times(v, k) {
  if (k === 1) return v;
  return Number.isSafeInteger(v) && Number.isSafeInteger(k) ? v * k : `${v}×${k}`;
}

function plus(a, b) {
  return Number.isSafeInteger(a) && Number.isSafeInteger(b) ? a + b : `${a}+${b}`;
}

function addGoods(acc, goods, m, multiplier) {
  if (!goods) return;
  const k = multiplier === 1 ? 1 : evalInt(multiplier, m);
  for (const [r, x] of Object.entries(goods)) {
    const v = evalInt(x, m);
    const total = Number.isSafeInteger(v) && Number.isSafeInteger(k) ? v * k : `${v}${k === 1 ? "" : `×${typeof k === "number" ? k : `(${k})`}`}`;
    const prev = acc[r];
    if (prev === undefined) acc[r] = total;
    else acc[r] = Number.isSafeInteger(prev) && Number.isSafeInteger(total) ? prev + total : `${prev}+${total}`;
  }
}

/** The place conditions the preflight checks once a user binds the params. */
function placeRules(m, steps) {
  const rules = [];
  for (const s of steps) {
    for (const [name, a] of Object.entries(EFFECTS[s.effect].args)) {
      const e = s.args[name];
      if (a.own) rules.push({ step: s.id, arg: name, rule: "own", expr: e });
      if (a.unshared) rules.push({ step: s.id, arg: name, rule: "unshared", expr: e });
      if (a.sameProvinceAs) rules.push({ step: s.id, arg: name, rule: "sameProvince", expr: e, as: s.args[a.sameProvinceAs] });
      if (TYPES[a.type]?.place && !a.connect) rules.push({ step: s.id, arg: name, rule: "type", expr: e, type: a.type });
    }
  }
  for (const [name, p] of Object.entries(m.params)) if (p.own) rules.push({ param: name, rule: "own", expr: { param: name } });
  return rules;
}

// ---------------------------------------------------------------- limits

function checkLimits(m, steps, facts, add) {
  const rpd = m.limits.runsPerDay;
  for (const k of Object.keys(m.limits)) if (k !== "runsPerDay") add("SHAPE", `$.limits.${k}`, { detail: "unknown limit" });
  if (!(Number.isSafeInteger(rpd) && rpd >= 1)) { add("SHAPE", "$.limits.runsPerDay", { detail: "a positive integer" }); return; }
  const over = (what, got, max, path = "$.limits") => add("LIMIT_EXCEEDED", path, { what, got, max });
  if (m.steps.length > CAPS.steps) over("steps", m.steps.length, CAPS.steps, "$.steps");
  if (rpd > CAPS.runsPerDay) over("runsPerDay", rpd, CAPS.runsPerDay);
  if (facts.perRun.caravans > CAPS.caravansPerRun) over("caravansPerRun", facts.perRun.caravans, CAPS.caravansPerRun, "$.steps");
  if (facts.perDay.tx > CAPS.txPerDay) over("txPerDay", facts.perDay.tx, CAPS.txPerDay);
  if (facts.perDay.cu > CAPS.cuPerDay) over("cuPerDay", facts.perDay.cu, CAPS.cuPerDay);
  steps.forEach((s) => {
    const i = m.steps.indexOf(s);
    if (s.effect === "workshop.run") {
      const max = maxOf(s.args.runs, m);
      if (max === Infinity) over("workshop runs (unbounded: give the param a max)", "∞", CAPS.runsPerDay, `$.steps[${i}].args.runs`);
      else if (max * rpd > CAPS.runsPerDay) over("workshop runs per day", max * rpd, CAPS.runsPerDay, `$.steps[${i}].args.runs`);
    }
    if (s.effect === "receipt.withdraw" && maxOf(s.args.amount, m) === Infinity) over("receipt amount (unbounded: give the param a max)", "∞", "max", `$.steps[${i}].args.amount`);
  });
  for (const [id, u] of Object.entries(m.uses)) {
    if (u.relation === "connect" && u.amount !== undefined && maxOf(u.amount, m) === Infinity) over("grant amount (unbounded: give the param a max)", "∞", "max", `$.uses.${id}.amount`);
  }
}

// ---------------------------------------------------------------- claims

function same(a, b) {
  return exprKey(a) === exprKey(b);
}

function checkClaims(m, facts, add) {
  const claims = m.claims ?? {};
  for (const [key, value] of Object.entries(claims)) {
    const path = `$.claims.${key}`;
    if (!CLAIM_KEYS.includes(key)) { add("CLAIM_UNKNOWN", path, { key }); continue; }
    let machine;
    switch (key) {
      case "trigger": machine = facts.trigger; break;
      case "runsPerDay": machine = facts.runsPerDay; break;
      case "outputsPerRun": machine = facts.outputsPerRun; break;
      case "grants": machine = [...new Set(facts.grants.map((g) => g.kind))].sort(); break;
      case "signer": machine = facts.signer; break;
      case "deliversTo": machine = facts.deliversTo; break;
      case "consumes": machine = facts.consumes.map((c) => c.dep).sort(); break;
    }
    const claimed = Array.isArray(value) ? [...value].sort() : value;
    if (!same(claimed, machine)) add("CLAIM_MISMATCH", path, { claimed: value, machine });
  }
}

export { RELATIONS };
