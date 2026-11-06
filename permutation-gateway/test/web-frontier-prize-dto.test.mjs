// The contract between the relay's GET /f/prize?asset= view and the page's
// readers: the REAL Entry decoder (sdk prize.mjs decodeEntryResident) over
// literal bytes → the REAL route mapper (src/frontier/prize-view.mjs
// passView, the one the route serializes) → real JSON serialization →
// fprize.claimIsMine / passClaimModel. Would have caught the omitted
// `claimGeneration` (a rightful same-generation owner read as "claimed by
// another").
//
// PURE: literal bytes and strings only; the decoder base58-encodes bytes
// (an encoding, not a derivation); no key, no PDA or with-seed address, no
// chain. The route's RPC reads and its Citizen-address derivation are NOT
// executed here: the mapper is called with the decoded objects the route
// would pass it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encode as b58 } from '../client/src/base58.mjs';
import { u32le, u64le, utf8 } from '../client/src/bytes.mjs';
import { decodeEntryResident, ENTRY_RESIDENT_SIZE } from '../client/src/frontier/prize.mjs';
import { PASS_ENTRY_VIEW_KEYS, passEntryView, passView, walletEntryView } from '../src/frontier/prize-view.mjs';
import { claimIsMine, passClaimModel } from '../../permutation-server/web/frontier/fprize.mjs';

// Literal 32-byte identities (base58 of filled arrays: an encoding, not a derivation).
const bytes = n => new Uint8Array(32).fill(n);
const A = b58(bytes(0xa1)), B = b58(bytes(0xb2)), ASSET = b58(bytes(0x5a)), POOL = b58(bytes(0x70));
const CITIZEN = 'Citizen41414141414141414141414141414141414141';

/** The 192-byte NFT Entry as the program writes it (permutation-prize `entry_resident`). */
function entryBytes({ claimed = false, claimedBy = null, claimGeneration = 0, paidBy = bytes(0xa1), payGeneration = 0, amount = 25_000_000n, claimAmount = 0n, nation = null } = {}) {
  const d = new Uint8Array(ENTRY_RESIDENT_SIZE);
  d.set(utf8('WYPRNFTE'), 0);
  d[9] = claimed ? 1 : 0;
  if (nation !== null) { d[10] = 1; d[11] = nation; }
  d.set(u32le(payGeneration), 12);
  d.set(bytes(0x70), 16); d.set(bytes(0x5a), 48); d.set(u64le(amount), 80); d.set(u64le(77n), 88); d.set(u64le(claimAmount), 96);
  d.set(paidBy, 104);
  if (claimed) { d.set(claimedBy, 136); d.set(u32le(claimGeneration), 168); }
  return d;
}
/** What the route does: decode the account bytes, project, serialize to JSON, and the page parses it. */
const overTheWire = (data, citizenAccount = { FACTION: 1 }) => JSON.parse(JSON.stringify(passView({ asset: ASSET, citizen: CITIZEN, citizenAccount, entry: decodeEntryResident(data) })));
const pool = pass => ({ decimals: 6, state: 'shares', prize: '40000000', winners: [1], shares: { mode: 'shares', shareNations: 1, totalPoints: ['0', '16', '0', '0', '0', '0'] }, pass });
const resident = generation => ({ asset: ASSET, citizen: CITIZEN, generation, joined: true, proof: {} });

test('the pass view carries claimedBy AND claimGeneration, always as keys, through JSON', () => {
  const unclaimed = overTheWire(entryBytes());
  assert.deepEqual(Object.keys(unclaimed.entry).sort(), [...PASS_ENTRY_VIEW_KEYS].sort());
  assert.deepEqual([unclaimed.asset, unclaimed.citizen, unclaimed.faction, unclaimed.entry.claimed, unclaimed.entry.claimedBy, unclaimed.entry.claimGeneration, unclaimed.entry.paid, unclaimed.entry.paidBy],
    [ASSET, CITIZEN, 1, false, null, null, '25000000', A]);
  assert.ok('claimGeneration' in unclaimed.entry, 'the key is present even unclaimed');
  const claimed = overTheWire(entryBytes({ claimed: true, claimedBy: bytes(0xb2), claimGeneration: 1, claimAmount: 25_000_000n }));
  assert.deepEqual([claimed.entry.claimed, claimed.entry.claimedBy, claimed.entry.claimGeneration, claimed.entry.claimAmount], [true, B, 1, '25000000']);
  // No account at the address: a null entry, the pass and Citizen still named.
  const none = JSON.parse(JSON.stringify(passView({ asset: ASSET, citizen: CITIZEN, citizenAccount: null, entry: decodeEntryResident(null) })));
  assert.deepEqual(none, { asset: ASSET, citizen: CITIZEN, faction: null, entry: null });
  assert.equal(passEntryView(null), null);
  // Bytes that are no NFT Entry decode to nothing.
  assert.equal(decodeEntryResident(entryBytes().slice(0, 191)), null);
  // The wallet view is unchanged in shape.
  assert.deepEqual(walletEntryView({ amount: 1n, claimed: false, claimAmount: 0n, nation: null }), { paid: '1', claimed: false, claimAmount: '0', nation: null });
  assert.equal(walletEntryView(null), null);
});

