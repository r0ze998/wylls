// The walletless demo's NPC camps (demo-npc-camps; owner r0ze 2026-11-28 16:21): bandit camps on the demo map, beaten by
// the real march and clash, paying loot. Keyless: the sample world is made with the keyless viewer and signs nothing; the
// player's orders go through the world's own instructions (liveworld `order`, `campsTest`), no key is derived or used.
//   - the pure rule (web/frontier/democamps.mjs): placement, troops by distance and comeback, loot, the mask's winner;
//   - the world (screens/liveworld.mjs `camps`): off by default, 18 camps away from every site and the flag-castle centre,
//     the day's check never runs (the kernel agrees: any difference throws), scaled at the player's first resolve, cleared
//     by the kernel's clash with the program's Works AND the demo's loot, the report says it, the camp comes back stronger
//     once its tile is empty, the same inputs make the same camps (what the save's replay relies on);
//   - the page: the tile card's loot chip, the report's spoils, the guide line; EN for each; never "season".
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as W from '../screens/world.mjs';
import { createLive } from '../screens/liveworld.mjs';
import * as DC from '../../permutation-server/web/frontier/democamps.mjs';
import { TILE_OFFSETS, hexDistance, ringProvinces } from '../../permutation-server/web/frontier/fgeo.mjs';
import { renderSpoils } from '../../permutation-server/web/frontier/screens/report.mjs';
import { setLang } from '../../permutation-server/web/lang.mjs';
import EN from '../../permutation-server/web/lang/en-frontier-play.mjs';

const web = f => readFileSync(new URL(`../../permutation-server/web/${f}`, import.meta.url), 'utf8');
const hexD = (a, b) => (Math.abs(a.q - b.q) + Math.abs(a.r - b.r) + Math.abs(a.q + a.r - b.q - b.r)) / 2;
const TURN = 12;
async function demoWorld(extra = {}) {
  let real = 1_000_000;
  const live = createLive({ viewer: await W.viewer({ keyless: true }), keyless: true, stage: 'none', opening: true, territory: true, nations: true, landUpkeep: true, landClaim: true,
    turn: TURN, delay: 3, landMs: 400, wall: () => real, ...extra });
  live.seen();
  const step = ms => { real += ms; live.clock(); };
  step(4_000);
  return { live, step, turn: () => step(TURN * 1000) };
}

test('the rule: troops by distance and comeback (capped), loot per defender, the camp mask\'s winner', () => {
  assert.deepEqual([0, 1, 2, 3, 4].map(d => DC.campTroops(d)), [300, 500, 700, 900, 1100]);
  assert.equal(DC.campTroops(null), 700, 'before a village: the middle distance');
  assert.deepEqual([0, 1, 2, 3].map(k => DC.campTroops(0, k)), [300, 360, 432, 518]);
  assert.equal(DC.campTroops(4, 9), DC.DEMO_CAMPS.capTroops);
  assert.deepEqual(DC.lootOf(500), { food: 150, ore: 50, gold: 25 });
  assert.deepEqual(DC.lootOf(0), { food: 0, ore: 0, gold: 0 });
  assert.deepEqual(DC.lootOf(-3), { food: 0, ore: 0, gold: 0 });
  assert.equal(DC.maskWinner(0), -1);
  assert.equal(DC.maskWinner(0b10100), 2);
  assert.equal(DC.maskWinner(1 << 23), 23);
  assert.deepEqual(DC.LOOT_RES, { food: 0, ore: 3, gold: 5 }, 'rules.mjs RES: Food 0, Ore 3, Gold 5');
  assert.equal(DC.campsOn({ sample: { camps: { v: 1, lootMilli: { food: 1, ore: 1, gold: 1 } } } }).v, 1);
  for (const FS of [null, {}, { sample: {} }, { sample: { camps: { v: 2, lootMilli: {} } } }]) assert.equal(DC.campsOn(FS), null);
});

