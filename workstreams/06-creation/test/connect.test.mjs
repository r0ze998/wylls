/**
 * The connection of an adopted caravan definition to ③'s SendCaravan and
 * ④'s Run / Outcome / Receipt (src/connect/caravan.mjs).
 *
 * These tests generate, derive and use no key and sign nothing: plans are
 * built as content and hashed only. Place records and ④'s runs are
 * fixtures written in ④'s shapes (src/model.rs), not read from a chain.
 */

import test from "node:test";

// No key is generated, imported, derived or used here: any such call fails the run.
for (const k of ["generateKey", "importKey", "exportKey", "deriveKey", "deriveBits", "sign", "verify"]) {
  globalThis.crypto.subtle[k] = () => { throw new Error(`crypto.subtle.${k} called in a no-key test`); };
}

import assert from "node:assert/strict";
import { contentHash } from "../src/canonical.mjs";
import { frontSupply, mineDelivery } from "../src/scenario.mjs";
import { readFileSync } from "node:fs";
import { bindInbound, connectability, coreCargo, dedupeReceipts, resultOf, resultOfAct, resultOfRun4, toMcpCaravans, toRunSpecs, CORE_RESOURCES, REQUEST_ID } from "../src/connect/caravan.mjs";
import { fixtureText, relayManifest, relaySpecs } from "../cli/connect-fixture.mjs";

const AUTHOR = "ab".repeat(32); // public-key-shaped strings: no key behind them
const USER = "cd".repeat(32);
const TAG = { M: 41, B: 42 };

// place records as ④/③ would read them from the chain (fixture)
const PLACES = {
  "vault:M-mine": { kind: 2, p: 2, q: -1, at: 7, gen: 1, ownerTag: TAG.M },
  "vault:M-store": { kind: 2, p: 2, q: -1, at: 9, gen: 1, ownerTag: TAG.M },
  "vault:B-work": { kind: 2, p: 3, q: -1, at: 4, gen: 3, ownerTag: TAG.B },
};
const places = (id) => PLACES[id] ?? null;

function adopted(m, params, over = {}) {
  const env = { manifest: m, hash: contentHash(m) };
  const plan = {
    format: "wylls.creation.plan/1",
    manifest: { author: m.author, name: m.name, version: m.version, hash: env.hash },
    actor: USER,
    bindings: { params, grants: {} },
    preparedDay: 12,
    effects: { "caravan.send": 1 },
    ...over,
  };
  return { env, plan, planHash: contentHash(plan) };
}

const BUDGET = { max_attempts: 3, max_fee: 100_000, max_port_errors: 5 };
const spec = (a, extra = {}) => toRunSpecs({ ...a, nonce: "r1", places, ownerTag: TAG.M, deadlineSlot: 5_000, budget: BUDGET, ...extra });

test("an adopted caravan definition becomes ④ run specs: places, cargo[8] in the core's order, run id, pin", () => {
  const a = adopted(mineDelivery(AUTHOR), { mine: "vault:M-mine", buyer: "vault:M-store", ore: 24, wood: 12 });
  const r = spec(a);
  assert.equal(r.ok, true, JSON.stringify(r.findings));
  assert.equal(r.runs.length, 1);
  const s = r.runs[0].spec;
  assert.equal(s.run_id, `ws06:${a.planHash}:r1:ship`);
  assert.deepEqual(s.stock, { kind: 2, p: 2, q: -1, at: 7, gen: 1 });
  assert.deepEqual(s.ship.dst, { kind: 2, p: 2, q: -1, at: 9, gen: 1 });
  assert.equal(CORE_RESOURCES[1], "wood");
  assert.equal(CORE_RESOURCES[3], "ore");
  assert.deepEqual(s.ship.cargo, [0, 12, 0, 24, 0, 0, 0, 0]);
  assert.equal(s.facility, null, "no placeholder facility");
  assert.equal(s.rights_units, 0);
  assert.equal(r.runs[0].walletRequired, false);
  assert.deepEqual(r.runs[0].pin.manifest, a.plan.manifest);
  assert.ok(r.gaps.some((g) => g.includes("CLI")), "④'s accept/view command is still awaited");
  assert.equal(r.needs4, "30a3fd2e", "④ takes a null facility from 30a3fd2e on");
  assert.ok(r.runs[0].leftToExecutor.some((x) => x.startsWith("seq")), "the seq is ④'s to fix");
  // the same request gives the same run id; another nonce another one
  assert.equal(spec(a).runs[0].spec.run_id, s.run_id);
  assert.notEqual(spec(a, { nonce: "r2" }).runs[0].spec.run_id, s.run_id);
});

