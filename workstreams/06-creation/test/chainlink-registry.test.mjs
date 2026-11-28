/**
 * ⑥ chain link, slice 1: the real Registry with the flag on, driven by
 * envelopes and status signatures PRE-SIGNED with the public demo seeds
 * (fixtures/chainlink/signed.json, written by cli/chainlink-fixture.mjs).
 * This file never signs, derives or generates a key: the Registry only
 * *verifies* Ed25519 signatures (a raw public key import + verify).
 * src/keys.mjs is in the import closure (through registry.mjs) but none of
 * its signing functions is called; the key-API names below are stubbed to
 * throw so a regression fails here too.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Registry } from "../src/registry.mjs";
import { LinkedRegistry } from "../src/chainlink/linked.mjs";
import { LocalChain } from "../src/chainlink/localchain.mjs";
import { crossCheck, matchEnvelope, readCatalog } from "../src/chainlink/catalog.mjs";

const subtle = globalThis.crypto.subtle;
const proto = Object.getPrototypeOf(subtle);
for (const name of ["generateKey", "deriveKey", "deriveBits"]) Object.defineProperty(proto, name, { value: () => { throw new Error(`${name} called in a key-free test`); }, configurable: true, writable: true });
Object.defineProperty(proto, "sign", { value: () => { throw new Error("sign called in a key-free test"); }, configurable: true, writable: true });

const F = JSON.parse(readFileSync(new URL("../fixtures/chainlink/signed.json", import.meta.url), "utf8"));
const { pubs, rules, envelopes: E, status: S } = F;

function fresh(on = true) {
  const registry = new Registry();
  const chain = on ? new LocalChain({ seasonId: 3, slot: 0, accounts: {}, log: [] }) : null;
  return { registry, chain, linked: new LinkedRegistry(registry, chain) };
}

test("flag on: a publish lands in both the registry and the chain record, and they agree", async () => {
  const { registry, chain, linked } = fresh();
  const r = await linked.publish(E.a1, rules);
  assert.equal(r.ok, true, JSON.stringify(r.findings));
  assert.equal(r.chain.slot, 1);
  const e = chain.entry(pubs.A, E.a1.manifest.name);
  assert.deepEqual([e.status, e.statusSeq, e.versionCount, e.newest, e.newestHash, e.statusDay], ["listed", 1, 1, "1.0.0", E.a1.hash, rules.today]);
  assert.equal(chain.version(pubs.A, "front-supply", "1.0.0").hash, E.a1.hash);
  assert.ok(registry.entry(pubs.A, "front-supply"), "the registry has it too");
  assert.deepEqual(crossCheck(registry.toJSON(), chain), []);
  assert.equal(matchEnvelope(chain, registry.getVersion({ author: pubs.A, name: "front-supply", version: "1.0.0" })), null);
});

test("flag on: the whole story (publish, fork with derivedFrom, patch, suspend, relist) stays in step", async () => {
  const { registry, chain, linked } = fresh();
  for (const k of ["a1", "m1", "b1", "a2"]) assert.equal((await linked.publish(E[k], rules)).ok, true, k);
  assert.equal((await linked.setStatus(S.aSuspend2.ref, S.aSuspend2.status, S.aSuspend2.seq, S.aSuspend2.signature, 13)).ok, true);
  assert.equal(chain.entry(pubs.A, "front-supply").status, "suspended");
  assert.equal(chain.entry(pubs.A, "front-supply").statusDay, 13);
  assert.equal((await linked.setStatus(S.aRelist3.ref, S.aRelist3.status, S.aRelist3.seq, S.aRelist3.signature, 14)).ok, true);
  assert.deepEqual(crossCheck(registry.toJSON(), chain), []);
  const cat = readCatalog(chain);
  assert.deepEqual(cat.entries.map((x) => [x.name, x.status, x.statusSeq, x.versions.map((v) => v.version)]).sort(), [
    ["front-supply", "listed", 4, ["1.0.0", "1.0.1"]],
    ["front-supply-river", "listed", 1, [E.b1.manifest.version]],
    ["mine-delivery", "listed", 1, ["1.0.0"]],
  ].sort());
  const river = cat.entries.find((x) => x.name === "front-supply-river");
  assert.equal(river.author, pubs.B);
  assert.equal(river.versions[0].derivedFromHash, E.a1.hash, "the fork's source is on its version record");
  assert.deepEqual(chain.data.log.map((x) => x.kind), ["CREATION_PUBLISHED", "CREATION_PUBLISHED", "CREATION_PUBLISHED", "CREATION_PUBLISHED", "CREATION_STATUS", "CREATION_STATUS"]);
});

test("flag on: what the registry refuses never reaches the chain", async () => {
  const { registry, chain, linked } = fresh();
  await linked.publish(E.a1, rules);
  const before = JSON.stringify(chain.toJSON());
  const same = await linked.publish(E.a1other, rules);
  assert.equal(same.ok, false);
  assert.ok(same.findings.some((f) => f.code === "VERSION_EXISTS"));
  const tampered = await linked.publish({ ...E.a2, hash: E.a1.hash }, rules);
  assert.ok(tampered.findings.some((f) => f.code === "HASH_MISMATCH"));
  const notAuthor = await linked.setStatus(S.bSuspend2.ref, "suspended", 1, S.bSuspend2.signature, 13);
  assert.equal(notAuthor.ok, false);
  assert.equal(JSON.stringify(chain.toJSON()), before, "chain untouched");
  assert.deepEqual(crossCheck(registry.toJSON(), chain), []);
});

test("flag on: what the chain refuses leaves the registry untouched too (one transaction, both or neither)", async () => {
  const { registry, chain, linked } = fresh();
  // The registry accepts A's envelope, but the transaction is signed by B's wallet.
  const r = await linked.publish(E.a1, rules, { signer: pubs.B });
  assert.equal(r.ok, false);
  const f = r.findings.find((x) => x.stage === "chain");
  assert.equal(f.code, "CHAIN_NOT_AUTHOR");
  assert.match(f.message, /チェーンの記録/);
  assert.equal(registry.entry(pubs.A, "front-supply"), null, "registry unchanged");
  assert.equal(chain.data.slot, 0);
  // Status: the chain was moved on behind the registry's back (a stale page): refused, registry unchanged.
  await linked.publish(E.a1, rules);
  await linked.publish(E.a2, rules);
  chain.setStatus({ signer: pubs.A, author: pubs.A, name: "front-supply", status: "withdrawn", seq: 2 });
  const s = await linked.setStatus(S.aSuspend2.ref, "suspended", 2, S.aSuspend2.signature, 13);
  assert.equal(s.ok, false);
  assert.equal(s.findings[0].code, "CHAIN_STALE_SEQ");
  assert.equal(registry.entry(pubs.A, "front-supply").status, "listed");
  assert.deepEqual(crossCheck(registry.toJSON(), chain).map((d) => d.code).sort(), ["SEQ_DIFFERS", "STATUS_DIFFERS"]);
});

test("flag off: the registry behaves exactly as without the chain link", async () => {
  const plain = new Registry();
  const { registry, linked } = fresh(false);
  for (const k of ["a1", "m1", "b1", "a2"]) {
    const x = await plain.publish(E[k], rules);
    const y = await linked.publish(E[k], rules);
    assert.deepEqual(y, x, k);
  }
  const x = await plain.setStatus(S.aSuspend2.ref, "suspended", 2, S.aSuspend2.signature, 13);
  const y = await linked.setStatus(S.aSuspend2.ref, "suspended", 2, S.aSuspend2.signature, 13);
  assert.deepEqual(y, x);
  assert.deepEqual(registry.toJSON(), plain.toJSON());
  assert.equal("chain" in y, false);
});

test("the fixture's authors are the demo keys the rest of ⑥ uses (regenerate with cli/chainlink-fixture.mjs)", () => {
  assert.equal(E.a1.manifest.author, pubs.A);
  assert.equal(E.b1.manifest.author, pubs.B);
  assert.equal(E.b1.manifest.derivedFrom.hash, E.a1.hash);
  assert.equal(E.m1.manifest.author, pubs.M);
});
