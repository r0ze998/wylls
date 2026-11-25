// TEST-ONLY wide PLAY in a local `--wide-land` world (owner t379u 「広い版がんばれ」, 2026-11-19): the wide claim (0xD9
// WideClaimSite) and the one-site rim request (FileTicket) as page-signed local acts, the operator AI residents' wide
// rule, the launcher's `--wide-scale` and wide statement, the page's rim-first home planning and its wide-claim card,
// and the centre-free map (⑭ R2) flags. THIS FILE MAKES NO KEY: nothing is signed, sent or served; no chain, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as W from '../../permutation-server/web/frontier/flocalplay-wide.mjs';
import * as A from '../../permutation-server/web/frontier/flocalplay-act.mjs';
import * as LP from '../../permutation-server/web/frontier/flocalplay.mjs';
import * as H from '../../permutation-server/web/frontier/home.mjs';
import * as WORLD from '../../permutation-server/web/frontier/map/world.mjs';
import * as SPR from '../../permutation-server/web/frontier/map/sprites.mjs';
import { seasonAddresses } from '../../permutation-server/web/frontier/faddr.mjs';
import { localActIntent, localActMessage, LOCAL_ACT_COMMANDS, LocalActError } from '../src/frontier/local-play-act.mjs';
import { LOCAL_PLAY_PROGRAM, LOCAL_PLAY_RULESET_HASH } from '../src/frontier/local-play-relay.mjs';
import * as P from '../src/frontier/local-play-operator-policy.mjs';
import * as L from '../src/frontier/local-play-launcher.mjs';

const WALLET = 'BbPGAbHDvV5U43zQ5E8FmSnEzZ7r2vwWAZWTNAPTTSUT';
const HASH = '11111111111111111111111111111111';
const RIM = { p: 68, q: 60, site: 2 };
const TARGET = { p: '69', q: '60' };
const refused = (f, code) => assert.throws(f, e => e.code === code, code);

test('the wide claim intent: a legacy anchor, a wide target within outpost_range, site 0-11, slot 2-3', () => {
  const i = W.wideClaimIntent({ holding: RIM, target: TARGET }, { site: 3, slot: 2 });
  assert.deepEqual(JSON.parse(JSON.stringify(i)), { name: 'WideClaim', subject: { holding: RIM, target: TARGET }, fields: { site: 3, slot: 2 } });
  refused(() => W.wideClaimIntent({ holding: RIM, target: { p: '128', q: '0' } }, { site: 0, slot: 2 }), 'LocalActShape');      // not wide
  refused(() => W.wideClaimIntent({ holding: { p: -3, q: 0, site: 1 }, target: TARGET }, { site: 0, slot: 2 }), 'LocalActShape'); // out of range
  refused(() => W.wideClaimIntent({ holding: { p: 129, q: 0, site: 1 }, target: { p: '130', q: '0' } }, { site: 0, slot: 2 }), 'LocalActWideHolding');
  for (const f of [{ site: 12, slot: 2 }, { site: 0, slot: 1 }, { site: 0, slot: 4 }, { site: 0 }, { site: 0, slot: 2, x: 1 }]) refused(() => W.wideClaimIntent({ holding: RIM, target: TARGET }, f), 'LocalActShape');
  refused(() => W.wideClaimIntent({ holding: RIM, target: { p: 69, q: 60 } }, { site: 0, slot: 2 }), 'LocalActShape');          // numbers, not text
});

