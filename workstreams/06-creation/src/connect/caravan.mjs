/**
 * The connection of 06's adopted caravan steps to the delivered contracts of
 * ③ (the SendCaravan instruction) and ④ (Run, Outcome, Receipt).
 *
 * Sources, read from GitHub (docs/11-connection.ja.md has the paths):
 *   ② preserve/ws02-rights-dc3bd3d  dc3bd3d93465eebb65f1815eb702ca779cc31827
 *       StockSwap is not adopted and is not a right to use a workshop: no
 *       06 step connects to it.
 *   ③ preserve/ws03-mcp-acdcd0bf    acdcd0bf795d10a65f6b8192076c4f8d6357e557
 *       SendCaravan (0xB1): seq = Citizen.CARAVANS, destination
 *       kind/p/q/at/gen, steps, path, cargo[8] whole units, fee >= 50,000;
 *       a session key sends only between the owner's own places.
 *   ④ preserve/ws04-a967f5f1        a967f5f1c64facc32facf07010f39a679c77d80a
 *       RunSpec, the 15 run states, Outcome and Verification
 *       (src/model.rs), Receipt (docs/CONTRACTS §3), the quantity contract.
 *   ④ claude/gallant-ride-cunptv    d0e96d5394d88decf878676f37bc3782654d1045
 *       (first read at 8e96f24d) the act registry (`runexec act`,
 *       clients/acts.mjs) and the seven send fates
 *       (docs/EXECUTION-CONTRACT-20261106). RunSpec still needs a facility
 *       there; ④ 30a3fd2e makes it optional (a cargo-only run), so a
 *       caravan-only run (and a second one waiting for it as its inbound)
 *       is ④'s run end to end. ④'s accept/view command is being written
 *       in ④ (not arrived).
 *   Two routes, both here: the act route (06 plan → ③ prepare_caravan /
 *       send_caravan → the agent wallet → ④ `act register --run <06 run
 *       id>`), which knows the send only; and the run route (06 plan → ④
 *       `run accept` → ④'s executor → `run view`), which judges arrival and
 *       the amount under ④'s quantity contract.
 *
 * Only `caravan.send` connects: it is the one instruction in main's S1
 * among 06's effects. A workshop step is S2's UseRun, copied as a mock.
 *
 * Nothing here signs, sends, reads a chain or derives a key. The run spec
 * leaves to ④ and ③ what only they can fix: the caravan's seq (read from
 * the Citizen when ④ signs), the path, and the fee.
 */

import { confirmedRev, effectRev } from "../catalog.mjs";
import { resolve } from "../plan.mjs";
import { stepOrder } from "../manifest.mjs";
import { contentHash } from "../canonical.mjs";

export const SOURCES = Object.freeze({
  rights: { ws: "02", ref: "preserve/ws02-rights-dc3bd3d", sha: "dc3bd3d93465eebb65f1815eb702ca779cc31827" },
  instructions: { ws: "03", ref: "preserve/ws03-mcp-acdcd0bf", sha: "acdcd0bf795d10a65f6b8192076c4f8d6357e557" },
  execution: { ws: "04", ref: "preserve/ws04-a967f5f1", sha: "a967f5f1c64facc32facf07010f39a679c77d80a" },
  acts: { ws: "04", ref: "claude/gallant-ride-cunptv", sha: "d0e96d5394d88decf878676f37bc3782654d1045" },
  extensions: { ws: "11", ref: "integration/ws09-13-v16-d0949fd4", sha: "ef63544c727490fc6801d30affd11c5b7106c480" },
});

/**
 * cargo[8] in S1's resource order: permutation-rules frontier/holding.rs
 * `Resource`, where S1's arms take the Horses slot (arms.rs `ARMS =
 * Resource::Horses`; ③'s `RESOURCES_S1`). The same order as 06's types.
 */
export const CORE_RESOURCES = Object.freeze(["food", "wood", "stone", "ore", "arms", "gold", "science", "influence"]);
/** Science and influence can only be pledged, never moved (holding.rs). */
export const PLEDGE_ONLY = Object.freeze(["science", "influence"]);
/** ③ 02-instruction-matrix: SendCaravan's fee is at least 50,000 lamports. */
export const CARAVAN_FEE_MIN = 50_000;

