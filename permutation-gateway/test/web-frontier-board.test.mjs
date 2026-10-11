// After landing: the board (UX design 14.2 to 14.4; permutation-server/web/frontier/map/board.mjs, hostmarks.mjs,
// picktile.mjs, villagework.mjs, people/onboard.mjs, and their part of map/fmap.mjs and fx/stage.mjs).
// The rule every test here leans on: under this line's rules nothing a player does changes who holds land, so the
// board draws only pictures of real records: the host a character leads is the lowest host id alive of its village,
// the character is where that host's records say, the land a standing host watches is its sight, the tiles a march
// walked become surveyed when it has arrived. The words are 村のまわり, 軍勢が押さえているマス, 見張っている土地,
// 測量した土地; never 領土.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as B from '../../permutation-server/web/frontier/map/board.mjs';
import * as S from '../../permutation-server/web/frontier/map/survey.mjs';
import * as H from '../../permutation-server/web/frontier/map/hostmarks.mjs';
import * as P from '../../permutation-server/web/frontier/map/picktile.mjs';
import * as V from '../../permutation-server/web/frontier/map/villagework.mjs';
import * as O from '../../permutation-server/web/frontier/people/onboard.mjs';
import { provinceTokens, paintPennon } from '../../permutation-server/web/frontier/people/units.mjs';
import { surveyInput } from '../../permutation-server/web/frontier/map/viewer.mjs';
import { FrontierMap } from '../../permutation-server/web/frontier/map/fmap.mjs';
import { HOST_LEGEND, renderSurveyHelp } from '../../permutation-server/web/frontier/map/legend.mjs';
import { paintVillage, ANNEX_AT, VILLAGE } from '../../permutation-server/web/frontier/map/village.mjs';
import { LANDING, landingAt } from '../../permutation-server/web/frontier/map/ownland.mjs';
import { ACTION_COLOURS } from '../../permutation-server/web/frontier/map/actions.mjs';
import { hostId } from '../../permutation-server/web/frontier/faddr.mjs';
import { DIRECTIONS, hexDistance, locate, tileHex } from '../../permutation-server/web/frontier/fgeo.mjs';
import { DEPART_STAMINA, RULES } from '../../permutation-server/web/frontier/fmarch.mjs';
import { BUILD_ITEMS, baseProduction } from '../../permutation-server/web/frontier/fland.mjs';
import { playGain, playFormed, playRecruits, playPromotion } from '../../permutation-server/web/frontier/fx/stage.mjs';
import { SAMPLES } from '../../permutation-server/web/frontier/fx/demo.mjs';
import { setLang } from '../../permutation-server/web/lang.mjs';
import { RADIUS, project } from '../../permutation-server/web/map.mjs';

const WEB = new URL('../../permutation-server/web/frontier/', import.meta.url);
const HOME = { p: 2, q: 0, site: 3, gen: 1, tile: 7 };
const id = seq => hostId({ ...HOME, seq });
const entry = (seq, o = {}) => ({ id: id(seq), faction: 0, unit: 0, tile: HOME.tile, state: 1, troops: 400_000, staminaValue: 120, staminaBell: 40, readyBell: 0, fromBell: 0, pendOp: 0, ...o });
const holding = (o = {}) => ({ ...HOME, state: 2, tier: 1, transit: [], queue: [], stores: [], production: [], explore: { state: 0 }, ...o });
const page = ({ entries = [], marches = [], nowBell = 42, hold = {}, more = [] } = {}) => ({ mode: 'play', nowBell, holdings: [holding(hold)], marches, citizen: { faction: 0 }, wallet: { address: 'W' }, record: { rings: [0, 1, 2] },
  provinces: new Map([[`${HOME.p},${HOME.q}`, { province: { p: HOME.p, q: HOME.q, entries, sites: [0, 1, 2, HOME.tile] } }], ...more.map(pv => [`${pv.p},${pv.q}`, { province: pv }])]) });
/** A context that takes every call and paints nothing (the painters must tolerate it). */
const inert = () => new Proxy({}, { get: (t, k) => (k in t ? t[k] : k === 'canvas' ? {} : /Gradient$/.test(String(k)) ? () => ({ addColorStop() {} }) : () => undefined), set: (t, k, v) => { t[k] = v; return true; } });
const march = (seq, o = {}) => ({ entry: { host: String(id(seq)), state: 'landed', departBell: 41, arriveBell: 43, route: { p: HOME.p, q: HOME.q, tile: HOME.tile, dirs: [0, 1, 0, 0] }, ...(o.entry ?? {}) }, transit: null,
  facts: { slotPresent: false, ...(o.facts ?? {}) }, dest: o.dest ?? (() => { let { q, r } = tileHex(HOME.p, HOME.q, HOME.tile); for (const d of [0, 1, 0, 0]) { q += DIRECTIONS[d][0]; r += DIRECTIONS[d][1]; } const l = locate(q, r); return { p: l.p, q: l.q, tile: l.idx }; })() });

test('who leads: the lowest host id alive of the village; a host still forming up is not yet on the board; a host on a sealed march still leads', () => {
  const fs = page({ entries: [entry(9, { unit: 6 }), entry(8), entry(7, { state: 3 }), entry(5, { state: 2, fromBell: 43 }), entry(4, { state: 0 })] });
  const rows = B.ownHostRows(fs);
  assert.deepEqual(rows.map(r => r.id), [5, 7, 8, 9].map(s => String(id(s))), 'by id, the free slot left out');
  assert.equal(B.leadOf(rows, 42).id, String(id(7)), 'seq 5 forms up next turn: not yet; seq 7 is on the road and still leads');
  assert.equal(B.leadOf(rows, 43).id, String(id(5)), 'the turn has come: the mustered host stands and is the lowest id');
  assert.equal(B.leadOf(rows.filter(r => r.id !== String(id(7)) && r.id !== String(id(5))), 42).id, String(id(8)), 'lost or dissolved: the next lowest');
  assert.equal(B.leadOf([], 42), null);
  // another village's hosts are not this village's (the id names the site and its generation)
  const other = { id: hostId({ p: 2, q: 0, site: 4, gen: 1, seq: 1 }), faction: 0, unit: 0, tile: 9, state: 1, troops: 100_000, staminaValue: 120, staminaBell: 40 };
  assert.equal(B.ownHostRows(page({ entries: [entry(8), other] })).length, 1);
  // the public rows of any village's site, for another player's character
  assert.deepEqual(B.siteHostRows(page({ entries: [entry(8), other] }).provinces, { p: 2, q: 0, site: 4 }, 42).map(r => r.tile), [9]);
});

