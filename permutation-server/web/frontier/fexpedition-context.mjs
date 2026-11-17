// One bounded account/Clock observation for the original departure card.
// Content binding and RPC coherence are not freshness or signer authority.
import { encode, decode as fromB58 } from '../sdk/base58.mjs';
import { fromBase64, toBase64, toHex, utf8 } from '../sdk/bytes.mjs';
import { sha256 } from '../sdk/sha256.mjs';
import { LAYOUTS } from '../sdk/frontier/abi-v2-layouts.mjs';
import { decode } from './fcodec.mjs';
import { seasonAddresses } from './faddr.mjs';
import { canonicalOutboundRoles } from './fexpedition-depart.mjs';
import { traceWideDirections } from './fexpedition-seal.mjs';
import { outboundRoutePlaces, outboundRouteAddress } from './fexpedition-route-read.mjs';
import { routeLandFromBytes } from './fexpedition-route.mjs';
import { parseU64, parseWideInt, ringPosition } from './map/wide.mjs';
import { readInspection } from './fexpedition.mjs';

export const OUTBOUND_CONTEXT_REQUEST = 'frontier-original-outbound-snapshot-request-v1';
export const OUTBOUND_CONTEXT_REPORT = 'frontier-original-outbound-snapshot-v1';
const CLOSED = ['dispatch_available', 'executable', 'admitted', 'signed', 'enqueued'];
const check = (ok, code = 'OutboundSnapshotInvalid') => { if (!ok) throw Object.assign(new Error(code), { code }); };
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const exact = (x, fields) => object(x) && Object.keys(x).length === fields.length && fields.every(k => Object.hasOwn(x, k));
const stable = x => JSON.stringify(x, (_, v) => object(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
const freeze = x => { if (object(x) || Array.isArray(x)) { Object.values(x).forEach(freeze); Object.freeze(x); } return x; };
const bytes64 = (s, length) => {
  check(typeof s === 'string' && s.length === Math.ceil(length / 3) * 4 && /^[A-Za-z0-9+/]+={0,2}$/.test(s), 'OutboundSnapshotBytes');
  const b = fromBase64(s); check(b.length === length && toBase64(b) === s, 'OutboundSnapshotBytes'); return b;
};
const addressBytes = s => { let b; try { b = fromB58(s); } catch { check(false); } check(b.length === 32 && encode(b) === s); return b; };
const le = (n, width) => {
  const b = new Uint8Array(width), v = new DataView(b.buffer);
  if (width === 8) v.setBigUint64(0, BigInt(n), true); else v.setUint32(0, Number(n), true);
  return b;
};

/** Exact public request, independent of caller mutations. No payer or keys. */
export function outboundSnapshotRequest(source, directions, { minSlot = '0' } = {}) {
  canonicalOutboundRoles(source, { transitSlot: 0 });
  const seasonId = parseU64(String(source.seasonId)).toString();
  check(seasonAddresses(source.program, seasonId).season === source.season, 'SeasonPinMismatch');
  check(/^[a-z0-9-]{1,32}$/.test(source.cluster) && Number.isInteger(source.programVersion)
    && source.programVersion >= 0 && source.programVersion <= 65535 && (source.programVersion & 0x4000) !== 0
    && /^[0-9a-f]{64}$/.test(source.ruleset), 'DeploymentPinMissing');
  const trace = traceWideDirections({ world: source.world, origin: source.origin, directions });
  check(trace.pathComplete && BigInt(trace.endpoint.ring) > 128n, 'WideDestinationRequired');
  return freeze({ schema: OUTBOUND_CONTEXT_REQUEST, operation: 'outbound_snapshot', cluster: source.cluster,
    program: source.program, season: source.season, season_id: seasonId,
    deployment: { program_version: String(source.programVersion), ruleset_hash: source.ruleset },
    host: source.host, wallet: source.wallet,
    origin: { p: parseWideInt(source.origin.p).toString(), q: parseWideInt(source.origin.q).toString(), tile: source.origin.tile },
    directions: [...directions], min_slot: parseU64(minSlot).toString() });
}

export function outboundSnapshotRequestDigest(r) {
  return toHex(sha256(utf8(`${OUTBOUND_CONTEXT_REQUEST}\n${[r.operation, r.cluster, r.program, r.season, r.season_id,
    r.deployment.program_version, r.deployment.ruleset_hash, r.host, r.wallet, r.origin.p, r.origin.q,
    String(r.origin.tile), r.directions.join(','), r.min_slot].join('\n')}\n`)));
}

/** Same encoding as fclient::snapshot::digest_of; all unique caller accounts,
 * including absent route accounts, followed by the complete Clock and no Rent. */
export function outboundSnapshotContentDigest({ contextSlot, minSlot, accounts, clockBytes }) {
  const rows = [...accounts].map(([address, account]) => ({ address: addressBytes(address), account }));
  rows.sort((a, b) => toHex(a.address) < toHex(b.address) ? -1 : toHex(a.address) > toHex(b.address) ? 1 : 0);
  const parts = [utf8('PSF-KEEPER-WIDE-SNAPSHOT-v1'), le(contextSlot, 8), le(minSlot, 8), le(9, 4), utf8('confirmed'), le(rows.length, 4)];
  for (const { address, account } of rows) {
    parts.push(address, Uint8Array.of(account ? 1 : 0));
    if (account) parts.push(le(account.lamports, 8), addressBytes(account.owner), Uint8Array.of(account.executable ? 1 : 0),
      le(account.bytes.length, 4), account.bytes);
  }
  parts.push(Uint8Array.of(0xc1), clockBytes, Uint8Array.of(0));
  return toHex(sha256(...parts));
}

/** Parse the full same-response observation before exposing any decoded state.
 * No account is written into the normal map, wallet or marching state. */
export function parseOutboundSnapshot(value, request, { source }) {
  const expected = outboundSnapshotRequest(source, request.directions, { minSlot: request.min_slot });
  check(stable(expected) === stable(request), 'OutboundSnapshotScope');
  check(exact(value, ['schema', 'status', 'request_digest', 'scope', 'source', 'clock', 'accounts', 'route', 'blocker', 'observation_only', ...CLOSED]));
  check(value.schema === OUTBOUND_CONTEXT_REPORT && value.observation_only === true && CLOSED.every(k => value[k] === false));
  check(value.request_digest === outboundSnapshotRequestDigest(request) && stable(value.scope) === stable(request), 'OutboundSnapshotScope');
  if (value.status === 'blocked') {
    check(value.source === null && value.clock === null && value.accounts === null && value.route === null
      && exact(value.blocker, ['code']) && /^[A-Za-z][A-Za-z0-9]{0,79}$/.test(value.blocker.code));
    return Object.freeze({ status: 'blocked', code: value.blocker.code, observationOnly: true, executable: false });
  }
  check(value.status === 'snapshot' && value.blocker === null);
  const meta = value.source;
  check(exact(meta, ['kind', 'read_calls', 'coherent', 'single_response', 'context_slot', 'min_slot', 'commitment', 'digest', 'authority_verified', 'freshness', 'complete_world_view']));
  check(meta.kind === 'single_snapshot_source' && meta.read_calls === '1' && meta.coherent === true && meta.single_response === true
    && meta.commitment === 'confirmed' && meta.authority_verified === false && meta.freshness === 'unknown' && meta.complete_world_view === false
    && meta.min_slot === request.min_slot && /^[0-9a-f]{64}$/.test(meta.digest), 'OutboundSnapshotCoherence');
  const contextSlot = parseU64(meta.context_slot), minSlot = parseU64(request.min_slot);
  check(contextSlot >= minSlot, 'OutboundSnapshotStale');
  check(exact(value.clock, ['slot', 'unix_timestamp', 'bytes_b64']) && value.clock.slot === meta.context_slot
    && /^(0|-?[1-9][0-9]{0,18})$/.test(value.clock.unix_timestamp), 'OutboundSnapshotClock');
  const clockBytes = bytes64(value.clock.bytes_b64, 40), cv = new DataView(clockBytes.buffer);
  check(cv.getBigUint64(0, true) === contextSlot && cv.getBigInt64(32, true).toString() === value.clock.unix_timestamp, 'OutboundSnapshotClock');
  const roles = canonicalOutboundRoles(source, { transitSlot: 0 }), role = name => roles.find(x => x.name === name).address;
  const base = { season: [source.season, 'Season'], citizen: [role('citizen'), 'Citizen'], holding: [role('holding'), 'Holding'],
    home: [role('holding_province'), 'Province'], standing: [role('province'), 'Province'] };
  check(exact(value.accounts, Object.keys(base)));
  const accounts = new Map(), serialized = new Map(), decoded = {}, rawSource = {}, lands = new Map(), unavailable = [];
  function account(row, address, length, nullable = false) {
    if (row === null) { check(nullable, 'OutboundSnapshotAbsent'); }
    else {
      check(exact(row, ['address', 'owner', 'lamports', 'executable', 'bytes_b64']) && row.address === address
        && row.owner === source.program && row.executable === false, 'OutboundSnapshotAccount');
      parseU64(row.lamports);
    }
    const text = stable(row);
    if (serialized.has(address)) check(serialized.get(address) === text, 'OutboundSnapshotAlias');
    else serialized.set(address, text);
    const result = row === null ? null : { owner: row.owner, lamports: row.lamports, executable: false, bytes: bytes64(row.bytes_b64, length) };
    accounts.set(address, result); return result;
  }
  for (const [name, [address, kind]] of Object.entries(base)) {
    const raw = account(value.accounts[name], address, LAYOUTS.accounts.find(a => a.kind === kind).size).bytes;
    check(new DataView(raw.buffer).getUint16(16, true) === 2, 'OutboundSnapshotVersion');
    rawSource[name] = raw;
    decoded[name] = decode(kind, raw, { profile: 2, seasonId: request.season_id });
  }
  check(decoded.season.programVersion === Number(request.deployment.program_version)
    && toHex(decoded.season.rulesetHash) === request.deployment.ruleset_hash, 'DeploymentPinMissing');
  check(decoded.home.p === Number(source.home.p) && decoded.home.q === Number(source.home.q)
    && String(decoded.standing.p) === request.origin.p && String(decoded.standing.q) === request.origin.q, 'OutboundSnapshotAccount');
  const places = outboundRoutePlaces(source, request.directions);
  check(Array.isArray(value.route) && value.route.length === places.length, 'OutboundSnapshotRoute');
  value.route.forEach((row, i) => {
    const at = places[i];
    check(exact(row, ['key', 'p', 'q', 'account']) && row.key === at.key && row.p === at.p && row.q === at.q, 'OutboundSnapshotRoute');
    const wide = ringPosition(BigInt(at.p), BigInt(at.q)).ring > 128n;
    const raw = account(row.account, outboundRouteAddress(source, at), wide ? 4864 : 4736, true);
    if (raw) lands.set(at.key, routeLandFromBytes({ source, at, bytes: raw.bytes }));
    else unavailable.push(Object.freeze({ ...at, state: 'unknown' }));
  });
  check(outboundSnapshotContentDigest({ contextSlot, minSlot, accounts, clockBytes }) === meta.digest, 'OutboundSnapshotDigest');
  const hosts = decoded.standing.entries.filter(x => String(x.id) === source.hostId && x.state !== 0);
  check(hosts.length === 1 && hosts[0].tile === request.origin.tile, 'OutboundSnapshotHostChanged');
  const host = hosts[0], observedSource = Object.freeze({ ...source, unit: host.unit, faction: host.faction, holdingFlags: decoded.holding.flags });
  return Object.freeze({ status: 'snapshot', source: observedSource, season: decoded.season, citizen: decoded.citizen,
    holding: decoded.holding, holdingBytes: rawSource.holding, ownProvince: decoded.home, province: decoded.standing, host,
    clock: Object.freeze({ slot: contextSlot, unixTimestamp: cv.getBigInt64(32, true) }),
    lands, unavailable: Object.freeze(unavailable), contextSlot: meta.context_slot, digest: meta.digest,
    coherent: true, contentConsistent: true, authorityVerified: false, freshness: 'unknown', observationOnly: true, executable: false });
}

export async function readOutboundSnapshot(source, directions, { minSlot = '0', read = readInspection, ...options } = {}) {
  const request = outboundSnapshotRequest(source, directions, { minSlot });
  const report = await read(request, options);
  return parseOutboundSnapshot(report, request, { source });
}
