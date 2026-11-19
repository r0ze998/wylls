/**
 * Dispatch (src/connect/dispatch.mjs): run ids fixed from the plan, the
 * journal written before every outside call, lost answers and restarts.
 *
 * ④ and ③ are fakes here with the behaviour of the delivered code
 * (④ cf517b55 main.rs `run accept`, ③ 84f710d5 server.mjs send_caravan):
 * ④ answers Created / Existing for one run id and spec, Conflict for another
 * spec, NotAuthorized when the requester is not the pass's holder; ③
 * answers a requestId it already took with that operation before it looks
 * at the plan (another plan or run: IdempotencyConflict), and a gone plan
 * only when it sent nothing. A fake can apply a call and lose its answer. A
 * restart is a new Dispatch on the saved journal. test/connect-live.test.mjs
 * runs the real ④ binary and checks ③'s rules in its source.
 *
 * No key is generated, imported, derived or used, and nothing is signed.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const k of ["generateKey", "importKey", "exportKey", "deriveKey", "deriveBits", "sign", "verify"]) {
  globalThis.crypto.subtle[k] = () => { throw new Error(`crypto.subtle.${k} called in a no-key test`); };
}

const { Dispatch, fileJournal, processStart } = await import("../src/connect/dispatch.mjs");
const { contentHash } = await import("../src/canonical.mjs");
const { relayRequest } = await import("../cli/connect-fixture.mjs");
const { mineDelivery } = await import("../src/scenario.mjs");

const lost = () => { const e = new Error("no answer (timeout)"); e.code = "LOST"; return e; };
// the requester as the gateway's credential layer hands it over (public addresses; nothing here authenticates)
const REQ = { actor: "1".repeat(31) + "A", generation: 1, citizen: "1".repeat(31) + "C", authenticatedBy: "test: the gateway's credential layer (stand-in)" };

function memJournal() {
  let saved = null;
  let writes = 0;
  return { load: () => (saved ? JSON.parse(saved) : null), save: (o) => { saved = JSON.stringify(o); writes++; }, get writes() { return writes; } };
}

/** ④'s run store, faked: idempotent accept by run id and spec, views scripted per run. */
function fake4() {
  const runs = new Map();
  const f = {
    runs, accepts: 0, created: 0, loseAccept: 0, failView: 0, requesters: [], refuse: null,
    async accept(spec, requester) {
      f.accepts++;
      f.requesters.push(requester);
      if (f.refuse) throw Object.assign(new Error("refused"), { code: f.refuse, definitive: true });
      const d = contentHash(spec);
      let result;
      const had = runs.get(spec.run_id);
      if (!had) { runs.set(spec.run_id, { spec, digest: d, state: "Accepted", detail: { ship_seq: null, outcome: null } }); f.created++; result = "Created"; }
      else if (had.digest === d) result = "Existing";
      else throw Object.assign(new Error("another spec under this run id"), { code: "Conflict", definitive: true });
      if (f.loseAccept > 0) { f.loseAccept--; throw lost(); }
      return { result };
    },
    async view(runId) {
      if (f.failView > 0) { f.failView--; throw new Error("could not ask"); }
      const r = runs.get(runId);
      if (!r) return null;
      // ④'s run view keys (src/view.rs)
      return { view_version: "p04-run/0.1", run_id: runId, state: r.state, terminal: ["Fulfilled", "Partial", "DeliveredUnverified", "Failed", "Cancelled", "Expired"].includes(r.state), held_reason: r.held ?? null, cancel_phase: null, detail: r.detail, outcome: r.detail.outcome ?? null, spec: r.spec, receipts: [] };
    },
    /** what ④'s executor would have done to a run */
    set(runId, state, detail = {}) { const r = runs.get(runId); r.state = state; Object.assign(r.detail, detail); },
  };
  return f;
}

const delivered = (wood) => ({ outcome: { delivered: [0, wood, 0, 0, 0, 0, 0, 0], verification: "Recorded", cargo_logged: [0, wood, 0, 0, 0, 0, 0, 0], effects: [], note: "" } });

test("run route: ids fixed in the journal before any call; a lost accept answer and a restart accept once", async () => {
  const j = memJournal();
  const four = fake4();
  let d = new Dispatch({ journal: j, run4: four });
  const req = relayRequest();
  const p = d.plan({ route: "run", ...req, requester: REQ });
  assert.equal(p.ok, true, JSON.stringify(p.findings));
  assert.equal(four.accepts, 0, "planning calls nobody");
  assert.equal(JSON.parse(JSON.stringify(j.load())).plans[p.key].steps[0].state, "planned");
  // the same request again: the same ids; other content under the same key: refused
  assert.deepEqual(d.plan({ route: "run", ...req, requester: REQ }).steps.map((s) => s.runId), p.steps.map((s) => s.runId));
  assert.equal(d.plan({ route: "run", ...req, requester: REQ, budget: { ...req.budget, max_fee: 1 } }).findings[0].code, "CONFLICT");

  four.loseAccept = 1; // ④ stores the run, the answer is lost
  let st = await d.advance(p.key);
  assert.equal(st.steps[0].state, "accepting");
  assert.equal(four.created, 1);
  // restart: a new process on the saved journal
  d = new Dispatch({ journal: j, run4: four });
  st = await d.advance(p.key);
  assert.equal(st.steps[0].state, "accepted", "found by its run id, not accepted again");
  assert.equal(four.created, 1);
  assert.equal(four.accepts, 1, "the second pass looked first and did not repeat the accept");
  assert.equal(four.runs.size, 1, "the second step waits: it is not accepted before the first is on the road");
  assert.ok(four.requesters.every((r) => JSON.stringify(r) === JSON.stringify(REQ)), "④ got the upstream requester unchanged");
  // no requester, or one 06 would have to complete: not planned
  for (const none of [undefined, null]) {
    assert.equal(new Dispatch({ journal: memJournal(), run4: four }).plan({ route: "run", ...relayRequest(), requester: none }).findings[0].code, "NoAuthenticatedRequester");
  }
  for (const bad of [{ ...REQ, authenticatedBy: "" }, { ...REQ, authenticatedBy: undefined }, { ...REQ, extra: 1 }, { ...REQ, actor: "x" }]) {
    assert.equal(new Dispatch({ journal: memJournal(), run4: four }).plan({ route: "run", ...relayRequest(), requester: bad }).findings[0].code, "REQUESTER");
  }
});

