/**
 * WRITTEN, NOT RUN (2026-11-17, under an execution pause): no part of this file has been executed. Run it only with
 * its own approval. Its import closure is intake.test.mjs's (src/connect/dispatch.mjs → caravan.mjs → plan.mjs →
 * keys.mjs, which names a key API never reached here; cli/connect-fixture.mjs): it needs the same kind of review entry
 * before a key-free job may run it.
 *
 * Dispatch.plan never answers a plan as planned while its save has not been seen to succeed (dispatch.mjs #unsaved,
 * 2026-11-17), and never takes anything back from memory: a save that throws may still have reached the disk.
 *   U1 a save that throws before writing: the same request again throws while saving still fails, then is saved and
 *      answered (not "already"); only after that is it "already"
 *   U2 a save that throws after the journal reached the disk (as a failed directory sync): the same request is saved
 *      again before it is answered
 *   U3 a later save for another key covers the earlier one: then the first key is "already"
 *   U4 the same key with other content is still CONFLICT while unsaved
 *   U5 after a restart, a plan whose save never reached the disk is not there (NO_RECORD) and is planned again
 *   U6 advance on an unsaved plan calls nothing outside that has an effect: accept is preceded by a save, and a save
 *      that throws stops it
 *   U7 the source: the key is marked before the save, a successful save clears the mark
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

test("U7 the source: marked before the save, cleared by a save that succeeds", () => {
  const src = readFileSync(new URL("../src/connect/dispatch.mjs", import.meta.url), "utf8");
  assert.match(src, /#save\(\) \{\n\s+this\.journal\.save\(clone\(this\.data\)\);\n\s+this\.#unsaved\.clear\(\);\n\s+\}/);
  assert.match(src, /this\.data\.plans\[key\] = fresh;\n\s+this\.#unsaved\.add\(key\);\n\s+this\.#save\(\);/);
  assert.match(src, /if \(this\.#unsaved\.has\(key\)\) \{ this\.#save\(\); return \{ ok: true, key, steps: clone\(had\.steps\) \}; \}/);
});
