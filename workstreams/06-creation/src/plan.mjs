/**
 * A user's plan: one published manifest version, bound to the user's own
 * places, grants and results, and signed by the user.
 *
 * Preparing a plan needs the published envelope (public data) and the
 * user's own key — never the author's. The author's signature is checked
 * with the author's public key only. Preflight then says, before anything
 * runs, what is missing: rights, places, results, stock, capacity, and
 * which steps need the wallet rather than the game's session key.
 */

import { CanonicalError, contentHash, own, plain } from "./canonical.mjs";
import { EFFECTS } from "./catalog.mjs";
import { finding, hasErrors } from "./codes.mjs";
import { DOMAIN, signHash, verifyHash } from "./keys.mjs";
import { verifyEnvelope } from "./registry.mjs";
import { GRANT_SOURCE, RESOURCES, placeKindsOf } from "./types.mjs";
import { evalInt, validateDefinition, valueFits } from "./validate.mjs";
import { afterRefs, stepOrder } from "./manifest.mjs";
import { candidateLots, citizenOf, grantProblem, place, useRunsLeft, workshopRunsLeft } from "./world.mjs";

export const PLAN_FORMAT = "wylls.creation.plan/0";

/**
 * Bind a published manifest for `userKey`. Grants the caller did not name
 * are filled with the user's own matching lots when the world shows one.
 * The result is signed by the user; it is not checked here (preflight).
 */
export async function preparePlan(env, bindings, userKey, { world, today } = {}) {
  const m = env.manifest;
  const grants = { ...(bindings.grants ?? {}) };
  const actor = world ? citizenOf(world, userKey.pub) : null;
  if (world && actor) {
    for (const [dep, u] of Object.entries(m.uses)) {
      if (u.relation !== "connect" || grants[dep]) continue;
      const sourceId = resolve(u.target, m, bindings.params ?? {});
      if (typeof sourceId !== "string") continue;
      const lots = candidateLots(world, { actor, kind: u.grant, sourceId, today: today ?? world.today });
      if (lots.length) grants[dep] = lots[0];
    }
  }
  const plan = {
    format: PLAN_FORMAT,
    manifest: { author: m.author, name: m.name, version: m.version, hash: env.hash },
    actor: userKey.pub,
    bindings: { params: { ...(bindings.params ?? {}) }, grants, receipts: { ...(bindings.receipts ?? {}) } },
    preparedDay: today ?? world?.today ?? null,
  };
  const hash = contentHash(plan);
  return { plan, hash, signature: await signHash(userKey, DOMAIN.plan, hash) };
}

export async function verifyPlanSignature(signed) {
  let hash;
  try { hash = contentHash(signed?.plan); } catch { return false; }
  return hash === signed.hash && verifyHash(signed.plan.actor, DOMAIN.plan, hash, signed.signature);
}

/** The value an expression names under a plan's bindings: a place id, an int, or undefined. */
export function resolve(e, m, params) {
  if (Number.isSafeInteger(e)) return e;
  if (!e || typeof e !== "object") return undefined;
  if ("param" in e) {
    const v = own(params, e.param) ?? own(m.params, e.param)?.default;
    if (v === undefined || v === null) return undefined;
    if (e.times) return Number.isSafeInteger(v) ? v * e.times : undefined;
    return typeof v === "string" || Number.isSafeInteger(v) ? v : undefined;
  }
  if ("place" in e) return e.place;
  if ("use" in e) {
    const u = own(m.uses, e.use);
    return u?.relation === "connect" ? resolve(u.target, m, params) : undefined;
  }
  return undefined;
}

function goodsOf(e, m, params) {
  const out = {};
  for (const [r, x] of Object.entries(e?.goods ?? {})) out[r] = resolve(x, m, params);
  return out;
}

/**
 * Check a signed plan before it runs. Returns { ready, findings, signers,
 * costs, def }. `ctx` is { registry, world, ledger }.
 */