test('the world without `camps` is what it was: no camps record, the program\'s camps (ring 2 only, the day\'s check on)', async () => {
  const { live } = await demoWorld();
  assert.equal(live.camps, null);
  assert.equal(live.campsTest, null);
  assert.equal(live.herald('/h/season', new URL('http://x/h/season')).body.sample.camps, undefined);
  for (const { p, q } of ringProvinces(1)) assert.equal(live.province(p, q).camp.state, 0, 'ring 1 has no camp');
  const ring2 = ringProvinces(2).map(({ p, q }) => live.province(p, q).camp);
  assert.ok(ring2.every(c => c.state === 1 && c.troops >= 100 && c.troops <= 400 && c.nextCheckDay < 1000), 'camp.rs: 100–400, checked daily');
});

test('placement: one camp in every ring-1 and ring-2 province, ≥ 3 tiles from every site, ring 1 ≥ 3 from the centre; the day\'s check never comes', async () => {
  const { live } = await demoWorld({ camps: true });
  const r = live.camps();
  assert.equal(r.v, 1);
  assert.equal(r.camps.length, 18);
  assert.equal(live.province(0, 0).camp.state, 0, 'no camp in the middle');
  for (const c of r.camps) {
    const pv = live.province(c.p, c.q);
    assert.equal(pv.camp.state, 1);
    assert.equal(pv.camp.tile, c.tile);
    assert.equal(pv.camp.nextCheckDay, DC.NEVER);
    assert.equal(c.troops, 700, 'before the village: the middle distance');
    const sites = pv.sites.slice(0, pv.siteCount);
    assert.ok(!sites.includes(c.tile) && ((BigInt(pv.passableMask) >> BigInt(c.tile)) & 1n) === 1n);
    assert.ok(Math.min(...sites.map(s => hexD(TILE_OFFSETS[c.tile], TILE_OFFSETS[s]))) >= 3, `${c.p},${c.q}: away from the sites`);
    if (pv.ring === 1) assert.ok(hexD(TILE_OFFSETS[c.tile], { q: 0, r: 0 }) >= 3, 'away from the flag castle\'s centre');
    assert.equal(DC.campTile(pv, TILE_OFFSETS), c.tile, 'the rule is deterministic');
  }
  for (const { p, q } of [{ p: 0, q: 0 }]) assert.equal(live.province(p, q).camp.nextCheckDay, DC.NEVER, 'the middle too');
  const s = live.herald('/h/season', new URL('http://x/h/season')).body.sample.camps;
  assert.deepEqual(s, { v: 1, kind: 'bandit-camps', lootMilli: { ...DC.DEMO_CAMPS.lootMilli }, regrowBells: DC.DEMO_CAMPS.regrowBells, regrowBps: DC.DEMO_CAMPS.regrowBps });
  // a full game day of quiet turns: no camp moves (the kernel's own day check would, and the world throws on any difference)
  const w = await demoWorld({ camps: true });
  for (let i = 0; i < 150; i++) w.turn();
  assert.deepEqual(w.live.camps().camps.map(c => [c.tile, c.troops, c.up]), r.camps.map(c => [c.tile, c.troops, c.up]));
});

/** Join, build nothing, train `n` Spearmen, muster them, and march on the nearest camp: → {live, step, turn, camp, host}. */
async function marchOnNearest(n = 500, extra = {}) {
  const w = await demoWorld({ camps: true, ...extra });
  const j = w.live.campsTest.join(1);
  assert.equal(j.ok, true, JSON.stringify(j));
  w.turn(); w.step(TURN * 500);   // (mid-turn: after the province's resolve, as the playtest acts)
  const me = () => w.live.summary().me, [p, q] = me().village;
  assert.equal(w.live.order('Train', { unit: 0, n }, null).ok, true);
  assert.equal(w.live.order('Muster', { unit: 0, troops: n, tile: me().tile }, { p, q }).ok, true);
  w.turn(); w.turn();
  const camps = w.live.camps().camps.filter(c => c.up).sort((a, b) => hexDistance(a.p, a.q, p, q) - hexDistance(b.p, b.q, p, q) || a.p - b.p || a.q - b.q);
  const host = me().hosts.find(h => h.troops === n);
  assert.ok(host, 'the host is formed');
  const r = w.live.campsTest.march(host.id, { p: camps[0].p, q: camps[0].q, tile: camps[0].tile });
  assert.equal(r.ok, true, JSON.stringify(r));
  return { ...w, camp: camps[0], host, arrive: r.arrive, home: { p, q } };
}

