// LOCAL PLAY — the game's ORDINARY march (legacy Depart 0x50) as a page-signed transaction: the relay's VALIDATOR and
// flow, apart from the six economy commands (local-play-act.mjs, unchanged).
//
// The march is the game's own: the page's builder (`fplay.mjs` accountsFor/buildShape, the same Depart the ordinary page
// sends) and its own time-lock seal (seal.mjs). What differs in local play is only who signs and how it is sent:
//   - the page's memory-only wallet is fee payer AND actor (a real Join stores session = wallet, and the program accepts
//     the wallet itself as actor: prologue.rs player_prologue), so no in-game session key exists or is made;
//   - the relay REBUILDS the message from the stated intent with the same builder and these pins, and requires it byte for
//     byte, with exactly one signature, the relay's one wallet's, which verifies;
//   - the seal is opaque here (a drand time-lock to the arrival turn's round): its shape is checked (165 bytes, the
//     compressed-point flag the program checks, `seal_flag_ok`), and the relay returns `ct_hash` and `seal_root` so the
//     page compares them with its own book entry. The program binds commit and seal (seal_root) and the later Reveal
//     checks the commit (CommitMismatch); nothing here claims to verify the plaintext or the route;
//   - ONE read of the real accounts, then recorded as sent BEFORE ONE send, never again; an unknown outcome is asked
//     about by its signature only.
// It changes no instruction, ABI or rule. Reveal is not built here: the march is revealed after its arrival round by the
// world's keeper from the public round (the seal is a time-lock to it), never by this relay and never from the page's
// secret material.
import { createHash, createPublicKey, verify as edVerify } from 'node:crypto';
import { decode, encode } from '../../client/src/base58.mjs';
import { parseTransaction } from '../../client/src/solana-tx.mjs';
import { localPlayRelayConfigProblems, fetchRpc, LOCAL_PLAY_SEASON_ID } from './local-play-relay.mjs';
import { localActAccountsCheck, LOCAL_ACT_LOADED_LIMIT } from './local-play-act.mjs';
import { decodePrefix } from '../../../permutation-server/web/frontier/fcodec.mjs';
import { accountsFor, buildShape } from '../../../permutation-server/web/frontier/fplay.mjs';
import { seasonAddresses, hostParts } from '../../../permutation-server/web/frontier/faddr.mjs';
import { ringPosition } from '../../../permutation-server/web/frontier/map/wide.mjs';
import { profileForHash } from '../../../permutation-server/web/sdk/frontier/profile.mjs';
import { budgetPrefix } from '../../../permutation-server/web/sdk/frontier/budgets.mjs';
import { compileMessage } from '../../../permutation-server/web/sdk/solana-tx.mjs';

export const LOCAL_MARCH_COMMANDS = Object.freeze(['Depart']);
export const LOCAL_MARCH_SUBMIT_SCHEMA = 'frontier-local-play-march-submit-v1';
export const LOCAL_MARCH_STATUS_SCHEMA = 'frontier-local-play-march-status-v1';
export const LOCAL_MARCH_CAPABILITY_SCHEMA = 'frontier-local-play-march-capability-v1';
export const LOCAL_MARCH_ROUTES = Object.freeze({ capability: 'POST /f/local-play/march/capability', submit: 'POST /f/local-play/march/submit', status: 'POST /f/local-play/march/status' });
export const LOCAL_MARCH_MAX_HISTORY = 64;
export const SEAL_LEN = 165, COMMIT_LEN = 32, TRANSIT_SLOTS = 4;
const ERRORS = Object.freeze({
  LocalMarchInvalid: [400, 'the march is not well formed'],
  LocalMarchNotAllowed: [403, 'only the ordinary Depart is served here'],
  LocalMarchWideHolding: [403, 'a wide village or province: not the ordinary march'],
  LocalMarchNotYourHost: [403, 'the host is not this village\'s'],
  LocalMarchSeal: [400, 'the seal is not a compressed point of the right length'],
  LocalMarchMessageMismatch: [400, 'the signed message is not the stated march'],
  LocalMarchSigner: [403, 'the wallet must be the only signer, as fee payer and actor'],
  LocalMarchCitizen: [403, 'this wallet has no Citizen of this Season'],
  LocalMarchHolding: [403, 'the village is not this wallet\'s legacy village'],
  LocalMarchProvince: [403, 'the origin province is not the program\'s province at those coordinates'],
  LocalMarchMessageUsed: [409, 'these bytes were sent already; they are only asked about'],
  LocalMarchBusy: [429, 'too many marches in this world'],
  LocalMarchRpcUnavailable: [503, 'the runner did not answer usably'],
  LocalMarchClosed: [503, 'the relay is stopping'],
  LocalMarchSendRefused: [502, 'the runner refused the send'],
  LocalMarchUnknownSignature: [404, 'not a march sent through this relay'],
  LocalMarchNoInstance: [404, 'this relay has no pinned runner instance: no march capability'],
});
export class LocalMarchError extends Error {
  constructor(code, detail = undefined) { super(ERRORS[code]?.[1] ?? code); this.code = code; this.status = ERRORS[code]?.[0] ?? 400; if (detail !== undefined) this.detail = detail; }
}
/** Refusals made BEFORE the send: the page may say "not sent" for these only. */
export const LOCAL_MARCH_PRESEND_REFUSALS = Object.freeze(['LocalMarchInvalid', 'LocalMarchNotAllowed', 'LocalMarchWideHolding', 'LocalMarchNotYourHost', 'LocalMarchSeal',
  'LocalMarchMessageMismatch', 'LocalMarchSigner', 'LocalMarchCitizen', 'LocalMarchHolding', 'LocalMarchProvince', 'LocalMarchBusy', 'LocalMarchRpcUnavailable', 'LocalMarchClosed']);
