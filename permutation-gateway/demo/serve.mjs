#!/usr/bin/env node
// A plain static file server for the built demo (testing only — the demo needs no server of its own):
//   node serve.mjs [--dir dist] [--port 0] [--prefix /play/]
// Serves files only (no /h, no /gw): anything else is a 404, as a static host answers.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const TYPES = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.wasm': 'application/wasm', '.sha256': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp',
  '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.glb': 'model/gltf-binary' };

/** Start a static server: `{url, port, requests, close()}` (`url` ends with the prefix). */
export async function serveStatic({ dir, port = 0, prefix = '/' } = {}) {
  const root = resolve(dir) + sep;
  const pre = `/${String(prefix).replace(/^\/+|\/+$/g, '')}/`.replace('//', '/');
  const requests = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    let code = 404;
    try {
      if (url.pathname.startsWith(pre)) {
        let rel = decodeURIComponent(url.pathname.slice(pre.length));
        if (rel === '' || rel.endsWith('/')) rel += 'index.html';
        const full = normalize(join(root, rel));
        if (full.startsWith(root) && (await stat(full)).isFile()) {
          const body = await readFile(full);
          res.writeHead(200, { 'Content-Type': TYPES[extname(full)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
          res.end(body); code = 200;
        }
      }
    } catch { /* 404 */ }
    if (code === 404) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); }
    requests.push({ path: url.pathname, code });
  });
  await new Promise((ok, no) => { server.once('error', no); server.listen(port, '127.0.0.1', ok); });
  const p = server.address().port;
  return { url: `http://127.0.0.1:${p}${pre}`, port: p, requests, close: () => new Promise(r => { server.closeAllConnections?.(); server.close(r); }) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const { values } = parseArgs({ options: { dir: { type: 'string', default: 'dist' }, port: { type: 'string', default: '0' }, prefix: { type: 'string', default: '/' } } });
  const s = await serveStatic({ dir: values.dir, port: Number(values.port), prefix: values.prefix });
  console.log(`walletless demo: ${s.url}`);
  for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, async () => { await s.close(); process.exit(0); });
}
