// fix-lp29-fog-fort (owner r0ze 2026-11-28 09:05, inbox 2026-11-28-0905-r0ze-0900-answers.md: Q-LP29-1 (b); also Q-FL28-1 (b)).
//   Q-LP29-1 (b)  in a TEST-ONLY capture demo world (`--demo`, `--demo --two`) the guide and the keep list name the demo's
//                 PREPARED fort even under the fog, marked as the demo's target, by name and distance, with NO defender
//                 count until the fort is in sight; the guide's press opens the march order on it (one tap). Every other
//                 world (kept, plain, wide, devnet, the walletless Pages demo) has no such exception.
//   Q-FL28-1 (b)  attack pair: the second player's "Check the nation and keep" names the fort both players can reach.
//
// THIS FILE MAKES NO KEY. No runner, herald, chain or process: stand-in worlds (WorldManager with a fake launch), the page's
// own pure modules and a real fog view (map/fog.mjs) built from a survey.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { setLang } from '../../permutation-server/web/lang.mjs';
import { demoFortSummary, pairTargetSummary, WorldManager, createLauncherServer, DEMO_FORT_MODE as LAUNCHER_MODE } from '../src/frontier/local-play-launcher.mjs';
import * as DF from '../../permutation-server/web/frontier/fdemofort.mjs';
import * as F from '../../permutation-server/web/frontier/map/fog.mjs';
import * as S from '../../permutation-server/web/frontier/map/survey.mjs';
import * as KH from '../../permutation-server/web/frontier/hud/keephand.mjs';
import { contestableKeeps } from '../../permutation-server/web/frontier/fkeepreach.mjs';
import { tileHex } from '../../permutation-server/web/frontier/fgeo.mjs';
import { hostId } from '../../permutation-server/web/frontier/faddr.mjs';
import { baseProduction } from '../../permutation-server/web/frontier/fland.mjs';
import { conquestObjective, conquestGuide, conquestFacts, demoFortRow } from '../../permutation-server/web/frontier/screens/conquestguide.mjs';
import { pairGuideView, pairGuideText } from '../../permutation-server/web/frontier/flocalplay-session.mjs';