const fail = (code, detail) => { throw new LocalMarchError(code, detail); };
const check = (ok, code = 'LocalMarchInvalid') => { if (!ok) fail(code); };
const exact = (v, keys) => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const int = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
const address = s => { try { return typeof s === 'string' && s.length <= 44 && decode(s).length === 32 && encode(decode(s)) === s; } catch { return false; } };
const hexOf = (s, n) => typeof s === 'string' && s.length === 2 * n && /^[0-9a-f]+$/.test(s);
const u64Text = s => typeof s === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(s) && BigInt(s) <= 0xffffffffffffffffn;
const sha = b => createHash('sha256').update(b).digest();
const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');
/** The program's own syntax check of a compressed G2 point's first byte (host.rs `seal_flag_ok`). */
export const sealFlagOk = b0 => (b0 & 0x80) !== 0 && (b0 & 0x40) === 0;
const legacy = (p, q) => { let ring; try { ring = ringPosition(BigInt(p), BigInt(q)).ring; } catch { fail('LocalMarchInvalid'); } check(ring <= 128n, 'LocalMarchWideHolding'); };

/**
 * The stated march, checked and rebuilt (only what a Depart can carry survives):
 *   subject {holding: {p, q, site}, province: {p, q}}   the village whose host departs, and the province it stands in
 *   fields  {host_id, commit, seal, arrive_bell, tip, transit_slot}
 *           host_id and tip decimal strings (u64); commit 32 bytes and seal 165 bytes as lowercase hex; arrive_bell a
 *           whole turn; transit_slot 0-3
 * The host id must name THIS village (its province, site; hostParts) — the program checks the rest (resident, window, slot).
 */
export function localMarchIntent(value) {
  check(exact(value, ['name', 'subject', 'fields']) && typeof value.name === 'string');
  check(LOCAL_MARCH_COMMANDS.includes(value.name), 'LocalMarchNotAllowed');
  const { subject: s, fields: f } = value;
  check(exact(s, ['holding', 'province']) && exact(s.holding, ['p', 'q', 'site']) && exact(s.province, ['p', 'q']));
  const h = s.holding, pv = s.province;
  check(Number.isSafeInteger(h.p) && Number.isSafeInteger(h.q) && int(h.site, 0, 11) && Number.isSafeInteger(pv.p) && Number.isSafeInteger(pv.q));
  legacy(h.p, h.q); legacy(pv.p, pv.q);
  check(exact(f, ['host_id', 'commit', 'seal', 'arrive_bell', 'tip', 'transit_slot']));
  check(u64Text(f.host_id) && u64Text(f.tip) && int(f.arrive_bell, 1, 0xffffffff) && int(f.transit_slot, 0, TRANSIT_SLOTS - 1));
  const parts = hostParts(BigInt(f.host_id));
  check(!!parts && parts.p === h.p && parts.q === h.q && parts.site === h.site, 'LocalMarchNotYourHost');
  check(hexOf(f.commit, COMMIT_LEN) && !/^0+$/.test(f.commit));
  check(hexOf(f.seal, SEAL_LEN), 'LocalMarchSeal');
  check(sealFlagOk(parseInt(f.seal.slice(0, 2), 16)), 'LocalMarchSeal');
  return Object.freeze({ name: 'Depart', subject: Object.freeze({ holding: Object.freeze({ p: h.p, q: h.q, site: h.site }), province: Object.freeze({ p: pv.p, q: pv.q }) }),
    fields: Object.freeze({ host_id: f.host_id, commit: f.commit, seal: f.seal, arrive_bell: f.arrive_bell, tip: f.tip, transit_slot: f.transit_slot }) });
}

