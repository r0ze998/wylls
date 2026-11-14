// CreateSeason on the Frontier NFT lane (`localnet-nft-sbf`), a REAL transaction on a loopback validator.
// Before the lane's range view (permutation-frontier proc/season.rs) no nft-experimental build could create
// a Season: CreateSeason demands exactly the binary's version (S1 | 0x8000) and the generic validate()
// accepts only 3/4/5. The Announced state (what AnnounceSeason writes: status, authority, params hash,
// t_create_min already passed, bond) is preloaded because AnnounceSeason needs a 24-hour lead on this
// wall-clock chain (src/nft-world-fixture.mjs); CreateSeason itself runs as deployed.
// Keys: random, in memory. Test values only.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { keypair } from '../src/crypto.mjs';
import { localnetAvailable, startValidator, TEST_PROGRAM_ID } from '../src/localnet.mjs';
import { customCode, signedTx } from '../src/resident-ix.mjs';
import { announcedSeasonAccount, createSeasonIx, laneSeasonParams, LOCALNET_NFT_PROGRAM_ID as FRONTIER, NFT_LANE_PROGRAM_VERSION, paramsHashV2, payoutRev3 } from '../src/nft-world-fixture.mjs';

const LANE_SO = process.env.PSF_LOCALNET_NFT_SO ?? fileURLToPath(new URL('../../permutation-frontier/target/deploy-localnet-nft-sbf/permutation_frontier.so', import.meta.url));
const has = (file, marker) => existsSync(file) && readFileSync(file).includes(Buffer.from(marker));
const skip = !localnetAvailable() || !has(LANE_SO, 'PSF_LOCALNET_NFT_SBF_BUILD') ? 'needs the validator and the lane .so' : false;
const ERR = { BadData: 1, Announce: 56 };
const STATUS_CREATED = 1;

const setup = keypair();
const now = Math.floor(Date.now() / 1000);
const payout = payoutRev3();
const variants = {
  lane: { id: 1n, params: laneSeasonParams() },
  s1: { id: 2n, params: laneSeasonParams({ programVersion: 4 }) },
  expedition: { id: 3n, params: laneSeasonParams({ programVersion: 0x4804 }) },
  mismatch: { id: 4n, params: laneSeasonParams(), announced: laneSeasonParams({ programVersion: 4 }) },
};
let v;
before(async () => {
  if (skip) return;
  const accounts = Object.values(variants).map(x => {
    const a = announcedSeasonAccount({ programId: FRONTIER, seasonId: x.id, authority: setup.publicKey, paramsHash: paramsHashV2(x.announced ?? x.params, payout), now });
    x.addresses = a.addresses;
    return a.account;
  });
  v = await startValidator({ programId: TEST_PROGRAM_ID, setup, extraPrograms: [{ id: FRONTIER, so: LANE_SO }], extraAccounts: accounts });
  await v.rpc.confirm(await v.rpc.airdrop(setup.publicKey, 50_000_000_000));
});
after(async () => { if (v) await v.stop(); });

async function create(x) {
  const { blockhash } = await v.rpc.latestBlockhash();
  const tx = signedTx({ feePayer: setup.publicKey, blockhash, instructions: [createSeasonIx({ addresses: x.addresses, authority: setup.publicKey, params: x.params, payout })], signers: [setup] });
  try {
    const st = await v.rpc.confirm(await v.rpc.send(tx.wire));
    return { ok: !!st && !st.err, err: st?.err, code: customCode(st?.err) };
  } catch (e) { return { ok: false, err: e.message, code: customCode({ message: e.message, data: e.data ?? null }) }; }
}

test('the lane creates a Season at its own version S1 | 0x8000', { skip }, async () => {
  const r = await create(variants.lane);
  assert.ok(r.ok, JSON.stringify(r.err));
  const s = Buffer.from((await v.rpc.account(variants.lane.addresses.season)).data);
  assert.equal(s[64], STATUS_CREATED, 'CREATED (Running from its genesis on)');
  assert.equal(s.readUInt16LE(138), NFT_LANE_PROGRAM_VERSION, 'the web offers NFTs in this world (& 0x8000)');
  assert.ok(await v.rpc.account(variants.lane.addresses.frontier), 'the Frontier account exists');
  assert.ok(await v.rpc.account(variants.lane.addresses.defencePool), 'the defence pool exists');
});

test('any other version is refused by the lane (BadData): S1 (4) and the expedition lane\'s 0x4804; nothing is created', { skip }, async () => {
  for (const name of ['s1', 'expedition']) {
    const x = variants[name];
    const r = await create(x);
    assert.equal(r.ok, false, name);
    assert.equal(r.code, ERR.BadData, `${name}: ${JSON.stringify(r.err)}`);
    assert.equal(Buffer.from((await v.rpc.account(x.addresses.season)).data)[64], 0, `${name}: still ANNOUNCED`);
    assert.equal(await v.rpc.account(x.addresses.frontier), null);
  }
});

test('parameters other than the announced ones are refused (Announce)', { skip }, async () => {
  const r = await create(variants.mismatch);
  assert.equal(r.code, ERR.Announce, JSON.stringify(r.err));
});

test('the .so under test is the lane build of the current source tree', { skip }, () => {
  const so = readFileSync(LANE_SO);
  assert.ok(so.includes(Buffer.from('PSF_TEST_BEACON_BUILD')));
  assert.ok(!so.includes(Buffer.from('PSF_LOCALNET_EXPEDITION_SBF_BUILD')));
  console.log(`lane .so sha256 ${createHash('sha256').update(so).digest('hex')}`);
});