test("run route: the second step binds the first caravan once and keeps it across a restart; completion only from verified arrivals", async () => {
  const j = memJournal();
  const four = fake4();
  let d = new Dispatch({ journal: j, run4: four });
  const p = d.plan({ route: "run", ...relayRequest(), requester: REQ });
  await d.advance(p.key);
  const [haul, fwd] = p.steps.map((s) => s.runId);
  four.set(haul, "InTransit", { ship_seq: 7 });
  let st = await d.advance(p.key);
  assert.deepEqual(four.runs.get(fwd).spec.inbound, { owner: 119, seq: 7 }, "④ got the spec with the first caravan as inbound");
  // restart, and ④ now (wrongly or not) shows another seq: the bound spec is not changed
  d = new Dispatch({ journal: j, run4: four });
  four.set(haul, "InTransit", { ship_seq: 9 });
  st = await d.advance(p.key);
  assert.equal(four.runs.size, 2);
  assert.equal(four.created, 2);
  assert.deepEqual(four.runs.get(fwd).spec.inbound, { owner: 119, seq: 7 });
  // arrival of the first, the second unverified: not complete
  four.set(haul, "Fulfilled", delivered(4));
  four.set(fwd, "DeliveredUnverified", { outcome: { delivered: null, verification: "Unverifiable", cargo_logged: [0, 4, 0, 0, 0, 0, 0, 0], effects: [], note: "" } });
  st = await d.advance(p.key);
  assert.equal(st.complete, false, "an unverified arrival is not completion");
  assert.equal(st.steps[1].result.actual.kind, "unknown");
  // a fresh plan where both arrive verified in full: complete
  const j2 = memJournal(), f2 = fake4();
  const d2 = new Dispatch({ journal: j2, run4: f2 });
  const p2 = d2.plan({ route: "run", ...relayRequest(), requester: REQ, nonce: "r2" });
  await d2.advance(p2.key);
  const [h2, w2] = p2.steps.map((s) => s.runId);
  f2.set(h2, "InTransit", { ship_seq: 1 });
  await d2.advance(p2.key);
  assert.equal((await d2.advance(p2.key)).complete, false, "in transit is not complete");
  f2.set(h2, "Fulfilled", delivered(4));
  f2.set(w2, "Fulfilled", delivered(4));
  assert.equal((await d2.advance(p2.key)).complete, true);
});

test("run route: Conflict and a missing record are held, never answered with a new run id; a lost view changes nothing", async () => {
  const j = memJournal();
  const four = fake4();
  const d = new Dispatch({ journal: j, run4: four });
  const p = d.plan({ route: "run", ...relayRequest(), requester: REQ });
  // someone else's spec already sits under the first run id at ④
  const first = p.steps[0];
  four.runs.set(first.runId, { spec: { ...first.spec, ship: { ...first.spec.ship, cargo: [0, 9, 0, 0, 0, 0, 0, 0] } }, digest: "other", state: "Accepted", detail: {} });
  let st = await d.advance(p.key);
  assert.equal(st.steps[0].state, "held", "④ answered Conflict: held");
  assert.equal(st.steps[0].runId, first.runId, "no new run id");
  assert.equal(four.created, 0);
  // a plan whose run is unknown to ④ after acceptance
  const j3 = memJournal(), f3 = fake4();
  const d3 = new Dispatch({ journal: j3, run4: f3 });
  const p3 = d3.plan({ route: "run", ...relayRequest(), requester: REQ, nonce: "r3" });
  await d3.advance(p3.key);
  f3.runs.delete(p3.steps[0].runId);
  st = await d3.advance(p3.key);
  assert.equal(st.steps[0].state, "held");
  assert.equal(st.held, true);
  // Conflict on a fresh accept
  const j4 = memJournal(), f4 = fake4();
  const d4 = new Dispatch({ journal: j4, run4: f4 });
  const p4 = d4.plan({ route: "run", ...relayRequest(), requester: REQ, nonce: "r4" });
  f4.view = async () => null;
  f4.runs.set(p4.steps[0].runId, { spec: {}, digest: "other", state: "Accepted", detail: {} });
  st = await d4.advance(p4.key);
  assert.equal(st.steps[0].state, "held");
  assert.equal(st.steps[0].runId, p4.steps[0].runId, "the run id did not change");
  // the requester is not the pass's holder (④ NotAuthorized, exit 5): held, nothing retried
  const j6 = memJournal(), f6 = fake4();
  const d6 = new Dispatch({ journal: j6, run4: f6 });
  const p6 = d6.plan({ route: "run", ...relayRequest(), requester: REQ, nonce: "r6" });
  f6.refuse = "NotAuthorized";
  st = await d6.advance(p6.key);
  assert.equal(st.steps[0].state, "held");
  assert.match(st.steps[0].why, /NotAuthorized/);
  await d6.advance(p6.key);
  assert.equal(f6.accepts, 1, "a refusal is not retried");
  // a view that cannot be read leaves the step as it was
  const j5 = memJournal(), f5 = fake4();
  const d5 = new Dispatch({ journal: j5, run4: f5 });
  const p5 = d5.plan({ route: "run", ...relayRequest(), requester: REQ, nonce: "r5" });
  await d5.advance(p5.key);
  f5.failView = 1;
  st = await d5.advance(p5.key);
  assert.equal(st.steps[0].state, "accepted");
  assert.equal(f5.accepts, 1);
});

