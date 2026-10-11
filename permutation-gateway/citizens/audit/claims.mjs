// What an opening or a published range CLAIMS, read against what the herald and the chain say (unit FB3; reviewer findings D2 of the wave-B audit review).
//
// verify-minds M3 used to take three things from files the operator writes: the label of an opening's destination ("unrevealed", "not_sent",
// "planned" skipped the REVEAL comparison and moved the due bell), the first and last bell that have a file (so a removed tail passed), and a
// `redacted` flag (so a flag could stand for a record). The helpers here tie each of them to a public source:
//
//   departOf(feed, host, decisionBell)     the DEPART the release job matches (the same window: a bell before the decision to four after it)
//   unrevealedClaimProblem(...)            an "unrevealed" claim is false when a REVEAL of the march was public before the release job gave up
//   marchSentInTx(tx)                      a sent march in a record's tx list (the release job's own MARCH_INTENTS and `status: sent`)
//   registrarMemos(rpc, registrar, season) every anchor memo the registrar sent, by bell, from the chain (not from the published files)
//
// Pure over a feed (`events(bell)`, `revealOf`) and an rpc (`call`); no files, no network of their own.

/** The release job's reading of a march (watcher/release.mjs MARCH_INTENTS): a depart, a march or a recall the brain sent. */
export const MARCH_INTENTS = new Set(['depart', 'march', 'recall']);
/** Depart is the game instruction 0x50 (frontier-abi tags.rs); the only instruction that sends a host on a march. */
export const DEPART_TAG = 0x50;
/** The release job waits at most this many bells after the end of the bell `release_bell` for a REVEAL (7.2). */
export const UNREVEALED_WAIT_BELLS = 6;

/** The DEPART of `host` that the release job would match for a decision at `decisionBell` (watcher/release.mjs `departOf`), or null. */
export function departOf(feed, host, decisionBell) {
  for (let b = Math.max(0, decisionBell - 1); b <= decisionBell + 4; b++) {
    for (const ev of feed.events(b)) if (ev.kind === 'DEPART' && String(ev.host_id) === String(host) && ev.depart_bell >= decisionBell - 1) return ev;
  }
  return null;
}

/** The marches that name a host the opening can show (a recall is a march for sealing, but the plan's `intended` list may not name its host). */
export const HOSTED_MARCH_INTENTS = new Set(['depart', 'march']);

/** Did the record's tx list send a march? true | false (a list with no sent march) | null (no list at all). */
export function marchSentInTx(tx, intents = MARCH_INTENTS) {
  if (!Array.isArray(tx) || !tx.length) return null;
  return tx.some(t => intents.has(t.intent) && t.status === 'sent');
}

/**
 * An "unrevealed" destination is a claim that no REVEAL of the march was public when the release job gave up (6 bells after `release_bell`).
 * Returns null when the claim stands (no REVEAL, or one logged later than that), else the REVEAL that contradicts it.
 * The arrival bell is not taken from the opening: the planned one and the one of the public DEPART are both looked up.
 */
export function unrevealedClaimProblem({ feed, host, plannedArrive, decisionBell, releaseBell }) {
  const arrives = new Set();
  if (Number.isInteger(plannedArrive)) arrives.add(plannedArrive);
  const d = departOf(feed, host, decisionBell);
  if (d && Number.isInteger(d.arrive_bell)) arrives.add(d.arrive_bell);
  for (const a of arrives) {
    const rv = feed.revealOf(String(host), a);
    if (rv && Number.isInteger(rv.bell) && rv.bell <= releaseBell + UNREVEALED_WAIT_BELLS) return { arrive_bell: a, reveal_log_bell: rv.bell, depart_bell: d?.depart_bell ?? null, p: rv.p, q: rv.q, tile: rv.tile };
  }
  return null;
}

/** The REVEAL a "planned" destination can be compared with (the planned arrival or the arrival of the public DEPART), or null. */
export function publicRevealFor({ feed, host, plannedArrive, decisionBell }) {
  const d = departOf(feed, host, decisionBell);
  for (const a of [plannedArrive, d?.arrive_bell]) {
    if (!Number.isInteger(a)) continue;
    const rv = feed.revealOf(String(host), a);
    if (rv) return rv;
  }
  return null;
}

const MEMO_RE = /^wylls-ai\/1 (\d+) (\d+) ([0-9a-f]{64}) ([0-9a-f]{64})$/;

/**
 * Every anchor memo the registrar sent for `season`, by bell, read from the chain: `getSignaturesForAddress(registrar)` pages, then
 * `getTransaction` of each (the memo text and the first signer). `memoOf(tx)` is verify-minds' reader. Returns
 * `Map<bell, [{signature, social_root, minds_root, signer, slot}]>`. Throws when the registrar's history cannot be read.
 */
export async function registrarMemos({ rpc, tx, memoOf, registrar, season }) {
  const sigs = [];
  let before = null;
  for (let page = 0; page < 200; page++) {
    const rows = await rpc.call('getSignaturesForAddress', [registrar, { limit: 1000, ...(before ? { before } : {}) }]);
    if (!Array.isArray(rows)) throw new Error('getSignaturesForAddress did not return a list');
    if (!rows.length) break;
    sigs.push(...rows);
    if (rows.length < 1000) break;
    before = rows[rows.length - 1].signature;
  }
  const out = new Map();
  for (const row of sigs) {
    const t = await tx(row.signature);
    const m = t ? memoOf(t) : null;
    const hit = m && m.signer === registrar ? MEMO_RE.exec(m.text) : null;
    if (!hit || Number(hit[1]) !== Number(season)) continue;
    const bell = Number(hit[2]);
    (out.get(bell) ?? out.set(bell, []).get(bell)).push({ signature: row.signature, social_root: hit[3], minds_root: hit[4], signer: m.signer, slot: t.slot });
  }
  return out;
}
