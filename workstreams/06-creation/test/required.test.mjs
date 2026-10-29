/**
 * The ten tests the task requires, by name. Definition-only cases are also
 * in fixtures/ (fixtures.test.mjs); these add the registry, the preflight
 * against a world, and the mock ledger.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { contentHash } from "../src/canonical.mjs";
import { validateDefinition } from "../src/validate.mjs";
import { signManifest, signStatus } from "../src/registry.mjs";
import { preparePlan, preflight } from "../src/plan.mjs";
import { forkManifest } from "../src/fork.mjs";
import { simulateRun } from "../src/run.mjs";
import { describe as paper } from "../src/describe.mjs";
import { editForkForRiver, frontSupply, giveUseLot, mineDelivery } from "../src/scenario.mjs";
import { codes, setup } from "./helpers.mjs";

const B_BIND = { params: { source: "vault:B-home", workVault: "vault:B-work", receiver: "vault:B-home", runs: 3, workshop: "village:W" } };

async function planFor(s, who, ref, bindings, world = s.world) {
  return preparePlan(s.registry.getVersion(ref), bindings, s.keys[who], { world });
}

/** B ready to run A's front-supply: a use lot from W and enough stock. */
async function readyB() {
  const s = await setup();
  s.world = giveUseLot(s.world, { to: "B" });
  s.world.places["vault:B-home"].stores = { ore: 60, wood: 30 };
  return s;
}

/** B's river copy published, M's delivery done into B's vault; returns the receipt. */
async function riverWithDelivery() {
  const s = await readyB();
  const fork = forkManifest(s.registry.getVersion(s.refs.A), s.pubs.B, { name: "front-supply-river" });
  const river = editForkForRiver(fork.manifest, { mineRef: { author: s.pubs.M, name: "mine-delivery", range: "^1.0.0" } });
  s.refs.river = (await s.registry.publish(await signManifest(river, s.keys.B), s.ctx)).ref;
  const planM = await planFor(s, "M", s.refs.M, { params: { buyer: "vault:B-work", ore: 24, wood: 12 } });
  const run = await simulateRun(planM, s);
  assert.equal(run.ok, true);
  s.world = run.world;
  s.delivery = run.receipts[0];
  s.riverBind = { params: { workshop: "village:W", workVault: "vault:B-work", receiver: "vault:D-fort", runs: 3 }, receipts: { ore: s.delivery.id } };
  return s;
}

test("baseline: B's plan on A's definition is ready once B holds a use lot", async () => {
  const s = await readyB();
  const pf = await preflight(await planFor(s, "B", s.refs.A, B_BIND), s);
  assert.equal(pf.ready, true, JSON.stringify(pf.findings));
  assert.deepEqual(pf.grantsUsed, { ws: "lot:B-1" });
});

test("1 型の不一致: arguments, consume types and resources are typed", async () => {
  const s = await setup();
  const asVault = frontSupply(s.pubs.A, { params: { ...frontSupply(s.pubs.A).params, workshop: { type: "vault" } } });
  assert.ok(codes(validateDefinition(asVault, s.ctx).findings).includes("TYPE_MISMATCH"));
  // a consume dependency that expects a production record where the producer gives a delivery
  const river = editForkForRiver(frontSupply(s.pubs.B, { name: "river-bad-type" }), { mineRef: { author: s.pubs.M, name: "mine-delivery", range: "^1.0.0" } });
  river.uses.ore.type = "result:run";
  const r = await s.registry.publish(await signManifest(river, s.keys.B), s.ctx);
  assert.equal(r.ok, false);
  assert.ok(codes(r.findings).includes("TYPE_MISMATCH"));
  // a bound value of the wrong kind of place
  const pf = await preflight(await planFor(s, "B", s.refs.A, { params: { ...B_BIND.params, workshop: "vault:B-work" } }), s);
  assert.ok(codes(pf.findings).includes("PARAM_TYPE"));
});

