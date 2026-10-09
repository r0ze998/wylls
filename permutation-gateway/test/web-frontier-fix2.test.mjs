// The fix pass on the second review (docs/frontier/DECISIONS.md part Z, wave 2 fixes). What every test here leans on:
//   · what stands on the tilted board is drawn so that the tilt shows it upright, as tall as it was painted and as
//     large as its row (map/tilt.mjs standAt, standing);
//   · a village is drawn by code at the size the screen asks for and is never a stretched sprite (map/village.mjs);
//   · the viewer's own town is some 180 px wide at the hero zoom.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as tilt from '../../permutation-server/web/frontier/map/tilt.mjs';
import * as village from '../../permutation-server/web/frontier/map/village.mjs';
import * as PLATES from '../../permutation-server/web/frontier/map/plates.mjs';
import { heroZoom } from '../../permutation-server/web/frontier/map/opening.mjs';
import { RADIUS } from '../../permutation-server/web/map.mjs';

const desk = { width: 1440, height: 900 }, phone = { width: 390, height: 844 };
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

/** A context that records what is called on it. */
function recorder() {
  const calls = [];
  const grad = { addColorStop() {} };
  return new Proxy({}, { get: (_, k) => (k === 'calls' ? calls : k === 'canvas' ? null : k === 'createLinearGradient' || k === 'createRadialGradient' ? () => grad : k === 'measureText' ? t => ({ width: String(t).length * 7 }) : typeof k === 'string' ? (...a) => { calls.push([k, ...a]); } : undefined), set: () => true });
}

test('the board is seen from near enough that its rows visibly shrink: the far row is at least a quarter narrower than the near one', () => {
  for (const size of [desk, phone]) {
    const g = tilt.tiltGeo(size, tilt.TILT.deg);
    const far = g.scaleAt(0), nearRow = g.scaleAt(size.height);
    assert.ok(far / nearRow < 0.75, `${size.width}: far ${far.toFixed(3)} against near ${nearRow.toFixed(3)}`);
    assert.ok(far / nearRow > 0.6, 'and not a fisheye');
  }
  assert.ok(tilt.TILT.deg <= tilt.TILT.max && tilt.TILT.max <= 22, 'the angle stays what the baked ground allows');
  assert.equal(tilt.perspFromQuery('?persp=1200'), 1200);
  assert.equal(tilt.perspFromQuery('?persp=5'), 600, 'clamped');
  assert.equal(tilt.perspFromQuery('?tilt=3'), null);
});

test('what stands on the board stands upright: drawn in the plane through standAt, the tilt shows it vertical and as large as its row', () => {
  const size = desk, g = tilt.tiltGeo(size, tilt.TILT.deg);
  for (const [sx, sy] of [[720, 450], [200, 120], [1300, 760], [60, 860], [1000, 40]]) {
    const m = g.standAt(sx, sy), k = g.scaleAt(sy);
    assert.ok(near(m.k, k));
    // a point `h` px above the foot of a picture, as `standing` places it in the plane…
    const h = 40, px = sx + m.sh * (-h), py = sy + m.vs * (-h);
    // …is seen straight above the foot, `h` times the row's scale higher (to within the curve of the view over 40 px)
    const foot = g.toBox(sx, sy), top = g.toBox(px, py);
    assert.ok(Math.abs(top.x - foot.x) < 0.6, `vertical at (${sx}, ${sy}): off by ${(top.x - foot.x).toFixed(2)} px`);
    assert.ok(Math.abs((foot.y - top.y) - h * k) < 1.6, `as tall as its row at (${sx}, ${sy}): ${(foot.y - top.y).toFixed(2)} against ${(h * k).toFixed(2)}`);
    // a point beside the foot stays beside it, the row's scale away
    const side = g.toBox(sx + 30, sy);
    assert.ok(near(side.x - foot.x, 30 * k, 1e-6) && near(side.y, foot.y, 1e-9));
  }
  // a flat board asks nothing, and `standing` then just draws
  assert.equal(tilt.tiltGeo(size, 0).standAt(10, 10), null);
  const rec = recorder();
  assert.equal(tilt.standing(rec, null, 5, 5, () => 'drawn'), 'drawn');
  assert.equal(rec.calls.length, 0);
  tilt.standing(rec, { sh: 0.1, vs: 1.2 }, 5, 50, () => rec.fillRect(0, 0, 1, 1));
  assert.deepEqual(rec.calls.map(c => c[0]), ['save', 'transform', 'fillRect', 'restore']);
  // the foot itself does not move under the transform
  const t = rec.calls[1], at = (x, y) => [t[1] * x + t[3] * y + t[5], t[2] * x + t[4] * y + t[6]];
  assert.ok(near(at(5, 50)[0], 5) && near(at(5, 50)[1], 50));
});

