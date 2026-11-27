#!/usr/bin/env node
// A plain static file server for the built demo (testing only — the demo needs no server of its own):
//   node serve.mjs [--dir dist] [--port 0] [--prefix /play/] [--gzip]
// Serves files only (no /h, no /gw): anything else is a 404, as a static host answers (with dist/404.html when the
// build wrote one, as GitHub Pages does).
// --gzip: text files (html, js, css, json, svg) are sent gzip-encoded when the browser asks, as GitHub Pages,
// Cloudflare Pages, Netlify and Vercel do; images and wasm are sent as they are (the conservative case).
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const TYPES = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.wasm': 'application/wasm', '.sha256': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp',
  '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.glb': 'model/gltf-binary' };

/** Start a static server: `{url, port, requests, close()}` (`url` ends with the prefix). */
export async function serveStatic({ dir, port = 0, prefix = '/', gzip = false } = {}) {
  const zipped = new Map();
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
          let body = await readFile(full);
          const head = { 'Content-Type': TYPES[extname(full)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' };
          if (gzip && /^(?:text\/|application\/json|image\/svg)/.test(head['Content-Type']) && /\bgzip\b/.test(req.headers['accept-encoding'] ?? '')) {
            if (!zipped.has(full)) zipped.set(full, gzipSync(body, { level: 9 }));
            body = zipped.get(full); head['Content-Encoding'] = 'gzip'; head.Vary = 'Accept-Encoding';
          }
          res.writeHead(200, head);
          res.end(body); code = 200;
        }
      }
    } catch { /* 404 */ }
    if (code === 404) {
      const page = await readFile(join(root, '404.html')).catch(() => null);
      res.writeHead(404, { 'Content-Type': page ? TYPES['.html'] : 'text/plain' }); res.end(page ?? 'not found');
    }
    requests.push({ path: url.pathname, code });
  });
  await new Promise((ok, no) => { server.once('error', no); server.listen(port, '127.0.0.1', ok); });
  const p = server.address().port;
  return { url: `http://127.0.0.1:${p}${pre}`, port: p, requests, close: () => new Promise(r => { server.closeAllConnections?.(); server.close(r); }) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const { values } = parseArgs({ options: { dir: { type: 'string', default: 'dist' }, port: { type: 'string', default: '0' }, prefix: { type: 'string', default: '/' }, gzip: { type: 'boolean', default: false } } });
  const s = await serveStatic({ dir: values.dir, port: Number(values.port), prefix: values.prefix, gzip: values.gzip });
  console.log(`walletless demo: ${s.url}`);
  for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, async () => { await s.close(); process.exit(0); });
}
