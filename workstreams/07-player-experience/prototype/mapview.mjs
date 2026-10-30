// The prototype's map: one SVG of hexes, drawn in one of three visual
// directions (compare.html shows them side by side). The direction changes
// how each fact is ENCODED, not only its colours:
//   atlas    (recommended) an ink-on-paper chart: terrain by pattern AND a
//            muted tint, a nation by colour AND an emblem shape, a state by a
//            ring style AND a glyph AND words in the card; labels only on
//            what is the viewer's, selected or alerted
//   tokens   a flat board: strong fills, round tokens; states by fill alone
//            (fast to read in colour, fails without it — shown to compare)
//   diorama  the current client's family: saturated biome fills, no patterns,
//            pictures over every tile, every name labelled (the look the
//            Realms comparison worries about)
import { tileHex, TILE_OFFSETS } from '../../../permutation-server/web/frontier/fgeo.mjs';

export const SQ3 = Math.sqrt(3);
export const NATION_COLOR = ['#3d6fb6', '#4b8f8c', '#c0542f', '#7b4a9c', '#b8902a', '#5b6b2f'];
export const NATION_SHAPE = ['circle', 'triangle', 'square', 'diamond', 'hexagon', 'cross'];
export const TERRAIN_NAME = ['grass', 'plains', 'forest', 'hills', 'mountain', 'water'];
const TERRAIN_FILL = {
  atlas: ['var(--t-grass)', 'var(--t-plains)', 'var(--t-forest)', 'var(--t-hills)', 'var(--t-mountain)', 'var(--t-water)'],
  tokens: ['#9ccf74', '#d9d47a', '#4f9a4a', '#b99a63', '#8b8b8b', '#5aa4d6'],
  diorama: ['#6fb04a', '#c9c25b', '#2f7d32', '#a8834a', '#7a7a7a', '#2f86c9'],
};

/** Pixel centre of axial hex (q, r), pointy top. */
export const px = (q, r, s) => ({ x: s * SQ3 * (q + r / 2), y: s * 1.5 * r });
const corners = (x, y, s) => Array.from({ length: 6 }, (_, i) => { const a = (Math.PI / 180) * (60 * i - 30); return `${(x + s * Math.cos(a)).toFixed(1)},${(y + s * Math.sin(a)).toFixed(1)}`; }).join(' ');

/** An emblem of a nation: its shape in its colour, a light rim (readable on any terrain). */
export function emblem(f, x, y, r) {
  const c = NATION_COLOR[f] ?? '#777', rim = 'var(--emblem-rim)';
  const shape = NATION_SHAPE[f] ?? 'circle';
  const st = `fill="${c}" stroke="${rim}" stroke-width="${(r * 0.28).toFixed(1)}"`;
  if (shape === 'circle') return `<circle cx="${x}" cy="${y}" r="${r}" ${st}/>`;
  if (shape === 'square') return `<rect x="${x - r * 0.85}" y="${y - r * 0.85}" width="${r * 1.7}" height="${r * 1.7}" ${st}/>`;
  if (shape === 'triangle') return `<polygon points="${x},${y - r * 1.05} ${x + r},${y + r * 0.75} ${x - r},${y + r * 0.75}" ${st}/>`;
  if (shape === 'diamond') return `<polygon points="${x},${y - r * 1.1} ${x + r},${y} ${x},${y + r * 1.1} ${x - r},${y}" ${st}/>`;
  if (shape === 'hexagon') return `<polygon points="${corners(x, y, r)}" ${st}/>`;
  return `<path d="M${x - r * 0.35} ${y - r}h${r * 0.7}v${r * 0.65}h${r * 0.65}v${r * 0.7}h${-r * 0.65}v${r * 0.65}h${-r * 0.7}v${-r * 0.65}h${-r * 0.65}v${-r * 0.7}h${r * 0.65}z" ${st}/>`;
}

