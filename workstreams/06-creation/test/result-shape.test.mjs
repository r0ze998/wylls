/**
 * The shape of the quantity vectors 06 reads from ④'s runs (src/connect/caravan.mjs resultOf / resultOfRun4,
 * 2026-11-17). ④'s `Res` is `[u64; 8]` in whole units (④ src/model.rs; QUANTITY-CONTRACT §1): a vector that is not
 * one is refused as SHAPE, never thrown on, counted or taken as evidence. Legitimate ④ output (zeros, normal amounts,
 * the u32 cargo_log cap, u64 amounts above u32) reads as before.
 *
 * Pure: no key, no signature, no chain, no world, no runner. Dispatch is not imported or run; its source is read as
 * text to show where a SHAPE answer goes.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// No key is generated, imported, derived or used here: any such call fails the run. Installed before the module
// under test is loaded (dynamic import below), so nothing it loads can reach a key API unguarded.
for (const k of ["generateKey", "importKey", "exportKey", "deriveKey", "deriveBits", "sign", "verify", "wrapKey", "unwrapKey", "encrypt", "decrypt"]) {
  globalThis.crypto.subtle[k] = () => { throw new Error(`crypto.subtle.${k} called in a no-key test`); };
}

const { resultOf, resultOfRun4, CORE_RESOURCES } = await import("../src/connect/caravan.mjs");

const RUN_ID = "ws06:x:r1:ship";
const run = (state, outcome, extra = {}) => ({ run_id: RUN_ID, state, outcome, ...extra });
const view = (state, outcome, extra = {}) => ({ view_version: "p04-run/0.1", run_id: RUN_ID, state, outcome, held_reason: null, cancel_phase: null, ...extra });
const out = (delivered, verification, cargo_logged = null) => ({ delivered, verification, cargo_logged, effects: [], note: "" });
const LOG_MAX = 4294967295;
const vec = (...xs) => { const a = new Array(8).fill(0); xs.forEach((x, i) => { a[i] = x; }); return a; };

function sparse() {
  const a = new Array(8);
  for (const i of [0, 1, 2, 4, 5, 6, 7]) a[i] = 0; // slot 3 (ore) missing
  return a;
}

/** Malformed vectors: none of them is a `[u64; 8]`. */
const MALFORMED = {
  null: null,
  empty: [],
  short: [0, 0, 0, 0, 0, 0, 0],
  long: [0, 0, 0, 0, 0, 0, 0, 0, 0],
  sparse: sparse(),
  string: ["4", 0, 0, 0, 0, 0, 0, 0],
  negative: vec(0, -1),
  fraction: vec(0, 1.5),
  NaN: vec(0, NaN),
  Infinity: vec(0, Infinity),
  minusInfinity: vec(0, -Infinity),
  nullEntry: vec(0, null),
  boolean: vec(true),
  beyondU64: vec(0, 2 ** 64 + 4096), // the next double after the parsed u64::MAX (2^64)
  huge: vec(0, 1e100), // an integer double no u64 can be
  object: { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0, length: 8 },
  stringWhole: "00000000",
  number: 4,
};

const isShape = (r, field, why) => {
  assert.equal(r.ok, false, `${why}: refused`);
  assert.equal(r.code, "SHAPE", `${why}: SHAPE`);
  assert.equal(typeof r.detail, "string", `${why}: a detail`);
  assert.ok(r.detail.startsWith(`outcome.${field}:`), `${why}: names ${field} (${r.detail})`);
  assert.equal(r.evidence, undefined, `${why}: no evidence`);
  assert.equal(r.counted, undefined, `${why}: nothing counted`);
};

test("the producer's shape: 8 resources, the core's order", () => {
  assert.equal(CORE_RESOURCES.length, 8, "④ Res = [u64; RESOURCES], RESOURCES = 8");
});

test("a malformed delivered vector of a terminal Recorded/RuleDerived run is SHAPE, never a throw or evidence (resultOf and resultOfRun4)", () => {
  for (const [name, bad] of Object.entries(MALFORMED)) {
    for (const state of ["Fulfilled", "Partial", "DeliveredUnverified", "Failed"]) {
      for (const v of ["Recorded", "RuleDerived"]) {
        const why = `${state}/${v} delivered ${name}`;
        let a, b, c;
        assert.doesNotThrow(() => { a = resultOf(run(state, out(bad, v, vec(4)))); }, why);
        isShape(a, "delivered", why);
        assert.doesNotThrow(() => { b = resultOfRun4(view(state, out(bad, v, vec(4)))); }, `${why} (run view)`);
        isShape(b, "delivered", `${why} (run view)`);
        // ④'s view may carry the outcome under detail only
        assert.doesNotThrow(() => { c = resultOfRun4(view(state, undefined, { detail: { outcome: out(bad, v, vec(4)) } })); }, `${why} (detail.outcome)`);
        isShape(c, "delivered", `${why} (detail.outcome)`);
      }
    }
  }
});

