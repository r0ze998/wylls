// ⑰ (2026-11-15): the page's local-play pass claim (fprize.mjs loadPrizeLocal / claimPassLocal). Pure: a real compiled
// message with literal keys, a mocked relay and a mocked wallet that fills in a FAKE 64-byte signature (no key is made;
// the relay's real-signature checks are tested on its side, local-play-prize-signed.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encode as b58 } from '../client/src/base58.mjs';
import { compileMessage, wireTransaction } from '../../permutation-server/web/sdk/solana-tx.mjs';
import { claimPassLocal, LOCAL_PRIZE, loadPrizeLocal } from '../../permutation-server/web/frontier/fprize.mjs';

const k = n => b58(new Uint8Array(32).fill(n));
const WALLET = k(0xa1), ASSET = k(0x5a);
const message = Uint8Array.from(compileMessage({ feePayer: WALLET, recentBlockhash: k(0x09),
  instructions: [{ programId: k(0x50), keys: [{ pubkey: WALLET, isSigner: true, isWritable: true }], data: Uint8Array.of(9) }] }));
const other = Uint8Array.from(compileMessage({ feePayer: WALLET, recentBlockhash: k(0x08),
  instructions: [{ programId: k(0x50), keys: [{ pubkey: WALLET, isSigner: true, isWritable: true }], data: Uint8Array.of(9) }] }));
const b64 = u8 => Buffer.from(u8).toString('base64');
const wallet = (msg = message) => ({ signTransaction: async () => wireTransaction(msg, [new Uint8Array(64).fill(7)]) });
/** A mocked relay: answers by path; records requests. */
function relay(answers) {
  const seen = [];
  const request = async (method, path, opts = {}) => { seen.push([method, path, opts.body ?? null]); const a = answers[path]; return typeof a === 'function' ? a(opts.body) : a; };
  return { request, seen };
}
const prepared = { ok: true, status: 'prepared', message_digest: 'ab'.repeat(32), message_b64: b64(message) };

test('load: the TEST ONLY pool through /f/local-play/prize; no pool is "no pool", not an error', async () => {
  const r = relay({ [`${LOCAL_PRIZE.view}?asset=${ASSET}`]: { ok: true, testOnly: true, pool: { state: 'shares', pass: { asset: ASSET } } } });
  const v = await loadPrizeLocal({ asset: ASSET, request: r.request });
  assert.deepEqual([v.ok, v.testOnly, v.pool.pass.asset], [true, true, ASSET]);
  const none = await loadPrizeLocal({ request: relay({ [LOCAL_PRIZE.view]: { ok: false, code: 'LocalPrizeNoPool', httpStatus: 404 } }).request });
  assert.deepEqual(none, { ok: true, pool: null });
});

test('claim: prepare → the wallet signs exactly that message → one submit', async () => {
  const r = relay({ [LOCAL_PRIZE.prepare]: prepared, [LOCAL_PRIZE.submit]: { ok: true, status: 'submitted', signature: 'sig1' } });
  const out = await claimPassLocal({ wallet: wallet(), asset: ASSET, generation: 2, request: r.request });
  assert.deepEqual([out.ok, out.sent, out.signature], [true, true, 'sig1']);
  assert.deepEqual(r.seen.map(x => x[1]), [LOCAL_PRIZE.prepare, LOCAL_PRIZE.submit]);
  assert.deepEqual(r.seen[0][2], { schema: LOCAL_PRIZE.prepareSchema, asset: ASSET, generation: 2 });
  assert.equal(r.seen[1][2].message_digest, prepared.message_digest);
});

test('before the submit nothing is definite-sent: prepare refused, wallet refused, or the wallet changed the message → notSent', async () => {
  const refused = await claimPassLocal({ wallet: wallet(), asset: ASSET, generation: 2, request: relay({ [LOCAL_PRIZE.prepare]: { ok: false, code: 'SharesNotPosted' } }).request });
  assert.deepEqual([refused.ok, refused.notSent, refused.code], [false, true, 'SharesNotPosted']);
  const r = relay({ [LOCAL_PRIZE.prepare]: prepared, [LOCAL_PRIZE.submit]: () => { throw new Error('must not submit'); } });
  const noSign = await claimPassLocal({ wallet: { signTransaction: async () => { throw Object.assign(new Error('rejected'), { code: 'UserRejected' }); } }, asset: ASSET, generation: 2, request: r.request });
  assert.deepEqual([noSign.notSent, noSign.code], [true, 'UserRejected']);
  const altered = await claimPassLocal({ wallet: wallet(other), asset: ASSET, generation: 2, request: r.request });
  assert.deepEqual([altered.notSent, altered.code], [true, 'WalletAlteredMessage']);
  assert.equal(r.seen.filter(x => x[1] === LOCAL_PRIZE.submit).length, 0, 'nothing was submitted');
});

test('an earlier claim: "already" for this owner and generation; "claimedByOther" → AlreadyClaimedByPriorOwner, nothing sent', async () => {
  const mine = await claimPassLocal({ wallet: wallet(), asset: ASSET, generation: 2, request: relay({ [LOCAL_PRIZE.prepare]: { ok: true, status: 'already', signature: 'old', amount: '25000000' } }).request });
  assert.deepEqual([mine.ok, mine.already, mine.sent, mine.landed], [true, true, false, true]);
  const prior = await claimPassLocal({ wallet: wallet(), asset: ASSET, generation: 2, request: relay({ [LOCAL_PRIZE.prepare]: { ok: true, status: 'claimedByOther', claimedBy: k(0xb2), claimGeneration: 1 } }).request });
  assert.deepEqual([prior.ok, prior.notSent, prior.code, prior.priorClaim], [false, true, 'AlreadyClaimedByPriorOwner', { claimedBy: k(0xb2), claimGeneration: 1 }]);
});

test('after the submit nothing is called failed: a refused or unknown submit keeps the signature and is not resent', async () => {
  const unknown = await claimPassLocal({ wallet: wallet(), asset: ASSET, generation: 2, request: relay({ [LOCAL_PRIZE.prepare]: prepared, [LOCAL_PRIZE.submit]: { ok: true, status: 'unknown', signature: 'sigU' } }).request });
  assert.deepEqual([unknown.ok, unknown.notSent, unknown.code, unknown.signature], [false, false, 'ClaimOutcomeUnknown', 'sigU']);
  const refused = await claimPassLocal({ wallet: wallet(), asset: ASSET, generation: 2, request: relay({ [LOCAL_PRIZE.prepare]: prepared, [LOCAL_PRIZE.submit]: { ok: false, code: 'LocalPrizeRunnerChanged', signature: null } }).request });
  assert.deepEqual([refused.ok, refused.notSent, refused.code], [false, false, 'LocalPrizeRunnerChanged']);
});
