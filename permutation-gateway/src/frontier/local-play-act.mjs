// LOCAL PLAY — the six economy and mustering commands as page-signed transactions: the VALIDATOR CORE.
// (docs/integration/FABLE-LOCAL-ECONOMY-SIGNED-PATH-PLAN-20261112.md)
//
//   Join, PlaceHome, Harvest, Build, Train, Muster
//
// NOT WIRED: no route, no server and no page calls this yet. It is the part that decides, for a relay, whether a
// signed transaction is exactly the command it is stated to be:
//   - the command is one of the six (a closed list; nothing else, and not the page's general `act`);
//   - the stated intent — the command, its village, its fields — is well formed for that command;
//   - the message, REBUILT here from that intent with the game's own SDK builder and this relay's pins, is the signed
//     message byte for byte (so the signature cannot belong to another command, village, account or amount);
//   - the wallet is fee payer AND actor: exactly one signature, the relay's one wallet's, and it verifies;
//   - a village outside the legacy disk is refused: a wide (acquired) holding is another account family and these
//     legacy commands are never built for it.
// It changes no command, no ABI and no rule: the builder is the one the page already uses.
import { createHash, createPublicKey, verify as edVerify } from 'node:crypto';
import { decode, encode } from '../../client/src/base58.mjs';
import { parseTransaction } from '../../client/src/solana-tx.mjs';
import { localPlayRelayConfigProblems, fetchRpc, LOCAL_PLAY_SEASON_ID } from './local-play-relay.mjs';
import { citizenIdentity } from './conquest-table-read.mjs';
import { localPlayTurnGate } from './local-play-turns.mjs';
import { decodePrefix } from '../../../permutation-server/web/frontier/fcodec.mjs';
import { accountsFor, buildShape, SIGNED_BY } from '../../../permutation-server/web/frontier/fplay.mjs';
import { seasonAddresses } from '../../../permutation-server/web/frontier/faddr.mjs';
import { ringPosition } from '../../../permutation-server/web/frontier/map/wide.mjs';
import { profileForHash } from '../../../permutation-server/web/sdk/frontier/profile.mjs';
import { budgetPrefix } from '../../../permutation-server/web/sdk/frontier/budgets.mjs';
import { compileMessage } from '../../../permutation-server/web/sdk/solana-tx.mjs';
import { WIDE_CLAIM, wideClaimIntent, wideClaimMessage } from '../../../permutation-server/web/frontier/flocalplay-wide.mjs';
import { TERRITORY_CLAIM, territoryClaimIntent, territoryClaimMessage } from '../../../permutation-server/web/frontier/flocalplay-territory.mjs';
import { WIDE_HOST_ACTS, WIDE_BUILT_ACTS, WIDE_ECONOMY_ACTS, wideHostIntent, wideHostMessage } from '../../../permutation-server/web/frontier/flocalplay-wide-host.mjs';
import { worldIdOf } from '../../../permutation-server/web/frontier/map/wide.mjs';
import { COEXIST_ACTS, RIGHTS_ACTS, RIGHTS_WALLET_ONLY, rightsIntent, rightsMessage, grantOfIntent, decodeGrant } from '../../../permutation-server/web/frontier/flocalplay-rights.mjs';
import { COEXIST_LANE } from '../../../permutation-server/web/frontier/flocalplay-lane.mjs';
import { OUTPOST_ACT, outpostIntent, outpostMessage } from '../../../permutation-server/web/frontier/fdevnet-outpost.mjs';
import { RENT_CONTEXT_SCHEMA, clusterRentAnswer } from '../../../permutation-server/web/frontier/frent.mjs';

// (TEST-ONLY wide play, owner t379u: the seventh, the wide claim 0xD9, built by the page's own flocalplay-wide.mjs)
// (and FileTicket, one site: a first village on the rim of a local wide world, where PlaceHome cannot reach)
// (TEST-ONLY wide -> wide marches, Q-W2 owner t385u: a wide village's own Train, Muster and Depart, the page's
//  flocalplay-wide-host.mjs; the program authenticates the wide accounts, this relay the Citizen and the bytes)
// (territory-impl, owner 2026-11-24 12:09: the single-tile claim 0xDA op 7, flocalplay-territory.mjs)
export const LOCAL_ACT_COMMANDS = Object.freeze(['Join', 'PlaceHome', 'Harvest', 'Build', 'Train', 'Muster', 'FileTicket', WIDE_CLAIM, TERRITORY_CLAIM, ...WIDE_HOST_ACTS]);
export const LOCAL_ACT_SUBMIT_SCHEMA = 'frontier-local-play-act-submit-v1';
const ERRORS = Object.freeze({
  LocalActInvalid: [400, 'invalid local-play command request'],
  LocalActNotAllowed: [403, 'this command is not one local play sends'],
  // (verify-pr163: an external resident's relay in a wide world, `--no-wide-orders` — the wide land's orders are not its own)
  LocalActWideOrderRefused: [403, 'the wide land\'s orders are not sent by an external resident'],
  LocalActWideHolding: [409, 'a village outside the legacy disk is not served by these commands'],
  LocalActMessageMismatch: [409, 'the signed message is not the stated command'],
  LocalActSigner: [403, 'the transaction is not signed by this relay\'s wallet alone'],
  // (the relay flow below)
  LocalActAlreadyJoined: [409, 'this wallet already has a Citizen in this Season'],
  LocalActCitizen: [409, 'this wallet\'s Citizen is not there, or is not this wallet\'s'],
  LocalActHolding: [409, 'the village is not there, or is not a village account of this program'],
  LocalActNotYourVillage: [403, 'the village does not belong to this wallet\'s Citizen'],
  LocalActMessageUsed: [409, 'this transaction was already submitted'],
  LocalActBusy: [429, 'too many submitted commands are still unsettled'],
  LocalActRpcUnavailable: [503, 'the local-play runner did not give a usable answer'],
  LocalActUnknownSignature: [404, 'not a signature this relay submitted'],
  LocalActSendRefused: [502, 'the local-play runner refused the transaction'],
  // (2026-11-19, fix-march-held) the runner's send answered that it did NOT take the transaction (its preflight
  //  simulation failed, the blockhash is unknown, the signature does not verify): never in its queue, never run
  LocalActRejected: [422, 'the local-play runner rejected the transaction before running it: it was not sent'],
  // (the relay is stopping: asked before the send — nothing was sent by a submit that answers this)
  LocalActClosed: [503, 'the local-play relay is closing'],
  // (the instance read of the context route: this relay was started without a pinned runner instance)
  LocalActNoInstance: [404, 'this relay has no pinned runner instance to confirm'],
  // (one action per resident per bell, local-play-turns.mjs: only on a relay started with --resident-turns)
  ResidentAlreadyActed: [409, 'this resident already acted in this bell'],
  ResidentTurnUnavailable: [503, 'the resident turn lease cannot be recorded'],
  // (TEST-ONLY, the coexist lane, ② rights: IssueGrant and RevokeGrant are the wallet's own and never delegated — a
  //  resident's relay (--resident-turns: an operator or external AI resident) never sends them)
  LocalActWalletOnly: [403, 'this command is the wallet\'s own and is never sent by a delegated resident'],
  // (…and the Grant read with the Citizen is not one this command may use: absent, another program's or Season's, or
  //  naming another grantee, issuer, facility or Vault)
  LocalActGrant: [409, 'the Grant is not there, or is not one this wallet\'s Citizen may use this way'],
  // (devnet-page-outpost: the devnet flow's FileOutpost names a Province that is not there yet — the program would
  //  refuse it with BadAccount; refused here before any send)
  LocalActProvinceAbsent: [409, 'the target province is not opened yet'],
});
export class LocalActError extends Error {
  constructor(code, detail) { const known = Object.hasOwn(ERRORS, code) ? code : 'LocalActInvalid'; super(ERRORS[known][1]); this.code = known; this.status = ERRORS[known][0]; if (detail !== undefined) this.detail = detail; }
}
/**
 * The refusals `submit` makes BEFORE its one send: nothing has been sent and the bytes are not consumed. The page
 * (flocalplay-act.mjs `LOCAL_ACT_PRESEND_REFUSALS`) treats ONLY these as "not sent"; every other answer keeps the
 * signature. Not among them: `LocalActSendRefused` (the runner's send WAS called) and `LocalActMessageUsed` (the bytes
 * were submitted before, or the runner already knows the signature) — in both the transaction may be on the chain.
 */
