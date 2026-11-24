// DEVNET PLAY (devnet gap P1; owner decision B7: the PLAYABLE lane on devnet) — what the page needs to play a devnet
// season itself: its first village (on a wide season, a rim village by a one-site village request, FileTicket), that
// village's economy, and the wide claim (0xD9 WideClaimSite).
//
// The page SENDS ONLY ITS OWN PLAYER COMMANDS, signed by the player's connected wallet (Wallet Standard
// `solana:signTransaction`, chain `solana:devnet`), with that wallet as fee payer AND actor: it pays its own fees and
// rent; no relay key co-signs and the operator pays nothing (owner question O11 — whether a sponsor pays instead — is
// still r0ze's; this path needs no answer to it). The Join registers the wallet itself as the session key (no in-game
// key is made), so every command is one wallet signature. Everything a turn needs besides — the bell's anchor and
// seed, SettleTicket (#104 `tickets`), the rim and the wide rings (#104 `rim_per_wedge`, #107 `wide_rings`),
// WideSettleTicket / WideFinalize (#107 `wide-tickets`), the feed guard (#108) — is keeper A's, not the page's.
//
// Transport: the gateway's devnet play routes behind the herald's /gw (permutation-gateway devnet-play-act.mjs), the
// same protocol as local play's (flocalplay-act.mjs, `devnetLane`): the gateway rebuilds the stated command for the
// transaction's one signer, checks the accounts, and forwards it ONCE to the operator's RPC. The page has no RPC URL
// of its own (its CSP is its own origin) — so no devnet URL is baked in anywhere here.
//
// It is ON only when every one of these holds (`readDevnetPlay`): the page is not local play, the pinned world's
// cluster is 'devnet', and the gateway answers its info with exactly the pinned program, Season account, Season id and
// the Season's own ruleset hash (the gateway's `--devnet-play`, the operator's devnet-config flag). Otherwise nothing
// changes: every order takes the page's ordinary path, as before. The fog of war (fog-devnet) is on for a devnet page by
// its own switch, map/fog.mjs DEVNET_FOG, keyed on the pinned season's cluster — not on this module's answer: a viewer of
// a devnet season sees the same player view whether or not the gateway's routes answered. Nothing here shows the map;
// `wideTargetsOf` hands the wide claim card coordinates only.
import { DEVNET_ACT_CONTEXT_PATH, DEVNET_ACT_INFO_SCHEMA, DEVNET_ACT_NAMES, devnetLane, postLocalAct } from './flocalplay-act.mjs';
import { decode, encode } from '../sdk/base58.mjs';

export { DEVNET_ACT_NAMES };
/** The program's hard outermost ring (geometry R_MAX_HARD): the rim is ring 128, the wide land rings 129+. */
export const RIM_RING = 128;

const fail = code => { throw Object.assign(new Error(code), { code }); };
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const address = v => { try { return typeof v === 'string' && v.length <= 44 && decode(v).length === 32 && encode(decode(v)) === v; } catch { return false; } };
const hexOf = h => (h instanceof Uint8Array ? [...h].map(b => b.toString(16).padStart(2, '0')).join('') : typeof h === 'string' ? h.toLowerCase() : null);

/**
 * Whether this page may play the pinned devnet world itself: `{origin, pin, rulesetHash, localPlay, post}` → a frozen
 * `{relay, programId, seasonAddress, seasonId, rulesetHash, lane}`, or null (off; the ordinary path stays). One read
 * (the gateway's info: its own configuration), nothing sent.
 */
export async function readDevnetPlay({ origin, pin, rulesetHash, localPlay = null, post = postLocalAct }) {
  if (localPlay || !pin || pin.cluster !== 'devnet' || typeof origin !== 'string' || !origin) return null;
  const season = pin.addresses?.season ?? pin.seasonAddress ?? null, hash = hexOf(rulesetHash);
  if (!address(pin.programId) || !address(season) || !/^[0-9a-f]{64}$/.test(hash ?? '')) return null;
  let v;
  try { v = await post(origin, DEVNET_ACT_CONTEXT_PATH, { schema: DEVNET_ACT_INFO_SCHEMA }); } catch { return null; }
  return devnetPlayOf(v, { origin, programId: pin.programId, season, seasonId: String(pin.seasonId), rulesetHash: hash });
}

