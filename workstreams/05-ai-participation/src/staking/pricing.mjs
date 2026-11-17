// What a model call costs, measured and converted, apart from how anyone is
// actually paid. The owner sees one budget (test USDC); behind it there are
// several ways a bill can be settled, and only one of them exists today.
//
// No price here is a production figure. Every entry carries its status
// (TEST or PROPOSED); the production prices, the conversion source and the
// settlement method are the owner's to decide (docs/agent-wallet/STATUS-
// 2026-10-23.ja.md §9.11 "推論の料金", still open).
//
// Amounts are test-USDC base units (6 decimals) as decimal strings; the
// arithmetic is in BigInt and always rounds a cost UP (an owner is never
// shown less than what will be held).

export const SETTLEMENT = Object.freeze({
  'ledger-fixed-per-call': {
    implemented: 'yes (relay)',
    how: 'The relay holds one fixed price per call from the prepaid test-USDC balance and settles it whether the call succeeds or fails (AgentGateway.meterInference, prices.inference). The owner decision of 2026-10-17.',
    whoPaysTheModel: 'the operator (its own machine for a local model); the ledger charge is the owner\'s price for a call, not a pass-through of a bill',
  },
  'ledger-metered': {
    implemented: 'integration patch only (patches/0001, not applied)',
    how: 'Hold the quote (the most a call can cost: the token ceiling × the price), settle the measured cost ≤ the hold from the server\'s usage report.',
    whoPaysTheModel: 'as above; the charge follows the usage',
  },
  'operator-advance': {
    implemented: 'no',
    how: 'The operator pays an outside provider\'s invoice in its own currency; the owner\'s ledger is charged the metered cost converted at a published rate; the operator\'s cost record keeps the provider\'s request id for reconciliation; a difference between the invoice and the charges is the operator\'s.',
    needs: 'a provider with per-request usage ids, a rate source with validity, a reconciliation period, the owner\'s decision on who carries rate and rounding differences',
  },
  'owner-own-key': {
    implemented: 'no',
    how: 'The owner uses their own provider account; the ledger records usage only and charges 0 for inference. The relay cannot verify that bill.',
    needs: 'a way to hold the owner\'s credential that the relay never sees, or an MCP client that calls the model itself',
  },
});

const big = v => BigInt(v);
const ceilDiv = (a, b) => (a + b - 1n) / b;

/**
 * @param {object} o
 * @param {string} o.version
 * @param {Array}  o.entries   [{match: {provider, model?}, unit: 'call', amount} | {match, unit: 'tokens', currency: 'USD'|'test-USDC', promptPerMillion, completionPerMillion}] (amounts in the currency's base units: micro-USD or test-USDC base units)
 * @param {object} [o.rates]   {USD: {baseUnitsPerUnit, source, status}}: test-USDC base units for 1 USD
 * @param {string} o.status    'TEST' | 'PROPOSED'
 * @param {string} o.settlement a SETTLEMENT key
 */
export class PriceBook {
  constructor({ version, entries, rates = {}, status = 'TEST', settlement = 'ledger-fixed-per-call' }) {
    if (!['TEST', 'PROPOSED'].includes(status)) throw new Error('a price book here is TEST or PROPOSED, never a production one');
    if (!SETTLEMENT[settlement]) throw new Error(`unknown settlement ${settlement}`);
    this.version = String(version);
    this.status = status;
    this.settlement = settlement;
    this.entries = entries.map(e => ({ ...e }));
    this.rates = { ...rates };
  }

  #entry(cfg) {
    return this.entries.find(e => e.match.provider === cfg.provider && e.match.model === cfg.model) ?? this.entries.find(e => e.match.provider === cfg.provider && e.match.model === undefined) ?? null;
  }

  #toBase(amount, currency) {
    if (currency === 'test-USDC') return amount;
    const r = this.rates[currency];
    if (!r) throw Object.assign(new Error(`no ${currency} rate in price book ${this.version}`), { code: 'NoRate' });
    // amount is in micro-units of the currency; base units of test USDC are micro-USDC.
    return ceilDiv(amount * big(r.baseUnitsPerUnit), 1_000_000n);
  }

  /** The most a call can cost (what is reserved before it): {amount, basis}. */
  quote(cfg, { maxPromptTokens = 4_000, maxCompletionTokens = cfg.maxTokens ?? 400 } = {}) {
    const e = this.#entry(cfg);
    if (!e) throw Object.assign(new Error(`no price for ${cfg.provider}/${cfg.model} in price book ${this.version}`), { code: 'NoPrice' });
    if (e.unit === 'call') return { amount: String(e.amount), basis: `${this.status} per call (book ${this.version})` };
    const raw = ceilDiv(big(maxPromptTokens) * big(e.promptPerMillion) + big(maxCompletionTokens) * big(e.completionPerMillion), 1_000_000n);
    return { amount: String(this.#toBase(raw, e.currency)), basis: `${this.status} ceiling ${maxPromptTokens}+${maxCompletionTokens} tokens (book ${this.version})` };
  }

  /** What a finished call costs from its usage report; never more than the quote. A call with no usage report costs the quote. */
  cost(cfg, usage, quote = this.quote(cfg)) {
    const e = this.#entry(cfg);
    if (e.unit === 'call') return { amount: String(e.amount), basis: `${this.status} per call`, measured: false };
    if (!usage || !Number.isInteger(usage.prompt_tokens) || !Number.isInteger(usage.completion_tokens)) return { amount: quote.amount, basis: 'no usage report: the quote', measured: false };
    const raw = ceilDiv(big(usage.prompt_tokens) * big(e.promptPerMillion) + big(usage.completion_tokens) * big(e.completionPerMillion), 1_000_000n);
    const a = this.#toBase(raw, e.currency);
    return { amount: String(a < big(quote.amount) ? a : big(quote.amount)), basis: `${this.status} ${usage.prompt_tokens}+${usage.completion_tokens} tokens`, measured: true };
  }

  toJSON() { return { version: this.version, status: this.status, settlement: this.settlement, settlementHow: SETTLEMENT[this.settlement], entries: this.entries, rates: this.rates }; }
}

/** The book the demo and tests use: the relay's current fixed test price, the only rule implemented. */
export const TEST_BOOK = () => new PriceBook({
  version: 'test-2026-10-30', status: 'TEST', settlement: 'ledger-fixed-per-call',
  entries: [{ match: { provider: 'scripted' }, unit: 'call', amount: '10000' }, { match: { provider: 'local-openai' }, unit: 'call', amount: '10000' }],
});
