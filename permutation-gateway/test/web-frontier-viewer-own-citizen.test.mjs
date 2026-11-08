// ⑯ 2026-11-08: the controller's /h/me adoption (⑳ 5ee5fa35, controller.mjs viewerOwnCitizen in applyMeResult) on
// the program's own Citizen bytes (frontier-abi vectors/v2/resident-citizen.json), and nothing else:
//   - an NFT viewer refuses a wallet Citizen whose WALLET is the asset address (the herald's me_citizen serves it first);
//   - an NFT viewer adopts the Citizen whose resident mark names the asset played;
//   - a wallet viewer still adopts its unmarked wallet Citizen (no regression), and refuses a marked one;
//   - a refusal leaves the Citizen and the holdings already adopted in place.
// Static call-path review (⑯ REPORT §29.26): applyMeResult reaches viewerOwnCitizen (base58), fwide (adoptWide /
// failWide / clearWide), fland.landState, the in-memory land record (no pin is set, so no storage), fstate.invalidate
// (no renderer is registered in this closure) and refreshDelegation, which returns before any read because the store
// below has a wallet, no session problem and agentWallet defined. FS.session is null, so fsession is never called.
// No pin, no herald, no transport, no network, no key: the wallet below is a public address and the asset is the
// vector's public one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyMeResult } from '../../permutation-server/web/frontier/controller.mjs';
import { FS } from '../../permutation-server/web/frontier/fstate.mjs';
import { decode } from '../../permutation-server/web/frontier/fcodec.mjs';
import { encodeAccount } from '../../permutation-server/web/sdk/frontier/codec.mjs';
import { encode as toB58, decode as fromB58 } from '../../permutation-server/web/sdk/base58.mjs';
import { fromHex } from '../../permutation-server/web/sdk/bytes.mjs';

const V = JSON.parse(readFileSync(new URL('../../frontier-abi/vectors/v2/resident-citizen.json', import.meta.url), 'utf8'));
const ASSET = V.asset;
const bytesOf = name => fromHex(V.cases.find(c => c.case === name).bytes);
const citizen = b => decode('Citizen', b, { profile: 2, seasonId: V.season_id });
const WALLET_CASE = V.cases.find(c => c.case === 'wallet');
/** the program's wallet Citizen and NFT Citizen, as the vector writes them */
const walletCitizen = () => citizen(bytesOf('wallet'));
const nftCitizen = () => citizen(bytesOf('nft'));
/** a wallet Citizen keyed by the asset address: what /h/me/{asset} serves first when such a Citizen exists */
const walletAtAsset = () => citizen(encodeAccount('Citizen', { SEASON_ID: BigInt(V.season_id), LAYOUT_VERSION: 2, WALLET: fromB58(ASSET), FACTION: 2, TICKET_BELL: 0xffffffff }, { profile: 2 }));
/** the NFT Citizen's bytes with a mark naming another asset (flag kept) */
const otherAsset = toB58(new Uint8Array(32).fill(0x6b));
const nftOfOther = () => { const b = bytesOf('nft'); b.set(fromB58(otherAsset), V.resident_asset_off); return citizen(b); };

const me = (c, holdings) => ({ ok: true, citizen: c, holdings, slots: [], record: { v: 1, citizen: {}, holdings: [], slots: [], hosts: [] } });
const NFT_VIEWER = Object.freeze({ asset: ASSET, generation: 1, joined: true, citizen: V.cases.find(c => c.case === 'nft').citizen_address });
const store = resident => ({
  wallet: { address: WALLET_CASE.key }, resident, session: null, sessionProblem: null, delegation: null, agentWallet: false,
  clock: null, chain: null, record: null, land: null, landRec: null, citizen: null, holdings: [], meStatus: 'loading', meError: null, meAnswered: false,
  wideHoldings: null, wideStatus: 'loading', wideError: null, wideSelect: null,
});
const keep = () => { const saved = { ...FS }; return () => { for (const k of Object.keys(FS)) if (!(k in saved)) delete FS[k]; Object.assign(FS, saved); }; };

