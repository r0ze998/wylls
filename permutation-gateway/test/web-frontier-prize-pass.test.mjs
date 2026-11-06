// NFT pass prize on the page (experimental): the pass claim model
// (fprize.passClaimModel, passShareOf, pointsOf), the claim operation's
// identity guard (claimOpLive) and the 賞金 panel's pass section
// (screens/prize.mjs renderPass), with the wallet player's panel unchanged.
//
// PURE: every input is a literal object or string; no key is generated,
// derived or signed, and no address (PDA, with-seed) is derived — the model
// and the renderer only read the relay's view, the ledger and the page's
// state. The controller's actions (claimPass, paidJoinPass) and fprize's
// relay calls are not exercised here: they sign and derive at run time and
// are left to a run under approval.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { claimOpLive, claimOpOf, claimOutcome, nextPassEpoch, passClaimModel, passShareOf, pointsOf, prizeModel } from '../../permutation-server/web/frontier/fprize.mjs';
import { render as panel, renderPass } from '../../permutation-server/web/frontier/screens/prize.mjs';
import { failureText } from '../../permutation-server/web/frontier/fi18n.mjs';
import { setLang } from '../../permutation-server/web/lang.mjs';

afterEach(() => setLang('ja'));
const plain = s => String(s).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
// Literal, never-derived identifiers (base58-looking strings the page only prints).
const WALLET = 'WaLLet1111111111111111111111111111111111111';
const OWNER_B = 'OwnerB22222222222222222222222222222222222222';
const ASSET = 'Asset5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5';
const OTHER = 'Asset5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5';
const CITIZEN = 'Citizen41414141414141414141414141414141414141';
const PROOF = { policy: 'Policy61', link: 'Link62', asset: ASSET, resident: 'Resident63' };
const U64_MAX = '18446744073709551615';
const resident = (generation = 1) => ({ asset: ASSET, citizen: CITIZEN, generation, joined: true, proof: PROOF });

const pool = (extra = {}) => ({ testAssetsOnly: true, program: 'PrizeProgram', pool: 'Pool', vault: 'Vault', mint: 'Mint', decimals: 6, fee: '25000000', opsBps: 2000, prizeBps: 8000,
  entries: 2, collected: '50000000', prize: '40000000', ops: '10000000', state: 'open', expectedKeeps: 54, counted: 0, area: null, winners: null, shares: null, ...extra });
const entry = (extra = {}) => ({ paid: '25000000', paidBy: WALLET, payGeneration: 0, claimed: false, claimedBy: null, claimAmount: '0', nation: null, ...extra });
const pass = (extra = {}) => ({ asset: ASSET, citizen: CITIZEN, faction: 1, entry: entry(), ...extra });
const posted = (extra = {}) => pool({ state: 'shares', counted: 54, area: [8, 10, 9, 9, 9, 9], winners: [1],
  shares: { mode: 'shares', shareNations: 1, totalPoints: ['0', '16', '0', '0', '0', '0'], claims: 0, claimed: '0', root: 'ab', ledgerHash: 'cd' }, ...extra });
const ledger = (members = [{ wallet: `pass:${ASSET}`, asset: ASSET, nation: 1, points: 10, proof: ['00'.repeat(32)] }, { wallet: WALLET, asset: null, nation: 1, points: 6, proof: ['11'.repeat(32)] }]) => ({
  provisional: true, provisionalRules: [], kinds: { capture: { derivable: true } },
  lines: [{ kind: 'capture', wallet: `pass:${ASSET}`, nation: 1, province: { p: 4, q: 0 }, quantity: 1, unit: 'province', bell: 240, points: 10, eligible: true, signatures: ['5capSig1111111111'] }],
  shares: { mode: 'shares', members }, estimate: { split: [{ wallet: `pass:${ASSET}`, asset: ASSET, nation: 1, points: 10, amount: '25000000' }] } });
const fs = (extra = {}) => ({ wallet: { address: WALLET }, inFlight: 0, prize: pool(), prizeLedger: null, resident: null, prizePass: null, ...extra });
const share = (over = {}) => [{ wallet: `pass:${ASSET}`, asset: ASSET, nation: 1, points: 10, proof: ['00'.repeat(32)], ...over }];

