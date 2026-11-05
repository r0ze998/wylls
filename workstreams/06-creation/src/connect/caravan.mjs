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

export const SOURCES = Object.freeze({
  rights: { ws: "02", ref: "preserve/ws02-rights-dc3bd3d", sha: "dc3bd3d93465eebb65f1815eb702ca779cc31827" },
  instructions: { ws: "03", ref: "preserve/ws03-mcp-acdcd0bf", sha: "acdcd0bf795d10a65f6b8192076c4f8d6357e557" },
  execution: { ws: "04", ref: "preserve/ws04-a967f5f1", sha: "a967f5f1c64facc32facf07010f39a679c77d80a" },
  extensions: { ws: "11", ref: "integration/ws09-13-v16-d0949fd4", sha: "ef63544c727490fc6801d30affd11c5b7106c480" },
});

/** The core's resource order (permutation-rules frontier/holding.rs `Resource`): cargo[8]. */
export const CORE_RESOURCES = Object.freeze(["food", "wood", "stone", "ore", "horses", "gold", "science", "influence"]);
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
    if (i < 0) problems.push({ resource: r, why: "コアの資源にない（cargo[8] に枠がない）" });
    else if (PLEDGE_ONLY.includes(r)) problems.push({ resource: r, why: "誓約にしか使えず、運べない" });
    else if (!Number.isSafeInteger(n) || n < 0 || n > 0xffffffff) problems.push({ resource: r, why: "u32 の整数単位でない" });
    else cargo[i] = n;
  }
  return { cargo, problems };
}

/**
 * Whether a definition connects to the delivered contracts, step by step.
 * Static: it reads the manifest only.
 */
export function connectability(m) {
  const reasons = [];
  for (const s of m.steps) {
    if (s.effect !== "caravan.send") {
      reasons.push({ step: s.id, effect: s.effect, why: NOT_CONNECTED[s.effect] ?? "既存の命令にない" });
      continue;
    }
    if ((s.after ?? []).length) {
      reasons.push({ step: s.id, why: "前の手順を待つ荷車。④の Run は荷車を1つ送るだけで、前の荷車の seq は前の Run が固定するまで分からない（④の inbound の受け渡しが未接続）" });
    }
    for (const r of Object.keys(s.args?.cargo?.goods ?? {})) {
      if (!CORE_RESOURCES.includes(r)) reasons.push({ step: s.id, resource: r, why: "コアの資源にない（cargo[8] に枠がない）" });
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
  const findings = [];
  const m = env.manifest;
  if (plan.manifest?.hash !== env.hash || plan.manifest?.version !== m.version || plan.manifest?.name !== m.name || plan.manifest?.author !== m.author) {
    return { ok: false, findings: [{ code: "PIN_MISMATCH", pinned: plan.manifest, given: { author: m.author, name: m.name, version: m.version, hash: env.hash } }] };
  }
  const c = connectability(m);
  if (!c.connectable) return { ok: false, findings: c.reasons.map((r) => ({ code: "NOT_CONNECTED", ...r })) };
  const now = effectRev({ effectRevs }, "caravan.send");
  if (confirmedRev(plan, "caravan.send") !== now) {
    return { ok: false, findings: [{ code: "EFFECT_REVISED", effect: "caravan.send", confirmed: confirmedRev(plan, "caravan.send"), now }] };
  }
  if (typeof nonce !== "string" || !nonce) return { ok: false, findings: [{ code: "SHAPE", detail: "nonce" }] };
  const params = plan.bindings?.params ?? {};
  const runs = [];
  for (const s of m.steps) {
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
      // kept by 06 beside the run id: ④'s Run has no field for the definition it came from
      pin: { planHash, manifest: { ...plan.manifest }, effects: { "caravan.send": confirmedRev(plan, "caravan.send") } },
      leftToExecutor: ["seq（④が署名の時に Citizen.CARAVANS から固定）", "steps・path（③の命令の組み立て）", `fee（${CARAVAN_FEE_MIN} lamports 以上、③）`],
    });
  }
  if (findings.length) return { ok: false, findings };
  return { ok: true, findings: [], runs, gaps: ["④の RunSpec.facility は必須。荷車だけの Run には facility を省ける形（Option）が要る（④への提案。仮の施設で埋めない）"] };
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

