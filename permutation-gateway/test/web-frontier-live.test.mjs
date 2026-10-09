// The real pipeline in node (UX design 12.4): the page's own controller reads
// the live fixture (permutation-gateway/screens/liveworld.mjs) through the
// page's own herald client, across the toll, and what the page's triggers
// would then do is asserted: the notifications of hud/feed.mjs, the moments
// of people/moments.mjs, the results the effects layer plays and where.
// Every defect below was first seen on screen with the live fixture; each
// assertion names what was wrong.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../screens/server.mjs';
import * as W from '../screens/world.mjs';
import { LIVE } from '../screens/liveworld.mjs';
import { FS } from '../../permutation-server/web/frontier/fstate.mjs';
import * as C from '../../permutation-server/web/frontier/controller.mjs';
import { createHerald } from '../../permutation-server/web/frontier/herald.mjs';
import * as io from '../../permutation-server/web/frontier/fchainio.mjs';
import { ChainClock, seasonClock, bellAt } from '../../permutation-server/web/frontier/clock.mjs';
import { snapshot, diffFeed } from '../../permutation-server/web/frontier/hud/feed.mjs';
import { momentSnapshot, detectMoments } from '../../permutation-server/web/frontier/people/moments.mjs';
import { queueItem, QUEUE_KIND, BUILD_ITEMS } from '../../permutation-server/web/frontier/fland.mjs';
import { resultKind } from '../../permutation-server/web/frontier/fx/stage.mjs';
import { toHex } from '../../permutation-server/web/sdk/bytes.mjs';
import { setLang } from '../../permutation-server/web/lang.mjs';

test('a queue record is named by what it builds: production by its resource, the walls by their kind', () => {
  // (the page read `kind` as the build item: every building under way was the woodcutter's)
  assert.deepEqual(BUILD_ITEMS.slice(0, 6).map(b => queueItem({ kind: QUEUE_KIND.PRODUCTION, arg: ['Food', 'Wood', 'Stone', 'Ore', 'Horses', 'Gold', 'Science', 'Influence'].indexOf(b.resource) })), [0, 1, 2, 3, 4, 5]);
  assert.equal(queueItem({ kind: QUEUE_KIND.WALLS, arg: 0 }), 6);
  assert.equal(queueItem({ kind: QUEUE_KIND.TIER_UP, arg: 0 }), null, 'a tier-up is not a building of the list');
  assert.equal(queueItem({ kind: QUEUE_KIND.PRODUCTION, arg: 4 }), null, 'no building produces horses');
  assert.equal(queueItem({ kind: QUEUE_KIND.FREE, arg: 0 }), null);
  assert.equal(queueItem(null), null);
});

