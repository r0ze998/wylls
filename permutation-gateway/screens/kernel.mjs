// The rules kernel in node: the very file the page loads
// (permutation-server/web/frontier/wasm/frontier.wasm), checked against its
// published sha256 and its pinned ruleset hash exactly as the page checks it
// (web/frontier/wasm.mjs `loadKernel`), and called through the page's own
// wrapper (`Kernel`: borsh in, a frame out). The sample world resolves its
// clashes, prices its paths and draws its terrain with it (liveworld.mjs), so
// the world and the page's forecast and verification run one copy of the
// rules.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Kernel, ABI_VERSION } from '../../permutation-server/web/frontier/wasm.mjs';
import { RULESET_HASH } from '../../permutation-server/web/frontier/abi.mjs';

const WASM = new URL('../../permutation-server/web/frontier/wasm/frontier.wasm', import.meta.url);
let loaded = null;

/** The kernel (loaded once; throws when the file is not the published one or was built from other rules). */
export function kernel() {
  if (loaded) return loaded;
  const bytes = readFileSync(WASM);
  const want = readFileSync(new URL(`${WASM.href}.sha256`), 'utf8').trim().split(/\s+/)[0];
  const got = createHash('sha256').update(bytes).digest('hex');
  if (got !== want) throw new Error(`frontier.wasm sha256 ${got}, published ${want}`);
  const k = new Kernel(new WebAssembly.Instance(new WebAssembly.Module(bytes), {}).exports);
  const v = k.call('abi_version');
  if (!v.ok || v.value !== ABI_VERSION) throw new Error(`frontier.wasm ABI ${v.value}`);
  if (k.rulesetHash() !== RULESET_HASH) throw new Error('frontier.wasm was built from other rules');
  loaded = k;
  return k;
}