test('where the character is, from the records: home, at the head of its host, on the viewer\'s own ribbon, at the destination once the seal is open, away', () => {
  const village = { p: HOME.p, q: HOME.q, tile: HOME.tile };
  const place = (entries, marches = [], o = {}) => { const fs = page({ entries, marches, ...o }); return B.characterPlace({ village, rows: B.ownHostRows(fs), marches: B.ownMarches(fs), nowBell: fs.nowBell, own: o.own ?? true }); };
  assert.equal(place([]).at, 'home', 'no host: by its standard');
  assert.deepEqual(place([entry(7), entry(8)]), { at: 'home', host: String(id(7)), p: 2, q: 0, tile: 7, unit: 0, alone: false }, 'the lead stands on the village: by its standard');
  assert.deepEqual(place([entry(7, { tile: 30 }), entry(8)]), { at: 'host', host: String(id(7)), p: 2, q: 0, tile: 30, unit: 0, alone: true }, 'the lead stands afield: at its head, on its tile');
  // a sealed march this browser holds the order of: a marker on the viewer's own ribbon
  assert.equal(place([entry(7, { state: 3 }), entry(8)], [march(7)]).at, 'march');
  // the arrival turn has begun and the seal is not open yet: still the ribbon (the marker rests at its end)
  assert.equal(place([entry(7, { state: 3 })], [march(7)], { nowBell: 43 }).at, 'march');
  // the seal is open: at the destination with the host
  const m = march(7, { facts: { slotPresent: true } });
  assert.deepEqual(place([entry(7, { state: 3 })], [m], { nowBell: 43 }), { at: 'arrived', host: String(id(7)), ...m.dest });
  assert.equal(place([entry(7, { state: 3 })], [march(7, { entry: { state: 'revealed' } })], { nowBell: 43 }).at, 'arrived');
  // an order this browser does not hold (another device): nothing more may be drawn
  assert.equal(place([entry(7, { state: 3 })], [{ entry: null, transit: { hostId: id(7), arriveBell: 43 }, facts: {}, dest: null }]).at, 'away');
  // another player's character is never placed from a march book: on a sealed march it is not on the board
  assert.equal(place([entry(7, { state: 3 })], [march(7)], { own: false }).at, 'away');
  // settled: the host stands in the roster of the province it arrived in
  const there = B.characterPlace({ village, rows: B.ownHostRows(page({ entries: [entry(8)], more: [{ p: 1, q: 0, entries: [entry(7, { tile: 32 })] }] })), nowBell: 42, own: true });
  assert.deepEqual([there.at, there.p, there.q, there.tile], ['host', 1, 0, 32]);
});

test('a host on the road that no roster holds any more is still alive: it leads, its character is on the ribbon and then at the destination; another player\'s is away', () => {
  // (integration of wave 5, found with the sample world: the origin's entry is freed when the departure turn is
  // resolved and the destination's is written only when the arrival turn is; in between the character jumped to the
  // next host and a host whose seal was open stood nowhere)
  const village = { p: HOME.p, q: HOME.q, tile: HOME.tile };
  const on = (marches, nowBell, entries = [entry(8, { unit: 6, tile: 5 })]) => { const fs = page({ entries, marches, nowBell }); return { fs, rows: B.ownHostRows(fs), rec: B.boardRecords(fs) }; };
  const road = on([march(7)], 42);
  assert.deepEqual(road.rows.map(r => [r.id, r.sealed, !!r.road, r.standing]), [[String(id(7)), true, true, false], [String(id(8)), false, false, true]], 'the marching host is a row, from the march alone');
  assert.equal(road.rec.lead, String(id(7)), 'it still leads: the lowest id alive');
  assert.equal(road.rec.place.at, 'march', 'the character is the marker on the viewer\'s own ribbon, not with the Scouts');
  // the arrival turn has begun and the seal is open: host and character stand on the destination
  const open = on([{ ...march(7, { entry: { state: 'revealed' } }), slot: { account: { unit: 0, depMass: 200_000 } } }], 43);
  assert.equal(open.rec.place.at, 'arrived');
  assert.deepEqual(open.rec.arrivals.map(a => [a.id, a.troops, a.unit]), [[String(id(7)), 200, 0]], 'drawn on its destination with the arrival slot\'s own unit and troops');
  // the arrival is resolved and no roster holds it: it did not stay (destroyed, or going home through the settle)
  const gone = on([march(7, { entry: { state: 'revealed' }, facts: { pipeline: 'resolved' } })], 45);
  assert.deepEqual(gone.rows.map(r => r.id), [String(id(8))]);
  assert.equal(gone.rec.lead, String(id(8)), 'the next host leads');
  // once a roster holds it again, the roster's row is the host
  assert.equal(on([march(7, { entry: { state: 'revealed' } })], 45, [entry(7, { tile: 30 }), entry(8)]).rows.filter(r => r.id === String(id(7)))[0].road, undefined);
  // another player's first host on the road, by the public DEPART record: away (never drawn), not back at the village
  const away = [{ host: String(id(7)), p: 2, q: 0, tile: 7, arriveBell: 44 }];
  const pub = B.siteHostRows(page({ entries: [entry(8, { tile: 30 })] }).provinces, { p: 2, q: 0, site: 3 }, 42, away);
  assert.equal(B.characterPlace({ village, rows: pub, nowBell: 42, own: false }).at, 'away');
  assert.equal(B.characterPlace({ village, rows: B.siteHostRows(page({ entries: [entry(8, { tile: 30 })] }).provinces, { p: 2, q: 0, site: 3 }, 42), nowBell: 42, own: false }).at, 'host', 'without the record the next host would seem to lead');
});

test('the viewer\'s own marches: known to this browser, arrived, open; how far along by the clock; the route\'s tiles', () => {
  const fs = page({ entries: [entry(7, { state: 3 })], marches: [march(7), { entry: null, transit: { hostId: id(8), arriveBell: 45 }, facts: {}, dest: { p: 1, q: 0 } }] });
  const [a, b] = B.ownMarches(fs);
  assert.equal(a.known, true); assert.equal(a.arrived, false); assert.equal(a.open, false);
  assert.equal(a.hexes.length, 5, 'the origin and four steps');
  assert.deepEqual([b.known, b.dest, b.hexes.length, b.arriveBell], [false, null, 0, 45], 'no order on this device: no destination and no route are drawn');
  // an order kept without its route (an older entry): a straight line from the village to the destination, so the ribbon and its marker are still drawn
  const bare = B.ownMarches(page({ entries: [entry(7, { state: 3 })], marches: [march(7, { entry: { route: null } })] }))[0];
  assert.equal(bare.known, true); assert.equal(bare.hexes.length, 2); assert.deepEqual(bare.hexes[0], tileHex(HOME.p, HOME.q, HOME.tile));
  // the route as hexes and as tiles: each step one hex further, the last the destination
  const hx = B.routeHexes(a.route), home = tileHex(HOME.p, HOME.q, HOME.tile);
  assert.deepEqual(hx[0], { q: home.q, r: home.r });
  for (let i = 1; i < hx.length; i++) assert.equal(hexDistance(hx[i - 1].q, hx[i - 1].r, hx[i].q, hx[i].r), 1);
  assert.deepEqual(B.routeTiles(a.route).at(-1), a.dest);
  assert.deepEqual(B.routeHexes(null), []); assert.deepEqual(B.routeHexes({ p: 2, q: 0, tile: 7, dirs: [0, 9, 0] }).length, 2, 'an unknown direction ends the route there');
  // by the clock: 0 at the start of the departure turn, 1 from the arrival turn's start
  const g = 1000;
  assert.equal(B.marchShare(a, { genesisTs: g, now: g + 600 * 41 }), 0);
  assert.equal(B.marchShare(a, { genesisTs: g, now: g + 600 * 42 }), 0.5);
  assert.equal(B.marchShare(a, { genesisTs: g, now: g + 600 * 50 }), 1);
  assert.equal(B.marchShare(b, { genesisTs: g, now: g }), 0);
});

