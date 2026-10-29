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
  const ctx = { features: world.features, today: world.today };
  const refs = {};
  if (publish) {
    refs.A = (await registry.publish(await signManifest(frontSupply(p.A), keys.A), ctx)).ref;
    refs.M = (await registry.publish(await signManifest(mineDelivery(p.M), keys.M), ctx)).ref;
  }
  return { keys, pubs: p, world, registry, ledger, ctx, refs };
}

export function codes(findings, { severities = ["error", "warning"] } = {}) {
  return [...new Set(findings.filter((f) => severities.includes(f.severity)).map((f) => f.code))].sort();
}

export function loadFixture(rel, p) {
  const text = readFileSync(join(FIXTURES, rel), "utf8").replace(/"\$([A-Z])"/g, (_, id) => JSON.stringify(p[id]));
  return JSON.parse(text);
}
