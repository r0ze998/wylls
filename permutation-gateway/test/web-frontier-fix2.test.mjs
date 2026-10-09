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