test('the fixtures are what they claim (decoded by the page codec)', () => {
  assert.equal(walletCitizen().residentAsset, undefined, 'the wallet case carries no mark');
  assert.equal(toB58(nftCitizen().residentAsset), ASSET, 'the nft case names the asset');
  const w = walletAtAsset();
  assert.equal(w.residentAsset, undefined, 'a wallet Citizen keyed by the asset carries no mark');
  assert.equal(toB58(w.wallet), ASSET, 'and its WALLET is the asset address');
  assert.equal(toB58(nftOfOther().residentAsset), otherAsset);
  assert.equal(citizen(bytesOf('flagged_with_wallet')).residentAsset, null, 'an invalid mark decodes to null');
});

test('NFT viewer: the wallet Citizen at the asset address is refused; the Citizen and holdings already adopted stay', () => {
  const restore = keep();
  try {
    Object.assign(FS, store({ ...NFT_VIEWER }));
    const own = nftCitizen(), ownHoldings = [{ held: 'nft' }];
    assert.equal(applyMeResult(me(own, ownHoldings)), 'found');
    assert.equal(FS.citizen, own); assert.equal(FS.holdings, ownHoldings);
    assert.equal(applyMeResult(me(walletAtAsset(), [{ held: 'wallet-at-asset' }])), 'error');
    assert.deepEqual([FS.meStatus, FS.meError?.code], ['error', 'WrongKey']);
    assert.equal(FS.citizen, own, 'the NFT Citizen is not overwritten');
    assert.equal(FS.holdings, ownHoldings, 'the holdings are not overwritten');
    // the same for a mark naming another asset, and an invalid mark
    for (const c of [nftOfOther(), citizen(bytesOf('flagged_with_wallet')), citizen(bytesOf('flagged_zero_asset')), walletCitizen()]) {
      assert.equal(applyMeResult(me(c, [{ held: 'other' }])), 'error');
      assert.equal(FS.meError?.code, 'WrongKey');
      assert.equal(FS.citizen, own); assert.equal(FS.holdings, ownHoldings);
    }
  } finally { restore(); }
});

test('NFT viewer: the Citizen whose resident mark names the asset played is adopted, with its holdings', () => {
  const restore = keep();
  try {
    Object.assign(FS, store({ ...NFT_VIEWER }));
    const c = nftCitizen(), h = [{ held: 'nft' }];
    assert.equal(applyMeResult(me(c, h)), 'found');
    assert.deepEqual([FS.meStatus, FS.meError], ['ready', null]);
    assert.equal(FS.citizen, c); assert.equal(FS.holdings, h);
    assert.equal(toB58(FS.citizen.residentAsset), ASSET);
    assert.equal(FS.sessionProblem, null);
  } finally { restore(); }
});

test('wallet viewer: the unmarked wallet Citizen is still adopted; a marked one is refused and leaves it in place', () => {
  const restore = keep();
  try {
    Object.assign(FS, store(null));
    const c = walletCitizen(), h = [{ held: 'wallet' }];
    assert.equal(applyMeResult(me(c, h)), 'found');
    assert.deepEqual([FS.meStatus, FS.meError], ['ready', null]);
    assert.equal(FS.citizen, c); assert.equal(FS.holdings, h);
    for (const bad of [nftCitizen(), citizen(bytesOf('flagged_with_wallet')), citizen(bytesOf('flagged_zero_asset'))]) {
      assert.equal(applyMeResult(me(bad, [{ held: 'bad' }])), 'error');
      assert.equal(FS.meError?.code, 'WrongKey');
      assert.equal(FS.citizen, c); assert.equal(FS.holdings, h);
    }
    // a read with no Citizen is still 'found' (unchanged: no Citizen is no other key's); NotFound is still 'missing'
    assert.equal(applyMeResult(me(null, [])), 'found');
    assert.equal(FS.citizen, null);
    FS.citizen = c;
    assert.equal(applyMeResult({ ok: false, code: 'NotFound' }), 'missing');
    assert.equal(FS.citizen, null);
  } finally { restore(); }
});
