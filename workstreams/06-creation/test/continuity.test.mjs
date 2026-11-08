/**
 * The world goes on: no season ends it, and ⑥'s definitions, adoptions,
 * pinned versions, batches and run history carry across a day boundary, a
 * restart (every book saved to JSON and loaded again) and a change of the
 * core's rules. See docs/10-continuous-world.ja.md.
 *
 * Everything runs on the MOCK world (execute.mjs). Crossing a boundary and
 * staying bounded over a long run are tested apart.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { Registry, signManifest } from "../src/registry.mjs";
import { Ledger } from "../src/ledger.mjs";
import { AdoptionBook, RUN_REQUEST_DAYS } from "../src/adoption.mjs";
import { checkHoldInvariant, execute, requestRun } from "../src/execute.mjs";
import { forkManifest } from "../src/fork.mjs";
import { contentHash } from "../src/canonical.mjs";
import { DOMAIN, signHash } from "../src/keys.mjs";
import { editForkForRiver, giveUseLot } from "../src/scenario.mjs";
import { adopt, check, deliverToB, exec, prepare, preflight, setup } from "./helpers.mjs";

const BIND = { params: { source: "vault:B-home", workVault: "vault:B-work", receiver: "vault:B-home", workshop: "village:W" } };
const FEE = 50_000;

async function ready() {
  const s = await setup();
  s.world = giveUseLot(s.world, { to: "B", amount: 6 });
  s.world.places["vault:B-home"].stores = { ore: 200, wood: 100 };
  return s;
}

/** Save every book to JSON and load it into new objects, as a process restart would. */
function restart(s) {
  const saved = JSON.parse(JSON.stringify({ registry: s.registry, ledger: s.ledger, adoptions: s.adoptions, world: s.world }));
  return { ...s, registry: new Registry(saved.registry), ledger: new Ledger(saved.ledger), adoptions: new AdoptionBook(saved.adoptions), world: saved.world };
}

const stateOf = (s) => JSON.stringify({ registry: s.registry, ledger: s.ledger, adoptions: s.adoptions, world: s.world });
const run = (s, plan, request) => execute(plan, s, { request });

test("across a day boundary and a restart: nothing is lost, no request runs twice, fees and goods add up", async () => {
  let s = await ready();
  const D = s.world.today;
  const lamports0 = s.world.citizens.B.lamports;
  const plan = await adopt(s, "B", s.refs.A, BIND);
  const used = await requestRun(plan, { nonce: "used", day: D }, s.keys.B);
  const pending = await requestRun(plan, { nonce: "pending", day: D }, s.keys.B); // signed, not yet sent
  assert.equal((await run(s, plan, used)).ok, true);

  const before = stateOf(s);
  s = restart(s);
  assert.equal(stateOf(s), before, "a restart keeps every book as it was");

  s.world.today = D + 1; // the boundary
  const replay = await run(s, plan, used);
  assert.equal(replay.failure.code, "RUN_REQUEST_INVALID");
  assert.equal(replay.failure.reason, "replayed", "the nonce survived the restart");
  assert.equal((await run(s, plan, pending)).ok, true, "a request signed before the boundary runs once after it");
  assert.equal((await run(s, plan, pending)).failure.reason, "replayed");

  s = restart(s);
  s.world.today = D + RUN_REQUEST_DAYS + 1;
  assert.equal((await run(s, plan, used)).failure.reason, "stale", "an old request is refused by its day, after its nonce is dropped");

  assert.deepEqual(s.adoptions.tally(plan.hash, D), { started: 1, succeeded: 1, failed: 0 });
  assert.deepEqual(s.adoptions.tally(plan.hash, D + 1), { started: 1, succeeded: 1, failed: 0 }, "each day's history is kept");
  assert.equal(s.adoptions.problem(plan.hash), null, "the adoption is still active");
  // two runs, two caravans each: the fees are exactly what the delivered records show
  const caravans = Object.values(s.ledger.data.receipts).filter((r) => r.actor === "B" && r.effect === "caravan.send" && r.outcome === "delivered").length;
  assert.equal(caravans, 4);
  assert.equal(lamports0 - s.world.citizens.B.lamports, caravans * FEE);
  assert.deepEqual(s.world.places["vault:B-home"].stores, { ore: 200 - 48, wood: 100 - 24, arms: 24 });
  assert.deepEqual(checkHoldInvariant(s.world), []);
});

test("a batch held before the boundary is consumed once after a restart, and only once", async () => {
  let s = await setup();
  s.world = giveUseLot(s.world, { to: "B", amount: 6 });
  const m = editForkForRiver(forkManifest(s.registry.getVersion(s.refs.A), s.pubs.B, { name: "river" }).manifest, { mineRef: { author: s.pubs.M, name: "mine-delivery", range: "^1.0.0" } });
  s.refs.river = (await s.registry.publish(await signManifest(m, s.keys.B), s.ctx)).ref;
  s.world.places["vault:B-work"].stores = {};
  const d = await deliverToB(s);
  const held = { ...s.world.places["vault:B-work"].held };

  s = restart(s);
  s.world.today += 1;
  assert.equal(s.world.batches[d.batch].state, "open");
  assert.deepEqual(s.world.places["vault:B-work"].held, held, "the held goods crossed the boundary");
  const plan = await adopt(s, "B", s.refs.river, { params: { workshop: "village:W", workVault: "vault:B-work", receiver: "vault:B-home" } });
  assert.equal((await exec(s, plan, { batches: { ore: d.batch } })).ok, true);
  assert.equal(s.world.batches[d.batch].state, "spent");

  s = restart(s);
  s.world.today += 1;
  const again = await exec(s, plan, { batches: { ore: d.batch } });
  assert.equal(again.failure.code, "BATCH_INVALID");
  assert.equal(again.failure.reason, "spent");
  assert.equal(s.ledger.check(d.evidence, { outcomeOk: ["delivered"] }), null, "the record of the delivery stays true");
  assert.deepEqual(checkHoldInvariant(s.world), []);
});