test('the wide claim instruction: 0xD9 ‖ p ‖ q ‖ site ‖ slot, twelve accounts, the wallet actor and payer', () => {
  const i = W.wideClaimIntent({ holding: RIM, target: TARGET }, { site: 3, slot: 2 });
  const ix = W.wideClaimInstruction(i, { programId: LOCAL_PLAY_PROGRAM, seasonId: '11', wallet: WALLET });
  assert.equal(ix.data.length, 19);
  assert.equal(ix.data[0], 0xd9);
  const dv = new DataView(ix.data.buffer);
  assert.equal(dv.getBigInt64(1, true), 69n); assert.equal(dv.getBigInt64(9, true), 60n);
  assert.deepEqual([ix.data[17], ix.data[18]], [3, 2]);
  assert.equal(ix.keys.length, 12);
  assert.deepEqual(ix.keys.slice(0, 2).map(k => [k.pubkey, k.isSigner, k.isWritable]), [[WALLET, true, false], [WALLET, true, true]]);
  const S = seasonAddresses(LOCAL_PLAY_PROGRAM, '11');
  assert.equal(ix.keys[2].pubkey, S.season);
  assert.equal(ix.keys[5].pubkey, W.wideProvinceAddress(S.season, LOCAL_PLAY_PROGRAM, '69', '60'));
  assert.equal(ix.keys[7].pubkey, S.of('Holding', RIM)); assert.equal(ix.keys[9].pubkey, ix.keys[7].pubkey);
  assert.equal(ix.keys[11].pubkey, '11111111111111111111111111111111');
  // (the seeds are the frontier-abi ones: tag ‖ 30 hex digits)
  assert.match(W.wideProvinceSeed('129', '0'), /^wp[0-9a-f]{30}$/);
  assert.match(W.wideTicketSeed(WALLET), /^wt[0-9a-f]{30}$/);
});

test('settler cost and claim targets', () => {
  assert.deepEqual(W.settlerCost(2), [1200, 1200, 600, 0, 0, 300, 0, 0]);
  assert.deepEqual(W.settlerCost(3), [2400, 2400, 1200, 0, 0, 600, 0, 0]);
  assert.deepEqual(W.claimTargets({ p: 68, q: 60 }, [{ p: '-62', q: '131' }, { p: '70', q: '60' }, { p: '69', q: '60' }, { p: '64', q: '64' }]), [{ p: '69', q: '60' }, { p: '70', q: '60' }]);
});

test('free sites: a claim names only a FREE or RELEASED site of the herald\'s captured province (live capture, run 5)', async () => {
  const { readFileSync } = await import('node:fs');
  const route = JSON.parse(readFileSync(new URL('./fixtures/wide-route-local-65-129.json', import.meta.url), 'utf8'));
  // (captured from a local wide world: site 0 an operator resident's village, site 8 reserved — state 5)
  assert.deepEqual(W.freeWideSites(route).get('-65,129'), [1, 2, 3, 4, 5, 6, 7, 9, 10, 11]);
  assert.equal(W.freeWideSites({ route: [{ p: '1', q: '1', capture: { bytes_b64: 'AAAA' } }] }).size, 0, 'unreadable bytes: not offered');
  assert.equal(W.freeWideSites(null).size, 0);
  // the AI rule takes the free list when it has one
  const m = P.createResidentMemory(0);
  const v1 = { joined: true, faction: 1, holding: { p: -64, q: 128, site: 1, tile: 5 }, wide: 0 };
  const d = P.decideNext(m, v1, { homes: [], wide: { targets: [{ p: '-65', q: '129', free: [1, 2] }], canClaim: true }, nowSecs: 1 });
  assert.deepEqual([d.name, d.fields.site, d.v.target], ['WideClaim', 1, { p: '-65', q: '129' }]);
  // the page's press asks the herald first
  const ctl = (await import('node:fs')).readFileSync(new URL('../../permutation-server/web/frontier/controller.mjs', import.meta.url), 'utf8');
  assert.ok(ctl.includes("const r = await herald.wideRoute({ places: [target] });"));
});

