/**
 * 06's caravan connection checked against the delivered code of ③ and ④,
 * not against 06's own copies of their contracts.
 *
 *   WS03_ROOT   a checkout of ③ (claude/modest-goldberg-c180fk, 84f710d5…)
 *   WS04_ROOT   a checkout of ④ (claude/gallant-ride-cunptv, cf517b55…)
 *   RUNEXEC_BIN ④'s `runexec`, built from WS04_ROOT (cargo build --release --bin runexec)
 *   WS06_RUN4_STORE  optional: a store ④'s executor wrote on 06's specs (handoff/ws04-check)
 *
 * Without them every test is skipped. Nothing here generates, imports,
 * derives or uses a key, or signs: the crypto guard below is installed
 * before any of ③'s or ④'s modules is loaded (dynamic imports), so a key
 * operation at load time fails the run too. The wallet's answers come from
 * a scripted loopback `GET /f/agent/fate`, the way ④'s own act tests do;
 * the road (steps, path) and the seq are fixtures standing in for ③'s
 * planner, which reads the chain.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

for (const k of ["generateKey", "importKey", "exportKey", "deriveKey", "deriveBits", "sign", "verify"]) {
  globalThis.crypto.subtle[k] = () => { throw new Error(`crypto.subtle.${k} called in a no-key test`); };
}

const { WS03_ROOT, WS04_ROOT, RUNEXEC_BIN } = process.env;
const skip = !(WS03_ROOT && WS04_ROOT && RUNEXEC_BIN) && "set WS03_ROOT, WS04_ROOT and RUNEXEC_BIN to check against ③ and ④";
const load = (root, rel) => import(pathToFileURL(join(root, rel)).href);

const { contentHash } = await import("../src/canonical.mjs");
const { mineDelivery } = await import("../src/scenario.mjs");
const C = await import("../src/connect/caravan.mjs");

const AUTHOR = "ab".repeat(32);
const VIEW = {
  citizenTag: "41",
  agent: { village: [2, -1, 3] },
  village: { kind: "holding", p: 2, q: -1, site: 3, gen: 1, tile: 11, placeId: "village:2,-1,3" },
  places: [
    { kind: "holding", p: 2, q: -1, site: 3, gen: 1, tile: 11, placeId: "village:2,-1,3" },
    { kind: "vault", p: 2, q: -1, tile: 7, gen: 1, known: true, placeId: "vault:2,-1,7" },
    { kind: "vault", p: 3, q: -1, tile: 4, gen: 2, known: true, placeId: "vault:3,-1,4" },
  ],
};

function call(nonce = "r1", params = { mine: "vault:2,-1,7", buyer: "vault:3,-1,4", ore: 24, wood: 12, arms: 0 }) {
  const m = mineDelivery(AUTHOR);
  const env = { manifest: m, hash: contentHash(m) };
  const plan = { format: "wylls.creation.plan/1", manifest: { author: m.author, name: m.name, version: m.version, hash: env.hash }, actor: "cd".repeat(32), bindings: { params, grants: {} }, preparedDay: 12, effects: { "caravan.send": 1 } };
  const r = C.toMcpCaravans({ plan, planHash: contentHash(plan), env, nonce, view: VIEW });
  assert.equal(r.ok, true, JSON.stringify(r.findings));
  return r.calls[0];
}

test("③: S1's resource order, the owner-only places, the requestId rule and the field builders are the ones 06 uses", { skip }, async () => {
  const game = await load(WS03_ROOT, "workstreams/03-composability/mcp/src/game.mjs");
  assert.deepEqual(game.RESOURCES_S1.map((r) => r.toLowerCase()), [...C.CORE_RESOURCES]);
  const c = call();
  // ③'s own place lookup: 06's placeIds resolve; another player's place does not
  assert.equal(game.Game.placeOf(VIEW, c.prepare.from).placeId, "vault:2,-1,7");
  assert.equal(game.Game.placeOf(VIEW, c.prepare.to).gen, 2);
  assert.throws(() => game.Game.placeOf(VIEW, "vault:9,9,1"), (e) => e.code === "NotYourPlace");
  // ③'s requestId pattern, read from its source (tools.mjs pulls the OAuth module, not loaded here)
  const src = readFileSync(join(WS03_ROOT, "workstreams/03-composability/mcp/src/tools.mjs"), "utf8");
  const re = new RegExp(src.match(/REQUEST_ID = \/(.+)\/;/)[1]);
  assert.equal(re.source, C.REQUEST_ID.source);
  assert.ok(re.test(c.requestId));
  // the web client's builders, as ③'s planner calls them
  const fplay = await load(WS03_ROOT, "permutation-server/web/frontier/fplay.mjs");
  const bytes = Array.from(fplay.cargoBytes(c.prepare.cargo));
  assert.equal(bytes.length, 32);
  assert.deepEqual([bytes[4], bytes[12]], [12, 24], "wood in slot 1, ore in slot 3, little-endian u32");
  assert.deepEqual(fplay.placeData({ kind: "vault", p: 3, q: -1, tile: 4, gen: 2 }), { dst_kind: 2, dst_p: 3, dst_q: -1, dst_at: 4, dst_gen: 2 });
});

test("④'s gateway accepts the action ③ would build from 06's call; the key fits", { skip }, async (t) => {
  let parseActionRequest;
  try {
    ({ parseActionRequest } = await load(WS04_ROOT, "permutation-gateway/src/frontier/agent/contract.mjs"));
  } catch (e) {
    // the gateway's npm dependencies (@solana/web3.js …) are not installed here, and nothing is installed for this check
    if (e.code === "ERR_MODULE_NOT_FOUND") return t.skip(`not run: ${e.message.split(" imported from")[0]} (the gateway's dependencies are not installed)`);
    throw e;
  }
  const fplay = await load(WS03_ROOT, "permutation-server/web/frontier/fplay.mjs");
  const c = call();
  const dst = VIEW.places.find((p) => p.placeId === c.prepare.to);
  // as ③'s server.mjs builds it (source mcp, key ws03:<linkId>:<requestId>); seq, steps, path: fixtures for ③'s planner
  const request = {
    agentId: "agent-1", source: "mcp", idempotencyKey: `ws03:link-0123456789abcdef:${c.requestId}`, policyVersion: 1,
    action: {
      name: "SendCaravan", holding: VIEW.agent.village,
      fields: { seq: 0, ...fplay.placeData(dst), steps: 2, path: new Array(12).fill(0), cargo: Array.from(fplay.cargoBytes(c.prepare.cargo)), fee: String(C.CARAVAN_FEE_MIN) },
      route: { src: { kind: "vault", p: 2, q: -1, tile: 7 }, dst: { kind: "vault", p: 3, q: -1, tile: 4 }, provinces: [{ p: 2, q: -1 }, { p: 3, q: -1 }] },
    },
  };
  const parsed = parseActionRequest(request);
  assert.equal(parsed.action.name, "SendCaravan");
  assert.ok(parsed.idempotencyKey.length <= 128);
  // 06 is not one of the wallet's sources: the act goes as ③'s (mcp)
  assert.throws(() => parseActionRequest({ ...request, source: "ws06" }), (e) => e.code === "BadRequest");
});

// the requester as the gateway's credential layer hands it over: public addresses only, nothing authenticated here
const ADDR = (n) => "1".repeat(31) + n;
const REQ = { actor: ADDR("A"), generation: 1, citizen: ADDR("C"), authenticatedBy: "test: the gateway's credential layer (stand-in)" };
const fixtureSpecs = () => JSON.parse(readFileSync(new URL("../fixtures/connect/ws06-runspecs.json", import.meta.url), "utf8"));

test("④'s RunSpec takes 06's caravan-only spec (facility: Option, ④ 30a3fd2e and later)", { skip }, () => {
  const model = readFileSync(join(WS04_ROOT, "workstreams/04-execution/src/model.rs"), "utf8");
  const spec = model.slice(model.indexOf("pub struct RunSpec"), model.indexOf("}", model.indexOf("pub struct RunSpec")));
  assert.match(spec, /pub facility: Option<FacilityRef>,/);
});

test("④ run accept: 06 hands the spec and the upstream requester through ④'s own client; a refusal is held as an answer", { skip }, async () => {
  const { createRunsClient } = await load(WS04_ROOT, "workstreams/04-execution/clients/runs.mjs");
  const { run4FromRunexec } = await import("../src/connect/ports.mjs");
  const db = join(mkdtempSync(join(tmpdir(), "ws06-runs-")), "runs.db");
  // no node at 127.0.0.1:9: ④ cannot read the pass, so nothing is admitted (④ reads the chain; 06 never decides who may run)
  const runs = createRunsClient({ bin: RUNEXEC_BIN, db, rpc: "http://127.0.0.1:9", program: ADDR("P"), season: ADDR("S") });
  const port = run4FromRunexec({ runs, bin: RUNEXEC_BIN, db });
  const [haul] = fixtureSpecs();
  await assert.rejects(port.accept(haul, REQ), (e) => e.code === "NotAuthorized" && e.definitive === true);
  // a requester 06 would have to complete is refused by ④'s client before runexec is started
  await assert.rejects(port.accept(haul, { ...REQ, authenticatedBy: "" }), (e) => e.code === "BadRequest" && e.definitive === true);
  // the same through the dispatcher: held, the run id unchanged, nothing retried
  const { Dispatch } = await import("../src/connect/dispatch.mjs");
  const { relayRequest } = await import("../cli/connect-fixture.mjs");
  let saved = null;
  const d = new Dispatch({ journal: { load: () => saved, save: (o) => { saved = JSON.parse(JSON.stringify(o)); } }, run4: port });
  const p = d.plan({ route: "run", ...relayRequest(), requester: REQ });
  const st = await d.advance(p.key);
  assert.equal(st.steps[0].state, "held");
  assert.match(st.steps[0].why, /NotAuthorized/);
  assert.equal(st.steps[0].runId, haul.run_id);
  assert.equal(st.complete, false);
});

test("④ run view: 06 reads ④'s own store with the real runexec; arrival and amount from ④'s judgement", { skip: skip || (!process.env.WS06_RUN4_STORE && "set WS06_RUN4_STORE (a store ④'s executor wrote on 06's specs: handoff/ws04-check)") }, async () => {
  const { run4FromRunexec } = await import("../src/connect/ports.mjs");
  const db = process.env.WS06_RUN4_STORE;
  const port = run4FromRunexec({ runs: { accept: async () => { throw new Error("not used"); } }, bin: RUNEXEC_BIN, db });
  const [haul, fwd] = fixtureSpecs();
  const vh = await port.view(haul.run_id), vf = await port.view(fwd.run_id);
  for (const v of [vh, vf]) {
    const r = C.resultOfRun4(v);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.state, "Fulfilled");
    assert.deepEqual(r.counted, { wood: 4 });
  }
  assert.deepEqual(vf.spec.inbound, { owner: 119, seq: vh.detail.ship_seq }, "the second waited for the first caravan");
  assert.equal(await port.view("ws06:none:x:y"), null, "NoRecord from a store that was read");
  const nowhere = run4FromRunexec({ runs: {}, bin: RUNEXEC_BIN, db: join(mkdtempSync(join(tmpdir(), "ws06-none-")), "no-such-store.db") });
  await assert.rejects(nowhere.view(haul.run_id), (e) => e.code === "StoreUnavailable", "a missing store is no answer, not NoRecord");
});

test("③'s rules in its source: requestId and runId patterns, the cargo names, the plan answers 06 treats as re-plan", { skip }, () => {
  const tools = readFileSync(join(WS03_ROOT, "workstreams/03-composability/mcp/src/tools.mjs"), "utf8");
  const server = readFileSync(join(WS03_ROOT, "workstreams/03-composability/mcp/src/server.mjs"), "utf8");
  const re = (name) => new RegExp(tools.match(new RegExp(`export const ${name} = /(.+)/;`))[1]);
  assert.equal(re("RUN_ID").source, C.RUN_ID.source);
  const c = call();
  assert.ok(re("REQUEST_ID").test(c.requestId) && re("RUN_ID").test(c.runId), `${c.requestId} ${c.runId}`);
  const longest = C.runIdOf("f".repeat(64), "n".repeat(16), "s".repeat(40));
  assert.ok(longest && re("RUN_ID").test(longest) && longest.length <= 128, "the longest 06 run id fits ③ and ④");
  assert.equal(C.runIdOf("f".repeat(64), "n".repeat(17), "s"), null);
  for (const code of ["PlanUnknown", "PlanUsed", "PlanExpired", "PlanStale", "IdempotencyConflict", "NotResent", "RunRegistryUnavailable"]) assert.ok(server.includes(`fail('${code}'`), code);
  // the requestId check comes before the plan lookup: a gone plan is answered only when nothing was sent under the requestId
  assert.ok(server.indexOf("const prior = store.operation(opId)") < server.indexOf("fail('PlanUnknown'"));
  const names = tools.match(/\[('Food'[^\]]+)\]/)[1].split(",").map((x) => x.trim().replace(/'/g, ""));
  assert.deepEqual(names.map((x) => x.toLowerCase()), [...C.CORE_RESOURCES]);
  assert.match(tools, /name: 'get_run_status'/);
});

/** A loopback GET /f/agent/fate?id=&key= answering per key, chunked like the wallet. */
async function fateServer(answers) {
  const seen = [];
  const srv = createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    seen.push(u.pathname + u.search);
    const a = u.pathname === "/f/agent/fate" ? answers.get(u.searchParams.get("key")) : null;
    res.writeHead(a ? 200 : 404, { "content-type": "application/json" });
    const body = JSON.stringify(a ?? { error: "UnknownAgent" });
    res.write(body.slice(0, 7));
    res.end(body.slice(7));
  });
  await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
  return { port: srv.address().port, seen, close: () => new Promise((ok) => srv.close(ok)) };
}

