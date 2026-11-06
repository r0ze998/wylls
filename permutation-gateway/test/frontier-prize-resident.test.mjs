// NFT pass prize (experimental, permutation-prize `nft-experimental`): the
// SDK's addresses, decoders, leaf, builders, the paid-JoinResident message
// and its classifier (sdk frontier/prize.mjs).
//
// Key-free: every address is a literal 32-byte value (base58 of a filled
// array) or a program address the SDK derives by hashing; no key is
// generated, derived or signed, and the transactions carry all-zero
// signatures (the classifier does not check signatures; the relay's own
// signature check and its routes are exercised in test/frontier-prize.test.mjs,
// which uses keys and is left to the manual key-tests job).
//
// EXECUTION CLASS: address-deriving (NOT pure). `entryResidentAddress`,
// `ata`, `prizeAddresses` and the builders derive PDAs and with-seed
// addresses at run time. Under the rule that address derivation may not be
// executed without approval, this file is syntax-check only
// (`node --check`) until a run is approved. The pure web test is
// test/web-frontier-prize-pass.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { encode as b58 } from '../client/src/base58.mjs';
import { toHex, u32le, u64le, utf8 } from '../client/src/bytes.mjs';
import { sha256 } from '../client/src/sha256.mjs';
import { compileMessage, findProgramAddress, parseTransaction, pubkeyBytes, wireTransaction } from '../client/src/solana-tx.mjs';
import { SYSTEM_PROGRAM } from '../client/src/frontier/addresses.mjs';
import { budgetPrefix } from '../client/src/frontier/budgets.mjs';
import { joinResidentIx, residentBudget } from '../client/src/frontier/resident.mjs';
import { frontierIx } from '../client/src/frontier/shapes.mjs';
import {
  ata, claimIx, claimResidentIx, classifyPaidJoin, classifyPaidResidentJoin, decodeEntry, decodeEntryResident, ENTRY_RESIDENT_SIZE, ENTRY_SIZE, entryAddress,
  entryResidentAddress, leafHash, leafResidentHash, merkleTree, nodeHash, PAID_JOIN_RESIDENT_EXTRA_CU, paidJoinMessage, paidJoinResidentBudget,
  paidJoinResidentMessage, payResidentIx, PRIZE_ERRORS, PRIZE_TAG, prizeAddresses, recordNationIx, recordResidentNationIx, TOKEN_PROGRAM,
} from '../client/src/frontier/prize.mjs';

const key = n => b58(new Uint8Array(32).fill(n));
const PROGRAM = key(0x11), PRIZE_PROGRAM = key(0x12), MINT = key(0x13), SEASON = key(0x22), FRONTIER = key(0x42), FEE_PAYER = key(0x31), GATE = key(0x91);
const OWNER = key(0xa1), OTHER = key(0xb2), ASSET = key(0x5a), CITIZEN = key(0x41), LINK = key(0x62), POLICY = key(0x61), RESIDENT = key(0x63);
const BLOCKHASH = key(0x77);
const PROFILE = 3;
const PRIZE = prizeAddresses({ prizeProgram: PRIZE_PROGRAM, gameProgram: PROGRAM, seasonId: 5n, mint: MINT });
const tx = message => parseTransaction(wireTransaction(message));
const join = (over = {}) => ({ owner: OWNER, season: SEASON, frontier: FRONTIER, citizen: CITIZEN, policy: POLICY, link: LINK, asset: ASSET, resident: RESIDENT, joinGate: GATE, generation: 2, faction: 1, ...over });
const paid = (over = {}) => paidJoinResidentMessage({ programId: PROGRAM, prize: PRIZE, feePayer: FEE_PAYER, recentBlockhash: BLOCKHASH, profile: PROFILE, join: join(), ...over });

function entryResidentData({ asset = ASSET, claimed = false, nation = null, paidBy = OWNER, claimedBy = OTHER, amount = 25_000_000n } = {}) {
  const d = new Uint8Array(ENTRY_RESIDENT_SIZE);
  d.set(utf8('WYPRNFTE'), 0);
  d[9] = claimed ? 1 : 0;
  if (nation !== null) { d[10] = 1; d[11] = nation; }
  d.set(u32le(3), 12);
  d.set(pubkeyBytes(PRIZE.pool), 16); d.set(pubkeyBytes(asset), 48); d.set(u64le(amount), 80); d.set(u64le(77n), 88); d.set(u64le(claimed ? 9n : 0n), 96);
  d.set(pubkeyBytes(paidBy), 104);
  if (claimed) { d.set(pubkeyBytes(claimedBy), 136); d.set(u32le(4), 168); }
  return d;
}

