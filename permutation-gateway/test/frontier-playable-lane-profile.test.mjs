// The playable lane's identity per cluster (src/frontier/playable-lane-profile.mjs, owner decision B7). Pure: no
// server, no key, no network.
//   node --test ./test/frontier-playable-lane-profile.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LOCALNET_PLAYABLE_LANE, PLAYABLE_LANE_VERSION, devnetPlayableLane, devnetPlayableProfileProblems, devnetHeraldArgs, laneIdentityOk, laneRpcOk,
} from '../src/frontier/playable-lane-profile.mjs';
import { LOCAL_PLAY_PROGRAM, LOCAL_PLAY_CLUSTER, localPlayPort } from '../src/frontier/local-play-relay.mjs';
import { LOCAL_PLAY_PROGRAM as PAGE_PROGRAM, LOCAL_PLAY_PROGRAM_VERSION as PAGE_VERSION, LOCAL_PLAY_CLUSTER as PAGE_CLUSTER } from '../../permutation-server/web/frontier/flocalplay.mjs';
import { DEPART_PREPARE_PROGRAM_VERSION } from '../src/frontier/expedition-depart-prepare.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = f => readFileSync(path.join(REPO, f), 'utf8');
const PROFILE = () => JSON.parse(read('scripts/devnet/devnet-playable-profile.json'));
const PROGRAM = 'BPFLoaderUpgradeab1e11111111111111111111111'; // a valid 32-byte address, test value only
const filled = () => ({ ...PROFILE(), programId: PROGRAM });

test('localnet: exactly the existing local-play pins of the relay, the launcher and the page (no drift)', () => {
  assert.equal(LOCALNET_PLAYABLE_LANE.program, LOCAL_PLAY_PROGRAM);
  assert.equal(LOCALNET_PLAYABLE_LANE.program, PAGE_PROGRAM);
  assert.equal(LOCALNET_PLAYABLE_LANE.program, '5fQPsn8hoaVddFG26cWQ5QFdqxWtUPNaZ9zH2E6LYzFn');
  assert.match(read('permutation-gateway/src/frontier/local-play-launcher.mjs'), new RegExp(`const PROGRAM = '${LOCALNET_PLAYABLE_LANE.program}';`));
  assert.equal(LOCALNET_PLAYABLE_LANE.cluster, LOCAL_PLAY_CLUSTER);
  assert.equal(LOCALNET_PLAYABLE_LANE.cluster, PAGE_CLUSTER);
  assert.equal(LOCALNET_PLAYABLE_LANE.version, PAGE_VERSION);
  assert.equal(String(PLAYABLE_LANE_VERSION), String(DEPART_PREPARE_PROGRAM_VERSION));
  assert.equal(PLAYABLE_LANE_VERSION, 0x4804);
  // the program's own version and the devnet build's marker
  assert.match(read('frontier-abi/src/world_index/expedition_dispatch_ix.rs'), /pub const VERSION_BIT: u16 = 0x0800;/);
  assert.match(read('permutation-frontier/src/markers.rs'), /b"PSF_DEVNET_PLAYABLE_BUILD"/);
  assert.ok(Object.isFrozen(LOCALNET_PLAYABLE_LANE));
});

test('localnet RPC rule equals the relay\'s localPlayPort rule', () => {
  for (const u of ['http://127.0.0.1:41000', 'http://127.0.0.1:41999', 'http://127.0.0.1:41970', 'http://127.0.0.1:40999', 'http://127.0.0.1:42000',
    'http://localhost:41100', 'https://127.0.0.1:41100', 'http://127.0.0.1:041100', 'http://127.0.0.1:41100/', 'https://api.devnet.solana.com', null]) {
    assert.equal(laneRpcOk(LOCALNET_PLAYABLE_LANE, u), localPlayPort(u) !== null, String(u));
  }
});

test('devnet: refused while the program id is r0ze\'s placeholder; the committed (filled) profile is accepted', () => {
  // the committed profile holds the devnet program id since devnet-deploy-1 (2026-11-23); its unfilled form is refused
  const unfilled = { ...PROFILE(), programId: '<SET-BY-R0ZE: program>' };
  const problems = devnetPlayableProfileProblems(unfilled);
  assert.deepEqual(problems.length, 1);
  assert.match(problems[0], /programId is still a placeholder/);
  assert.throws(() => devnetPlayableLane(unfilled), /devnet playable lane refused/);
  assert.deepEqual(devnetPlayableProfileProblems(PROFILE()), []);
  assert.equal(PROFILE().programId, 'GGFRJr9dwzq5g4Dj4w1gN9DdSwhVz1McfUGtekiECMrr');
});

