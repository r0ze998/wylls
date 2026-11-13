// LOCAL-PLAY ONLY, CLOSED BY DEFAULT: the one player-signed conquest step (DeclareSiege of the Free City an original
// host stays at) on the dedicated loopback relay:
//
//   POST /f/local-play/conquest/prepare   `frontier-local-play-conquest-prepare-request-v1`
//   POST /f/local-play/conquest/submit    {schema, message_digest, transaction_b64}
//   POST /f/local-play/conquest/status    {schema, signature}
//
// Preparation is conquest-prepare.mjs (the keyless one-shot CLI and the independent check of its unsigned message)
// under the relay's own pins, with the relay's one wallet as actor AND payer. Submit and status are the Depart
// relay's own machinery (local-play-relay.mjs `flow`): the exact prepared message signed once by that wallet, a
// replay barrier, ONE send, an unknown outcome answered by status only.
//
// The five crank steps of a conquest (ResolveWithConquest, SettleCapture, SettleSiege, the two closes) are not
// player commands and have no route here.
//
// CLOSED: CONQUEST_OPEN_CONDITIONS below. While any of them is false the routes cannot be constructed from the
// command line, whatever is pinned. No key is held; nothing is signed here.
import { createConquestPrepare, ConquestPrepareError, CONQUEST_DISPATCH_PINS } from './conquest-prepare.mjs';
import { createLocalPlayRelay, localPlayRelayConfigProblems, fetchRpc, LocalPlayError, LOCAL_PLAY_CLUSTER } from './local-play-relay.mjs';
import { canonicalDeclareSiegeRoles } from '../../../permutation-server/web/frontier/fconquest-identity.mjs';
import { decodePrefix } from '../../../permutation-server/web/frontier/fcodec.mjs';
import { DEPART_PREPARE_PROGRAM_VERSION } from './expedition-depart-prepare.mjs';
import { createConquestOrdersRead } from './local-play-conquest-orders.mjs';

export const CONQUEST_SUBMIT_SCHEMA = 'frontier-local-play-conquest-submit-v1';
export const CONQUEST_STATUS_SCHEMA = 'frontier-local-play-conquest-status-v1';
export const CONQUEST_ROUTES = Object.freeze({
  prepare: 'POST /f/local-play/conquest/prepare',
  submit: 'POST /f/local-play/conquest/submit',
  status: 'POST /f/local-play/conquest/status',
});
export { ConquestPrepareError };
/**
 * What must ALL be true before these routes may be served from the module's own pins (the command line). Each is a
 * fact someone has to establish and then set here by hand; none is inferred.
 *   dispatchPublished      TRUE: kind 12 / tag 0xDA are in CONQUEST_DISPATCH_PINS from the published contract
 *                          (docs/integration/CLAUDE-CONQUEST-DISPATCH-KINDS-20261111.md)
 *   addressVectorsVerified TRUE: fconquest-identity.mjs equals the Rust-produced vector, six cases
 *                          (test/web-frontier-conquest-identity.test.mjs)
 *   heapConfirmed          false: the 256 KiB frame of the pin is a local decision until a real SBF execution of the
 *                          conquest lane accepts a wrapped DeclareSiege with it
 *   pageBinding            false: the page's own module (permutation-server/web/frontier/flocalplay-conquest.mjs) is
 *                          written and tested on stand-in data (it derives the same twelve accounts and checks the
 *                          prepared message itself), but it is not connected to a world capability and has not been
 *                          accepted in review; tracked as an integration remainder, not claimed
 * The WORLD is not a constant here. Whether the world being served can be besieged at all is a fact of one start:
 * it is given as a `capability` (below) naming the conquest artefact and the very program, Season and runner this
 * relay is pinned to, and is checked against them. No capability, no route.
 */
export const CONQUEST_OPEN_CONDITIONS = Object.freeze({ dispatchPublished: true, addressVectorsVerified: true, heapConfirmed: false, pageBinding: false });
export const CONQUEST_MARKERS = Object.freeze(['PSF_LOCALNET_EXPEDITION_SBF_BUILD', 'PSF_LOCALNET_CONQUEST_SBF_BUILD']);
export const CONQUEST_WORLD_PRESET = 'local-conquest-test-v1';
/**
 * Why a world capability does not open the conquest routes of THIS relay, or [] when it does. The capability is what
 * the runner and herald of one start established and report (its shape is proposed here; the launcher's owner wires
 * it): `{schema, artifact_sha256, markers, program, season, rpc, world_preset, free_city}`.
 *   artifact_sha256  the conquest lane's artefact, as the runner authenticated it (64 lowercase hex)
 *   markers          exactly both markers, in this order: an expedition-only artefact carries one and refuses kinds 12-17
 *   program, season, rpc   the very ones this relay is pinned to: a capability of another world or runner is not this one's
 *   world_preset     the explicit local test preset whose Free City the program's own SetRules/OpenProvince made
 *   free_city        `{p, q, site, tile}` of that city as read from the chain (decimal strings and small integers)
 * It proves nothing by itself: it is a statement the relay refuses to act without, bound to its own pins.
 */
