// The agent wallet's one entry point (docs/agent-wallet/DESIGN.md §3): the
// browser (owner commands), the operator's AI runner and a future MCP
// server all call `AgentGateway.submit(request, credential)`, and every
// request passes the same checks in the same order before anything is
// signed or charged:
//
//   credential (owner signature, capability token, or the in-process runner)
//   → idempotency key (a repeat returns the recorded result; a different
//     request under the same key is IdempotencyConflict)
//   → mode is auto (AgentStopped) → policy version and mode epoch are current
//   → the action is allowed by the policy (never a NEVER_DELEGATED one)
//   → the action is on the agent's own village
//   → a hold of the action's USDC price (InsufficientBalance / BudgetExceeded
//     / DailyLimitReached; the price table is empty: existing actions stay
//     free or resource-paid)
//   → on chain, the Citizen's session key is the agent's key and unexpired
//   → the transaction is built here (accountsFor), signed by the agent's
//     key, and goes through the relay's own `sponsor()` (shape allowlist,
//     quota, simulation, drain guard); `beforeSend` re-checks mode and
//     policy synchronously just before the bytes leave.
//
// Every check and every ledger change before the first `await` is
// synchronous, so concurrent requests cannot both pass the last unit of a
// balance or budget. Nothing here holds a secret: the agent keys stay in
// the keyring, the custody key in Custody; views and errors carry public
// keys only.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { encode as base58 } from '../../../client/src/base58.mjs';
import { fromBase64 } from '../../../client/src/bytes.mjs';
import { ixOf } from '../../../client/src/frontier/codec.mjs';
import { profileForSeason } from '../../../client/src/frontier/profile.mjs';
import { classify, shapeMessage } from '../../../client/src/frontier/shapes.mjs';
import { parseTransaction, wireTransaction } from '../../../client/src/solana-tx.mjs';
import { signatureOf, signedBy } from '../../cosign.mjs';
import { simulateWatching } from '../chain.mjs';
import { drainGuard } from '../shapes.mjs';
import { landed } from '../routes/prize.mjs';
import { signAs } from '../routes/relay.mjs';
import { PublicKey } from '@solana/web3.js';
import { RouteError } from '../../routes/errors.mjs';
import { feeOf } from '../shapes.mjs';
import { sponsor } from '../routes/relay.mjs';
import { AgentError, CATEGORIES, ERR, MODES, parseActionRequest, RESULT_STATUS, SOURCES, isAmount } from './contract.mjs';
import { AgentLedger , budgetDay } from './ledger.mjs';
import { canonical, isPubkey } from './owner-auth.mjs';
import { checkAllowed, normalisePolicy } from './policy.mjs';

export const MAX_AGENTS_PER_OWNER = 8;
/** Build's walls item: the only profile-1 Build that names the Province (web fplay.mjs ITEM_WALLS). */
export const ITEM_WALLS = 6;
/** How long an action's hold may stay `held` before `expire` gives it back (the relay path takes seconds). */
export const ACTION_HOLD_TTL_MS = 120_000;
/** A model call's hold: long enough for a slow local model. */
export const INFERENCE_HOLD_TTL_MS = 10 * 60_000;
/** Default per-call test price of one model call (base units; 0.01 test USDC). TEST VALUE. */
export const DEFAULT_INFERENCE_PRICE = '10000';

const sha256hex = s => createHash('sha256').update(s).digest('hex');
const big = v => BigInt(v ?? 0);

/**
 * The accounts of an agent action's shape, recomputed here from the
 * season's addresses (the mirror of the web client's fplay.accountsFor for
 * the delegable actions; the fee payer is added by shapeMessage).
 */
export function accountsFor(name, { addresses: A, actor, owner, holding: [p, q, site], fields = {}, profile = 1 }) {
  const cq = profile === 2;
  const base = { actor, season: A.season, citizen: A.citizen(owner) };
  const holding = A.holding(p, q, site);
  const province = A.province(p, q);
  switch (name) {
    case 'SetVigil': return base;
    case 'Harvest': case 'Train': return { ...base, holding, ...(cq ? { province } : {}) };
    case 'Build': return { ...base, holding, ...(cq || Number(fields.item) === ITEM_WALLS ? { province } : {}) };
    case 'Muster': case 'Garrison': return { ...base, holding, province };
    case 'Dissolve': case 'Explore': case 'Depart': return { ...base, holding, province, ...(cq ? { holding_province: province } : {}) };
    default: throw new AgentError(ERR.ACTION_NOT_ALLOWED, `${name} is not an action an agent sends`, 403);
  }
}

/**
 * Instruction fields from JSON: integers as numbers or decimal strings,
 * byte fields as arrays of bytes or base64 strings. Unknown fields are
 * refused (BadRequest); missing ones are the codec's error.
 */