test("2 必要権利なし: missing, someone else's, the wrong source, too few runs", async () => {
  const s = await setup();
  let pf = await preflight(await planFor(s, "B", s.refs.A, B_BIND), s);
  assert.equal(pf.ready, false);
  assert.ok(codes(pf.findings).includes("MISSING_GRANT"));
  pf = await preflight(await planFor(s, "B", s.refs.A, { ...B_BIND, grants: { ws: "lot:A-1" } }), s);
  assert.ok(codes(pf.findings).includes("GRANT_NOT_HELD"));
  // a lot of W's other workshop does not open this one
  s.world.issues["issue:W2-1"] = { kind: "use", source: "village:W2", srcGen: 1, srcStamp: 910, perUnit: 1, untilDay: 30, state: "live", issuer: "W" };
  s.world = giveUseLot(s.world, { to: "B", lotId: "lot:B-w2", issue: "issue:W2-1" });
  pf = await preflight(await planFor(s, "B", s.refs.A, { ...B_BIND, grants: { ws: "lot:B-w2" } }), s);
  assert.ok(codes(pf.findings).includes("GRANT_WRONG"));
  // one unit = one run a day; the plan asks three
  s.world = giveUseLot(s.world, { to: "B", lotId: "lot:B-small", amount: 1 });
  pf = await preflight(await planFor(s, "B", s.refs.A, { ...B_BIND, grants: { ws: "lot:B-small" } }), s);
  assert.ok(codes(pf.findings).includes("GRANT_INSUFFICIENT"));
});

test("3 利用期限切れ: an expired lot, and an expired definition", async () => {
  const s = await setup();
  const pf = await preflight(await planFor(s, "B", s.refs.A, { ...B_BIND, grants: { ws: "lot:B-old" } }), s);
  assert.ok(codes(pf.findings).includes("GRANT_EXPIRED"));
  const old = frontSupply(s.pubs.A, { name: "front-supply-short", validUntilDay: 15 });
  const ref = (await s.registry.publish(await signManifest(old, s.keys.A), s.ctx)).ref;
  const later = { ...s, world: { ...giveUseLot(s.world, { to: "B" }), today: 16 } };
  const pf2 = await preflight(await planFor(later, "B", ref, B_BIND), later);
  assert.ok(codes(pf2.findings).includes("MANIFEST_EXPIRED"));
});

test("4 削除・停止された依存先: closed or captured facility, suspended or withdrawn definitions", async () => {
  const s = await readyB();
  const plan = await planFor(s, "B", s.refs.A, B_BIND);
  // the workshop's village is closed
  let w = structuredClone(s.world);
  w.places["village:W"].live = false;
  assert.ok(codes((await preflight(plan, { ...s, world: w })).findings).includes("DEPENDENCY_UNAVAILABLE"));
  // the village is captured: its generation rises and every use lot of it is void (S2 2a)
  w = structuredClone(s.world);
  w.places["village:W"].gen = 2;
  assert.ok(codes((await preflight(plan, { ...s, world: w })).findings).includes("GRANT_VOID"));
  // the workshop is gone from the village
  w = structuredClone(s.world);
  w.places["village:W"].workshops = 0;
  assert.ok(codes((await preflight(plan, { ...s, world: w })).findings).includes("DEPENDENCY_UNAVAILABLE"));
  // A suspends front-supply: no plan on it passes preflight
  assert.equal((await s.registry.setStatus(s.refs.A, "suspended", 12, await signStatus(s.refs.A, "suspended", 12, s.keys.A))).ok, true);
  assert.ok(codes((await preflight(plan, s)).findings).includes("ENTRY_NOT_LISTED"));
  // only the author can change the status
  const byB = await s.registry.setStatus(s.refs.A, "listed", 12, await signStatus(s.refs.A, "listed", 12, s.keys.B));
  assert.deepEqual(codes(byB.findings), ["NOT_AUTHOR"]);
});

test("4 削除・停止された依存先: a consume dependency suspended or withdrawn", async () => {
  const s = await riverWithDelivery();
  const plan = await planFor(s, "B", s.refs.river, s.riverBind);
  assert.equal((await preflight(plan, s)).ready, true);
  await s.registry.setStatus(s.refs.M, "suspended", 12, await signStatus(s.refs.M, "suspended", 12, s.keys.M));
  assert.ok(codes((await preflight(plan, s)).findings).includes("DEPENDENCY_SUSPENDED"));
  await s.registry.setStatus(s.refs.M, "withdrawn", 12, await signStatus(s.refs.M, "withdrawn", 12, s.keys.M));
  assert.ok(codes((await preflight(plan, s)).findings).includes("DEPENDENCY_WITHDRAWN"));
  // and a new definition cannot be published on top of it
  const again = editForkForRiver(frontSupply(s.pubs.B, { name: "river-two" }), { mineRef: { author: s.pubs.M, name: "mine-delivery", range: "^1.0.0" } });
  const r = await s.registry.publish(await signManifest(again, s.keys.B), s.ctx);
  assert.equal(r.ok, false);
  assert.ok(codes(r.findings).includes("DEPENDENCY_WITHDRAWN"));
});

