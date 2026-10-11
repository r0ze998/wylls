// The fixture world read back by the page's own modules in node, before any
// browser runs: the herald client decodes and checks every file the scenes
// use (season pins, the `me` key checks for each viewer stage, envelopes,
// overviews, the bell-region record, the clash report), and flog decodes
// every event. A world the page would refuse fails here, not as a blank
// screenshot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './server.mjs';
import * as W from './world.mjs';
import { createHerald } from '../../permutation-server/web/frontier/herald.mjs';
import { setPin } from '../../permutation-server/web/frontier/fchainio.mjs';
import { decodePage } from '../../permutation-server/web/frontier/flog.mjs';
import { landState, siteAllowed } from '../../permutation-server/web/frontier/fland.mjs';
import { toHex } from '../../permutation-server/web/sdk/bytes.mjs';
import { regionOf } from '../../permutation-server/web/frontier/fgeo.mjs';
import { createSurveyor, L1, L3 } from '../../permutation-server/web/frontier/map/survey.mjs';
import { surveyInput } from '../../permutation-server/web/frontier/map/viewer.mjs';

test('the fixture herald: every file the scenes read decodes and passes the page\'s checks', async () => {
  const srv = await startServer();
  try {
    const h = createHerald({ base: srv.url });
    const s = await h.season();
    assert.ok(s.ok, `${s.code} ${s.error ?? ""}`);
    const pin = setPin({ programId: s.record.programId, cluster: s.record.cluster, seasonId: s.record.season, seasonAddress: s.record.seasonAddress, rulesetHash: toHex(s.season.rulesetHash) });
    h.pin(s.record.season, pin.addresses);
    for (let d = 0; d <= 2; d++) {
      const o = await h.overview(d);
      assert.ok(o.ok, `overview ${d}: ${o.code}`);
      assert.ok(o.provinces.length >= 1);
    }
    const expect = { none: 'none', joined: 'joined', ticket: 'ticket', provisional: 'provisional', holding: 'final' };
    assert.deepEqual(Object.keys(expect), [...W.STAGES], 'every stage of the fixture is read back here');
    const held = new Map();
    for (let d = 0; d <= 2; d++) for (const r of (await h.overview(d)).provinces) held.set(`${r.p},${r.q}`, r);
    for (const stage of W.STAGES) {
      srv.stage(stage);
      const me = await h.me(srv.viewer.wallet);
      assert.ok(me.ok, `${stage}: ${me.code} ${me.error ?? ''}`);
      const land = landState(me.citizen);
      assert.equal(land.stage, expect[stage], stage);
      if (me.citizen) assert.equal(me.citizen.session.length, 32);
      if (stage === 'ticket') {
        // the wait for the village: three candidate sites, each a free site the viewer's nation may ask for
        assert.equal(land.ticket.bell, W.TICKET_BELL);
        assert.deepEqual(land.ticket.sites, W.TICKET_SITES.map(x => ({ ...x })));
        for (const x of land.ticket.sites) {
          assert.ok(siteAllowed(me.citizen.faction, x), `${x.p},${x.q} site ${x.site} is in the home wedge`);
          assert.equal(held.get(`${x.p},${x.q}`).sites[x.site], 0, `${x.p},${x.q} site ${x.site} is free`);
        }
        assert.equal(me.holdings.length, 0);
      }
      if (stage === 'provisional') {
        // a provisional village: a hamlet on the home tile, no hosts of its own in its province
        assert.equal(me.holdings.length, 1);
        assert.deepEqual([me.holdings[0].state, me.holdings[0].tier, me.holdings[0].tile], [1, 0, W.HOME.tile]);
        const pv = await h.province(W.HOME.p, W.HOME.q, 'latest');
        assert.ok(pv.ok, pv.code);
        assert.equal(pv.province.entries.filter(e => e.state >= 1).length, 0);
        assert.equal(pv.province.siteMirror[W.HOME.site].tier, 0);
      }
    }
    srv.stage('holding');
    const env = await h.province(W.HOME.p, W.HOME.q, 'latest');
    assert.ok(env.ok, env.code);
    assert.equal(env.province.entries.filter(e => e.state >= 1).length, 3);
    assert.equal(env.province.camp.state, 1);
    const other = await h.province(3, -1, 'latest');
    assert.ok(other.ok, other.code);
    const b = await h.bellRegion(W.BELL, regionOf(W.HOME.p, W.HOME.q));
    assert.ok(b.ok && b.anchor, b.code);
    const c = await h.clash(W.HOME.p, W.HOME.q, W.REPORT_BELL);
    assert.ok(c.ok && c.inputs, c.code);
    assert.equal(c.inputs.nPresent, 2);
    const ev = await h.events(0);
    assert.ok(ev.ok);
    const page = decodePage(ev.events);
    assert.equal(page.records.length, ev.events.length, 'every fixture event decodes');
    assert.ok(page.records.some(r => r.record.name === 'CLASH' && r.record.bell === W.REPORT_BELL));
    // Only the paths the page asks for exist; nothing failed so far.
    assert.deepEqual(srv.requests.filter(r => r.code >= 400), []);
  } finally {
    await srv.close();
  }
});

