// A checkout's web client against a running herald (docs/design/uplift/04-VERIFY, 3 回目): serves a worktree's
// permutation-server/web under /frontier/ and passes /h/* and /gw/* to the herald, so two builds of the client (the
// base and this branch) can be seen and timed against the same live world. Loopback only; it sends nothing anywhere
// else and writes nothing.
//
//   node uplift-proxy.mjs <web root> <listen port> <herald port>
//   (then http://127.0.0.1:<listen port>/frontier/frontier/spectate.html?intro=0)
import { createServer, request } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';

const [, , root, portArg, upArg] = process.argv;
if (!root || !portArg || !upArg) { console.error('usage: node uplift-proxy.mjs <web root> <listen port> <herald port>'); process.exit(2); }
const CSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; frame-ancestors 'none'";
const TYPES = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.wasm': 'application/wasm', '.sha256': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2', '.txt': 'text/plain' };

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/h/') || url.pathname.startsWith('/gw/')) {
    const up = request({ host: '127.0.0.1', port: Number(upArg), path: req.url, method: req.method, headers: req.headers }, r => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    up.on('error', () => { res.writeHead(502); res.end(); });
    req.pipe(up);
    return;
  }
  let p = url.pathname.startsWith('/frontier/') ? url.pathname.slice('/frontier'.length) : url.pathname;
  if (p.endsWith('/')) p += 'index.html';
  const file = normalize(join(root, decodeURIComponent(p)));
  if (!file.startsWith(normalize(root) + sep) && file !== normalize(root)) { res.writeHead(403); res.end(); return; }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache', 'Content-Security-Policy': CSP });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
}).listen(Number(portArg), '127.0.0.1', () => console.log(`uplift-proxy http://127.0.0.1:${portArg}/frontier/frontier/ -> herald ${upArg}`));