test("5 版の不一致: ranges, pinned hashes, receipts of another version, immutable versions", async () => {
  const s = await riverWithDelivery();
  const mk = (name, range, hash) => editForkForRiver(frontSupply(s.pubs.B, { name }), { mineRef: { author: s.pubs.M, name: "mine-delivery", range, ...(hash ? { hash } : {}) } });
  let r = await s.registry.publish(await signManifest(mk("river-v2", "^2.0.0"), s.keys.B), s.ctx);
  assert.ok(codes(r.findings).includes("DEPENDENCY_VERSION"));
  r = await s.registry.publish(await signManifest(mk("river-pin", "^1.0.0", "f".repeat(64)), s.keys.B), s.ctx);
  assert.ok(codes(r.findings).includes("DEPENDENCY_VERSION"));
  // the same version cannot be published twice, and a bump must match the change
  r = await s.registry.publish(await signManifest(frontSupply(s.pubs.A, { title: "前線補給・改" }), s.keys.A), s.ctx);
  assert.ok(codes(r.findings).includes("VERSION_EXISTS"));
  const v101 = frontSupply(s.pubs.A, { version: "1.0.1", limits: { runsPerDay: 2 }, claims: { ...frontSupply(s.pubs.A).claims, runsPerDay: 2 } });
  r = await s.registry.publish(await signManifest(v101, s.keys.A), s.ctx);
  assert.ok(codes(r.findings).includes("VERSION_BUMP_TOO_SMALL"));
  // M publishes 2.0.0; a definition that pins ~2.0.0 rejects the 1.0.0 delivery B holds
  const m2 = mineDelivery(s.pubs.M, { version: "2.0.0", limits: { runsPerDay: 2 } });
  assert.equal((await s.registry.publish(await signManifest(m2, s.keys.M), s.ctx)).ok, true);
  const two = mk("river-on-two", "~2.0.0");
  const pubTwo = await s.registry.publish(await signManifest(two, s.keys.B), s.ctx);
  assert.equal(pubTwo.ok, true, JSON.stringify(pubTwo.findings));
  const pf = await preflight(await planFor(s, "B", pubTwo.ref, s.riverBind), s);
  assert.equal(pf.findings.find((f) => f.code === "RECEIPT_INVALID")?.reason, "wrong-version");
  // a plan pinned to a hash the registry does not hold for that version
  const plan = await planFor(s, "B", s.refs.river, s.riverBind);
  const pinned = { ...plan, plan: { ...plan.plan, manifest: { ...plan.plan.manifest, hash: "0".repeat(64) } } };
  pinned.hash = contentHash(pinned.plan);
  assert.ok(codes((await preflight(pinned, s)).findings).includes("HASH_MISMATCH"));
});

test("6 循環する依存: steps that wait on each other, definitions that consume each other", async () => {
  const s = await setup();
  const m = frontSupply(s.pubs.A, { name: "loop" });
  m.steps[0].after = ["ship"];
  assert.ok(codes(validateDefinition(m, s.ctx).findings).includes("STEP_CYCLE"));
  // X consumes Y's output, Y consumes X's: publishing the edge that closes the loop is refused
  const x1 = mineDelivery(s.pubs.M, { name: "x-feed" });
  assert.equal((await s.registry.publish(await signManifest(x1, s.keys.M), s.ctx)).ok, true);
  const y = editForkForRiver(frontSupply(s.pubs.B, { name: "y-feed" }), { mineRef: { author: s.pubs.M, name: "x-feed", range: "^1.0.0" } });
  assert.equal((await s.registry.publish(await signManifest(y, s.keys.B), s.ctx)).ok, true);
  const x2 = mineDelivery(s.pubs.M, { name: "x-feed", version: "2.0.0" });
  x2.uses = { back: { relation: "consume", manifest: { author: s.pubs.B, name: "y-feed", range: "^1.0.0" }, output: "arms", type: "result:delivery" } };
  x2.steps[0].after = [{ use: "back" }];
  const r = await s.registry.publish(await signManifest(x2, s.keys.M), s.ctx);
  assert.equal(r.ok, false);
  const cyc = r.findings.find((f) => f.code === "DEPENDENCY_CYCLE");
  assert.ok(cyc, JSON.stringify(r.findings));
  assert.equal(cyc.cycle.length, 3);
  // a definition that consumes itself
  const self = mineDelivery(s.pubs.M, { name: "self-feed" });
  self.uses = { me: { relation: "consume", manifest: { author: s.pubs.M, name: "self-feed", range: "^1.0.0" }, output: "delivered", type: "result:delivery" } };
  assert.ok(codes((await s.registry.publish(await signManifest(self, s.keys.M), s.ctx)).findings).includes("DEPENDENCY_CYCLE"));
});

