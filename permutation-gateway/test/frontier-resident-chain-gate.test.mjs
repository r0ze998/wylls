// ⑳ The relay's NFT holder gate read from the chain (src/frontier/resident-chain-gate.mjs),
// over literal account bytes: the program's own NFT Citizen bytes (frontier-abi
// vectors/v2/resident-citizen.json), a Core AssetV1, the resident program's record
// and the policy. No key, signature, network or npm dependency.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createResidentChainGate, citizenMark, decodePolicyRecord, RESIDENT_GATE_CODES as C } from '../src/frontier/resident-chain-gate.mjs';
import { decode as fromB58, encode as b58 } from '../client/src/base58.mjs';
import { policyAddress, residentAddress } from '../client/src/frontier/resident.mjs';

const vec = JSON.parse(readFileSync(new URL('../../frontier-abi/vectors/v2/resident-citizen.json', import.meta.url), 'utf8'));
const hex = h => Uint8Array.from(h.match(/../g).map(x => parseInt(x, 16)));
const caseOf = name => vec.cases.find(c => c.case === name);
const key = n => b58(Uint8Array.from({ length: 32 }, (_, i) => (i === 0 ? n : (n * 31 + i) & 0xff)));

const PROGRAM = vec.program_id;
const ASSET = vec.asset;
const CORE = 'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d';
const RESIDENT_PROGRAM = key(7);
const COLLECTION = key(8);
const GUARD = key(9);
const A = key(21), B = key(22), STRANGER = key(23);

const policyBytes = (o = {}) => Uint8Array.from([...Buffer.from('PSFNP002'), ...fromB58(o.core ?? CORE), ...fromB58(RESIDENT_PROGRAM), ...fromB58(o.collection ?? COLLECTION), ...fromB58(GUARD)]);
/** Core AssetV1 head: Key 1, owner, UpdateAuthority::Collection (2) + collection, then name/uri (not read). */
const assetBytes = (owner, collection = COLLECTION) => Uint8Array.from([1, ...fromB58(owner), 2, ...fromB58(collection), ...new Uint8Array(40)]);
const residentBytes = (gen, asset = ASSET) => {
  const b = new Uint8Array(133); b[0] = 0xc2; b.set(fromB58(asset), 1); new DataView(b.buffer).setUint32(48, gen, true); return b;
};

/** A chain of `{address → {owner, data}}` with a read counter; `holder`/`gen` move the pass. */
function chain({ holder = A, gen = 0, citizen = 'nft' } = {}) {
  const nft = caseOf(citizen);
  const accounts = new Map([
    [policyAddress(PROGRAM), { owner: PROGRAM, data: policyBytes() }],
    [ASSET, { owner: CORE, data: assetBytes(holder) }],
    [residentAddress(RESIDENT_PROGRAM, ASSET), { owner: RESIDENT_PROGRAM, data: residentBytes(gen) }],
    [nft.citizen_address, { owner: PROGRAM, data: hex(nft.bytes) }],
    [caseOf('wallet').citizen_address, { owner: PROGRAM, data: hex(caseOf('wallet').bytes) }],
  ]);
  const c = { accounts, reads: 0, getAccount: async k => { c.reads++; return accounts.get(k) ?? null; },
    transfer(to) { holder = to; gen += 1; accounts.set(ASSET, { owner: CORE, data: assetBytes(to) }); accounts.set(residentAddress(RESIDENT_PROGRAM, ASSET), { owner: RESIDENT_PROGRAM, data: residentBytes(gen) }); } };
  return c;
}
const CITIZEN = caseOf('nft').citizen_address;
const proof = (generation, o = {}) => ({ generation, asset: ASSET, resident: residentAddress(RESIDENT_PROGRAM, ASSET), policy: policyAddress(PROGRAM), link: key(30), ...o });
const gateOn = c => createResidentChainGate({ programId: PROGRAM, getAccount: c.getAccount });