test('an own arrival keeps its ownership mark between rosters; another village and an older generation never gain it', () => {
  const stranger = hostId({ ...HOME, site: HOME.site + 1, seq: 1 });
  const old = hostId({ ...HOME, gen: HOME.gen - 1, seq: 1 });
  const opened = host => march(7, { entry: { host: String(host), state: 'revealed' } });
  const fs = page({ nowBell: 43, entries: [entry(8), entry(1, { id: stranger })], marches: [opened(id(7)), opened(stranger), opened(old)] });
  const surveyor = S.createSurveyor({ storage: { get: () => null, set: () => true }, now: () => 0 });
  const input = surveyInput(fs);
  assert.ok(input.board.arrivals.some(a => a.id === String(id(7))), 'the opened march is drawn before its destination roster is loaded');
  const inTransit = surveyor(input);
  assert.deepEqual([...inTransit.ownHosts].sort(), [String(id(7)), String(id(8))].sort(), 'the arrival stays yours, without marking a same-nation neighbour or an older generation as yours');
  // Once the destination roster arrives, the same host stays yours through the handoff.
  const arrived = page({ nowBell: 45, entries: [entry(8), entry(7, { tile: 30 }), entry(1, { id: stranger })], marches: [opened(id(7))] });
  assert.deepEqual([...surveyor(surveyInput(arrived)).ownHosts].sort(), [String(id(7)), String(id(8))].sort());
  // A resolved march with no survivor does not leave an ownership mark behind.
  const gone = page({ nowBell: 45, entries: [entry(8)], marches: [march(7, { entry: { state: 'revealed' }, facts: { pipeline: 'resolved' } })] });
  assert.deepEqual([...surveyor(surveyInput(gone)).ownHosts], [String(id(8))]);
});

test('the bundle: the lead and its place, a host whose seal is open stands on its destination and sees from it, the route becomes surveyed at arrival', () => {
  const m = march(7, { facts: { slotPresent: true } });
  const sealed = B.boardRecords(page({ entries: [entry(7, { state: 3, staminaValue: 46 }), entry(8)], marches: [march(7)] }));
  assert.equal(sealed.lead, String(id(7))); assert.equal(sealed.place.at, 'march');
  assert.deepEqual([sealed.routes.length, sealed.arrivals.length], [0, 0], 'on the road: nothing of the route is surveyed, nothing stands at the destination');
  const fs = page({ entries: [entry(7, { state: 3, staminaValue: 46 }), entry(8)], marches: [m], nowBell: 43 });
  const open = B.boardRecords(fs);
  assert.equal(open.place.at, 'arrived');
  assert.equal(open.routes.length, 5, 'the tiles the column walked');
  assert.deepEqual(open.arrivals, [{ id: String(id(7)), ...m.dest, unit: 0, troops: 400, stamina: 49 }]);
  // the survey: the route's tiles are surveyed (each alone), and the host sees two tiles round its destination
  const input = surveyInput(fs, { ready: true });
  const anchors = S.anchorsOf(input);
  assert.equal(anchors.filter(x => x.kind === 'route').length, 5);
  assert.ok(anchors.filter(x => x.kind === 'route').every(x => x.radius === 0 && x.level === S.L2));
  const dh = tileHex(m.dest.p, m.dest.q, m.dest.tile);
  assert.ok(anchors.some(x => x.kind === 'host' && x.q === dh.q && x.r === dh.r && x.radius === S.SIGHT.host && x.level === S.L3));
  assert.equal(input.board.lead, String(id(7))); assert.equal(typeof input.chainNow, 'function');
  // an exploration still to be answered: its tiles carry the surveyors' flags
  const ex = B.boardRecords(page({ entries: [entry(9, { unit: 6 })], hold: { explore: { state: 1, p: 2, q: 0, tiles: [8, 255], host: id(9) } } }));
  assert.deepEqual(ex.explores, [{ p: 2, q: 0, tile: 8, host: String(id(9)) }]);
});

test('the survey counts itself: count() is the tiles surveyed this season, and a change says how many it added and round which piece', () => {
  const a = S.buildSurvey({ ringsOpen: 3, anchors: [{ q: 15, r: -7, radius: 1, level: S.L3, kind: 'village' }] });
  assert.equal(a.count(), 7); assert.equal(a.count.surveyed, 7); assert.equal(a.count.sight, 7);
  const b = S.buildSurvey({ ringsOpen: 3, anchors: [...a.anchors, { q: 19, r: -7, radius: 2, level: S.L3, kind: 'host' }] });
  assert.deepEqual(S.surveyGain(a, b), { n: 19, q: 19, r: -7 }, 'nineteen new tiles, round the host that sees them');
  assert.equal(S.surveyGain(b, b), null); assert.equal(S.surveyGain(null, b), null);
  // the page's surveyor: nothing for the first picture, then the gain of each change, counted
  let now = 0;
  const sv = S.createSurveyor({ storage: { get: () => null, set: () => true }, now: () => now });
  const base = { mode: 'play', ringsOpen: 3, ready: true, wallet: 'W', scope: { cluster: 'c', programId: 'p', seasonId: 1 }, villages: [{ p: 2, q: 0, tile: 7, tier: 1 }] };
  const first = sv(base);
  assert.equal(first.gain, null); assert.equal(first.board, null);
  now = 500;
  const next = sv({ ...base, hosts: [{ p: 1, q: 0, tile: 32, unit: 0 }], board: { lead: 'x' }, chainNow: () => 7, genesisTs: 3 });
  assert.equal(next.gain.seq, 1); assert.equal(next.gain.t0, 500); assert.ok(next.gain.n > 0 && next.gain.n <= 19);
  assert.equal(next.count() - first.count(), next.gain.n, 'the chip says exactly what the count grew by');
  assert.deepEqual(next.board, { lead: 'x' }); assert.equal(next.chainNow(), 7); assert.equal(next.genesisTs, 3);
  assert.equal(sv({ ...base, hosts: [{ p: 1, q: 0, tile: 32, unit: 0 }], board: { lead: 'x' } }).gain.seq, 1, 'nothing new: the same gain, not told again');
});

