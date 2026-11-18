// The PLAYABLE lane's identity per cluster (owner decision B7, 2026-11-18: ship the playable build, expedition /
// wide land / conquest, to devnet). One place that says which program, version and RPC a playable-lane component may
// bind to:
//
//   - `localnet`: EXACTLY today's local-play pins (program [0x45; 32], version 0x4804, cluster 'localnet', the
//     runner's loopback RPC on 41000-41999 except 41970). The existing local-play modules keep their own constants
//     (local-play-relay.mjs, local-play-launcher.mjs, web flocalplay*.mjs); a test here checks they are equal, so the
//     two can never drift and localnet behaviour is unchanged.
//   - `devnet`: read from scripts/devnet/devnet-playable-profile.json. Refused while its program id is still r0ze's
//     placeholder, or when the RPC is not https on one of the profile's allowed hosts (mainnet/testnet always refused).
//     Same version 0x4804, since the devnet build (scripts/build-frontier-devnet-playable-sbf.sh) is the same code
//     as the land lane without the id check.
//
// Pure: no I/O, no key, no network. Nothing in the gateway uses the devnet lane yet: who pays a page-made key's fees
// and rent on devnet (the local runner airdrops it) is a question for r0ze (reports/devnet-playable-lane-design.md
// O11), and the page-held key on a public origin is ⑧ P2 (ws08). This module is what that wiring will use.
import { decode, encode } from '../../client/src/base58.mjs';

export const PLAYABLE_LANE_VERSION = 0x4804;
export const PLAYABLE_LANE_MARKER = 'PSF_DEVNET_PLAYABLE_BUILD';
const LOCALNET_REFUSED_PORT = 41970;
const HARD_REFUSED_HOSTS = ['mainnet', 'testnet'];

export const LOCALNET_PLAYABLE_LANE = Object.freeze({
  cluster: 'localnet',
  program: encode(new Uint8Array(32).fill(0x45)),
  version: PLAYABLE_LANE_VERSION,
  rpc: 'loopback runner: http://127.0.0.1:PORT, PORT 41000-41999, never 41970',
});

const isPlaceholder = s => typeof s !== 'string' || s.includes('SET-BY-R0ZE') || /^<.*>$/.test(s);
const isAddress = s => {
  try { const b = decode(s); return typeof s === 'string' && b.length === 32 && b.some(x => x !== 0) && encode(b) === s; }
  catch { return false; }
};

/** What is wrong with a devnet playable profile (empty when a lane may be built from it). */
export function devnetPlayableProfileProblems(p) {
  const out = [];
  if (!p || typeof p !== 'object') return ['profile must be an object'];
  if (p.schema !== 'wylls-devnet-profile-v1') out.push('profile schema is not wylls-devnet-profile-v1');
  if (p.cluster !== 'devnet') out.push(`profile cluster ${p.cluster}: devnet only`);
  if (p.lane !== 'playable') out.push('not the playable lane profile (lane must be "playable")');
  if (p.program?.programVersion !== '0x4804') out.push('program.programVersion must be 0x4804');
  if (!(p.program?.requiredMarkers ?? []).includes(PLAYABLE_LANE_MARKER)) out.push(`program.requiredMarkers must name ${PLAYABLE_LANE_MARKER}`);
  if (isPlaceholder(p.programId)) out.push('programId is still a placeholder (r0ze fills it in after creating the key offline)');
  else if (!isAddress(p.programId)) out.push(`programId ${p.programId} is not a 32-byte base58 address`);
  else if (p.programId === LOCALNET_PLAYABLE_LANE.program) out.push('programId must not be the localnet lane\'s [0x45; 32]');
  const r = devnetRpcProblem(p.rpcUrl, p);
  if (r) out.push(r);
  return out;
}

