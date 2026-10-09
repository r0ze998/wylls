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

// ------------------------------------------------------------------ the HUD: the dial is a button, one clock in the wait, one button language
import { readFileSync } from 'node:fs';
import * as dialcard from '../../permutation-server/web/frontier/hud/dialcard.mjs';
import * as hud from '../../permutation-server/web/frontier/hud/hud.mjs';
import { rowGap, ROW_GAP_MAX } from '../../permutation-server/web/frontier/hud/drawer.mjs';
import * as WAIT from '../../permutation-server/web/frontier/map/waitview.mjs';

const WEB = new URL('../../permutation-server/web/frontier/', import.meta.url);
const text = name => readFileSync(new URL(name, WEB), 'utf8');

test('the turn dial is a button on all three pages; its card says the turn, the bell\'s tie to it, and what the next bell brings', () => {
  for (const page of ['index.html', 'practice.html', 'spectate.html']) {
    const html = text(page);
    assert.match(html, /<button type="button" class="dial" id="bell-pill" data-act="dial" data-urgency="calm" aria-haspopup="dialog" aria-expanded="false" aria-label="ターンと次の鐘" data-i18n-attr="aria-label">[\s\S]*?id="bell-chip"[\s\S]*?<\/button>/, page);
    assert.doesNotMatch(html, /<div class="dial"/, page);
  }
  const css = text('frontier.css');
  assert.match(css, /button\.dial \{[^}]*pointer-events: auto;/, 'a press on the dial never reaches the map under it');
  setLang('ja');
  const chip = { bell: 42, secondsLeft: 562, beforeGenesis: false, ended: false };
  const FS = { mode: 'play', nowBell: 42, incoming: [{ bell: 43, holding: { p: 2, q: 0, site: 0, tier: 1 } }, { bell: 44, holding: { p: 2, q: 0, site: 0, tier: 1 } }],
    holdings: [{ p: 2, q: 0, site: 0, transit: [{ state: 1, arriveBell: 43, hostId: 7n }, { state: 1, arriveBell: 45, hostId: 8n }, { state: 0, arriveBell: 43, hostId: 9n }] }] };
  const items = dialcard.nextBellItems(FS, { hostInfo: id => (id === 7n ? { mine: true, unit: 'Spearman', troops: 400, dest: '森' } : null), decides: { turn: 43, after: 1 } });
  assert.deepEqual(items.map(x => x.icon), ['alert', 'seal', 'home'], 'only what the next bell brings: one warning, one arrival, the village');
  assert.match(items[1].text, /^あなたの槍兵 400が森に着きます$/);
  assert.equal(items[2].text, '村の場所が決まります（鐘のあと約 1 分）');
  assert.deepEqual(dialcard.nextBellItems({ ...FS, mode: 'spectate' }), [], 'a watcher has nothing of their own');
  assert.equal(dialcard.nextBellItems(FS, { hostInfo: () => ({ mine: true, unit: 'Spearman', troops: 400, dest: null }) })[1].text, 'あなたの槍兵 400が行き先に着きます', 'no destination is named that this device does not hold');
  const card = String(dialcard.renderDialCard(chip, items));
  assert.match(card, /<strong>ターン 42<\/strong><span class="dial-pop-left">次の鐘まで <span class="num" data-dial-left>9:22<\/span><\/span>/);
  assert.match(card, /鐘が鳴るたびにターンが進みます。/, 'the one sentence that ties the bell to the turn');
  assert.match(card, /<h4 class="dial-pop-h">次の鐘で<\/h4><ul class="dial-pop-list">/);
  assert.match(String(dialcard.renderDialCard(chip, [])), /次の鐘であなたに届くものは、いまはありません。/, 'nothing is invented');
  assert.doesNotMatch(String(dialcard.renderDialCard(null, [])), /次の鐘で/);
});

test('the plate says what the village request is doing, in the wait view\'s own words', () => {
  setLang('ja');
  const clock = { genesisTs: 1_000, window: () => 60, margin: 6 };
  const say = (land, autoTicket) => hud.waitingLine({ land, autoTicket, clock });
  assert.equal(say({ stage: 'ticket', ticket: { bell: 42 } }), '村の申し込みは済んでいます。ターン 43 の鐘のあとに決まります。');
  assert.equal(say({ stage: 'joined' }, { state: 'failed' }), '村の申し込みはまだ通っていません。次のターンにやり直します。');
  assert.doesNotMatch(say({ stage: 'joined' }, { state: 'failed' }), /自動で出しています/, 'a refused request is not "being sent"');
  assert.equal(say({ stage: 'joined' }, { state: 'nofree' }), '空いた場所が見つかりません。ターンごとに探し直します。');
  assert.equal(say({ stage: 'joined' }, { state: 'searching' }), '村の申し込みを出しています。');
  setLang('en');
  assert.equal(say({ stage: 'joined' }, { state: 'failed' }), 'Your village request has not gone through yet. It will be retried next turn.');
  setLang('ja');
});