export function normaliseFields(name, fields, profile = 1) {
  const ix = ixOf(name, profile);
  if (!ix?.data) throw new AgentError(ERR.BAD_REQUEST, `${name}: unknown instruction`);
  const known = new Set(ix.data.map(f => f.name));
  for (const k of Object.keys(fields)) if (!known.has(k)) throw new AgentError(ERR.BAD_REQUEST, `${name}: unknown field ${k}`);
  const out = {};
  for (const f of ix.data) {
    const v = fields[f.name];
    if (v === undefined) continue;
    if (Array.isArray(v)) out[f.name] = Uint8Array.from(v);
    else if (typeof v === 'number' && Number.isInteger(v)) out[f.name] = v;
    else if (typeof v === 'string' && /^-?\d{1,20}$/.test(v)) out[f.name] = BigInt(v);
    else if (typeof v === 'string') { try { out[f.name] = fromBase64(v); } catch { throw new AgentError(ERR.BAD_REQUEST, `${name}.${f.name}: not an integer, byte list or base64`); } }
    else throw new AgentError(ERR.BAD_REQUEST, `${name}.${f.name}: not an integer, byte list or base64`);
  }
  return out;
}

const resultOf = (rec, key, status, extra = {}) => ({
  ok: status === RESULT_STATUS.SENT, requestId: key, agentId: rec.agentId, status, policyVersion: rec.policy.version, modeEpoch: rec.modeEpoch, charges: [], ...extra,
});

export class AgentGateway {
  /**
   * @param {object} o
   * @param {object} o.ctx       the relay context (pool, chain, blockhashes, connection, addresses, programId, quota, relayed, sent, log)
   * @param {object} o.ledger    AgentLedger
   * @param {object} o.keyring   AgentKeyring
   * @param {object} o.custody   Custody (deposits and withdrawals); null disables money in and out (tests of the rest)
   * @param {object} [o.prices]  {inference: base units per model call, game: {actionName: base units}}
   * @param {object} [o.waits]   {withdraw: {tries, every}} how long `withdraw` waits for the chain before leaving it to reconcile
   */
  constructor({ ctx, ledger, keyring, custody = null, prices = {}, waits = {}, unresolvedReleaseMs = null, now = Date.now, log = () => {} }) {
    /** The proposed deadline rule (§6.5): null keeps unresolved holds until the operator decides. Not a default. */
    this.unresolvedReleaseMs = Number.isFinite(unresolvedReleaseMs) && unresolvedReleaseMs > 0 ? unresolvedReleaseMs : null;
    this.ctx = ctx;
    this.ledger = ledger;
    this.keyring = keyring;
    this.custody = custody;
    this.prices = { inference: String(prices.inference ?? DEFAULT_INFERENCE_PRICE), game: { ...(prices.game ?? {}) } };
    for (const [k, v] of Object.entries(this.prices.game)) if (!isAmount(v)) throw new Error(`game price of ${k}: ${v} is not a base-unit amount`);
    if (!isAmount(this.prices.inference)) throw new Error(`inference price ${this.prices.inference} is not a base-unit amount`);
    this.waits = { withdraw: { tries: 40, every: 250, ...(waits.withdraw ?? {}) }, deposit: { tries: 60, every: 250, ...(waits.deposit ?? {}) } };
    this.now = now;
    this.log = log;
    /** In-flight submits by `agentId\nkey` → {hash, promise}: a concurrent repeat shares the promise. */
    this.inflight = new Map();
    this.recover();
  }

  // ------------------------------------------------------------ startup

  /**
   * After a restart: a `held` hold is given back (its request died before
   * anything was sent); a `running` model call becomes `unresolved` (the
   * call may have run: the money stays reserved, nothing is guessed, the
   * operator decides or the operator's cost record keeps it); `unresolved`
   * ones stay as they are (a second restart changes nothing); `sending`
   * ones wait for `reconcile`.
   */
  recover() {
    let released = 0;
    let unresolved = 0;
    for (const rec of this.ledger.agents()) {
      for (const h of Object.values(rec.holds)) {
        if (h.state === 'held') { this.ledger.release(rec.agentId, h.id, 'restart'); released++; }
        else if (h.state === 'running' && this.ledger.markUnresolved(rec.agentId, h.id, 'restart')) unresolved++;
      }
    }
    if (released || unresolved) this.log(`agent wallet: after a restart, ${released} hold(s) released and ${unresolved} model call(s) left unresolved`);
    return { released, unresolved };
  }

