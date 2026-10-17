// The agent wallet's ledger (docs/agent-wallet/DESIGN.md §4): one record per
// agent, kept in the relay's JSON state (config.mjs createStateStore: tmp
// file + rename), test-USDC base units as decimal strings.
//
// Per agent:
//   deposited        credited deposits (each deposit signature once, ever)
//   available        may be held for spending or withdrawn
//   reserved         held for an action in flight (a hold)
//   spent.{inference,network,game}   settled spending, by category
//   pendingWithdraw  taken out of `available` for a withdrawal being sent
//   withdrawn        withdrawals that landed
//
// Invariant (checked by `check`, asserted by the tests after every step):
//   deposited = available + reserved + Σspent + pendingWithdraw + withdrawn
//
// Every method is synchronous: the check and the change happen with no
// await in between, so two concurrent requests in this process cannot both
// pass the last unit of a balance or a budget. One relay process owns the
// file; several processes on one file are not supported (DESIGN.md §9).
//
// A hold's lifecycle: held → (sending, with the transaction's signature
// known before it is sent; or running, a model call in progress) → settled
// (spent ≤ held, the rest back to available) or released (all back). A stop
// (manual) and `expire` release `held` holds only: a `running` call is
// paid for when it returns (the owner's decision: a call made is a call
// charged; `expire` gives it back only past its own long TTL), and a
// `sending` hold is settled or released by its transaction's outcome alone
// (`reconcile` in gateway.mjs), so a timeout can never refund money whose
// action landed.
import { randomUUID } from 'node:crypto';
import { AgentError, CATEGORIES, ERR } from './contract.mjs';

const ZERO = '0';
const big = v => BigInt(v ?? 0);
const str = v => v.toString();
const HISTORY_MAX = 500;
const REQUESTS_MAX = 2_000;

/** The wall-clock budget day (UTC) of `ms`. */
export const budgetDay = ms => new Date(ms).toISOString().slice(0, 10);

export class AgentLedger {
  /** `store`: `{state, save()}`; the ledger lives in `state.agentWallet`. */
  constructor({ store = { state: {}, save() {} }, now = Date.now } = {}) {
    this.store = store;
    this.now = now;
    this.store.state ??= {};
    this.store.state.agentWallet ??= { agents: {}, deposits: {}, ownerNonces: {} };
  }

  get db() { return this.store.state.agentWallet; }
  save() { this.store.save(); }

  // ------------------------------------------------------------ agents

  create({ agentId = randomUUID(), owner, agentKey, village, policy }) {
    if (this.db.agents[agentId]) throw new AgentError(ERR.BAD_REQUEST, 'agent id taken', 409);
    const rec = {
      agentId, owner, payout: owner, agentKey, village: [...village], createdAt: this.now(),
      mode: 'manual', modeEpoch: 0,
      capabilityHash: null, capabilityVersion: 0,
      policy: { ...policy, version: 1 },
      bal: { deposited: ZERO, available: ZERO, reserved: ZERO, pendingWithdraw: ZERO, withdrawn: ZERO,
        spent: { [CATEGORIES.INFERENCE]: ZERO, [CATEGORIES.NETWORK]: ZERO, [CATEGORIES.GAME]: ZERO } },
      day: { key: budgetDay(this.now()), spent: ZERO },
      holds: {}, withdrawals: {}, requests: {}, history: [],
    };
    this.db.agents[agentId] = rec;
    this.note(rec, { type: 'created', owner, agentKey });
    this.save();
    return rec;
  }

  get(agentId) {
    const rec = this.db.agents[agentId];
    if (!rec) throw new AgentError(ERR.UNKNOWN_AGENT, 'no such agent', 404);
    return rec;
  }

  agents() { return Object.values(this.db.agents); }
  agentsOf(owner) { return this.agents().filter(a => a.owner === owner); }
  byKey(agentKey) { return Object.values(this.db.agents).find(a => a.agentKey === agentKey) ?? null; }

  note(rec, entry) {
    rec.history.push({ at: this.now(), ...entry });
    if (rec.history.length > HISTORY_MAX) rec.history.splice(0, rec.history.length - HISTORY_MAX);
  }

  // ------------------------------------------------------------ owner-set state