export const LOCAL_ACT_PRESEND_REFUSALS = Object.freeze(['LocalActInvalid', 'LocalActNotAllowed', 'LocalActWideHolding', 'LocalActMessageMismatch', 'LocalActSigner',
  'LocalActBusy', 'LocalActAlreadyJoined', 'LocalActCitizen', 'LocalActHolding', 'LocalActNotYourVillage', 'LocalActRpcUnavailable', 'LocalActClosed',
  'ResidentAlreadyActed', 'ResidentTurnUnavailable', 'LocalActWalletOnly', 'LocalActGrant', 'LocalActProvinceAbsent', 'LocalActWideOrderRefused']);

/** (TEST-ONLY) Whether the relay's pins are a coexist world's (flocalplay-lane.mjs COEXIST_LANE): only then are ② rights and the S1 Vault and caravan served. */
export const coexistPins = pins => pins?.rulesetHash === COEXIST_LANE.rulesetHash;

/**
 * (2026-11-19, fix-march-held) The runner's own "not taken" answers to `sendTransaction`: the send WAS called, and the
 * runner said it did not take these bytes. Solana's RPC (and this repo's localnet, server.rs `sendTransaction`)
 * answers
 *   -32002 "Transaction simulation failed: …"   the preflight ran the transaction and it failed (`data.err`, `data.logs`):
 *                                               it is not queued or forwarded — EXCEPT `AlreadyProcessed`, which says
 *                                               the signature IS known (it may land or have landed)
 *   -32003 "Transaction signature verification failure"   never queued
 * Every other answer (another code, AlreadyProcessed, a malformed error) stays "the runner refused the send": the
 * outcome is not known and the signature is kept. → `null`, or `{err, programCode, logs}` for a definite rejection.
 */
export function runnerRejection(error) {
  if (error === null || typeof error !== 'object' || Array.isArray(error)) return null;
  const data = error.data !== null && typeof error.data === 'object' && !Array.isArray(error.data) ? error.data : {};
  const message = String(error.message ?? '');
  if (error.code === -32003 && /signature verification failure/i.test(message)) return Object.freeze({ err: 'SignatureFailure', programCode: null, logs: [] });
  if (error.code !== -32002 || !/^Transaction simulation failed/.test(message)) return null;
  if (data.err === undefined || data.err === null || data.err === 'AlreadyProcessed' || /already been processed/i.test(message)) return null;
  const ie = Array.isArray(data.err?.InstructionError) ? data.err.InstructionError[1] : undefined;
  const custom = Number.isInteger(ie?.Custom) ? ie.Custom : null;
  const logs = Array.isArray(data.logs) ? data.logs.filter(x => typeof x === 'string').slice(-6).map(x => x.slice(0, 200)) : [];
  return Object.freeze({ err: data.err, programCode: custom, logs });
}
/** The detail of a send answer: the runner's code and message, the signature, and — for a rejection — its error and program code. */
export function sendRefusalDetail(error, signature) {
  const r = runnerRejection(error);
  return { code: error?.code, message: String(error?.message ?? '').slice(0, 300), signature, ...(r ? { err: r.err, program_code: r.programCode, logs: r.logs } : {}) };
}
const fail = code => { throw new LocalActError(code); };
const check = (ok, code = 'LocalActInvalid') => { if (!ok) fail(code); };
const exact = (v, keys) => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const int = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
const address = s => { try { return typeof s === 'string' && s.length <= 44 && decode(s).length === 32 && encode(decode(s)) === s; } catch { return false; } };
const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');

/** A legacy village `{p, q, site}`: whole coordinates inside the legacy disk (ring ≤ 128), site 0-11. Outside it: a wide place, refused. */
function village(h) {
  check(exact(h, ['p', 'q', 'site']) && Number.isSafeInteger(h.p) && Number.isSafeInteger(h.q) && int(h.site, 0, 11));
  let ring; try { ring = ringPosition(BigInt(h.p), BigInt(h.q)).ring; } catch { fail('LocalActInvalid'); }
  check(ring <= 128n, 'LocalActWideHolding');
  return Object.freeze({ p: h.p, q: h.q, site: h.site });
}

/**
 * The stated intent, checked and rebuilt (only what a command of that name can carry survives): `{name, subject, fields}`.
 *   Join       subject {faction}            fields {faction, session, session_expiry}   session = the wallet itself (base58); expiry a decimal string
 *   PlaceHome  subject {holding, faction}   fields {p, q, site}                          the fields are the village's own
 *   Harvest    subject {holding}            fields {}
 *   Build      subject {holding}            fields {item}        0-7 (a building, the walls, the promotion)
 *   Train      subject {holding}            fields {unit, n}
 *   Muster     subject {holding}            fields {unit, troops, tile}
 * `wallet`: the relay's one wallet (the Join's session key must be it: no other key is ever registered here).
 */
