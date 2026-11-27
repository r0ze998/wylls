// The rules kernel for the in-browser sample world: the same frontier.wasm the
// page loads (screens/kernel.mjs reads it with node:fs; here it is fetched once,
// checked against its published sha256 and ruleset hash, and instantiated before
// the world is made, so `kernel()` stays synchronous for liveworld.mjs).
import { Kernel, ABI_VERSION } from '../../../permutation-server/web/frontier/wasm.mjs';
import { RULESET_HASH } from '../../../permutation-server/web/frontier/abi.mjs';
import { sha256 } from '../../../permutation-server/web/sdk/sha256.mjs';
import { toHex } from '../../../permutation-server/web/sdk/bytes.mjs';

let loaded = null;

/** Load the kernel from `url` (the page's own wasm/frontier.wasm) with `fetcher` (the browser's real fetch). */
export async function initKernel(url, fetcher) {
  if (loaded) return loaded;
  const [bin, sum] = await Promise.all([fetcher(url).then(r => r.arrayBuffer()), fetcher(`${url}.sha256`).then(r => r.text())]);
  const bytes = new Uint8Array(bin);
  const want = sum.trim().split(/\s+/)[0];
  const got = toHex(sha256(bytes));
  if (got !== want) throw new Error(`frontier.wasm sha256 ${got}, published ${want}`);
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const k = new Kernel(instance.exports);
  const v = k.call('abi_version');
  if (!v.ok || v.value !== ABI_VERSION) throw new Error(`frontier.wasm ABI ${v.value}`);
  if (k.rulesetHash() !== RULESET_HASH) throw new Error('frontier.wasm was built from other rules');
  loaded = k;
  return k;
}

/** The kernel (initKernel must have resolved first). */
export function kernel() {
  if (!loaded) throw new Error('walletless demo: the kernel is not loaded yet');
  return loaded;
}
