// The owner's one budget, as the agent's executor enforces it and as the
// owner reads it.
//
// Two layers, never confused in the reports:
//   RELAY (real, the agent cannot go around it): the prepaid test-USDC balance, the policy's total and
//     per-day budget, the per-day model-call cap, the hold → sending → settled/released states
//     (AgentLedger, AgentGateway). Shared by every caller of the same agent.
//   EXECUTOR (this file, provisional until ② and the relay take it over): per-call, per-day and total
//     caps PER CATEGORY (inference apart from game spending). The model never holds the capability
//     token, so it cannot go around this layer; whoever holds the token directly can. Reservations
//     are synchronous inside one process: concurrent runs of one executor cannot both take the last
//     unit. Several processes on one agent are not covered (the relay patch is the fix).
import { CATEGORIES } from '../../../../permutation-gateway/src/frontier/agent/contract.mjs';

export const BUDGET = Object.freeze({ PER_CALL: 'PerCallLimit', CATEGORY_DAY: 'CategoryDayLimit', CATEGORY_TOTAL: 'CategoryTotalLimit' });
/** Refusals that mean "the budget is used up for now" (relay codes and this layer's). */
export const BUDGET_STOP_CODES = new Set(['InsufficientBalance', 'BudgetExceeded', 'DailyLimitReached', 'CallLimitReached', ...Object.values(BUDGET)]);

const big = v => BigInt(v ?? 0);
const dayOf = ms => new Date(ms).toISOString().slice(0, 10);

export class BudgetError extends Error {
  constructor(code, message, extra = {}) { super(message); this.code = code; Object.assign(this, extra); }
}

/**
 * Executor-side caps per category. `caps`:
 *   { perCall: {inference, game}, perDay: {inference, game}, total: {inference, game} }   base units; a missing cap is no cap here (the relay's still hold)
 */
export class BudgetGuard {
  constructor({ caps = {}, now = () => Date.now() } = {}) {
    this.caps = { perCall: { ...(caps.perCall ?? {}) }, perDay: { ...(caps.perDay ?? {}) }, total: { ...(caps.total ?? {}) } };
    this.now = now;
    /** key → {category, amount, state: 'reserved'|'committed', day} */
    this.items = new Map();
  }