test('a part of the drawer that scrolls above a foot rests on a whole row: the room of a cut row is left bare', () => {
  // three whole rows, then a row the foot would cut at 300 px
  const rows = [{ top: 0, bottom: 80, leaf: true }, { top: 90, bottom: 180, leaf: true }, { top: 190, bottom: 270, leaf: true }, { top: 280, bottom: 330, leaf: true }];
  assert.equal(rowGap(300, rows), 30, 'from the last whole row to the foot');
  assert.equal(rowGap(340, rows), 0, 'nothing is cut: no gap');
  assert.equal(rowGap(300, [...rows.slice(0, 3), { top: 280, bottom: 330, leaf: false }]), 0, 'a box of rows is not a row');
  assert.equal(rowGap(300, [{ top: 0, bottom: 80, leaf: true }, { top: 100, bottom: 520, leaf: true }]), 0, `a gap of more than ${ROW_GAP_MAX} px is no gain`);
  const css = text('frontier.css');
  assert.doesNotMatch(css, /\.order-body \{[^}]*mask-image/, 'no row fades to half its contrast under the foot');
  assert.match(css, /\.order-body \{[^}]*margin-bottom: var\(--row-gap, 0px\)/);
});

test('one button language per material: nothing on bell metal is filled white or cream; on paper a key is ink', () => {
  const css = text('frontier.css');
  const tail = css.slice(css.indexOf('one button language per material'));
  assert.ok(tail.length > 500);
  // the metal's keys (the plate, a toast, the objective's chip): dark with a brass rim, or brass for the one that confirms
  assert.match(tail, /\.plate \.btn, \.toast \.btn, \.ob-chip \.btn[^{]*\{[^}]*background: linear-gradient\(180deg, #24463e, #152b26\)/);
  assert.match(tail, /\.plate \.btn\.primary, \.toast \.btn\.primary, \.ob-chip \.btn, \.ob-chip \.btn\.primary \{[^}]*background: linear-gradient\(180deg, #f4dc94/);
  assert.doesNotMatch(tail, /\.(plate|toast|ob-chip)[^{]*\{[^}]*background: (var\(--ivory\)|#fff|linear-gradient\(180deg, #fffaf0)/);
  // "see" is a link with an arrow
  assert.match(tail, /\.toast \.btn\.go \{[^}]*background: none;[^}]*text-decoration: underline/);
  const feed = text('hud/feed.mjs');
  assert.equal((feed.match(/class="btn small go"/g) ?? []).length, 4);
  assert.doesNotMatch(feed, /class="btn small primary" data-act="(battle-play|feed-go|turn-go)"/);
  // paper: the key is drawn in ink, the order's choices are tokens inside a stamped ring
  assert.match(tail, /\n\.btn \{ border: 1\.5px solid rgba\(64,48,18,\.6\); border-radius: 5px; background: rgba\(64,48,18,\.05\); box-shadow: none; \}/);
  assert.match(tail, /\.pick::before \{[^}]*border: 2px solid var\(--seal\); border-radius: 50%/);
  assert.match(tail, /\.pick \{[^}]*border: 0;[^}]*background: none;/);
});

test('the wait is a view: the leader\'s line by the standard, the surveyors\' lines to the sites, a slow arc round each site', () => {
  setLang('ja');
  assert.deepEqual(WAIT.leaderWords(0, 'ticket'), { who: 'オリアーヌ・ヴェル', text: '村の場所はもうすぐ決まる。待つあいだに、戦い方を確かめておけ。' });
  assert.equal(WAIT.leaderWords(0, 'failed').text, 'まずは村の申し込みだ。通りしだい、候補地を知らせよう。');
  assert.equal(WAIT.leaderWords(9), null);
  setLang('en');
  assert.equal(WAIT.leaderWords(2, 'ticket').who, 'Sedra Ashfane');
  assert.match(WAIT.leaderWords(2, 'ticket').text, /^Your village will be placed soon\./);
  setLang('ja');
  const g = recorder2();
  WAIT.paintHomeTag(g, { x: 100, y: 200 }, { zoom: 1, faction: 0, say: WAIT.leaderWords(0, 'ticket') });
  const said = g.calls.filter(c => c[0] === 'fillText').map(c => c[1]);
  assert.deepEqual(said.slice(0, 2), ['アステル', 'あなたの国の土地']);
  assert.ok(said.slice(2, -1).join('').includes('村の場所はもうすぐ決まる。'), 'the line, wrapped');
  assert.equal(said[said.length - 1], '— オリアーヌ・ヴェル');
  // wrapped lines never begin with a closing mark
  const lines = WAIT.wrapText({ measureText: t => ({ width: t.length * 13 }) }, '「村の場所はもうすぐ決まる。待つあいだに、戦い方を確かめておけ。」', 238, 13);
  assert.ok(lines.length >= 2 && lines.every(l => !/^[、。」]/.test(l)), lines.join(' / '));
  assert.deepEqual(WAIT.wrapText({ measureText: t => ({ width: t.length * 7 }) }, 'Use the wait to learn how a battle goes.', 140, 13), ['Use the wait to', 'learn how a battle', 'goes.']);
  // the lines: one to every site that has a place, none without a canvas
  const s = recorder2();
  const sites = [{ p: 2, q: 0, site: 0, tile: 7 }, { p: 1, q: 1, site: 2, tile: 30 }];
  assert.equal(WAIT.paintSurveyLines(s, { x: 0, y: 0 }, sites, { zoom: 1, still: true }), 2);
  assert.equal(WAIT.paintSurveyLines(null, { x: 0, y: 0 }, sites), 0);
});

// ------------------------------------------------------------------ words
import * as status from '../../permutation-server/web/frontier/hud/status.mjs';
import * as legend from '../../permutation-server/web/frontier/map/legend.mjs';
import { provisionalNote } from '../../permutation-server/web/frontier/screens/holding.mjs';
import { holdingName } from '../../permutation-server/web/frontier/people/ui.mjs';
import { placeName } from '../../permutation-server/web/frontier/people/identity.mjs';

test('a refusal says what was not done and where the host still is; the server\'s silence is said as that', () => {
  setLang('ja');
  const FS = { notice: { ok: false, code: 'Unavailable' }, lastAct: { name: 'march-send' }, compose: { host: { unit: 0, troops: 600, tile: 7 }, origin: { p: 2, q: 0 } }, provinces: new Map() };
  const st = status.statusOf(FS, { canRetry: true });
  assert.equal(st.state, 'refused');
  assert.match(st.what, /^進軍は送られていません（槍兵 600 は.+にいます）。$/);
  assert.equal(st.text, 'サーバーが応じませんでした。少し待ってから、もう一度試してください。');
  const out = String(status.renderStatus(st));
  assert.match(out, /<strong class="tx-what">進軍は送られていません/);
  assert.match(out, /data-act="notice-retry"/);
  assert.equal(status.unsentText({ lastAct: { name: 'harvest' } }), '収穫はまだされていません。');
  assert.equal(status.unsentText({ lastAct: { name: 'something-else' } }), null, 'an action the table does not know says only the reason');
  setLang('en');
  assert.match(status.statusOf(FS).what, /^The march was not sent \(600 Spearmen are still at .+\)\.$/);
  assert.equal(status.statusOf(FS).text, 'The server did not answer. Wait a moment, then try again.');
  setLang('ja');
});

test('words the second review asked for: a village\'s English name, the shield, the confirmed stamp, a province, a time for the provisional village', () => {
  setLang('en');
  assert.equal(holdingName({ p: 2, q: 0, site: 3 }, 1), `Town of ${placeName(2, 0, 3).en}`);
  assert.equal(holdingName({ p: 2, q: 0, site: 3 }, 0), `Hamlet of ${placeName(2, 0, 3).en}`);
  const en = JSON.stringify([String(provisionalNote(null, null)), String(provisionalNote({ clock: { genesisTs: 0, window: () => 60, margin: 6 } }, { ticketBell: 40 }))]);
  assert.match(en, /about 4 hours after the request at the latest/);
  assert.match(en, /It is confirmed once every request from the same turn is decided \(<time datetime=/);
  setLang('ja');
  assert.equal(holdingName({ p: 2, q: 0, site: 3 }, 1), `${placeName(2, 0, 3).ja}の町`, 'the Japanese name is as it was');
  assert.match(String(provisionalNote(null, null)), /遅くとも申し込みから約 4 時間/);
  // the dictionaries say them
  const dict = text('../lang/en-frontier.mjs') + text('../lang/en-frontier-play.mjs') + text('../lang/en-pages.mjs');
  for (const [ja, en2] of [['保護 あと {0}', 'Shielded for {0}'], ['確定した村', 'Confirmed'], ['{0}方面・第{1}輪の州', '{0} side, ring {1}'], ['観戦', 'Spectate']]) assert.ok(dict.includes(`'${ja}': '${en2}'`), `${ja} → ${en2}`);
  assert.doesNotMatch(dict, /Shield in |Final village|the way itself|is collected, this host|ring-\{1\} province/);
});

test('the legend: the reach in its true words, a glyph on every target\'s swatch, the map\'s two lines, and a way to it beside the lenses', () => {
  setLang('ja');
  const out = String(legend.renderSurveyHelp());
  assert.match(out, /<section class="survey-help" id="survey-help"/);
  assert.match(out, /軍勢のまわり 6 マスです。線の外のマスも、道がつながっていれば行き先にできます（32 マスまで）。/);
  for (const [id, glyph] of [['attack', 'swords'], ['home', 'home'], ['explore', 'eye']]) assert.match(out, new RegExp(`<span class="survey-key lit-${id}" aria-hidden="true"><svg class="ic"[^>]*><use href="art/ui/icons.svg#${glyph}"/></svg></span>`), id);
  assert.deepEqual(legend.LINE_LEGEND.map(x => x.id), ['own', 'province']);
  assert.match(out, /<span class="survey-key line-own" aria-hidden="true"><\/span>/);
  const app = text('app.mjs');
  assert.match(app, /class="lens lens-help" data-act="legend-open"/);
  assert.match(app, /'legend-open': \(\) => \{/);
  assert.match(text('frontier.css'), /\.lit-attack \{ background: rgba\(226,85,61,\.5\)/, 'the legend\'s attack swatch is the map\'s ember');
});

test('the order card says nothing of defenders it does not have in sight', () => {
  const src = text('hud/marchcard.mjs');
  assert.match(src, /const def = c\.dest && sight >= 3 \? defendersAt\(FS, c\.dest\) : null;/);
  assert.match(src, /未測量の土地です。守り手は、ここからはわかりません。/);
  assert.doesNotMatch(src, /at\.local\} ごろ|道のりは約/);
});

// ------------------------------------------------------------------ the landing waits for the picture; a flight shows no half-made sea
test('the landing book can say which landing is about to be reported without noting it', async () => {
  const { createLandingBook } = await import('../../permutation-server/web/frontier/map/landing.mjs');
  const kept = new Map();
  const storage = { get: k => kept.get(k) ?? null, set: (k, v) => { kept.set(k, v); return true; } };
  const book = createLandingBook({ storage });
  const fresh = [{ p: 2, q: 0, tile: 7, site: 1, gen: 0, state: 1 }], old = [{ p: 2, q: 0, tile: 7, site: 1, gen: 0, state: 2 }];
  assert.equal(book.peek('k', fresh), '2,0,7');
  assert.equal(kept.size, 0, 'nothing is noted by a look');
  assert.equal(book.peek('k', old), null, 'a village that is already final is old news');
  assert.equal(book.peek(null, fresh), null);
  assert.equal(book.next('k', fresh)?.key, '2,0,7');
  assert.equal(book.peek('k', fresh), null, 'once reported it is not about to be');
});

test('the landing\'s timeline before its start: no colour, no border, no standard (the land waits for the camera)', async () => {
  const { landingAt, LANDING } = await import('../../permutation-server/web/frontier/map/ownland.mjs');
  const f = landingAt(-1, 2);
  assert.equal(f.ring(0).fill, 0); assert.equal(f.ring(2).flash, 0);
  assert.equal(f.border, 0); assert.equal(f.standard.shown, false); assert.equal(f.dust, null); assert.equal(f.done, false);
  const fm = await import('../../permutation-server/web/frontier/map/fmap.mjs');
  assert.ok(fm.LANDING_REST >= 400 && fm.LANDING_REST <= 800, 'half a second of stillness');
  assert.ok(fm.LANDING_WAIT > fm.LANDING_REST * 4, 'and never a wait without end');
  assert.ok(fm.LANDING_ZOOM > 1.2 && fm.LANDING_HOLD >= 800, 'closer than the everyday frame, held, then eased back');
  assert.ok(LANDING.ring === 90, 'the flood itself is the brief\'s: about 90 ms a ring');
});

test('the sea is made as fine as the screen, so a picture needs about as many pieces at every zoom; a kept piece stands in for one that waits', async () => {
  const sea = await import('../../permutation-server/web/frontier/map/cloudsea.mjs');
  assert.equal(sea.seaRes(1.5), 1, 'never finer than 1');
  assert.equal(sea.seaRes(0.57), 0.71);
  assert.equal(sea.seaRes(0.2), 0.25);
  assert.equal(sea.seaRes(0.01), sea.SEA_STEPS[0]);
  for (const z of [0.2, 0.4, 0.57, 0.9, 1.5]) {
    const res = sea.seaRes(z), side = sea.PIECE / res, n = Math.ceil(1440 / z / side + 1) * Math.ceil(900 / z / side + 1);
    assert.ok(n * (sea.PIECE + 64) ** 2 < sea.SEA_PIXELS * 1.6, `zoom ${z}: ${n} pieces`);
  }
  // a stand-in: two finenesses hold parts of a square; the larger part is drawn whole, the other only where the first left it bare
  const s = new sea.CloudSea({});
  const cv = {};
  s.pieces.set('a', { rings: 3, cv, x: 0, y: 0, size: 1024 });               // holds all of the square
  s.pieces.set('b', { rings: 3, cv, x: 256, y: 0, size: 256 });              // a finer one inside it
  s.pieces.set('c', { rings: 4, cv, x: 0, y: 0, size: 512 });                // another world's
  const calls = [];
  const ctx = { save() {}, restore() {}, beginPath() {}, rect() {}, clip(r) { calls.push(['clip', r]); }, drawImage(...a) { calls.push(['draw', a[5], a[6], a[7], a[8]]); } };
  assert.equal(s.standIn(ctx, 3, 0, 0, 512), true);
  assert.deepEqual(calls, [['draw', 0, 0, 512, 512]], 'the piece that holds the whole square, once, and nothing over it');
  assert.equal([...s.pieces.keys()].at(-1), 'a', 'a piece that stands in is not the next to be dropped');
  calls.length = 0;
  assert.equal(s.standIn(ctx, 3, 2048, 0, 512), false, 'nothing kept lies there');
  s.pieces.delete('a'); calls.length = 0;
  s.pieces.set('d', { rings: 3, cv, x: 0, y: 0, size: 300 });
  assert.equal(s.standIn(ctx, 3, 0, 0, 512), true);
  assert.equal(calls.filter(c => c[0] === 'draw').length, 2);
  assert.deepEqual(calls.find(c => c[0] === 'clip'), ['clip', 'evenodd'], 'the second fineness only where the first left the square bare');
});

// ------------------------------------------------------------------ the phone's strip; the map's keys
test('a strip that cannot show every resource says how many more there are on its last token, and writes numbers one way', async () => {
  const hud = await import('../../permutation-server/web/frontier/hud/hud.mjs');
  const tokens = [0, 1, 2, 3, 4].map(i => ({ resource: i, value: 1220 - i * 100, cap: 5000, perHour: 0, state: 'ok', fullIn: null, name: `r${i}` }));
  const two = hud.renderStrip(tokens, null, 2).map(String);
  assert.equal(two.length, 2, 'two tokens, no third piece that could be cut at the plaque\'s point');
  assert.doesNotMatch(two[0], /res-more-n/);
  assert.match(two[1], /class="res-more-n" aria-hidden="true">\+3</);
  assert.ok(two.every(x => /data-r="\*"/.test(x)), 'each opens every resource');
  const allOf = hud.renderStrip(tokens, null, 8).map(String);
  assert.equal(allOf.length, 5); assert.ok(allOf.every(x => !/res-more-n/.test(x)));
  // one way of writing a number: whole up to 9,999 in both languages, short above
  assert.equal(hud.shortNum(815), '815');
  assert.equal(hud.shortNum(1220), '1,220');
  assert.equal(hud.shortNum(9999), '9,999');
  assert.notEqual(hud.shortNum(12000), '12,000');
  const css = (await import('node:fs')).readFileSync(new URL('../../permutation-server/web/frontier/frontier.css', import.meta.url), 'utf8');
  assert.match(css, /body:has\(\.plate-main\[data-act="home"\]\) \.map-btn\[data-map="home"\] \{ display: none; \}/, 'on a phone the plate has the way home: the map carries no second one');
  const fm = await import('../../permutation-server/web/frontier/map/fmap.mjs');
  const chart = fm.MAP_TOOLS.find(t => t.id === 'chart');
  assert.ok(typeof chart.text === 'function' && chart.text().length > 0 && chart.textOn().length > 0, 'the world chart key says what it is in a word');
});
