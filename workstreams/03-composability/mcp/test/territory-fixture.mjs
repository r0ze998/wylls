// (ws13-territory) Test bytes of a local world with PLAYER TERRITORY: herald wide-province captures (4,864 B), the two
// territory records (672 B 'PSFXWTN1', 320 B 'PSFXWTU1') as the page's own decoders read them
// (permutation-server/web/frontier/flocalplay-territory.mjs), and a fake herald route + relay account read over them.
// KEY-FREE. Not a test file itself.
import { seasonAddresses } from '../../../../permutation-server/web/frontier/faddr.mjs';
import { territoryProvinceAddress, territoryPlayerAddress, citizenTagOf } from '../../../../permutation-server/web/frontier/flocalplay-territory.mjs';

export const PROGRAM = 'Vote111111111111111111111111111111111111111', WALLET = 'SysvarRent111111111111111111111111111111111', OTHER = 'SysvarC1ock11111111111111111111111111111111', SEASON_ID = '11';
const ascii = (b, s) => { for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i); };

/** A wide province capture: `sites` `[{tile, state (0 free, 1 village, 3 released), faction}]`, the keep, the territory rule byte. */
export function captureBytes({ sites = [], keepTile = 30, keepHolder = 0, keepChanges = 0, territory = true } = {}) {
  const b = new Uint8Array(4864);
  b[262] = sites.length;
  sites.forEach((s, i) => { b[250 + i] = s.tile; b[296 + i * 64] = s.state ?? 0; b[296 + i * 64 + 1] = s.faction ?? 0; });
  b[4480] = keepTile; b[4481] = keepHolder; b[4486] = keepChanges & 0xff; b[4487] = keepChanges >> 8;
  b[4789] = territory ? 1 : 0;
  return b;
}
/** A territory province record: `owners` `{tile: tag (decimal string)}`, `dist` `{tile: upkeep distance}`. */
export function provinceRecord({ owners = {}, dist = {}, keepTile = 30 } = {}) {
  const b = new Uint8Array(672), dv = new DataView(b.buffer);
  ascii(b, 'PSFXWTN1'); b[18] = 1; b[19] = Object.keys(owners).length; b[69] = keepTile;
  for (const [t, tag] of Object.entries(owners)) { dv.setBigUint64(104 + 8 * Number(t), BigInt(tag), true); b[592 + Number(t)] = dist[t] ?? 0; }
  return b;
}
/** A territory player summary. `unpaidSince` null = paid. */
export function playerRecord({ tag, tiles = 0, excess = 0, unpaidSince = null, lastClaimBell = 0xffffffff, claimsInBell = 0, faction = 3 } = {}) {
  const b = new Uint8Array(320), dv = new DataView(b.buffer);
  ascii(b, 'PSFXWTU1'); b[18] = 1; b[19] = unpaidSince === null ? 0 : 1;
  dv.setBigUint64(84, BigInt(tag), true); dv.setUint32(92, tiles, true); dv.setBigUint64(96, BigInt(excess), true);
  dv.setUint32(120, unpaidSince ?? 0xffffffff, true); dv.setUint32(124, lastClaimBell, true); b[128] = claimsInBell; b[129] = faction;
  return b;
}

/**
 * A fake world: `capture(p, q, bytes)`, `record(p, q, bytes)`, `player(wallet, bytes)`; `getJson(url)` answers the
 * herald's `/h/world/wide/route` (at most four places), `read(addresses)` the relay's account read. `calls` counts both.
 */
export function fakeTerritoryWorld({ programId = PROGRAM, seasonId = SEASON_ID } = {}) {
  const addresses = seasonAddresses(programId, seasonId);
  const caps = new Map(), accounts = new Map(), calls = { route: 0, read: 0, places: [], asked: [] };
  const citizenOf = wallet => addresses.of('Citizen', { wallet });
  return {
    addresses, programId, seasonId, calls, citizenOf,
    tagOf: wallet => citizenTagOf(citizenOf(wallet)),
    capture(p, q, bytes) { caps.set(`${p},${q}`, bytes); return this; },
    record(p, q, bytes) { accounts.set(territoryProvinceAddress(addresses.season, programId, String(p), String(q)), bytes); return this; },
    player(wallet, bytes) { accounts.set(territoryPlayerAddress(addresses.season, programId, citizenOf(wallet)), bytes); return this; },
    async getJson(url) {
      const u = new URL(url);
      if (u.pathname !== '/h/world/wide/route') throw new Error(`unexpected GET ${u.pathname}`);
      const places = decodeURIComponent(u.searchParams.get('at') ?? '').split(';').filter(Boolean);
      if (places.length < 1 || places.length > 4) throw new Error('RoutePlaces');
      calls.route++; calls.places.push(...places);
      return { route: places.filter(k => caps.has(k)).map(k => { const [p, q] = k.split(','); return { p, q, capture: { bytes_b64: Buffer.from(caps.get(k)).toString('base64') } }; }) };
    },
    async read(list) {
      if (!Array.isArray(list) || list.length < 1 || list.length > 16) throw new Error('WideReadShape');
      calls.read++; calls.asked.push(...list);
      return list.map(a => accounts.get(a) ?? null);
    },
  };
}