// UX brief §3: what each viewer stage of the fixture has surveyed, read through the page's own modules
// (herald → land state → the survey's input → the survey). The screenshots of the stages show exactly this.
test('the fixture stages and the survey: chart only before a village; small discs on the candidates; a disc on the village; hosts add to it', async () => {
  const srv = await startServer();
  try {
    const h = createHerald({ base: srv.url });
    const s = await h.season();
    const pin = setPin({ programId: s.record.programId, cluster: s.record.cluster, seasonId: s.record.season, seasonAddress: s.record.seasonAddress, rulesetHash: toHex(s.season.rulesetHash) });
    h.pin(s.record.season, pin.addresses);
    // the candidates' tiles: the home province's real sites, and a stand-in for province (1,1) (the page asks the rules module)
    const terrainOf = (p, q) => (p === W.HOME.p && q === W.HOME.q ? { sites: [...W.HOME_SITES] } : { sites: [2, 5, 9, 14, 20, 24, 30, 36, 41, 47, 52, 58] });
    const seen = {};
    for (const stage of W.STAGES) {
      srv.stage(stage);
      const me = await h.me(srv.viewer.wallet);
      const provinces = new Map();
      for (const o of me.holdings ?? []) { const env = await h.province(o.p, o.q, 'latest'); provinces.set(`${o.p},${o.q}`, env); }
      const fs = { mode: 'play', record: { rings: s.record.rings }, wallet: { address: srv.viewer.wallet }, citizen: me.citizen, holdings: me.holdings ?? [], land: landState(me.citizen), provinces, nowBell: W.BELL + 2, chronicle: [], marches: [] };
      const sv = createSurveyor({ storage: { get: () => null, set: () => true } })(surveyInput(fs, { terrainOf, ready: true, scope: { cluster: 'localnet', programId: W.PROGRAM, seasonId: W.SEASON_ID } }));
      seen[stage] = sv.count.sight;
      assert.equal(sv.showAll, false, stage);
      assert.equal(sv.levelOf(-2, 1, 30), L1, `${stage}: the far side of the world is chart`);
      if (stage === 'ticket') for (const x of W.TICKET_SITES) assert.equal(sv.levelOf(x.p, x.q, terrainOf(x.p, x.q).sites[x.site]), L3, 'a candidate site is in sight');
      if (stage === 'provisional' || stage === 'holding') assert.equal(sv.levelOf(W.HOME.p, W.HOME.q, W.HOME.tile), L3);
      if (stage === 'holding') assert.equal(sv.ownHosts.size, 3, 'the viewer\'s three hosts');
    }
    assert.deepEqual([seen.none, seen.joined], [0, 0], 'nothing in sight before there is land');
    // (a candidate site is a disc of two tiles about it since the second review: at most 19 tiles each, less where two overlap or water lies)
    assert.ok(seen.ticket > 21 && seen.ticket <= 57, `three discs of two tiles about each site (${seen.ticket} tiles)`);
    assert.equal(seen.provisional, 61, 'a hamlet sees 4 tiles around it');
    assert.equal(seen.holding, 91, 'a town sees 5 (its hosts stand inside that)');
  } finally {
    await srv.close();
  }
});

// ------------------------------------------------------------------ the live mode (UX design 12.4, 14.5; liveworld.mjs)
// The sample world read back through the page's own modules, as the still world above: the herald client decodes
// and checks every answer, the relay is driven by the page's own submit and track, and what the page would conclude
// is asserted (the battle scene of people/battle.mjs, the page's own verification of a clash, the moments of
// people/moments.mjs). The rules themselves are pinned in liveworld.screen.mjs (run with this file).
import './liveworld.screen.mjs';
// (the labelled prototype of the banner rule, a design that is not in the program: claims.mjs, claimsworld.mjs; off by default)
import './claims.screen.mjs';
import { LIVE, SIMPLER } from './liveworld.mjs';
import * as R from './rules.mjs';
import { kernel } from './kernel.mjs';
import * as io from '../../permutation-server/web/frontier/fchainio.mjs';
import * as fplay from '../../permutation-server/web/frontier/fplay.mjs';
import * as book from '../../permutation-server/web/frontier/marchbook.mjs';
import { keyFromSeed } from '../../permutation-server/web/session.mjs';
import { hostsIn, storesAt, actionBlocks, BUILD_ITEMS, tileNeighbours } from '../../permutation-server/web/frontier/fland.mjs';
import { pack, unpack, sealRoot, ctHash, commit as commitOf, encodePath } from '../../permutation-server/web/frontier/seal.mjs';
import { bellAt, seasonClock } from '../../permutation-server/web/frontier/clock.mjs';
import { tileHex, hexDistance, DIRECTIONS } from '../../permutation-server/web/frontier/fgeo.mjs';
import { battleScene } from '../../permutation-server/web/frontier/people/battle.mjs';
import { verifyClash } from '../../permutation-server/web/frontier/screens/report.mjs';
import { momentSnapshot, detectMoments } from '../../permutation-server/web/frontier/people/moments.mjs';
import { updateLife } from '../../permutation-server/web/frontier/people/life.mjs';
import { RESOURCE_ORDER } from '../../permutation-server/web/frontier/fi18n.mjs';
import { decode as decodeAccount } from '../../permutation-server/web/frontier/fcodec.mjs';
import { fromBase64, toBase64 } from '../../permutation-server/web/sdk/bytes.mjs';

/** A herald client on a live server, pinned as the page pins it; `clock.t` is the wall clock the live world reads (ms). */
async function liveHerald(opts = {}, stage = 'holding') {
  const srv = await startServer();
  srv.stage(stage);
  const clock = { t: 1_700_000_000_000 };
  const world = srv.live(true, { wall: () => clock.t, ...opts });
  const h = createHerald({ base: srv.url });
  const s = await h.season();
  assert.ok(s.ok, `${s.code} ${s.error ?? ''}`);
  const pin = setPin({ programId: s.record.programId, cluster: s.record.cluster, seasonId: s.record.season, seasonAddress: s.record.seasonAddress, rulesetHash: toHex(s.season.rulesetHash) });
  h.pin(s.record.season, pin.addresses);
  return { srv, h, clock, world, season: s, pin };
}
const stores = (holding, now) => Object.fromEntries(storesAt(holding, now, RESOURCE_ORDER).map(x => [x.resource, x.value]));

