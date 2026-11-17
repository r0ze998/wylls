/**
 * WRITTEN, NOT RUN (2026-11-17, under an execution pause): no part of this file has been executed. Run it only with
 * its own approval. Its import closure is intake.test.mjs's (src/connect/dispatch.mjs → caravan.mjs → plan.mjs →
 * keys.mjs, which names a key API never reached here; cli/connect-fixture.mjs): it needs the same kind of review entry
 * before a key-free job may run it.
 *
 * Dispatch never answers a plan as planned, nor shows its state as saved, while that state has not been seen saved
 * (dispatch.mjs #saved: the plan as loaded or as last written by a save that returned; 2026-11-17), and never takes
 * anything back from memory: a save that throws may still have reached the disk.
 *   U1 a save that throws before writing: the same request again throws while saving still fails, then is saved and
 *      answered (not "already"); only after that is it "already"
 *   U2 a save that throws after the journal reached the disk (as a failed directory sync): the same request is saved
 *      again before it is answered
 *   U3 a later save for another key covers the earlier one: then the first key is "already"
 *   U4 the same key with other content is still CONFLICT while unsaved
 *   U5 after a restart, a plan whose save never reached the disk is not there (NO_RECORD) and is planned again
 *   U6 advance on an unsaved plan calls nothing outside that has an effect: accept is preceded by a save, and a save
 *      that throws stops it
 *   U7 the source: a save that returns records what it wrote; plan and status compare against it, reading only
 *   S1 status of a plan whose save threw: `saved: false`; after a save that returns, no `saved` field (as before)
 *   S2 the same after a save that threw once the journal was in place (a failed directory sync)
 *   S3 another key whose plan is as saved has no `saved` field
 *   S4 a step whose save threw before its outside call (accept): `saved: false`, accept not called; once a save
 *      returns, the field goes and the step goes on
 *   S5 a restart shows the journal's state with no `saved` field
 *   S6 status and the busy answer read only: no save is made by asking
 * Stand-ins only (an in-memory journal, a run port that counts). No key is generated, imported, derived or used;
 * nothing is signed, sent, spawned or fetched.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

for (const k of ["generateKey", "importKey", "exportKey", "deriveKey", "deriveBits", "sign", "verify"]) {
  globalThis.crypto.subtle[k] = () => { throw new Error(`crypto.subtle.${k} called in a no-key test`); };
}

const { Dispatch } = await import("../src/connect/dispatch.mjs");
const { relayRequest } = await import("../cli/connect-fixture.mjs");

const REQ = { actor: "1".repeat(31) + "A", generation: 1, citizen: "1".repeat(31) + "C", authenticatedBy: "test: the gateway's credential layer (stand-in)" };
/** A journal whose save can fail before writing ("before") or after the bytes are in place ("after"). */
function flaky() {
  let saved = null;
  const j = { mode: null, saves: 0, load: () => (saved ? JSON.parse(JSON.stringify(saved)) : null) };
  j.save = (o) => {
    j.saves++;
    if (j.mode === "before") throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
    saved = JSON.parse(JSON.stringify(o));
    if (j.mode === "after") throw Object.assign(new Error("EIO: directory sync"), { code: "EIO" });
  };
  j.has = (key) => Boolean(saved?.plans?.[key]);
  return j;
}
const counting = () => {
  const calls = [];
  return { calls, port: new Proxy({}, { get: (_, name) => async () => { calls.push(name); throw new Error("not reached"); } }) };
};
const req = (nonce) => ({ route: "run", ...relayRequest(), requester: REQ, ...(nonce ? { nonce } : {}) });

test("U1 a save that throws before writing", () => {
  const j = flaky();
  const d = new Dispatch({ journal: j, run4: counting().port });
  j.mode = "before";
  assert.throws(() => d.plan(req()), /ENOSPC/);
  assert.throws(() => d.plan(req()), /ENOSPC/, "not answered as already planned");
  j.mode = null;
  const p = d.plan(req());
  assert.deepEqual([p.ok, p.already], [true, undefined]);
  assert.equal(j.has(p.key), true);
  assert.equal(d.plan(req()).already, true);
});

test("U2 a save that throws after the journal reached the disk", () => {
  const j = flaky();
  const d = new Dispatch({ journal: j, run4: counting().port });
  j.mode = "after";
  assert.throws(() => d.plan(req()), /EIO/);
  j.mode = null;
  const before = j.saves;
  const p = d.plan(req());
  assert.deepEqual([p.ok, p.already, j.saves], [true, undefined, before + 1], "saved again before it is answered");
});

test("U3 a later save covers an earlier key", () => {
  const j = flaky();
  const d = new Dispatch({ journal: j, run4: counting().port });
  j.mode = "before";
  assert.throws(() => d.plan(req("n1")));
  j.mode = null;
  const b = d.plan(req("n2"));
  assert.equal(b.ok, true);
  const a = d.plan(req("n1"));
  assert.deepEqual([a.ok, a.already, j.has(a.key)], [true, true, true]);
});

