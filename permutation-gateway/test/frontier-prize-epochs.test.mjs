// ⑰ settlement windows (reopened by the owner 2026-11-18; test USDC, localnet/devnet only): the relay's epoch-pool
// addresses, the pool decoder's epoch fields and the config refusals. The program side is
// permutation-prize/svm-tests/tests/epoch.rs (LiteSVM).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PublicKey } from '@solana/web3.js';
import { u32le, u64le } from '../client/src/bytes.mjs';
import { decodePool, epochPoolAddress, POOL_SIZE, POOL_STATE, PRIZE_ERRORS, PRIZE_TAG, poolAddress, prizeAddresses, vaultAddress } from '../client/src/frontier/prize.mjs';
import { checkFrontierConfig, loadFrontierConfig, MAINNET_USDC_MINT, runIdentity } from '../src/frontier/config.mjs';

const PRIZE = new PublicKey(new Uint8Array(32).fill(1)).toBase58();
const GAME = new PublicKey(new Uint8Array(32).fill(2)).toBase58();
const MINT = new PublicKey(new Uint8Array(32).fill(3)).toBase58();

test('epoch pools: ["epool", game, le64(season), le32(epoch)], distinct from the legacy pool', () => {
  const [want] = PublicKey.findProgramAddressSync([Buffer.from('epool'), new PublicKey(GAME).toBuffer(), Buffer.from(u64le(5n)), Buffer.from(u32le(2))], new PublicKey(PRIZE));
  assert.equal(epochPoolAddress(PRIZE, GAME, 5n, 2), want.toBase58());
  assert.notEqual(epochPoolAddress(PRIZE, GAME, 5n, 0), epochPoolAddress(PRIZE, GAME, 5n, 1));
  assert.notEqual(epochPoolAddress(PRIZE, GAME, 5n, 0), poolAddress(PRIZE, GAME, 5n));
  const legacy = prizeAddresses({ prizeProgram: PRIZE, gameProgram: GAME, seasonId: 5n, mint: MINT });
  assert.equal(legacy.pool, poolAddress(PRIZE, GAME, 5n));
  assert.equal('epoch' in legacy, false);
  const e = prizeAddresses({ prizeProgram: PRIZE, gameProgram: GAME, seasonId: 5n, mint: MINT, epoch: 0 });
  assert.equal(e.pool, epochPoolAddress(PRIZE, GAME, 5n, 0));
  assert.equal(e.vault, vaultAddress(PRIZE, e.pool));
  assert.equal(e.epoch, 0);
});

test('decodePool reads an epoch pool (same 640 B and magic) and marks a legacy one', () => {
  const d = new Uint8Array(POOL_SIZE);
  d.set(Buffer.from('WYPRPOOL'));
  d.set(u64le(25_000_000n), 184);
  d.set(u32le(2_016), 456);
  assert.equal(decodePool(d).kind, 'legacy');
  d.set(u32le(3), 600);
  d.set(u32le(600), 604);
  d.set(u64le(1_700_000_000n), 608);
  d.set(u32le(1_008), 616);
  d[620] = 1;
  d.set(u64le(1_700_604_800n), 624);
  d.set(u64le(4_000_000n), 632);
  d[10] = POOL_STATE.SWEPT;
  const p = decodePool(d);
  assert.deepEqual([p.kind, p.epoch, p.bellSecs, p.genesisTs, p.claimBells, p.deadlineTs, p.rolledOut, p.endBell, p.fee, p.state],
    ['epoch', 3, 600, 1_700_000_000, 1_008, 1_700_604_800, 4_000_000n, 2_016, 25_000_000n, 3]);
});

test('the SDK names the program\'s epoch tags and errors', () => {
  assert.deepEqual([PRIZE_TAG.INIT_EPOCH_POOL, PRIZE_TAG.EPOCH_TALLY, PRIZE_TAG.EPOCH_FINALIZE, PRIZE_TAG.SWEEP, PRIZE_TAG.RECORD_NATION], [8, 9, 10, 11, 7]);
  assert.deepEqual([0x111, 0x113, 0x114, 0x115, 0x116].map(c => PRIZE_ERRORS[c]), ['CeilingPastTally', 'FiniteSeason', 'EpochClosed', 'ClaimWindowOpen', 'WindowOpen']);
});

test('--prize-epoch: test assets only (localnet/devnet, never mainnet, never the mainnet USDC mint)', () => {
  const base = ['--program', GAME, '--season', '5', '--prize-program', PRIZE, '--prize-mint', MINT, '--dev', '--pool-size', '1'];
  const off = loadFrontierConfig(base);
  assert.equal(off.prizeEpoch, null);
  assert.equal('prizeEpoch' in runIdentity(off), false, 'a legacy relay keeps its saved run identity');
  const on = loadFrontierConfig([...base, '--prize-epoch', '0']);
  assert.equal(String(on.prizeEpoch), '0');
  assert.equal(runIdentity(on).prizeEpoch, '0');
  assert.deepEqual(checkFrontierConfig(on).filter(m => m.includes('--prize-epoch')), []);
  assert.equal(String(loadFrontierConfig([...base, '--prize-epoch', '0', '--cluster', 'devnet']).prizeEpoch), '0');
  const refused = (argv, re) => assert.throws(() => loadFrontierConfig(argv), re);
  refused([...base, '--prize-epoch', '0', '--cluster', 'mainnet'], /--prize-epoch: test assets only, localnet or devnet/);
  refused([...base, '--prize-epoch', '0', '--cluster', 'mainnet-beta'], /--prize-epoch: test assets only, localnet or devnet/);
  refused(['--program', GAME, '--season', '5', '--prize-program', PRIZE, '--prize-mint', MAINNET_USDC_MINT, '--dev', '--pool-size', '1', '--prize-epoch', '0'], /mainnet USDC/);
  refused([...base, '--prize-epoch', '-1'], /--prize-epoch must be a u32/);
  refused(['--program', GAME, '--season', '5', '--prize-epoch', '0'], /--prize-epoch needs --prize-program/);
});
