// The browser driver for the page tests: `playwright` when installed, else the
// repository's pinned `playwright-core` (permutation-gateway/screens, `npm ci` there).
// Returns null when neither is present (the browser tests then skip).
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

export function loadPlaywright() {
  const req = createRequire(import.meta.url);
  try { return req('playwright'); } catch { /* next */ }
  try {
    const screens = fileURLToPath(new URL('../../permutation-gateway/screens/package.json', import.meta.url));
    return createRequire(screens)('playwright-core');
  } catch { return null; }
}