test("U4 other content under an unsaved key is still CONFLICT", () => {
  const j = flaky();
  const d = new Dispatch({ journal: j, run4: counting().port });
  j.mode = "before";
  assert.throws(() => d.plan(req()));
  j.mode = null;
  const other = d.plan({ ...req(), requester: { ...REQ, generation: 2 } });
  assert.equal(other.findings?.[0]?.code, "CONFLICT");
});

test("U5 a restart reads only what reached the disk", async () => {
  const j = flaky();
  const d = new Dispatch({ journal: j, run4: counting().port });
  j.mode = "before";
  assert.throws(() => d.plan(req()));
  j.mode = null;
  const fresh = new Dispatch({ journal: j, run4: counting().port });
  const key = Dispatch.key(relayRequest().planHash, relayRequest().nonce);
  assert.deepEqual(await fresh.advance(key), { ok: false, code: "NO_RECORD" });
  assert.equal(fresh.plan(req()).ok, true);
});

test("U6 advance on an unsaved plan: nothing with an effect goes out", async () => {
  const j = flaky();
  const four = counting();
  const d = new Dispatch({ journal: j, run4: four.port });
  j.mode = "before";
  assert.throws(() => d.plan(req()));
  const key = Dispatch.key(relayRequest().planHash, relayRequest().nonce);
  await assert.rejects(d.advance(key), /ENOSPC/, "the save before accept throws");
  assert.equal(four.calls.includes("accept"), false, "accept was not called");
});

test("U7 the source: a save that returns records what it wrote; plan and status compare against it", () => {
  const src = readFileSync(new URL("../src/connect/dispatch.mjs", import.meta.url), "utf8");
  assert.match(src, /#save\(\) \{\n\s+const snapshot = clone\(this\.data\);\n\s+this\.journal\.save\(snapshot\);\n\s+this\.#remember\(snapshot\);\n\s+\}/, "recorded only after the save returns");
  assert.match(src, /if \(!this\.#isSaved\(key\)\) \{ this\.#save\(\); return \{ ok: true, key, steps: clone\(had\.steps\) \}; \}/);
  assert.match(src, /steps, \.\.\.\(this\.#isSaved\(key\) \? \{\} : \{ saved: false \}\) \};/);
  assert.match(src, /if \(this\.#busy\.has\(key\)\) return \{ \.\.\.this\.status\(key\), busy: true \};/, "the busy answer is the status, saved flag included");
});

test("S1 status after a plan whose save threw", () => {
  const j = flaky();
  const d = new Dispatch({ journal: j, run4: counting().port });
  const key = Dispatch.key(relayRequest().planHash, relayRequest().nonce);
  j.mode = "before";
  assert.throws(() => d.plan(req()));
  assert.equal(d.status(key).saved, false);
  j.mode = null;
  d.plan(req());
  assert.equal("saved" in d.status(key), false);
});

test("S2 after a save that threw once the journal was in place", () => {
  const j = flaky();
  const d = new Dispatch({ journal: j, run4: counting().port });
  const key = Dispatch.key(relayRequest().planHash, relayRequest().nonce);
  j.mode = "after";
  assert.throws(() => d.plan(req()));
  assert.deepEqual([j.has(key), d.status(key).saved], [true, false], "on disk, but not seen saved: still shown as not saved");
});

test("S3 another key as saved has no flag", () => {
  const j = flaky();
  const d = new Dispatch({ journal: j, run4: counting().port });
  const a = d.plan(req("n1"));
  j.mode = "before";
  assert.throws(() => d.plan(req("n2")));
  assert.equal("saved" in d.status(a.key), false);
  assert.equal(d.status(Dispatch.key(relayRequest().planHash, "n2")).saved, false);
});

test("S4 a step whose save threw before its outside call", async () => {
  const j = flaky();
  // ④ has no record yet (view null), then accept fails without an answer: the step stays, nothing decided
  const four = { calls: [] };
  four.port = { view: async () => { four.calls.push("view"); return null; }, accept: async () => { four.calls.push("accept"); throw Object.assign(new Error("no answer"), { code: "Spawn" }); } };
  const d = new Dispatch({ journal: j, run4: four.port });
  const { key } = d.plan(req());
  j.mode = "before";
  await assert.rejects(d.advance(key), /ENOSPC/);
  const s = d.status(key);
  assert.deepEqual([s.saved, s.steps[0].state, four.calls.includes("accept")], [false, "accepting", false]);
  j.mode = null;
  await d.advance(key);
  assert.equal(four.calls.includes("accept"), true, "the step goes on once a save returns");
  assert.equal("saved" in d.status(key), false);
});

test("S5 a restart shows the journal's state", () => {
  const j = flaky();
  const d = new Dispatch({ journal: j, run4: counting().port });
  const { key } = d.plan(req());
  const r = new Dispatch({ journal: j, run4: counting().port });
  assert.deepEqual([r.status(key).ok, "saved" in r.status(key)], [true, false]);
});

test("S6 asking makes no save", () => {
  const j = flaky();
  const d = new Dispatch({ journal: j, run4: counting().port });
  j.mode = "before";
  assert.throws(() => d.plan(req()));
  const n = j.saves;
  const key = Dispatch.key(relayRequest().planHash, relayRequest().nonce);
  d.status(key); d.status(key);
  assert.equal(j.saves, n);
});
