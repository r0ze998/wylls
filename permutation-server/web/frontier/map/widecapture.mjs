// Byte/summary consistency for captured wide map accounts, not chain verification.
// Expected geometry and public season pins come from the map's pinned manifest.
// No wallet, transaction, signer, generated terrain or live-state assumptions.
import { fromBase64, toBase64, toHex, utf8 } from '../../sdk/bytes.mjs';
import { decode, encode } from '../../sdk/base58.mjs';
import { sha256 } from '../../sdk/sha256.mjs';

const check = (ok, message) => { if (!ok) throw new Error(message); };
const zero = (b, start, size) => b.subarray(start, start + size).every(x => x === 0);

/** Canonical public with-seed address, using the ABI's wide seed domains. */
export function captureAddress(kind, sortKey, site, seasonAddress, program) {
  const domain = kind === 'province' ? 'PSF-WIDE-PROVINCE-SEED-v1' : 'PSF-WIDE-HOLDING-SEED-v1';
  const seed = (kind === 'province' ? 'wp' : 'wh') + toHex(sha256(utf8(domain), sortKey,
    ...(kind === 'province' ? [] : [Uint8Array.of(site)])).slice(0, 15));
  const season = decode(seasonAddress), owner = decode(program);
  check(season.length === 32 && owner.length === 32, 'public address length');
  return encode(sha256(season, utf8(seed), owner));
}

/** Validate raw ABI identity and all displayed summary facts; throws on disagreement.
 * `expected` is derived by the page parser, never taken from the capture summary.
 */
export function checkCapturedBytes(kind, summary, capture, expected) {
  const { world, p, q, ring, wedge, pos, manifest } = expected;
  check(manifest && manifest.world === world, 'capture requires the pinned manifest');
  check(manifest.captureBounds, 'capture requires fold bounds');
  check(capture.slot <= manifest.captureBounds.lastSlot
    && capture.archiveSequence <= manifest.captureBounds.foldedThrough, 'capture ahead of fold');
  const b = fromBase64(capture.bytes_b64);
  check(toBase64(b) === capture.bytes_b64, 'noncanonical base64');
  const province = kind === 'province', t = province ? 4736 : 1280;
  check(b.length === (province ? 4864 : 1344), 'capture length');
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  check(String.fromCharCode(...b.subarray(0, 8)) === (province ? 'PSFXWPV1' : 'PSFXWHL1'), 'capture magic');
  check(v.getUint16(16, true) === 3 && v.getUint16(t, true) === 1 && b[t + 2] === 1, 'capture version/status');
  check(v.getBigUint64(8, true).toString() === manifest.season, 'capture season');
  check(v.getInt16(64, true) === 0 && v.getInt16(66, true) === 0, 'legacy prefix');
  check(typeof p === 'bigint' && typeof q === 'bigint' && ring > 128n, 'wide coordinate');
  const key = new Uint8Array(17), kv = new DataView(key.buffer);
  kv.setBigUint64(0, ring, false); key[8] = wedge; kv.setBigUint64(9, pos, false);
  const worldOffset = t + (province ? 4 : 8), keyOffset = t + (province ? 36 : 40);
  check(toHex(b.subarray(worldOffset, worldOffset + 32)) === world, 'capture world');
  check(toHex(b.subarray(keyOffset, keyOffset + 17)) === toHex(key), 'capture coordinate');
  check(capture.address === captureAddress(kind, key, summary.site, manifest.seasonAddress, manifest.program), 'capture address');
  if (province) {
    check(b[t + 3] === 15 && zero(b, t + 53, 3) && zero(b, t + 104, 24), 'province readiness/reserved');
    check(v.getUint16(68, true) === 0 && b[70] === wedge, 'province legacy ring/wedge');
    check(!zero(b, t + 64, 32), 'province seed');
    check(b[71] === summary.region && v.getUint32(76, true) === summary.openedBell
      && b[4481] === summary.keepHolder, 'province summary');
  } else {
    check(zero(b, t + 7, 1) && zero(b, t + 57, 7), 'holding reserved');
    check(b[68] === summary.site && b[69] === summary.generation && b[t + 3] === summary.inventorySlot, 'holding summary');
    check(encode(b.subarray(72, 104)) === summary.ownerCitizen, 'holding owner');
    const identity = v.getUint16(t + 4, true);
    check(identity === 0 || identity === 1, 'holding host identity');
    check(identity !== 0 || (v.getUint32(132, true) === 0 && b[t + 6] === 0), 'holding debit without identity');
    check([0, 1, 2, 3].every(i => b[784 + i * 96] === 0) && b[1186] === 0, 'holding active legacy transit/explore');
  }
}
