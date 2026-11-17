/**
 * The four kinds of reuse stay apart:
 *   A copying a definition gives no right and no result,
 *   B connecting needs the user's own grant on someone's running facility,
 *   C consuming needs a finished result in the ledger,
 *   D a world effect outside the commands is not composable at all.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { validateDefinition } from "../src/validate.mjs";
import { signManifest } from "../src/registry.mjs";
import { preparePlan, preflight } from "../src/plan.mjs";
import { forkManifest } from "../src/fork.mjs";
import { EFFECTS, NOT_COMPOSABLE } from "../src/catalog.mjs";
import { editForkForRiver, frontSupply, giveUseLot } from "../src/scenario.mjs";
import { codes, setup } from "./helpers.mjs";

test("A: a copy is ready only when B brings B's own right — copying is not connecting", async () => {
  const s = await setup();
  const fork = forkManifest(s.registry.getVersion(s.refs.A), s.pubs.B, { name: "copy-only" });
  const pub = await s.registry.publish(await signManifest(fork.manifest, s.keys.B), s.ctx);
  const bind = { params: { source: "vault:B-home", workVault: "vault:B-work", receiver: "vault:B-home", workshop: "village:W" } };
  const pf = await preflight(await preparePlan(s.registry.getVersion(pub.ref), bind, s.keys.B, { world: s.world }), s);
  assert.equal(pf.ready, false);
  assert.ok(codes(pf.findings).includes("MISSING_GRANT"));
});

test("B: connecting is to a running facility; the right is the user's lot, checked against the facility now", async () => {
  const s = await setup();
  s.world = giveUseLot(s.world, { to: "B" });
  s.world.places["vault:B-home"].stores = { ore: 60, wood: 30 };
  const bind = { params: { source: "vault:B-home", workVault: "vault:B-work", receiver: "vault:B-home", workshop: "village:W" } };
  const plan = await preparePlan(s.registry.getVersion(s.refs.A), bind, s.keys.B, { world: s.world });
  assert.equal((await preflight(plan, s)).ready, true);
  // the same plan, the facility now in another Province than B's vault
  const moved = structuredClone(s.world);
  moved.places["vault:B-work"].province = [9, 9];
  assert.ok(codes((await preflight(plan, { ...s, world: moved })).findings).includes("PLACE_MISMATCH"));
});

test("C: consuming needs a finished result, not a definition and not a right", async () => {
  const s = await setup();
  s.world = giveUseLot(s.world, { to: "B" });
  const river = editForkForRiver(forkManifest(s.registry.getVersion(s.refs.A), s.pubs.B, { name: "c-only" }).manifest, { mineRef: { author: s.pubs.M, name: "mine-delivery", range: "^1.0.0" } });
  const pub = await s.registry.publish(await signManifest(river, s.keys.B), s.ctx);
  assert.equal(pub.ok, true, JSON.stringify(pub.findings));
  const bind = { params: { workVault: "vault:B-work", receiver: "vault:B-home", workshop: "village:W" } };
  const plan = await preparePlan(s.registry.getVersion(pub.ref), bind, s.keys.B, { world: s.world });
  // without run inputs, the batch is left to each run; with an empty run input, nothing backs the consume
  assert.ok(codes((await preflight(plan, s)).findings, { severities: ["info"] }).includes("BATCH_AT_RUN"));
  const pf = await preflight(plan, s, { inputs: { batches: {} } });
  assert.deepEqual(pf.findings.filter((f) => f.severity === "error").map((f) => [f.code, f.reason]), [["BATCH_INVALID", "unbound"]]);
});

test("D: effects outside the commands are refused, by class, and nothing executes code", async () => {
  const s = await setup();
  for (const [effect, nc] of Object.entries(NOT_COMPOSABLE)) {
    const m = frontSupply(s.pubs.A, { name: "d-check" });
    m.steps.push({ id: "d", effect, args: {} });
    const got = codes(validateDefinition(m, s.ctx).findings);
    assert.ok(got.includes(nc.class === "forbidden" ? "EFFECT_FORBIDDEN" : "EFFECT_UNKNOWN"), `${effect}: ${got}`);
  }
  // every composable effect names an instruction that exists, at a stated level
  for (const e of Object.values(EFFECTS)) {
    assert.ok(["base", "s2-branch"].includes(e.availability));
    assert.ok(e.commands.every((c) => /\(0x[0-9A-F]{2}/.test(c)));
  }
});

test("on the base commit's main (S1 only) the workshop step is unavailable; a caravan-only definition works", async () => {
  const s = await setup();
  const main = { features: ["base"], today: 12 };
  assert.ok(codes(validateDefinition(frontSupply(s.pubs.A), main).findings).includes("EFFECT_UNAVAILABLE"));
  const world = { ...structuredClone(s.world), features: ["base"] };
  const plan = await preparePlan(s.registry.getVersion(s.refs.M), { params: { buyer: "vault:B-work" } }, s.keys.M, { world });
  const pf = await preflight(plan, { ...s, world });
  assert.equal(pf.ready, true, JSON.stringify(pf.findings));
  assert.ok(codes(pf.findings, { severities: ["info"] }).includes("WALLET_REQUIRED"), "a send to B's vault needs M's wallet (S1 §3.3)");
});
