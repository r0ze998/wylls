// territory-video-3 (owner, 2026-11-24 on evidence/territory-video-2: 「それは隠れてて見にくいな。改善したい。」 and
// 「自分の領土が枠で囲われているようなのがよくない？」): the wide land's ownership must read at a glance, fog kept.
//  - each nation's land carries its own border round the union of its provinces (map/wideland.mjs paintNationBorders:
//    the cell's `rim`, both sides of a border between nations, none between two provinces of one nation, none for no
//    nation's land or a holder the fog never saw);
//  - one name per region, not per province (two Aster provinces side by side read "Lands of Aster" twice);
//  - another nation's standing host says its nation ("Aster · 300 troops");
//  - a legend lists only the holders the frame drew (the fogged land), viewer first;
//  - the folded test-world notice leaves the dock (the host card covered all but its title).
// Synthetic data only: no keys, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { landOfCells, paintWideLand, paintNationBorders, holdersOf, borderNation, NEUTRAL, NATION_BORDER } from '../../permutation-server/web/frontier/map/wideland.mjs';
import { wideRegions, wideHostWords, paintWideNames, PLATE_MIN_PX } from '../../permutation-server/web/frontier/map/widemarks.mjs';
import { wideLegendRows, mountWideLegend, WIDE_LEGEND_ID } from '../../permutation-server/web/frontier/map/widelegend.mjs';
import { NATION_LAND, NATION_DARK } from '../../permutation-server/web/frontier/palette.mjs';
import { provincePixel, PROVINCE_CIRCUMRADIUS } from '../../permutation-server/web/frontier/map/layers.mjs';
import { setLang } from '../../permutation-server/web/lang.mjs';

const VIEWER = 3, ASTER = 0, CINDER = 2;
const ALL = { x0: -1e9, y0: -1e9, x1: 1e9, y1: 1e9 };
/** A wide cell as wideland.mjs makes one (no capture: holder given), at province (p, q). */
const cell = (p, q, holder, extra = {}) => {
  const c = provincePixel(p, q), r = PROVINCE_CIRCUMRADIUS;
  return { p, q, key: `${p},${q}`, ring: 200, wedge: 0, holder, villages: [], terrain: null, keep: null, hosts: [], colour: '#c8bb98', x: c.x, y: c.y, box: { x0: c.x - r, y0: c.y - r, x1: c.x + r, y1: c.y + r }, ...extra };
};
const landOf = cells => landOfCells(cells, { rings: { min: 200, max: 200 }, reach: 201 });
/** A recording 2D context: every stroke with its style, width, alpha and segment count; clip calls. */
function recorder() {
  const log = { strokes: [], clips: 0, fills: [] };
  let segs = 0;
  const ctx = new Proxy({ globalAlpha: 1 }, {
    get: (t, k) => {
      if (k in t) return t[k];
      if (k === 'beginPath') return () => { segs = 0; };
      if (k === 'moveTo') return () => { segs++; };
      if (k === 'stroke') return () => log.strokes.push({ style: t.strokeStyle, width: t.lineWidth, alpha: t.globalAlpha, segs, dash: t._dash ?? 0 });
      if (k === 'fill') return () => log.fills.push({ style: t.fillStyle, alpha: t.globalAlpha });
      if (k === 'clip') return () => { log.clips++; };
      if (k === 'setLineDash') return d => { t._dash = d.length; };
      if (k === 'measureText') return () => ({ width: 40 });
      if (/Gradient|Pattern/.test(k)) return () => ({ addColorStop() {} });
      return () => {};
    },
    set: (t, k, v) => { t[k] = v; return true; },
  });
  return { ctx, log };
}

test('the nation border runs round the UNION of a nation\'s provinces: none between its own, both sides between nations', () => {
  // two of the viewer's provinces side by side, an Aster one beside them, a no-nation's one
  const land = landOf([cell(0, 0, VIEWER), cell(1, 0, VIEWER), cell(2, 0, ASTER), cell(0, 1, NEUTRAL)]);
  const [a, b, c, n] = land.cells;
  assert.equal(a.rim.length, 5, 'six sides less the one shared with its own nation');
  assert.equal(b.rim.length, 5, 'its own neighbour gives no border; the Aster side does');
  assert.equal(c.rim.length, 6, 'Aster borders the viewer on one side, no recorded land on five');
  assert.equal(n.rim.length, 6);
  assert.deepEqual([borderNation(a), borderNation(c), borderNation(n)], [VIEWER, ASTER, null], 'no nation\'s land carries no nation border');
  // the viewer's and Aster's border on their shared edge: the same corner pair on each side
  const key = e => [e.a, e.b].map(p => p.map(v => v.toFixed(1)).join(',')).sort().join('|');
  const shared = b.rim.map(key).filter(k => c.rim.map(key).includes(k));
  assert.equal(shared.length, 1, 'one shared edge, drawn on both sides (each nation\'s colour in its own land)');
});

