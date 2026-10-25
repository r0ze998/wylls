// A static server for the render page: the repository root on 127.0.0.1 (the page imports the
// game's own modules and art from permutation-server/web, read only). `node serve.mjs [port]`.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const T = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webp': 'image/webp', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.wasm': 'application/wasm' };
export function serve(port = 41781) {
  return new Promise(res => {
    const s = createServer(async (q, r) => {
      const p = normalize(decodeURIComponent(new URL(q.url, 'http://x').pathname));
      try { const b = await readFile(join(ROOT, p)); r.writeHead(200, { 'content-type': T[extname(p)] ?? 'application/octet-stream' }); r.end(b); }
      catch { r.writeHead(404); r.end(); }
    }).listen(port, '127.0.0.1', () => res(s));
  });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) serve(Number(process.argv[2] ?? 41781)).then(() => console.log('serving the repository on 127.0.0.1'));
