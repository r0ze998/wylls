// TEST-ONLY `--coexist local-coexist-v1` (2026-11-20, rights-play): the ②+⑨+⑩ COEXIST lane in local play. The lane
// module (flocalplay-lane.mjs), the one-shot process lane every pin follows, the launcher's and the relay's words, the
// page's selection. The PLAIN half of every check runs BEFORE this process selects the coexist lane: in a process that
// never selects, every pin is what it was. THIS FILE MAKES NO KEY: no chain, no binary, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as LANE from '../../permutation-server/web/frontier/flocalplay-lane.mjs';
import * as L from '../src/frontier/local-play-launcher.mjs';
import * as RELAY from '../src/frontier/local-play-relay.mjs';
import * as SERVER from '../src/frontier/local-play-relay-server.mjs';
import * as DEPART from '../src/frontier/expedition-depart-prepare.mjs';
import * as WEB_DEPART from '../../permutation-server/web/frontier/fexpedition-depart-prepare.mjs';
import * as LP from '../../permutation-server/web/frontier/flocalplay.mjs';
import { profileForHash, RULESET_HASH_V4_HEX } from '../client/src/frontier/profile.mjs';
import { seasonAddresses } from '../../permutation-server/web/frontier/faddr.mjs';

const V3 = 'e9059c9307189f337b00a4b2166b72a46e1cbbf888068ed1057067546d89de70';
const V4 = 'a1ddb3590f7a15c166a77d10362dd2a499c97111a6021d1eb2baad0ed36c8b62';
const fromHex = h => Uint8Array.from(h.match(/../g), x => parseInt(x, 16));
const PROGRAM = LP.LOCAL_PLAY_PROGRAM, SEASON = seasonAddresses(PROGRAM, '11').season;
const WALLET = 'BbPGAbHDvV5U43zQ5E8FmSnEzZ7r2vwWAZWTNAPTTSUT';
const cfg = hash => ({ localPlay: true, rpc: 'http://127.0.0.1:41704', program: PROGRAM, season: SEASON, wallet: WALLET, rulesetHash: hash, prepareBin: '/x/depart', cuLimit: '1000000', loadedLimit: '67108864' });
const abs = ['--root', '/r', '--data', '/d', '--runner', '/x/runner', '--herald', '/x/herald', '--depart', '/x/depart', '--preview', '/x/preview', '--resident', '/x/resident', '--artifact', '/x/a.so', '--artifact-sha', 'ab'.repeat(32)];
const natural = [...abs, '--world-preset', 'local-natural-v1', '--natural-runner', '/x/natural', '--economy', 'page-signed-v1'];
// (a herald client that answers one Season and no player)
const heraldOf = season => ({ season: async () => ({ ok: true, record: { programId: PROGRAM, cluster: 'localnet', season: '11', seasonAddress: SEASON }, season }), pin() {}, me: async () => ({ ok: true, citizen: null, holdings: [] }) });

test('the two lanes: exactly one version per hash; V4 = the coexist lane, 0x7805 = 30725; the kernel alias is the S1 one', () => {
  assert.equal(LANE.PLAIN_LANE.rulesetHash, V3);
  assert.equal(LANE.COEXIST_LANE.rulesetHash, V4);
  assert.equal(RULESET_HASH_V4_HEX, V4);
  assert.deepEqual([LANE.PLAIN_LANE.programVersion, LANE.COEXIST_LANE.programVersion], [0x4804, 0x7805]);
  for (const l of LANE.LOCAL_LANES) assert.equal(l.programVersionText, String(l.programVersion));
  assert.equal(LANE.laneOfRuleset(V4), LANE.COEXIST_LANE);
  assert.equal(LANE.laneOfRuleset(fromHex(V3)), LANE.PLAIN_LANE);
  assert.equal(LANE.laneOfRuleset('00'.repeat(32)), null);
  assert.equal(LANE.laneOfVersion('30725'), LANE.COEXIST_LANE);
  assert.equal(LANE.laneOfVersion(0x4804), LANE.PLAIN_LANE);
  assert.equal(LANE.laneOfVersion(0x7804), null);
  assert.equal(LANE.lanePair(0x7805, V4), true);
  assert.equal(LANE.lanePair(0x7805, V3), false, 'a version is never taken without its own hash');
  assert.equal(LANE.lanePair(0x4804, V4), false);
  assert.equal(LANE.COEXIST_LANE.kernelRulesetHash, V3);
  // (the SDK reads a V4 Season as S1: the same layouts and instructions)
  assert.equal(profileForHash(V4), 3);
  assert.equal(profileForHash(V3), 3);
});

