// Mint → hold → join → act, on one loopback validator with the REAL programs: Metaplex Core (mainnet
// binary), the resident program (latest build) and the Frontier NFT lane (`localnet-nft-sbf`).
// The world's starting state (a Running Season and its Frontier) is preloaded as the Frontier
// program's runtime harness writes it (src/nft-world-fixture.mjs); every step after that is a real
// signed transaction executed by the programs:
//   CreateResidentPolicy → MintResident (A) → JoinResident (A: the first login creates the NFT
//   Citizen) → ResidentAct(SetVigil) (A) → TransferResident (A→B) → the old holder and the old
//   generation are refused, B acts → B cannot log in again in this world (one NFT, one Citizen).
// Refusals: a wallet without the pass, a double login, A after the transfer, generations signed before
// it. The relay gate (permutation-gateway resident-chain-gate.mjs) is asked the same questions on the
// same accounts and must agree with the program.
// A separate payer signs as the fee payer (the relay's role); holders sign as owners. Keys are random,
// in memory, for this process. Test values only; no public chain, wallet or funds.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { keypair } from '../src/crypto.mjs';
import { localnetAvailable, setupWorld, startValidator, TEST_PROGRAM_ID } from '../src/localnet.mjs';
import { customCode, mintResidentIx, pdas, signedTx, transferResidentIx } from '../src/resident-ix.mjs';
import { MPL_CORE_PROGRAM } from '../src/core-asset.mjs';
import { LOCALNET_NFT_PROGRAM_ID as FRONTIER, NFT_LANE_PROGRAM_VERSION, nftWorldAccounts } from '../src/nft-world-fixture.mjs';
import { createResidentPolicyIx, joinResidentIx, linkAddress, policyAddress, residentActIx, residentCitizen } from '../../permutation-gateway/client/src/frontier/resident.mjs';
import { citizenMark, createResidentChainGate, RESIDENT_GATE_CODES as G } from '../../permutation-gateway/src/frontier/resident-chain-gate.mjs';

const LANE_SO = process.env.PSF_LOCALNET_NFT_SO ?? fileURLToPath(new URL('../../permutation-frontier/target/deploy-localnet-nft-sbf/permutation_frontier.so', import.meta.url));
const skip = !localnetAvailable() || !existsSync(LANE_SO) ? 'needs the validator, Core, the resident program and the lane .so' : false;
const SYSTEM = '11111111111111111111111111111111';
const SET_VIGIL = 50;                                   // abi-v2-tags SetVigil
const VIGIL_NEXT_MIN = 148;                             // Citizen layout (v2): SetVigil writes the next vigil…
const VIGIL_FROM_TS = 152;                              // …and when it takes effect
const ERR = { Cooldown: 29, ResidentStaleGeneration: 174, ResidentNotCurrentAuthority: 175 };

let v, world, fx;
const setup = keypair();
before(async () => {
  if (skip) return;
  fx = nftWorldAccounts({ programId: FRONTIER, seasonId: 1n, genesisTs: Math.floor(Date.now() / 1000) - 3600 });
  v = await startValidator({ programId: TEST_PROGRAM_ID, setup, extraPrograms: [{ id: FRONTIER, so: LANE_SO }], extraAccounts: fx.accounts });
  world = await setupWorld({ rpc: v.rpc, programId: v.programId, setup });
});
after(async () => { if (v) await v.stop(); });

async function send(instructions, signers, feePayer = signers[0].publicKey) {
  const { blockhash } = await v.rpc.latestBlockhash();
  const tx = signedTx({ feePayer, blockhash, instructions, signers });
  try {
    const sig = await v.rpc.send(tx.wire);
    const st = await v.rpc.confirm(sig);
    return { ok: !!st && !st.err, err: st?.err ?? null, code: customCode(st?.err), sig };
  } catch (e) { return { ok: false, err: e.message, code: customCode({ message: e.message, data: e.data ?? null }) }; }
}
async function funded(sol = 2) {
  const k = keypair();
  await v.rpc.confirm(await v.rpc.airdrop(k.publicKey, sol * 1_000_000_000));
  return k;
}
const account = async k => { const a = await v.rpc.account(k); return a ? { owner: a.owner, data: a.data } : null; };