// ③ faked: one requestId is sent once; ④'s act registry read by run id
function fakeAct() {
  const f = {
    sends: 0, prepares: 0, ops: new Map(), plans: new Map(), loseSend: 0, receipts: new Map(),
    async prepare(args) { f.prepares++; const planId = `plan-${f.prepares}`; f.plans.set(planId, { args, live: true }); return { planId }; },
    async send({ planId, requestId, runId }) {
      const prior = f.ops.get(requestId);
      if (prior) {
        if (prior.planId !== planId || prior.runId !== runId) throw Object.assign(new Error("another plan or run"), { code: "IdempotencyConflict", definitive: true });
      } else {
        const pl = f.plans.get(planId);
        if (!pl?.live) throw Object.assign(new Error("plan gone"), { code: "PlanAgain" });
        pl.live = false;
        f.ops.set(requestId, { planId, runId }); f.sends++;
        f.receipts.set(requestId, { receiptVersion: "p04-acts/0.1", runId, state: "registered", newAttemptAllowed: false });
      }
      if (f.loseSend > 0) { f.loseSend--; throw lost(); }
      return { ok: true };
    },
    async status(runId, requestId) { const r = f.receipts.get(requestId); return r && r.runId === runId ? r : null; },
    fate(runId, requestId, state) { f.receipts.set(requestId, { receiptVersion: "p04-acts/0.1", runId, state, newAttemptAllowed: state === "expired" || state === "not-sent" }); },
  };
  return f;
}

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
  return { plan, planHash: contentHash(plan), env, nonce, view: VIEW };
}

test("act route: a lost send answer and a restart send once; landed is not complete; unknown is held and never re-sent", async () => {
  const j = memJournal();
  const three = fakeAct();
  let d = new Dispatch({ journal: j, act: three });
  const p = d.plan({ route: "act", ...actRequest() });
  assert.equal(p.ok, true, JSON.stringify(p.findings));
  three.loseSend = 1;
  let st = await d.advance(p.key);
  assert.equal(st.steps[0].state, "sending");
  d = new Dispatch({ journal: j, act: three }); // restart
  st = await d.advance(p.key);
  assert.equal(three.sends, 1, "one send");
  assert.equal(st.steps[0].attempts, 1, "④ had the act, so ③ was not called again");
  three.fate(p.steps[0].runId, p.steps[0].requestId, "landed");
  st = await d.advance(p.key);
  assert.equal(st.steps[0].final, true);
  assert.equal(st.complete, false, "landed is the send, not the arrival");
  assert.equal(st.steps[0].result.delivery, "not-verified");

  const j2 = memJournal(), t2 = fakeAct();
  let d2 = new Dispatch({ journal: j2, act: t2 });
  const p2 = d2.plan({ route: "act", ...actRequest("a2") });
  await d2.advance(p2.key);
  t2.fate(p2.steps[0].runId, p2.steps[0].requestId, "unknown");
  st = await d2.advance(p2.key);
  assert.equal(st.steps[0].state, "held");
  for (let i = 0; i < 3; i++) { d2 = new Dispatch({ journal: j2, act: t2 }); st = await d2.advance(p2.key); }
  assert.equal(t2.sends, 1, "never re-sent after unknown, across restarts");
  assert.equal(st.steps[0].state, "held");

  const j3 = memJournal(), t3 = fakeAct();
  const d3 = new Dispatch({ journal: j3, act: t3 });
  const p3 = d3.plan({ route: "act", ...actRequest("a3") });
  await d3.advance(p3.key);
  t3.fate(p3.steps[0].runId, p3.steps[0].requestId, "expired");
  st = await d3.advance(p3.key);
  st = await d3.advance(p3.key);
  assert.equal(t3.sends, 1, "a proved non-send is not retried here: a new attempt is a new run request");
  assert.equal(st.steps[0].result.newRequestAllowed, true);

  // the plan expires before the first send reaches ③ (and a restart): a new plan, the same requestId; one send
  const j4 = memJournal(), t4 = fakeAct();
  let d4 = new Dispatch({ journal: j4, act: t4 });
  const p4 = d4.plan({ route: "act", ...actRequest("a4") });
  const realSend = t4.send;
  t4.send = async () => { throw lost(); }; // never reaches ③
  await d4.advance(p4.key);
  t4.send = realSend;
  for (const pl of t4.plans.values()) pl.live = false; // expired meanwhile
  d4 = new Dispatch({ journal: j4, act: t4 });
  st = await d4.advance(p4.key);
  assert.equal(st.steps[0].state, "sending", "PlanAgain: the plan is dropped, nothing sent");
  st = await d4.advance(p4.key);
  assert.equal(t4.prepares, 2);
  assert.equal(t4.sends, 1);
  assert.equal(t4.ops.get(p4.steps[0].requestId).runId, p4.steps[0].runId);

  // a send that reached ③ under the first plan is never re-planned: the same plan and requestId again
  const j5 = memJournal(), t5 = fakeAct();
  let d5 = new Dispatch({ journal: j5, act: t5 });
  const p5 = d5.plan({ route: "act", ...actRequest("a5") });
  t5.loseSend = 1;
  t5.status = async () => null; // ④ has not registered it yet
  await d5.advance(p5.key);
  d5 = new Dispatch({ journal: j5, act: t5 });
  st = await d5.advance(p5.key);
  assert.equal(t5.prepares, 1, "no new plan");
  assert.equal(t5.sends, 1, "③ returned its operation for the requestId");
  assert.notEqual(st.steps[0].state, "held");
});