test('points are exact u64 bigints: safe numbers and decimal strings pass, floats, negatives, unsafe numbers and more than u64 do not', () => {
  assert.equal(pointsOf(0), 0n);
  assert.equal(pointsOf(10), 10n);
  assert.equal(pointsOf(Number.MAX_SAFE_INTEGER), 9007199254740991n);
  assert.equal(pointsOf(2 ** 53), null, 'a number above 2^53 − 1 is not exact in JSON');
  assert.equal(pointsOf('9007199254740993'), 9007199254740993n, 'a decimal string keeps every digit');
  assert.equal(pointsOf(U64_MAX), 18446744073709551615n);
  assert.equal(pointsOf('18446744073709551616'), null, 'above u64');
  assert.equal(pointsOf(123n), 123n);
  assert.equal(pointsOf(-1n), null);
  for (const bad of [-1, 1.5, NaN, Infinity, '', '007', '1.0', '-3', ' 1', '1e3', 'abc', null, undefined, true, {}, []]) assert.equal(pointsOf(bad), null, String(bad));
});

test('the pass share is found by asset or by its pass: id, and only with a proof, a nation 0–5 and exact points', () => {
  const s = passShareOf(ledger(), ASSET);
  assert.deepEqual([s.nation, s.points, s.proof.length], [1, 10n, 1]);
  assert.equal(passShareOf(ledger(), OTHER), null);
  assert.deepEqual(passShareOf(ledger([{ wallet: `pass:${OTHER}`, nation: 2, points: '3', proof: [] }]), OTHER), { nation: 2, points: 3n, proof: [] });
  assert.equal(passShareOf(ledger(share({ proof: undefined })), ASSET), null, 'no proof, no share');
  assert.equal(passShareOf(ledger(share({ nation: 6 })), ASSET), null, 'a nation outside 0–5');
  assert.equal(passShareOf(ledger(share({ points: 1.5 })), ASSET), null, 'points that are no u64');
  assert.equal(passShareOf(ledger(share({ points: 2 ** 60 })), ASSET), null, 'an inexact number is refused rather than rounded');
  assert.equal(passShareOf(ledger(share({ points: U64_MAX })), ASSET).points, 18446744073709551615n);
  assert.equal(passShareOf(null, ASSET), null);
});