afterEach(() => { setLang('ja'); F.resetFogNow(); DF.setDemoFort(null); });
const CJK = /[぀-ヿ㐀-鿿]/;
const SEASONWORD = /season/i;
const plain = s => String(s).replace(/<[^>]*>/g, ' ').replace(/&#39;/g, '\'').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const WEB = new URL('../../permutation-server/web/frontier/', import.meta.url);
const src = f => readFileSync(new URL(f, WEB), 'utf8');

// ------------------------------------------------------------------ the page's world
const HOME = { p: 2, q: 0 };
const SEASON = { programVersion: 3, layoutVersion: 2, endBell: 4294967295, bellSecs: 600, minLead: 2, maxLead: 72, conquestParams: { keepBells: 72 } };
const HID = hostId({ p: HOME.p, q: HOME.q, site: 2, gen: 0, seq: 1 });
const VILLAGE = { ...HOME, site: 2, gen: 0, tile: 20, faction: 0, state: 2, order: 1, tier: 0, flags: 0, production: baseProduction(0), upkeep: Array(8).fill(0n), stores: [], reserve: Array(8).fill(0),
  queue: [{ kind: 1, item: 0, doneAt: 5000n }], transit: [{ state: 0 }], explore: { state: 0 }, lastOwnerAction: 1000n, finalTs: 1n, shieldUntil: 0n };
const entry = { id: HID, unit: 0, state: 1, tile: 20, troops: 300000, staminaValue: 120, staminaBell: 10, readyBell: 10, pendOp: 0, fromBell: 10, faction: 0 };
// the demo's prepared fort (Ember, 100 defenders) and an ordinary keep of another nation, both under the fog
const FORT = { p: 3, q: -2, tile: 18, holder: 4, troops: 100, heartland: false };
const OTHER = { p: 4, q: -1, tile: 30, holder: 1, troops: 60, heartland: false };
const keepsMap = () => new Map([[`${FORT.p},${FORT.q}`, { ...FORT }], [`${OTHER.p},${OTHER.q}`, { ...OTHER }]]);
function world(extra = {}) {
  return { mode: 'play', season: SEASON, citizen: { faction: 0, arrivals: 0 }, holdings: [VILLAGE], nowBell: 10, chain: { now: () => 1000 }, land: { stage: 'final' }, inFlight: 0,
    provinces: new Map([['2,0', { province: { p: 2, q: 0, resolvedNext: 10, entries: [entry], ticketCohorts: [] } }]]),
    conquest: { status: 'ready', keeps: keepsMap(), events: [] }, marches: [], orders: [], ui: { dismissed: ['ob:skip:camp'] }, terrainOf: () => null, ...extra };
}
const hostRow = s => { const pv = s.provinces.get('2,0').province; return { ...entry, id: String(HID), troops: 300, stamina: 120, pending: 0, inTransit: false, p: 2, q: 0, province: pv, holding: s.holdings[0], holdingIndex: 0, home: true }; };
// the host's reach answer as controller.mjs wantHostReach makes it (reachableKeeps over guideKeeps): one row per keep it routes
const reachRow = (k, hexes = 13) => ({ p: k.p, q: k.q, tile: k.tile, holder: k.holder, troops: k.troops, origin: null, route: { hexes, provinces: [[2, 0], [3, -1], [k.p, k.q]], secs: hexes * 300 } });
const withReach = (s, keeps) => ({ ...s, conquest: { ...s.conquest, hostReach: { host: String(HID), ok: true, rows: contestableKeeps(keeps, { faction: 0, nowBell: 10 }).map(k => reachRow(k)), unreachable: [] } } });

/** A real fog view: only the village's own tile (and, with `seeFort`, the fort's tile) is in sight. */
function fogOn({ seeFort = false } = {}) {
  const h = tileHex(HOME.p, HOME.q, 20), anchors = [{ q: h.q, r: h.r, radius: 0, level: S.L3, kind: 'host' }];
  if (seeFort) { const f = tileHex(FORT.p, FORT.q, FORT.tile); anchors.push({ q: f.q, r: f.r, radius: 0, level: S.L3, kind: 'host' }); }
  const survey = S.buildSurvey({ ringsOpen: 4, anchors });
  survey.rev = 1; survey.ownHosts = new Set(); survey.faction = 0;
  F.createFogger({ storage: { get: () => null, set: () => true } })({ active: true, survey, overviews: new Map(), viewer: 0, terrainOf: () => null, memKey: seeFort ? 'w2' : 'w1' });
  assert.equal(F.viewTile(FORT.p, FORT.q, FORT.tile, 2), seeFort, seeFort ? 'the fort is in sight' : 'the fort is under the fog');
  assert.equal(F.viewTile(OTHER.p, OTHER.q, OTHER.tile, 2), false, 'the other keep is under the fog');
}
const READY = { state: 'ready', fort: { p: FORT.p, q: FORT.q, tile: FORT.tile }, holder: FORT.holder };

// ================================================================== the fog exception (map/fog.mjs guideKeeps)
test('guideKeeps: under the fog the demo\'s prepared fort is named — position and holder, marked, NO defender count; nothing else passes; viewKeeps (the map) unchanged', () => {
  fogOn();
  const keeps = keepsMap();
  assert.equal(F.viewKeeps(keeps).size, 0, 'the fog hides both keeps');
  assert.equal(F.guideKeeps(keeps), F.viewKeeps(keeps), 'not a demo world (no fort set): exactly the fog\'s view');
  DF.setDemoFort(READY);
  const g = F.guideKeeps(keeps);
  assert.deepEqual([...g.keys()], ['3,-2'], 'only the prepared fort; the other fogged keep stays hidden');
  const k = g.get('3,-2');
  assert.deepEqual(k, { p: 3, q: -2, tile: 18, holder: 4, heartland: false, asOfBell: null, fog: 'demo', demoFort: true });
  assert.equal('troops' in k, false, 'no defender count under the fog');
  assert.equal(F.viewKeeps(keeps).size, 0, 'the map, minimap and keep panel still read the fog\'s view: nothing is drawn');
  assert.equal(F.viewTile(FORT.p, FORT.q, FORT.tile, 2), false, 'and the fort\'s tile is not surveyed by the exception');
  assert.equal(F.guideKeeps(keeps), g, 'the same answer while nothing changed (the reach cache keys on it)');
  // the page's records must hold that keep on that tile — a fort the launcher names elsewhere is not invented
  DF.setDemoFort({ ...READY, fort: { ...READY.fort, tile: 19 } });
  assert.equal(F.guideKeeps(keeps).size, 0, 'another tile: nothing');
  DF.setDemoFort({ ...READY, fort: { p: 9, q: 9, tile: 18 } });
  assert.equal(F.guideKeeps(keeps).size, 0, 'a province the page holds no keep of: nothing');
  // it is a keep the reach list routes (another nation's, not a heartland)
  DF.setDemoFort(READY);
  assert.deepEqual(contestableKeeps(F.guideKeeps(keeps), { faction: 0, nowBell: 10 }).map(x => `${x.p},${x.q}`), ['3,-2']);
});

test('guideKeeps: in sight the fort is the fog\'s own entry, count included, and still marked', () => {
  fogOn({ seeFort: true });
  DF.setDemoFort(READY);
  const k = F.guideKeeps(keepsMap()).get('3,-2');
  assert.equal(k.troops, 100, 'in sight: its defenders, as for any keep in sight');
  assert.equal(k.demoFort, true);
  assert.equal(k.fog, undefined, 'not the fogged stand-in');
});

test('guideKeeps: DELIBERATE BREAK — a version that copied the raw record under the fog would tell the 100 defenders (caught)', () => {
  fogOn();
  DF.setDemoFort(READY);
  const broken = keeps => { const v = new Map(F.viewKeeps(keeps)); v.set('3,-2', { ...keeps.get('3,-2'), demoFort: true }); return v; };
  assert.equal(broken(keepsMap()).get('3,-2').troops, 100, 'the break tells the count');
  assert.notEqual(F.guideKeeps(keepsMap()).get('3,-2').troops, 100, 'the real one does not');
});

// ================================================================== the keep list (hud/keephand.mjs)
test('the keep list: the fogged prepared fort is a row marked "Demo target", defenders "—", no odds; in sight its count and odds (JA + EN)', () => {
  fogOn();
  DF.setDemoFort(READY);
  const s = withReach(world(), F.guideKeeps(keepsMap()));
  const km = KH.keepsModel(s, hostRow(s));
  assert.equal(km.state, 'ready');
  assert.equal(km.rows.length, 1);
  const r = km.rows[0];
  assert.equal(r.demoFort, true); assert.equal(r.fogged, true);
  assert.equal(r.troops, null, 'no count'); assert.equal(r.odds, null, 'no odds either: they would tell the count');
  assert.equal(r.hexes, 13);
  const model = { host: hostRow(s), name: '軍勢' };
  const head = (t, sub) => `<h>${t} ${sub}</h>`;
  setLang('ja');
  const ja = String(KH.renderKeepsPop(s, model, { head }));
  assert.match(ja, /<span class="kh-row-demo">デモの目標<\/span>/);
  // (verify-pr311: the tag comes BEFORE the name — after it, the name's ellipsis cut it away at 1280 px — and the fogged
  //  defenders label may wrap: `kh-fig-fog`, conquest-hand.css)
  assert.match(ja, /<strong class="kh-row-name"><span class="kh-row-demo">デモの目標<\/span> /);
  assert.match(ja, /class="kh-fig kh-fig-def kh-fig-fog"/);
  assert.match(readFileSync(new URL('../../permutation-server/web/frontier/conquest-hand.css', import.meta.url), 'utf8'), /\.kh-fig-fog \.kh-fig-k \{ white-space: normal; \}/);
  assert.match(ja, /aria-label="デモの目標、[^"]*の砦へ進軍：エンバーが保持、霧の中なので守備兵は見えません、到着はターン /);
  assert.match(ja, /守備兵（霧の中）/);
  assert.doesNotMatch(plain(ja), /\b100\b/, 'the 100 defenders are not on the card');
  assert.match(ja, /data-act="cq-march" data-host="[^"]+" data-p="3" data-q="-2" data-tile="18"/, 'its row opens the march order on the fort');
  setLang('en');
  const en = String(KH.renderKeepsPop(s, model, { head }));
  assert.doesNotMatch(plain(en), CJK); assert.doesNotMatch(en, SEASONWORD);
  assert.match(en, /<span class="kh-row-demo">Demo target<\/span>/);
  assert.match(en, /aria-label="Demo target: march on the keep of [^"]*: held by Ember, its defenders hidden by the fog, arrival on turn /);
  assert.match(plain(en), /defenders \(in the fog\)/);
  assert.doesNotMatch(plain(en), /\b100\b/);
  // in sight: the count and the odds, as for any keep, and the mark stays
  F.resetFogNow(); fogOn({ seeFort: true });
  const s2 = withReach(world(), F.guideKeeps(keepsMap()));
  const r2 = KH.keepsModel(s2, hostRow(s2)).rows[0];
  assert.equal(r2.troops, 100); assert.equal(r2.demoFort, true); assert.equal(r2.fogged, undefined); assert.ok(r2.odds);
  setLang('ja');
  assert.match(String(KH.renderKeepsPop(s2, { host: hostRow(s2), name: '軍勢' }, { head })), /aria-label="デモの目標、[^"]*の砦へ進軍：エンバーが保持、守備兵 100、/);
});