test("the file journal survives a process restart and leaves no partial file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ws06-journal-"));
  const path = join(dir, "dispatch.json");
  const four = fake4();
  // two runs of the program: the same pid (common in a container), another process start time
  const first = { pid: 4242, startOf: (pid) => (pid === 4242 ? "start-1" : null) };
  let d = new Dispatch({ journal: fileJournal(path, fs, first), run4: four });
  const p = d.plan({ route: "run", ...relayRequest(), requester: REQ });
  four.loseAccept = 1;
  await d.advance(p.key);
  // the first run died without close(): the restart takes its lock over
  d = new Dispatch({ journal: fileJournal(path, fs, { pid: 4242, startOf: (pid) => (pid === 4242 ? "start-2" : null) }), run4: four });
  const st = await d.advance(p.key);
  assert.equal(st.steps[0].state, "accepted");
  assert.equal(four.created, 1);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).format, "wylls.creation.dispatch/0");
  assert.equal(fs.existsSync(`${path}.tmp`), false);
});

test("act route: PlanUsed (another requestId sent the plan) and a requestId reused on another connection are held, never re-planned", async () => {
  for (const code of ["PlanUsed", "RequestIdUsedOnAnotherConnection"]) {
    const j = memJournal(), t = fakeAct();
    const d = new Dispatch({ journal: j, act: t });
    const p = d.plan({ route: "act", ...actRequest(`u-${code.length}`) });
    t.send = async () => { throw Object.assign(new Error(code), { code, definitive: true }); };
    let st = await d.advance(p.key);
    st = await d.advance(p.key);
    assert.equal(st.steps[0].state, "held", code);
    assert.equal(t.prepares, 1, `${code}: no new plan`);
    assert.equal(t.sends, 0);
  }
});

test("act route: a send held on unknown keeps being read, never sent; a later final fate ends the hold (still not complete)", async () => {
  const j = memJournal(), t = fakeAct();
  let d = new Dispatch({ journal: j, act: t });
  const p = d.plan({ route: "act", ...actRequest("k1") });
  await d.advance(p.key);
  const [s0] = p.steps;
  t.fate(s0.runId, s0.requestId, "unknown");
  let st = await d.advance(p.key);
  assert.equal(st.steps[0].state, "held");
  d = new Dispatch({ journal: j, act: t }); // restart while held
  st = await d.advance(p.key);
  assert.equal(st.steps[0].state, "held", "still unknown: still held");
  t.fate(s0.runId, s0.requestId, "landed");
  st = await d.advance(p.key);
  assert.equal(st.steps[0].final, true);
  assert.equal(st.steps[0].state, "sent-requested");
  assert.equal(st.held, false);
  assert.equal(st.complete, false, "landed is the send, not the arrival");
  assert.equal(t.sends, 1, "never sent again");
  // a hold on a refusal is not read at all
  const t2 = fakeAct(), d2 = new Dispatch({ journal: memJournal(), act: t2 });
  const p2 = d2.plan({ route: "act", ...actRequest("k2") });
  t2.send = async () => { throw Object.assign(new Error("PlanUsed"), { code: "PlanUsed", definitive: true }); };
  await d2.advance(p2.key);
  let reads = 0;
  t2.status = async () => { reads++; return null; };
  await d2.advance(p2.key);
  assert.equal(reads, 0);
});

test("two passes over one request at once in one process: one goes out, the other returns the state", async () => {
  const four = fake4();
  let release;
  const gate = new Promise((ok) => { release = ok; });
  const slow = { ...four, accept: async (spec, req) => { await gate; return four.accept(spec, req); }, view: (id) => four.view(id) };
  const d = new Dispatch({ journal: memJournal(), run4: slow });
  const p = d.plan({ route: "run", ...relayRequest(), requester: REQ, nonce: "c1" });
  const a = d.advance(p.key);
  // without the guard the second pass would wait on the same accept: fail fast instead of hanging
  const b = await Promise.race([d.advance(p.key), new Promise((ok) => setTimeout(() => ok({ timedOut: true }), 500))]);
  assert.equal(b.busy, true, JSON.stringify(b));
  release();
  await a;
  assert.equal(four.accepts, 1, "one accept, not two");
});

