// ⑳ NFT residents: the relay's classification and the SDK's builders of
// JoinResident (0xE1) and ResidentAct (0xE2).
//
// Key-free: every address is a literal 32-byte value (base58 of a filled
// array); no key is generated, derived or signed, no PDA is computed, and
// the transactions carry all-zero signatures (the classifier does not check
// signatures; the relay's own signature check is not exercised here).
import test from 'node:test';
import assert from 'node:assert/strict';
import { encode as b58 } from '../client/src/base58.mjs';
import { parseTransaction, wireTransaction } from '../client/src/solana-tx.mjs';
import { classify, frontierIx } from '../client/src/frontier/shapes.mjs';
import { budgetPrefix } from '../client/src/frontier/budgets.mjs';
import { compileMessage } from '../client/src/solana-tx.mjs';
import { withSeed, seed, SEED_TAGS, citizenTag15 } from '../client/src/frontier/addresses.mjs';
import {
  joinResidentMessage, residentActIx, residentActMessage, residentBudget, residentCitizen, residentTag15,
  decodeResident, decodeAssetOwner, RESIDENT_ACT_TAG,
} from '../client/src/frontier/resident.mjs';
import { allowanceFor, CITIZEN_RENT, LINK_RENT } from '../src/frontier/shapes.mjs';

const key = n => b58(new Uint8Array(32).fill(n));
const hex = h => Uint8Array.from(h.match(/../g).map(x => parseInt(x, 16)));
const PROGRAM = key(0x11), SEASON = key(0x22), FEE_PAYER = key(0x31), OWNER = key(0xa1), CITIZEN = key(0x41);
const PROOF = { policy: key(0x61), link: key(0x62), asset: key(0x5a), resident: key(0x63) };
const BLOCKHASH = key(0x77);
const PROFILE = 3;
const tx = message => parseTransaction(wireTransaction(message));
const wire = message => wireTransaction(message);

const vigil = (actor = OWNER) => frontierIx(PROGRAM, 'SetVigil', { actor, payer: FEE_PAYER, season: SEASON, citizen: CITIZEN }, { start_min: 600 }, PROFILE);

test('the resident id and the NFT Citizen address match the program', () => {
  // The resident id the resident program stored for this asset (frontier-abi resident_citizen tests).
  const asset = b58(hex('1e0472eeda371c36b8209aa20a7ec299e99fb803f918adafebb81ab58cc08ddc'));
  assert.deepEqual([...residentTag15(asset)], [...hex('9ab72fc6db3606d32bdcdd217ac454')]);
  const a = { season: SEASON, programId: PROGRAM };
  const c = residentCitizen(a, asset);
  assert.equal(c, withSeed(SEASON, seed(SEED_TAGS.Citizen, residentTag15(asset)), PROGRAM));
  // Never the zero wallet's Citizen, never the asset read as a wallet.
  assert.notEqual(c, withSeed(SEASON, seed(SEED_TAGS.Citizen, citizenTag15(key(0))), PROGRAM));
  assert.notEqual(c, withSeed(SEASON, seed(SEED_TAGS.Citizen, citizenTag15(asset)), PROGRAM));
});

test('a ResidentAct around a player shape is that shape, with its proof and generation', () => {
  const m = residentActMessage({ inner: vigil(), proof: PROOF, generation: 2, feePayer: FEE_PAYER, recentBlockhash: BLOCKHASH, profile: PROFILE });
  const s = classify(tx(m), { programId: PROGRAM, wireBytes: wire(m).length, profile: PROFILE });
  assert.equal(s.ok, true, s.problem);
  assert.equal(s.kind, 'player');
  assert.equal(s.name, 'SetVigil');
  assert.equal(s.wrapper, 'ResidentAct');
  assert.equal(s.authority, OWNER);
  assert.equal(s.accounts.citizen, CITIZEN);
  assert.deepEqual(s.resident, { generation: 2, ...PROOF });
  assert.equal(s.keys.length, 8);
  assert.equal(Number(s.cu.limit), residentBudget('SetVigil', PROFILE).cuLimit);
});

