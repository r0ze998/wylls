/**
 * Shared set-up: the demo people's keys, the world with their public keys,
 * and a registry where A's and M's definitions are published.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { keyFromSeed } from "../src/keys.mjs";
import { Registry, signManifest } from "../src/registry.mjs";
import { Ledger } from "../src/ledger.mjs";
import { AdoptionBook } from "../src/adoption.mjs";
import { preparePlan, preflight } from "../src/plan.mjs";
import { execute, requestRun } from "../src/execute.mjs";
import { bindIdentities } from "../src/world.mjs";
import { DEMO_SEEDS, demoWorld, frontSupply, mineDelivery } from "../src/scenario.mjs";

export const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

let cached;
export async function people() {
  if (!cached) {
    const keys = {};
    for (const [id, seed] of Object.entries(DEMO_SEEDS)) keys[id] = await keyFromSeed(seed);
    cached = keys;
  }
  return cached;
}

export async function pubs() {
  const k = await people();
  return Object.fromEntries(Object.entries(k).map(([id, key]) => [id, key.pub]));
}

/** A fresh world, registry and ledger with A's front-supply and M's mine-delivery listed. */
export async function setup({ publish = true } = {}) {
  const keys = await people();
  const p = await pubs();
  const world = bindIdentities(demoWorld(), p);
  const registry = new Registry();
  const ledger = new Ledger();
  const adoptions = new AdoptionBook();
  const ctx = { features: world.features, today: world.today };
  const refs = {};
  if (publish) {
    refs.A = (await registry.publish(await signManifest(frontSupply(p.A), keys.A), ctx)).ref;
    refs.M = (await registry.publish(await signManifest(mineDelivery(p.M), keys.M), ctx)).ref;
  }
  return { keys, pubs: p, world, registry, ledger, adoptions, ctx, refs };
}

export function codes(findings, { severities = ["error", "warning"] } = {}) {
  return [...new Set(findings.filter((f) => severities.includes(f.severity)).map((f) => f.code))].sort();
}

export function loadFixture(rel, p) {
  const text = readFileSync(join(FIXTURES, rel), "utf8").replace(/"\$([A-Z])"/g, (_, id) => JSON.stringify(p[id]));
  return JSON.parse(text);
}

/** Prepare a plan for `who` on a listed version. */
export function prepare(s, who, ref, bindings, opts = {}) {
  return preparePlan(s.registry.getVersion(ref), bindings, s.keys[who], { world: s.world, ...opts });
}

// Batches named in a test's bindings are per-run inputs, not part of the plan:
// remembered here so `exec` and `check` can pass them with each run.
const runInputs = new WeakMap();

/** Prepare, adopt (the user's confirmation) and return the signed plan; throws if adoption fails. */
export async function adopt(s, who, ref, bindings, opts = {}) {
  const plan = await prepare(s, who, ref, bindings, opts);
  const a = await s.adoptions.adopt(plan, s);
  if (!a.ok) throw new Error(`adoption failed: ${JSON.stringify(a.findings.filter((f) => f.severity === "error"))}`);
  if (bindings.batches) runInputs.set(plan, bindings.batches);
  return plan;
}

let nonces = 0;
/** Run a plan once (mock), with a run request signed by the plan's own user. */
export async function exec(s, plan, { batches, raidAt, as } = {}) {
  const who = as ?? Object.keys(s.pubs).find((id) => s.pubs[id] === plan.plan.actor);
  const request = await requestRun(plan, { batches: batches ?? runInputs.get(plan) ?? {}, nonce: `t${++nonces}`, day: s.world.today }, s.keys[who]);
  return execute(plan, s, { request, raidAt });
}

/** Preflight with the run's batches as inputs. */
export function check(s, plan, batches) {
  return preflight(plan, s, { inputs: { batches: batches ?? runInputs.get(plan) ?? {} } });
}

/** Prepare, adopt and execute once (mock). */
export async function adoptAndRun(s, who, ref, bindings, opts = {}) {
  const plan = await adopt(s, who, ref, bindings);
  const run = await exec(s, plan, opts);
  return { plan, run };
}

/** M runs mine-delivery into B's vault: returns the batch id and the evidence id it made. */
export async function deliverToB(s, { ore = 24, wood = 12, vault = "vault:B-work" } = {}) {
  const { run } = await adoptAndRun(s, "M", s.refs.M, { params: { buyer: vault, ore, wood } });
  if (!run.ok) throw new Error(`delivery failed: ${JSON.stringify(run.failure)}`);
  const batch = Object.values(s.world.batches).find((b) => b.evidence === run.receipts[0].id);
  return { batch: batch.id, evidence: run.receipts[0].id };
}

export { preflight, execute, requestRun };
