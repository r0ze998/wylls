/**
 * Author A and user B are different people with different keys. B prepares
 * a plan from public data and B's own key; A's private key is never in
 * reach of B's code, and nobody can publish in A's name without it.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { contentHash } from "../src/canonical.mjs";
import { DOMAIN, generateKey, signHash, verifyHash } from "../src/keys.mjs";
import { Registry, signManifest, verifyEnvelope } from "../src/registry.mjs";
import { preparePlan, preflight, verifyPlanSignature } from "../src/plan.mjs";
import { Ledger } from "../src/ledger.mjs";
import { bindIdentities } from "../src/world.mjs";
import { demoWorld, frontSupply, giveUseLot } from "../src/scenario.mjs";
import { codes } from "./helpers.mjs";

/** A publishes with a fresh, non-extractable key and keeps it; only the registry's JSON leaves A's scope. */
async function authorPublishes() {
  const a = await generateKey();
  const registry = new Registry();
  const world0 = demoWorld();
  const r = await registry.publish(await signManifest(frontSupply(a.pub), a), { features: world0.features, today: world0.today });
  assert.equal(r.ok, true);
  return { listing: JSON.parse(JSON.stringify(registry.toJSON())), aPub: a.pub, ref: r.ref };
}

test("B prepares and checks a plan with only public data and B's own key", async () => {
  const { listing, aPub, ref } = await authorPublishes();
  // B's side: a registry rebuilt from the listing's JSON, B's own key, a world snapshot
  const registry = new Registry(listing);
  const b = await generateKey();
  const world = giveUseLot(bindIdentities(demoWorld(), { A: aPub, B: b.pub }), { to: "B" });
  world.places["vault:B-home"].stores = { ore: 60, wood: 30 };
  const env = registry.getVersion(ref);
  assert.deepEqual(await verifyEnvelope(env), [], "A's signature checks with A's public key");
  const signed = await preparePlan(env, { params: { source: "vault:B-home", workVault: "vault:B-work", receiver: "vault:B-home", workshop: "village:W" } }, b, { world });
  assert.equal(signed.plan.actor, b.pub);
  assert.equal(signed.plan.manifest.author, aPub);
  assert.equal(await verifyPlanSignature(signed), true);
  assert.equal(await verifyHash(aPub, DOMAIN.plan, signed.hash, signed.signature), false, "the plan is not A's");
  const pf = await preflight(signed, { registry, world, ledger: new Ledger() });
  assert.equal(pf.ready, true, JSON.stringify(pf.findings));
  // the plan carries no private material of anyone
  const text = JSON.stringify(signed);
  for (const field of ["seed", "private", "pkcs8", "\"d\""]) assert.ok(!text.includes(field));
});

test("B cannot publish in A's name, nor alter A's listing", async () => {
  const { listing, aPub } = await authorPublishes();
  const registry = new Registry(listing);
  const b = await generateKey();
  const asA = frontSupply(aPub, { version: "2.0.0", title: "Aの名前を騙る版" });
  await assert.rejects(() => signManifest(asA, b), /not the manifest's author/);
  const forged = await registry.publish({ manifest: asA, hash: contentHash(asA), signature: await signHash(b, DOMAIN.publish, contentHash(asA)) }, { features: ["base", "s2-branch"], today: 12 });
  assert.deepEqual(codes(forged.findings), ["SIGNATURE_INVALID"]);
  // a publication signature cannot be replayed as another kind of message
  const env = Object.values(listing.entries)[0].versions["1.0.0"];
  assert.equal(await verifyHash(aPub, DOMAIN.status, env.hash, env.signature), false);
  // editing A's listed manifest breaks its hash
  const edited = structuredClone(env);
  edited.manifest.limits.runsPerDay = 3;
  assert.deepEqual(codes(await verifyEnvelope(edited)), ["HASH_MISMATCH", "SIGNATURE_INVALID"]);
});

test("a plan edited after B signed it is refused", async () => {
  const { listing, aPub, ref } = await authorPublishes();
  const registry = new Registry(listing);
  const b = await generateKey();
  const world = giveUseLot(bindIdentities(demoWorld(), { A: aPub, B: b.pub }), { to: "B" });
  const signed = await preparePlan(registry.getVersion(ref), { params: { source: "vault:B-home", workVault: "vault:B-work", receiver: "vault:B-home", workshop: "village:W" } }, b, { world });
  const edited = structuredClone(signed);
  edited.plan.bindings.params.receiver = "vault:D-fort";
  edited.hash = contentHash(edited.plan);
  const pf = await preflight(edited, { registry, world, ledger: new Ledger() });
  assert.ok(codes(pf.findings).includes("PLAN_SIGNATURE_INVALID"));
});

test("an input left at the author's default that points at someone else's place is flagged", async () => {
  const { listing, aPub, ref } = await authorPublishes();
  const registry = new Registry(listing);
  const b = await generateKey();
  const world = giveUseLot(bindIdentities(demoWorld(), { A: aPub, B: b.pub }), { to: "B" });
  world.places["vault:B-home"].stores = { ore: 60, wood: 30 };
  // B binds everything but the receiver: the default is A's front vault
  const signed = await preparePlan(registry.getVersion(ref), { params: { source: "vault:B-home", workVault: "vault:B-work", workshop: "village:W" } }, b, { world });
  const pf = await preflight(signed, { registry, world, ledger: new Ledger() });
  const f = pf.findings.find((x) => x.code === "PARAM_DEFAULT_FOREIGN");
  assert.equal(f?.param, "receiver");
  assert.equal(f?.owner, "A");
});