/** The commitments the program records (host.rs: seal_root = sha256(commit ‖ sha256(seal))), as lowercase hex. */
export function sealBinding(intent) {
  const seal = Buffer.from(intent.fields.seal, 'hex'), commit = Buffer.from(intent.fields.commit, 'hex');
  const ct = sha(seal);
  return { ct_hash: ct.toString('hex'), seal_root: sha(Buffer.concat([commit, ct])).toString('hex') };
}

/**
 * The message of a checked intent under the pins `{program, season, seasonId, wallet, rulesetHash}` and `blockhash`: the
 * page's own Depart with the wallet as fee payer AND actor, the game's budget prefix with the local loaded-data limit.
 */
export function localMarchMessage(intent, pins, blockhash) {
  const A = seasonAddresses(pins.program, String(pins.seasonId));
  check(A.season === pins.season && address(pins.wallet) && address(blockhash));
  const profile = profileForHash(pins.rulesetHash);
  const v = { addresses: A, wallet: pins.wallet, actor: pins.wallet, profile, holding: intent.subject.holding, province: intent.subject.province };
  const f = intent.fields;
  const fields = { host_id: BigInt(f.host_id), commit: Uint8Array.from(Buffer.from(f.commit, 'hex')), seal: Uint8Array.from(Buffer.from(f.seal, 'hex')),
    arrive_bell: f.arrive_bell, tip: BigInt(f.tip), transit_slot: f.transit_slot };
  let built;
  try { built = buildShape({ programId: pins.program, name: 'Depart', accounts: accountsFor('Depart', v), fields, feePayer: pins.wallet, blockhash, profile }); } catch { fail('LocalMarchInvalid'); }
  check(built.signers.length === 0, 'LocalMarchSigner');
  const prefix = budgetPrefix('Depart', { profile, loadedLimit: LOCAL_ACT_LOADED_LIMIT });
  return Uint8Array.from(compileMessage({ feePayer: pins.wallet, recentBlockhash: blockhash, instructions: [...prefix, built.expected] }));
}

/** A submit `{schema, name, subject, fields, transaction_b64}` → `{intent, message, signature}`; throws otherwise. Sends nothing. */
export function localMarchSubmit(body, pins) {
  check(exact(body, ['schema', 'name', 'subject', 'fields', 'transaction_b64']) && body.schema === LOCAL_MARCH_SUBMIT_SCHEMA
    && typeof body.transaction_b64 === 'string' && body.transaction_b64.length <= 1700);
  const intent = localMarchIntent({ name: body.name, subject: body.subject, fields: body.fields });
  const wire = Buffer.from(body.transaction_b64, 'base64');
  check(wire.toString('base64') === body.transaction_b64 && wire.length <= 1232);
  let tx; try { tx = parseTransaction(wire); } catch { fail('LocalMarchInvalid'); }
  check(tx.signatures.length === 1 && tx.signers.length === 1 && tx.signers[0] === pins.wallet, 'LocalMarchSigner');
  const expected = localMarchMessage(intent, pins, tx.recentBlockhash);
  check(Buffer.from(tx.message).equals(Buffer.from(expected)), 'LocalMarchMessageMismatch');
  const key = createPublicKey({ key: Buffer.concat([SPKI_ED25519, Buffer.from(decode(pins.wallet))]), format: 'der', type: 'spki' });
  check(edVerify(null, tx.message, key, tx.signatures[0]), 'LocalMarchSigner');
  return Object.freeze({ intent, message: Uint8Array.from(tx.message), signature: encode(tx.signatures[0]) });
}

