/**
 * WRITTEN, NOT RUN (2026-11-17, under an execution pause): no part of this file has been executed. Run it only with
 * its own approval. Its import closure is dispatch.test.mjs's (src/connect/dispatch.mjs → caravan.mjs → plan.mjs →
 * keys.mjs, which names a key API never reached here; src/canonical.mjs; src/scenario.mjs): it needs the same kind of
 * review entry before a key-free job may run it.
 *
 * A save that throws AFTER ③'s send (the act route). Two different unknowns are kept apart: whether the journal holds
 * the newest state (`saved: false` in status) and what happened outside (each step's state and result). Nothing is
 * rolled back: a step that sent never reads "planned" again, and no new planId or requestId is ever made.
 *   A1 the send answered ok, then the save of "sent-requested" threw: status shows sent-requested and saved: false;
 *      one send
 *   A2 the same instance advances again: no send (the step is past sending); the flag stays until a save returns
 *   A3 the same request planned again saves the journal: the flag goes, the journal holds sent-requested; no send
 *   A4 another key's save writes the whole journal: the first key's flag goes too; no send
 *   A5 a restart after a save that threw before writing (the journal still says "sending"): ④ has the act, so the step
 *      becomes sent-requested without a send; ④ has no record: the only call is ③'s send with the SAME planId and
 *      requestId (the existing read-before-send recovery; ③ answers a requestId it has from its record) — never new ids
 *   A6 a send whose answer is not known (it throws, not definitive) and a save that then throws: the step stays
 *      sending, saved: false; the next pass reads ④ before any send
 * Stand-ins only (an in-memory journal, a ③ port that counts and records its arguments). No key is generated,
 * imported, derived or used; nothing is signed, sent, spawned or fetched.
 */

import test from "node:test";
import assert from "node:assert/strict";

for (const k of ["generateKey", "importKey", "exportKey", "deriveKey", "deriveBits", "sign", "verify"]) {
  globalThis.crypto.subtle[k] = () => { throw new Error(`crypto.subtle.${k} called in a no-key test`); };
}

const { Dispatch } = await import("../src/connect/dispatch.mjs");
const { contentHash } = await import("../src/canonical.mjs");
const { mineDelivery } = await import("../src/scenario.mjs");

const VIEW = {
  citizenTag: "41",
  places: [
    { kind: "vault", p: 2, q: -1, tile: 7, gen: 1, known: true, placeId: "vault:2,-1,7" },
    { kind: "vault", p: 3, q: -1, tile: 4, gen: 2, known: true, placeId: "vault:3,-1,4" },
  ],
};
function actRequest(nonce = "a1") {
  const m = mineDelivery("ab".repeat(32));
  const env = { manifest: m, hash: contentHash(m) };
  const plan = { format: "wylls.creation.plan/1", manifest: { author: m.author, name: m.name, version: m.version, hash: env.hash }, actor: "cd".repeat(32), bindings: { params: { mine: "vault:2,-1,7", buyer: "vault:3,-1,4", ore: 3, wood: 1 }, grants: {} }, preparedDay: 12, effects: { "caravan.send": 1 } };
  return { route: "act", plan, planHash: contentHash(plan), env, nonce, view: VIEW };
}

/** An in-memory journal: `failWhen(obj)` true makes that save throw, before writing or after (`mode`). */
function flaky() {
  let saved = null;
  const j = { mode: "before", failWhen: () => false, load: () => (saved ? JSON.parse(JSON.stringify(saved)) : null) };
  j.save = (o) => {
    const fail = j.failWhen(o);
    if (fail && j.mode === "before") throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
    saved = JSON.parse(JSON.stringify(o));
    if (fail) throw Object.assign(new Error("EIO: directory sync"), { code: "EIO" });
  };
  j.disk = () => saved;
  return j;
}
/** ③ as act3FromMcp gives it: prepare, send, and ④'s act receipt by status (null: not registered). */
function three() {
  const t = { sends: [], prepares: 0, record: null, sendAnswer: () => ({ ok: true }) };
  t.prepare = async () => { t.prepares++; return { planId: "pl-1" }; };
  t.send = async (a) => { t.sends.push(a); return t.sendAnswer(); };
  t.status = async () => t.record;
  return t;
}
const pending = (s) => ({ receiptVersion: "p04-acts/0.1", runId: s.runId, idempotencyKey: `ws03:L:${s.requestId}`, source: "mcp", state: "pending", newAttemptAllowed: false });
const stepOf = (j, key) => j.disk()?.plans?.[key]?.steps?.[0];