test('the pass claim model offers a claim in exactly one state: shares posted, a share in the ledger, the pass still held, unclaimed', () => {
  assert.equal(passClaimModel({ prize: pool(), resident: null }), null, 'no pass played');
  assert.equal(passClaimModel({ prize: null, resident: resident() }), null, 'no pool');
  assert.equal(passClaimModel({ prize: pool(), resident: resident() }).state, 'unpaid');
  assert.equal(passClaimModel({ prize: pool({ pass: pass({ asset: OTHER }) }), resident: resident() }).state, 'unpaid', 'another pass\'s entry is not this one\'s');
  const open = passClaimModel({ prize: pool({ pass: pass() }), resident: resident() });
  assert.deepEqual([open.state, open.entry.paid, open.entry.paidBy, open.entry.claimed, open.generation, open.offer], ['notPosted', '25', WALLET, false, 1, null]);
  assert.equal(passClaimModel({ prize: pool({ state: 'final', winners: [1], pass: pass() }), resident: resident() }).state, 'notPosted');
  // Refund mode: nothing is offered, the state says why.
  const refund = passClaimModel({ prize: posted({ shares: { mode: 'refund', shareNations: 0, totalPoints: ['0', '0', '0', '0', '0', '0'] }, pass: pass() }), resident: resident(), prizeLedger: ledger() });
  assert.deepEqual([refund.state, refund.offer, refund.share], ['refund', null, null]);
  // Shares posted: no ledger line, a losing nation's line, or zero points give no claim.
  assert.equal(passClaimModel({ prize: posted({ pass: pass() }), resident: resident(), prizeLedger: null }).state, 'noShare');
  assert.equal(passClaimModel({ prize: posted({ pass: pass() }), resident: resident(), prizeLedger: ledger(share({ nation: 2 })) }).state, 'noShare');
  assert.equal(passClaimModel({ prize: posted({ pass: pass() }), resident: resident(), prizeLedger: ledger(share({ points: 0 })) }).state, 'noShare');
  // The pass left the wallet (no generation): no claim.
  assert.equal(passClaimModel({ prize: posted({ pass: pass() }), resident: resident(null), prizeLedger: ledger() }).state, 'notHeld');
  // Claimable: the share (exact bigint), the estimate from the posted totals (40 / 1 × 10 / 16 = 25), the points as a decimal string.
  const ok = passClaimModel({ prize: posted({ pass: pass() }), resident: resident(2), prizeLedger: ledger() });
  assert.deepEqual([ok.state, ok.generation, ok.share.nation, ok.share.points, ok.offer], ['claimable', 2, 1, 10n, { nation: 1, points: '10', amount: '25' }]);
  // Exact at the top of u64: points and totals of 2^64 − 1 (never through Number).
  const top = passClaimModel({ prize: posted({ shares: { mode: 'shares', shareNations: 1, totalPoints: ['0', U64_MAX, '0', '0', '0', '0'] }, pass: pass() }),
    resident: resident(2), prizeLedger: ledger(share({ points: U64_MAX })) });
  assert.deepEqual([top.share.points, top.offer.points, top.offer.amount], [18446744073709551615n, U64_MAX, '40']);
  // Points above the posted total (the program would refuse): no estimate, still the program's call.
  assert.equal(passClaimModel({ prize: posted({ pass: pass() }), resident: resident(2), prizeLedger: ledger(share({ points: 17 })) }).offer.amount, null);
  // Claimed on chain: claimed, whoever claimed it, and never offered again.
  const done = passClaimModel({ prize: posted({ pass: pass({ entry: entry({ claimed: true, claimedBy: OWNER_B, claimAmount: '25000000' }) }) }), resident: resident(2), prizeLedger: ledger() });
  assert.deepEqual([done.state, done.entry.claimedBy, done.entry.claimAmount, done.offer], ['claimed', OWNER_B, '25', null]);
});

test('a pending or unknown claim of this pass holds the offer back; a stale one (another pass, another wallet, a failed attempt of an earlier generation) is dropped', () => {
  const base = { prize: posted({ pass: pass() }), resident: resident(2), prizeLedger: ledger(), wallet: { address: WALLET } };
  const pending = passClaimModel({ ...base, prizePass: { wallet: WALLET, asset: ASSET, generation: 2, state: 'pending', signature: 'sig1' } });
  assert.deepEqual([pending.state, pending.pending.state, pending.pending.signature, pending.offer], ['pending', 'pending', 'sig1', null]);
  // An unknown outcome is kept as pending (never failed, never unsent), whatever the generation.
  const unknown = passClaimModel({ ...base, prizePass: { wallet: WALLET, asset: ASSET, generation: 1, state: 'unknown', signature: 'sig0', code: 'ClaimOutcomeUnknown' } });
  assert.deepEqual([unknown.state, unknown.pending.state, unknown.pending.code, unknown.offer], ['pending', 'unknown', 'ClaimOutcomeUnknown', null]);
  // A pending transaction may still land after a transfer: it is shown, not offered twice.
  assert.equal(passClaimModel({ ...base, prizePass: { asset: ASSET, generation: 1, state: 'pending', signature: 'sig0' } }).state, 'pending');
  // A failed attempt of this generation is reported beside a fresh offer; one of an earlier generation or another pass is forgotten.
  const failed = passClaimModel({ ...base, prizePass: { asset: ASSET, generation: 2, state: 'failed', code: 'ResidentStaleGeneration' } });
  assert.deepEqual([failed.state, failed.pending.state, failed.pending.code], ['claimable', 'failed', 'ResidentStaleGeneration']);
  assert.equal(passClaimModel({ ...base, prizePass: { asset: ASSET, generation: 1, state: 'failed', code: 'X' } }).pending, null);
  assert.equal(passClaimModel({ ...base, prizePass: { asset: OTHER, generation: 2, state: 'pending' } }).pending, null);
  // A record signed by another wallet never shows on this wallet's screen.
  assert.equal(passClaimModel({ ...base, prizePass: { wallet: OWNER_B, asset: ASSET, generation: 2, state: 'pending', signature: 'sigB' } }).pending, null);
  assert.equal(passClaimModel({ ...base, prizePass: { wallet: OWNER_B, asset: ASSET, generation: 2, state: 'pending', signature: 'sigB' } }).state, 'claimable');
});