test('the page and the relay take the wide claim and a ONE-site rim request, and build the same bytes', () => {
  // (+ the TEST-only wide village host acts of #94 wide-depart-local: WideTrain, WideMuster, WideDepart; + world goal ②
  //  research #232: ResearchPledge, ResearchApply)
  assert.deepEqual(A.LOCAL_ACT_NAMES, ['Join', 'PlaceHome', 'Harvest', 'Build', 'Train', 'Muster', 'FileTicket', 'WideClaim', 'TerritoryClaim', 'WideTrain', 'WideMuster', 'WideDepart', 'ResearchPledge', 'ResearchApply']);
  assert.deepEqual(LOCAL_ACT_COMMANDS, A.LOCAL_ACT_NAMES);
  const page = A.localActIntentOf('WideClaim', { holding: RIM, target: TARGET }, { site: 1, slot: 2 }, WALLET);
  const relay = localActIntent(JSON.parse(JSON.stringify(page)), { wallet: WALLET });
  assert.deepEqual(JSON.parse(JSON.stringify(relay)), JSON.parse(JSON.stringify(page)));
  const identity = { address: WALLET, programId: LOCAL_PLAY_PROGRAM, seasonAddress: seasonAddresses(LOCAL_PLAY_PROGRAM, '11').season, cluster: 'localnet' };
  const pins = { program: LOCAL_PLAY_PROGRAM, season: identity.seasonAddress, seasonId: 11, wallet: WALLET, rulesetHash: LOCAL_PLAY_RULESET_HASH };
  for (const [name, v, f] of [['WideClaim', { holding: RIM, target: TARGET }, { site: 1, slot: 2 }], ['FileTicket', { sites: [RIM] }, { sites: [RIM] }]]) {
    const pi = A.localActIntentOf(name, v, f, WALLET);
    const ri = localActIntent(JSON.parse(JSON.stringify(pi)), { wallet: WALLET });
    const a = A.localActMessage(pi, identity, LOCAL_PLAY_RULESET_HASH.toLowerCase?.() ?? LOCAL_PLAY_RULESET_HASH, HASH);
    const b = localActMessage(ri, pins, HASH).message;
    assert.deepEqual(Buffer.from(a), Buffer.from(b), name);
  }
  // (a ticket of two sites, or a site past the legacy disk, is not this path's)
  assert.throws(() => localActIntent({ name: 'FileTicket', subject: { sites: [RIM, { ...RIM, site: 3 }] }, fields: { sites: [RIM, { ...RIM, site: 3 }] } }, { wallet: WALLET }), LocalActError);
  assert.throws(() => localActIntent({ name: 'FileTicket', subject: { sites: [{ p: 130, q: 0, site: 1 }] }, fields: { sites: [{ p: 130, q: 0, site: 1 }] } }, { wallet: WALLET }), e => e.code === 'LocalActWideHolding');
  assert.throws(() => localActIntent({ name: 'WideClaim', subject: { holding: RIM, target: { p: '-3', q: '0' } }, fields: { site: 1, slot: 2 } }, { wallet: WALLET }), e => e.code === 'LocalActInvalid');
});