test("A1-A3 the save after an ok send throws; the same instance; the request planned again", async () => {
  const j = flaky(), t = three();
  const d = new Dispatch({ journal: j, act: t });
  const p = d.plan(actRequest());
  j.mode = "after";
  j.failWhen = (o) => o.plans[p.key]?.steps[0].state === "sent-requested";
  await assert.rejects(d.advance(p.key), /EIO/);
  let s = d.status(p.key);
  assert.deepEqual([s.steps[0].state, s.saved, t.sends.length], ["sent-requested", false, 1]);
  j.failWhen = () => false;
  s = await d.advance(p.key);
  assert.deepEqual([s.steps[0].state, s.saved, t.sends.length], ["sent-requested", false, 1], "A2: no send; not saved yet");
  const again = d.plan(actRequest());
  assert.deepEqual([again.ok, again.already], [true, undefined], "A3: saved before it is answered");
  assert.deepEqual(["saved" in d.status(p.key), stepOf(j, p.key).state, t.sends.length], [false, "sent-requested", 1]);
});

test("A4 another key's save covers the first", async () => {
  const j = flaky(), t = three();
  const d = new Dispatch({ journal: j, act: t });
  const p = d.plan(actRequest("a1"));
  j.failWhen = (o) => o.plans[p.key]?.steps[0].state === "sent-requested";
  await assert.rejects(d.advance(p.key), /ENOSPC/);
  assert.equal(stepOf(j, p.key).state, "sending", "the journal is a step behind");
  j.failWhen = () => false;
  d.plan(actRequest("a2"));
  assert.deepEqual(["saved" in d.status(p.key), stepOf(j, p.key).state, t.sends.length], [false, "sent-requested", 1]);
});

test("A5 a restart from a journal that still says sending", async () => {
  for (const registered of [true, false]) {
    const j = flaky(), t = three();
    const d = new Dispatch({ journal: j, act: t });
    const p = d.plan(actRequest());
    j.failWhen = (o) => o.plans[p.key]?.steps[0].state === "sent-requested";
    await assert.rejects(d.advance(p.key), /ENOSPC/);
    j.failWhen = () => false;
    const first = t.sends[0];
    const r = new Dispatch({ journal: j, act: t });
    assert.deepEqual([r.status(p.key).steps[0].state, "saved" in r.status(p.key)], ["sending", false], "a restart reads the journal's state");
    t.record = registered ? pending(p.steps[0]) : null;
    await r.advance(p.key);
    if (registered) assert.equal(t.sends.length, 1, "④ has the act: no send");
    else {
      assert.equal(t.sends.length, 2, "④ has no record: the existing read-before-send recovery calls ③ again");
      assert.deepEqual([t.sends[1].planId, t.sends[1].requestId, t.sends[1].runId], [first.planId, first.requestId, first.runId], "with the same planId, requestId and run id");
    }
    assert.notEqual(r.status(p.key).steps[0].state, "planned", "never back to planned");
  }
});

test("A6 a send with no known answer, then a save that throws", async () => {
  const j = flaky(), t = three();
  const d = new Dispatch({ journal: j, act: t });
  const p = d.plan(actRequest());
  t.sendAnswer = () => { throw Object.assign(new Error("RelayUnreachable"), { code: "RelayUnreachable" }); };
  j.failWhen = (o) => typeof o.plans[p.key]?.steps[0].lastError === "string";
  await assert.rejects(d.advance(p.key), /ENOSPC/);
  const s = d.status(p.key);
  assert.deepEqual([s.steps[0].state, s.saved, t.sends.length], ["sending", false, 1]);
  j.failWhen = () => false;
  t.record = pending(p.steps[0]);
  await d.advance(p.key);
  assert.deepEqual([t.sends.length, d.status(p.key).steps[0].state], [1, "sent-requested"], "④ read first; no second send");
});