/** Building silhouettes (one line weight, legible at 16 px): what stands on a tile. */
export function glyph(kind, x, y, s, tier = 0) {
  const k = s / 22, g = d => `<path d="${d}" class="ink" transform="translate(${x} ${y}) scale(${k.toFixed(3)})"/>`;
  switch (kind) {
    case 'village': {
      // hamlet 1 roof, town 2, city 3 with a wall line, stronghold 3 and a keep
      const roofs = [[-4, 0]], extra = [[-9, 2], [3, 2]];
      const set = tier >= 1 ? [...roofs, extra[1]] : roofs;
      const all = tier >= 2 ? [...set, extra[0]] : set;
      return all.map(([dx, dy]) => g(`M${dx - 4} ${dy + 4}v-6l5 -5l5 5v6z`)).join('') + (tier >= 2 ? g('M-13 9h26') : '') + (tier >= 3 ? g('M-2 -12v-5h4v5') : '');
    }
    case 'vault': return g('M-7 -5h14v11h-14zM-7 0h14M-2 -5v11M2 -5v11');
    case 'tower': return g('M-3 8v-14h6v14M-5 -6h10l-5 -6z M-2 -2h4');
    case 'palisade': return g('M-9 7v-9l1.5 -3 1.5 3v9M-3 7v-11l1.5 -3 1.5 3v11M3 7v-9l1.5 -3 1.5 3v9M-11 3h22');
    case 'fort': return g('M-9 7v-10l4 -3v3h3v-4h4v4h3v-3l4 3v10z');
    case 'cart': return g('M-8 -2h12v5h-12zM4 0h4M-5 6m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0M3 6m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0');
    case 'host': return g('M-4 8v-16M-4 -8l10 3l-10 3');
    case 'ore': return `<path d="M${x} ${y - s * 0.22}l${s * 0.16} ${s * 0.22}l${-s * 0.16} ${s * 0.22}l${-s * 0.16} ${-s * 0.22}z" class="ore"/>`;
    default: return '';
  }
}

/** A state's mark beside a thing: never colour alone — a ring style, a glyph, and the card's words. */
export function stateMark(state, x, y, s) {
  switch (state) {
    case 'war': return `<circle cx="${x}" cy="${y}" r="${s * 0.78}" class="st-war"/>`;
    case 'pass': return `<circle cx="${x}" cy="${y}" r="${s * 0.78}" class="st-pass"/>`;
    case 'own': return `<circle cx="${x}" cy="${y}" r="${s * 0.8}" class="st-own"/><circle cx="${x}" cy="${y}" r="${s * 0.62}" class="st-own2"/>`;
    case 'siege': return `<g class="st-badge" transform="translate(${x + s * 0.55} ${y - s * 0.6})"><circle r="${s * 0.3}"/><path d="M-4 4l8 -8M-4 -4l8 8" /></g>`;
    case 'shield': return `<g class="st-badge" transform="translate(${x + s * 0.55} ${y - s * 0.6})"><path d="M0 -6l5 2v3c0 3 -2 5 -5 6c-3 -1 -5 -3 -5 -6v-3z"/></g>`;
    case 'alert': return `<g class="st-alert" transform="translate(${x - s * 0.55} ${y - s * 0.6})"><circle r="${s * 0.3}"/><text y="4" text-anchor="middle">!</text></g>`;
    default: return '';
  }
}

/**
 * The map. `scene`: {provinces [[p, q]], terrain Map, villages, structures,
 * vaults, hosts, iron Set, sight(p, q, t), me {faction}, stances}; `opt`:
 * {style, size, selected {p, q, tile}, route [{p, q, tile}] with turns,
 * focus, labels}. Returns `{svg, hexes: Map key → {x, y, q, r, p, pq, tile}}`.
 */
