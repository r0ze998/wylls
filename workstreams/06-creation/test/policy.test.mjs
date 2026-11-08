/**
 * The owner's decisions of 2026-10-30 (docs/05-update-policy.ja.md):
 *   - the author's publication stop blocks new use and new adoption only;
 *     a plan the user already confirmed keeps running its pinned version;
 *   - what still stops an adopted plan: the facility owner's revocation,
 *     expiry, an insufficient balance (and the other execution checks);
 *   - updates are notices; a plan moves to a new version only when its user
 *     confirms by adopting a new plan that supersedes it.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { signManifest, signStatus } from "../src/registry.mjs";
import { forkManifest } from "../src/fork.mjs";
import { DOMAIN, signHash } from "../src/keys.mjs";
import { editForkForRiver, frontSupply, giveUseLot } from "../src/scenario.mjs";
import { adopt, codes, deliverToB, exec, execute, prepare, preflight, setup } from "./helpers.mjs";

const BIND = { params: { source: "vault:B-home", workVault: "vault:B-work", receiver: "vault:B-home", workshop: "village:W" } };

async function ready() {
  const s = await setup();
  s.world = giveUseLot(s.world, { to: "B", amount: 6 });
  s.world.places["vault:B-home"].stores = { ore: 200, wood: 100 };
  return s;
}

async function setStatus(s, ref, status, who) {
  const seq = s.registry.statusSeq(ref);
  return s.registry.setStatus(ref, status, seq, await signStatus(ref, status, seq, s.keys[who]));
}

test("the author's publication stop blocks new adoption, not a plan the user already confirmed", async () => {
  const s = await ready();
  const adopted = await adopt(s, "B", s.refs.A, BIND);
  assert.equal((await setStatus(s, s.refs.A, "suspended", "A")).ok, true);
  // a new plan on the suspended definition: refused at preflight and at adoption
  const fresh = await prepare(s, "B", s.refs.A, { ...BIND, params: { ...BIND.params, receiver: "vault:B-work" } });
  assert.ok(codes((await preflight(fresh, s)).findings).includes("ENTRY_NOT_LISTED"));
  const refused = await s.adoptions.adopt(fresh, s);
  assert.equal(refused.ok, false);
  assert.ok(codes(refused.findings).includes("ENTRY_NOT_LISTED"));
  // the adopted plan: checked as pinned, and it runs
  const pf = await preflight(adopted, s);
  assert.equal(pf.ready, true, JSON.stringify(pf.findings));
  assert.ok(codes(pf.findings, { severities: ["info"] }).includes("ENTRY_DELISTED_PINNED"));
  const run = await exec(s, adopted);
  assert.equal(run.ok, true, JSON.stringify(run.failure));
  assert.match(run.log[0], /固定版 1\.0\.0/);
  // withdrawal is the same for it
  assert.equal((await setStatus(s, s.refs.A, "withdrawn", "A")).ok, true);
  s.world.today += 1;
  assert.equal((await exec(s, adopted)).ok, true);
});

test("a new definition cannot newly adopt a suspended producer; an adopted consumer keeps going", async () => {
  const s = await ready();
  const river = editForkForRiver(forkManifest(s.registry.getVersion(s.refs.A), s.pubs.B, { name: "river" }).manifest, { mineRef: { author: s.pubs.M, name: "mine-delivery", range: "^1.0.0" } });
  const ref = (await s.registry.publish(await signManifest(river, s.keys.B), s.ctx)).ref;
  const d1 = await deliverToB(s);
  const adopted = await adopt(s, "B", ref, { params: { workshop: "village:W", workVault: "vault:B-work", receiver: "vault:B-home" }, batches: { ore: d1.batch } });
  await setStatus(s, s.refs.M, "suspended", "M");
  // new definitions on it are refused at publication
  const again = editForkForRiver(frontSupply(s.pubs.B, { name: "river-two" }), { mineRef: { author: s.pubs.M, name: "mine-delivery", range: "^1.0.0" } });
  assert.ok(codes((await s.registry.publish(await signManifest(again, s.keys.B), s.ctx)).findings).includes("DEPENDENCY_SUSPENDED"));
  // the adopted consumer: the delivery it holds still proves what happened
  const pf = await preflight(adopted, s);
  assert.equal(pf.ready, true, JSON.stringify(pf.findings));
  assert.ok(codes(pf.findings, { severities: ["info"] }).includes("DEPENDENCY_DELISTED_PINNED"));
  assert.equal((await exec(s, adopted)).ok, true);
});

test("what still stops an adopted plan: revocation, expiry, balance — at execution, not by the author", async () => {
  const cases = [
    ["the facility owner revokes the issue (mock)", (w) => { w.issues["issue:W-1"].state = "revoked"; }, "GRANT_REVOKED"],
    ["the lot's end day passes", (w) => { w.today = 31; }, "GRANT_EXPIRED"],
    ["the workshop's village is captured", (w) => { w.places["village:W"].gen += 1; }, "GRANT_VOID"],
    ["the user's balance cannot pay the caravan fee", (w) => { w.citizens.B.lamports = 10_000; }, "BALANCE_SHORT"],
    ["the user's goods are gone", (w) => { w.places["vault:B-home"].stores = {}; }, "STOCK_SHORT"],
  ];
  for (const [what, change, code] of cases) {
    const s = await ready();
    const plan = await adopt(s, "B", s.refs.A, BIND);
    change(s.world);
    const run = await exec(s, plan);
    assert.equal(run.ok, false, what);
    assert.equal(run.failure.code, code, `${what}: ${JSON.stringify(run.failure)}`);
  }
});

test("updates: a notice moves nothing; the user's confirmation supersedes the old plan", async () => {
  const s = await ready();
  const old = await adopt(s, "B", s.refs.A, BIND);
  // a description-only patch: the plan still runs the confirmed hash
  const patch = frontSupply(s.pubs.A, { version: "1.0.1", note: "峠は夜に通るのが安全です。" });
  const p = await s.registry.publish(await signManifest(patch, s.keys.A), s.ctx);
  assert.equal(p.ok, true);
  const run = await exec(s, old);
  assert.equal(run.ok, true);
  assert.ok(run.receipts.every((r) => r.receipt.manifest.version === "1.0.0" && r.receipt.manifest.hash === s.refs.A.hash));
  // confirming the update: a new plan on 1.0.1, preflight, adopted with `supersedes`
  s.world.today += 1;
  const next = await prepare(s, "B", p.ref, BIND, { supersedes: old.hash });
  const a = await s.adoptions.adopt(next, s);
  assert.equal(a.ok, true, JSON.stringify(a.findings));
  assert.equal((await exec(s, old)).failure.code, "PLAN_SUPERSEDED");
  const r2 = await exec(s, next);
  assert.equal(r2.ok, true);
  assert.ok(r2.receipts.every((r) => r.receipt.manifest.version === "1.0.1"));
  // superseding is the user's own act: another user cannot supersede B's plan
  const s2 = await ready();
  const bPlan = await adopt(s2, "B", s2.refs.A, BIND);
  const byD = await prepare(s2, "D", s2.refs.A, { params: { source: "vault:D-fort", workVault: "vault:B-work", receiver: "vault:D-fort", workshop: "village:W" } }, { supersedes: bPlan.hash });
  const refused = await s2.adoptions.adopt(byD, s2);
  assert.equal(refused.ok, false);
  assert.equal(refused.findings[0].path, "$.plan.supersedes");
});

test("execution needs adoption; the user can end their own plan, nobody else can", async () => {
  const s = await ready();
  const plan = await prepare(s, "B", s.refs.A, BIND);
  assert.equal((await preflight(plan, s)).ready, true);
  assert.equal((await exec(s, plan)).failure.code, "PLAN_NOT_ADOPTED", "a passing preflight is not an authorisation");
  await s.adoptions.adopt(plan, s);
  const byA = await s.adoptions.end(plan.hash, await signHash(s.keys.A, DOMAIN.end, plan.hash));
  assert.equal(byA.ok, false);
  assert.equal((await s.adoptions.end(plan.hash, await signHash(s.keys.B, DOMAIN.end, plan.hash))).ok, true);
  assert.equal((await exec(s, plan)).failure.code, "PLAN_ENDED");
});

test("runs per day of the pinned definition are enforced at execution", async () => {
  const s = await ready();
  const plan = await adopt(s, "B", s.refs.A, BIND);
  assert.equal((await exec(s, plan)).ok, true);
  assert.equal((await exec(s, plan)).failure.code, "RUNS_PER_DAY_EXCEEDED");
  s.world.today += 1;
  assert.equal((await exec(s, plan)).ok, true);
});

test("runs per day (provisional): only accepted starts count; failures after acceptance are recorded apart", async () => {
  const s = await ready();
  const plan = await adopt(s, "B", s.refs.A, BIND);
  const day = s.world.today;
  // a preflight, a request signed by someone else, and a malformed request are not counted
  await preflight(plan, s);
  const { requestRun } = await import("./helpers.mjs");
  await execute(plan, s, { request: await requestRun(plan, { nonce: "x1" }, s.keys.A) });
  await execute(plan, s, {});
  assert.deepEqual(s.adoptions.tally(plan.hash, day), { started: 0, succeeded: 0, failed: 0 });
  // accepted, then stopped at a step: one start, one failure, no success
  const saved = s.world.citizens.B.lamports;
  s.world.citizens.B.lamports = 0;
  const req = await requestRun(plan, { nonce: "x2" }, s.keys.B);
  assert.equal((await execute(plan, s, { request: req })).failure.code, "BALANCE_SHORT");
  assert.deepEqual(s.adoptions.tally(plan.hash, day), { started: 1, succeeded: 0, failed: 1 });
  // the same request again is refused as replayed and not counted
  s.world.citizens.B.lamports = saved;
  assert.equal((await execute(plan, s, { request: req })).failure.reason, "replayed");
  assert.deepEqual(s.adoptions.tally(plan.hash, day), { started: 1, succeeded: 0, failed: 1 });
  // the cap (1 a day) is on starts: a new request the same day is refused before it starts
  assert.equal((await exec(s, plan)).failure.code, "RUNS_PER_DAY_EXCEEDED");
  assert.deepEqual(s.adoptions.tally(plan.hash, day), { started: 1, succeeded: 0, failed: 1 });
  s.world.today += 1;
  assert.equal((await exec(s, plan)).ok, true);
  assert.deepEqual(s.adoptions.tally(plan.hash, s.world.today), { started: 1, succeeded: 1, failed: 0 });
});

test("runs per day: another plan or another version of the same definition shares the cap; a fork does not", async () => {
  const s = await ready();
  const p1 = await adopt(s, "B", s.refs.A, BIND);
  assert.equal((await exec(s, p1)).ok, true);
  const v2 = await s.registry.publish(await signManifest(frontSupply(s.pubs.A, { version: "1.0.1", note: "説明だけ直した" }), s.keys.A), s.ctx);
  const p2 = await adopt(s, "B", v2.ref, BIND);
  assert.equal((await exec(s, p2)).failure.code, "RUNS_PER_DAY_EXCEEDED", "a new version is the same definition");
  // a fork is another definition (another author/name): its cap is its own. The resources it
  // uses are still bounded by the grants (the lot's and the workshop's runs a day).
  const fork = forkManifest(s.registry.getVersion(s.refs.A), s.pubs.B, { name: "front-supply-b" });
  const fr = (await s.registry.publish(await signManifest(fork.manifest, s.keys.B), s.ctx)).ref;
  const p3 = await adopt(s, "B", fr, BIND);
  const r3 = await exec(s, p3);
  assert.equal(r3.ok, true, JSON.stringify(r3.failure));
  assert.equal(s.world.lots["lot:B-1"].dayUsed, 6, "the lot (6 runs a day) is now used up");
  const p4 = await adopt(s, "B", fr, { params: { ...BIND.params, receiver: "vault:B-work" } }).catch((e) => e);
  assert.match(String(p4.message), /GRANT_INSUFFICIENT/, "a further plan cannot even be adopted today: the grant bounds it");
});
