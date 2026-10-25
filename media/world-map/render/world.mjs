// The world map of one recorded season, painted by the game's own map painters
// (permutation-server/web/frontier/map/*): the land, villages, camps, the Concord
// and its bell tower, keeps and their standards, hosts, and the cloud sea past the
// open rings. Every layer is its own canvas at the same size and origin, so they
// can be shown, hidden and stacked in any editor:
//
//   base      the land and everything that stands on it, no words (the deliverable)
//   realms    the six nations' lands as the world chart washes them, and their rims
//   grid      province edges (thin) over the land
//   routes    a COMPLEMENT (制作上の補完): the passes between neighbouring provinces
//             joined keep to keep, as a reading aid; not roads of the rules
//   labels    nation names, the Concord, village names (in the game's own words)
//
// window.WORLD = { ready: Promise, layers: {name: canvas}, info } once painted.
// Query: ?data=season-94.json&scale=1.25&lang=ja|en&extra=2 (cloud rings past the open ones)
import { SpriteArt } from '../../../permutation-server/web/frontier/map/sprites.mjs';
import { CloudSea } from '../../../permutation-server/web/frontier/map/cloudsea.mjs';
import { paintKeepFortress, KEEP_LOOK } from '../../../permutation-server/web/frontier/map/keeps.mjs';
import { FORTRESS } from '../../../permutation-server/web/frontier/map/village.mjs';
import { paintStandard } from '../../../permutation-server/web/frontier/map/ownland.mjs';
import { project, RADIUS, FLATTEN } from '../../../permutation-server/web/map.mjs';
import { tileHex, ringProvinces, wedgeOf, provinceCentre, DIRECTIONS } from '../../../permutation-server/web/frontier/fgeo.mjs';
import { TERRAIN } from '../../../permutation-server/web/frontier/wasm.mjs';
import { decode } from '../../../permutation-server/web/frontier/fcodec.mjs';
import { FS } from '../../../permutation-server/web/frontier/fstate.mjs';
import { setLang, L } from '../../../permutation-server/web/lang.mjs';
import { factionName, FACTION_COLORS } from '../../../permutation-server/web/frontier/fi18n.mjs';
import { holdingName } from '../../../permutation-server/web/frontier/people/ui.mjs';
import { NATION_INK } from '../../../permutation-server/web/frontier/palette.mjs';
import { paintLife } from './life.mjs';

const q = new URLSearchParams(location.search);
const DATA = q.get('data') ?? 'season-94.json';
const S = Number(q.get('scale') ?? 1.25);          // canvas px per world px
const EXTRA = Number(q.get('extra') ?? 2);          // cloud rings past the open ones
const LANG = q.get('lang') ?? 'ja';
const ONLY = (q.get('layers') ?? 'base,land,life,realms,grid,routes,labels,names').split(',');
// the conquest art (the handover pack's soldiers): the page shows it on a conquest season
FS.season = { layoutVersion: 2, programVersion: 4 };
setLang(LANG === 'en' ? 'en' : 'ja');

const world = await (await fetch(`../data/${DATA}`)).json();
const provs = world.provinces.map(p => ({ ...p, prov: decode('Province', Uint8Array.from(atob(p.bytes), c => c.charCodeAt(0)), { profile: 3 }) }));
const open = Math.max(...provs.map(p => p.ring)) + 1;
// ---- the DEMO population (制作上の補完, media/world-map/scripts/demo-state.mjs): laid onto the decoded accounts in the
// rules' own shapes, so the game's painters draw it as they would a record
const DEMO = q.get('demo');
const demo = DEMO ? await (await fetch(`../data/${DEMO}`)).json() : null;
const clashOf = new Map();
if (demo) {
  const at = new Map(provs.map(p => [`${p.p},${p.q}`, p]));
  for (const v of demo.villages) {
    const pv = at.get(`${v.p},${v.q}`)?.prov, m = pv?.siteMirror?.[v.site];
    if (!m || m.state !== 0) continue;
    Object.assign(m, { state: 1, faction: v.faction, tier: v.tier, wallsCommitted: v.walls ? 1n : 0n, garrison: BigInt(v.garrison * 1000), shieldUntilBell: 0 });
  }
  for (const h of demo.hosts) {
    const pv = at.get(`${h.p},${h.q}`)?.prov;
    if (!pv) continue;
    pv.entries = [...pv.entries, { id: BigInt(h.id), faction: h.faction, unit: h.unit, tile: h.tile, state: 1, troops: BigInt(h.troops * 1000), staminaValue: 120, readyBell: 0, fromBell: 0 }];
  }
  for (const c of demo.contests) { const pv = at.get(`${c.p},${c.q}`)?.prov; if (pv?.keep) Object.assign(pv.keep, { contender: c.contender, progress: c.progress }); }
  for (const c of demo.clashes) clashOf.set(`${c.p},${c.q}`, { bell: world.lastBell, arrivals: c.arrivals });
}
const byKey = new Map(provs.map(p => [`${p.p},${p.q}`, p]));

