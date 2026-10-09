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

// ------------------------------------------------------------------ the live mode (UX design 12.4; liveworld.mjs)
// Read back through the page's own modules, as the still world above: the herald client decodes and checks every
// answer, the relay is driven by the page's own submit and track, and what the page would conclude is asserted
// (the notifications of hud/feed.mjs, the moments of people/moments.mjs, the battle scene of people/battle.mjs).
import { LIVE } from './liveworld.mjs';
import * as io from '../../permutation-server/web/frontier/fchainio.mjs';
import * as fplay from '../../permutation-server/web/frontier/fplay.mjs';
import * as book from '../../permutation-server/web/frontier/marchbook.mjs';
import { keyFromSeed } from '../../permutation-server/web/session.mjs';
import { hostsIn, storesAt, actionBlocks, BUILD_ITEMS } from '../../permutation-server/web/frontier/fland.mjs';
import { pack, unpack, sealRoot, ctHash, commit as commitOf } from '../../permutation-server/web/frontier/seal.mjs';
import { bellAt } from '../../permutation-server/web/frontier/clock.mjs';
import { tileHex, hexDistance, DIRECTIONS } from '../../permutation-server/web/frontier/fgeo.mjs';
import { battleScene } from '../../permutation-server/web/frontier/people/battle.mjs';
import { momentSnapshot, detectMoments } from '../../permutation-server/web/frontier/people/moments.mjs';
import { updateLife } from '../../permutation-server/web/frontier/people/life.mjs';
import { RESOURCE_ORDER } from '../../permutation-server/web/frontier/fi18n.mjs';
import { decode as decodeAccount } from '../../permutation-server/web/frontier/fcodec.mjs';
import { fromBase64, toBase64 } from '../../permutation-server/web/sdk/bytes.mjs';

