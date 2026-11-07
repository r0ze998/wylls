// Read-only local fixture server for the wide-economy browser fixture.
// Node built-ins only (the allowlist constants come from model.mjs). GET/HEAD only; loopback, ephemeral port; never
// writes, proxies, relays or upgrades. Routes mirror repo paths so the model's relative imports resolve unchanged in
// the browser:
//   /permutation-gateway/screens/wide-economy-fixture/{index.html,fixture.mjs,fixture.css,model.mjs,manifest.mjs}
//   /permutation-gateway/screens/wide-economy-fixture/art/**   read-only alias of permutation-server/web/frontier/art/**
//   Every request must carry Host exactly 127.0.0.1:<listening port> and no cross-site Fetch Metadata (403 otherwise).
//   /permutation-server/web/**            public web assets only (extension allowlist, no dot segments)
//   /frontier-node/crates/verify/tests/fixtures/wide_economy/{case}/{file}   the 40 original binaries, exact allowlist
import { createServer } from 'node:http';
import { realpath, stat, readFile } from 'node:fs/promises';
import { dirname, join, resolve, sep, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CASE_NAMES, FILE_NAMES, FIXTURE_DIR } from './model.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const WEB_ROOT = join(REPO_ROOT, 'permutation-server', 'web');
const BIN_ROOT = join(REPO_ROOT, ...FIXTURE_DIR.split('/'));

export const FIXTURE_PREFIX = '/permutation-gateway/screens/wide-economy-fixture/';
export const WEB_PREFIX = '/permutation-server/web/';
/** Page-relative `art/...` of the production markup: a read-only alias of permutation-server/web/frontier/art/**. */
export const ART_PREFIX = '/permutation-gateway/screens/wide-economy-fixture/art/';
const ART_ROOT = join(WEB_ROOT, 'frontier', 'art');
export const INDEX_PATH =`${FIXTURE_PREFIX}index.html`;
/** Page files (exact names). manifest.mjs is the generated SHA-256 pin list; make-manifest.mjs is never served. */
export const FIXTURE_FILES = Object.freeze(['index.html', 'fixture.mjs', 'fixture.css', 'model.mjs', 'manifest.mjs']);
/** The exact 40 binary routes. */
export const BINARY_ROUTES = Object.freeze(new Set(CASE_NAMES.flatMap(c => FILE_NAMES.map(f => `/${FIXTURE_DIR}/${c}/${f}`))));

const WEB_EXTENSIONS = new Set(['.html', '.mjs', '.js', '.css', '.json', '.svg', '.png', '.webp', '.jpg', '.jpeg', '.woff2', '.wasm', '.sha256']);
const MIME = {
  '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.sha256': 'text/plain; charset=utf-8', '.bin': 'application/octet-stream',
};
const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self' data:",
  "connect-src 'self'", "font-src 'self'", "worker-src 'none'", "frame-src 'none'",
  "frame-ancestors 'none'", "form-action 'none'", "base-uri 'none'",
].join('; ');

function baseHeaders(extra = {}) {
  return {
    'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer', ...extra,
  };
}

function sendError(res, status, extra = {}) {
  const body = `${status}\n`;
  res.writeHead(status, baseHeaders({ 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': Buffer.byteLength(body), ...extra }));
  res.end(body);
}

/**
 * The path of a request target, judged on the RAW text (URL parsing would silently fold `..` and `%2e%2e`): origin-form
 * only, no percent escapes, backslashes, NULs, empty or dot segments. Returns the path or null.
 */
export function cleanPath(target) {
  if (typeof target !== 'string' || !target.startsWith('/') || target.startsWith('//')) return null;
  const path = target.split('?')[0].split('#')[0];
  if (path.includes('%') || path.includes('\\') || path.includes('\0') || /[\u0000-\u001f\u007f]/.test(path)) return null;
  const segments = path.slice(1).split('/');
  for (const seg of segments) if (seg === '' && path !== '/') return null; else if (seg.startsWith('.')) return null;
  return path;
}

// Realpath `file` and require it to stay under realpath(`dir`); null when missing or escaping via symlink.
async function confined(dir, file) {
  try {
    const [realDir, real] = await Promise.all([realpath(dir), realpath(file)]);
    return real.startsWith(realDir + sep) ? real : null;
  } catch { return null; }
}

// The same public web-asset rules for a path below WEB_ROOT: no empty segment, no node_modules, safe extension only.
function webTarget(rootDir, segments) {
  if (segments.some(s => s === '' || s === 'node_modules') || !WEB_EXTENSIONS.has(extname(segments[segments.length - 1]).toLowerCase())) return null;
  return confined(rootDir, join(rootDir, ...segments));
}

async function resolveTarget(path) {
  if (BINARY_ROUTES.has(path)) return confined(BIN_ROOT, join(REPO_ROOT, ...path.slice(1).split('/')));
  if (path.startsWith(ART_PREFIX)) {
    // the production markup says `art/...` relative to the fixture page: the SAME public files as frontier/art, nothing else
    return webTarget(ART_ROOT, path.slice(ART_PREFIX.length).split('/'));
  }
  if (path.startsWith(FIXTURE_PREFIX)) {
    const name = path.slice(FIXTURE_PREFIX.length);
    return FIXTURE_FILES.includes(name) ? confined(HERE, join(HERE, name)) : null;
  }
  if (path.startsWith(WEB_PREFIX)) {
    return webTarget(WEB_ROOT, path.slice(WEB_PREFIX.length).split('/'));
  }
  return null;
}

/**
 * Anti DNS-rebinding / cross-site gate, before any redirect or file response: Host must be exactly the address this
 * server listens on, and Fetch Metadata (when the browser sends it) must say same-origin or a user-typed navigation.
 */
export function requestAllowed(headers, expectedHost) {
  if (typeof headers.host !== 'string' || headers.host !== expectedHost) return false;
  const site = headers['sec-fetch-site'];
  return site === undefined || site === 'same-origin' || site === 'none';
}

async function handle(req, res, expectedHost) {
  if (!requestAllowed(req.headers, expectedHost)) return sendError(res, 403);
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendError(res, 405, { Allow: 'GET, HEAD' });
  const path = cleanPath(req.url);
  if (path === null) return sendError(res, 400);
  if (path === '/') {
    res.writeHead(302, baseHeaders({ Location: INDEX_PATH, 'Content-Length': 0 }));
    return res.end();
  }
  const target = await resolveTarget(path);
  if (!target) return sendError(res, 404);
  let info;
  try { info = await stat(target); } catch { return sendError(res, 404); }
  if (!info.isFile()) return sendError(res, 404);
  const body = await readFile(target);
  res.writeHead(200, baseHeaders({
    'Content-Type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream', 'Content-Length': body.length,
  }));
  res.end(req.method === 'HEAD' ? undefined : body);
}

export function startServer() {
  let expectedHost = null; // set from the real listening address; until then every request is refused
  const server = createServer((req, res) => {
    handle(req, res, expectedHost).catch(() => { if (!res.headersSent) sendError(res, 500); else res.end(); });
  });
  // no upgrades or CONNECT: refuse rather than hand the socket to anything
  server.on('upgrade', (_req, socket) => socket.destroy());
  server.on('connect', (_req, socket) => socket.destroy());
  return new Promise((resolveStart, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { address, port } = server.address();
      expectedHost = `${address}:${port}`; // address is the bound 127.0.0.1
      const origin = `http://127.0.0.1:${port}`;
      const close = () => new Promise((done) => { server.closeAllConnections?.(); server.close(() => done()); });
      resolveStart({ origin, url: origin + INDEX_PATH, close });
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