test('the NFT entry is its own account kind: its own seed, size, magic and decoder', () => {
  const [want] = findProgramAddress([utf8('entry-nft'), pubkeyBytes(PRIZE.pool), pubkeyBytes(ASSET)], PRIZE_PROGRAM);
  assert.equal(entryResidentAddress(PRIZE_PROGRAM, PRIZE.pool, ASSET), want);
  assert.notEqual(entryResidentAddress(PRIZE_PROGRAM, PRIZE.pool, ASSET), entryAddress(PRIZE_PROGRAM, PRIZE.pool, ASSET), 'the asset read as a wallet is another address');
  const e = decodeEntryResident(entryResidentData());
  assert.deepEqual([e.asset, e.pool, e.amount, e.claimed, e.nationRecorded, e.nation, e.paidBy, e.payGeneration, e.claimedBy, e.claimGeneration],
    [ASSET, PRIZE.pool, 25_000_000n, false, false, null, OWNER, 3, null, null]);
  const c = decodeEntryResident(entryResidentData({ claimed: true, nation: 1 }));
  assert.deepEqual([c.claimed, c.nation, c.claimedBy, c.claimGeneration, c.claimAmount], [true, 1, OTHER, 4, 9n]);
  // Neither decoder reads the other's account.
  assert.equal(decodeEntry(entryResidentData()), null);
  const w = new Uint8Array(ENTRY_SIZE); w.set(utf8('WYPRENTR'), 0); w.set(pubkeyBytes(PRIZE.pool), 16); w.set(pubkeyBytes(OWNER), 48);
  assert.equal(decodeEntryResident(w), null);
  assert.deepEqual([decodeEntry(w).wallet, decodeEntry(w).nation, decodeEntry(w).nationRecorded], [OWNER, null, false]);
  w[10] = 1; w[11] = 4;
  assert.equal(decodeEntry(w).nation, 4);
  assert.equal(decodeEntryResident(entryResidentData().slice(0, 191)), null);
  const bad = entryResidentData(); bad[7] ^= 1;
  assert.equal(decodeEntryResident(bad), null);
});

test('a pass leaf has its own domain and proves under the same root as wallet leaves', () => {
  const pass = leafResidentHash(PRIZE.pool, ASSET, 2, 10n);
  assert.deepEqual(pass, sha256([2], pubkeyBytes(PRIZE.pool), pubkeyBytes(ASSET), [2], u64le(10n)));
  assert.notDeepEqual(pass, leafHash(PRIZE.pool, ASSET, 2, 10n), 'the same bytes under the wallet domain');
  assert.notDeepEqual(pass, leafResidentHash(PRIZE.pool, ASSET, 3, 10n));
  assert.notDeepEqual(pass, leafResidentHash(PRIZE.pool, ASSET, 2, 11n));
  assert.notDeepEqual(pass, leafResidentHash(PRIZE.pool, key(0x5b), 2, 10n));
  const leaves = [pass, leafHash(PRIZE.pool, OWNER, 2, 6n), leafResidentHash(PRIZE.pool, key(0x5b), 2, 1n)];
  const tree = merkleTree(leaves);
  for (const l of leaves) assert.deepEqual(tree.proof(l).reduce((h, s) => nodeHash(h, s), l), tree.root);
  assert.equal(tree.proof(leafHash(PRIZE.pool, ASSET, 2, 10n)), null, 'the wallet-domain leaf of the asset is not in the tree');
});

