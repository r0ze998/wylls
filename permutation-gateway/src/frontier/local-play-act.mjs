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
import { decodePrefix } from '../../../permutation-server/web/frontier/fcodec.mjs';
import { accountsFor, buildShape, SIGNED_BY } from '../../../permutation-server/web/frontier/fplay.mjs';
import { seasonAddresses } from '../../../permutation-server/web/frontier/faddr.mjs';
import { ringPosition } from '../../../permutation-server/web/frontier/map/wide.mjs';
import { profileForHash } from '../../../permutation-server/web/sdk/frontier/profile.mjs';
import { budgetPrefix } from '../../../permutation-server/web/sdk/frontier/budgets.mjs';
import { compileMessage } from '../../../permutation-server/web/sdk/solana-tx.mjs';

export const LOCAL_ACT_COMMANDS = Object.freeze(['Join', 'PlaceHome', 'Harvest', 'Build', 'Train', 'Muster']);
export const LOCAL_ACT_SUBMIT_SCHEMA = 'frontier-local-play-act-submit-v1';
const ERRORS = Object.freeze({
  LocalActInvalid: [400, 'invalid local-play command request'],
  LocalActNotAllowed: [403, 'this command is not one local play sends'],
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
  // (the relay is stopping: asked before the send — nothing was sent by a submit that answers this)
  LocalActClosed: [503, 'the local-play relay is closing'],
  // (the instance read of the context route: this relay was started without a pinned runner instance)
  LocalActNoInstance: [404, 'this relay has no pinned runner instance to confirm'],
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
  'LocalActBusy', 'LocalActAlreadyJoined', 'LocalActCitizen', 'LocalActHolding', 'LocalActNotYourVillage', 'LocalActRpcUnavailable', 'LocalActClosed']);
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
export function localActIntent(value, { wallet }) {
  check(exact(value, ['name', 'subject', 'fields']) && typeof value.name === 'string');
  check(LOCAL_ACT_COMMANDS.includes(value.name) && Object.hasOwn(SIGNED_BY, value.name), 'LocalActNotAllowed');
  const { name, subject: s, fields: f } = value;
  check(s !== null && typeof s === 'object' && !Array.isArray(s) && f !== null && typeof f === 'object' && !Array.isArray(f));
  if (name === 'Join') {
    check(exact(s, ['faction']) && int(s.faction, 0, 5) && exact(f, ['faction', 'session', 'session_expiry']) && f.faction === s.faction);
    check(address(f.session) && f.session === wallet && typeof f.session_expiry === 'string' && /^[1-9][0-9]{0,18}$/.test(f.session_expiry));
    return Object.freeze({ name, subject: Object.freeze({ faction: s.faction }), fields: Object.freeze({ faction: f.faction, session: f.session, session_expiry: f.session_expiry }) });
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
  if (name === 'Build') { check(exact(f, ['item']) && int(f.item, 0, 7)); return Object.freeze({ name, subject, fields: Object.freeze({ item: f.item }) }); }
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
  const profile = profileForHash(pins.rulesetHash);
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
export function localActSubmit(body, pins) {
  check(exact(body, ['schema', 'name', 'subject', 'fields', 'transaction_b64']) && body.schema === LOCAL_ACT_SUBMIT_SCHEMA
    && typeof body.transaction_b64 === 'string' && body.transaction_b64.length <= 1700);
  const intent = localActIntent({ name: body.name, subject: body.subject, fields: body.fields }, { wallet: pins.wallet });
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
export const LOCAL_ACT_MAX_HISTORY = 256;
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

/** Step 3 above, on the accounts as read: throws the refusal, or returns. `accounts` = `[citizen, holding | undefined]`. */
export function localActAccountsCheck(intent, pins, { citizenAt, holdingAt }, [citizen, holding]) {
  if (intent.name === 'Join') { check(citizen === null, 'LocalActAlreadyJoined'); return; }
  check(citizen !== null && citizen.owner === pins.program, 'LocalActCitizen');
  try { citizenIdentity(citizen.bytes, { seasonId: pins.seasonId, wallet: decode(pins.wallet), address: decode(citizenAt) }); } catch { fail('LocalActCitizen'); }
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
  const h = intent.subject.holding;
  check(String(d.seasonId) === String(pins.seasonId) && d.p === h.p && d.q === h.q && d.site === h.site, 'LocalActHolding');
  const owner = d.ownerCitizen;
  check(owner instanceof Uint8Array && owner.length === 32 && encode(owner) === citizenAt, 'LocalActNotYourVillage');
  void holdingAt;
}

/**
 * The flow over `cfg` (the relay's own closed configuration), `rpc` and, when the runner states one, `runnerInstance`.
 * → `{routes, context(body), submit(body), status(body), stats()}`. Constructing it reads and sends nothing.
 */
// `test` (TEST ONLY — a test entry on the test port range, never the relay's own listener or the launcher, which do
// not pass it): `{rpcOk(url), sendGuard()}`. The RPC must then be the TEST runner's (the test range, and not an
// ordinary one), a runner instance must be pinned, and `sendGuard` is asked as the last thing before the one send:
// when it throws, nothing is sent and the bytes are not consumed. Nothing else about the flow differs.
export function createLocalPlayAct({ cfg, rpc = (m, p) => fetchRpc(cfg.rpc, m, p), runnerInstance = null, test = null }) {
  if (test !== null && (test === undefined || typeof test !== 'object' || typeof test.rpcOk !== 'function' || typeof test.sendGuard !== 'function' || runnerInstance === null)) throw new Error('local-play act refused: bad test form');
  const problems = localPlayRelayConfigProblems(cfg, test === null ? {} : { testRpcOk: test.rpcOk });
  if (problems.length) throw new Error('local-play act refused: ' + problems.join('; '));
  if (runnerInstance !== null && (typeof runnerInstance !== 'string' || !/^[0-9a-f]{64}$/.test(runnerInstance) || /^0{64}$/.test(runnerInstance))) throw new Error('local-play act refused: bad runner instance');
  const pins = Object.freeze({ program: cfg.program, season: cfg.season, seasonId: LOCAL_PLAY_SEASON_ID, wallet: cfg.wallet, rulesetHash: cfg.rulesetHash });
  const A = seasonAddresses(pins.program, String(pins.seasonId));
  const citizenAt = A.of('Citizen', { wallet: pins.wallet });
  // digest → {signature, name}: a submitted message, for good (the record that bars its bytes and that `status` answers from)
  const seen = new Map();
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
      check(!seen.has(digest), 'LocalActMessageUsed'); check(seen.size < LOCAL_ACT_MAX_HISTORY, 'LocalActBusy');
      const { intent } = ok, holdingAt = intent.subject.holding ? A.of('Holding', intent.subject.holding) : null;
      const asked = holdingAt === null ? [citizenAt] : [citizenAt, holdingAt];
      const got = await ask('getMultipleAccounts', [asked, { encoding: 'base64', commitment: 'confirmed' }]);
      open();   // (the listener began to stop while the accounts were read: nothing further, nothing sent, the bytes not consumed)
      const slot = got.result?.context?.slot, rows = got.result?.value;
      if (!Number.isSafeInteger(slot) || slot < 0 || !Array.isArray(rows) || rows.length !== asked.length) fail('LocalActRpcUnavailable');
      localActAccountsCheck(intent, pins, { citizenAt, holdingAt }, [accountOf(rows[0]), holdingAt === null ? undefined : accountOf(rows[1])]);
      // With a pinned runner: the LAST thing asked before the send is the runner's own word on this very signature.
      // The answer must be the pinned instance's (the status context is where the runner states its instance), and the
      // signature must not be known to it yet. Another instance, no instance, or a malformed answer: nothing is sent
      // and the bytes are not consumed. A signature the runner already knows is not sent again.
      if (runnerInstance !== null) {
        const p = await ask('getSignatureStatuses', [[ok.signature], { searchTransactionHistory: true }]);
        open();   // (…or while the runner was asked its last question)
        const ctx = p.result?.context, value = p.result?.value;
        if (!Number.isSafeInteger(ctx?.slot) || ctx.slot < 0 || !Array.isArray(value) || value.length !== 1 || ctx.instance !== runnerInstance) fail('LocalActRpcUnavailable');
        if (value[0] !== null) { seen.set(digest, Object.freeze({ signature: ok.signature, name: intent.name })); fail('LocalActMessageUsed'); }
      }
      // (re-checked after the awaits: a concurrent submit of the same bytes may have taken it. Synchronous from here to the send.)
      check(!seen.has(digest), 'LocalActMessageUsed'); check(seen.size < LOCAL_ACT_MAX_HISTORY, 'LocalActBusy');
      open();   // THE LAST THING BEFORE THE SEND: a relay that is closing sends nothing
      if (test !== null) test.sendGuard();   // (test form: the test run's own end / send latch — throws: nothing sent, bytes not consumed)
      seen.set(digest, Object.freeze({ signature: ok.signature, name: intent.name }));   // before sending: at most once
      let sent;
      try { sent = await rpc('sendTransaction', [body.transaction_b64, { encoding: 'base64', preflightCommitment: 'confirmed' }]); }
      catch { return { status: 'unknown', name: intent.name, signature: ok.signature, status_route: LOCAL_ACT_ROUTES.status }; }   // (the outcome is unknown: asked about by its signature, never sent again)
      if (sent?.error) throw new LocalActError('LocalActSendRefused', { code: sent.error.code, message: String(sent.error.message ?? '').slice(0, 300), signature: ok.signature });
      return { status: sent?.result === ok.signature ? 'submitted' : 'unknown', name: intent.name, signature: ok.signature, status_route: LOCAL_ACT_ROUTES.status };
    },

    async status(body) {
      open();
      check(exact(body, ['schema', 'signature']) && body.schema === LOCAL_ACT_STATUS_SCHEMA && typeof body.signature === 'string');
      check([...seen.values()].some(e => e.signature === body.signature), 'LocalActUnknownSignature');
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