// (`outpost`: the caller's own flow carries FileOutpost — the devnet wallet-paid flow, devnet-play-act.mjs, never the
//  request's word; every local-play relay refuses it as before: not one local play sends)
// (`wideVillage`: devnet-p17 — the devnet flow carries a wide village's Harvest and Build as well; no local-play relay
//  passes it, so every local play refuses them as before)
export function localActIntent(value, { wallet, coexist = false, outpost = false, wideVillage = false }) {
  check(exact(value, ['name', 'subject', 'fields']) && typeof value.name === 'string');
  if (outpost && value.name === OUTPOST_ACT) {
    try { return outpostIntent(value.subject, value.fields, 'LocalActInvalid'); } catch { fail('LocalActInvalid'); }
  }
  if (wideVillage && WIDE_ECONOMY_ACTS.includes(value.name)) {
    try { return wideHostIntent(value.name, value.subject, value.fields, 'LocalActInvalid'); } catch { fail('LocalActInvalid'); }
  }
  // (TEST-ONLY, the coexist lane only — `coexist` is the relay's own pins, never the request's word: ② rights' six and
  //  the S1 Vault and caravan, flocalplay-rights.mjs. Every other relay refuses them as before: not one local play sends)
  if (coexist && COEXIST_ACTS.includes(value.name)) {
    try { return rightsIntent(value.name, value.subject, value.fields, 'LocalActInvalid'); } catch (e) { fail(e?.code === 'LocalActWideHolding' ? 'LocalActWideHolding' : 'LocalActInvalid'); }
  }
  check(LOCAL_ACT_COMMANDS.includes(value.name) && (value.name === WIDE_CLAIM || value.name === TERRITORY_CLAIM || WIDE_HOST_ACTS.includes(value.name) || Object.hasOwn(SIGNED_BY, value.name)), 'LocalActNotAllowed');
  const { name, subject: s, fields: f } = value;
  check(s !== null && typeof s === 'object' && !Array.isArray(s) && f !== null && typeof f === 'object' && !Array.isArray(f));
  // (the wide claim: its anchor village is a legacy one, its target a wide province within range; flocalplay-wide.mjs)
  if (name === WIDE_CLAIM) {
    try { return wideClaimIntent(s, f, 'LocalActInvalid'); } catch (e) { fail(e?.code === 'LocalActWideHolding' ? 'LocalActWideHolding' : 'LocalActInvalid'); }
  }
  // (the tile claim: its paying first home a legacy village, its target a wide province's tile; flocalplay-territory.mjs)
  if (name === TERRITORY_CLAIM) {
    try { return territoryClaimIntent(s, f, 'LocalActInvalid'); } catch (e) { fail(e?.code === 'LocalActWideHolding' ? 'LocalActWideHolding' : 'LocalActInvalid'); }
  }
  if (WIDE_HOST_ACTS.includes(name)) {
    try { return wideHostIntent(name, s, f, 'LocalActInvalid'); } catch { fail('LocalActInvalid'); }
  }
  if (name === 'Join') {
    check(exact(s, ['faction']) && int(s.faction, 0, 5) && exact(f, ['faction', 'session', 'session_expiry']) && f.faction === s.faction);
    check(address(f.session) && f.session === wallet && typeof f.session_expiry === 'string' && /^[1-9][0-9]{0,18}$/.test(f.session_expiry));
    return Object.freeze({ name, subject: Object.freeze({ faction: s.faction }), fields: Object.freeze({ faction: f.faction, session: f.session, session_expiry: f.session_expiry }) });
  }
  if (name === 'FileTicket') {
    check(exact(s, ['sites']) && Array.isArray(s.sites) && s.sites.length === 1 && exact(f, ['sites']) && Array.isArray(f.sites) && f.sites.length === 1);
    const h = village(s.sites[0]), g = village(f.sites[0]);
    check(h.p === g.p && h.q === g.q && h.site === g.site);
    return Object.freeze({ name, subject: Object.freeze({ sites: Object.freeze([h]) }), fields: Object.freeze({ sites: Object.freeze([h]) }) });
  }
  if (name === 'PlaceHome') {
    check(exact(s, ['holding', 'faction']) && int(s.faction, 0, 5));
    const h = village(s.holding);
    check(exact(f, ['p', 'q', 'site']) && f.p === h.p && f.q === h.q && f.site === h.site);
    return Object.freeze({ name, subject: Object.freeze({ holding: h, faction: s.faction }), fields: Object.freeze({ p: h.p, q: h.q, site: h.site }) });
  }
  check(exact(s, ['holding']));
  const h = village(s.holding), subject = Object.freeze({ holding: h });
  if (name === 'Harvest') { check(exact(f, [])); return Object.freeze({ name, subject, fields: Object.freeze({}) }); }
  // (TEST-ONLY coexist lane: also the S1 workshop, item 8 — ② rights' facility is a workshop village; elsewhere 0-7 as before)
  if (name === 'Build') { check(exact(f, ['item']) && int(f.item, 0, coexist ? 8 : 7)); return Object.freeze({ name, subject, fields: Object.freeze({ item: f.item }) }); }
  // (the ABI's own widths: unit 1 byte; n and troops 4 bytes; tile 1 byte, 0-60 on the province's map)
  if (name === 'Train') { check(exact(f, ['unit', 'n']) && int(f.unit, 0, 255) && int(f.n, 1, 0xffffffff)); return Object.freeze({ name, subject, fields: Object.freeze({ unit: f.unit, n: f.n }) }); }
  check(name === 'Muster' && exact(f, ['unit', 'troops', 'tile']) && int(f.unit, 0, 255) && int(f.troops, 1, 0xffffffff) && int(f.tile, 0, 60));
  return Object.freeze({ name, subject, fields: Object.freeze({ unit: f.unit, troops: f.troops, tile: f.tile }) });
}

/**
 * The message of `intent` (already checked) under the relay's pins `{program, season, seasonId, wallet, rulesetHash}`
 * and `blockhash`: the game's own builder, with the wallet as fee payer AND actor. → `{message, name}`.
 * No other key signs it: a shape that would need one is not this path's.
 */
/** The local-play loaded-data limit (bytes), the same as the page's (flocalplay-act.mjs `LOCAL_ACT_LOADED_LIMIT`). */
export const LOCAL_ACT_LOADED_LIMIT = 67108864;