// A process table for the lock: pid -> start time ("missing" = no such process)
const procs = (entries) => { const t = new Map(entries); return (pid) => (t.has(pid) ? t.get(pid) : null); };
const lockDir = () => join(mkdtempSync(join(tmpdir(), "ws06-lock-")), "dispatch.json");

test("journal lock, same process: a second open is refused; close() releases only its own lock", () => {
  const path = lockDir();
  const table = procs([[700, "s700"]]);
  const a = fileJournal(path, fs, { pid: 700, startOf: table });
  assert.throws(() => fileJournal(path, fs, { pid: 700, startOf: table }), (e) => e.code === "JournalLocked", "the same pid and start: another open in this process");
  // with the real process table, as 16 probed it
  const real = lockDir();
  const r1 = fileJournal(real, fs);
  assert.throws(() => fileJournal(real, fs), (e) => e.code === "JournalLocked");
  r1.close();
  const r2 = fileJournal(real, fs); // after close: open again
  r2.close();
  a.save({ format: "wylls.creation.dispatch/0", plans: {} });
  a.close();
  assert.equal(fs.existsSync(`${path}.lock`), false);
});

test("journal lock, live holder: another process cannot take it; a previous run's lock (dead pid, or the same pid restarted) is taken over", () => {
  const path = lockDir();
  const a = fileJournal(path, fs, { pid: 800, startOf: procs([[800, "s800"], [801, "s801"]]) });
  assert.throws(() => fileJournal(path, fs, { pid: 801, startOf: procs([[800, "s800"], [801, "s801"]]) }), (e) => e.code === "JournalLocked");
  // 800 died (not in the table): 801 takes over
  const b = fileJournal(path, fs, { pid: 801, startOf: procs([[801, "s801"]]) });
  // a pid now used by an unrelated process (another start time) is not the holder: taken over
  const c = fileJournal(path, fs, { pid: 802, startOf: procs([[801, "reused"], [802, "s802"]]) });
  assert.throws(() => b.save({ v: 1 }), (e) => e.code === "JournalFenced");
  c.close();
  void a;
});

test("journal lock, 16's probe shape: pids absent from the process table, liveness from an injected alive()", () => {
  const none = () => null; // no /proc entry for any of these pids
  // J2: the same pid twice is refused although the process table does not know it
  const p2 = lockDir();
  const j1 = fileJournal(p2, fs, { pid: 111, alive: () => true, startOf: none });
  assert.throws(() => fileJournal(p2, fs, { pid: 111, alive: () => true, startOf: none }), (e) => e.code === "JournalLocked");
  assert.throws(() => fileJournal(p2, fs, { pid: 111, alive: () => false, startOf: none }), (e) => e.code === "JournalLocked", "this process even if alive() says no");
  j1.close();
  // J4: alive() is honoured: a live holder in another process is refused, close() releases
  const p4 = lockDir();
  const a4 = fileJournal(p4, fs, { pid: 111, alive: () => true, startOf: none });
  assert.throws(() => fileJournal(p4, fs, { pid: 222, alive: () => true, startOf: none }), (e) => e.code === "JournalLocked");
  a4.close();
  assert.equal(fs.existsSync(`${p4}.lock`), false);
  // J1: two restarts after a crash, interleaved: one wins
  const p1 = lockDir();
  fs.writeFileSync(`${p1}.lock`, "999\n"); // a crashed holder, old lock format
  const dead999 = (p) => p !== 999;
  let b = null, once = false;
  const aFs = { ...fs, readFileSync: (f, o) => {
    const v = fs.readFileSync(f, o);
    if (!once && String(f) === `${p1}.lock`) { once = true; b = fileJournal(p1, fs, { pid: 222, alive: dead999, startOf: none }); }
    return v;
  } };
  assert.throws(() => fileJournal(p1, aFs, { pid: 111, alive: dead999, startOf: none }), (e) => e.code === "JournalLocked");
  b.save({ who: "B" });
  assert.deepEqual(JSON.parse(readFileSync(p1, "utf8")), { who: "B" });
  // J3: a writer whose lock was taken over is fenced
  const p3 = lockDir();
  const a3 = fileJournal(p3, fs, { pid: 111, alive: () => true, startOf: none });
  const b3 = fileJournal(p3, fs, { pid: 222, alive: (p) => p === 222, startOf: none });
  b3.save({ who: "B", step: "sent" });
  assert.throws(() => a3.save({ who: "A", step: "stale" }), (e) => e.code === "JournalFenced");
  assert.deepEqual(JSON.parse(readFileSync(p3, "utf8")), { who: "B", step: "sent" });
  a3.close();
  assert.equal(fs.existsSync(`${p3}.lock`), true, "the fenced writer's close leaves B's lock");
  b3.close();
});