test('mint → hold → join → act; transfer; the old holder and old generations refused; the relay gate agrees', { skip }, async () => {
  const addrs = fx.addresses;
  // The world's preloaded state is what the lane expects.
  const season = await account(addrs.season);
  assert.equal(season.owner, FRONTIER);
  assert.equal(Buffer.from(season.data).readUInt16LE(138), NFT_LANE_PROGRAM_VERSION, 'S1 | 0x8000: the web offers NFTs in this world');

  // Policy (Frontier upgrade authority = the setup key of this process).
  const pol = await send([createResidentPolicyIx({ programId: FRONTIER, authority: setup.publicKey, coreProgram: MPL_CORE_PROGRAM, residentProgram: v.programId, collection: world.collection })], [setup]);
  assert.ok(pol.ok, JSON.stringify(pol.err));

  // 1. Mint (A pays; the page's transaction shape).
  const A = await funded(), B = await funded(), stranger = await funded(), payer = await funded(5);
  const asset = keypair();
  const minted = await send([mintResidentIx({ program: v.programId, payer: A.publicKey, treasury: world.treasury, asset: asset.publicKey, collection: world.collection, price: world.priceLamports })], [A, asset]);
  assert.ok(minted.ok, JSON.stringify(minted.err));

  // 2. Hold: the asset is A's, in the collection; the resident record is at generation 0.
  const gate = createResidentChainGate({ programId: FRONTIER, getAccount: account });
  const proofAt = generation => ({ generation, policy: policyAddress(FRONTIER), link: linkAddress(FRONTIER, addrs.season, asset.publicKey), asset: asset.publicKey, resident: pdas(v.programId).resident(asset.publicKey) });
  const citizen = residentCitizen(addrs, asset.publicKey);
  const join = (owner, generation) => joinResidentIx({ programId: FRONTIER, owner: owner.publicKey, payer: payer.publicKey, season: addrs.season, frontier: addrs.frontier, citizen, ...proofAt(generation), generation, faction: 2 });
  const vigil = (actor, generation, startMin) => residentActIx({ programId: FRONTIER, keys: [
    { pubkey: actor.publicKey, isSigner: true, isWritable: false }, { pubkey: payer.publicKey, isSigner: true, isWritable: true },
    { pubkey: addrs.season, isSigner: false, isWritable: false }, { pubkey: citizen, isSigner: false, isWritable: true },
  ], data: Uint8Array.from([SET_VIGIL, startMin & 0xff, startMin >> 8]) }, proofAt(generation));
  const vigilOf = async () => Buffer.from((await account(citizen)).data).readUInt16LE(VIGIL_NEXT_MIN);

  // 3. A wallet without the pass cannot log in with A's NFT (program and gate).
  assert.deepEqual(await gate.checkJoin({ owner: stranger.publicKey, resident: proofAt(0) }), { ok: false, code: G.NOT_HOLDER });
  const noPass = await send([join(stranger, 0)], [payer, stranger], payer.publicKey);
  assert.equal(noPass.ok, false);
  assert.equal(noPass.code, ERR.ResidentNotCurrentAuthority, JSON.stringify(noPass.err));
  assert.equal(await account(citizen), null, 'no Citizen from a refused login');

  // 4. Join: A's first login creates the NFT Citizen of this world.
  assert.deepEqual(await gate.checkJoin({ owner: A.publicKey, resident: proofAt(0) }), { ok: true });
  const joined = await send([join(A, 0)], [payer, A], payer.publicKey);
  assert.ok(joined.ok, JSON.stringify(joined.err));
  const made = await account(citizen);
  assert.equal(made.owner, FRONTIER);
  assert.deepEqual(citizenMark(made.data), { nft: true, asset: asset.publicKey }, 'the NFT Citizen, WALLET zero, the asset marked');
  assert.equal(made.data[136], 2, 'the faction A chose');
  assert.ok(await account(proofAt(0).link), 'the world link of this NFT');
  const twice = await send([join(A, 0)], [payer, A], payer.publicKey);
  assert.equal(twice.ok, false, 'one NFT, one Citizen per world');

  // 5. Act: ResidentAct(SetVigil) by A at generation 0.
  assert.deepEqual(await gate.check({ citizen, actor: A.publicKey, resident: proofAt(0) }), { ok: true });
  const acted = await send([vigil(A, 0, 600)], [payer, A], payer.publicKey);
  assert.ok(acted.ok, JSON.stringify(acted.err));
  assert.equal(await vigilOf(), 600);
  assert.ok(Buffer.from((await account(citizen)).data).readBigInt64LE(VIGIL_FROM_TS) > 0n, 'scheduled');
  const strangerAct = await send([vigil(stranger, 0, 660)], [payer, stranger], payer.publicKey);
  assert.equal(strangerAct.code, ERR.ResidentNotCurrentAuthority, JSON.stringify(strangerAct.err));
  assert.equal(await vigilOf(), 600, 'nothing changed');

  // 6. Transfer A→B through the resident program (generation 1).
  const moved = await send([transferResidentIx({ program: v.programId, owner: A.publicKey, asset: asset.publicKey, collection: world.collection, to: B.publicKey })], [A]);
  assert.ok(moved.ok, JSON.stringify(moved.err));

  // 7. After the transfer: A at generation 0 is stale, A at 1 is not the holder, B at 0 is stale; B at 1 acts.
  const cases = [
    [A, 0, ERR.ResidentStaleGeneration, G.STALE],
    [A, 1, ERR.ResidentNotCurrentAuthority, G.NOT_HOLDER],
    [B, 0, ERR.ResidentStaleGeneration, G.STALE],
  ];
  for (const [who, gen, code, gateCode] of cases) {
    const r = await send([vigil(who, gen, 720)], [payer, who], payer.publicKey);
    assert.equal(r.code, code, `${who === A ? 'A' : 'B'} at ${gen}: ${JSON.stringify(r.err)}`);
    assert.deepEqual(await gate.check({ citizen, actor: who.publicKey, resident: proofAt(gen) }), { ok: false, code: gateCode }, 'the gate agrees');
  }
  assert.equal(await vigilOf(), 600, 'no refused action changed the Citizen');
  // B at generation 1 passes the holder check and reaches SetVigil's own rule: a vigil changes at most
  // once in 6 days (VIGIL_AFTER_FROM_SECS), and A changed it a moment ago on this real-time chain. So
  // the program answers Cooldown (29), not 174/175: B is the Citizen's authority now.
  assert.deepEqual(await gate.check({ citizen, actor: B.publicKey, resident: proofAt(1) }), { ok: true });
  const bActs = await send([vigil(B, 1, 780)], [payer, B], payer.publicKey);
  assert.equal(bActs.code, ERR.Cooldown, `B reaches the action's own rule: ${JSON.stringify(bActs.err)}`);
  assert.equal(await vigilOf(), 600);

  // 8. B cannot log in again in this world (its Citizen exists; one NFT, one Citizen).
  const again = await send([join(B, 1)], [payer, B], payer.publicKey);
  assert.equal(again.ok, false);
});