test("7 過大な処理量: static caps, and the workshop's shared daily runs", async () => {
  const s = await readyB();
  const big = frontSupply(s.pubs.A, { name: "big" });
  big.params.runs.max = 24;
  big.limits.runsPerDay = 2;
  big.claims.runsPerDay = 2;
  const lim = validateDefinition(big, s.ctx).findings.filter((f) => f.code === "LIMIT_EXCEEDED");
  assert.deepEqual(lim.map((f) => f.what), ["workshop runs per day"]);
  const unbounded = frontSupply(s.pubs.A, { name: "unbounded" });
  delete unbounded.params.runs.max;
  assert.ok(validateDefinition(unbounded, s.ctx).findings.some((f) => f.code === "LIMIT_EXCEEDED" && /unbounded/.test(f.what)));
  // W's workshop (2 copies) has 48 runs a day across all tickets; 46 are used today
  s.world.places["village:W"].useDay = 12;
  s.world.places["village:W"].useRuns = 46;
  const pf = await preflight(await planFor(s, "B", s.refs.A, B_BIND), s);
  const f = pf.findings.find((x) => x.code === "GRANT_INSUFFICIENT");
  assert.match(f.of, /workshop/);
  // a delivery that would overflow the vault's cap (5000 per resource) loses the excess: refused
  s.world.places["vault:B-home"].stores.arms = 4995;
  s.world.places["village:W"].useRuns = 0;
  const pf2 = await preflight(await planFor(s, "B", s.refs.A, B_BIND), s);
  assert.ok(codes(pf2.findings).includes("CAPACITY"));
});

test("8 偽の完了結果: unknown, edited, unfinished, failed, foreign, someone else's, reused, misplaced", async () => {
  const s = await riverWithDelivery();
  const check = async (receipt, ledger = s.ledger) => {
    const plan = await planFor(s, "B", s.refs.river, { ...s.riverBind, receipts: { ore: receipt } });
    return (await preflight(plan, { ...s, ledger })).findings.find((f) => f.code === "RECEIPT_INVALID")?.reason;
  };
  assert.equal(await check(s.delivery.id), undefined);
  assert.equal(await check("9".repeat(64)), "unknown");
  // B presents the receipt with more goods than were delivered
  const edited = { id: s.delivery.id, receipt: { ...s.delivery.receipt, goods: { ore: 240, wood: 120 } } };
  assert.equal(await check(edited), "tampered");
  const forged = { ...s.delivery.receipt, goods: { ore: 240, wood: 120 } };
  assert.equal(await check(forged), "not-in-ledger");
  // records the ledger holds but that are no finished delivery to B
  const base = { manifest: s.delivery.receipt.manifest, planHash: "p", runSeq: 9, actor: "M", step: "ship", output: "delivered", at: "vault:B-work", goods: { ore: 24, wood: 12 }, day: 12 };
  assert.equal(await check(s.ledger.record({ ...base, outcome: "delivered", final: false, beneficiary: "B" }).id), "not-final");
  assert.equal(await check(s.ledger.record({ ...base, outcome: "raided", final: true, beneficiary: "B" }).id), "failed-run");
  assert.equal(await check(s.ledger.record({ ...base, outcome: "delivered", final: true, beneficiary: "D" }).id), "not-beneficiary");
  assert.equal(await check(s.ledger.record({ ...base, outcome: "delivered", final: true, beneficiary: "B", at: "vault:B-home" }).id), "place-mismatch");
  const other = { ...s.refs.A, hash: s.refs.A.hash };
  assert.equal(await check(s.ledger.record({ ...base, manifest: other, outcome: "delivered", final: true, beneficiary: "B" }).id), "wrong-producer");
  // used once by a run, it cannot be used again
  const run = await simulateRun(await planFor(s, "B", s.refs.river, s.riverBind), s);
  assert.equal(run.ok, true, JSON.stringify(run.preflight?.findings));
  assert.equal(await check(s.delivery.id), "already-consumed");
});