// ---- the frame: every tile of the open rings and of EXTRA cloud rings, in world px
const entries = [];
for (let d = 0; d < open + EXTRA; d++) for (const pr of ringProvinces(d)) {
  const k = byKey.get(`${pr.p},${pr.q}`);
  entries.push(k ? { p: pr.p, q: pr.q, terrain: Array.from(k.prov.terrain), names: TERRAIN, sites: Array.from(k.prov.sites).slice(0, k.prov.siteCount), prov: k.prov, rec: null, fog: 'clear', clash: clashOf.get(`${pr.p},${pr.q}`) ?? null }
    : { p: pr.p, q: pr.q, terrain: Array(61).fill(0), names: TERRAIN, sites: [], prov: null, rec: null, fog: 'unopened' });
}
let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
for (const e of entries) for (let i = 0; i < 61; i++) { const h = tileHex(e.p, e.q, i), c = project(h.q, h.r); minX = Math.min(minX, c.x); maxX = Math.max(maxX, c.x); minY = Math.min(minY, c.y); maxY = Math.max(maxY, c.y); }
// (trim the cloud rings to a 16:9-friendly box around the land: the land's own box plus a cloud margin)
let lx0 = Infinity, ly0 = Infinity, lx1 = -Infinity, ly1 = -Infinity;
for (const e of entries) if (e.fog !== 'unopened') for (let i = 0; i < 61; i++) { const h = tileHex(e.p, e.q, i), c = project(h.q, h.r); lx0 = Math.min(lx0, c.x); lx1 = Math.max(lx1, c.x); ly0 = Math.min(ly0, c.y); ly1 = Math.max(ly1, c.y); }
const M = { x: Number(q.get('mx') ?? 520), y: Number(q.get('my') ?? 440) };   // cloud margin, world px
const REGION = q.get('region')?.split(',').map(Number) ?? null;   // x,y,w,h in world px: a close-up of the same world
const box = REGION ? { x: REGION[0], y: REGION[1], w: REGION[2], h: REGION[3] } : { x: lx0 - M.x, y: ly0 - M.y - RADIUS * 2, w: (lx1 - lx0) + 2 * M.x, h: (ly1 - ly0) + 2 * M.y + RADIUS * 2 };
const W = Math.round(box.w * S), H = Math.round(box.h * S);
const layer = () => Object.assign(document.createElement('canvas'), { width: W, height: H });
const layers = Object.fromEntries(ONLY.map(n => [n, layer()]));
const toWorld = g => g.setTransform(S, 0, 0, S, -box.x * S, -box.y * S);