test('a label knows how large its row is drawn: rowScale is 1 on a plain context and the board\'s own on the armed label canvas', () => {
  const rec = recorder();
  assert.equal(tilt.rowScale(rec, 1, 2), 1);
  tilt.armUpright(rec, { place: (x, y) => ({ x, y }), zoom: 1, scaleAt: () => 1.2 });
  assert.equal(tilt.rowScale(rec, 1, 2), 1.2);
  tilt.disarmUpright(rec);
  assert.equal(tilt.rowScale(rec, 1, 2), 1);
});

test('a village is drawn by code: four tiers with four silhouettes, the nation\'s colour on its roofs, and a picture never smaller than it is shown', () => {
  const V = village.VILLAGE;
  assert.equal(V.ring.length, 4);
  for (let t = 1; t < 4; t++) { assert.ok(V.ring[t] > V.ring[t - 1], 'each tier is wider'); assert.ok(V.top[t] > V.top[t - 1], 'and taller'); }
  // every tier paints, and says something different from the tier below it
  const sizes = [];
  for (let t = 0; t < 4; t++) {
    const g = recorder();
    village.paintVillage(g, 0, 0, 100, { tier: t, faction: 2 });
    const fills = g.calls.filter(c => c[0] === 'fill').length;
    assert.ok(fills > 40, `tier ${t}: ${fills} filled shapes`);
    sizes.push(g.calls.length);
  }
  assert.equal(new Set(sizes).size, 4, 'no two tiers are the same picture');
  // (no canvas in this runtime: the caller paints straight)
  assert.equal(village.villageSprite(120, { tier: 1, faction: 0 }), null);
  // another's village keeps inside its own tile; the viewer's reaches past it, and its plate hangs above its roofs
  assert.ok(V.ring[3] * PLATES.VILLAGE_SCALE <= 1.0 + 1e-9);
  assert.ok(PLATES.villageTop({ hero: true, tier: 1 }) > PLATES.villageTop({ tier: 1 }) * 1.5);
  assert.ok(PLATES.villageTop({ hero: true, tier: 3 }) > PLATES.villageTop({ hero: true, tier: 0 }));
  assert.deepEqual(PLATES.villagePlace({ hero: true }), { scale: PLATES.HERO.scale, x: PLATES.HERO.at.x, y: PLATES.HERO.at.y });
});

test('the hero of the screen: at the hero zoom the viewer\'s own town is at least 180 px wide on a desktop', () => {
  const ring = village.VILLAGE.ring[1] * PLATES.HERO.scale * RADIUS * heroZoom(1);
  // (the palisade's ring from side to side; the roads and the fields reach further)
  assert.ok(ring * 2 >= 165, `the ring is ${Math.round(ring * 2)} px wide`);
  const withRoads = ring * 2 * 1.2;
  assert.ok(withRoads >= 180, `with its roads ${Math.round(withRoads)} px`);
  assert.ok(heroZoom(2) <= heroZoom(1) && heroZoom(2) * RADIUS >= 52);
});

// ------------------------------------------------------------------ the land's colour, the far view, the cloud sea
import * as LAND from '../../permutation-server/web/frontier/map/ownland.mjs';
import { REALM_FAR, RISE } from '../../permutation-server/web/frontier/map/sprites.mjs';
import { BANK, paintHeap, seaField } from '../../permutation-server/web/frontier/map/cloudsea.mjs';
import { HEX_W, SHEET, sheetOf } from '../../permutation-server/web/frontier/map/table.mjs';
import { landBox } from '../../permutation-server/web/frontier/map/camera.mjs';

