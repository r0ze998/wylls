// territory-video-2 (owner, 2026-11-24 on the territory recording: 「左側の色ついてるマップが意味わからんな。後被ってるし」):
//  - the wide land's colours get an owner a player can see: each province's KEEP (map/widemarks.mjs, read from the
//    captured Province v2 bytes KEEP @4480), the HOSTS standing on it (entries @1064 in state ROSTER), one figure per
//    tile, and a plate saying whose land it is and who is taking its keep — under the fog only what is in sight;
//  - an expedition's column walks its line (flocalplay-expedition.mjs carries the marker's DEPART_BELL: without it the
//    column stood at the village and appeared at the destination on arrival);
//  - two columns at one place step aside (map/marcher.mjs columnLane) and the figures block the label pass.
// Synthetic bytes only: no keys, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keepAndHostsOfCapture, landOfCells } from '../../permutation-server/web/frontier/map/wideland.mjs';
import { wideHostSpots, wideProvinceWords, widekeepPlace, paintWideMarks, paintWideNames } from '../../permutation-server/web/frontier/map/widemarks.mjs';
import { columnLane, marcherBox } from '../../permutation-server/web/frontier/map/marcher.mjs';
import { ownMarches, marchShare } from '../../permutation-server/web/frontier/map/board.mjs';
import { smoothPath } from '../../permutation-server/web/frontier/fx/draw.mjs';
import * as F from '../../permutation-server/web/frontier/map/fog.mjs';
import * as S from '../../permutation-server/web/frontier/map/survey.mjs';
import { tileHex } from '../../permutation-server/web/frontier/fgeo.mjs';
import { setLang } from '../../permutation-server/web/lang.mjs';
import { createLabelPass } from '../../permutation-server/web/frontier/map/labelpass.mjs';

const VIEWER = 3, ENEMY = 0, OTHER = 4;
/** A 4,864-byte wide province capture: keep on `keep.tile` (or none), `hosts` `[{faction, unit, tile, troops, state}]`. */
function capture({ keep = null, hosts = [] } = {}) {
  const b = new Uint8Array(4864), v = new DataView(b.buffer);
  hosts.forEach((h, i) => { const o = 1064 + i * 48; b[o + 8] = h.faction; b[o + 9] = h.unit ?? 0; b[o + 10] = h.tile; b[o + 11] = h.state ?? 1; v.setUint32(o + 12, h.troops * 1000 + 999, true); });
  if (keep) { b[4480] = keep.tile; b[4481] = keep.holder; b[4482] = keep.contender ?? 0xff; b[4483] = keep.progress ?? 0; b[4484] = keep.required ?? 72; v.setUint32(4488, keep.troops ?? 0, true); }
  else b[4480] = 0xff;
  return Buffer.from(b).toString('base64');
}
const cellOf = (p, q, holder, kh) => { const c = tileHex(p, q, 30); return { p, q, key: `${p},${q}`, ring: 3, holder, villages: [], terrain: { sites: Array.from({ length: 12 }, (_, j) => 7 + 2 * j) }, ...kh, x: 0, y: 0, box: { x0: -1e9, y0: -1e9, x1: 1e9, y1: 1e9 }, _c: c }; };
const ALL = { x0: -1e9, y0: -1e9, x1: 1e9, y1: 1e9 };