// ---- the base: ground, the cloud sea past the open rings, what stands on the land, the keeps
const art = new SpriteArt({ onLoad: () => {}, onTick: () => {} });
const sea = new CloudSea({ image: (set, size, name) => art.image(set, size, name) });
const paintArgs = { zoom: S, dpr: 1, artZoom: S, ringsOpen: open, viewerFaction: null, sea: true, stamp: 1 };
// paint until every sprite asked for has arrived: three passes in a row with nothing loading and nothing newly asked
async function settle(fn, tries = 120) {
  let calm = 0, seen = -1;
  for (let i = 0; i < tries && calm < 3; i++) {
    fn();
    await new Promise(r => setTimeout(r, 150));
    const n = art.images.size;
    calm = !art.loading && n === seen ? calm + 1 : 0;
    seen = n;
  }
  fn();
}
const keeps = provs.filter(p => p.prov.keep && p.prov.ring > 0 && p.prov.keep.tile < 61).map(p => {
  const h = tileHex(p.p, p.q, p.prov.keep.tile), c = project(h.q, h.r), u = RADIUS * KEEP_LOOK.unit;
  return { p: p.p, q: p.q, x: c.x + KEEP_LOOK.at.x * RADIUS, y: c.y + KEEP_LOOK.at.y * RADIUS, u, holder: p.prov.keep.holder < 6 ? p.prov.keep.holder : null };
});
function paintLand(g) {
  g.save(); g.setTransform(1, 0, 0, 1, 0, 0); g.fillStyle = '#e7e4ec'; g.fillRect(0, 0, W, H); g.restore();
  toWorld(g);
  art.paint(g, entries, { ...paintArgs, part: 'ground' });
  // the sea over the unopened rings (still: no drift), as the world chart shows it
  sea.paint(g, { box: { x0: box.x, y0: box.y, x1: box.x + box.w, y1: box.y + box.h }, res: Math.min(1, S), ringsOpen: open, still: true, part: 'still', now: 0, bakes: 9999 });
  art.paint(g, entries, { ...paintArgs, part: 'props' });
  // keeps, back to front, each with its holder's standard on the great tower
  for (const k of [...keeps].sort((a, b) => a.y - b.y)) {
    paintKeepFortress(g, k.x, k.y, k.u, { faction: k.holder, zoom: S, dpr: 1 });
    if (k.holder !== null) paintStandard(g, k.x + FORTRESS.pole.x * k.u, k.y - FORTRESS.pole.up * k.u, { u: k.u * KEEP_LOOK.standard, zoom: S, faction: k.holder, still: true });
  }
  art.paint(g, entries, { ...paintArgs, part: 'live' });
}
function paintLifeLayer(g) { toWorld(g); return paintLife(g, provs, { clashes: demo?.clashes ?? [], keeps, open }); }

// ---- province edges and the nations' lands (the wedges), as edge lists in world px
const hexCorners = (x, y) => Array.from({ length: 6 }, (_, i) => { const a = (i * 60 - 30) * Math.PI / 180; return [x + Math.cos(a) * RADIUS, y + Math.sin(a) * RADIUS * FLATTEN]; });
const provOfTile = new Map();
for (const e of entries) for (let i = 0; i < 61; i++) { const h = tileHex(e.p, e.q, i); provOfTile.set(`${h.q},${h.r}`, e); }
function edgesWhere(test) {
  const out = [];
  for (const e of entries) {
    if (e.fog === 'unopened') continue;
    for (let i = 0; i < 61; i++) {
      const h = tileHex(e.p, e.q, i), c = project(h.q, h.r), pts = hexCorners(c.x, c.y);
      DIRECTIONS.forEach(([dq, dr]) => {
        const n = provOfTile.get(`${h.q + dq},${h.r + dr}`);
        if (n === e || !test(e, n)) return;
        const nc = project(h.q + dq, h.r + dr), mx = (c.x + nc.x) / 2, my = (c.y + nc.y) / 2;
        // the two corners nearest the midpoint of the shared edge
        const two = pts.map(p => [p, Math.hypot(p[0] - mx, p[1] - my)]).sort((a, b) => a[1] - b[1]).slice(0, 2).map(x => x[0]);
        out.push({ a: two[0], b: two[1], e, n });
      });
    }
  }
  return out;
}
function paintGrid(g) {
  toWorld(g);
  g.lineCap = 'round';
  g.strokeStyle = 'rgba(32,30,22,.38)'; g.lineWidth = 2.2 / S; g.setLineDash([6 / S, 5 / S]);
  g.beginPath();
  for (const s of edgesWhere((e, n) => n && n.fog !== 'unopened' && `${e.p},${e.q}` < `${n.p},${n.q}`)) { g.moveTo(...s.a); g.lineTo(...s.b); }
  g.stroke(); g.setLineDash([]);
}
// a province's nation on the map: the holder of its keep (the conquest record); the Concord and the ring-1
// provinces have no keep and belong to no nation
const holderOf = new Map(keeps.map(k => [`${k.p},${k.q}`, k.holder]));
const wedge = e => holderOf.get(`${e.p},${e.q}`) ?? null;
function paintRealms(g) {
  toWorld(g);
  // a light wash of each nation's colour over its wedge (the Concord stays the land's own)
  for (const e of entries) {
    const w = wedge(e);
    if (e.fog === 'unopened' || w === null) continue;
    g.fillStyle = FACTION_COLORS[w]; g.globalAlpha = 0.16;
    for (let i = 0; i < 61; i++) { const h = tileHex(e.p, e.q, i), c = project(h.q, h.r), pts = hexCorners(c.x, c.y); g.beginPath(); pts.forEach((p, j) => (j ? g.lineTo(...p) : g.moveTo(...p))); g.closePath(); g.fill(); }
  }
  g.globalAlpha = 1;
  // the rim between two nations' lands (and round the Concord): ink under the colour
  const rims = edgesWhere((e, n) => n && n.fog !== 'unopened' && wedge(e) !== wedge(n));
  g.lineCap = 'round'; g.lineJoin = 'round';
  for (const [w, c] of [[8.5, 'rgba(20,18,12,.55)']]) { g.strokeStyle = c; g.lineWidth = w / S; g.beginPath(); for (const s of rims) { g.moveTo(...s.a); g.lineTo(...s.b); } g.stroke(); }
  for (const s of rims) { const w = wedge(s.e); g.strokeStyle = w === null ? '#e9d79a' : FACTION_COLORS[w]; g.lineWidth = 4.5 / S; g.beginPath(); g.moveTo(...s.a); g.lineTo(...s.b); g.stroke(); }
}