  /**
   * The operator's decision on an `unresolved` model call: 'charge' (the
   * owner pays the fixed price) or 'refund' (the owner gets it back and the
   * operator's cost record keeps the call). Only an unresolved hold can be
   * decided; a hold whose result arrived in the meantime is settled already.
   */
  settleUnresolved(agentId, holdId, outcome, note = '', { by = 'operator', claimedBy = null, evidence = '' } = {}) {
    const rec = this.ledger.get(agentId);
    const h = rec.holds[holdId];
    if (!h || h.state !== 'unresolved') throw new AgentError(ERR.BAD_REQUEST, 'no unresolved hold with this id (decided, settled by a late result, or released already)', 404);
    if (outcome !== 'charge' && outcome !== 'refund') throw new AgentError(ERR.BAD_REQUEST, 'outcome must be charge or refund');
    // `by` is what the credential identifies (the route passes operatorPrincipal: listener, token fingerprint, address);
    // `claimedBy` is the caller's own label, recorded as a claim and never as the identity.
    const who = typeof by === 'string' ? { via: String(by).slice(0, 64) } : { via: String(by?.via ?? 'operator').slice(0, 64), ...(by?.token ? { token: String(by.token).slice(0, 16) } : {}), ...(by?.ip ? { ip: String(by.ip).slice(0, 64) } : {}) };
    const claim = claimedBy === null || claimedBy === undefined ? null : String(claimedBy).slice(0, 64);
    const audit = { holdId, key: h.key, amount: h.amount, model: h.model ?? null, unresolvedReason: h.unresolvedReason ?? null, unresolvedAt: h.unresolvedAt ?? null, outcome, note: String(note).slice(0, 200), evidence: String(evidence).slice(0, 500), by: who, claimedBy: claim };
    if (outcome === 'charge') this.ledger.settle(agentId, holdId, undefined, { decidedBy: who, claimedBy: claim, note: audit.note, evidence: audit.evidence });
    else {
      this.ledger.release(agentId, holdId, 'operator-refund');
      this.ledger.recordOperatorCost({ agentId, kind: 'refunded-call', holdId, key: h.key, amount: h.amount, note: audit.note, by: who, claimedBy: claim });
    }
    this.ledger.recordSettlement({ agentId, ...audit });
    this.log(`agent wallet: ${who.via}${who.token ? ' ' + who.token : ''}${who.ip ? ' from ' + who.ip : ''}${claim ? ' (claims ' + claim + ')' : ''} ${outcome}d unresolved call ${holdId} of ${agentId} (${audit.note})`);
    return { holdId, outcome, by: who, claimedBy: claim, balance: this.ledger.balance(agentId) };
  }

  /** What waits for the operator: every unresolved hold, and the operator's cost record. */
  unresolved() {
    const holds = this.ledger.unresolvedHolds();
    return { holds, total: holds.reduce((s, h) => s + big(h.amount), 0n).toString(), operatorCosts: [...this.ledger.db.operatorCosts], settlements: [...(this.ledger.db.settlements ?? [])], unresolvedReleaseMs: this.unresolvedReleaseMs };
  }

  // ------------------------------------------------------------ agents (owner commands)

  /** A new agent for `owner` on `village` with `policy`: its key, its record and its capability token (returned once). */
  createAgent({ owner, village, policy }) {
    if (!isPubkey(owner)) throw new AgentError(ERR.BAD_REQUEST, 'owner must be a base58 wallet address');
    if (!Array.isArray(village) || village.length !== 3 || !village.every(Number.isInteger)) throw new AgentError(ERR.BAD_REQUEST, 'village must be [p, q, site]');
    const pol = normalisePolicy(policy);
    if (this.ledger.agentsOf(owner).length >= MAX_AGENTS_PER_OWNER) throw new AgentError(ERR.TOO_MANY_AGENTS, `an owner has at most ${MAX_AGENTS_PER_OWNER} agents`, 409);
    const agentId = randomUUID();
    const agentKey = this.keyring.create(agentId);
    this.ledger.create({ agentId, owner, agentKey, village, policy: pol });
    const capability = this.#issueCapability(agentId);
    this.log(`agent wallet: created ${agentId} for ${owner} (key ${agentKey}, village ${village.join(',')})`);
    return { agent: this.view(agentId), capability };
  }