function accountOf(row) {
  if (row === null) return null;
  if (row === undefined || typeof row !== 'object' || typeof row.owner !== 'string' || row.executable === true || !Array.isArray(row.data) || row.data[1] !== 'base64' || typeof row.data[0] !== 'string') fail('LocalMarchRpcUnavailable');
  const bytes = Buffer.from(row.data[0], 'base64');
  if (bytes.toString('base64') !== row.data[0]) fail('LocalMarchRpcUnavailable');
  return { owner: row.owner, bytes: new Uint8Array(bytes) };
}
const ACT_TO_MARCH = { LocalActCitizen: 'LocalMarchCitizen', LocalActHolding: 'LocalMarchHolding', LocalActWideHolding: 'LocalMarchWideHolding', LocalActNotYourVillage: 'LocalMarchHolding' };

/** The real accounts, as read `[citizen, holding, province]`: this wallet's Citizen, its legacy village, the program's province at (p, q). */
export function localMarchAccountsCheck(intent, pins, { citizenAt, holdingAt }, [citizen, holding, province]) {
  try { localActAccountsCheck({ name: 'Depart', subject: { holding: intent.subject.holding } }, pins, { citizenAt, holdingAt }, [citizen, holding]); }
  catch (e) { fail(ACT_TO_MARCH[e?.code] ?? 'LocalMarchHolding'); }
  check(province !== null && province.owner === pins.program, 'LocalMarchProvince');
  let d; try { d = decodePrefix('Province', province.bytes, { profile: profileForHash(pins.rulesetHash) }); } catch { fail('LocalMarchProvince'); }
  check(String(d.seasonId) === String(pins.seasonId) && d.p === intent.subject.province.p && d.q === intent.subject.province.q, 'LocalMarchProvince');
}