test('watched land: the sight of each standing host afield, by its kind; a host on its own village watches nothing of its own; land that does not exist yet is not watched', () => {
  const fs = page({ entries: [entry(7, { tile: 30 }), entry(8), entry(9, { unit: 6, tile: 30 }), entry(10, { state: 3, tile: 12 }), entry(11, { state: 2, fromBell: 43, tile: 14 })] });
  const rows = B.ownHostRows(fs);
  const w = B.watchOf(rows, { nowBell: 42 });
  assert.equal(w.length, 1, 'two hosts on one tile are one watch; the host at home, the one on the road and the one forming up have none');
  const h = tileHex(2, 0, 30);
  assert.deepEqual([w[0].q, w[0].r, w[0].radius, w[0].tiles.length], [h.q, h.r, 3, 37], 'the Scout sees three tiles: the wider watch');
  assert.ok(w[0].tiles.every(t => hexDistance(h.q, h.r, t.q, t.r) === t.d && t.d <= 3));
  assert.equal(B.watchOf(rows.filter(r => r.unit !== 6), { nowBell: 42 })[0].tiles.length, 19, 'a combat host sees two');
  assert.equal(B.watchOf(rows, { nowBell: 43 }).length, 2, 'the turn has come: the mustered host stands and watches');
  assert.equal(B.watchOf(rows, { nowBell: 42, open: (q) => q <= h.q })[0].tiles.every(t => t.q <= h.q), true);
  // the two tables agree: what a host watches is what the survey lets it see
  assert.equal(B.WATCH.host, S.SIGHT.host); assert.equal(B.WATCH.scout, S.SIGHT.scout); assert.equal(B.watchRadius(6), 3); assert.equal(B.watchRadius(0), 2);
  assert.equal(B.discTiles(0, 0, 2).length, 19);
});

test('stamina as a ring: 74 of 120 is a march; one point returns a turn; the pip is a host that can be given an order this turn', () => {
  assert.equal(DEPART_STAMINA, 74); assert.equal(RULES.STAMINA_CAP, 120);
  const full = B.staminaRing(120), spent = B.staminaRing(46), edge = B.staminaRing(74), none = B.staminaRing(undefined);
  assert.deepEqual([full.share, full.ready, full.wait], [1, true, 0]);
  assert.deepEqual([spent.ready, spent.wait], [false, 28], 'a host that has marched once: 46 left, twenty-eight turns to the next march');
  assert.ok(Math.abs(spent.need - 74 / 120) < 1e-12 && Math.abs(spent.share - 46 / 120) < 1e-12);
  assert.deepEqual([edge.ready, edge.wait, none.share, none.wait, full.notches], [true, 0, 0, 74, 12]);
  assert.equal(B.staminaRing(500).stamina, 120); assert.equal(B.staminaRing(-3).stamina, 0);
  const row = o => ({ state: 1, stamina: 120, readyBell: 0, unit: 0, ...o });
  assert.equal(B.canAct(row(), 42), true);
  assert.equal(B.canAct(row({ stamina: 46 }), 42), false, 'it cannot pay a march');
  assert.equal(B.canAct(row({ stamina: 0, unit: 6 }), 42), true, 'a Scout can explore without stamina');
  assert.equal(B.canAct(row({ readyBell: 43 }), 42), false, 'it fought: it rests a turn');
  assert.equal(B.canAct(row({ state: 2 }), 42), false); assert.equal(B.canAct(row({ state: 3 }), 42), false); assert.equal(B.canAct(null, 42), false);
});

test('the village at work: its queue is serial, what it has built is read from its production, the fields carry what has grown since the last settling', () => {
  const base = baseProduction(1);
  const prod = base.map((b, i) => String(b + (i === 0 ? 2n * 12_000n : i === 3 ? 6_000n : 0n)));
  assert.deepEqual(B.buildingsOf({ tier: 1, production: prod }), [2, 0, 0, 1, 0, 0], 'two farms and a mine over a town\'s base');
  assert.deepEqual(B.buildingsOf({ tier: 0, production: [] }), [0, 0, 0, 0, 0, 0]);
  assert.equal(BUILD_ITEMS[0].perHour, 12); assert.equal(BUILD_ITEMS[3].perHour, 6);
  const now = 100_000;
  const h = { p: 2, q: 0, site: 3, tile: 7, tier: 1, production: prod, walls: 100,
    queue: [{ doneAt: String(now + 1800), kind: 1, arg: 0 }, { doneAt: String(now + 9000), kind: 1, arg: 3 }, { doneAt: '0', kind: 0, arg: 0 }, { doneAt: String(now - 5), kind: 1, arg: 1 }],
    stores: [{ value: '1200000', rate: '64000', cap: '6000000', t0: String(now - 1800), frac: '0' }, { value: '6000000', rate: '30000', cap: '6000000', t0: String(now - 1800), frac: '0' }] };
  const w = B.villageWork(h, now);
  assert.deepEqual(w.queue.map(q => [q.slot, q.item, q.kind]), [[0, 0, 'build'], [1, 3, 'build']], 'what is under way, in order; a finished item and a free slot are not');
  assert.ok(Math.abs(w.queue[0].share - (9000 - 1800) / 9000) < 1e-9, 'a third farm takes 3,600 + 1,800 x 3 s: four fifths done');
  assert.equal(w.queue[1].startAt, now + 1800, 'the second begins when the first ends');
  assert.equal(w.queue[1].share, 0);
  assert.equal(w.grown[0], 32, 'half an hour at 64 an hour'); assert.equal(w.sheaves, 0.5);
  assert.equal(w.full, true, 'a store stands at its cap'); assert.equal(w.grown[1], 0);
  assert.equal(B.villageWork(null, now), null);
  // the scaffolds: one for every item; only the first is being built
  const sc = V.scaffoldsOf(h, now);
  assert.deepEqual(sc.map(c => [c.slot, c.queued, c.site]), [[0, false, 3], [1, true, 3]]);
  assert.equal(sc[1].share, 0); assert.ok(sc[0].share > 0.6);
  // a first copy takes 5,400 s (the card once said 3,600)
  assert.equal(B.villageWork({ tier: 0, production: [], queue: [{ doneAt: String(now + 5400), kind: 1, arg: 1 }], stores: [] }, now).queue[0].startAt, now);
  assert.equal(V.SCAFFOLD_SLOTS.length, 4, 'a stronghold\'s queue has four slots');
  for (const s of V.SCAFFOLD_SLOTS) assert.ok(s.x < -RADIUS, 'outside the wall on the left: the standard, the character and the hosts are to the right and in front');
  // sheaves: none on a field just settled, more as it grows
  assert.deepEqual([0, 0.01, 0.1, 0.5, 1, 3].map(x => V.sheafCount(x)), [0, 0, 1, 3, 5, 5]);
  assert.equal(V.fieldSpots(1).length, 2); assert.equal(V.fieldSpots(1, { farm: true }).length, 3); assert.equal(V.fieldSpots(3).length, 0);
  assert.deepEqual(V.paintSheaves(inert(), 0, 0, 100, { tier: 1, share: 0 }), [], 'bare fields: nothing flies from them');
  assert.equal(V.paintSheaves(inert(), 0, 0, 100, { tier: 1, share: 0.6 }).length, 2);
  // the board keeps the village's own record as plain data (it can be compared as text)
  const rec = B.boardRecords(page({ hold: { production: prod.map(BigInt), queue: [{ doneAt: BigInt(now + 1800), kind: 1, arg: 0 }], stores: [{ value: 1n, rate: 2n, cap: 3n, t0: 4n, frac: 0n }] } })).work;
  assert.doesNotThrow(() => JSON.stringify(rec));
  assert.deepEqual(B.buildingsOf(rec), [2, 0, 0, 1, 0, 0]);
});