/** A herald client on a live server, pinned as the page pins it; `clock.t` is the wall clock the live world reads (ms). */
async function liveHerald(opts = {}) {
  const srv = await startServer();
  srv.stage('holding');
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

test('the live fixture: the clock starts at the first /h/season and the turn ends eight seconds later; the herald then shows the turn after', async () => {
  const { srv, h, clock, world, season } = await liveHerald();
  try {
    const genesis = Number(season.season.genesisTs);
    // the first answer: turn 42, eight seconds before its end
    assert.equal(LIVE.TURN, 42);
    assert.equal(season.record.latestUnix, world.tollAt - LIVE.DELAY);
    assert.equal(bellAt(genesis, season.record.latestUnix), 42);
    // ---- turn 42: the world as the still fixture has it, with the building nearly done and the viewer's march on this device
    let me = await h.me(srv.viewer.wallet);
    assert.ok(me.ok, `${me.code} ${me.error ?? ''}`);
    const before = me.holdings[0];
    assert.deepEqual(before.queue.filter(q => Number(q.doneAt) > 0).map(q => [Number(q.doneAt) - world.tollAt, q.kind, q.arg, Number(q.delta)]), [[LIVE.BUILT_AFTER, 1, 1, 10_000]], 'one building in the queue, done twelve seconds into the next turn (QueueItem: production of wood)');
    let env = await h.province(W.HOME.p, W.HOME.q, 'latest');
    assert.ok(env.ok, env.code);
    assert.deepEqual([env.bell, env.province.resolvedNext, env.province.resolveSummary.bell, env.slots.length], [W.BELL, W.BELL + 1, W.REPORT_BELL, 0]);
    let ev = await h.events(0);
    const base = decodePage(ev.events);
    assert.equal(base.records.length, ev.events.length, 'every record decodes');
    assert.equal(ev.next, String(W.HEAD_SEQ + 2));
    assert.deepEqual((await h.events(ev.next)).events, [], 'the log is paged: nothing after the head');
    assert.ok(base.records.some(r => r.record.name === 'BUILD' && Number(r.record.done_at) === world.tollAt + LIVE.BUILT_AFTER), 'the building\'s order is in the log');
    // the march book of this device: the page's own entry of the transit on the road, whose seal root the Holding carries
    const key = book.bookKey({ cluster: 'localnet', programId: W.PROGRAM, seasonId: W.SEASON_ID }, srv.viewer.wallet);
    const stored = W.storageFor(srv.viewer, { stage: 'holding', lang: 'ja' });
    const entries = book.loadBook({ get: k => stored[k] ?? null }, key);
    assert.equal(entries.length, 1);
    const e = entries[0], tr = before.transit[e.transitSlot];
    assert.deepEqual([e.state, e.host, e.arriveBell, e.holding], ['landed', String(W.HOSTS.marching), 43, srv.viewer.holding]);
    assert.equal(toHex(tr.sealRoot), e.sealRoot_hex, 'the transit carries the entry\'s seal root');
    assert.equal(toHex(sealRoot(commitOf(fromBase64(e.plain_b64), fromBase64(e.salt_b64)), ctHash(fromBase64(e.seal_b64)))), e.sealRoot_hex, 'the root is the page\'s own arithmetic of the entry');
    const plain = unpack(book.materialBytes(e).plain);
    assert.deepEqual([plain.destP, plain.destQ, plain.destTile, plain.arriveBell, plain.hostId], [W.HOME.p, W.HOME.q, W.CAMP_TILE, 43, W.HOSTS.marching]);
    const reconciled = book.reconcile(entries, { transits: before.transit.map((t, slot) => ({ slot, state: t.state, hostId: t.hostId, arriveBell: t.arriveBell, sealRoot: toHex(t.sealRoot) })), complete: true });
    assert.equal(reconciled[0].state, 'landed', 'the page keeps the entry (no mismatch)');
    // its route walks from the village to the camp
    let hex = tileHex(e.route.p, e.route.q, e.route.tile);
    for (const d of e.route.dirs) hex = { q: hex.q + DIRECTIONS[d][0], r: hex.r + DIRECTIONS[d][1] };
    const camp = tileHex(W.HOME.p, W.HOME.q, W.CAMP_TILE);
    assert.equal(hexDistance(hex.q, hex.r, camp.q, camp.r), 0);

    // ---- seven seconds on: still turn 42
    clock.t += 7_000;
    let s = await h.season();
    assert.equal(s.record.latestUnix, world.tollAt - 1);
    assert.ok(s.record.latestSlot > season.record.latestSlot, 'the slot moves with the clock (the page drops an older sample)');
    assert.equal((await h.province(W.HOME.p, W.HOME.q, 'latest')).slots.length, 0);

    // ---- the toll
    clock.t += 1_000;
    s = await h.season();
    assert.equal(bellAt(genesis, s.record.latestUnix), 43);
    assert.equal(world.turn(), 43);
    const now = world.now() + LIVE.BUILT_AFTER + 1;   // a little after the building's done_at
    me = await h.me(srv.viewer.wallet);
    assert.ok(me.ok, `${me.code} ${me.error ?? ''}`);
    const after = me.holdings[0];
    // a building of the viewer has completed (its done_at passed; the record stays until the next owner action, as on chain)
    assert.ok(after.queue.some(q => Number(q.doneAt) > 0 && Number(q.doneAt) <= now));
    // the stores have risen by more than the hour's production gives
    const was = stores(before, now), is = stores(after, now);
    assert.deepEqual([is.Food - was.Food, is.Wood - was.Wood, is.Stone - was.Stone], [LIVE.CREDIT[0], LIVE.CREDIT[1], 0]);
    // the viewer's sealed march is revealed: its ArrivalSlot stands in the envelope of its arrival bell (and in the latest one)
    for (const which of ['latest', 43]) {
      env = await h.province(W.HOME.p, W.HOME.q, which);
      assert.ok(env.ok, `${which}: ${env.code} ${env.error ?? ''}`);
      assert.equal(env.bell, 43);
      assert.deepEqual(env.slots.map(x => [x.account.hostId, x.account.tile, x.account.bell, x.account.faction]), [[W.HOSTS.marching, W.CAMP_TILE, 43, 0]]);
    }
    // the clash of bell 41 at the viewer's village: the Province's summary, the report, the log
    assert.deepEqual([env.province.resolvedNext, env.province.resolveSummary.bell, env.province.resolveSummary.arrivals], [42, LIVE.CLASH_BELL, 1]);
    const c = await h.clash(W.HOME.p, W.HOME.q, LIVE.CLASH_BELL);
    assert.ok(c.ok && c.inputs, c.code);
    assert.deepEqual([c.inputs.bell, c.inputs.nPresent, c.inputs.arrivals.filter(a => a.present).length, c.inputs.arrivals[8].hostId], [LIVE.CLASH_BELL, 1, 1, W.RAIDER]);
    const prov = decodeAccount('Province', fromBase64(c.report.province_before_b64));
    const scene = battleScene({ p: W.HOME.p, q: W.HOME.q, bell: LIVE.CLASH_BELL, inputs: c.inputs, before: prov, after: env.province });
    assert.equal(scene.tiles.length, 1);
    assert.equal(scene.tiles[0].idx, W.HOME.tile, 'the battle is on the viewer\'s village');
    assert.deepEqual(scene.tiles[0].attackers.map(x => [x.faction, x.before, x.after, x.fate]), [[2, 900, 0, 'Destroyed']]);
    assert.deepEqual(scene.tiles[0].defenders.map(x => [x.kind, x.faction, x.before, x.after]).sort(), [['garrison', 0, 340, 300], ['resident', 0, 100, 100], ['resident', 0, 640, 600]], 'the viewer\'s host and garrison held, with losses');
    const region = regionOf(W.HOME.p, W.HOME.q);
    const br = await h.bellRegion(LIVE.CLASH_BELL, region);
    assert.ok(br.ok && br.anchor && br.record.resolved.length === 1);
    assert.equal((await h.bellRegion(43, region)).anchor, null, 'the turn that began is open');
    ev = await h.events(ev.next);
    const fresh = decodePage(ev.events).records.map(r => r.record);
    assert.deepEqual(fresh.map(r => r.name), ['REVEAL', 'CLASH', 'TRANSIT_SETTLED']);
    assert.deepEqual([fresh[0].host_id, fresh[0].tile, fresh[0].arrive, fresh[1].bell, fresh[1].logBell, fresh[2].host_id, fresh[2].outcome], [W.HOSTS.marching, W.CAMP_TILE, 43, LIVE.CLASH_BELL, 43, W.RAIDER, 4]);
    assert.equal((await h.season()).record.headSeq, ev.next, 'the season record\'s head is the last record');
    // nothing was asked for that the fixture does not serve
    assert.deepEqual(srv.requests.filter(r => r.code >= 400), []);
    // ---- advance(): the next turn at once
    assert.equal(srv.advance(), 44);
    assert.equal(bellAt(genesis, (await h.season()).record.latestUnix), 44);
  } finally {
    srv.live(false);
    await srv.close();
  }
});

test('the live fixture, other stages: the clock runs, the world and the relay stay the still fixture\'s', async () => {
  const srv = await startServer();
  try {
    srv.stage('provisional');
    const clock = { t: 5_000 };
    const world = srv.live(true, { wall: () => clock.t, delay: 3 });
    const a = await (await fetch(`${srv.url}/h/season`)).json();
    assert.equal(a.latestUnix, world.tollAt - 3);
    assert.equal(a.headSeq, '812');
    clock.t += 4_000;
    assert.equal((await (await fetch(`${srv.url}/h/season`)).json()).latestUnix, world.tollAt + 1);
    const me = await (await fetch(`${srv.url}/h/me/${srv.viewer.wallet}`)).json();
    assert.deepEqual(me, W.meRecord(srv.viewer, 'provisional'));
    assert.equal((await (await fetch(`${srv.url}/gw/f/relay`, { method: 'POST', body: '{}' })).json()).code, 'Unavailable');
    assert.equal(Object.keys(W.storageFor(srv.viewer, { stage: 'provisional', lang: 'ja' })).some(k => k.startsWith('ps-fmarch:')), false);
  } finally {
    srv.live(false);
    await srv.close();
  }
});

test('the live relay: Harvest, Build, Muster, Explore and Depart are answered as the relay answers, land, and show in the herald; a second Depart in the turn is refused', async () => {
  const { srv, h, clock, world, pin } = await liveHerald({ delay: 300 });
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
      return { holding: me.holdings[0], province: env.province, quota: me.record.quota, hosts: hostsIn(env.province, me.holdings[0], world.turn()) };
    };
    const info = await io.relayInfo();
    assert.ok(info.ok, info.code);
    assert.deepEqual(Object.keys(info).filter(k => !['ok', 'httpStatus', 'code', 'error'].includes(k)).sort(), ['blockhash', 'feePayer', 'lastValidBlockHeight', 'programId', 'quota'], 'GET /f/relay as the relay answers it');
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

    // ---- Build: a quarry (item 2) is paid for and queued
    const quarry = BUILD_ITEMS[2];
    const paidAt = now() + 2;
    const s0 = stores(w.holding, paidAt);
    assert.ok((await send('Build', { item: 2 }, { item: 2 })).ok);
    w = await read();
    const s1 = stores(w.holding, paidAt);
    assert.deepEqual(RESOURCE_ORDER.map(r => s0[r] - s1[r]), quarry.cost, 'the first copy\'s cost left the stores');
    const queued = w.holding.queue.filter(q => Number(q.doneAt) > now());
    assert.deepEqual(queued.map(q => [q.kind, q.arg, Number(q.delta)]), [[1, 1, 10_000], [1, RESOURCE_ORDER.indexOf('Stone'), quarry.perHour * 1000]], 'two buildings under way; the new one is production of stone');
    const built = (await logged())[0];
    assert.deepEqual([built.name, built.item, Number(built.done_at)], ['BUILD', 2, Number(queued[1].doneAt)]);

    // ---- Muster: 200 spearmen leave the reserve and stand muster-pending at the village; the page's moments see a new host
    const m0 = momentSnapshot({ provinces: new Map([['2,0', { province: w.province }]]) });
    assert.ok((await send('Muster', { unit: 0, troops: 200, tile: W.HOME.tile })).ok);
    w = await read();
    assert.deepEqual([w.holding.reserve[0], w.holding.hostSeq], [100, 11]);
    const fresh = w.hosts.find(x => !start.hosts.some(y => y.id === x.id));
    assert.deepEqual([fresh.unit, fresh.troops, fresh.tile, fresh.state, fresh.fromBell], [0, 200, W.HOME.tile, 2, world.turn() + 1]);
    const mustered = (await logged())[0];
    assert.deepEqual([mustered.name, mustered.host_id, mustered.troops], ['MUSTER', fresh.id, 200]);
    const moments = detectMoments(m0, momentSnapshot({ provinces: new Map([['2,0', { province: w.province }]]) }), 1);
    assert.deepEqual(moments.map(x => [x.kind, x.tile, x.troops]), [['muster', W.HOME.tile, 200_000]], 'a host that was just mustered is a moment, though it is muster-pending');
    assert.equal((await send('Muster', { unit: 0, troops: 500, tile: W.HOME.tile })).code, 'Insufficient', 'more than the reserve holds is refused');

    // ---- Explore: the Scout's order is pending in the Holding; the tile is marked in the Province
    const scout = w.hosts.find(x => x.unit === 6), target = 3;
    assert.ok((await send('Explore', { host_id: scout.id, n: 1, tiles: Uint8Array.of(target, 0) })).ok);
    w = await read();
    assert.deepEqual([w.holding.explore.state, w.holding.explore.bell, w.holding.explore.host, [...w.holding.explore.tiles]], [1, world.turn(), scout.id, [target, 0xff]]);
    assert.equal((BigInt(w.province.exploredMask) >> BigInt(target)) & 1n, 1n);
    assert.deepEqual(actionBlocks('Explore', { holding: w.holding, province: w.province, nowBell: world.turn(), host: w.hosts.find(x => x.unit === 6) }), ['Explored'], 'the page offers no second exploration');
    assert.deepEqual((await logged()).map(r => [r.name, r.host_id, r.n]), [['EXPLORE', scout.id, 1]]);

    // ---- Depart with its seal: the transit record and the departed entry; the life of the village knows it marched
    const free = w.hosts.find(x => String(x.id) === String(W.HOSTS.free));
    const commit = new Uint8Array(32).fill(7), seal = new Uint8Array(165).fill(9), tip = 14_472n, arrive = world.turn() + 2;
    const depart = (host, slot) => send('Depart', { host_id: host, commit, seal, arrive_bell: arrive, tip, transit_slot: slot });
    assert.ok((await depart(free.id, 0)).ok);
    w = await read();
    const tr = w.holding.transit[0];
    assert.deepEqual([tr.state, tr.hostId, tr.departBell, tr.arriveBell, tr.depMass, tr.marchStamina, tr.flags, toHex(tr.sealRoot)], [1, free.id, world.turn(), arrive, 600_000, 74, 3, toHex(sealRoot(commit, ctHash(seal)))]);
    assert.deepEqual(w.hosts.find(x => x.id === free.id).state, 3, 'the host has departed');
    assert.equal(w.hosts.find(x => x.id === free.id).inTransit, true);
    const departed = (await logged())[0];
    assert.deepEqual([departed.name, departed.host_id, departed.arrive_bell, departed.dep_mass, toHex(departed.seal_root), departed.seal.length], ['DEPART', free.id, arrive, 600_000, toHex(tr.sealRoot), 165]);
    assert.equal(updateLife(new Map(), [departed]).get(`${W.HOME.p},${W.HOME.q},${W.HOME.site}`).depart, world.turn());

    // ---- the reveal of that march (the browser posts material, never a transaction): the keeper's answer, and from
    // then on the ArrivalSlot in the destination's envelope of the arrival bell, with its REVEAL record
    const plainOf = tile => pack({ version: 1, hostId: free.id, arriveBell: arrive, destP: W.HOME.p, destQ: W.HOME.q, destTile: tile, stance: 2, retreatBps: 0, pathLen: 0, path: new Uint8Array(12) });
    const material = { holding: srv.viewer.holding, transit_slot: 0, plain_b64: toBase64(plainOf(W.CAMP_TILE)), salt_b64: toBase64(new Uint8Array(32)), ct_hash_b64: toBase64(ctHash(seal)) };
    const rv = await io.reveal(material);
    assert.deepEqual([rv.ok, rv.httpStatus, rv.accepted, typeof rv.track], [true, 202, true, 'string']);
    const at = await h.province(W.HOME.p, W.HOME.q, arrive);
    assert.ok(at.ok, `${at.code} ${at.error ?? ''}`);
    assert.deepEqual(at.slots.map(x => [x.account.hostId, x.account.tile, x.account.stance, x.account.bell, x.account.i]), [[free.id, W.CAMP_TILE, 2, arrive, 0]]);
    assert.deepEqual((await logged()).map(r => [r.name, r.host_id, r.tile, r.arrive]), [['REVEAL', free.id, W.CAMP_TILE, arrive]]);
    assert.equal((await io.reveal({ ...material, transit_slot: 3 })).code, 'TransitState', 'a reveal that names no march of the viewer\'s is refused');

    // ---- one Depart a turn: the Scout's is refused, nothing is sent, nothing changes
    const refused = await depart(scout.id, 2);
    assert.deepEqual([refused.ok, refused.code, refused.httpStatus], [false, 'Bucket', 200]);
    const same = await read();
    assert.equal(same.holding.transit[2].state, 0);
    assert.deepEqual(await logged(), []);
    assert.deepEqual(world.orders.map(o => [o.name, o.ok, o.code ?? null]), [['Harvest', true, null], ['Build', true, null], ['Muster', true, null], ['Muster', false, 'Insufficient'], ['Explore', true, null], ['Depart', true, null], ['Depart', false, 'Bucket']]);
    assert.equal(same.quota.left, start.quota.left - 5, 'five were sent');

    // ---- what the live relay does not play is refused as the still fixture refuses it; a forged order is not taken
    assert.equal((await send('Train', { unit: 0, n: 10 })).code, 'Unavailable');
    const stranger = await keyFromSeed(new Uint8Array(32).fill(0x44));
    const forged = await fplay.submit({ name: 'Harvest', accounts: fplay.accountsFor('Harvest', { ...v(), actor: stranger.publicKey }), signer: { session: stranger } });
    assert.equal(forged.code, 'BadSignature');
    // the keeper's routes answer as the keeper does
    const nudge = await io.nudge(W.HOME.p, W.HOME.q, 42);
    assert.deepEqual([nudge.ok, nudge.queued], [true, true]);
    assert.deepEqual(srv.requests.filter(r => r.code >= 400), []);
  } finally {
    io.setRelay(relayWas);
    srv.live(false);
    await srv.close();
  }
});