  #issueCapability(agentId) {
    const token = randomBytes(32).toString('base64url');
    const version = this.ledger.setCapability(agentId, sha256hex(token));
    return { token, version };
  }

  /** Replaces the capability token (owner command); the old one stops working at once. */
  rotateCapability(agentId, owner) {
    this.#own(agentId, owner);
    return { agent: this.view(agentId), capability: this.#issueCapability(agentId) };
  }

  setPolicy(agentId, owner, policy) {
    this.#own(agentId, owner);
    this.ledger.setPolicy(agentId, normalisePolicy(policy));
    return this.view(agentId);
  }

  setMode(agentId, owner, mode) {
    this.#own(agentId, owner);
    if (!Object.values(MODES).includes(mode)) throw new AgentError(ERR.BAD_REQUEST, 'mode must be manual or auto');
    this.ledger.setMode(agentId, mode);
    return this.view(agentId);
  }

  #own(agentId, owner) {
    const rec = this.ledger.get(agentId);
    if (owner !== rec.owner) throw new AgentError(ERR.NOT_OWNER, 'only the agent\'s owner may do this', 403);
    return rec;
  }

  // ------------------------------------------------------------ money in

  /** Credits a confirmed deposit transaction (signed by the agent's owner, to the custody account) once. */
  async deposit(agentId, signature) {
    if (!this.custody) throw new AgentError(ERR.DISABLED, 'deposits are not enabled on this relay', 503);
    const rec = this.ledger.get(agentId);
    if (typeof signature !== 'string' || signature.length < 64 || signature.length > 128) throw new AgentError(ERR.BAD_REQUEST, 'signature must be a transaction signature (base58)');
    const prior = this.ledger.db.deposits[signature];
    if (prior) return { credited: false, already: true, agentId: prior.agentId, amount: prior.amount, balance: this.ledger.balance(agentId) };
    const amount = await this.custody.verifyDeposit(signature, rec.owner);
    const r = this.ledger.credit(agentId, signature, amount.toString());
    if (r.credited) this.log(`agent wallet: ${agentId} +${r.amount} (deposit ${signature})`);
    return { ...r, already: !r.credited, balance: this.ledger.balance(agentId) };
  }

  /**
   * A sponsored deposit: the owner's wallet signed `tx` (checkDepositShape),
   * a relay pool key is its fee payer. The relay co-signs, simulates with
   * the drain guard, sends, waits for the result and credits the agent
   * from the chain's own record of the transaction (verifyDeposit), so
   * both deposit paths credit through the same check, once per signature.
   */
  async sponsorDeposit(agentId, { tx, wire, lastValidBlockHeight }) {
    if (!this.custody) throw new AgentError(ERR.DISABLED, 'deposits are not enabled on this relay', 503);
    const rec = this.ledger.get(agentId);
    const { ctx } = this;
    const shape = this.custody.checkDepositShape(tx, { owner: rec.owner, pool: ctx.pool });
    if (!signedBy(tx, rec.owner)) throw new AgentError(ERR.BAD_OWNER_SIGNATURE, 'the owner\'s signature on the deposit is missing or invalid', 401);
    const replayKey = `agent-deposit:${base58(tx.signatures[1])}`;
    ctx.relayed.refuseRepeat(replayKey, 'deposit');
    ctx.relayed.add(replayKey);
    let signature;
    try {
      const signed = signAs(tx, [ctx.pool.keypair(shape.feePayer)]);
      const before = BigInt(await ctx.connection.getBalance(new PublicKey(shape.feePayer), 'confirmed'));
      const sim = await simulateWatching(ctx.connection, signed, [shape.feePayer], ctx.programId);
      drainGuard({ pre: before, post: sim.post[0], fee: shape.fee, allowance: shape.allowance });
      const expiry = await ctx.blockhashes.expiryOf(tx.recentBlockhash, lastValidBlockHeight);
      signature = await ctx.connection.sendRawTransaction(signed, { skipPreflight: true, maxRetries: 5 });
      ctx.sent.set(signature, { lastValidBlockHeight: expiry, kind: 'AgentDeposit' });
    } catch (e) {
      ctx.relayed.seen.delete(replayKey);
      throw e;
    }
    this.log(`agent wallet: deposit ${signature} of ${shape.amount} for ${agentId} sent (fee payer ${shape.feePayer})`);
    await landed(ctx, signature, this.waits.deposit);
    return { ...(await this.deposit(agentId, signature)), signature, sponsored: true };
  }

  /** The owner's agents, briefly (public by address, as the view is public by id). */
  byOwner(owner) {
    return this.ledger.agentsOf(owner).map(rec => ({ agentId: rec.agentId, village: [...rec.village], mode: rec.mode, modeEpoch: rec.modeEpoch, agentKey: rec.agentKey, policy: { ...rec.policy }, balance: this.ledger.balance(rec.agentId), createdAt: rec.createdAt }));
  }

  // ------------------------------------------------------------ money out

  /**
   * Withdraws `amount` (or everything available with `all`) to the owner's
   * wallet (the payout fixed at creation). Reserved money is never
   * withdrawn. A full withdrawal stops the agent first (its `held` holds
   * come back to available and go too). Returns `{withdrawal, agent}`; the
   * withdrawal's state is 'done', 'failed' or (chain outcome unknown yet)
   * 'sending', which `reconcile` finishes.
   */
  async withdraw(agentId, owner, { amount, all = false }) {
    if (!this.custody) throw new AgentError(ERR.DISABLED, 'withdrawals are not enabled on this relay', 503);
    const rec = this.#own(agentId, owner);
    if (!all && !isAmount(amount)) throw new AgentError(ERR.BAD_REQUEST, 'amount must be a base-unit amount string, or all: true');
    const whole = all || big(amount) >= big(rec.bal.available);
    if (whole && rec.mode !== MODES.MANUAL) this.ledger.setMode(agentId, MODES.MANUAL);
    const take = all ? rec.bal.available : amount;
    if (big(take) <= 0n) throw new AgentError(ERR.BAD_REQUEST, 'nothing to withdraw', 409, { available: rec.bal.available });
    const w = this.ledger.holdWithdraw(agentId, take);
    let signed = null;
    try {
      const sent = await this.custody.withdraw({ to: rec.payout, amount: take }, {
        onSigned: s => { signed = s; this.ledger.withdrawSending(agentId, w.id, s.signature, s.lastValidBlockHeight); },
      });
      const fate = await this.#await(sent.signature, sent.lastValidBlockHeight, this.waits.withdraw);
      this.#finishWithdrawal(rec, w.id, fate);
    } catch (e) {
      if (!signed) {
        this.ledger.failWithdraw(agentId, w.id, e.message);
        throw new AgentError(ERR.WITHDRAW_FAILED, `the withdrawal could not be built or signed: ${e.message}`, 502);
      }
      // Sent (or maybe sent): only the chain's answer moves the money now.
      this.log(`agent wallet: withdrawal ${w.id} of ${agentId} uncertain (${e.message}); reconcile decides`);
    }
    return { withdrawal: { ...rec.withdrawals[w.id] }, agent: this.view(agentId) };
  }

  #finishWithdrawal(rec, id, fate) {
    if (fate === 'landed') { this.ledger.finishWithdraw(rec.agentId, id); this.log(`agent wallet: ${rec.agentId} withdrew ${rec.withdrawals[id].amount} (${rec.withdrawals[id].signature})`); }
    else if (fate === 'failed' || fate === 'expired') this.ledger.failWithdraw(rec.agentId, id, fate);
  }

  async #await(signature, lastValidBlockHeight, { tries, every }) {
    for (let i = 0; i < tries; i++) {
      const fate = await this.custody.status(signature, lastValidBlockHeight);
      if (fate !== 'pending') return fate;
      if (i + 1 < tries) await new Promise(r => setTimeout(r, every));
    }
    return 'pending';
  }

  // ------------------------------------------------------------ actions

  /**
   * One action request from any entry point. `credential` is one of
   * `{owner}` (the route verified the owner's signed command), `{capability}`
   * (the agent's token) or `{runner: true}` (the in-process runner). Returns
   * an ActionResult (contract.mjs), never throws for a refusal.
   */
  async submit(request, credential = {}) {
    // Everything up to the hold inside #run happens before this function's first await: synchronous for concurrent callers.
    const r = parseActionRequest(request);
    const rec = this.ledger.get(r.agentId);
    this.#authenticate(rec, credential);
    const hash = sha256hex(canonical({ action: r.action, policyVersion: r.policyVersion, modeEpoch: r.modeEpoch ?? null, source: r.source }));
    const prior = this.ledger.request(rec.agentId, r.idempotencyKey);
    if (prior) {
      if (prior.hash !== hash) throw new AgentError(ERR.IDEMPOTENCY_CONFLICT, 'this idempotency key was used for a different request', 409);
      return { ...prior.result, replayed: true, balance: this.ledger.balance(rec.agentId) };
    }
    const flightKey = `${rec.agentId}\n${r.idempotencyKey}`;
    const flying = this.inflight.get(flightKey);
    if (flying) {
      if (flying.hash !== hash) throw new AgentError(ERR.IDEMPOTENCY_CONFLICT, 'this idempotency key is in use for a different request', 409);
      return flying.promise.then(res => ({ ...res, replayed: true }));
    }
    const promise = this.#run(rec, r, hash).finally(() => this.inflight.delete(flightKey));
    this.inflight.set(flightKey, { hash, promise });
    return promise;
  }

  #authenticate(rec, credential) {
    if (credential.runner === true) return;
    if (typeof credential.owner === 'string') {
      if (credential.owner !== rec.owner) throw new AgentError(ERR.NOT_OWNER, 'this agent belongs to another owner', 403);
      return;
    }
    const token = credential.capability;
    if (typeof token !== 'string' || !rec.capabilityHash) throw new AgentError(ERR.BAD_CAPABILITY, 'a valid capability token is required', 401);
    const a = Buffer.from(sha256hex(token), 'hex');
    const b = Buffer.from(rec.capabilityHash, 'hex');
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new AgentError(ERR.BAD_CAPABILITY, 'the capability token is not this agent\'s current one', 401);
  }

  /** The synchronous gate every action passes before money moves; throws the refusal. */
  #gate(rec, r) {
    if (rec.mode !== MODES.AUTO) throw new AgentError(ERR.AGENT_STOPPED, 'the agent is stopped (manual mode); the owner must switch it to auto', 409, { mode: rec.mode, modeEpoch: rec.modeEpoch });
    if (r.policyVersion !== rec.policy.version) throw new AgentError(ERR.STALE_POLICY, `the request was decided under policy ${r.policyVersion}; the current one is ${rec.policy.version}`, 409, { policyVersion: rec.policy.version });
    if (r.modeEpoch !== undefined && r.modeEpoch !== rec.modeEpoch) throw new AgentError(ERR.STALE_MODE, `the request began in mode epoch ${r.modeEpoch}; the current one is ${rec.modeEpoch}`, 409, { modeEpoch: rec.modeEpoch });
    checkAllowed(rec.policy, r.action.name);
    if (r.action.holding.some((v, i) => v !== rec.village[i])) throw new AgentError(ERR.WRONG_VILLAGE, `the agent acts on its own village ${rec.village.join(',')} only`, 403, { village: rec.village });
  }

  async #run(rec, r, hash) {
    const key = r.idempotencyKey;
    const refused = (e, status = RESULT_STATUS.REFUSED, charges = []) => {
      const err = e instanceof RouteError ? { code: e.code, message: e.message, ...(e.extra ?? {}) } : { code: ERR.SEND_FAILED, message: String(e?.message ?? e) };
      const res = resultOf(rec, key, status, { error: err, charges });
      if (status !== RESULT_STATUS.REFUSED || charges.length) this.ledger.recordAction(rec.agentId, { name: r.action.name, key, source: r.source, status, code: err.code });
      return res;
    };
    let hold = null;
    try {
      this.#gate(rec, r);
      // Every check above and this hold are synchronous: a concurrent request cannot slip between them.
      hold = this.ledger.hold(rec.agentId, { category: CATEGORIES.GAME, amount: this.prices.game[r.action.name] ?? '0', key, ttlMs: ACTION_HOLD_TTL_MS, policyVersion: r.policyVersion, modeEpoch: rec.modeEpoch });
    } catch (e) {
      const res = refused(e);
      this.ledger.remember(rec.agentId, key, hash, res);
      return { ...res, balance: this.ledger.balance(rec.agentId) };
    }
    const epoch = rec.modeEpoch;
    const charge = state => (big(hold.amount) > 0n ? [{ category: CATEGORIES.GAME, amount: hold.amount, state }] : []);
    let sending = false;
    let res;
    try {
      const { shape, tx, wire, lastValidBlockHeight } = await this.#build(rec, r);
      const sent = await sponsor(this.ctx, { ip: '127.0.0.1', surface: 'agent' }, {
        tx, wire, shape, lastValidBlockHeight, viaAgent: true,
        beforeSend: ({ signature, lastValidBlockHeight: lvbh }) => {
          // Synchronous, right before the bytes leave: a stop or a new policy in the meantime refuses.
          if (rec.mode !== MODES.AUTO || rec.modeEpoch !== epoch) throw new AgentError(ERR.AGENT_STOPPED, 'the agent was stopped while this action was being prepared', 409);
          if (rec.policy.version !== r.policyVersion) throw new AgentError(ERR.STALE_POLICY, 'the policy changed while this action was being prepared', 409);
          this.ledger.markSending(rec.agentId, hold.id, signature, lvbh);
          sending = true;
        },
        onSent: ({ signature, moved }) => this.ledger.recordNetwork(rec.agentId, { lamports: feeOf(shape) + BigInt(moved ?? 0), signature, key }),
      });
      // Sent. A priced action stays reserved until the chain's answer (reconcile); a free one has nothing to settle.
      if (big(hold.amount) === 0n) this.ledger.release(rec.agentId, hold.id, 'free');
      this.ledger.recordAction(rec.agentId, { name: r.action.name, key, source: r.source, status: RESULT_STATUS.SENT, signature: sent.signature, holdId: big(hold.amount) > 0n ? hold.id : undefined, ...(r.reason ? { reason: r.reason } : {}) });
      res = resultOf(rec, key, RESULT_STATUS.SENT, { signature: sent.signature, charges: charge('reserved') });
      this.log(`agent wallet: ${rec.agentId} ${r.action.name} sent ${sent.signature} (${r.source}, key ${key})`);
    } catch (e) {
      if (!sending) {
        // Nothing left this process: the hold comes back whole.
        this.ledger.release(rec.agentId, hold.id, 'refused');
        // A refusal of the gateway's or the relay's (a RouteError) is 'refused'; an exception on the way (RPC down) is 'failed'.
        res = refused(e, e instanceof RouteError ? RESULT_STATUS.REFUSED : RESULT_STATUS.FAILED);
        if (!(e instanceof RouteError)) this.log(`agent wallet: ${rec.agentId} ${r.action.name} failed before sending: ${e.message}`);
      } else {
        // The send threw after the signature was recorded: the outcome is the chain's (reconcile), the hold stays.
        if (big(hold.amount) === 0n) this.ledger.release(rec.agentId, hold.id, 'free');
        res = refused(e, RESULT_STATUS.FAILED, charge('reserved'));
        this.log(`agent wallet: ${rec.agentId} ${r.action.name} send uncertain (${e.message}); reconcile decides`);
      }
    }
    this.ledger.remember(rec.agentId, key, hash, res);
    return { ...res, balance: this.ledger.balance(rec.agentId) };
  }

  /** The signed transaction of an action, after the chain says the agent's key is the Citizen's live session key. */
  async #build(rec, r) {
    const { ctx } = this;
    const [season, clock, citizen] = await Promise.all([ctx.chain.season(), ctx.chain.clock(), ctx.chain.citizen(ctx.addresses.citizen(rec.owner))]);
    if (!citizen) throw new AgentError(ERR.SESSION_NOT_DELEGATED, 'the owner has no Citizen this season', 409);
    const live = base58(citizen.SESSION) === rec.agentKey && BigInt(citizen.SESSION_EXPIRY) > BigInt(clock.unixTimestamp);
    if (!live) throw new AgentError(ERR.SESSION_NOT_DELEGATED, 'the agent\'s key is not the Citizen\'s unexpired session key (the owner sets it with SetSession)', 409, { agentKey: rec.agentKey, sessionExpiry: String(citizen.SESSION_EXPIRY) });
    const profile = profileForSeason(season);
    const fields = normaliseFields(r.action.name, r.action.fields, profile);
    const accounts = accountsFor(r.action.name, { addresses: ctx.addresses, actor: rec.agentKey, owner: rec.owner, holding: r.action.holding, fields, profile });
    const feePayer = ctx.pool.draw().publicKey.toBase58();
    const { blockhash, lastValidBlockHeight } = await ctx.blockhashes.latest();
    let message;
    try {
      message = shapeMessage({ programId: ctx.programId, name: r.action.name, accounts, fields, feePayer, recentBlockhash: blockhash, profile });
    } catch (e) {
      throw new AgentError(ERR.BAD_REQUEST, `${r.action.name}: ${e.message}`);
    }
    const wire = wireTransaction(message, { [rec.agentKey]: this.keyring.sign(rec.agentId, message) });
    const tx = parseTransaction(wire);
    const shape = classify(tx, { programId: ctx.programId, wireBytes: wire.length, profile });
    if (!shape.ok) throw new AgentError(ERR.RELAY_REFUSED, `relay refused: ${shape.problem}`, 400, { relayCode: shape.code });
    return { shape, tx, wire, lastValidBlockHeight, signature: signatureOf(wire) };
  }

  // ------------------------------------------------------------ inference

  /**
   * Runs one model call `fn()` for the agent and charges the fixed test
   * price whether it succeeds or fails (the owner's decision of
   * 2026-10-17); `free` (the rule autopilot) only records. The price is
   * held before the call, so a call the agent cannot pay for is never
   * made. Returns `{ok, charged, result | error, tokens}`.
   */
  async meterInference(agentId, fn, { key = randomUUID(), free = false, model = null } = {}) {
    const rec = this.ledger.get(agentId);
    if (rec.mode !== MODES.AUTO) throw new AgentError(ERR.AGENT_STOPPED, 'the agent is stopped', 409);
    if (free) {
      const result = await fn();
      return { ok: true, charged: '0', result };
    }
    const hold = this.ledger.hold(agentId, { category: CATEGORIES.INFERENCE, amount: this.prices.inference, key, ttlMs: INFERENCE_HOLD_TTL_MS, policyVersion: rec.policy.version, modeEpoch: rec.modeEpoch });
    // Running: a stop while the model works does not give the hold back; the call is paid for when it returns.
    this.ledger.markRunning(agentId, hold.id);
    let result;
    let error = null;
    try { result = await fn(); } catch (e) { error = e; }
    const tokens = result?.tokens ?? null;
    // The outcome is known now: settle, also when the hold had become unresolved (past its TTL) in the meantime.
    const late = rec.holds[hold.id]?.state === 'unresolved';
    const settled = this.ledger.settle(agentId, hold.id, undefined, { model, tokens, ok: !error, ...(late ? { late: true } : {}) });
    if (!settled) {
      // The hold is gone (the operator refunded it): the owner is not billed twice; the operator's record keeps the late result.
      this.ledger.recordOperatorCost({ agentId, kind: 'late-result', holdId: hold.id, key, amount: hold.amount, model, ok: !error });
      this.log(`agent wallet: ${agentId} model call ${key} returned after its hold was refunded: not charged, recorded`);
    }
    const charged = settled ? hold.amount : '0';
    if (error) return { ok: false, charged, error: { code: ERR.INFERENCE_FAILED, message: String(error?.message ?? error) }, tokens };
    return { ok: true, charged, result, tokens };
  }

  // ------------------------------------------------------------ reconcile

  /**
   * Settles what the chain has decided: a `sending` hold whose transaction
   * landed is spent, one that failed or expired comes back; the same for
   * withdrawals. Expired `held` holds come back too. Returns the counts.
   */
  async reconcile() {
    const out = { settled: 0, released: 0, withdrawn: 0, withdrawalsFailed: 0, pending: 0, expired: this.ledger.expire(), autoReleased: this.unresolvedReleaseMs ? this.ledger.releaseUnresolvedOlderThan(this.unresolvedReleaseMs) : 0 };
    const fate = (sig, lvbh) => (this.custody ? this.custody.status(sig, lvbh) : this.#statusOf(sig, lvbh));
    for (const rec of this.ledger.agents()) {
      for (const h of Object.values(rec.holds)) {
        if (h.state !== 'sending') continue;
        const f = await fate(h.signature, h.lastValidBlockHeight);
        if (f === 'landed') { this.ledger.settle(rec.agentId, h.id, undefined, { signature: h.signature }); out.settled++; }
        else if (f === 'failed' || f === 'expired') { this.ledger.release(rec.agentId, h.id, f); out.released++; }
        else out.pending++;
      }
      for (const w of Object.values(rec.withdrawals)) {
        if (w.state !== 'sending') continue;
        const f = await fate(w.signature, w.lastValidBlockHeight);
        if (f === 'landed') { this.#finishWithdrawal(rec, w.id, f); out.withdrawn++; }
        else if (f === 'failed' || f === 'expired') { this.#finishWithdrawal(rec, w.id, f); out.withdrawalsFailed++; }
        else out.pending++;
      }
    }
    return out;
  }

  /** A relay transaction's fate without a Custody (custody.status's rule). */
  async #statusOf(signature, lastValidBlockHeight) {
    const st = (await this.ctx.connection.getSignatureStatuses([signature], { searchTransactionHistory: true }))?.value?.[0] ?? null;
    if (st?.err) return 'failed';
    if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) return 'landed';
    if (!st && Number.isSafeInteger(lastValidBlockHeight) && (await this.ctx.connection.getBlockHeight('confirmed')) > lastValidBlockHeight) return 'expired';
    return 'pending';
  }

  // ------------------------------------------------------------ views

  /** Whether `pubkey` is one of this relay's agent keys (the relay refuses such a key on POST /f/relay). */
  isAgentKey(pubkey) { return this.keyring.isAgentKey(pubkey); }

  /**
   * Today's budget line as the ledger would roll it: the stored day is rolled only when a hold is made, so a
   * reader (the scheduler's cap, the page) on a new UTC day must not see yesterday's count — it would never
   * call again, and nothing would roll it (found by test/agent-wallet-caps.test.mjs).
   */
  #dayOf(rec) {
    const key = budgetDay(this.ledger.now());
    return rec.day.key === key ? { ...rec.day, calls: rec.day.calls ?? 0 } : { key, spent: '0', calls: 0 };
  }

  /** The agent as every caller sees it: public keys, balances, policy, recent history. No token, no secret. */
  view(agentId) {
    const rec = this.ledger.get(agentId);
    const holds = Object.values(rec.holds).map(h => ({ id: h.id, category: h.category, amount: h.amount, state: h.state, key: h.key, signature: h.signature ?? null }));
    const withdrawals = Object.values(rec.withdrawals).slice(-10).map(w => ({ id: w.id, amount: w.amount, state: w.state, payout: w.payout, signature: w.signature ?? null, createdAt: w.createdAt }));
    return {
      agentId: rec.agentId, owner: rec.owner, payout: rec.payout, agentKey: rec.agentKey, citizen: this.ctx.addresses.citizen(rec.owner), village: [...rec.village],
      mode: rec.mode, modeEpoch: rec.modeEpoch, policy: { ...rec.policy, allowed: [...rec.policy.allowed], budget: { ...rec.policy.budget } },
      capabilityVersion: rec.capabilityVersion, balance: this.ledger.balance(agentId), day: this.#dayOf(rec), holds, withdrawals,
      history: rec.history.slice(-50), createdAt: rec.createdAt, testAssetsOnly: true,
    };
  }

  /**
   * The delegation as the chain has it now: whether the owner's Citizen names the agent's key as its
   * unexpired session key. The server-side stop (manual) does not change this; only the owner's
   * SetSession does, and the browser should show both.
   */
  async delegation(agentId) {
    const rec = this.ledger.get(agentId);
    const [clock, citizen] = await Promise.all([this.ctx.chain.clock(), this.ctx.chain.citizen(this.ctx.addresses.citizen(rec.owner))]);
    if (!citizen) return { citizen: false, delegated: false, session: null, expiry: null, now: clock.unixTimestamp };
    const session = base58(citizen.SESSION);
    const expiry = Number(citizen.SESSION_EXPIRY);
    return { citizen: true, delegated: session === rec.agentKey && expiry > clock.unixTimestamp, session, expiry, now: clock.unixTimestamp };
  }

  /** What an owner needs to delegate: the key to put in SetSession, and this relay's prices. */
  sessionTerms(agentId) {
    const rec = this.ledger.get(agentId);
    return { agentId, agentKey: rec.agentKey, citizen: this.ctx.addresses.citizen(rec.owner), instruction: 'SetSession', fields: { session: rec.agentKey, expiry: 'unix seconds, chosen by the owner' }, ...this.terms() };
  }

  /** The relay's agent-wallet terms (public). */
  terms() {
    return {
      enabled: true, testAssetsOnly: true, mint: this.custody?.mint ?? null, custodyAccount: this.custody?.account ?? null, custodyAuthority: this.custody?.authority ?? null,
      runner: this.runner ?? null,
      prices: { inference: this.prices.inference, game: { ...this.prices.game }, autopilot: '0' },
      sources: [...SOURCES], networkFees: { paidBy: 'relay', unit: 'lamports', recordedOnly: true },
    };
  }

  toJSON() { return { agents: this.ledger.agents().length, custody: this.custody?.toJSON() ?? null }; }
}

/**
 * Builds the agent wallet over a relay context and attaches it as
 * `ctx.agents` (the routes and the relay's agent-key refusal read it).
 */
export function attachAgentWallet(ctx, { store, keyring, custody = null, prices, waits, unresolvedReleaseMs = null, log = ctx.log ?? (() => {}), now = ctx.now ?? Date.now }) {
  const ledger = new AgentLedger({ store, now });
  const gateway = new AgentGateway({ ctx, ledger, keyring, custody, prices, waits, unresolvedReleaseMs, now, log });
  ctx.agents = gateway;
  return gateway;
}
