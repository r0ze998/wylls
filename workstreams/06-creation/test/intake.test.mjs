/**
 * The gateway-facing entry (src/connect/intake.mjs). No key is generated,
 * imported, derived or used, and nothing is signed. ③/⑤'s route that would
 * call it does not exist yet; its inputs are stand-ins here.
 */

import test from "node:test";
import assert from "node:assert/strict";

for (const k of ["generateKey", "importKey", "exportKey", "deriveKey", "deriveBits", "sign", "verify"]) {
  globalThis.crypto.subtle[k] = () => { throw new Error(`crypto.subtle.${k} called in a no-key test`); };
}

const { intake, status } = await import("../src/connect/intake.mjs");
const { Dispatch } = await import("../src/connect/dispatch.mjs");
const { relayRequest } = await import("../cli/connect-fixture.mjs");

const REQ = { actor: "1".repeat(31) + "A", generation: 1, citizen: "1".repeat(31) + "C", authenticatedBy: "test: the gateway's credential layer (stand-in)" };
const mem = () => { let s = null; return { load: () => s, save: (o) => { s = JSON.parse(JSON.stringify(o)); } }; };
const counting = () => {
  const calls = [];
  const port = new Proxy({}, { get: (_, name) => async (...a) => { calls.push(name); throw new Error("not reached"); } });
  return { calls, port };
};

test("no binding decided: nothing is planned; an adoption that is not active is refused", () => {
  const d = new Dispatch({ journal: mem(), run4: counting().port });
  // no authenticated requester (as today: no route makes one): closed first, whatever else is given
  for (const requester of [undefined, null]) {
    assert.equal(intake({ dispatch: d, route: "run", adoption: () => null, binding: () => null, request: { ...relayRequest(), requester } }).findings[0].code, "NoAuthenticatedRequester");
  }
  const request = { ...relayRequest(), requester: REQ };
  assert.equal(intake({ dispatch: d, route: "run", adoption: () => null, request }).findings[0].code, "BINDING_UNDECIDED");
  assert.equal(intake({ dispatch: d, route: "run", adoption: () => "PLAN_ENDED", binding: () => null, request }).findings[0].code, "PLAN_ENDED");
  assert.equal(intake({ dispatch: d, route: "run", adoption: () => null, binding: () => "the requester does not act for this plan's user", request }).findings[0].code, "NOT_BOUND");
});

test("with a binding supplied by the caller: planned with the requester as it came; status reads the journal only", async () => {
  const four = counting();
  const d = new Dispatch({ journal: mem(), run4: four.port });
  const request = { ...relayRequest(), requester: REQ };
  const p = intake({ dispatch: d, route: "run", adoption: () => null, binding: () => null, request });
  assert.equal(p.ok, true, JSON.stringify(p.findings));
  assert.equal(p.steps.length, 2);
  const st = status(d, p.key);
  assert.equal(st.ok, true);
  assert.equal(st.complete, false);
  assert.deepEqual(four.calls, [], "planning and status call neither ④ nor ③");
  assert.deepEqual(d.data.plans[p.key].requester, REQ, "kept as the gateway handed it over");
  // a requester the caller did not authenticate fully is still refused by the dispatcher
  const bad = intake({ dispatch: new Dispatch({ journal: mem() }), route: "run", adoption: () => null, binding: () => null, request: { ...request, requester: { ...REQ, authenticatedBy: "" } } });
  assert.equal(bad.findings[0].code, "REQUESTER");
});