/** Why `url` is not a devnet RPC this profile allows (null when it is). */
export function devnetRpcProblem(url, p) {
  let u;
  try { u = new URL(url); } catch { return `RPC URL ${url} is not a URL`; }
  if (u.protocol !== 'https:') return `RPC URL ${url}: https only`;
  if (u.username || u.password) return `RPC URL ${url}: no credentials in the URL`;
  const host = u.hostname.toLowerCase();
  for (const bad of [...HARD_REFUSED_HOSTS, ...(p?.refusedRpcHostPatterns ?? [])]) if (host.includes(bad)) return `RPC URL ${url}: host ${host} is refused (${bad}); devnet only`;
  if (!(p?.allowedRpcHosts ?? []).includes(host)) return `RPC URL ${url}: host ${host} is not in the profile's allowedRpcHosts`;
  return null;
}

/** The devnet lane from the playable profile; throws (with every problem) when the profile cannot make one. */
export function devnetPlayableLane(p, { rpcUrl } = {}) {
  const problems = devnetPlayableProfileProblems(p);
  if (rpcUrl !== undefined) { const r = devnetRpcProblem(rpcUrl, p); if (r) problems.push(r); }
  if (problems.length) { const e = new Error(`devnet playable lane refused:\n  - ${problems.join('\n  - ')}`); e.problems = problems; throw e; }
  return Object.freeze({ cluster: 'devnet', program: p.programId, version: PLAYABLE_LANE_VERSION, rpc: rpcUrl ?? p.rpcUrl });
}

/** Whether `url` is an RPC this lane may use: the loopback runner on localnet, the lane's own https RPC on devnet. */
export function laneRpcOk(lane, url) {
  if (lane === LOCALNET_PLAYABLE_LANE) {
    const m = typeof url === 'string' ? /^http:\/\/127\.0\.0\.1:([1-9][0-9]{4})$/.exec(url) : null;
    const port = m ? Number(m[1]) : NaN;
    return port >= 41_000 && port <= 41_999 && port !== LOCALNET_REFUSED_PORT;
  }
  return lane?.cluster === 'devnet' && typeof url === 'string' && url === lane.rpc;
}

/**
 * Whether an identity a herald publishes (`{ cluster, program, version }`, version as a number or its decimal
 * string, as /h/season and the local-play metadata carry it) is this lane's.
 */
export function laneIdentityOk(lane, identity) {
  if (!lane || !identity || typeof identity !== 'object') return false;
  const v = typeof identity.version === 'string' && /^[0-9]+$/.test(identity.version) ? Number(identity.version) : identity.version;
  return identity.cluster === lane.cluster && identity.program === lane.program && v === lane.version;
}

/**
 * The herald's argv for a devnet playable season (an RPC source, no local-play bootstrap): `--source rpc` needs an
 * explicit `--cluster` (herald main.rs `season_cluster`), it listens on loopback behind the TLS proxy, and
 * `--public-host` is the proxy's host name (B13). The herald binary must be built with the lane's read features
 * (`--features land-preview`, as the local land lane's herald). Data paths and ports are the operator's.
 */
export function devnetHeraldArgs(lane, { data, seasonId, listen, relay, publicHost }) {
  if (!lane || lane.cluster !== 'devnet') throw new Error('devnetHeraldArgs: a devnet lane only (localnet uses the launcher)');
  if (typeof data !== 'string' || !data.startsWith('/')) throw new Error('data must be an absolute path');
  if (!Number.isSafeInteger(seasonId) || seasonId < 0) throw new Error('seasonId must be a whole number');
  for (const [k, v] of [['listen', listen], ['relay', relay]]) if (typeof v !== 'string' || !/^127\.0\.0\.1:[1-9][0-9]{3,4}$/.test(v)) throw new Error(`${k} must be 127.0.0.1:PORT (only the TLS proxy is public)`);
  if (typeof publicHost !== 'string' || !/^[a-z0-9.-]+$/i.test(publicHost)) throw new Error('publicHost must be the proxy\'s host name');
  return ['--data', data, '--program', lane.program, '--season', String(seasonId), '--rpc', lane.rpc, '--listen', listen,
    '--source', 'rpc', '--cluster', 'devnet', '--relay', relay, '--public-host', publicHost];
}