test('over the real view: the same owner at the same generation is its own claim; an old owner, and A → B → A at an old generation, are not', () => {
  // B claimed at generation 1.
  const byB = overTheWire(entryBytes({ claimed: true, claimedBy: bytes(0xb2), claimGeneration: 1, claimAmount: 25_000_000n })).entry;
  assert.equal(claimIsMine(byB, B, 1), true, 'B, generation 1: its own claim');
  assert.equal(claimIsMine(byB, A, 2), false, 'A, back at generation 2 (A → B → A): B\'s claim, not A\'s');
  assert.equal(claimIsMine(byB, A, 1), false, 'A at B\'s generation: another owner');
  assert.equal(claimIsMine(byB, B, 2), false, 'B after selling and buying back: an older generation\'s claim');
  // A claimed at generation 2 and still holds the pass.
  const byA = overTheWire(entryBytes({ claimed: true, claimedBy: bytes(0xa1), claimGeneration: 2, claimAmount: 25_000_000n })).entry;
  assert.equal(claimIsMine(byA, A, 2), true);
  assert.equal(claimIsMine(byA, A, 3), false);
  // Unclaimed, and no Entry at all: never anyone's claim.
  assert.equal(claimIsMine(overTheWire(entryBytes()).entry, A, 0), false);
  assert.equal(claimIsMine(null, A, 0), false);
  // The model over the same JSON: B sees its own claim, A sees a prior owner's, nobody gets an offer.
  const asB = passClaimModel({ prize: pool({ asset: ASSET, citizen: CITIZEN, faction: 1, entry: byB }), resident: resident(1), wallet: { address: B } });
  assert.deepEqual([asB.state, asB.entry.claimedByOther, asB.entry.claimedBy, asB.entry.claimGeneration, asB.offer], ['claimed', false, B, 1, null]);
  const asA = passClaimModel({ prize: pool({ asset: ASSET, citizen: CITIZEN, faction: 1, entry: byB }), resident: resident(2), wallet: { address: A } });
  assert.deepEqual([asA.state, asA.entry.claimedByOther, asA.offer], ['claimed', true, null]);
  const unclaimedForA = passClaimModel({ prize: pool({ asset: ASSET, citizen: CITIZEN, faction: 1, entry: overTheWire(entryBytes()).entry }), resident: resident(0), wallet: { address: A } });
  assert.notEqual(unclaimedForA.state, 'claimed');
});

test('an omitted claimGeneration is detected: the view that drops it mislabels the rightful owner, the real view does not', () => {
  const real = overTheWire(entryBytes({ claimed: true, claimedBy: bytes(0xa1), claimGeneration: 2, claimAmount: 25_000_000n })).entry;
  assert.equal(claimIsMine(real, A, 2), true);
  // The earlier route projection (claimedBy without claimGeneration), reproduced from the same decode.
  const stale = JSON.parse(JSON.stringify({ ...real, claimGeneration: undefined }));
  assert.equal('claimGeneration' in stale, false);
  assert.equal(claimIsMine(stale, A, 2), false, 'without the generation the rightful owner reads as another\'s claim');
  assert.equal(passClaimModel({ prize: pool({ asset: ASSET, citizen: CITIZEN, faction: 1, entry: stale }), resident: resident(2), wallet: { address: A } }).entry.claimedByOther, true);
  assert.equal(passClaimModel({ prize: pool({ asset: ASSET, citizen: CITIZEN, faction: 1, entry: real }), resident: resident(2), wallet: { address: A } }).entry.claimedByOther, false);
});
