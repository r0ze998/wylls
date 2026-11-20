/**
 * Written 2026-11-17 under an execution pause; run since on Node 20 and 22. Its import closure is dispatch-status-pin.test.mjs's (src/connect/dispatch.mjs → caravan.mjs →
 * plan.mjs → keys.mjs, which names a key API never reached here; src/connect/intake.mjs; cli/connect-fixture.mjs;
 * src/canonical.mjs): it is cleared by its entry in scripts/ci/node-key-reviewed.txt (ws06-next 2026-11-20), so the key-free job runs it.
 *
 * Dispatch.plan plans only the content its hashes name (dispatch.mjs hashProblem, 2026-11-17).
 *   H1 the fixture request (hashes computed from its content) is planned as before
 *   H2 an adopted plan hash with other content (another parameter, another place) is refused PLAN_HASH_MISMATCH:
 *      nothing is saved, no run id exists for it, no port is called
 *   H3 a definition whose env.hash is not its manifest's hash is refused DEFINITION_HASH_MISMATCH
 *   H4 content that cannot be hashed (a non-integer number) is refused SHAPE; a missing env is refused, not thrown
 *   H5 through intake: the adoption check passes for the adopted hash, and the other content is still refused
 *   H6 the act route is checked the same way (no prepare, no send)
 *   H7 the requester checks still come first on the run route (their codes unchanged)
 * Stand-ins only (an in-memory journal, ports that count). No key is generated, imported, derived or used; nothing is
 * signed, sent, spawned or fetched.
 */

import test from "node:test";
import assert from "node:assert/strict";

for (const k of ["generateKey", "importKey", "exportKey", "deriveKey", "deriveBits", "sign", "verify"]) {
  globalThis.crypto.subtle[k] = () => { throw new Error(`crypto.subtle.${k} called in a no-key test`); };
}

const { Dispatch } = await import("../src/connect/dispatch.mjs");
const { intake } = await import("../src/connect/intake.mjs");
const { relayRequest } = await import("../cli/connect-fixture.mjs");
const { contentHash } = await import("../src/canonical.mjs");

const REQ = { actor: "1".repeat(31) + "A", generation: 1, citizen: "1".repeat(31) + "C", authenticatedBy: "test: the gateway's credential layer (stand-in)" };
function memJournal() {
  let saved = null, saves = 0;
  return { load: () => (saved ? JSON.parse(JSON.stringify(saved)) : null), save: (o) => { saves++; saved = JSON.parse(JSON.stringify(o)); }, saves: () => saves, disk: () => saved };
}
const counting = () => {
  const calls = [];
  return { calls, port: new Proxy({}, { get: (_, name) => async () => { calls.push(name); throw new Error("not reached"); } }) };
};
const run = (r) => ({ route: "run", ...r, requester: REQ });
/** The adopted request with its plan's bindings changed, its planHash kept. */
const tampered = (r, params) => ({ ...r, plan: { ...r.plan, bindings: { ...r.plan.bindings, params: { ...r.plan.bindings.params, ...params } } } });

test("H1 consistent content is planned", () => {
  const d = new Dispatch({ journal: memJournal(), run4: counting().port });
  const r = relayRequest();
  assert.equal(r.planHash, contentHash(r.plan));
  assert.equal(d.plan(run(r)).ok, true);
});

test("H2 an adopted hash with other content", () => {
  for (const params of [{ wood: 9 }, { end: "village:2,2,1" }]) {
    const j = memJournal(), four = counting();
    const d = new Dispatch({ journal: j, run4: four.port });
    const r = tampered(relayRequest(), params);
    const p = d.plan(run(r));
    assert.deepEqual([p.ok, p.findings?.[0]?.code], [false, "PLAN_HASH_MISMATCH"], JSON.stringify(params));
    assert.equal(p.steps, undefined, "no run ids");
    assert.deepEqual([j.saves(), j.disk(), four.calls], [0, null, []], "nothing saved, nothing called");
  }
});

test("H3 a definition hash that is not its manifest's", () => {
  const r = relayRequest();
  const env = { ...r.env, manifest: { ...r.env.manifest, title: "edited after its hash" } };
  const d = new Dispatch({ journal: memJournal(), run4: counting().port });
  assert.equal(d.plan(run({ ...r, env })).findings?.[0]?.code, "DEFINITION_HASH_MISMATCH");
});

test("H4 content that cannot be hashed; a missing env", () => {
  const d = new Dispatch({ journal: memJournal(), run4: counting().port });
  const r = relayRequest();
  assert.equal(d.plan(run(tampered(r, { wood: 2.5 }))).findings?.[0]?.code, "SHAPE");
  const none = d.plan(run({ ...r, env: undefined }));
  assert.equal(none.ok, false);
  assert.ok(["DEFINITION_HASH_MISMATCH", "SHAPE"].includes(none.findings?.[0]?.code), JSON.stringify(none));
});

test("H5 through intake: the adopted hash passes adoption, the content is still refused", () => {
  const r = relayRequest();
  const asked = [];
  const d = new Dispatch({ journal: memJournal(), run4: counting().port });
  const out = intake({ dispatch: d, route: "run", adoption: (h) => { asked.push(h); return h === r.planHash ? null : "NOT_ADOPTED"; }, binding: () => null, request: { ...tampered(r, { wood: 9 }), requester: REQ } });
  assert.deepEqual(asked, [r.planHash]);
  assert.equal(out.findings?.[0]?.code, "PLAN_HASH_MISMATCH");
});

test("H6 the act route", () => {
  const r = relayRequest();
  const three = counting();
  const d = new Dispatch({ journal: memJournal(), act: three.port });
  const p = d.plan({ route: "act", ...tampered(r, { wood: 9 }), view: { citizenTag: "41", places: [] } });
  assert.deepEqual([p.ok, p.findings?.[0]?.code, three.calls], [false, "PLAN_HASH_MISMATCH", []]);
});

test("H7 requester checks first", () => {
  const d = new Dispatch({ journal: memJournal(), run4: counting().port });
  const r = tampered(relayRequest(), { wood: 9 });
  assert.equal(d.plan({ route: "run", ...r }).findings?.[0]?.code, "NoAuthenticatedRequester");
  assert.equal(d.plan({ route: "run", ...r, requester: { ...REQ, actor: "not base58 0OIl" } }).findings?.[0]?.code, "REQUESTER");
});