test('the Citizen mark reads the program\'s own bytes: wallet, NFT, and the two invalid marks', () => {
  assert.deepEqual(citizenMark(hex(caseOf('wallet').bytes)), { nft: false });
  assert.deepEqual(citizenMark(hex(caseOf('nft').bytes)), { nft: true, asset: ASSET });
  assert.deepEqual(citizenMark(hex(caseOf('flagged_with_wallet').bytes)), { nft: true, asset: null });
  assert.deepEqual(citizenMark(hex(caseOf('flagged_zero_asset').bytes)), { nft: true, asset: null });
  assert.equal(citizenMark(new Uint8Array(10)), null);
  assert.deepEqual(decodePolicyRecord(policyBytes()), { coreProgram: CORE, residentProgram: RESIDENT_PROGRAM, collection: COLLECTION, guardAuthority: GUARD });
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

test('after a transfer: the old holder is refused, a generation signed before it is stale, the new holder at the new generation passes', async () => {
  const c = chain();
  c.transfer(B);
  const g = gateOn(c);
  assert.deepEqual(await g.check({ citizen: CITIZEN, actor: A, resident: proof(0) }), { ok: false, code: C.NOT_HOLDER });
  assert.deepEqual(await g.check({ citizen: CITIZEN, actor: A, resident: proof(1) }), { ok: false, code: C.NOT_HOLDER });
  assert.deepEqual(await g.check({ citizen: CITIZEN, actor: B, resident: proof(0) }), { ok: false, code: C.STALE });
  assert.deepEqual(await g.check({ citizen: CITIZEN, actor: B, resident: proof(1) }), { ok: true });
});

test('A→B→A: what A signed before leaving stays dead; A at the new generation passes', async () => {
  const c = chain();
  c.transfer(B); c.transfer(A);
  const g = gateOn(c);
  assert.deepEqual(await g.check({ citizen: CITIZEN, actor: A, resident: proof(0) }), { ok: false, code: C.STALE });
  assert.deepEqual(await g.check({ citizen: CITIZEN, actor: B, resident: proof(1) }), { ok: false, code: C.NOT_HOLDER });
  assert.deepEqual(await g.check({ citizen: CITIZEN, actor: A, resident: proof(2) }), { ok: true });
});

test('wrapper and Citizen disagree, or the wrapper names a wallet Citizen: refused', async () => {
  const c = chain();
  const g = gateOn(c);
  assert.deepEqual(await g.check({ citizen: CITIZEN, actor: A, resident: proof(0, { asset: key(50) }) }), { ok: false, code: C.WRONG_ASSET });
  assert.deepEqual(await g.check({ citizen: caseOf('wallet').citizen_address, actor: A, resident: proof(0) }), { ok: false, code: C.NOT_NFT });
});

test('anything not exactly what the program wrote is unverified, never a pass', async () => {
  const cases = {
    'invalid mark (wallet set)': c => { c.accounts.set(CITIZEN, { owner: PROGRAM, data: hex(caseOf('flagged_with_wallet').bytes) }); },
    'invalid mark (zero asset)': c => { c.accounts.set(CITIZEN, { owner: PROGRAM, data: hex(caseOf('flagged_zero_asset').bytes) }); },
    'Citizen not created': c => { c.accounts.delete(CITIZEN); },
    'Citizen of another program': c => { c.accounts.set(CITIZEN, { ...c.accounts.get(CITIZEN), owner: key(60) }); },
    'no policy': c => { c.accounts.delete(policyAddress(PROGRAM)); },
    'asset outside the collection': c => { c.accounts.set(ASSET, { owner: CORE, data: assetBytes(A, key(61)) }); },
    'asset not owned by Core': c => { c.accounts.set(ASSET, { owner: key(62), data: assetBytes(A) }); },
    'no resident record': c => { c.accounts.delete(residentAddress(RESIDENT_PROGRAM, ASSET)); },
    'record of another program': c => { const k = residentAddress(RESIDENT_PROGRAM, ASSET); c.accounts.set(k, { ...c.accounts.get(k), owner: key(63) }); },
  };
  for (const [name, spoil] of Object.entries(cases)) {
    const c = chain();
    spoil(c);
    assert.deepEqual(await gateOn(c).check({ citizen: CITIZEN, actor: A, resident: proof(0) }), { ok: false, code: C.UNVERIFIED }, name);
  }
  const c = chain();
  assert.deepEqual(await gateOn(c).check({ citizen: CITIZEN, actor: A, resident: proof(0, { resident: key(64) }) }), { ok: false, code: C.UNVERIFIED }, 'a record address the program would not derive');
});

test('JoinResident: only the holder, at the current generation; a pass-less wallet and the old holder are refused', async () => {
  const c = chain();
  const g = gateOn(c);
  assert.deepEqual(await g.checkJoin({ owner: A, resident: proof(0) }), { ok: true });
  assert.deepEqual(await g.checkJoin({ owner: STRANGER, resident: proof(0) }), { ok: false, code: C.NOT_HOLDER });
  c.transfer(B);
  assert.deepEqual(await g.checkJoin({ owner: A, resident: proof(0) }), { ok: false, code: C.NOT_HOLDER });
  assert.deepEqual(await g.checkJoin({ owner: B, resident: proof(0) }), { ok: false, code: C.STALE });
  assert.deepEqual(await g.checkJoin({ owner: B, resident: proof(1) }), { ok: true });
  assert.deepEqual(await g.checkJoin({ owner: B, resident: null }), { ok: false, code: C.UNVERIFIED });
});

test('the relay passes the wrapper to the gate at both reads, and JoinResident to checkJoin', () => {
  const relay = readFileSync(new URL('../src/frontier/routes/relay.mjs', import.meta.url), 'utf8');
  assert.equal(relay.match(/residentRefusal\(ctx, residentCitizen, shape\.authority, shape\)/g)?.length, 2, 'before the simulation and right before the send');
  assert.match(relay, /shape\?\.wrapper === 'JoinResident' && ctx\.residents\.checkJoin \? await ctx\.residents\.checkJoin\(\{ owner: actor, resident \}\)/);
  assert.match(relay, /catch \{\n\s*return 'ResidentUnverified';/, 'a gate that throws refuses');
  const app = readFileSync(new URL('../src/frontier/app.mjs', import.meta.url), 'utf8');
  assert.match(app, /residents: residents !== undefined \? residents : createResidentChainGate\(/);
});