// ---- the routes (COMPLEMENT): keep to keep through the middle of each shared border, as a dotted way
function paintRoutes(g) {
  toWorld(g);
  const at = new Map(keeps.map(k => [`${k.p},${k.q}`, k]));
  const concord = project(0, 0);
  const node = (p, q) => (p === 0 && q === 0 ? { x: concord.x, y: concord.y } : at.get(`${p},${q}`));
  g.lineCap = 'round'; g.lineJoin = 'round';
  const seen = new Set();
  for (const e of entries) {
    if (e.fog === 'unopened') continue;
    const a = node(e.p, e.q); if (!a) continue;
    for (const [dp, dq] of DIRECTIONS) {
      const n = byKey.get(`${e.p + dp},${e.q + dq}`) ?? (e.p + dp === 0 && e.q + dq === 0 ? { p: 0, q: 0 } : null);
      const b = n ? node(n.p, n.q) : null, key = [`${e.p},${e.q}`, `${e.p + dp},${e.q + dq}`].sort().join('|');
      if (!b || seen.has(key)) continue;
      seen.add(key);
      // through the pass: the middle of the shared border (between the two province centres)
      const ca = provinceCentre(e.p, e.q), cb = provinceCentre(e.p + dp, e.q + dq), pa = project(ca.q, ca.r), pb = project(cb.q, cb.r);
      const mid = { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 };
      for (const [w, c] of [[7, 'rgba(40,28,14,.5)'], [3.6, 'rgba(246,226,170,.95)']]) {
        g.strokeStyle = c; g.lineWidth = w / S; g.setLineDash(w > 5 ? [] : [10 / S, 9 / S]);
        g.beginPath(); g.moveTo(a.x, a.y); g.quadraticCurveTo(mid.x, mid.y, b.x, b.y); g.stroke();
      }
    }
  }
  g.setLineDash([]);
}