/** ④ src/model.rs `RunState`. */
export const RUN_STATES = Object.freeze([
  "Accepted", "Reserved", "FacilityRequested", "FacilitySubmitted", "FacilityConfirmed",
  "ShipRequested", "ShipSubmitted", "InTransit", "Arrived",
  "Fulfilled", "Partial", "DeliveredUnverified", "Failed", "Cancelled", "Expired",
]);
export const TERMINAL = Object.freeze(["Fulfilled", "Partial", "DeliveredUnverified", "Failed", "Cancelled", "Expired"]);
/** ④ `Verification`. */
export const VERIFICATIONS = Object.freeze(["Recorded", "RuleDerived", "KnownZero", "Unverifiable", "NotShipped"]);

const NOT_CONNECTED = {
  "workshop.run": "S2 の UseRun の模擬（未統合）。②の StockSwap は加工能力の貸出ではなく、代替にしない",
  "receipt.withdraw": "S2（未統合）の命令",
  "shares.withdraw": "S2（未統合）の命令",
};

/** The cargo of a step as cargo[8] in the core's order, or the reasons it cannot be. */
export function coreCargo(goods) {
  const cargo = new Array(CORE_RESOURCES.length).fill(0);
  const problems = [];
  for (const [r, n] of Object.entries(goods)) {
    const i = CORE_RESOURCES.indexOf(r);
    if (i < 0) problems.push({ resource: r, why: "S1 の資源にない（cargo[8] に枠がない）" });
    else if (PLEDGE_ONLY.includes(r)) problems.push({ resource: r, why: "誓約にしか使えず、運べない" });
    else if (!Number.isSafeInteger(n) || n < 0 || n > 0xffffffff) problems.push({ resource: r, why: "u32 の整数単位でない" });
    else cargo[i] = n;
  }
  return { cargo, problems };
}

/**
 * Whether a definition connects to the delivered contracts, step by step.
 * Static: it reads the manifest only.
 *
 * `chains`: a caravan step may wait for one earlier caravan step whose
 * destination is its source (④'s run carries the earlier caravan as its
 * `inbound` and waits for the goods at its stock). Only ④'s run route
 * takes it; ③'s MCP route plans one caravan at a time.
 */
export function connectability(m, { chains = false } = {}) {
  const reasons = [];
  const byId = new Map(m.steps.map((s) => [s.id, s]));
  const same = (a, b) => { try { return contentHash(a ?? null) === contentHash(b ?? null); } catch { return false; } };
  for (const s of m.steps) {
    if (s.effect !== "caravan.send") {
      reasons.push({ step: s.id, effect: s.effect, why: NOT_CONNECTED[s.effect] ?? "既存の命令にない" });
      continue;
    }
    const after = s.after ?? [];
    if (after.length && !chains) {
      reasons.push({ step: s.id, why: "前の手順を待つ荷車。③の MCP は荷車を1つずつ計画するので、この経路では待てない（④の Run の経路で inbound として待つ）" });
    } else if (after.length) {
      const prev = after.length === 1 && typeof after[0] === "string" ? byId.get(after[0]) : null;
      if (!prev || prev.effect !== "caravan.send") reasons.push({ step: s.id, why: "待てるのは、前の荷車の手順1つだけ" });
      else if (!same(prev.args?.to, s.args?.from)) reasons.push({ step: s.id, why: "前の荷車の届け先が、この荷車の送り元でない（④の inbound は同じ倉で待つ）" });
    }
    for (const r of Object.keys(s.args?.cargo?.goods ?? {})) {
      if (!CORE_RESOURCES.includes(r)) reasons.push({ step: s.id, resource: r, why: "S1 の資源にない（cargo[8] に枠がない）" });
      else if (PLEDGE_ONLY.includes(r)) reasons.push({ step: s.id, resource: r, why: "誓約にしか使えず、運べない" });
    }
  }
  for (const [dep, u] of Object.entries(m.uses ?? {})) {
    reasons.push({ use: dep, relation: u.relation, why: u.relation === "consume" ? "完了結果の消費（C）は④の Receipt との対応が未接続" : "権利の接続（B）に当たる②の契約がない" });
  }
  return { connectable: reasons.length === 0, reasons };
}