test("a send to another's place is marked for the sender's wallet (④ holds it: WalletRequired)", () => {
  const a = adopted(mineDelivery(AUTHOR), { mine: "vault:M-mine", buyer: "vault:B-work", ore: 5, wood: 0 });
  const r = spec(a);
  assert.equal(r.ok, true);
  assert.equal(r.runs[0].walletRequired, true);
  assert.deepEqual(r.runs[0].spec.ship.dst, { kind: 2, p: 3, q: -1, at: 4, gen: 3 }, "the generation is part of the place");
});

test("the plan's pin and effect revision are checked; a source that is not the actor's is refused", () => {
  const a = adopted(mineDelivery(AUTHOR), { mine: "vault:M-mine", buyer: "vault:M-store" });
  const other = { manifest: { ...a.env.manifest, version: "1.0.1" }, hash: "00".repeat(32) };
  assert.equal(spec({ ...a, env: other }).findings[0].code, "PIN_MISMATCH");
  assert.equal(spec(a, { effectRevs: { "caravan.send": 2 } }).findings[0].code, "EFFECT_REVISED");
  // a plan/0 (no effects) is read as rev 1, as 06 reads it elsewhere
  const legacy = adopted(mineDelivery(AUTHOR), { mine: "vault:M-mine", buyer: "vault:M-store" }, { format: "wylls.creation.plan/0", effects: undefined });
  delete legacy.plan.effects;
  assert.equal(spec(legacy).ok, true);
  assert.equal(spec(a, { ownerTag: TAG.B }).findings[0].code, "NOT_OWNER");
  assert.equal(spec(a, { places: () => null }).findings[0].code, "PLACE_UNRESOLVED");
});

test("what does not connect says why: the workshop (S2 mock), a consume dependency, chained caravans; arms ride in S1's slot 4", () => {
  const c = connectability(frontSupply(AUTHOR));
  assert.equal(c.connectable, false);
  const why = c.reasons.map((r) => r.effect ?? r.resource ?? r.use ?? r.step);
  assert.ok(why.includes("workshop.run"));
  assert.ok(!why.includes("arms"), "S1's arms take the Horses slot (arms.rs ARMS = Resource::Horses)");
  assert.equal(CORE_RESOURCES[4], "arms");
  assert.deepEqual(coreCargo({ arms: 12 }).cargo, [0, 0, 0, 0, 12, 0, 0, 0]);
  assert.ok(why.includes("ws"));
  assert.ok(c.reasons.some((r) => r.step === "ship" && r.why.includes("inbound")));
  assert.deepEqual(coreCargo({ science: 1 }).problems.map((p) => p.resource), ["science"]);
  assert.deepEqual(coreCargo({ ore: -1 }).problems.map((p) => p.resource), ["ore"]);
  assert.equal(connectability(mineDelivery(AUTHOR)).connectable, true);
});

const run = (state, outcome, extra = {}) => ({ run_id: "ws06:x:r1:ship", state, outcome, ...extra });
const res = (o = 0, w = 0) => [0, w, 0, o, 0, 0, 0, 0];

test("④ outcomes become 06 results: counted only when verified; unverified is unknown, not 0", () => {
  const full = resultOf(run("Fulfilled", { delivered: res(24, 12), verification: "RuleDerived", cargo_logged: res(24, 12), effects: [] }));
  assert.deepEqual(full.counted, { wood: 12, ore: 24 });
  assert.equal(full.actual.kind, "at-least");
  assert.equal(full.evidence.usable, true);

  const part = resultOf(run("Partial", { delivered: res(20, 12), verification: "Recorded", cargo_logged: res(20, 12), effects: [] }));
  assert.deepEqual(part.counted, { wood: 12, ore: 20 });

  const unv = resultOf(run("DeliveredUnverified", { delivered: null, verification: "Unverifiable", cargo_logged: res(24, 12), effects: [] }));
  assert.deepEqual(unv.counted, {}, "counts 0");
  assert.equal(unv.actual.kind, "unknown", "but the amount is unknown, not 0");
  assert.deepEqual(unv.actual.below, { food: 1, wood: 13, stone: 1, ore: 25, arms: 1, gold: 1, science: 1, influence: 1 });
  assert.equal(unv.evidence.usable, false);

  const burned = resultOf(run("Failed", { delivered: res(0, 0), verification: "KnownZero", cargo_logged: null, effects: ["caravan_raided cv:29:7"] }));
  assert.equal(burned.actual.kind, "zero");
  assert.deepEqual(burned.counted, {});

  const held = resultOf(run("Arrived", null, { held_reason: "DestinationMismatch" }));
  assert.equal(held.final, false);
  assert.equal(held.held, "DestinationMismatch");
  assert.equal(held.actual.kind, "pending");

  const cancelled = resultOf(run("Cancelled", { delivered: null, verification: "NotShipped", cargo_logged: null, effects: [] }, { cancel_phase: { Completed: { effects: [] } } }));
  assert.equal(cancelled.final, true);
  assert.equal(cancelled.actual.kind, "none");

  assert.equal(resultOf(run("InTransit", null)).final, false);
  assert.equal(resultOf(run("Teleported", null)).ok, false);
  assert.equal(resultOf(run("Fulfilled", { verification: "Guessed" })).ok, false);
});

