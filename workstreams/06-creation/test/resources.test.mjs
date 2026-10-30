/**
 * Evidence (a record of a past event) versus the right to consume goods
 * (a batch held in a vault), and double consumption under concurrency.
 * Everything here runs on the MOCK chain (execute.mjs); what the real game
 * needs from ② / ④ / the chain to keep these guarantees is listed in
 * docs/07-guarantees.ja.md.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { signManifest } from "../src/registry.mjs";
import { forkManifest } from "../src/fork.mjs";
import { checkHoldInvariant, releaseBatch } from "../src/execute.mjs";
import { editForkForRiver, giveUseLot, mineDelivery } from "../src/scenario.mjs";
import { adopt, check, deliverToB, exec, setup } from "./helpers.mjs";

const RIVER_BIND = (batch, receiver = "vault:B-home") => ({ params: { workshop: "village:W", workVault: "vault:B-work", receiver }, batches: { ore: batch } });

/** B's river copy listed, B holding a use lot of 6 runs a day. */
async function river() {
  const s = await setup();
  s.world = giveUseLot(s.world, { to: "B", amount: 6 });
  const m = editForkForRiver(forkManifest(s.registry.getVersion(s.refs.A), s.pubs.B, { name: "river" }).manifest, { mineRef: { author: s.pubs.M, name: "mine-delivery", range: "^1.0.0" } });
  s.refs.river = (await s.registry.publish(await signManifest(m, s.keys.B), s.ctx)).ref;
  return s;
}

const stock = (s, id) => ({ ...s.world.places[id].stores });

test("a record alone creates no goods: invented, real-but-cited-as-right, or of a seized vault", async () => {
  const s = await river();
  // anyone holding the mock ledger can write a record: it must not matter
  const fake = s.ledger.record({ manifest: s.refs.M, planHash: "x", actor: "M", step: "ship", port: "delivered", outputs: ["delivered"], outcome: "delivered", final: true, beneficiary: "B", at: "vault:B-work", goods: { ore: 240, wood: 120 }, day: 12 });
  const before = stock(s, "vault:B-work");
  const plan = await adopt(s, "B", s.refs.river, RIVER_BIND(fake.id));
  assert.equal((await check(s, plan)).findings.find((f) => f.code === "BATCH_INVALID")?.reason, "unknown");
  const run = await exec(s, plan);
  assert.equal(run.failure.code, "BATCH_INVALID");
  assert.equal(run.failure.reason, "unknown");
  assert.deepEqual(stock(s, "vault:B-work"), before, "nothing appeared in the vault");
  // a real delivery's record, named where the right is asked for: still nothing
  const d = await deliverToB(s);
  assert.equal((await check(s, plan, { ore: d.evidence })).findings.find((f) => f.code === "BATCH_INVALID")?.reason, "unknown");
  // the vault is seized after the delivery: the batch is void, the record stays true
  s.world.places["vault:B-work"].gen += 1;
  s.world.today += 1; // a started run counts toward the day's runs, even one that stopped
  const r2 = await exec(s, plan, { batches: { ore: d.batch } });
  assert.equal(r2.failure.code, "BATCH_INVALID");
  assert.equal(r2.failure.reason, "void");
  assert.equal(s.ledger.check(d.evidence, { outcomeOk: ["delivered"] }), null);
});

test("held goods back their batch only: an ordinary step cannot take them", async () => {
  const s = await river();
  s.world.places["vault:B-work"].stores = {};
  const d = await deliverToB(s); // B-work: ore 24, wood 12, all held for B's batch
  // B's own plain move: send ore and wood out of B-work (no consume dependency)
  const move = mineDelivery(s.pubs.B, { name: "move-out", params: { mine: { type: "vault", own: true, ja: "出す倉" }, buyer: { type: "vault", ja: "届け先" }, ore: { type: "int", min: 0, max: 200, default: 24 }, wood: { type: "int", min: 0, max: 100, default: 12 } } });
  delete move.claims;
  const ref = (await s.registry.publish(await signManifest(move, s.keys.B), s.ctx)).ref;
  const plan = await adopt(s, "B", ref, { params: { mine: "vault:B-work", buyer: "vault:B-home" } });
  const run = await exec(s, plan);
  assert.equal(run.failure.code, "STOCK_SHORT");
  assert.equal(run.failure.free, 0);
  assert.deepEqual(s.world.places["vault:B-work"].stores, { ore: 24, wood: 12 });
  // released by its owner, the goods are ordinary stock again (and the batch can no longer be consumed)
  assert.equal(releaseBatch(s.world, d.batch, "D"), false, "only the batch's owner releases it");
  assert.equal(releaseBatch(s.world, d.batch, "B"), true);
  s.world.today += 1;
  assert.equal((await exec(s, plan)).ok, true);
  assert.deepEqual(checkHoldInvariant(s.world), []);
});

test("each run writes its own evidence: two runs of one plan on one day never share a record", async () => {
  const s = await river();
  const a = await deliverToB(s);
  const b = await deliverToB(s);
  assert.notEqual(a.evidence, b.evidence);
  assert.notEqual(a.batch, b.batch);
  assert.deepEqual(s.world.places["vault:B-work"].held, { ore: 48, wood: 24 });
});

