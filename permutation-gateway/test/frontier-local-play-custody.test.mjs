// ⑨ capacity and ⑩ custody as a TEST-ONLY local-play preview in a COEXIST world (local-9-10-preview): the one builder the
// page and the relay share (permutation-server/web/frontier/flocalplay-custody.mjs, carried by flocalplay-rights.mjs'
// coexist acts) and the village-screen card's model (screens/custody.mjs). The encodings are pinned BY HAND from
// frontier-abi/src/capacity.rs (CapData::encode, accounts_of, pool/job seeds), frontier-abi/src/v2/ix.rs + addr.rs (the
// custody band 0xC2–0xCC, lot_seed) and the account layouts (permutation-rules capacity.rs `layout`, v2 s1 Lot/Caravan),
// and the custody account lists are checked against the generated ABI table (abi-v2-tags.mjs).
// No key (plain addresses), no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { encode, decode as b58d } from '../client/src/base58.mjs';
import { localActIntent, localActMessage, coexistPins } from '../src/frontier/local-play-act.mjs';
import { LOCAL_PLAY_PROGRAM } from '../src/frontier/local-play-relay.mjs';
import * as C from '../../permutation-server/web/frontier/flocalplay-custody.mjs';
import * as R from '../../permutation-server/web/frontier/flocalplay-rights.mjs';
import { custodyModel, renderCustody, reserveShort, reserveShortText } from '../../permutation-server/web/frontier/screens/custody.mjs';
import { rightsModel } from '../../permutation-server/web/frontier/screens/rights.mjs';
import { COEXIST_LANE, PLAIN_LANE } from '../../permutation-server/web/frontier/flocalplay-lane.mjs';
import { seasonAddresses, seasonPda, citizenTag } from '../../permutation-server/web/frontier/faddr.mjs';
import { TAGS as TAGS_V2 } from '../../permutation-server/web/sdk/frontier/abi-v2-tags.mjs';
import { parseTransaction } from '../client/src/solana-tx.mjs';
import { short } from '../../permutation-server/web/util.mjs';
import { PREVIEW_INTENTS } from './fixtures/custody-intents.mjs';

const w = n => encode(new Uint8Array(32).fill(n));
const WALLET = w(1), WALLET_B = w(2);
const SEASON = seasonPda(LOCAL_PLAY_PROGRAM, 11)[0], HASH = encode(new Uint8Array(32).fill(7));
const A = seasonAddresses(LOCAL_PLAY_PROGRAM, '11');
const ME = A.of('Citizen', { wallet: WALLET }), YOU = A.of('Citizen', { wallet: WALLET_B }), THEM = A.of('Citizen', { wallet: w(3) });
const TAG = citizenTag(ME).toString();
const COEX = { program: LOCAL_PLAY_PROGRAM, season: SEASON, seasonId: 11, wallet: WALLET, rulesetHash: COEXIST_LANE.rulesetHash };
const F = { p: 3, q: -2, site: 4 }, V = { p: 3, q: -2, tile: 22 };
const INTENTS = PREVIEW_INTENTS({ F, V, owner: YOU, tag: TAG, rentTo: WALLET_B });
const messageOf = (intent, p = COEX) => localActMessage(localActIntent(intent, { wallet: p.wallet, coexist: coexistPins(p) }), p, HASH).message;
const txOf = message => {
  const t = parseTransaction(Buffer.concat([Buffer.from([1]), Buffer.alloc(64), Buffer.from(message)]));
  const h = t.header, n = t.accountKeys.length;
  // (the legacy message header: signers first, the read-only ones last among them; then the unsigned, read-only last)
  return { ...t, isSigner: i => i < h.numRequiredSignatures,
    isWritable: i => (i < h.numRequiredSignatures ? i < h.numRequiredSignatures - h.numReadonlySignedAccounts : i < n - h.numReadonlyUnsignedAccounts) };
};
const ixs = name => txOf(messageOf(INTENTS[name])).instructions.slice(3);
const hex = x => Buffer.from(x.data).toString('hex');
const le = (n, v) => { const b = Buffer.alloc(n); if (n === 2) b.writeInt16LE(v); else if (n === 4) b.writeUInt32LE(v); else b.writeBigInt64LE(BigInt(v)); return b.toString('hex'); };
const withSeed = seed => encode(createHash('sha256').update(Buffer.from(b58d(SEASON))).update(seed).update(Buffer.from(b58d(LOCAL_PLAY_PROGRAM))).digest());

test('the pool, job and lot addresses are capacity.rs\'s and v2 addr.rs\'s seeds, byte for byte (pinned by hand)', () => {
  // cp‖hex(le16 p ‖ le16 q ‖ site ‖ gen); cj‖hex(pool raw ‖ le32 grant ‖ le32 job); cl‖hex(le16 p ‖ le16 q ‖ tile ‖ gen ‖ le64 tag ‖ resource)
  assert.equal(C.poolSeed({ ...F, gen: 1 }), 'cp' + '0300' + 'feff' + '04' + '01');
  assert.equal(C.jobSeed({ ...F, gen: 1 }, 2, 3), 'cp0300feff0401'.replace('cp', 'cj') + '02000000' + '03000000');
  const tagHex = Buffer.from(b58d(ME)).subarray(0, 8).toString('hex');
  assert.equal(C.lotSeed({ ...V, gen: 0 }, TAG), 'cl' + '0300' + 'feff' + '16' + '00' + tagHex + '03');
  assert.equal(C.lotSeed({ ...V, gen: 0 }, TAG).length, 32);   // (the longest seed create_with_seed takes)
  assert.equal(C.poolAddress(SEASON, LOCAL_PLAY_PROGRAM, { ...F, gen: 1 }), withSeed(C.poolSeed({ ...F, gen: 1 })));
  assert.equal(C.jobAddress(SEASON, LOCAL_PLAY_PROGRAM, { ...F, gen: 1 }, 2, 3), withSeed(C.jobSeed({ ...F, gen: 1 }, 2, 3)));
  assert.equal(C.lotAddress(SEASON, LOCAL_PLAY_PROGRAM, { ...V, gen: 0 }, TAG), withSeed(C.lotSeed({ ...V, gen: 0 }, TAG)));
});