export function renderMap(scene, opt = {}) {
  const style = opt.style ?? 'atlas', s = opt.size ?? 22, fills = TERRAIN_FILL[style];
  const hexes = new Map();
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [p, q] of scene.provinces) for (let t = 0; t < 61; t++) {
    const h = tileHex(p, q, t), c = px(h.q, h.r, s);
    hexes.set(`${p},${q},${t}`, { ...c, q: h.q, r: h.r, p, pq: q, tile: t });
    minX = Math.min(minX, c.x); maxX = Math.max(maxX, c.x); minY = Math.min(minY, c.y); maxY = Math.max(maxY, c.y);
  }
  const pad = s * 1.2, W = maxX - minX + 2 * pad, H = maxY - minY + 2 * pad, ox = pad - minX, oy = pad - minY;
  const rel = (p, q) => {
    const f = scene.me.faction;
    if (p === f) return 'own';
    const st = scene.stances?.[p]?.[f] ?? 0;
    return st === 0 ? 'war' : 'pass';
  };
  const out = [];
  out.push(`<svg viewBox="0 0 ${W.toFixed(0)} ${H.toFixed(0)}" class="map map-${style}" role="application" aria-label="${opt.ariaLabel ?? 'map'}" data-style="${style}">`);
  out.push(`<defs>
    <pattern id="pt-forest" width="10" height="10" patternUnits="userSpaceOnUse"><path d="M2 8l3 -6l3 6z" class="pt"/></pattern>
    <pattern id="pt-hills" width="12" height="8" patternUnits="userSpaceOnUse"><path d="M0 7q3 -5 6 0q3 -5 6 0" class="pt" fill="none"/></pattern>
    <pattern id="pt-mountain" width="12" height="10" patternUnits="userSpaceOnUse"><path d="M1 9l5 -8l5 8M4 5l2 2l2 -2" class="pt" fill="none"/></pattern>
    <pattern id="pt-water" width="12" height="6" patternUnits="userSpaceOnUse"><path d="M0 3q3 -3 6 0t6 0" class="pt" fill="none"/></pattern>
    <pattern id="pt-plains" width="9" height="9" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r="0.7" class="pt-dot"/></pattern>
    <pattern id="pt-fog" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><path d="M0 0v6" class="pt-fog"/></pattern>
  </defs>`);
  out.push(`<g transform="translate(${ox.toFixed(1)} ${oy.toFixed(1)})">`);
  // 1 ground: tint, and in the atlas its pattern
  for (const [key, h] of hexes) {
    const ter = scene.terrain.get(`${h.p},${h.pq}`)[h.tile];
    const seen = scene.sight(h.p, h.pq, h.tile);
    const pat = style === 'atlas' && ter > 0 ? `<polygon points="${corners(h.x, h.y, s * 0.97)}" fill="url(#pt-${TERRAIN_NAME[ter]})" class="pat"/>` : '';
    // (level 2: the land is known, who stands on it is not — a faint veil; level 1 or less: not in sight — the hatch)
    const fog = seen < 2 ? `<polygon points="${corners(h.x, h.y, s * 0.97)}" fill="${style === 'atlas' ? 'url(#pt-fog)' : 'rgba(30,30,40,.35)'}" class="fog"/>`
      : seen < 3 ? `<polygon points="${corners(h.x, h.y, s * 0.97)}" class="veil"/>` : '';
    const sel = opt.selected && opt.selected.p === h.p && opt.selected.q === h.pq && opt.selected.tile === h.tile;
    const foc = opt.focus === key;
    out.push(`<g class="hex${sel ? ' sel' : ''}${foc ? ' foc' : ''}" data-key="${key}" data-terrain="${TERRAIN_NAME[ter]}"><polygon points="${corners(h.x, h.y, s * 0.97)}" fill="${fills[ter]}" class="ground"/>${pat}${fog}</g>`);
    if (style !== 'tokens' && scene.iron?.has(key) && seen >= 2) out.push(glyph('ore', h.x + s * 0.45, h.y + s * 0.35, s));
  }
  // province borders
  if (style === 'atlas') for (const [p, q] of scene.provinces) {
    const edge = [];
    for (let t = 0; t < 61; t++) { const o = TILE_OFFSETS[t]; if ((Math.abs(o.q) + Math.abs(o.r) + Math.abs(o.q + o.r)) / 2 === 4) edge.push(hexes.get(`${p},${q},${t}`)); }
    for (const h of edge) out.push(`<polygon points="${corners(h.x, h.y, s)}" class="prov-edge"/>`);
  }
  // 2 the route's line (a caravan preview), under the things it passes
  if (opt.route?.steps?.length) {
    const pts = [opt.route.from, ...opt.route.steps].map(t => hexes.get(`${t.p},${t.q},${t.tile}`)).filter(Boolean);
    out.push(`<polyline points="${pts.map(h => `${h.x.toFixed(1)},${h.y.toFixed(1)}`).join(' ')}" class="route"/>`);
  }
  // 3 things on tiles: structures, storehouses, villages, hosts — and their nation and state
  const label = (h, text, cls = '') => out.push(`<text x="${h.x.toFixed(1)}" y="${(h.y + s * 1.25).toFixed(1)}" text-anchor="middle" class="lbl ${cls}">${text}</text>`);
  const sightOf = x => scene.sight(x.p, x.q, x.tile);
  for (const st of scene.structures) {
    const h = hexes.get(`${st.p},${st.q},${st.tile}`); if (!h || sightOf(st) < 2) continue;
    const kind = ['', 'tower', 'palisade', 'fort'][st.kind];
    if (style === 'atlas') out.push(stateMark(rel(st.faction), h.x, h.y, s));
    if (style === 'tokens') out.push(`<circle cx="${h.x}" cy="${h.y}" r="${s * 0.62}" fill="${NATION_COLOR[st.faction]}" class="tok"/>`);
    out.push(glyph(kind, h.x, h.y, s));
    if (style !== 'tokens') out.push(emblem(st.faction, h.x + s * 0.5, h.y + s * 0.45, s * 0.2));
    if (style === 'diorama') label(h, ({ tower: '物見櫓', palisade: '柵', fort: '要塞' })[kind], 'all');
  }
  for (const v of scene.vaults) {
    const h = hexes.get(`${v.p},${v.q},${v.tile}`); if (!h) continue;
    if (style === 'atlas') out.push(stateMark('own', h.x, h.y, s));
    if (style === 'tokens') out.push(`<circle cx="${h.x}" cy="${h.y}" r="${s * 0.62}" fill="${NATION_COLOR[v.faction]}" class="tok"/>`);
    out.push(glyph('vault', h.x, h.y, s));
    if (style !== 'tokens') out.push(emblem(v.faction, h.x + s * 0.5, h.y + s * 0.45, s * 0.2));
    if (style !== 'tokens') label(h, v.label, 'own');
  }
  for (const v of scene.villages) {
    const h = hexes.get(`${v.p},${v.q},30`) && hexes.get(`${v.p},${v.q},${v.tile}`); if (!h) continue;
    const r = rel(v.faction);
    if (style === 'atlas') out.push(stateMark(r, h.x, h.y, s));
    if (style === 'tokens') out.push(`<circle cx="${h.x}" cy="${h.y}" r="${s * 0.7}" fill="${NATION_COLOR[v.faction]}" class="tok"/>`);
    out.push(glyph('village', h.x, h.y, s, v.tier));
    if (style !== 'tokens') out.push(emblem(v.faction, h.x + s * 0.55, h.y + s * 0.5, s * 0.24));
    if (style === 'atlas') { if (v.siege) out.push(stateMark('siege', h.x, h.y, s)); if (v.shield) out.push(stateMark('shield', h.x, h.y, s)); if (v.alert) out.push(stateMark('alert', h.x, h.y, s)); }
    if (style === 'diorama' || v.own || (style === 'atlas' && (v.alert || (opt.selected && opt.selected.p === v.p && opt.selected.q === v.q && opt.selected.tile === v.tile)))) label(h, v.name, v.own ? 'own' : '');
  }
  for (const ho of scene.hosts) {
    const h = hexes.get(`${ho.p},${ho.q},${ho.tile}`); if (!h || sightOf(ho) < 3) continue;
    const dx = s * -0.5, dy = s * -0.35;
    if (style === 'tokens') out.push(`<circle cx="${h.x + dx}" cy="${h.y + dy}" r="${s * 0.34}" fill="${NATION_COLOR[ho.faction]}" class="tok"/>`);
    out.push(glyph('host', h.x + dx, h.y + dy, s * 0.8));
    if (style !== 'tokens') out.push(emblem(ho.faction, h.x + dx + s * 0.28, h.y + dy - s * 0.25, s * 0.16));
    out.push(`<text x="${(h.x + dx).toFixed(1)}" y="${(h.y + dy + s * 0.62).toFixed(1)}" text-anchor="middle" class="num">${Math.floor(ho.troops / 1000)}</text>`);
  }
  // 4 the route's turn marks and the palisade it went round, over everything (they are what the card speaks of)
  if (opt.route?.steps?.length) {
    (opt.route.turns ?? []).forEach((t, i) => {
      const h = hexes.get(`${t.p},${t.q},${t.tile}`); if (!h) return;
      const cls = t.known.length ? 'turn danger' : t.unknown ? 'turn unknown' : t.sheltered ? 'turn safe' : 'turn';
      out.push(`<g class="${cls}" transform="translate(${(h.x + s * 0.5).toFixed(1)} ${(h.y + s * 0.42).toFixed(1)})"><rect x="-8" y="-8" width="16" height="16" rx="3"/><text y="4" text-anchor="middle">${i + 1}</text>${t.unknown ? '<text class="q" x="11" y="-6">?</text>' : ''}${t.known.length ? '<text class="q" x="11" y="-6">!</text>' : ''}</g>`);
    });
    if (opt.route.avoidedAt) { const h = hexes.get(opt.route.avoidedAt); if (h) out.push(`<g class="avoid" transform="translate(${(h.x - s * 0.52).toFixed(1)} ${(h.y + s * 0.45).toFixed(1)})"><circle r="7"/><path d="M-4 -4l8 8M4 -4l-8 8"/></g>`); }
  }
  out.push('</g></svg>');
  return { svg: out.join(''), hexes, width: W, height: H, ox, oy };
}
