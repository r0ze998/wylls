/**
 * MOCK execution of an adopted plan, standing in for ④'s Run and the
 * chain's instructions. It sends nothing to a chain, a relay or a wallet.
 *
 * Execution does not trust preflight. It takes the signed plan and a run
 * request signed by the plan's user (which plan, a nonce used once, and the
 * batches this run spends), and checks, at the moment each step runs and
 * against the current world:
 *   - the plan is the user's, adopted, not superseded or ended, under its
 *     runs per day, and its pinned definition (version and content hash)
 *     is the one in the registry; the author's publication status does
 *     not matter here;
 *   - the step's effect exists in this world's rules (an S2 effect never
 *     runs on a world that only has main's S1);
 *   - the grant (holder, issuer's revocation, capture, expiry, runs left on
 *     the lot and on the workshop), the places (owner, live, Province), the
 *     free goods (stores minus what batches hold), the batch it consumes,
 *     the balance for the caravan fee, and the vault's cap.
 * Each step's checks and its changes happen in one synchronous block, so
 * two executions interleaved by `await` between steps cannot both spend
 * the same lot runs, goods, balance or batch. A failed step stops the run
 * and is recorded ("失敗は止まるだけ"); earlier steps stay done.
 *
 * Records (evidence) and batches (rights to consume) are kept apart:
 *   - every finished step writes evidence into the ledger: a record of a
 *     past event, never spent, never a source of goods;
 *   - a delivery published as an output also makes a batch in the receiving
 *     vault: its goods are held there for the receiver, who may consume
 *     them once through a consume dependency, or release them to free stock.
 */

import { CanonicalError, clone, contentHash, own, plain } from "./canonical.mjs";
import { DOMAIN, signHash, verifyHash } from "./keys.mjs";
import { EFFECTS } from "./catalog.mjs";
import { finding } from "./codes.mjs";
import { afterRefs, stepOrder } from "./manifest.mjs";
import { resolve, verifyPlanSignature } from "./plan.mjs";
import { verifyEnvelope } from "./registry.mjs";
import { validateDefinition } from "./validate.mjs";
import { balanceOf, batchProblem, citizenOf, freeStock, grantProblem, place, useRunsLeft, workshopRunsLeft } from "./world.mjs";

const yieldTurn = () => new Promise((ok) => setTimeout(ok, 0));

export const RUN_FORMAT = "wylls.creation.run/0";

/**
 * The user's request to run an adopted plan once: signed with the user's
 * key, naming the plan, a nonce never used before for it, and the batches
 * (rights to consume) this run spends. Without it nobody — not even someone
 * holding the signed plan — can make the plan spend the user's goods.
 */
export async function requestRun(signedPlan, { batches = {}, nonce }, userKey) {
  const request = { format: RUN_FORMAT, planHash: signedPlan.hash, nonce: String(nonce), inputs: { batches: { ...batches } } };
  const hash = contentHash(request);
  return { request, hash, signature: await signHash(userKey, DOMAIN.run, hash) };
}

async function requestProblem(req, signed) {
  if (!req?.request) return { reason: "missing" };
  let hash;
  try { hash = contentHash(req.request); } catch { return { reason: "malformed" }; }
  if (hash !== req.hash) return { reason: "hash" };
  if (req.request.format !== RUN_FORMAT || typeof req.request.nonce !== "string" || !req.request.nonce) return { reason: "malformed" };
  if (req.request.planHash !== signed.hash) return { reason: "other-plan" };
  if (!(await verifyHash(signed.plan.actor, DOMAIN.run, hash, req.signature))) return { reason: "not-the-user" };
  return null;
}