test("④ receipts are deduplicated by kind and subject, not by source", () => {
  const a = { run_id: "x", kind: "caravan_settled", subject: "cv:29:7", source: "event:1", slot: 9, body: {} };
  const b = { ...a, source: "history:4" };
  const c = { ...a, kind: "caravan_sent", source: "sig:s" };
  assert.deepEqual(dedupeReceipts([a, b, c]).map((r) => r.kind), ["caravan_settled", "caravan_sent"]);
});

// ③'s view of the owner (get_village_status): only the owner's own places, with placeIds and generations
const VIEW = {
  citizenTag: "41",
  village: { kind: "holding", p: 2, q: -1, site: 3, gen: 1, tile: 11, placeId: "village:2,-1,3" },
  places: [
    { kind: "holding", p: 2, q: -1, site: 3, gen: 1, tile: 11, placeId: "village:2,-1,3" },
    { kind: "vault", p: 2, q: -1, tile: 7, gen: 1, known: true, placeId: "vault:2,-1,7" },
    { kind: "vault", p: 3, q: -1, tile: 4, gen: 2, known: true, placeId: "vault:3,-1,4" },
  ],
};

test("the ③ route: prepare_caravan arguments, a requestId ③ accepts, 06's run id for ④'s act registry", () => {
  const a = adopted(mineDelivery(AUTHOR), { mine: "vault:2,-1,7", buyer: "vault:3,-1,4", ore: 24, wood: 12 });
  const r = toMcpCaravans({ ...a, nonce: "r1", view: VIEW });
  assert.equal(r.ok, true, JSON.stringify(r.findings));
  const c = r.calls[0];
  assert.deepEqual(c.prepare, { from: "vault:2,-1,7", to: "vault:3,-1,4", cargo: [0, 12, 0, 24, 0, 0, 0, 0] });
  assert.ok(REQUEST_ID.test(c.requestId), c.requestId);
  assert.equal(toMcpCaravans({ ...a, nonce: "r1", view: VIEW }).calls[0].requestId, c.requestId, "a retry of the same decision reuses it");
  assert.notEqual(toMcpCaravans({ ...a, nonce: "r2", view: VIEW }).calls[0].requestId, c.requestId);
  assert.equal(c.runId, `ws06:${a.planHash}:r1:ship`);
  assert.equal(c.register.source, "mcp");
  assert.deepEqual(c.places.to, { placeId: "vault:3,-1,4", gen: 2 });
  assert.equal(r.citizenTag, "41");
  // another player's place is not planned on this route; a logical name is not a placeId
  const other = adopted(mineDelivery(AUTHOR), { mine: "vault:2,-1,7", buyer: "vault:9,9,1" });
  assert.equal(toMcpCaravans({ ...other, nonce: "r1", view: VIEW }).findings[0].code, "NOT_YOUR_PLACE");
  const logical = adopted(mineDelivery(AUTHOR), { mine: "vault:M-mine", buyer: "vault:3,-1,4" });
  assert.equal(toMcpCaravans({ ...logical, nonce: "r1", view: VIEW }).findings[0].code, "PLACE_UNRESOLVED");
  const empty = adopted(mineDelivery(AUTHOR), { mine: "vault:2,-1,7", buyer: "vault:3,-1,4", ore: 0, wood: 0 });
  assert.equal(toMcpCaravans({ ...empty, nonce: "r1", view: VIEW }).findings[0].code, "CARGO");
  assert.equal(toMcpCaravans({ ...a, nonce: "bad nonce", view: VIEW }).findings[0].code, "SHAPE");
});

const act = (state, extra = {}) => ({ receiptVersion: "p04-acts/0.1", runId: "ws06:x:r1:ship", state, newAttemptAllowed: state === "expired" || state === "not-sent", ...extra });

