// Workstream 20: the viewer's own `/h/me/{key}` read for an NFT resident, against the Citizen bytes the program
// writes. frontier-abi's `abi-vectors` writes vectors/v2/resident-citizen.json with `resident_citizen::mark` (the
// program's own marking of a v2 Citizen), `resident_asset`'s answer and the Citizen address the herald's
// `me_citizen` serves for each key; here the web client's own codec (fcodec `decode`), its own address derivation
// (faddr `withSeed`/`seedOf`, sdk `residentCitizen`) and the real herald client (`createHerald().me`, `checkMe`)
// read those bytes over a stand-in fetch. Nothing on the client side builds the expected object: it comes from the
// Rust side, and wrong owner, another asset, an invalid mark, truncated or malformed bytes stay refusals.
// Public synthetic data only: no key is made, derived or used.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as herald from '../../permutation-server/web/frontier/herald.mjs';
import { decode, RESIDENT_ASSET_OFF, RESIDENT_FLAGS_OFF, FLAG_RESIDENT } from '../../permutation-server/web/frontier/fcodec.mjs';
import { withSeed, seedOf } from '../../permutation-server/web/frontier/faddr.mjs';
import { residentCitizen, residentTag15 } from '../../permutation-server/web/sdk/frontier/resident.mjs';
import { encodeAccount } from '../../permutation-server/web/sdk/frontier/codec.mjs';
import { encode as toB58, decode as fromB58 } from '../../permutation-server/web/sdk/base58.mjs';
import { toBase64, fromHex, toHex } from '../../permutation-server/web/sdk/bytes.mjs';

const V = JSON.parse(readFileSync(new URL('../../frontier-abi/vectors/v2/resident-citizen.json', import.meta.url), 'utf8'));
const CASE = Object.fromEntries(V.cases.map(c => [c.case, { ...c, raw: fromHex(c.bytes) }]));
/** The client's addresses of the vector's season (its Season address and program as given, every account by with-seed). */
const ADDRS = Object.freeze({
  programId: V.program_id, seasonId: String(V.season_id), season: V.season_pda,
  of: (kind, key = {}) => withSeed(V.season_pda, seedOf(kind, key), V.program_id),
});
const WALLET = CASE.wallet.key, ASSET = V.asset;
const NFT_AT = CASE.nft.citizen_address;

/** A herald answering `/h/me/{key}` from `routes` (key → body), 404 otherwise. */
const heraldOf = routes => {
  const h = herald.createHerald({
    base: 'http://herald.test', seasonId: V.season_id,
    fetch: async url => {
      const key = decodeURIComponent(String(url).split('/h/me/')[1] ?? '');
      const body = routes[key];
      return body === undefined ? { ok: false, status: 404, json: async () => ({}) } : { ok: true, status: 200, json: async () => structuredClone(body) };
    },
  });
  h.pin(V.season_id, ADDRS);
  return h;
};
const meOf = (citizen, { address, holdings = [] } = {}) => ({
  v: 1, citizen: citizen === null ? null : { address, bytes_b64: toBase64(citizen) }, holdings, slots: [],
});
/** A v2 Holding at the NFT Citizen's first slot ref (2,0,3) gen 1, owned by `owner`. */
const holdingOf = owner => ({
  address: ADDRS.of('Holding', { p: 2, q: 0, site: 3 }),
  bytes_b64: toBase64(encodeAccount('Holding', { SEASON_ID: BigInt(V.season_id), LAYOUT_VERSION: 2, P: 2, Q: 0, SITE: 3, GEN: 1, OWNER_CITIZEN: fromB58(owner), TIER: 1, STATE: 2 }, { profile: 2 })),
});

test('the client reads the program\'s resident mark where frontier-abi puts it', () => {
  assert.equal(RESIDENT_ASSET_OFF, V.resident_asset_off);
  assert.equal(RESIDENT_FLAGS_OFF, V.resident_flags_off);
  assert.equal(FLAG_RESIDENT, V.flag_resident);
  for (const c of V.cases) {
    const d = decode('Citizen', CASE[c.case].raw, { seasonId: V.season_id });
    assert.equal(d.layoutVersion, 2, c.case);
    assert.equal(d.residentAsset !== undefined, c.flagged, `${c.case}: flagged`);
    if (c.flagged) assert.equal(d.residentAsset === null ? null : toB58(d.residentAsset), c.resident_asset, `${c.case}: resident_asset`);
  }
  // The NFT Citizen as the program leaves it: the wallet zero, the faction and slot refs kept.
  const nft = decode('Citizen', CASE.nft.raw);
  assert.ok(nft.wallet.every(x => x === 0));
  assert.equal(nft.faction, 2);
  assert.deepEqual(nft.holding.map(r => [r.p, r.q, r.site, r.gen]), [[2, 0, 3, 1], [0, 0, 12, 0], [0, 0, 0, 255]]);
});