export function localActMessage(intent, pins, blockhash) {
  const A = seasonAddresses(pins.program, String(pins.seasonId));
  check(A.season === pins.season && address(pins.wallet) && address(blockhash));
  if (intent.name === WIDE_CLAIM) {
    try { return { message: wideClaimMessage(intent, { programId: pins.program, seasonId: pins.seasonId, wallet: pins.wallet, blockhash, loadedLimit: LOCAL_ACT_LOADED_LIMIT }), name: intent.name }; } catch { fail('LocalActInvalid'); }
  }
  if (intent.name === TERRITORY_CLAIM) {
    try { return { message: territoryClaimMessage(intent, { programId: pins.program, seasonId: pins.seasonId, wallet: pins.wallet, blockhash, loadedLimit: LOCAL_ACT_LOADED_LIMIT }), name: intent.name }; } catch { fail('LocalActInvalid'); }
  }
  if (WIDE_BUILT_ACTS.includes(intent.name)) {
    try { return { message: wideHostMessage(intent, { programId: pins.program, seasonId: pins.seasonId, wallet: pins.wallet, world: worldIdOf(A.season, pins.program), blockhash, loadedLimit: LOCAL_ACT_LOADED_LIMIT }), name: intent.name }; } catch { fail('LocalActInvalid'); }
  }
  if (COEXIST_ACTS.includes(intent.name)) {
    check(coexistPins(pins), 'LocalActNotAllowed');
    try { return { message: rightsMessage(intent, { programId: pins.program, seasonId: pins.seasonId, wallet: pins.wallet, blockhash, loadedLimit: LOCAL_ACT_LOADED_LIMIT, profile: profileForHash(pins.rulesetHash) ?? 3 }), name: intent.name }; } catch { fail('LocalActInvalid'); }
  }
  const profile = profileForHash(pins.rulesetHash);
  if (intent.name === OUTPOST_ACT) {
    try { return { message: outpostMessage(intent, { programId: pins.program, seasonId: pins.seasonId, wallet: pins.wallet, blockhash, loadedLimit: LOCAL_ACT_LOADED_LIMIT, profile }), name: intent.name }; } catch { fail('LocalActInvalid'); }
  }
  const v = { addresses: A, wallet: pins.wallet, actor: pins.wallet, profile, ...intent.subject };
  const fields = intent.name === 'Join' ? { faction: intent.fields.faction, session: Uint8Array.from(decode(intent.fields.session)), session_expiry: BigInt(intent.fields.session_expiry) } : { ...intent.fields };
  let built;
  try { built = buildShape({ programId: pins.program, name: intent.name, accounts: accountsFor(intent.name, v), fields, feePayer: pins.wallet, blockhash, profile }); } catch { fail('LocalActInvalid'); }
  check(built.signers.length === 0, 'LocalActSigner');   // (the fee payer — the wallet — is the only signer)
  // (the game's own instruction and budget prefix, with the local loaded-data limit: the page builds the same bytes)
  const prefix = budgetPrefix(intent.name, { profile, loadedLimit: LOCAL_ACT_LOADED_LIMIT });
  return { message: Uint8Array.from(compileMessage({ feePayer: pins.wallet, recentBlockhash: blockhash, instructions: [...prefix, built.expected] })), name: intent.name };
}

/**
 * A submit: `{schema, name, subject, fields, transaction_b64}` → `{intent, message, signature, blockhash}` when the
 * transaction is exactly the stated command, signed once by the relay's wallet. Throws a `LocalActError` otherwise.
 * Nothing is sent here.
 */
// (`schema`: the submit schema of the flow; devnet-play-act.mjs, the devnet wallet-paid flow, states its own)
// (`outpost`: devnet-page-outpost — the devnet flow carries FileOutpost; no local-play relay passes it)
// (`wideVillage`: devnet-p17 — the devnet flow carries a wide village's Harvest and Build; no local-play relay passes it)
export function localActSubmit(body, pins, { schema = LOCAL_ACT_SUBMIT_SCHEMA, outpost = false, wideVillage = false } = {}) {
  check(exact(body, ['schema', 'name', 'subject', 'fields', 'transaction_b64']) && body.schema === schema
    && typeof body.transaction_b64 === 'string' && body.transaction_b64.length <= 1700);
  const intent = localActIntent({ name: body.name, subject: body.subject, fields: body.fields }, { wallet: pins.wallet, coexist: coexistPins(pins), outpost, wideVillage });
  const wire = Buffer.from(body.transaction_b64, 'base64');
  check(wire.toString('base64') === body.transaction_b64 && wire.length <= 1232);
  let tx; try { tx = parseTransaction(wire); } catch { fail('LocalActInvalid'); }
  check(tx.signatures.length === 1 && tx.signers.length === 1 && tx.signers[0] === pins.wallet, 'LocalActSigner');
  const expected = localActMessage(intent, pins, tx.recentBlockhash);
  check(Buffer.from(tx.message).equals(Buffer.from(expected.message)), 'LocalActMessageMismatch');
  const key = createPublicKey({ key: Buffer.concat([SPKI_ED25519, Buffer.from(decode(pins.wallet))]), format: 'der', type: 'spki' });
  check(edVerify(null, tx.message, key, tx.signatures[0]), 'LocalActSigner');
  return Object.freeze({ intent, message: Uint8Array.from(tx.message), signature: encode(tx.signatures[0]), blockhash: tx.recentBlockhash });
}