  #used(category, { day = null } = {}) {
    let t = 0n;
    for (const it of this.items.values()) if (it.category === category && (day === null || it.day === day)) t += big(it.amount);
    return t;
  }

  /** Synchronous: checks and records in one step. Throws BudgetError. Idempotent for a key already held. */
  reserve(key, category, amount) {
    if (!Object.values(CATEGORIES).includes(category)) throw new BudgetError('BadCategory', `unknown category ${category}`);
    if (this.items.has(key)) return this.items.get(key);
    const a = big(amount);
    const day = dayOf(this.now());
    const cap = (k) => (this.caps[k][category] === undefined ? null : big(this.caps[k][category]));
    if (cap('perCall') !== null && a > cap('perCall')) throw new BudgetError(BUDGET.PER_CALL, `${category}: ${a} is over the per-call cap ${cap('perCall')}`, { category, cap: String(cap('perCall')), amount: String(a) });
    if (cap('perDay') !== null && this.#used(category, { day }) + a > cap('perDay')) throw new BudgetError(BUDGET.CATEGORY_DAY, `${category}: today's ${this.#used(category, { day })} + ${a} is over the per-day cap ${cap('perDay')}`, { category });
    if (cap('total') !== null && this.#used(category) + a > cap('total')) throw new BudgetError(BUDGET.CATEGORY_TOTAL, `${category}: ${this.#used(category)} + ${a} is over the total cap ${cap('total')}`, { category });
    const it = { key, category, amount: String(a), state: 'reserved', day };
    this.items.set(key, it);
    return it;
  }

  /** The measured amount (≤ reserved) is what stays counted. */
  commit(key, amount) {
    const it = this.items.get(key);
    if (!it) return null;
    it.amount = String(big(amount) < big(it.amount) ? big(amount) : big(it.amount));
    it.state = 'committed';
    return it;
  }

  release(key) { return this.items.delete(key); }

  /** Rebuilds the counts after a restart from the journal's recorded charges (what the executor itself spent). */
  seed(journal) {
    for (const e of journal.entries) {
      if (e.step === 'plan') for (const a of e.attempts ?? []) if (big(a.charged) > 0n) this.items.set(`${e.runId}:plan:${a.attempt}`, { key: `${e.runId}:plan:${a.attempt}`, category: CATEGORIES.INFERENCE, amount: a.charged, state: 'committed', day: dayOf(e.at) });
      if (e.step === 'act-begin' && big(e.gamePrice) > 0n) this.items.set(`game:${e.attemptId}`, { key: `game:${e.attemptId}`, category: CATEGORIES.GAME, amount: e.gamePrice, state: 'reserved', day: dayOf(e.at) });
      if (e.step === 'act-result' && e.outcome !== 'sent') this.items.delete(`game:${e.attemptId}`);
      if (e.step === 'verify' && (e.outcome === 'failed' || e.outcome === 'expired')) { const b = journal.entries.findLast(x => x.key === e.key && x.step === 'act-begin'); if (b) this.items.delete(`game:${b.attemptId}`); }
    }
    return this;
  }

  toJSON() { return { caps: this.caps, items: [...this.items.values()] }; }
}

/**
 * What the owner reads: the balance apart (available, in flight, settled by category), every money line,
 * and what is in flight with whether a stop would still cancel it. From the relay's view (the ledger) only.
 */
export function statement(view) {
  const holds = view.holds ?? [];
  const inFlight = holds.map(h => ({
    holdId: h.id, category: h.category, amount: h.amount, state: h.state, key: h.key, signature: h.signature,
    ...(h.state === 'held' ? { cancellable: true, why: '送る前。停止すると予約は戻る' }
      : h.state === 'sending' ? { cancellable: false, why: '取引の署名が記録され、送った（または送る途中）。取り消せない。鎖の答えで確定か返金' }
        : h.state === 'running' ? { cancellable: false, why: 'モデルが考えている最中。停止しても、この呼び出しは支払う。決めた行動は送らない' }
          : h.state === 'unresolved' ? { cancellable: false, why: '結果が分からない呼び出し。運営の確認待ち' }
            : { cancellable: false, why: h.state }),
  }));
  const lines = (view.history ?? []).filter(h => h.type === 'spend' || h.type === 'release' || h.type === 'deposit' || h.type === 'withdraw' || h.type === 'network')
    .map(h => ({ at: h.at, type: h.type, category: h.category ?? (h.type === 'network' ? 'network' : null), amount: h.amount ?? null, lamports: h.lamports ?? null, key: h.key ?? null, model: h.model ?? null, reason: h.reason ?? null }));
  const b = view.balance;
  const sumHolds = st => holds.filter(h => h.state === st).reduce((s, h) => s + big(h.amount), 0n).toString();
  return {
    balance: {
      deposited: b.deposited, available: b.available, withdrawn: b.withdrawn, pendingWithdraw: b.pendingWithdraw,
      inFlight: { total: b.reserved, beforeSend: sumHolds('held'), sending: sumHolds('sending'), modelRunning: sumHolds('running'), unresolved: b.unresolved },
      settled: { inference: b.spent.inference, game: b.spent.game, network: b.spent.network },
    },
    networkFees: { paidBy: 'relay', recordedLamports: lines.filter(l => l.type === 'network').reduce((s, l) => s + big(l.lamports), 0n).toString() },
    budget: { policy: view.policy?.budget, today: view.day, mode: view.mode, policyVersion: view.policy?.version },
    lines, inFlight,
    sound: big(b.deposited) === big(b.available) + big(b.reserved) + big(b.spent.inference) + big(b.spent.network) + big(b.spent.game) + big(b.pendingWithdraw) + big(b.withdrawn),
  };
}

/**
 * One line per decision: what the agent thought, what it asked, what the relay accepted, what finally
 * happened, and what it cost — joined from the executor's journal and the relay's ledger lines.
 */
export function trace(journal, view) {
  const ledger = view.history ?? [];
  const runs = new Map();
  for (const e of journal.entries) {
    if (!e.runId) continue;
    const r = runs.get(e.runId) ?? { runId: e.runId, thought: null, inference: [], items: new Map() };
    runs.set(e.runId, r);
    if (e.step === 'plan') {
      r.thought = { by: e.by, configuredModel: e.configuredModel ?? null, servedModel: e.servedModel ?? null, modelFile: e.modelFile ?? null, proposals: e.proposals, notes: e.notes };
      r.inference = (e.attempts ?? []).map(a => ({ attempt: a.attempt, ok: a.ok, charged: a.charged, error: a.error ?? null, relayLine: ledger.find(l => l.type === 'spend' && l.category === 'inference' && l.key === `${e.runId}:plan:${a.attempt}`) ? 'settled' : (big(a.charged) > 0n ? 'not in the last 50 lines' : 'no charge') }));
    }
    if (e.step === 'guard' && e.requestId) {
      const it = r.items.get(e.key) ?? { requestId: e.requestId, key: e.key };
      Object.assign(it, { verdict: e.verdict, code: e.code, reason: e.reason, ownerDecision: e.ownerDecision ?? null });
      r.items.set(e.key, it);
    }
    if (e.step === 'act-begin') { const it = r.items.get(e.key) ?? { requestId: e.requestId, key: e.key }; it.request = e.args; it.gamePrice = e.gamePrice ?? '0'; r.items.set(e.key, it); }
    if (e.step === 'act-result' || e.step === 'act-error') {
      const it = r.items.get(e.key) ?? { requestId: e.requestId, key: e.key };
      it.accepted = { outcome: e.outcome, code: e.code ?? null, signature: e.signature ?? null };
      const idem = `mcp:${e.attemptId}`;
      const spend = ledger.find(l => l.type === 'spend' && l.category === 'game' && l.key === idem);
      const rel = ledger.find(l => l.type === 'release' && l.category === 'game' && l.key === idem);
      it.gameCost = spend ? { state: 'settled', amount: spend.amount } : rel ? { state: 'released', amount: '0', reason: rel.reason } : big(it.gamePrice ?? 0) > 0n ? { state: (view.holds ?? []).some(h => h.key === idem) ? 'reserved' : 'unknown', amount: it.gamePrice } : { state: 'free', amount: '0' };
      r.items.set(e.key, it);
    }
  }
  // The final word on each item is the latest verify/memory line for its key, wherever it was written.
  for (const r of runs.values()) for (const it of r.items.values()) {
    const v = journal.entries.findLast(e => e.key === it.key && (e.step === 'verify' || e.step === 'memory'));
    it.final = v ? { outcome: v.outcome, tx: v.tx ?? null, effect: v.effect ?? null } : (it.accepted ? { outcome: 'not checked yet' } : { outcome: it.verdict ?? 'none' });
  }
  return [...runs.values()].map(r => ({ ...r, items: [...r.items.values()] }));
}
