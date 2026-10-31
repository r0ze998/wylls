// The mint page's companion server: static files (the page, and the
// repository's dependency-free browser SDK for transaction bytes), the
// page's config, the holder check that decides "registered", and `/rpc`.
//
// Two modes, same page code:
//   mock   `/rpc` is the mock JSON-RPC over the mock chain (tests, local demo);
//          `/mock/*` test knobs exist only here.
//   devnet `/rpc` forwards to the configured RPC URL (not exercised in this
//          environment: devnet deployment is not approved).
//
// "Registered" is never taken from the page: `GET /mint/status` reads the
// asset account through the server's reader, verifies program, collection
// and holder, and reads the resident account's binding, every time.
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyResidentAsset, MPL_CORE_PROGRAM } from './core-asset.mjs';
import { decodeResident, residentAccountOf, RESIDENT_PROGRAM } from './mock-chain.mjs';
import { residentIdOf } from './ids.mjs';
import { ASSET_BYTES, LAMPORTS_PER_SIGNATURE, MINT_RESIDENT_ACCOUNTS, MINT_RESIDENT_TAG, RESIDENT_BYTES, rentFor, SYSTEM_PROGRAM } from './mint-rpc.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const REPO = path.resolve(ROOT, '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };

/** Static roots the page may load from (read-only): the spike's web/, and the repo's browser SDK. */
const STATIC = [
  { prefix: '/web/', dir: path.join(ROOT, 'web') },
  { prefix: '/sdk/', dir: path.join(REPO, 'permutation-server', 'web', 'sdk') },
];

export function createMintHandler({ rpc, chain, collection, config, mode = 'mock', testWallet = false }) {
  const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body, (_, v) => (typeof v === 'bigint' ? v.toString() : v))); };
  return async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const read = async () => { const c = []; for await (const x of req) c.push(x); return c.length ? JSON.parse(Buffer.concat(c).toString('utf8')) : {}; };
    try {
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/mint')) { res.writeHead(302, { Location: '/web/mint.html' }); return res.end(); }
      for (const s of STATIC) {
        if (req.method === 'GET' && url.pathname.startsWith(s.prefix)) {
          const rel = path.normalize(url.pathname.slice(s.prefix.length));
          const f = path.join(s.dir, rel);
          if (!f.startsWith(s.dir) || !existsSync(f) || !statSync(f).isFile()) { res.writeHead(404); return res.end('not found'); }
          res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
          return res.end(readFileSync(f));
        }
      }
      if (req.method === 'GET' && url.pathname === '/mint/config') {
        return json(res, 200, {
          mode, network: config.network, chainId: config.chainId, genesisHash: config.genesisHash, rpc: '/rpc', explorer: config.explorer,
          notice: { test: true, devnetOnly: true, noValue: true, noProductionEntitlement: true },
          price: { lamports: String(config.priceLamports), label: config.priceLabel, test: true, changeable: true },
          estimate: { feeLamports: String(LAMPORTS_PER_SIGNATURE * 2n), rentAssetLamports: String(rentFor(ASSET_BYTES)), rentResidentLamports: String(rentFor(RESIDENT_BYTES)) },
          programs: { resident: RESIDENT_PROGRAM, core: MPL_CORE_PROGRAM, system: SYSTEM_PROGRAM }, collection, treasury: config.treasury, collectionAuthorityPda: config.collectionAuthorityPda, configPda: config.configPda,
          instruction: { tag: MINT_RESIDENT_TAG, accounts: MINT_RESIDENT_ACCOUNTS }, testWallet,
        });
      }
      if (req.method === 'GET' && url.pathname === '/mint/status') {
        const wallet = url.searchParams.get('wallet');
        const asset = url.searchParams.get('asset');
        if (!asset) return json(res, 400, { ok: false, code: 'BadRequest' });
        const r = await rpc.readerGetAccount(asset);
        const v = verifyResidentAsset({ account: r.account ? { ...r.account, address: asset } : null, expected: { program: MPL_CORE_PROGRAM, collection } });
        if (!v.ok) return json(res, 200, { registered: false, code: v.code, asset, readSlot: r.slot });
        const resident = decodeResident((await rpc.readerGetAccount(residentAccountOf(asset))).account);
        const bound = resident?.bound === residentIdOf(asset);
        const holder = v.holder === wallet;
        return json(res, 200, { registered: bound && holder, holder: v.holder, isHolder: holder, bound, residentId: bound ? resident.bound : null, gen: resident?.gen ?? null, asset, readSlot: r.slot, frozenByGuard: r.account?.flags?.permanentFrozen === true });
      }
      if (req.method === 'GET' && url.pathname === '/mint/derive') {
        // The resident account for an asset (mock derivation; the real program's PDA seeds are in MINT-FLOW §4 and would be derived in the page).
        const asset = url.searchParams.get('asset');
        return json(res, 200, { asset, resident: residentAccountOf(asset) });
      }
      if (req.method === 'GET' && url.pathname === '/mint/mine') {
        // The wallet's residents (mock: scan; devnet: a DAS getAssetsByOwner or an indexer, listed in MINT-FLOW §5).
        const wallet = url.searchParams.get('wallet');
        const mine = [];
        for (const [address, a] of chain.accounts) {
          if (a.owner !== MPL_CORE_PROGRAM) continue;
          const v = verifyResidentAsset({ account: { ...a, address }, expected: { program: MPL_CORE_PROGRAM, collection } });
          if (v.ok && v.holder === wallet) mine.push({ asset: address, residentId: residentIdOf(address) });
        }
        return json(res, 200, { wallet, residents: mine, published: false });
      }
      if (req.method === 'POST' && url.pathname === '/rpc') {
        const body = await read();
        const out = await rpc.handle(body);
        if (out?.drop) { res.writeHead(504, { 'Content-Type': 'text/plain' }); return res.end('gateway timeout (test knob: the transaction was forwarded and landed, the answer is lost)'); }
        return json(res, 200, out);
      }
      if (mode === 'mock' && req.method === 'POST' && url.pathname.startsWith('/mock/')) {
        const body = await read();
        switch (url.pathname) {
          case '/mock/airdrop': rpc.airdrop(body.address, BigInt(body.lamports)); return json(res, 200, { ok: true, balance: rpc.balance(body.address) });
          case '/mock/knobs': Object.assign(rpc.knobs, body); return json(res, 200, { ok: true, knobs: rpc.knobs });
          case '/mock/advance': rpc.advance(Number(body.blocks ?? 1)); return json(res, 200, { ok: true, height: rpc.height });
          case '/mock/price': config.priceLamports = BigInt(body.lamports); return json(res, 200, { ok: true, price: config.priceLamports });
          case '/mock/transfer': { const r = rpc.mockTransfer(body); return json(res, 200, r); }
          case '/mock/state': return json(res, 200, { height: rpc.height, slot: chain.slot, balances: Object.fromEntries([...rpc.lamports].map(([k, v]) => [k, v.toString()])), sent: rpc.sent, assets: [...chain.accounts.keys()].filter(k => chain.accounts.get(k).owner === MPL_CORE_PROGRAM && k !== collection) });
          default: return json(res, 404, { ok: false });
        }
      }
      json(res, 404, { ok: false, code: 'NotFound' });
    } catch (e) {
      json(res, 500, { ok: false, code: 'Internal', message: e.message });
    }
  };
}

export function serveMint(opts) {
  const server = createServer(createMintHandler(opts));
  return new Promise(resolve => server.listen(opts.port ?? 0, '127.0.0.1', () => resolve({ server, port: server.address().port, url: `http://127.0.0.1:${server.address().port}` })));
}