test('PLAIN (this process before it selects): every pin is the plain lane\'s; V4 is refused everywhere; the launcher word is natural-only, never the wide land', async () => {
  assert.equal(LANE.localLane(), LANE.PLAIN_LANE);
  assert.equal(LANE.kernelRulesetFor(V4), V4, 'no alias before the coexist lane is selected');
  assert.equal(RELAY.LOCAL_PLAY_RULESET_HASH, V3);
  assert.equal(DEPART.DEPART_PREPARE_PROGRAM_VERSION, '18436');
  assert.equal(WEB_DEPART.DEPART_PREPARE_PROGRAM_VERSION, '18436');
  assert.equal(LP.LOCAL_PLAY_PROGRAM_VERSION, 0x4804);
  assert.deepEqual(RELAY.localPlayRelayConfigProblems(cfg(V3)), []);
  assert.ok(RELAY.localPlayRelayConfigProblems(cfg(V4)).some(p => /rulesetHash/.test(p)));
  // (the launcher: the word exact, once, natural only, never with the demo or the wide land; off unless given)
  const fault = async (args, code) => assert.rejects(L.parseConfig(args), e => e.code === code, code);
  for (const v of ['true', 'coexist', 'local-coexist-v2', 'LOCAL-COEXIST-V1']) await fault([...natural, '--coexist', v], 'InvalidCoexist');
  await fault([...natural, '--coexist', L.COEXIST_MODE, '--coexist', L.COEXIST_MODE], 'InvalidArguments');
  await fault([...abs, '--coexist', L.COEXIST_MODE], 'CoexistNeedsNaturalWorld');
  // (the capture demo's TEST clock is a natural world: well formed, it fails only later at the paths)
  await assert.rejects(L.parseConfig([...natural, '--march-trial', L.MARCH_TRIAL_MODE, '--capture-demo', L.CAPTURE_DEMO_MODE, '--demo-scale', '20', '--coexist', L.COEXIST_MODE]), e => !['InvalidCoexist', 'CoexistNeedsNaturalWorld'].includes(e.code));
  await fault([...natural, '--wide-land', L.WIDE_LAND_MODE, '--coexist', L.COEXIST_MODE], 'CoexistNeedsNaturalWorld');
  // (well formed with the kept world's words: it fails only later, at the paths, which do not exist here)
  await assert.rejects(L.parseConfig([...natural, '--continuous', L.CONTINUOUS_MODE, '--persist', L.PERSIST_MODE, '--coexist', L.COEXIST_MODE]), e => !['InvalidCoexist', 'CoexistNeedsNaturalWorld', 'InvalidArguments'].includes(e.code));
  assert.equal(L.COEXIST_MODE, 'local-coexist-v1');
  assert.match(L.USAGE, /--coexist local-coexist-v1: TEST-ONLY, natural preset only \(kept or capture demo; no wide land\)/);
  // (the relay's command line: --coexist is a word of its own, once)
  const args = ['--local-play', '--rpc', 'http://127.0.0.1:41704', '--program', PROGRAM, '--season', SEASON, '--wallet', WALLET, '--ruleset-hash', V3, '--prepare-bin', '/x/depart', '--cu-limit', '1000000', '--loaded-limit', '67108864', '--listen-port', '41705'];
  assert.equal(SERVER.parseArgs(args).coexist, undefined);
  assert.equal(SERVER.parseArgs([...args, '--coexist']).coexist, true);
  assert.throws(() => SERVER.parseArgs([...args, '--coexist', '--coexist']), /--coexist twice/);
  // (the page: the launcher's word alone never selects; a plain Season with the word stays plain and is the plain gate)
  const loc = href => ({ hostname: 'localhost', href });
  const pageCfg = { mode: 'play', dev: true };
  assert.equal(LP.localCoexistLane(pageCfg, loc('http://localhost:41700/frontier/frontier/index.html?localPlay=1&launcher=1&lane=coexist')), true);
  assert.equal(LP.localCoexistLane(pageCfg, loc('http://localhost:41700/frontier/frontier/index.html?localPlay=1&lane=coexist')), false, 'only a launcher page');
  assert.equal(LP.localCoexistLane(pageCfg, loc('http://localhost:41700/frontier/frontier/index.html?localPlay=1&launcher=1&lane=plain')), false);
  const plainSeason = { programVersion: 0x4804, rulesetHash: fromHex(V3), seasonId: '11' };
  const r = await LP.verifyLocalPlayHerald(heraldOf(plainSeason), WALLET, { natural: true, coexist: true });
  assert.equal(r.ok, true);
  assert.equal(LANE.localLane(), LANE.PLAIN_LANE);
  // (a coexist Season WITHOUT the launcher's word: refused as another version, nothing selected)
  const coexistSeason = { programVersion: 0x7805, rulesetHash: fromHex(V4), seasonId: '11' };
  assert.deepEqual(await LP.verifyLocalPlayHerald(heraldOf(coexistSeason), WALLET, { natural: true }), { ok: false, code: 'LocalPlayVersion' });
  // (a mixed pair WITH the word: the version without its hash selects nothing)
  assert.deepEqual(await LP.verifyLocalPlayHerald(heraldOf({ ...coexistSeason, rulesetHash: fromHex(V3) }), WALLET, { natural: true, coexist: true }), { ok: false, code: 'LocalPlayVersion' });
  assert.equal(LANE.localLane(), LANE.PLAIN_LANE);
});

