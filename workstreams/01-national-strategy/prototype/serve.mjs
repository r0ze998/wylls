// 国の卓の試作を配る小さな静的サーバー（依存なし）。
//   node workstreams/01-national-strategy/prototype/serve.mjs [--port 41871]
// 127.0.0.1 だけで待ち受け、このフォルダの中だけを配る。

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const i = process.argv.indexOf('--port');
const port = Number(i > 0 ? process.argv[i + 1] : process.env.PORT ?? 41871);
const TYPES = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

export function start(p = port) {
  const server = createServer(async (req, res) => {
    let path;
    try { path = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400).end('bad request'); return; }
    const rel = normalize(path === '/' ? '/index.html' : path).replace(/^([/\\])+/, '');
    const file = join(root, rel);
    if (!file.startsWith(root) || !TYPES[extname(file)]) { res.writeHead(404).end('not found'); return; }
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': TYPES[extname(file)], 'cache-control': 'no-store' }).end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  return new Promise(resolve => server.listen(p, '127.0.0.1', () => resolve(server)));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  start().then(s => console.log(`国の卓の試作：http://127.0.0.1:${s.address().port}/`));
}