test('the instruction data are CapData::encode\'s and v2 ix.rs\'s, byte for byte (pinned by hand)', () => {
  // OpenCapacityPool (policies CaptorTakesAll · Unaffected · HonorBooked) then LendCapacity {units, seq}: one message
  assert.deepEqual(ixs('OpenCapacityPool').map(hex), ['f0' + '000000', 'f1' + le(4, 2) + le(4, 0)]);
  assert.deepEqual(ixs('ReclaimCapacity').map(hex), ['f2' + le(4, 1) + le(4, 1)]);
  // GrantCapacity {grant u32, user [32], recipe u8, max_units u32, max_output i64, from i64, until i64} = 66 bytes
  assert.deepEqual(ixs('GrantCapacity').map(hex), ['f3' + le(4, 0) + Buffer.from(b58d(YOU)).toString('hex') + '01' + le(4, 2) + le(8, 40000) + le(8, 1790000000) + le(8, 1790086400)]);
  assert.deepEqual(ixs('RevokeCapacity').map(hex), ['f4' + le(4, 0)]);
  // ReserveCapacity {grant, job, units, start, end, max_output} then DepositToJob ×2 {grant, job, deposit u64, resource u8, amount i64, source 0, slot 0, order 0}
  assert.deepEqual(ixs('ReserveCapacity').map(hex), [
    'f5' + le(4, 0) + le(4, 0) + le(4, 2) + le(8, 1790000120) + le(8, 1790004620) + le(8, 10000),
    'f6' + le(4, 0) + le(4, 0) + le(8, 0) + '03' + le(8, 20000) + '00' + '00' + le(4, 0),
    'f6' + le(4, 0) + le(4, 0) + le(8, 1) + '01' + le(8, 10000) + '00' + '00' + le(4, 0)]);
  for (const [name, t] of [['SettleJob', 'f7'], ['CancelJob', 'f8'], ['ClaimJob', 'f9']]) assert.deepEqual(ixs(name).map(hex), [t + le(4, 0) + le(4, 0)], name);
  assert.deepEqual(ixs('RecordFacilityLoss').map(hex), ['fa']);
  // custody: OpenLot {resource u8 (ore 3), quota u32}; DepositLot {seq, qty, steps, path[12], fee u64}; WithdrawLot {seq, qty, dst_kind, dst_p, dst_q, dst_at, dst_gen, steps, path, fee}
  const path = '09' + '00'.repeat(11), fee = Buffer.alloc(8); fee.writeBigUInt64LE(50_000n);
  assert.deepEqual(ixs('OpenLot').map(hex), ['c2' + '03' + le(4, 50)]);
  assert.deepEqual(ixs('DepositLot').map(hex), ['c4' + le(4, 1) + le(4, 10) + '02' + path + fee.toString('hex')]);
  assert.deepEqual(ixs('WithdrawLot').map(hex), ['cc' + le(4, 2) + le(4, 10) + '01' + le(2, 3) + le(2, -2) + '04' + '00' + '02' + path + fee.toString('hex')]);
  assert.deepEqual(ixs('SettleCustody').map(hex), ['c8' + Buffer.from(b58d(WALLET)).toString('hex')]);
  assert.deepEqual(ixs('ReconcileLot').map(hex), ['ca']); assert.deepEqual(ixs('CloseLot').map(hex), ['cb']);
});

test('the account lists are accounts_of\'s (capacity, by hand) and the generated ABI table\'s (custody), flags included', () => {
  const t = txOf(messageOf(INTENTS.ReserveCapacity));
  const keysOf = ix => ix.accounts.map(i => t.accountKeys[i]);
  const fac = { ...F, gen: 0 }, pool = C.poolAddress(SEASON, LOCAL_PLAY_PROGRAM, fac), job = C.jobAddress(SEASON, LOCAL_PLAY_PROGRAM, fac, 0, 0);
  const [reserve, dep] = t.instructions.slice(3);
  // RESERVE: [actor s] [payer s,w] [season] [citizen w] [holding r] [pool w] [job w] [system]; DEPOSIT: … [holding r] [pool w] [job w] [vault w]
  assert.deepEqual(keysOf(reserve), [WALLET, WALLET, SEASON, ME, A.of('Holding', F), pool, job, '11111111111111111111111111111111']);
  assert.deepEqual(keysOf(dep), [WALLET, WALLET, SEASON, ME, A.of('Holding', F), pool, job, A.of('Vault', V)]);
  const loss = txOf(messageOf(INTENTS.RecordFacilityLoss)), lossIx = loss.instructions[3];
  assert.deepEqual(lossIx.accounts.map(i => loss.accountKeys[i]), [WALLET, SEASON, A.of('Holding', F), pool, job]);
  // custody: every position's signer and writable flag as the ABI table states it (the actor/payer pair merges into one key)
  for (const name of ['OpenLot', 'DepositLot', 'WithdrawLot', 'SettleCustody', 'ReconcileLot', 'CloseLot']) {
    const row = TAGS_V2.instructions.find(x => x.name === name), tx = txOf(messageOf(INTENTS[name])), ix = tx.instructions[3];
    const specs = row.account_groups.flatMap(g => Array.from({ length: g.max === 4 && g.accounts[0].kind === 'Province' ? 1 : g.max === 4 ? INTENTS[name].subject.caravans.length : 1 }, () => g.accounts).flat());
    assert.equal(ix.accounts.length, specs.length, name);
    specs.forEach((s, i) => {
      const at = ix.accounts[i];
      if (s.kind !== 'wallet') { assert.equal(tx.isWritable(at), s.writable === 'w' || tx.accountKeys[at] === WALLET, `${name} ${s.name} writable`); }
      if (s.signer) assert.ok(tx.isSigner(at), `${name} ${s.name} signs`);
    });
  }
  // the lot is the depositor's lot of ore in that storehouse
  const open = txOf(messageOf(INTENTS.OpenLot));
  assert.equal(open.accountKeys[open.instructions[3].accounts[6]], C.lotAddress(SEASON, LOCAL_PLAY_PROGRAM, { ...V, gen: 0 }, citizenTag(YOU).toString()));
});

