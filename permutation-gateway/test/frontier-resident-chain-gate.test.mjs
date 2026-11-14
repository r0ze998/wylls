// ⑳ The relay's NFT holder gate read from the chain (src/frontier/resident-chain-gate.mjs), over the
// programs' own bytes: Core assets and resident records the REAL mainnet Core binary and the resident
// program wrote in LiteSVM (permutation-nft-resident-spike/svm-core/out: after mint, after A→B, after
// A→B→A) and the Frontier program's NFT Citizen (frontier-abi vectors/v2/resident-citizen.json, the same
// asset). No key, signature, network or npm dependency.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createResidentChainGate, citizenMark, decodePolicyRecord, guardRefusal, assetBaseEnd, assetOwnerIn, RESIDENT_GATE_CODES as C } from '../src/frontier/resident-chain-gate.mjs';
import { decode as fromB58, encode as b58 } from '../client/src/base58.mjs';
import { guardAuthorityAddress, policyAddress, residentAddress } from '../client/src/frontier/resident.mjs';

const read = p => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const vec = JSON.parse(read('frontier-abi/vectors/v2/resident-citizen.json'));
const scene = name => JSON.parse(read(`permutation-nft-resident-spike/svm-core/out/${name}.json`));
const MINT = scene('32BAc86QRafuU5kBhBDCbMdAF66DHPqtsho6Ny9espxj');  // after mint: holder A, gen 0
const TO_B = scene('Bead66hFEGrpqGsVRrGY4ywxiReBZegnVTvQq2BVeiyW');  // after A→B (another asset of the run)
const ABA = scene('3W1Wt9uSLStrJ1K9V886N2o7P1MYnZtCQLUQyPhdYhpU');   // after A→B→A
const b64 = s => Uint8Array.from(Buffer.from(s, 'base64'));
const hex = h => Uint8Array.from(h.match(/../g).map(x => parseInt(x, 16)));
const caseOf = name => vec.cases.find(c => c.case === name);
const key = n => b58(Uint8Array.from({ length: 32 }, (_, i) => (i === 0 ? n : (n * 31 + i) & 0xff)));

const PROGRAM = vec.program_id;
const ASSET = MINT.asset.address;
const CORE = MINT.coreProgram;
const RESIDENT_PROGRAM = MINT.residentProgram;
const COLLECTION = MINT.collection;
const GUARD = guardAuthorityAddress(RESIDENT_PROGRAM);
const A = MINT.extra.holder;          // the minting wallet of the real run
const B = TO_B.extra.holder;          // the buyer of the real run
const STRANGER = key(23);
const CITIZEN = caseOf('nft').citizen_address;
const RECORD = residentAddress(RESIDENT_PROGRAM, ASSET);

assert.equal(vec.asset, ASSET, 'the vector Citizen is this asset\'s');
assert.equal(RECORD, MINT.resident.address, 'the record address the resident program used');

const policyBytes = (o = {}) => Uint8Array.from([...Buffer.from('PSFNP002'), ...fromB58(o.core ?? CORE), ...fromB58(o.residentProgram ?? RESIDENT_PROGRAM), ...fromB58(o.collection ?? COLLECTION), ...fromB58(o.guard ?? GUARD)]);
/** The real asset bytes with another owner: TransferResident changes only bytes 1..33 (frozen, guarded). */
const assetOwnedBy = owner => { const d = b64(MINT.asset.dataBase64); d.set(fromB58(owner), 1); return d; };
/** The real record bytes at another generation, session cleared (TransferResident clears it). */
const recordAt = (gen, session = null) => {
  const d = b64(MINT.resident.dataBase64);
  new DataView(d.buffer).setUint32(48, gen, true);
  d.fill(0, 52, 128);
  if (session) { d.set(fromB58(session.key), 52); new DataView(d.buffer).setBigInt64(84, BigInt(session.expiry), true); new DataView(d.buffer).setUint32(92, session.gen, true); d.set(fromB58(session.setter), 96); }
  return d;
};