test('COEXIST (after the page\'s own selection): every pin follows; once selected the lane never goes back', async () => {
  const coexistSeason = { programVersion: 0x7805, rulesetHash: fromHex(V4), seasonId: '11' };
  const r = await LP.verifyLocalPlayHerald(heraldOf(coexistSeason), WALLET, { natural: true, coexist: true });
  assert.equal(r.ok, true);
  assert.equal(LANE.localLane(), LANE.COEXIST_LANE);
  assert.equal(RELAY.LOCAL_PLAY_RULESET_HASH, V4);
  assert.equal(DEPART.DEPART_PREPARE_PROGRAM_VERSION, '30725');
  assert.equal(WEB_DEPART.DEPART_PREPARE_PROGRAM_VERSION, '30725');
  assert.equal(LP.LOCAL_PLAY_PROGRAM_VERSION, 0x7805);
  assert.equal(LANE.kernelRulesetFor(V4), V3, 'the one alias: the S1 kernel for the coexist Season');
  assert.equal(LANE.kernelRulesetFor(V3), V3);
  assert.deepEqual(RELAY.localPlayRelayConfigProblems(cfg(V4)), []);
  assert.ok(RELAY.localPlayRelayConfigProblems(cfg(V3)).some(p => /rulesetHash/.test(p)), 'the plain hash is refused by a coexist relay');
  // (a plain Season is now another version: refused)
  assert.deepEqual(await LP.verifyLocalPlayHerald(heraldOf({ programVersion: 0x4804, rulesetHash: fromHex(V3), seasonId: '11' }), WALLET, { natural: true, coexist: true }), { ok: false, code: 'LocalPlayVersion' });
  assert.equal(LANE.selectLocalLane(LANE.COEXIST_LANE), LANE.COEXIST_LANE, 'selecting it again is a no-op');
  assert.throws(() => LANE.selectLocalLane(LANE.PLAIN_LANE), e => e.code === 'LocalLaneFixed');
  assert.throws(() => LANE.selectLocalLane({ ...LANE.COEXIST_LANE }), e => e.code === 'LocalLaneUnknown');
  // (a module that registers late is told the lane at once)
  let seen = null; LANE.onLocalLane(l => { seen = l.name; });
  assert.equal(seen, 'coexist');
});

import { localActIntent, LocalActError } from '../src/frontier/local-play-act.mjs';
test('the S1 workshop (Build item 8, ② rights\' facility) is a local act in the coexist lane only; 0-7 everywhere as before', () => {
  const v = item => ({ name: 'Build', subject: { holding: { p: 0, q: 2, site: 10 } }, fields: { item } });
  for (const item of [0, 7]) { assert.equal(localActIntent(v(item), { wallet: WALLET }).fields.item, item); assert.equal(localActIntent(v(item), { wallet: WALLET, coexist: true }).fields.item, item); }
  assert.throws(() => localActIntent(v(8), { wallet: WALLET }), e => e instanceof LocalActError && e.code === 'LocalActInvalid', 'a plain relay refuses the workshop as before');
  assert.equal(localActIntent(v(8), { wallet: WALLET, coexist: true }).fields.item, 8);
  assert.throws(() => localActIntent(v(9), { wallet: WALLET, coexist: true }), e => e.code === 'LocalActInvalid');
});