test('one signature, the wallet, and a compute limit that covers every instruction of the message', () => {
  for (const name of C.PREVIEW_ACTS) {
    const t = txOf(messageOf(INTENTS[name]));
    assert.deepEqual(t.signers, [WALLET], name);
    const cu = Buffer.from(t.instructions[0].data).readUInt32LE(1);
    assert.ok(cu >= 10_000 && cu <= 1_400_000, `${name} ${cu}`);
  }
  assert.equal(Buffer.from(txOf(messageOf(INTENTS.ReserveCapacity)).instructions[0].data).readUInt32LE(1), C.CAP_CU.ReserveCapacity + 2 * C.CAP_CU.DepositToJob);
});

test('intents: the closed shapes (only CaptorTakesAll, no wide village, a window of 7 days at most, the storehouse in the village\'s Province)', () => {
  const bad = (name, patch) => assert.throws(() => C.previewIntent(name, { ...INTENTS[name].subject, ...(patch.subject ?? {}) }, { ...INTENTS[name].fields, ...(patch.fields ?? {}) }, 'X'), e => e.code === 'X' || e.code === 'LocalActWideHolding', JSON.stringify(patch));
  bad('OpenCapacityPool', { fields: { policies: [1, 0, 0] } });   // UserKeepsAll: not this preview's rule
  bad('OpenCapacityPool', { fields: { lend: 0 } });
  bad('ReserveCapacity', { fields: { end: String(1790000120 + 7 * 86_400 + 1) } });
  bad('ReserveCapacity', { subject: { vault: { p: 4, q: -2, tile: 22, gen: 0 } } });
  bad('ClaimJob', { subject: { vault: { p: 4, q: -2, tile: 22, gen: 0 } } });
  bad('GrantCapacity', { fields: { from: '1790086400', until: '1790000000' } });
  bad('OpenLot', { subject: { owner: 'not-an-address' } });
  bad('DepositLot', { fields: { seq: 9 } });
  bad('DepositLot', { fields: { fee: '1' } });
  bad('RecordFacilityLoss', { subject: { jobs: Array.from({ length: 17 }, (_, i) => ({ grant: 0, job: i })) } });
  assert.throws(() => C.previewIntent('OpenCapacityPool', { facility: { p: 200, q: 0, site: 0, gen: 0 }, open: true }, INTENTS.OpenCapacityPool.fields, 'X'), e => e.code === 'LocalActWideHolding');
  assert.throws(() => C.previewIntent('SeizeVault', {}, {}, 'X'), e => e.code === 'LocalActNotAllowed');
  // a plain world's relay builds none of them
  for (const name of C.PREVIEW_ACTS) assert.throws(() => localActMessage(localActIntent(INTENTS[name], { wallet: WALLET, coexist: true }), { ...COEX, rulesetHash: PLAIN_LANE.rulesetHash }, HASH), e => e.code === 'LocalActNotAllowed', name);
  // lending and opening a lot for someone are the wallet's own (② A's rule for issuing a right)
  for (const n of ['GrantCapacity', 'RevokeCapacity', 'OpenLot']) assert.ok(R.RIGHTS_WALLET_ONLY.includes(n), n);
});