test("journal lock, takeover race: two openers that judged the same lock stale cannot both win", () => {
  const path = lockDir();
  fileJournal(path, fs, { pid: 900, startOf: procs([[900, "s900"]]) }); // dies without close
  const table = procs([[901, "s901"], [902, "s902"]]);
  let b = null, bErr = null;
  // A reads the stale lock; before A takes it over, B runs its whole takeover
  let interleaved = false;
  const aFs = { ...fs, readFileSync: (f, o) => {
    const v = fs.readFileSync(f, o);
    if (!interleaved && String(f).endsWith(".lock")) {
      interleaved = true;
      try { b = fileJournal(path, fs, { pid: 902, startOf: table }); } catch (e) { bErr = e; }
    }
    return v;
  } };
  let aErr = null;
  try { fileJournal(path, aFs, { pid: 901, startOf: table }); } catch (e) { aErr = e; }
  assert.equal(bErr, null, "B took it over");
  assert.equal(aErr?.code, "JournalLocked", "A sees the lock changed and gives up");
  b.save({ v: "B" });
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { v: "B" });
  // a takeover that is under way (its taker alive) is not raced either
  const path2 = lockDir();
  fileJournal(path2, fs, { pid: 910, startOf: procs([[910, "s910"]]) });
  fs.writeFileSync(`${path2}.lock.takeover`, JSON.stringify({ pid: 911, start: "s911", token: "t" }));
  assert.throws(() => fileJournal(path2, fs, { pid: 912, startOf: procs([[911, "s911"], [912, "s912"]]) }), (e) => e.code === "JournalLocked");
  // a taker that died mid-takeover does not block forever
  const j = fileJournal(path2, fs, { pid: 912, startOf: procs([[912, "s912"]]) });
  j.close();
  assert.equal(fs.existsSync(`${path2}.lock.takeover`), false);
});

test("journal lock, fencing: a writer that lost the lock writes nothing; its close() leaves the new holder's lock", () => {
  const path = lockDir();
  const a = fileJournal(path, fs, { pid: 1000, startOf: procs([[1000, "s1000"]]) });
  a.save({ v: "A" });
  // A is judged gone (e.g. by a process in another view of the table); B takes over
  const b = fileJournal(path, fs, { pid: 1001, startOf: procs([[1001, "s1001"]]) });
  assert.throws(() => a.save({ v: "A again" }), (e) => e.code === "JournalFenced");
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { v: "A" }, "the old writer changed nothing");
  a.close();
  assert.ok(fs.existsSync(`${path}.lock`), "A's close did not remove B's lock");
  b.save({ v: "B" });
  b.close();
  assert.equal(fs.existsSync(`${path}.lock`), false);
  // a Dispatch over a fenced journal stops at its first write: no outside call follows
  const path3 = lockDir();
  const four = fake4();
  const j = fileJournal(path3, fs, { pid: 1100, startOf: procs([[1100, "s1100"]]) });
  const d = new Dispatch({ journal: j, run4: four });
  const p = d.plan({ route: "run", ...relayRequest(), requester: REQ, nonce: "fz" });
  fileJournal(path3, fs, { pid: 1101, startOf: procs([[1101, "s1101"]]) }); // takes over
  return assert.rejects(d.advance(p.key), (e) => e.code === "JournalFenced").then(() => assert.equal(four.accepts, 0, "the accept is never made: the journal write before it was refused"));
});

test("journal lock, real interleavings (16's J6, truthful liveness): no writer the lock does not name ever lands its save", async () => {
  const { actor } = await import("./lock-steps.mjs");
  const mod = new URL("../src/connect/dispatch.mjs", import.meta.url).href;
  const table = { 111: "s111", 333: "s333" }; // A=111 and C=333 run; 999 and 998 are gone
  const A_PAUSES = [{ name: "A-lock-rename", op: "rename", end: ".lock" }, { name: "A-save-tmp", op: "open", match: "dispatch.json.", not: ".lock" }];
  const run = async (setup, cPauses) => {
    const path = lockDir();
    setup(path);
    const C = actor({ mod, path, pid: 333, table, pauses: cPauses, steps: [{ op: "open" }, { op: "save", obj: { who: "C", step: "sent" } }] });
    const A = actor({ mod, path, pid: 111, table, pauses: A_PAUSES, steps: [{ op: "open" }, { op: "save", obj: { who: "A" } }] });
    const at = (seen, name) => assert.equal(seen.at(-1)?.name, name, JSON.stringify(seen));
    at(await C.until("C-1"), "C-1"); // C inside its takeover, having judged the stale file
    at(await A.until("A-lock-rename"), "A-lock-rename"); // A holds the takeover mutex, about to replace the lock
    C.release();
    const c = (await C.until("C-lock-rename")).filter((m) => m.event === "step"); // 11be9d44: C reached its own lock replace here
    A.release();
    const a1 = await A.until("A-save-tmp");
    at(a1, "A-save-tmp"); // A holds the lock and passed save()'s fence check
    C.release();
    await C.finish();
    A.release();
    const a = [...a1, ...(await A.finish())].filter((m) => m.event === "step");
    assert.deepEqual(c.map((m) => [m.op, m.ok, m.code]), [["open", false, "JournalLocked"]], "C is refused while a live taker holds the mutex");
    assert.deepEqual(a.map((m) => [m.op, m.ok]), [["open", true], ["save", true]]);
    assert.equal(JSON.parse(readFileSync(`${path}.lock`, "utf8")).pid, 111, "the writer whose save landed is the lock's holder");
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { who: "A" });
    const dir = path.slice(0, path.lastIndexOf("/"));
    assert.deepEqual(fs.readdirSync(dir).sort(), ["dispatch.json", "dispatch.json.lock"], "no takeover mutex or temporary file left");
  };
  const deadLock = (p) => fs.writeFileSync(`${p}.lock`, JSON.stringify({ pid: 999, start: "s999", token: "dead" }) + "\n");
  // the takeover mutex must never be visible empty (an empty file reads as "no taker")
  await run(deadLock, [{ name: "C-1", op: "write", match: ".lock.takeover" }, { name: "C-lock-rename", op: "rename", end: ".lock" }]);
  // a dead taker's mutex: C judged it dead, then A put its own there; C must not remove or replace A's
  await run((p) => { deadLock(p); fs.writeFileSync(`${p}.lock.takeover`, JSON.stringify({ pid: 998, start: "s998", token: "dead-taker" }) + "\n"); },
    [{ name: "C-1", op: "rm", end: ".lock.takeover" }, { name: "C-1", op: "link", end: ".lock.takeover.takeover" }, { name: "C-lock-rename", op: "rename", end: ".lock" }]);
});

