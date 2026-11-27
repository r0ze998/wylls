// node:fs for the browser bundle: the few files the sample world reads at load
// (frontier-abi presets, the fixture vectors) are embedded by build.mjs as the
// virtual module `demo:files` and looked up by the end of their path.
import { FILES } from 'demo:files';

export function readFileSync(path, enc) {
  const p = String(path);
  for (const [name, text] of Object.entries(FILES)) if (p.endsWith(`/${name}`) || p === name) return enc ? text : new TextEncoder().encode(text);
  throw new Error(`walletless demo: no embedded file for ${p}`);
}
export function writeFileSync() { throw new Error('walletless demo: no file system'); }
export default { readFileSync, writeFileSync };
