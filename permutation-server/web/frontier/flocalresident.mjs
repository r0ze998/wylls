// LOCAL PLAY on the LOCAL TEST CANDIDATE lane only (conquest lane + NFT residents; id [0x4C; 32], version 0xC804;
// NOT an allocation, never deployable): the message of a local command played by an NFT resident's Citizen.
//
// One builder for the page (flocalplay-act.mjs) and the relay (permutation-gateway local-play-act.mjs), so the relay's
// rebuild is the page's bytes. The command is the game's own legacy instruction (Harvest, PlaceHome, Build, Train,
// Muster) run inside ResidentAct (0xE2) for the resident's Citizen, signed by the asset's owner — the local-play wallet,
// which is also the fee payer — for the holder generation it states, with the four proof accounts (policy, link,
// asset, resident record). The proof addresses are always recomputed (fresident.mjs `identityOf`'s rule): the policy
// and the link from the program and the Season, the record from the policy's resident program and the asset.
//
// Nothing here reads the chain, holds a key or decides that the wallet holds the asset: the relay reads the policy,
// the asset (its current Core owner and collection), the record (its generation), the Citizen (its resident mark) and
// the village in ONE read before it sends (local-play-resident.mjs). On the conquest lane this module refuses: a wallet
// Citizen's command is built exactly as before by flocalplay-act.mjs `localActMessage`.
import { decode } from '../sdk/base58.mjs';
import { seasonAddresses } from './faddr.mjs';
import { accountsFor, buildShape } from './fplay.mjs';
import { profileForHash } from '../sdk/frontier/profile.mjs';
import { budgetPrefix } from '../sdk/frontier/budgets.mjs';
import { compileMessage } from '../sdk/solana-tx.mjs';
import { linkAddress, policyAddress, residentAddress, residentBudget, residentCitizen } from '../sdk/frontier/resident.mjs';
import { isCandidateProgram } from './flocallanes.mjs';

/** The local commands an NFT resident's Citizen may send (Join is JoinResident's, not this path's). */
export const LOCAL_RESIDENT_ACT_COMMANDS = Object.freeze(['Harvest', 'PlaceHome', 'Build', 'Train', 'Muster']);
/** The NFT's first login on the local Season (its Citizen is made; the owner — the wallet — signs and pays). */
export const LOCAL_RESIDENT_JOIN = 'JoinResident';
/** The submit schema of a resident's command (the wallet path keeps `frontier-local-play-act-submit-v1`, unchanged). */
export const LOCAL_ACT_SUBMIT_RESIDENT_SCHEMA = 'frontier-local-play-act-submit-resident-v1';
/** The local-play Season id (local-play-relay.mjs `LOCAL_PLAY_SEASON_ID`). */
export const LOCAL_RESIDENT_SEASON_ID = '11';
/** The local-play loaded-data limit (flocalplay-act.mjs / local-play-act.mjs `LOCAL_ACT_LOADED_LIMIT`). */
export const LOCAL_RESIDENT_LOADED_LIMIT = 67108864;

const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const address = s => typeof s === 'string' && B58.test(s) && (() => { try { return decode(s).length === 32; } catch { return false; } })();
const fail = code => { throw Object.assign(new Error(code), { code }); };

/** The four proof addresses of `asset` on the candidate lane, recomputed (never taken from a page or a relay answer). */
export function localResidentProof({ programId, seasonAddress, asset, residentProgram }) {
  if (!isCandidateProgram(programId) || !address(seasonAddress) || !address(asset) || !address(residentProgram)) fail('LocalActResidentUnverified');
  return Object.freeze({ policy: policyAddress(programId), link: linkAddress(programId, seasonAddress, asset), asset, resident: residentAddress(residentProgram, asset) });
}

/** The resident's Citizen address on the candidate lane's local Season (fresident.mjs `identityOf`'s rule). */
export function localResidentCitizen(programId, asset) {
  if (!isCandidateProgram(programId) || !address(asset)) fail('LocalActResidentUnverified');
  return residentCitizen(seasonAddresses(programId, LOCAL_RESIDENT_SEASON_ID), asset);
}