test('the keep list of the DEFENDER (a defend pair): its own contested keep — the prepared fort — is a defend row as before, with no "Demo target" mark (verify-pr311)', () => {
  DF.setDemoFort(READY); fogOn({ seeFort: true });
  const contested = () => new Map([[`${FORT.p},${FORT.q}`, { ...FORT, holder: 0, contender: 4, progress: 2 }]]);
  const base = world({ conquest: { status: 'ready', keeps: contested(), events: [] } });
  const s = { ...base, conquest: { ...base.conquest, keeps: F.guideKeeps(contested()), hostReach: { host: String(HID), ok: true, rows: [{ ...reachRow({ ...FORT, holder: 0 }), defend: true }], unreachable: [] } } };
  assert.equal(F.guideKeeps(contested()).get(`${FORT.p},${FORT.q}`)?.demoFort, true, 'the fort itself is the demo\'s');
  const km = KH.keepsModel(s, hostRow(s));
  assert.equal(km.rows.length, 1); assert.equal(km.rows[0].defend, true);
  assert.equal(km.rows[0].demoFort, undefined, 'no demo mark on a defend row'); assert.equal(km.rows[0].fogged, undefined);
  for (const lang of ['ja', 'en']) { setLang(lang); assert.doesNotMatch(String(KH.renderKeepsPop(s, { host: hostRow(s), name: 'x' }, { head: t => t })), /kh-row-demo|デモの目標|Demo target/); }
  setLang('ja');
});

