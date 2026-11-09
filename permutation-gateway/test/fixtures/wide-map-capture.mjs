// Synthetic public identity rebound onto COPIES of the committed runtime ABI
// fixtures. Never edits/regenerates those files; not a chain authenticity claim.
import { readFileSync } from 'node:fs';
import { decode } from '../../../permutation-server/web/sdk/base58.mjs';
import { worldIdOf, ringPosition } from '../../../permutation-server/web/frontier/map/wide.mjs';
import { captureAddress } from '../../../permutation-server/web/frontier/map/widecapture.mjs';

const root = new URL('../../../frontier-node/crates/verify/tests/fixtures/wide_economy/harvest/', import.meta.url);
export function syntheticWideEntry({ seasonAddress, program, season = '5', p = '9007199254740993', q = '0',
  slot = '9007199254740994', archiveSequence = '12' }) {
  const world = worldIdOf(seasonAddress, program), rp = ringPosition(BigInt(p), BigInt(q));
  const key = Buffer.alloc(17); key.writeBigUInt64BE(rp.ring); key[8] = rp.wedge; key.writeBigUInt64BE(rp.pos, 9);
  const province = Buffer.from(readFileSync(new URL('province_post.bin', root)));
  const holding = Buffer.from(readFileSync(new URL('holding_post.bin', root)));
  for (const [b, t, worldAt, keyAt] of [[province, 4736, 4, 36], [holding, 1280, 8, 40]]) {
    b.writeBigUInt64LE(BigInt(season), 8);
    Buffer.from(world, 'hex').copy(b, t + worldAt); key.copy(b, t + keyAt);
  }
  province[70] = rp.wedge; province[71] = 3; province.writeUInt32LE(5, 76); province[4481] = 4;
  holding[68] = 2; holding[69] = 1; holding[1283] = 2; holding.set(decode(seasonAddress), 72);
  const capture = (kind, b) => ({ address: captureAddress(kind, key, 2, seasonAddress, program), slot, archiveSequence,
    verification: 'captured-unverified', postState: 'at-or-after-transaction', bytes_b64: b.toString('base64') });
  return { p, q, ring: String(rp.ring), wedge: rp.wedge, pos: String(rp.pos), state: 'open', revision: '1', observedAt: slot,
    legacy: null, wide: { world, p, q, region: 3, openedBell: 5, keepHolder: 4, capture: capture('province', province),
      holdings: [{ world, p, q, site: 2, generation: 1, inventorySlot: 2, ownerCitizen: seasonAddress, capture: capture('holding', holding) }] } };
}