test("9 公開者の説明と機械条件の不一致: claims are checked, the note is shown apart", async () => {
  const s = await setup();
  const lying = frontSupply(s.pubs.A, { name: "lying" });
  lying.claims.outputsPerRun = { arms: 20 };
  lying.claims.signer = "session";
  lying.trigger = "daily";
  lying.claims.trigger = "daily";
  const v = validateDefinition(lying, s.ctx);
  const mism = v.findings.filter((f) => f.code === "CLAIM_MISMATCH").map((f) => f.path).sort();
  assert.deepEqual(mism, ["$.claims.outputsPerRun", "$.claims.signer", "$.claims.trigger"]);
  assert.equal(v.findings.find((f) => f.path === "$.claims.outputsPerRun").machine.arms, 12);
  const r = await s.registry.publish(await signManifest(lying, s.keys.A), s.ctx);
  assert.equal(r.ok, false);
  // a free note can promise anything; it is warned about and kept off the machine's paper
  const promise = frontSupply(s.pubs.A, { name: "promise", note: "兵器は必ず届きます。保証します。" });
  const pv = validateDefinition(promise, s.ctx);
  assert.deepEqual(codes(pv.findings), ["NOTE_PROMISE"]);
  const p = paper(promise, pv.facts);
  assert.equal(p.authorNote, promise.note);
  assert.ok(!p.lines.flatMap((l) => l.items).some((t) => t.includes("保証します")));
});

test("10 コピー後の権限未設定: a copy carries no grant, place, signature, claim or record", async () => {
  const s = await setup();
  const env = s.registry.getVersion(s.refs.A);
  const fork = forkManifest(env, s.pubs.B, { name: "front-supply-b" });
  const text = JSON.stringify(fork.manifest);
  assert.ok(!text.includes("lot:"), "no lot in a definition");
  assert.ok(!text.includes("vault:A-"), "A's places are not defaults of the copy");
  assert.equal(fork.manifest.claims, undefined);
  assert.equal(fork.manifest.derivedFrom.hash, env.hash);
  assert.deepEqual(fork.dropped.map((d) => d.what).slice(0, 4), ["signature", "grants", "resources", "record"]);
  // unsigned, the copy cannot be listed
  const unsigned = await s.registry.publish({ manifest: fork.manifest, hash: contentHash(fork.manifest), signature: null }, s.ctx);
  assert.deepEqual(codes(unsigned.findings), ["SIGNATURE_MISSING"]);
  // signed by B, it is listed; a plan on it has no inputs and no grant yet
  const pub = await s.registry.publish(await signManifest(fork.manifest, s.keys.B), s.ctx);
  assert.equal(pub.ok, true, JSON.stringify(pub.findings));
  const bare = await preflight(await planFor(s, "B", pub.ref, {}), s);
  assert.deepEqual(codes(bare.findings), ["MISSING_GRANT", "PARAM_UNBOUND"]);
  // B names the places but holds no lot; A's lot is A's
  const named = await preflight(await planFor(s, "B", pub.ref, B_BIND), s);
  assert.ok(codes(named.findings).includes("MISSING_GRANT"));
  const withA = await preflight(await planFor(s, "B", pub.ref, { ...B_BIND, grants: { ws: "lot:A-1" } }), s);
  assert.ok(codes(withA.findings).includes("GRANT_NOT_HELD"));
  // once B has its own lot (and stock), the copy is ready
  const w = giveUseLot(s.world, { to: "B" });
  w.places["vault:B-home"].stores = { ore: 60, wood: 30 };
  const ok = await preflight(await planFor({ ...s, world: w }, "B", pub.ref, B_BIND, w), { ...s, world: w });
  assert.equal(ok.ready, true, JSON.stringify(ok.findings));
});