test('ResidentAct refusals: the plain budget, a writable or signing proof, a Join or SetSession inside, a missing proof', () => {
  const ok = { programId: PROGRAM, profile: PROFILE };
  // The inner instruction's own budget (no resident overhead).
  const plain = compileMessage({ feePayer: FEE_PAYER, recentBlockhash: BLOCKHASH, instructions: [
    ...budgetPrefix('SetVigil', { profile: PROFILE }), residentActIx(vigil(), { generation: 0, ...PROOF })] });
  assert.match(classify(tx(plain), ok).problem, /SetComputeUnitLimit/);
  // A writable proof account.
  const ix = residentActIx(vigil(), { generation: 0, ...PROOF });
  ix.keys[ix.keys.length - 1].isWritable = true;
  const b = residentBudget('SetVigil', PROFILE);
  const w = compileMessage({ feePayer: FEE_PAYER, recentBlockhash: BLOCKHASH, instructions: [
    ...budgetPrefix('SetVigil', { profile: PROFILE, cuLimit: b.cuLimit, loadedLimit: b.loadedLimit }), ix] });
  assert.match(classify(tx(w), ok).problem, /proof accounts are read-only/);
  // SetSession is never run for an NFT Citizen; the builder refuses it.
  const ss = frontierIx(PROGRAM, 'SetSession', { actor: OWNER, payer: FEE_PAYER, season: SEASON, citizen: CITIZEN }, { session: new Uint8Array(32).fill(0xc3), expiry: 1n }, PROFILE);
  assert.throws(() => residentActIx(ss, { generation: 0, ...PROOF }), /not run for an NFT Citizen/);
  // A hand-made ResidentAct around SetSession is refused by the classifier.
  const forged = { ...ix, keys: [...ss.keys, ...ix.keys.slice(-4).map(k => ({ ...k, isWritable: false }))],
    data: Uint8Array.from([RESIDENT_ACT_TAG, 0, 0, 0, 0, ...ss.data]) };
  const fm = compileMessage({ feePayer: FEE_PAYER, recentBlockhash: BLOCKHASH, instructions: [
    ...budgetPrefix('SetVigil', { profile: PROFILE, cuLimit: b.cuLimit, loadedLimit: b.loadedLimit }), forged] });
  assert.match(classify(tx(fm), ok).problem, /not run for an NFT Citizen/);
  // Without the proof accounts.
  const bare = { ...ix, keys: ix.keys.slice(0, 4) };
  const bm = compileMessage({ feePayer: FEE_PAYER, recentBlockhash: BLOCKHASH, instructions: [
    ...budgetPrefix('SetVigil', { profile: PROFILE, cuLimit: b.cuLimit, loadedLimit: b.loadedLimit }), bare] });
  assert.equal(classify(tx(bm), ok).ok, false);
});

test('JoinResident: classified as a join of the owner, with and without the join gate', () => {
  const fields = { programId: PROGRAM, owner: OWNER, season: SEASON, frontier: key(0x42), citizen: CITIZEN, ...PROOF, generation: 1, faction: 2 };
  const m = joinResidentMessage({ feePayer: FEE_PAYER, recentBlockhash: BLOCKHASH, profile: PROFILE, ...fields });
  const s = classify(tx(m), { programId: PROGRAM, wireBytes: wire(m).length, profile: PROFILE });
  assert.equal(s.ok, true, s.problem);
  assert.equal(s.wrapper, 'JoinResident');
  assert.equal(s.authority, OWNER);
  assert.equal(s.accounts.citizen, CITIZEN);
  assert.equal(s.accounts.join_gate, undefined);
  assert.deepEqual(s.data, { generation: 1, faction: 2 });
  assert.equal(allowanceFor(s, { season: null }), CITIZEN_RENT + LINK_RENT);
  const gated = joinResidentMessage({ feePayer: FEE_PAYER, recentBlockhash: BLOCKHASH, profile: PROFILE, ...fields, joinGate: key(0x91) });
  const g = classify(tx(gated), { programId: PROGRAM, profile: PROFILE });
  assert.equal(g.ok, true, g.problem);
  assert.equal(g.accounts.join_gate, key(0x91));
  // The fee payer may not be the owner.
  const self = joinResidentMessage({ feePayer: OWNER, recentBlockhash: BLOCKHASH, profile: PROFILE, ...fields });
  assert.equal(classify(tx(self), { programId: PROGRAM, profile: PROFILE }).ok, false);
});

