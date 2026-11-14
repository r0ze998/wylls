// Local play on the LOCAL TEST CANDIDATE lane (conquest lane + NFT residents; id [0x4C; 32], version 0xC804; NOT an
// allocation, never deployable), increment 1: the relay's configuration and the page's herald gate accept exactly the
// two lanes as EXACT pairs, and the conquest lane [0x45; 32] / 0x4804 is answered exactly as before. Pure, no world.
import test from 'node:test';
import assert from 'node:assert/strict';
import { LOCAL_LANE_PROGRAMS, servesLocalProgram, servesLocalLane, isCandidateProgram } from '../src/frontier/local-lane-versions.mjs';
import { localPlayRelayConfigProblems, laneVersion, LOCAL_PLAY_PROGRAM } from '../src/frontier/local-play-relay.mjs';
import { seasonPda } from '../../permutation-server/web/frontier/faddr.mjs';
import { verifyLocalPlayHerald, localPlayIdentityOk } from '../../permutation-server/web/frontier/flocalplay.mjs';
import { seasonAddresses } from '../../permutation-server/web/frontier/faddr.mjs';
import { decode as fromB58 } from '../../permutation-server/web/sdk/base58.mjs';

const CONQ = LOCAL_LANE_PROGRAMS.conquest, CAND = LOCAL_LANE_PROGRAMS.conquestNftCandidate;
const WALLET = 'B7yQBg4KBnypKx7TQRSaZFDD17hfhry5JN51dmz88rX3';

test('the two lanes are exact pairs: conquest [0x45]/0x4804, candidate [0x4C]/0xC804; every mix is refused', () => {
  assert.equal(CONQ, LOCAL_PLAY_PROGRAM);
  assert.ok(servesLocalProgram(CONQ) && servesLocalProgram(CAND) && !servesLocalProgram(WALLET));
  assert.ok(isCandidateProgram(CAND) && !isCandidateProgram(CONQ));
  for (const v of [0x4804, '18436']) { assert.equal(servesLocalLane(CONQ, v), true); assert.equal(servesLocalLane(CAND, v), false, 'the conquest version under the candidate id'); }
  for (const v of [0xc804, '51204']) { assert.equal(servesLocalLane(CAND, v), true); assert.equal(servesLocalLane(CONQ, v), false, 'the candidate version under the conquest id'); }
  for (const v of [4, 0x4004, 0x8004, 0xc805, '051204', '0x4804', 18436.5, null, undefined]) { assert.equal(servesLocalLane(CONQ, v), false); assert.equal(servesLocalLane(CAND, v), false); }
  assert.equal(servesLocalLane(WALLET, 0x4804), false);
  assert.equal(laneVersion(CONQ), '18436');
  assert.equal(laneVersion(CAND), '51204');
});

const cfgOf = (program, over = {}) => ({ localPlay: true, rpc: 'http://127.0.0.1:41010', program, season: seasonPda(program, 11)[0], wallet: WALLET,
  rulesetHash: 'f9d4cd2ab7d4b7b80c91fa8f2abb5bd65d6ba1f3be6a0a13e1c4f9aeb6c4c3b1', prepareBin: '/abs/prepare', cuLimit: 400000, loadedLimit: 262144, ...over });

test('relay configuration: the conquest lane exactly as before; the candidate under its own Season; nothing else', () => {
  const base = cfgOf(CONQ), cand = cfgOf(CAND);
  const progProblems = c => localPlayRelayConfigProblems(c).filter(p => /program|season/.test(p));
  assert.deepEqual(progProblems(base), []);
  assert.deepEqual(progProblems(cand), []);
  assert.ok(progProblems(cfgOf(WALLET)).length > 0, 'another program is refused');
  assert.ok(progProblems({ ...cand, season: seasonPda(CONQ, 11)[0] }).length > 0, 'the candidate with the conquest lane\'s Season is refused');
  assert.ok(progProblems({ ...base, season: seasonPda(CAND, 11)[0] }).length > 0, 'the conquest lane with the candidate\'s Season is refused');
  assert.ok(progProblems({ ...cand, season: seasonPda(CAND, 12)[0] }).length > 0, 'another Season id is refused');
});

function heraldOf(program, version, { wallet = WALLET } = {}) {
  const addrs = seasonAddresses(program, '11');
  return {
    season: async () => ({ ok: true, record: { programId: program, cluster: 'localnet', season: '11', seasonAddress: addrs.season }, season: { programVersion: version, seasonId: 11n } }),
    me: async () => ({ ok: true, citizen: { wallet: fromB58(wallet) }, holdings: [{}] }),
    pin: () => {},
  };
}

test('herald gate: each lane only with its own version; the identity names the record\'s program and Season', async () => {
  const conq = await verifyLocalPlayHerald(heraldOf(CONQ, 0x4804), WALLET);
  assert.equal(conq.ok, true); assert.equal(conq.identity.programId, CONQ); assert.equal(conq.identity.seasonAddress, seasonAddresses(CONQ, '11').season);
  const cand = await verifyLocalPlayHerald(heraldOf(CAND, 0xc804), WALLET);
  assert.equal(cand.ok, true); assert.equal(cand.identity.programId, CAND); assert.equal(cand.identity.seasonAddress, seasonAddresses(CAND, '11').season);
  assert.equal((await verifyLocalPlayHerald(heraldOf(CONQ, 0xc804), WALLET)).code, 'LocalPlayVersion');
  assert.equal((await verifyLocalPlayHerald(heraldOf(CAND, 0x4804), WALLET)).code, 'LocalPlayVersion');
  assert.equal((await verifyLocalPlayHerald(heraldOf(CAND, '51204'), WALLET)).code, 'LocalPlayVersion', 'a Season version is a number');
  assert.equal((await verifyLocalPlayHerald(heraldOf(WALLET, 0x4804), WALLET)).code, 'LocalPlayProgram');
  // the wallet guard stays: a Citizen bound to another wallet is refused on the candidate too
  assert.equal((await verifyLocalPlayHerald(heraldOf(CAND, 0xc804, { wallet: '11111111111111111111111111111112' }), WALLET)).code, 'WalletBindingMismatch');
});

test('after the boot: the identity holds only with its own lane\'s version', () => {
  const id = { address: WALLET, programId: CAND, cluster: 'localnet', seasonId: '11', seasonAddress: seasonAddresses(CAND, '11').season };
  const pin = { programId: CAND, cluster: 'localnet', seasonId: '11', addresses: { season: id.seasonAddress } };
  assert.equal(localPlayIdentityOk(id, pin, { programVersion: 0xc804 }), true);
  assert.equal(localPlayIdentityOk(id, pin, { programVersion: 0x4804 }), false);
  assert.equal(localPlayIdentityOk(id, pin, { programVersion: '51204' }), false);
  const cid = { ...id, programId: CONQ, seasonAddress: seasonAddresses(CONQ, '11').season };
  assert.equal(localPlayIdentityOk(cid, { ...pin, programId: CONQ, addresses: { season: cid.seasonAddress } }, { programVersion: 0x4804 }), true);
  assert.equal(localPlayIdentityOk(cid, { ...pin, programId: CONQ, addresses: { season: cid.seasonAddress } }, { programVersion: 0xc804 }), false);
});
