/**
 * Regressions for the defects the second independent review found in the
 * adoption and execution of commit 308087dc (each failed before the fix).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { signManifest } from "../src/registry.mjs";
import { forkManifest } from "../src/fork.mjs";
import { validateDefinition } from "../src/validate.mjs";
import { DOMAIN, signHash } from "../src/keys.mjs";
import { checkHoldInvariant } from "../src/execute.mjs";
import { editForkForRiver, giveUseLot, mineDelivery } from "../src/scenario.mjs";
import { adopt, codes, deliverToB, exec, prepare, setup } from "./helpers.mjs";

const BIND = { params: { source: "vault:B-home", workVault: "vault:B-work", receiver: "vault:B-home", workshop: "village:W" } };

async function ready() {
  const s = await setup();
  s.world = giveUseLot(s.world, { to: "B", amount: 6 });
  s.world.places["vault:B-home"].stores = { ore: 200, wood: 100 };
  return s;
}

test("one batch named twice in one run is refused; goods are not taken twice", async () => {
  const s = await ready();
  const m = editForkForRiver(forkManifest(s.registry.getVersion(s.refs.A), s.pubs.B, { name: "twice-batch" }).manifest, { mineRef: { author: s.pubs.M, name: "mine-delivery", range: "^1.0.0" } });
  m.uses.ore2 = { ...m.uses.ore };
  m.steps.find((x) => x.id === "make").after = [{ use: "ore" }, { use: "ore2" }];
  delete m.claims;
  const ref = (await s.registry.publish(await signManifest(m, s.keys.B), s.ctx)).ref;
  s.world.places["vault:B-work"].stores = {};
  const d = await deliverToB(s, { ore: 12, wood: 6 });
  const plan = await adopt(s, "B", ref, { params: { workshop: "village:W", workVault: "vault:B-work", receiver: "vault:B-home" } });
  const run = await exec(s, plan, { batches: { ore: d.batch, ore2: d.batch } });
  assert.equal(run.ok, false);
  assert.equal(run.failure.code, "BATCH_INVALID");
  assert.equal(run.failure.reason, "duplicate-in-plan");
  assert.deepEqual(s.world.places["vault:B-work"].stores, { ore: 12, wood: 6 });
  assert.deepEqual(checkHoldInvariant(s.world), []);
});

test("ending or superseding a plan stops a run already under way at its next step", async () => {
  const s = await ready();
  const plan = await adopt(s, "B", s.refs.A, BIND);
  const running = exec(s, plan);
  // let the first step finish, then the user ends the plan
  while (!Object.values(s.ledger.data.receipts).some((r) => r.planHash === plan.hash)) await new Promise((ok) => setTimeout(ok, 0));
  // the end takes effect between steps (set synchronously here so the test does not race the
  // signature check of AdoptionBook.end, which policy.test.mjs covers)
  s.adoptions.data.adoptions[plan.hash].state = "ended";
  const run = await running;
  assert.equal(run.ok, false);
  assert.equal(run.failure.code, "PLAN_ENDED");
  assert.equal(run.stoppedAt, "make");
  // the same for a supersede
  s.world.today += 1;
  const p2 = await adopt(s, "B", s.refs.A, BIND);
  const running2 = exec(s, p2);
  while (!Object.values(s.ledger.data.receipts).some((r) => r.planHash === p2.hash)) await new Promise((ok) => setTimeout(ok, 0));
  s.adoptions.data.adoptions[p2.hash].state = "superseded";
  assert.equal((await running2).failure.code, "PLAN_SUPERSEDED");
});

test("adoption re-checks after its preflight: two supersedes of one plan, or one plan adopted twice at once", async () => {
  const s = await ready();
  const old = await adopt(s, "B", s.refs.A, BIND);
  const p1 = await prepare(s, "B", s.refs.A, { params: { ...BIND.params, receiver: "vault:B-work" } }, { supersedes: old.hash });
  const p2 = await prepare(s, "B", s.refs.A, { params: { ...BIND.params, receiver: "vault:B-home" }, grants: { ws: "lot:B-1" } }, { supersedes: old.hash });
  const [a1, a2] = await Promise.all([s.adoptions.adopt(p1, s), s.adoptions.adopt(p2, s)]);
  assert.deepEqual([a1.ok, a2.ok].sort(), [false, true]);
  assert.equal(s.adoptions.activeOf(s.pubs.B).length, 1);
  // the same plan adopted twice at once: one record, its count and nonces kept
  const p3 = await prepare(s, "B", s.refs.A, { params: { ...BIND.params, receiver: "vault:B-work" } }, { today: 11 });
  const [b1, b2] = await Promise.all([s.adoptions.adopt(p3, s), s.adoptions.adopt(p3, s)]);
  assert.equal(b1.ok && b2.ok, true);
  assert.equal([b1.already, b2.already].filter(Boolean).length, 1);
});

test("runs per day hold per user and definition, however many plans of it the user adopts", async () => {
  const s = await ready();
  const p1 = await adopt(s, "B", s.refs.A, BIND);
  const p2 = await adopt(s, "B", s.refs.A, BIND, { today: 11 });
  assert.notEqual(p1.hash, p2.hash);
  assert.equal((await exec(s, p1)).ok, true);
  assert.equal((await exec(s, p2)).failure.code, "RUNS_PER_DAY_EXCEEDED");
});

test("a consumed result must feed a step that uses goods; a caravan cannot claim to consume it", async () => {
  const s = await setup();
  const m = mineDelivery(s.pubs.B, { name: "fake-consume" });
  m.uses = { ore: { relation: "consume", manifest: { author: s.pubs.M, name: "mine-delivery", range: "^1.0.0" }, output: "delivered", type: "result:delivery" } };
  m.steps[0].after = [{ use: "ore" }];
  delete m.claims;
  const f = validateDefinition(m, s.ctx).findings.find((x) => x.code === "REF_UNKNOWN" && x.path === "$.uses.ore");
  assert.ok(f, JSON.stringify(validateDefinition(m, s.ctx).findings));
  assert.match(f.detail, /uses goods/);
});

test("re-adopting an ended or superseded plan is not reported as adopted", async () => {
  const s = await ready();
  const plan = await adopt(s, "B", s.refs.A, BIND);
  await s.adoptions.end(plan.hash, await signHash(s.keys.B, DOMAIN.end, plan.hash));
  const again = await s.adoptions.adopt(plan, s);
  assert.equal(again.ok, false);
  assert.deepEqual(codes(again.findings), ["PLAN_ENDED"]);
});