export async function preflight(signed, ctx) {
  const { registry, world, ledger } = ctx;
  const F = [];
  const add = (code, path, detail) => F.push(finding(code, path, detail));
  const today = world.today;

  if (!(await verifyPlanSignature(signed))) add("PLAN_SIGNATURE_INVALID", "$.plan", {});
  let plan;
  try { plan = plain(signed.plan); } catch (e) {
    if (!(e instanceof CanonicalError)) throw e;
    return done([...F, finding("SHAPE", e.path, { detail: "nested too deep" })]);
  }
  if (!plan?.manifest || !plan.bindings) return done([...F, finding("SHAPE", "$.plan", { detail: "{ manifest, actor, bindings }" })]);
  const env = registry.getVersion(plan.manifest);
  if (!env?.manifest) return done([finding("DEPENDENCY_UNKNOWN", "$.plan.manifest", { ref: plan.manifest })]);
  if (env.hash !== plan.manifest.hash) add("HASH_MISMATCH", "$.plan.manifest.hash", { pinned: plan.manifest.hash, listed: env.hash });
  F.push(...(await verifyEnvelope(env)));
  const entry = registry.entry(plan.manifest.author, plan.manifest.name);
  if (entry.status !== "listed") add("ENTRY_NOT_LISTED", "$.plan.manifest", { status: entry.status });

  const m = plain(env.manifest);
  const def = validateDefinition(m, { features: world.features, today });
  F.push(...def.findings.filter((f) => f.severity !== "info"));
  F.push(...registry.checkDependencies(m));
  const actor = citizenOf(world, plan.actor);
  if (!actor) { add("ACTOR_UNKNOWN", "$.plan.actor", {}); return done(F, def); }
  if (!def.facts) return done(F, def);

  const params = plan.bindings.params ?? Object.create(null);
  const grantsBound = plan.bindings.grants ?? Object.create(null);
  const receiptsBound = plan.bindings.receipts ?? Object.create(null);
  // inputs: bound, typed, existing, owned where asked
  for (const [name, p] of Object.entries(m.params)) {
    const path = `$.plan.bindings.params.${name}`;
    const v = own(params, name) ?? p.default;
    if (v === undefined || v === null) { add("PARAM_UNBOUND", path, { param: name, type: p.type, ja: p.ja }); continue; }
    if (!valueFits(p, v)) { add("PARAM_TYPE", path, { param: name, value: v, type: p.type }); continue; }
    if (placeKindsOf(p.type).length) checkPlace(world, v, p.type, path, add, { owner: p.own ? actor : null });
    if (own(params, name) === undefined && placeKindsOf(p.type).length && place(world, v) && place(world, v).owner !== actor) {
      add("PARAM_DEFAULT_FOREIGN", path, { param: name, place: v, owner: place(world, v).owner });
    }
  }
  // place rules of the steps
  for (const r of def.facts.placeRules) {
    if (r.param) continue;
    const id = resolve(r.expr, m, params);
    if (typeof id !== "string") continue;
    const pl = place(world, id);
    const path = `$.steps.${r.step}.args.${r.arg}`;
    if (!pl) continue; // reported with the param
    if (r.rule === "own" && pl.owner !== actor) add("NOT_OWNER", path, { place: id, owner: pl.owner });
    if (r.rule === "unshared" && pl.shared) add("PLACE_MISMATCH", path, { place: id, detail: "a shared vault cannot host a use run" });
    if (r.rule === "type" && !placeKindsOf(r.type).includes(pl.kind)) add("PARAM_TYPE", path, { place: id, expected: r.type, got: pl.kind });
    if (r.rule === "sameProvince") {
      const other = place(world, resolve(r.as, m, params));
      if (other && String(other.province) !== String(pl.province)) add("PLACE_MISMATCH", path, { place: id, province: pl.province, mustBe: other.province, detail: "the vault must be in the workshop's Province (S2 L4)" });
    }
  }
  // B: connections to someone else's running facility, through the user's own grant
  const grantsUsed = {};
  const runsByLot = new Map(); // lot → [runs needed, path, dep]; one lot may serve several dependencies
  const runsByShop = new Map();
  for (const [dep, u] of Object.entries(m.uses)) {
    if (u.relation !== "connect") continue;
    const path = `$.plan.bindings.grants.${dep}`;
    const sourceId = resolve(u.target, m, params);
    const lotId = own(grantsBound, dep);
    if (typeof sourceId !== "string") {
      add("MISSING_GRANT", path, { dep, kind: u.grant, source: null, ja: GRANT_JA[u.grant], detail: "接続先の入力が未設定" });
      continue;
    }
    if (!place(world, sourceId)) {
      add("DEPENDENCY_UNAVAILABLE", `$.uses.${dep}`, { place: sourceId, detail: "no such place in the world" });
      continue;
    }
    const src = place(world, sourceId);
    if (!src.live || (u.grant === "use" && !(src.workshops > 0))) {
      add("DEPENDENCY_UNAVAILABLE", `$.uses.${dep}`, { place: sourceId, detail: src.live ? "no workshop left" : "closed or seized" });
      continue;
    }
    if (typeof lotId !== "string") { add("MISSING_GRANT", path, { dep, kind: u.grant, source: sourceId, owner: src.owner, ja: GRANT_JA[u.grant] }); continue; }
    const problem = grantProblem(world, lotId, { actor, kind: u.grant, sourceId, today });
    if (problem) { add(problem.code, path, { dep, lot: lotId, ...problem }); continue; }
    grantsUsed[dep] = lotId;
    if (u.grant === "use") {
      const needed = runsNeeded(m, dep, params);
      runsByLot.set(lotId, { needed: (runsByLot.get(lotId)?.needed ?? 0) + needed, path, dep });
      runsByShop.set(sourceId, { needed: (runsByShop.get(sourceId)?.needed ?? 0) + needed, path, dep, lot: lotId });
    }
  }
  for (const [lotId, x] of runsByLot) {
    const left = useRunsLeft(world, lotId, today);
    if (x.needed > left) add("GRANT_INSUFFICIENT", x.path, { dep: x.dep, lot: lotId, needs: x.needed, left, of: "the ticket's runs today" });
  }
  for (const [shop, x] of runsByShop) {
    const left = workshopRunsLeft(world, shop, today);
    if (x.needed > left) add("GRANT_INSUFFICIENT", x.path, { dep: x.dep, lot: x.lot, needs: x.needed, left, of: "the workshop's runs today, across every ticket" });
  }
  // C: finished results of other definitions' runs
  const receiptsUsed = {};
  const receiptIds = new Map();
  for (const [dep, u] of Object.entries(m.uses)) {
    if (u.relation !== "consume") continue;
    const path = `$.plan.bindings.receipts.${dep}`;
    const claim = own(receiptsBound, dep);
    const bad = ledger.check(claim, {
      producer: u.manifest,
      output: u.output,
      outcomeOk: ["delivered", "made"],
      beneficiary: actor,
    });
    if (bad) { add("RECEIPT_INVALID", path, { dep, ...bad }); continue; }
    const rid = typeof claim === "string" ? claim : contentHash(claim.receipt ?? claim);
    if (receiptIds.has(rid)) { add("RECEIPT_INVALID", path, { dep, reason: "duplicate-in-plan", id: rid, alsoFor: receiptIds.get(rid) }); continue; }
    receiptIds.set(rid, dep);
    const r = ledger.get(rid);
    receiptsUsed[dep] = r;
    for (const s of m.steps) {
      if (!afterRefs(s).some((a) => a.use === dep)) continue;
      const spec = own(EFFECTS, s.effect);
      const takeAt = spec?.takes ? resolve(s.args[spec.takes.place], m, params) : undefined;
      if (takeAt && r.at !== takeAt) add("RECEIPT_INVALID", path, { dep, reason: "place-mismatch", deliveredTo: r.at, takesFrom: takeAt });
    }
  }
  // goods and capacity, step by step, before any raid
  const signers = [];
  const costs = { feeLamports: def.facts.perRun.feeLamports, tx: def.facts.perRun.tx, cu: def.facts.perRun.cu, materials: {} };
  dryRun(m, params, world, actor, add, signers, costs);
  for (const s of signers) if (s.signer === "wallet") add("WALLET_REQUIRED", `$.steps.${s.step}`, { to: s.to, owner: s.owner });
  return done(F, def, { signers, costs, grantsUsed, receiptIds: Object.fromEntries([...receiptIds].map(([id, dep]) => [dep, id])), actor });

  function done(findings, d = null, extra = {}) {
    return { ready: !hasErrors(findings), findings, def: d, ...extra };
  }
}