test("the three reproduced cases: null throws no more, [] is no evidence, \"4\" is not food", () => {
  const n = resultOf(run("Fulfilled", out(null, "Recorded")));
  assert.equal(n.code, "SHAPE");
  const e = resultOf(run("Fulfilled", out([], "Recorded")));
  assert.equal(e.ok, false);
  assert.notEqual(e.evidence?.usable, true);
  const s = resultOfRun4(view("Fulfilled", out(["4", 0, 0, 0, 0, 0, 0, 0], "Recorded")));
  assert.equal(s.ok, false);
  assert.equal(s.counted, undefined);
  assert.match(s.detail, /entry 0 \(food\)/);
});

test("integers beyond u64 are refused by name; the parsed u64::MAX is not", () => {
  for (const big of [2 ** 64 + 4096, 1e100, Number.MAX_VALUE]) {
    for (const r of [resultOf(run("Fulfilled", out(vec(0, big), "Recorded"))), resultOfRun4(view("Fulfilled", out(vec(0, big), "Recorded")))]) {
      assert.equal(r.code, "SHAPE", String(big));
      assert.match(r.detail, /^outcome\.delivered: entry 1 \(wood\) is beyond u64/);
    }
    const u = resultOf(run("DeliveredUnverified", out(null, "Unverifiable", vec(0, big))));
    assert.equal(u.code, "SHAPE");
    assert.match(u.detail, /^outcome\.cargo_logged: entry 1 \(wood\) is beyond u64/);
  }
  const ok = resultOfRun4(view("Fulfilled", out(vec(0, JSON.parse("18446744073709551615")), "Recorded")));
  assert.equal(ok.ok, true);
});

test("a malformed non-null cargo_logged of a terminal outcome read as unknown is SHAPE; null or absent stays no upper bound", () => {
  for (const [name, bad] of Object.entries(MALFORMED)) {
    if (bad === null) continue; // null is ④'s "no record cargo", below
    for (const [state, v] of [["DeliveredUnverified", "Unverifiable"], ["Failed", "Unverifiable"], ["DeliveredUnverified", null]]) {
      const why = `${state}/${v} cargo_logged ${name}`;
      let a, b;
      assert.doesNotThrow(() => { a = resultOf(run(state, out(null, v, bad))); }, why);
      isShape(a, "cargo_logged", why);
      assert.doesNotThrow(() => { b = resultOfRun4(view(state, out(null, v, bad))); }, `${why} (run view)`);
      isShape(b, "cargo_logged", `${why} (run view)`);
    }
  }
  for (const r of [resultOf(run("DeliveredUnverified", out(null, "Unverifiable", null))), resultOfRun4(view("DeliveredUnverified", out(null, "Unverifiable", null)))]) {
    assert.equal(r.ok, true);
    assert.equal(r.actual.kind, "unknown");
    assert.equal(r.actual.below, null, "no record cargo: no upper bound, not 0");
    assert.deepEqual(r.counted, {});
    assert.equal(r.evidence.usable, false);
  }
  const absent = { delivered: null, verification: "Unverifiable", effects: [] };
  const r = resultOf(run("DeliveredUnverified", absent));
  assert.equal(r.ok, true);
  assert.equal(r.actual.below, null);
});

test("legitimate ④ vectors read as before: zeros, normal amounts, the u32 cap, u64 above u32", () => {
  // zeros: a fraction below one unit arrived (QUANTITY-CONTRACT §3, b = 0 is not 0)
  for (const r of [resultOf(run("Partial", out(vec(), "RuleDerived", vec()))), resultOfRun4(view("Partial", out(vec(), "RuleDerived", vec())))]) {
    assert.equal(r.ok, true);
    assert.deepEqual(r.counted, {});
    assert.equal(r.actual.kind, "at-least");
    assert.deepEqual(r.actual.lower, {});
    assert.equal(r.actual.below, "lower + 1（資源ごと）");
    assert.equal(r.evidence.usable, true);
  }
  // normal
  const normal = vec(0, 12, 0, 24);
  for (const r of [resultOf(run("Fulfilled", out(normal, "Recorded", normal))), resultOfRun4(view("Fulfilled", out(normal, "Recorded", normal)))]) {
    assert.equal(r.ok, true);
    assert.deepEqual(r.counted, { wood: 12, ore: 24 });
    assert.deepEqual(r.evidence, { usable: true, lowerBound: { wood: 12, ore: 24 } });
    assert.equal(r.actual.below, "lower + 1（資源ごと）");
  }
  // at the cargo_log cap: lower kept, upper not known
  const cap = vec(0, LOG_MAX);
  const atCap = resultOfRun4(view("Fulfilled", out(cap, "RuleDerived", cap)));
  assert.equal(atCap.ok, true);
  assert.deepEqual(atCap.counted, { wood: LOG_MAX });
  assert.equal(atCap.actual.below, null);
  // u64 above u32 (④ Res is [u64; 8]); 2^64-1 as JSON.parse reads it (rounded to a double, still an integer)
  const u64max = JSON.parse("18446744073709551615");
  // the boundary: u64::MAX parses to exactly 2^64 (the same double as Number(0xffffffffffffffffn)); a parsed 2^64 is
  // the same value and cannot be told apart from it here
  assert.equal(u64max, 2 ** 64);
  assert.equal(u64max, Number(0xffffffffffffffffn));
  assert.notEqual(2 ** 64 + 4096, u64max, "the next double is distinct (refused above)");
  assert.ok(Number.isInteger(1e100), "1e100 passes an integer test alone; the u64 bound refuses it");
  for (const big of [LOG_MAX + 1, 2 ** 53, 2 ** 53 + 2, 2 ** 64 - 4096, u64max]) {
    const d = vec(0, big);
    for (const r of [resultOf(run("Fulfilled", out(d, "Recorded", d))), resultOfRun4(view("Fulfilled", out(d, "Recorded", d)))]) {
      assert.equal(r.ok, true, `${big} is ④'s own output`);
      assert.deepEqual(r.counted, { wood: big });
      assert.equal(r.actual.below, null, "at or above the cap: no upper bound");
    }
    const u = resultOf(run("DeliveredUnverified", out(null, "Unverifiable", d)));
    assert.equal(u.ok, true);
    assert.equal(u.actual.below, null);
  }
  // an unknown amount with a normal logged cargo: below logged + 1, as before
  const u = resultOf(run("DeliveredUnverified", out(null, "Unverifiable", normal)));
  assert.deepEqual(u.actual.below, { food: 1, wood: 13, stone: 1, ore: 25, arms: 1, gold: 1, science: 1, influence: 1 });
  const uc = resultOf(run("DeliveredUnverified", out(null, "Unverifiable", cap)));
  assert.equal(uc.actual.below, null);
});