function chain() {
  const accounts = new Map([
    [policyAddress(PROGRAM), { owner: PROGRAM, data: policyBytes() }],
    [ASSET, { owner: CORE, data: b64(MINT.asset.dataBase64) }],
    [RECORD, { owner: RESIDENT_PROGRAM, data: b64(MINT.resident.dataBase64) }],
    [CITIZEN, { owner: PROGRAM, data: hex(caseOf('nft').bytes) }],
    [caseOf('wallet').citizen_address, { owner: PROGRAM, data: hex(caseOf('wallet').bytes) }],
  ]);
  let gen = 0;
  const c = { accounts, reads: 0, getAccount: async k => { c.reads++; return accounts.get(k) ?? null; },
    transfer(to) { gen += 1; accounts.set(ASSET, { owner: CORE, data: assetOwnedBy(to) }); accounts.set(RECORD, { owner: RESIDENT_PROGRAM, data: recordAt(gen) }); },
    setSession(s) { accounts.set(RECORD, { owner: RESIDENT_PROGRAM, data: recordAt(gen, s) }); } };
  return c;
}
const proof = (generation, o = {}) => ({ generation, asset: ASSET, resident: RECORD, policy: policyAddress(PROGRAM), link: key(30), ...o });
const gateOn = (c, o = {}) => createResidentChainGate({ programId: PROGRAM, getAccount: c.getAccount, ...o });

test('the readers agree with the programs\' bytes: Citizen mark, policy, AssetV1 owner, the transfer guard of all three real scenes', () => {
  assert.deepEqual(citizenMark(hex(caseOf('wallet').bytes)), { nft: false });
  assert.deepEqual(citizenMark(hex(caseOf('nft').bytes)), { nft: true, asset: ASSET });
  assert.deepEqual(citizenMark(hex(caseOf('flagged_with_wallet').bytes)), { nft: true, asset: null });
  assert.deepEqual(citizenMark(hex(caseOf('flagged_zero_asset').bytes)), { nft: true, asset: null });
  assert.deepEqual(decodePolicyRecord(policyBytes()), { coreProgram: CORE, residentProgram: RESIDENT_PROGRAM, collection: COLLECTION, guardAuthority: GUARD });
  for (const s of [MINT, TO_B, ABA]) {
    const d = b64(s.asset.dataBase64);
    assert.equal(assetOwnerIn(d, COLLECTION), s.extra.holder, s.extra.scene);
    assert.equal(guardRefusal(d, GUARD), null, `${s.extra.scene}: guarded`);
    assert.equal(guardRefusal(d, key(70)), 'NotFrozen', `${s.extra.scene}: another authority's guard is no guard`);
  }
  // The Rust test's guard address (frontier-abi resident_guard.rs GUARD) is this resident program's.
  assert.match(read('frontier-abi/src/resident_guard.rs'), new RegExp(`const GUARD: &str = "${Buffer.from(fromB58(GUARD)).toString('hex')}"`));
});

test('a call without a wrapper passes with no chain read (every wallet player, every existing world)', async () => {
  const c = chain();
  assert.deepEqual(await gateOn(c).check({ citizen: CITIZEN, actor: STRANGER }), { ok: true });
  assert.deepEqual(await gateOn(c).check({ citizen: caseOf('wallet').citizen_address, actor: key(40) }), { ok: true });
  assert.equal(c.reads, 0);
});

test('the holder at the current generation passes; a wallet without the pass is refused', async () => {
  const c = chain();
  assert.deepEqual(await gateOn(c).check({ citizen: CITIZEN, actor: A, resident: proof(0) }), { ok: true });
  assert.deepEqual(await gateOn(c).check({ citizen: CITIZEN, actor: STRANGER, resident: proof(0) }), { ok: false, code: C.NOT_HOLDER });
});

test('after a transfer (the program\'s order: generation, then owner): what A signed before is stale, A now is not the holder, B passes', async () => {
  const c = chain();
  c.transfer(B);
  const g = gateOn(c);
  assert.deepEqual(await g.check({ citizen: CITIZEN, actor: A, resident: proof(0) }), { ok: false, code: C.STALE });
  assert.deepEqual(await g.check({ citizen: CITIZEN, actor: A, resident: proof(1) }), { ok: false, code: C.NOT_HOLDER });
  assert.deepEqual(await g.check({ citizen: CITIZEN, actor: B, resident: proof(0) }), { ok: false, code: C.STALE });
  assert.deepEqual(await g.check({ citizen: CITIZEN, actor: B, resident: proof(1) }), { ok: true });
  assert.deepEqual(await g.check({ citizen: CITIZEN, actor: B, resident: proof(7) }), { ok: false, code: C.STALE }, 'a generation from the future is no better');
});

test('A→B→A: what A signed before leaving stays dead; B is out; A at the new generation passes', async () => {
  const c = chain();
  c.transfer(B); c.transfer(A);
  const g = gateOn(c);
  assert.deepEqual(await g.check({ citizen: CITIZEN, actor: A, resident: proof(0) }), { ok: false, code: C.STALE });
  assert.deepEqual(await g.check({ citizen: CITIZEN, actor: B, resident: proof(2) }), { ok: false, code: C.NOT_HOLDER });
  assert.deepEqual(await g.check({ citizen: CITIZEN, actor: A, resident: proof(2) }), { ok: true });
});

