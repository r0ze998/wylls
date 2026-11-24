// DEVNET PLAY (devnet gap P1, owner decision B7: the PLAYABLE lane on devnet) — the page's own first-village and
// wide-land commands on a devnet season, WALLET-PAID: the player's wallet is fee payer AND actor, signs once, and pays
// its own fees and rent. The gateway sponsors nothing here (no relay pool key signs, no lamport leaves the operator):
// it is a checked forwarder in front of the operator's RPC, because the page's CSP lets it talk to its own origin only
// (the herald, which proxies /gw/* to this gateway).
//
//   POST /f/devnet-play/act/context  {schema: …-info-v1}                    → the lane this gateway serves (a read of config)
//                                    {schema: …-context-v1, wallet}         → {wallet, blockhash} (one getLatestBlockhash)
//                                    {schema: frontier-play-rent-context-v1} → the cluster's rent of one Holding
//                                                                              (rent-live-rest, web/frontier/frent.mjs)
//   POST /f/devnet-play/act/submit   {schema: …-submit-v1, name, subject, fields, transaction_b64}
//   POST /f/devnet-play/act/status   {schema: …-status-v1, signature}       → the chain's word on a signature it sent
//
// The checks are local play's own (local-play-act.mjs, the validator core), with this gateway's pins and the Season's
// real id instead of local play's one wallet and season 11:
//   1. the command is one of DEVNET_ACT_COMMANDS (a closed list; the wide -> wide host acts are NOT here: the devnet
//      build closes wide departures, Q-W2 = local TEST only);
//   2. the stated intent is well formed; the message REBUILT here from it with the game's own builder for the
//      transaction's ONE signer (fee payer = actor = that wallet) is the signed message byte for byte; the signature
//      verifies;
//   3. one read of the real accounts (the Citizen, and the village for a village command) at one slot;
//   4. the replay barrier (these bytes were not submitted before), then ONE sendTransaction, never again.
//
// devnet-page-war: the ORDINARY sealed march (legacy Depart 0x50) on the same terms, over its own two routes:
//   POST /f/devnet-play/march/submit {schema: …-march-submit-v1, name: 'Depart', subject, fields, transaction_b64}
//   POST /f/devnet-play/march/status {schema: …-march-status-v1, signature} → also `expired` (the blockhash read first)
// The checks are local play's march validator (local-play-march.mjs `localMarchSubmit` / `localMarchAccountsCheck`):
// the Depart rebuilt for the ONE signer with the game's builder, byte-compared, the signature verified, the seal's
// shape, the host of THIS village; then one read of the Citizen, the legacy village and its province; the replay
// barrier; ONE send. The seal stays opaque here (a drand time-lock): the march is revealed by keeper A from the public
// round, or from the owner's material the page hands to the keeper (`POST /f/reveal`), never by this gateway.
// The march's later steps (SettleDeparture, the reveal, the clash, SettleTransit, the return) are keeper A's play
// roles: nothing else of the war is served here.
// devnet-p15-p9 (devnet gap P15): the BOUNDARY DEPARTURE (ExpeditionDepart, the 0x4804 wrapper kind 0; the page's
// 「境界への道を準備」) on the same terms, over its own two routes:
//   POST /f/devnet-play/expedition/submit {schema: …-expedition-submit-v1, request, blockhash, transaction_b64}
//   POST /f/devnet-play/expedition/status {schema: …-expedition-status-v1, signature} → also `expired`
// `request` is the local relay's canonical preparation request (expedition-depart-prepare.mjs
// `expeditionDepartPrepareRequest`: the nine roles and the 369 inner bytes rebuilt from its public facts), pinned to
// this gateway's program, Season, ruleset hash and the host-only dispatch revision, with the wallet as payer AND actor
// AND the transaction's one signer. The unsigned message is REBUILT here with the page's own builder
// (web/frontier/fexpedition-depart-message.mjs, byte-equal to the keyless Rust CLI's) for the stated blockhash and
// compared byte for byte; the signature verified; one read of the wallet's Citizen, the host's home village and the
// origin province; the replay barrier; ONE send (with preflight). No CLI is spawned and no RPC URL leaves this
// process. The seal stays opaque: keeper A's `expeditions` role opens it from the public round T(arrive) and drives
// every later step; the page never posts the reveal half.
// devnet-page-outpost: the SECOND and THIRD village (FileOutpost) is one of the acts (DEVNET_ACT_COMMANDS), checked by
// the same core with the shared intent/message of web/frontier/fdevnet-outpost.mjs (its anchor the wallet's first home
// of the stated generation, by the chain's own bytes); the submit also reads the target Province and refuses an absent
// one (`LocalActProvinceAbsent`, before any send: the program would answer BadAccount). Its context
// (`…-outpost-context-v1`) adds the cluster's rent of the Holding the ticket escrows, so the page's preview names what
// the wallet pays. Keeper A's `tickets` role settles the ticket, as a rim first village's.
// devnet-p17 (devnet gap P17): a WIDE village's own acts — WideHarvest, WideBuild, WideTrain, WideMuster (0xDA op 3 /
// op 1, the shared builder web/frontier/flocalplay-wide-host.mjs) — are acts too (DEVNET_ACT_COMMANDS), checked by the
// same core; the submit also reads the wide holding and its own wide province in the same call: the holding must be
// this program's wide holding (magic, Season) owned by the wallet's Citizen (`LocalActNotYourVillage`), the province
// present (`LocalActProvinceAbsent`), before any send. WideDepart is NOT here (the devnet build keeps its debit closed:
// NotImplemented). Its context (`…-wide-village-context-v1`, with the village) adds the cluster's rent of the wide
// roster a FIRST WideMuster of the province creates from the payer, and whether that roster is there already.
// devnet-territory-dev (owner NWP-2: territory playable on devnet before world 3): the single-tile claim
// (WideClaimTile 0xDA op 7, TERRITORY_CLAIM, the shared builder web/frontier/flocalplay-territory.mjs) is an act too,
// checked by the same core (its paying first home the subject holding, read as one); the submit also reads the target's
// WIDE province in the same call (absent: `LocalActProvinceAbsent`, before any send). Its context
// (`…-territory-context-v1`, with the target) adds the cluster's rent of the province's territory record (672 bytes)
// and of the player's summary (320 bytes) — each created from the claimer's wallet when absent (owner TQ-12 (a)) — whether
// each is there, and the claimer's tile count (the ore price of the next tile). Upkeep, decay and the conquest transfer
// are keeper A's `territory` role, never this gateway's.
// No key is held, nothing is signed here. Off unless the operator starts the gateway with `--devnet-play`
// (config.mjs devnetPlayConfigProblems: cluster devnet, an https RPC; the offline test form only on loopback).
import { createHash, createPublicKey, verify as edVerify } from 'node:crypto';
import { decode, encode } from '../../client/src/base58.mjs';
import { parseTransaction } from '../../client/src/solana-tx.mjs';
import { seasonAddresses } from '../../../permutation-server/web/frontier/faddr.mjs';
import { WIDE_CLAIM } from '../../../permutation-server/web/frontier/flocalplay-wide.mjs';
import { fetchRpc } from './local-play-relay.mjs';
import { LocalActError, localActAccountOf, localActAccountsCheck, localActSubmit, runnerRejection, sendRefusalDetail } from './local-play-act.mjs';
import { LOCALNET_PLAYABLE_LANE } from './playable-lane-profile.mjs';
import { expeditionDepartPrepareRequest, DEPART_PREPARE_PROGRAM_VERSION } from './expedition-depart-prepare.mjs';
import { departUnsignedMessage, DEVNET_DEPART_CU_LIMIT, DEVNET_DEPART_LOADED_LIMIT } from '../../../permutation-server/web/frontier/fexpedition-depart-message.mjs';
import { singleSigned } from './local-play-relay.mjs';
import { LocalMarchError, localMarchAccountOf, localMarchAccountsCheck, localMarchSubmit, sealBinding } from './local-play-march.mjs';
import { OUTPOST_ACT, OUTPOST_HOLDING_BYTES } from '../../../permutation-server/web/frontier/fdevnet-outpost.mjs';
import { WIDE_VILLAGE_ACTS, WIDE_ROSTER_BYTES, wideVillageAccounts } from '../../../permutation-server/web/frontier/flocalplay-wide-host.mjs';
import { worldIdOf, ringPosition } from '../../../permutation-server/web/frontier/map/wide.mjs';
import { RENT_CONTEXT_SCHEMA, clusterRentAnswer } from '../../../permutation-server/web/frontier/frent.mjs';
import { TERRITORY_CLAIM, TERRITORY_PROVINCE_BYTES, TERRITORY_PLAYER_BYTES, territoryProvinceAddress, territoryPlayerAddress, decodeTerritoryPlayer } from '../../../permutation-server/web/frontier/flocalplay-territory.mjs';
import { wideProvinceAddress } from '../../../permutation-server/web/frontier/flocalplay-wide.mjs';