test('a promotion floods the new ring alone, in the landing\'s rhythm; the village\'s picture takes one addition for each kind of building', () => {
  const f0 = V.promotionAt(0, 1, 2);
  assert.deepEqual([f0.ring(0).fill, f0.ring(1).fill, f0.ring(2).fill], [1, 1, 0], 'the land it had is there; the new ring is not yet');
  assert.deepEqual(f0.standard, { shown: true, lift: 0, alpha: 1 }, 'the standard stands as it stood');
  const mid = V.promotionAt(LANDING.floodAt + LANDING.ringFade, 1, 2);
  assert.equal(mid.ring(2).fill, 1); assert.ok(mid.ring(2).flash > 0 && mid.ring(1).flash === 0);
  assert.equal(mid.done, false);
  assert.equal(V.promotionAt(V.promotionMs(1, 2), 1, 2).done, true);
  assert.equal(V.promotionAt(V.promotionMs(1, 2), 1, 2).border, 1);
  assert.equal(V.promotionAt(LANDING.floodAt + LANDING.ringFade, 1, 2).ring(2).fill, landingAt(LANDING.floodAt + LANDING.ringFade, 0).ring(0).fill, 'the new ring floods as a landing\'s first ring does');
  // the annexes: six places, all outside the palisade and none on the right-hand side in front (the standard, the character, the hosts)
  assert.equal(ANNEX_AT.length, 6);
  for (const [gx, gy] of ANNEX_AT) assert.ok(Math.hypot(gx, gy) > VILLAGE.ring[1] + 0.1 && (gx < 0 || gy < -0.7), `${gx},${gy}`);
  for (const tier of [0, 1, 2, 3]) assert.doesNotThrow(() => paintVillage(inert(), 200, 200, 80, { tier, faction: 0, annex: [1, 1, 1, 1, 1, 1] }));
  const src = readFileSync(new URL('map/village.mjs', WEB), 'utf8');
  assert.match(src, /const key = `\$\{r\}\|\$\{tier\}\|\$\{faction\}\|\$\{walls \? 1 : 0\}\|\$\{variant \? 1 : 0\}\|\$\{mask\}`;/, 'a village with farms and a mine is a picture of its own');
});

test('picking a tile: the lit set in the reach\'s shape, its colour by kind, the keyboard\'s step', () => {
  const tiles = [8, 6, 13, 14, 2, 3].map(t => ({ p: 2, q: 0, tile: t }));
  const m = P.pickModel({ kind: 'explore', tiles, origin: { p: 2, q: 0, tile: 7 }, max: 2, label: 'x', t0: 5 });
  assert.equal(m.mode, 'pick'); assert.equal(m.kind, 'explore'); assert.equal(m.tiles.length, 6); assert.equal(m.max, 2); assert.equal(m.t0, 5);
  const home = tileHex(2, 0, 7);
  assert.deepEqual(m.hex, { q: home.q, r: home.r }, 'the origin is part of the shape and is not a tile to take');
  assert.ok(m.tiles.every(t => t.kind === 'move' && t.d === hexDistance(home.q, home.r, t.hq, t.hr) && m.byHex.get(`${t.hq},${t.hr}`) === t));
  assert.deepEqual(m.picked, []);
  const two = P.pickModel({ kind: 'explore', tiles, origin: { p: 2, q: 0, tile: 7 }, max: 2, picked: [{ p: 2, q: 0, tile: 8 }] });
  assert.deepEqual(two.picked, [{ p: 2, q: 0, tile: 8 }]); assert.deepEqual(two.chosen, [8]);
  assert.equal(two.tiles.find(t => t.tile === 8).kind, 'explore', 'a tile that was taken shows a hexagon of its own with a tick');
  // the origin among the tiles (a muster may stand on the village's own tile): no separate origin hex
  assert.equal(P.pickModel({ kind: 'muster', tiles: [{ p: 2, q: 0, tile: 7 }, ...tiles], origin: { p: 2, q: 0, tile: 7 } }).hex, null);
  // axial tiles are taken too; a tile given twice is one; an unknown kind is the reach's own
  assert.equal(P.pickModel({ tiles: [{ q: home.q + 1, r: home.r }, { q: home.q + 1, r: home.r }] }).tiles.length, 1);
  assert.equal(P.pickModel({ kind: 'nope', tiles }).kind, 'move');
  // colours: muster is neither the reach's pale teal nor the gold of "yours"; explore is the sky blue of an exploration
  assert.notDeepEqual(P.PICK_KINDS.muster.rim, ACTION_COLOURS.move.rim); assert.notDeepEqual(P.PICK_KINDS.muster.rim, ACTION_COLOURS.home.rim);
  assert.deepEqual(P.PICK_KINDS.explore.rim, ACTION_COLOURS.explore.rim);
  assert.deepEqual(P.pickPalette('muster').move, P.PICK_KINDS.muster); assert.equal(P.pickPalette('explore').attack, ACTION_COLOURS.attack);
  // the keyboard: with no cursor, the tile nearest the origin; then the tile that lies most nearly that way
  const first = P.pickStep(m, null);
  assert.equal(first.d, 1);
  const right = P.pickStep(m, { q: home.q, r: home.r }, 'right');
  assert.ok(project(right.hq, right.hr).x > project(home.q, home.r).x);
  const up = P.pickStep(m, { q: home.q, r: home.r }, 'up');
  assert.ok(project(up.hq, up.hr).y < project(home.q, home.r).y);
  assert.equal(P.pickStep({ tiles: [] }, null), null); assert.equal(P.pickStep(m, { q: home.q, r: home.r }, 'sideways'), null);
});