test("one batch, two adopted plans, run concurrently: exactly one consumes it", async () => {
  const s = await river();
  const d = await deliverToB(s);
  const p1 = await adopt(s, "B", s.refs.river, RIVER_BIND(d.batch, "vault:B-home"));
  const p2 = await adopt(s, "B", s.refs.river, RIVER_BIND(d.batch, "vault:B-work"));
  // both checked fine on the same snapshot
  assert.equal((await check(s, p1)).ready, true);
  assert.equal((await check(s, p2)).ready, true);
  const before = stock(s, "vault:B-work");
  const [r1, r2] = await Promise.all([exec(s, p1), exec(s, p2)]);
  const oks = [r1, r2].filter((r) => r.ok);
  const bad = [r1, r2].find((r) => !r.ok);
  assert.equal(oks.length, 1, JSON.stringify([r1.failure, r2.failure]));
  assert.equal(bad.failure.code, "BATCH_INVALID");
  assert.equal(bad.failure.reason, "spent");
  // the goods were taken once: 24 ore and 12 wood made 12 arms
  const after = stock(s, "vault:B-work");
  assert.equal(after.ore, before.ore - 24);
  assert.equal(after.wood, before.wood - 12);
  assert.deepEqual(checkHoldInvariant(s.world), []);
});

test("one lot, one stock, one balance shared by concurrent plans: the second is stopped at its step", async () => {
  // lot: 3 runs a day; two plans each need 3
  let s = await setup();
  s.world = giveUseLot(s.world, { to: "B", amount: 3 });
  s.world.places["vault:B-home"].stores = { ore: 200, wood: 100 };
  const bind = (receiver) => ({ params: { source: "vault:B-home", workVault: "vault:B-work", receiver, workshop: "village:W" } });
  let p1 = await adopt(s, "B", s.refs.A, bind("vault:B-home"));
  let p2 = await adopt(s, "B", s.refs.A, bind("vault:B-work"));
  let [r1, r2] = await Promise.all([exec(s, p1), exec(s, p2)]);
  assert.deepEqual([r1.ok, r2.ok].sort(), [false, true]);
  assert.equal([r1, r2].find((r) => !r.ok).failure.code, "GRANT_INSUFFICIENT");
  assert.equal(s.world.lots["lot:B-1"].dayUsed, 3, "the lot's runs were spent once");
  // stock: enough for one haul (24 ore, 12 wood)
  s = await setup();
  s.world = giveUseLot(s.world, { to: "B", amount: 6 });
  s.world.places["vault:B-home"].stores = { ore: 30, wood: 20 };
  p1 = await adopt(s, "B", s.refs.A, bind("vault:B-home"));
  p2 = await adopt(s, "B", s.refs.A, bind("vault:B-work"));
  [r1, r2] = await Promise.all([exec(s, p1), exec(s, p2)]);
  assert.deepEqual([r1.ok, r2.ok].sort(), [false, true]);
  assert.equal([r1, r2].find((r) => !r.ok).failure.code, "STOCK_SHORT");
  assert.ok(s.world.places["vault:B-home"].stores.ore >= 0 && s.world.places["vault:B-home"].stores.wood >= 0);
  // balance: 150,000 lamports; each run pays two caravan fees (100,000)
  s = await setup();
  s.world = giveUseLot(s.world, { to: "B", amount: 6 });
  s.world.places["vault:B-home"].stores = { ore: 200, wood: 100 };
  s.world.citizens.B.lamports = 150_000;
  p1 = await adopt(s, "B", s.refs.A, bind("vault:B-home"));
  p2 = await adopt(s, "B", s.refs.A, bind("vault:B-work"));
  [r1, r2] = await Promise.all([exec(s, p1), exec(s, p2)]);
  const failed = [r1, r2].filter((r) => !r.ok);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].failure.code, "BALANCE_SHORT");
  assert.ok(s.world.citizens.B.lamports >= 0);
});

test("invariant over many interleaved runs, releases and deliveries: held ≤ stores, held = open batches", async () => {
  const s = await river();
  s.world.places["vault:M-mine"].stores = { ore: 5000, wood: 5000 };
  s.world.citizens.M.lamports = 10_000_000;
  s.world.citizens.B.lamports = 10_000_000;
  s.world.lots["lot:B-1"].amount = 24;
  const batches = [];
  for (let day = 0; day < 6; day++) {
    for (let i = 0; i < 3; i++) batches.push((await deliverToB(s)).batch);
    const open = batches.filter((b) => s.world.batches[b].state === "open");
    const plans = [];
    for (const b of open.slice(0, 2)) plans.push(await adopt(s, "B", s.refs.river, RIVER_BIND(b, day % 2 ? "vault:B-home" : "vault:D-fort")));
    // the same first batch named twice more, to race
    if (open[0]) plans.push(await adopt(s, "B", s.refs.river, RIVER_BIND(open[0], "vault:B-work")));
    await Promise.all(plans.map((p) => exec(s, p)));
    if (open[2]) assert.equal(releaseBatch(s.world, open[2], "B"), true);
    assert.deepEqual(checkHoldInvariant(s.world), [], `day ${day}`);
    for (const p of Object.values(s.world.places)) for (const n of Object.values(p.stores ?? {})) assert.ok(n >= 0);
    s.world.today += 1;
  }
  const spent = Object.values(s.world.batches).filter((b) => b.state === "spent");
  assert.ok(spent.length >= 6);
  assert.ok(spent.every((b) => Object.keys(b.remaining).length === 0));
});