test("KnownZero, NotShipped, non-terminal and absent outcomes read as before; nothing absent becomes success", () => {
  const zero = resultOf(run("Failed", out(vec(), "KnownZero", null)));
  assert.equal(zero.ok, true);
  assert.equal(zero.actual.kind, "zero");
  assert.deepEqual(zero.counted, {});
  assert.equal(zero.evidence.usable, false);

  const none = resultOfRun4(view("Cancelled", out(null, "NotShipped", null), { cancel_phase: { Completed: { effects: [] } } }));
  assert.equal(none.ok, true);
  assert.equal(none.actual.kind, "none");
  assert.equal(none.evidence.usable, false);

  // not terminal: the outcome is not read for amounts (unchanged), whatever it holds
  for (const d of [null, [], ["4", 0, 0, 0, 0, 0, 0, 0]]) {
    const r = resultOfRun4(view("InTransit", out(d, "Recorded", d)));
    assert.equal(r.ok, true);
    assert.equal(r.final, false);
    assert.equal(r.actual.kind, "pending");
    assert.deepEqual(r.counted, {});
    assert.equal(r.evidence.usable, false);
  }
  const held = resultOf(run("Arrived", null, { held_reason: "DestinationMismatch" }));
  assert.equal(held.ok, true);
  assert.equal(held.held, "DestinationMismatch");
  assert.equal(held.actual.kind, "pending");

  // a terminal Fulfilled without an outcome, or without a verification, is never evidence
  for (const o of [null, undefined, { delivered: vec(0, 4), cargo_logged: null, effects: [] }]) {
    const r = resultOfRun4(view("Fulfilled", o));
    assert.equal(r.ok, true);
    assert.deepEqual(r.counted, {});
    assert.equal(r.evidence.usable, false);
  }
  const unv = resultOf(run("Fulfilled", out(null, "Unverifiable", vec(0, 4))));
  assert.equal(unv.ok, true);
  assert.equal(unv.evidence.usable, false);

  // unchanged refusals
  assert.equal(resultOf(run("Teleported", null)).code, "SHAPE");
  assert.equal(resultOf(run("Fulfilled", { verification: "Guessed" })).code, "SHAPE");
  assert.equal(resultOfRun4({ ...view("Fulfilled", out(vec(0, 4), "Recorded")), view_version: "p04-run/9" }).code, "SHAPE");
});

test("Dispatch holds a SHAPE answer: the step stays unfinished, with the detail as lastError (source read as text, not run)", () => {
  const src = readFileSync(new URL("../src/connect/dispatch.mjs", import.meta.url), "utf8");
  const read = "const r = resultOfRun4(v);";
  const refuse = "if (!r.ok) { s.lastError = r.detail; this.#save(); return; }";
  const at = src.indexOf(read);
  assert.ok(at >= 0, "Dispatch reads ④'s view through resultOfRun4");
  assert.equal(src.indexOf(read, at + 1), -1, "once");
  const r = src.indexOf(refuse, at);
  assert.ok(r > at, "a refusal returns right after the read");
  assert.equal(src.slice(at + read.length, r).trim(), "", "nothing in between");
  // the result, the view and finality are written only after that return
  for (const w of ["s.view = v;", "s.result = r;", "s.final = r.final;"]) {
    const i = src.indexOf(w, at);
    assert.ok(i > r, `${w} only after a refusal returned`);
  }
  // completeness needs a Fulfilled result with usable evidence, which a refusal never stores
  assert.ok(src.includes('s.final && s.result?.state === "Fulfilled" && s.result.evidence?.usable'));
});