test('the keep list in a world that is NOT a demo: the fogged keeps stay out, as before (no row, no mark)', () => {
  fogOn();
  const s = withReach(world(), F.guideKeeps(keepsMap()));
  assert.equal(KH.keepsModel(s, hostRow(s)).rows.length, 0);
  assert.doesNotMatch(String(KH.renderKeepsPop(s, { host: hostRow(s), name: 'x' }, { head: t => t })), /kh-row-demo|デモの目標/);
});

// ================================================================== the guide (screens/conquestguide.mjs)
test('the guide\'s march step names the fogged prepared fort by name and distance, without its defenders; one press opens its march order (JA + EN)', () => {
  fogOn();
  DF.setDemoFort(READY);
  const s = withReach(world(), F.guideKeeps(keepsMap()));
  assert.equal(conquestGuide(s).current, 'march');
  setLang('ja');
  const o = conquestObjective(s);
  assert.equal(o.id, 'march');
  assert.match(o.text, /^このデモの目標は.+の砦（エンバーが保持、13 マス先）です。霧の中なので守備兵の数は見えません。下のボタンで、この砦への進軍の命令が開きます（封をするまで何も送られません）。$/);
  assert.doesNotMatch(o.text, /100/);
  assert.deepEqual(o.go, { act: 'cq-march', data: { host: String(HID), p: 3, q: -2, tile: 18 }, label: 'デモの砦へ進軍' }, 'one tap: the march order on that keep (no blank tile to guess)');
  setLang('en');
  const en = conquestObjective(s);
  assert.doesNotMatch(en.text, CJK); assert.doesNotMatch(en.text, SEASONWORD); assert.doesNotMatch(en.text, /100/);
  assert.match(en.text, /^This demo's target is the keep of .+ \(held by Ember, 13 tiles away\)\. It is in the fog, so its defenders are not shown\. The button below opens the march order for this keep \(nothing is sent until you seal it\)\.$/);
  assert.equal(en.go.label, 'March on the demo keep');
  // a march sealed to it counts as the march (the step moves on), as for any keep
  const sealed = { ...s, orders: [{ id: 'o1', kind: 'march', name: 'Depart', dest: { p: 3, q: -2, tile: 18 } }] };
  assert.equal(conquestFacts(sealed).marched, true);
  assert.notEqual(conquestGuide(sealed).current, 'march');
});

test('the guide before the host\'s list is computed (no host has the hand yet): the fort named without a distance, the same one press (JA + EN)', () => {
  fogOn();
  DF.setDemoFort(READY);
  const s = world();   // no FS.conquest.hostReach: keepsModel says 'loading'
  assert.equal(KH.keepsModel(s, hostRow(s)).state, 'loading');
  setLang('ja');
  const o = conquestObjective(s);
  assert.match(o.text, /^このデモの目標は.+の砦（エンバーが保持）です。霧の中なので守備兵の数は見えません。/);
  assert.doesNotMatch(o.text, /100|マス先/);
  assert.deepEqual(o.go.data, { host: String(HID), p: 3, q: -2, tile: 18 }); assert.equal(o.go.act, 'cq-march');
  setLang('en');
  const en = conquestObjective(s).text;
  assert.match(en, /^This demo's target is the keep of .+ \(held by Ember\)\. It is in the fog, so its defenders are not shown\./);
  assert.doesNotMatch(en, CJK);
  // the list was computed and the fort is NOT in this host's reach: not offered (the march card would say no path)
  const out = { ...s, conquest: { ...s.conquest, hostReach: { host: String(HID), ok: true, rows: [], unreachable: ['3,-2'] } } };
  assert.equal(demoFortRow(out, hostRow(out)), null);
  // not a demo: nothing
  DF.setDemoFort(null);
  assert.equal(demoFortRow(s, hostRow(s)), null);
});

test('the guide in sight of the fort: its defenders and odds; too few troops → the troops to add (JA + EN)', () => {
  fogOn({ seeFort: true });
  DF.setDemoFort(READY);
  const s = withReach(world(), F.guideKeeps(keepsMap()));
  setLang('ja');
  const o = conquestObjective(s);
  assert.match(o.text, /^このデモの目標は.+の砦（エンバーが保持、13 マス先）で、守備兵は 100 です。/);
  setLang('en');
  assert.match(conquestObjective(s).text, /^This demo's target is the keep of .+ \(held by Ember, 13 tiles away\), with 100 defenders\. /);
  // a host too weak for 100 behind walls: the odds and the troops to add, not the march
  const weak = withReach(world({ provinces: new Map([['2,0', { province: { p: 2, q: 0, resolvedNext: 10, entries: [{ ...entry, troops: 40000 }], ticketCohorts: [] } }]]) }), F.guideKeeps(keepsMap()));
  const wr = { ...hostRow(weak), troops: 40 };
  const row = demoFortRow(weak, wr);
  assert.ok(row && row.odds && row.odds.odds !== 'good', 'the list itself says the odds are not good');
  setLang('ja');
  const ow = conquestObjective(weak);
  assert.match(ow.text, /いまの軍勢では、この砦の勝ち目は(五分|低い)です。/);
  assert.equal(ow.go.label, '兵を足す');
  setLang('en');
  assert.match(conquestObjective(weak).text, /With your host as it is, the odds at this keep are (even|poor)\./);
});

test('the guide in a world that is NOT a demo: no demo line (the fog\'s own "no keep in sight" step, as before)', () => {
  fogOn();
  const s = withReach(world(), F.guideKeeps(keepsMap()));
  assert.equal(demoFortRow(s, hostRow(s)), null);
  setLang('ja');
  const o = conquestObjective(s);
  assert.doesNotMatch(o.text, /デモ/);
  assert.notEqual(o.go.act, 'cq-march');
  setLang('en');
  assert.doesNotMatch(conquestObjective(s).text, /demo/i);
});

test('the guide and the lists read guideKeeps, the map surfaces still viewKeeps (source pins)', () => {
  assert.ok(src('screens/conquestguide.mjs').includes('const keepsOf = FS => (FS.conquest?.keeps instanceof Map ? [...guideKeeps(FS.conquest.keeps).values()] : []);'));
  assert.ok(src('hud/keephand.mjs').includes('  const keeps = guideKeeps(FS.conquest?.keeps);\n  const rows = hr.rows.map'));
  assert.equal(src('controller.mjs').split('keeps: guideKeeps(cq.keeps)').length - 1, 2, 'both reach lists');
  assert.ok(src('map/keepmount.mjs').includes('const keeps = viewKeeps(cq.keeps);'), 'the board draws only what the fog shows');
  assert.ok(src('screens/conquest.mjs').includes('  const keeps = viewKeeps(FS.conquest?.keeps);\n  return keeps instanceof Map'), 'the keep panel too');
  assert.doesNotMatch(src('hud/worldgoals.mjs'), /guideKeeps/);
  // only the gate sets the fort, and only on a capture-demo launcher page
  for (const f of ['app.mjs', 'controller.mjs', 'map/fog.mjs', 'hud/keephand.mjs', 'screens/conquestguide.mjs']) assert.doesNotMatch(src(f), /setDemoFort/, f);
  const gate = src('flocalplay.mjs');
  assert.equal(gate.split('setDemoFort').length - 1, 2, 'imported once, used once');
  assert.ok(gate.includes("    if (launcher && claimedDemo !== null) { const asked = handle.address; startDemoFortAsks({ ask: () => checkDemoFort(asked, { herald: base, expiry: claimedEnd }), set: setDemoFort }); }"));
  // the devnet page and the walletless Pages demo have no prepared fort: nothing of theirs imports the module
  for (const f of ['fdevnetplay.mjs', 'fdevnet-depart.mjs', 'fdevnet-territory.mjs']) assert.doesNotMatch(src(f), /fdemofort|demoFort/, f);
  for (const f of ['boot.mjs', 'page-app.mjs']) assert.doesNotMatch(readFileSync(new URL(`../demo/src/${f}`, import.meta.url), 'utf8'), /fdemofort|demoFort|demo-fort/, `walletless demo ${f}`);
});

// ================================================================== the launcher (demoFortSummary, /local-play/demo-fort)
const EXPIRY = { schema: 'frontier-local-play-world-expiry-v1', startedAt: 1000, ttlMs: 2700000, expiresAt: 2701000, instance: 'a'.repeat(64) };
const SCOPE = { herald: 'http://localhost:41751', expiry: EXPIRY };
const readyLine = (over = {}, fort = {}) => ({ schema: 'frontier-localnet-capture-demo-v1', demo_step: 'ready', test_only: true, synthetic_clock_scale: 60, test_participants: 38,
  ring: 4, player_nation: 5, provinces_opened: [], refused: [], pair: null, new_ring_reachable: [{ p: -1, q: -3, keep_holder: 4, keep_tile: 58, route_steps: 13, from_tile: 41, ...fort }], ...over });

test('demoFortSummary: the demo\'s ready line → its fort and holder, numbers only, no count; pending before; anything wrong → invalid', () => {
  assert.equal(LAUNCHER_MODE, DF.DEMO_FORT_MODE, 'the launcher and the page agree on the mode');
  assert.deepEqual(demoFortSummary([]), { state: 'pending' });
  assert.deepEqual(demoFortSummary(null), { state: 'pending' });
  assert.deepEqual(demoFortSummary([{ ...readyLine(), demo_step: 'settled' }]), { state: 'pending' });
  assert.deepEqual(demoFortSummary([{ ...readyLine(), test_only: false }]), { state: 'pending' }, 'only the runner\'s test-only lines');
  assert.deepEqual(demoFortSummary([readyLine()]), { state: 'ready', fort: { p: -1, q: -3, tile: 58 }, holder: 4 });
  assert.deepEqual(Object.keys(demoFortSummary([readyLine({ note: 'x' }, { troops: 100 })])).sort(), ['fort', 'holder', 'state'], 'nothing else crosses (no count)');
  for (const bad of [readyLine({}, { keep_tile: 61 }), readyLine({}, { keep_holder: 6 }), readyLine({}, { keep_holder: 5 }), readyLine({}, { p: 0.5 }), readyLine({}, { q: '1' }),
    readyLine({ new_ring_reachable: [] }), readyLine({ new_ring_reachable: [readyLine().new_ring_reachable[0], readyLine().new_ring_reachable[0]] }), readyLine({ player_nation: 7 })])
    assert.deepEqual(demoFortSummary([bad]), { state: 'invalid' }, JSON.stringify(bad.new_ring_reachable));
});

const A = 'BbPGAbHDvV5U43zQ5E8FmSnEzZ7r2vwWAZWTNAPTTSUT', B = '5fQPsn8hoaVddFG26cWQ5QFdqxWtUPNaZ9zH2E6LYzFn', C = 'Avexj6jFeyqKwd6V9Y8M7PVSqQEWmFJXAnAroC1wv3FJ';
const fakeWorld = (over = {}) => ({ herald: SCOPE.herald, stop: async () => {}, expiry: EXPIRY, keeper: async () => null, captureDemo: { scale: 60 }, demoFort: async () => demoFortSummary([readyLine()]), ...over });

test('the launcher answers the demo fort for the world\'s own address (and its pair\'s second), only on a capture-demo launcher', async () => {
  const m = new WorldManager({ captureDemo: { scale: 60 } }, async () => fakeWorld());
  await m.start(A);
  assert.deepEqual(await m.demoFort(A), { demoFort: { mode: LAUNCHER_MODE, target: { state: 'ready', fort: { p: -1, q: -3, tile: 58 }, holder: 4 }, world: { herald: SCOPE.herald, expiry: EXPIRY } } });
  await assert.rejects(m.demoFort(C), e => e.code === 'WorldNotFound', 'another address');
  await assert.rejects(m.demoFort('nope'), e => e.code === 'InvalidWallet');
  // a launcher without the capture demo: no such answer at all
  const plainM = new WorldManager({}, async () => fakeWorld({ captureDemo: undefined, demoFort: undefined }));
  await plainM.start(A);
  await assert.rejects(plainM.demoFort(A), e => e.code === 'NotADemo');
  // a demo world that gives no reader (deliberately broken world): refused, never invented
  const noReader = new WorldManager({ captureDemo: { scale: 60 } }, async () => fakeWorld({ demoFort: undefined }));
  await noReader.start(A);
  await assert.rejects(noReader.demoFort(A), e => e.code === 'NotADemo');
  // the pair's second address asks about the same world, with its own herald
  const pm = new WorldManager({ captureDemo: { scale: 60 }, contestPair: 'contest-pair-v1' }, async (c, w, slot, f, sig, opts) => fakeWorld({ pair: { second: opts.second, herald: 'http://localhost:41752' }, pairView: async () => ({ state: 'pending' }) }));
  await Promise.all([pm.start(A), pm.start(B)]);
  const second = await pm.demoFort(B);
  assert.equal(second.demoFort.world.herald, 'http://localhost:41752');
  assert.equal(second.demoFort.target.state, 'ready');
  await m.close(); await plainM.close(); await noReader.close(); await pm.close();
});

test('the route /local-play/demo-fort: a same-origin POST of {wallet}, as the other launcher routes (an ephemeral port)', async () => {
  const m = new WorldManager({ captureDemo: { scale: 60 } }, async () => fakeWorld());
  await m.start(A);
  const { server } = createLauncherServer({ port: 41753, web: '/nonexistent' }, m);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port;
  const post = (body, headers = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/local-play/demo-fort', method: 'POST', headers: { host: 'localhost:41753', origin: 'http://localhost:41753', 'content-type': 'application/json', ...headers } }, res => {
      let d = ''; res.on('data', c => { d += c; }); res.on('end', () => resolve({ status: res.statusCode, body: d ? JSON.parse(d) : null }));
    });
    req.on('error', reject); req.end(JSON.stringify(body));
  });
  try {
    const ok = await post({ wallet: A });
    assert.equal(ok.status, 200);
    assert.deepEqual(DF.demoFortView(ok.body, SCOPE, 2000), { state: 'ready', fort: { p: -1, q: -3, tile: 58 }, holder: 4 });
    assert.equal((await post({ wallet: A }, { origin: 'http://evil.example' })).status, 403);
    assert.equal((await post({ wallet: C })).status, 404);
  } finally { server.close(); await m.close(); }
});