// ---------------------------------------------------------------------------------------------------------------
// THE RELAY FLOW (still not served by any server: nothing constructs it but tests).
//
//   POST /f/local-play/act/context   {schema}                                  → a blockhash to build on (a read)
//                                    {schema: …-instance-v1}                    → {wallet, instance} (a read; see below)
//                                    {schema: frontier-play-rent-context-v1}    → the runner's rent of one Holding (a read;
//                                                                                 rent-live-rest, web/frontier/frent.mjs)
//   POST /f/local-play/act/submit    {schema, name, subject, fields, transaction_b64}
//   POST /f/local-play/act/status    {schema, signature}
//
// submit, in this order, and nothing is sent unless every step holds:
//   1. `localActSubmit` (above): the closed list, the intent, the rebuilt message, the wallet's one signature;
//   2. the replay barrier: these exact bytes were not submitted before;
//   3. ONE read of the REAL accounts the command acts on, at one slot (`getMultipleAccounts`):
//        Join                      this wallet has NO Citizen yet
//        every other command       this wallet's Citizen is there, the program's, and by its own bytes this wallet's
//        Harvest/Build/Train/Muster  the village's Holding is there, the program's, of the LEGACY family (a wide
//                                  Holding at that address is refused: another family), and its owner is this Citizen
//        PlaceHome                 the place is not a wide Holding (it may be absent: the command makes it)
//      So a village of another family or another owner is refused by what the chain holds, not by what the page says.
//   4. recorded as sent BEFORE the send; ONE `sendTransaction`; never again.
// status is read strictly (a context slot, exactly one entry, a found entry carrying err, slot and a known level) and,
// with a pinned runner instance, only from that instance.
export const LOCAL_ACT_ROUTES = Object.freeze({ context: 'POST /f/local-play/act/context', submit: 'POST /f/local-play/act/submit', status: 'POST /f/local-play/act/status' });
export const LOCAL_ACT_CONTEXT_SCHEMA = 'frontier-local-play-act-context-v1';
// The context route's SECOND, read-only answer (asked for by its own schema; the v1 request and answer are unchanged):
//   {schema: 'frontier-local-play-act-instance-v1'} → {wallet, instance}
// Only with a pinned runner instance, and only when the runner itself states that very instance in this answer:
// ONE `getSignatureStatuses` of NO signature (an empty list: nothing is looked up, nothing is sent), whose `value` must
// be an empty array, its `context.slot` a safe non-negative integer, and its `context.instance` the pinned one. The pin
// alone is never returned as confirmed. No pin: `LocalActNoInstance` (nothing asked). Anything else: unavailable.
export const LOCAL_ACT_INSTANCE_SCHEMA = 'frontier-local-play-act-instance-v1';
export const LOCAL_ACT_STATUS_SCHEMA = 'frontier-local-play-act-status-v1';
export const LOCAL_ACT_WIDE_READ_SCHEMA = 'frontier-local-play-act-wide-read-v1';
export const LOCAL_ACT_WIDE_READ_MAX = 16;
// (owner-answers-logic, owner 2026-11-26 10:52 answer 8 / Q-TG2-1: a storehouse's keeper sees EVERY lot in its own
//  storehouse, also a depositor's whose village there was captured or left) The context route's read-only LOT LIST of one
//  storehouse: {schema, vault: {p, q, tile, gen}} → {schema, context_slot, addresses, more}. A lot's address is
//  `cl‖P,Q,tile,gen,owner_tag,resource` (frontier-abi v2/addr.rs) — it needs the depositor's tag, and the storehouse keeps
//  only a count of its lots (Vault CUSTODY_LOTS), no index — so the lots are found by what they ARE: ONE
//  `getProgramAccounts` of this relay's program, filtered to a Lot (576 B, magic PSF1CLOT) of this relay's season
//  (header SEASON_ID @8) at that storehouse place and generation (P, Q, TILE, VAULT_GEN @64). Only the addresses are
//  answered (dataSlice 0): the page reads them with the wide read above and keeps a lot only when its own bytes derive
//  that very address (flocalplay-custody.mjs listedLots). At most LOCAL_ACT_LOTS_READ_MAX, sorted; `more` says the
//  list was cut. Nothing is kept or sent.
export const LOCAL_ACT_LOTS_READ_SCHEMA = 'frontier-local-play-act-lots-read-v1';
export const LOCAL_ACT_LOTS_READ_MAX = 64;
const LOT_SIZE = 576, LOT_MAGIC = 'PSF1CLOT', LOT_PLACE_AT = 64;
/** The getProgramAccounts filters of the lots of storehouse `vault` in season `seasonId` (pure; exported for tests). */
export function lotListFilters(vault, seasonId) {
  const head = new Uint8Array(16);
  head.set([...LOT_MAGIC].map(c => c.charCodeAt(0)), 0);
  new DataView(head.buffer).setBigUint64(8, BigInt(seasonId), true);
  const place = new Uint8Array(6), dv = new DataView(place.buffer);
  dv.setInt16(0, vault.p, true); dv.setInt16(2, vault.q, true); dv.setUint8(4, vault.tile); dv.setUint8(5, vault.gen);
  return [{ dataSize: LOT_SIZE }, { memcmp: { offset: 0, bytes: Buffer.from(head).toString('base64'), encoding: 'base64' } },
    { memcmp: { offset: LOT_PLACE_AT, bytes: Buffer.from(place).toString('base64'), encoding: 'base64' } }];
}
const lotVault = v => exact(v, ['p', 'q', 'tile', 'gen']) && [v.p, v.q].every(x => Number.isInteger(x) && x >= -32768 && x <= 32767) && Number.isInteger(v.tile) && v.tile >= 0 && v.tile <= 60 && Number.isInteger(v.gen) && v.gen >= 0 && v.gen <= 255;
export const LOCAL_ACT_MAX_HISTORY = 256;
/** Signatures this relay still answers `status` for after their record left the replay barrier (oldest forgotten first). */
export const LOCAL_ACT_MAX_ANSWERED = 8192;
/** At most this many distinct blockhashes are asked about in one retirement pass (one `isBlockhashValid` each). */
export const LOCAL_RETIRE_MAX_ASKS = 64;

/**
 * THE REPLAY BARRIER of a local-play relay (fix-loop5, L5-1). A submitted message's record stays here — its bytes refused
 * again, its signature answerable by `status` — for as long as the chain could still take those bytes: until the
 * runner says its blockhash is no longer valid (`isBlockhashValid` → false; the local runner keeps a blockhash 150
 * slots ≈ 60 s and drops a queued transaction whose blockhash expired). From then on the chain itself refuses the bytes
 * for good, so the record may RETIRE: it leaves the barrier (its signature is kept for `status`, up to `maxAnswered`).
 * `max` therefore bounds the commands that are still UNSETTLED — what the `…Busy` answer says — and no longer every
 * command a world ever sent (loop-play5: a page that had sent 256 acts was refused for the rest of the world, with a
 * text that blamed "today's quota"). Retirement happens only when the barrier is full, needs the runner's answer, and
 * fails closed: no usable answer → nothing retires (the caller answers Busy and nothing is sent).
 * `ask(method, params)` → a JSON-RPC answer (throws on no answer). `instance`: the pinned runner instance, or null.
 */
export function createReplayBarrier({ max, maxAnswered = LOCAL_ACT_MAX_ANSWERED, instance = null }) {
  const live = new Map();       // digest → {signature, blockhash, …}
  const answered = new Map();   // signature → entry, of retired records (insertion order = age)
  let retired = 0;
  const forget = (digest, e) => {
    live.delete(digest);
    answered.set(e.signature, e);
    while (answered.size > maxAnswered) answered.delete(answered.keys().next().value);
    retired++;
  };
  return Object.freeze({
    has: digest => live.has(digest),
    room: () => live.size < max,
    add: (digest, entry) => { live.set(digest, entry); },
    get size() { return live.size; },
    get retired() { return retired; },
    /** The record of a signature this relay submitted (live or retired), or undefined. */
    find(signature) {
      for (const e of live.values()) if (e.signature === signature) return e;
      return answered.get(signature);
    },
    /** One retirement pass (when full): every record whose blockhash the runner says is no longer valid leaves the barrier. */
    async retire(ask) {
      if (live.size < max) return 0;
      const hashes = [...new Set([...live.values()].map(e => e.blockhash).filter(h => typeof h === 'string'))].slice(0, LOCAL_RETIRE_MAX_ASKS);
      let n = 0;
      for (const h of hashes) {
        let v;
        try { v = await ask('isBlockhashValid', [h, { commitment: 'processed' }]); } catch { return n; }
        const ctx = v?.result?.context;
        if (!v || v.error !== undefined || !Number.isSafeInteger(ctx?.slot) || ctx.slot < 0 || typeof v.result?.value !== 'boolean') return n;
        if (instance !== null && ctx.instance !== undefined && ctx.instance !== instance) return n;
        // (verify-pr117: the hashes are asked oldest record first, and a still-valid one ends the pass: records come in
        //  roughly in blockhash order, so the rest are younger. A full relay refused again and again costs the runner
        //  about one ask per refused submit, not up to LOCAL_RETIRE_MAX_ASKS. A record built on an older hash than its
        //  place says retires on a later pass — later, never early: the barrier still fails closed)
        if (v.result.value !== false) break;
        for (const [d, e] of [...live]) if (e.blockhash === h) { forget(d, e); n++; }
      }
      return n;
    },
  });
}
const LEGACY_HOLDING_MAGIC = 'PSF1HOLD', WIDE_HOLDING_MAGIC = 'PSFXWHL1';
const magicOf = bytes => String.fromCharCode(...bytes.subarray(0, 8));
const sha = b => createHash('sha256').update(b).digest('hex');