test('keep and standing hosts are read from the captured province bytes (Province v2 KEEP @4480, entries @1064)', () => {
  const kh = keepAndHostsOfCapture(capture({ keep: { tile: 30, holder: ENEMY, contender: VIEWER, progress: 11, required: 72, troops: 100 },
    hosts: [{ faction: VIEWER, unit: 0, tile: 30, troops: 88 }, { faction: ENEMY, unit: 1, tile: 12, troops: 40 }, { faction: OTHER, tile: 5, troops: 9, state: 3 }] }));
  // (expansion-gameplay-1: and the times the keep was taken, CHANGES @6 — a won keep is reach for a claim)
  assert.deepEqual(kh.keep, { tile: 30, holder: ENEMY, contender: VIEWER, progress: 11, required: 72, troops: 100, changes: 0 });
  assert.deepEqual(kh.hosts, [{ faction: VIEWER, unit: 0, tile: 30, troops: 88 }, { faction: ENEMY, unit: 1, tile: 12, troops: 40 }], 'a departed entry (state 3) stands on no tile');
  assert.equal(keepAndHostsOfCapture(capture()).keep, null, 'no keep tile (0xFF)');
  assert.equal(keepAndHostsOfCapture(capture({ keep: { tile: 30, holder: 2 } })).keep.contender, null, 'contender 0xFF is none');
  assert.equal(keepAndHostsOfCapture('AAAA'), null, 'not a whole province');
});

test('one figure per tile, never a heap: the strongest host stands for the tile, with its nation\'s troops there', () => {
  const kh = keepAndHostsOfCapture(capture({ keep: { tile: 30, holder: ENEMY }, hosts: [
    { faction: VIEWER, tile: 30, troops: 60 }, { faction: VIEWER, tile: 30, troops: 40 }, { faction: ENEMY, tile: 30, troops: 70 }, { faction: ENEMY, tile: 12, troops: 5 }] }));
  const land = landOfCells([cellOf(3, 0, ENEMY, kh)], { rings: { min: 3, max: 3 }, reach: 4 });
  const spots = wideHostSpots(land, ALL);
  assert.equal(spots.length, 2);
  const k = spots.find(s => s.tile === 30);
  assert.deepEqual([k.faction, k.troops, k.count], [ENEMY, 70, 3]);
  assert.ok(k.x > widekeepPlace(land.cells[0], 1).cx, 'on the keep tile the figure stands before the gate, not on the fortress');
});

test('the plate says whose keep it is (territory-map OQ-3) and who is taking it (English and Japanese)', () => {
  const kh = { keep: { tile: 30, holder: ENEMY, contender: VIEWER, progress: 11, required: 72 }, hosts: [] };
  setLang('en');
  try {
    assert.deepEqual(wideProvinceWords({ holder: ENEMY, ...kh }, VIEWER), { name: 'Keep: Aster', sub: 'Your nation is taking the keep · 11/72 turns' });
    assert.deepEqual(wideProvinceWords({ holder: VIEWER, keep: { tile: 30, holder: VIEWER, contender: null } }, VIEWER), { name: 'Keep: your nation', sub: null });
    assert.equal(wideProvinceWords({ holder: VIEWER, keep: { tile: 30, holder: VIEWER, contender: OTHER, progress: 3, required: 72 } }, VIEWER).sub, 'Ember is taking the keep · 3/72 turns');
    assert.equal(wideProvinceWords({ holder: 6, keep: null }, VIEWER).name, 'Keep: no nation', 'territory-map OQ-3: the plate says whose keep, not whose land');
  } finally { setLang('ja'); }
  assert.equal(wideProvinceWords({ holder: ENEMY, ...kh }, VIEWER).sub, 'あなたの国が砦を奪取中 11/72 ターン');
});