// ================================================================== the page's check and its bounded asks
test('demoFortView: mode, the same world (herald + every expiry field, not past), every number — else unavailable', () => {
  const body = (target, w = { herald: SCOPE.herald, expiry: EXPIRY }, mode = DF.DEMO_FORT_MODE) => ({ demoFort: { mode, target, world: w } });
  const T = { state: 'ready', fort: { p: -1, q: -3, tile: 58 }, holder: 4 };
  assert.deepEqual(DF.demoFortView(body(T), SCOPE, 2000), T);
  assert.deepEqual(DF.demoFortView(body({ state: 'pending' }), SCOPE, 2000), { state: 'pending' });
  const no = { state: 'unavailable' };
  assert.deepEqual(DF.demoFortView(body(T, undefined, 'contest-pair-v1'), SCOPE, 2000), no);
  assert.deepEqual(DF.demoFortView(body(T, { herald: 'http://localhost:41760', expiry: EXPIRY }), SCOPE, 2000), no, 'another herald');
  assert.deepEqual(DF.demoFortView(body(T, { herald: SCOPE.herald, expiry: { ...EXPIRY, instance: 'b'.repeat(64) } }), SCOPE, 2000), no, 'another instance');
  assert.deepEqual(DF.demoFortView(body(T), SCOPE, EXPIRY.expiresAt), no, 'the world\'s end has come');
  for (const t of [{ ...T, holder: 6 }, { ...T, fort: { p: -1, q: -3, tile: 61 } }, { ...T, fort: null }, { ...T, state: 'invalid' }])
    assert.deepEqual(DF.demoFortView(body(t), SCOPE, 2000), no, JSON.stringify(t));
  assert.deepEqual(DF.demoFortView(null, SCOPE, 2000), no);
});