test('the resident record and the asset owner decode from bytes', () => {
  const r = new Uint8Array(133);
  r[0] = 0xc2; r.set(new Uint8Array(32).fill(0x5a), 1); r.set([2, 0, 0, 0], 48);
  r.set(new Uint8Array(32).fill(0xc3), 52); r.set([1, 0, 0, 0], 92);
  const d = decodeResident(r);
  assert.equal(d.generation, 2);
  assert.equal(d.sessionGeneration, 1);
  assert.equal(decodeResident(r.slice(0, 132)), null);
  const a = new Uint8Array(66); a[0] = 1; a.fill(0xa1, 1, 33); a[33] = 2; a.fill(0x55, 34, 66);
  assert.equal(b58(decodeAssetOwner(a).owner), OWNER);
  assert.equal(decodeAssetOwner(a.slice(0, 40)), null);
});

test('GET /f/residents lists the wallet\'s resident NFTs from the chain, checking each hit', async () => {
  const { PublicKey } = await import('@solana/web3.js');
  const { listResidents } = await import('../src/frontier/routes/residents.mjs');
  const CORE = key(0x44), RESIDENT_PROGRAM = key(0x33), COLLECTION = key(0x55), POLICY = key(0x61);
  const raw = k => new PublicKey(k).toBytes();
  const policy = new Uint8Array(136);
  policy.set([...'PSFNP002'].map(c => c.charCodeAt(0)));
  policy.set(raw(CORE), 8); policy.set(raw(RESIDENT_PROGRAM), 40); policy.set(raw(COLLECTION), 72); policy.set(raw(key(0x66)), 104);
  const asset = (owner, collection) => { const a = new Uint8Array(66); a[0] = 1; a.set(raw(owner), 1); a[33] = 2; a.set(raw(collection), 34); return a; };
  const A1 = key(0x5a), A2 = key(0x5b), FORGED = key(0x5c);
  const resident = (a, gen) => { const r = new Uint8Array(133); r[0] = 0xc2; r.set(raw(a), 1); r.set([gen, 0, 0, 0], 48); return r; };
  const accounts = new Map([
    [POLICY, { data: policy, owner: new PublicKey(PROGRAM) }],
    [key(0x71), { data: resident(A1, 2), owner: new PublicKey(RESIDENT_PROGRAM) }],
    [key(0x72), { data: resident(A2, 0), owner: new PublicKey(RESIDENT_PROGRAM) }],
    [key(0x81), { data: new Uint8Array(384), owner: new PublicKey(PROGRAM) }],
  ]);
  const connection = {
    getAccountInfo: async pk => accounts.get(pk.toBase58()) ?? null,
    getProgramAccounts: async (prog, opts) => {
      assert.equal(prog.toBase58(), CORE);
      assert.deepEqual(opts.filters.map(f => f.memcmp.offset), [0, 1, 34]);
      return [
        { pubkey: new PublicKey(A2), account: { data: asset(OWNER, COLLECTION) } },
        { pubkey: new PublicKey(A1), account: { data: asset(OWNER, COLLECTION) } },
        // An RPC that ignored the filters: another owner's asset is dropped.
        { pubkey: new PublicKey(FORGED), account: { data: asset(key(0xb2), COLLECTION) } },
      ];
    },
    getMultipleAccountsInfo: async keys => keys.map(k => accounts.get(k.toBase58()) ?? null),
  };
  const addrs = {
    policy: POLICY,
    resident: (prog, a) => (assert.equal(prog, RESIDENT_PROGRAM), a === A1 ? key(0x71) : key(0x72)),
    citizen: a => (a === A1 ? key(0x81) : key(0x82)),
    link: a => (a === A1 ? key(0x91) : key(0x92)),
  };
  const r = await listResidents({ connection, owner: OWNER, addrs });
  assert.equal(r.policy.collection, COLLECTION);
  assert.deepEqual(r.residents.map(x => [x.asset, x.generation, x.joined]), [[A1, 2, true], [A2, 0, false]].sort((x, y) => (x[0] < y[0] ? -1 : 1)));
  // No policy (a program without the experimental build): an empty list.
  const none = await listResidents({ connection: { ...connection, getAccountInfo: async () => null }, owner: OWNER, addrs });
  assert.deepEqual(none, { residents: [], policy: null });
});
