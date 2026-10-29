/**
 * MOCK execution of a prepared plan, for the prototype only.
 *
 * This is not the game. It sends nothing to a chain, a relay or a wallet.
 * It applies the composed effects to a copy of the world snapshot with the
 * S1/S2 rules' arithmetic (cargo debited and credited, 8 ore + 4 wood → 4
 * arms per use run, the ticket's and the workshop's daily runs), lets a
 * caravan arrive at once unless the caller asks for a raid, and writes
 * mock receipts into the mock ledger (④'s stand-in). A step that fails
 * stops the run and is recorded ("失敗は止まるだけ").
 */

import { clone, own } from "./canonical.mjs";
import { EFFECTS } from "./catalog.mjs";
import { place } from "./world.mjs";
import { preflight, resolve, stepOrder } from "./plan.mjs";

export async function simulateRun(signed, ctx, { raidAt = null, seq = 1 } = {}) {
  const check = await preflight(signed, ctx);
  if (!check.ready) return { ok: false, mock: true, preflight: check, receipts: [], log: [] };
  const plan = signed.plan;
  const m = ctx.registry.getVersion(plan.manifest).manifest;
  const world = clone(ctx.world);
  const params = plan.bindings.params;
  const today = world.today;
  const actor = check.actor;
  const log = [];
  const receipts = [];
  for (const [dep, u] of Object.entries(m.uses)) {
    if (u.relation !== "consume") continue;
    // preflight checked each receipt once; a race with another run is caught here
    if (!ctx.ledger.consume(check.receiptIds[dep], signed.hash)) return { ok: false, mock: true, preflight: check, receipts: [], log: [`${dep}: 完了記録はもう使われていた`] };
  }
  // A delivery's result belongs to whoever owns the place it reached; a run's to the plan's user.
  const base = { manifest: plan.manifest, planHash: signed.hash, runSeq: seq, actor, beneficiary: actor, day: today };
  for (const s of stepOrder(m)) {
    const spec = own(EFFECTS, s.effect);
    const outName = Object.keys(spec.outputs)[0];
    if (s.effect === "caravan.send") {
      const from = resolve(s.args.from, m, params), to = resolve(s.args.to, m, params);
      const cargo = Object.fromEntries(Object.entries(s.args.cargo.goods).map(([r, x]) => [r, resolve(x, m, params)]));
      if (!debit(world, from, cargo)) return stop(s, "送り元の在庫が足りない");
      if (raidAt === s.id) {
        receipts.push(ctx.ledger.record({ ...base, beneficiary: place(world, to)?.owner ?? null, step: s.id, port: outName, outputs: published(s.id, outName), outcome: "raided", final: true, at: to, goods: cargo }));
        return stop(s, "途中で襲われた（模擬）");
      }
      credit(world, to, cargo);
      receipts.push(ctx.ledger.record({ ...base, beneficiary: place(world, to)?.owner ?? null, step: s.id, port: outName, outputs: published(s.id, outName), outcome: "delivered", final: true, at: to, goods: cargo }));
      log.push(`${s.id}: 荷車 ${from} → ${to} ${fmt(cargo)}（模擬：すぐ着いた）`);
    } else if (s.effect === "workshop.run") {
      const vault = resolve(s.args.vault, m, params), runs = resolve(s.args.runs, m, params);
      const shop = resolve(s.args.via, m, params);
      const lot = world.lots[check.grantsUsed[s.args.via.use]];
      const need = scale(spec.takes.perRun, runs);
      if (!debit(world, vault, need)) return stop(s, "鉱石・木材が足りない");
      const made = scale(spec.makes.perRun, runs);
      credit(world, vault, made);
      lot.dayUsed = (lot.day === today ? lot.dayUsed ?? 0 : 0) + runs;
      lot.day = today;
      const h = place(world, shop);
      h.useRuns = (h.useDay === today ? h.useRuns ?? 0 : 0) + runs;
      h.useDay = today;
      receipts.push(ctx.ledger.record({ ...base, step: s.id, port: outName, outputs: published(s.id, outName), outcome: "made", final: true, at: vault, goods: made }));
      log.push(`${s.id}: ${shop} の工房を ${runs} 回（${vault} の中で ${fmt(need)} → ${fmt(made)}、模擬）`);
    }
  }
  return { ok: true, mock: true, world, receipts, log, preflight: check };

  /** The manifest's output names a step's port is published under (C consumes these). */
  function published(stepId, port) {
    return Object.entries(m.outputs).filter(([, o]) => o.from?.step === stepId && o.from?.out === port).map(([name]) => name).sort();
  }

  function stop(s, why) {
    receipts.push(ctx.ledger.record({ ...base, step: s.id, port: Object.keys(own(EFFECTS, s.effect).outputs)[0], outputs: published(s.id, Object.keys(own(EFFECTS, s.effect).outputs)[0]), outcome: "failed", final: true, reason: why }));
    log.push(`${s.id}: 止まった — ${why}`);
    return { ok: false, mock: true, world, receipts, log, stoppedAt: s.id, preflight: check };
  }
}


function scale(per, k) {
  return Object.fromEntries(Object.entries(per).map(([r, n]) => [r, n * k]));
}

function debit(world, id, goods) {
  const pl = place(world, id);
  if (!pl) return false;
  pl.stores ??= {};
  for (const [r, n] of Object.entries(goods)) if ((pl.stores[r] ?? 0) < n) return false;
  for (const [r, n] of Object.entries(goods)) pl.stores[r] -= n;
  return true;
}

function credit(world, id, goods) {
  const pl = place(world, id);
  if (!pl) return;
  pl.stores ??= {};
  for (const [r, n] of Object.entries(goods)) pl.stores[r] = Math.min((pl.stores[r] ?? 0) + n, pl.cap ?? Infinity);
}

const JA = { food: "食料", wood: "木材", stone: "石", ore: "鉱石", arms: "兵器", gold: "金", science: "学", influence: "影響" };
export function fmt(goods) {
  return Object.entries(goods).map(([r, n]) => `${JA[r] ?? r}${n}`).join("・") || "なし";
}