test('the pass builders name the accounts the program checks, in its order', () => {
  const pay = payResidentIx({ prize: PRIZE, owner: OWNER, payer: FEE_PAYER, asset: ASSET, policy: POLICY, resident: RESIDENT, generation: 2 });
  assert.equal(pay.programId, PRIZE_PROGRAM);
  assert.deepEqual([...pay.data], [PRIZE_TAG.PAY_RESIDENT, 2, 0, 0, 0]);
  assert.deepEqual(pay.keys.map(k => k.pubkey), [OWNER, FEE_PAYER, PRIZE.pool, entryResidentAddress(PRIZE_PROGRAM, PRIZE.pool, ASSET), ata(OWNER, MINT), PRIZE.vault, MINT, TOKEN_PROGRAM, SYSTEM_PROGRAM, POLICY, ASSET, RESIDENT]);
  assert.deepEqual(pay.keys.map(k => [k.isSigner, k.isWritable]), [[true, false], [true, true], [false, true], [false, true], [false, true], [false, true], [false, false], [false, false], [false, false], [false, false], [false, false], [false, false]]);
  const proof = [new Uint8Array(32).fill(1), new Uint8Array(32).fill(2)];
  const claim = claimResidentIx({ prize: PRIZE, owner: OTHER, asset: ASSET, citizen: CITIZEN, link: LINK, policy: POLICY, resident: RESIDENT, generation: 1, nation: 2, points: 10n, proof });
  assert.deepEqual([...claim.data.slice(0, 14)], [PRIZE_TAG.CLAIM_RESIDENT, 1, 0, 0, 0, 2, 10, 0, 0, 0, 0, 0, 0, 0, 2]);
  assert.equal(claim.data.length, 14 + 64);
  assert.deepEqual([...claim.data.slice(14, 46)], [...proof[0]]);
  assert.deepEqual(claim.keys.map(k => k.pubkey), [OTHER, PRIZE.pool, entryResidentAddress(PRIZE_PROGRAM, PRIZE.pool, ASSET), CITIZEN, LINK, PRIZE.vault, ata(OTHER, MINT), MINT, TOKEN_PROGRAM, POLICY, ASSET, RESIDENT]);
  assert.deepEqual(claim.keys.map(k => k.isSigner), [true, false, false, false, false, false, false, false, false, false, false, false]);
  assert.deepEqual(claim.keys.map(k => k.isWritable), [false, true, true, false, false, true, true, false, false, false, false, false]);
  // The claim goes to the signer's own token account, never to the payer's: a later owner names its own.
  assert.notEqual(claim.keys[6].pubkey, ata(OWNER, MINT));
  const rec = recordResidentNationIx({ prize: PRIZE, asset: ASSET, citizen: CITIZEN });
  assert.deepEqual([[...rec.data], rec.keys.map(k => k.pubkey), rec.keys.map(k => k.isSigner)], [[PRIZE_TAG.RECORD_RESIDENT_NATION], [PRIZE.pool, entryResidentAddress(PRIZE_PROGRAM, PRIZE.pool, ASSET), CITIZEN], [false, false, false]]);
  const legacy = recordNationIx({ prize: PRIZE, wallet: OWNER, citizen: CITIZEN });
  assert.deepEqual([[...legacy.data], legacy.keys[1].pubkey], [[PRIZE_TAG.RECORD_NATION], entryAddress(PRIZE_PROGRAM, PRIZE.pool, OWNER)]);
  // The legacy Claim is untouched: eight accounts, tag 5.
  const c5 = claimIx({ prize: PRIZE, wallet: OWNER, citizen: CITIZEN });
  assert.deepEqual([c5.data[0], c5.keys.length], [PRIZE_TAG.CLAIM, 8]);
  assert.deepEqual(Object.entries(PRIZE_ERRORS).filter(([c]) => Number(c) >= 0x113).map(([, n]) => n),
    ['ResidentNotSigned', 'ResidentAsset', 'ResidentAccount', 'ResidentUnguarded', 'ResidentStaleGeneration', 'ResidentNotCurrentAuthority', 'ResidentPolicy', 'ResidentRefundUndecided']);
});