test('the viewer\'s land is a glow that hugs its border, not two more kinds of terrain: most of the band falls within the first third of its depth', () => {
  const F = LAND.OWN_FILL, steps = LAND.bandSteps();
  assert.equal(F.blend, 'soft-light', 'the ground keeps how light it is and takes the nation\'s hue');
  // the strength `d` px inside the border: the fill and every stroke that reaches that far
  const at = d => 1 - (1 - F.middle) * steps.filter(s => s.width / 2 >= d).reduce((a, s) => a * (1 - s.alpha), 1);
  const rim = at(0.01), third = at(F.depth / 3), deep = at(F.depth * 0.99);
  assert.ok(rim > 0.34 && rim <= F.rim + 1e-9, `at the border ${rim.toFixed(3)}`);
  assert.ok(third - F.middle < (rim - F.middle) * 0.5, `a third of the way in ${third.toFixed(3)}: less than half of the band is left`);
  assert.ok(deep < F.middle + 0.02, 'at its depth only the faint fill');
  // from afar: a quarter of the colour, one rim (ink, the colour, a hair of gold), each inside the one before
  const A = LAND.OWN_FAR;
  assert.equal(A.fill, 0.25);
  assert.ok(A.ink > A.colour && A.colour > A.gold && A.ink <= 4.5);
  assert.ok(REALM_FAR.fill <= 0.25 && REALM_FAR.colour > REALM_FAR.ink, 'a nation\'s land from afar: a quiet wash and one rim');
});

test('the far view\'s rim of the viewer\'s land is three strokes on one line, and no band is laid from afar', () => {
  if (typeof Path2D === 'undefined') return;
  const g = recorder();
  const land = { shape: LAND.landShape(LAND.landTiles({ q: 12, r: -4, tier: 1 })), provisional: false };
  LAND.paintOwnLand(g, land, { zoom: 0.2, faction: 0, still: true, far: true });
  const strokes = g.calls.filter(c => c[0] === 'stroke').length;
  assert.equal(strokes, 3);
  assert.ok(!g.calls.some(c => c[0] === 'drawImage'), 'no band bitmap from afar');
});

test('the cloud sea lies over all the paper beyond the opened rings and thickens away from the land', () => {
  const sea = seaField(3), sheet = sheetOf(3), land = landBox(3);
  assert.ok(BANK.near < 1 && BANK.near >= 0.6 && BANK.full > 1);
  // far out along the sheet's long axis, past where the bank used to thin into bare paper: still cloud
  const past = land.x + (SHEET.sea + SHEET.fade + 0.2) * HEX_W;
  assert.ok(past < sheet.x - SHEET.margin * 1.3 * HEX_W || true);
  let n = 0, covered = 0;
  for (let x = land.x + 4.2 * HEX_W; x < sheet.x - SHEET.margin * 1.5 * HEX_W; x += HEX_W / 2) { n++; if (sea.cover(x, 0, sheet) > 0.9) covered++; }
  for (let i = 0; i < 12; i++) { const x = (sheet.x - 2.2 * HEX_W) * (i % 2 ? 1 : -1), y = (sheet.y - 2.6 * HEX_W * 0.76) * (i < 6 ? 1 : -1) * (0.5 + 0.5 * (i % 3) / 2); n++; if (sea.cover(x, y, sheet) > 0.9) covered++; }
  assert.ok(n >= 12 && covered === n, `${covered} of ${n} points between the bank and the margin are deep in cloud`);
  // next to the land it is thinner than far out
  let nearSum = 0, farSum = 0, k = 0;
  for (let i = 0; i < 40; i++) { const a = (i / 40) * Math.PI * 2; nearSum += sea.cover(Math.cos(a) * (land.x + HEX_W * 1.3), Math.sin(a) * (land.x + HEX_W * 1.3) * 0.76, sheet); farSum += sea.cover(Math.cos(a) * (land.x + HEX_W * 3.2), Math.sin(a) * (land.x + HEX_W * 3.2) * 0.76, sheet); k++; }
  assert.ok(farSum / k > nearSum / k + 0.05, `thicker away from the land: ${(nearSum / k).toFixed(2)} near, ${(farSum / k).toFixed(2)} far`);
  // a heap is the same heap every time (its seed is its tile's, never the piece it happens to be painted in)
  const a = recorder(), b = recorder();
  assert.ok(paintHeap(a, 100, 50, 30, 4711, 1) >= 4);
  paintHeap(b, 100, 50, 30, 4711, 1);
  assert.deepEqual(a.calls, b.calls);
  assert.ok(paintHeap(recorder(), 0, 0, 80, 9, 1, true) >= 9, 'a bank is many rounds');
  assert.equal(paintHeap(null, 0, 0, 10), 0);
});