const placeRef = (p) => ({ kind: p.kind, p: p.p, q: p.q, at: p.at, gen: p.gen });

/**
 * ④ run specs for one accepted run request of an adopted plan.
 *
 *   plan      the plan's content (the signature is checked before, by 06)
 *   planHash  its content hash
 *   env       the pinned definition { manifest, hash }
 *   nonce     the run request's nonce (one per request)
 *   places    (logicalId) => { kind, p, q, at, gen, ownerTag } | null:
 *             the place record ④/③ read from the chain; 06 never invents it
 *   ownerTag  the actor's citizen_tag
 *   deadlineSlot, budget  ④'s RunSpec fields, decided outside 06 (⑤ for the budget)
 *   effectRevs  the running world's effect revisions (default: the catalog's)
 *
 * ④'s RunSpec has a required facility. A caravan-only run has none, so
 * `facility` is null here and the gap is reported: it is not filled with
 * a placeholder facility.
 */
export function toRunSpecs({ plan, planHash, env, nonce, places, ownerTag, deadlineSlot, budget, effectRevs }) {
  // see the doc above: ④ 30a3fd2e and later accept the spec as is (cargo-only run)
  const findings = [];
  const m = env.manifest;
  if (plan.manifest?.hash !== env.hash || plan.manifest?.version !== m.version || plan.manifest?.name !== m.name || plan.manifest?.author !== m.author) {
    return { ok: false, findings: [{ code: "PIN_MISMATCH", pinned: plan.manifest, given: { author: m.author, name: m.name, version: m.version, hash: env.hash } }] };
  }
  const c = connectability(m, { chains: true });
  if (!c.connectable) return { ok: false, findings: c.reasons.map((r) => ({ code: "NOT_CONNECTED", ...r })) };
  const now = effectRev({ effectRevs }, "caravan.send");
  if (confirmedRev(plan, "caravan.send") !== now) {
    return { ok: false, findings: [{ code: "EFFECT_REVISED", effect: "caravan.send", confirmed: confirmedRev(plan, "caravan.send"), now }] };
  }
  if (typeof nonce !== "string" || !nonce) return { ok: false, findings: [{ code: "SHAPE", detail: "nonce" }] };
  const params = plan.bindings?.params ?? {};
  const runs = [];
  for (const s of stepOrder(m)) {
    const fromId = resolve(s.args.from, m, params), toId = resolve(s.args.to, m, params);
    const src = typeof fromId === "string" ? places(fromId) : null;
    const dst = typeof toId === "string" ? places(toId) : null;
    if (!src) findings.push({ code: "PLACE_UNRESOLVED", step: s.id, place: fromId ?? null });
    if (!dst) findings.push({ code: "PLACE_UNRESOLVED", step: s.id, place: toId ?? null });
    const goods = {};
    for (const [r, x] of Object.entries(s.args.cargo?.goods ?? {})) goods[r] = resolve(x, m, params);
    const { cargo, problems } = coreCargo(goods);
    for (const p of problems) findings.push({ code: "CARGO", step: s.id, ...p });
    if (!src || !dst || problems.length) continue;
    if (src.ownerTag !== ownerTag) { findings.push({ code: "NOT_OWNER", step: s.id, place: fromId }); continue; }
    runs.push({
      step: s.id,
      spec: {
        run_id: `ws06:${planHash}:${nonce}:${s.id}`,
        owner: ownerTag,
        stock: placeRef(src),
        inbound: null,
        facility: null,
        inputs: new Array(CORE_RESOURCES.length).fill(0),
        outputs: new Array(CORE_RESOURCES.length).fill(0),
        rights_units: 0,
        ship: { dst: placeRef(dst), cargo },
        deadline_slot: deadlineSlot,
        budget,
      },
      // ④ holds a send to another's place for the sender's own wallet (WalletRequired)
      walletRequired: dst.ownerTag !== ownerTag,
      // the earlier caravan step this run waits for: its caravan becomes this spec's inbound (bindInbound)
      awaits: typeof s.after?.[0] === "string" ? s.after[0] : null,
      // kept by 06 beside the run id: ④'s Run has no field for the definition it came from
      pin: { planHash, manifest: { ...plan.manifest }, effects: { "caravan.send": confirmedRev(plan, "caravan.send") } },
      leftToExecutor: ["seq（④が署名の時に Citizen.CARAVANS から固定）", "steps・path（③の命令の組み立て）", `fee（${CARAVAN_FEE_MIN} lamports 以上、③）`],
    });
  }
  if (findings.length) return { ok: false, findings };
  return {
    ok: true, findings: [], runs,
    // ④ 30a3fd2e and later take `facility: null` (a cargo-only run); checked against 6984acfa
    needs4: "30a3fd2e",
    gaps: ["④の受付・照会の CLI は④で作成中（未着）。⑥は RunSpec の JSON と実行 id を渡す側まで"],
  };
}