test('the live fixture is off until asked for: the default server has no moving clock and its relay refuses', async () => {
  const srv = await startServer();
  try {
    srv.stage('holding');
    assert.equal(srv.world(), null);
    assert.equal(srv.advance(), null);
    const a = await (await fetch(`${srv.url}/h/season`)).json();
    await new Promise(r => setTimeout(r, 30));
    const b = await (await fetch(`${srv.url}/h/season`)).json();
    assert.deepEqual(a, b);
    assert.equal(a.latestUnix, W.LATEST_UNIX);
    const r = await (await fetch(`${srv.url}/gw/f/relay`, { method: 'POST', body: '{}' })).json();
    assert.deepEqual(r, { ok: false, code: 'Unavailable', error: 'the screenshot fixture relay sends nothing' });
    // live on and off again: the still world is back, and the storage has no march book
    srv.live(true);
    assert.ok(Object.keys(W.storageFor(srv.viewer, { stage: 'holding', lang: 'ja' })).some(k => k.startsWith('ps-fmarch:')));
    srv.live(false);
    assert.deepEqual(await (await fetch(`${srv.url}/h/season`)).json(), a);
    assert.equal(Object.keys(W.storageFor(srv.viewer, { stage: 'holding', lang: 'ja' })).some(k => k.startsWith('ps-fmarch:')), false);
  } finally {
    srv.live(false);
    await srv.close();
  }
});

