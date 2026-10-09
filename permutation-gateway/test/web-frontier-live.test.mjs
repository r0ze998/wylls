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
import { updateLife } from '../../permutation-server/web/frontier/people/life.mjs';
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

// ------------------------------------------------------------------ the polish of the final check (UX design 12.5)
import * as B from '../../permutation-server/web/frontier/people/battle.mjs';
import { dustColors } from '../../permutation-server/web/frontier/fx/battle.mjs';
import { FILE_SHADE } from '../../permutation-server/web/frontier/fx/pieces.mjs';
import { freeFrom, NARROW, HUD_IDS } from '../../permutation-server/web/frontier/fx/safe.mjs';
import { FACTION_FILL } from '../../permutation-server/web/frontier/people/avatar.mjs';
import { readFileSync } from 'node:fs';

/** A context that records what is stroked, filled and written (colours, fonts, widths). */
function recorder() {
  const log = [];
  const grad = () => { const stops = []; return { stops, addColorStop: (o, c) => stops.push([o, c]) }; };
  const state = { font: '', fillStyle: '', strokeStyle: '', lineWidth: 1, globalAlpha: 1 };
  return new Proxy(state, {
    get: (o, k) => {
      if (k === 'log') return log;
      if (k in o) return o[k];
      if (k === 'measureText') return t => ({ width: String(t).length * 13 });
      if (k === 'createLinearGradient' || k === 'createRadialGradient') return grad;
      if (k === 'getTransform') return () => ({ a: 1, b: 0 });
      if (k === 'stroke') return () => { log.push(['stroke', o.strokeStyle, o.lineWidth]); };
      if (k === 'fill') return () => { log.push(['fill', o.fillStyle]); };
      if (k === 'fillRect') return (...a) => { log.push(['fillRect', o.fillStyle, ...a]); };
      if (k === 'fillText') return (t, ...a) => { log.push(['fillText', String(t), o.font, o.fillStyle]); };
      if (k === 'strokeText') return (t, ...a) => { log.push(['strokeText', String(t), o.font]); };
      return () => undefined;
    },
    set: (o, k, v) => { o[k] = v; return true; },
  });
}
const scene = () => ({ p: 2, q: 0, bell: 41, tiles: [{ idx: 7,
  attackers: [{ id: 'a', faction: 2, unit: 0, stance: 1, before: 900, after: 0, fate: 'Destroyed', kind: 'arrival' }],
  defenders: [{ id: 'd', faction: 0, unit: 0, stance: 0, before: 640, after: 600, fate: 'Stays', kind: 'resident' }] }] });