// ---- account bytes written the way the Rust encoders write them, read back by the page's decoders
function poolBytes({ facility, owner, lent = 2, lostAt = null, grants = [], occ = [], ownerSeq = 1 }) {
  const b = Buffer.alloc(C.POOL_SIZE + 32); let o = 0;
  const put = (buf) => { buf.copy(b, o); o += buf.length; };
  const i16 = v => { const x = Buffer.alloc(2); x.writeInt16LE(v); return x; }, u32 = v => { const x = Buffer.alloc(4); x.writeUInt32LE(v); return x; }, i64 = v => { const x = Buffer.alloc(8); x.writeBigInt64LE(BigInt(v)); return x; };
  const key = k => Buffer.from(b58d(k)), u8 = v => Buffer.from([v]);
  put(Buffer.from('PSF1CPOL')); put(Buffer.from([1, 0, 25, 0, 0, 0, 0, 0]));
  put(i16(facility.p)); put(i16(facility.q)); put(u8(facility.site)); put(u8(facility.gen)); put(key(owner)); put(Buffer.from([0, 0, 0])); put(u32(lent)); put(u32(ownerSeq));
  put(Buffer.from([1, 1])); put(u32(lent)); put(u32(0));
  put(u8(lostAt === null ? 0 : 1)); put(i64(lostAt ?? 0)); put(u8(0)); put(Buffer.alloc(32)); put(u8(grants.length ? 1 : 0)); put(u32(grants.length ? grants.at(-1).seq : 0)); put(i64(occ.length));
  put(u8(grants.length));
  for (let i = 0; i < 8; i++) { const s = o; const g = grants[i]; if (g) { put(u32(g.seq)); put(key(g.user)); put(u8(1)); put(u32(g.maxUnits ?? 2)); put(i64(g.maxOutput ?? 40000)); put(i64(g.from ?? 0)); put(i64(g.until ?? 2e9)); put(u8(0)); put(i64(0)); put(i64(g.spent ?? 0)); put(u8(occ.some(x => x.grant === g.seq) ? 1 : 0)); put(u32(Math.max(0, ...occ.filter(x => x.grant === g.seq).map(x => x.job)))); } o = s + 87; }
  put(u8(occ.length));
  for (let i = 0; i < 16; i++) { const s = o; const r = occ[i]; if (r) { put(u32(r.grant)); put(u32(r.job)); put(u32(r.units)); put(i64(r.start)); put(i64(r.end)); put(i64(r.end)); put(u8(1)); put(i64(10000)); } o = s + 45; }
  assert.equal(o, C.POOL_SIZE);
  return new Uint8Array(b);
}
function jobBytes({ grant = 0, seq = 0, user, units = 2, start, end, maxOutput = 10000, hopper = [20000, 10000], fin = 0, finAt = 0, settled = 0, claimed = 0, forfeitedIn = [0, 0], forfeitedOut = 0 }) {
  const b = Buffer.alloc(C.JOB_SIZE + 32 + 57); let o = 0;
  const put = buf => { buf.copy(b, o); o += buf.length; };
  const u32 = v => { const x = Buffer.alloc(4); x.writeUInt32LE(v); return x; }, i64 = v => { const x = Buffer.alloc(8); x.writeBigInt64LE(BigInt(v)); return x; };
  put(Buffer.from('PSF1CJOB')); put(Buffer.from([1, 0, 26, 0, 0, 0, 0, 0]));
  put(u32(grant)); put(u32(seq)); put(i64(0)); put(Buffer.from(b58d(user))); put(Buffer.from([1])); put(u32(units)); put(i64(start)); put(i64(end)); put(i64(maxOutput));
  put(i64(hopper[0])); put(i64(hopper[1])); put(Buffer.from([fin])); put(i64(finAt)); put(i64(settled)); put(Buffer.from([0])); put(i64(claimed)); put(Buffer.from([0]));
  put(i64(0)); put(i64(0)); put(i64(forfeitedIn[0])); put(i64(forfeitedIn[1])); put(i64(forfeitedOut)); put(Buffer.from([0]));
  return new Uint8Array(b);
}
function lotBytes({ vault, owner, ownerTag, custodianTag = vault.ownerTag ?? 0, state = 1, quota = 50000, held = 0, forfeited = 0, inbound = [], rentTo = WALLET_B }) {
  const b = Buffer.alloc(576);
  b.write('PSF1CLOT', 0); b.writeInt16LE(vault.p, 64); b.writeInt16LE(vault.q, 66); b[68] = vault.tile; b[69] = vault.gen; b[70] = 3; b[71] = state;
  Buffer.from(b58d(owner)).copy(b, 72); b.writeBigUInt64LE(BigInt(ownerTag), 104); b.writeBigUInt64LE(BigInt(custodianTag), 112); b.writeBigInt64LE(BigInt(quota), 120); b.writeBigInt64LE(BigInt(held), 128); b.writeBigInt64LE(BigInt(forfeited), 160);
  inbound.forEach((x, i) => { const at = 432 + i * 24; b.writeBigUInt64LE(BigInt(x.tag), at); b.writeUInt32LE(x.seq, at + 8); b[at + 12] = 1; b.writeBigInt64LE(BigInt(x.qty), at + 16); });
  Buffer.from(b58d(rentTo)).copy(b, 528);
  return new Uint8Array(b);
}
function caravanBytes({ owner, seq, state = 1, custody = 1, dst, arriveTs, provinces = [{ p: 3, q: -2 }] }) {
  const b = Buffer.alloc(320);
  b.write('PSF1CRVN', 0); Buffer.from(b58d(owner)).copy(b, 64); b.writeBigUInt64LE(citizenTag(owner), 96); b.writeUInt32LE(seq, 104); b[109] = state; b[111] = provinces.length;
  b[128] = 2; b.writeInt16LE(dst.p, 129); b.writeInt16LE(dst.q, 131); b[133] = dst.tile; b[134] = dst.gen;
  provinces.forEach((x, i) => { b.writeInt16LE(x.p, 156 + i * 4); b.writeInt16LE(x.q, 158 + i * 4); });
  b.writeBigInt64LE(BigInt(arriveTs), 180); b[296] = custody; b[297] = 3; b.writeBigUInt64LE(citizenTag(owner), 304);
  return new Uint8Array(b);
}

test('the decoders read pools, jobs, lots and caravans as the Rust layouts write them', () => {
  const fac = { ...F, gen: 0 };
  const pl = C.decodePool(poolBytes({ facility: fac, owner: YOU, grants: [{ seq: 0, user: ME }], occ: [{ grant: 0, job: 0, units: 2, start: 100, end: 4600 }] }));
  assert.deepEqual(pl.facility, fac); assert.equal(pl.owner, YOU); assert.equal(pl.lent, 2); assert.equal(pl.lostAt, null);
  assert.equal(pl.grants[0].user, ME); assert.equal(pl.grants[0].lastJobSeq, 0); assert.equal(pl.occ[0].units, 2); assert.equal(pl.lastGrantSeq, 0);
  assert.equal(C.nextGrantSeq(pl), 1); assert.equal(C.nextJobSeq(pl.grants[0]), 1);
  const j = C.decodeJob(jobBytes({ user: ME, start: 100, end: 4600, fin: 3, finAt: 900, forfeitedIn: [18000, 9000], forfeitedOut: 1000 }));
  assert.equal(j.user, ME); assert.equal(j.fin, C.FIN.lost); assert.deepEqual(j.forfeitedIn, [18000, 9000]); assert.equal(j.forfeitedOut, 1000);
  const l = C.decodeLot(lotBytes({ vault: { ...V, gen: 0 }, owner: ME, ownerTag: TAG, held: 7000, inbound: [{ tag: TAG, seq: 3, qty: 5000 }] }));
  assert.equal(l.owner, ME); assert.equal(l.held, 7000); assert.deepEqual(l.inbound, [{ tag: TAG, seq: 3, qty: 5000 }]); assert.equal(l.rentTo, WALLET_B);
  const cv = C.decodeCaravan(caravanBytes({ owner: ME, seq: 3, dst: { ...V, gen: 0 }, arriveTs: 500 }));
  assert.deepEqual(cv.dst, { kind: 'vault', ...V, gen: 0 }); assert.equal(cv.custody, C.CV_CUSTODY_LOT); assert.deepEqual(cv.provinces, [{ p: 3, q: -2 }]);
  for (const f of [C.decodePool, C.decodeJob, C.decodeLot, C.decodeCaravan, C.decodeHoldingBrief]) assert.equal(f(new Uint8Array(600)), null);
});

