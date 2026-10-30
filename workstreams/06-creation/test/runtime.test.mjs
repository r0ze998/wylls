/**
 * What changes between preflight (and adoption) and execution. Preflight
 * is advice on a snapshot; execution re-checks every right, balance, good,
 * capacity and the world's rules at the moment each step runs.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { contentHash } from "../src/canonical.mjs";
import { signManifest } from "../src/registry.mjs";
import { giveUseLot, mineDelivery } from "../src/scenario.mjs";
import { adopt, codes, exec, execute, prepare, preflight, requestRun, setup } from "./helpers.mjs";

const BIND = { params: { source: "vault:B-home", workVault: "vault:B-work", receiver: "vault:B-home", workshop: "village:W" } };

async function adopted() {
  const s = await setup();
  s.world = giveUseLot(s.world, { to: "B" });
  s.world.places["vault:B-home"].stores = { ore: 60, wood: 30 };
  const plan = await adopt(s, "B", s.refs.A, BIND);
  assert.equal((await preflight(plan, s)).ready, true);
  return { s, plan };
}

const CHANGES = [
  ["W revokes the issue (mock)", (w) => { w.issues["issue:W-1"].state = "revoked"; }, "GRANT_REVOKED", "make"],
  ["the day passes the lot's end", (w) => { w.today = 31; }, "GRANT_EXPIRED", "make"],
  ["W's village is captured", (w) => { w.places["village:W"].gen = 2; }, "GRANT_VOID", "make"],
  ["W's village is closed", (w) => { w.places["village:W"].live = false; }, "DEPENDENCY_UNAVAILABLE", "make"],
  ["B gave the lot away", (w) => { w.lots["lot:B-1"].holder = "D"; }, "GRANT_NOT_HELD", "make"],
  ["other ticket holders used the workshop's 48 runs", (w) => { w.places["village:W"].useDay = w.today; w.places["village:W"].useRuns = 47; }, "GRANT_INSUFFICIENT", "make"],
  ["B spent the lamports", (w) => { w.citizens.B.lamports = 0; }, "BALANCE_SHORT", "haul"],
  ["B's materials left", (w) => { w.places["vault:B-home"].stores = { ore: 0, wood: 0 }; }, "STOCK_SHORT", "haul"],
  ["the receiving vault filled up", (w) => { w.places["vault:B-home"].stores.arms = 4995; }, "CAPACITY", "ship"],
  ["B's work vault was seized", (w) => { w.places["vault:B-work"].owner = "D"; }, "NOT_OWNER", "make"],
];

for (const [what, change, code, step] of CHANGES) {
  test(`after preflight and adoption: ${what} → ${code} at ${step}`, async () => {
    const { s, plan } = await adopted();
    change(s.world);
    const run = await exec(s, plan);
    assert.equal(run.ok, false);
    assert.equal(run.failure.code, code, JSON.stringify(run.failure));
    assert.equal(run.stoppedAt, step);
    // the stop is recorded as evidence of a failed step, never of a success
    assert.equal(run.receipts.at(-1).receipt.outcome, "failed");
    // preflight now says so too (it is advice, re-run on the new snapshot)
    assert.ok(codes((await preflight(plan, s)).findings, { severities: ["error", "warning"] }).includes(code));
  });
}

test("a step that fails mid-run stops the run; the steps before it stay done", async () => {
  const { s, plan } = await adopted();
  s.world.places["vault:B-home"].stores.arms = 4995; // ship's destination will overflow
  const run = await exec(s, plan);
  assert.equal(run.stoppedAt, "ship");
  assert.deepEqual(run.receipts.map((r) => r.receipt.outcome), ["delivered", "made", "failed"]);
  assert.equal(s.world.places["vault:B-work"].stores.arms, 12, "the made arms stay in the work vault");
});

test("preflight authorises nothing: an unadopted plan, an edited plan, an edited registry", async () => {
  const { s, plan } = await adopted();
  // the same bindings, validly signed by B and passing preflight, but never adopted
  const other = await prepare(s, "B", s.refs.A, { params: { ...BIND.params, receiver: "vault:B-work" } });
  assert.equal((await preflight(other, s)).ready, true);
  assert.equal((await exec(s, other)).failure.code, "PLAN_NOT_ADOPTED");
  // a signed plan whose body was changed and re-hashed without the key
  const forged = structuredClone(plan);
  forged.plan.preparedDay = 13;
  forged.hash = contentHash(forged.plan);
  assert.equal((await exec(s, forged)).failure.code, "PLAN_SIGNATURE_INVALID");
  // the adopted plan with its receiver changed after the user signed
  const edited = structuredClone(plan);
  edited.plan.bindings.params.receiver = "vault:D-fort";
  assert.equal((await exec(s, edited)).failure.code, "PLAN_SIGNATURE_INVALID");
  // the local registry's copy of the pinned version is altered
  const env = s.registry.data.entries[`${s.refs.A.author}/${s.refs.A.name}`].versions["1.0.0"];
  env.manifest.steps[2].args.cargo.goods.arms.times = 1;
  assert.equal((await exec(s, plan)).failure.code, "HASH_MISMATCH");
});

test("S2's mock rules never run on main's S1: the workshop step is refused at execution", async () => {
  const { s, plan } = await adopted();
  s.world.features = ["base"];
  const run = await exec(s, plan);
  assert.equal(run.failure.code, "EFFECT_UNAVAILABLE");
  assert.equal(run.stoppedAt, null, "refused before any step");
  // a caravan-only definition runs on the S1 world
  const m = mineDelivery(s.pubs.M, { name: "s1-only" });
  const ref = (await s.registry.publish(await signManifest(m, s.keys.M), { features: ["base"], today: s.world.today })).ref;
  const p = await adopt(s, "M", ref, { params: { buyer: "vault:B-work" } });
  assert.equal((await exec(s, p)).ok, true);
});

test("only the plan's user can make it run, once per request", async () => {
  const { s, plan } = await adopted();
  // holding the signed plan is not enough
  assert.equal((await execute(plan, s)).failure.reason, "missing");
  // a request signed by someone else (here the author A)
  const byA = await requestRun(plan, { nonce: "n1" }, s.keys.A);
  assert.equal((await execute(plan, s, { request: byA })).failure.reason, "not-the-user");
  // B's request for another plan
  const other = await adopt(s, "B", s.refs.A, { params: { ...BIND.params, receiver: "vault:B-work" } });
  const forOther = await requestRun(other, { nonce: "n2" }, s.keys.B);
  assert.equal((await execute(plan, s, { request: forOther })).failure.reason, "other-plan");
  // a valid request runs once; replayed, it is refused
  const req = await requestRun(plan, { nonce: "n3" }, s.keys.B);
  assert.equal((await execute(plan, s, { request: req })).ok, true);
  s.world.today += 1;
  const again = await execute(plan, s, { request: req });
  assert.equal(again.failure.code, "RUN_REQUEST_INVALID");
  assert.equal(again.failure.reason, "replayed");
  // an edited request (more batches named after signing) breaks its hash
  const edited = structuredClone(req);
  edited.request.nonce = "n4";
  assert.equal((await execute(plan, s, { request: edited })).failure.reason, "hash");
});

test("the mock runs caravans and workshop runs only: a share withdrawal is checked but not executed", async () => {
  const { s } = await adopted();
  s.world.issues["issue:M-sh"] = { kind: "share", source: "vault:M-mine", srcGen: 1, srcStamp: 400, perUnit: 0, untilDay: 4294967295, state: "live", issuer: "M" };
  s.world.lots["lot:B-sh"] = { issue: "issue:M-sh", holder: "B", amount: 10, srcGen: 1, state: "live", day: 0, dayUsed: 0, escrow: false };
  const m = {
    format: "wylls.creation.manifest/0", name: "share-out", version: "1.0.0", author: s.pubs.B, title: "持ち分の引き出し",
    params: { pool: { type: "vault", ja: "共有の倉" }, to: { type: "vault", own: true, ja: "受け取る倉" } },
    uses: { sh: { relation: "connect", target: { param: "pool" }, grant: "share" } },
    steps: [{ id: "out", effect: "shares.withdraw", args: { via: { use: "sh" }, to: { param: "to" } } }],
    trigger: "manual", limits: { runsPerDay: 1 }, outputs: { got: { from: { step: "out", out: "delivered" } } },
  };
  const ref = (await s.registry.publish(await signManifest(m, s.keys.B), s.ctx)).ref;
  const plan = await adopt(s, "B", ref, { params: { pool: "vault:M-mine", to: "vault:B-home" } });
  const run = await exec(s, plan);
  assert.equal(run.failure.code, "EFFECT_UNKNOWN");
  assert.match(run.failure.detail, /not simulated/);
});