const hex = c => { const n = parseInt(c.slice(1), 16); return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},`; };

test('the battle\'s polish: the shock on the ground is in the two nations\' own colours, the outcomes stand on bell-metal tags in the serif, the baked shadows are let through', () => {
  const play = B.startBattle(scene(), 0, 1);
  // ---- a contact frame: the ring's gradient runs from the attacker's colour to the defender's, with no ivory between
  const ctx = recorder();
  B.paintBattle(ctx, play, { zoom: 2.1, at: B.BATTLE_HITS[0] + 0.08, top: true, fateText: f => f, lossText: n => `−${n}` });
  const rings = ctx.log.filter(x => x[0] === 'stroke' && x[1]?.stops?.length === 4).map(x => x[1].stops.map(st => st[1]));
  assert.ok(rings.length >= 1, 'the shock is stroked with a gradient');
  for (const stops of rings) {
    assert.ok(stops[0].startsWith(hex(FACTION_FILL[2])) && stops[1].startsWith(hex(FACTION_FILL[2])), `the attacker's half is Cinder's colour: ${stops[0]}`);
    assert.ok(stops[2].startsWith(hex(FACTION_FILL[0])) && stops[3].startsWith(hex(FACTION_FILL[0])), `the defender's half is Aster's colour: ${stops[3]}`);
    assert.ok(stops.every(c => !/rgba\(255,24\d,2\d\d/.test(c)), 'no ivory stop');
    assert.ok(Number(/,([\d.]+)\)$/.exec(stops[0])[1]) > 0.5, 'at strength');
  }
  // ---- after the fates: each outcome is written once, in the serif at 13 px, ivory, on a plate (never outlined bare text)
  const end = recorder();
  B.paintBattle(end, play, { zoom: 2.1, at: B.PHASE.fates + 1.2, top: true, fateText: f => ({ Stays: '戦場に残った', Destroyed: '壊滅した' })[f], lossText: n => `−${n} 兵` });
  const fates = end.log.filter(x => x[0] === 'fillText' && ['戦場に残った', '壊滅した'].includes(x[1]));
  assert.deepEqual(fates.map(x => x[1]).sort(), ['壊滅した', '戦場に残った']);
  for (const f of fates) { assert.match(f[2], new RegExp(`^600 ${B.FATE_PX}px "Hiragino Mincho ProN"`)); assert.equal(f[3], '#f4efe0'); }
  assert.deepEqual(end.log.filter(x => x[0] === 'strokeText' && ['戦場に残った', '壊滅した'].includes(x[1])), [], 'no outlined caption');
  // the plates: bell metal under each, the accent down its edge (ember where nothing is left, else the side's colour)
  const accents = end.log.filter(x => x[0] === 'fillRect' && (x[1] === '#e2553d' || x[1] === FACTION_FILL[0])).map(x => x[1]);
  assert.deepEqual(accents.sort(), ['#e2553d', FACTION_FILL[0]].sort());
  assert.ok(B.FATE_PX >= 12 && B.FATE_PLATE_PX >= 20);
  // ---- shadows: a battle's figures and a file's keep under half of the sheet's baked shadow; a token on the map keeps it all
  assert.ok(B.FIGURE_SHADE > 0.2 && B.FIGURE_SHADE < 0.5 && FILE_SHADE > 0.2 && FILE_SHADE < 0.5);
  const minis = readFileSync(new URL('../../permutation-server/web/frontier/people/minis.mjs', import.meta.url), 'utf8');
  assert.match(minis, /shade = 1 \} = \{\}\)/, 'the map\'s own tokens are drawn as they were (shade 1 by default)');
  assert.match(minis, /d\[i \+ 3\] < 250 && d\[i\] < 8 && d\[i \+ 1\] < 8 && d\[i \+ 2\] < 8/, 'only the sheet\'s black, translucent pixels are the shadow');
  // ---- dust: each nation's own colour is in every puff of its line (it was mostly the pale tint, and read grey)
  const sat = c => { const n = parseInt(c.slice(1), 16), r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255; return (Math.max(r, g, b) - Math.min(r, g, b)) / Math.max(r, g, b); };
  for (const f of [0, 2]) for (const c of dustColors(B.sideColors(f))) assert.ok(sat(c) > 0.2, `${c} carries the nation's colour`);
});

