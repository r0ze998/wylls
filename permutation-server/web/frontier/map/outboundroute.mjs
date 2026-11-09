// The original canvas's boundary-route layer. These are user-chosen geometric
// tiles, not terrain, reach, arrival advice, recorded hosts or an executable order.
import { DIRECTIONS, tileHex } from '../fgeo.mjs';
import { wideTileAt, traceWideDirections } from '../fexpedition-seal.mjs';
import { parseWideInt, ringPosition } from './wide.mjs';
import { project, hexPoints } from '../../map.mjs';

const check = (ok, code) => { if (!ok) throw Object.assign(new Error(code), { code }); };
const abs = n => n < 0n ? -n : n;
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const exact = value => {
  // The legacy canvas produces small integer coordinates. Full-width callers
  // must supply canonical text/BigInt; unsafe numeric coordinates are refused.
  check(typeof value === 'string' || typeof value === 'bigint' || Number.isSafeInteger(value), 'MapTileRequired');
  return parseWideInt(String(value)).toString();
};

/** Resolve a hit against the source's world, never a village/host ID or index. */
export function outboundTileHit(world, hit) {
  check(!!hit && (hit.world === undefined || hit.world === world), 'WorldMismatch');
  const tile = hit.tile ?? hit.idx;
  check(hit.tile === undefined || hit.idx === undefined || hit.tile === hit.idx, 'MapTileMismatch');
  const at = wideTileAt({ world, p: exact(hit.p), q: exact(hit.q), tile });
  if (hit.key !== undefined) check(hit.key === at.key, 'MapTileMismatch');
  for (const k of ['tileQ', 'tileR']) if (hit[k] !== undefined) {
    check((typeof hit[k] === 'string' && /^(0|-?[1-9][0-9]*)$/.test(hit[k])) || typeof hit[k] === 'bigint' || Number.isSafeInteger(hit[k]), 'MapTileMismatch');
    check(String(hit[k]) === at[k], 'MapTileMismatch');
  }
  return at;
}

/** One adjacent step only. Repeated taps on the endpoint are a no-op. */
export function outboundHitDirection(source, directions, hit) {
  const at = outboundTileHit(source.world, hit);
  const trace = traceWideDirections({ world: source.world, origin: source.origin, directions });
  const dq = BigInt(at.tileQ) - BigInt(trace.endpoint.tileQ), dr = BigInt(at.tileR) - BigInt(trace.endpoint.tileR);
  if (dq === 0n && dr === 0n) return null;
  const direction = DIRECTIONS.findIndex(([q, r]) => BigInt(q) === dq && BigInt(r) === dr);
  check(direction >= 0, 'AdjacentTileRequired');
  return direction;
}

/** Bounded presentation from an original origin plus exact relative offsets.
 * No wide province or global wide tile coordinate is narrowed through Number. */
export function outboundMapGeometry(source, directions) {
  const trace = traceWideDirections({ world: source.world, origin: source.origin, directions });
  const p = BigInt(trace.origin.p), q = BigInt(trace.origin.q);
  check(ringPosition(p, q).ring <= 128n, 'OriginalOriginRequired');
  const anchor = tileHex(Number(p), Number(q), trace.origin.tile);
  const projected = at => {
    const dq = BigInt(at.tileQ) - BigInt(trace.origin.tileQ), dr = BigInt(at.tileR) - BigInt(trace.origin.tileR);
    check(abs(dq) <= 33n && abs(dr) <= 33n && abs(dq + dr) <= 33n, 'MapOffset');
    return { q: anchor.q + Number(dq), r: anchor.r + Number(dr) };
  };
  const hexes = [trace.origin, ...trace.steps].map(projected), next = [];
  if (directions.length < 32) for (let direction = 0; direction < 6; direction++) {
    try {
      const candidate = traceWideDirections({ world: source.world, origin: source.origin, directions: [...directions, direction] }).endpoint;
      next.push({ direction, tile: candidate, hex: projected(candidate) });
    } catch { /* A fifth entered province or world edge is not a candidate. */ }
  }
  return freeze({ world: source.world, host: source.host, hostId: source.hostId,
    origin: trace.origin, endpoint: trace.endpoint, hexes, next, steps: directions.length,
    verification: 'geometry-only', terrainVerified: false, costVerified: false, arrivalVerified: false,
    executable: false, admitted: false, arriveBell: null });
}

/** Separate dashed ink, never the ordinary executable march ribbon. */
export function paintOutboundRoute(ctx, model, zoom, { tiles = true } = {}) {
  if (!model?.hexes?.length || model.verification !== 'geometry-only') return;
  ctx.save();
  ctx.strokeStyle = '#76529b'; ctx.fillStyle = 'rgba(118,82,155,.12)';
  ctx.lineWidth = 2 / zoom; ctx.setLineDash([5 / zoom, 5 / zoom]);
  if (model.hexes.length > 1) {
    ctx.beginPath();
    model.hexes.forEach((h, i) => { const p = project(h.q, h.r); if (i) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y); });
    ctx.stroke();
  }
  if (tiles) for (const choice of model.next) {
    const centre = project(choice.hex.q, choice.hex.r);
    ctx.beginPath();
    hexPoints(centre.x, centre.y).forEach(([x, y], i) => { if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
    ctx.closePath(); ctx.fill(); ctx.stroke();
  }
  ctx.setLineDash([]);
  const end = project(model.hexes.at(-1).q, model.hexes.at(-1).r);
  ctx.beginPath(); ctx.arc(end.x, end.y, 6 / zoom, 0, Math.PI * 2); ctx.stroke();
  ctx.restore();
}
