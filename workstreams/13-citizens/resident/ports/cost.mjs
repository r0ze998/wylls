// The cost port: what one model call is reserved at before it is made, and what it is charged after. The money
// itself stays in the agent wallet's ledger (AgentLedger: hold → settle, or unresolved); this port only says how
// much. Two kinds:
//
//   flatCost(price)      one fixed test price per call, charged whether the call is answered or not (the agent
//                        wallet owner's decision of 2026-10-17). The default, and today's behaviour.
//   priceBookCost(book)  workstream 5's rules (model-api/src/price-book.mjs, run-cost.mjs on
//                        preserve/ws05-provider-budget-45cba41e): reserve the book's QUOTE before the call (every
//                        input byte at the dearest input rate, plus the output ceiling); after it, charge what the
//                        usage report MEASURES, never more than the quote (anything above is the operator's overrun,
//                        recorded, not charged); a call whose outcome is unknown, or whose report has no billed
//                        count, stays UNDECIDED (the hold becomes `unresolved`: no code releases it; only an outside
//                        answer does); a provider refusal before generating, a throttle or a billing stop charges 0.
//                        `book` is workstream 5's TokenPriceBook (quote, measure) or anything with those methods.
//
//   quote(req) → amount (base-unit string)
//   settle({outcome, usage, quote}) → {charge, overrun?} | {undecided: true, reason}
//
// Which day a daily budget counts (UTC day of the relay, or the game day) is not decided here (see 08 and WORK).
const big = v => BigInt(v ?? 0);

export function flatCost(price) {
  return Object.freeze({
    kind: 'flat',
    quote: () => String(price),
    settle: () => ({ charge: String(price) }),
  });
}

const NO_GENERATION = new Set(['rejected', 'throttled', 'billing']);

/** A usage report in workstream 5's shape, from either its shape or the fixture's {inputTokens, outputTokens}. */
export function toBookUsage(u) {
  if (!u) return null;
  if ('inputUncached' in u || 'output' in u) return u;
  return { inputUncached: u.inputTokens ?? null, cacheRead: 0, cacheWrite: {}, output: u.outputTokens ?? null };
}

export function priceBookCost(book, { provider, model }) {
  if (typeof book?.quote !== 'function' || typeof book?.measure !== 'function') throw new TypeError('a price book with quote() and measure()');
  book.entry?.(provider, model); // a model the book does not price is refused up front (NoPrice)
  return Object.freeze({
    kind: 'price-book', provider, model, version: book.version ?? null,
    quote(req) {
      const bytes = Buffer.byteLength(req.system) + Buffer.byteLength(req.user) + Buffer.byteLength(JSON.stringify(req.schema ?? {}));
      return String(book.quote(provider, model, { inputTokenCeiling: bytes, maxOutputTokens: req.limits.maxOutputTokens }));
    },
    settle({ outcome, usage, quote }) {
      if (NO_GENERATION.has(outcome)) return { charge: '0' };
      if (outcome !== 'answered') return { undecided: true, reason: `outcome ${outcome}` };
      const measured = book.measure(provider, model, toBookUsage(usage));
      if (measured === null || measured === undefined) return { undecided: true, reason: 'usage report has no billed count' };
      const m = big(measured), q = big(quote);
      return m > q ? { charge: String(q), overrun: String(m - q) } : { charge: String(m) };
    },
  });
}
