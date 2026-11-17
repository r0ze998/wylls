// Bounded captured-land input for the original boundary composer. Capture
// consistency is not live account authority or a coherent chain snapshot.
import { parseWideManifest, parseU64, ringPosition } from './map/wide.mjs';
import { captureAddress } from './map/widecapture.mjs';
import { seasonAddresses } from './faddr.mjs';
import { fromBase64, toBase64 } from '../sdk/bytes.mjs';
import { traceWideDirections } from './fexpedition-seal.mjs';
import { routeLandFromBytes } from './fexpedition-route.mjs';

const check = (ok, code) => { if (!ok) throw Object.assign(new Error(code), { code }); };

/** Destination-first, at most four exact coordinates; never scan the world. */
export function outboundRoutePlaces(source, directions) {
  const trace = traceWideDirections({ world: source.world, origin: source.origin, directions });
  check(trace.steps.length > 0, 'ChooseSteps');
  return trace.accountKeys.map(key => {
    const at = trace.steps.find(t => t.key === key);
    return Object.freeze({ key, p: at.p, q: at.q });
  });
}

export function outboundRouteAddress(source, at) {
  const { ring, wedge, pos } = ringPosition(BigInt(at.p), BigInt(at.q));
  if (ring <= 128n) return seasonAddresses(source.program, source.seasonId).of('Province', { p: Number(at.p), q: Number(at.q) });
  const sort = new Uint8Array(17), v = new DataView(sort.buffer);
  v.setBigUint64(0, ring, false); sort[8] = wedge; v.setBigUint64(9, pos, false);
  return captureAddress('province', sort, null, source.season, source.program);
}

/** Refuse a swapped/extra/malformed row before using any returned land. */
export function parseOutboundRouteCaptures(json, { source, places }) {
  check(Array.isArray(places) && places.length >= 1 && places.length <= 4, 'RoutePlaces');
  const manifest = parseWideManifest(json, { seasonId: source.seasonId, seasonAddress: source.season, programId: source.program });
  check(manifest.world === source.world && manifest.captureBounds, 'RouteScope');
  check(Array.isArray(json.route) && json.route.length === places.length, 'RouteRows');
  const lands = new Map(), captures = [], unavailable = [];
  json.route.forEach((row, i) => {
    const at = places[i];
    check(row && row.p === at.p && row.q === at.q && ['captured', 'unknown', 'closed'].includes(row.state), 'RouteRows');
    if (row.state !== 'captured') {
      check(row.capture === null, 'RouteRows');
      unavailable.push(Object.freeze({ ...at, state: row.state })); return;
    }
    const c = row.capture;
    check(c && c.verification === 'captured-unverified' && ['transaction', 'at-or-after-transaction'].includes(c.postState), 'RouteCapture');
    check(c.address === outboundRouteAddress(source, at), 'RouteCaptureAddress');
    const slot = parseU64(c.slot, 'RouteCapture'), sequence = parseU64(c.archiveSequence, 'RouteCapture');
    check(slot <= manifest.captureBounds.lastSlot && sequence <= manifest.captureBounds.foldedThrough, 'RouteCaptureAhead');
    const wide = ringPosition(BigInt(at.p), BigInt(at.q)).ring > 128n, len = wide ? 4864 : 4736;
    check(typeof c.bytes_b64 === 'string' && c.bytes_b64.length === Math.ceil(len / 3) * 4 && /^[A-Za-z0-9+/]+={0,2}$/.test(c.bytes_b64), 'RouteCaptureBytes');
    const bytes = fromBase64(c.bytes_b64);
    check(bytes.length === len && toBase64(bytes) === c.bytes_b64, 'RouteCaptureBytes');
    lands.set(at.key, routeLandFromBytes({ source, at, bytes }));
    captures.push(Object.freeze({ ...at, address: c.address, slot: slot.toString(), archiveSequence: sequence.toString(), postState: c.postState }));
  });
  return Object.freeze({ lands, captures: Object.freeze(captures), unavailable: Object.freeze(unavailable),
    snapshot: manifest.snapshot, observationOnly: true, coherentSnapshotVerified: false, provenanceVerified: false, executable: false });
}

export async function loadOutboundRouteCaptures(client, source, directions, signal) {
  check(typeof client?.wideRoute === 'function', 'RouteReadUnavailable');
  const places = outboundRoutePlaces(source, directions);
  const result = await client.wideRoute({ places, signal });
  check(!signal?.aborted, 'Aborted');
  check(result?.ok, result?.code ?? 'RouteReadUnavailable');
  return parseOutboundRouteCaptures(result.json, { source, places });
}