export async function execute(signed, ctx, { request, raidAt = null } = {}) {
  const { registry, world, ledger, adoptions } = ctx;
  const log = [];
  const receipts = [];
  const fail = (code, detail = {}, stoppedAt = null) => ({ ok: false, mock: true, world, receipts, log, stoppedAt, failure: finding(code, stoppedAt ? `$.steps.${stoppedAt}` : "$", detail) });

  if (!(await verifyPlanSignature(signed))) return fail("PLAN_SIGNATURE_INVALID");
  let plan;
  try { plan = plain(signed.plan); } catch (e) {
    if (e instanceof CanonicalError) return fail("SHAPE", { detail: "nested too deep" });
    throw e;
  }
  const env = registry.getVersion(plan.manifest);
  if (!env?.manifest || env.hash !== plan.manifest.hash || (await verifyEnvelope(env)).length) return fail("HASH_MISMATCH", { pinned: plan.manifest });
  const m = plain(env.manifest);
  const today = world.today;
  const def = validateDefinition(m, { features: world.features, today });
  const blocking = def.findings.find((f) => f.severity === "error");
  if (blocking) return fail(blocking.code, { from: "the pinned definition in this world", ...strip(blocking) });
  const actor = citizenOf(world, plan.actor);
  if (!actor) return fail("ACTOR_UNKNOWN");
  // adoption, the request's nonce and the runs per day: re-checked and counted in one
  // synchronous block (no await between the last check and the count)
  const adoptionProblem = adoptions ? adoptions.problem(signed.hash) : "PLAN_NOT_ADOPTED";
  if (adoptionProblem) return fail(adoptionProblem);
  const rp = await requestProblem(request, signed);
  if (rp) return fail("RUN_REQUEST_INVALID", rp);
  const inputs = plain(request.request.inputs ?? {});
  if (adoptions.problem(signed.hash)) return fail(adoptions.problem(signed.hash));
  if (!adoptions.useNonce(signed.hash, request.request.nonce)) return fail("RUN_REQUEST_INVALID", { reason: "replayed", nonce: request.request.nonce });
  if (adoptions.runsOn(signed.hash, today) >= m.limits.runsPerDay) return fail("RUNS_PER_DAY_EXCEEDED", { max: m.limits.runsPerDay });
  adoptions.noteRun(signed.hash, today);
  // every run is distinct, so two runs of one plan on one day never share a record id
  world.runSeq = (world.runSeq ?? 0) + 1;
  const run = { seq: world.runSeq, ofPlanToday: adoptions.runsOn(signed.hash, today) };
  const entry = registry.entry(plan.manifest.author, plan.manifest.name);
  if (entry.status !== "listed") log.push(`定義は「${entry.status}」。採用済みの固定版 ${plan.manifest.version}（${plan.manifest.hash.slice(0, 12)}…）のまま続ける`);

  const params = plan.bindings.params ?? {};
  const base = { manifest: plan.manifest, planHash: signed.hash, run, actor, day: today };
  const spentInRun = new Set();
  for (const s of stepOrder(m)) {
    await yieldTurn(); // another execution, an end or a supersede may happen here: re-checked below
    const r = applyStep(s);
    if (!r.ok) {
      receipts.push(ledger.record({ ...base, beneficiary: actor, step: s.id, ...ports(s), outcome: r.code === "RAIDED" ? "raided" : "failed", final: true, reason: r.code, at: r.at ?? null, goods: r.goods ?? null }));
      log.push(`${s.id}: 止まった — ${r.code}`);
      return fail(r.code, r.detail, s.id);
    }
  }
  return { ok: true, mock: true, world, receipts, log, run };

  function ports(s) {
    const port = Object.keys(own(EFFECTS, s.effect).outputs)[0];
    const outputs = Object.entries(m.outputs).filter(([, o]) => o.from?.step === s.id && o.from?.out === port).map(([name]) => name).sort();
    return { port, outputs };
  }

  /** One step: every check, then every change, with no await in between. */
  function applyStep(s) {
    const today = world.today; // the day the step runs on (a run may cross a day)
    const spec = own(EFFECTS, s.effect);
    const no = (code, detail = {}, extra = {}) => ({ ok: false, code, detail, ...extra });
    // the plan and its pinned definition are re-checked at every step
    const ap = adoptions.problem(signed.hash);
    if (ap) return no(ap);
    if (m.validUntilDay != null && today > m.validUntilDay) return no("MANIFEST_EXPIRED", { validUntilDay: m.validUntilDay, today });
    const consumes = afterRefs(s).filter((a) => a.use !== undefined);
    if (consumes.length && s.effect !== "workshop.run") return no("EFFECT_UNKNOWN", { effect: s.effect, detail: "only a step that uses goods may consume a batch" });
    if (s.effect === "caravan.send") {
      const from = resolve(s.args.from, m, params), to = resolve(s.args.to, m, params);
      const cargo = goodsOf(s.args.cargo, params);
      if (!cargo) return no("PARAM_TYPE", { detail: "cargo amounts" });
      const pf = place(world, from), pt = place(world, to);
      if (!pf || !pf.live) return no("PLACE_UNKNOWN", { place: from });
      if (pf.owner !== actor) return no("NOT_OWNER", { place: from, owner: pf.owner });
      if (!pt || !pt.live) return no("PLACE_UNKNOWN", { place: to });
      for (const [r, n] of Object.entries(cargo)) if (freeStock(world, from, r) < n) return no("STOCK_SHORT", { place: from, resource: r, free: freeStock(world, from, r), needs: n });
      if (balanceOf(world, actor) < spec.feeLamports) return no("BALANCE_SHORT", { has: balanceOf(world, actor), needs: spec.feeLamports });
      if (pt.kind === "vault") for (const [r, n] of Object.entries(cargo)) if ((own(pt.stores, r) ?? 0) + n > pt.cap) return no("CAPACITY", { place: to, resource: r, cap: pt.cap });
      // changes
      debit(pf, cargo);
      world.citizens[actor].lamports -= spec.feeLamports;
      if (raidAt === s.id) return no("RAIDED", { detail: "mock raid on the way" }, { at: to, goods: cargo });
      credit(pt, cargo);
      const p = ports(s);
      const ev = ledger.record({ ...base, beneficiary: pt.owner, step: s.id, ...p, outcome: "delivered", final: true, at: to, goods: cargo });
      receipts.push(ev);
      const note = p.outputs.length && pt.kind === "vault" ? `、束 ${makeBatch(to, pt, cargo, ev.id, p.outputs)} として ${pt.owner} のために押さえた` : "";
      log.push(`${s.id}: 荷車 ${from} → ${to} ${fmt(cargo)}（模擬：すぐ着いた${note}）`);
      return { ok: true };
    }
    if (s.effect === "workshop.run") {
      const dep = s.args.via.use;
      const shop = resolve(s.args.via, m, params);
      const vault = resolve(s.args.vault, m, params), runs = resolve(s.args.runs, m, params);
      const lotId = own(plan.bindings.grants, dep);
      const h = place(world, shop);
      if (!h || !h.live || !(h.workshops > 0)) return no("DEPENDENCY_UNAVAILABLE", { place: shop });
      const gp = grantProblem(world, lotId, { actor, kind: "use", sourceId: shop, today });
      if (gp) return no(gp.code, { lot: lotId, ...gp });
      if (!Number.isSafeInteger(runs) || runs < 1) return no("PARAM_TYPE", { detail: "runs" });
      if (useRunsLeft(world, lotId, today) < runs) return no("GRANT_INSUFFICIENT", { lot: lotId, left: useRunsLeft(world, lotId, today), needs: runs, of: "the ticket's runs today" });
      if (workshopRunsLeft(world, shop, today) < runs) return no("GRANT_INSUFFICIENT", { left: workshopRunsLeft(world, shop, today), needs: runs, of: "the workshop's runs today" });
      const pv = place(world, vault);
      if (!pv || !pv.live) return no("PLACE_UNKNOWN", { place: vault });
      if (pv.owner !== actor) return no("NOT_OWNER", { place: vault, owner: pv.owner });
      if (pv.shared) return no("PLACE_MISMATCH", { place: vault, detail: "shared vault" });
      if (String(pv.province) !== String(h.province)) return no("PLACE_MISMATCH", { place: vault, detail: "not in the workshop's Province" });
      const need = scale(spec.takes.perRun, runs);
      // the batches this step waits on: rights to goods held in this vault
      const batches = [];
      for (const a of consumes) {
        const id = own(inputs.batches, a.use);
        if (typeof id === "string" && (spentInRun.has(id) || batches.some((b) => b.id === id))) return no("BATCH_INVALID", { batch: id, reason: "duplicate-in-plan" });
        const bp = batchProblem(world, id, { actor, placeId: vault });
        if (bp) return no("BATCH_INVALID", { batch: id ?? null, ...bp });
        const u = own(m.uses, a.use);
        const bad = ledger.check(world.batches[id].evidence, { producer: u.manifest, output: u.output, outcomeOk: ["delivered", "made"], beneficiary: actor });
        if (bad) return no("RECEIPT_INVALID", { batch: id, ...bad });
        batches.push(world.batches[id]);
      }
      const fromBatch = {};
      for (const [r, n] of Object.entries(need)) {
        let left = n;
        for (const b of batches) { const t = Math.min(left, own(b.remaining, r) ?? 0); fromBatch[r] = (fromBatch[r] ?? 0) + t; left -= t; }
        if (freeStock(world, vault, r) < left) return no("STOCK_SHORT", { place: vault, resource: r, free: freeStock(world, vault, r), needs: left, fromBatch: fromBatch[r] ?? 0 });
      }
      const made = scale(spec.makes.perRun, runs);
      for (const [r, n] of Object.entries(made)) if ((own(pv.stores, r) ?? 0) - (need[r] ?? 0) + n > pv.cap) return no("CAPACITY", { place: vault, resource: r, cap: pv.cap });
      // changes: the batches are spent (what this run did not need goes back to free stock)
      for (const b of batches) {
        spentInRun.add(b.id);
        for (const [r, n] of Object.entries(b.remaining)) pv.held[r] -= n;
        b.remaining = {};
        b.state = "spent";
        b.spentBy = { planHash: signed.hash, step: s.id, day: today };
      }
      debit(pv, need);
      credit(pv, made);
      const lot = world.lots[lotId];
      lot.dayUsed = (lot.day === today ? lot.dayUsed ?? 0 : 0) + runs;
      lot.day = today;
      h.useRuns = (h.useDay === today ? h.useRuns ?? 0 : 0) + runs;
      h.useDay = today;
      const p = ports(s);
      const ev = ledger.record({ ...base, beneficiary: actor, step: s.id, ...p, outcome: "made", final: true, at: vault, goods: made });
      receipts.push(ev);
      const note = p.outputs.length ? `、束 ${makeBatch(vault, pv, made, ev.id, p.outputs)}` : "";
      log.push(`${s.id}: ${shop} の工房を ${runs} 回（${vault} の中で ${fmt(need)} → ${fmt(made)}${batches.length ? `、束 ${batches.map((b) => b.id).join("・")} を使った` : ""}${note}、模擬）`);
      return { ok: true };
    }
    // receipt.withdraw and shares.withdraw are typed and checked, but this mock does not run them
    return no("EFFECT_UNKNOWN", { effect: s.effect, detail: "valid in the catalog, not simulated by this mock executor" });
  }

  function makeBatch(vaultId, pv, goods, evidence, outputs) {
    world.batchSeq = (world.batchSeq ?? 0) + 1;
    const id = `batch:${world.batchSeq}`;
    world.batches ??= {};
    world.batches[id] = { id, vault: vaultId, vaultGen: pv.gen, owner: pv.owner, goods: clone(goods), remaining: clone(goods), evidence, outputs, producer: plan.manifest, state: "open", day: today };
    pv.held ??= {};
    for (const [r, n] of Object.entries(goods)) pv.held[r] = (pv.held[r] ?? 0) + n;
    return id;
  }

  function goodsOf(e, params) {
    const out = {};
    for (const [r, x] of Object.entries(e?.goods ?? {})) {
      const v = resolve(x, m, params);
      if (!Number.isSafeInteger(v) || v < 0) return null;
      out[r] = v;
    }
    return out;
  }
}