test('operator residents in a wide world: a rim request first, save, then the wide claim; one action per decision', () => {
  const homes = [{ p: 2, q: 1, nation: 1 }, { p: 67, q: 61, nation: 1 }];
  const m = P.createResidentMemory(0);
  const wide = { targets: [{ p: '68', q: '61' }], canClaim: false };
  const v0 = { joined: true, faction: 1, holding: null, wide: 0 };
  const d1 = P.decideNext(m, v0, { homes, wide, nowSecs: 1 });
  assert.equal(d1.name, 'FileTicket'); assert.deepEqual(d1.fields.sites, [{ p: 67, q: 61, site: 0 }]);
  P.noteOutcome(m, d1, 'landed');
  assert.equal(P.decideNext(m, v0, { homes, wide, nowSecs: 1 }).wait, true, 'waits for the request to settle');
  for (let i = 0; i < 10; i++) P.noteOutcome(m, { wait: true }, 'wait');
  assert.deepEqual(P.decideNext(m, v0, { homes, wide, nowSecs: 1 }).fields.sites, [{ p: 67, q: 61, site: 1 }], 'a filed site is not filed again');
  // (without the wide statement: the heartland first, as before)
  assert.equal(P.decideNext(P.createResidentMemory(0), v0, { homes, nowSecs: 1 }).name, 'PlaceHome');
  const v1 = { joined: true, faction: 1, holding: { p: 67, q: 61, site: 1, tile: 5 }, wide: 0 };
  const save = P.decideNext(m, v1, { homes, wide, nowSecs: 1 });
  assert.equal(save.name, 'Harvest'); assert.match(save.why, /saving/);
  const claim = P.decideNext(m, v1, { homes, wide: { ...wide, canClaim: true }, nowSecs: 1 });
  assert.equal(claim.name, 'WideClaim'); assert.deepEqual(claim.v.target, { p: '68', q: '61' }); assert.deepEqual(claim.fields, { site: 0, slot: 2 });
  P.noteOutcome(m, claim, 'failed');
  const again = P.decideNext(m, v1, { homes, wide: { ...wide, canClaim: true }, nowSecs: 1 });
  assert.equal(again.name, 'Harvest', 'the claim cools down after a refusal');
  for (let i = 0; i < 5; i++) P.noteOutcome(m, { wait: true }, 'wait');
  const next = P.decideNext(m, v1, { homes, wide: { ...wide, canClaim: true }, nowSecs: 1 });
  assert.deepEqual(next.fields, { site: 1, slot: 2 }, 'the refused site is not asked again');
  P.noteOutcome(m, next, 'landed'); P.noteOutcome(m, next, 'landed');
  assert.equal(m.claims, 2);
  assert.notEqual(P.decideNext(m, v1, { homes, wide: { ...wide, canClaim: true }, nowSecs: 1 }).name, 'WideClaim', 'at most two claims, then the rotation');
});

test('the launcher: --wide-scale 1-60 only with --wide-land; the statement agrees with the runner; the targets read', async () => {
  for (const ok of ['1', '9', '10', '59', '60']) assert.equal(L.parseWideScale(ok), Number(ok));
  for (const bad of ['0', '61', '06', '1.5', '', ' 6', undefined]) assert.equal(L.parseWideScale(bad), null, String(bad));
  const abs = ['--root', '/r', '--data', '/d', '--runner', '/x/runner', '--herald', '/x/herald', '--depart', '/x/depart', '--preview', '/x/preview', '--resident', '/x/resident', '--artifact', '/x/a.so', '--artifact-sha', 'ab'.repeat(32)];
  const natural = [...abs, '--world-preset', 'local-natural-v1', '--natural-runner', '/x/natural', '--economy', 'page-signed-v1'];
  await assert.rejects(L.parseConfig([...natural, '--wide-scale', '60']), e => e.code === 'InvalidWideLand');
  await assert.rejects(L.parseConfig([...natural, '--wide-land', L.WIDE_LAND_MODE, '--wide-scale', '61']), e => e.code === 'InvalidWideLand');
  const sum = { legacy_rings_opened: 129, wide_rings: [{ ring: 129, provinces: [{ p: '65', q: '64' }] }, { ring: 130, provinces: [{ p: '-66', q: '130' }, { p: 'x', q: '1' }] }] };
  const meta = s => ({ wide_land: { mode: L.WIDE_LAND_MODE, preset: 'S1_DEVNET_WIDE_7D', test_only: true, summary: sum, ...(s ? { scale: s } : {}) } });
  assert.equal(L.runnerWideAgrees(meta(60), true, 60), true);
  assert.equal(L.runnerWideAgrees(meta(null), true, null), true);
  assert.equal(L.runnerWideAgrees(meta(30), true, 60), false);
  assert.equal(L.runnerWideAgrees(meta(null), true, 60), false);
  assert.deepEqual(L.wideTargetsOf(meta(60)), [{ p: '65', q: '64' }, { p: '-66', q: '130' }]);
  assert.match(L.USAGE, /--wide-scale <1-60>: TEST-ONLY, only with --wide-land/);
  // (the herald's compact output may come with the wide land too: its 129-ring map outgrows the plain output's guard)
  await assert.rejects(L.parseConfig([...natural, '--herald-output', 'compact-v2']), e => e.code === 'HeraldOutputNeedsCaptureDemo');
  await assert.rejects(L.parseConfig([...natural, '--wide-land', L.WIDE_LAND_MODE, '--herald-output', 'compact-v2']), e => e.code !== 'HeraldOutputNeedsCaptureDemo' && e.code !== 'InvalidHeraldOutput');
  assert.match(L.USAGE, /--herald-output compact-v1: TEST-ONLY, only with --capture-demo or --wide-land/);
  // (and its own output guard: 512 MiB for a wide world, the 128 MiB of every other world unchanged)
  assert.equal(L.WIDE_OUTPUT_MAX, 512 * 1024 ** 2); assert.equal(L.WORLD_OUTPUT_MAX, 128 * 1024 ** 2);
  const src = (await import('node:fs')).readFileSync(new URL('../src/frontier/local-play-launcher.mjs', import.meta.url), 'utf8');
  assert.ok(src.includes('outputMax: wide ? WIDE_OUTPUT_MAX : WORLD_OUTPUT_MAX'));
});