/** ④'s states after which a run's caravan is known: its key may be another run's inbound. */
const SHIPPED = ["InTransit", "Arrived", "Fulfilled", "Partial", "DeliveredUnverified"];

/**
 * The next step's spec, once the step it waits for has shipped: its
 * caravan (owner, seq, read from ④'s run view) becomes the inbound. ④ then
 * waits for the goods at the next run's stock, and fails it (InputLost)
 * only on evidence that the caravan was lost. The next step relies on the
 * canonical stock, never on the amount the earlier run reported.
 */
export function bindInbound(entry, prevEntry, prevView) {
  if (!entry.awaits || entry.awaits !== prevEntry.step) return { ok: false, code: "SHAPE", detail: "this run does not wait for that step" };
  const v = readRunView(prevView);
  if (!v.ok) return v;
  if (v.runId !== prevEntry.spec.run_id) return { ok: false, code: "SHAPE", detail: "the view is of another run" };
  if (["Failed", "Cancelled", "Expired"].includes(v.state)) return { ok: false, code: "INBOUND_STOPPED", state: v.state, why: "前の荷車は送られなかった・止まった。次の手順は始めない" };
  if (!SHIPPED.includes(v.state) || !Number.isSafeInteger(v.view.detail?.ship_seq)) return { ok: false, code: "WAIT", state: v.state, why: "前の荷車がまだ道に出ていない（連番が決まっていない）" };
  return { ok: true, spec: { ...entry.spec, inbound: { owner: v.view.spec.owner, seq: v.view.detail.ship_seq } } };
}

function readRunView(view) {
  if (view?.viewVersion !== "p04-run/0.1") return { ok: false, code: "SHAPE", detail: `view version ${view?.viewVersion}` };
  if (!RUN_STATES.includes(view.state)) return { ok: false, code: "SHAPE", detail: `unknown run state ${view.state}` };
  return { ok: true, runId: view.runId, state: view.state, view };
}

/**
 * 06's result from a ④ run view: the same reading as `resultOf`. PROVISIONAL
 * shape (`p04-run/0.1`: runId, state, held, cancel, detail.outcome,
 * detail.ship_seq, spec) — 06's guess, used by the dispatch tests; ④'s
 * accept/view command, being written in ④, defines the real one, and this
 * reader follows it when it arrives.
 */
export function resultOfRun4(view) {
  const v = readRunView(view);
  if (!v.ok) return v;
  return resultOf({ run_id: view.runId, state: view.state, outcome: view.detail?.outcome ?? null, held_reason: view.held ?? null, cancel_phase: view.cancel ?? null });
}

/** ③'s placeIds: `vault:p,q,tile` and `village:p,q,site` (mcp/src/game.mjs). */
export const PLACE_ID = /^(vault|village):-?\d+,-?\d+,\d+$/;
/** ③'s requestId (mcp/src/tools.mjs REQUEST_ID). */
export const REQUEST_ID = /^[A-Za-z0-9._:-]{8,100}$/;

/**
 * The ③ MCP calls for one accepted run request of an adopted plan, on the
 * owner's view as ③'s `get_village_status` returns it (`places` lists only
 * the owner's own village and storehouses, with `placeId` and `gen`).
 * The plan binds its place params to those placeIds.
 *
 * For each step: the `prepare_caravan` arguments ({from, to, cargo[8]}),
 * the `send_caravan` requestId (derived from the plan, the request and the
 * step, so a retry of the same decision reuses it), and 06's run id, which
 * ③ passes to ④ as `act register --run` so the act stays tied to the
 * pinned definition. ③ computes the road, the seq and the fields; 06 does
 * not. A place that is not the owner's is refused: ③ plans only between
 * the owner's places, and a send to another player needs the sender's
 * wallet, which this route never holds.
 */
