// The resident id (住民ID): fixed for the life of the NFT, derived from the
// asset's address alone, never from a wallet. It mirrors the game's Citizen
// seed tag (`sha256("PSF-CIT" ‖ wallet)[0..15]`, permutation-rules
// frontier::addr) with a domain of its own, so the proposal to ④ is one new
// seed tag next to the existing one, not a change to the Citizen grammar:
//
//   resident_tag15 = sha256("PSF-RES" ‖ asset_id)[0..15]
//   resident_id    = lowercase hex of resident_tag15 (30 chars)
//
// Two different assets never share a tag in practice (120-bit prefix); the
// registry still refuses a collision outright instead of merging records.
import { pubkeyBytes, sha256, toHex, utf8 } from './crypto.mjs';

export const RESIDENT_TAG_DOMAIN = 'PSF-RES';

export const residentTag15 = assetId => sha256(utf8(RESIDENT_TAG_DOMAIN), pubkeyBytes(assetId)).slice(0, 15);
export const residentIdOf = assetId => toHex(residentTag15(assetId));
export const isResidentId = s => typeof s === 'string' && /^[0-9a-f]{30}$/.test(s);
