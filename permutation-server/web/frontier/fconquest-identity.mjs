// The canonical public accounts of a wide DeclareSiege by an original host that stays in wide land, rebuilt from
// public bytes only. Shared by the gateway (conquest-prepare.mjs) and the page, so neither takes an address from a
// report: what is signed names the province the host stands in, that province's roster and conquest table, the site
// chosen, this Citizen's capture escrow, and the host's own village and its province. Nothing else.
//
// Parity targets (read, not executed here):
//   permutation-frontier/src/proc/wide_conquest_exec.rs  declare: province → roster_address(pkey), the source Holding
//     of the roster reference, check_source_province (a legacy source: the Holding's own Province),
//     holding_address(prov.coord, site) which must be absent, the conquest table of pkey, the Citizen's escrow
//   frontier-abi world_index/conquest.rs  conquest_seed `wq` / PSF-WIDE-CONQUEST-SEED-v1 over the 50-byte province key;
//     capture_escrow_seed `we` / PSF-WIDE-CAPTURE-ESCROW-SEED-v1 over the Citizen's address
//   frontier-abi world_index/holding.rs   holding_seed `wh` / PSF-WIDE-HOLDING-SEED-v1 over sort key ‖ site
//   frontier-abi world_index/wide_ix.rs   DECLARE_SIEGE: the twelve positions and their privileges
//
// Cross-checked against a Rust-produced vector: frontier-node/crates/fclient/tests/fixtures/
// wide_conquest_declare_siege_v1.json (six cases), by permutation-gateway/test/web-frontier-conquest-identity.test.mjs.
// That is one of the opening conditions of the conquest route, not all of them (docs/integration/
// FABLE-CONQUEST-CONNECTION-20261111.md).
//
// No authority, signature or freshness is implied by any value here.
import { canonicalExpeditionAccounts } from './fexpedition-identity.mjs';
import { wideHoldingAddress } from './fwide.mjs';
import { withSeed } from './faddr.mjs';
import { parseWideInt } from './map/wide.mjs';
import { decode, encode } from '../sdk/base58.mjs';
import { fromHex, toHex, utf8 } from '../sdk/bytes.mjs';
import { sha256 } from '../sdk/sha256.mjs';

const SYSTEM = '11111111111111111111111111111111';
const check = (ok, code = 'ConquestIdentity') => { if (!ok) throw Object.assign(new Error(code), { code }); };
const publicBytes = s => { check(typeof s === 'string' && s.length >= 32 && s.length <= 44); const b = decode(s); check(b.length === 32 && b.some(x => x !== 0) && encode(b) === s); return b; };

/** DECLARE_SIEGE: name, signer, writable, in the ABI's order. */
export const DECLARE_SIEGE_SHAPE = Object.freeze([['actor', true, false], ['payer', true, true], ['season', false, false], ['citizen', false, true], ['source_holding', false, true],
  ['target_province', false, true], ['target_roster', false, false], ['source_province', false, false], ['target_holding_position', false, false], ['conquest', false, true],
  ['capture_escrow', false, true], ['system', false, false]].map(r => Object.freeze(r)));

/**
 * The outer dispatch of a wrapped DeclareSiege, the one definition the gateway and the page both read.
 *   tag, kind  published: docs/integration/CLAUDE-CONQUEST-DISPATCH-KINDS-20261111.md (kind 12, tag 0xDA)
 *   heap       a recorded LOCAL decision (256 KiB, as Depart and the resident steps needed through the same wrapper);
 *              unconfirmed until the conquest lane's first real SBF execution
 */
export const DECLARE_SIEGE_DISPATCH = Object.freeze({ tag: 0xda, kind: 12, heap: 256 * 1024 });
/** The instruction data of a wrapped DeclareSiege: `[tag, 0xFF, 2, kind]`, then the ABI's own `DA FF 01 05 site entry`. */
export function declareSiegeInstruction(site, entry, dispatch = DECLARE_SIEGE_DISPATCH) {
  check(Number.isInteger(site) && site >= 0 && site <= 11 && Number.isInteger(entry) && entry >= 0 && entry <= 55);
  return Uint8Array.of(dispatch.tag, 0xff, 2, dispatch.kind, 0xda, 0xff, 1, 5, site, entry);
}

/**
 * The twelve roles of DeclareSiege for `request` (the original-host inspection request: the host, its owner, the
 * wide province it stands in, the acting wallet which also pays) and `site` (0–11) of that province.
 * → `[{name, address, signer, writable}]` in order, frozen. Throws `ConquestIdentity` when the request cannot name
 * them: no wallet, a payer that is not the wallet, a Citizen that is not this wallet's, a site out of range.
 */
export function canonicalDeclareSiegeRoles(request, site) {
  check(Number.isInteger(site) && site >= 0 && site <= 11);
  const wallet = request?.wallet; publicBytes(wallet);
  check(request.payer === wallet);
  const { standing_key: key, accounts: a, citizen } = canonicalExpeditionAccounts(request);
  // (the host's owner is this wallet's own Citizen: the program refuses any other as NotOwner)
  check(citizen !== null && citizen === request.original_owner);
  const derive = seed => withSeed(request.season, seed, request.program);
  const hashed = (tag, domain, ...parts) => derive(tag + toHex(sha256(utf8(domain), ...parts).slice(0, 15)));
  const address = {
    actor: wallet, payer: wallet, season: request.season, citizen,
    source_holding: a.original_holding,
    target_province: a.wide_standing,
    target_roster: a.wide_roster,
    source_province: a.original_home,
    target_holding_position: wideHoldingAddress(request.season, request.program, parseWideInt(request.standing.p), parseWideInt(request.standing.q), site),
    conquest: hashed('wq', 'PSF-WIDE-CONQUEST-SEED-v1', fromHex(key)),
    capture_escrow: hashed('we', 'PSF-WIDE-CAPTURE-ESCROW-SEED-v1', publicBytes(citizen)),
    system: SYSTEM,
  };
  // (the wallet stands twice, actor and payer: Solana's privileges are per account, so both positions carry the payer's
  // writable flag, exactly as the Rust draft records them — fclient wide_conquest_draft.rs)
  const roles = DECLARE_SIEGE_SHAPE.map(([name, signer, writable]) => Object.freeze({ name, address: address[name], signer, writable: writable || name === 'actor' }));
  // (ten distinct accounts besides the wallet named twice: a collision would mean a request this path does not serve)
  check(new Set(roles.map(r => r.address)).size === roles.length - 1);
  return Object.freeze(roles);
}
