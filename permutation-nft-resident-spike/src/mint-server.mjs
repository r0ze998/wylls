// The mint page's companion server: static files (the page, and the
// repository's dependency-free browser SDK for transaction bytes), the
// page's config, the holder check that decides "registered", and `/rpc`.
//
// Two adapters (src/adapters.mjs), same page code:
//   MockAdapter  `/rpc` is the mock JSON-RPC over the mock chain (tests without a validator);
//   RpcAdapter   `/rpc` forwards to a real JSON-RPC (the loopback solana-test-validator with the
//                real Core binary and the resident program; devnet later, not approved yet).
// `/mock/*` are test knobs; a devnet configuration must not serve them.
//
// "Registered" is never taken from the page: `GET /mint/status` reads the
// asset account through the server's reader, verifies program, collection
// and holder, and reads the resident account's binding, every time.
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MPL_CORE_PROGRAM } from './core-asset.mjs';
export { MockAdapter, RpcAdapter } from './adapters.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const REPO = path.resolve(ROOT, '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };

/** Static roots the page may load from (read-only): the spike's web/, and the repo's browser SDK. */
const STATIC = [
  { prefix: '/web/', dir: path.join(ROOT, 'web') },
  { prefix: '/sdk/', dir: path.join(REPO, 'permutation-server', 'web', 'sdk') },
];

/** The JSON-RPC methods the page sends (web/mint.mjs); `/rpc` forwards these only, never as an open proxy. */
export const PAGE_RPC_METHODS = Object.freeze(['getGenesisHash', 'getBalance', 'getLatestBlockhash', 'getBlockHeight', 'getAccountInfo', 'getSignatureStatuses', 'sendTransaction']);
/** The largest request body the server reads (a signed transaction is at most 1,232 bytes, base64 in JSON). */
export const MAX_BODY_BYTES = 64 * 1024;

/**
 * `testWallet`: the page offers its browser test wallet. `testKnobs`: the `/mock/*` routes (airdrop, response knobs,
 * state) answer — for local tests only; off by default, so a shared deployment never exposes them.
 */
export function createMintHandler({ adapter, mode = adapter.kind, testWallet = false, testKnobs = false }) {
  const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body, (_, v) => (typeof v === 'bigint' ? v.toString() : v))); };
  return async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const read = async () => {
      const c = []; let n = 0;
      for await (const x of req) { n += x.length; if (n > MAX_BODY_BYTES) throw Object.assign(new Error('request body too large'), { status: 413, code: 'TooLarge' }); c.push(x); }
      return c.length ? JSON.parse(Buffer.concat(c).toString('utf8')) : {};
    };
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
        const c = await adapter.config();
        return json(res, 200, { ...c, rpc: '/rpc', notice: { test: true, devnetOnly: true, noValue: true, noProductionEntitlement: true }, testWallet });
      }
      if (req.method === 'GET' && url.pathname === '/mint/status') {
        const wallet = url.searchParams.get('wallet');
        const asset = url.searchParams.get('asset');
        if (!asset) return json(res, 400, { ok: false, code: 'BadRequest' });
        return json(res, 200, await adapter.status({ wallet, asset }));
      }
      if (req.method === 'GET' && url.pathname === '/mint/derive') {
        const asset = url.searchParams.get('asset');
        return json(res, 200, { asset, resident: adapter.derive(asset) });
      }
      if (req.method === 'GET' && url.pathname === '/mint/mine') {
        const wallet = url.searchParams.get('wallet');
        return json(res, 200, { wallet, residents: await adapter.mine(wallet), published: false });
      }
      if (req.method === 'POST' && url.pathname === '/rpc') {
        const body = await read();
        if (Array.isArray(body) || !PAGE_RPC_METHODS.includes(body?.method)) {
          return json(res, 403, { jsonrpc: '2.0', id: body?.id ?? null, error: { code: -32601, message: 'method not served by the mint page' } });
        }
        const out = await adapter.handle(body);
        if (out?.drop) { res.writeHead(504, { 'Content-Type': 'text/plain' }); return res.end('gateway timeout (test knob: the transaction was forwarded and landed, the answer is lost)'); }
        return json(res, 200, out);
      }
      if (req.method === 'POST' && url.pathname.startsWith('/mock/') && testKnobs) {
        // Test knobs: local tests only (`testKnobs`); without it these paths are 404 like any other.
        const body = await read();
        switch (url.pathname) {
          case '/mock/airdrop': return json(res, 200, { ok: true, balance: await adapter.airdrop(body.address, BigInt(body.lamports)) });
          case '/mock/knobs': Object.assign(adapter.knobs, body); return json(res, 200, { ok: true, knobs: adapter.knobs });
          case '/mock/advance': if (adapter.rpc.advance) adapter.rpc.advance(Number(body.blocks ?? 1)); return json(res, 200, { ok: true });
          case '/mock/price': if (adapter.cfg) adapter.cfg.priceLamports = BigInt(body.lamports); return json(res, 200, { ok: true });
          case '/mock/transfer': return json(res, 200, adapter.rpc.mockTransfer ? adapter.rpc.mockTransfer(body) : { ok: false, code: 'NotMock' });
          case '/mock/state': {
            if (adapter.kind === 'mock') { const chain = adapter.chain; const rpc = adapter.rpc; return json(res, 200, { height: rpc.height, slot: chain.slot, balances: Object.fromEntries([...rpc.lamports].map(([k, v]) => [k, v.toString()])), sent: rpc.sent, assets: [...chain.accounts.keys()].filter(k => chain.accounts.get(k).owner === MPL_CORE_PROGRAM && k !== adapter.collection) }); }
            return json(res, 200, { sent: adapter.sent });
          }
          default: return json(res, 404, { ok: false });
        }
      }
      json(res, 404, { ok: false, code: 'NotFound' });
    } catch (e) {
      if (e.status === 413) return json(res, 413, { ok: false, code: e.code });
      json(res, 500, { ok: false, code: 'Internal', message: e.message });
    }
  };
}

export function serveMint(opts) {
  const server = createServer(createMintHandler(opts));
  return new Promise(resolve => server.listen(opts.port ?? 0, '127.0.0.1', () => resolve({ server, port: server.address().port, url: `http://127.0.0.1:${server.address().port}` })));
}
