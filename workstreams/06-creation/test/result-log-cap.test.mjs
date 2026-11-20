/**
 * Written 2026-11-17 under an execution pause; run since on Node 20 and 22. Its import closure is connect.test.mjs's (src/connect/caravan.mjs → plan.mjs → keys.mjs, which
 * names a key API never reached here): it is cleared by its entry in scripts/ci/node-key-reviewed.txt (ws06-next 2026-11-20), so the key-free job runs it.
 *
 * resultOf's upper bound when a record sits at the program's cap (cargo_log saturates at u32 = 4294967295,
 * permutation-frontier/src/proc/caravan.rs; ④ QUANTITY-CONTRACT §1):
 *   Q1 below the cap (4294967294 included): Recorded and RuleDerived say "lower + 1（資源ごと）" as before
 *   Q2 a delivered amount at the cap: the upper bound is not known (below null); lower, counted and evidence as before
 *   Q3 Unverifiable below the cap: logged + 1 per resource as before; at the cap (one resource or several): null
 *   Q4 KnownZero, NotShipped and an unfinished run are unchanged
 * Plain objects only. No key is generated, imported, derived or used; nothing is signed, sent, spawned or fetched.
 */

import test from "node:test";

for (const k of ["generateKey", "importKey", "exportKey", "deriveKey", "deriveBits", "sign", "verify"]) {
  globalThis.crypto.subtle[k] = () => { throw new Error(`crypto.subtle.${k} called in a no-key test`); };
}

import assert from "node:assert/strict";
import { resultOf } from "../src/connect/caravan.mjs";

const CAP = 4294967295;
const run = (state, outcome, extra = {}) => ({ run_id: "ws06:x:r1:ship", state, outcome, ...extra });
const res = (o = 0, w = 0) => [0, w, 0, o, 0, 0, 0, 0];

test("Q1 below the cap: lower + 1, as before", () => {
  for (const v of ["Recorded", "RuleDerived"]) {
    const r = resultOf(run("Fulfilled", { delivered: res(24, 12), verification: v, cargo_logged: res(24, 12), effects: [] }));
    assert.deepEqual([r.actual.kind, r.actual.lower, r.actual.below], ["at-least", { wood: 12, ore: 24 }, "lower + 1（資源ごと）"], v);
  }
  const edge = resultOf(run("Partial", { delivered: res(CAP - 1, 12), verification: "Recorded", cargo_logged: res(CAP - 1, 12), effects: [] }));
  assert.equal(edge.actual.below, "lower + 1（資源ごと）", "one under the cap is still a full reading");
});

test("Q2 at the cap: the upper bound is not known; the lower bound and the count stay", () => {
  for (const v of ["Recorded", "RuleDerived"]) {
    const r = resultOf(run("Fulfilled", { delivered: res(CAP, 12), verification: v, cargo_logged: res(CAP, 12), effects: [] }));
    assert.equal(r.actual.kind, "at-least", v);
    assert.deepEqual(r.actual.lower, { wood: 12, ore: CAP }, v);
    assert.equal(r.actual.below, null, `${v}: not "lower + 1"`);
    assert.deepEqual(r.counted, { wood: 12, ore: CAP }, v);
    assert.deepEqual(r.evidence, { usable: true, lowerBound: { wood: 12, ore: CAP } }, v);
  }
});

test("Q3 Unverifiable: logged + 1 below the cap, unknown at it", () => {
  const below = resultOf(run("DeliveredUnverified", { delivered: null, verification: "Unverifiable", cargo_logged: res(24, 12), effects: [] }));
  assert.deepEqual(below.actual.below, { food: 1, wood: 13, stone: 1, ore: 25, arms: 1, gold: 1, science: 1, influence: 1 }, "as connect.test.mjs pins it");
  for (const logged of [res(CAP, 12), res(CAP, CAP), [CAP, 0, 0, 0, 0, 0, 0, 0]]) {
    const r = resultOf(run("DeliveredUnverified", { delivered: null, verification: "Unverifiable", cargo_logged: logged, effects: [] }));
    assert.deepEqual([r.actual.kind, r.actual.below, r.counted, r.evidence.usable], ["unknown", null, {}, false], JSON.stringify(logged));
  }
});

test("Q4 zero, not shipped and unfinished: unchanged", () => {
  assert.equal(resultOf(run("Failed", { delivered: res(0, 0), verification: "KnownZero", cargo_logged: null, effects: [] })).actual.kind, "zero");
  assert.equal(resultOf(run("Failed", { delivered: null, verification: "NotShipped", cargo_logged: null, effects: [] })).actual.kind, "none");
  assert.equal(resultOf(run("Arrived", null)).actual.kind, "pending");
});
