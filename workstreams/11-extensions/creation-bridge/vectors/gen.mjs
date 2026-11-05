#!/usr/bin/env node
/**
 * Contract vectors for the creation bridge, produced by workstream 06's own
 * code (not re-implemented): canonical forms and content hashes, signed
 * publication envelopes, a registry export with status changes, and the
 * status signatures that export does not keep.
 *
 *   node gen.mjs <path to workstreams/06-creation> <06 commit> > creation-vectors.json
 *
 * Keys are 06's demo seeds (public in its repository; not secrets).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [root, commit] = process.argv.slice(2);
if (!root || !commit) {
  console.error("usage: gen.mjs <06-creation dir> <commit>");
  process.exit(2);
}
const mod = (p) => import(pathToFileURL(join(root, p)).href);
const { canonicalize, contentHash } = await mod("src/canonical.mjs");
const { keyFromSeed, DOMAIN } = await mod("src/keys.mjs");
const { Registry, signManifest, signStatus, statusMessage } = await mod("src/registry.mjs");
const { DEMO_SEEDS, demoWorld } = await mod("src/scenario.mjs");
const { bindIdentities } = await mod("src/world.mjs");

const keys = {};
for (const [id, seed] of Object.entries(DEMO_SEEDS)) keys[id] = await keyFromSeed(seed);
const pubs = Object.fromEntries(Object.entries(keys).map(([id, k]) => [id, k.pub]));
const load = (rel) =>
  JSON.parse(
    readFileSync(join(root, "fixtures", rel), "utf8").replace(/"\$([A-Z])"/g, (_, id) => JSON.stringify(pubs[id])),
  );

// Canonical forms: 06's fixtures and edge cases of key order, escapes and
// numbers (the parts two implementations most easily disagree on).
const values = [
  { a: 1, B: 2, _: 3, "": 4, aa: 5, "é": 6, "\u{1F600}": 7, "Ａ": 8, "z": [true, false, null] },
  { s: "quote \" backslash \\ slash / tab \t nl \n cr \r bs \b ff \f nul \u0000 us \u001f del \u007f nbsp   ls   emoji \u{1F600}" },
  { n: [0, -0, 1, -1, 100, 1e2, 9007199254740991, -9007199254740991] },
  { nested: { b: { d: 1, c: 2 }, a: [{ y: 1, x: 2 }] } },
];
const canonical = [];
for (const v of values) canonical.push({ json: JSON.stringify(v), canonical: canonicalize(v), hash: contentHash(v) });
const refused = [1.5, 9007199254740992, 1e300].map((n) => {
  let err = null;
  try { canonicalize({ n }); } catch (e) { err = e.name; }
  return { json: JSON.stringify({ n }), error: err };
});

const manifests = {};
for (const f of ["ok/front-supply.json", "ok/mine-delivery.json", "ok/front-supply-river.json", "ok/base-only-caravan.json"]) {
  const m = load(f);
  manifests[f] = { manifest: m, canonical: canonicalize(m), hash: contentHash(m) };
}

// Envelopes and a registry: A's and M's definitions published, then M's
// suspended and relisted, A's withdrawn (06's own Registry and signatures).
const world = bindIdentities(demoWorld(), pubs);
const ctx = { features: world.features, today: world.today };
const reg = new Registry();
const envelopes = {};
const statusSignatures = [];
for (const [who, f] of [["A", "ok/front-supply.json"], ["M", "ok/mine-delivery.json"]]) {
  const env = await signManifest(manifests[f].manifest, keys[who]);
  const r = await reg.publish(env, ctx);
  if (!r.ok) throw new Error(`publish ${f}: ${JSON.stringify(r.findings)}`);
  envelopes[f] = env;
}
const mRef = { author: pubs.M, name: envelopes["ok/mine-delivery.json"].manifest.name };
const aRef = { author: pubs.A, name: envelopes["ok/front-supply.json"].manifest.name };
for (const [ref, who, status] of [[mRef, "M", "suspended"], [mRef, "M", "listed"], [aRef, "A", "withdrawn"]]) {
  const seq = reg.statusSeq(ref);
  const signature = await signStatus(ref, status, seq, keys[who]);
  const r = await reg.setStatus(ref, status, seq, signature, world.today);
  if (!r.ok) throw new Error(`status: ${JSON.stringify(r.findings)}`);
  statusSignatures.push({ author: ref.author, name: ref.name, status, seq, message: statusMessage(ref, status, seq), signature });
}

process.stdout.write(
  JSON.stringify(
    {
      source: { workstream: "06-creation", commit, generator: "workstreams/11-extensions/creation-bridge/vectors/gen.mjs" },
      domains: DOMAIN,
      pubs,
      canonical,
      refused,
      manifests,
      envelopes,
      registry: reg.toJSON(),
      statusSignatures,
    },
    null,
    1,
  ) + "\n",
);
