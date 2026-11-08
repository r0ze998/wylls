// Workstream 07: how a screen test opens the WHOLE game page as a connected player without any key.
// - The fixture server starts keyless (server.mjs startServer({keyless: true})): the viewer's wallet and session are
//   32-byte names made from no key (world.mjs KEYLESS_WALLET, KEYLESS_SESSION).
// - The page's storage holds no seed (no 'ps-dev-wallet', no session): only the language, the title seen, and the name
//   of the wallet last used, so the page reconnects silently to the test wallet below.
// - The test wallet (Wallet Standard, as workstream 01's coop.browser.nokey.mjs registers one) has the viewer's address
//   and NO key: signMessage and signTransaction refuse. Nothing the page shows can rest on a signature.
// - The page is opened as wylls.test (not a loopback host: frontier/config.mjs `dev` is false, so the page never offers
//   its dev wallet, which would make a key); Chromium treats that origin as secure, so WebCrypto's verify is there.
// - Every key operation in the page (generate, derive, import a private key, sign) is blocked and counted.
// These tests check what the page SHOWS from the fixture's records. They do not check signing, sending or the chain.
export const TEST_WALLET = 'Test Wallet (no keys)';
export const HOST = 'wylls.test';

export const launchArgs = (...ports) => ['--host-resolver-rules=MAP wylls.test 127.0.0.1', `--unsafely-treat-insecure-origin-as-secure=${ports.map(p => `http://${HOST}:${p}`).join(',')}`];
export const pageBase = port => `http://${HOST}:${port}`;

/** localStorage for a returning player of the keyless viewer: no seed of any kind. */
export const storage = ({ lang = 'ja' } = {}) => ({ 'ps-lang': lang, 'ps-fintro:v1': '1', 'ps-wallet': TEST_WALLET });

/** The init script (a page function): the storage, the key guard, and the test wallet with `address`. */
export function init({ store, address, name }) {
  try { for (const [k, v] of Object.entries(store)) localStorage.setItem(k, v); } catch { /* none */ }
  window.__keyUses = [];
  // (kept across reloads in this context: a reload clears the page's own variables, not its storage)
  const note = what => { window.__keyUses.push(what); try { localStorage.setItem('ws07:keyUses', JSON.stringify([...JSON.parse(localStorage.getItem('ws07:keyUses') ?? '[]'), what])); } catch { /* none */ } };
  const s = globalThis.crypto?.subtle;
  if (s) {
    for (const m of ['generateKey', 'deriveKey', 'deriveBits', 'sign', 'unwrapKey']) Object.defineProperty(s, m, { value: async () => { note(m); throw new Error(`key use blocked: ${m}`); } });
    const imp = s.importKey.bind(s);
    Object.defineProperty(s, 'importKey', { value: async (f, d, a, e, u) => { if (f === 'pkcs8' || (f === 'jwk' && d && d.d) || (u ?? []).includes('sign')) { note(`importKey:${f}`); throw new Error('key use blocked'); } return imp(f, d, a, e, u); } });
  }
  const refuse = async () => { note('wallet sign asked'); throw new Error('this test wallet has no key and signs nothing'); };
  const account = { address, publicKey: new Uint8Array(32), chains: ['solana:localnet'], features: ['solana:signTransaction', 'solana:signMessage'] };
  const wallet = {
    version: '1.0.0', name, icon: 'data:image/svg+xml;base64,PHN2Zy8+', chains: ['solana:localnet'], accounts: [account],
    features: {
      'standard:connect': { version: '1.0.0', connect: async () => ({ accounts: [account] }) },
      'standard:disconnect': { version: '1.0.0', disconnect: async () => {} },
      'standard:events': { version: '1.0.0', on: () => () => {} },
      'solana:signMessage': { version: '1.0.0', signMessage: refuse },
      'solana:signTransaction': { version: '1.0.0', supportedTransactionVersions: ['legacy'], signTransaction: refuse },
    },
  };
  window.addEventListener('wallet-standard:app-ready', e => e.detail.register(wallet));
}
/** The init script's argument for a keyless viewer. */
export const initArg = (viewer, opts) => ({ store: storage(opts), address: viewer.wallet, name: TEST_WALLET });

/**
 * Every page of `ctx` made no key operation, was never asked by the page to sign, and holds no seed (the dev wallet's or a
 * session's) in its storage. Call before closing the context.
 */
export async function assertKeyless(ctx, assert) {
  for (const page of ctx.pages()) {
    const r = await page.evaluate(() => ({ uses: JSON.parse(localStorage.getItem('ws07:keyUses') ?? '[]'), seeds: Object.keys(localStorage).filter(k => k === 'ps-dev-wallet' || k.startsWith('ps-fsession:')) })).catch(() => null);
    if (!r) continue;
    assert.deepEqual(r.uses, [], 'no key operation and no signature asked of the wallet');
    assert.deepEqual(r.seeds, [], 'no seed in storage');
  }
}