test('scaled at the player\'s first resolve: 300 + 200 a province from the village', async () => {
  const w = await demoWorld({ camps: true });
  w.live.campsTest.join(1);
  w.turn();
  const [p, q] = w.live.summary().me.village, r = w.live.camps();
  assert.notEqual(r.posted, null);
  for (const c of r.camps) assert.equal(c.troops, 300 + 200 * hexDistance(c.p, c.q, p, q), `${c.p},${c.q}`);
  assert.deepEqual(r.camps.find(c => c.p === p && c.q === q).loot, { food: 90, ore: 30, gold: 15 }, 'the own province\'s camp');
});

test('a camp beaten by the real march and clash: cleared, the program\'s Works and the demo\'s loot to the winner, the report says it; it comes back stronger once its tile is empty', async () => {
  const w = await marchOnNearest(500);
  const { live } = w;
  assert.equal(w.camp.p === w.home.p && w.camp.q === w.home.q, true, 'the nearest camp is the own province\'s');
  assert.equal(w.camp.troops, 300);
  const before = live.summary().me;
  while (live.turn() <= w.arrive + 2) w.turn();
  const log = live.campsLog().filter(x => x.kind === 'cleared');
  assert.equal(log.length, 1, JSON.stringify(live.campsLog()));
  const c = log[0];
  assert.equal(c.bell, w.arrive);
  assert.equal(c.defenders, 300);
  assert.deepEqual(c.winner && [c.winner.nation, c.winner.viewer, c.winner.troops], [1, true, 500]);
  assert.ok(c.winner.survivors > 300 && c.winner.survivors < 500, `the clash cost troops (${c.winner.survivors})`);
  assert.deepEqual(c.loot, { food: 90, ore: 30, gold: 15 });
  assert.deepEqual(c.full, c.loot, 'nothing lost to a full store');
  const after = live.summary().me;
  assert.ok(after.stores[3] >= before.stores[3] + 30, `ore +30 (${before.stores[3]} → ${after.stores[3]})`);
  assert.ok(after.stores[5] >= before.stores[5] + 15, 'gold +15');
  assert.equal(after.works, before.works + 10, 'the program\'s camp Works (WORKS_CAMP) still go to the winner');
  const rep = live.herald(`/h/clash/${c.p},${c.q}/${c.bell}`, new URL('http://x/')).body;
  assert.deepEqual(rep.demoCamp, c && { ...c, kind: undefined, v: 1 } && rep.demoCamp);
  assert.equal(rep.demoCamp.v, 1);
  assert.equal(rep.demoCamp.winner.viewer, true);
  assert.equal(rep.decoded.engagements > 0, true, 'a real clash (the kernel\'s)');
  assert.equal(live.province(c.p, c.q).camp.state, 0);
  // the winner stands on the camp's tile: the camp does not come back while it does
  const back = c.backAt;
  assert.equal(back, c.bell + DC.DEMO_CAMPS.regrowBells);
  while (live.turn() <= back + 2) w.turn();
  assert.equal(live.province(c.p, c.q).camp.state, 0, 'held: no comeback under a host');
  // the host leaves (Dissolve: its troops back to the reserve; a march would wait for its stamina): the camp comes back
  // on its own tile, 20 % stronger
  const h = live.summary().me.hosts.find(x => x.province[0] === c.p && x.province[1] === c.q && x.tile === c.tile);
  assert.ok(h, 'the winner stands on the camp tile');
  const r = live.order('Dissolve', { host_id: BigInt(h.id) }, { p: c.p, q: c.q });
  assert.equal(r.ok, true, JSON.stringify(r));
  const left = live.turn();
  while (live.turn() <= left + 3) w.turn();
  const now = live.camps().camps.find(x => x.p === c.p && x.q === c.q);
  assert.equal(now.up, true, JSON.stringify(live.campsLog().slice(-3)));
  assert.equal(now.tile, c.tile);
  assert.equal(now.troops, 360);
  assert.equal(now.comebacks, 1);
  assert.ok(live.records().some(x => x.kind === 43 && x.fields.p === c.p && x.fields.q === c.q && x.fields.troops === 360), 'the CAMP record of its return (the chronicle says it)');
});

