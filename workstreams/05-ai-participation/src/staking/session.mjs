// AI staking for one owner and one agent: the owner funds a budget, sets what
// the agent may do, starts it, watches what it did and what it cost, and
// takes the village back. Each owner step is the real owner command of the
// agent wallet (signed by the owner's wallet, verified by the relay); each
// agent step is one participation run (src/participate.mjs) through the
// agent's MCP tools, with this layer's caps on top (budget.mjs).
//
// What this file adds is orchestration only: no balance, no payment path and
// no permission of its own. The money is the relay's ledger; the stop is the
// relay's mode; the on-chain revocation is the owner's SetSession.
import { RunJournal } from '../adapters.mjs';
import { modelDecider } from '../deciders.mjs';
import { participate, tool, verifyPending } from '../participate.mjs';
import { BudgetGuard, costClasses, statement, stopReport, trace } from './budget.mjs';
import { createProvider, parseModelConfig } from './providers.mjs';

export class StakingSession {
  /**
   * @param {object} o
   * @param {object} o.world         createLocalWorld()'s world (the relay, the owner's controls, the public reads)
   * @param {object|string} o.model  a model config or preset (providers.mjs)
   * @param {object} o.priceBook     PriceBook (pricing.mjs)
   * @param {object} [o.providerDeps] {fetch, answer} for the provider
   */
  constructor({ world, model, priceBook, providerDeps = {}, journal = null }) {
    this.w = world;
    this.modelCfg = parseModelConfig(model);
    this.provider = createProvider(this.modelCfg, providerDeps);
    this.priceBook = priceBook;
    this.journal = journal ?? new RunJournal({ now: () => world.state.clock * 1000 });
    this.policy = world.view().policy;
    this.mandate = null;
    this.guard = null;
    this.runs = 0;
    this.log = [];
  }

  #note(step, detail) { const e = { step, worldSec: this.w.state.clock, ...detail }; this.log.push(e); return e; }

  /** 予算設定: the owner deposits and sets the relay's budget (total, per day, model calls a day). */
  async setBudget({ deposit = null, total, perDay, callsPerDay = undefined }) {
    if (deposit) await this.w.ownerDeposit(deposit);
    const budget = { total: String(total), perDay: String(perDay), ...(Number.isInteger(callsPerDay) ? { callsPerDay } : {}) };
    const res = await this.w.ownerSetPolicy({ allowed: this.policy.allowed, budget });
    this.policy = res.agent.policy;
    return this.#note('budget', { policy: this.policy, balance: res.agent.balance });
  }

  /** 許可範囲設定: the relay's allowed actions, and the owner's mandate (purpose, limits, caps per category, places, expiry), written against the policy it narrows. */
  async setScope({ allowed, mandate }) {
    const res = await this.w.ownerSetPolicy({ allowed, budget: this.policy.budget });
    this.policy = res.agent.policy;
    this.mandate = { ...mandate, agentId: this.w.agentId, basedOnPolicyVersion: this.policy.version, version: (this.mandate?.version ?? 0) + 1 };
    return this.#note('scope', { policyAllowed: this.policy.allowed, policyVersion: this.policy.version, mandate: this.mandate });
  }

  /** 自動開始: the provider's identity and the relay's terms are read and checked against the price book first. */
  async start() {
    this.identity = await this.provider.identify();
    this.terms = (await tool(this.w.mcp(), 'agent_terms')).structuredContent;
    const quote = this.priceBook.quote(this.modelCfg);
    // The relay charges its own fixed price per call; a book that says otherwise would show the owner a wrong cost.
    if (this.priceBook.settlement === 'ledger-fixed-per-call' && quote.amount !== this.terms.prices.inference) {
      throw Object.assign(new Error(`the price book quotes ${quote.amount} a call, the relay charges ${this.terms.prices.inference}`), { code: 'PriceBookMismatch' });
    }
    this.guard = new BudgetGuard({ caps: this.mandate?.budget ?? {}, now: () => this.w.state.clock * 1000 }).seed(this.journal);
    const res = await this.w.ownerSetMode('auto');
    return this.#note('start', { mode: res.agent.mode, modeEpoch: res.agent.modeEpoch, configuredModel: this.modelCfg.model, provider: this.modelCfg.provider, identity: this.identity, quote, relayPrices: this.terms.prices });
  }