export function toMcpCaravans({ plan, planHash, env, nonce, view, effectRevs }) {
  const m = env.manifest;
  if (plan.manifest?.hash !== env.hash || plan.manifest?.version !== m.version || plan.manifest?.name !== m.name || plan.manifest?.author !== m.author) {
    return { ok: false, findings: [{ code: "PIN_MISMATCH", pinned: plan.manifest, given: { author: m.author, name: m.name, version: m.version, hash: env.hash } }] };
  }
  const c = connectability(m);
  if (!c.connectable) return { ok: false, findings: c.reasons.map((r) => ({ code: "NOT_CONNECTED", ...r })) };
  const now = effectRev({ effectRevs }, "caravan.send");
  if (confirmedRev(plan, "caravan.send") !== now) return { ok: false, findings: [{ code: "EFFECT_REVISED", effect: "caravan.send", confirmed: confirmedRev(plan, "caravan.send"), now }] };
  if (typeof nonce !== "string" || !/^[A-Za-z0-9._-]{1,32}$/.test(nonce)) return { ok: false, findings: [{ code: "SHAPE", detail: "nonce: 1–32 of A–Z a–z 0–9 . _ -" }] };
  if (!/^[0-9a-f]{64}$/.test(planHash)) return { ok: false, findings: [{ code: "SHAPE", detail: "planHash" }] };
  const mine = new Map((view?.places ?? []).map((p) => [p.placeId, p]));
  const params = plan.bindings?.params ?? {};
  const findings = [];
  const calls = [];
  for (const s of m.steps) {
    const from = resolve(s.args.from, m, params), to = resolve(s.args.to, m, params);
    for (const [end, id] of [["from", from], ["to", to]]) {
      if (typeof id !== "string" || !PLACE_ID.test(id)) findings.push({ code: "PLACE_UNRESOLVED", step: s.id, end, place: id ?? null, why: "③ の placeId（vault:p,q,tile / village:p,q,site）で束ねる" });
      else if (!mine.has(id)) findings.push({ code: "NOT_YOUR_PLACE", step: s.id, end, place: id, why: "③ は持ち主の場所の間だけを計画する。他人の場所あては送り手の財布の署名が要り、この経路では送らない" });
    }
    const goods = {};
    for (const [r, x] of Object.entries(s.args.cargo?.goods ?? {})) goods[r] = resolve(x, m, params);
    const { cargo, problems } = coreCargo(goods);
    for (const p of problems) findings.push({ code: "CARGO", step: s.id, ...p });
    if (!cargo.some((n) => n > 0)) findings.push({ code: "CARGO", step: s.id, why: "空の荷車（③ は NoCargo）" });
    if (findings.length) continue;
    const runId = `ws06:${planHash}:${nonce}:${s.id}`;
    calls.push({
      step: s.id,
      prepare: { from, to, cargo },
      requestId: `ws06.${contentHash({ planHash, nonce, step: s.id }).slice(0, 48)}`,
      runId,
      // what 06 saw of the places when it prepared: ③ puts dst.gen in the fields; a later change of gen is a new place
      places: { from: { placeId: from, gen: mine.get(from).gen }, to: { placeId: to, gen: mine.get(to).gen } },
      pin: { planHash, manifest: { ...plan.manifest }, effects: { "caravan.send": confirmedRev(plan, "caravan.send") } },
      register: { source: "mcp", runId, keyOf: "ws03:<linkId>:<requestId>（③ が linkId を入れる）" },
    });
  }
  if (findings.length) return { ok: false, findings };
  return { ok: true, findings: [], calls, citizenTag: view.citizenTag ?? null };
}

