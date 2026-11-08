// Isolated local village-and-march server (protocol v3: economy, march and ring-129 land opening on one holding,
// one revision, one clock). Strict loopback Host/Origin, fixed subprocess, serial revisions.
// Only /api/state, /api/action, /api/reset, /api/open, /api/quote and exact browser dependencies are exposed.
// Initial state is captured from the first validated local host reply, not a chain provenance pin.
import { createServer } from 'node:http';
import { realpath, stat, readFile } from 'node:fs/promises';
import { dirname, join, resolve, sep, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  PROTOCOL, commandFromBody, commandFromQuoteBody, commandLine, parseReplyLine, validateState,
  checkTransition, checkQuote, replyObject, LocalModelError,
} from './local-model.mjs';
import { createChildBridge } from './host-bridge.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const WEB_ROOT = join(REPO_ROOT, 'permutation-server', 'web');

export const LOCAL_PREFIX = '/permutation-gateway/screens/wide-march-local/';
export const WEB_PREFIX = '/permutation-server/web/';
export const INDEX_PATH = `${LOCAL_PREFIX}index.html`;
/** Exact own browser files. README.md, the server, the bridge and the tests are never served. */
export const LOCAL_FILES = Object.freeze(['index.html', 'local.mjs', 'local-client.mjs', 'local-model.mjs', 'local.css', 'local-map.mjs', 'local-evidence.mjs']);
export const API = Object.freeze({ state: '/api/state', action: '/api/action', reset: '/api/reset', open: '/api/open', quote: '/api/quote' });
export const ACTION_HEADER = 'x-wylls-local-action';
export const MAX_BODY_BYTES = 512;
export const MAX_PENDING = 8;
const BODY_TIMEOUT_MS = 5000;

const WEB_FILES = new Set(['frontier/map/wide.mjs','frontier/fgeo.mjs','sdk/sha256.mjs','sdk/base58.mjs','sdk/bytes.mjs','frontier/fcodec.mjs','frontier/abi.mjs','sdk/frontier/abi-v2-layouts.mjs']);
const WEB_EXTENSIONS = new Set(['.html', '.mjs', '.js', '.css', '.json', '.svg', '.png', '.webp', '.jpg', '.jpeg', '.woff2', '.wasm', '.sha256']);
const MIME = {
  '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.sha256': 'text/plain; charset=utf-8', '.bin': 'application/octet-stream',
};
const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self' data:", "connect-src 'self'", "font-src 'self'",
  "worker-src 'none'", "frame-src 'none'", "frame-ancestors 'none'", "form-action 'none'", "base-uri 'none'", "object-src 'none'",
].join('; ');

const baseHeaders = (extra = {}) => ({
  'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin', 'Cross-Origin-Opener-Policy': 'same-origin', ...extra,
});