test('devnet: a filled profile gives the lane; wrong profiles are refused', () => {
  const lane = devnetPlayableLane(filled());
  assert.deepEqual({ ...lane }, { cluster: 'devnet', program: PROGRAM, version: 0x4804, rpc: 'https://api.devnet.solana.com' });
  assert.ok(Object.isFrozen(lane));
  const bad = [
    [{ ...filled(), cluster: 'mainnet-beta' }, /devnet only/],
    [{ ...filled(), lane: undefined }, /playable lane profile/],
    [{ ...filled(), programId: LOCALNET_PLAYABLE_LANE.program }, /\[0x45; 32\]/],
    [{ ...filled(), programId: 'not-base58-0OIl' }, /not a 32-byte base58/],
    [{ ...filled(), rpcUrl: 'http://api.devnet.solana.com' }, /https only/],
    [{ ...filled(), rpcUrl: 'https://api.mainnet-beta.solana.com', allowedRpcHosts: ['api.mainnet-beta.solana.com'] }, /refused \(mainnet\)/],
    [{ ...filled(), rpcUrl: 'https://user:pw@api.devnet.solana.com' }, /no credentials/],
    [{ ...filled(), rpcUrl: 'https://devnet.example.com' }, /not in the profile's allowedRpcHosts/],
    [{ ...filled(), program: { ...filled().program, programVersion: '0x0004' } }, /0x4804/],
    [{ ...filled(), program: { ...filled().program, requiredMarkers: [] } }, /PSF_DEVNET_PLAYABLE_BUILD/],
  ];
  for (const [p, re] of bad) assert.match(devnetPlayableProfileProblems(p).join(';'), re);
  assert.throws(() => devnetPlayableLane(filled(), { rpcUrl: 'https://api.testnet.solana.com' }), /refused \(testnet\)/);
});

test('identity: only the exact lane passes (cluster, program, version as number or decimal string)', () => {
  const lane = devnetPlayableLane(filled());
  assert.ok(laneIdentityOk(lane, { cluster: 'devnet', program: PROGRAM, version: 0x4804 }));
  assert.ok(laneIdentityOk(lane, { cluster: 'devnet', program: PROGRAM, version: '18436' }));
  assert.ok(!laneIdentityOk(lane, { cluster: 'localnet', program: PROGRAM, version: 0x4804 }));
  assert.ok(!laneIdentityOk(lane, { cluster: 'devnet', program: LOCALNET_PLAYABLE_LANE.program, version: 0x4804 }));
  assert.ok(!laneIdentityOk(lane, { cluster: 'devnet', program: PROGRAM, version: 4 }));
  assert.ok(!laneIdentityOk(lane, { cluster: 'devnet', program: PROGRAM, version: '0x4804' }));
  assert.ok(laneIdentityOk(LOCALNET_PLAYABLE_LANE, { cluster: 'localnet', program: LOCAL_PLAY_PROGRAM, version: 0x4804 }));
  assert.ok(!laneIdentityOk(LOCALNET_PLAYABLE_LANE, { cluster: 'devnet', program: LOCAL_PLAY_PROGRAM, version: 0x4804 }));
  assert.ok(!laneIdentityOk(lane, null));
  // the devnet lane's RPC is exactly its own
  assert.ok(laneRpcOk(lane, 'https://api.devnet.solana.com'));
  assert.ok(!laneRpcOk(lane, 'http://127.0.0.1:41100'));
});

test('devnet herald argv: RPC source with an explicit cluster, loopback listen/relay, public host; localnet refused', () => {
  const lane = devnetPlayableLane(filled());
  assert.deepEqual(devnetHeraldArgs(lane, { data: '/srv/herald', seasonId: 1, listen: '127.0.0.1:41040', relay: '127.0.0.1:41033', publicHost: 'play.example.org' }), [
    '--data', '/srv/herald', '--program', PROGRAM, '--season', '1', '--rpc', 'https://api.devnet.solana.com', '--listen', '127.0.0.1:41040',
    '--source', 'rpc', '--cluster', 'devnet', '--relay', '127.0.0.1:41033', '--public-host', 'play.example.org']);
  const ok = { data: '/srv/herald', seasonId: 1, listen: '127.0.0.1:41040', relay: '127.0.0.1:41033', publicHost: 'play.example.org' };
  assert.throws(() => devnetHeraldArgs(LOCALNET_PLAYABLE_LANE, ok), /devnet lane only/);
  assert.throws(() => devnetHeraldArgs(lane, { ...ok, listen: '0.0.0.0:41040' }), /127\.0\.0\.1/);
  assert.throws(() => devnetHeraldArgs(lane, { ...ok, data: 'rel/dir' }), /absolute/);
  assert.throws(() => devnetHeraldArgs(lane, { ...ok, publicHost: 'a b' }), /host name/);
  // the herald really takes these flags, and --source rpc needs --cluster
  const main = read('frontier-node/crates/herald/src/main.rs');
  for (const f of ['need("program")', 'need("season")', 'need("rpc")', 'a.get("listen")', 'a.get("relay")', 'get("public-host")']) assert.ok(main.includes(f), f);
  assert.match(main, /--source rpc requires --cluster NAME/);
});