test("journal lock, the earlier format (a bare pid): a running holder is refused, a gone one is taken over", () => {
  const path = lockDir();
  fs.writeFileSync(`${path}.lock`, "4300\n");
  assert.throws(() => fileJournal(path, fs, { pid: 4301, startOf: procs([[4300, "s4300"], [4301, "s4301"]]) }), (e) => e.code === "JournalLocked");
  const j = fileJournal(path, fs, { pid: 4301, startOf: procs([[4301, "s4301"]]) });
  j.save({ v: 1 });
  j.close();
});

test("journal lock, real processes: eight that race for one stale lock (every other round with a dead taker's mutex too), five rounds: exactly one wins each round", async () => {
  // (2026-11-19, discrepancy 85) Barriers, not sleeps. Before, the winner held the lock for a fixed 300 ms and exited
  // without close(); a child that a loaded runner spawned more than 300 ms late found the lock of a holder that had
  // exited, and took it over (as it must: that lock is stale), so the round counted two winners. Now every child
  // reports "ready" once loaded, all are released by a "go" (together, or a few ms apart), and each stays alive (the winner holding the
  // lock) until the parent has every child's answer: no attempt can meet a holder that is gone.
  const { spawn } = await import("node:child_process");
  const mod = new URL("../src/connect/dispatch.mjs", import.meta.url).href;
  const child = `const { fileJournal } = await import(${JSON.stringify(mod)}); const fs = await import("node:fs");
    let buf = "", j = null;
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (x) => {
      buf += x;
      if (buf.includes("go\\n") && j === null) {
        j = false;
        try { j = fileJournal(process.argv[1], fs); process.stdout.write("won\\n"); } catch (e) { process.stdout.write(e.code + "\\n"); }
      }
    });
    process.stdin.on("end", () => { if (j) { j.save({ by: process.pid }); process.stdout.write("saved\\n"); } });
    process.stdout.write("ready\\n");`;
  for (let round = 0; round < 5; round++) {
    const path = lockDir();
    fs.writeFileSync(`${path}.lock`, JSON.stringify({ pid: 2147483646, start: "gone", token: "dead" }));
    if (round % 2) fs.writeFileSync(`${path}.lock.takeover`, JSON.stringify({ pid: 2147483645, start: "gone", token: "dead-taker" }));
    const kids = Array.from({ length: 8 }, () => {
      const c = spawn(process.execPath, ["--input-type=module", "-e", child, path], { stdio: ["pipe", "pipe", "inherit"] });
      const k = { c, lines: [], waiters: [] };
      let o = "";
      c.stdout.on("data", (x) => {
        o += x;
        for (let i; (i = o.indexOf("\n")) >= 0; o = o.slice(i + 1)) k.lines.push(o.slice(0, i));
        k.waiters = k.waiters.filter((w) => !w());
      });
      k.closed = new Promise((ok) => c.on("close", (code) => { k.waiters.forEach((w) => w()); ok(code); }));
      k.line = (n) => new Promise((ok, no) => {
        const w = () => { if (k.lines.length > n) { ok(k.lines[n]); return true; } if (c.exitCode !== null) { no(new Error(`child ${c.pid} exited (${c.exitCode}) after ${JSON.stringify(k.lines)}`)); return true; } return false; };
        if (!w()) k.waiters.push(w);
      });
      return k;
    });
    try {
      assert.deepEqual(await Promise.all(kids.map((k) => k.line(0))), Array(8).fill("ready"), `round ${round}: every child loaded`);
      // released together (round 0) or a few ms apart, so the openers meet at every step of a takeover; a late one
      // still finds the winner alive, since no child exits before every answer is in
      const gap = [0, 1, 2, 3, 5][round];
      for (const [i, k] of kids.entries()) { if (gap && i) await new Promise((ok) => setTimeout(ok, gap)); k.c.stdin.write("go\n"); }
      const outs = await Promise.all(kids.map((k) => k.line(1))); // every answer is in while every child still runs
      assert.equal(outs.filter((o) => o === "won").length, 1, `round ${round}: ${outs.join(",")}`);
      assert.ok(outs.every((o) => o === "won" || o === "JournalLocked"), `round ${round}: ${outs.join(",")}`);
      const winner = kids[outs.indexOf("won")].c.pid;
      assert.equal(JSON.parse(readFileSync(`${path}.lock`, "utf8")).pid, winner, `round ${round}: the lock names the one that won`);
      for (const k of kids) k.c.stdin.end();
      assert.deepEqual(await Promise.all(kids.map((k) => k.closed)), Array(8).fill(0), `round ${round}: every child exits cleanly`);
      assert.deepEqual(kids.map((k) => k.lines.slice(2)), outs.map((o) => (o === "won" ? ["saved"] : [])), `round ${round}: only the winner saved`);
      assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { by: winner }, `round ${round}: the journal holds the winner's save`);
    } finally {
      for (const k of kids) if (k.c.exitCode === null) k.c.kill();
    }
  }
});