test('the page: the wide statement checked; rim-first homes only in a local wide world', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(LP.launcherWideLand({ scale: 60, targets: [{ p: '69', q: '60' }] }))), { scale: 60, targets: [{ p: '69', q: '60' }] });
  for (const bad of [null, {}, { scale: 0, targets: [] }, { scale: 61, targets: [] }, { scale: 60, targets: [{ p: 69, q: 60 }] }, { scale: 60 }]) assert.equal(LP.launcherWideLand(bad), null);
  const season = { conquestParams: { placement: 2, heartlandMaxRing: 3 }, genesisSeed: new Uint8Array(32) };
  assert.equal(H.homePlaceOf({ season }).placement, 1, 'outside a local wide world: as before (placement 2 places as 1)');
  assert.equal(H.homePlaceOf({ season, localPlay: { wideLand: { scale: 60, targets: [] } } }).outward, true);
  assert.equal(H.homeRingsOf({ season }, 129), 4);
  assert.equal(H.homeRingsOf({ season, localPlay: { wideLand: {} } }, 129), 129);
  // (outward: past the heartland only a settled province takes a first village)
  const place = { placement: 2, heartlandMaxRing: 3, genesisSeed: new Uint8Array(32), outward: true };
  const prov = (state) => ({ p: 68, q: 60, siteCount: 3, sites: [1, 2, 3], siteMirror: [{ state, gen: 0 }, { state: 0, gen: 0 }, { state: 0, gen: 0 }], ticketCohorts: [] });
  assert.equal(H.homeSites(prov(0), { place }).length, 0, 'an empty rim province: no first village (R3)');
  assert.ok(H.homeSites(prov(1), { place }).length > 0, 'a settled rim province: its free sites');
});

test('the centre-free map (⑭ R2): no Seat camps once the page knows; an unopened (0,0) is closed', () => {
  assert.equal(SPR.centreLand(), false);
  SPR.setCentreLand(true); assert.equal(SPR.centreLand(), true);
  SPR.setCentreLand(false); assert.equal(SPR.centreLand(), false);
  assert.equal(WORLD.centreIsLand({ conquestParams: { centre: 1 } }), true);
  const w = { ringsOpened: 129, ringsOpen: 129, rMax: 128, ringProvinces: [0, 6, 12, 18] };
  const ringsOf = d => (d === 1 ? new Set(['1,0', '1,-1', '0,-1', '-1,0', '-1,1', '0,1']) : null);
  assert.equal(WORLD.placeOf(w, 0, 0, ringsOf, { centre: false }), WORLD.PLACE.centre);
  assert.equal(WORLD.placeOf(w, 1, 0, ringsOf, { centre: false }), WORLD.PLACE.open);
});