test('map.pickTile answers with the tile tapped, or null on Escape, a tap outside, a deselection; two tiles for a Scout; the camera can be put back', async () => {
  const src = { ringsOpen: 3, overviews: new Map(), own: [{ p: 2, q: 0, tile: 7 }], open: { ready: true, active: 0 } };
  const taps = [];
  const map = new FrontierMap({ clientWidth: 800, clientHeight: 600 }, { source: () => src, onSelect: h => taps.push(h) });
  const hit = t => { const h = tileHex(2, 0, t); return { tileQ: h.q, tileR: h.r, p: 2, q: 0, idx: t }; };
  const tiles = [8, 6, 13].map(t => ({ p: 2, q: 0, tile: t }));
  // one tile: the first tap on a lit tile
  let p = map.pickTile({ kind: 'muster', tiles, origin: { p: 2, q: 0, tile: 7 }, label: 'here' });
  assert.equal(map.picking, true);
  map.tap(hit(8));
  assert.deepEqual(await p, { p: 2, q: 0, tile: 8 }); assert.equal(map.picking, false);
  assert.equal(taps.length, 0, 'a tap that is the pick\'s is not a selection');
  // a tap outside the lit set lets go, and is not a selection either
  p = map.pickTile({ kind: 'muster', tiles });
  map.tap(hit(40));
  assert.equal(await p, null); assert.equal(taps.length, 0);
  // Escape, and a deselection
  p = map.pickTile({ kind: 'muster', tiles }); assert.equal(map.pickKey({ key: 'Escape' }), true); assert.equal(await p, null);
  p = map.pickTile({ kind: 'muster', tiles }); map.pickCancel(); assert.equal(await p, null);
  // another pick lets the first go
  const a = map.pickTile({ kind: 'muster', tiles }), b = map.pickTile({ kind: 'explore', tiles, max: 2 });
  assert.equal(await a, null);
  // two tiles: a tap takes one, a tap on a taken one lets it go, the second answers
  map.tap(hit(8)); assert.deepEqual(map.pick.model.picked, [{ p: 2, q: 0, tile: 8 }]);
  map.tap(hit(8)); assert.deepEqual(map.pick.model.picked, []);
  map.tap(hit(6)); map.tap(hit(13));
  assert.deepEqual(await b, [{ p: 2, q: 0, tile: 6 }, { p: 2, q: 0, tile: 13 }]);
  // fewer than the most: Enter, or pickDone()
  p = map.pickTile({ kind: 'explore', tiles, max: 2 }); map.tap(hit(6)); map.pickDone();
  assert.deepEqual(await p, [{ p: 2, q: 0, tile: 6 }]);
  // the keyboard: an arrow steps onto a lit tile, Enter takes it
  p = map.pickTile({ kind: 'muster', tiles, origin: { p: 2, q: 0, tile: 7 } });
  assert.equal(map.pickKey({ key: 'ArrowRight' }), true); assert.ok(map.pick.cursor);
  assert.equal(map.pickKey({ key: 'Enter' }), true);
  const stepped = await p;
  assert.ok(tiles.some(t => t.tile === stepped.tile));
  assert.equal(await map.pickTile({ kind: 'muster', tiles: [] }), null, 'nothing to take: null at once');
  // with no pick a tap is a selection, as before
  map.tap(hit(9)); assert.equal(taps.at(-1).idx, 9);
  // the camera's place is kept and given back
  map.setView({ x: 100, y: 50, zoom: 1 });
  const memo = map.viewMemo();
  map.setView({ x: 900, y: -300, zoom: 0.6 });
  assert.equal(map.restore(memo, { ms: 0, ifStill: true }), false, 'a person moved the camera since: it is theirs');
  assert.equal(map.restore(memo, { ms: 0 }), true);
  assert.deepEqual([map.view.x, map.view.y, map.view.zoom], [100, 50, 1]);
  assert.equal(map.restore(null), false);
  // a host is ringed and let go
  map.selectHost(5n); assert.equal(map.hostSel, '5'); map.selectHost(null); assert.equal(map.hostSel, null);
  assert.equal(map.hostAt(10, 10), null, 'no picture yet: nothing under the pointer');
  map.destroy();
});