/** One account of a `getMultipleAccounts` answer: null (absent), or `{owner, bytes}`; anything else is "no usable answer". */
function accountOf(row) {
  if (row === null) return null;
  if (row === undefined || typeof row !== 'object' || typeof row.owner !== 'string' || row.executable === true || !Array.isArray(row.data) || row.data[1] !== 'base64' || typeof row.data[0] !== 'string') fail('LocalActRpcUnavailable');
  const bytes = Buffer.from(row.data[0], 'base64');
  if (bytes.toString('base64') !== row.data[0]) fail('LocalActRpcUnavailable');
  return { owner: row.owner, bytes: new Uint8Array(bytes) };
}

/** (the same reading, for the devnet wallet-paid flow, devnet-play-act.mjs) */
export const localActAccountOf = row => accountOf(row);

/** Step 3 above, on the accounts as read: throws the refusal, or returns. `accounts` = `[citizen, holding | undefined]`. */
export function localActAccountsCheck(intent, pins, { citizenAt, holdingAt }, [citizen, holding]) {
  if (intent.name === 'Join') { check(citizen === null, 'LocalActAlreadyJoined'); return; }
  check(citizen !== null && citizen.owner === pins.program, 'LocalActCitizen');
  try { citizenIdentity(citizen.bytes, { seasonId: pins.seasonId, wallet: decode(pins.wallet), address: decode(citizenAt) }); } catch { fail('LocalActCitizen'); }
  // (a village request names no village of its own yet: the Citizen above is the whole check; the program checks the sites)
  if (intent.name === 'FileTicket') return;
  // (a wide village's own act: the Citizen above is this relay's check; the program authenticates the wide holding,
  //  its owner and its provinces — a legacy Holding cannot stand at a wide address)
  if (WIDE_BUILT_ACTS.includes(intent.name)) return;
  // (TEST-ONLY, the coexist lane: a use of a Grant is checked against the Grant itself, `localActGrantCheck`; a caravan
  //  names places the program authenticates — the Citizen above is this relay's check)
  if (COEXIST_ACTS.includes(intent.name) && intent.name !== 'IssueGrant' && intent.name !== 'BuildVault') return;
  if (intent.name === 'PlaceHome') {
    // (the command makes or claims the village: it may be absent; what must not be there is another family's account)
    if (holding !== null) { check(holding.owner === pins.program, 'LocalActHolding'); check(magicOf(holding.bytes) !== WIDE_HOLDING_MAGIC, 'LocalActWideHolding'); }
    return;
  }
  check(holding !== null && holding.owner === pins.program, 'LocalActHolding');
  const magic = magicOf(holding.bytes);
  check(magic !== WIDE_HOLDING_MAGIC, 'LocalActWideHolding'); check(magic === LEGACY_HOLDING_MAGIC, 'LocalActHolding');
  // (the game's own account decoder: the account must itself say it is THIS village — this Season, these coordinates,
  //  this site — and not merely sit at the address; then whose it is)
  let d; try { d = decodePrefix('Holding', holding.bytes, { profile: profileForHash(pins.rulesetHash) }); } catch { fail('LocalActHolding'); }
  // (IssueGrant: the facility is the village checked — the issuer's own)
  const h = intent.name === 'IssueGrant' ? intent.subject.facility : intent.subject.holding;
  check(String(d.seasonId) === String(pins.seasonId) && d.p === h.p && d.q === h.q && d.site === h.site, 'LocalActHolding');
  const owner = d.ownerCitizen;
  check(owner instanceof Uint8Array && owner.length === 32 && encode(owner) === citizenAt, 'LocalActNotYourVillage');
  // (devnet-page-outpost: FileOutpost's subject holding is its ANCHOR — this Citizen's first home, of the generation its key names)
  if (intent.name === OUTPOST_ACT) check(Number(d.gen) === intent.subject.gen && Number(d.order) === 1, 'LocalActHolding');
  void holdingAt;
}

/**
 * (TEST-ONLY, the coexist lane) The Grant a rights command names, as read in the same `getMultipleAccounts` as the
 * Citizen: IssueGrant — no account at the new Grant's address; every other — the program's Grant of this Season at
 * its address, and by its own bytes one this Citizen may use this way (ReserveSwap/ExecuteSwap/ReleaseSwap: its
 * grantee, with the facility and Vault the command names; RevokeGrant: its issuer, the same places; CloseGrant: its
 * issuer, and the rent goes back to this wallet). The program checks it all again; this refuses before any send.
 */
export function localActGrantCheck(intent, pins, { citizenAt }, grant) {
  if (!RIGHTS_ACTS.includes(intent.name)) return;
  if (intent.name === 'IssueGrant') { check(grant === null, 'LocalActGrant'); return; }
  check(grant !== null && grant.owner === pins.program, 'LocalActGrant');
  const g = decodeGrant(grant.bytes);
  check(g !== null && g.seasonId === String(pins.seasonId), 'LocalActGrant');
  const s = intent.subject;
  check(g.issuerTag === s.grant.issuer_tag && g.nonce === s.grant.nonce, 'LocalActGrant');
  if (intent.name === 'CloseGrant') { check(g.issuerCitizen === citizenAt && g.rentTo === pins.wallet, 'LocalActGrant'); return; }
  const A = seasonAddresses(pins.program, String(pins.seasonId));
  check(g.facility === A.of('Holding', s.facility) && g.station === A.of('Vault', s.station) && g.p === s.facility.p && g.q === s.facility.q, 'LocalActGrant');
  check(intent.name === 'RevokeGrant' ? g.issuerCitizen === citizenAt : g.granteeCitizen === citizenAt, 'LocalActGrant');
}

/**
 * The flow over `cfg` (the relay's own closed configuration), `rpc` and, when the runner states one, `runnerInstance`.
 * → `{routes, context(body), submit(body), status(body), stats()}`. Constructing it reads and sends nothing.
 */