const GRANT_JA = { use: "使用権の札", share: "持ち分の札", receipt: "受け取りの札" };

function runsNeeded(m, dep, params) {
  let runs = 0;
  for (const s of m.steps) {
    if (s.effect === "workshop.run" && s.args.via?.use === dep) runs += resolve(s.args.runs, m, params) ?? 0;
  }
  return runs * m.limits.runsPerDay;
}

function checkPlace(world, id, type, path, add, { owner }) {
  const pl = place(world, id);
  if (!pl) { add("PLACE_UNKNOWN", path, { place: id }); return; }
  if (!placeKindsOf(type).includes(pl.kind) || (type === "workshop" && !(pl.workshops > 0))) {
    add("PARAM_TYPE", path, { place: id, expected: type, got: pl.kind });
    return;
  }
  if (owner && pl.owner !== owner) add("NOT_OWNER", path, { place: id, owner: pl.owner });
}

function stores(world, id, cache) {
  if (!cache.has(id)) cache.set(id, { ...(place(world, id)?.stores ?? {}) });
  return cache.get(id);
}

/** Walk the steps once over a copy of the stores: stock short, capacity, signers. */
function dryRun(m, params, world, actor, add, signers, costs) {
  // A consumed delivery is already in the stores of the place it names.
  const cache = new Map();
  for (const s of stepOrder(m)) {
    const spec = own(EFFECTS, s.effect);
    const path = `$.steps.${s.id}`;
    if (s.effect === "caravan.send") {
      const from = resolve(s.args.from, m, params), to = resolve(s.args.to, m, params);
      const cargo = goodsOf(s.args.cargo, m, params);
      take(world, cache, from, cargo, path, add, costs);
      give(world, cache, to, cargo, path, add);
    } else if (s.effect === "workshop.run") {
      const vault = resolve(s.args.vault, m, params), runs = resolve(s.args.runs, m, params);
      const need = Object.fromEntries(Object.entries(spec.takes.perRun).map(([r, n]) => [r, n * runs]));
      take(world, cache, vault, need, path, add, costs);
      give(world, cache, vault, Object.fromEntries(Object.entries(spec.makes.perRun).map(([r, n]) => [r, n * runs])), path, add, true);
    }
    if (spec.walletUnlessOwn) {
      const to = resolve(s.args[spec.walletUnlessOwn], m, params);
      const owner = place(world, to)?.owner ?? null;
      if (typeof to === "string") signers.push({ step: s.id, to, owner, signer: owner === actor ? "session" : "wallet" });
    }
  }
}

function take(world, cache, id, goods, path, add, costs) {
  if (!place(world, id)) return;
  const st = stores(world, id, cache);
  for (const [r, n] of Object.entries(goods)) {
    if (!RESOURCES.includes(r) || !Number.isSafeInteger(n)) continue;
    costs.materials[r] = (costs.materials[r] ?? 0) + n;
    if ((st[r] ?? 0) < n) add("STOCK_SHORT", path, { place: id, resource: r, has: st[r] ?? 0, needs: n });
    st[r] = Math.max(0, (st[r] ?? 0) - n);
  }
}

function give(world, cache, id, goods, path, add, refuse = false) {
  const pl = place(world, id);
  if (!pl || pl.kind !== "vault") return;
  const st = stores(world, id, cache);
  for (const [r, n] of Object.entries(goods)) {
    if (!Number.isSafeInteger(n)) continue;
    st[r] = (st[r] ?? 0) + n;
    if (st[r] > pl.cap) add("CAPACITY", path, { place: id, resource: r, would: st[r], cap: pl.cap, detail: refuse ? "the run is refused (BadData)" : "the excess is lost on arrival" });
  }
}

export { GRANT_SOURCE, stepOrder };