test('the character on the board follows its place: at the head of its host in THAT host\'s province, none while it is on a sealed march (the viewer\'s own stands by its standard when no ribbon can be drawn), three steps out when the seal comes down', () => {
  const c = { p: 2, q: 0, tile: 7, faction: 0, own: true, tier: 1 };
  O.setBoardCharacters([c]);
  const [ch] = O.boardCharacters();
  const key = `${c.p},${c.q},${c.tile},${c.faction}`;
  const toks = (p, q, place, o = {}) => O.characterTokens({ p, q, villages: new Set([7]), heroTiles: new Set([7]), places: new Map([[key, place]]), level: 'full', stages: [], ...o });
  // home: one token, beside its village
  const home = toks(2, 0, { at: 'home', host: null, p: 2, q: 0, tile: 7 }, { now: 10 });
  assert.equal(home.length, 1); assert.equal(home[0].character.host, null);
  // the lead stands afield in another province: its token is there, on the host's tile, and nowhere else
  const place = { at: 'host', host: 'h7', p: 1, q: 0, tile: 32, unit: 0, alone: true };
  assert.equal(toks(2, 0, place, { now: 11 }).length, 0, 'never two of the same player on screen');
  const [there] = toks(1, 0, place, { villages: new Set(), heroTiles: null, now: 11 });
  const hx = tileHex(1, 0, 32), centre = project(hx.q, hx.r);
  assert.equal(there.character.host, 'h7'); assert.equal(there.tile, 32);
  assert.ok(Math.abs(there.x - (centre.x + O.HOST_SPOT.character[0] * RADIUS)) < 1e-9 && Math.abs(there.y - (centre.y + O.HOST_SPOT.character[1] * RADIUS)) < 1e-9, 'at the head of the host');
  assert.ok(O.HOST_SPOT.character[0] < 0 && O.HOST_SPOT.host[0] > 0 && O.HOST_SPOT.character[1] > O.HOST_SPOT.host[1], 'the character in front and to the left, the host a step to the right');
  // the host's own figure steps to the right of the tile's middle when a character leads it
  const led = provinceTokens({ p: 1, q: 0, hosts: [{ id: 'h7', faction: 0, unit: 0, tile: 32, state: 1, troops: 400 }], places: new Map([[key, place]]) });
  const host = led.find(t => !t.character);
  assert.equal(host.led, true); assert.ok(Math.abs(host.x - (centre.x + O.HOST_SPOT.host[0] * RADIUS)) < 1e-9);
  // on a sealed march with no departure heard (a page that opens on it): not on the board, and no walk
  O.setBoardCharacters([]); O.setBoardCharacters([c]);
  assert.equal(toks(2, 0, { at: 'march', host: 'h7', p: 2, q: 0, tile: 7 }, { now: 500 }).length, 0);
  // (rewritten at the integration of 2026-10-10, after the independent check of wave 5: the viewer's OWN character whose
  // lead is on a march this browser holds no order of stands by its standard, where the map says its host is on the
  // march. It was a 30 px face there, and the opening frame of a village owner had lost its character. Another
  // player's character on a sealed march is still not on the board)
  const awayOwn = toks(2, 0, { at: 'away', host: 'h7', p: 2, q: 0, tile: 7 }, { now: 500 });
  assert.equal(awayOwn.length, 1); assert.equal(awayOwn[0].tile, 7); assert.equal(awayOwn[0].character.own, true);
  O.setBoardCharacters([]); O.setBoardCharacters([{ ...c, own: false }]);
  assert.equal(O.characterTokens({ p: 2, q: 0, villages: new Set([7]), heroTiles: null, places: new Map([[key, { at: 'away', host: 'h7', p: 2, q: 0, tile: 7 }]]), level: 'full', stages: [], now: 500 }).length, 0, 'another player\'s: nothing of a sealed march');
  O.setBoardCharacters([]); O.setBoardCharacters([c]);
  // the seal comes down while it stands by its village, and it is the host it leads: it steps off with the column
  const standing = { at: 'home', host: 'h7', p: 2, q: 0, tile: 7, unit: 0, alone: true };
  toks(2, 0, standing, { now: 1000 });
  O.noteDeparture(1000, { tile: { p: 2, q: 0, tile: 7 }, unit: 0, host: null });
  assert.equal(O.leadDeparts(standing, { p: 2, q: 0, tile: 7 }, 1000.1), true);
  assert.equal(O.leadDeparts({ ...standing, alone: false }, { p: 2, q: 0, tile: 7 }, 1000.1), false, 'two hosts of that unit stand there: the event must name the host');
  assert.equal(O.leadDeparts(standing, { p: 2, q: 0, tile: 8 }, 1000.1), false);
  assert.equal(O.leadDeparts(standing, { p: 2, q: 0, tile: 7 }, 1000 + O.LEAVE.heard + 1), false);
  const walking = toks(2, 0, standing, { now: 1000 + O.LEAVE_AFTER + 0.3 });
  assert.equal(walking.length, 1); assert.ok(walking[0].character.leave, 'it walks out');
  assert.equal(toks(2, 0, standing, { now: 1000 + O.LEAVE_AFTER + O.walkSecs(O.LEAVE.cycles) + 0.1 }).length, 0, 'and is gone, before the records have come round');
  assert.equal(toks(2, 0, { at: 'march', host: 'h7', p: 2, q: 0, tile: 7 }, { now: 1004 }).length, 0, 'the records say it marches: no second walk');
  // named by the event: the lead's own id
  O.noteDeparture(2000, { tile: { p: 2, q: 0, tile: 7 }, unit: 0, host: 'h7' });
  assert.equal(O.leadDeparts({ ...standing, alone: false }, { p: 2, q: 0, tile: 7 }, 2000.1), true);
  assert.equal(O.leadDeparts({ ...standing, host: 'h8' }, { p: 2, q: 0, tile: 7 }, 2000.1), false, 'another host left: the character stays');
  // the walk itself: three steps of the clip, fading over its last part; under reduced motion it is simply gone
  assert.equal(O.LEAVE.cycles, O.LANDING_WALK.cycles, 'as long as the landing\'s walk: what the owner\'s clip carries without sliding');
  assert.deepEqual(O.leavePose(0), { k: 0, share: 0, alpha: 1 });
  const late = O.leavePose(O.walkSecs(O.LEAVE.cycles) * 0.9);
  assert.ok(late.alpha < 0.5 && late.share > 1.2); assert.equal(O.leavePose(O.walkSecs(O.LEAVE.cycles)), null); assert.equal(O.leavePose(-1), null);
  O.setBoardCharacters([]); O.setBoardCharacters([c]);
  toks(2, 0, standing, { now: 3000, level: 'reduced' });
  O.noteDeparture(3000, { tile: { p: 2, q: 0, tile: 7 }, unit: 0, host: 'h7' });
  assert.equal(toks(2, 0, standing, { now: 3000.6, level: 'reduced' }).length, 0);
  // where each character is: the viewer's own from the board's records, another player's from the public roster
  const places = O.characterPlaces([ch, { p: 2, q: 0, tile: 9, faction: 2, own: false, tier: 1 }], { board: { village: { p: 2, q: 0, tile: 7 }, place }, nowBell: 42,
    provinces: [{ p: 2, q: 0, sites: [0, 1, 2, 7, 9], entries: [{ id: hostId({ p: 2, q: 0, site: 4, gen: 0, seq: 1 }), tile: 20, unit: 0, state: 1 }, { id: hostId({ p: 2, q: 0, site: 4, gen: 0, seq: 2 }), tile: 9, unit: 0, state: 1 }] }] });
  assert.equal(places.get(key), place);
  assert.deepEqual([places.get('2,0,9,2').at, places.get('2,0,9,2').tile], ['host', 20]);
  assert.equal(O.characterPlaces([ch], { board: null }).get(key).at, 'home', 'no records: by its village');
  O.setBoardCharacters([]);
});