test('the paid JoinResident is exactly [limit, price 0, loaded, PayResident, JoinResident] of one pass; anything else is refused', () => {
  const ok = classifyPaidResidentJoin(tx(paid()), { programId: PROGRAM, prize: PRIZE, profile: PROFILE });
  assert.equal(ok.ok, true, ok.problem);
  assert.deepEqual([ok.owner, ok.asset, ok.ownerToken, ok.join.wrapper, ok.join.authority, ok.join.accounts.join_gate, ok.join.resident.generation, ok.join.signers.length],
    [OWNER, ASSET, ata(OWNER, MINT), 'JoinResident', OWNER, GATE, 2, 3]);
  const b = paidJoinResidentBudget(PROFILE);
  assert.equal(b.cuLimit, residentBudget('JoinResident', PROFILE).cuLimit + PAID_JOIN_RESIDENT_EXTRA_CU);
  const refused = (message, re) => {
    const r = classifyPaidResidentJoin(tx(message), { programId: PROGRAM, prize: PRIZE, profile: PROFILE });
    assert.equal(r.ok, false);
    assert.match(r.problem, re);
  };
  // Another pool, vault or mint.
  refused(paid({ prize: prizeAddresses({ prizeProgram: PRIZE_PROGRAM, gameProgram: PROGRAM, seasonId: 6n, mint: MINT }) }), /not this season's pool/);
  refused(paid({ prize: { ...PRIZE, vault: key(0x99) } }), /not this season's pool, vault/);
  refused(paid({ prize: { ...PRIZE, mint: key(0x98) } }), /not this season's pool, vault, mint/);
  // Another budget, the fee payer as the owner, a JoinResident without the gate while PayResident stays.
  refused(paid({ profile: 2 }), /the prefix must be limit/);
  refused(paid({ join: join({ owner: FEE_PAYER }) }), /fee payer/);
  const good = tx(paid()).instructions;
  const rebuilt = (payIx, joinIx) => compileMessage({ feePayer: FEE_PAYER, recentBlockhash: BLOCKHASH, instructions: [...good.slice(0, 3), payIx, joinIx] });
  // PayResident of another owner, another pass or another generation than the JoinResident's.
  const payOf = over => payResidentIx({ prize: PRIZE, owner: OWNER, payer: FEE_PAYER, asset: ASSET, policy: POLICY, resident: RESIDENT, generation: 2, ...over });
  refused(rebuilt(payOf({ owner: OTHER }), good[4]), /not this season's pool, vault, mint, the pass's entry, or the JoinResident's owner/);
  refused(rebuilt(payOf({ asset: key(0x5b) }), good[4]), /the pass's entry/);
  refused(rebuilt(payOf({ resident: key(0x64) }), good[4]), /pass accounts/);
  refused(rebuilt(payOf({ generation: 3 }), good[4]), /JoinResident's generation/);
  // A Pay (wallet) in front of a JoinResident, or a PayResident in front of a wallet Join.
  const walletPay = { ...payOf(), data: Uint8Array.of(PRIZE_TAG.PAY), keys: payOf().keys.slice(0, 9) };
  refused(rebuilt(walletPay, good[4]), /must be the prize program's PayResident/);
  const walletJoin = frontierIx(PROGRAM, 'Join', { wallet: OWNER, payer: FEE_PAYER, season: SEASON, frontier: FRONTIER, citizen: CITIZEN, joinshard: key(0x43), join_gate: GATE },
    { faction: 1, session: new Uint8Array(32).fill(0xc3), session_expiry: 1n }, PROFILE);
  refused(rebuilt(payOf(), walletJoin), /must be the game's JoinResident/);
  // The legacy classifier never takes the pass message, nor this one the legacy message.
  assert.equal(classifyPaidJoin(tx(paid()), { programId: PROGRAM, prize: PRIZE, profile: PROFILE }).ok, false);
  const legacy = paidJoinMessage({ programId: PROGRAM, prize: PRIZE, wallet: OWNER, feePayer: FEE_PAYER, recentBlockhash: BLOCKHASH, profile: PROFILE,
    joinAccounts: { wallet: OWNER, season: SEASON, frontier: FRONTIER, citizen: CITIZEN, joinshard: key(0x43), join_gate: GATE },
    joinFields: { faction: 1, session: new Uint8Array(32).fill(0xc3), session_expiry: 1n } });
  assert.equal(classifyPaidResidentJoin(tx(legacy), { programId: PROGRAM, prize: PRIZE, profile: PROFILE }).ok, false);
  // A JoinResident alone (no payment) is not a paid shape.
  const rb = residentBudget('JoinResident', PROFILE);
  const alone = compileMessage({ feePayer: FEE_PAYER, recentBlockhash: BLOCKHASH, instructions: [
    ...budgetPrefix('Join', { profile: PROFILE, cuLimit: rb.cuLimit, loadedLimit: rb.loadedLimit }), joinResidentIx({ programId: PROGRAM, payer: FEE_PAYER, ...join() })] });
  refused(alone, /exactly five instructions/);
  // The message's bytes are the SDK's own (a fixed message, no signature).
  assert.equal(toHex(wireTransaction(paid())).length > 0, true);
});
