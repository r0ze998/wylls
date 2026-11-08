/**
 * The adapters of src/connect/ports.mjs, with stand-ins for ③'s tools and
 * ④'s client and binary (the real ones: test/connect-live.test.mjs). No key
 * is generated, imported, derived or used, and nothing is signed.
 */

import test from "node:test";
import assert from "node:assert/strict";

for (const k of ["generateKey", "importKey", "exportKey", "deriveKey", "deriveBits", "sign", "verify"]) {
  globalThis.crypto.subtle[k] = () => { throw new Error(`crypto.subtle.${k} called in a no-key test`); };
}

const { act3FromMcp, cargoForMcp, run4FromRunexec } = await import("../src/connect/ports.mjs");

test("③: cargo by S1 name, plan answers become re-plan, refusals are answers, the act is the requestId's", async () => {
  assert.deepEqual(cargoForMcp([0, 12, 0, 24, 3, 0, 0, 0]), { Wood: 12, Ore: 24, Arms: 3 });
  const calls = [];
  let answer = {};
  const port = act3FromMcp({ callTool: async (name, args) => { calls.push([name, args]); return answer[name]; } });
  answer = { prepare_caravan: { planId: "pl-1", expiresAt: "x" } };
  assert.deepEqual(await port.prepare({ from: "vault:2,-1,7", to: "vault:3,-1,4", cargo: [0, 1, 0, 2, 0, 0, 0, 0] }), { planId: "pl-1" });
  assert.deepEqual(calls[0], ["prepare_caravan", { from: "vault:2,-1,7", to: "vault:3,-1,4", cargo: { Wood: 1, Ore: 2 } }]);
  for (const code of ["PlanUnknown", "PlanUsed", "PlanExpired", "PlanStale"]) {
    answer = { send_caravan: { ok: false, error: { code, message: "m" } } };
    await assert.rejects(port.send({ planId: "pl-1", requestId: "ws06.abcdefgh", runId: "ws06:x" }), (e) => e.code === "PlanAgain" && e.was === code && !e.definitive);
  }
  answer = { send_caravan: { ok: false, error: { code: "IdempotencyConflict", message: "m" } } };
  await assert.rejects(port.send({ planId: "p", requestId: "r", runId: "x" }), (e) => e.definitive === true);
  answer = { send_caravan: { ok: false, error: { code: "RelayUnreachable", message: "m", retryable: true } } };
  await assert.rejects(port.send({ planId: "p", requestId: "r", runId: "x" }), (e) => !e.definitive, "a retryable failure is no answer");
  answer = { send_caravan: { state: "accepted", runId: "x" } };
  assert.equal((await port.send({ planId: "p", requestId: "r", runId: "x" })).ok, true);
  const act = (key, source = "mcp") => ({ receiptVersion: "p04-acts/0.1", runId: "x", idempotencyKey: key, source, state: "landed" });
  answer = { get_run_status: { runId: "x", registry: { read: true, acts: [act("ws03:L:other"), act("ws03:L:ws06.req1"), act("ai:ws06.req1", "ai")] } } };
  assert.equal((await port.status("x", "ws06.req1")).idempotencyKey, "ws03:L:ws06.req1", "③'s own act for the requestId, not another sender's");
  assert.equal(await port.status("x", "ws06.none"), null);
  answer = { get_run_status: { runId: "x", registry: { read: false, error: "StoreError" } } };
  await assert.rejects(port.status("x", "ws06.req1"), (e) => e.code === "RegistryUnreadable", "an unread registry is no answer");
  answer = { get_run_status: { runId: "x", registry: null } };
  await assert.rejects(port.status("x", "ws06.req1"));
});

test("④: refusals of run accept are answers; the view's NoRecord is null, an unreachable store is no answer", async () => {
  const refuse = (code) => ({ accept: async () => { throw Object.assign(new Error("m"), { code }); } });
  for (const code of ["NotAuthorized", "Conflict", "BadRequest"]) {
    await assert.rejects(run4FromRunexec({ runs: refuse(code), bin: "x", db: "y" }).accept({}, {}), (e) => e.definitive === true && e.code === code);
  }
  for (const code of ["StoreError", "Spawn"]) {
    await assert.rejects(run4FromRunexec({ runs: refuse(code), bin: "x", db: "y" }).accept({}, {}), (e) => !e.definitive);
  }
  const passed = [];
  const runs = { accept: async (spec, req) => { passed.push(req); return { accept: "Existing", view_version: "p04-run/0.1" }; } };
  const REQ = { actor: "a", generation: 0, citizen: "c", authenticatedBy: "upstream" };
  assert.equal((await run4FromRunexec({ runs, bin: "x", db: "y" }).accept({ run_id: "r" }, REQ)).result, "Existing");
  assert.equal(passed[0], REQ, "the requester object is handed on as given");
  const exec = (code, out) => (bin, args, o, cb) => cb(code ? Object.assign(new Error("exit"), { code }) : null, `${JSON.stringify(out)}\n`);
  assert.equal(await run4FromRunexec({ runs, bin: "x", db: "y", execFile: exec(3, { error: "NoRecord" }) }).view("r"), null);
  await assert.rejects(run4FromRunexec({ runs, bin: "x", db: "y", execFile: exec(5, { error: "StoreUnavailable", message: "no store" }) }).view("r"), (e) => e.code === "StoreUnavailable");
  assert.equal((await run4FromRunexec({ runs, bin: "x", db: "y", execFile: exec(0, { view_version: "p04-run/0.1", run_id: "r" }) }).view("r")).run_id, "r");
});
