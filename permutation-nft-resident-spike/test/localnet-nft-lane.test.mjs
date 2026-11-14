// The local NFT world's programs together on one loopback validator: the REAL Core binary, the
// resident program (latest build) and the Frontier NFT lane (`localnet-nft-sbf`,
// scripts/build-frontier-localnet-nft-sbf.sh). Real transactions, real program bytes:
//   - the lane runs only under its program id ([0x4E; 32]); the same .so elsewhere is BadAddress;
//   - CreateResidentPolicy: only the Frontier upgrade authority, only the resident program's guard,
//     once; the policy the program writes is the one the relay gate reads;
//   - a pass minted and transferred on the same chain; the relay gate (permutation-gateway
//     resident-chain-gate.mjs) reads the programs' accounts: the holder passes, a wallet without
//     the pass and the old holder are refused, a generation signed before the transfer is stale.
// Not here: a Season (JoinResident and ResidentAct need a running world: frontier-stack, see
// docs/integration/CLAUDE-NFT-PASS-LOCAL-WORLD-20261114.md §5).
// Keys: random, in memory, for this process (setup, payer, holders). Test values only.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { keypair, base58 } from '../src/crypto.mjs';
import { localnetAvailable, setupWorld, startValidator, TEST_PROGRAM_ID } from '../src/localnet.mjs';
import { customCode, mintResidentIx, pdas, signedTx, transferResidentIx } from '../src/resident-ix.mjs';
import { MPL_CORE_PROGRAM } from '../src/core-asset.mjs';
import { attachMintStack } from '../src/mint-demo.mjs';
import { createResidentPolicyIx, guardAuthorityAddress, policyAddress } from '../../permutation-gateway/client/src/frontier/resident.mjs';
import { createResidentChainGate, decodePolicyRecord, guardRefusal, RESIDENT_GATE_CODES as C } from '../../permutation-gateway/src/frontier/resident-chain-gate.mjs';

const LANE_SO = process.env.PSF_LOCALNET_NFT_SO ?? fileURLToPath(new URL('../../permutation-frontier/target/deploy-localnet-nft-sbf/permutation_frontier.so', import.meta.url));
const FRONTIER = base58(new Uint8Array(32).fill(0x4e));            // LOCALNET_NFT_PROGRAM_ID
const ELSEWHERE = base58(new Uint8Array(32).fill(0x4d));           // the same .so under another id
const skip = !localnetAvailable() || !existsSync(LANE_SO) ? 'needs the validator, Core, the resident program and the lane .so' : false;
const FRONTIER_ERR = { BadData: 1, BadAddress: 3, Auth: 4 };

let v, world;
const setup = keypair();
before(async () => {
  if (skip) return;
  v = await startValidator({ programId: TEST_PROGRAM_ID, setup, extraPrograms: [{ id: FRONTIER, so: LANE_SO }, { id: ELSEWHERE, so: LANE_SO }] });
  world = await setupWorld({ rpc: v.rpc, programId: v.programId, setup });
});
after(async () => { if (v) await v.stop(); });

async function send(instructions, signers, feePayer = signers[0].publicKey) {
  const { blockhash } = await v.rpc.latestBlockhash();
  const tx = signedTx({ feePayer, blockhash, instructions, signers });
  try {
    const sig = await v.rpc.send(tx.wire);
    const st = await v.rpc.confirm(sig);
    return { ok: !!st && !st.err, err: st?.err ?? null, code: customCode(st?.err) };
  } catch (e) { return { ok: false, err: e.message, code: customCode({ message: e.message, data: e.data ?? null }) }; }
}
async function funded() {
  const k = keypair();
  await v.rpc.confirm(await v.rpc.airdrop(k.publicKey, 2_000_000_000));
  return k;
}
const policyFields = () => ({ programId: FRONTIER, authority: setup.publicKey, coreProgram: MPL_CORE_PROGRAM, residentProgram: v.programId, collection: world.collection });

test('the lane runs only under its program id: the same .so elsewhere refuses every instruction (BadAddress)', { skip }, async () => {
  const r = await send([createResidentPolicyIx({ ...policyFields(), programId: ELSEWHERE })], [setup]);
  assert.equal(r.ok, false);
  assert.equal(r.code, FRONTIER_ERR.BadAddress, JSON.stringify(r.err));
});

