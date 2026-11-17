/**
 * WRITTEN, NOT RUN (2026-11-17, under an execution pause): no part of this file has been executed. Run it only with
 * its own approval. Its import closure is dispatch-unsaved-plan.test.mjs's (src/connect/dispatch.mjs → caravan.mjs →
 * plan.mjs → keys.mjs, which names a key API never reached here; cli/connect-fixture.mjs; src/canonical.mjs): it
 * needs the same kind of review entry before a key-free job may run it.
 *
 * Dispatch.status shows, per step, the definition the step runs (`pin`) and where its result was read
 * (`resultFrom`), from the journal only (dispatch.mjs status, 2026-11-17).
 *   S1 a planned run: every step's pin is the plan hash, the manifest (author, name, version, hash) and the confirmed
 *      effect revision; resultFrom is null while there is no result
 *   S2 a re-edited definition (version 1.1.0) is a new plan hash and a new key: its steps show 1.1.0, the earlier
 *      run's still show 1.0.0
 *   S3 the earlier key asked again with the re-edited definition: refused (PIN_MISMATCH) or answered as it is; the
 *      pin shown never changes
 *   S4 a restart over the same journal shows the same pins
 *   S5 act route: after ④'s act receipt is read, resultFrom names it; the pin is there as on the run route
 *   S6 status calls nothing outside (a run port and an act port that count every call)
 * Stand-ins only (an in-memory journal, ports that count). No key is generated, imported, derived or used; nothing is
 * signed, sent, spawned or fetched.
 */

import test from "node:test";
import assert from "node:assert/strict";

for (const k of ["generateKey", "importKey", "exportKey", "deriveKey", "deriveBits", "sign", "verify"]) {
  globalThis.crypto.subtle[k] = () => { throw new Error(`crypto.subtle.${k} called in a no-key test`); };
}

const { Dispatch } = await import("../src/connect/dispatch.mjs");
const { relayRequest, relayManifest } = await import("../cli/connect-fixture.mjs");
const { contentHash } = await import("../src/canonical.mjs");
const { mineDelivery } = await import("../src/scenario.mjs");

const REQ = { actor: "1".repeat(31) + "A", generation: 1, citizen: "1".repeat(31) + "C", authenticatedBy: "test: the gateway's credential layer (stand-in)" };
function memJournal() {
  let saved = null;
  return { load: () => (saved ? JSON.parse(JSON.stringify(saved)) : null), save: (o) => { saved = JSON.parse(JSON.stringify(o)); } };
}
const counting = () => {
  const calls = [];
  return { calls, port: new Proxy({}, { get: (_, name) => async () => { calls.push(name); throw new Error("not reached"); } }) };
};
const run = (r) => ({ route: "run", ...r, requester: REQ });

/** relayRequest with the manifest re-edited to `version`: a new definition hash, so a new plan hash. */
function reEdited(version) {
  const base = relayRequest();
  const m = { ...relayManifest(), version };
  const env = { manifest: m, hash: contentHash(m) };
  const plan = { ...base.plan, manifest: { author: m.author, name: m.name, version: m.version, hash: env.hash } };
  return { ...base, plan, planHash: contentHash(plan), env };
}
const pinOf = (r) => ({ planHash: r.planHash, manifest: { ...r.plan.manifest }, effects: { "caravan.send": 1 } });

test("S1 a planned run shows its pin; no result yet", () => {
  const d = new Dispatch({ journal: memJournal(), run4: counting().port });
  const r = relayRequest();
  const p = d.plan(run(r));
  assert.equal(p.ok, true);
  const s = d.status(p.key);
  assert.equal(s.steps.length, 2);
  for (const st of s.steps) {
    assert.deepEqual(st.pin, pinOf(r), st.step);
    assert.equal(st.pin.manifest.version, "1.0.0");
    assert.equal(st.resultFrom, null);
  }
});

test("S2-S4 a re-edit is a new key; the earlier run keeps its version", () => {
  const j = memJournal();
  const d = new Dispatch({ journal: j, run4: counting().port });
  const v1 = relayRequest(), v2 = reEdited("1.1.0");
  assert.notEqual(v1.planHash, v2.planHash);
  const a = d.plan(run(v1)), b = d.plan(run(v2));
  assert.deepEqual([a.ok, b.ok], [true, true]);
  assert.notEqual(a.key, b.key);
  assert.deepEqual(d.status(b.key).steps.map((x) => x.pin.manifest.version), ["1.1.0", "1.1.0"]);
  assert.deepEqual(d.status(a.key).steps.map((x) => x.pin.manifest.version), ["1.0.0", "1.0.0"], "S2");
  // S3: the earlier key (its plan hash and nonce) with the re-edited definition
  const again = d.plan(run({ ...v2, plan: v1.plan, planHash: v1.planHash }));
  assert.ok(again.ok === false ? again.findings[0].code === "PIN_MISMATCH" : again.already === true, JSON.stringify(again));
  assert.deepEqual(d.status(a.key).steps.map((x) => x.pin), [pinOf(v1), pinOf(v1)], "S3: unchanged");
  // S4
  const r = new Dispatch({ journal: j, run4: counting().port });
  assert.deepEqual(r.status(a.key).steps.map((x) => x.pin.manifest.version), ["1.0.0", "1.0.0"]);
  assert.deepEqual(r.status(b.key).steps.map((x) => x.pin.manifest.version), ["1.1.0", "1.1.0"]);
});

test("S5 act route: the receipt's source is named", async () => {
  const VIEW = { citizenTag: "41", places: [
    { kind: "vault", p: 2, q: -1, tile: 7, gen: 1, known: true, placeId: "vault:2,-1,7" },
    { kind: "vault", p: 3, q: -1, tile: 4, gen: 2, known: true, placeId: "vault:3,-1,4" },
  ] };
  const m = mineDelivery("ab".repeat(32));
  const env = { manifest: m, hash: contentHash(m) };
  const plan = { format: "wylls.creation.plan/1", manifest: { author: m.author, name: m.name, version: m.version, hash: env.hash }, actor: "cd".repeat(32), bindings: { params: { mine: "vault:2,-1,7", buyer: "vault:3,-1,4", ore: 3, wood: 1 }, grants: {} }, preparedDay: 12, effects: { "caravan.send": 1 } };
  const sends = [];
  const act = {
    prepare: async () => ({ planId: "pl-1" }),
    send: async (x) => { sends.push(x); return { ok: true }; },
    status: async (runId, requestId) => ({ receiptVersion: "p04-acts/0.1", runId, idempotencyKey: `ws03:L:${requestId}`, source: "mcp", state: "pending", newAttemptAllowed: false }),
  };
  const d = new Dispatch({ journal: memJournal(), act });
  const p = d.plan({ route: "act", plan, planHash: contentHash(plan), env, nonce: "a1", view: VIEW });
  assert.equal(p.ok, true);
  assert.equal(d.status(p.key).steps[0].resultFrom, null, "no result yet");
  await d.advance(p.key);
  const st = d.status(p.key).steps[0];
  assert.equal(sends.length, 1);
  assert.equal(st.result?.state, "pending");
  assert.equal(st.resultFrom, "④ act registry receipt (p04-acts/0.1), read through ③");
  assert.equal(st.pin.manifest.hash, env.hash);
});

test("S6 status calls nothing outside", () => {
  const four = counting(), three = counting();
  const d = new Dispatch({ journal: memJournal(), run4: four.port, act: three.port });
  const p = d.plan(run(relayRequest()));
  d.status(p.key);
  assert.deepEqual([four.calls, three.calls], [[], []]);
});
