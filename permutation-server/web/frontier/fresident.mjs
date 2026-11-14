// ⑳ NFT residents on the page (provisional, nft-experimental programs):
// the NFT choice of the first login and the identity an NFT Citizen plays as.
//
//   loadResidents(owner)     GET /f/residents?owner= → {ok, residents, policy}
//   identityOf(entry, …)     the NFT Citizen's addresses: its Citizen (at the
//                            resident ID's address), the four proof accounts,
//                            the generation the owner signs
//
// One NFT, one Citizen: the page offers each NFT the connected wallet holds;
// a joined one is played, a new one is joined first (JoinResident). The
// program decides who may act on every instruction (the asset's current
// owner, the transfer guard, the generation); the page only reads the
// generation fresh before each send, so an action after a transfer is
// signed for the new generation by the new owner's wallet.
//
// Limits (not implemented): an NFT resident has no in-game key yet (its
// session lives in the resident program, which this page does not call), so
// the wallet signs every action; SetSession is refused for an NFT Citizen.
import { linkAddress, policyAddress, residentAddress, residentCitizen } from '../sdk/frontier/resident.mjs';
import * as io from './fchainio.mjs';

/** The NFTs `owner` holds that can be a resident here (the relay reads the chain). */
export async function loadResidents(owner, { request = io.request } = {}) {
  const r = await request('GET', `/f/residents?owner=${encodeURIComponent(owner)}`);
  if (!r.ok) return r;
  return { ok: true, residents: r.residents ?? [], policy: r.policy ?? null, mint: mintLink(r.mint) };
}

/** The relay's mint page link, kept only as an http(s) URL without credentials (else null). */
export function mintLink(url) {
  if (typeof url !== 'string') return null;
  try {
    const u = new URL(url);
    return (u.protocol === 'http:' || u.protocol === 'https:') && !u.username && !u.password ? u.toString() : null;
  } catch { return null; }
}

/**
 * ⑳ The march's send (fmarch.sendMarch* → `submit`) for the viewer. A march is a Depart, signed by the Frontier
 * session key for a wallet Citizen; an NFT Citizen has no session key, so its owner's wallet signs the Depart inside
 * ResidentAct, for the generation read now (a transfer since the page loaded changes it) — exactly as `act` does for
 * every other player instruction. A pass no longer in the wallet is refused before anything is signed.
 * `resident()`: the NFT played (or null); `walletNow()`: the connected wallet; `generationOf(owner, asset)`: the
 * resident record's generation for this owner, or null when the owner does not hold it.
 */
export function marchSubmitFor({ submit, resident, walletNow, generationOf, adopt = () => {} }) {
  return async req => {
    const r = resident();
    if (!r) return submit(req);
    const w = walletNow();
    if (!w) return { ok: false, code: 'NoWallet' };
    const g = await generationOf(w.address, r.asset);
    if (g === null || g === undefined) return { ok: false, code: 'NftNotHeld' };
    adopt(g);
    return submit({ ...req, signer: { wallet: w }, resident: { generation: g, proof: r.proof } });
  };
}

/**
 * The identity an NFT plays as in the pinned season: `{asset, citizen,
 * generation, joined, proof: {policy, link, asset, resident}}`. The proof
 * addresses are recomputed here (never taken from the relay's answer).
 */
export function identityOf(entry, policy, { addresses, programId }) {
  const asset = entry.asset;
  return {
    asset,
    citizen: residentCitizen(addresses, asset),
    generation: entry.generation,
    joined: !!entry.joined,
    proof: { policy: policyAddress(programId), link: linkAddress(programId, addresses.season, asset), asset, resident: residentAddress(policy.residentProgram, asset) },
  };
}

/** The accounts of JoinResident for `id` (the relay's fee payer is added by fplay.submit). */
export function joinAccounts(id, { addresses, owner, joinGate = null }) {
  return {
    owner, season: addresses.season, frontier: addresses.of('Frontier'), citizen: id.citizen,
    policy: id.proof.policy, link: id.proof.link, asset: id.asset, resident: id.proof.resident,
    ...(joinGate ? { joinGate } : {}),
  };
}

/** The controller's account context for an NFT Citizen: the wallet (the owner) acts for the resident's Citizen. */
export const actorContext = (id, owner) => ({ wallet: owner, actor: owner, citizen: id.citizen, shardKey: id.asset });

/**
 * The generation to sign now: the relay's fresh answer for `asset`, else
 * null (the NFT left this wallet — the page then stops acting for it).
 */
export async function currentGeneration(owner, asset, opts) {
  const r = await loadResidents(owner, opts);
  if (!r.ok) return null;
  const e = r.residents.find(x => x.asset === asset);
  return e && Number.isInteger(e.generation) ? e.generation : null;
}