test('CreateResidentPolicy: not the upgrade authority → Auth; a guard that is not the resident program\'s → BadData; then once, and never again', { skip }, async () => {
  const stranger = await funded();
  const notAuth = await send([createResidentPolicyIx({ ...policyFields(), authority: stranger.publicKey })], [stranger]);
  assert.equal(notAuth.code, FRONTIER_ERR.Auth, JSON.stringify(notAuth.err));
  const badGuard = createResidentPolicyIx(policyFields());
  badGuard.data = Uint8Array.from(badGuard.data); badGuard.data.fill(7, 97, 129);
  const g = await send([badGuard], [setup]);
  assert.equal(g.code, FRONTIER_ERR.BadData, JSON.stringify(g.err));
  assert.equal(await v.rpc.account(policyAddress(FRONTIER)), null, 'nothing written by a refusal');
  const ok = await send([createResidentPolicyIx(policyFields())], [setup]);
  assert.ok(ok.ok, JSON.stringify(ok.err));
  const acct = await v.rpc.account(policyAddress(FRONTIER));
  assert.equal(acct.owner, FRONTIER);
  assert.deepEqual(decodePolicyRecord(acct.data), { coreProgram: MPL_CORE_PROGRAM, residentProgram: v.programId, collection: world.collection, guardAuthority: guardAuthorityAddress(v.programId) });
  assert.equal(guardAuthorityAddress(v.programId), pdas(v.programId).collectionAuthority);
  const again = await send([createResidentPolicyIx(policyFields())], [setup]);
  assert.equal(again.ok, false, 'write-once');
});

test('a pass minted and transferred on the same chain; the relay gate reads the programs\' accounts: holder, no pass, old holder, stale generation', { skip }, async () => {
  if (!(await v.rpc.account(policyAddress(FRONTIER)))) assert.ok((await send([createResidentPolicyIx(policyFields())], [setup])).ok);
  const getAccount = async k => { const a = await v.rpc.account(k); return a ? { owner: a.owner, data: a.data } : null; };
  const gate = createResidentChainGate({ programId: FRONTIER, getAccount });
  const A = await funded(), B = await funded(), stranger = await funded();
  const asset = keypair();
  const m = await send([mintResidentIx({ program: v.programId, payer: A.publicKey, treasury: world.treasury, asset: asset.publicKey, collection: world.collection, price: world.priceLamports })], [A, asset]);
  assert.ok(m.ok, JSON.stringify(m.err));
  const proof = generation => ({ generation, asset: asset.publicKey, resident: pdas(v.programId).resident(asset.publicKey) });
  assert.equal(guardRefusal((await getAccount(asset.publicKey)).data, guardAuthorityAddress(v.programId)), null, 'the minted asset carries the transfer guard');
  assert.deepEqual(await gate.checkJoin({ owner: A.publicKey, resident: proof(0) }), { ok: true });
  assert.deepEqual(await gate.checkJoin({ owner: stranger.publicKey, resident: proof(0) }), { ok: false, code: C.NOT_HOLDER });
  const t = await send([transferResidentIx({ program: v.programId, owner: A.publicKey, asset: asset.publicKey, collection: world.collection, to: B.publicKey })], [A]);
  assert.ok(t.ok, JSON.stringify(t.err));
  assert.deepEqual(await gate.checkJoin({ owner: A.publicKey, resident: proof(0) }), { ok: false, code: C.STALE });
  assert.deepEqual(await gate.checkJoin({ owner: A.publicKey, resident: proof(1) }), { ok: false, code: C.NOT_HOLDER });
  assert.deepEqual(await gate.checkJoin({ owner: B.publicKey, resident: proof(0) }), { ok: false, code: C.STALE });
  assert.deepEqual(await gate.checkJoin({ owner: B.publicKey, resident: proof(1) }), { ok: true });
  // The mint page attached read-only to this chain reads the same sale from the config, and B's pass.
  const page = await attachMintStack({ rpcUrl: v.url, programId: v.programId });
  assert.equal(page.world.collection, world.collection);
  assert.equal(page.world.priceLamports, world.priceLamports);
});
