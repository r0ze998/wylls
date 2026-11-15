// LOCAL-PLAY ONLY: the submit-only Reveal route of the temporary loopback
// relay. The browser builds and signs its own ExpeditionReveal
// (web/frontier/fexpedition-reveal.mjs); this module only checks that the
// signed transaction is exactly that and forwards it, once, to the loopback
// runner. It never builds, prepares or alters a reveal, and holds no key.
//
//   POST /f/local-play/reveal/submit  {schema, transaction_b64}
//   POST /f/local-play/reveal/status  {schema, signature}
//
// Accepted only (a strict SHAPE check mirroring the program's REVEAL account
// spec; the program itself authenticates the transit, beacons, route and
// slots; this is not a Rust-fixture or real-SBF parity proof): a legacy
// transaction with ONE signature, by the pinned wallet (also the fee payer),
// verified Ed25519 over the message; exactly three compute-budget instructions
// (limit ≤ 1.4M, price 0, loaded-data limit) then ONE instruction of the
// pinned program whose data is the 242-byte version-2 wrapper of
// ExpeditionReveal (`ee ff 02 02 ee ff 01 01 …`, transit/target slot ≤ 3,
// beneficiary = the pinned wallet) and whose 16 + ≤ 3 distinct accounts are:
// the wallet (signer, writable), the pinned Season, holding, transit, anchor,
// archive, beacon log, inputs and destination Province (all read-only), the
// ArrivalDay (writable), the four slots with ONLY the target slot writable,
// the instructions sysvar and the System program at their fixed addresses
// (read-only), then the path provinces (read-only); no other program or signer.
//
// The transaction carries the player's plaintext and salt (that is the
// reveal); this module keeps only the message digest, the signature and the
// blockhash, never the bytes, and logs nothing. A digest is sent at most once:
// a timeout or network error after sending answers `unknown` with the
// signature (status can look it up) and is never resent. A used digest is
// retired only when the runner itself says its blockhash is no longer valid;
// when the barrier is full and nothing can be retired, new submissions are
// refused (fail-closed). The general gateway and the Depart routes are
// untouched.
import { createHash, createPublicKey, verify as edVerify } from 'node:crypto';
import { decode, encode } from '../../client/src/base58.mjs';
import { parseTransaction, COMPUTE_BUDGET_PROGRAM } from '../../client/src/solana-tx.mjs';
import { localPlayRelayConfigProblems, fetchRpc, LocalPlayError } from './local-play-relay.mjs';

export const REVEAL_SUBMIT_SCHEMA = 'frontier-local-play-reveal-submit-v1';
export const REVEAL_STATUS_SCHEMA = 'frontier-local-play-reveal-status-v1';
export const REVEAL_ROUTES = Object.freeze({
  submit: 'POST /f/local-play/reveal/submit',
  status: 'POST /f/local-play/reveal/status',
});
export const REVEAL_WIRE_LEN = 242;
export const REVEAL_HEAD = Object.freeze([0xee, 0xff, 2, 2, 0xee, 0xff, 1, 1]);
export const MAX_REVEAL_HISTORY = 64;
const MAX_CU = 1_400_000, MAX_LOADED = 64 * 1024 * 1024;
export const IX_SYSVAR = 'Sysvar1nstructions1111111111111111111111111';
export const SYSTEM_PROGRAM = '11111111111111111111111111111111';
const fail = (code, detail) => { throw new LocalPlayError(code, detail); };
const exact = (v, fields) => v !== null && typeof v === 'object' && !Array.isArray(v)
  && Object.keys(v).length === fields.length && fields.every(k => Object.hasOwn(v, k));
const sha = b => createHash('sha256').update(b).digest('hex');
const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');
const u32 = d => d.length === 5 ? Buffer.from(d).readUInt32LE(1) : -1;
const u64 = d => d.length === 9 ? Buffer.from(d).readBigUInt64LE(1) : -1n;

/** The reveal-specific shape checks of a parsed transaction (throws LocalPlayBadTransaction). */
export function checkRevealTransaction(parsed, pins) {
  const bad = () => fail('LocalPlayBadTransaction');
  if (parsed.signatures.length !== 1 || parsed.signers.length !== 1 || parsed.signers[0] !== pins.wallet || parsed.accountKeys[0] !== pins.wallet) bad();
  const ixs = parsed.instructions;
  if (ixs.length !== 4) bad();
  const [limit, price, loaded, game] = ixs;
  for (const ix of [limit, price, loaded]) if (ix.programId !== COMPUTE_BUDGET_PROGRAM || ix.keys.length !== 0) bad();
  const cu = u32(limit.data), ld = u32(loaded.data);
  if (limit.data[0] !== 2 || !(cu > 0 && cu <= MAX_CU) || price.data[0] !== 3 || u64(price.data) !== 0n
      || loaded.data[0] !== 4 || !(ld > 0 && ld <= MAX_LOADED)) bad();
  if (game.programId !== pins.program || game.data.length !== REVEAL_WIRE_LEN || REVEAL_HEAD.some((x, i) => game.data[i] !== x)) bad();
  if (game.data[8] > 3 || game.data[9] > 3) bad();
  // the beneficiary of a local-play reveal is the player's own wallet
  if (encode(game.data.slice(210, 242)) !== pins.wallet) bad();
  const k = game.keys;
  if (k.length < 16 || k.length > 19 || new Set(k.map(x => x.pubkey)).size !== k.length) bad();
  if (k[0].pubkey !== pins.wallet || !k[0].isSigner || !k[0].isWritable) bad();
  if (k.slice(1).some(x => x.isSigner)) bad();
  if (k[1].pubkey !== pins.season) bad();
  // read-only: season, holding, transit, anchor, archive, beacon log, inputs,
  // destination Province, the fixed sysvar/system, every path province
  for (const i of [1, 2, 3, 4, 5, 6, 7, 8, 14, 15]) if (k[i].isWritable) bad();
  if (k.slice(16).some(x => x.isWritable)) bad();
  if (!k[9].isWritable) bad(); // the ArrivalDay
  const target = game.data[9];
  for (let i = 0; i < 4; i++) if (k[10 + i].isWritable !== (i === target)) bad();
  if (k[14].pubkey !== IX_SYSVAR || k[15].pubkey !== SYSTEM_PROGRAM) bad();
  // only the wallet, the program, the compute-budget program and the reveal's accounts appear
  const named = new Set([pins.program, COMPUTE_BUDGET_PROGRAM, ...game.keys.map(k => k.pubkey)]);
  if (parsed.accountKeys.some(k => !named.has(k))) bad();
  return { blockhash: parsed.recentBlockhash };
}