test("④ act receipts: a send is never complete or counted; unknown holds; only proved non-sends allow a new request", () => {
  for (const s of ["registered", "pending", "unknown", "unqueryable", "landed", "failed", "expired", "not-sent"]) {
    const r = resultOfAct(act(s));
    assert.equal(r.ok, true, s);
    assert.equal(r.complete, false, `${s} is never complete`);
    assert.deepEqual(r.counted, {}, `${s} counts nothing`);
  }
  assert.equal(resultOfAct(act("landed")).delivery, "not-verified");
  assert.equal(resultOfAct(act("landed")).sendFinal, true);
  assert.equal(resultOfAct(act("unknown")).hold, true);
  assert.equal(resultOfAct(act("unknown")).newRequestAllowed, false);
  assert.equal(resultOfAct(act("unqueryable")).sendFinal, false);
  assert.equal(resultOfAct(act("expired")).newRequestAllowed, true);
  assert.equal(resultOfAct(act("landed", { newAttemptAllowed: true })).newRequestAllowed, false, "a landed send is never retried");
  assert.equal(resultOfAct(act("teleported")).ok, false);
  assert.equal(resultOfAct({ ...act("landed"), receiptVersion: "p04-acts/9" }).ok, false);
});

// ④'s own run views (runexec::view::run_view, p04-run/0.1, ④ cf517b55), written by ④'s executor on the specs
// below in a scratch checkout (handoff/ws04-check/ws06_check.rs, not left in ④)
const VIEW4 = (name) => JSON.parse(readFileSync(new URL(`../fixtures/connect/run4-view-${name}.json`, import.meta.url), "utf8"));

test("a two-caravan plan becomes two ④ runs; the second waits for the first (its caravan as inbound)", () => {
  assert.equal(fixtureText(), readFileSync(new URL("../fixtures/connect/ws06-runspecs.json", import.meta.url), "utf8"), "the fixture ④ reads is what 06 writes now");
  const r = relaySpecs();
  assert.equal(r.ok, true, JSON.stringify(r.findings));
  const [haul, forward] = r.runs;
  assert.equal(forward.awaits, "haul");
  assert.equal(forward.spec.inbound, null, "bound only once the first caravan is on the road");
  // before the first ships: wait; once it is in transit: its key
  const early = { ...VIEW4("haul-in-transit"), state: "FacilityConfirmed", detail: { ...VIEW4("haul-in-transit").detail, ship_seq: null } };
  assert.equal(bindInbound(forward, haul, early).code, "WAIT");
  const b = bindInbound(forward, haul, VIEW4("haul-in-transit"));
  assert.equal(b.ok, true, JSON.stringify(b));
  assert.deepEqual(b.spec.inbound, { owner: 119, seq: 0 });
  assert.equal(bindInbound(forward, haul, { ...VIEW4("haul-in-transit"), state: "Failed" }).code, "INBOUND_STOPPED");
  assert.equal(bindInbound(forward, haul, { ...VIEW4("haul-in-transit"), run_id: "other" }).code, "SHAPE");
  assert.equal(bindInbound(forward, haul, { ...VIEW4("haul-in-transit"), spec: { ...VIEW4("haul-in-transit").spec, owner: 1 } }).code, "SHAPE", "another owner's caravan is not bound");
  assert.equal(bindInbound(haul, forward, VIEW4("haul-in-transit")).ok, false, "the first waits for nothing");
  // ③'s MCP route plans one caravan at a time: a chain does not go that way
  assert.equal(connectability(relayManifest()).connectable, false);
  assert.equal(connectability(relayManifest(), { chains: true }).connectable, true);
  const bent = relayManifest();
  bent.steps[1].args.from = { param: "home" };
  assert.equal(connectability(bent, { chains: true }).connectable, false, "waiting needs the earlier destination as the source");
});

test("④'s run views read as 06 results: arrival and amount from ④'s judgement, never from the send", () => {
  const transit = resultOfRun4(VIEW4("haul-in-transit"));
  assert.equal(transit.final, false);
  assert.deepEqual(transit.counted, {}, "in transit counts nothing");
  const haul = resultOfRun4(VIEW4("haul-fulfilled"));
  assert.equal(haul.state, "Fulfilled");
  assert.deepEqual(haul.counted, { wood: 4 });
  assert.equal(haul.evidence.usable, true);
  const fwd = resultOfRun4(VIEW4("forward-fulfilled"));
  assert.deepEqual(fwd.counted, { wood: 4 });
  assert.deepEqual(fwd.effects, ["caravan_sent cv:77:1", "caravan_settled cv:77:1"]);
  const lost = resultOfRun4(VIEW4("forward-input-lost"));
  assert.equal(lost.state, "Failed");
  assert.equal(lost.actual.kind, "none");
  assert.deepEqual(lost.counted, {});
  assert.equal(resultOfRun4({ ...VIEW4("haul-fulfilled"), view_version: "p04-run/9" }).ok, false);
});
