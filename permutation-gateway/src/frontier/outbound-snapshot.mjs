// Closed request/report validation for the original composer's one-response
// context. No RPC, child process, private material or execution here.
import { createHash } from 'node:crypto';
import { decode, encode } from '../../client/src/base58.mjs';
import { seasonAddresses } from '../../../permutation-server/web/frontier/faddr.mjs';
import { decodeWideHostRef, traceWideDirections } from '../../../permutation-server/web/frontier/fexpedition-seal.mjs';
import { worldIdOf, ringPosition } from '../../../permutation-server/web/frontier/map/wide.mjs';
import { captureAddress } from '../../../permutation-server/web/frontier/map/widecapture.mjs';
import { LAYOUTS } from '../../../permutation-server/web/sdk/frontier/abi-v2-layouts.mjs';

export const OUTBOUND_SNAPSHOT_REQUEST_SCHEMA = 'frontier-original-outbound-snapshot-request-v1';
export const OUTBOUND_SNAPSHOT_REPORT_SCHEMA = 'frontier-original-outbound-snapshot-v1';
const check = yes => { if (!yes) throw new Error('OutboundSnapshotContract'); };
const exact = (v, names) => v && typeof v === 'object' && !Array.isArray(v)
  && Object.keys(v).length === names.length && names.every(k => Object.hasOwn(v, k));
const fields = ['schema', 'operation', 'cluster', 'program', 'season', 'season_id', 'deployment', 'host', 'wallet', 'origin', 'directions', 'min_slot'];
const closed = ['dispatch_available', 'executable', 'admitted', 'signed', 'enqueued'];
const uint = (x, max = 0xffffffffffffffffn) => typeof x === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(x) && BigInt(x) <= max;
const signed = x => typeof x === 'string' && /^(0|-?[1-9][0-9]{0,18})$/.test(x) && BigInt(x) >= -(1n << 63n) && BigInt(x) < (1n << 63n);
const publicAddress = x => {
  check(typeof x === 'string' && x.length >= 32 && x.length <= 44);
  const b = decode(x); check(b.length === 32 && b.some(x => x !== 0) && encode(b) === x); return x;
};
export function outboundSnapshotRequest(v) {
  check(exact(v, fields) && v.schema === OUTBOUND_SNAPSHOT_REQUEST_SCHEMA && v.operation === 'outbound_snapshot');
  check(typeof v.cluster === 'string' && /^[a-z0-9-]{1,32}$/.test(v.cluster));
  publicAddress(v.program); publicAddress(v.season); publicAddress(v.wallet);
  check(v.program !== v.season && v.wallet !== v.program && v.wallet !== v.season);
  check(uint(v.season_id) && uint(v.min_slot));
  check(exact(v.deployment, ['program_version', 'ruleset_hash']) && uint(v.deployment.program_version, 65535n)
    && (BigInt(v.deployment.program_version) & 0x4000n) !== 0n && /^[0-9a-f]{64}$/.test(v.deployment.ruleset_hash));
  check(exact(v.origin, ['p', 'q', 'tile']) && signed(v.origin.p) && signed(v.origin.q)
    && Number.isInteger(v.origin.tile) && v.origin.tile >= 0 && v.origin.tile < 61);
  const addresses = seasonAddresses(v.program, v.season_id); check(addresses.season === v.season);
  const host = decodeWideHostRef(v.host), world = worldIdOf(v.season, v.program);
  check(host.world === world && BigInt(host.ring) <= 128n);
  const route = traceWideDirections({ world, origin: v.origin, directions: v.directions });
  check(route.pathComplete && BigInt(route.origin.ring) <= 128n && BigInt(route.endpoint.ring) > 128n);
  return Object.freeze({ ...v, deployment: Object.freeze({ ...v.deployment }), origin: Object.freeze({ ...v.origin }), directions: Object.freeze([...v.directions]) });
}
export function outboundSnapshotRequestDigest(r) {
  const values = [r.operation, r.cluster, r.program, r.season, r.season_id, r.deployment.program_version,
    r.deployment.ruleset_hash, r.host, r.wallet, r.origin.p, r.origin.q, String(r.origin.tile), r.directions.join(','), r.min_slot];
  return createHash('sha256').update(`${OUTBOUND_SNAPSHOT_REQUEST_SCHEMA}\n${values.join('\n')}\n`).digest('hex');
}
export function outboundSnapshotAddresses(r) {
  const addresses = seasonAddresses(r.program, r.season_id), host = decodeWideHostRef(r.host);
  const home = { p: Number(host.p), q: Number(host.q), site: host.site };
  const source = { season: r.season, citizen: addresses.of('Citizen', { wallet: r.wallet }),
    holding: addresses.of('Holding', home), home: addresses.of('Province', home),
    standing: addresses.of('Province', { p: Number(r.origin.p), q: Number(r.origin.q) }) };
  const trace = traceWideDirections({ world: host.world, origin: r.origin, directions: r.directions });
  const route = trace.accountKeys.map(key => {
    const at = trace.steps.find(t => t.key === key), rp = ringPosition(BigInt(at.p), BigInt(at.q));
    let address;
    if (rp.ring <= 128n) address = addresses.of('Province', { p: Number(at.p), q: Number(at.q) });
    else {
      const sort = new Uint8Array(17), view = new DataView(sort.buffer);
      view.setBigUint64(0, rp.ring, false); sort[8] = rp.wedge; view.setBigUint64(9, rp.pos, false);
      address = captureAddress('province', sort, null, r.season, r.program);
    }
    return { key, p: at.p, q: at.q, address, wide: rp.ring > 128n };
  });
  return { source, route };
}
const BLOCKERS = new Set(['Arguments', 'InputRead', 'RuntimeUnavailable', 'RequestShape', 'RequestInteger', 'RequestAddress', 'RequestHex',
  'RequestTooLarge', 'RequestJson', 'RequestSchema', 'RequestCluster', 'RequestScope', 'RequestVersion', 'RequestHost', 'RequestOrigin',
  'RequestPath', 'RequestDestination', 'SnapshotMismatch', 'SnapshotAccount', 'SourceAbsent', 'SourceLayout', 'DeploymentMismatch',
  'RouteIdentity', 'OutputTooLarge', 'SnapshotUnavailable', 'SnapshotTimeout']);