function sendJson(res, status, obj, extra = {}) {
  const body = `${JSON.stringify(obj)}\n`;
  res.writeHead(status, baseHeaders({ 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), ...extra }));
  res.end(body);
}
function sendError(res, status, extra = {}) {
  const body = `${status}\n`;
  res.writeHead(status, baseHeaders({ 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': Buffer.byteLength(body), ...extra }));
  res.end(body);
}

/** Request target judged on its RAW text: origin-form only, no query, fragment, escapes, backslashes, controls, empty or dot segments. */
export function cleanPath(target) {
  if (typeof target !== 'string' || !target.startsWith('/') || target.startsWith('//')) return null;
  if (target.includes('?') || target.includes('#')) return null;
  if (target.includes('%') || target.includes('\\') || /[\u0000-\u001f\u007f]/.test(target)) return null;
  for (const seg of target.slice(1).split('/')) if (seg === '' && target !== '/') return null; else if (seg.startsWith('.')) return null;
  return target;
}

async function confined(dir, file) {
  try {
    const [realDir, real] = await Promise.all([realpath(dir), realpath(file)]);
    return real.startsWith(realDir + sep) ? real : null;
  } catch { return null; }
}
function webTarget(rootDir, segments) {
  if (segments.some(s => s === '' || s === 'node_modules') || !WEB_EXTENSIONS.has(extname(segments[segments.length - 1]).toLowerCase())) return null;
  return confined(rootDir, join(rootDir, ...segments));
}
async function resolveTarget(path) {
  if (path.startsWith(LOCAL_PREFIX)) {
    const name = path.slice(LOCAL_PREFIX.length);
    return LOCAL_FILES.includes(name) ? confined(HERE, join(HERE, name)) : null;
  }
  if (path.startsWith(WEB_PREFIX) && WEB_FILES.has(path.slice(WEB_PREFIX.length))) return webTarget(WEB_ROOT, path.slice(WEB_PREFIX.length).split('/'));
  return null;
}

/** Exact Host always. Cross-site top-level document navigation may read static files only, never API routes. */
export function requestAllowed(headers, expectedHost, method = null, path = null) {
  if (typeof headers.host !== 'string' || headers.host !== expectedHost) return false;
  const site = headers['sec-fetch-site'];
  if (site === undefined || site === 'same-origin' || site === 'none') return true;
  return site === 'cross-site' && (method === 'GET' || method === 'HEAD')
    && path !== null && path !== '/api' && !path.startsWith('/api/')
    && headers['sec-fetch-mode'] === 'navigate' && headers['sec-fetch-dest'] === 'document';
}

/** Mutating POST gate: exact Origin (mandatory), Sec-Fetch-Site same-origin when present, fixed custom header, strict JSON type. */
export function mutationHeaderProblem(headers, expectedOrigin) {
  if (headers.origin !== expectedOrigin) return 403;
  if (headers['sec-fetch-site'] !== undefined && headers['sec-fetch-site'] !== 'same-origin') return 403;
  if (headers[ACTION_HEADER] !== PROTOCOL) return 403;
  const ct = headers['content-type'];
  if (ct !== 'application/json' && ct !== 'application/json; charset=utf-8') return 415;
  if (headers['transfer-encoding'] !== undefined || headers['content-encoding'] !== undefined) return 400;
  const cl = headers['content-length'];
  if (typeof cl !== 'string' || !/^(0|[1-9][0-9]{0,5})$/.test(cl)) return 411;
  if (Number(cl) > MAX_BODY_BYTES) return 413;
  return 0;
}

function readBody(req) {
  return new Promise((ok, fail) => {
    const chunks = []; let n = 0;
    const timer = setTimeout(() => { req.destroy(); fail(Object.assign(new Error('body timeout'), { status: 408 })); }, BODY_TIMEOUT_MS);
    req.on('data', c => {
      n += c.length;
      if (n > MAX_BODY_BYTES) { clearTimeout(timer); req.destroy(); fail(Object.assign(new Error('too large'), { status: 413 })); return; }
      chunks.push(c);
    });
    req.on('end', () => { clearTimeout(timer); ok(Buffer.concat(chunks)); });
    req.on('error', e => { clearTimeout(timer); fail(e); });
    req.on('aborted', () => { clearTimeout(timer); fail(Object.assign(new Error('aborted'), { status: 400 })); });
  });
}

/** Strict body: UTF-8, JSON, and byte-for-byte what JSON.stringify would write (no duplicate keys, no spacing, no `1.0`). */
export function parseCanonicalJson(buf) {
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(buf); } catch { throw new LocalModelError('BadBody', 'not UTF-8'); }
  let v;
  try { v = JSON.parse(text); } catch { throw new LocalModelError('BadBody', 'not JSON'); }
  if (JSON.stringify(v) !== text) throw new LocalModelError('BadBody', 'not canonical JSON');
  return v;
}

// ------------------------------------------------------------------ controller (all host talk, serialized)
const describe = cmd => cmd.kind;

/**
 * Owns the host bridge. One request at a time (promise chain, at most MAX_PENDING waiting); the revision check happens
 * INSIDE the turn, so a duplicate or stale request is judged against the state its predecessors left. Any bridge or
 * validation failure makes the controller UNCERTAIN for good: no retry, no restart, no more mutations.
 */
export function createController({ bridge, initial, maxPending = MAX_PENDING }) {
  let phase = 'starting', last = null, reason = null, lastResult = null, waiting = 0, tail = Promise.resolve();

  const checkAlive = () => { if (phase === 'ready' && bridge.alive === false) stop('bridge', bridge.deadReason ?? 'Exit', 'host'); };
  const view = () => { checkAlive(); return ({
    v: 1, protocol: PROTOCOL, mode: 'local-simulation', mockAuth: true, phase, uncertain: phase === 'uncertain', reason,
    // while uncertain nothing is shown as current: the last good state may no longer be the host's
    revision: phase === 'ready' ? last.revision : null, lastResult, reply: phase === 'ready' ? replyObject(last) : null,
  }); };
  const stop = (stage, code, label) => {
    phase = 'uncertain'; reason = { stage, code: String(code ?? 'Error') };
    lastResult = { command: label, outcome: 'uncertain', code: reason.code, revision: null };
    try { bridge.close(); } catch { /* ignore */ }
  };
  const enqueue = fn => {
    if (waiting >= maxPending) return Promise.resolve({ status: 429, body: { error: 'busy', view: view() } });
    waiting++;
    const run = tail.then(fn);
    tail = run.then(() => {}, () => {});
    return run.finally(() => { waiting--; });
  };

  async function exchange(cmd) {
    const raw = await bridge.exchange(commandLine(cmd));
    return parseReplyLine(raw);
  }

  return Object.freeze({
    view,
    get phase() { return phase; },
    /** Startup get: validated revision zero ready state becomes reset baseline. */
    start: () => enqueue(async () => {
      let next;
      try {
        next = await exchange({ kind: 'get' });
        validateState(next, initial);
        const e = next.economy;
        if (next.status !== 'ok' || next.revision !== 0 || next.command !== 'get' || next.phase !== 'ready'
          || e.usedThisInstant !== 0 || e.harvests !== 0 || e.farmBuilds !== 0 || e.trains !== 0
          || next.land.opened !== 0) throw new LocalModelError('BadStart', 'first state is not an ok revision 0');
        initial = JSON.parse(JSON.stringify(next));
      } catch (e) { stop('start', e.code, 'get'); return { status: 502, body: { error: 'uncertain', view: view() } }; }
      last = next; phase = 'ready';
      return { status: 200, body: { view: view() } };
    }),
    /** Explicit refresh: the cached view; never asks the host and never retries anything. */
    state: () => ({ status: 200, body: { view: view() } }),
    mutate: cmd => enqueue(async () => {
      checkAlive();
      const label = describe(cmd);
      if (phase !== 'ready') return { status: 503, body: { error: 'uncertain', view: view() } };
      if (cmd.rev !== last.revision) return { status: 409, body: { error: 'stale', view: view() } };
      let next, outcome;
      try {
        next = await exchange(cmd);
        validateState(next, initial);
        outcome = checkTransition(last, cmd, next, initial);
      } catch (e) {
        stop(e instanceof LocalModelError ? 'validate' : 'bridge', e.code, label);
        return { status: 502, body: { error: 'uncertain', view: view() } };
      }
      last = next;
      lastResult = { command: label, outcome, code: next.error, revision: next.revision };
      return { status: 200, body: { outcome, view: view() } };
    }),
    /** A non-mutating route quote: the host validates the chosen path; state, revision and the cached view are
     * left exactly as they were. A bad/garbled reply makes the controller uncertain for good, like any host talk. */
    quote: cmd => enqueue(async () => {
      checkAlive();
      if (phase !== 'ready') return { status: 503, body: { error: 'uncertain', view: view() } };
      let next, routeQuote;
      try {
        next = await exchange(cmd);
        validateState(next, initial);
        routeQuote = checkQuote(last, next);
      } catch (e) {
        stop(e instanceof LocalModelError ? 'validate' : 'bridge', e.code, 'quote_route');
        return { status: 502, body: { error: 'uncertain', view: view() } };
      }
      // `last` and the revision are unchanged: a quote is a read.
      return { status: 200, body: { routeQuote, view: view() } };
    }),
  });
}

// ------------------------------------------------------------------ http
async function handle(req, res, ctx) {
  const { expectedHost, expectedOrigin, controller } = ctx;
  const path = cleanPath(req.url);
  if (expectedHost === null || !requestAllowed(req.headers, expectedHost, req.method, path)) return sendError(res, 403);
  if (path === null) return sendError(res, 400);
  if (req.method === 'OPTIONS') return sendError(res, 405, { Allow: path === API.state ? 'GET' : path in { [API.action]: 1, [API.reset]: 1, [API.open]: 1, [API.quote]: 1 } ? 'POST' : 'GET, HEAD' });

  if (path === API.state) {
    if (req.method !== 'GET') return sendError(res, 405, { Allow: 'GET' });
    const r = controller.state();
    return sendJson(res, r.status, r.body);
  }
  if (path === API.action || path === API.reset || path === API.open || path === API.quote) {
    if (req.method !== 'POST') return sendError(res, 405, { Allow: 'POST' });
    const problem = mutationHeaderProblem(req.headers, expectedOrigin);
    if (problem) { req.resume(); return sendError(res, problem); }
    let cmd;
    try {
      const buf = await readBody(req);
      const body = parseCanonicalJson(buf);
      cmd = path === API.quote ? commandFromQuoteBody(body) : commandFromBody(path.slice('/api/'.length), body);
    } catch (e) {
      if (e?.status) return sendError(res, e.status);
      return sendJson(res, 400, { error: 'bad-request', code: e instanceof LocalModelError ? e.code : 'BadBody' });
    }
    const r = path === API.quote ? await controller.quote(cmd) : await controller.mutate(cmd);
    return sendJson(res, r.status, r.body);
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') return sendError(res, 405, { Allow: 'GET, HEAD' });
  if (path === '/') { res.writeHead(302, baseHeaders({ Location: INDEX_PATH, 'Content-Length': 0 })); return res.end(); }
  const target = await resolveTarget(path);
  if (!target) return sendError(res, 404);
  let info;
  try { info = await stat(target); } catch { return sendError(res, 404); }
  if (!info.isFile()) return sendError(res, 404);
  const body = await readFile(target);
  res.writeHead(200, baseHeaders({ 'Content-Type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream', 'Content-Length': body.length }));
  res.end(req.method === 'HEAD' ? undefined : body);
}

/**
 * Start the demo. `bridge` (an object with exchange(line)/close()) and `initial` are injectable for tests; by default the
 * fixed child host is spawned once. A host that cannot start or whose first
 * state is not a validated ready state aborts the start (no retry, nothing listening).
 */
export async function startLocalServer({ bridge = null, initial = null } = {}) {
  const init = initial;
  const host = bridge ?? await createChildBridge();
  const controller = createController({ bridge: host, initial: init });
  const started = await controller.start();
  if (started.status !== 200) { try { host.close(); } catch { /* ignore */ } throw new LocalModelError('HostStart', `the local host did not start cleanly (${controller.view().reason?.code})`); }
  const ctx = { expectedHost: null, expectedOrigin: null, controller };
  const server = createServer({ maxHeaderSize: 8192 }, (req, res) => {
    handle(req, res, ctx).catch(() => { if (!res.headersSent) sendError(res, 500); else res.end(); });
  });
  server.headersTimeout = 5000; server.requestTimeout = 15000; server.maxHeadersCount = 40;
  server.on('upgrade', (_req, socket) => socket.destroy());
  server.on('connect', (_req, socket) => socket.destroy());
  return new Promise((resolveStart, reject) => {
    server.once('error', e => { try { host.close(); } catch { /* ignore */ } reject(e); });
    server.listen(0, '127.0.0.1', () => {
      const { address, port } = server.address();
      ctx.expectedHost = `${address}:${port}`;
      ctx.expectedOrigin = `http://${address}:${port}`;
      const origin = ctx.expectedOrigin;
      const close = () => new Promise(done => { try { host.close(); } catch { /* ignore */ } server.closeAllConnections?.(); server.close(() => done()); });
      resolveStart({ origin, url: origin + INDEX_PATH, close, controller });
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { url, close } = await startLocalServer();
    process.stdout.write(`${url}\n`);
    const stop = () => { close().then(() => process.exit(0)); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  } catch (e) {
    process.stderr.write(`wide-march-local: ${e?.code ?? 'Error'}: ${e?.message ?? e}\n`);
    process.exit(1);
  }
}
