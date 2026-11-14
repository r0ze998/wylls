// A local NFT world's starting state, for a loopback validator: a Running Season and its folded
// Frontier, written as the Frontier program's own runtime harness writes them
// (permutation-frontier/src/resident_runtime_tests.rs `World::new`), with the program version of the
// NFT lane (S1 | 0x8000). Everything after this state is executed by the real programs: the policy
// (CreateResidentPolicy), the pass (MintResident), the first login (JoinResident, which creates the
// link and the NFT Citizen) and the player's actions (ResidentAct).
//
// TEST STATE ONLY: this is not a Season made by AnnounceSeason / CreateSeason / InitShards, has no
// map, nations, beacon or keeper, and only supports what JoinResident and Citizen-only actions need
// (SetVigil, say). The playable world with the real season lifecycle is frontier-stack's
// (docs/integration/CLAUDE-NFT-PASS-LOCAL-WORLD-20261114.md §5). No key is made here.
import { LAYOUTS as V2 } from '../../permutation-gateway/client/src/frontier/abi-v2-layouts.mjs';
import { PRESETS } from '../../permutation-gateway/client/src/frontier/abi-v2-presets.mjs';
import { FrontierAddresses } from '../../permutation-gateway/client/src/frontier/addresses.mjs';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { base58, pubkeyBytes } from './crypto.mjs';

/** The isolated local NFT lane's program id (`LOCALNET_NFT_PROGRAM_ID`, [0x4E; 32]). */
export const LOCALNET_NFT_PROGRAM_ID = base58(new Uint8Array(32).fill(0x4e));
/** S1 (4) | nft-experimental (0x8000): the version `localnet-nft-sbf` builds carry. */
export const NFT_LANE_PROGRAM_VERSION = 0x8000 | 4;
const STATUS_RUNNING = 3;              // frontier-abi layout::world season::STATUS_RUNNING
const LAYOUT_VERSION_V2 = 2;

const layout = kind => {
  const a = V2.accounts.find(x => x.kind === kind);
  if (!a) throw new Error(`no ${kind} layout`);
  const f = Object.fromEntries(a.fields.map(x => [x.name, x.off]));
  return { size: a.size, magic: a.magic, chained: a.chained, f };
};
const hexBytes = h => Uint8Array.from(h.match(/../g).map(x => parseInt(x, 16)));

/** `frontier_abi::v2::layout::write_header`: magic, season id, and for a chained account layout_version 2 (seq 0, zero head). */
function header(kind, seasonId) {
  const L = layout(kind);
  const d = new Uint8Array(L.size);
  const v = new DataView(d.buffer);
  d.set(Buffer.from(L.magic, 'latin1'), 0);
  v.setBigUint64(8, BigInt(seasonId), true);
  if (L.chained) v.setUint16(L.f.LAYOUT_VERSION, LAYOUT_VERSION_V2, true);
  return { d, v, f: L.f };
}

/**
 * The Season and the Frontier of `seasonId` under `programId` (`[{address, owner, data, lamports}]`, for
 * startValidator's `extraAccounts`). `genesisTs`: the Season's start (a past unix time on the validator's
 * clock). Values as the harness: r_max 8, join closes at bell 100,000, ends at 200,000, 100 open sites.
 */
export function nftWorldAccounts({ programId = LOCALNET_NFT_PROGRAM_ID, seasonId = 1n, genesisTs, lamports = 1_000_000_000n }) {
  if (!Number.isInteger(genesisTs)) throw new TypeError('genesisTs: unix seconds');
  const addrs = new FrontierAddresses({ programId, seasonId: BigInt(seasonId) });
  const s = header('Season', seasonId);
  s.d[s.f.STATUS] = STATUS_RUNNING;
  s.d[s.f.BUMP] = addrs.bump;
  s.v.setUint16(s.f.R_MAX, 8, true);
  s.d.set(hexBytes(PRESETS.ruleset_hash_v3), s.f.RULESET_HASH);
  s.v.setUint16(s.f.PROGRAM_VERSION, NFT_LANE_PROGRAM_VERSION, true);
  s.v.setBigInt64(s.f.GENESIS_TS, BigInt(genesisTs), true);
  s.v.setUint32(s.f.JOIN_CLOSE_BELL, 100_000, true);
  s.v.setUint32(s.f.END_BELL, 200_000, true);
  s.v.setUint16(s.f.BUCKET_RATE_PER_H, 60, true);
  s.v.setUint16(s.f.BUCKET_BURST, 20, true);
  const fr = header('Frontier', seasonId);
  fr.v.setUint32(fr.f.OPEN_SITES, 100, true);
  return {
    addresses: addrs,
    accounts: [
      { address: addrs.season, owner: programId, data: s.d, lamports },
      { address: addrs.frontier, owner: programId, data: fr.d, lamports },
    ],
  };
}

