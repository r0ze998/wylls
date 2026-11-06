/**
 * Dispatch (src/connect/dispatch.mjs): run ids fixed from the plan, the
 * journal written before every outside call, lost answers and restarts.
 *
 * ④'s accept/view command and ③'s b76b0a57 have not arrived, so ④ and ③
 * are fakes with the idempotency their delivered contracts give: ④'s store
 * answers Created / Existing for one run id and spec, Conflict for another
 * spec; ③ sends one requestId once. A fake can apply a call and lose its
 * answer. A restart is a new Dispatch on the saved journal.
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

function memJournal() {
  let saved = null;
  let writes = 0;
  return { load: () => (saved ? JSON.parse(saved) : null), save: (o) => { saved = JSON.stringify(o); writes++; }, get writes() { return writes; } };
}

/** ④'s run store, faked: idempotent accept by run id and spec, views scripted per run. */
function fake4() {
  const runs = new Map();
  const f = {
    runs, accepts: 0, created: 0, loseAccept: 0, failView: 0,
    async accept(spec) {
      f.accepts++;
      const d = contentHash(spec);
      let result;
      const had = runs.get(spec.run_id);
      if (!had) { runs.set(spec.run_id, { spec, digest: d, state: "Accepted", detail: { ship_seq: null, outcome: null } }); f.created++; result = "Created"; }
      else result = had.digest === d ? "Existing" : "Conflict";
      if (f.loseAccept > 0) { f.loseAccept--; throw lost(); }
      return { result };
    },
    async view(runId) {
      if (f.failView > 0) { f.failView--; throw new Error("could not ask"); }
      const r = runs.get(runId);
      if (!r) return null;
      return { viewVersion: "p04-run/0.1", runId, state: r.state, terminal: ["Fulfilled", "Partial", "DeliveredUnverified", "Failed", "Cancelled", "Expired"].includes(r.state), held: r.held ?? null, cancel: null, detail: r.detail, spec: r.spec, receipts: [] };
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
  const p = d.plan({ route: "run", ...req });
  assert.equal(p.ok, true, JSON.stringify(p.findings));
  assert.equal(four.accepts, 0, "planning calls nobody");
  assert.equal(JSON.parse(JSON.stringify(j.load())).plans[p.key].steps[0].state, "planned");
  // the same request again: the same ids; other content under the same key: refused
  assert.deepEqual(d.plan({ route: "run", ...req }).steps.map((s) => s.runId), p.steps.map((s) => s.runId));
  assert.equal(d.plan({ route: "run", ...req, budget: { ...req.budget, max_fee: 1 } }).findings[0].code, "CONFLICT");

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
});

test("run route: the second step binds the first caravan once and keeps it across a restart; completion only from verified arrivals", async () => {
  const j = memJournal();
  const four = fake4();
  let d = new Dispatch({ journal: j, run4: four });
  const p = d.plan({ route: "run", ...relayRequest() });
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
  const p2 = d2.plan({ route: "run", ...relayRequest(), nonce: "r2" });
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
  const p = d.plan({ route: "run", ...relayRequest() });
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
  const p3 = d3.plan({ route: "run", ...relayRequest(), nonce: "r3" });
  await d3.advance(p3.key);
  f3.runs.delete(p3.steps[0].runId);
  st = await d3.advance(p3.key);
  assert.equal(st.steps[0].state, "held");
  assert.equal(st.held, true);
  // Conflict on a fresh accept
  const j4 = memJournal(), f4 = fake4();
  const d4 = new Dispatch({ journal: j4, run4: f4 });
  const p4 = d4.plan({ route: "run", ...relayRequest(), nonce: "r4" });
  f4.view = async () => null;
  f4.runs.set(p4.steps[0].runId, { spec: {}, digest: "other", state: "Accepted", detail: {} });
  st = await d4.advance(p4.key);
  assert.equal(st.steps[0].state, "held");
  assert.equal(st.steps[0].runId, p4.steps[0].runId, "the run id did not change");
  // a view that cannot be read leaves the step as it was
  const j5 = memJournal(), f5 = fake4();
  const d5 = new Dispatch({ journal: j5, run4: f5 });
  const p5 = d5.plan({ route: "run", ...relayRequest(), nonce: "r5" });
  await d5.advance(p5.key);
  f5.failView = 1;
  st = await d5.advance(p5.key);
  assert.equal(st.steps[0].state, "accepted");
  assert.equal(f5.accepts, 1);
});

// ③ faked: one requestId is sent once; ④'s act registry read by run id
function fakeAct() {
  const f = {
    sends: 0, applied: new Map(), loseSend: 0, receipts: new Map(),
    async send({ requestId, runId }) {
      if (!f.applied.has(requestId)) { f.applied.set(requestId, runId); f.sends++; f.receipts.set(runId, { receiptVersion: "p04-acts/0.1", runId, state: "registered", newAttemptAllowed: false }); }
      if (f.loseSend > 0) { f.loseSend--; throw lost(); }
      return { ok: true };
    },
    async status(runId) { return f.receipts.get(runId) ?? null; },
    fate(runId, state) { f.receipts.set(runId, { receiptVersion: "p04-acts/0.1", runId, state, newAttemptAllowed: state === "expired" || state === "not-sent" }); },
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
  three.fate(p.steps[0].runId, "landed");
  st = await d.advance(p.key);
  assert.equal(st.steps[0].final, true);
  assert.equal(st.complete, false, "landed is the send, not the arrival");
  assert.equal(st.steps[0].result.delivery, "not-verified");

  const j2 = memJournal(), t2 = fakeAct();
  let d2 = new Dispatch({ journal: j2, act: t2 });
  const p2 = d2.plan({ route: "act", ...actRequest("a2") });
  await d2.advance(p2.key);
  t2.fate(p2.steps[0].runId, "unknown");
  st = await d2.advance(p2.key);
  assert.equal(st.steps[0].state, "held");
  for (let i = 0; i < 3; i++) { d2 = new Dispatch({ journal: j2, act: t2 }); st = await d2.advance(p2.key); }
  assert.equal(t2.sends, 1, "never re-sent after unknown, across restarts");
  assert.equal(st.steps[0].state, "held");

  const j3 = memJournal(), t3 = fakeAct();
  const d3 = new Dispatch({ journal: j3, act: t3 });
  const p3 = d3.plan({ route: "act", ...actRequest("a3") });
  await d3.advance(p3.key);
  t3.fate(p3.steps[0].runId, "expired");
  st = await d3.advance(p3.key);
  st = await d3.advance(p3.key);
  assert.equal(t3.sends, 1, "a proved non-send is not retried here: a new attempt is a new run request");
  assert.equal(st.steps[0].result.newRequestAllowed, true);
});

test("the file journal survives a process restart and leaves no partial file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ws06-journal-"));
  const path = join(dir, "dispatch.json");
  const four = fake4();
  let d = new Dispatch({ journal: fileJournal(path, fs), run4: four });
  const p = d.plan({ route: "run", ...relayRequest() });
  four.loseAccept = 1;
  await d.advance(p.key);
  d = new Dispatch({ journal: fileJournal(path, fs), run4: four });
  const st = await d.advance(p.key);
  assert.equal(st.steps[0].state, "accepted");
  assert.equal(four.created, 1);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).format, "wylls.creation.dispatch/0");
  assert.equal(fs.existsSync(`${path}.tmp`), false);
});