test('on a phone the notices step back for a set piece: they are not an obstacle to its stage, and the stylesheet hides them only there', () => {
  assert.equal(NARROW, 760);
  assert.deepEqual(HUD_IDS.narrowGhost, ['notices']);
  const card = { left: 60, top: 80, right: 330, bottom: 250 };
  // the same boxes on a phone's map and on a wide one
  const phone = freeFrom({ left: 0, top: 0, width: 390, height: 520 }, [{ ...card, kind: 'ghost' }]);
  assert.ok(phone.stage.top < 80 && phone.stage.height > 400, 'the stage is the whole map');
  assert.ok(phone.centre.top >= 250 || phone.centre.bottom <= 80, 'the everyday stage keeps off the card');
  // what belongs to the scene is placed off what stays, not off what stepped back (the numbers were pushed under the figures)
  assert.deepEqual(phone.placeStage(195, 160, 80, 30), { x: 195, y: 160, moved: false });
  assert.equal(phone.place(195, 160, 80, 30).moved, true);
  const css = readFileSync(new URL('../../permutation-server/web/frontier/fx/fx.css', import.meta.url), 'utf8');
  assert.match(css, /@media \(max-width: 759px\) \{\s*body\[data-fx-piece\] #feed \{ opacity: 0; \}/);
  assert.match(css, /body\[data-fx-piece\] #feed:has\(:focus-visible\) \{ opacity: 1; \}/, 'a key\'s focus brings them back, a finger\'s press does not');
  assert.doesNotMatch(css, /@keyframes|animation:(?!\s*none)|transition:/);
});

test('the triggers as written: the departure\'s effect gets the road with its origin; a result card put away does not come back as single notices', () => {
  const ctl = readFileSync(new URL('../../permutation-server/web/frontier/controller.mjs', import.meta.url), 'utf8');
  // (the planner's answer has no starting tile: fx/stage.mjs routePoints then drew a straight line from the village to the destination)
  assert.match(ctl, /route: Array\.isArray\(c\.route\?\.dirs\) \? \{ p: c\.origin\.p, q: c\.origin\.q, tile: c\.host\.tile, dirs: \[\.\.\.c\.route\.dirs\] \} : null/);
  assert.match(ctl, /const dest = \{ p: p\.destP, q: p\.destQ, tile: p\.destTile \};/);
  const app = readFileSync(new URL('../../permutation-server/web/frontier/app.mjs', import.meta.url), 'utf8');
  assert.match(app, /inStrip = new Set\(\(turnStrip && fxNow\(\) - turnStrip\.at <= TURN_STRIP_MS \? turnStrip\.items : \[\]\)\.map\(x => x\.id\)\)/, 'the card\'s rows are not single notices before it shows nor after it is dismissed');
  assert.match(app, /if \(FS\.mode === 'play' && feedAnnounces\(env\.province\.p, env\.province\.q, b\)\) continue;/, 'a clash the feed announces is not also played in passing');
  assert.doesNotMatch(app, /autoPan\) playBattle\(/, 'the pan to combat waits its turn in the results (turn:scene), it does not start at the poll');
});

test('a map that a sheet covers has no place for a caption: the free rectangle says so', () => {
  const st = { left: 0, top: 0, width: 390, height: 780 };
  const strip = { left: 0, top: 0, right: 390, bottom: 56 }, dock = { left: 0, top: 724, right: 390, bottom: 780 };
  const half = freeFrom(st, [strip, { left: 0, top: 420, right: 390, bottom: 724 }, dock]);
  assert.equal(half.covered, false);
  assert.ok(half.bounds.top >= 56 && half.bounds.bottom <= 420);
  const full = freeFrom(st, [strip, { left: 0, top: 60, right: 390, bottom: 724 }, dock]);
  assert.equal(full.covered, true, 'four pixels of map between the strip and the sheet are no map');
  const effects = readFileSync(new URL('../../permutation-server/web/frontier/fx/effects.mjs', import.meta.url), 'utf8');
  assert.match(effects, /const covered = !!s\.free\.covered \|\|/, 'the tag of a covered tile is not shown');
});

test('a harvest is a moment: the first one read of a village after the log was read, and a second one in the same turn; never the log read at load', () => {
  const k = '2,0,3';
  const snap = (life, o = {}) => momentSnapshot({ life: new Map(life), provinces: new Map(), bell: 43, logged: true, ...o });
  const none = { last: 40, harvest: -1, harvests: 0 }, one = { last: 43, harvest: 43, harvests: 1 }, two = { last: 43, harvest: 43, harvests: 2 };
  const kinds = (a, b) => detectMoments(a, b, 1).map(m => [m.kind, m.p, m.q, m.site]);
  // (it asked for an earlier harvest in the log: a village's first never played)
  assert.deepEqual(kinds(snap([[k, none]]), snap([[k, one]])), [['harvest', 2, 0, 3]], 'the first harvest of a village the page knew');
  assert.deepEqual(kinds(snap([]), snap([[k, one]])), [['harvest', 2, 0, 3]], 'and of one it had no record of');
  // (and for a later bell: two in one turn were one)
  assert.deepEqual(kinds(snap([[k, one]]), snap([[k, two]])), [['harvest', 2, 0, 3]], 'a second harvest in the same turn');
  assert.deepEqual(kinds(snap([[k, one]]), snap([[k, one]])), [], 'nothing new, nothing played');
  // the load: the first snapshot was taken before the log was read, so what the log then shows is not news
  assert.deepEqual(kinds(snap([], { logged: false }), snap([[k, one]])), []);
  // the log being read up: a harvest of long ago is not news either
  assert.deepEqual(kinds(snap([]), snap([[k, { last: 30, harvest: 30, harvests: 1 }]])), []);
  // the page's fold counts them
  const life = updateLife(new Map(), [{ name: 'HARVEST', bell: 43, p: 2, q: 0, site: 3 }, { name: 'HARVEST', bell: 43, p: 2, q: 0, site: 3 }]);
  assert.deepEqual([life.get(k).harvest, life.get(k).harvests], [43, 2]);
});