/**
 * The message of `intent` ({name, subject, fields}, already checked by the caller's intent rule) for the resident
 * `{asset, generation, proof}` played by `wallet` (owner, actor and fee payer) on `blockhash`.
 * → the message bytes. Throws for any other lane, command, or a proof that is not the recomputed one.
 */
export function localResidentActMessage(intent, { programId, seasonAddress, wallet, rulesetHash, blockhash, resident }) {
  if (!isCandidateProgram(programId)) fail('LocalActNotAllowed');
  if (!LOCAL_RESIDENT_ACT_COMMANDS.includes(intent?.name) && intent?.name !== LOCAL_RESIDENT_JOIN) fail('LocalActNotAllowed');
  if (!address(wallet) || !address(blockhash) || !resident || !address(resident.asset) || !Number.isInteger(resident.generation) || resident.generation < 0 || resident.generation > 0xffffffff) fail('LocalActInvalid');
  const A = seasonAddresses(programId, LOCAL_RESIDENT_SEASON_ID);
  if (A.season !== seasonAddress) fail('LocalActIdentity');
  const p = resident.proof;
  const want = localResidentProof({ programId, seasonAddress, asset: resident.asset, residentProgram: residentProgramOf(p) });
  if (!p || p.policy !== want.policy || p.link !== want.link || p.asset !== want.asset || p.resident !== want.resident) fail('LocalActResidentUnverified');
  const profile = profileForHash(rulesetHash);
  const citizen = residentCitizen(A, resident.asset);
  if (intent.name === LOCAL_RESIDENT_JOIN) {
    // (fresident.mjs `joinAccounts`: the owner, the Season, the Frontier, the Citizen to make, the four proof accounts)
    const f = intent.fields;
    if (!f || !Number.isInteger(f.faction) || f.faction < 0 || f.faction > 5) fail('LocalActInvalid');
    let joined;
    try { joined = buildShape({ programId, name: LOCAL_RESIDENT_JOIN, accounts: { owner: wallet, season: A.season, frontier: A.of('Frontier'), citizen, policy: want.policy, link: want.link, asset: want.asset, resident: want.resident }, fields: { generation: resident.generation, faction: f.faction }, feePayer: wallet, blockhash, profile }); } catch { fail('LocalActInvalid'); }
    if (joined.signers.length !== 0) fail('LocalActSigner');   // (owner = fee payer = the wallet: one signature)
    const jb = residentBudget(LOCAL_RESIDENT_JOIN, profile);
    const jp = budgetPrefix('Join', { profile, cuLimit: jb.cuLimit, loadedLimit: LOCAL_RESIDENT_LOADED_LIMIT });
    return Uint8Array.from(compileMessage({ feePayer: wallet, recentBlockhash: blockhash, instructions: [...jp, joined.expected] }));
  }
  // (fresident.mjs `actorContext`: the owner acts for the resident's Citizen; the asset keys the join shard)
  const v = { addresses: A, wallet, actor: wallet, citizen, shardKey: resident.asset, profile, ...intent.subject };
  let built;
  try { built = buildShape({ programId, name: intent.name, accounts: accountsFor(intent.name, v), fields: { ...intent.fields }, feePayer: wallet, blockhash, profile, resident: { generation: resident.generation, proof: want } }); } catch { fail('LocalActInvalid'); }
  if (built.signers.length !== 0) fail('LocalActSigner');   // (the wallet — owner and fee payer — is the only signer)
  const b = residentBudget(intent.name, profile);
  const prefix = budgetPrefix(intent.name, { profile, cuLimit: b.cuLimit, loadedLimit: LOCAL_RESIDENT_LOADED_LIMIT });
  return Uint8Array.from(compileMessage({ feePayer: wallet, recentBlockhash: blockhash, instructions: [...prefix, built.expected] }));
}

// The record address names its program only through the derivation: the caller passes the resident program with the
// proof (`proof.residentProgram`), and the record address is recomputed from it here.
function residentProgramOf(p) {
  if (!p || !address(p.residentProgram)) fail('LocalActResidentUnverified');
  return p.residentProgram;
}