// ---- labels (the game's own names)
// every label's box (canvas px), and what labels keep clear of: the keeps with their standards
const taken = [];
const hits = (b) => taken.some(t => b.x < t.x + t.w && b.x + b.w > t.x && b.y < t.y + t.h && b.y + b.h > t.y);
const keepBoxes = () => keeps.map(k => ({ x: (k.x - box.x - 1.05 * k.u) * S, y: (k.y - box.y - 2.3 * k.u) * S, w: 2.3 * k.u * S, h: 3.1 * k.u * S }));
function measure(g, text, size, weight, font) { g.save(); g.font = `${weight} ${size}px ${font}`; const w = g.measureText(text).width; g.restore(); return { w: w + size * 0.5, h: size * 1.3 }; }
function label(g, x, y, text, { size = 30, weight = 800, fill = '#fff8e6', ink = 'rgba(20,16,10,.85)', font = '"Shippori Mincho B1", "Hiragino Mincho ProN", serif', accent = null } = {}) {
  const m = measure(g, text, size, weight, font);
  // (a word the frame would cut is left out: a post shows whole names or none)
  if (x - m.w / 2 < 0 || x + m.w / 2 > W || y - m.h / 2 < 0 || y + m.h / 2 > H) { info.cut = (info.cut ?? 0) + 1; return; }
  taken.push({ x: x - m.w / 2, y: y - m.h / 2, w: m.w, h: m.h });
  g.save();
  g.font = `${weight} ${size}px ${font}`; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.lineJoin = 'round'; g.lineWidth = size * 0.22; g.strokeStyle = ink; g.strokeText(text, x, y);
  g.fillStyle = fill; g.fillText(text, x, y);
  if (accent) { const w = g.measureText(text).width; g.fillStyle = accent; g.fillRect(x - w / 2, y + size * 0.62, w, Math.max(2, size * 0.08)); }
  g.restore();
}
function paintLabels(g) {
  const px = (x, y) => [(x - box.x) * S, (y - box.y) * S];
  // nation names over the middle of their heartland (ring 2 of each wedge)
  for (let f = 0; f < 6; f++) {
    const pr = ringProvinces(3).filter(p => wedgeOf(p.p, p.q) === f);
    const mid = pr[Math.floor(pr.length / 2)];
    const c = provinceCentre(mid.p, mid.q), w = project(c.q, c.r);
    const [x, y] = px(w.x, w.y);
    label(g, x, y - 40 * S, factionName(f), { size: 92 * Math.max(S, 0.85), fill: '#fff6df', ink: NATION_INK[f] ?? '#222', accent: FACTION_COLORS[f] });
  }
  const c0 = project(0, 0), [cx, cy] = px(c0.x, c0.y);
  label(g, cx, cy + 120 * S, L`大協約`, { size: 54 * Math.max(S, 0.85), fill: '#fbefc8' });
}
function paintNames(g) {
  const px = (x, y) => [(x - box.x) * S, (y - box.y) * S];
  taken.push(...keepBoxes());
  // the towns, cities and strongholds by their names (?nameTier=0 names the hamlets too), larger places first:
  // a town gives way to a city
  const minTier = Number(q.get('nameTier') ?? 1), list = [];
  for (const p of provs) for (let j = 0; j < p.prov.siteCount; j++) {
    const m = p.prov.siteMirror[j];
    if (m?.state === 1 && (m.tier ?? 0) >= minTier) list.push({ p, j, m });
  }
  list.sort((a, b) => b.m.tier - a.m.tier);
  for (const { p, j, m } of list) {
    const h = tileHex(p.p, p.q, p.prov.sites[j]), w = project(h.q, h.r), [x, y] = px(w.x, w.y);
    const size = [17, 19, 23, 26][m.tier ?? 0] * S, text = holdingName({ p: p.p, q: p.q, site: j }, m.tier ?? 0), font = '"Noto Sans JP", system-ui, sans-serif';
    // below the village, else further below, else above it; left out where every place is taken
    const mm = measure(g, text, size, 700, font);
    const spot = [40, 58, -88].map(dy => y + dy * S).find(yy => !hits({ x: x - mm.w / 2, y: yy - mm.h / 2, w: mm.w, h: mm.h }));
    if (spot === undefined) { info.namesLeftOut = (info.namesLeftOut ?? 0) + 1; continue; }
    label(g, x, spot, text, { size, weight: 700, font, fill: '#fffdf4', ink: NATION_INK[m.faction] ?? 'rgba(16,22,20,.9)' });
  }
}