const signed = (state) => ({ state, sent: true, signature: "sigA", lastValidBlockHeight: 5000, slotFloor: 4000, signedAt: 1_762_000_000_000, commitment: state === "landed" ? "finalized" : "confirmed", why: state });

test("④'s act registry: 06's run id is kept with the act; the seven fates read back; none completes 06's run", { skip }, async () => {
  const { createActsClient, ActsError } = await load(WS04_ROOT, "workstreams/04-execution/clients/acts.mjs");
  const db = join(mkdtempSync(join(tmpdir(), "ws06-acts-")), "runs.db");
  const answers = new Map();
  const srv = await fateServer(answers);
  try {
    const acts = createActsClient({ bin: RUNEXEC_BIN, db, gatewayPort: srv.port });
    const agentId = "agent-1";
    const keyOf = (c) => `ws03:link-0123456789abcdef:${c.requestId}`;
    const c = call("r1");
    // registered before the send: idempotent, tied to 06's run id; another run under the same key is refused
    const r1 = await acts.register({ agentId, key: keyOf(c), source: c.register.source, runId: c.runId });
    const r2 = await acts.register({ agentId, key: keyOf(c), source: c.register.source, runId: c.runId });
    assert.equal(r1.run4Id, r2.run4Id);
    await assert.rejects(acts.register({ agentId, key: keyOf(c), source: "mcp", runId: `${c.runId}:other` }), (e) => e instanceof ActsError && e.code === "Conflict");
    const first = await acts.status({ agentId, key: keyOf(c) }, { read: false });
    assert.equal(first.runId, c.runId, "④ keeps 06's run id: the act stays tied to the pinned definition");
    assert.equal(C.resultOfAct(first).state, "registered");
    assert.equal(C.resultOfAct(first).complete, false);

    // each fate, through the real runexec and the scripted wallet
    const fates = { pending: signed("pending"), unknown: signed("unknown"), unqueryable: { state: "unqueryable", retained: false, why: "not kept here" }, landed: signed("landed"), failed: signed("failed"), expired: signed("expired"), "not-sent": { state: "not-sent", sent: false, why: "refused before signing" } };
    const results = {};
    const callOf = {};
    for (const [i, [state, answer]] of Object.entries(fates).entries()) {
      const ci = call(`f${i}`);
      answers.set(keyOf(ci), answer);
      await acts.register({ agentId, key: keyOf(ci), source: "mcp", runId: ci.runId });
      const rec = await acts.status({ agentId, key: keyOf(ci) });
      assert.equal(rec.state, state);
      const r = C.resultOfAct(rec);
      assert.equal(r.ok, true);
      assert.equal(r.runId, ci.runId);
      results[state] = r;
      callOf[state] = ci;
    }
    for (const r of Object.values(results)) {
      assert.equal(r.complete, false);
      assert.deepEqual(r.counted, {});
    }
    assert.equal(results.landed.delivery, "not-verified", "landed is the send, not the arrival");
    assert.equal(results.unknown.hold, true);
    assert.equal(results.unknown.newRequestAllowed, false, "a result-unknown send is never re-sent");
    assert.equal(results.unqueryable.sendFinal, false);
    assert.equal(results.expired.newRequestAllowed, true);
    assert.equal(results["not-sent"].newRequestAllowed, true);
    assert.equal(results.landed.newRequestAllowed, false);
    assert.ok(srv.seen.some((p) => p.startsWith("/f/agent/fate?id=agent-1&key=ws03")), "runexec read the wallet's route");

    // a final fate is not undone by a later contradicting read
    const cl = callOf.landed;
    answers.set(keyOf(cl), signed("expired"));
    const again = await acts.status({ agentId, key: keyOf(cl) });
    assert.equal(again.state, "landed");
    assert.equal(again.conflict?.state, "expired");
    assert.ok(C.resultOfAct(again).conflict);

    // every act of one 06 run id is listed
    const listed = await acts.list(c.runId);
    const rows = Array.isArray(listed) ? listed : listed.acts ?? listed.receipts ?? [];
    assert.equal(rows.length, 1);
    assert.equal(rows[0].runId ?? rows[0].ext_run, c.runId);
  } finally {
    await srv.close();
  }
});
