// The resident transfer on the mint page (TEST): the parts with no DOM and no network, so they are tested alone.
//
// The program's TransferResident (program/src/lib.rs `transfer_resident`) checks that the owner signs and owns the
// asset; it does NOT refuse a transfer to oneself, to an address nobody can sign for (a program-derived address), or
// to one of the system's own accounts. Such a transfer would burn the generation or lose the resident for good, so
// the page refuses them before anything is signed.
//
// Rules (the same as the mint):
// * The pending record {signature, asset, from, to, lastValidBlockHeight} is written BEFORE the send. A lost answer is
//   resolved by the signature, then by the asset's owner on the chain; never by a second send.
// * "Transferred" is said only when the chain shows the asset's owner is the destination.
export const TRANSFER_TAG = 0x51;
export const PENDING_TRANSFER = w => `wylls-transfer-pending:${w}`;

/**
 * The destination as typed, checked strictly. Outer spaces (a paste) are trimmed; anything else that is not exactly a
 * 32-byte base58 public key is refused, and so are: no wallet connected, the sender itself, an address off the curve
 * (a program-derived address: no key exists, the resident could never move or play again), and the system's own
 * accounts (programs, the collection, the treasury, the config, the asset itself).
 * Returns `{ ok: true, address }` or `{ ok: false, code }`.
 */
export function checkDestination({ input, from, asset, config, decode, isOnCurve }) {
  if (!from) return { ok: false, code: 'NoWallet' };
  const s = String(input ?? '').trim();
  if (!s) return { ok: false, code: 'Empty' };
  if (!/^[1-9A-HJ-NP-Za-km-z]+$/.test(s)) return { ok: false, code: 'NotBase58' };
  let bytes;
  try { bytes = decode(s); } catch { return { ok: false, code: 'NotBase58' }; }
  if (bytes.length !== 32) return { ok: false, code: 'WrongLength' };
  if (s === from) return { ok: false, code: 'Self' };
  const known = [asset, config?.collection, config?.treasury, config?.configPda, config?.collectionAuthorityPda, ...Object.values(config?.programs ?? {})].filter(Boolean);
  if (known.includes(s)) return { ok: false, code: 'SystemAccount' };
  if (!isOnCurve(s)) return { ok: false, code: 'OffCurve' };
  return { ok: true, address: s };
}

/**
 * Whether the connected wallet may transfer this asset now, from the server's chain read (`/mint/status` for the
 * sender). Refused when the wallet is not connected, the asset is someone else's, or it is not a bound resident.
 */
export function checkSender({ from, status }) {
  if (!from) return { ok: false, code: 'NoWallet' };
  if (!status || status.code) return { ok: false, code: status?.code ?? 'NotResident' };
  if (!status.isHolder) return { ok: false, code: 'NotYours' };
  if (!status.bound) return { ok: false, code: 'NotResident' };
  return { ok: true };
}

/** The TransferResident instruction: `[owner s][payer s,w][asset w][collection w][coll_auth][resident w][new_owner][core][system]`, data `[0x51]`. */
export function transferInstruction({ config, owner, asset, resident, to }) {
  return {
    programId: config.programs.resident,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: asset, isSigner: false, isWritable: true },
      { pubkey: config.collection, isSigner: false, isWritable: true },
      { pubkey: config.collectionAuthorityPda, isSigner: false, isWritable: false },
      { pubkey: resident, isSigner: false, isWritable: true },
      { pubkey: to, isSigner: false, isWritable: false },
      { pubkey: config.programs.core, isSigner: false, isWritable: false },
      { pubkey: config.programs.system, isSigner: false, isWritable: false },
    ],
    data: Uint8Array.of(TRANSFER_TAG),
  };
}

/** The owner of a Core asset account (`AssetV1`: key u8, then the owner's 32 bytes), base58; null when absent. */
export function assetOwnerOf(accountValue, toBase58) {
  if (!accountValue) return null;
  const raw = Uint8Array.from(atob(accountValue.data[0]), ch => ch.charCodeAt(0));
  return raw.length >= 33 ? toBase58(raw.slice(1, 33)) : null;
}

/**
 * The pending record as stored (`raw`: the localStorage string or null), checked before it is trusted:
 * - `none`: no record;
 * - `ok`: a record of this network (`genesis`) with every field;
 * - `otherNetwork`: written against another chain (a local test world restarted on the same address and port): its
 *   signature can never be answered here, so it is set aside rather than blocking the screen forever;
 * - `unreadable`: not a record this page wrote (damaged, an older format).
 * A record that is set aside never allows a double transfer: the program refuses a second TransferResident from a
 * wallet that no longer owns the asset (NotOwner).
 */
export function parsePendingRecord(raw, genesis) {
  if (raw === null || raw === undefined) return { state: 'none' };
  let p;
  try { p = JSON.parse(raw); } catch { return { state: 'unreadable' }; }
  const str = k => typeof p?.[k] === 'string' && p[k].length > 0;
  if (!p || p.v !== 1 || !['signature', 'asset', 'from', 'to', 'genesis'].every(str) || !Number.isSafeInteger(p.gen) || !Number.isSafeInteger(p.lastValidBlockHeight)) return { state: 'unreadable' };
  if (p.genesis !== genesis) return { state: 'otherNetwork', p };
  return { state: 'ok', p };
}

/**
 * What a pending transfer turned out to be, from what the chain says:
 * - `settled`: the signature's status at confirmed or later (or null), `owner`: the asset's owner now,
 * - `gen`: the resident's generation now (null when unread); every transfer raises it by one, so a generation above
 *   the one recorded at the send means the asset moved at least once since (A→B→A comes back to A at +2),
 * - `expired`: the blockhash can no longer land, `finalOwner`: the owner read at finalized once that is past expiry (or undefined).
 * Returns 'landed' | 'returned' | 'failed' | 'notLanded' | 'unknown' | 'elsewhere'. Only 'failed' and 'notLanded'
 * mean nothing moved; 'notLanded' is said only when the owner is still the sender AND the generation is unchanged.
 */
export function decidePending({ p, settled, owner, gen = null, expired, finalOwner }) {
  if (settled?.err) return 'failed';
  if (owner === p.to) return 'landed';
  const movedSince = Number.isSafeInteger(gen) && gen > p.gen;
  if (settled) return owner === p.from && movedSince ? 'returned' : 'elsewhere';
  if (owner === p.from && movedSince) return 'returned';
  if (!expired || finalOwner === undefined) return 'unknown';
  if (finalOwner === p.from) return gen === p.gen ? 'notLanded' : movedSince ? 'returned' : 'unknown';
  return finalOwner === p.to ? 'landed' : 'elsewhere';
}

/** A short form of an address for the confirmation (the full one is shown next to it). */
export const shortAddress = a => (a && a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-6)}` : a ?? '');