test('the sample world through the page\'s herald client: turn 42 as the world starts; then the toll, and the clash at the camp resolved by the kernel, which the page\'s own verification confirms', async () => {
  const { srv, h, clock, world, season } = await liveHerald();
  try {
    const genesis = Number(season.season.genesisTs);
    // ---- the first answer: turn 42, eight wall seconds (240 of the game) before its end; a sample world on a scaled clock
    assert.equal(LIVE.TURN, 42);
    assert.equal(season.record.latestUnix, world.tollAt - LIVE.DELAY * 30);
    assert.equal(bellAt(genesis, season.record.latestUnix), 42);
    assert.deepEqual([season.record.cluster, season.record.sample.world, season.record.sample.turnSecs, season.record.sample.rate], ['localnet', 'sample', 20, 30]);
    assert.deepEqual(season.record.sample.simpler, SIMPLER);
    // ---- turn 42: the town as the rules have it; the march that reached the camp last turn, sealed and revealed on this device
    let me = await h.me(srv.viewer.wallet);
    assert.ok(me.ok, `${me.code} ${me.error ?? ''}`);
    const before = me.holdings[0];
    assert.deepEqual([before.state, before.tier, before.hostSeq, before.reserve[0], before.reserve[6]], [2, 1, 10, 300, 100]);
    assert.deepEqual(before.production.map(Number), [72_000, 45_000, 30_000, 22_000, 0, 22_000, 7_000, 0], 'a town\'s base production and one farm');
    assert.deepEqual(before.stores.map(s => [Number(s.rate), Number(s.cap)]), before.production.map(p => [Number(p), 6_000_000]));
    assert.deepEqual(before.queue.filter(q => Number(q.doneAt) > 0).map(q => [Number(q.doneAt) - world.tollAt, q.kind, q.arg, Number(q.delta)]), [[LIVE.BUILT_AFTER, 1, 1, 10_000]], 'one building in the queue, done 360 game seconds into the next turn (QueueItem: production of wood)');
    assert.equal(Number(before.shieldUntil), genesis + 1_300 + 48 * 3_600, 'the founding shield');
    assert.deepEqual(me.record.hosts.map(x => [x.id, x.province, x.tile, x.state]).sort(), [[String(W.HOSTS.free), [2, 0], W.HOME.tile, 1], [String(W.HOSTS.scout), [2, 0], W.HOME.tile, 1]].sort());
    let env = await h.province(W.HOME.p, W.HOME.q, 'latest');
    assert.ok(env.ok, env.code);
    assert.deepEqual([env.bell, env.province.resolvedNext, env.slots.length, env.province.camp.state, env.province.camp.troops], [42, 41, 0, 1, 250]);
    const pvk = kernel().call('generate_province', { ring_seed: season.record.rings[2].seed, p: W.HOME.p, q: W.HOME.q }).value;
    assert.equal(env.province.passableMask, pvk.passableMask, 'the Province carries the land the rules generate for it');
    assert.deepEqual([...env.province.terrain], pvk.terrain.terrain);
    assert.deepEqual(hostsIn(env.province, before, 42).map(x => [x.id, x.tile, x.state]), [[W.HOSTS.free, W.HOME.tile, 1], [W.HOSTS.scout, W.HOME.tile, 1]], 'the host that marched is in its transit record, not in the roster');
    // the turn's own file of the arrival turn is not there before the turn is resolved; the page then takes the latest (and keeps nothing)
    const early = await h.province(W.HOME.p, W.HOME.q, 41);
    assert.deepEqual([early.ok, early.code], [false, 'BadEnvelope']);
    let ev = await h.events(0);
    const base = decodePage(ev.events);
    assert.equal(base.records.length, ev.events.length, 'every record decodes');
    assert.deepEqual(base.records.map(r => r.record.name), ['RING_OPEN', 'PROVINCE_OPEN', 'JOIN', 'SETTLE', 'HOLDING_FINAL', 'CAMP', 'DEPART', 'BUILD', 'REVEAL', 'DEPART']);
    assert.equal(ev.next, (await h.season()).record.headSeq, 'the season record\'s head is the last record');
    assert.deepEqual((await h.events(ev.next)).events, [], 'the log is paged: nothing after the head');
    assert.ok(base.records.some(r => r.record.name === 'BUILD' && Number(r.record.done_at) === world.tollAt + LIVE.BUILT_AFTER), 'the building\'s order is in the log');
    // another nation's departure: origin and arrival turn, sealed
    const other = base.records.at(-1).record;
    assert.deepEqual([Number(other.origin_p), Number(other.origin_q), other.origin_tile, other.depart_bell, other.seal.length], [2, 0, W.HOME_SITES[7], 41, 165]);
    // the march book of this device: the page's own entry of the transit, whose seal root the Holding carries
    const key = book.bookKey({ cluster: 'localnet', programId: W.PROGRAM, seasonId: W.SEASON_ID }, srv.viewer.wallet);
    const stored = W.storageFor(srv.viewer, { stage: 'holding', lang: 'ja' });
    const entries = book.loadBook({ get: k => stored[k] ?? null }, key);
    assert.equal(entries.length, 1);
    const e = entries[0], tr = before.transit[e.transitSlot];
    assert.deepEqual([e.state, e.host, e.departBell, e.arriveBell, e.holding], ['revealed', String(W.HOSTS.marching), 38, 41, srv.viewer.holding]);
    assert.deepEqual([tr.state, tr.hostId, tr.departBell, tr.arriveBell, tr.troopsAfter, tr.staminaAfter], [2, W.HOSTS.marching, 38, 41, 400_000, 46], 'departed and settled at its origin: 400 with 120 less 74');
    assert.equal(toHex(tr.sealRoot), e.sealRoot_hex, 'the transit carries the entry\'s seal root');
    assert.equal(toHex(sealRoot(commitOf(fromBase64(e.plain_b64), fromBase64(e.salt_b64)), ctHash(fromBase64(e.seal_b64)))), e.sealRoot_hex, 'the root is the page\'s own arithmetic of the entry');
    const plain = unpack(book.materialBytes(e).plain);
    assert.deepEqual([plain.destP, plain.destQ, plain.destTile, plain.arriveBell, plain.hostId], [W.HOME.p, W.HOME.q, W.CAMP_TILE, 41, W.HOSTS.marching]);
    const reconciled = book.reconcile(entries, { transits: before.transit.map((t, slot) => ({ slot, state: t.state, hostId: t.hostId, arriveBell: t.arriveBell, sealRoot: toHex(t.sealRoot) })), complete: true });
    assert.equal(reconciled[0].state, 'revealed', 'the page keeps the entry (no mismatch)');
    // its route walks from the village to the camp
    let hex = tileHex(e.route.p, e.route.q, e.route.tile);
    for (const d of e.route.dirs) hex = { q: hex.q + DIRECTIONS[d][0], r: hex.r + DIRECTIONS[d][1] };
    const camp = tileHex(W.HOME.p, W.HOME.q, W.CAMP_TILE);
    assert.equal(hexDistance(hex.q, hex.r, camp.q, camp.r), 0);
    // the turn before last is anchored, its window still open, no seed yet
    const region = regionOf(W.HOME.p, W.HOME.q);
    let br = await h.bellRegion(41, region);
    assert.ok(br.ok && br.anchor && br.record.caches.length === 0 && br.record.resolved.length === 0);
    assert.equal(Number(br.anchor.a), genesis + 600 * 42 + LIVE.A_OFF);
    assert.equal((await h.bellRegion(42, region)).anchor, null, 'the turn that runs has no anchor');

    // ---- seven wall seconds on: still turn 42
    clock.t += 7_000;
    let s = await h.season();
    assert.equal(s.record.latestUnix, world.tollAt - 30);
    assert.ok(s.record.latestSlot > season.record.latestSlot, 'the slot moves with the clock (the page drops an older sample)');

    // ---- the toll, and three wall seconds into turn 43: the clash of turn 41 at the camp is resolved
    clock.t += 1_000 + 3_000;
    s = await h.season();
    assert.equal(bellAt(genesis, s.record.latestUnix), 43);
    assert.equal(world.turn(), 43);
    env = await h.province(W.HOME.p, W.HOME.q, 'latest');
    assert.deepEqual([env.bell, env.province.resolvedNext, env.province.resolveSummary.bell, env.province.resolveSummary.arrivals, env.province.resolveSummary.engagements, env.province.camp.state], [43, 42, 41, 1, 1, 0]);
    const closed = await h.province(W.HOME.p, W.HOME.q, 41);
    assert.ok(closed.ok, `${closed.code} ${closed.error ?? ''}`);
    assert.deepEqual([closed.bell, closed.slots.map(x => [x.account.hostId, x.account.tile, x.account.bell, x.account.faction, x.account.stance]), closed.inputs.bell, closed.inputs.flags & 2], [41, [[W.HOSTS.marching, W.CAMP_TILE, 41, 0, 1]], 41, 2]);
    const c = await h.clash(W.HOME.p, W.HOME.q, 41);
    assert.ok(c.ok && c.inputs, c.code);
    assert.deepEqual([c.inputs.bell, c.inputs.nPresent, c.inputs.arrivals[0].hostId, c.inputs.arrivals[0].fate, c.inputs.campMask], [41, 1, W.HOSTS.marching, 1, 1]);
    // the page's own verification of the clash, step by step, with the kernel the page loads: every step green
    const verdict = await verifyClash({ p: W.HOME.p, q: W.HOME.q, bell: 41, clash: c, herald: h, kernel: kernel(), clock: seasonClock(season.season), season: season.season });
    assert.deepEqual(Object.fromEntries(Object.entries(verdict.steps).map(([k, v]) => [k, v.ok])), { kernel: true, seed: true, inputs: true, recompute: true, digest: true, fates: true }, JSON.stringify(verdict.steps));
    assert.deepEqual([verdict.result, verdict.builder, verdict.pageBuilder], ['match', 'kernel', 'agrees']);
    // the battle the page stages from the report: the viewer's 400 on the camp's 250, on the camp's tile
    const prov = decodeAccount('Province', fromBase64(c.report.province_before_b64));
    const scene = battleScene({ p: W.HOME.p, q: W.HOME.q, bell: 41, inputs: c.inputs, before: prov, after: closed.province });
    assert.equal(scene.tiles.length, 1);
    assert.equal(scene.tiles[0].idx, W.CAMP_TILE, 'the battle is on the camp\'s tile');
    const survivors = Math.floor(c.inputs.arrivals[0].troopsAfter / 1000);
    assert.deepEqual(scene.tiles[0].attackers.map(x => [x.faction, x.before, x.after, x.fate]), [[0, 400, survivors, 'Stays']]);
    assert.deepEqual(scene.tiles[0].defenders.map(x => [x.kind, x.before, x.after]), [['camp', 250, 0]]);
    assert.ok(survivors > 300 && survivors < 400);
    // the host stands on the camp's tile, in the roster of the province and in /h/me
    me = await h.me(srv.viewer.wallet);
    assert.deepEqual(hostsIn(env.province, me.holdings[0], 43).map(x => [x.id, x.tile, x.state, x.troops]).find(x => x[0] === W.HOSTS.marching), [W.HOSTS.marching, W.CAMP_TILE, 1, survivors]);
    assert.ok(me.record.hosts.some(x => x.id === String(W.HOSTS.marching) && x.tile === W.CAMP_TILE && x.state === 1));
    br = await h.bellRegion(41, region);
    assert.ok(br.ok && br.anchor && br.record.caches.length === 1 && br.record.resolved.length === 1);
    assert.equal((await h.bellRegion(43, region)).anchor, null, 'the turn that began is open');
    ev = await h.events(ev.next);
    const fresh = decodePage(ev.events).records.map(r => r.record);
    assert.deepEqual(fresh.map(r => r.name), ['CAMP', 'CLASH', 'DEPARTURE_SETTLED']);
    assert.deepEqual([fresh[0].tile, fresh[0].troops, fresh[1].bell, fresh[1].logBell, fresh[1].engagements, toHex(fresh[1].outcome_digest)], [W.CAMP_TILE, 0, 41, 43, 1, c.report.outcomeDigest]);
    // nothing was asked for that the fixture does not serve
    assert.deepEqual(srv.requests.filter(r => r.code >= 400), []);
    // ---- advance(): the next turn at once; pause(): the clock stands
    assert.equal(srv.advance(), 44);
    assert.equal(bellAt(genesis, (await h.season()).record.latestUnix), 44);
    assert.equal(srv.pause(true), true);
    const stood = (await h.season()).record.latestUnix;
    clock.t += 30_000;
    assert.equal((await h.season()).record.latestUnix, stood);
    ev = await h.events(ev.next);
    assert.ok(decodePage(ev.events).records.some(r => r.record.name === 'TRANSIT_SETTLED' && r.record.host_id === W.HOSTS.marching && r.record.outcome === 0), 'the march is settled: the host stays');
    assert.equal(Number((await h.me(srv.viewer.wallet)).citizen.works), 10, 'the camp\'s Works');
  } finally {
    srv.live(false);
    await srv.close();
  }
});

