// fix-devnet-join-wait (herald-load-50 F3): the page's wait for its OWN record after a send the chain has taken.
//
// The herald reads FINALIZED transactions only (`--source rpc`: getSignaturesForAddress + getTransaction at
// finalized, then the accounts' post-states), so on a real cluster what the page just sent shows there about
// 32 slots (≈13 s) after it landed, plus the herald's poll and its ingest queue (herald-load-50: p95 16 s, max 90 s
// at the runbook's gap 250 under a burst). The old wait gave it 5 × 1 s and then STOPPED: after a Join the rim
// village request was never filed (2 of 3 real pages in that run). A localnet answers everything as finalized at
// once, so no offline run saw it.
//
// This wait reads the page's own record again (`read`, the page's refresh: herald reads only, nothing is sent) on a
// growing gap (OWN_WAIT_DELAYS_MS, then every OWN_WAIT_EVERY_MS) until `predicate()` holds, the page is no longer the
// scope the wait began in (`still()` false → 'left': nothing more is done for it), or `maxMs` of wall time have gone
// by ('timeout': the caller says why it stopped and offers to look again; nothing is sent again by this wait). A read
// that throws, or a record that cannot be read for a moment, is not an answer: the wait goes on. `progress(secs)`
// is told after every read so the page can say how long it has been waiting.
//
// References compared (2026-11-23): solana-web3.js `BlockheightBasedTransactionConfirmationStrategy`
// (github.com/solana-foundation/solana-web3.js packages/web3.js/src/connection.ts: wait until a deadline, not a fixed
// count), @solana/kit `sendAndConfirmTransactionFactory` (github.com/anza-xyz/kit packages/kit/src/
// send-and-confirm-transaction.ts: the same, with a commitment to reach), TanStack Query retries
// (github.com/TanStack/query docs/framework/react/guides/query-retries.md: `min(1000 · 2^n, 30 s)` backoff). This
// page already KNOWS its send landed (the relay's status at confirmed); what it waits for is the herald, an indexer
// that reads finalized: a capped backoff with a wall-clock deadline sized for finalized lag.

/** The gaps between the first reads (ms); after them, every OWN_WAIT_EVERY_MS. */
export const OWN_WAIT_DELAYS_MS = Object.freeze([1000, 1000, 2000, 2000, 3000, 3000]);
export const OWN_WAIT_EVERY_MS = 5000;
/**
 * How long the page waits for its own record (wall ms): finality (~13 s) + the herald's poll + an ingest backlog
 * under a burst (herald-load-50 measured up to 90 s at the runbook's gap) with margin. Waiting longer costs nothing
 * when the record comes early: the wait ends at the first read that shows it.
 */
export const OWN_WAIT_MS = 180_000;

/** The gap before read `i` (0-based; read 0 is made at once). */
export const ownWaitDelay = i => (i <= 0 ? 0 : (OWN_WAIT_DELAYS_MS[i - 1] ?? OWN_WAIT_EVERY_MS));

/**
 * → `{ok: true, secs}` | `{ok: false, why: 'timeout' | 'left', secs}` (secs: whole seconds waited).
 * `read`: one re-read of the page's own record (may throw: not an answer). `predicate`: whether it shows what was sent.
 * `still`: whether the page is still the scope the wait began in. Clock and sleep are injectable for tests.
 */
export async function waitForOwnRecord({ predicate, read, still = () => true, progress = () => {}, maxMs = OWN_WAIT_MS,
  now = () => Date.now(), sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  const t0 = now();
  const secs = () => Math.max(0, Math.floor((now() - t0) / 1000));
  for (let i = 0; ; i++) {
    const gap = ownWaitDelay(i);
    if (i > 0 && now() - t0 + gap > maxMs) return { ok: false, why: 'timeout', secs: secs() };
    if (gap) await sleep(gap);
    if (!still()) return { ok: false, why: 'left', secs: secs() };
    try { await read(); } catch { /* a read that failed is not an answer: asked again at the next gap */ }
    if (!still()) return { ok: false, why: 'left', secs: secs() };
    let shown = false;
    try { shown = !!predicate(); } catch { shown = false; }
    if (shown) return { ok: true, secs: secs() };
    try { progress(secs()); } catch { /* the page's repaint is not the wait's */ }
  }
}