test('the fog: a province whose holder was never seen carries no border and is not washed as "no nation\'s"', () => {
  const unknown = cell(1, 0, null, { holderKnown: false });
  const land = landOf([cell(0, 0, VIEWER), unknown]);
  assert.equal(borderNation(land.byKey.get('1,0')), null);
  assert.equal(land.byKey.get('0,0').rim.length, 6, 'the viewer\'s border runs along the unknown province too');
  const { ctx, log } = recorder();
  const out = paintWideLand(ctx, land, { seen: ALL, zoom: 1, level: 'province' });
  assert.deepEqual(out.holders, [VIEWER], 'the legend is told only the known holder');
  assert.deepEqual(out.borders, [VIEWER]);
  assert.ok(!log.fills.some(f => f.style === '#b9b29a'), 'nothing is filled in the no-nation colour');
  assert.deepEqual(holdersOf([cell(0, 0, ASTER), cell(1, 0, NEUTRAL), cell(2, 0, null, { holderKnown: false }), cell(3, 0, ASTER)]), [ASTER, NEUTRAL]);
});

test('the border is painted in the nation\'s land colour with a dark seam, clipped to its own land, at every near level', () => {
  const land = landOf([cell(0, 0, VIEWER), cell(1, 0, VIEWER), cell(2, 0, ASTER)]);
  for (const level of ['world', 'province', 'tile']) {
    const { ctx, log } = recorder();
    const r = paintNationBorders(ctx, land.cells, { zoom: 0.5, level });
    assert.deepEqual(r.nations, [ASTER, VIEWER]);
    assert.equal(log.clips, 2, `${level}: one clip a nation`);
    const look = NATION_BORDER[level];
    const band = log.strokes.find(s => s.style === NATION_LAND[VIEWER] && s.alpha === 1);
    assert.ok(band, `${level}: the band in the viewer's land colour`);
    assert.equal(band.width, 2 * look.band / 0.5, 'centred on the edge, twice the band (the outer half is clipped away), in screen px');
    assert.equal(band.segs, 10, 'all ten rim edges of the two provinces in one path');
    assert.ok(log.strokes.some(s => s.style === NATION_DARK[VIEWER] && s.width === 2 * look.seam / 0.5), `${level}: the dark seam`);
    assert.ok(log.strokes.some(s => s.style === NATION_LAND[ASTER]), 'and Aster\'s own');
  }
  // from afar (the enlarged mosaic of the chart) the land is the nations' colours themselves: no border pass
  const { ctx, log } = recorder();
  paintWideLand(ctx, land, { seen: ALL, zoom: 0.0005, level: 'chart' });
  assert.equal(log.clips, 0);
});

test('one name per nation in view, on its largest region, and only where provinces are big enough on screen to carry it', () => {
  const land = landOf([cell(0, 0, ASTER), cell(1, 0, ASTER), cell(3, 0, ASTER), cell(0, 1, VIEWER), cell(5, 0, null, { holderKnown: false })]);
  const regions = wideRegions(land, ALL);
  assert.deepEqual(regions.map(r => [r.holder, r.cells.length]), [[ASTER, 2], [ASTER, 1], [VIEWER, 1]], 'the unknown province is in no region');
  const { ctx } = recorder();
  // (plates stand only well inside the picture: here the whole land is in the middle of a 1280×800 picture)
  const at = { screen: () => ({ x: 640, y: 400 }), bounds: { w: 1280, h: 800 } };
  const n = paintWideNames(ctx, land, { seen: ALL, zoom: 0.3, level: 'province', viewer: VIEWER, ...at });
  assert.equal(n, 2, 'Aster once (its two-province region), the viewer once — not four, one per province (live: nine over eleven)');
  assert.ok(2 * PROVINCE_CIRCUMRADIUS * 0.3 >= PLATE_MIN_PX && 2 * PROVINCE_CIRCUMRADIUS * 0.2 < PLATE_MIN_PX);
  assert.equal(paintWideNames(ctx, land, { seen: ALL, zoom: 0.2, level: 'province', viewer: VIEWER, ...at }), 0, 'provinces too small on screen: the colours and the legend say it');
});

