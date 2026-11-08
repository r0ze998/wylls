#!/usr/bin/env node
// Regenerates scenarios/fixtures/ws01-3f3c8478.json from ①'s own code (no keys,
// no signatures: only the pure functions coop/arrival.mjs `arrivalOf`,
// `creditedOf`, `indexFeed`). Extract ①'s files first (read only):
//   git archive 3f3c8478b0a37a7ecfd6ca4641b8d47fb58aff52 workstreams/01-national-strategy permutation-server/web/sdk permutation-server/web/frontier | tar -x -C <dir>
//   node workstreams/15-coop-outcomes/scenarios/fixtures/gen-ws01.mjs <dir>
// The herald file is ①'s committed test fixture; the chain ends follow the
// shape ①'s coop/chain.mjs `caravanEndFromChain` returns (documented there).
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(process.argv[2] ?? '');
const ws = `${root}/workstreams/01-national-strategy`;
const { arrivalOf, creditedOf, indexFeed } = await import(`${ws}/coop/arrival.mjs`);
const herald = JSON.parse(readFileSync(`${ws}/test/fixtures/herald-caravans-ended.json`, 'utf8'));
const feed = indexFeed(herald);
const village = { kind: 1, p: 3, q: 0, at: 2, gen: 1, tile: 20 };
// A request as fold() makes it (coop/record.mjs): an object keyed by id, links in record order (n).
const request = { id: 'req-a', goalId: 'crossing-storehouse-v1', requester: 'W-n1-0', nation: 1, need: { wood: 200, stone: 100 }, to: { kind: 'holding', p: 3, q: 0, site: 2, gen: 1 }, at: 1790000000, expiresAt: 1790100000, state: 'open', cancel: null, responses: {}, links: [] };
const link = (tag, seq, n) => ({ responder: `W-${tag}`, claimedNation: 2, caravan: { ownerTag: tag, seq }, at: 1790000600 + n, n });
const cases = {
  'chain village (lower bound)': [link('88', 0, 1), { status: 'settled', settled: { outcome: 0, dst: village, cargo: [0, 114, 0, 0, 0, 0, 0, 0], signature: 'sigA' }, raided: null }],
  'chain storehouse at the address (unverified)': [link('88', 1, 2), { status: 'settled', settled: { outcome: 0, dst: { ...village, kind: 2 }, cargo: [0, 0, 80, 0, 0, 0, 0, 0], signature: 'sigB' }, raided: null }],
  'chain lost': [link('88', 3, 3), { status: 'settled', settled: { outcome: 1, dst: village, cargo: [0, 50, 0, 0, 0, 0, 0, 0], signature: 'sigC' }, raided: null }],
  'chain elsewhere': [link('88', 4, 4), { status: 'settled', settled: { outcome: 0, dst: { ...village, p: 9 }, cargo: [0, 60, 0, 0, 0, 0, 0, 0], signature: 'sigD' }, raided: null }],
  'chain burned': [link('88', 5, 5), { status: 'raided', settled: null, raided: { choice: 1, raiderTag: '99', signature: 'sigE' } }],
  'chain taken': [link('88', 2, 6), { status: 'raided', settled: null, raided: { choice: 0, raiderTag: '99', signature: 'sigF' } }],
  'herald only (no chain read)': [link('88', 0, 7), undefined],
  'chain has nothing yet': [link('88', 6, 8), { status: 'none', why: 'none yet' }],
};
const arrivals = {};
for (const [name, [l, end]] of Object.entries(cases)) arrivals[name] = arrivalOf(request, l, feed, end);
const out = {
  source: { repo: 'r0ze998/wylls', branch: 'preserve/ws01-coop-s1-3f3c8478', commit: '3f3c8478b0a37a7ecfd6ca4641b8d47fb58aff52', code: 'workstreams/01-national-strategy/coop/arrival.mjs arrivalOf, creditedOf; herald file test/fixtures/herald-caravans-ended.json', note: 'Produced by ①\'s functions. Chain ends are inputs in the shape caravanEndFromChain returns; no chain was read.' },
  request: { ...request, links: Object.values(cases).map(([l]) => l) },
  arrivals,
  creditedOf: { village: creditedOf({ dst: village, cargo: [0, 114, 0, 0, 0, 0, 0, 0] }), storehouse: creditedOf({ dst: { ...village, kind: 2 }, cargo: [0, 0, 80, 0, 0, 0, 0, 0] }) },
};
writeFileSync(new URL('./ws01-3f3c8478.json', import.meta.url), `${JSON.stringify(out, null, 1)}\n`);
console.log(Object.entries(arrivals).map(([k, a]) => `${k}: ${a.state} ${a.source} ${JSON.stringify(a.verifiedQty)} ${a.qtyKind ?? ''}`).join('\n'));