/** The flow over the relay's closed `cfg`, `rpc` and the runner's pinned instance (or null). Constructing it reads and sends nothing. */
export function createLocalPlayMarch({ cfg, rpc = (m, p) => fetchRpc(cfg.rpc, m, p), runnerInstance = null, trial = false }) {
  if (trial !== false && trial !== true) throw new Error('local-play march refused: trial must be a boolean');
  // DEFAULT CLOSED (independent review, 2026-11-13): the march exists only for the TEST-ONLY trial entry and only over
  // a pinned runner instance. Without both nothing is built, so no listener can serve a signed Depart: neither an
  // economy flag alone nor a relay without a pin. Opening it outside the trial is a separate, reviewed change.
  if (trial !== true) throw new Error('local-play march refused: only the test-only trial entry serves the march');
  if (runnerInstance === null) throw new Error('local-play march refused: a pinned runner instance is required');
  const problems = localPlayRelayConfigProblems(cfg, {});
  if (problems.length) throw new Error('local-play march refused: ' + problems.join('; '));
  if (runnerInstance !== null && (typeof runnerInstance !== 'string' || !/^[0-9a-f]{64}$/.test(runnerInstance) || /^0{64}$/.test(runnerInstance))) throw new Error('local-play march refused: bad runner instance');
  const pins = Object.freeze({ program: cfg.program, season: cfg.season, seasonId: LOCAL_PLAY_SEASON_ID, wallet: cfg.wallet, rulesetHash: cfg.rulesetHash });
  const A = seasonAddresses(pins.program, String(pins.seasonId));
  const citizenAt = A.of('Citizen', { wallet: pins.wallet });
  const seen = new Map();   // digest → {signature}: for good
  let closed = false;
  const open = () => { if (closed) fail('LocalMarchClosed'); };
  const ask = async (method, params) => { let r; try { r = await rpc(method, params); } catch { fail('LocalMarchRpcUnavailable'); } if (!r || r.error !== undefined) fail('LocalMarchRpcUnavailable'); return r; };
  return Object.freeze({
    routes: LOCAL_MARCH_ROUTES,
    // The READ-ONLY capability: that THIS relay serves the ordinary march for its one wallet, on the runner that states
    // the pinned instance itself (an empty getSignatureStatuses, as the act instance read). The pin alone is never
    // answered as confirmed; no pin → LocalMarchNoInstance. It signs, sends and records nothing. It says nothing about
    // whether the page or the keeper is ready: those are the page's own booleans (flocalplay-march.mjs).
    async capability(body) {
      open();
      check(exact(body, ['schema']) && body.schema === LOCAL_MARCH_CAPABILITY_SCHEMA);
      if (runnerInstance === null) fail('LocalMarchNoInstance');
      const p = await ask('getSignatureStatuses', [[]]);
      open();
      const ctx = p.result?.context, value = p.result?.value;
      if (!Number.isSafeInteger(ctx?.slot) || ctx.slot < 0 || !Array.isArray(value) || value.length !== 0 || ctx.instance !== runnerInstance) fail('LocalMarchRpcUnavailable');
      return { schema: LOCAL_MARCH_CAPABILITY_SCHEMA, wallet: pins.wallet, instance: runnerInstance, commands: [...LOCAL_MARCH_COMMANDS], reveal: 'keeper', trial };
    },
    async submit(body) {
      open();
      const ok = localMarchSubmit(body, pins), digest = sha(ok.message).toString('hex');
      check(!seen.has(digest), 'LocalMarchMessageUsed'); check(seen.size < LOCAL_MARCH_MAX_HISTORY, 'LocalMarchBusy');
      const holdingAt = A.of('Holding', ok.intent.subject.holding), provinceAt = A.of('Province', ok.intent.subject.province);
      const got = await ask('getMultipleAccounts', [[citizenAt, holdingAt, provinceAt], { encoding: 'base64', commitment: 'confirmed' }]);
      open();
      const slot = got.result?.context?.slot, rows = got.result?.value;
      if (!Number.isSafeInteger(slot) || slot < 0 || !Array.isArray(rows) || rows.length !== 3) fail('LocalMarchRpcUnavailable');
      localMarchAccountsCheck(ok.intent, pins, { citizenAt, holdingAt }, rows.map(accountOf));
      if (runnerInstance !== null) {
        const p = await ask('getSignatureStatuses', [[ok.signature], { searchTransactionHistory: true }]);
        open();
        const ctx = p.result?.context, value = p.result?.value;
        if (!Number.isSafeInteger(ctx?.slot) || ctx.slot < 0 || !Array.isArray(value) || value.length !== 1 || ctx.instance !== runnerInstance) fail('LocalMarchRpcUnavailable');
        if (value[0] !== null) { seen.set(digest, Object.freeze({ signature: ok.signature })); fail('LocalMarchMessageUsed'); }
      }
      check(!seen.has(digest), 'LocalMarchMessageUsed'); check(seen.size < LOCAL_MARCH_MAX_HISTORY, 'LocalMarchBusy');
      open();   // the last thing before the send
      seen.set(digest, Object.freeze({ signature: ok.signature }));   // before sending: at most once
      const binding = sealBinding(ok.intent);
      let sent;
      try { sent = await rpc('sendTransaction', [body.transaction_b64, { encoding: 'base64', preflightCommitment: 'confirmed' }]); }
      catch { return { status: 'unknown', name: 'Depart', signature: ok.signature, ...binding, status_route: LOCAL_MARCH_ROUTES.status }; }
      if (sent?.error) throw new LocalMarchError('LocalMarchSendRefused', { code: sent.error.code, message: String(sent.error.message ?? '').slice(0, 300), signature: ok.signature });
      return { status: sent?.result === ok.signature ? 'submitted' : 'unknown', name: 'Depart', signature: ok.signature, ...binding, status_route: LOCAL_MARCH_ROUTES.status };
    },
    async status(body) {
      open();
      check(exact(body, ['schema', 'signature']) && body.schema === LOCAL_MARCH_STATUS_SCHEMA && typeof body.signature === 'string');
      check([...seen.values()].some(e => e.signature === body.signature), 'LocalMarchUnknownSignature');
      const r = await ask('getSignatureStatuses', [[body.signature], { searchTransactionHistory: true }]);
      const ctx = r.result?.context, value = r.result?.value, slot = ctx?.slot;
      if (!Number.isSafeInteger(slot) || slot < 0 || !Array.isArray(value) || value.length !== 1) fail('LocalMarchRpcUnavailable');
      if (runnerInstance !== null && ctx.instance !== runnerInstance) fail('LocalMarchRpcUnavailable');
      const s = value[0];
      if (s === null) return { signature: body.signature, status: 'pending', context_slot: slot };
      if (typeof s !== 'object' || Array.isArray(s) || !Object.hasOwn(s, 'err') || !Number.isSafeInteger(s.slot) || s.slot < 0 || s.slot > slot
          || !['processed', 'confirmed', 'finalized'].includes(s.confirmationStatus) || !(s.err === null || typeof s.err === 'string' || (typeof s.err === 'object' && !Array.isArray(s.err)))) fail('LocalMarchRpcUnavailable');
      return { signature: body.signature, status: s.err !== null ? 'failed' : s.confirmationStatus, err: s.err, slot: s.slot, context_slot: slot };
    },
    stats() { return { history: seen.size }; },
    close() { closed = true; },
    closed: () => closed,
  });
}