// `test` (TEST ONLY — a test entry on the test port range, never the relay's own listener or the launcher, which do
// not pass it): `{rpcOk(url), sendGuard()}`. The RPC must then be the TEST runner's (the test range, and not an
// ordinary one), a runner instance must be pinned, and `sendGuard` is asked as the last thing before the one send:
// when it throws, nothing is sent and the bytes are not consumed. Nothing else about the flow differs.
// `turns` (resident-turns.mjs, from `--resident-turns`): one action per bell for this wallet's Citizen; Join is none.
// `noWideOrders` (verify-pr163, `--no-wide-orders`, with `turns` only): an external resident's relay in a wide world —
// the wide claim 0xD9 and a wide village's Train/Muster/Depart are refused before anything is read.
export function createLocalPlayAct({ cfg, rpc = (m, p) => fetchRpc(cfg.rpc, m, p), runnerInstance = null, test = null, turns = null, noWideOrders = false }) {
  if (noWideOrders !== false && (noWideOrders !== true || turns === null)) throw new Error('local-play act refused: --no-wide-orders is a resident relay\'s only');
  if (test !== null && (test === undefined || typeof test !== 'object' || typeof test.rpcOk !== 'function' || typeof test.sendGuard !== 'function' || runnerInstance === null)) throw new Error('local-play act refused: bad test form');
  const problems = localPlayRelayConfigProblems(cfg, test === null ? {} : { testRpcOk: test.rpcOk });
  if (problems.length) throw new Error('local-play act refused: ' + problems.join('; '));
  if (runnerInstance !== null && (typeof runnerInstance !== 'string' || !/^[0-9a-f]{64}$/.test(runnerInstance) || /^0{64}$/.test(runnerInstance))) throw new Error('local-play act refused: bad runner instance');
  const pins = Object.freeze({ program: cfg.program, season: cfg.season, seasonId: LOCAL_PLAY_SEASON_ID, wallet: cfg.wallet, rulesetHash: cfg.rulesetHash });
  const A = seasonAddresses(pins.program, String(pins.seasonId));
  const citizenAt = A.of('Citizen', { wallet: pins.wallet });
  const gate = localPlayTurnGate({ turns, cfg, citizen: citizenAt });
  // digest → {signature, name, blockhash}: a submitted message (the record that bars its bytes and that `status` answers
  // from), until its blockhash is no longer valid on the runner (createReplayBarrier above: then the chain bars the bytes)
  const seen = createReplayBarrier({ max: LOCAL_ACT_MAX_HISTORY, instance: runnerInstance });
  // CLOSED (`close()`, called when the listener begins to stop): a latch. From then on nothing is read and nothing is
  // sent — also by a submit that was already inside one of its awaits when the close came: it is asked on entry, after
  // every await, and as the last thing before the send. A transaction that WAS sent before the close keeps its record.
  let closed = false;
  const open = () => { if (closed) fail('LocalActClosed'); };
  const ask = async (method, params) => { let r; try { r = await rpc(method, params); } catch { fail('LocalActRpcUnavailable'); } if (!r || r.error !== undefined) fail('LocalActRpcUnavailable'); return r; };
  return Object.freeze({
    routes: LOCAL_ACT_ROUTES,

    /** A recent blockhash to build the message on. A read: nothing is kept. */
    async context(body) {
      open();
      if (exact(body, ['schema']) && body.schema === LOCAL_ACT_INSTANCE_SCHEMA) {
        // (the read-only instance answer above: the runner's own word, never the pin by itself)
        if (runnerInstance === null) fail('LocalActNoInstance');
        const p = await ask('getSignatureStatuses', [[]]);
        open();
        const ctx = p.result?.context, value = p.result?.value;
        if (!Number.isSafeInteger(ctx?.slot) || ctx.slot < 0 || !Array.isArray(value) || value.length !== 0 || ctx.instance !== runnerInstance) fail('LocalActRpcUnavailable');
        return { wallet: pins.wallet, instance: runnerInstance };
      }
      // (TEST-ONLY wide -> wide marches: the READ-ONLY account read of a wide village's host — its holding, its
      //  provinces and rosters — for the page and the AI residents to see their wide hosts and the keeps. At most
      //  LOCAL_ACT_WIDE_READ_MAX addresses; an account another program owns is answered as absent. Nothing is sent)
      if (exact(body, ['schema', 'addresses']) && body.schema === LOCAL_ACT_WIDE_READ_SCHEMA) {
        check(Array.isArray(body.addresses) && body.addresses.length >= 1 && body.addresses.length <= LOCAL_ACT_WIDE_READ_MAX && body.addresses.every(address));
        const got = await ask('getMultipleAccounts', [body.addresses, { encoding: 'base64', commitment: 'confirmed' }]);
        open();
        const slot = got.result?.context?.slot, rows = got.result?.value;
        if (!Number.isSafeInteger(slot) || slot < 0 || !Array.isArray(rows) || rows.length !== body.addresses.length) fail('LocalActRpcUnavailable');
        return { schema: LOCAL_ACT_WIDE_READ_SCHEMA, context_slot: String(slot),
          accounts: rows.map(row => { const a = accountOf(row); return a !== null && a.owner === pins.program ? { data_b64: Buffer.from(a.bytes).toString('base64') } : null; }) };
      }
      // (owner-answers-logic: the read-only lot list of one storehouse — LOCAL_ACT_LOTS_READ_SCHEMA above)
      if (exact(body, ['schema', 'vault']) && body.schema === LOCAL_ACT_LOTS_READ_SCHEMA) {
        check(lotVault(body.vault));
        const got = await ask('getProgramAccounts', [pins.program, { encoding: 'base64', commitment: 'confirmed', withContext: true, dataSlice: { offset: 0, length: 0 }, filters: lotListFilters(body.vault, pins.seasonId) }]);
        open();
        const slot = got.result?.context?.slot, rows = got.result?.value;
        if (!Number.isSafeInteger(slot) || slot < 0 || !Array.isArray(rows)) fail('LocalActRpcUnavailable');
        const found = [...new Set(rows.filter(x => address(x?.pubkey) && x?.account?.owner === pins.program).map(x => x.pubkey))].sort();
        return { schema: LOCAL_ACT_LOTS_READ_SCHEMA, context_slot: String(slot), addresses: found.slice(0, LOCAL_ACT_LOTS_READ_MAX), more: found.length > LOCAL_ACT_LOTS_READ_MAX };
      }
      // (rent-live-rest: the runner's rent of one Holding — the village ticket's escrow — for the page's preview; one
      //  getMinimumBalanceForRentExemption, nothing kept or sent: web/frontier/frent.mjs)
      if (exact(body, ['schema']) && body.schema === RENT_CONTEXT_SCHEMA) {
        const out = await clusterRentAnswer(ask, () => fail('LocalActRpcUnavailable'));
        open();
        return out;
      }
      check(exact(body, ['schema']) && body.schema === LOCAL_ACT_CONTEXT_SCHEMA);
      const r = await ask('getLatestBlockhash', [{ commitment: 'confirmed' }]);
      open();
      const v = r.result?.value, slot = r.result?.context?.slot;
      if (!address(v?.blockhash) || !Number.isSafeInteger(v.lastValidBlockHeight) || v.lastValidBlockHeight < 0 || !Number.isSafeInteger(slot) || slot < 0) fail('LocalActRpcUnavailable');
      return { wallet: pins.wallet, blockhash: { hash: v.blockhash, last_valid_block_height: String(v.lastValidBlockHeight), context_slot: String(slot) } };
    },

    async submit(body) {
      open();
      const ok = localActSubmit(body, pins), digest = sha(ok.message);
      // (TEST-ONLY, the coexist lane: the wallet's own Grant commands are never sent by a resident's relay — refused
      //  before anything is read, the history retirement below included)
      if (turns !== null && RIGHTS_WALLET_ONLY.includes(ok.intent.name)) fail('LocalActWalletOnly');
      // (verify-pr163: the wide land's orders are not an external resident's — refused before anything is read)
      if (noWideOrders && (ok.intent.name === WIDE_CLAIM || ok.intent.name === TERRITORY_CLAIM || WIDE_HOST_ACTS.includes(ok.intent.name))) fail('LocalActWideOrderRefused');
      check(!seen.has(digest), 'LocalActMessageUsed');
      if (!seen.room()) { await seen.retire(ask); open(); }
      check(seen.room(), 'LocalActBusy');
      const { intent } = ok, holdingAt = intent.subject.holding ? A.of('Holding', intent.subject.holding) : intent.name === 'IssueGrant' ? A.of('Holding', intent.subject.facility) : null;
      const grantAt = RIGHTS_ACTS.includes(intent.name) ? grantOfIntent(intent, { programId: pins.program, seasonId: pins.seasonId, wallet: pins.wallet }) : null;
      const asked = [citizenAt, ...(holdingAt === null ? [] : [holdingAt]), ...(grantAt === null ? [] : [grantAt])];
      const got = await ask('getMultipleAccounts', [asked, { encoding: 'base64', commitment: 'confirmed' }]);
      open();   // (the listener began to stop while the accounts were read: nothing further, nothing sent, the bytes not consumed)
      const slot = got.result?.context?.slot, rows = got.result?.value;
      if (!Number.isSafeInteger(slot) || slot < 0 || !Array.isArray(rows) || rows.length !== asked.length) fail('LocalActRpcUnavailable');
      localActAccountsCheck(intent, pins, { citizenAt, holdingAt }, [accountOf(rows[0]), holdingAt === null ? undefined : accountOf(rows[1])]);
      if (grantAt !== null) localActGrantCheck(intent, pins, { citizenAt }, accountOf(rows[rows.length - 1]));
      // With a pinned runner: the LAST thing asked before the send is the runner's own word on this very signature.
      // The answer must be the pinned instance's (the status context is where the runner states its instance), and the
      // signature must not be known to it yet. Another instance, no instance, or a malformed answer: nothing is sent
      // and the bytes are not consumed. A signature the runner already knows is not sent again.
      if (runnerInstance !== null) {
        const p = await ask('getSignatureStatuses', [[ok.signature], { searchTransactionHistory: true }]);
        open();   // (…or while the runner was asked its last question)
        const ctx = p.result?.context, value = p.result?.value;
        if (!Number.isSafeInteger(ctx?.slot) || ctx.slot < 0 || !Array.isArray(value) || value.length !== 1 || ctx.instance !== runnerInstance) fail('LocalActRpcUnavailable');
        if (value[0] !== null) { seen.add(digest, Object.freeze({ signature: ok.signature, name: intent.name, blockhash: ok.blockhash })); fail('LocalActMessageUsed'); }
      }
      // A resident's relay: the chain's bell, read last (one read of the Season and the Clock at one slot).
      const turnBell = gate !== null && intent.name !== 'Join' ? await gate.bell(ask, () => fail('LocalActRpcUnavailable')) : null;
      open();
      // (re-checked after the awaits: a concurrent submit of the same bytes may have taken it. Synchronous from here to the send.)
      check(!seen.has(digest), 'LocalActMessageUsed'); check(seen.room(), 'LocalActBusy');
      open();   // THE LAST THING BEFORE THE SEND: a relay that is closing sends nothing
      if (test !== null) test.sendGuard();   // (test form: the test run's own end / send latch — throws: nothing sent, bytes not consumed)
      // One action per resident per bell: claimed synchronously, the first writer of the bell wins; a refusal here is
      // before the send (nothing sent, the bytes not consumed). From the claim to the send nothing can refuse.
      const ticket = gate !== null && intent.name !== 'Join' ? gate.claim(turnBell, 'local-play', (code, detail) => { throw new LocalActError(code, detail); }) : null;
      seen.add(digest, Object.freeze({ signature: ok.signature, name: intent.name, blockhash: ok.blockhash }));   // before sending: at most once
      ticket?.sent(ok.signature);
      let sent;
      try { sent = await rpc('sendTransaction', [body.transaction_b64, { encoding: 'base64', preflightCommitment: 'confirmed' }]); }
      catch { return { status: 'unknown', name: intent.name, signature: ok.signature, status_route: LOCAL_ACT_ROUTES.status }; }   // (the outcome is unknown: asked about by its signature, never sent again)
      // (a definite rejection — the runner did not take the bytes — is said as that: the page may say "not sent";
      //  anything else stays "refused, outcome unknown" and keeps the signature)
      if (sent?.error) throw new LocalActError(runnerRejection(sent.error) ? 'LocalActRejected' : 'LocalActSendRefused', sendRefusalDetail(sent.error, ok.signature));
      return { status: sent?.result === ok.signature ? 'submitted' : 'unknown', name: intent.name, signature: ok.signature, status_route: LOCAL_ACT_ROUTES.status };
    },

    async status(body) {
      open();
      check(exact(body, ['schema', 'signature']) && body.schema === LOCAL_ACT_STATUS_SCHEMA && typeof body.signature === 'string');
      check(seen.find(body.signature) !== undefined, 'LocalActUnknownSignature');
      const r = await ask('getSignatureStatuses', [[body.signature], { searchTransactionHistory: true }]);
      const ctx = r.result?.context, value = r.result?.value, slot = ctx?.slot;
      if (!Number.isSafeInteger(slot) || slot < 0 || !Array.isArray(value) || value.length !== 1) fail('LocalActRpcUnavailable');
      if (runnerInstance !== null && ctx.instance !== runnerInstance) fail('LocalActRpcUnavailable');
      const s = value[0];
      if (s === null) return { signature: body.signature, status: 'pending', context_slot: slot };
      if (typeof s !== 'object' || Array.isArray(s) || !Object.hasOwn(s, 'err') || !Object.hasOwn(s, 'slot') || !Object.hasOwn(s, 'confirmationStatus')
          || !Number.isSafeInteger(s.slot) || s.slot < 0 || s.slot > slot || !['processed', 'confirmed', 'finalized'].includes(s.confirmationStatus)
          || !(s.err === null || typeof s.err === 'string' || (typeof s.err === 'object' && !Array.isArray(s.err)))) fail('LocalActRpcUnavailable');
      return { signature: body.signature, status: s.err !== null ? 'failed' : s.confirmationStatus, err: s.err, slot: s.slot, context_slot: slot };
    },

    /** Counts only. */
    stats() { return { history: seen.size }; },
    /** The listener is stopping: latch. Nothing is read or sent after this; what was sent keeps its record (never "not sent"). */
    close() { closed = true; },
    closed: () => closed,
  });
}