function rawBytes(s, length) {
  check(typeof s === 'string' && s.length === Math.ceil(length / 3) * 4);
  const b = Buffer.from(s, 'base64'); check(b.length === length && b.toString('base64') === s); return b;
}
function le(value, bytes) { const b = Buffer.alloc(bytes); bytes === 8 ? b.writeBigUInt64LE(BigInt(value)) : b.writeUInt32LE(Number(value)); return b; }

/** Recompute fclient SnapshotMeta's complete account/Clock binding. */
export function outboundSnapshotDigest(source, rows, clockBytes) {
  const hash = createHash('sha256').update('PSF-KEEPER-WIDE-SNAPSHOT-v1').update(le(source.context_slot, 8))
    .update(le(source.min_slot, 8)).update(le(9, 4)).update('confirmed').update(le(rows.size, 4));
  const sorted = [...rows].sort(([a], [b]) => Buffer.compare(Buffer.from(decode(a)), Buffer.from(decode(b))));
  for (const [address, a] of sorted) {
    hash.update(decode(address)).update(Uint8Array.of(a === null ? 0 : 1));
    if (a) hash.update(le(a.lamports, 8)).update(decode(a.owner)).update(Uint8Array.of(0))
      .update(le(Buffer.from(a.bytes_b64, 'base64').length, 4)).update(Buffer.from(a.bytes_b64, 'base64'));
  }
  return hash.update(Uint8Array.of(0xc1)).update(clockBytes).update(Uint8Array.of(0)).digest('hex');
}
export function outboundSnapshotReport(v, request) {
  check(exact(v, ['schema', 'status', 'request_digest', 'scope', 'source', 'clock', 'accounts', 'route', 'blocker', 'observation_only', ...closed]));
  check(v.schema === OUTBOUND_SNAPSHOT_REPORT_SCHEMA && ['snapshot', 'blocked'].includes(v.status)
    && v.observation_only === true && closed.every(k => v[k] === false));
  if (v.scope === null || v.request_digest === null) check(v.scope === null && v.request_digest === null && v.status === 'blocked');
  else check(outboundSnapshotRequestDigest(outboundSnapshotRequest(v.scope)) === outboundSnapshotRequestDigest(request)
    && v.request_digest === outboundSnapshotRequestDigest(request));
  if (v.status === 'blocked') {
    check(exact(v.blocker, ['code']) && BLOCKERS.has(v.blocker.code) && v.source === null && v.clock === null && v.accounts === null && v.route === null);
    return v;
  }
  check(v.scope !== null && v.blocker === null);
  const s = v.source;
  check(exact(s, ['kind', 'read_calls', 'coherent', 'single_response', 'context_slot', 'min_slot', 'commitment', 'digest', 'authority_verified', 'freshness', 'complete_world_view'])
    && s.kind === 'single_snapshot_source' && s.read_calls === '1' && s.coherent === true && s.single_response === true
    && uint(s.context_slot) && s.min_slot === request.min_slot && BigInt(s.context_slot) >= BigInt(request.min_slot)
    && s.commitment === 'confirmed' && /^[0-9a-f]{64}$/.test(s.digest) && s.authority_verified === false
    && s.freshness === 'unknown' && s.complete_world_view === false);
  check(exact(v.clock, ['slot', 'unix_timestamp', 'bytes_b64']) && v.clock.slot === s.context_slot && signed(v.clock.unix_timestamp));
  const clock = rawBytes(v.clock.bytes_b64, 40);
  check(clock.readBigUInt64LE(0).toString() === v.clock.slot && clock.readBigInt64LE(32).toString() === v.clock.unix_timestamp);
  const expected = outboundSnapshotAddresses(request), rows = new Map();
  function account(a, address, size, optional = false) {
    if (a === null) check(optional);
    else {
      check(exact(a, ['address', 'owner', 'lamports', 'executable', 'bytes_b64']) && a.address === address && a.owner === request.program && uint(a.lamports) && a.executable === false);
      rawBytes(a.bytes_b64, size);
    }
    if (rows.has(address)) check(JSON.stringify(rows.get(address)) === JSON.stringify(a)); else rows.set(address, a);
  }
  check(exact(v.accounts, Object.keys(expected.source)));
  for (const [name, address] of Object.entries(expected.source)) {
    const kind = { season: 'Season', citizen: 'Citizen', holding: 'Holding', home: 'Province', standing: 'Province' }[name];
    account(v.accounts[name], address, LAYOUTS.accounts.find(a => a.kind === kind).size);
  }
  check(Array.isArray(v.route) && v.route.length === expected.route.length);
  v.route.forEach((row, i) => {
    const want = expected.route[i]; check(exact(row, ['key', 'p', 'q', 'account']) && ['key', 'p', 'q'].every(k => row[k] === want[k]));
    account(row.account, want.address, want.wide ? 4864 : 4736, true);
  });
  check(outboundSnapshotDigest(s, rows, clock) === s.digest); return v;
}