/** The commands a devnet page sends itself (the first village, its economy, the wide claim). */
// (devnet-page-outpost: and FileOutpost, the second and third village)
// (devnet-p17: and a wide village's own Harvest, Build, Train and Muster)
// (devnet-territory-dev: and the single-tile claim of a territory world)
export const DEVNET_ACT_COMMANDS = Object.freeze(['Join', 'PlaceHome', 'Harvest', 'Build', 'Train', 'Muster', 'FileTicket', WIDE_CLAIM, OUTPOST_ACT, ...WIDE_VILLAGE_ACTS, TERRITORY_CLAIM]);
/** devnet-territory-dev: the context of a tile claim — the blockhash, the cluster's rent of the two territory records, whether
 * each is there, whether the target's wide province is, and the claimer's tiles (the ore price of the next one). */
export const DEVNET_TERRITORY_CONTEXT_SCHEMA = 'frontier-devnet-play-territory-context-v1';
/** devnet-p17: the context of a wide village's act — the blockhash, the cluster's rent of the wide roster, and whether it is there. */
export const DEVNET_WIDE_VILLAGE_CONTEXT_SCHEMA = 'frontier-devnet-play-wide-village-context-v1';
/** devnet-p17: a wide holding as the submit checks it (fwide.mjs: size, magic, the Season id at 8, the owner Citizen at 72). */
export const DEVNET_WIDE_HOLDING = Object.freeze({ SIZE: 1344, MAGIC: 'PSFXWHL1', SEASON_ID: 8, OWNER_CITIZEN: 72 });
/** devnet-page-outpost: the context of a FileOutpost — the blockhash, and the cluster's rent of the Holding it escrows. */
export const DEVNET_OUTPOST_CONTEXT_SCHEMA = 'frontier-devnet-play-outpost-context-v1';
export const DEVNET_ACT_ROUTES = Object.freeze({ context: 'POST /f/devnet-play/act/context', submit: 'POST /f/devnet-play/act/submit', status: 'POST /f/devnet-play/act/status' });
/** devnet-page-war: the ordinary sealed march (Depart) of the devnet page, wallet-paid as the acts. */
export const DEVNET_MARCH_COMMANDS = Object.freeze(['Depart']);
export const DEVNET_MARCH_ROUTES = Object.freeze({ submit: 'POST /f/devnet-play/march/submit', status: 'POST /f/devnet-play/march/status' });
export const DEVNET_MARCH_SUBMIT_SCHEMA = 'frontier-devnet-play-march-submit-v1';
export const DEVNET_MARCH_STATUS_SCHEMA = 'frontier-devnet-play-march-status-v1';
/** devnet-p15-p9 (P15): the boundary departure of the devnet page, wallet-paid as the acts; the rest is keeper A's. */
export const DEVNET_EXPEDITION_COMMANDS = Object.freeze(['ExpeditionDepart']);
export const DEVNET_EXPEDITION_ROUTES = Object.freeze({ submit: 'POST /f/devnet-play/expedition/submit', status: 'POST /f/devnet-play/expedition/status' });
export const DEVNET_EXPEDITION_SUBMIT_SCHEMA = 'frontier-devnet-play-expedition-submit-v1';
export const DEVNET_EXPEDITION_STATUS_SCHEMA = 'frontier-devnet-play-expedition-status-v1';
/** devnet-p15-p9: the context of a boundary departure — the blockhash, and the cluster's rent of the transit record the
 * Depart creates from the wallet (`OWNED_BRIDGE_LEN` 336 bytes, `proc/wide_expedition_exec.rs`), so the page's preview
 * names everything the wallet pays. */