test("the core changes an effect in the running world: plans on it are held, not ended; others go on; old records keep their revision", async () => {
  const s = await ready();
  const planW = await adopt(s, "B", s.refs.A, BIND);
  assert.deepEqual(planW.plan.effects, { "caravan.send": 1, "workshop.run": 1 });
  const first = await exec(s, planW);
  assert.equal(first.ok, true);
  const made = first.receipts.find((r) => r.receipt.effect === "workshop.run");
  assert.equal(made.receipt.rev, 1);

  // a legacy plan, signed before revisions were recorded (plan/0, no `effects`): read as rev 1
  const fresh = await prepare(s, "B", s.refs.M, { params: { mine: "vault:B-home", buyer: "vault:B-work", ore: 1, wood: 0 } });
  const legacy = { ...fresh.plan, format: "wylls.creation.plan/0" };
  delete legacy.effects;
  const lh = contentHash(legacy);
  const legacyPlan = { plan: legacy, hash: lh, signature: await signHash(s.keys.B, DOMAIN.plan, lh) };

  s.world.today += 1;
  s.world.effectRevs = { "workshop.run": 2 }; // the core's migration changes what a workshop run means
  const pf = await preflight(planW, s);
  const f = pf.findings.find((x) => x.code === "EFFECT_REVISED");
  assert.deepEqual([f.effect, f.confirmed, f.now, f.legacy], ["workshop.run", 1, 2, false]);
  const held = await exec(s, planW);
  assert.equal(held.failure.code, "EFFECT_REVISED");
  assert.deepEqual(s.adoptions.tally(planW.hash, s.world.today), { started: 0, succeeded: 0, failed: 0 }, "a held run is not counted");
  assert.equal(s.adoptions.problem(planW.hash), null, "held, not ended");

  // a plan that uses only unchanged effects goes on; so does a legacy one
  assert.equal((await s.adoptions.adopt(legacyPlan, s)).ok, true);
  assert.equal((await exec(s, legacyPlan)).ok, true);

  // the old record is not read as the new meaning
  assert.equal(s.ledger.get(made.id).rev, 1);

  // the user confirms a plan under the new meaning: it supersedes the old one and runs
  const planW2 = await adopt(s, "B", s.refs.A, BIND, { supersedes: planW.hash });
  assert.equal(planW2.plan.effects["workshop.run"], 2);
  assert.equal((await exec(s, planW2)).ok, true);
  assert.equal(s.adoptions.problem(planW.hash), "PLAN_SUPERSEDED");

  // a legacy plan on a changed effect says it was read as rev 1
  s.world.effectRevs["caravan.send"] = 2;
  const lf = (await preflight(legacyPlan, s)).findings.find((x) => x.code === "EFFECT_REVISED");
  assert.deepEqual([lf.confirmed, lf.now, lf.legacy], [1, 2, true]);
});

test("a run request is accepted on its day and the next only", async () => {
  const s = await ready();
  const plan = await adopt(s, "B", s.refs.A, BIND);
  const D = s.world.today;
  const future = await requestRun(plan, { nonce: "f", day: D + 1 }, s.keys.B);
  assert.equal((await run(s, plan, future)).failure.reason, "future");
  const old = await requestRun(plan, { nonce: "o", day: D - RUN_REQUEST_DAYS }, s.keys.B);
  assert.equal((await run(s, plan, old)).failure.reason, "stale");
  assert.deepEqual(s.adoptions.tally(plan.hash, D), { started: 0, succeeded: 0, failed: 0 });
  await assert.rejects(() => requestRun(plan, { nonce: "x" }, s.keys.B), TypeError);
});

test("a long run: replay state stays bounded, history is kept, days past 2^32 work", async () => {
  let s = await setup();
  const DAYS = 400, PER_DAY = 2;
  s.world.today = 2 ** 32 - 200; // crosses 2^32 halfway (the core's u32 day is ④'s to check)
  s.world.citizens.M.lamports = DAYS * PER_DAY * FEE;
  const plan = await adopt(s, "M", s.refs.M, { params: { buyer: "vault:B-work", ore: 1, wood: 1 } });
  const start = s.world.today;
  let maxNonces = 0;
  for (let i = 0; i < DAYS; i++) {
    s.world.places["vault:M-mine"].stores = { ore: 10, wood: 10 };
    s.world.places["vault:B-work"].stores = {};
    for (let k = 0; k < PER_DAY; k++) assert.equal((await exec(s, plan)).ok, true, `day ${i} run ${k}`);
    maxNonces = Math.max(maxNonces, Object.keys(s.adoptions.data.adoptions[plan.hash].nonces).length);
    if (i === DAYS / 2) s = restart(s);
    s.world.today += 1;
  }
  assert.ok(maxNonces <= RUN_REQUEST_DAYS * PER_DAY, `nonces kept: ${maxNonces}`);
  const days = Object.values(s.adoptions.data.runs)[0];
  assert.equal(Object.keys(days).length, DAYS, "one tally per day, none dropped");
  assert.deepEqual(s.adoptions.tally(plan.hash, start + DAYS - 1), { started: PER_DAY, succeeded: PER_DAY, failed: 0 });
  assert.equal(Object.keys(s.ledger.data.receipts).length, DAYS * PER_DAY, "the record of every run is kept");
  assert.equal(s.world.citizens.M.lamports, 0);
  assert.equal(s.world.runSeq, DAYS * PER_DAY);
});