test('after a transfer the new holder changes the Citizen the old holder created; the old holder cannot', { skip }, async () => {
  const addrs = fx.addresses;
  if (!(await account(policyAddress(FRONTIER)))) {
    assert.ok((await send([createResidentPolicyIx({ programId: FRONTIER, authority: setup.publicKey, coreProgram: MPL_CORE_PROGRAM, residentProgram: v.programId, collection: world.collection })], [setup])).ok);
  }
  const A = await funded(), B = await funded(), payer = await funded(5);
  const asset = keypair();
  assert.ok((await send([mintResidentIx({ program: v.programId, payer: A.publicKey, treasury: world.treasury, asset: asset.publicKey, collection: world.collection, price: world.priceLamports })], [A, asset])).ok);
  const proofAt = generation => ({ generation, policy: policyAddress(FRONTIER), link: linkAddress(FRONTIER, addrs.season, asset.publicKey), asset: asset.publicKey, resident: pdas(v.programId).resident(asset.publicKey) });
  const citizen = residentCitizen(addrs, asset.publicKey);
  const vigil = (actor, generation, startMin) => residentActIx({ programId: FRONTIER, keys: [
    { pubkey: actor.publicKey, isSigner: true, isWritable: false }, { pubkey: payer.publicKey, isSigner: true, isWritable: true },
    { pubkey: addrs.season, isSigner: false, isWritable: false }, { pubkey: citizen, isSigner: false, isWritable: true },
  ], data: Uint8Array.from([SET_VIGIL, startMin & 0xff, startMin >> 8]) }, proofAt(generation));
  const read = async () => Buffer.from((await account(citizen)).data);
  // A logs in (A's state: the Citizen of this pass in this world), then sells.
  assert.ok((await send([joinResidentIx({ programId: FRONTIER, owner: A.publicKey, payer: payer.publicKey, season: addrs.season, frontier: addrs.frontier, citizen, ...proofAt(0), generation: 0, faction: 1 })], [payer, A], payer.publicKey)).ok);
  const before = await read();
  assert.equal(before.readBigInt64LE(VIGIL_FROM_TS), 0n, 'no vigil yet');
  assert.ok((await send([transferResidentIx({ program: v.programId, owner: A.publicKey, asset: asset.publicKey, collection: world.collection, to: B.publicKey })], [A])).ok);
  // A, at either generation, changes nothing.
  for (const gen of [0, 1]) {
    const r = await send([vigil(A, gen, 300)], [payer, A], payer.publicKey);
    assert.equal(r.code, gen === 0 ? ERR.ResidentStaleGeneration : ERR.ResidentNotCurrentAuthority, JSON.stringify(r.err));
  }
  assert.equal((await read()).readBigInt64LE(VIGIL_FROM_TS), 0n);
  // B, at the new generation, changes the same Citizen.
  const r = await send([vigil(B, 1, 840)], [payer, B], payer.publicKey);
  assert.ok(r.ok, JSON.stringify(r.err));
  const after = await read();
  assert.equal(after.readUInt16LE(VIGIL_NEXT_MIN), 840);
  assert.ok(after.readBigInt64LE(VIGIL_FROM_TS) > 0n);
  assert.equal(after[136], 1, 'the faction A chose stays with the Citizen');
  assert.deepEqual(citizenMark(after), { nft: true, asset: asset.publicKey });
});