test('the sample world, other stages: without a village the clock and the neighbours run and the relay stays the still fixture\'s; a village just landed is a hamlet with the starter kit', async () => {
  const srv = await startServer();
  try {
    for (const stage of ['none', 'joined', 'ticket']) {
      srv.stage(stage);
      const clock = { t: 5_000 };
      const world = srv.live(true, { wall: () => clock.t, delay: 3 });
      const a = await (await fetch(`${srv.url}/h/season`)).json();
      assert.equal(a.latestUnix, world.tollAt - 90);
      clock.t += 4_000;
      assert.equal((await (await fetch(`${srv.url}/h/season`)).json()).latestUnix, world.tollAt + 30);
      const me = await (await fetch(`${srv.url}/h/me/${srv.viewer.wallet}`)).json();
      assert.deepEqual(me, W.meRecord(srv.viewer, stage));
      assert.equal((await (await fetch(`${srv.url}/gw/f/relay`, { method: 'POST', body: '{}' })).json()).code, 'Unavailable');
      assert.equal(Object.keys(W.storageFor(srv.viewer, { stage, lang: 'ja' })).some(k => k.startsWith('ps-fmarch:')), false);
      assert.equal(world.summary().me, null);
      assert.equal(world.summary().neighbours.length, 3);
    }
    // a change of stage starts the world anew, with the stage's own village
    srv.stage('provisional');
    const world = srv.world();
    assert.equal(world.summary().me.state, 1);
    const h = createHerald({ base: srv.url });
    const s = await h.season();
    const pin = setPin({ programId: s.record.programId, cluster: s.record.cluster, seasonId: s.record.season, seasonAddress: s.record.seasonAddress, rulesetHash: toHex(s.season.rulesetHash) });
    h.pin(s.record.season, pin.addresses);
    const me = await h.me(srv.viewer.wallet);
    assert.ok(me.ok, `${me.code} ${me.error ?? ''}`);
    assert.equal(landState(me.citizen).stage, 'provisional');
    const hm = me.holdings[0];
    assert.deepEqual([hm.state, hm.tier, hm.hostSeq, hm.reserve.reduce((a, b) => a + b, 0)], [1, 0, 0, 0]);
    assert.deepEqual(hm.stores.map(x => [Math.floor(Number(x.value) / 1000 / 100) * 100, Number(x.rate) / 1000, Number(x.cap) / 1000]), [[300, 40, 2000], [300, 30, 2000], [200, 20, 2000], [100, 15, 2000], [0, 0, 2000], [100, 15, 2000], [0, 5, 2000], [0, 0, 2000]], 'the starter kit, a hamlet\'s production and stores');
    const env = await h.province(W.HOME.p, W.HOME.q, 'latest');
    assert.deepEqual([env.province.siteMirror[W.HOME.site].tier, env.province.siteMirror[W.HOME.site].garrison, hostsIn(env.province, hm, 42).length], [0, 0, 0]);
    assert.equal(Object.keys(W.storageFor(srv.viewer, { stage: 'provisional', lang: 'ja' })).some(k => k.startsWith('ps-fmarch:')), false);
    const ev = decodePage((await h.events(0)).events).records.map(r => r.record.name);
    assert.deepEqual(ev.slice(0, 5), ['RING_OPEN', 'PROVINCE_OPEN', 'JOIN', 'CAMP', 'SETTLE']);
  } finally {
    srv.live(false);
    await srv.close();
  }
});

