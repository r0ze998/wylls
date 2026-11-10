// Explicitly synthetic public observations for bounded browser/unit cases.
// No RPC, keys, signed receipt, chain history or departure is fabricated.
import { encodeAccount } from '../../../permutation-server/web/sdk/frontier/codec.mjs';
import { decode as fromB58 } from '../../../permutation-server/web/sdk/base58.mjs';
import { fromHex, toBase64 } from '../../../permutation-server/web/sdk/bytes.mjs';
import { hostId } from '../../../permutation-server/web/frontier/faddr.mjs';
import { decodeWideHostRef } from '../../../permutation-server/web/frontier/fexpedition-seal.mjs';
import { ringPosition } from '../../../permutation-server/web/frontier/map/wide.mjs';
import { outboundSnapshotAddresses, outboundSnapshotRequestDigest, outboundSnapshotDigest,
  OUTBOUND_SNAPSHOT_REPORT_SCHEMA } from '../../src/frontier/outbound-snapshot.mjs';

export function syntheticOutboundSnapshot(request, { contextSlot = '5000', genesis = 1800000000n,
  unixTimestamp = genesis + 6000n, missing = false, stamina = 120, wideBytes = null } = {}) {
  const expected = outboundSnapshotAddresses(request), host = decodeWideHostRef(request.host);
  const home = { p: Number(host.p), q: Number(host.q), site: host.site, gen: host.gen, seq: host.seq };
  const origin = { p: Number(request.origin.p), q: Number(request.origin.q) }, bell = Number((unixTimestamp - genesis) / 600n);
  const raw = (kind, fields) => encodeAccount(kind, { LAYOUT_VERSION: 2, SEASON_ID: BigInt(request.season_id), ...fields }, { profile: 2 });
  const province = (p, q, standing) => {
    const at = ringPosition(BigInt(p), BigInt(q));
    return raw('Province', { P: p, Q: q, RING: Number(at.ring), WEDGE: at.wedge, RESOLVED_NEXT: bell + 1,
      PASSABLE_MASK: (1n << 61n) - 1n,
      SITE_MIRROR: Array.from({ length: 12 }, (_, i) => i === home.site ? { STATE: 1, GEN: home.gen } : {}),
      ENTRIES: standing ? [{ ID: hostId(home), STATE: 1, UNIT: 0, FACTION: 0, TILE: request.origin.tile,
        TROOPS: 600000, STAMINA_VALUE: stamina, STAMINA_BELL: bell, READY_BELL: bell }] : [] });
  };
  const sourceBytes = {
    season: raw('Season', { PROGRAM_VERSION: Number(request.deployment.program_version), RULESET_HASH: fromHex(request.deployment.ruleset_hash),
      STATUS: 3, GENESIS_TS: genesis, MIN_LEAD: 2, MAX_LEAD: 72, END_BELL: 100000,
      MIN_REVEAL_PRIORITY_MILLI: 433, REVEAL_CU_LIMIT: 26000, REVEAL_LOADED_LIMIT: 1540096,
      MARCH_FEE: 10000n, SEAL_BOND: 20000n, DRAND_GENESIS: 1692803367n, DRAND_PERIOD: 3, BUCKET_RATE_PER_H: 120, BUCKET_BURST: 4 }),
    citizen: raw('Citizen', { WALLET: fromB58(request.wallet), FLAGS: 5, BUCKET_MILLI: 4000, BUCKET_T: bell * 600,
      HOLDING: [{ P: home.p, Q: home.q, SITE: home.site, GEN: home.gen }, { GEN: 255 }, { GEN: 255 }] }),
    holding: raw('Holding', { P: home.p, Q: home.q, SITE: home.site, GEN: home.gen, ORDER: 1, STATE: 2,
      HOST_SEQ: home.seq + 1, OWNER_CITIZEN: fromB58(expected.source.citizen) }),
    home: province(home.p, home.q, home.p === origin.p && home.q === origin.q),
    standing: province(origin.p, origin.q, true),
  };
  const rows = new Map(), account = (address, bytes) => {
    if (rows.has(address)) return rows.get(address);
    const row = bytes === null ? null : { address, owner: request.program, lamports: '123456789', executable: false, bytes_b64: toBase64(bytes) };
    rows.set(address, row); return row;
  };
  const accounts = Object.fromEntries(Object.entries(expected.source).map(([name, address]) => [name, account(address, sourceBytes[name])]));
  const route = expected.route.map(at => {
    let bytes = null;
    if (!missing) {
      if (!at.wide) bytes = province(Number(at.p), Number(at.q), at.p === request.origin.p && at.q === request.origin.q);
      else if (wideBytes) bytes = new Uint8Array(wideBytes);
      else {
        bytes = new Uint8Array(4864); bytes.set(province(0, 0, false)); bytes.set(new TextEncoder().encode('PSFXWPV1'));
        const v = new DataView(bytes.buffer), atRing = ringPosition(BigInt(at.p), BigInt(at.q));
        v.setUint16(16, 3, true); bytes[70] = atRing.wedge;
        v.setUint16(4736, 1, true); bytes[4738] = 1; bytes[4739] = 15;
        bytes.set(fromHex(host.world), 4740); bytes.set(fromHex(at.key.slice(66)), 4772); bytes.fill(7, 4800, 4832);
      }
    }
    return { key: at.key, p: at.p, q: at.q, account: account(at.address, bytes) };
  });
  const cb = new Uint8Array(40), cv = new DataView(cb.buffer);
  cv.setBigUint64(0, BigInt(contextSlot), true); cv.setBigInt64(32, unixTimestamp, true);
  const source = { kind: 'single_snapshot_source', read_calls: '1', coherent: true, single_response: true,
    context_slot: contextSlot, min_slot: request.min_slot, commitment: 'confirmed', digest: '',
    authority_verified: false, freshness: 'unknown', complete_world_view: false };
  source.digest = outboundSnapshotDigest(source, rows, cb);
  return { schema: OUTBOUND_SNAPSHOT_REPORT_SCHEMA, status: 'snapshot', request_digest: outboundSnapshotRequestDigest(request), scope: request,
    source, clock: { slot: contextSlot, unix_timestamp: unixTimestamp.toString(), bytes_b64: toBase64(cb) }, accounts, route, blocker: null,
    observation_only: true, dispatch_available: false, executable: false, admitted: false, signed: false, enqueued: false };
}
