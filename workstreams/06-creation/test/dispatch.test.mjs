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

const { Dispatch, fileJournal } = await import("../src/connect/dispatch.mjs");
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

test("journal lock, real processes: eight that race for one stale lock, five rounds: exactly one wins each round", async () => {
  const { spawn } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const mod = new URL("../src/connect/dispatch.mjs", import.meta.url).href;
  const child = `const { fileJournal } = await import(${JSON.stringify(mod)}); const fs = await import("node:fs");
    try { fileJournal(process.argv[1], fs); process.stdout.write("won"); setTimeout(() => {}, 300); } catch (e) { process.stdout.write(e.code); }`;
  for (let round = 0; round < 5; round++) {
    const path = lockDir();
    fs.writeFileSync(`${path}.lock`, JSON.stringify({ pid: 2147483646, start: "gone", token: "dead" }));
    const outs = await Promise.all(Array.from({ length: 8 }, () => new Promise((ok) => {
      const c = spawn(process.execPath, ["--input-type=module", "-e", child, path], { stdio: ["ignore", "pipe", "inherit"] });
      let o = ""; c.stdout.on("data", (x) => { o += x; }); c.on("close", () => ok(o));
    })));
    assert.equal(outs.filter((o) => o === "won").length, 1, `round ${round}: ${outs.join(",")}`);
    assert.ok(outs.every((o) => o === "won" || o === "JournalLocked"), outs.join(","));
    void fileURLToPath;
  }
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