  /** A new policy (owner command only): its version is the old one + 1, so requests decided under the old one are refused. */
  setPolicy(agentId, policy) {
    const rec = this.get(agentId);
    rec.policy = { ...policy, version: rec.policy.version + 1 };
    this.note(rec, { type: 'policy', version: rec.policy.version });
    this.save();
    return rec.policy;
  }

  /** Mode change (owner command only): bumps the epoch, so work started in the old mode cannot send. Manual releases every `held` hold. */
  setMode(agentId, mode) {
    const rec = this.get(agentId);
    if (rec.mode === mode) return rec;
    rec.mode = mode;
    rec.modeEpoch += 1;
    if (mode === 'manual') for (const h of Object.values(rec.holds)) if (h.state === 'held') this.#release(rec, h, 'stopped');
    this.note(rec, { type: 'mode', mode, epoch: rec.modeEpoch });
    this.save();
    return rec;
  }

  // ------------------------------------------------------------ money in

  /** Credits a verified deposit once per transaction signature (across all agents). */
  credit(agentId, signature, amount) {
    const rec = this.get(agentId);
    const prior = this.db.deposits[signature];
    if (prior) return { credited: false, agentId: prior.agentId, amount: prior.amount };
    const a = big(amount);
    if (a <= 0n) throw new AgentError(ERR.DEPOSIT_INVALID, 'deposit amount must be positive');
    this.db.deposits[signature] = { agentId, amount: str(a), at: this.now() };
    rec.bal.deposited = str(big(rec.bal.deposited) + a);
    rec.bal.available = str(big(rec.bal.available) + a);
    this.note(rec, { type: 'deposit', amount: str(a), signature });
    this.save();
    return { credited: true, agentId, amount: str(a) };
  }

  // ------------------------------------------------------------ spending

