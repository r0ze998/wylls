/**
 * WRITTEN, NOT RUN (2026-11-17, under an execution pause): no part of this file has been executed. Run it only with
 * its own approval, through the repository's key-free guard.
 *
 * intake() plans exactly the route it checked (src/connect/intake.mjs, 2026-11-17): a `route` inside `request` never
 * replaces it.
 *   I1 outer "act" with request.route "run": dispatch gets "act"; binding is not consulted (as for any act)
 *   I2 outer "run" with request.route "act": dispatch gets "run", after the requester and binding checks
 *   I3 normal run and act intakes pass the request's own fields through unchanged
 *   I4 every refusal (no requester, no binding, adoption problem, NOT_BOUND, unknown route) reaches no dispatch
 *   I5 the source spreads the request first and the checked route last
 * KEY-FREE: imports node:test, node:assert/strict, node:fs and ../src/connect/intake.mjs, which imports nothing. The
 * dispatch is a stub that records what it is given; nothing is planned, sent, spawned or fetched.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { intake } from "../src/connect/intake.mjs";

const stub = () => { const calls = []; return { calls, plan: (x) => { calls.push(x); return { ok: true, key: "k" }; } }; };
const REQ = { actor: "a", generation: 0, citizen: "c", authenticatedBy: "upstream" };
const base = { plan: { id: "p" }, planHash: "h", env: {}, nonce: "n1" };

test("I1 an act intake stays an act", () => {
  const d = stub();
  let bound = 0;
  const r = intake({ dispatch: d, route: "act", adoption: () => null, binding: () => { bound++; return null; }, request: { ...base, route: "run", requester: REQ } });
  assert.equal(r.ok, true);
  assert.equal(d.calls.length, 1);
  assert.equal(d.calls[0].route, "act", "request.route did not replace the checked route");
  assert.equal(bound, 0, "binding is consulted for runs only");
});

test("I2 a run intake stays a run, after its checks", () => {
  const d = stub();
  let bound = 0;
  intake({ dispatch: d, route: "run", adoption: () => null, binding: () => { bound++; return null; }, request: { ...base, route: "act", requester: REQ } });
  assert.deepEqual([d.calls.length, d.calls[0].route, bound], [1, "run", 1]);
  const none = stub();
  const r = intake({ dispatch: none, route: "run", adoption: () => null, binding: () => null, request: { ...base, route: "act" } });
  assert.equal(r.findings[0].code, "NoAuthenticatedRequester", "the run's requester check is not skipped by request.route");
  assert.equal(none.calls.length, 0);
});

test("I3 normal intakes pass the request through", () => {
  const d = stub();
  intake({ dispatch: d, route: "run", adoption: () => null, binding: () => null, request: { ...base, requester: REQ, extra: 1 } });
  intake({ dispatch: d, route: "act", adoption: () => null, binding: () => null, request: { ...base, extra: 2 } });
  assert.deepEqual(d.calls[0], { ...base, requester: REQ, extra: 1, route: "run" });
  assert.deepEqual(d.calls[1], { ...base, extra: 2, route: "act" });
});

test("I4 a refusal reaches no dispatch", () => {
  const cases = [
    [{ route: "run", adoption: () => null, binding: () => null, request: { ...base } }, "NoAuthenticatedRequester"],
    [{ route: "run", adoption: () => null, request: { ...base, requester: REQ } }, "BINDING_UNDECIDED"],
    [{ route: "act", adoption: () => "PLAN_ENDED", binding: () => null, request: { ...base } }, "PLAN_ENDED"],
    [{ route: "run", adoption: () => null, binding: () => "not this user's", request: { ...base, requester: REQ } }, "NOT_BOUND"],
    [{ route: "other", adoption: () => null, binding: () => null, request: { ...base, route: "act" } }, "SHAPE"],
  ];
  for (const [args, code] of cases) {
    const d = stub();
    const r = intake({ dispatch: d, ...args });
    assert.deepEqual([r.ok, r.findings[0].code, d.calls.length], [false, code, 0], code);
  }
});

test("I5 the source: request first, the checked route last", () => {
  const src = readFileSync(new URL("../src/connect/intake.mjs", import.meta.url), "utf8");
  assert.match(src, /return dispatch\.plan\(\{ \.\.\.request, route \}\);/);
  assert.doesNotMatch(src, /dispatch\.plan\(\{ route, \.\.\.request \}\)/);
});
