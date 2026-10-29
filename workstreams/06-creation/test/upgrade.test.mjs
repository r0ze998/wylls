import test from "node:test";
import assert from "node:assert/strict";
import { offerFor, requiredBump } from "../src/upgrade.mjs";
import { satisfies, bumpOf } from "../src/semver.mjs";
import { signManifest } from "../src/registry.mjs";
import { preparePlan, preflight } from "../src/plan.mjs";
import { frontSupply, giveUseLot } from "../src/scenario.mjs";
import { setup } from "./helpers.mjs";

const PK = "ab".repeat(32);

test("ranges", () => {
  assert.ok(satisfies("1.4.2", "^1.0.0"));
  assert.ok(!satisfies("2.0.0", "^1.0.0"));
  assert.ok(satisfies("0.1.9", "^0.1.0") && !satisfies("0.2.0", "^0.1.0"));
  assert.ok(satisfies("1.2.9", "~1.2.0") && !satisfies("1.3.0", "~1.2.0"));
  assert.ok(satisfies("1.2.3", "1.2.3") && !satisfies("1.2.4", "1.2.3"));
  assert.equal(bumpOf("1.2.3", "1.2.3"), null);
  assert.equal(bumpOf("1.2.3", "2.0.0"), "major");
});

test("required bumps: text is patch, additions are minor, behaviour is major", () => {
  const v1 = frontSupply(PK);
  assert.equal(requiredBump(v1, { ...v1, version: "1.0.1", title: "前線補給（改題）", note: "説明を直した" }).bump, "patch");
  assert.equal(requiredBump(v1, { ...v1, validUntilDay: 99 }).bump, "major", "an end where there was none shortens validity");
  const added = structuredClone(v1);
  added.params.memo = { type: "int", default: 0, ja: "控え" };
  added.outputs.extra = { from: { step: "make", out: "made" } };
  assert.equal(requiredBump(v1, added).bump, "minor");
  const needsInput = structuredClone(v1);
  needsInput.params.escort = { type: "int" };
  assert.equal(requiredBump(v1, needsInput).bump, "major");
  const moreRuns = structuredClone(v1);
  moreRuns.limits.runsPerDay = 2;
  assert.equal(requiredBump(v1, moreRuns).bump, "major");
  const route = structuredClone(v1);
  route.steps[2].args.cargo.goods.arms.times = 3;
  const r = requiredBump(v1, route);
  assert.equal(r.bump, "major");
  assert.ok(r.reasons.includes("手順が変わった"));
});

test("existing users: pinned plans keep their version; the offer depends on the bump", async () => {
  const s = await setup();
  s.world = giveUseLot(s.world, { to: "B" });
  s.world.places["vault:B-home"].stores = { ore: 60, wood: 30 };
  const bind = { params: { source: "vault:B-home", workVault: "vault:B-work", receiver: "vault:B-home", workshop: "village:W" } };
  const v1 = s.registry.getVersion(s.refs.A);
  const plan = await preparePlan(v1, bind, s.keys.B, { world: s.world });
  // A publishes 2.0.0 that ships only 2 arms per run
  const v2 = frontSupply(s.pubs.A, { version: "2.0.0" });
  v2.steps[2].args.cargo.goods.arms.times = 2;
  v2.claims.outputsPerRun = { arms: 6 };
  const pub = await s.registry.publish(await signManifest(v2, s.keys.A), s.ctx);
  assert.equal(pub.ok, true, JSON.stringify(pub.findings));
  assert.equal((await preflight(plan, s)).ready, true, "the plan still runs the version it pinned");
  const offer = offerFor(v1.manifest, s.registry.getVersion(pub.ref).manifest);
  assert.equal(offer.action, "stay");
  // a text-only patch may be followed
  const v201 = { ...v2, version: "2.0.1", note: "経路の注意を足した" };
  const p2 = await s.registry.publish(await signManifest(v201, s.keys.A), s.ctx);
  assert.equal(p2.ok, true);
  assert.equal(offerFor(v2, v201).action, "follow");
});