test('the page\'s controller across the live turn: the march has its tile, the feed names the arrival and the clash once, the building is the page\'s own clock', async () => {
  const srv = await startServer();
  const saved = { ...FS }, storageWas = globalThis.localStorage, relayWas = io.relay();
  const clock = { t: 1_700_000_000_000 };
  try {
    setLang('ja');
    srv.stage('holding');
    const world = srv.live(true, { wall: () => clock.t });
    // the storage the page finds (the march book of this device among it)
    const stored = new Map(Object.entries(W.storageFor(srv.viewer, { stage: 'holding', lang: 'ja' })));
    globalThis.localStorage = { getItem: k => stored.get(k) ?? null, setItem: (k, v) => { stored.set(k, String(v)); }, removeItem: k => { stored.delete(k); } };
    const h = createHerald({ base: srv.url });
    const s = await h.season();
    const pin = io.setPin({ programId: s.record.programId, cluster: s.record.cluster, seasonId: s.record.season, seasonAddress: s.record.seasonAddress, rulesetHash: toHex(s.season.rulesetHash) });
    h.pin(s.record.season, pin.addresses);
    io.setRelay(`${srv.url}/gw`);
    const chain = new ChainClock({ wall: () => clock.t });
    chain.observe(s.record.latestUnix, s.record.latestSlot);
    Object.assign(FS, { mode: 'play', pin, record: s.record, season: s.season, clock: seasonClock(s.season), chain, wallet: { address: srv.viewer.wallet }, session: null, kernel: null,
      citizen: null, holdings: [], provinces: new Map(), overviews: new Map(), chronicle: [], marches: [], book: [], life: new Map(), incoming: [] });
    C.useHerald(h);
    const moments = () => momentSnapshot({ life: FS.life ?? new Map(), provinces: FS.provinces, constructions: (FS.holdings[0]?.queue ?? []).filter(q => Number(q.doneAt) > chain.now()).map(q => ({ p: W.HOME.p, q: W.HOME.q, site: W.HOME.site, name: String(queueItem(q)) })) });

    // ---- turn 42
    await C.refresh();
    assert.equal(FS.nowBell, 42);
    assert.equal(FS.land.stage, 'final');
    assert.equal(FS.marches.length, 1);
    const m = FS.marches[0];
    assert.equal(m.entry?.state, 'landed', 'this device holds the march\'s record');
    // (the tile was left out of `dest`: the people layer threw on every frame drawing the viewer's column, the
    // survey never kept the destination and the arrival's mark fell on the province's middle tile)
    assert.deepEqual(m.dest, { p: W.HOME.p, q: W.HOME.q, tile: W.CAMP_TILE });
    assert.deepEqual([m.facts.slotPresent, m.facts.pipeline], [false, 'open']);
    const feed0 = snapshot(FS), mom0 = moments();
    assert.equal(feed0.marches.get(String(W.HOSTS.marching)).revealed, false);
    assert.ok(feed0.marches.get(String(W.HOSTS.marching)).destName, 'the feed can name the destination tile');

    // ---- the toll, and the poll after it
    clock.t += (LIVE.DELAY + 2) * 1000;
    assert.equal(bellAt(FS.clock.genesisTs, chain.now()), 43, 'the page\'s own clock has turned');
    await C.refresh();
    assert.equal(FS.nowBell, 43);
    const fresh = diffFeed(feed0, snapshot(FS));
    assert.deepEqual(fresh.map(x => [x.id.split(':')[0], x.kind, resultKind(x)]), [['rv', 'march', 'arrival'], ['cl', 'battle', 'battle']], 'the arrival and the clash, each once');
    assert.deepEqual([fresh[0].p, fresh[0].q], [W.HOME.p, W.HOME.q]);
    assert.match(fresh[0].text, /野営地への進軍の封が開けられました$/);
    assert.deepEqual(fresh[1].battle, { p: W.HOME.p, q: W.HOME.q, bell: LIVE.CLASH_BELL });
    assert.equal(FS.marches[0].facts.slotPresent, true);
    assert.equal(FS.book[0].state, 'revealed');
    // nothing the moments would invent at the poll: no host appeared or left, no village changed hands
    assert.deepEqual(detectMoments(mom0, moments(), 1), []);
    // the province is not behind: no catch-up is asked for
    assert.equal(C.shouldAutoNudge({ holding: FS.holdings[0], province: FS.provinces.get('2,0').province, nowBell: FS.nowBell }), false);

    // ---- twelve seconds into the turn the building is done: by the page's clock, with no new answer
    const mom1 = moments(), feed1 = snapshot(FS);
    clock.t += LIVE.BUILT_AFTER * 1000;
    const built = detectMoments(mom1, moments(), 2);
    assert.deepEqual(built.map(x => [x.kind, x.site, x.label]), [['built', W.HOME.site, '1']], 'the woodcutter\'s (item 1), from the queue record\'s resource');
    const done = diffFeed(feed1, snapshot(FS));
    assert.deepEqual(done.map(x => x.kind), ['build']);
    assert.match(done[0].text, /^伐採場が完成しました/);
    assert.deepEqual(srv.requests.filter(r => r.code >= 400), []);
  } finally {
    Object.assign(FS, saved);
    for (const k of Object.keys(FS)) if (!(k in saved)) delete FS[k];
    if (storageWas === undefined) delete globalThis.localStorage; else globalThis.localStorage = storageWas;
    io.setRelay(relayWas);
    srv.live(false);
    await srv.close();
  }
});