test('startDemoFortAsks: at once, then spaced; stops at ready (sets it), at stop, and after the last try; never two at a time', async () => {
  const timers = [];
  const timer = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
  const answers = [{ state: 'pending' }, { state: 'unavailable' }, { state: 'ready', fort: { p: 1, q: 2, tile: 3 }, holder: 2 }];
  let asked = 0, set = null;
  DF.startDemoFortAsks({ ask: async () => answers[asked++], set: v => { set = v; }, timer, clear: () => {}, spacingMs: 15000, tries: 10 });
  await new Promise(r => setImmediate(r));
  assert.equal(asked, 1); assert.equal(timers.length, 1); assert.equal(timers[0].ms, 15000);
  await timers[0].fn(); assert.equal(asked, 2); assert.equal(timers.length, 2);
  await timers[1].fn(); assert.equal(asked, 3); assert.equal(timers.length, 2, 'ready: no further ask');
  assert.deepEqual(set, answers[2]);
  // stop: the launcher says this world is gone / no demo
  let n = 0; const t2 = [];
  DF.startDemoFortAsks({ ask: async () => { n++; return { state: 'stop' }; }, timer: (fn) => t2.push(fn), clear: () => {} });
  await new Promise(r => setImmediate(r));
  assert.equal(n, 1); assert.equal(t2.length, 0);
  // bounded: never more than `tries`
  let k = 0; const t3 = [];
  DF.startDemoFortAsks({ ask: async () => { k++; return { state: 'pending' }; }, timer: fn => { t3.push(fn); return t3.length; }, clear: () => {}, tries: 3 });
  await new Promise(r => setImmediate(r));
  while (t3.length) await t3.shift()();
  assert.equal(k, 3);
  assert.equal(DF.DEMO_FORT_TRIES * DF.DEMO_FORT_SPACING_MS, 30 * 60 * 1000, '30 minutes at most');
});

