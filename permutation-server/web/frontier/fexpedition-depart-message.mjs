// DEVNET PLAY (devnet gap P15) — the UNSIGNED message of a boundary departure (ExpeditionDepart, the 0x4804 wrapper,
// kind 0), built from a checked preparation request alone. ONE copy, used by the page (fdevnet-depart.mjs, which has
// its connected wallet sign it) and by the gateway (permutation-gateway devnet-play-act.mjs, which rebuilds it from the
// stated request and compares the signed message byte for byte before its one send).
//
// It is exactly the message the keyless Rust CLI (frontier-experimental-expedition-depart-prepare, fclient
// experimental_expedition_message::prepare_depart) prepares, so the local relay's checker (expeditionDepartPrepareReport)
// and the page's (departPreparationReport) accept it: five instructions — SetComputeUnitLimit(cuLimit),
// SetComputeUnitPrice(0), SetLoadedAccountsDataSizeLimit(loadedLimit), RequestHeapFrame(256 KiB), then the dispatch
// (DEPART_OUTER_HEAD + the 369 canonical inner bytes) over the nine canonical roles (privileges merged where they
// alias) — compiled as solana-message compiles it (NOT as web3.js does): the fee payer first, then writable signers,
// read-only signers, writable non-signers, read-only non-signers, each group in raw key-byte order. The equality with
// the CLI's own output is pinned by the gateway test (the recorded `*-wallet-payer-heap256k-rust.json` fixture).
//
// Pure: no read, no key, no signature, no send. The request must already be canonical (the page's
// departPreparationRequestOf / the gateway's expeditionDepartPrepareRequest rebuilt it).
import { decode } from '../sdk/base58.mjs';
import { fromHex, toHex } from '../sdk/bytes.mjs';
import { sha256 } from '../sdk/sha256.mjs';
import { COMPUTE_BUDGET_PROGRAM } from '../sdk/solana-tx.mjs';

/** fclient DEPART_HEAP_FRAME (256 KiB): the one heap frame of a Depart. */
export const DEPART_MESSAGE_HEAP = 256 * 1024;
/** The devnet page's budget: the local launcher's relay values (`--cu-limit 1000000 --loaded-limit 67108864`). */
export const DEVNET_DEPART_CU_LIMIT = 1_000_000;
export const DEVNET_DEPART_LOADED_LIMIT = 67_108_864;
/** expedition_dispatch_ix::encode(Kind::Depart, …): TAG_DEPART, ENVELOPE_ESCAPE, VERSION 2, Kind::Depart 0. */
export const DEPART_MESSAGE_OUTER_HEAD = Object.freeze([0xda, 0xff, 2, 0]);
export const DEPART_MESSAGE_INNER_BYTES = 369;

const fail = code => { throw Object.assign(new Error(code), { code }); };
const check = (ok, code = 'DepartMessageContract') => { if (!ok) fail(code); };
const le32 = n => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; };
const le64 = n => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n), true); return b; };
const join = parts => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let at = 0; for (const p of parts) { out.set(p, at); at += p.length; } return out; };
const shortvec = n => { const out = []; for (;;) { let b = n & 0x7f; n >>= 7; if (n === 0) { out.push(b); return Uint8Array.from(out); } out.push(b | 0x80); } };
const key32 = a => { let b; try { b = decode(a); } catch { fail('DepartMessageContract'); } check(b.length === 32); return b; };
const cmpBytes = (a, b) => { for (let i = 0; i < 32; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; };
const positive = (v, max) => Number.isSafeInteger(v) && v > 0 && v <= max;

/**
 * `{request, blockhash, cuLimit, loadedLimit}` → `{message, digest, signers, accounts}` (message: Uint8Array; digest:
 * sha256 hex of the message; signers: [payer]; accounts: the number of distinct keys). The request's payer must be its
 * wallet (one signer). Throws `DepartMessageContract` on anything else.
 */
export function departUnsignedMessage({ request, blockhash, cuLimit = DEVNET_DEPART_CU_LIMIT, loadedLimit = DEVNET_DEPART_LOADED_LIMIT }) {
  check(request && typeof request === 'object' && request.payer === request.wallet);
  check(positive(cuLimit, 1_400_000) && positive(loadedLimit, 64 * 1024 * 1024));
  const roles = request.proposal?.roles;
  check(Array.isArray(roles) && roles.length === 9 && roles[1]?.name === 'payer' && roles[1].address === request.payer);
  const inner = fromHex(request.proposal.bytes_hex);
  check(inner.length === DEPART_MESSAGE_INNER_BYTES);
  const hash = key32(blockhash);
  const program = request.program;
  const ixs = [
    { programId: COMPUTE_BUDGET_PROGRAM, keys: [], data: join([Uint8Array.of(2), le32(cuLimit)]) },
    { programId: COMPUTE_BUDGET_PROGRAM, keys: [], data: join([Uint8Array.of(3), le64(0)]) },
    { programId: COMPUTE_BUDGET_PROGRAM, keys: [], data: join([Uint8Array.of(4), le32(loadedLimit)]) },
    { programId: COMPUTE_BUDGET_PROGRAM, keys: [], data: join([Uint8Array.of(1), le32(DEPART_MESSAGE_HEAP)]) },
    { programId: program, keys: roles.map(r => ({ pubkey: r.address, isSigner: !!r.signer, isWritable: !!r.writable })),
      data: join([Uint8Array.from(DEPART_MESSAGE_OUTER_HEAD), inner]) },
  ];
  // solana-message CompiledKeys: the payer (signer, writable), then every key once with merged privileges.
  const metas = new Map([[request.payer, { signer: true, writable: true }]]);
  const put = (k, s, w) => { const m = metas.get(k) ?? { signer: false, writable: false }; metas.set(k, { signer: m.signer || s, writable: m.writable || w }); };
  for (const ix of ixs) { put(ix.programId, false, false); for (const k of ix.keys) put(k.pubkey, k.isSigner, k.isWritable); }
  check(!(metas.get(program)?.signer || metas.get(program)?.writable));
  const group = (s, w) => [...metas.entries()].filter(([k, m]) => k !== request.payer && m.signer === s && m.writable === w)
    .map(([k]) => [k, key32(k)]).sort((a, b) => cmpBytes(a[1], b[1])).map(([k]) => k);
  const keys = [request.payer, ...group(true, true), ...group(true, false), ...group(false, true), ...group(false, false)];
  const signers = keys.filter(k => metas.get(k).signer);
  check(signers.length === 1);
  const header = Uint8Array.of(signers.length, keys.filter(k => metas.get(k).signer && !metas.get(k).writable).length,
    keys.filter(k => !metas.get(k).signer && !metas.get(k).writable).length);
  const at = k => keys.indexOf(k);
  const body = ixs.map(ix => join([Uint8Array.of(at(ix.programId)), shortvec(ix.keys.length), Uint8Array.from(ix.keys.map(k => at(k.pubkey))), shortvec(ix.data.length), ix.data]));
  const message = join([header, shortvec(keys.length), ...keys.map(key32), hash, shortvec(ixs.length), ...body]);
  return Object.freeze({ message, digest: toHex(sha256(message)), signers: Object.freeze(signers), accounts: keys.length });
}