export const DEVNET_EXPEDITION_CONTEXT_SCHEMA = 'frontier-devnet-play-expedition-context-v1';
export const DEVNET_EXPEDITION_TRANSIT_BYTES = 336;
export const DEVNET_ACT_INFO_SCHEMA = 'frontier-devnet-play-act-info-v1';
export const DEVNET_ACT_CONTEXT_SCHEMA = 'frontier-devnet-play-act-context-v1';
export const DEVNET_ACT_SUBMIT_SCHEMA = 'frontier-devnet-play-act-submit-v1';
export const DEVNET_ACT_STATUS_SCHEMA = 'frontier-devnet-play-act-status-v1';
/** Signatures kept for the status route and the replay barrier (oldest forgotten first; a blockhash lives ~1-2 min). */
export const DEVNET_ACT_MAX_HISTORY = 8192;
/** The offline test form's RPC: the in-process localnet on the M1 port range (never 41970), nothing else. */
export const DEVNET_PLAY_OFFLINE_RPC = /^http:\/\/127\.0\.0\.1:(4[1][0-9]{3})$/;
const HARD_REFUSED_HOSTS = ['mainnet', 'testnet'];

const fail = code => { throw new LocalActError(code); };
const check = (ok, code = 'LocalActInvalid') => { if (!ok) fail(code); };
const exact = (v, keys) => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const address = s => { try { return typeof s === 'string' && s.length <= 44 && decode(s).length === 32 && encode(decode(s)) === s; } catch { return false; } };
const sha = b => createHash('sha256').update(b).digest('hex');
const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');
const edKey = raw => createPublicKey({ key: Buffer.concat([SPKI_ED25519, Buffer.from(raw)]), format: 'der', type: 'spki' });
/** The home `{p, q, site}` of an original host's 56-byte reference (hex): byte 0 = 1, world 32, ring u64 BE, wedge, pos u64 BE, site, gen, seq. */
function hostHome(hex) {
  const b = Buffer.from(hex, 'hex');
  const ring = b.readBigUInt64BE(33), wedge = b[41], pos = b.readBigUInt64BE(42);
  let p = ring - pos, q = pos;
  for (let i = 0; i < wedge; i++) [p, q] = [-q, p + q];
  return { p: Number(p), q: Number(q), site: b[50] };
}

/**
 * What is wrong with a gateway configuration that asks for the devnet play routes (empty when they may be served):
 * `{cluster, rpc, programId, seasonId, devnetPlay, devnetPlayRulesetHash, devnetPlayOfflineRpc}`.
 * There is no default devnet RPC: the operator names one (https, no credentials in the URL, never a mainnet or
 * testnet host). `devnetPlayOfflineRpc` (TEST ONLY) allows the in-process localnet on loopback instead, so the page
 * can be proven against the exact devnet `.so` offline; it never allows any other http URL.
 */
export function devnetPlayConfigProblems(cfg) {
  if (!cfg?.devnetPlay) return [];
  const out = [];
  if (cfg.cluster !== 'devnet') out.push(`--devnet-play: cluster ${cfg.cluster}; the devnet play routes serve a devnet season only`);
  if (!address(cfg.programId)) out.push('--devnet-play needs --program (a base58 address)');
  else if (cfg.programId === LOCALNET_PLAYABLE_LANE.program) out.push('--devnet-play: the program is the localnet lane\'s [0x45; 32] (local play has its own relay)');
  if (!/^[0-9]{1,20}$/.test(String(cfg.seasonId ?? ''))) out.push('--devnet-play needs --season');
  if (!/^[0-9a-f]{64}$/.test(String(cfg.devnetPlayRulesetHash ?? ''))) out.push('--devnet-play needs --devnet-play-ruleset-hash (64 hex, the Season\'s RULESET_HASH)');
  let u = null; try { u = new URL(cfg.rpc); } catch { out.push(`--rpc ${cfg.rpc} is not a URL`); }
  if (u) {
    if (cfg.devnetPlayOfflineRpc) {
      const m = DEVNET_PLAY_OFFLINE_RPC.exec(String(cfg.rpc));
      if (!m || Number(m[1]) === 41970) out.push(`--devnet-play-offline-rpc: ${cfg.rpc} is not the in-process localnet (http://127.0.0.1:41000-41999, never 41970)`);
    } else {
      if (u.protocol !== 'https:') out.push(`--rpc ${cfg.rpc}: the devnet play routes send through an https RPC only`);
      if (u.username || u.password) out.push(`--rpc ${cfg.rpc}: no credentials in the URL`);
      const host = u.hostname.toLowerCase();
      for (const bad of HARD_REFUSED_HOSTS) if (host.includes(bad)) out.push(`--rpc ${cfg.rpc}: host ${host} is refused (${bad}); devnet only`);
    }
  }
  return out;
}