// ---- scene anchors (world px) for the crops: the Concord, each nation's largest town, the fronts, a burning camp
const anchors = (() => {
  const c0 = project(0, 0), out = { concord: { x: c0.x, y: c0.y }, nations: [], fronts: [], camps: [] };
  for (let f = 0; f < 6; f++) {
    let best = null;
    for (const p of provs) for (let j = 0; j < p.prov.siteCount; j++) {
      const m = p.prov.siteMirror[j];
      if (m?.state !== 1 || m.faction !== f) continue;
      const h = tileHex(p.p, p.q, p.prov.sites[j]), c = project(h.q, h.r), score = m.tier * 10 - p.ring;
      if (!best || score > best.score) best = { x: c.x, y: c.y, tier: m.tier, score, p: p.p, q: p.q };
    }
    const vs = provs.flatMap(p => Array.from(p.prov.siteMirror).slice(0, p.prov.siteCount).map((m, j) => ({ m, j, p })).filter(x => x.m.state === 1 && x.m.faction === f));
    const mid = vs.reduce((a, x) => { const h = tileHex(x.p.p, x.p.q, x.p.prov.sites[x.j]), c = project(h.q, h.r); return { x: a.x + c.x / vs.length, y: a.y + c.y / vs.length }; }, { x: 0, y: 0 });
    out.nations.push({ faction: f, town: best, centre: mid, villages: vs.length });
  }
  for (const c of demo?.contests ?? []) { const k = keeps.find(x => x.p === c.p && x.q === c.q); if (k) out.fronts.push({ x: k.x, y: k.y, holder: k.holder, contender: c.contender }); }
  for (const cl of demo?.clashes ?? []) { const pv = byKey.get(`${cl.p},${cl.q}`)?.prov; if (pv?.camp?.state === 1 && !keeps.some(k => k.p === cl.p && k.q === cl.q && cl.arrivals.some(a => a.faction !== k.holder))) { const h = tileHex(cl.p, cl.q, pv.camp.tile), c = project(h.q, h.r); out.camps.push({ x: c.x, y: c.y }); } }
  return out;
})();
const info = { data: DATA, demo: DEMO, region: REGION, anchors, season: world.seasonId, bell: world.lastBell, scale: S, width: W, height: H, box, open, provinces: provs.length,
  villages: provs.reduce((n, p) => n + Array.from(p.prov.siteMirror).slice(0, p.prov.siteCount).filter(m => m.state === 1).length, 0), keeps: keeps.length };
const ready = (async () => {
  // the label faces in every subset the words need (a face's subsets load only when asked for)
  const words = [L`大協約`, ...Array.from({ length: 6 }, (_, f) => factionName(f)), ...provs.flatMap(p => Array.from(p.prov.siteMirror).slice(0, p.prov.siteCount).map((m, j) => (m.state === 1 ? holdingName({ p: p.p, q: p.q, site: j }, m.tier ?? 0) : '')))].join('');
  await Promise.all(['800 40px "Shippori Mincho B1"', '700 40px "Noto Sans JP"'].map(f => document.fonts.load(f, words).catch(() => null)));
  await document.fonts?.ready;
  if (layers.land || layers.base) { const land = layers.land ?? layer(); await settle(() => paintLand(land.getContext('2d'))); layers.land = land; }
  if (layers.life || layers.base) { const life = layers.life ?? layer(); info.figures = paintLifeLayer(life.getContext('2d')); layers.life = life; }
  if (layers.base) { const g = layers.base.getContext('2d'); g.drawImage(layers.land, 0, 0); g.drawImage(layers.life, 0, 0); }
  if (layers.realms) paintRealms(layers.realms.getContext('2d'));
  if (layers.grid) paintGrid(layers.grid.getContext('2d'));
  if (layers.routes) paintRoutes(layers.routes.getContext('2d'));
  if (layers.labels) paintLabels(layers.labels.getContext('2d'));
  if (layers.names) paintNames(layers.names.getContext('2d'));
  return info;
})();
window.WORLD = { ready, layers, info };