test('the board\'s painters take any context; the words are the land\'s true names, in both languages; the legend names what a host away from home shows', () => {
  const g = inert();
  const watch = { q: 18, r: -8, radius: 2, tiles: B.discTiles(18, -8, 2) };
  assert.doesNotThrow(() => { H.paintWatch(g, watch, { zoom: 1, faction: 0, age: 200 }); H.paintWatchTop(g, watch, { zoom: 1 }); H.paintStaminaRing(g, 0, 0, 1, B.staminaRing(46)); H.paintStaminaRing(g, 0, 0, 1, B.staminaRing(120));
    H.paintActPip(g, 0, 0, 1); H.paintSurveyFlag(g, 0, 0, 30); H.paintMarkerDisc(g, 0, 0, 30, { faction: 0 }); H.paintHostRing(g, 0, 0, 40); H.paintBellTag(g, 0, 0, 'x', { zoom: 1 }); paintPennon(g, 0, 0, 40, 0); paintPennon(g, 0, 0, 40, 0, { side: 1 }); });
  assert.equal(H.paintSealedMarch(g, [{ q: 15, r: -7 }], {}), null, 'a route of one tile is no route');
  assert.ok(H.WATCH_LOOK.wash < 0.12, 'washed very lightly: far lighter than the village\'s band');
  const low = H.watchTop(watch);
  assert.ok(low.y > project(18, -8).y, 'the watch\'s name stands under its foot (the chip that counts a survey rises over its top)');
  for (const lang of ['ja', 'en']) {
    setLang(lang);
    const words = [H.LAND_WORDS.village(), H.LAND_WORDS.held(), H.LAND_WORDS.watch(), H.LAND_WORDS.surveyed(), H.formingText(), H.exploreFlagText(), H.marchTagText(44), H.marchTagText(null), H.awaitKeyText(), H.awayText(44), H.awayText(null), H.gainText(8), H.watchTipText(),
      ...HOST_LEGEND.flatMap(x => [x.name(), x.text()])];
    for (const w of words) {
      assert.ok(w.length > 0);
      assert.ok(!/領土|領有|territor/i.test(w), `never territory for what no rule makes territory: ${w}`);
      if (lang === 'en') assert.ok(!/[぀-ヿ一-鿿]/.test(w), `English: ${w}`);
    }
  }
  setLang('ja');
  assert.deepEqual([H.LAND_WORDS.village(), H.LAND_WORDS.held(), H.LAND_WORDS.watch(), H.LAND_WORDS.surveyed()], ['村のまわり', '軍勢が押さえているマス', '見張っている土地', '測量した土地']);
  assert.equal(H.gainText(8), '+8 マス測量'); assert.equal(H.formingText(), '次のターンで整列');
  assert.match(H.marchTagText(44), /あなたにだけ見えます/); assert.match(H.awaitKeyText(), /あなたにだけ見えます/);
  assert.ok(!/あなたにだけ/.test(H.awayText(44)), 'that a host left and when it arrives is public: only a destination is the viewer\'s alone');
  assert.deepEqual(HOST_LEGEND.map(x => x.id), ['watch', 'held', 'stamina', 'forming', 'flags', 'marker']);
  const help = String(renderSurveyHelp());
  assert.match(help, /<ul class="host-legend">/); assert.match(help, /class="survey-key host-watch"/); assert.match(help, /74/);
  assert.equal((help.match(/<ul class="key-legend">/g) ?? []).length, 2, 'the map\'s two lines and the two marks round a village stay as they were');
});

test('the map says once what its records show: the survey\'s gain, an arrival, a host formed; a sample is laid over the page\'s records by the demo switch alone', () => {
  const src = readFileSync(new URL('map/fmap.mjs', WEB), 'utf8');
  for (const ev of ['survey:gain', 'board:arrival', 'board:formed', 'board:left', 'promotion', 'pick:open', 'pick:close']) assert.ok(src.includes(`fxEmit('${ev}'`), `map/fmap.mjs says ${ev}`);
  // nothing is said for what a page finds when it opens
  assert.match(src, /const faction = survey\.faction \?\? null, first = !this\.boardSeen;/);
  assert.match(src, /if \(g && g\.seq !== seen\.gain\) \{ seen\.gain = g\.seq; if \(!first\) fxEmit\('survey:gain'/);
  // the camera is taken to an arrival only when the player is not busy, and never as a move of their own
  assert.match(src, /if \(this\.busy\(now\) \|\| this\.lod !== 'tile'\) return;/);
  assert.match(src, /this\.flyTo\(\{ p: a\.p, q: a\.q, tile: a\.tile \}, null, \{ auto: true \}\);/);
  // the viewer's sealed march is drawn by the map from its record, and only what this browser holds the order of
  assert.match(src, /marches: \(board\.marches \?\? \[\]\)\.filter\(m => m\.known && !m\.open && m\.hexes\.length > 1\)/);
  const stage = readFileSync(new URL('fx/stage.mjs', WEB), 'utf8');
  for (const ev of ['survey:gain', 'board:formed', 'board:arrival', 'promotion']) assert.ok(stage.includes(`on('${ev}'`), `fx/stage.mjs plays ${ev}`);
  assert.match(stage, /if \(a\.name === 'Train'\) playRecruits\(fx\.later\(0\.35\), \{ \.\.\.rec\?\.a, \.\.\.a \}\);/, 'recruits walk in when a Train has landed on the chain');
  // (the compositions themselves are played on a page in test/web-frontier-setpieces.test.mjs)
  for (const fn of [playGain, playFormed, playRecruits, playPromotion]) assert.equal(typeof fn, 'function');
  // the demo switch's board samples hand the map sample records (or open a pick); every other caller sees the page's own
  const calls = [];
  const map = { setSample: fs => calls.push(['sample', typeof fs]), pickTile: o => { calls.push(['pick', o.kind, o.max ?? 1]); return Promise.resolve(null); }, pickCancel() {} };
  // (an engine that takes every call: the samples' own effects are played on a page in test/web-frontier-setpieces.test.mjs)
  const fx = new Proxy({}, { get: (t, k) => (k === 'map' ? map : k === 'later' ? () => fx : k === 'motionLevel' ? () => 'full' : () => []) });
  const names = Object.keys(SAMPLES).filter(n => SAMPLES[n].board);
  for (const n of ['afield', 'athome', 'sealed', 'sealed-two', 'arrival', 'ghost', 'flags', 'leave', 'scaffolds', 'annex', 'sheaves', 'harvest-fields', 'promotion', 'pick-muster', 'pick-explore']) assert.ok(names.includes(n), `a sample for ${n}`);
  assert.ok(typeof SAMPLES.recruits.run === 'function');
  for (const n of names) { calls.length = 0; SAMPLES[n].run({ at: { q: 15, r: -7 } }, fx, () => fx); assert.ok(calls.some(c => c[0] === 'sample'), n); }
  calls.length = 0;
  // (without a page the demo has no village to pick round: the map is still asked to take the sample away first)
  SAMPLES['pick-explore'].run({ at: { q: 15, r: -7 } }, fx);
  assert.deepEqual(calls[0], ['sample', 'object']);
  // a sample on a real map: the source is the page's own again once it is taken away
  const page0 = { ringsOpen: 3, overviews: new Map(), own: [{ p: 2, q: 0, tile: 7 }], open: { ready: true, active: 0 }, survey: null };
  const m = new FrontierMap({ clientWidth: 800, clientHeight: 600 }, { source: () => page0 });
  assert.equal(m.source(), page0);
  m.setSample(page({ entries: [entry(7, { tile: 30 })] }));
  const s = m.source();
  assert.equal(s.sample, true); assert.equal(s.survey.board.place.at, 'host'); assert.equal(s.survey.board.lead, String(id(7)));
  m.setSample(null);
  assert.equal(m.source(), page0);
  m.destroy();
});
