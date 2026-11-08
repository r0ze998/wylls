// Workstream 07: how a screen test opens the WHOLE game page as a connected player without any key.
// - The fixture server starts keyless (server.mjs startServer({keyless: true})): the viewer's wallet and session are
//   32-byte names made from no key (world.mjs KEYLESS_WALLET, KEYLESS_SESSION).
// - The page's storage holds no seed (no 'ps-dev-wallet', no session): only the language, the title seen, and the name
//   of the wallet last used, so the page reconnects silently to the test wallet below.
// - The test wallet (Wallet Standard, as workstream 01's coop.browser.nokey.mjs registers one) has the viewer's address
//   and NO key: signMessage and signTransaction refuse. Nothing the page shows can rest on a signature.
// - The page is opened as wylls.test (not a loopback host: frontier/config.mjs `dev` is false, so the page never offers
//   its dev wallet, which would make a key). Chromium treats that origin as secure (`--unsafely-treat-insecure-origin-
//   as-secure`), so WebCrypto is there (the kernel's sha256 check needs it). That flag is honoured by the full
//   Chromium only, not by Playwright's default headless shell: `launchOptions` asks for channel 'chromium'. (Before
//   2026-11-08 this helper launched the headless shell, where the page was NOT a secure context: no WebCrypto, so
//   the kernel did not load. The tests of that time did not need the kernel; INTEGRATION §0m.)
// - Every key operation in the page is blocked and counted: WebCrypto's generate, derive, import of a private key
//   and sign, and the page's own Ed25519 functions in web/session.mjs (keyFromSeed, publicKeyOf, which work out a
//   public key in JavaScript before WebCrypto is asked), replaced as the module is served (`prepare`).
// These tests check what the page SHOWS from the fixture's records. They do not check signing, sending or the chain.
export const TEST_WALLET = 'Test Wallet (no keys)';
export const HOST = 'wylls.test';

/** chromium.launch options for a page on wylls.test at these ports (the full Chromium: see above). */
export const launchOptions = (...ports) => ({ channel: 'chromium', args: launchArgs(...ports) });
export const launchArgs = (...ports) => ['--host-resolver-rules=MAP wylls.test 127.0.0.1', `--unsafely-treat-insecure-origin-as-secure=${ports.map(p => `http://${HOST}:${p}`).join(',')}`];
export const pageBase = port => `http://${HOST}:${port}`;

/** localStorage for a returning player of the keyless viewer: no seed of any kind. */
export const storage = ({ lang = 'ja' } = {}) => ({ 'ps-lang': lang, 'ps-fintro:v1': '1', 'ps-wallet': TEST_WALLET });

/** The init script (a page function): the storage, the key guard, and the test wallet with `address`. */
export function init({ store, address, name }) {
  try { for (const [k, v] of Object.entries(store)) localStorage.setItem(k, v); } catch { /* none */ }
  window.__keyUses = [];
  // (kept across reloads in this context: a reload clears the page's own variables, not its storage)
  const note = window.__ws07note = what => { window.__keyUses.push(what); try { localStorage.setItem('ws07:keyUses', JSON.stringify([...JSON.parse(localStorage.getItem('ws07:keyUses') ?? '[]'), what])); } catch { /* none */ } };
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
/** What is appended to web/session.mjs as it is served: its key functions refuse, counted (they are mutable bindings). */
const SESSION_GUARD = `
;keyFromSeed = async () => { globalThis.__ws07note?.('keyFromSeed'); throw new Error('key use blocked: keyFromSeed'); };
publicKeyOf = async () => { globalThis.__ws07note?.('publicKeyOf'); throw new Error('key use blocked: publicKeyOf'); };
`;
/**
 * Make `ctx` keyless for `viewer`: the init script (storage, guard, test wallet) and web/session.mjs served with its
 * key functions replaced by refusals that are counted.
 */
export async function prepare(ctx, viewer, opts) {
  await ctx.addInitScript(init, initArg(viewer, opts));
  await ctx.route(/\/session\.mjs(\?.*)?$/, async route => {
    // (fetched from Node, which does not know wylls.test: the same server at 127.0.0.1)
    const u = new URL(route.request().url());
    if (u.hostname === HOST) u.hostname = '127.0.0.1';
    const r = await route.fetch({ url: u.href });
    const body = await r.text();
    if (!/export async function keyFromSeed/.test(body) || !/export async function publicKeyOf/.test(body)) throw new Error('web/session.mjs changed: the keyless guard no longer knows its key functions');
    await route.fulfill({ response: r, body: body + SESSION_GUARD });
  });
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