test('job planning: 4 arms an hour a copy, 2 ore + 1 wood an arm (milli), output bounded by the hopper and the window', () => {
  assert.equal(C.secsFor(1, 4), 3600); assert.equal(C.secsFor(2, 10), 4500);
  const p = C.jobPlan({ units: 2, arms: 10, now: 1000 });
  assert.deepEqual(p, { units: 2, arms: 10, start: 1120, end: 5620, maxOutput: 10000, ore: 20000, wood: 10000 });
  const j = { units: 2, start: 1120, end: 5620, maxOutput: 10000, hopper: [20000, 10000], fin: 0, finAt: 0 };
  assert.equal(C.jobOutAt(j, 1120), 0); assert.equal(C.jobOutAt(j, 1120 + 1800), 4000); assert.equal(C.jobOutAt(j, 9999), 10000);
  assert.equal(C.jobOutAt({ ...j, hopper: [6000, 10000] }, 9999), 3000);   // (only 3 arms of ore)
});

// ---- the card's model: FOG RULE and losses told from the viewer's side
const NOW = 10_000;
const VAULT_YOU = { p: 3, q: -2, tile: 22, gen: 0, ownerTag: citizenTag(YOU).toString(), ownerCitizen: YOU, faction: 1 };
const VAULT_ME = { p: 3, q: -2, tile: 30, gen: 0, ownerTag: TAG, ownerCitizen: ME, faction: 0 };
const H = (citizen, site, extra = {}) => ({ p: 3, q: -2, site, gen: 0, tile: site + 10, state: 1, ownerCitizen: citizen, faction: citizen === ME ? 0 : citizen === YOU ? 1 : 2, workshops: 0, lent: 0, ...extra });
function world({ lots = [], pools = [], jobs = [], caravans = [], vaults = [VAULT_YOU, VAULT_ME], holdings = [H(ME, 4, { workshops: 3 }), H(YOU, 7), H(THEM, 9)] } = {}) {
  return { chain: { now: () => NOW }, clock: {}, provinces: new Map(), holdings: [], s1: { caravans: { vaults, moving: [] } },
    custody: { on: true, viewer: ME, myTag: TAG, read: 'ok', holdings, vaults, told: new Set(), custodySeqs: new Set(),
      lots: new Map(lots.map((e, i) => [`lot${i}`, e])), pools: new Map(pools.map((e, i) => [`pool${i}`, e])), jobs: new Map(jobs.map((e, i) => [`job${i}`, e])), caravans: new Map(caravans.map((e, i) => [`cv${i}`, e])) } };
}
const lotEntry = (vault, owner, over = {}) => ({ vault, owner, lot: C.decodeLot(lotBytes({ vault, owner, ownerTag: citizenTag(owner).toString(), ...over })) });

test('custody: the depositor sees its own lot and offers; the keeper sees what it holds; nothing of others; a room is offered only for players in the Province', () => {
  const m = custodyModel(world({ lots: [lotEntry(VAULT_YOU, ME, { held: 12000 }), lotEntry(VAULT_ME, YOU, { held: 5000 }), lotEntry(VAULT_YOU, THEM, { held: 9000 })] }));
  assert.equal(m.myLots.length, 1); assert.equal(m.myLots[0].held, 12); assert.equal(m.myLots[0].keeper, 1);
  assert.ok(m.myLots[0].canDeposit && m.myLots[0].canWithdraw && !m.myLots[0].canClose);
  assert.equal(m.keptLots.length, 1); assert.equal(m.keptLots[0].depositor, 1); assert.equal(m.keptLots[0].held, 5);   // (THEM's lot in YOU's storehouse: not drawn)
  assert.deepEqual(m.openChoices.map(x => x.faction), [2]);   // (YOU already has a room in the viewer's storehouse; THEM not yet)
  assert.deepEqual(m.losses, []);
  const html = String(renderCustody(world({ lots: [lotEntry(VAULT_YOU, ME, { held: 12000 })] })));
  assert.match(html, /data-form="lot-withdraw"/); assert.match(html, /data-form="lot-deposit"/); assert.doesNotMatch(html, /9000|THEM/);
  assert.equal(String(renderCustody({ custody: undefined })), '');
});

