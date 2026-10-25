// Extract one recorded local season into media/world-map/data/<name>.json: every
// opened province's land and what stands on it, decoded from the raw Province
// accounts the herald kept (not from any decoded JSON of its own).
//
//   node media/world-map/scripts/extract-season.mjs <herald files dir> <name>
//   e.g. frontier-node/.local/frontier/art-b1/herald/files  season-92
//
// What is kept is public on the chain: terrain, resources, sites, villages (nation, tier,
// walls, garrison), camps, keeps (holder, garrison), the hosts that stand in a province
// (their nation, kind and size; a host on a sealed march is not in any province's list),
// structures and caravans. No wallet, key or owner address is copied.
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decode } from '../../../permutation-server/web/frontier/fcodec.mjs';

const [src, name = 'season'] = process.argv.slice(2);
if (!src) { console.error('usage: extract-season.mjs <herald files dir> <name>'); process.exit(2); }
const here = dirname(fileURLToPath(import.meta.url));
const pdir = join(src, 'h', 'province');
const num = v => (typeof v === 'bigint' ? Number(v) : v);
const out = { name, source: 'herald files (raw Province accounts, latest bell of each)', provinces: [] };
let season = null, lastBell = 0;
for (const key of readdirSync(pdir).sort()) {
  const bells = readdirSync(join(pdir, key)).filter(f => /^\d+\.json$/.test(f)).map(f => Number(f.split('.')[0]));
  if (!bells.length) continue;
  const bell = Math.max(...bells);
  const rec = JSON.parse(readFileSync(join(pdir, key, `${bell}.json`), 'utf8'));
  const a = decode('Province', Uint8Array.from(Buffer.from(rec.bytes, 'base64')), { profile: 3 });
  season ??= num(a.seasonId); lastBell = Math.max(lastBell, bell);
  const n = a.siteCount;
  out.provinces.push({
    p: a.p, q: a.q, ring: a.ring, wedge: a.wedge, bell,
    // the account itself, as the chain holds it: the renderer decodes it with the page's own codec
    bytes: rec.bytes,
    terrain: Array.from(a.terrain), resource: Array.from(a.resource), sites: Array.from(a.sites).slice(0, n),
    sitesMirror: a.siteMirror.slice(0, n).map(m => ({ state: m.state, faction: m.faction, tier: m.tier, garrison: Math.floor(num(m.garrison) / 1000), walls: num(m.wallsCommitted) > 0 })),
    camp: a.camp?.state === 1 ? { tile: a.camp.tile, troops: num(a.camp.troops) } : null,
    keep: a.keep ? { tile: a.keep.tile, holder: a.keep.holder, contender: a.keep.contender, troops: num(a.keep.troops), progress: a.keep.progress, required: a.keep.required } : null,
    hosts: a.entries.filter(e => e.state === 1 || e.state === 2).map(e => ({ tile: e.tile, faction: e.faction, unit: e.unit, troops: Math.floor(num(e.troops) / 1000), state: e.state })),
    structures: (a.structures ?? []).filter(s => s.kind > 0).map(s => ({ kind: s.kind, tile: s.tile, faction: s.faction })),
    caravans: (a.caravans ?? []).filter(c => num(c.id) !== 0).map(c => ({ faction: c.faction, n: num(c.n), tiles: Array.from(c.tiles) })),
    roadMask: String(a.roadMask), relations: String(a.relations),
  });
}
out.seasonId = season; out.lastBell = lastBell;
const standings = join(src, 'h', 'standings', 'latest.json');
if (existsSync(standings)) { try { const s = JSON.parse(readFileSync(standings, 'utf8')); out.standings = s.nations ?? s.rows ?? null; } catch { /* optional */ } }
const file = join(here, '..', 'data', `${name}.json`);
writeFileSync(file, JSON.stringify(out));
const villages = out.provinces.reduce((n, p) => n + p.sitesMirror.filter(m => m.state === 1).length, 0);
console.log(`${file}: season ${season}, bell ${lastBell}, ${out.provinces.length} provinces, ${villages} villages, ${out.provinces.reduce((n, p) => n + p.hosts.length, 0)} hosts, ${out.provinces.filter(p => p.camp).length} camps`);