test('a host too small loses to a camp: no loot, the camp stays (with what is left of it)', async () => {
  const w = await marchOnNearest(100);
  while (w.live.turn() <= w.arrive + 2) w.turn();
  assert.equal(w.live.campsLog().filter(x => x.kind === 'cleared').length, 0);
  const c = w.live.camps().camps.find(x => x.p === w.camp.p && x.q === w.camp.q);
  assert.equal(c.up, true);
  assert.ok(c.troops <= 300 && c.troops > 0);
});

test('deterministic: the same inputs make the same camps twice (what the save\'s replay relies on)', async () => {
  const run = async () => { const w = await marchOnNearest(500); for (let i = 0; i < 40; i++) w.turn(); return JSON.stringify({ c: w.live.camps(), log: w.live.campsLog(), me: w.live.summary().me }); };
  assert.equal(await run(), await run());
});

test('the page: the tile card\'s loot chip, the report\'s spoils, the guide line — EN for each, never "season"', () => {
  setLang('ja');
  const c = { v: 1, winner: { viewer: true }, loot: { food: 90, ore: 30, gold: 15 }, full: { food: 90, ore: 30, gold: 15 }, backAt: 70 };
  const ja = String(renderSpoils(c));
  assert.match(ja, /data-demo-spoils="1"/);
  assert.match(ja, /戦利品：食料 \+90・鉱石 \+30・金 \+15/);
  assert.match(ja, /ターン 70 以降/);
  assert.match(String(renderSpoils({ ...c, loot: { food: 10, ore: 30, gold: 15 } })), /いっぱい/);
  for (const no of [null, { ...c, v: 2 }, { ...c, winner: { viewer: false } }, { ...c, winner: null }]) assert.equal(String(renderSpoils(no)), '');
  setLang('en');
  const en = String(renderSpoils(c));
  assert.match(en, /Loot: \+90 food · \+30 ore · \+15 gold/);
  assert.match(en, /From turn 70/);
  setLang('ja');
  const inspect = web('frontier/hud/inspect.mjs'), onboarding = web('frontier/screens/onboarding.mjs'), report = web('frontier/screens/report.mjs');
  assert.match(inspect, /const campRule = t\?\.camp \? campsOn\(FS\) : null;/);
  assert.match(inspect, /if \(\(here === 3 \|\| campsOn\(FS\)\) && prov\?\.camp\?\.state === 1 && prov\.camp\.tile === s\.idx\) tile\.camp = /, 'in the demo the card says a camp through the fog (as its marker does)');
  assert.match(inspect, /if \(campRule\) \{ const x = lootOf\(t\.camp\.troops, campRule\);/);
  assert.match(onboarding, /if \(campsOn\(FS\)\) text \+= L`/);
  assert.match(report, /\$\{renderSpoils\(rep\.demoCamp\)\}/);
  const keys = ['倒すと戦利品：食料 {0}・鉱石 {1}・金 {2}', '戦利品：食料 +{0}・鉱石 +{1}・金 +{2}', '村の蔵がいっぱいの分は受け取れませんでした。', '村の蔵に入りました。',
    '野営地はターン {0} 以降、そのマスが空いていれば、もっと強くなって戻ってきます。', '地図のテントは蛮族の野営地で、数は守り手です。倒すと食料・鉱石・金が手に入ります（見えているマスを押すと戦利品が出ます）。'];
  for (const k of keys) {
    assert.equal(typeof EN[k], 'string', k);
    assert.doesNotMatch(EN[k], /season/i);
    assert.doesNotMatch(k, /シーズン/);
  }
  assert.doesNotMatch(readFileSync(new URL('../../permutation-server/web/frontier/democamps.mjs', import.meta.url), 'utf8').replace(/\/\/.*$/gm, ''), /season/i);
});

test('the demo turns it on: boot.mjs makes the world with `camps: true`', () => {
  const boot = readFileSync(new URL('../demo/src/boot.mjs', import.meta.url), 'utf8');
  assert.match(boot, /landClaim: true, camps: true, turn: DEMO\.turnSecs/);
});