  #rollDay(rec) {
    const key = budgetDay(this.now());
    if (rec.day.key !== key) rec.day = { key, spent: ZERO };
  }

  #heldTotal(rec, filter = () => true) {
    let t = 0n;
    for (const h of Object.values(rec.holds)) if (filter(h)) t += big(h.amount);
    return t;
  }

  /**
   * Holds `amount` of `category` for an action (key: the request's
   * idempotency key). Refuses with InsufficientBalance (available),
   * BudgetExceeded (policy.budget.total over the agent's whole spending:
   * settled + held) or DailyLimitReached (policy.budget.perDay over today's
   * settled + held). A zero amount makes a hold that only records.
   */
  hold(agentId, { category, amount, key, ttlMs = 120_000, policyVersion, modeEpoch }) {
    const rec = this.get(agentId);
    if (!Object.values(CATEGORIES).includes(category)) throw new AgentError(ERR.BAD_REQUEST, `unknown category ${category}`);
    const a = big(amount);
    if (a < 0n) throw new AgentError(ERR.BAD_REQUEST, 'negative amount');
    this.#rollDay(rec);
    if (a > 0n) {
      if (a > big(rec.bal.available)) throw new AgentError(ERR.INSUFFICIENT_BALANCE, `balance ${rec.bal.available} is less than ${a}`, 402, { available: rec.bal.available, needed: str(a) });
      const spentAll = Object.values(rec.bal.spent).reduce((s, v) => s + big(v), 0n);
      const total = big(rec.policy.budget.total);
      if (spentAll + big(rec.bal.reserved) + a > total) throw new AgentError(ERR.BUDGET_EXCEEDED, `budget ${total} would be exceeded`, 402, { budget: str(total), used: str(spentAll + big(rec.bal.reserved)) });
      const perDay = big(rec.policy.budget.perDay);
      const today = big(rec.day.spent) + this.#heldTotal(rec);
      if (today + a > perDay) throw new AgentError(ERR.DAILY_LIMIT, `daily limit ${perDay} would be exceeded`, 402, { perDay: str(perDay), today: str(today) });
    }
    const h = { id: randomUUID(), category, amount: str(a), key, state: 'held', createdAt: this.now(), expiresAt: this.now() + ttlMs, policyVersion, modeEpoch };
    rec.holds[h.id] = h;
    rec.bal.available = str(big(rec.bal.available) - a);
    rec.bal.reserved = str(big(rec.bal.reserved) + a);
    this.save();
    return { ...h };
  }

  /** The hold's model call is running: a stop no longer releases it; its return settles it (`expire` past its TTL is the only other way out). */
  markRunning(agentId, holdId) {
    const h = this.get(agentId).holds[holdId];
    if (!h) throw new AgentError(ERR.BAD_REQUEST, 'no such hold');
    h.state = 'running';
    this.save();
  }

  /** The hold's transaction is about to be sent: from here only its outcome (`lastValidBlockHeight` bounds it) settles or releases it. */
  markSending(agentId, holdId, signature, lastValidBlockHeight = null) {
    const h = this.get(agentId).holds[holdId];
    if (!h) throw new AgentError(ERR.BAD_REQUEST, 'no such hold');
    h.state = 'sending';
    h.signature = signature;
    h.lastValidBlockHeight = lastValidBlockHeight;
    this.save();
  }

  /** Spends `spent` (≤ held) of a hold; the rest goes back to available. */
  settle(agentId, holdId, spent, ref = {}) {
    const rec = this.get(agentId);
    const h = rec.holds[holdId];
    if (!h) return false; // settled or released already: idempotent
    const s = spent === undefined ? big(h.amount) : big(spent);
    if (s < 0n || s > big(h.amount)) throw new AgentError(ERR.BAD_REQUEST, `settle ${s} outside 0..${h.amount}`);
    this.#rollDay(rec);
    delete rec.holds[holdId];
    rec.bal.reserved = str(big(rec.bal.reserved) - big(h.amount));
    rec.bal.available = str(big(rec.bal.available) + big(h.amount) - s);
    rec.bal.spent[h.category] = str(big(rec.bal.spent[h.category]) + s);
    rec.day.spent = str(big(rec.day.spent) + s);
    this.note(rec, { type: 'spend', category: h.category, amount: str(s), key: h.key, ...ref });
    this.save();
    return true;
  }

  #release(rec, h, reason) {
    delete rec.holds[h.id];
    rec.bal.reserved = str(big(rec.bal.reserved) - big(h.amount));
    rec.bal.available = str(big(rec.bal.available) + big(h.amount));
    if (big(h.amount) > 0n) this.note(rec, { type: 'release', category: h.category, amount: h.amount, key: h.key, reason });
  }

  /** Gives a whole hold back (nothing was spent). Idempotent. */
  release(agentId, holdId, reason = 'released') {
    const rec = this.get(agentId);
    const h = rec.holds[holdId];
    if (!h) return false;
    this.#release(rec, h, reason);
    this.save();
    return true;
  }

  /** Releases `held` and `running` holds past their expiry (never `sending` ones); returns how many. */
  expire() {
    let n = 0;
    for (const rec of Object.values(this.db.agents)) {
      for (const h of Object.values(rec.holds)) if ((h.state === 'held' || h.state === 'running') && h.expiresAt <= this.now()) { this.#release(rec, h, 'expired'); n++; }
    }
    if (n) this.save();
    return n;
  }

  /** A network fee the relay paid in SOL for this agent's transaction: history only (no USDC moves; DESIGN.md §6). */
  recordNetwork(agentId, { lamports, signature, key }) {
    const rec = this.get(agentId);
    this.note(rec, { type: 'network', category: CATEGORIES.NETWORK, amount: ZERO, lamports: String(lamports), paidBy: 'relay', signature, key });
    this.save();
  }

  // ------------------------------------------------------------ money out

  /** Moves `amount` from available to a pending withdrawal (to the agent's fixed payout). */
  holdWithdraw(agentId, amount) {
    const rec = this.get(agentId);
    const a = big(amount);
    if (a <= 0n) throw new AgentError(ERR.BAD_REQUEST, 'withdraw amount must be positive');
    if (a > big(rec.bal.available)) throw new AgentError(ERR.INSUFFICIENT_BALANCE, `available ${rec.bal.available} is less than ${a}`, 402, { available: rec.bal.available });
    const w = { id: randomUUID(), amount: str(a), payout: rec.payout, state: 'pending', createdAt: this.now() };
    rec.withdrawals[w.id] = w;
    rec.bal.available = str(big(rec.bal.available) - a);
    rec.bal.pendingWithdraw = str(big(rec.bal.pendingWithdraw) + a);
    this.save();
    return { ...w };
  }

  withdrawSending(agentId, id, signature, lastValidBlockHeight = null) {
    const w = this.get(agentId).withdrawals[id];
    w.state = 'sending';
    w.signature = signature;
    w.lastValidBlockHeight = lastValidBlockHeight;
    this.save();
  }

  finishWithdraw(agentId, id) {
    const rec = this.get(agentId);
    const w = rec.withdrawals[id];
    if (!w || w.state === 'done' || w.state === 'failed') return false;
    w.state = 'done';
    rec.bal.pendingWithdraw = str(big(rec.bal.pendingWithdraw) - big(w.amount));
    rec.bal.withdrawn = str(big(rec.bal.withdrawn) + big(w.amount));
    this.note(rec, { type: 'withdraw', amount: w.amount, payout: w.payout, signature: w.signature });
    this.save();
    return true;
  }

  /** The withdrawal certainly did not land: its amount goes back to available. */
  failWithdraw(agentId, id, reason) {
    const rec = this.get(agentId);
    const w = rec.withdrawals[id];
    if (!w || w.state === 'done' || w.state === 'failed') return false;
    w.state = 'failed';
    w.reason = reason;
    rec.bal.pendingWithdraw = str(big(rec.bal.pendingWithdraw) - big(w.amount));
    rec.bal.available = str(big(rec.bal.available) + big(w.amount));
    this.note(rec, { type: 'withdraw-failed', amount: w.amount, reason });
    this.save();
    return true;
  }

  // ------------------------------------------------------------ records

  /** A game action the gateway sent (or refused after a hold): history only. */
  recordAction(agentId, entry) {
    this.note(this.get(agentId), { type: 'action', ...entry });
    this.save();
  }

  /** The sha256 (hex) of the agent's current capability token; the token itself is never stored. */
  setCapability(agentId, hash) {
    const rec = this.get(agentId);
    rec.capabilityHash = hash;
    rec.capabilityVersion += 1;
    this.note(rec, { type: 'capability', version: rec.capabilityVersion });
    this.save();
    return rec.capabilityVersion;
  }

  // ------------------------------------------------------------ idempotency

  request(agentId, key) { return this.get(agentId).requests[key] ?? null; }

  remember(agentId, key, hash, result) {
    const rec = this.get(agentId);
    rec.requests[key] = { hash, result, at: this.now() };
    const keys = Object.keys(rec.requests);
    if (keys.length > REQUESTS_MAX) for (const k of keys.slice(0, keys.length - REQUESTS_MAX)) delete rec.requests[k];
    this.save();
  }

  // ------------------------------------------------------------ views and checks

  /** Balance as callers see it (strings). */
  balance(agentId) {
    const b = this.get(agentId).bal;
    return { available: b.available, reserved: b.reserved, pendingWithdraw: b.pendingWithdraw, withdrawn: b.withdrawn, deposited: b.deposited, spent: { ...b.spent } };
  }

  /** Every agent's books balance; returns the problems (empty when sound). */
  check() {
    const out = [];
    for (const rec of Object.values(this.db.agents)) {
      const b = rec.bal;
      const spent = Object.values(b.spent).reduce((s, v) => s + big(v), 0n);
      const sum = big(b.available) + big(b.reserved) + spent + big(b.pendingWithdraw) + big(b.withdrawn);
      if (sum !== big(b.deposited)) out.push(`${rec.agentId}: deposited ${b.deposited} ≠ ${sum}`);
      for (const k of ['available', 'reserved', 'pendingWithdraw', 'withdrawn']) if (big(b[k]) < 0n) out.push(`${rec.agentId}: ${k} negative`);
      const held = this.#heldTotal(rec);
      if (held !== big(b.reserved)) out.push(`${rec.agentId}: reserved ${b.reserved} ≠ holds ${held}`);
    }
    return out;
  }

  /** What the custody token account must hold at least: everything not yet spent or withdrawn. */
  liabilities() {
    let t = 0n;
    for (const rec of Object.values(this.db.agents)) t += big(rec.bal.available) + big(rec.bal.reserved) + big(rec.bal.pendingWithdraw);
    return t;
  }
}
