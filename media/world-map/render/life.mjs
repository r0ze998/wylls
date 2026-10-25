// The life of the world map (presentation, 制作上の補完): who is doing what, drawn with the
// game's own figure painters (people/crowds.mjs `figure`, `actor`, `trip`; people/units.mjs
// `scaffold`) at fixed moments, so a picture is the same on every run.
//
//   townsfolk   on errands round each village (more with its tier)
//   carriers    from a village to the fields, woods and hills next to it and back (the work its
//               stores come from; which tile is the nearest of each kind, not a rule)
//   builders    at a scaffold beside some towns
//   smoke       from the chimneys (map/village.mjs VILLAGE.chimneys)
//   keeps       soldiers at drill before the gate, in the holder's colours
//   fronts      the demo's clashes: the two sides' fighters between the attackers' tiles and the keep,
//               dust and smoke over them; a camp attacked burns
//   scouts      at the edge of the open land, looking into the clouds
//   the Concord travellers crossing its paving
//
// Nothing here is a host or an order: hosts are the game's own tokens (map/sprites.mjs).
import { figure, actor, trip } from '../../../permutation-server/web/frontier/people/crowds.mjs';
import { scaffold } from '../../../permutation-server/web/frontier/people/units.mjs';
import { FACTION_FILL, FACTION_DARK } from '../../../permutation-server/web/frontier/people/avatar.mjs';
import { SKIN, HAIR } from '../../../permutation-server/web/frontier/people/identity.mjs';
import { VILLAGE } from '../../../permutation-server/web/frontier/map/village.mjs';
import { VILLAGE_AT, VILLAGE_SCALE } from '../../../permutation-server/web/frontier/map/plates.mjs';
import { project, RADIUS, FLATTEN } from '../../../permutation-server/web/map.mjs';
import { tileHex, TILE_OFFSETS, hexDistance, ringOf } from '../../../permutation-server/web/frontier/fgeo.mjs';

const CLOTH = ['#8a6a46', '#6f7a52', '#9a7a5a', '#5f6a74', '#a08a62', '#7a5a4a', '#8e5a4a', '#5a6a5a'];
const hash = (a, b, c = 0) => { let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(c | 0, 0x9e3779b9); h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; return (h >>> 0) / 4294967296; };
const FOLK = RADIUS * 0.22, ACTOR = RADIUS * 0.32;
const T = 37.5;   // the moment (seconds) every trip is drawn at
const KIND = ['grassland', 'plains', 'forest', 'hills', 'mountain', 'water'];

function smoke(g, x, y, s, seed) {
  g.save();
  for (let i = 0; i < 5; i++) {
    const k = i / 4, dx = Math.sin(seed * 9 + i * 0.9) * s * 0.35 * k + s * 0.5 * k, dy = -s * 1.6 * k;
    g.globalAlpha = 0.34 * (1 - k * 0.7);
    g.fillStyle = i % 2 ? '#eae6dc' : '#d6d1c6';
    g.beginPath(); g.arc(x + dx, y + dy, s * (0.16 + 0.2 * k), 0, Math.PI * 2); g.fill();
  }
  g.restore();
}
function dustAndSmoke(g, x, y, r, seed, fire = false) {
  g.save();
  for (let i = 0; i < 14; i++) {
    const a = hash(seed, i) * Math.PI * 2, d = hash(seed, i, 2) * r, px = x + Math.cos(a) * d, py = y + Math.sin(a) * d * FLATTEN;
    const rr = r * (0.18 + hash(seed, i, 3) * 0.22);
    g.globalAlpha = 0.18 + hash(seed, i, 4) * 0.16;
    g.fillStyle = i % 3 === 0 ? '#5a534a' : '#c9b99a';
    g.beginPath(); g.ellipse(px, py - rr * 0.6, rr, rr * 0.8, 0, 0, Math.PI * 2); g.fill();
  }
  if (fire) for (let i = 0; i < 6; i++) {
    const px = x + (hash(seed, i, 7) - 0.5) * r * 0.9, py = y + (hash(seed, i, 8) - 0.5) * r * 0.4, h = r * (0.25 + hash(seed, i, 9) * 0.3);
    g.globalAlpha = 0.85; g.fillStyle = i % 2 ? '#f39a2c' : '#ffd36a';
    g.beginPath(); g.moveTo(px - h * 0.25, py); g.quadraticCurveTo(px - h * 0.2, py - h * 0.6, px, py - h); g.quadraticCurveTo(px + h * 0.2, py - h * 0.6, px + h * 0.25, py); g.closePath(); g.fill();
    g.globalAlpha = 0.3; g.fillStyle = '#4a4440'; g.beginPath(); g.arc(px + h * 0.2, py - h * 1.5, h * 0.45, 0, Math.PI * 2); g.fill();
  }
  g.restore();
}