test('under the fog: hosts only on tiles in sight (or the viewer\'s own), no contest from memory', () => {
  const kh = keepAndHostsOfCapture(capture({ keep: { tile: 30, holder: ENEMY, contender: OTHER, progress: 9 }, hosts: [{ faction: ENEMY, tile: 30, troops: 50 }, { faction: VIEWER, tile: 60, troops: 20 }] }));
  const land = landOfCells([cellOf(3, 0, ENEMY, kh)], { rings: { min: 3, max: 3 }, reach: 4 });
  const h = tileHex(3, 0, 30);
  const look = S.buildSurvey({ ringsOpen: 3, extraOpen: ['3,0'], anchors: [{ q: h.q, r: h.r, radius: 1, level: S.L3, kind: 'host' }] }); look.rev = 1;
  const mem = F.createFogMemory({ storage: { get: () => null, set: () => true } }); mem.use('k');
  const a = F.fogWideLand(land, { survey: look, mem, viewer: VIEWER, relayout: landOfCells }).cells[0];
  assert.equal(a.fog, 'sight');
  assert.deepEqual(a.hosts.map(x => x.faction).sort(), [ENEMY, VIEWER]);
  assert.equal(a.keep.contender, OTHER, 'the keep\'s tile is in sight: its contest is seen');
  const memory = new Set([...look.tiles].filter(([, v]) => v === S.L3).map(([k]) => k));
  const away = S.buildSurvey({ ringsOpen: 3, extraOpen: ['3,0'], anchors: [], memory }); away.rev = 2;
  const b = F.fogWideLand(land, { survey: away, mem, viewer: VIEWER, relayout: landOfCells }).cells[0];
  assert.equal(b.fog, 'memory');
  assert.deepEqual(b.hosts.map(x => x.faction), [VIEWER], 'an enemy host out of sight is not drawn; the viewer\'s own is');
  assert.deepEqual([b.keep.tile, b.keep.holder, b.keep.contender], [30, ENEMY, null], 'the remembered keep: its place and last holder, no contest');
});

test('the painters draw keeps and figures at the tile view, marks at the province view, nothing from afar', () => {
  const kh = keepAndHostsOfCapture(capture({ keep: { tile: 30, holder: ENEMY }, hosts: [{ faction: VIEWER, tile: 12, troops: 9 }] }));
  const land = landOfCells([cellOf(3, 0, ENEMY, kh)], { rings: { min: 3, max: 3 }, reach: 4 });
  const ctx = new Proxy({}, { get: (t, k) => (k in t ? t[k] : k === 'measureText' ? () => ({ width: 40 }) : /Gradient|Pattern/.test(k) ? () => ({ addColorStop() {} }) : () => {}), set: (t, k, v) => { t[k] = v; return true; } });
  assert.deepEqual(paintWideMarks(ctx, land, { seen: ALL, zoom: 1, level: 'tile', viewer: VIEWER }), { keeps: 1, hosts: 1 });
  assert.deepEqual(paintWideMarks(ctx, land, { seen: ALL, zoom: 0.3, level: 'province', viewer: VIEWER }), { keeps: 1, hosts: 0 });
  assert.deepEqual(paintWideMarks(ctx, land, { seen: ALL, zoom: 0.05, level: 'world', viewer: VIEWER }), { keeps: 0, hosts: 0 });
  assert.equal(paintWideNames(ctx, land, { seen: ALL, zoom: 1, level: 'tile', viewer: VIEWER }), 1);
  assert.equal(paintWideNames(ctx, land, { seen: ALL, zoom: 0.05, level: 'world', viewer: VIEWER }), 0);
  // a plate that finds no free place gives way (spare): the label pass with the whole picture taken leaves it out
  const pass = createLabelPass({ nogo: [{ x: -1e6, y: -1e6, w: 2e6, h: 2e6 }], zoom: 1 });
  assert.equal(paintWideNames(ctx, land, { seen: ALL, zoom: 1, level: 'province', viewer: VIEWER, pass }), 0);
});

test('an expedition column walks its line: the marker\'s departure turn reaches the board (pop-in fixed)', () => {
  const fs = { nowBell: 330, marches: [{ expedition: { stage: 'sent', dest: { p: 3, q: 0, tile: 30 }, origin: { p: 2, q: 0, tile: 7 }, arriveBell: 334, host: 'h' },
    transit: { slot: 0, state: 4, hostId: 7n, departBell: 326, arriveBell: 334 } }] };
  const [m] = ownMarches(fs);
  assert.equal(m.departBell, 326);
  const share = marchShare(m, { genesisTs: 0, now: 600 * 330 });
  assert.equal(share, 0.5, 'half way at turn 330 of 326→334');
  const [old] = ownMarches({ ...fs, marches: [{ ...fs.marches[0], transit: { ...fs.marches[0].transit, departBell: undefined } }] });
  assert.equal(marchShare(old, { genesisTs: 0, now: 600 * 330 }), 0, 'without it the column stands at the start (the old pop-in)');
});