test('a session: the owner\'s, of this generation, unexpired (when the chain clock is given); never the old holder\'s', async () => {
  const c = chain();
  const K = key(80);
  c.setSession({ key: K, expiry: 1_000, gen: 0, setter: A });
  assert.deepEqual(await gateOn(c).check({ citizen: CITIZEN, actor: K, resident: proof(0) }), { ok: true });
  assert.deepEqual(await gateOn(c, { now: () => 999 }).check({ citizen: CITIZEN, actor: K, resident: proof(0) }), { ok: true });
  assert.deepEqual(await gateOn(c, { now: () => 1_000 }).check({ citizen: CITIZEN, actor: K, resident: proof(0) }), { ok: false, code: C.NOT_HOLDER });
  c.setSession({ key: K, expiry: 1_000, gen: 0, setter: STRANGER });
  assert.deepEqual(await gateOn(c).check({ citizen: CITIZEN, actor: K, resident: proof(0) }), { ok: false, code: C.NOT_HOLDER }, 'set by someone else');
  c.transfer(B);
  c.setSession({ key: K, expiry: 1_000, gen: 0, setter: A });
  assert.deepEqual(await gateOn(c).check({ citizen: CITIZEN, actor: K, resident: proof(1) }), { ok: false, code: C.NOT_HOLDER }, 'A\'s session left behind');
  assert.deepEqual(await gateOn(c).checkJoin({ owner: K, resident: proof(1) }), { ok: false, code: C.NOT_HOLDER }, 'the first login takes no session');
});

test('the wrapper and the Citizen disagree, or the wrapper names a wallet Citizen: refused', async () => {
  const g = gateOn(chain());
  assert.deepEqual(await g.check({ citizen: CITIZEN, actor: A, resident: proof(0, { asset: key(50) }) }), { ok: false, code: C.WRONG_ASSET });
  assert.deepEqual(await g.check({ citizen: caseOf('wallet').citizen_address, actor: A, resident: proof(0) }), { ok: false, code: C.NOT_NFT });
});

test('no transfer guard of the policy\'s authority: refused (a plain Core transfer could move it without a new generation)', async () => {
  const real = b64(MINT.asset.dataBase64);
  const base = assetBaseEnd(real);
  // Core's layout after the base: PluginHeaderV1 (3, registry offset u64), the first plugin's data
  // (PermanentFreezeDelegate: 5, frozen 1), …, PluginRegistryV1 (4, entries: kind, authority, offset).
  assert.deepEqual([real[base], real[base + 9], real[base + 10]], [3, 5, 1]);
  const reg = Number(new DataView(real.buffer).getBigUint64(base + 1, true));
  assert.deepEqual([real[reg], real[reg + 5], real[reg + 6]], [4, 5, 3], 'first entry: the freeze delegate, Address authority');
  const cases = {
    'not frozen': [d => { d[base + 10] = 0; }, 'NotFrozen'],
    'the freeze delegate of another authority': [d => { d.set(fromB58(key(71)), reg + 7); }, 'NotFrozen'],
    'the transfer delegate of another authority': [d => { d.set(fromB58(key(72)), reg + 5 + 42 + 2); }, 'NoTransferDelegate'],
    'no plugins at all': [d => d.slice(0, base), 'NoRegistry'],
  };
  for (const [name, [spoil, why]] of Object.entries(cases)) {
    const c = chain();
    const d = b64(MINT.asset.dataBase64);
    const spoiled = spoil(d) ?? d;
    assert.equal(guardRefusal(spoiled, GUARD), why, `${name}: the reader sees it`);
    c.accounts.set(ASSET, { owner: CORE, data: spoiled });
    assert.deepEqual(await gateOn(c).check({ citizen: CITIZEN, actor: A, resident: proof(0) }), { ok: false, code: C.UNGUARDED }, name);
  }
});