test('the client derives the Citizen address the herald serves, for a wallet and for an asset', () => {
  assert.equal(toHex(residentTag15(ASSET)), V.resident_tag15);
  assert.equal(ADDRS.of('Citizen', { wallet: WALLET }), CASE.wallet.citizen_address);
  assert.equal(residentCitizen(ADDRS, ASSET), NFT_AT);
  // never the asset read as a wallet
  assert.notEqual(ADDRS.of('Citizen', { wallet: ASSET }), NFT_AT);
});

test('/h/me of an NFT: the program\'s NFT Citizen and its holding are the viewer\'s own', async () => {
  const r = await heraldOf({ [ASSET]: meOf(CASE.nft.raw, { address: NFT_AT, holdings: [holdingOf(NFT_AT)] }) }).me(ASSET);
  assert.equal(r.ok, true, r.error);
  assert.equal(toB58(r.citizen.residentAsset), ASSET);
  assert.equal(r.holdings.length, 1);
  assert.equal(toB58(r.holdings[0].ownerCitizen), NFT_AT);
  // the Citizen bytes alone, before any holding
  const bare = await heraldOf({ [ASSET]: meOf(CASE.nft.raw, { address: NFT_AT }) }).me(ASSET);
  assert.equal(bare.ok, true, bare.error);
  // and the wallet's own Citizen is read as before
  const w = await heraldOf({ [WALLET]: meOf(CASE.wallet.raw, { address: CASE.wallet.citizen_address }) }).me(WALLET);
  assert.equal(w.ok, true, w.error);
  assert.equal(w.citizen.residentAsset, undefined);
});

test('/h/me of an NFT: another asset, another address, an invalid mark or a wrong owner is refused', async () => {
  const other = toB58(new Uint8Array(32).fill(0x33));
  const code = async (key, body) => (await heraldOf({ [key]: body }).me(key)).code;
  // the NFT Citizen served for another asset (at the other asset's address, or at this one's)
  assert.equal(await code(other, meOf(CASE.nft.raw, { address: residentCitizen(ADDRS, other) })), 'WrongKey');
  assert.equal(await code(other, meOf(CASE.nft.raw, { address: NFT_AT })), 'WrongKey');
  // the NFT Citizen named at the asset's wallet-derived address
  assert.equal(await code(ASSET, meOf(CASE.nft.raw, { address: ADDRS.of('Citizen', { wallet: ASSET }) })), 'WrongKey');
  // a flagged Citizen the program never writes
  assert.equal(await code(ASSET, meOf(CASE.flagged_with_wallet.raw, { address: NFT_AT })), 'WrongKey');
  assert.equal(await code(ASSET, meOf(CASE.flagged_zero_asset.raw, { address: NFT_AT })), 'WrongKey');
  // a wallet Citizen served for the asset, or the NFT Citizen for a wallet
  assert.equal(await code(ASSET, meOf(CASE.wallet.raw, { address: NFT_AT })), 'WrongKey');
  assert.equal(await code(WALLET, meOf(CASE.nft.raw, { address: CASE.wallet.citizen_address })), 'WrongKey');
  // a holding owned by the asset's wallet-derived Citizen, or by the wallet's
  assert.equal(await code(ASSET, meOf(CASE.nft.raw, { address: NFT_AT, holdings: [holdingOf(ADDRS.of('Citizen', { wallet: ASSET }))] })), 'WrongKey');
  assert.equal(await code(ASSET, meOf(CASE.nft.raw, { address: NFT_AT, holdings: [holdingOf(CASE.wallet.citizen_address)] })), 'WrongKey');
});

test('/h/me of an NFT: truncated, malformed or another season\'s bytes are refused by the codec', async () => {
  const code = async raw => (await heraldOf({ [ASSET]: meOf(raw, { address: NFT_AT }) }).me(ASSET)).code;
  assert.equal(await code(CASE.nft.raw.subarray(0, RESIDENT_FLAGS_OFF)), 'WrongSize');
  assert.equal(await code(CASE.nft.raw.subarray(0, CASE.nft.raw.length - 1)), 'WrongSize');
  const magic = Uint8Array.from(CASE.nft.raw); magic[0] ^= 0xff;
  assert.equal(await code(magic), 'WrongMagic');
  const season = Uint8Array.from(CASE.nft.raw); season[8] = 6;
  assert.equal(await code(season), 'WrongSeason');
  // an incomplete record stays an incomplete record
  assert.equal((await heraldOf({ [ASSET]: { v: 1, citizen: null } }).me(ASSET)).code, 'BadRecord');
});