/**
 * The flow over `cfg` (devnetPlayConfigProblems must be empty) and `rpc(method, params)` → the JSON-RPC answer.
 * → `{routes, info(), context(body), submit(body), status(body), stats()}`. Constructing it reads and sends nothing.
 */
export function createDevnetPlayAct({ cfg, rpc = (m, p) => fetchRpc(cfg.rpc, m, p), now = () => Date.now() }) {
  const problems = devnetPlayConfigProblems({ ...cfg, devnetPlay: true });
  if (problems.length) throw new Error('devnet play refused: ' + problems.join('; '));
  const seasonId = String(cfg.seasonId);
  const A = seasonAddresses(cfg.programId, seasonId);
  const base = Object.freeze({ program: cfg.programId, season: A.season, seasonId, rulesetHash: cfg.devnetPlayRulesetHash });
  const seen = new Map();   // digest → {signature, name, at}; also the status route's list
  const remember = (digest, e) => { seen.set(digest, e); while (seen.size > DEVNET_ACT_MAX_HISTORY) seen.delete(seen.keys().next().value); };
  const ask = async (method, params) => { let r; try { r = await rpc(method, params); } catch { fail('LocalActRpcUnavailable'); } if (!r || r.error !== undefined) fail('LocalActRpcUnavailable'); return r; };
  const world = worldIdOf(A.season, cfg.programId);
  /** devnet-p17: the wide accounts of `village` `{p, q, site}` (decimal p/q strings, ring 129+), or LocalActInvalid. */
  const wideOf = village => {
    check(exact(village, ['p', 'q', 'site']) && typeof village.p === 'string' && typeof village.q === 'string' && /^-?(0|[1-9][0-9]{0,17})$/.test(village.p)
      && /^-?(0|[1-9][0-9]{0,17})$/.test(village.q) && Number.isInteger(village.site) && village.site >= 0 && village.site <= 11);
    let ring; try { ring = ringPosition(BigInt(village.p), BigInt(village.q)).ring; } catch { fail('LocalActInvalid'); }
    check(ring >= 129n);
    return wideVillageAccounts({ programId: cfg.programId, seasonId, world, village });
  };
  /** devnet-p17: the wide-village context — a blockhash, the roster's rent on this cluster, and whether the roster is there. */
  const wideVillageContext = async body => {
    check(exact(body, ['schema', 'wallet', 'village']) && address(body.wallet));
    const acc = wideOf(body.village);
    const r = await ask('getLatestBlockhash', [{ commitment: 'confirmed' }]);
    const v = r.result?.value, slot = r.result?.context?.slot;
    if (!address(v?.blockhash) || !Number.isSafeInteger(v.lastValidBlockHeight) || v.lastValidBlockHeight < 0 || !Number.isSafeInteger(slot) || slot < 0) fail('LocalActRpcUnavailable');
    const rent = (await ask('getMinimumBalanceForRentExemption', [WIDE_ROSTER_BYTES, { commitment: 'confirmed' }])).result;
    if (!Number.isSafeInteger(rent) || rent < 0) fail('LocalActRpcUnavailable');
    const got = await ask('getMultipleAccounts', [[acc.roster], { encoding: 'base64', commitment: 'confirmed' }]);
    const rows = got.result?.value;
    if (!Array.isArray(rows) || rows.length !== 1) fail('LocalActRpcUnavailable');
    const roster = localActAccountOf(rows[0]);
    return { wallet: body.wallet, blockhash: { hash: v.blockhash, last_valid_block_height: String(v.lastValidBlockHeight), context_slot: String(slot) },
      roster_rent: String(rent), roster_present: roster !== null && roster.owner === cfg.programId };
  };
  /** devnet-territory-dev: the target `{p, q}` of a tile claim (decimal strings, a wide ring), or LocalActInvalid. */
  const wideTarget = target => {
    check(exact(target, ['p', 'q']) && typeof target.p === 'string' && typeof target.q === 'string' && /^-?(0|[1-9][0-9]{0,17})$/.test(target.p) && /^-?(0|[1-9][0-9]{0,17})$/.test(target.q));
    let ring; try { ring = ringPosition(BigInt(target.p), BigInt(target.q)).ring; } catch { fail('LocalActInvalid'); }
    check(ring >= 129n);
    return { p: target.p, q: target.q };
  };
  /** devnet-territory-dev: the tile claim's context (DEVNET_TERRITORY_CONTEXT_SCHEMA). Four reads, nothing kept. */
  const territoryContext = async body => {
    check(exact(body, ['schema', 'wallet', 'target']) && address(body.wallet));
    const t = wideTarget(body.target);
    const citizen = A.of('Citizen', { wallet: body.wallet });
    const r = await ask('getLatestBlockhash', [{ commitment: 'confirmed' }]);
    const v = r.result?.value, slot = r.result?.context?.slot;
    if (!address(v?.blockhash) || !Number.isSafeInteger(v.lastValidBlockHeight) || v.lastValidBlockHeight < 0 || !Number.isSafeInteger(slot) || slot < 0) fail('LocalActRpcUnavailable');
    const rentOf = async n => { const x = (await ask('getMinimumBalanceForRentExemption', [n, { commitment: 'confirmed' }])).result; if (!Number.isSafeInteger(x) || x < 0) fail('LocalActRpcUnavailable'); return x; };
    const provinceRent = await rentOf(TERRITORY_PROVINCE_BYTES), playerRent = await rentOf(TERRITORY_PLAYER_BYTES);
    const keys = [territoryProvinceAddress(A.season, cfg.programId, t.p, t.q), territoryPlayerAddress(A.season, cfg.programId, citizen), wideProvinceAddress(A.season, cfg.programId, t.p, t.q)];
    const got = await ask('getMultipleAccounts', [keys, { encoding: 'base64', commitment: 'confirmed' }]);
    const rows = got.result?.value;
    if (!Array.isArray(rows) || rows.length !== 3) fail('LocalActRpcUnavailable');
    const [tp, pl, wp] = rows.map(localActAccountOf);
    const ours = a => a !== null && a.owner === cfg.programId;
    const summary = ours(pl) ? decodeTerritoryPlayer(Uint8Array.from(pl.bytes)) : null;
    return { wallet: body.wallet, blockhash: { hash: v.blockhash, last_valid_block_height: String(v.lastValidBlockHeight), context_slot: String(slot) },
      province_rent: String(provinceRent), province_present: ours(tp), player_rent: String(playerRent), player_present: summary !== null,
      wide_province_present: ours(wp), tiles: summary === null ? 0 : summary.tiles, unpaid: summary === null ? false : summary.unpaid };
  };
  /** devnet-p17: the wide holding as read — this program's, of this Season, the Citizen's own (refused before the send otherwise). */
  const wideHoldingCheck = (row, citizenAt) => {
    const h = localActAccountOf(row);
    check(h !== null && h.owner === cfg.programId, 'LocalActHolding');
    const b = Buffer.from(h.bytes);
    check(b.length === DEVNET_WIDE_HOLDING.SIZE && b.subarray(0, 8).toString('latin1') === DEVNET_WIDE_HOLDING.MAGIC
      && b.readBigUInt64LE(DEVNET_WIDE_HOLDING.SEASON_ID).toString() === seasonId, 'LocalActHolding');
    check(encode(b.subarray(DEVNET_WIDE_HOLDING.OWNER_CITIZEN, DEVNET_WIDE_HOLDING.OWNER_CITIZEN + 32)) === citizenAt, 'LocalActNotYourVillage');
  };
  return Object.freeze({
    routes: DEVNET_ACT_ROUTES,
    /** The lane this gateway serves (its own configuration; nothing is read). */
    info: () => ({ schema: DEVNET_ACT_INFO_SCHEMA, cluster: 'devnet', program: base.program, season: base.season, season_id: seasonId, ruleset_hash: base.rulesetHash, commands: [...DEVNET_ACT_COMMANDS],
      march: { commands: [...DEVNET_MARCH_COMMANDS], reveal: 'keeper' },
      outpost: { commands: [OUTPOST_ACT], settle: 'keeper', holding_bytes: OUTPOST_HOLDING_BYTES },
      wide_village: { commands: [...WIDE_VILLAGE_ACTS], roster_bytes: WIDE_ROSTER_BYTES, resolve: 'keeper' },
      territory: { commands: [TERRITORY_CLAIM], province_bytes: TERRITORY_PROVINCE_BYTES, player_bytes: TERRITORY_PLAYER_BYTES, upkeep: 'keeper' },
      expedition: { commands: [...DEVNET_EXPEDITION_COMMANDS], reveal: 'keeper', cu_limit: DEVNET_DEPART_CU_LIMIT, loaded_limit: DEVNET_DEPART_LOADED_LIMIT } }),

    async context(body) {
      if (exact(body, ['schema']) && body.schema === DEVNET_ACT_INFO_SCHEMA) return this.info();
      if (body?.schema === DEVNET_WIDE_VILLAGE_CONTEXT_SCHEMA) return wideVillageContext(body);
      if (body?.schema === DEVNET_TERRITORY_CONTEXT_SCHEMA) return territoryContext(body);
      // (rent-live-rest: the cluster's rent of one Holding — the village ticket's escrow — for the page's preview;
      //  one getMinimumBalanceForRentExemption, nothing kept: web/frontier/frent.mjs)
      if (exact(body, ['schema']) && body.schema === RENT_CONTEXT_SCHEMA) return clusterRentAnswer(ask, () => fail('LocalActRpcUnavailable'));
      check(exact(body, ['schema', 'wallet']) && [DEVNET_ACT_CONTEXT_SCHEMA, DEVNET_EXPEDITION_CONTEXT_SCHEMA, DEVNET_OUTPOST_CONTEXT_SCHEMA].includes(body.schema) && address(body.wallet));
      const r = await ask('getLatestBlockhash', [{ commitment: 'confirmed' }]);
      const v = r.result?.value, slot = r.result?.context?.slot;
      if (!address(v?.blockhash) || !Number.isSafeInteger(v.lastValidBlockHeight) || v.lastValidBlockHeight < 0 || !Number.isSafeInteger(slot) || slot < 0) fail('LocalActRpcUnavailable');
      const out = { wallet: body.wallet, blockhash: { hash: v.blockhash, last_valid_block_height: String(v.lastValidBlockHeight), context_slot: String(slot) } };
      if (body.schema === DEVNET_OUTPOST_CONTEXT_SCHEMA) {
        const rent = (await ask('getMinimumBalanceForRentExemption', [OUTPOST_HOLDING_BYTES, { commitment: 'confirmed' }])).result;
        if (!Number.isSafeInteger(rent) || rent < 0) fail('LocalActRpcUnavailable');
        return { ...out, holding_rent: String(rent) };
      }
      if (body.schema !== DEVNET_EXPEDITION_CONTEXT_SCHEMA) return out;
      const rent = (await ask('getMinimumBalanceForRentExemption', [DEVNET_EXPEDITION_TRANSIT_BYTES, { commitment: 'confirmed' }])).result;
      if (!Number.isSafeInteger(rent) || rent < 0) fail('LocalActRpcUnavailable');
      return { ...out, transit_rent: String(rent) };
    },

    async submit(body) {
      check(exact(body, ['schema', 'name', 'subject', 'fields', 'transaction_b64']) && body.schema === DEVNET_ACT_SUBMIT_SCHEMA && typeof body.transaction_b64 === 'string' && body.transaction_b64.length <= 1700);
      check(DEVNET_ACT_COMMANDS.includes(body.name), 'LocalActNotAllowed');
      // (the transaction's ONE signer is the wallet the message is rebuilt for; anything else is refused by the core)
      let signer = null;
      try { const t = parseTransaction(Buffer.from(body.transaction_b64, 'base64')); if (t.signers.length === 1) signer = t.signers[0]; } catch { fail('LocalActInvalid'); }
      check(address(signer), 'LocalActSigner');
      const pins = Object.freeze({ ...base, wallet: signer });
      const ok = localActSubmit(body, pins, { schema: DEVNET_ACT_SUBMIT_SCHEMA, outpost: true, wideVillage: true }), digest = sha(ok.message);
      check(!seen.has(digest), 'LocalActMessageUsed');
      const { intent } = ok;
      const citizenAt = A.of('Citizen', { wallet: pins.wallet });
      // (the wide claim's subject holding is its anchor: the first home, a legacy village of this Citizen — checked as one)
      const holdingAt = intent.subject.holding ? A.of('Holding', intent.subject.holding) : null;
      // (devnet-page-outpost: a FileOutpost's target Province too, read in the same call — absent: refused before the send)
      const provinceAt = intent.name === OUTPOST_ACT ? A.of('Province', intent.subject.sites[0]) : null;
      // (devnet-p17: a wide village's act — its wide holding and its own wide province, read in the same call)
      const wide = WIDE_VILLAGE_ACTS.includes(intent.name) ? wideOf(intent.subject.wide) : null;
      // (devnet-territory-dev: a tile claim's target wide province, read in the same call — absent: refused before the send)
      const tileAt = intent.name === TERRITORY_CLAIM ? wideProvinceAddress(A.season, cfg.programId, intent.subject.target.p, intent.subject.target.q) : null;
      const asked = [citizenAt, ...(holdingAt === null ? [] : [holdingAt]), ...(provinceAt === null ? [] : [provinceAt]), ...(wide === null ? [] : [wide.holding, wide.province]), ...(tileAt === null ? [] : [tileAt])];
      const got = await ask('getMultipleAccounts', [asked, { encoding: 'base64', commitment: 'confirmed' }]);
      const slot = got.result?.context?.slot, rows = got.result?.value;
      if (!Number.isSafeInteger(slot) || slot < 0 || !Array.isArray(rows) || rows.length !== asked.length) fail('LocalActRpcUnavailable');
      localActAccountsCheck(intent, pins, { citizenAt, holdingAt },
        [localActAccountOf(rows[0]), holdingAt === null ? undefined : localActAccountOf(rows[1])]);
      if (provinceAt !== null) { const pv = localActAccountOf(rows[2]); check(pv !== null && pv.owner === pins.program, 'LocalActProvinceAbsent'); }
      if (wide !== null) {
        const at = asked.length - 2;
        wideHoldingCheck(rows[at], citizenAt);
        const pv = localActAccountOf(rows[at + 1]); check(pv !== null && pv.owner === pins.program, 'LocalActProvinceAbsent');
      }
      if (tileAt !== null) { const pv = localActAccountOf(rows[asked.length - 1]); check(pv !== null && pv.owner === pins.program, 'LocalActProvinceAbsent'); }
      check(!seen.has(digest), 'LocalActMessageUsed');   // (re-checked after the await; synchronous from here to the send)
      remember(digest, Object.freeze({ signature: ok.signature, name: intent.name, at: now() }));
      let sent;
      try { sent = await rpc('sendTransaction', [body.transaction_b64, { encoding: 'base64', preflightCommitment: 'confirmed' }]); }
      catch { return { status: 'unknown', name: intent.name, signature: ok.signature, status_route: DEVNET_ACT_ROUTES.status }; }
      if (sent?.error) throw new LocalActError(runnerRejection(sent.error) ? 'LocalActRejected' : 'LocalActSendRefused', sendRefusalDetail(sent.error, ok.signature));
      return { status: sent?.result === ok.signature ? 'submitted' : 'unknown', name: intent.name, signature: ok.signature, status_route: DEVNET_ACT_ROUTES.status };
    },

    async status(body) {
      check(exact(body, ['schema', 'signature']) && body.schema === DEVNET_ACT_STATUS_SCHEMA && typeof body.signature === 'string' && body.signature.length <= 100);
      check([...seen.values()].some(e => e.signature === body.signature), 'LocalActUnknownSignature');
      const r = await ask('getSignatureStatuses', [[body.signature], { searchTransactionHistory: true }]);
      const value = r.result?.value, slot = r.result?.context?.slot;
      if (!Number.isSafeInteger(slot) || slot < 0 || !Array.isArray(value) || value.length !== 1) fail('LocalActRpcUnavailable');
      const s = value[0];
      if (s === null) return { signature: body.signature, status: 'pending', context_slot: slot };
      if (typeof s !== 'object' || Array.isArray(s) || !Object.hasOwn(s, 'err') || !Number.isSafeInteger(s.slot) || s.slot < 0
          || !['processed', 'confirmed', 'finalized'].includes(s.confirmationStatus)) fail('LocalActRpcUnavailable');
      return { signature: body.signature, status: s.err !== null ? 'failed' : s.confirmationStatus, err: s.err, slot: s.slot, context_slot: slot };
    },

    /** ONE page-signed Depart (the wallet the only signer, fee payer AND actor), checked as local play's march. */
    async marchSubmit(body) {
      const mfail = (code, detail) => { throw new LocalMarchError(code, detail); };
      if (!(exact(body, ['schema', 'name', 'subject', 'fields', 'transaction_b64']) && body.schema === DEVNET_MARCH_SUBMIT_SCHEMA && typeof body.transaction_b64 === 'string' && body.transaction_b64.length <= 1700)) mfail('LocalMarchInvalid');
      if (!DEVNET_MARCH_COMMANDS.includes(body.name)) mfail('LocalMarchNotAllowed');
      let signer = null;
      try { const t = parseTransaction(Buffer.from(body.transaction_b64, 'base64')); if (t.signers.length === 1) signer = t.signers[0]; } catch { mfail('LocalMarchInvalid'); }
      if (!address(signer)) mfail('LocalMarchSigner');
      const pins = Object.freeze({ ...base, wallet: signer });
      const ok = localMarchSubmit(body, pins, { schema: DEVNET_MARCH_SUBMIT_SCHEMA }), digest = sha(ok.message);
      if (seen.has(digest)) mfail('LocalMarchMessageUsed');
      const citizenAt = A.of('Citizen', { wallet: pins.wallet });
      const holdingAt = A.of('Holding', ok.intent.subject.holding), provinceAt = A.of('Province', ok.intent.subject.province);
      let got; try { got = await rpc('getMultipleAccounts', [[citizenAt, holdingAt, provinceAt], { encoding: 'base64', commitment: 'confirmed' }]); } catch { mfail('LocalMarchRpcUnavailable'); }
      const slot = got?.result?.context?.slot, rows = got?.result?.value;
      if (got?.error !== undefined || !Number.isSafeInteger(slot) || slot < 0 || !Array.isArray(rows) || rows.length !== 3) mfail('LocalMarchRpcUnavailable');
      localMarchAccountsCheck(ok.intent, pins, { citizenAt, holdingAt }, rows.map(localMarchAccountOf));
      if (seen.has(digest)) mfail('LocalMarchMessageUsed');   // (re-checked after the await; synchronous from here to the send)
      remember(digest, Object.freeze({ signature: ok.signature, name: 'Depart', blockhash: ok.blockhash, at: now() }));
      const binding = sealBinding(ok.intent);
      let sent;
      try { sent = await rpc('sendTransaction', [body.transaction_b64, { encoding: 'base64', preflightCommitment: 'confirmed' }]); }
      catch { return { status: 'unknown', name: 'Depart', signature: ok.signature, ...binding, status_route: DEVNET_MARCH_ROUTES.status }; }
      if (sent?.error) throw new LocalMarchError(runnerRejection(sent.error) ? 'LocalMarchRejected' : 'LocalMarchSendRefused', sendRefusalDetail(sent.error, ok.signature));
      return { status: sent?.result === ok.signature ? 'submitted' : 'unknown', name: 'Depart', signature: ok.signature, ...binding, status_route: DEVNET_MARCH_ROUTES.status };
    },

    /** The chain's word on a march this gateway sent; `expired` once its blockhash is no longer valid and it is unknown. */
    async marchStatus(body, name = 'Depart') {
      const mfail = code => { throw new LocalMarchError(code); };
      if (!(exact(body, ['schema', 'signature']) && body.schema === DEVNET_MARCH_STATUS_SCHEMA && typeof body.signature === 'string' && body.signature.length <= 100)) mfail('LocalMarchInvalid');
      const entry = [...seen.values()].find(e => e.signature === body.signature && e.name === name);
      if (!entry) mfail('LocalMarchUnknownSignature');
      const q = async (m, p) => { let r; try { r = await rpc(m, p); } catch { mfail('LocalMarchRpcUnavailable'); } if (!r || r.error !== undefined) mfail('LocalMarchRpcUnavailable'); return r; };
      const v = await q('isBlockhashValid', [entry.blockhash, { commitment: 'processed' }]);
      const expired = v.result?.value === false;
      const r = await q('getSignatureStatuses', [[body.signature], { searchTransactionHistory: true }]);
      const value = r.result?.value, slot = r.result?.context?.slot;
      if (!Number.isSafeInteger(slot) || slot < 0 || !Array.isArray(value) || value.length !== 1) mfail('LocalMarchRpcUnavailable');
      const s = value[0];
      if (s === null) return { signature: body.signature, status: expired ? 'expired' : 'pending', context_slot: slot };
      if (typeof s !== 'object' || Array.isArray(s) || !Object.hasOwn(s, 'err') || !Number.isSafeInteger(s.slot) || s.slot < 0
          || !['processed', 'confirmed', 'finalized'].includes(s.confirmationStatus)) mfail('LocalMarchRpcUnavailable');
      return { signature: body.signature, status: s.err !== null ? 'failed' : s.confirmationStatus, err: s.err, slot: s.slot, context_slot: slot };
    },

    /**
     * ONE page-signed boundary departure (devnet gap P15): the canonical request pinned to this gateway, the message
     * rebuilt with the shared builder and byte-compared, the wallet's one signature verified, one read, one send.
     */
    async expeditionSubmit(body) {
      const mfail = (code, detail) => { throw new LocalMarchError(code, detail); };
      if (!(exact(body, ['schema', 'request', 'blockhash', 'transaction_b64']) && body.schema === DEVNET_EXPEDITION_SUBMIT_SCHEMA && address(body.blockhash)
          && typeof body.transaction_b64 === 'string' && body.transaction_b64.length <= 1700)) mfail('LocalMarchInvalid');
      let request; try { request = expeditionDepartPrepareRequest(body.request); } catch { mfail('LocalMarchInvalid'); }
      if (request.cluster !== 'devnet' || request.program !== base.program || request.season !== base.season
          || request.deployment.program_version !== DEPART_PREPARE_PROGRAM_VERSION || request.deployment.ruleset_hash !== base.rulesetHash) mfail('LocalMarchNotAllowed');
      if (request.payer !== request.wallet) mfail('LocalMarchSigner');
      const wire = Buffer.from(body.transaction_b64, 'base64');
      if (wire.toString('base64') !== body.transaction_b64 || wire.length > 1232) mfail('LocalMarchInvalid');
      let signed; try { signed = singleSigned(wire); } catch { mfail('LocalMarchSigner'); }
      let built; try { built = departUnsignedMessage({ request, blockhash: body.blockhash }); } catch { mfail('LocalMarchInvalid'); }
      if (!Buffer.from(signed.message).equals(Buffer.from(built.message))) mfail('LocalMarchMessageMismatch');
      if (!edVerify(null, signed.message, edKey(decode(request.wallet)), signed.signature)) mfail('LocalMarchSigner');
      const digest = built.digest;
      if (seen.has(digest)) mfail('LocalMarchMessageUsed');
      const pins = Object.freeze({ ...base, wallet: request.wallet });
      const role = n => request.proposal.roles.find(r => r.name === n).address;
      const citizenAt = A.of('Citizen', { wallet: pins.wallet });
      if (role('citizen') !== citizenAt) mfail('LocalMarchCitizen');
      const home = hostHome(request.host), holdingAt = role('holding'), provinceAt = role('province');
      let got; try { got = await rpc('getMultipleAccounts', [[citizenAt, holdingAt, provinceAt], { encoding: 'base64', commitment: 'confirmed' }]); } catch { mfail('LocalMarchRpcUnavailable'); }
      const slot = got?.result?.context?.slot, rows = got?.result?.value;
      if (got?.error !== undefined || !Number.isSafeInteger(slot) || slot < 0 || !Array.isArray(rows) || rows.length !== 3) mfail('LocalMarchRpcUnavailable');
      localMarchAccountsCheck({ subject: { holding: home, province: { p: Number(request.standing.p), q: Number(request.standing.q) } } }, pins,
        { citizenAt, holdingAt }, rows.map(localMarchAccountOf));
      if (seen.has(digest)) mfail('LocalMarchMessageUsed');   // (re-checked after the await; synchronous from here to the send)
      const signature = encode(signed.signature);
      remember(digest, Object.freeze({ signature, name: 'ExpeditionDepart', blockhash: body.blockhash, at: now() }));
      let sent;
      try { sent = await rpc('sendTransaction', [body.transaction_b64, { encoding: 'base64', preflightCommitment: 'confirmed' }]); }
      catch { return { status: 'unknown', name: 'ExpeditionDepart', signature, message_digest: digest, status_route: DEVNET_EXPEDITION_ROUTES.status }; }
      if (sent?.error) throw new LocalMarchError(runnerRejection(sent.error) ? 'LocalMarchRejected' : 'LocalMarchSendRefused', sendRefusalDetail(sent.error, signature));
      return { status: sent?.result === signature ? 'submitted' : 'unknown', name: 'ExpeditionDepart', signature, message_digest: digest, status_route: DEVNET_EXPEDITION_ROUTES.status };
    },

    /** The chain's word on a boundary departure this gateway sent (as marchStatus). */
    async expeditionStatus(body) {
      if (!(exact(body, ['schema', 'signature']) && body.schema === DEVNET_EXPEDITION_STATUS_SCHEMA && typeof body.signature === 'string' && body.signature.length <= 100)) throw new LocalMarchError('LocalMarchInvalid');
      if (![...seen.values()].some(e => e.signature === body.signature && e.name === 'ExpeditionDepart')) throw new LocalMarchError('LocalMarchUnknownSignature');
      return this.marchStatus({ schema: DEVNET_MARCH_STATUS_SCHEMA, signature: body.signature }, 'ExpeditionDepart');
    },

    stats: () => ({ history: seen.size }),
  });
}
