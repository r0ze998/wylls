// The resident's cost port over workstream 5's cost ledger (e9d1551a, model-api/src: price-book.mjs TokenPriceBook,
// cost-store.mjs FileCostLedger over run-cost.mjs RunCostMock, process-lease.mjs ProcessLease). Workstream 13 does not
// import workstream 5: the caller hands in 5's book and ledger.
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
//   - a stop while calling: undecided in both at the next start; a stop after reserving and before calling: released.
// Mock: 5's ledger is test-USDC base units of model inference, on one machine (5 says so itself). No model is called
// here; whether a real provider's usage report can be matched to these keys is not verified (5's EVIDENCE list).
import { priceBookCost } from './cost.mjs';

export function ws05LedgerCost({ book, ledger, provider, model }) {
  for (const m of ['reserve', 'calling', 'settle', 'release', 'undecided', 'classes']) if (typeof ledger?.[m] !== 'function') throw new TypeError(`workstream 5 cost ledger lacks ${m}()`);
  const base = priceBookCost(book, { provider, model });
  const log = [];
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
    restarted(callKey, phase) {
      if (phase === 'calling') { ledger.undecided(callKey, 'restart while calling'); log.push(['undecided', callKey, 'restart']); return; }
      // 'reserving': the stop came before or after 5 reserved it; release is a no-op when 5 never did (or 5's own
      // recovery already released it).
      const r = ledger.release(callKey, 'restart before calling');
      log.push(['release', callKey, r ? 'restart' : 'nothing reserved']);
    },
  });
}
