/**
 * Regressions for the defects an independent review found in the first
 * version (each test reproduces one; they failed before the fix).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { validateDefinition } from "../src/validate.mjs";
import { signManifest } from "../src/registry.mjs";
import { preparePlan, preflight } from "../src/plan.mjs";
import { simulateRun } from "../src/run.mjs";
import { requiredBump } from "../src/upgrade.mjs";
import { editForkForRiver, frontSupply, giveUseLot, mineDelivery } from "../src/scenario.mjs";
import { codes, setup } from "./helpers.mjs";

const prep = (s, ref, b, who = "B") => preparePlan(s.registry.getVersion(ref), b, s.keys[who], { world: s.world });

test("a connect target that is not in the world does not pass with any lot bound", async () => {
  const s = await setup();
  const m = frontSupply(s.pubs.A, { name: "ghost" });
  delete m.params.workshop;
  m.uses.ws.target = { place: "village:ghost", type: "workshop" };
  const ref = (await s.registry.publish(await signManifest(m, s.keys.A), s.ctx)).ref;
  const pf = await preflight(await prep(s, ref, { params: { source: "vault:B-home", workVault: "vault:B-work", receiver: "vault:B-home" }, grants: { ws: "lot:anything" } }), s);
  assert.equal(pf.ready, false);
  assert.ok(codes(pf.findings).includes("DEPENDENCY_UNAVAILABLE"));
});

test("one lot bound to two connect dependencies is counted once for both", async () => {
  const s = await setup();
  s.world = giveUseLot(s.world, { to: "B" });
  s.world.places["vault:B-home"].stores = { ore: 200, wood: 100 };
  const m = frontSupply(s.pubs.A, { name: "twice" });
  m.params.runs.max = 3;
  m.uses.ws2 = { relation: "connect", target: { param: "workshop" }, grant: "use", amount: { param: "runs" } };
  m.steps.splice(2, 0, { id: "make2", effect: "workshop.run", after: ["make"], args: { via: { use: "ws2" }, vault: { param: "workVault" }, runs: { param: "runs" } } });
  delete m.claims;
  const pub = await s.registry.publish(await signManifest(m, s.keys.A), s.ctx);
  assert.equal(pub.ok, true, JSON.stringify(pub.findings));
  const b = { params: { source: "vault:B-home", workVault: "vault:B-work", receiver: "vault:B-home", workshop: "village:W", runs: 3 }, grants: { ws: "lot:B-1", ws2: "lot:B-1" } };
  const pf = await preflight(await prep(s, pub.ref, b), s);
  const f = pf.findings.find((x) => x.code === "GRANT_INSUFFICIENT");
  assert.equal(f?.needs, 6);
  assert.equal(f?.left, 3);
});

test("one receipt bound to two consume dependencies is refused", async () => {
  const s = await setup();
  s.world = giveUseLot(s.world, { to: "B" });
  const mineRef = { author: s.pubs.M, name: "mine-delivery", range: "^1.0.0" };
  const m = editForkForRiver(frontSupply(s.pubs.B, { name: "double-dip" }), { mineRef });
  m.uses.ore2 = { ...m.uses.ore };
  m.steps.find((x) => x.id === "make").after = [{ use: "ore" }, { use: "ore2" }];
  delete m.claims;
  const pub = await s.registry.publish(await signManifest(m, s.keys.B), s.ctx);
  assert.equal(pub.ok, true, JSON.stringify(pub.findings));
  const run = await simulateRun(await prep(s, s.refs.M, { params: { buyer: "vault:B-work" } }, "M"), s);
  s.world = run.world;
  const rid = run.receipts[0].id;
  const b = { params: { workVault: "vault:B-work", receiver: "vault:B-home", workshop: "village:W" }, receipts: { ore: rid, ore2: rid } };
  const pf = await preflight(await prep(s, pub.ref, b), s);
  assert.equal(pf.findings.find((f) => f.code === "RECEIPT_INVALID")?.reason, "duplicate-in-plan");
});

test("inherited names are not effects, outputs, triggers or versions", async () => {
  const s = await setup();
  for (const effect of ["constructor", "toString", "__proto__"]) {
    const m = frontSupply(s.pubs.A);
    m.steps[0].effect = effect;
    assert.ok(codes(validateDefinition(m, s.ctx).findings).includes("EFFECT_UNKNOWN"), effect);
  }
  const out = frontSupply(s.pubs.A);
  out.outputs.zz = { from: { step: "make", out: "constructor" } };
  assert.ok(codes(validateDefinition(out, s.ctx).findings).includes("REF_UNKNOWN"));
  const trig = frontSupply(s.pubs.A, { trigger: "toString" });
  assert.ok(codes(validateDefinition(trig, s.ctx).findings).includes("SHAPE"));
  const plan = await prep(s, s.refs.A, {});
  for (const version of ["constructor", "__proto__"]) {
    const bad = structuredClone(plan);
    bad.plan.manifest.version = version;
    const pf = await preflight(bad, s);
    assert.equal(pf.ready, false);
  }
});

test("deep nesting and non-integers are findings, not crashes", async () => {
  const s = await setup();
  let deep = [];
  for (let i = 0; i < 20000; i++) deep = [deep];
  const m = frontSupply(s.pubs.A);
  m.claims.grants = deep;
  assert.ok(codes(validateDefinition(m, s.ctx).findings).includes("SHAPE"));
  const plan = await prep(s, s.refs.A, {});
  const bad = structuredClone(plan);
  bad.plan.bindings.receipts = { x: { receipt: { a: 1.5 } } };
  const pf = await preflight(bad, s);
  assert.ok(codes(pf.findings).includes("PLAN_SIGNATURE_INVALID"));
});

test("a receipt answers to the producer's published output name", async () => {
  const s = await setup();
  const m = mineDelivery(s.pubs.M, { name: "ore-run", outputs: { ore: { from: { step: "ship", out: "delivered" } } } });
  const ref = (await s.registry.publish(await signManifest(m, s.keys.M), s.ctx)).ref;
  const run = await simulateRun(await prep(s, ref, { params: { buyer: "vault:B-work" } }, "M"), s);
  assert.deepEqual(run.receipts[0].receipt.outputs, ["ore"]);
  assert.equal(s.ledger.check(run.receipts[0].id, { output: "ore" }), null);
  assert.equal(s.ledger.check(run.receipts[0].id, { output: "delivered" }).reason, "wrong-output");
});

test("load caps: unbounded cargo, and workshop runs summed over steps", async () => {
  const s = await setup();
  const md = mineDelivery(s.pubs.M);
  delete md.params.ore.max;
  assert.ok(validateDefinition(md, s.ctx).findings.some((f) => f.code === "LIMIT_EXCEEDED" && /cargo ore/.test(f.what)));
  const two = frontSupply(s.pubs.A);
  two.params.runs.max = 24;
  two.params.runs.default = 3;
  two.steps.splice(2, 0, { id: "make2", effect: "workshop.run", after: ["make"], args: { via: { use: "ws" }, vault: { param: "workVault" }, runs: { param: "runs" } } });
  delete two.claims;
  assert.ok(validateDefinition(two, s.ctx).findings.some((f) => f.code === "LIMIT_EXCEEDED" && f.what === "workshop runs per day" && f.got === 48));
});

test("a consume dependency must be waited on by a step", async () => {
  const s = await setup();
  const m = editForkForRiver(frontSupply(s.pubs.B), { mineRef: { author: s.pubs.M, name: "mine-delivery", range: "^1.0.0" } });
  m.steps.find((x) => x.id === "make").after = [];
  assert.ok(validateDefinition(m, s.ctx).findings.some((f) => f.code === "REF_UNKNOWN" && f.path === "$.uses.ore"));
});

test("a new input with a null default is a major change", () => {
  const v1 = frontSupply("ab".repeat(32));
  const v2 = structuredClone(v1);
  v2.params.escort = { type: "int", default: null };
  assert.equal(requiredBump(v1, v2).bump, "major");
});