export function conquestCapabilityProblems(capability, cfg) {
  const out = [], c = capability, keys = ['schema', 'artifact_sha256', 'markers', 'program', 'season', 'rpc', 'world_preset', 'free_city'];
  if (c === null || typeof c !== 'object' || Array.isArray(c) || Object.keys(c).length !== keys.length || !keys.every(k => Object.hasOwn(c, k))) return ['capability must have exactly ' + keys.join(', ')];
  if (c.schema !== 'frontier-local-play-conquest-capability-v1') out.push('schema');
  if (typeof c.artifact_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(c.artifact_sha256) || /^0{64}$/.test(c.artifact_sha256)) out.push('artifact_sha256');
  if (!Array.isArray(c.markers) || c.markers.length !== CONQUEST_MARKERS.length || c.markers.some((m, i) => m !== CONQUEST_MARKERS[i])) out.push('markers (both, in order)');
  if (c.program !== cfg.program) out.push('program is not this relay\'s');
  if (c.season !== cfg.season) out.push('season is not this relay\'s');
  if (c.rpc !== cfg.rpc) out.push('rpc is not this relay\'s runner');
  if (c.world_preset !== CONQUEST_WORLD_PRESET) out.push('world_preset');
  const f = c.free_city, int = /^-?(0|[1-9][0-9]{0,18})$/;
  if (f === null || typeof f !== 'object' || Array.isArray(f) || Object.keys(f).length !== 4 || typeof f.p !== 'string' || !int.test(f.p) || typeof f.q !== 'string' || !int.test(f.q)
      || !Number.isInteger(f.site) || f.site < 0 || f.site > 11 || !Number.isInteger(f.tile) || f.tile < 0 || f.tile > 60) out.push('free_city {p, q, site, tile}');
  return out;
}

/**
 * The conquest routes over `cfg` (the relay's own closed configuration), `conquestBin` (the absolute path of the
 * conquest prepare CLI) and `capability` (the world capability of this start, bound to `cfg`). `dispatch` and
 * `prepare` are for tests only. Throws when anything is not acceptable, always while an opening condition is not
 * established, and always without a capability of this very world: no route rather than a looser one.
 */
