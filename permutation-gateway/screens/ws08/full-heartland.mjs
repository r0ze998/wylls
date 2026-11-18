// Workstream 08, doc 31 §1 option A: a FULL heartland in the screens fixture (server.mjs `heraldWith`, opt-in).
//
// The fixture's Season is an instant-home one under the wedge rule with no conquest block (layout 1, program 2), so the
// rings a first village may be placed in are its open rings from ring 2 (home.mjs homeRingsOpen). With rings 0 .. 3 open
// (`srv.openRings(4)`) those are rings 2 and 3: for one nation 5 provinces × 12 sites = 60 places — the same count as
// the heartland of a v2 Season (heartland_max_ring = 3). This helper answers, for nation `faction`'s wedge:
//   - /h/province/{P},{Q}/…  the fixture's own Province with every site held by that nation (decoded, changed, encoded
//     again with the fixture's encoder), except `open` = {p, q, site} when one is asked to stay free;
//   - /h/overview/{d}/…      the fixture's overview with those provinces' site codes and owners saying the same;
//   - /h/roster/{d}/…        the fixture's roster with a villager on each of those sites (what the map draws).
// Everything else is the fixture's own answer. Nothing here is a rule: it is occupancy, as a herald would show it.
import { ringProvinces, wedgeOf } from '../../../permutation-server/web/frontier/fgeo.mjs';
import { homeWedge } from '../../../permutation-server/web/frontier/fland.mjs';
import { decode } from '../../../permutation-server/web/frontier/fcodec.mjs';
import * as W from '../world.mjs';

export const HOME_RINGS = Object.freeze([2, 3]);
export const SITES = 12;
/** The provinces of the nation's wedge in the home rings (5 of them: 60 sites). */
export const heartland = faction => HOME_RINGS.flatMap(d => ringProvinces(d)).filter(pr => wedgeOf(pr.p, pr.q) === homeWedge(faction));

/** `srv.heraldWith(fullHeartland({faction, open}))`: see the head of this file. */
export function fullHeartland({ faction = 0, open = null } = {}) {
  const mine = new Set(heartland(faction).map(pr => `${pr.p},${pr.q}`));
  const free = (p, q, s) => !!open && open.p === p && open.q === q && open.site === s;
  const sorted = d => ringProvinces(d).sort((a, b) => a.p - b.p || a.q - b.q);   // the order world.mjs writes a ring in
  return (path, stage) => {
    let m;
    if ((m = /^\/h\/province\/(-?\d+),(-?\d+)\/(latest|\d+)$/.exec(path))) {
      const p = Number(m[1]), q = Number(m[2]);
      if (!mine.has(`${p},${q}`)) return null;
      const env = W.provinceEnvelope(p, q, m[3] === 'latest' ? W.BELL : Number(m[3]), stage);
      const { kind, ...pv } = decode('Province', Buffer.from(env.bytes, 'base64'));
      pv.siteMirror = pv.siteMirror.map((site, s) => (free(p, q, s) ? { ...site, state: 0, faction: 6, order: 0, tier: 0, garrison: 0 } : { ...site, state: 1, faction, order: 1, tier: 1, gen: 0, garrison: 90_000 }));
      pv.nSitesUsed = pv.siteMirror.filter(x => x.state === 1).length;
      // (no host, no camp: the fixture's home province carries the viewer's own village and hosts, which a viewer
      //  without a village does not have)
      pv.entries = []; pv.nEntries = 0;
      return { json: { ...env, bytes: Buffer.from(W.encode('Province', pv)).toString('base64') } };
    }
    if ((m = /^\/h\/overview\/(\d+)\/(?:latest|\d+)\.bin$/.exec(path)) && HOME_RINGS.includes(Number(m[1]))) {
      const d = Number(m[1]), out = Buffer.from(W.overview(d));
      sorted(d).forEach((pr, i) => {
        if (!mine.has(`${pr.p},${pr.q}`)) return;
        const o = 32 + 24 * i;
        let owners = 0n, sites = 0, held = 0;
        for (let s = 0; s < SITES; s++) {
          const f = free(pr.p, pr.q, s);
          owners |= BigInt(f ? 7 : faction) << BigInt(3 * s);
          sites |= (f ? 0 : 1) << (2 * s);
          if (!f) held++;
        }
        for (let j = 0; j < 5; j++) out[o + 4 + j] = Number((owners >> BigInt(8 * j)) & 0xffn);
        out[o + 9] = sites & 0xff; out[o + 10] = (sites >> 8) & 0xff; out[o + 11] = (sites >> 16) & 0xff;
        for (let f = 0; f < 7; f++) out[o + 12 + f] = f === faction ? held : 0;
        out[o + 19] = 0;
      });
      return { bytes: out };
    }
    if ((m = /^\/h\/roster\/(\d+)\/latest\.bin$/.exec(path)) && HOME_RINGS.includes(Number(m[1]))) {
      const d = Number(m[1]), out = Buffer.from(W.roster(d)), dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
      sorted(d).forEach((pr, i) => {
        if (!mine.has(`${pr.p},${pr.q}`)) return;
        const o = 32 + 196 * i;
        for (let s = 0; s < SITES; s++) {
          const f = free(pr.p, pr.q, s);
          dv.setBigUint64(o + 4 + s * 16, f ? 0n : 0x5eed0000n + BigInt((pr.p + 64) * 4096 + (pr.q + 64) * 16 + s), true);
          dv.setUint32(o + 12 + s * 16, f ? 0 : 1, true);
          out[o + 16 + s * 16] = f ? 0 : (s + i) % 4;
        }
      });
      return { bytes: out };
    }
    return null;
  };
}