/** The owner turns a batch's held goods back into free stock (they no longer back a consume). */
export function releaseBatch(world, batchId, actor) {
  const b = own(world.batches, batchId);
  if (!b || b.owner !== actor || b.state !== "open") return false;
  const pv = place(world, b.vault);
  for (const [r, n] of Object.entries(b.remaining)) pv.held[r] -= n;
  b.remaining = {};
  b.state = "released";
  return true;
}

/** Invariant of the mock world: in every vault, held ≤ stores, and held = Σ open batches' remaining. */
export function checkHoldInvariant(world) {
  const sums = {};
  for (const b of Object.values(world.batches ?? {})) {
    if (b.state !== "open") continue;
    for (const [r, n] of Object.entries(b.remaining)) { sums[b.vault] ??= {}; sums[b.vault][r] = (sums[b.vault][r] ?? 0) + n; }
  }
  const broken = [];
  for (const [id, p] of Object.entries(world.places)) {
    for (const [r, h] of Object.entries(p.held ?? {})) {
      if (h < 0 || h > (p.stores?.[r] ?? 0) || h !== (sums[id]?.[r] ?? 0)) broken.push({ place: id, resource: r, held: h, stores: p.stores?.[r] ?? 0, batches: sums[id]?.[r] ?? 0 });
    }
    for (const [r, n] of Object.entries(sums[id] ?? {})) if ((p.held?.[r] ?? 0) !== n) broken.push({ place: id, resource: r, held: p.held?.[r] ?? 0, batches: n });
  }
  return broken;
}

function strip(f) {
  const { code, severity, stage, path, message, ...rest } = f;
  void code; void severity; void stage; void message;
  return { at: path, ...rest };
}

function scale(per, k) {
  return Object.fromEntries(Object.entries(per).map(([r, n]) => [r, n * k]));
}

function debit(pl, goods) {
  pl.stores ??= {};
  for (const [r, n] of Object.entries(goods)) pl.stores[r] = (pl.stores[r] ?? 0) - n;
}

function credit(pl, goods) {
  pl.stores ??= {};
  for (const [r, n] of Object.entries(goods)) pl.stores[r] = (pl.stores[r] ?? 0) + n;
}

const JA = { food: "食料", wood: "木材", stone: "石", ore: "鉱石", arms: "兵器", gold: "金", science: "学", influence: "影響" };
export function fmt(goods) {
  return Object.entries(goods ?? {}).filter(([, n]) => n).map(([r, n]) => `${JA[r] ?? r}${n}`).join("・") || "なし";
}