test('another nation\'s standing host says its nation; the viewer\'s own says its troops (English and Japanese)', () => {
  setLang('en');
  try {
    assert.equal(wideHostWords({ faction: ASTER, troops: 300, count: 1 }, VIEWER), 'Aster · 300 troops');
    assert.equal(wideHostWords({ faction: CINDER, troops: 1200, count: 2 }, VIEWER), 'Cinder · 1,200 troops (+ others)');
    assert.equal(wideHostWords({ faction: VIEWER, troops: 44, count: 1 }, VIEWER), '44 troops');
  } finally { setLang('ja'); }
  assert.equal(wideHostWords({ faction: ASTER, troops: 300, count: 1 }, VIEWER), 'アステル · 兵 300');
  assert.equal(wideHostWords({ faction: VIEWER, troops: 44, count: 2 }, VIEWER), '兵 44 ほか');
});

test('the legend lists only the holders drawn — the viewer first, other nations by name, then no nation', () => {
  setLang('en');
  try {
    assert.deepEqual(wideLegendRows([NEUTRAL, ASTER, VIEWER], VIEWER).map(r => [r.key, r.text]), [['n3', 'Your nation (Dunmar)'], ['n0', 'Aster'], ['none', 'No nation']]);
    assert.deepEqual(wideLegendRows([CINDER], VIEWER).map(r => r.text), ['Cinder'], 'the viewer\'s row only when its land is drawn');
  } finally { setLang('ja'); }
  assert.deepEqual(wideLegendRows([], VIEWER), []);
  assert.deepEqual(wideLegendRows([VIEWER], VIEWER).map(r => r.text), ['あなたの国（ダンマール）']);
  // (the page: shown with rows, hidden without, rewritten only when the rows change)
  const made = [];
  const el = tag => { const e = { tag, children: [], attrs: {}, dataset: {}, hidden: false, id: '', className: '', _t: '', writes: 0,
    set textContent(v) { e._t = v; if (v === '') e.children = []; e.writes++; }, get textContent() { return e._t; },
    setAttribute(k, v) { e.attrs[k] = v; }, append(...xs) { e.children.push(...xs); }, remove() { e.gone = true; } }; made.push(e); return e; };
  const body = el('body'), doc = { createElement: el, body, querySelector: () => null };
  const lg = mountWideLegend({ doc });
  assert.equal(lg.el.id, WIDE_LEGEND_ID);
  assert.equal(lg.el.hidden, true, 'nothing drawn yet');
  lg.update({ holders: [ASTER, VIEWER] }, VIEWER);
  assert.equal(lg.el.hidden, false);
  const writes = lg.el.writes;
  lg.update({ holders: [ASTER, VIEWER] }, VIEWER);
  assert.equal(lg.el.writes, writes, 'the same rows: the box is not rewritten');
  const rows = lg.el.children[1].children.map(li => li.children[0].attrs['data-key']);
  assert.deepEqual(rows, ['n3', 'n0'], 'swatches by class key (no inline style)');
  lg.update(null, VIEWER);
  assert.equal(lg.el.hidden, true, 'no wide land drawn: no legend');
});

test('the legend\'s swatches are the land colours of the palette; it stands in the label pass\'s no-go list', async () => {
  const css = readFileSync(new URL('../../permutation-server/web/frontier/frontier.css', import.meta.url), 'utf8');
  for (let i = 0; i < 6; i++) assert.ok(css.includes(`.wide-legend-swatch[data-key="n${i}"] { background: ${NATION_LAND[i]}; border-color: ${NATION_DARK[i]}; }`), `nation ${i}`);
  assert.match(css, /#wide-legend \{ position: fixed;[^}]*pointer-events: none; \}/);
  const { NO_GO } = await import('../../permutation-server/web/frontier/hud/insets.mjs');
  assert.ok(NO_GO.some(([id, sel]) => id === 'wide-legend' && sel === '#wide-legend'));
  const { NOGO_SELECTORS } = await import('../../permutation-server/web/frontier/map/fmap.mjs');
  assert.ok(NOGO_SELECTORS.includes('#wide-legend'));
  const app = readFileSync(new URL('../../permutation-server/web/frontier/app.mjs', import.meta.url), 'utf8');
  assert.ok(app.includes("onPainted: () => wideLegendRef?.update(map?.wideDrawn ?? null, FS.citizen?.faction ?? null),"), 'the page feeds it the frame\'s drawn holders');
});

test('the folded test-world notice stands at the left under the strip, not over the dock where the host card covered it', () => {
  const css = readFileSync(new URL('../../permutation-server/web/frontier/flocalplay.css', import.meta.url), 'utf8');
  const rule = css.match(/#local-play-session\[data-fold="folded"\] \{([^}]*)\}/)?.[1] ?? '';
  assert.match(rule, /top: calc\(var\(--strip\)/);
  assert.match(rule, /bottom: auto/);
  assert.match(rule, /left: var\(--edge\)/);
  assert.match(rule, /translate: none/);
  assert.doesNotMatch(rule, /--dock-h/);
});
