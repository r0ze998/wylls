#!/usr/bin/env node
// Regenerates scenarios/fixtures/ws01-fold-3f3c8478.json by running ①'s own
// `fold()` (coop/record.mjs) and `arrivalOf()` (coop/arrival.mjs) at
// 3f3c8478, the newest ① on GitHub. Extract ①'s files first (read only):
//   git archive 3f3c8478b0a37a7ecfd6ca4641b8d47fb58aff52 workstreams/01-national-strategy permutation-server/web/sdk permutation-server/web/frontier | tar -x -C <dir>
//   node workstreams/15-coop-outcomes/scenarios/fixtures/gen-ws01-fold.mjs <dir>
//
// No keys, no signatures. `fold()` checks only that `sig` is a string; it never
// verifies one (the board does that before a record is kept). Each record here
// carries the placeholder `sig: 'unsigned'`. The wallets are fixed 32-byte public
// addresses (bytes 0x11…, 0x22…): no key pair exists for them. The one
// computation on them is ①'s `ownerTagOf`: it hashes public data into the
// Citizen account address (createWithSeed and the Season PDA) and takes its
// first 8 bytes. No secret key is generated, derived or used.
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(process.argv[2] ?? '');
const ws = `${root}/workstreams/01-national-strategy`;
const { fold, recordId, ownerTagOf } = await import(`${ws}/coop/record.mjs`);
const { GOALS } = await import(`${ws}/coop/goal.mjs`);
const { arrivalOf, indexFeed } = await import(`${ws}/coop/arrival.mjs`);
const { encode: b58 } = await import(`${root}/permutation-server/web/sdk/base58.mjs`);

const addr = b => b58(new Uint8Array(32).fill(b));
const season = { programId: addr(3), seasonId: '90' }; // as ①'s own test (coop.test.mjs)
const W = { A: addr(0x11), B: addr(0x22), C: addr(0x33), D: addr(0x44) };
const tag = w => ownerTagOf(season, w);
const T0 = 1790000000;
const to = { kind: 'holding', p: 3, q: 0, site: 2, gen: 1 };
const rec = (signer, kind, at, body) => ({ v: 1, kind, signer, season, at, ...body, sig: 'unsigned' });

const req1 = rec(W.A, 'request', T0, { goalId: 'crossing-storehouse-v1', nation: 1, need: { wood: 200, stone: 200 }, to, expiresAt: T0 + 86400, nonce: 'r1' });
const R1 = recordId(req1);
const req2 = rec(W.D, 'request', T0 + 10, { goalId: 'crossing-storehouse-v1', nation: 4, need: { wood: 50 }, to: { ...to, p: 5 }, expiresAt: T0 + 86400, nonce: 'r2' });
const R2 = recordId(req2);
const linkB0 = rec(W.B, 'link', T0 + 300, { request: R1, caravan: { ownerTag: tag(W.B), seq: 0 } });
const records = [
  ['request A (nation 1)', req1],
  ['request D (nation 4)', req2],
  ['B accepts wood', rec(W.B, 'respond', T0 + 100, { request: R1, answer: 'accept', nation: 2, offer: { wood: 200 } })],
  ['C accepts stone', rec(W.C, 'respond', T0 + 110, { request: R1, answer: 'accept', nation: 3, offer: { stone: 200 } })],
  ['A answers own request', rec(W.A, 'respond', T0 + 120, { request: R1, answer: 'accept', nation: 1, offer: { wood: 10 } })],
  ['B accepts D', rec(W.B, 'respond', T0 + 130, { request: R2, answer: 'accept', nation: 2, offer: { wood: 50 } })],
  ['B links own caravan 0', linkB0],
  ['the same link record again', linkB0],
  ['C links B\'s caravan', rec(W.C, 'link', T0 + 310, { request: R1, caravan: { ownerTag: tag(W.B), seq: 1 } })],
  ['C links own caravan 0', rec(W.C, 'link', T0 + 320, { request: R1, caravan: { ownerTag: tag(W.C), seq: 0 } })],
  ['B links caravan 0 again (another record)', rec(W.B, 'link', T0 + 330, { request: R1, caravan: { ownerTag: tag(W.B), seq: 0 } })],
  ['B links caravan 2', rec(W.B, 'link', T0 + 340, { request: R1, caravan: { ownerTag: tag(W.B), seq: 2 } })],
  ['D cancels', rec(W.D, 'cancel', T0 + 400, { request: R2, reason: 'self' })],
  ['B links to cancelled request', rec(W.B, 'link', T0 + 410, { request: R2, caravan: { ownerTag: tag(W.B), seq: 3 } })],
  ['record of another season', rec(W.C, 'respond', T0 + 420, { season: { ...season, seasonId: '91' }, request: R1, answer: 'decline', nation: 3 })],
];
const state = fold(records.map(([, r]) => r), { goals: GOALS, season });

// Chain ends in the shape ①'s coop/chain.mjs `caravanEndFromChain` returns (no chain was read):
// B's caravan 0 settles at the village (lower bound), C's caravan 0 at a storehouse on the same
// spot (① proves no amount there), B's caravan 2 is lost.
const village = { kind: 1, p: 3, q: 0, at: 2, gen: 1, tile: 20 };
const r1 = state.requests[R1];
const ends = {
  [`${tag(W.B)}:0`]: { status: 'settled', settled: { outcome: 0, dst: village, cargo: [0, 180, 0, 0, 0, 0, 0, 0], signature: 'chain-sig-1' }, raided: null },
  [`${tag(W.C)}:0`]: { status: 'settled', settled: { outcome: 0, dst: village, cargo: [0, 0, 200, 0, 0, 0, 0, 0], signature: 'chain-sig-2' }, raided: null },
  [`${tag(W.B)}:2`]: { status: 'settled', settled: { outcome: 1, dst: village, cargo: [0, 20, 0, 0, 0, 0, 0, 0], signature: 'chain-sig-3' }, raided: null },
};
const arrivals = r1.links.map(l => arrivalOf(r1, l, indexFeed({ caravans: [] }), ends[`${l.caravan.ownerTag}:${l.caravan.seq}`]));

const out = {
  source: {
    repo: 'r0ze998/wylls', branch: 'preserve/ws01-coop-s1-3f3c8478', commit: '3f3c8478b0a37a7ecfd6ca4641b8d47fb58aff52',
    code: 'workstreams/01-national-strategy/coop/record.mjs fold, recordId, ownerTagOf; coop/goal.mjs GOALS; coop/arrival.mjs arrivalOf',
    note: 'state is fold()\'s return value, as ① produced it. Records carry sig "unsigned" (fold does not verify signatures). Wallets are fixed public addresses; no key was generated, derived or used. Chain ends are inputs in caravanEndFromChain\'s shape; no chain was read.',
  },
  season,
  wallets: W,
  ownerTags: Object.fromEntries(Object.entries(W).map(([k, w]) => [k, tag(w)])),
  records: records.map(([name, r]) => ({ name, id: recordId(r), record: r })),
  state,
  arrivals,
};
writeFileSync(new URL('./ws01-fold-3f3c8478.json', import.meta.url), `${JSON.stringify(out, null, 1)}\n`);
console.log('accepted', state.accepted.length, 'rejected', state.rejected.map(r => r.why).join(' / '));
console.log('tags', JSON.stringify(out.ownerTags));
console.log(arrivals.map(a => `${a.caravanId.ownerTag}:${a.caravanId.seq} ${a.state} ${a.source} ${JSON.stringify(a.verifiedQty)} ${a.qtyKind ?? ''}`).join('\n'));