// (2026-11-18) A missing /proc/<pid>/stat means "no such process" only where /proc exists; on a host without it
// (macOS) the race above saw every live holder as dead and all eight openers "won". Platform-independent checks of
// how a holder's liveness is read, with the file reader and the signal injected.
const enoent = () => Object.assign(new Error("ENOENT"), { code: "ENOENT" });
const errno = (code) => () => { throw Object.assign(new Error(code), { code }); };
const linuxStat = (start) => `4242 (node (x) y) S ${Array.from({ length: 19 }, (_, i) => (i === 18 ? start : "0")).join(" ")} 0 0`;

test("process start, Linux /proc: start time read; a pid absent from a mounted /proc is gone, without a signal", () => {
  const signals = [];
  const kill = (pid, sig) => { signals.push([pid, sig]); };
  const proc = (table) => (file) => { if (file === "/proc/self/stat") return linuxStat("1"); if (Object.hasOwn(table, file)) return table[file]; throw enoent(); };
  assert.equal(processStart(4242, { read: proc({ "/proc/4242/stat": linuxStat("98765") }), kill }), "98765", "field 22, after a ')' in the name");
  assert.equal(processStart(4243, { read: proc({}), kill }), null, "not in a mounted /proc: no such process");
  assert.deepEqual(signals, [], "/proc alone answers; no signal is sent");
  // a reused pid: same pid, another start time, is not the holder (running() compares the start times)
  const path = lockDir();
  fs.writeFileSync(`${path}.lock`, JSON.stringify({ pid: 4242, start: "111", token: "old" }));
  const j = fileJournal(path, fs, { pid: 5000, startOf: (p) => processStart(p, { read: proc({ "/proc/4242/stat": linuxStat("222"), "/proc/5000/stat": linuxStat("5") }), kill }) });
  j.save({ taken: true });
  j.close();
  // and the same start time is the running holder: refused
  fs.writeFileSync(`${path}.lock`, JSON.stringify({ pid: 4242, start: "222", token: "live" }));
  assert.throws(() => fileJournal(path, fs, { pid: 5000, startOf: (p) => processStart(p, { read: proc({ "/proc/4242/stat": linuxStat("222"), "/proc/5000/stat": linuxStat("5") }), kill }) }), (e) => e.code === "JournalLocked");
});

test("process start, no /proc (macOS): a live holder is running, only ESRCH is gone, EPERM and unknown errors are conservative", () => {
  const read = () => { throw enoent(); }; // no /proc at all: neither /proc/<pid>/stat nor /proc/self/stat
  assert.equal(processStart(4242, { read, kill: () => true }), undefined, "signal 0 delivered: runs, start unknown (was null: 'gone')");
  assert.equal(processStart(4242, { read, kill: errno("ESRCH") }), null, "no such process");
  assert.equal(processStart(4242, { read, kill: errno("EPERM") }), undefined, "another user's process: runs");
  assert.equal(processStart(4242, { read, kill: errno("EINVAL") }), undefined, "an unexplained failure is never read as gone");
  // a /proc read refused (hidepid) asks by signal as before
  const hidden = (file) => { if (file === "/proc/self/stat") return linuxStat("1"); throw Object.assign(new Error("EACCES"), { code: "EACCES" }); };
  assert.equal(processStart(4242, { read: hidden, kill: () => true }), undefined);
  assert.equal(processStart(4242, { read: hidden, kill: errno("ESRCH") }), null);
  // the lock: a live holder on such a host is refused, a gone one taken over
  const path = lockDir();
  const startOf = (alive) => (p) => processStart(p, { read, kill: (pid) => { if (!alive.includes(pid)) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" }); } });
  const held = fileJournal(path, fs, { pid: 6001, startOf: startOf([6001]) });
  assert.throws(() => fileJournal(path, fs, { pid: 6002, startOf: startOf([6001, 6002]) }), (e) => e.code === "JournalLocked", "the live holder keeps it");
  held.save({ by: 6001 });
  const taker = fileJournal(path, fs, { pid: 6002, startOf: startOf([6002]) }); // 6001 is gone (ESRCH)
  assert.throws(() => held.save({ by: 6001 }), (e) => e.code === "JournalFenced");
  taker.close();
});

test("process start of this process on the real host is not 'gone'", () => {
  assert.notEqual(processStart(process.pid), null);
});

test("the file journal is fsynced through the directory after the rename", () => {
  const path = lockDir();
  const dir = path.slice(0, path.lastIndexOf("/"));
  const dirFds = new Set(), syncedDirs = [];
  const spy = { ...fs, fsyncSync: (fd) => { if (dirFds.has(fd)) syncedDirs.push(fd); return fs.fsyncSync(fd); }, openSync: (...a) => { const fd = fs.openSync(...a); if (a[0] === dir) dirFds.add(fd); return fd; } };
  const j = fileJournal(path, spy, { pid: 1200, startOf: procs([[1200, "s1200"]]) });
  new Dispatch({ journal: j, run4: fake4() }).plan({ route: "run", ...relayRequest(), requester: REQ, nonce: "f1" });
  assert.ok(syncedDirs.length > 0, "the directory was fsynced after the rename");
  assert.equal(JSON.parse(readFileSync(path, "utf8")).format, "wylls.creation.dispatch/0");
  j.close();
  assert.equal(fs.existsSync(`${path}.lock`), false);
});
