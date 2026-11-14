// The relay's answer for a claimed Entry (src/frontier/claim-outcome.mjs,
// the rule routes/prize.mjs applies to a wallet Claim and an NFT pass
// ClaimResident alike): the received fact (claimed, for good) kept apart
// from the transaction evidence (the prior signature only when finalized
// without error), and who was paid (owner and generation for a pass).
//
// PURE: literal objects only; no key, no address derivation, no chain. The
// route's RPC reads are not executed here; the helper is called with the
// decoded Entry and signature status the route would pass it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claimedEntryAnswer, finalizedOk } from '../src/frontier/claim-outcome.mjs';

const POOL = 'Pool1111111111111111111111111111111111111111';
const WALLET = 'WaLLet1111111111111111111111111111111111111';
const OWNER_B = 'OwnerB22222222222222222222222222222222222222';
const ASSET = 'Asset5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5';
const SIG = '5sigPrior1111111111111111111111111111111111111111111111111111111111111111111111111111';
const prior = { status: 'pending', signature: SIG };
const ok = { confirmationStatus: 'finalized', err: null };
const err = { confirmationStatus: 'finalized', err: { InstructionError: [0, { Custom: 0x10d }] } };
const confirmed = { confirmationStatus: 'confirmed', err: null };

// The wallet claim's view (sdk decodeEntry) and its rule: the Entry's wallet, claimed by it only.
const walletEntry = (claimed, extra = {}) => ({ wallet: WALLET, pool: POOL, claimed, amount: 25_000_000n, claimAmount: claimed ? 20_000_000n : 0n, ...extra });
const walletRule = { pool: POOL, owns: e => e?.wallet === WALLET, mine: () => true, fallbackClaimer: WALLET };
// The pass claim's view (sdk decodeEntryResident) and its rule: this owner at this signed generation.
const passEntry = (claimedBy, claimGeneration, extra = {}) => ({ asset: ASSET, pool: POOL, claimed: !!claimedBy, amount: 25_000_000n, claimAmount: claimedBy ? 25_000_000n : 0n, claimedBy, claimGeneration, ...extra });
const passRule = (owner, generation) => ({ pool: POOL, owns: e => e?.asset === ASSET, mine: e => e?.claimedBy === owner && e?.claimGeneration === generation, fallbackClaimer: owner });

test('a signature is evidence only when finalized without error', () => {
  assert.equal(finalizedOk(ok), true);
  for (const s of [err, confirmed, null, undefined, {}, { confirmationStatus: 'processed' }, { confirmationStatus: 'finalized', err: 'x' }]) assert.equal(finalizedOk(s), false, JSON.stringify(s));
});

test('legacy wallet: a claimed Entry is reported claimed; the prior signature comes back only with finalized-ok evidence', () => {
  const landed = claimedEntryAnswer({ entry: walletEntry(true), ...walletRule, prior, status: ok });
  assert.deepEqual(landed, { kind: 'already', signature: SIG, priorStatus: 'landed', claimedBy: WALLET, claimGeneration: null, amount: '20000000' });
  for (const status of [err, confirmed, null]) {
    const a = claimedEntryAnswer({ entry: walletEntry(true), ...walletRule, prior, status });
    assert.deepEqual([a.kind, a.signature, a.priorStatus, a.amount], ['already', null, 'superseded', '20000000'], `status ${JSON.stringify(status)}: the fact, no evidence`);
  }
  // No prior attempt at all (the claim landed elsewhere): the fact, no signature, nothing to close.
  assert.deepEqual(claimedEntryAnswer({ entry: walletEntry(true), ...walletRule }), { kind: 'already', signature: null, priorStatus: null, claimedBy: WALLET, claimGeneration: null, amount: '20000000' });
  // Unclaimed, absent, another wallet's, another pool's: never "claimed".
  assert.deepEqual(claimedEntryAnswer({ entry: walletEntry(false), ...walletRule, prior, status: ok }), { kind: 'unclaimed' });
  assert.deepEqual(claimedEntryAnswer({ entry: null, ...walletRule, prior, status: ok }), { kind: 'unclaimed' });
  assert.deepEqual(claimedEntryAnswer({ entry: walletEntry(true, { wallet: OWNER_B }), ...walletRule, prior, status: ok }), { kind: 'unclaimed' });
  assert.deepEqual(claimedEntryAnswer({ entry: walletEntry(true, { pool: 'Other' }), ...walletRule, prior, status: ok }), { kind: 'unclaimed' });
});

test('NFT pass: the claim is this requester\'s only when the Entry names it at the signed generation; otherwise a prior owner\'s, with the same evidence rule', () => {
  const byB1 = passEntry(OWNER_B, 1);
  // B at generation 1, with and without evidence.
  assert.deepEqual(claimedEntryAnswer({ entry: byB1, ...passRule(OWNER_B, 1), prior, status: ok }), { kind: 'already', signature: SIG, priorStatus: 'landed', claimedBy: OWNER_B, claimGeneration: 1, amount: '25000000' });
  assert.deepEqual(claimedEntryAnswer({ entry: byB1, ...passRule(OWNER_B, 1), prior, status: err }).signature, null);
  assert.equal(claimedEntryAnswer({ entry: byB1, ...passRule(OWNER_B, 1), prior, status: confirmed }).priorStatus, 'superseded');
  // A at generation 2 (A → B → A), A at B's generation, B after a buy-back at generation 2: a prior owner's or generation's claim.
  for (const [owner, generation] of [[WALLET, 2], [WALLET, 1], [OWNER_B, 2]]) {
    const a = claimedEntryAnswer({ entry: byB1, ...passRule(owner, generation), prior, status: ok });
    assert.deepEqual([a.kind, a.claimedBy, a.claimGeneration, a.signature, a.priorStatus], ['claimedByOther', OWNER_B, 1, SIG, 'landed'], `${owner} @ ${generation}`);
    const noEvidence = claimedEntryAnswer({ entry: byB1, ...passRule(owner, generation), prior, status: err });
    assert.deepEqual([noEvidence.kind, noEvidence.signature, noEvidence.priorStatus], ['claimedByOther', null, 'superseded']);
    assert.deepEqual(claimedEntryAnswer({ entry: byB1, ...passRule(owner, generation) }).signature, null, 'no prior: no signature');
  }
  // Unclaimed and absent: never claimed; another pass's Entry: not this subject's.
  assert.deepEqual(claimedEntryAnswer({ entry: passEntry(null, null), ...passRule(WALLET, 0), prior, status: ok }), { kind: 'unclaimed' });
  assert.deepEqual(claimedEntryAnswer({ entry: null, ...passRule(WALLET, 0) }), { kind: 'unclaimed' });
  assert.deepEqual(claimedEntryAnswer({ entry: passEntry(WALLET, 2, { asset: 'OtherAsset' }), ...passRule(WALLET, 2), prior, status: ok }), { kind: 'unclaimed' });
  // A view without the generation never counts as the owner's (the DTO contract keeps it).
  assert.equal(claimedEntryAnswer({ entry: passEntry(WALLET, undefined), ...passRule(WALLET, 2) }).kind, 'claimedByOther');
});
