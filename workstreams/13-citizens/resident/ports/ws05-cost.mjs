// The resident's cost port over workstream 5's cost ledger (e9d1551a, model-api/src: price-book.mjs TokenPriceBook,
// cost-store.mjs FileCostLedger over run-cost.mjs RunCostMock, process-lease.mjs ProcessLease). The methods used here
// are the same at 10e74967 (5's cost API there only adds FileCostLedger.openFenced, a way to open the ledger that the
// caller may use; this port does not call it). Workstream 13 does not import workstream 5: the caller hands in 5's
// book and ledger.
//
// Two ledgers, one call each, never summed:
//   - the agent wallet's AgentLedger (the resident's money: hold → running → settle | unresolved), as before;
//   - workstream 5's ledger (5's caps per call / day / total, shared between processes under a file mutex, fenced by
//     the process lease): reserve → calling → settle | release | undecided, under a key of its own per call
//     (`<resident>:t<turn>:infer:<hold id>`: 5 refuses a key twice; a call made again is a new call).
//
// The rules are 5's and the resident's together:
//   - reserved at the book's quote BEFORE the call; 5's refusal (a cap, LeaseLost: another process took this agent
//     over) means no call: the resident releases its own hold and falls back without the model;
//   - answered: 5 settles the MEASURED cost (at most the quote; above it is 5's overrun record), the resident charges
//     the same capped amount;
//   - a refusal before generating, a throttle or a billing stop: nothing billed: 5 releases, the resident charges 0;
//   - outcome unknown, or a report without a billed count: UNDECIDED in both (5's undecided, the resident's
//     unresolved). Nothing here releases or zeroes it; only 5's decide() with evidence does;
//   - after a stop, recover(): 5's persistent item is read and is authoritative. A call the resident's write-ahead
//     record shows was never made (`notCalled`) is released in 5 if 5 still holds it reserved or calling; one that may
//     have been made is made undecided there. Whatever 5 then says (released, settled, undecided, absent) is returned,
//     and the resident's wallet follows it (resident.mjs #costRestart). An undecided item is never released here.
// Mock: 5's ledger is test-USDC base units of model inference, on one machine (5 says so itself). No model is called
// here; whether a real provider's usage report can be matched to these keys is not verified (5's EVIDENCE list).
import { priceBookCost } from './cost.mjs';

export function ws05LedgerCost({ book, ledger, provider, model }) {
  for (const m of ['reserve', 'calling', 'settle', 'release', 'undecided', 'classes']) if (typeof ledger?.[m] !== 'function') throw new TypeError(`workstream 5 cost ledger lacks ${m}()`);
  const base = priceBookCost(book, { provider, model });
  const log = [];
  /** 5's persistent item for a key, re-read from its ledger: {state, amount, settled} or null (5 holds no such item). */
  const itemOf = callKey => {
    const items = ledger.items;
    if (typeof items?.get !== 'function') return undefined;
    const it = items.get(callKey);
    return it ? { state: it.state, amount: it.amount, settled: it.settled ?? null } : null;
  };
  return Object.freeze({
    ...base,
    kind: 'ws05-ledger',
    ledgerStatus: ledger.status ?? null,
    log,
    reserve(callKey, quote) { const r = ledger.reserve(callKey, quote); log.push(['reserve', callKey, quote]); return r; },
    calling(callKey) { ledger.calling(callKey); log.push(['calling', callKey]); },
    close(callKey, out) {
      if (out.undecided) { ledger.undecided(callKey, out.reason); log.push(['undecided', callKey, out.reason]); return; }
      if (out.charge === '0' && !out.overrun) { ledger.release(callKey, `outcome ${out.outcome}: nothing billed`); log.push(['release', callKey]); return; }
      // 5 caps at the reservation itself and records any overrun: hand it the measured amount.
      const measured = out.overrun ? String(BigInt(out.charge) + BigInt(out.overrun)) : out.charge;
      ledger.settle(callKey, measured, `ws13 ${out.outcome}`);
      log.push(['settle', callKey, measured]);
    },
    /**
     * After a stop: 5's item for `callKey` as 5 persists it (after 5's own recovery, if it ran) is the answer.
     *   - still `reserved` or `calling`: `notCalled` (the resident's record shows the model was never called) releases
     *     it; otherwise it becomes undecided (it may have reached the provider);
     *   - anything else is left exactly as 5 has it (released, settled, undecided: only 5's decide() moves undecided).
     * Returns {state: 'released'|'settled'|'undecided'|'reserved'|'calling'|'absent'|'unknown', amount?, settled?}.
     * `absent`: 5 holds no item under the key; `unknown`: this ledger cannot be read item by item.
     */
    recover(callKey, { notCalled = false } = {}) {
      let it = itemOf(callKey);
      if (it === undefined) return Object.freeze({ state: 'unknown' });
      if (it && (it.state === 'reserved' || it.state === 'calling')) {
        if (notCalled) { ledger.release(callKey, 'restart before calling'); log.push(['release', callKey, 'restart']); }
        else { ledger.undecided(callKey, 'restart while calling'); log.push(['undecided', callKey, 'restart']); }
        it = itemOf(callKey);
      }
      return Object.freeze(it ? { ...it } : { state: 'absent' });
    },
    /** The earlier restart notice (phase only), kept for callers of the previous version; recover() supersedes it. */
    restarted(callKey, phase) { return this.recover(callKey, { notCalled: phase !== 'calling' }); },
  });
}
