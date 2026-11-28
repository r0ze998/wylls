#!/usr/bin/env node
/**
 * Write (or with --check, compare) fixtures/chainlink/signed.json: envelopes
 * and status signatures PRE-SIGNED with the public demo seeds of
 * src/scenario.mjs (not secrets), so test/chainlink-registry.test.mjs can
 * drive the real Registry with only signature *verification*, never a
 * signature (it runs in the key-free CI job). Ed25519 is deterministic, so
 * --check compares byte for byte.
 *
 *   node workstreams/06-creation/cli/chainlink-fixture.mjs [--check]
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { keyFromSeed } from "../src/keys.mjs";
import { Registry, signManifest, signStatus } from "../src/registry.mjs";
import { forkManifest } from "../src/fork.mjs";
import { DEMO_SEEDS, demoWorld, editForkForRiver, frontSupply, mineDelivery } from "../src/scenario.mjs";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "chainlink", "signed.json");

const keys = {};
const pubs = {};
for (const id of ["A", "B", "M"]) { keys[id] = await keyFromSeed(DEMO_SEEDS[id]); pubs[id] = keys[id].pub; }
const world = demoWorld();
const rules = { features: world.features, today: world.today };

const a1 = frontSupply(pubs.A);
const a2 = { ...structuredClone(a1), version: "1.0.1", note: `${a1.note ?? ""}（説明だけの直し）` };
const m1 = mineDelivery(pubs.M);

const reg = new Registry();
const envelopes = {};
envelopes.a1 = await signManifest(a1, keys.A);
envelopes.m1 = await signManifest(m1, keys.M);
for (const k of ["a1", "m1"]) if (!(await reg.publish(envelopes[k], rules)).ok) throw new Error(`fixture ${k} does not publish`);
const fork = forkManifest(reg.getVersion({ author: pubs.A, name: a1.name, version: a1.version }), pubs.B, { name: "front-supply-river", title: "前線補給（鉱山の便を使う）" });
const b1 = editForkForRiver(fork.manifest, { mineRef: { author: pubs.M, name: "mine-delivery", range: "^1.0.0" } });
envelopes.b1 = await signManifest(b1, keys.B);
envelopes.a2 = await signManifest(a2, keys.A);
// A same-version envelope with other content (a version is written once).
envelopes.a1other = await signManifest({ ...structuredClone(a1), note: "別の中身" }, keys.A);

const refA = { author: pubs.A, name: a1.name };
// A's statusLog after a1 and a2 has 2 rows, so the next change is signed over seq 2, then 3.
const status = {
  aSuspend2: { ref: refA, status: "suspended", seq: 2, signature: await signStatus(refA, "suspended", 2, keys.A) },
  aRelist3: { ref: refA, status: "listed", seq: 3, signature: await signStatus(refA, "listed", 3, keys.A) },
  bSuspend2: { ref: refA, status: "suspended", seq: 2, signature: await signStatus(refA, "suspended", 2, keys.B) },
};

const text = `${JSON.stringify({ note: "pre-signed with the public demo seeds of src/scenario.mjs; regenerate with cli/chainlink-fixture.mjs", pubs, rules, envelopes, status }, null, 2)}\n`;
if (process.argv.includes("--check")) {
  const have = readFileSync(OUT, "utf8");
  if (have !== text) { console.error(`${OUT} is stale: run cli/chainlink-fixture.mjs`); process.exit(1); }
  console.log("chainlink fixture: up to date");
} else {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, text);
  console.log(`wrote ${OUT}`);
}