test('setDemoFort / onDemoFort: a checked fort only; a listener hears a change once', () => {
  let heard = 0; const off = DF.onDemoFort(() => { heard++; });
  DF.setDemoFort({ state: 'pending' }); assert.equal(DF.demoFortNow(), null); assert.equal(heard, 0);
  DF.setDemoFort(READY); DF.setDemoFort(READY);
  assert.deepEqual(DF.demoFortNow(), { p: 3, q: -2, tile: 18, holder: 4 }); assert.equal(heard, 1);
  assert.equal(DF.isDemoFort({ p: 3, q: -2, tile: 18 }), true); assert.equal(DF.isDemoFort({ p: 3, q: -2, tile: 1 }), false);
  DF.setDemoFort({ ...READY, holder: 9 }); assert.equal(DF.demoFortNow(), null, 'a bad holder clears it'); assert.equal(heard, 2);
  off();
});

// ================================================================== Q-FL28-1 (b): the attack pair's notice for B
const pairReady = (over = {}, pair = {}, fort = {}) => ({ ...readyLine({ player_nation: 5, ...over }, fort),
  pair: { second_player_nation: 5, second_player_role: 'attack', second_player_home: { p: -2, q: 1, site: 7, tile: 33 }, second_player_route_steps: 12, ...pair } });
const pairCheck = (over = {}) => ({ schema: 'frontier-localnet-contest-pair-v1', pair_step: 'pair_ready', test_only: true, target: { p: -1, q: -3, keep_tile: 58, holder: 4 }, first_steps: 13,
  second_home: { p: -2, q: 1, site: 7, tile: 33 }, second_nation: 5, second_role: 'attack', second_steps: 12, as_predicted: true, ...over });