test('the claim operation\'s identity: live only in its own epoch, with the same wallet and pass, and the generation it signed', () => {
  const page = fs({ resident: resident(2), passEpoch: 5 });
  const op = claimOpOf(WALLET, ASSET, 5, 2);
  assert.deepEqual(op, { wallet: WALLET, asset: ASSET, epoch: 5, generation: 2 });
  assert.equal(claimOpLive(op, page), true);
  assert.equal(claimOpLive(claimOpOf(WALLET, ASSET, 5), page), true, 'before the generation is known');
  // The generation moved on the page (a transfer seen by another action): the operation signed the old one.
  assert.equal(claimOpLive(op, { ...page, resident: resident(3) }), false, 'generation changed');
  assert.equal(claimOpLive(op, { ...page, resident: resident(null) }), false, 'generation unknown now');
  // Switch away: logout, another pass, another wallet, no wallet.
  assert.equal(claimOpLive(op, { ...page, resident: null }), false, 'back to the wallet\'s resident');
  assert.equal(claimOpLive(op, { ...page, resident: { ...resident(2), asset: OTHER } }), false, 'another pass');
  assert.equal(claimOpLive(op, { ...page, wallet: { address: OWNER_B } }), false, 'another wallet');
  assert.equal(claimOpLive(op, { ...page, wallet: null }), false, 'no wallet');
  assert.equal(claimOpLive(null, page), false);
  // Switch away and back (A → B → A; logout and login again): the same wallet and pass, but a later epoch — stale.
  const away = { ...page, wallet: { address: OWNER_B }, resident: null };
  nextPassEpoch(away);
  const back = { ...away, wallet: { address: WALLET }, resident: resident(2) };
  nextPassEpoch(back);
  assert.deepEqual([back.wallet.address, back.resident.asset, back.resident.generation], [WALLET, ASSET, 2], 'identical identity');
  assert.equal(claimOpLive(op, back), false, 'a later epoch: the old operation never comes back to life');
  assert.equal(claimOpLive(claimOpOf(WALLET, ASSET, back.passEpoch, 2), back), true, 'an operation begun in the new epoch is live');
  // The epoch counts up from nothing, once per change.
  const fresh = fs({ resident: resident(1) });
  assert.equal(claimOpLive(claimOpOf(WALLET, ASSET, 0), fresh), true, 'no epoch yet is epoch 0');
  assert.equal(nextPassEpoch(fresh), 1);
  assert.equal(nextPassEpoch(fresh), 2);
  assert.equal(claimOpLive(claimOpOf(WALLET, ASSET, 0), fresh), false);
});