test('the live relay: every order a village owner has is answered as the relay answers, lands and shows in the herald; what the program refuses is refused with its name', async () => {
  const { srv, h, clock, world, pin } = await liveHerald();
  const relayWas = io.relay();
  try {
    io.setRelay(`${srv.url}/gw`);
    const session = await keyFromSeed(W.SESSION_SEED);
    assert.equal(session.publicKey, srv.viewer.session);
    const v = extra => ({ addresses: pin.addresses, wallet: srv.viewer.wallet, actor: session.publicKey, faction: 0, holding: { p: W.HOME.p, q: W.HOME.q, site: W.HOME.site }, ...extra });
    const wait = async () => { clock.t += 1_500; };
    const send = async (name, fields = {}, extra = {}) => {
      const r = await fplay.submit({ name, accounts: fplay.accountsFor(name, v(extra)), fields, signer: { session } });
      if (!r.ok) return r;
      // the page's own check passed: the answer's signature is the announced fee payer's signature of this very message
      const first = await io.txStatus(r.signature);
      assert.deepEqual([first.ok, first.state], [true, 'unknown'], 'not landed yet');
      const t = await fplay.track(r.signature, { wait });
      assert.deepEqual([t.ok, t.state], [true, 'landed'], `${name} lands`);
      return r;
    };
    const read = async () => {
      const me = await h.me(srv.viewer.wallet), env = await h.province(W.HOME.p, W.HOME.q, 'latest');
      assert.ok(me.ok && env.ok, `${me.code ?? ''} ${env.code ?? ''}`);
      return { holding: me.holdings[0], citizen: me.citizen, province: env.province, quota: me.record.quota, hosts: hostsIn(env.province, me.holdings[0], world.turn()), slots: env.slots };
    };
    const info = await io.relayInfo();
    assert.ok(info.ok, info.code);
    assert.deepEqual(Object.keys(info).filter(k => !['ok', 'httpStatus', 'code', 'error'].includes(k)).sort(), ['blockhash', 'feePayer', 'lastValidBlockHeight', 'programId', 'quota'], 'GET /f/relay as the relay answers it');
    clock.t += 8_000 + 3_000;   // turn 43, the province caught up
    const start = await read();
    let cursor = (await h.events(0)).next;
    const logged = async () => { const ev = await h.events(cursor); cursor = ev.next; return decodePage(ev.events).records.map(r => r.record); };
    const now = () => world.now();

    // ---- Harvest: the owner touch and its record
    assert.ok((await send('Harvest')).ok);
    let w = await read();
    assert.ok(Number(w.holding.lastOwnerAction) > Number(start.holding.lastOwnerAction));
    assert.deepEqual((await logged()).map(r => [r.name, r.p, r.q, r.site]), [['HARVEST', W.HOME.p, W.HOME.q, W.HOME.site]]);
    assert.equal(w.quota.left, start.quota.left - 1, 'a sponsored action is counted');

    // ---- Build: a quarry (item 2) is paid for and queued behind the woodcutter, for the first copy's 90 minutes
    const quarry = BUILD_ITEMS[2];
    const paidAt = now() + 2;
    const s0 = stores(w.holding, paidAt);
    assert.ok((await send('Build', { item: 2 }, { item: 2 })).ok);
    w = await read();
    const s1 = stores(w.holding, paidAt);
    assert.deepEqual(RESOURCE_ORDER.map(r => s0[r] - s1[r]), quarry.cost, 'the first copy\'s cost left the stores');
    const queued = w.holding.queue.filter(q => Number(q.doneAt) > now());
    assert.deepEqual(queued.map(q => [q.kind, q.arg, Number(q.delta)]), [[1, 1, 10_000], [1, RESOURCE_ORDER.indexOf('Stone'), quarry.perHour * 1000]], 'two buildings under way; the new one is production of stone');
    assert.equal(Number(queued[1].doneAt) - Number(queued[0].doneAt), 5_400);
    const built = (await logged())[0];
    assert.deepEqual([built.name, built.item, Number(built.done_at)], ['BUILD', 2, Number(queued[1].doneAt)]);
    // the walls name the Province too
    assert.ok((await send('Build', { item: 6 }, { item: 6 })).ok);
    assert.deepEqual((await logged()).map(r => [r.name, r.item]), [['BUILD', 6]]);
    assert.equal((await read()).province.siteMirror[W.HOME.site].wallItem0Delta, 100);
    assert.equal((await send('Build', { item: 0 }, { item: 0 })).code, 'QueueFull', 'a town builds three things at a time');

    // ---- Train: 200 Spearmen at once, for food 120, ore 40, gold 20
    const trainedAt = now() + 100, t0 = stores((await read()).holding, trainedAt);
    assert.ok((await send('Train', { unit: 0, n: 200 })).ok);
    w = await read();
    const t1 = stores(w.holding, trainedAt);
    assert.deepEqual([w.holding.reserve[0], t0.Food - t1.Food, t0.Ore - t1.Ore, t0.Gold - t1.Gold], [500, 120, 40, 20]);
    assert.deepEqual((await logged()).map(r => [r.name, r.unit, r.n]), [['TRAIN', 0, 200]]);
    assert.equal((await send('Train', { unit: 7, n: 100 })).code, 'BadData');

    // ---- Muster: 200 Spearmen onto a chosen tile next to the village; the page's moments see a new host
    const tile = tileNeighbours(W.HOME.tile).find(t => (BigInt(w.province.passableMask) >> BigInt(t)) & 1n);
    const m0 = momentSnapshot({ provinces: new Map([['2,0', { province: w.province }]]) });
    assert.ok((await send('Muster', { unit: 0, troops: 200, tile })).ok);
    w = await read();
    assert.deepEqual([w.holding.reserve[0], w.holding.hostSeq], [300, 11]);
    const fresh = w.hosts.find(x => !start.hosts.some(y => y.id === x.id));
    assert.deepEqual([fresh.unit, fresh.troops, fresh.tile, fresh.state, fresh.fromBell], [0, 200, tile, 2, world.turn() + 1]);
    const mustered = (await logged())[0];
    assert.deepEqual([mustered.name, mustered.host_id, mustered.troops, mustered.tile], ['MUSTER', fresh.id, 200, tile]);
    const moments = detectMoments(m0, momentSnapshot({ provinces: new Map([['2,0', { province: w.province }]]) }), 1);
    assert.deepEqual(moments.map(x => [x.kind, x.tile, x.troops]), [['muster', tile, 200_000]], 'a host that was just mustered is a moment, on the tile it was mustered onto');
    assert.equal((await send('Muster', { unit: 0, troops: 500, tile })).code, 'Insufficient', 'more than the reserve holds is refused');

    // ---- Garrison: 100 Spearmen, after the turn's clash
    assert.ok((await send('Garrison', { delta: 100n })).ok);
    w = await read();
    const mirror = w.province.siteMirror[W.HOME.site];
    assert.deepEqual([w.holding.reserve[0], mirror.garrison, mirror.pend0Bell, Number(mirror.pend0Delta)], [200, 300_000, world.turn(), 100_000]);
    assert.equal((await send('Garrison', { delta: -50n })).code, 'BadData');
    await logged();

    // ---- Explore: the Scout's order is pending in the Holding; the tile is marked in the Province
    const scout = w.hosts.find(x => x.unit === 6), target = tileNeighbours(W.HOME.tile)[0];
    assert.ok((await send('Explore', { host_id: scout.id, n: 1, tiles: Uint8Array.of(target, 0) })).ok);
    w = await read();
    assert.deepEqual([w.holding.explore.state, w.holding.explore.bell, w.holding.explore.host, [...w.holding.explore.tiles]], [1, world.turn(), scout.id, [target, 0xff]]);
    assert.equal((BigInt(w.province.exploredMask) >> BigInt(target)) & 1n, 1n);
    assert.deepEqual(actionBlocks('Explore', { holding: w.holding, province: w.province, nowBell: world.turn(), host: w.hosts.find(x => x.unit === 6) }), ['Explored'], 'the page offers no second exploration');
    assert.deepEqual((await logged()).map(r => [r.name, r.host_id, r.n]), [['EXPLORE', scout.id, 1]]);
    // a settle shape before the seed is out (the requester signs the request)
    const region = regionOf(W.HOME.p, W.HOME.q), A = pin.addresses;
    const early = await fplay.submit({ name: 'SettleExplore', accounts: fplay.accountsFor('SettleExplore', v({ settle: { seed: A.of('SeedCache', { bell: world.turn(), region, nonce: 0 }), anchor: A.of('BellAnchor', { bell: world.turn(), region }) } })), signer: null, requester: session, citizen: srv.viewer.citizen });
    assert.equal(early.code, 'SeedNotReady');

    // ---- Depart with its seal: the transit record; the host keeps its place this turn with the march pending; the life of the village knows it marched
    const free = w.hosts.find(x => String(x.id) === String(W.HOSTS.free));
    const dest = tileNeighbours(W.HOME.tile).filter(t => t !== tile && (BigInt(w.province.passableMask) >> BigInt(t)) & 1n && !w.province.sites.includes(t))[0];
    const planned = kernel().call('plan_path', { start: tileHex(W.HOME.p, W.HOME.q, W.HOME.tile), dest: tileHex(W.HOME.p, W.HOME.q, dest), unit: 0, blocked: [], seeds: W.seasonRecord().rings.map(r => ({ ring: r.d, seed: r.seed })) }).value;
    const arrive = world.turn() + 2, path = encodePath(planned.dirs);
    const plainOf = to => pack({ version: 1, hostId: free.id, arriveBell: arrive, destP: W.HOME.p, destQ: W.HOME.q, destTile: to, stance: 2, retreatBps: 0, pathLen: path.pathLen, path: path.path });
    const salt = new Uint8Array(32).fill(4), seal = Uint8Array.from({ length: 165 }, (_, i) => (i === 0 ? 0x83 : 9)), tip = W.MIN_TIP;
    const commit = commitOf(plainOf(dest), salt);
    const depart = (host, slot, extra = {}) => send('Depart', { host_id: host, commit, seal, arrive_bell: arrive, tip, transit_slot: slot, ...extra });
    assert.equal((await depart(free.id, 1)).code, 'TransitState', 'the record of the march that stands at the camp is in use until it is settled');
    assert.equal((await depart(free.id, 0, { arrive_bell: arrive - 1 })).code, 'ArrivalBell');
    assert.ok((await depart(free.id, 0)).ok);
    w = await read();
    const tr = w.holding.transit[0];
    assert.deepEqual([tr.state, tr.hostId, tr.departBell, tr.arriveBell, tr.depMass, tr.marchStamina, tr.flags, toHex(tr.sealRoot)], [1, free.id, world.turn(), arrive, 600_000, 74, 3, toHex(sealRoot(commit, ctHash(seal)))]);
    const gone = w.hosts.find(x => x.id === free.id);
    assert.deepEqual([gone.state, gone.pending, gone.inTransit], [1, R.OP.SPEND, true], 'it stands (and would fight) this turn; the march\'s stamina is charged after the turn\'s clash');
    assert.deepEqual(actionBlocks('Depart', { holding: w.holding, province: w.province, nowBell: world.turn(), now: now(), host: gone }), ['HostBusy', 'HostInTransit'], 'the page offers it no second order');
    const departed = (await logged())[0];
    assert.deepEqual([departed.name, departed.host_id, departed.arrive_bell, departed.dep_mass, toHex(departed.seal_root), departed.seal.length], ['DEPART', free.id, arrive, 600_000, toHex(tr.sealRoot), 165]);
    assert.equal(updateLife(new Map(), [departed]).get(`${W.HOME.p},${W.HOME.q},${W.HOME.site}`).depart, world.turn());
    assert.equal((await depart(scout.id, 2)).ok, true, 'a second march in the same turn: nothing in the rules holds it back');
    await logged();

    // ---- Dissolve: the mustered host cannot be dissolved before it is in the roster; a host of the roster can
    assert.equal((await send('Dissolve', { host_id: fresh.id })).code, 'NotResident');

    // ---- the reveal of the march (the browser posts material, never a transaction): the keeper's answer; the Reveal
    // is judged by the program's rules: from then on the ArrivalSlot stands in the destination's latest file of the
    // arrival turn, with its REVEAL record
    world.pause(true);
    world.advance(); world.advance();
    assert.equal(world.turn(), arrive);
    const material = to => ({ holding: srv.viewer.holding, transit_slot: 0, plain_b64: toBase64(plainOf(to)), salt_b64: toBase64(salt), ct_hash_b64: toBase64(ctHash(seal)) });
    const wrong = await io.reveal(material(W.CAMP_TILE));
    assert.deepEqual([wrong.ok, wrong.httpStatus, wrong.accepted], [true, 202, true], 'the keeper takes the material; the program refuses what was not sealed');
    assert.deepEqual(world.reveals.at(-1).code, 'CommitMismatch');
    assert.deepEqual((await read()).slots, []);
    const rv = await io.reveal(material(dest));
    assert.deepEqual([rv.ok, rv.httpStatus, rv.accepted, typeof rv.track], [true, 202, true, 'string']);
    assert.deepEqual([world.reveals.at(-1).ok, world.reveals.at(-1).by], [true, 'self']);
    w = await read();
    assert.deepEqual(w.slots.map(x => [x.account.hostId, x.account.tile, x.account.stance, x.account.bell, x.account.i]), [[free.id, dest, 2, arrive, 0]]);
    assert.ok((await logged()).some(r => r.name === 'REVEAL' && r.host_id === free.id && r.tile === dest && r.arrive === arrive));
    assert.equal((await io.reveal({ ...material(dest), transit_slot: 3 })).code, 'TransitState', 'a reveal that names no march of the viewer\'s is refused');
    // two turns on the host stands on its tile, and the mustered host has long been in the roster: it can be dissolved
    world.advance(); world.advance();
    w = await read();
    assert.deepEqual(w.hosts.filter(x => x.id === free.id).map(x => [x.tile, x.state]), [[dest, 1]], 'the host stays where it arrived');
    world.pause(false);
    assert.ok((await send('Dissolve', { host_id: fresh.id })).ok);
    assert.deepEqual(decodePage((await h.events(0)).events).bad, 0, 'every record of the log still decodes (the page skips the kinds it does not read)');

    // ---- what the relay itself refuses: a forged order; then the day's allowance runs out
    const stranger = await keyFromSeed(new Uint8Array(32).fill(0x44));
    const forged = await fplay.submit({ name: 'Harvest', accounts: fplay.accountsFor('Harvest', { ...v(), actor: stranger.publicKey }), signer: { session: stranger } });
    assert.equal(forged.code, 'BadSignature');
    const sentOk = world.orders.filter(o => o.ok).length;
    assert.equal((await read()).quota.left, start.quota.left - sentOk, 'every order that was sent is counted, a refused one is not');
    for (let i = (await read()).quota.left; i > 0; i--) assert.ok((await send('Harvest')).ok);
    assert.equal((await send('Harvest')).code, 'QuotaExceeded');
    // the keeper's routes answer as the keeper does
    const nudge = await io.nudge(W.HOME.p, W.HOME.q, 42);
    assert.deepEqual([nudge.ok, nudge.queued], [true, true]);
    assert.deepEqual(srv.requests.filter(r => r.code >= 400), []);
    assert.deepEqual(world.orders.filter(o => !o.ok).map(o => [o.name, o.code]), [['Build', 'QueueFull'], ['Train', 'BadData'], ['Muster', 'Insufficient'], ['Garrison', 'BadData'], ['SettleExplore', 'SeedNotReady'], ['Depart', 'TransitState'], ['Depart', 'ArrivalBell'], ['Dissolve', 'NotResident'], ['Harvest', 'QuotaExceeded']]);
  } finally {
    io.setRelay(relayWas);
    srv.live(false);
    await srv.close();
  }
});