/** The Reveal submit-only routes over the same pins as the local-play relay. */
export function createLocalPlayReveal({ cfg, rpc = (m, p) => fetchRpc(cfg.rpc, m, p) }) {
  const problems = localPlayRelayConfigProblems(cfg);
  if (problems.length) throw new Error('local-play reveal refused: ' + problems.join('; '));
  const pins = Object.freeze({ program: cfg.program, season: cfg.season, wallet: cfg.wallet });
  const walletKey = createPublicKey({ key: Buffer.concat([SPKI_ED25519, Buffer.from(decode(cfg.wallet))]), format: 'der', type: 'spki' });
  // digest → {state: 'reserved'|'sent', signature, blockhash}
  const seen = new Map();
  const retire = async () => {
    for (const [d, e] of [...seen]) {
      if (e.state !== 'sent') continue;
      let r;
      try { r = await rpc('isBlockhashValid', [e.blockhash, { commitment: 'confirmed' }]); } catch { return; }
      // only a successful answer (no error) whose value is the boolean false
      // retires; anything else (an error, a mixed error/result, a malformed
      // or non-boolean value) keeps the tombstone
      const ok = r !== null && typeof r === 'object' && r.error === undefined
        && r.result !== null && typeof r.result === 'object' && typeof r.result.value === 'boolean';
      if (ok && r.result.value === false) seen.delete(d);
    }
  };
  return Object.freeze({
    routes: REVEAL_ROUTES,

    async submit(body) {
      if (!exact(body, ['schema', 'transaction_b64']) || body.schema !== REVEAL_SUBMIT_SCHEMA
          || typeof body.transaction_b64 !== 'string' || body.transaction_b64.length > 1700) fail('LocalPlayInvalidRequest');
      const wire = Buffer.from(body.transaction_b64, 'base64');
      if (wire.toString('base64') !== body.transaction_b64 || wire.length > 1232) fail('LocalPlayBadTransaction');
      let parsed;
      try { parsed = parseTransaction(wire); } catch { fail('LocalPlayBadTransaction'); }
      const { blockhash } = checkRevealTransaction(parsed, pins);
      if (!edVerify(null, parsed.message, walletKey, parsed.signatures[0])) fail('LocalPlayBadSignature');
      const digest = sha(parsed.message);
      if (seen.has(digest)) fail('LocalPlayMessageUsed');
      if (seen.size >= MAX_REVEAL_HISTORY) await retire();
      // (re-checked after the await: a concurrent submit may have taken it)
      if (seen.has(digest)) fail('LocalPlayMessageUsed');
      if (seen.size >= MAX_REVEAL_HISTORY) fail('LocalPlayBusy');
      const signature = encode(parsed.signatures[0]);
      seen.set(digest, { state: 'sent', signature, blockhash }); // before sending: at most once
      let sent;
      try {
        sent = await rpc('sendTransaction', [body.transaction_b64, { encoding: 'base64', preflightCommitment: 'confirmed' }]);
      } catch {
        return { status: 'unknown', signature, status_route: REVEAL_ROUTES.status };
      }
      if (sent?.error) fail('LocalPlaySendRefused', { code: sent.error.code, message: String(sent.error.message ?? '').slice(0, 300), signature });
      if (sent?.result !== signature) return { status: 'unknown', signature, status_route: REVEAL_ROUTES.status };
      return { status: 'submitted', signature, status_route: REVEAL_ROUTES.status };
    },

    async status(body) {
      if (!exact(body, ['schema', 'signature']) || body.schema !== REVEAL_STATUS_SCHEMA || typeof body.signature !== 'string') fail('LocalPlayInvalidRequest');
      if (![...seen.values()].some(e => e.signature === body.signature)) fail('LocalPlayUnknownSignature');
      const r = await rpc('getSignatureStatuses', [[body.signature], { searchTransactionHistory: true }]);
      if (r.error) fail('LocalPlayRpcUnavailable');
      const s = r.result?.value?.[0] ?? null;
      if (s === null) return { signature: body.signature, status: 'pending' };
      return { signature: body.signature, status: s.err ? 'failed' : (s.confirmationStatus ?? 'processed'), err: s.err ?? null, slot: s.slot ?? null };
    },

    /** Counts only. */
    stats() { return { history: seen.size }; },
  });
}