/** The info answer `v` checked against the pinned world (null when it is not exactly that world's). Pure. */
export function devnetPlayOf(v, { origin, programId, season, seasonId, rulesetHash }) {
  if (!object(v) || v.schema !== DEVNET_ACT_INFO_SCHEMA || v.cluster !== 'devnet') return null;
  if (v.program !== programId || v.season !== season || v.season_id !== seasonId || v.ruleset_hash !== rulesetHash) return null;
  if (!Array.isArray(v.commands) || !DEVNET_ACT_NAMES.every(n => v.commands.includes(n))) return null;
  // (devnet-page-outpost: an optional command — FileOutpost — joins the lane only when the gateway lists it)
  let lane; try { lane = devnetLane(seasonId, { extra: v.commands }); } catch { return null; }
  return Object.freeze({ relay: origin, programId, seasonAddress: season, seasonId, rulesetHash, lane });
}

/**
 * A WIDE devnet season, as the page plays it (devnet-rim-homes design row "Page's devnet path" (1)): devnet play is on,
 * the Season's map may grow to the hard ceiling (`rMaxCeiling` 128) and the map has opened past it (rings opened > 128:
 * the rim is opened, the wide land begins). `record` = the herald's season record, `world` = map/world.mjs worldOf.
 */
export function devnetWide({ devnetPlay, record, world }) {
  if (!devnetPlay) return false;
  const opened = Math.max(Number(world?.ringsOpened ?? 0), Number(world?.ringsOpen ?? 0), Number(record?.ringsOpened ?? 0));
  return Number(record?.rMaxCeiling) === RIM_RING && opened > RIM_RING;
}

/** The opened wide provinces `[{p, q}]` (decimal strings) of the herald's wide land (map/wideland.mjs wideLandOf). */
export function wideTargetsOf(land) {
  const cells = Array.isArray(land?.cells) ? land.cells : [];
  return Object.freeze(cells.filter(c => Number.isSafeInteger(c?.p) && Number.isSafeInteger(c?.q) && Number(c.ring) > RIM_RING).map(c => Object.freeze({ p: String(c.p), q: String(c.q) })));
}

/** The devnet identity of `wallet` (what flocalplay-act.mjs submitLocalAct names): frozen, one object per wallet. */
export function devnetIdentityOf(dp, wallet) {
  if (!dp || !address(wallet)) fail('DevnetPlayIdentity');
  return Object.freeze({ address: wallet, programId: dp.programId, seasonAddress: dp.seasonAddress, cluster: 'devnet' });
}

/** (devnet-page-outpost) Whether this devnet play carries the second/third village (the gateway listed FileOutpost). */
export const devnetOutpostOn = dp => !!dp?.lane?.names?.includes?.('FileOutpost');
/**
 * (devnet-p17, devnet gap P17) Whether this devnet play carries a wide village's own acts — WideHarvest, WideBuild,
 * WideTrain and WideMuster, all four (the gateway listed them; flocalplay-act.mjs devnetLane takes them only together).
 */
export const devnetWideVillageOn = dp => ['WideHarvest', 'WideBuild', 'WideTrain', 'WideMuster'].every(n => !!dp?.lane?.names?.includes?.(n));
/**
 * (devnet-territory-dev) Whether this devnet play carries the single-tile claim of a territory world (the gateway listed
 * TerritoryClaim: its world runs the program of #206/#209 — tiles, villages on own tiles, the nation-land reach witness).
 */
export const devnetTerritoryOn = dp => !!dp?.lane?.names?.includes?.('TerritoryClaim');
