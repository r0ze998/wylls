// Records of finished runs on the local test chain, copied as the herald and the relay served them, for the
// `?fx=hand-…` samples (hud/handdemo.mjs, under the demo tag) and for the unit tests. Nothing here is made up:
//   KEEP_4_M1     /h/keep/4,-1.json of the run "ux-check": Fjordal's keep, Aster's host on its tile from turn 12,
//                 72 turns held, the capture at turn 83 with its transaction signature
//   STANDINGS_*   /h/standings/latest.json of the same run before the capture (9 provinces each) and at turn 92
//   POOL_FINAL, LEDGER   the prize pool of the season "ai-cq-season-3" after Tally and Finalize (area 11/8/9/9/9/8,
//                 winner Aster; three paid entries of 25 test USDC) and its published ledger (two capture lines, one
//                 reinforcement line, the estimated split)
//   CLASH_REF     the reference of a battle record of the run "ux-check" (/h/clash/4,-1/12): its slot. The herald's
//                 clash view carries no transaction signature.
export const KEEP_4_M1 = Object.freeze({ v: 1, p: 4, q: -1, tile: 10, holder: 0, since: 84, troops: 241, gen: 1, heartland: false,
  holders: [{ holder: 5, since: 0 }, { holder: 0, since: 84 }],
  contests: [{ contender: 0, from: 12, to: 83, outcome: 'taken', progress: 72 }],
  captures: [{ bell: 83, from: 5, to: 0, troops: 241, donor: '135244225183744', seq: '10696', sig: '4WwZktjF2KUobqepbfLWNhCPWXAWGcbYLBSAQfwYKkPGge7feRf6SwdcsLX17pee8xmDgXHL6wtM25HuAvidVBMK' }] });

const table = (bell, provinces) => ({ metric: 'province-bells', bell, rows: provinces.map((n, faction) => ({ faction, provinces: n, provinceBells: String(n * bell) })) });
export const STANDINGS_BEFORE = Object.freeze(table(82, [9, 9, 9, 9, 9, 9]));
export const STANDINGS_AFTER = Object.freeze(table(92, [10, 9, 9, 9, 9, 8]));

export const POOL_FINAL = Object.freeze({ testAssetsOnly: true, decimals: 6, fee: '25000000', opsBps: 2000, prizeBps: 8000, entries: 3, collected: '75000000', prize: '60000000', ops: '15000000',
  state: 'final', expectedKeeps: 54, counted: 54, area: [11, 8, 9, 9, 9, 8], winners: [0], shares: null, wallet: null });

export const LEDGER = Object.freeze({ provisional: true, kinds: { capture: { derivable: true }, reinforcement: { derivable: true }, defence: { derivable: false }, resourceSupply: { derivable: false } },
  lines: [
    { kind: 'capture', wallet: '4yWQ2bBEi1CNkZxvZ3z3kFGoo9477En3ueTFF9qoxUZF', nation: 0, province: { p: 0, q: 4 }, quantity: 1, unit: 'province', bell: 85, signatures: ['4GLCK5hPVTGajsak9jPHqfpbhMkGS2cftydpnkkocZcEVfKVxauXgehRZrmCqSzdCbQV74aeNMWAhs4ZsFLsf888'], player: 'paid', eligible: true, points: 10 },
    { kind: 'capture', wallet: '5ywv9JVHZnJxeiaVET7B27aPWzQyVThkLoFLFQRMmqDT', nation: 0, province: { p: 4, q: -1 }, quantity: 1, unit: 'province', bell: 84, signatures: ['23nX9sYugxWxWW169HAtp91V4MafinKwrcfpuzunAdb4qpozXqk9snLXtG5tEsz8a6jFZDZ44zsJkDEeXLrWRZaP'], player: 'paid', eligible: true, points: 10 },
    { kind: 'reinforcement', wallet: '6oWvAmAJAGTkEz8QHChgMaSwMXBuTGtq1WioZoCEyDeq', nation: 0, province: { p: 4, q: -1 }, quantity: 483, unit: 'troops', bell: 16, signatures: ['4xSEMhThfbxS4zgyA2H47ofFSbro15RodBrV6HyREJwxvBRMCxLtzCgTSYyMyzksTUM3s4vezqxFiFgfuMdeEX5N'], player: 'paid', eligible: true, points: 4 },
  ],
  shares: { mode: 'shares' },
  estimate: { split: [{ wallet: '4yWQ2bBEi1CNkZxvZ3z3kFGoo9477En3ueTFF9qoxUZF', nation: 0, points: 10, amount: '25000000' }, { wallet: '5ywv9JVHZnJxeiaVET7B27aPWzQyVThkLoFLFQRMmqDT', nation: 0, points: 10, amount: '25000000' }, { wallet: '6oWvAmAJAGTkEz8QHChgMaSwMXBuTGtq1WioZoCEyDeq', nation: 0, points: 4, amount: '10000000' }] } });

export const CLASH_REF = Object.freeze({ p: 4, q: -1, bell: 12, slot: 1074, sig: null });

/** A keep as the controller holds it (FS.conquest.keeps), from a /h/keep record: at `bell`, before or after its capture. */
export function keepAt(rec, bell) {
  const cap = rec.captures.find(c => c.bell < bell) ?? null;
  const run = rec.contests.find(c => c.from <= bell && bell <= (c.to ?? Infinity) && !cap) ?? null;
  const holder = cap ? cap.to : rec.holders[0].holder;
  return { p: rec.p, q: rec.q, tile: rec.tile, holder, troops: cap ? cap.troops : 100, heartland: rec.heartland, consolidatedUntil: cap ? cap.bell + 288 : 0,
    contender: run ? run.contender : 255, progress: run ? Math.min(72, bell - run.from + 1) : 0, requiredBells: 72, asOfBell: bell };
}
/** The /h/keep record as it stood at `bell` (the history the panel reads): contests and captures up to then. */
export function recordAt(rec, bell) {
  const captures = rec.captures.filter(c => c.bell < bell);
  return { ...rec, holders: rec.holders.filter(h => h.since <= bell), captures, asOf: bell,
    contests: rec.contests.filter(c => c.from <= bell).map(c => (c.to !== null && c.to < bell ? c : { ...c, to: null, outcome: 'running', progress: Math.min(72, bell - c.from + 1) })) };
}