// (`runnerInstance`: handed on to the relay machinery unchanged — see createLocalPlayRelay. No start gives one today.)
export function createLocalPlayConquest({ cfg, conquestBin, capability = null, dispatch = null, prepare = null, rpc = (m, p) => fetchRpc(cfg.rpc, m, p), now = () => Date.now(), spawn, setTimer, clearTimer, runnerInstance = null }) {
  const problems = localPlayRelayConfigProblems(cfg);
  if (problems.length) throw new Error('local-play conquest: ' + problems.join('; '));
  // (an explicit `dispatch` or `prepare` is a test's: it says nothing about the real program. Without one, the module's
  // own pins are used, and only when every opening condition has been established)
  if (dispatch === null && prepare === null) {
    const missing = Object.entries(CONQUEST_OPEN_CONDITIONS).filter(([, ok]) => ok !== true).map(([k]) => k);
    if (missing.length) throw new Error('local-play conquest: closed (not established: ' + missing.join(', ') + ')');
    const world = conquestCapabilityProblems(capability, cfg);
    if (world.length) throw new Error('local-play conquest: closed (world capability: ' + world.join('; ') + ')');
    dispatch = CONQUEST_DISPATCH_PINS;
  } else if (capability !== null) {
    // (a capability given to a test build is held to this relay's pins exactly as a real one is)
    const world = conquestCapabilityProblems(capability, cfg);
    if (world.length) throw new Error('local-play conquest: closed (world capability: ' + world.join('; ') + ')');
  }
  const city = capability === null ? null : Object.freeze({ ...capability.free_city });
  let adapter = prepare;
  if (!adapter) {
    try {
      adapter = createConquestPrepare({ cfg: { cluster: LOCAL_PLAY_CLUSTER, programId: cfg.program, conquestPrepareBin: conquestBin, conquestPrepareRpc: cfg.rpc,
        conquestPrepareFeePayer: cfg.wallet, conquestPrepareRulesetHash: cfg.rulesetHash, conquestPrepareCuLimit: cfg.cuLimit, conquestPrepareLoadedLimit: cfg.loadedLimit },
      season: cfg.season, dispatch, ...(spawn ? { spawn } : {}), ...(setTimer ? { setTimer } : {}), ...(clearTimer ? { clearTimer } : {}) });
    } catch { adapter = null; }
    if (!adapter) throw new Error('local-play conquest: closed (the conquest prepare binary must be an absolute path AND the dispatch kind must be pinned; it is not published yet)');
  }
  const relay = createLocalPlayRelay({ cfg, prepare: adapter, rpc, now, runnerInstance,
    flow: { routes: CONQUEST_ROUTES, submitSchema: CONQUEST_SUBMIT_SCHEMA, statusSchema: CONQUEST_STATUS_SCHEMA, scopeOf: body => body.source_request } });
  /**
   * THE CITY BINDING, before the CLI is asked anything: the request must name this start's Free City and no other.
   *   1. the province the host stands in is the capability's, and the site is the capability's (no read needed);
   *   2. the site and the tile belong together ON THE CHAIN, as the ABI has it: one read of the target Province at
   *      its canonical address (this relay's own runner) must show a program-owned Province whose site count covers
   *      the site, whose `SITES[site]` is the capability's tile, and whose site mirror is a Free City (state 5).
   * A request for another province, another site, another world, or a capability whose tile is not that site's,
   * is refused here: nothing is spawned, nothing is prepared. This narrows what the route serves; it opens nothing.
   */
  const bound = async body => {
    if (city === null) return;   // (only a test build has no capability: the command-line path always has one)
    const source = body?.source_request, target = body?.target;
    if (source === null || typeof source !== 'object' || target === null || typeof target !== 'object') throw new LocalPlayError('LocalPlayInvalidRequest');
    // (the relay's own scope, asked HERE first: a request of another wallet, payer, cluster, program, Season, version or
    // ruleset is refused before the runner is read for it. The relay asks the same again afterwards; this is its rule, not a second one)
    if (source.cluster !== LOCAL_PLAY_CLUSTER || source.program !== cfg.program || source.season !== cfg.season || source.wallet !== cfg.wallet || source.payer !== cfg.wallet
        || source.deployment?.program_version !== DEPART_PREPARE_PROGRAM_VERSION || source.deployment?.ruleset_hash !== cfg.rulesetHash) throw new LocalPlayError('LocalPlayScopeMismatch');
    if (source.standing?.p !== city.p || source.standing?.q !== city.q || target.site !== city.site) throw new ConquestPrepareError('ConquestPrepareScopeMismatch');
    let at; try { at = canonicalDeclareSiegeRoles(source, city.site)[5].address; } catch { throw new ConquestPrepareError('ConquestPrepareInvalidRequest'); }
    let got; try { got = await rpc('getAccountInfo', [at, { encoding: 'base64', commitment: 'confirmed' }]); } catch { throw new LocalPlayError('LocalPlayRpcUnavailable'); }
    const value = got?.result?.value;
    if (got?.error !== undefined || got?.result === undefined) throw new LocalPlayError('LocalPlayRpcUnavailable');
    // (an unopened or foreign Province, or bytes that are not a Province: not this capability's city)
    if (value === null || value === undefined || value.owner !== cfg.program || !Array.isArray(value.data) || value.data[1] !== 'base64' || typeof value.data[0] !== 'string') throw new ConquestPrepareError('ConquestPrepareScopeMismatch');
    let province; try { province = decodePrefix('Province', Buffer.from(value.data[0], 'base64'), { profile: 2 }); } catch { throw new ConquestPrepareError('ConquestPrepareScopeMismatch'); }
    const count = Number(province.siteCount), mirror = province.siteMirror?.[city.site];
    if (!(count <= 12 && city.site < count) || province.sites?.[city.site] !== city.tile || Number(mirror?.state) !== 5) throw new ConquestPrepareError('ConquestPrepareScopeMismatch');
  };
  // (read-only: this wallet's reservations in the province, local-play-conquest-orders.mjs. It exists only as part of
  // this object, so it is closed exactly while the conquest routes are)
  const orders = createConquestOrdersRead({ cfg, city, rpc });
  return Object.freeze({
    routes: CONQUEST_ROUTES,
    prepare: async (body, o) => { await bound(body); return relay.prepare(body, o); },
    orders: body => orders.read(body),
    submit: body => relay.submit(body),
    status: body => relay.status(body),
    stats: () => relay.stats(),
    close: () => relay.close(),
  });
}