const ACT_STATES = ["registered", "not-sent", "landed", "failed", "expired", "pending", "unknown", "unqueryable"];
const ACT_SAYS = {
  registered: "登録だけ。まだ照会していない",
  pending: "送信は未確定（待つ）",
  unknown: "結果不明：着地したかもしれない。再送しない（保留）",
  unqueryable: "照会できなかった：送信について何も言っていない（読み直す）",
  landed: "送信が確定した（荷車は道の上）。到着と量はまだ分からない",
  failed: "送信が確定的に失敗した（手数料は払った、効果なし）",
  expired: "送信が届かなかったと証明された。新しい依頼でだけやり直せる",
  "not-sent": "何も送られていない。新しい依頼でだけやり直せる",
};

/**
 * 06's reading of a ④ act receipt (`p04-acts/0.1`). An act is the send
 * only: `landed` means the caravan left, not that it arrived, so nothing
 * here is ever complete or counted. Arrival and the amount kept come from
 * the settle record under ④'s quantity contract (`resultOf` on a run),
 * which the act registry does not hold. A retry is a new 06 run request
 * (a new nonce, so a new requestId and key), never the same key.
 */
export function resultOfAct(receipt) {
  if (receipt?.receiptVersion !== "p04-acts/0.1") return { ok: false, code: "SHAPE", detail: `receipt version ${receipt?.receiptVersion}` };
  if (!ACT_STATES.includes(receipt.state)) return { ok: false, code: "SHAPE", detail: `unknown act state ${receipt.state}` };
  const s = receipt.state;
  return {
    ok: true,
    runId: receipt.runId ?? null,
    state: s,
    says: ACT_SAYS[s],
    sendFinal: ["not-sent", "landed", "failed", "expired"].includes(s),
    complete: false,
    counted: {},
    delivery: s === "landed" ? "not-verified" : "none-yet",
    hold: s === "unknown",
    newRequestAllowed: receipt.newAttemptAllowed === true && (s === "expired" || s === "not-sent"),
    conflict: receipt.conflict ?? null,
    signature: receipt.signature ?? null,
  };
}

const byName = (res) => Object.fromEntries(CORE_RESOURCES.map((r, i) => [r, res[i]]).filter(([, n]) => n));

/**
 * 06's view of a ④ run: whether it ended, what may be counted, what is
 * known of the amount that arrived, and whether it may serve as the
 * evidence of a finished delivery (C). Follows ④'s quantity contract:
 * only Fulfilled and Partial count, at their verified lower bound; an
 * unverified arrival counts 0 but its amount is unknown, never 0.
 */
export function resultOf(run) {
  if (!RUN_STATES.includes(run.state)) return { ok: false, code: "SHAPE", detail: `unknown run state ${run.state}` };
  const o = run.outcome ?? null;
  const v = o?.verification ?? null;
  if (v !== null && !VERIFICATIONS.includes(v)) return { ok: false, code: "SHAPE", detail: `unknown verification ${v}` };
  const final = TERMINAL.includes(run.state);
  const verified = (run.state === "Fulfilled" || run.state === "Partial") && (v === "Recorded" || v === "RuleDerived") && Array.isArray(o.delivered);
  let actual;
  if (!o || !final) actual = { kind: "pending" };
  else if (v === "Recorded" || v === "RuleDerived") actual = { kind: "at-least", lower: byName(o.delivered), below: "lower + 1（資源ごと）" };
  else if (v === "KnownZero") actual = { kind: "zero" };
  else if (v === "NotShipped") actual = { kind: "none" };
  else actual = { kind: "unknown", below: o.cargo_logged ? byName(o.cargo_logged.map((n) => n + 1)) : null };
  return {
    ok: true,
    runId: run.run_id ?? null,
    state: run.state,
    final,
    held: run.held_reason ?? null,
    cancel: run.cancel_phase ?? null,
    counted: verified ? byName(o.delivered) : {},
    actual,
    effects: o?.effects ?? [],
    evidence: verified ? { usable: true, lowerBound: byName(o.delivered) } : { usable: false, why: final ? `${run.state}${v ? `/${v}` : ""} は検証済みの配達ではない` : "まだ終わっていない" },
  };
}

/** ④ receipts without duplicates: the same event read from the feed and from history differs only in `source`. */
export function dedupeReceipts(receipts) {
  const seen = new Map();
  for (const r of receipts) {
    const k = `${r.kind}|${r.subject}`;
    if (!seen.has(k)) seen.set(k, r);
  }
  return [...seen.values()];
}