// (verify-pr256, owner 2026-11-26 answer 8 / Q-TG2-1: the keeper's lot list now shows a lot whose depositor has no village
// in the Province any more — its nation is not read there, so the row names the depositor by a short address, never "#null")
test('custody: a kept lot whose depositor has no village in the Province is named by its short address, not "#null"', () => {
  const gone = world({ lots: [lotEntry(VAULT_ME, THEM, { held: 20000 })], holdings: [H(ME, 4), H(YOU, 7)] });
  const m = custodyModel(gone);
  assert.equal(m.keptLots.length, 1); assert.equal(m.keptLots[0].depositor, null); assert.equal(m.keptLots[0].held, 20);
  const html = String(renderCustody(gone));
  assert.ok(html.includes(`${short(THEM)} の鉱石（マス 30）`), html.slice(0, 400)); assert.doesNotMatch(html, /#null|#undefined/);
  // with its village there, the nation as before
  assert.match(String(renderCustody(world({ lots: [lotEntry(VAULT_ME, THEM, { held: 20000 })] }))), /の鉱石（マス 30）/);
});

test('custody losses: a seized storehouse (reconcile, then forfeit) and a custody caravan taken on the road are told to the depositor; the keeper hears of its own', () => {
  // the storehouse changed hands (generation 1 now): the lot is frozen until anyone reconciles it
  const seized = custodyModel(world({ lots: [lotEntry(VAULT_YOU, ME, { held: 12000 })], vaults: [{ ...VAULT_YOU, gen: 1, ownerCitizen: THEM, faction: 2 }, VAULT_ME] }));
  assert.ok(seized.myLots[0].seized && seized.myLots[0].reconcile && !seized.myLots[0].canWithdraw && !seized.myLots[0].canDeposit);
  const forfeit = custodyModel(world({ lots: [lotEntry(VAULT_YOU, ME, { state: C.LOT_FORFEITED, forfeited: 12000 }), lotEntry(VAULT_ME, YOU, { state: C.LOT_FORFEITED, forfeited: 5000 })] }));
  const texts = forfeit.losses.map(x => x.text());
  assert.equal(texts.length, 2);
  assert.match(texts[0], /12/); assert.ok(forfeit.myLots[0].canClose);
  // the road: the lot expects caravan 3, and the caravan was taken
  const cv = C.decodeCaravan(caravanBytes({ owner: ME, seq: 3, custody: C.CV_CUSTODY_TAKEN, dst: { ...VAULT_YOU }, arriveTs: NOW + 50 }));
  const road = custodyModel(world({ lots: [lotEntry(VAULT_YOU, ME, { inbound: [{ tag: TAG, seq: 3, qty: 5000 }] })], caravans: [{ ...cv, vault: VAULT_YOU }] }));
  assert.equal(road.losses.length, 1); assert.match(road.losses[0].text(), /5/);
  assert.deepEqual(road.myLots[0].reconcile.caravans, [`${TAG}_3`]);
  // an arrived, untouched caravan is delivered by the custody card, never by the ② card's SettleCaravan
  const arrived = C.decodeCaravan(caravanBytes({ owner: ME, seq: 4, dst: { ...VAULT_YOU }, arriveTs: NOW - 5 }));
  const fs = world({ lots: [lotEntry(VAULT_YOU, ME, { inbound: [{ tag: TAG, seq: 4, qty: 5000 }] })], caravans: [{ ...arrived, vault: VAULT_YOU }] });
  assert.equal(custodyModel(fs).myLots[0].inbound[0].arrived, true);
  fs.custody.custodySeqs.add(4); fs.s1.caravans.moving = [{ ownerTag: TAG, seq: 4, arriveTs: NOW - 5, dst: { kind: 2, p: 3, q: -2, at: 22, gen: 0 }, provinces: [{ p: 3, q: -2 }], cargo: [], raided: false }];
  fs.rights = { on: true, viewer: ME, read: 'ok', live: new Map(), issued: [], rows: null };
  assert.equal(rightsModel(fs, NOW).deliveries.length, 0);
});

test('capacity: the owner lends and grants to players with a storehouse there; the user books and claims; a seized village is told to both, the captor having taken everything', () => {
  const fac = { ...F, gen: 0 };
  const lendOnly = custodyModel(world());
  assert.deepEqual(lendOnly.lendable.map(x => x.free), [3]);
  const pool = C.decodePool(poolBytes({ facility: fac, owner: ME, grants: [{ seq: 0, user: YOU }], occ: [{ grant: 0, job: 0, units: 2, start: NOW - 100, end: NOW + 4400 }] }));
  const owner = custodyModel(world({ pools: [{ holding: H(ME, 4), pool }], holdings: [H(ME, 4, { workshops: 1, lent: 2 }), H(YOU, 7)] }));
  assert.equal(owner.lendable.length, 0); assert.equal(owner.owned[0].lent, 2); assert.equal(owner.owned[0].busy, 2);
  assert.deepEqual(owner.owned[0].users.map(u => u.faction), [1]); assert.equal(owner.owned[0].nextGrant, 1);
  // the user's view of another's pool: only its own grant; a storehouse of its own in that Province makes it bookable
  const theirs = C.decodePool(poolBytes({ facility: { p: 3, q: -2, site: 7, gen: 0 }, owner: YOU, grants: [{ seq: 0, user: ME }, { seq: 1, user: THEM }] }));
  const user = custodyModel(world({ pools: [{ holding: H(YOU, 7), pool: theirs }] }));
  assert.equal(user.grants.length, 1); assert.ok(user.grants[0].canReserve); assert.equal(user.grants[0].vault.tile, 30);
  // (fix-loop15, LP15-8) the booking's materials: 2 ore + 1 wood an arm from the user's OWN storehouse there. Not known
  // (no herald read of the storehouse) → nothing is said and the button stays on: the program's check answers
  assert.equal(user.grants[0].stock, null); assert.equal(user.grants[0].empty, null);
  assert.doesNotMatch(String(renderCustody({ ...world({ pools: [{ holding: H(YOU, 7), pool: theirs }] }), mode: 'play' })), /custody-stock/);
  const stocked = (ore, wood) => world({ pools: [{ holding: H(YOU, 7), pool: theirs }], vaults: [VAULT_YOU, { ...VAULT_ME, stores: [0, wood, 0, ore, 0, 0, 0, 0], cap: 500 }] });
  const bare = custodyModel(stocked(0, 0)).grants[0];
  assert.deepEqual(bare.stock, { ore: 0, wood: 0 }); assert.deepEqual(bare.empty, { arms: 1, need: { ore: 2, wood: 1 }, have: { ore: 0, wood: 0 } }); assert.ok(bare.canReserve, 'the grant itself is live');
  const bareCard = String(renderCustody({ ...stocked(0, 0), mode: 'play' }));
  assert.match(bareCard, /<button type="submit" class="btn small" disabled>予約して材料を入れる<\/button>/, 'the button is off');
  assert.match(bareCard, /class="blocked custody-stock" data-stock="0,0">あなたの貯蔵庫（マス 30）に材料がありません（いま 鉱石 0・木材 0）。村から隊商で鉱石と木材を貯蔵庫へ運ぶと予約できます。/);
  const full = custodyModel(stocked(40, 20)).grants[0];
  assert.deepEqual(full.stock, { ore: 40, wood: 20 }); assert.equal(full.empty, null);
  const fullCard = String(renderCustody({ ...stocked(40, 20), mode: 'play' }));
  assert.match(fullCard, /<button type="submit" class="btn small" >予約して材料を入れる/); assert.match(fullCard, /class="muted custody-stock" data-stock="40,20">あなたの貯蔵庫（マス 30）：鉱石 40・木材 20</);
  // the press: 10 arms need 20 ore + 10 wood; one short of either is refused with the numbers, enough or unknown passes
  assert.equal(reserveShort([0, 10, 0, 20, 0, 0, 0, 0], 10), null); assert.equal(reserveShort(null, 10), null); assert.equal(reserveShort(undefined, 10), null);
  assert.deepEqual(reserveShort([0, 10, 0, 19, 0, 0, 0, 0], 10), { arms: 10, need: { ore: 20, wood: 10 }, have: { ore: 19, wood: 10 } });
  assert.ok(reserveShort([0, 9, 0, 20, 0, 0, 0, 0], 10));
  assert.equal(reserveShortText(reserveShort([0, 0, 0, 0, 0, 0, 0, 0], 10), 30), 'あなたの貯蔵庫（マス 30）の材料が足りません。兵器 10 には 鉱石 20・木材 10 がいります（いま 鉱石 0・木材 0）。村から隊商で貯蔵庫へ運んでから、もう一度押してください。');
  // the job lost with the village: the user is told what the captor took
  const job = C.decodeJob(jobBytes({ user: ME, start: NOW - 100, end: NOW + 4400, fin: 3, finAt: NOW - 50, settled: 0, forfeitedIn: [18000, 9000], forfeitedOut: 1000 }));
  const lost = custodyModel(world({ pools: [{ holding: H(YOU, 7), pool: { ...theirs, lostAt: NOW - 50 } }], jobs: [{ facility: { p: 3, q: -2, site: 7, gen: 0 }, job, owner: YOU }] }));
  assert.equal(lost.losses.length, 1); assert.match(lost.losses[0].text(), /18/); assert.ok(lost.myJobs[0].lost && !lost.myJobs[0].canClaim);
  // the village changed hands but the loss is not recorded yet: the record is offered (anyone may send it)
  const gone = custodyModel(world({ pools: [{ holding: H(YOU, 7), pool: theirs }], holdings: [H(ME, 4), { ...H(THEM, 7), gen: 1 }] }));
  assert.ok(gone.grants[0].gone && !gone.grants[0].canReserve);
  const ownerLost = custodyModel(world({ pools: [{ holding: H(ME, 4), pool: { ...pool, lostAt: NOW - 1 } }] }));
  assert.equal(ownerLost.losses.length, 1);
});

test('a loss is told as what happened — an alert with its own words, never "could not" and never a retry', async () => {
  const { statusOf, renderStatus } = await import('../../permutation-server/web/frontier/hud/status.mjs');
  const st = statusOf({ notice: { ok: false, loss: true, retry: false, text: () => '預けた鉱石 5 は道中で奪われました。' } }, { canRetry: true });
  assert.equal(st.state, 'loss'); assert.equal(st.retry, false);
  const h = String(renderStatus(st));
  assert.match(h, /role="alert"/); assert.match(h, /道中で奪われました/);
  assert.doesNotMatch(h, /できませんでした|notice-retry/);
});

// ---- verify-pr140: a seizure or a capture moves the storehouse or village to its next generation, and a lot's or pool's
// address carries the generation — the page reads the generations before too, or the loss vanishes instead of being told
test('reads after a seizure or a capture: the lots and pools of the generations before, and everything read before (verify-pr140)', () => {
  // a storehouse seized once (gen 2 now; built at gen 1): both roles are looked for at gen 1, the present one as before
  const v2 = { ...VAULT_YOU, gen: 2, ownerCitizen: THEM, faction: 2 };
  const plan = C.lotReadPlan({ vaults: [v2, { ...VAULT_ME, gen: 1 }], holdings: [H(ME, 4), H(YOU, 7), H(THEM, 9)], viewer: ME });
  const key = x => `${x.vault.tile}/${x.vault.gen}/${x.owner === ME ? 'me' : x.owner === YOU ? 'you' : 'them'}`;
  assert.deepEqual(plan.map(key).sort(), ['22/1/me', '22/1/them', '22/1/you', '22/2/me', '30/1/them', '30/1/you'].sort());
  // the addresses differ by generation (the reason for all this)
  assert.notEqual(C.lotAddress(A.season, LOCAL_PLAY_PROGRAM, { ...V, gen: 1 }, TAG), C.lotAddress(A.season, LOCAL_PLAY_PROGRAM, { ...V, gen: 2 }, TAG));
  // a lot read before is read again by its own address, even when nothing else points at it (the storehouse left the view)
  const again = C.lotReadPlan({ vaults: [], holdings: [], viewer: ME, known: [{ vault: { ...VAULT_YOU, gen: 1 }, owner: ME }] });
  assert.deepEqual(again.map(key), ['22/1/me']);
  // a captured workshop village (gen 2, the generation before 1): its old pool is read; a plain village is not
  const pools = C.poolReadPlan({ holdings: [{ ...H(THEM, 7), gen: 2, prevGen: 1, capturedBell: 40, workshops: 1 }, H(YOU, 9)], known: [{ p: 3, q: -2, site: 4, gen: 0 }] });
  assert.deepEqual(pools.map(f => `${f.site}/${f.gen}`).sort(), ['4/0', '7/1', '7/2']);
  // the brief decoder reads PREV_GEN @1256 and CAPTURED_BELL @1260
  const hb = Buffer.alloc(1264); hb.write('PSF1HOLD', 0); hb.writeInt16LE(3, 64); hb.writeInt16LE(-2, 66); hb[68] = 7; hb[69] = 2; hb[71] = 1; hb[1256] = 1; hb.writeUInt32LE(40, 1260);
  const brief = C.decodeHoldingBrief(new Uint8Array(hb));
  assert.equal(brief.gen, 2); assert.equal(brief.prevGen, 1); assert.equal(brief.capturedBell, 40);
});

test('the card on real chain state after a seizure: the lot of the generation before stays on both cards and the loss is told at once (verify-pr140)', () => {
  const v2 = { ...VAULT_YOU, gen: 2, ownerCitizen: THEM, faction: 2 };   // (YOU kept it at gen 1; THEM seized it)
  const old = { p: 3, q: -2, tile: 22, gen: 1, ownerCitizen: null, faction: null };
  const mine = lotEntry(old, ME, { held: 12000, custodianTag: citizenTag(YOU).toString() });
  const dep = custodyModel(world({ lots: [mine], vaults: [v2, VAULT_ME] }));
  assert.equal(dep.myLots.length, 1); assert.ok(dep.myLots[0].seized && dep.myLots[0].reconcile && !dep.myLots[0].canWithdraw);
  assert.equal(dep.myLots[0].keeper, 1);   // (the keeper the lot names — YOU's nation — not the captor's)
  assert.equal(dep.losses.length, 1); assert.match(dep.losses[0].text(), /12/);
  // the same key once reconciled: told once
  const after = custodyModel(world({ lots: [lotEntry(old, ME, { state: C.LOT_FORFEITED, forfeited: 12000, custodianTag: citizenTag(YOU).toString() })], vaults: [v2, VAULT_ME] }));
  assert.equal(after.losses[0].key, dep.losses[0].key);
  // the old keeper (viewer = YOU) still sees the lot it held, marked taken, and is told
  const fsKeeper = world({ lots: [lotEntry(old, ME, { held: 12000, custodianTag: citizenTag(YOU).toString() })], vaults: [v2, VAULT_ME] });
  fsKeeper.custody.viewer = YOU; fsKeeper.custody.myTag = citizenTag(YOU).toString();
  const keeper = custodyModel(fsKeeper);
  assert.equal(keeper.keptLots.length, 1); assert.ok(keeper.keptLots[0].seized); assert.equal(keeper.losses.length, 1);
  assert.match(String(renderCustody(fsKeeper)), /奪われた/);
  // a storehouse the view does not list (the herald's list late) is not taken for a seizure: no false alarm
  const late = custodyModel(world({ lots: [lotEntry(VAULT_YOU, ME, { held: 12000 })], vaults: [] }));
  assert.ok(!late.myLots[0].seized); assert.deepEqual(late.losses, []);
});

test('lending: only the copies the village still runs itself are offered (workshops − lent); the arms left count the open jobs (verify-pr140)', () => {
  const fac = { ...F, gen: 0 };
  const pool = C.decodePool(poolBytes({ facility: fac, owner: ME, lent: 1, grants: [{ seq: 0, user: YOU }] }));
  const all = custodyModel(world({ pools: [{ pool }], holdings: [H(ME, 4, { workshops: 1, lent: 1 }), H(YOU, 7)] }));
  assert.equal(all.owned[0].free, 0); assert.doesNotMatch(String(renderCustody(world({ pools: [{ pool }], holdings: [H(ME, 4, { workshops: 1, lent: 1 }), H(YOU, 7)] }))), /data-form="cap-lend"/);
  assert.deepEqual(custodyModel(world({ holdings: [H(ME, 4, { workshops: 2, lent: 1 })] })).lendable.map(x => x.free), [1]);
  assert.deepEqual(custodyModel(world({ holdings: [H(ME, 4, { workshops: 1, lent: 1 })] })).lendable, []);
  // a grant of 40 arms with one 10-arm job in the pool: 30 left; with 40 held, nothing is bookable
  const theirs = C.decodePool(poolBytes({ facility: { p: 3, q: -2, site: 7, gen: 0 }, owner: YOU, grants: [{ seq: 0, user: ME, maxOutput: 40000 }], occ: [{ grant: 0, job: 0, units: 1, start: NOW - 100, end: NOW + 4400 }] }));
  const user = custodyModel(world({ pools: [{ pool: theirs }] }));
  assert.equal(user.grants[0].maxArms, 30); assert.ok(user.grants[0].canReserve);
  const full = C.decodePool(poolBytes({ facility: { p: 3, q: -2, site: 7, gen: 0 }, owner: YOU, grants: [{ seq: 0, user: ME, maxOutput: 10000 }], occ: [{ grant: 0, job: 0, units: 1, start: NOW - 100, end: NOW + 4400 }] }));
  const none = custodyModel(world({ pools: [{ pool: full }] }));
  assert.equal(none.grants[0].maxArms, 0); assert.ok(!none.grants[0].canReserve);
});