test('two columns at one place step aside across their road; the figures block the words', () => {
  const path = smoothPath([{ x: 0, y: 0 }, { x: 400, y: 0 }]);
  const heads = [];
  assert.deepEqual(columnLane(heads, { x: 200, y: 0 }, { zoom: 1, path, k: 0.5 }), { dx: 0, dy: 0 });
  const b = columnLane(heads, { x: 200, y: 0 }, { zoom: 1, path, k: 0.5 });
  assert.ok(Math.abs(b.dx) < 1e-6 && Math.abs(b.dy) > 20, `stepped across a horizontal road: ${JSON.stringify(b)}`);
  const c = columnLane(heads, { x: 200, y: 0 }, { zoom: 1, path, k: 0.5 });
  assert.ok(c.dy * b.dy < 0, 'the next one steps to the other side');
  const box = marcherBox({ x: 10, y: 50, kind: 'lead' }, 1);
  assert.ok(box.y + box.h === 50 && box.w > 0, 'the box stands on the figure\'s foot');
});

test('the test world\'s notice folds to one line once a village stands, once; then it stays where the player puts it', async () => {
  const { mountSessionNotice, sessionSettled } = await import('../../permutation-server/web/frontier/flocalplay-session.mjs');
  const all = [];
  const make = tag => { const el = { tag, className: '', textContent: '', id: '', hidden: false, dataset: {}, attrs: {}, children: [], parent: null, on: {},
    setAttribute(k, v) { el.attrs[k] = v; }, append(...xs) { for (const x of xs) { x.parent = el; el.children.push(x); } }, addEventListener(k, f) { el.on[k] = f; } }; all.push(el); return el; };
  const doc = { body: make('body'), createElement: make };
  const n = mountSessionNotice({ doc, win: new EventTarget() });
  const box = all.find(e => e.className === 'local-play-session'), fold = all.find(e => e.className === 'local-play-session-fold');
  assert.equal(box.dataset.fold, 'open', 'open while joining');
  sessionSettled(doc);
  assert.equal(box.dataset.fold, 'folded', 'folded once the first village stands');
  fold.on.click();
  assert.equal(box.dataset.fold, 'open', 'the player opens it again');
  sessionSettled(doc);
  assert.equal(box.dataset.fold, 'open', 'and it is not folded a second time');
  n.unmount();
  sessionSettled(doc);   // (nothing mounted: nothing happens)
  const css = (await import('node:fs')).readFileSync(new URL('../../permutation-server/web/frontier/flocalplay.css', import.meta.url), 'utf8');
  // (territory-video-3: over the dock the host card covered it whenever a host was selected — folded, it now stands at the
  //  left under the provinces strip; web-frontier-territory-video-3.test.mjs)
  assert.match(css, /#local-play-session\[data-fold="folded"\] \{ top: calc\(var\(--strip\)[^}]*bottom: auto; left: var\(--edge\)/, 'folded, it leaves the top middle (the dial) for the left under the strip');
});

test('the label pass steps around the test world\'s notice (the wide land\'s plates stood under it)', async () => {
  const { NOGO_SELECTORS } = await import('../../permutation-server/web/frontier/map/fmap.mjs');
  assert.ok(NOGO_SELECTORS.split(',').map(s => s.trim()).includes('#local-play-session'));
  // (verify-pr197: the page feeds the map its own list — hud/insets.mjs NO_GO — and the map's selectors are then not read)
  const { NO_GO } = await import('../../permutation-server/web/frontier/hud/insets.mjs');
  assert.ok(NO_GO.some(([id, sel]) => id === 'local-play-session' && sel === '#local-play-session'), 'the page\'s own list has it');
  assert.ok(NO_GO.some(([id, sel]) => id === 'provinces' && sel === '#prov-strip'), 'and the provinces-held strip (plates stood under it)');
});

test('a plate stands only for a province well inside the view (never slid in beside the HUD)', () => {
  const kh = keepAndHostsOfCapture(capture({ keep: { tile: 30, holder: ENEMY } }));
  const land = landOfCells([cellOf(3, 0, ENEMY, kh)], { rings: { min: 3, max: 3 }, reach: 4 });
  const ctx = new Proxy({}, { get: (t, k) => (k in t ? t[k] : k === 'measureText' ? () => ({ width: 40 }) : /Gradient|Pattern/.test(k) ? () => ({ addColorStop() {} }) : () => {}), set: (t, k, v) => { t[k] = v; return true; } });
  const P = widekeepPlace(land.cells[0], 1), at = { x: P.x, y: P.y - P.u * 1.9 };
  const around = (dx, dy) => ({ x0: at.x - 500 + dx, y0: at.y - 500 + dy, x1: at.x + 500 + dx, y1: at.y + 500 + dy });
  assert.equal(paintWideNames(ctx, land, { seen: around(0, 0), zoom: 1, level: 'tile' }), 1);
  assert.equal(paintWideNames(ctx, land, { seen: around(0, 470), zoom: 1, level: 'tile' }), 0, 'its place just under the top edge');
});

// verify-pr197 (independent check of #197 in a ×30 --wide world, player view):
//  1. on the tilted board the map's `seen` is the ground canvas's flat box, larger than the picture: plates stood cut by
//     the screen's left edge and under the turn dial → the plate test is made in the picture's px (`screen`, `bounds`);
//  2. a province seen only from afar (L2) whose holder was never in sight read 「どの国のものでもない土地」 though it is held
//     → its holder is unknown: no keep and no plate;
//  3. before the first village the fog's mask is off and the raw wide land was drawn: other nations' standing hosts and
//     keep contests on the home-picking map → fog.mjs wideLandUnitless (app.mjs shownWide).
test('verify-pr197: a plate stands only where the PICTURE shows its place well inside (screen px, not the flat box)', () => {
  const kh = keepAndHostsOfCapture(capture({ keep: { tile: 30, holder: ENEMY } }));
  const land = landOfCells([cellOf(3, 0, ENEMY, kh)], { rings: { min: 3, max: 3 }, reach: 4 });
  const ctx = new Proxy({}, { get: (t, k) => (k in t ? t[k] : k === 'measureText' ? () => ({ width: 40 }) : /Gradient|Pattern/.test(k) ? () => ({ addColorStop() {} }) : () => {}), set: (t, k, v) => { t[k] = v; return true; } });
  const P = widekeepPlace(land.cells[0], 1), at = { x: P.x, y: P.y - P.u * 1.9 };
  const wide = { x0: at.x - 500, y0: at.y - 500, x1: at.x + 500, y1: at.y + 500 };   // the flat box says: well inside
  const bounds = { w: 1280, h: 800 };
  assert.equal(paintWideNames(ctx, land, { seen: wide, zoom: 1, level: 'tile', screen: () => ({ x: 640, y: 400 }), bounds }), 1, 'in the middle of the picture');
  assert.equal(paintWideNames(ctx, land, { seen: wide, zoom: 1, level: 'tile', screen: () => ({ x: -30, y: 300 }), bounds }), 0, 'left of the picture (the tilted board)');
  assert.equal(paintWideNames(ctx, land, { seen: wide, zoom: 1, level: 'tile', screen: () => ({ x: 660, y: 60 }), bounds }), 0, 'under the top bar and the dial');
  assert.equal(paintWideNames(ctx, land, { seen: wide, zoom: 1, level: 'tile', screen: () => ({ x: 640, y: 790 }), bounds }), 0, 'at the foot of the picture');
});

test('verify-pr197: a province whose holder the fog never saw has no keep and no plate (it is not "no nation\'s")', () => {
  const kh = keepAndHostsOfCapture(capture({ keep: { tile: 30, holder: ENEMY }, hosts: [{ faction: ENEMY, tile: 30, troops: 50 }] }));
  const land = landOfCells([cellOf(3, 0, ENEMY, kh)], { rings: { min: 3, max: 3 }, reach: 4 });
  const h = tileHex(3, 0, 30);
  const look = S.buildSurvey({ ringsOpen: 3, extraOpen: ['3,0'], anchors: [{ q: h.q, r: h.r, radius: 1, level: S.L3, kind: 'host' }] }); look.rev = 2;
  // (the survey remembers tiles seen before — the wide land's memory has nothing of this province: it was not loaded then,
  //  as in the live world where the vision's edge reads L2)
  const far = S.buildSurvey({ ringsOpen: 3, extraOpen: ['3,0'], anchors: [], memory: new Set([...look.tiles].filter(([, v]) => v === S.L3).map(([k]) => k)) }); far.rev = 1;
  const pv = far.province(3, 0).max;
  assert.ok(pv >= S.L2 && pv < S.L3, `seen before, not in sight (level ${pv})`);
  const mem = F.createFogMemory({ storage: { get: () => null, set: () => true } }); mem.use('k2');
  const c = F.fogWideLand(land, { survey: far, mem, viewer: VIEWER, relayout: landOfCells }).cells[0];
  assert.deepEqual([c.fog, c.holder, c.holderKnown, c.keep, c.hosts.length], ['memory', null, false, null, 0]);
  assert.deepEqual(wideProvinceWords(c, VIEWER), { name: null, sub: null });
  const ctx = new Proxy({}, { get: (t, k) => (k in t ? t[k] : k === 'measureText' ? () => ({ width: 40 }) : /Gradient|Pattern/.test(k) ? () => ({ addColorStop() {} }) : () => {}), set: (t, k, v) => { t[k] = v; return true; } });
  const fogged = landOfCells([c], { rings: { min: 3, max: 3 }, reach: 4 });
  assert.equal(paintWideNames(ctx, fogged, { seen: ALL, zoom: 0.3, level: 'province', viewer: VIEWER }), 0);
  assert.deepEqual(paintWideMarks(ctx, fogged, { seen: ALL, zoom: 1, level: 'tile', viewer: VIEWER }), { keeps: 0, hosts: 0 });
  // (seen in sight once, then away: the remembered holder is known and stays named)
  F.fogWideLand(land, { survey: look, mem, viewer: VIEWER, relayout: landOfCells });
  const later = F.fogWideLand(land, { survey: far, mem, viewer: VIEWER, relayout: landOfCells }).cells[0];
  assert.deepEqual([later.fog, later.holder, later.holderKnown, later.keep?.holder], ['memory', ENEMY, true, ENEMY]);
});

test('verify-pr197: before the first village a fogged page shows no standing host and no keep being taken', async () => {
  const kh = keepAndHostsOfCapture(capture({ keep: { tile: 30, holder: ENEMY, contender: OTHER, progress: 9, troops: 100 }, hosts: [{ faction: OTHER, tile: 30, troops: 300 }] }));
  const land = landOfCells([cellOf(3, 0, ENEMY, kh)], { rings: { min: 3, max: 3 }, reach: 4 });
  const bare = F.wideLandUnitless(land);
  assert.equal(F.wideLandUnitless(land), bare, 'kept per land (the map asks every frame)');
  const c = bare.cells[0];
  assert.deepEqual([c.hosts.length, c.keep.tile, c.keep.holder, c.keep.contender, c.keep.troops], [0, 30, ENEMY, null, null]);
  assert.equal(bare.byKey.get(c.key), c);
  assert.equal(wideHostSpots(bare, ALL).length, 0);
  assert.equal(wideProvinceWords(c, VIEWER).sub, null);
  assert.equal(land.cells[0].hosts.length, 1, 'the raw land is not touched');
  const app = (await import('node:fs')).readFileSync(new URL('../../permutation-server/web/frontier/app.mjs', import.meta.url), 'utf8');
  assert.ok(app.includes('const shownWide = land => (FS.fog?.on ? FS.fog.wide : fogActive(FS) ? wideLandUnitless(land) : land);'));
});