// ---------------------------------------------------------------- CreateSeason on the lane
// AnnounceSeason needs `t_create_min ≥ now + 24 h` and CreateSeason `now ≥ t_create_min`: on a wall-clock
// validator that is a day's wait. So the test preloads the state AnnounceSeason writes (status ANNOUNCED,
// bump, authority, params hash, t_create_min already passed, the bond) and runs the REAL CreateSeason on it.
// (frontier-stack's frontier-localnet moves its clock and runs AnnounceSeason itself.)
const S1_PRESETS = JSON.parse(readFileSync(new URL('../../frontier-abi/vectors/v2/presets.json', import.meta.url), 'utf8'));
/** `sha256(TEST_PK96)`: the beacon key a test-beacon build (the lane) accepts (permutation-frontier crypto/quick.rs). */
export const TEST_BEACON_PK_HASH = 'faa6e379244f54e13045e9810e27ff540156e9cc7dc2f15747f95df12e41b9ef';
export const MIN_CREATION_BOND = 1_000_000_000n;
const SP = { PROGRAM_VERSION: 6, QUICKNET_PK_HASH: 36 };

/** S1_LOCAL_7D with a given program version (default: the lane's) and the test beacon key. 352 B. */
export function laneSeasonParams({ programVersion = NFT_LANE_PROGRAM_VERSION } = {}) {
  const p = S1_PRESETS.presets_s1.find(x => x.name === 'S1_LOCAL_7D');
  const b = Uint8Array.from(Buffer.from(p.bytes, 'hex'));
  new DataView(b.buffer).setUint16(SP.PROGRAM_VERSION, programVersion, true);
  b.set(hexBytes(TEST_BEACON_PK_HASH), SP.QUICKNET_PK_HASH);
  return b;
}
export const payoutRev3 = () => hexBytes(S1_PRESETS.payout_params_rev3_borsh);
/** `params_hash_v2`: sha256("PSF-PARAMS-v2" ‖ params ‖ payout). */
export const paramsHashV2 = (params, payout) => createHash('sha256').update(Buffer.from(S1_PRESETS.params_domain_v2)).update(params).update(payout).digest();

/** The Season as AnnounceSeason leaves it, `t_create_min` already passed (see above). */
export function announcedSeasonAccount({ programId = LOCALNET_NFT_PROGRAM_ID, seasonId = 1n, authority, paramsHash, now }) {
  const addrs = new FrontierAddresses({ programId, seasonId: BigInt(seasonId) });
  const s = header('Season', seasonId);
  s.d[s.f.STATUS] = 0;                                       // STATUS_ANNOUNCED
  s.d[s.f.BUMP] = addrs.bump;
  s.d.set(pubkeyBytes(authority), s.f.AUTHORITY);
  s.d.set(paramsHash, s.f.PARAMS_HASH);
  s.v.setBigInt64(s.f.T_CREATE_MIN, BigInt(now - 60), true);
  s.v.setBigInt64(s.f.ANNOUNCED_TS, BigInt(now - 86_400 - 120), true);
  s.v.setBigUint64(s.f.CREATION_BOND, MIN_CREATION_BOND, true);
  s.v.setUint32(s.f.WINDOW_FROM_BELL, 0xffff_ffff, true);    // WINDOW_NONE
  return { addresses: addrs, account: { address: addrs.season, owner: programId, data: s.d, lamports: 100_000_000n + MIN_CREATION_BOND } };
}

/** 0x01 CreateSeason v2: `[authority s,w] [season w] [frontier w] [pfund × 6 w] [dpool w] [system]`. */
export function createSeasonIx({ addresses, authority, params, payout }) {
  const w = pubkey => ({ pubkey, isSigner: false, isWritable: true });
  return {
    programId: addresses.programId,
    keys: [{ pubkey: authority, isSigner: true, isWritable: true }, w(addresses.season), w(addresses.frontier),
      ...[0, 1, 2, 3, 4, 5].map(n => w(addresses.provinceFund(n))), w(addresses.defencePool),
      { pubkey: '11111111111111111111111111111111', isSigner: false, isWritable: false }],
    data: Uint8Array.from([0x01, ...params, ...payout]),
  };
}