test('pairTargetSummary, attack pair (loop-play29\'s two Fjordal players on Ember\'s fort): role and holder; ready after the check; fail closed', () => {
  const P = { state: 'predicted', nation: 5, opponentNation: 5, fort: { p: -1, q: -3, tile: 58 }, role: 'attack', holder: 4, home: { p: -2, q: 1, site: 7, tile: 33 } };
  assert.deepEqual(pairTargetSummary([pairReady()]), P, 'before: {state: "invalid"} (Q-FL28-1)');
  assert.deepEqual(pairTargetSummary([pairReady(), pairCheck()]), { ...P, state: 'ready' });
  assert.equal(pairTargetSummary([pairReady({}, { second_player_nation: 2 })]).nation, 2, 'a third nation attacking too');
  for (const [why, lines] of [
    ['the fort held by the second player\'s own nation is no attack', [pairReady({}, {}, { keep_holder: 5 })]],
    ['the fort held by the first player\'s nation', [pairReady({}, { second_player_nation: 2 }, { keep_holder: 5 })]],
    ['an unknown role', [pairReady({}, { second_player_role: 'watch' })]],
    ['a check about another holder', [pairReady(), pairCheck({ target: { p: -1, q: -3, keep_tile: 58, holder: 3 } })]],
    ['a check naming another role', [pairReady(), pairCheck({ second_role: 'defend' })]],
  ]) assert.deepEqual(pairTargetSummary(lines), { state: 'invalid' }, why);
  // DELIBERATE BREAK: without the role field the same line is read as a defend pair, which it is not — still invalid
  assert.deepEqual(pairTargetSummary([pairReady({}, { second_player_role: undefined })]), { state: 'invalid' });
  // the defend pair is unchanged: no role, no holder in the answer
  const defend = pairTargetSummary([pairReady({ player_nation: 0 }, { second_player_nation: 4, second_player_role: 'defend' })]);
  assert.deepEqual(Object.keys(defend).sort(), ['fort', 'home', 'nation', 'opponentNation', 'state']);
});

test('pairGuideView / pairGuideText for B of an attack pair: "You and <A> can both reach the keep of …" (JA + EN); a defend pair unchanged', () => {
  const body = target => ({ pair: { mode: 'contest-pair-v1', role: 'second', target, world: { herald: SCOPE.herald, expiry: EXPIRY } } });
  const atk = pairTargetSummary([pairReady(), pairCheck()]);
  const v = pairGuideView(body(atk), 'second', SCOPE, 2000);
  assert.equal(v.role, 'attack'); assert.equal(v.holder, 4);
  setLang('ja');
  assert.equal(pairGuideText(v), '二人用の試験：あなたと相手（フィヨルダル）は、どちらも 州 -1,-3 の砦（エンバー が保持）に届きます。あなたは フィヨルダル として、州 -2,1 の村から向かえます。 二人の道を、世界の記録で確かめました。');
  setLang('en');
  const en = pairGuideText(v);
  assert.doesNotMatch(en, CJK); assert.doesNotMatch(en, SEASONWORD);
  assert.match(en, /^Two-player test: you and the other player \(Fjordal\) can both reach the keep of Province -1,-3 \(held by Ember\)\. You play Fjordal and can set out from your village in Province -2,1\. Both routes were checked on the world's records\.$/);
  assert.doesNotMatch(en, /could not be checked|Press again/, 'not the old "press again" (Q-FL28-1 addendum)');
  // predicted (not yet re-checked): the same sentence without the check
  assert.match(pairGuideText(pairGuideView(body(pairTargetSummary([pairReady()])), 'second', SCOPE, 2000)), /^Two-player test: you and the other player \(Fjordal\) can both reach .+ Province -2,1\.$/);
  // fail closed on the page too: an attack answer whose holder is B's nation is not shown
  assert.deepEqual(pairGuideView(body({ ...atk, holder: 5 }), 'second', SCOPE, 2000), { state: 'unavailable' });
  assert.deepEqual(pairGuideView(body({ ...atk, role: undefined, holder: undefined }), 'second', SCOPE, 2000), { state: 'unavailable' }, 'one nation on both sides without the attack role');
  // the defend pair: exactly as before
  setLang('ja');
  const def = pairGuideView(body({ state: 'ready', nation: 4, opponentNation: 0, fort: { p: -1, q: -3, tile: 58 }, home: { p: -2, q: 1, site: 7, tile: 33 } }), 'second', SCOPE, 2000);
  assert.equal(def.role, undefined);
  assert.match(pairGuideText(def), /^二人用の試験：相手（アステル）の軍勢は 州 -1,-3 の砦（エンバー が保持）に向かいます。あなたは エンバー として/);
  assert.deepEqual(pairGuideView(body({ state: 'ready', nation: 4, opponentNation: 0, holder: 4, fort: { p: -1, q: -3, tile: 58 }, home: { p: -2, q: 1, site: 7, tile: 33 } }), 'second', SCOPE, 2000), { state: 'unavailable' }, 'a defend answer carries no holder');
});
