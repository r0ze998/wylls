// Read-only local fixture server for the wide-holding browser fixture.
// Node built-ins only. Serves a fixed allowlist of files; never proxies or relays.
import { createServer } from 'node:http';
import { realpath, stat, readFile } from 'node:fs/promises';
import { dirname, join, resolve, sep, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const WEB_ROOT = join(REPO_ROOT, 'permutation-server', 'web');
const SEASON_JSON = join(REPO_ROOT, 'permutation-gateway', 'test', 'fixtures', 'frontier', 'season.json');

const FIXTURE_FILES = new Set(['index.html', 'fixture.mjs', 'data.mjs', 'fixture.css']);
const WEB_EXTENSIONS = new Set([
  '.html', '.mjs', '.js', '.css', '.json', '.svg', '.png', '.webp',
  '.jpg', '.jpeg', '.woff2', '.wasm', '.sha256',
]);
const MIME = {
  '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.sha256': 'text/plain; charset=utf-8',
};
const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self' data:",
  "connect-src 'self'", "font-src 'self'", "worker-src 'none'", "frame-src 'none'",
  "frame-ancestors 'none'", "form-action 'none'", "base-uri 'none'",
].join('; ');

function baseHeaders(extra = {}) {
  return {
    'Content-Security-Policy': CSP,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    ...extra,
  };
}

function sendError(res, status, extra = {}) {
  const body = `${status}\n`;
  res.writeHead(status, baseHeaders({
    'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': Buffer.byteLength(body), ...extra,
  }));
  res.end(body);
}

// Validate a /web/* suffix without touching the filesystem. Returns segments or null.
function webSegments(rawPath) {
  if (rawPath.includes('\\') || rawPath.includes('%5c') || rawPath.includes('%5C')) return null;
  let decoded;
  try { decoded = decodeURIComponent(rawPath); } catch { return null; }
  if (decoded.includes('\\') || decoded.includes('\0')) return null;
  const segments = decoded.split('/');
  if (segments.length === 0) return null;
  for (const seg of segments) {
    if (seg === '' || seg.startsWith('.') || seg === 'node_modules') return null;
  }
  if (!WEB_EXTENSIONS.has(extname(segments[segments.length - 1]).toLowerCase())) return null;
  return segments;
}

// Realpath `file` and require it to stay under realpath(`dir`); null when missing or escaping via symlink.
async function confined(dir, file) {
  try {
    const [realDir, real] = await Promise.all([realpath(dir), realpath(file)]);
    return real.startsWith(realDir + sep) ? real : null;
  } catch { return null; }
}

async function resolveTarget(pathname) {
  if (pathname === '/fixture/season.json') return confined(dirname(SEASON_JSON), SEASON_JSON);
  if (pathname.startsWith('/fixture/')) {
    const name = pathname.slice('/fixture/'.length);
    return FIXTURE_FILES.has(name) ? confined(HERE, join(HERE, name)) : null;
  }
  if (pathname.startsWith('/web/')) {
    const segments = webSegments(pathname.slice('/web/'.length));
    if (!segments) return null;
    const webRoot = await realpath(WEB_ROOT);
    let real;
    try { real = await realpath(join(webRoot, ...segments)); } catch { return null; }
    return real.startsWith(webRoot + sep) ? real : null;
  }
  return null;
}

async function handle(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendError(res, 405, { Allow: 'GET, HEAD' });
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (url.pathname === '/') {
    res.writeHead(302, baseHeaders({ Location: '/fixture/index.html', 'Content-Length': 0 }));
    return res.end();
  }
  const target = await resolveTarget(url.pathname);
  if (!target) return sendError(res, 404);
  let info;
  try { info = await stat(target); } catch { return sendError(res, 404); }
  if (!info.isFile()) return sendError(res, 404);
  const body = await readFile(target);
  res.writeHead(200, baseHeaders({
    'Content-Type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': body.length,
  }));
  res.end(req.method === 'HEAD' ? undefined : body);
}

export function startServer() {
  const server = createServer((req, res) => {
    handle(req, res).catch(() => { if (!res.headersSent) sendError(res, 500); else res.end(); });
  });
  return new Promise((resolveStart, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      const url = `http://127.0.0.1:${port}/fixture/index.html`;
      const close = () => new Promise((done) => { server.closeAllConnections?.(); server.close(() => done()); });
      resolveStart({ url, close });
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { url, close } = await startServer();
  process.stdout.write(`${url}\n`);
  const stop = () => { close().then(() => process.exit(0)); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