test('a claim\'s outcome: failed only before the POST or when the chain proved it; everything uncertain after the POST is unknown', () => {
  // Before the POST: definite, not sent.
  for (const code of ['NoRelay', 'BuildFailed', 'SignFailed', 'WalletRejected', 'WalletAlteredMessage', 'PinMismatch']) {
    assert.deepEqual(claimOutcome({ ok: false, code, notSent: true }), { state: 'failed', notSent: true, code });
  }
  // After the POST: a refusal, a lost reply, a timeout, a changed relay answer, the relay's own pending codes — all unknown, never failed.
  for (const code of ['RelayRejected', 'network', 'TimeoutError', 'RelayMessageChanged', 'ClaimOutcomeUnknown', 'ClaimInFlight', 'Unavailable', 'HTTP502']) {
    assert.deepEqual(claimOutcome({ ok: false, code, notSent: false }), { state: 'unknown', notSent: false, code });
  }
  assert.equal(claimOutcome({ ok: false, code: 'X' }).state, 'unknown', 'no flag: never assumed unsent');
  assert.equal(claimOutcome(null).state, 'unknown');
  // An earlier claim reported by the relay: landed only if the Entry reads claimed.
  assert.deepEqual(claimOutcome({ ok: true, already: true, landed: true }), { state: 'landed', notSent: false, code: null });
  assert.deepEqual(claimOutcome({ ok: true, already: true, landed: false }), { state: 'unknown', notSent: false, code: 'ClaimOutcomeUnknown' });
  // Sent: pending until tracked; landed; a chain failure is the one proven failure; expired and unconfirmed are unknown.
  const sent = { ok: true, sent: true, already: false, signature: 'sig' };
  assert.deepEqual(claimOutcome(sent), { state: 'pending', notSent: false, code: null });
  assert.deepEqual(claimOutcome(sent, { ok: true, state: 'landed' }), { state: 'landed', notSent: false, code: null });
  assert.deepEqual(claimOutcome(sent, { ok: false, state: 'failed', code: 'ResidentStaleGeneration' }), { state: 'failed', notSent: false, code: 'ResidentStaleGeneration' });
  assert.deepEqual(claimOutcome(sent, { ok: false, state: 'expired', code: 'Expired' }), { state: 'unknown', notSent: false, code: 'Expired' });
  assert.deepEqual(claimOutcome(sent, { ok: false, state: 'unknown', code: 'Unconfirmed' }), { state: 'unknown', notSent: false, code: 'Unconfirmed' });
  assert.equal(claimOutcome(sent, { ok: false, state: 'unknown' }).code, 'Unconfirmed');
  // An unknown record holds the page's offer back; a failed one lets it retry.
  const base = { prize: posted({ pass: pass() }), resident: resident(2), prizeLedger: ledger(), wallet: { address: WALLET } };
  const rec = o => ({ wallet: WALLET, asset: ASSET, generation: 2, signature: 'sig', ...o });
  assert.equal(passClaimModel({ ...base, prizePass: rec(claimOutcome(sent, { ok: false, state: 'expired', code: 'Expired' })) }).state, 'pending');
  assert.equal(passClaimModel({ ...base, prizePass: rec(claimOutcome({ ok: false, code: 'RelayRejected', notSent: false })) }).state, 'pending');
  assert.equal(passClaimModel({ ...base, prizePass: rec(claimOutcome({ ok: false, code: 'SignFailed', notSent: true })) }).state, 'claimable');
  assert.equal(passClaimModel({ ...base, prizePass: rec(claimOutcome(sent, { ok: false, state: 'failed', code: 'BadProof' })) }).state, 'claimable');
});