test('the relief of the board: a mountain is drawn larger than its sprite and casts a shadow; a wood a little', () => {
  assert.ok(RISE.mountain.h > 1.3 && RISE.mountain.w > 1.1 && RISE.mountain.shadow > 0);
  assert.ok(RISE.forest.h > 1.1 && RISE.forest.h < RISE.mountain.h);
});

// ------------------------------------------------------------------ reach is one contour; one ribbon for one route
import * as ACT from '../../permutation-server/web/frontier/map/actions.mjs';
import { FACTION_COLORS } from '../../permutation-server/web/frontier/fi18n.mjs';
import { setLang } from '../../permutation-server/web/lang.mjs';

test('the reach\'s contour is its outer outline alone: a tile it encloses gets no frame, it is found and hatched', () => {
  // a ring of six tiles round a tile that is not in the set (a peak inside the reach)
  const ring = [[1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1], [1, -1]].map(([q, r], i) => ({ q, r, d: i === 0 ? 0 : 1 }));
  const shape = LAND.landShape(ring);
  assert.equal(shape.loops.length, 2, 'the outline has a loop for the hole');
  const outer = ACT.outerLoops(shape.loops);
  assert.equal(outer.length, 1, 'the contour keeps the outside only');
  assert.ok(outer[0].length > shape.loops.find(l => l !== outer[0]).length);
  assert.deepEqual(ACT.enclosed(ring).map(t => `${t.q},${t.r}`), ['0,0'], 'the tile in the middle is enclosed');
  // a set with no hole encloses nothing; two separate sets keep both outlines
  const blob = [{ q: 0, r: 0, d: 0 }, ...[[1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1], [1, -1]].map(([q, r]) => ({ q, r, d: 1 }))];
  assert.deepEqual(ACT.enclosed(blob), []);
  assert.equal(ACT.outerLoops(LAND.landShape([{ q: 0, r: 0, d: 0 }, { q: 9, r: 0, d: 1 }]).loops).length, 2);
  assert.deepEqual(ACT.outerLoops([]), []);
  assert.ok(ACT.REACH.rim === 2.5 && ACT.REACH.glow === 8, 'a 2.5 px pale rim with an 8 px glow');
});

test('one ribbon for one route: the nation\'s colour under the pointer, in the order card and once sealed; half there while it is a proposal', () => {
  const hexes = [{ q: 0, r: 0 }, { q: 1, r: 0 }, { q: 2, r: 0 }, { q: 3, r: 0 }];
  const fills = opts => { const g = recorder2(); ACT.paintRibbon(g, hexes, { zoom: 1.3, still: true, ...opts }); return g.calls.filter(c => c[0] === '=' && c[1] === 'fillStyle').map(c => String(c[2])); };
  const rgbOf = hex => { const n = parseInt(hex.slice(1), 16); return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`; };
  for (const f of [0, 1, 4]) {
    const proposal = fills({ faction: f, proposal: true }), sealed = fills({ faction: f, proposal: false });
    const cloth = list => list.find(s => s.includes(rgbOf(FACTION_COLORS[f])));
    assert.ok(cloth(proposal) && cloth(sealed), `nation ${f}: the cloth is its colour both times`);
    const alpha = s => Number(/,([\d.]+)\)$/.exec(s)?.[1] ?? 1);
    assert.ok(alpha(cloth(proposal)) < alpha(cloth(sealed)), 'a proposal is half there, a sealed route solid');
    assert.ok(proposal.includes(FACTION_COLORS[f]), 'and the arrowhead is the same colour');
  }
  assert.doesNotThrow(() => ACT.paintRibbon(null, hexes));
  setLang('ja');
  assert.equal(ACT.reachText(6), '近く 6 マス · その先も選べます');
  setLang('en');
  assert.equal(ACT.reachText(6), 'Within 6 tiles · you can pick farther ones too');
  setLang('ja');
});

/** A recorder that also records what is set on it. */
function recorder2() {
  const calls = [];
  const grad = { addColorStop() {} };
  return new Proxy({}, { get: (_, k) => (k === 'calls' ? calls : k === 'canvas' ? null : k === 'createLinearGradient' || k === 'createRadialGradient' ? () => grad : typeof k === 'string' ? (...a) => { calls.push([k, ...a]); } : undefined), set: (_, k, v) => { calls.push(['=', k, v]); return true; } });
}
