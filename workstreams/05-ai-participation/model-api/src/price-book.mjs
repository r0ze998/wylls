// Token prices, as a versioned book, apart from the adapters. No book here
// is a provider's real price list: the fixture book uses made-up numbers so
// that no production price is implied. A real book would be copied from the
// provider's pricing page (with its URL and the date read) and approved
// before use.
//
// Units: price per million tokens in micro-units of the book's currency
// (micro-USD for a USD book). Conversion to test-USDC base units needs a
// stated rate. All arithmetic is BigInt; every cost rounds UP.

const big = v => BigInt(v);
const ceilDiv = (a, b) => (a + b - 1n) / b;

/** The price components both providers publish (per million tokens). `cacheWrite` may be split by TTL. */
export const COMPONENTS = Object.freeze(['input', 'cacheRead', 'cacheWrite5m', 'cacheWrite1h', 'cacheWrite', 'output']);

export class TokenPriceBook {
  /**
   * @param {object} o
   * @param {string} o.version
   * @param {'FIXTURE'|'TEST'|'PROPOSED'} o.status   never a production book
   * @param {string} o.currency                      'USD' (micro-USD prices) or 'test-USDC' (base-unit prices)
   * @param {object} o.models                         {"provider/model": {input, cacheRead, cacheWrite5m?, cacheWrite1h?, cacheWrite?, output}}
   * @param {object} [o.rate]                         {baseUnitsPerMicroUnit: '1', source, status} to test-USDC base units
   * @param {object} [o.source]                       {url, retrieved} where the numbers came from
   */
  constructor({ version, status, currency, models, rate = null, source = null }) {
    if (!['FIXTURE', 'TEST', 'PROPOSED'].includes(status)) throw new Error('a price book here is FIXTURE, TEST or PROPOSED, never a production one');
    if (currency !== 'test-USDC' && !rate) throw new Error(`a ${currency} book needs a stated conversion rate to test-USDC`);
    Object.assign(this, { version: String(version), status, currency, models: structuredClone(models), rate, source });
  }

  entry(provider, model) {
    const e = this.models[`${provider}/${model}`];
    if (!e) throw Object.assign(new Error(`no price for ${provider}/${model} in book ${this.version}`), { code: 'NoPrice' });
    return e;
  }

  #toBase(micro) { return this.currency === 'test-USDC' ? micro : micro * big(this.rate.baseUnitsPerMicroUnit); }

  /**
   * The most a call can cost: every input token at the dearest input rate (a cache write can cost more than a
   * plain input token), plus the full output ceiling. `inputTokenCeiling` must be an upper bound (the adapter
   * uses the UTF-8 byte length of the request body, which no tokenizer exceeds).
   */
  quote(provider, model, { inputTokenCeiling, maxOutputTokens }) {
    const e = this.entry(provider, model);
    const dearestIn = [e.input, e.cacheWrite5m, e.cacheWrite1h, e.cacheWrite].filter(v => v !== undefined).map(big).reduce((a, b) => (a > b ? a : b));
    const micro = ceilDiv(big(inputTokenCeiling) * dearestIn + big(maxOutputTokens) * big(e.output), 1_000_000n);
    return String(this.#toBase(micro));
  }

  /** The measured cost of a usage report (contract.emptyUsage shape). Null when the report lacks a billed count. */
  measure(provider, model, usage) {
    if (!usage || usage.inputUncached === null || usage.output === null) return null;
    const e = this.entry(provider, model);
    const w = usage.cacheWrite ?? {};
    const rateOf = ttl => big(ttl === '5m' ? (e.cacheWrite5m ?? e.cacheWrite) : ttl === '1h' ? (e.cacheWrite1h ?? e.cacheWrite) : (e.cacheWrite ?? e.cacheWrite5m ?? e.input));
    let tokMicro = big(usage.inputUncached) * big(e.input) + big(usage.cacheRead ?? 0) * big(e.cacheRead ?? e.input) + big(usage.output) * big(e.output);
    for (const [ttl, n] of Object.entries(w)) tokMicro += big(n) * rateOf(ttl);
    return String(this.#toBase(ceilDiv(tokMicro, 1_000_000n)));
  }

  toJSON() { return { version: this.version, status: this.status, currency: this.currency, models: this.models, rate: this.rate, source: this.source }; }
}

/**
 * The fixture book for tests and the local demo. THE NUMBERS ARE INVENTED (round figures, the same for both
 * providers) and say nothing about either provider's prices. Model ids are placeholders.
 */
export const FIXTURE_BOOK = () => new TokenPriceBook({
  version: 'fixture-2026-10-30', status: 'FIXTURE', currency: 'USD', rate: { baseUnitsPerMicroUnit: '1', source: 'FIXTURE: 1 micro-USD = 1 test-USDC base unit', status: 'FIXTURE' },
  source: { url: null, retrieved: null, note: 'invented numbers; not a provider price list' },
  models: {
    'anthropic/claude-fixture-model': { input: '1000000', cacheRead: '100000', cacheWrite5m: '1250000', cacheWrite1h: '2000000', output: '5000000' },
    'openai/gpt-fixture-model': { input: '1000000', cacheRead: '100000', cacheWrite: '1250000', output: '5000000' },
  },
});