test('the panel shows the pass section for a pass player only; the claim button in the claimable state only; a refund says it is unavailable', () => {
  // A wallet player: the panel as before, without any pass section or button.
  const walletOnly = String(panel(fs({ prize: posted(), prizeLedger: ledger() })));
  assert.doesNotMatch(walletOnly, /prize-claim-pass|pz-pass|住民NFT/);
  assert.equal(renderPass(fs()), '', 'no pass played: nothing');
  // The pass player, shares posted and a share: the button, the estimate and the generation to be signed.
  const claimable = String(panel(fs({ prize: posted({ pass: pass() }), prizeLedger: ledger(), resident: resident(2) })));
  assert.match(claimable, /data-act="prize-claim-pass"/);
  assert.match(plain(claimable), /受け取れる試算：25 テストUSDC/);
  assert.match(plain(claimable), /10 点/);
  assert.match(plain(claimable), /いまの世代（2）/);
  assert.match(plain(claimable), /受け取れるのはいまの持ち主だけです/);
  // Exact points are printed digit for digit.
  const big = plain(String(renderPass(fs({ prize: posted({ shares: { mode: 'shares', shareNations: 1, totalPoints: ['0', U64_MAX, '0', '0', '0', '0'] }, pass: pass() }),
    prizeLedger: ledger(share({ points: U64_MAX })), resident: resident(2) }))));
  assert.match(big, new RegExp(`${U64_MAX} 点`));
  // The ledger marks the pass's own line as the viewer's.
  assert.match(claimable, /pz-line kh-n1 mine/);
  // In flight: the button is disabled.
  assert.match(String(panel(fs({ prize: posted({ pass: pass() }), prizeLedger: ledger(), resident: resident(2), inFlight: 1 }))), /data-act="prize-claim-pass" disabled/);
  // Refund mode: no button, the explanation.
  const refund = String(panel(fs({ prize: posted({ shares: { mode: 'refund', shareNations: 0, totalPoints: ['0', '0', '0', '0', '0', '0'] }, pass: pass() }), prizeLedger: ledger(), resident: resident(2) })));
  assert.doesNotMatch(refund, /prize-claim-pass/);
  assert.match(plain(refund), /返金先（支払ったウォレットか、いまの持ち主か）は未決定/);
  // Not held, claimed, pending, unknown, unpaid: no button either.
  for (const f of [
    fs({ prize: posted({ pass: pass() }), prizeLedger: ledger(), resident: resident(null) }),
    fs({ prize: posted({ pass: pass({ entry: entry({ claimed: true, claimedBy: OWNER_B, claimAmount: '25000000' }) }) }), prizeLedger: ledger(), resident: resident(2) }),
    fs({ prize: posted({ pass: pass() }), prizeLedger: ledger(), resident: resident(2), prizePass: { asset: ASSET, generation: 2, state: 'pending', signature: 'sig1' } }),
    fs({ prize: posted({ pass: pass() }), prizeLedger: ledger(), resident: resident(2), prizePass: { asset: ASSET, generation: 2, state: 'unknown', signature: 'sig1', code: 'ClaimOutcomeUnknown' } }),
    fs({ prize: pool(), resident: resident(2) }),
  ]) assert.doesNotMatch(String(panel(f)), /prize-claim-pass/);
  assert.match(plain(String(panel(fs({ prize: posted({ pass: pass({ entry: entry({ claimed: true, claimedBy: OWNER_B, claimAmount: '25000000' }) }) }), prizeLedger: ledger(), resident: resident(2) })))), /受け取り済みです：25 テストUSDC/);
  // An unknown outcome is said as unconfirmed, never as failed or unsent, with its signature.
  const unknown = plain(String(renderPass(fs({ prize: posted({ pass: pass() }), prizeLedger: ledger(), resident: resident(2), prizePass: { asset: ASSET, generation: 2, state: 'unknown', signature: 'sigU', code: 'ClaimOutcomeUnknown' } }))));
  assert.match(unknown, /結果がまだ確認できません/);
  assert.match(unknown, /sigU/);
  assert.doesNotMatch(unknown, /届きませんでした|失敗/);
  // A failed earlier attempt is said in words, beside the fresh offer.
  const retry = String(panel(fs({ prize: posted({ pass: pass() }), prizeLedger: ledger(), resident: resident(2), prizePass: { asset: ASSET, generation: 2, state: 'failed', code: 'ResidentStaleGeneration' } })));
  assert.match(retry, /前回の受け取りは届きませんでした/);
  assert.match(retry, /譲渡されました/);
  assert.match(retry, /data-act="prize-claim-pass"/);
  // The English page has no Japanese in the pass section.
  setLang('en');
  assert.doesNotMatch(plain(renderPass(fs({ prize: posted({ pass: pass() }), prizeLedger: ledger(), resident: resident(2) }))), /[぀-ヿ㐀-鿿]/);
  assert.doesNotMatch(unknown.length ? plain(renderPass(fs({ prize: posted({ pass: pass() }), prizeLedger: ledger(), resident: resident(2), prizePass: { asset: ASSET, generation: 2, state: 'unknown', signature: 'sigU' } }))) : '', /[぀-ヿ㐀-鿿]/);
});

test('every pass refusal code has words of its own', () => {
  for (const code of ['ResidentNotSigned', 'ResidentAsset', 'ResidentAccount', 'ResidentUnguarded', 'ResidentStaleGeneration', 'ResidentNotCurrentAuthority', 'ResidentPolicy',
    'ResidentRefundUndecided', 'NoResidentPolicy', 'X402NoPass', 'PassNotPaid', 'PassNoShare', 'PassRefundUnavailable', 'ClaimNotOpen', 'ClaimOutcomeUnknown', 'ClaimInFlight']) {
    const t = String(failureText({ code }));
    assert.ok(t && !t.includes(code), code);
  }
  // The wallet model is untouched by the pass fields.
  const m = prizeModel(pool({ pass: pass() }));
  assert.equal(m.wallet, null);
  assert.equal('pass' in m, false);
});