  /** One turn of the agent: a participation run, then the chain's and the relay's answers, then the agent's own check of what became of it. */
  async tick() {
    this.runs += 1;
    const runId = `stake-${this.runs}`;
    const report = await participate({
      mcp: this.w.mcp(), world: this.w.publicWorld, txState: this.w.txState, meter: this.w.meter, mandate: this.mandate,
      decider: modelDecider({ llm: this.provider }), journal: this.journal, runId,
      staking: { guard: this.guard, priceBook: this.priceBook, modelCfg: this.modelCfg, identity: this.identity, gamePrices: this.terms.prices.game, onBudgetLimit: this.mandate?.onBudgetLimit ?? 'stop', modelRetries: this.modelRetries ?? 0 },
    });
    this.w.settle();
    await this.w.reconcile();
    const verified = await verifyPending({ journal: this.journal, txState: this.w.txState, world: this.w.publicWorld, guard: this.guard });
    this.w.advance(600);
    this.#note('tick', { runId, status: report.status, stoppedBy: report.stoppedBy ?? null, charged: report.charged, by: report.by ?? null, items: report.items.map(i => ({ requestId: i.requestId, outcome: i.outcome, code: i.code ?? null })), verified: verified.map(v => v.outcome) });
    return { report, verified };
  }

  statement() { return statement(this.w.view()); }
  costs() { return costClasses(this.w.view()); }
  trace() { return trace(this.journal, this.w.view()); }

  /** 停止: three stages (stop, reconcile, release); see budget.mjs stopReport. Nothing already signed, sent or running is undone. */
  async stop() {
    const beforeView = this.w.view();
    const before = statement(beforeView).inFlight;
    const res = await this.w.ownerSetMode('manual');
    const report = stopReport({ before: beforeView, after: this.w.view(), journal: this.journal });
    return this.#note('stop', { mode: res.agent.mode, inFlightAtStop: before, inFlightAfter: statement(this.w.view()).inFlight, report });
  }

  /**
   * 手動復帰: stopped at the relay, then the session taken back on chain. The three facts kept apart:
   *   signer  only the owner's WALLET can sign SetSession (wallet-only on chain: permutation-frontier proc/citizen.rs set_session, player(..., false))
   *   final   it takes effect when that transaction lands; until then the agent's key is still the session. HERE the
   *           fixture writes the Citizen account directly (no transaction, no signature): a MOCK of the landed result
   *   scope   the session is the Citizen's (one per wallet per season, frontier-abi v2/layout/player.rs SESSION):
   *           taking it back ends it for every village of that Citizen and for whatever else held that one slot
   */
  async backToManual() {
    if (this.w.view().mode !== 'manual') await this.w.ownerSetMode('manual');
    this.w.ownerTakeKeyBack();
    const v = (await tool(this.w.mcp(), 'agent_view')).structuredContent;
    return this.#note('manual', { mode: v.mode, delegated: v.delegation?.delegated ?? null, session: v.delegation?.session === this.w.agentKey ? 'agent' : 'not the agent',
      sessionRevocation: { signer: 'the owner\'s wallet (SetSession is wallet-only on chain)', final: 'MOCK here: the fixture wrote the Citizen account; on a chain, only when the SetSession transaction lands', scope: 'the Citizen: all its villages (up to 3) and every session-allowed instruction; any other holder of the one session slot loses it too' } });
  }

  /** 引出し: available only (the relay's rule); the transfer is final when the chain answers and the relay's reconcile reads it. */
  async withdraw(params) {
    const res = await this.w.ownerWithdraw(params);
    const asked = { state: res.withdrawal?.state, amount: res.withdrawal?.amount };
    this.w.settle();
    await this.w.reconcile();
    const v = this.w.view();
    const w = v.withdrawals.find(x => x.id === res.withdrawal?.id);
    return this.#note('withdraw', { asked, final: { state: w?.state ?? null, amount: w?.amount ?? null }, balance: v.balance, mode: v.mode });
  }
}