/** Paint the life of every province `provs` ({p, q, prov}) whose land is open; `clashes` the demo's ({p, q, arrivals}). */
export function paintLife(g, provs, { clashes = [], keeps = [], open = 5 } = {}) {
  const tileC = (p, q, i) => { const h = tileHex(p, q, i); return h ? project(h.q, h.r) : null; };
  const items = [];   // drawn back to front
  const at = (y, fn) => items.push({ y, fn });
  for (const { p, q, prov } of provs) {
    const n = prov.siteCount;
    for (let j = 0; j < n; j++) {
      const m = prov.siteMirror[j];
      if (!m || m.state !== 1) continue;
      const tile = prov.sites[j], c = tileC(p, q, tile), tier = Math.max(0, Math.min(3, m.tier ?? 0)), f = m.faction;
      if (!c) continue;
      const u = RADIUS * VILLAGE_SCALE, vx = c.x + VILLAGE_AT.x, vy = c.y + VILLAGE_AT.y, ring = VILLAGE.ring[tier] * u;
      const flip = ((tileHex(p, q, tile).q * 7 + tileHex(p, q, tile).r * 13) & 1) ? -1 : 1;
      // smoke from the chimneys
      for (const [gx, gy] of VILLAGE.chimneys[tier]) {
        const sx = vx + flip * gx * u, sy = vy + gy * u * FLATTEN * 0.8 - u * 0.2;
        at(sy - 1, () => smoke(g, sx, sy - u * 0.12, u * 0.22, hash(p, q, tile)));
      }
      // townsfolk on errands in front of the village and round its gate
      const folk = [2, 3, 5, 6][tier];
      for (let i = 0; i < folk; i++) {
        const a = Math.PI * (0.15 + 0.7 * hash(p * 31 + q, tile, i)), d = ring * (1.05 + 0.35 * hash(p, tile, i + 9));
        const x = vx + Math.cos(a) * d * (i % 2 ? 1 : -1), y = vy + Math.sin(a) * d * FLATTEN * 0.8;
        at(y, () => figure(g, x, y, FOLK, { kind: 'folk', cloth: CLOTH[(tile + i) % CLOTH.length], skin: SKIN[(tile + i * 3) % SKIN.length], step: hash(tile, i, 4), face: hash(tile, i, 5) > 0.5 ? 1 : -1 }));
      }
      // carriers to the nearest field, wood and hill of the land round it
      const near = new Map();
      TILE_OFFSETS.forEach((o, i) => {
        const self = TILE_OFFSETS[tile], d = hexDistance(o.q, o.r, self.q, self.r);
        if (d < 1 || d > 2) return;
        const kind = KIND[prov.terrain[i]];
        const role = kind === 'grassland' || kind === 'plains' ? 'field' : kind === 'forest' ? 'wood' : kind === 'hills' || kind === 'mountain' ? 'hill' : null;
        if (role && (!near.has(role) || near.get(role).d > d)) near.set(role, { i, d });
      });
      let k = 0;
      for (const [role, { i }] of near) {
        const to = tileC(p, q, i);
        if (!to) continue;
        const trips = role === 'field' ? 1 + Math.min(2, tier) : 1 + (tier >= 2 ? 1 : 0);
        for (let r2 = 0; r2 < trips; r2++, k++) {
          const from = { x: vx + (to.x - vx) * 0.25, y: vy + (to.y - vy) * 0.25 + u * 0.1 };
          const pos = trip(from, { x: to.x, y: to.y }, T, 16 + hash(tile, k) * 8, hash(p * 7 + q, tile, k), RADIUS * 0.12);
          at(pos.y, () => figure(g, pos.x, pos.y, FOLK, { kind: pos.back ? 'carrier' : 'folk', cloth: CLOTH[(k + tile * 3) % CLOTH.length], skin: SKIN[(k + tile) % SKIN.length], step: hash(tile, k, 2), face: pos.face }));
        }
      }
      // a builder at a scaffold beside some towns
      if (tier >= 1 && hash(p, q, tile + 99) < 0.32) {
        const sx = vx - ring * 1.25, sy = vy + u * 0.18;
        at(sy, () => { scaffold(g, sx, sy, RADIUS * 0.42, 0); actor(g, sx + RADIUS * 0.28, sy + 2, ACTOR, { pose: 'hammer', cloth: FACTION_FILL[f] ?? CLOTH[0], trim: FACTION_DARK[f] ?? '#3a3a34', skin: SKIN[tile % SKIN.length], step: 0.3, face: -1 }); });
      }
    }
  }
  // soldiers at drill before each keep's gate, in its holder's colours
  for (const kp of keeps) {
    if (kp.holder === null) continue;
    for (let i = 0; i < 3; i++) {
      const x = kp.x - RADIUS * 0.35 + i * RADIUS * 0.3, y = kp.y + kp.u * 0.72 + (i % 2) * RADIUS * 0.08;
      at(y, () => actor(g, x, y, ACTOR, { pose: i === 1 ? 'spear' : 'drill', cloth: FACTION_FILL[kp.holder], trim: FACTION_DARK[kp.holder], skin: SKIN[(kp.p * 3 + kp.q + i) % SKIN.length], step: i * 0.33, face: 1 }));
    }
  }
  // the fronts and the burning camps (the demo's clashes)
  for (const cl of clashes) {
    const pv = provs.find(x => x.p === cl.p && x.q === cl.q)?.prov;
    if (!pv) continue;
    const kp = keeps.find(x => x.p === cl.p && x.q === cl.q);
    const camp = pv.camp?.state === 1 ? tileC(cl.p, cl.q, pv.camp.tile) : null;
    const target = kp && cl.arrivals.some(a => a.faction !== kp.holder) ? { x: kp.x, y: kp.y + kp.u * 0.5 } : camp;
    if (!target) continue;
    for (const a of cl.arrivals) {
      const c = tileC(cl.p, cl.q, a.tile);
      if (!c) continue;
      // (the melee a little out from the walls, toward the side it comes from)
      const k = kp ? 0.62 : 0.5, mx = target.x + (c.x - target.x) * k, my = target.y + (c.y - target.y) * k + RADIUS * 0.15, foe = kp?.holder ?? 6;
      const seed = hash(cl.p, cl.q, a.tile);
      at(my - 2, () => dustAndSmoke(g, mx, my, RADIUS * 0.7, seed * 1e6, !kp));
      for (let i = 0; i < 3; i++) {
        const x1 = mx - RADIUS * 0.16 + i * RADIUS * 0.12, y1 = my + (i - 1) * RADIUS * 0.1, face = target.x >= c.x ? 1 : -1;
        const mine = a.faction, them = a.faction === foe ? 6 : foe;
        at(y1, () => actor(g, x1 - face * RADIUS * 0.1, y1, ACTOR, { pose: 'sword', cloth: FACTION_FILL[mine] ?? '#7a5a4a', trim: FACTION_DARK[mine] ?? '#3a2a1a', skin: SKIN[i % SKIN.length], step: 0.2 + i * 0.25, face }));
        at(y1 + 1, () => actor(g, x1 + face * RADIUS * 0.12, y1 + 2, ACTOR, { pose: them === 6 ? 'spear' : 'sword', cloth: them === 6 ? '#6b4a32' : FACTION_FILL[them], trim: them === 6 ? '#2a1a10' : FACTION_DARK[them], skin: SKIN[(i + 2) % SKIN.length], step: 0.6 + i * 0.2, face: -face }));
      }
    }
  }
  // scouts at the edge of the open land, one a province of the outermost ring now and then
  for (const { p, q, prov } of provs) {
    if (ringOf(p, q) !== open - 1 || hash(p, q, 5) > 0.42) continue;
    let best = null;
    TILE_OFFSETS.forEach((o, i) => { const d = hexDistance(o.q, o.r, 0, 0); if (d === 4 && KIND[prov.terrain[i]] !== 'water') { const c = tileC(p, q, i), far = Math.hypot(c.x, c.y); if (!best || far > best.far) best = { c, far }; } });
    if (!best) continue;
    const f = prov.wedge < 6 ? prov.wedge : 0, face = best.c.x > 0 ? 1 : -1;
    at(best.c.y, () => actor(g, best.c.x, best.c.y, ACTOR, { pose: 'scout', cloth: FACTION_FILL[f], trim: FACTION_DARK[f], skin: SKIN[(p + q + 9) % SKIN.length], step: 0.25, face }));
  }
  // travellers crossing the Concord's paving
  const concord = provs.find(x => x.p === 0 && x.q === 0);
  if (concord) for (let i = 0; i < 18; i++) {
    const t0 = TILE_OFFSETS[Math.floor(hash(i, 1) * 61)], t1 = TILE_OFFSETS[Math.floor(hash(i, 2) * 61)];
    const a = project(t0.q, t0.r), b = project(t1.q, t1.r), pos = trip(a, b, T, 30, hash(i, 3), RADIUS * 0.2);
    at(pos.y, () => figure(g, pos.x, pos.y, FOLK, { kind: i % 4 === 0 ? 'carrier' : 'folk', cloth: CLOTH[i % CLOTH.length], skin: SKIN[i % SKIN.length], step: hash(i, 4), face: pos.face }));
  }
  items.sort((a, b) => a.y - b.y);
  for (const it of items) { g.save(); try { it.fn(); } finally { g.restore(); } }
  return items.length;
}