test('anything not exactly what the programs wrote is unverified, never a pass (forged collection, look-alike programs, missing records)', async () => {
  const cases = {
    'invalid mark (wallet set)': c => { c.accounts.set(CITIZEN, { owner: PROGRAM, data: hex(caseOf('flagged_with_wallet').bytes) }); },
    'invalid mark (zero asset)': c => { c.accounts.set(CITIZEN, { owner: PROGRAM, data: hex(caseOf('flagged_zero_asset').bytes) }); },
    'Citizen not created': c => { c.accounts.delete(CITIZEN); },
    'Citizen of another program': c => { c.accounts.set(CITIZEN, { ...c.accounts.get(CITIZEN), owner: key(60) }); },
    'no policy': c => { c.accounts.delete(policyAddress(PROGRAM)); },
    'a policy whose guard is not the resident program\'s': c => { c.accounts.set(policyAddress(PROGRAM), { owner: PROGRAM, data: policyBytes({ guard: key(65) }) }); },
    'a forged collection (same bytes, another collection)': c => { const d = b64(MINT.asset.dataBase64); d.set(fromB58(key(61)), 34); c.accounts.set(ASSET, { owner: CORE, data: d }); },
    'a look-alike Core program': c => { c.accounts.set(ASSET, { owner: key(62), data: b64(MINT.asset.dataBase64) }); },
    'a malformed name': c => { const d = b64(MINT.asset.dataBase64); d[70] = 0xff; c.accounts.set(ASSET, { owner: CORE, data: d }); },
    'no resident record': c => { c.accounts.delete(RECORD); },
    'a record of another program': c => { c.accounts.set(RECORD, { ...c.accounts.get(RECORD), owner: key(63) }); },
    'another asset\'s record at this address': c => { c.accounts.set(RECORD, { owner: RESIDENT_PROGRAM, data: b64(TO_B.resident.dataBase64) }); },
  };
  for (const [name, spoil] of Object.entries(cases)) {
    const c = chain();
    spoil(c);
    assert.deepEqual(await gateOn(c).check({ citizen: CITIZEN, actor: A, resident: proof(0) }), { ok: false, code: C.UNVERIFIED }, name);
  }
  assert.deepEqual(await gateOn(chain()).check({ citizen: CITIZEN, actor: A, resident: proof(0, { resident: key(64) }) }), { ok: false, code: C.UNVERIFIED }, 'a record address the program would not derive');
  assert.deepEqual(await gateOn(chain()).check({ citizen: CITIZEN, actor: A, resident: proof(-1) }), { ok: false, code: C.STALE }, 'a generation that is no u32');
});

test('JoinResident: only the holder itself, at the current generation; a pass-less wallet and the old holder are refused', async () => {
  const c = chain();
  const g = gateOn(c);
  assert.deepEqual(await g.checkJoin({ owner: A, resident: proof(0) }), { ok: true });
  assert.deepEqual(await g.checkJoin({ owner: STRANGER, resident: proof(0) }), { ok: false, code: C.NOT_HOLDER });
  c.transfer(B);
  assert.deepEqual(await g.checkJoin({ owner: A, resident: proof(1) }), { ok: false, code: C.NOT_HOLDER });
  assert.deepEqual(await g.checkJoin({ owner: B, resident: proof(0) }), { ok: false, code: C.STALE });
  assert.deepEqual(await g.checkJoin({ owner: B, resident: proof(1) }), { ok: true });
  assert.deepEqual(await g.checkJoin({ owner: B, resident: null }), { ok: false, code: C.UNVERIFIED });
});

test('the relay: the gate runs before the simulation and again right before the send, so a refusal costs the relay no fee; a gate that throws refuses', () => {
  const relay = read('permutation-gateway/src/frontier/routes/relay.mjs');
  const sponsor = relay.slice(relay.indexOf('async function sponsor('));
  const first = sponsor.indexOf('residentRefusal(ctx, residentCitizen, shape.authority, shape)');
  const sim = sponsor.indexOf('simulat');
  const second = sponsor.indexOf('residentRefusal(ctx, residentCitizen, shape.authority, shape)', first + 1);
  const send = sponsor.indexOf('connection.sendRawTransaction(');
  assert.ok(first > 0 && sim > first, 'checked before simulating');
  assert.ok(second > first && (send < 0 || send > second), 'checked again before the bytes leave');
  // The first refusal comes before the rate limit, the quota charge and the fee payer's signature;
  // the second one gives the whole quota back and releases the replay key before any send.
  assert.ok(sponsor.indexOf('limiter.check(') > first && sponsor.indexOf('quota.charge(') > first && sponsor.indexOf('signAs(') > first);
  const late = sponsor.slice(second, sponsor.indexOf('connection.sendRawTransaction('));
  assert.match(late, /catch \(e\) \{\n\s*\/\/ Every failure above is before the RPC call; these bytes were not sent\.\n\s*quota\.refund\(key, \{ day: frame\.day, lamports: moved \}\);\n\s*release\(\);/);
  assert.match(relay, /shape\?\.wrapper === 'JoinResident' && ctx\.residents\.checkJoin \? await ctx\.residents\.checkJoin\(\{ owner: actor, resident \}\)/);
  assert.match(relay, /catch \{\n\s*return 'ResidentUnverified';/);
  const app = read('permutation-gateway/src/frontier/app.mjs');
  assert.match(app, /residents: residents !== undefined \? residents : createResidentChainGate\(/);
});
