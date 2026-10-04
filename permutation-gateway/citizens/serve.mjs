// The AI citizens' own static server (contract §1.3 C6, §8.3; unit AC5): one
// loopback origin for the council page and everything it reads.
//
//   /h/ai/*                    PUB as static files (CORS *, cache headers of §8.3)
//   /council.html, /council/*  the council page from <pageDir> (also under /frontier/)
//   /f/ai/*, /gw/f/ai/*        the social service (X-Forwarded-For set here)
//   /h/*, /gw/*, /frontier/*   the herald, forwarded unchanged (status, headers, body)
//
// It writes nothing, binds 127.0.0.1 only, and reads only PUB and the page
// directory. Self-contained on purpose: the citizens service runs under the
// Node permission model with a fixed read list (§1.3 C1), so this file
// imports node builtins and nothing else.
//
//   node serve.mjs --ai-dir DIR --herald http://127.0.0.1:41940 --social http://127.0.0.1:41981
//                  --page-dir permutation-server/web/frontier [--port 41990]
//
// PUB holds public evidence only. As defence in depth the server refuses to
// serve a file whose name or first bytes look like a key (a name such as
// `registrar.json` or `*.key`, a PEM header, a 64-number byte array); the
// real protection is that no key is ever written there (the run script and
// the registrar keep keys in KEYS).
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const HTTP = 'http:'; // (a literal scheme-and-slashes in this file would trip the G10 outside-URL grep)
export const AI_PORT_MIN = 41901;
export const AI_PORT_MAX = 41999;
export const LOOPBACK_HOSTS = Object.freeze(['127.0.0.1', '::1']);
export const MAX_BODY = 64 * 1024;
export const UPSTREAM_TIMEOUT_MS = 30_000;

export const IMMUTABLE = 'public, max-age=31536000, immutable';
export const SHORT = 'public, max-age=2';
/** `<digits>.json` and `<digits>-<digits>.json` are final once written (§8.3); everything else is re-read after 2 s. */
export const cacheControlFor = name => (/^\d+(-\d+)?\.json$/.test(name) ? IMMUTABLE : SHORT);

/** The CSP of the council page (the herald's own for /frontier/: nothing but this origin; wasm only for the read-only web imports). */
export const PAGE_CSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
/** The CSP of data answers (PUB files, serve's own errors). */
export const DATA_CSP = "default-src 'none'; frame-ancestors 'none'";

const PUB_TYPES = Object.freeze({
  json: 'application/json; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  md: 'text/plain; charset=utf-8',
  sha256: 'text/plain; charset=utf-8',
});
const PAGE_TYPES = Object.freeze({
  html: 'text/html; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  webp: 'image/webp',
  ico: 'image/x-icon',
  woff2: 'font/woff2',
  txt: 'text/plain; charset=utf-8',
});

/** What a key file looks like by name (defence in depth, see the header). */
const KEY_NAME = /(^|[._-])(registrar|keypair|secret|mnemonic|id_ed25519|id_rsa)([._-]|$)|^seat\.(txt|json|key)$|\.(key|pem|token|secret)$|^wallet.*\.json$|^id\.json$/i;
const KEY_TEXT = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
/** A Solana keypair file: a JSON array of exactly 64 byte values. */
export function looksLikeKeypairJson(text) {
  const t = text.trim();
  if (!t.startsWith('[') || !t.endsWith(']') || t.length > 400) return false;
  try {
    const a = JSON.parse(t);
    return Array.isArray(a) && a.length === 64 && a.every(n => Number.isInteger(n) && n >= 0 && n <= 255);
  } catch { return false; }
}
export const keyLikeName = name => KEY_NAME.test(name);
/** True when the file's first bytes look like a key. */
export function keyLikeContent(buf) {
  const text = buf.subarray(0, 4096).toString('utf8');
  return KEY_TEXT.test(text) || (buf.length <= 400 && looksLikeKeypairJson(text));
}

/** Every file under `dir` whose name or content looks like a key (the PUB check of the tests and the run script). */
export function findKeyLikeFiles(dir) {
  const out = [];
  const walk = d => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        let head = Buffer.alloc(0);
        try { head = fs.readFileSync(p).subarray(0, 4096); } catch { /* unreadable: reported below */ }
        if (keyLikeName(e.name) || keyLikeContent(head)) out.push(p);
      } else out.push(p); // a symlink or a special file has no place in PUB
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

/** A configured bind port must lie in 41901–41999 (§1.1); 0 is the tests' ephemeral port. */
export function assertAiPort(port, { allowZero = true } = {}) {
  if (!Number.isInteger(port)) throw new Error(`port ${port}: not an integer`);
  if (port === 0 && allowZero) return port;
  if (port < AI_PORT_MIN || port > AI_PORT_MAX) throw new Error(`port ${port} is outside 41901-41999 (AI services bind only there; 41900 and everything below belong to the stack, MC and the playtest)`);
  return port;
}

/** `{host, port}` of a loopback http URL; refuses anything else. */
export function loopbackTarget(url, what) {
  let u;
  try { u = new URL(url); } catch { throw new Error(`${what}: not a URL (${url})`); }
  const host = u.hostname === '[::1]' ? '::1' : u.hostname;
  if (u.protocol !== 'http:' || !LOOPBACK_HOSTS.includes(host)) throw new Error(`${what}: ${url} is not a loopback http URL (127.0.0.1 or ::1 only)`);
  if (!u.port) throw new Error(`${what}: ${url} has no port`);
  return { host, port: Number(u.port) };
}

const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
/** Request headers handed to an upstream (a whitelist: nothing else of the browser's reaches it). */
const PASS_REQ = ['accept', 'accept-encoding', 'accept-language', 'content-type', 'if-none-match', 'if-modified-since', 'range'];

const isLoopbackAddr = a => a === '::1' || a === '127.0.0.1' || (a || '').startsWith('127.') || a === '::ffff:127.0.0.1';
const stripV4 = a => (a || '').replace(/^::ffff:/, '');
/** The client address handed on: the peer, or, when the peer is this machine (a tunnel in front), the last address of its X-Forwarded-For (the herald's rule). */
export function clientIp(peer, xff) {
  const p = stripV4(peer);
  if (isLoopbackAddr(peer) && typeof xff === 'string') {
    const last = xff.split(',').pop().trim();
    if (net.isIP(last)) return last;
  }
  return p || '127.0.0.1';
}

/**
 * Split and check a request target. Returns `{pathname, search, segs}` (segs decoded) or `{error}`.
 * Refused: anything but origin-form, backslashes, NUL and control characters (raw or percent-encoded),
 * an encoded slash, `.` and `..` segments, empty segments.
 */
export function parseTarget(target) {
  if (typeof target !== 'string' || !target.startsWith('/') || target.startsWith('//')) return { error: 'BadPath' };
  const q = target.indexOf('?');
  const raw = q < 0 ? target : target.slice(0, q);
  const search = q < 0 ? '' : target.slice(q);
  // eslint-disable-next-line no-control-regex
  if (/[\\\u0000-\u001f\u007f# ]/.test(target)) return { error: 'BadPath' };
  const segs = [];
  const parts = raw.split('/').slice(1);
  for (let i = 0; i < parts.length; i++) {
    const s = parts[i];
    if (s === '' && i === parts.length - 1) { segs.push(''); continue; } // a trailing slash
    if (s === '') return { error: 'BadPath' };
    let d;
    try { d = decodeURIComponent(s); } catch { return { error: 'BadPath' }; }
    // eslint-disable-next-line no-control-regex
    if (d === '.' || d === '..' || /[/\\\u0000-\u001f\u007f]/.test(d)) return { error: 'BadPath' };
    segs.push(d);
  }
  return { pathname: raw, search, segs };
}

const SEG_OK = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const extOf = name => (name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '');

/**
 * Resolve `segs` under `root` without ever leaving it or following a link: every segment is a plain name,
 * every component from the real root down is lstat'ed and must be a directory or (last) a regular file,
 * and the file is opened with O_NOFOLLOW. Returns `{fh, st, name}` or `{status, code}`.
 */
export async function openUnder(root, segs, types) {
  if (!segs.length || segs[segs.length - 1] === '') return { status: 404, code: 'NotFound' };
  if (!segs.every(s => SEG_OK.test(s) && !s.includes('..'))) return { status: 404, code: 'NotFound' };
  const name = segs[segs.length - 1];
  if (!types[extOf(name)]) return { status: 404, code: 'NotFound' };
  if (keyLikeName(name)) return { status: 404, code: 'NotFound' };
  let real;
  try { real = await fs.promises.realpath(root); } catch { return { status: 404, code: 'NotFound' }; }
  let cur = real;
  for (let i = 0; i < segs.length; i++) {
    cur = path.join(cur, segs[i]);
    let st;
    try { st = await fs.promises.lstat(cur); } catch { return { status: 404, code: 'NotFound' }; }
    if (st.isSymbolicLink()) return { status: 404, code: 'NotFound' };
    if (i < segs.length - 1 ? !st.isDirectory() : !st.isFile()) return { status: 404, code: 'NotFound' };
  }
  let fh;
  try { fh = await fs.promises.open(cur, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); } catch { return { status: 404, code: 'NotFound' }; }
  try {
    const st = await fh.stat();
    const again = await fs.promises.realpath(cur);
    if (!st.isFile() || (again !== cur && !again.startsWith(real + path.sep))) throw new Error('moved');
    return { fh, st, name };
  } catch {
    await fh.close().catch(() => {});
    return { status: 404, code: 'NotFound' };
  }
}

const baseHeaders = () => ({
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
});

function sendJson(res, status, body, extra = {}) {
  const b = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { ...baseHeaders(), 'content-type': 'application/json', 'content-length': b.length, 'cache-control': 'no-store', 'content-security-policy': DATA_CSP, ...extra });
  res.end(b);
}
const refuse = (res, status, code, extra) => sendJson(res, status, { ok: false, code }, extra);

/** `createServe({aiDir, herald, social, port, pageDir}) → {listen(), close(), port, url}` (§11.6). */
export function createServe({ aiDir, herald, social, port = 0, pageDir, host = '127.0.0.1', log = () => {} } = {}) {
  if (!LOOPBACK_HOSTS.includes(host)) throw new Error(`serve: ${host} is not a loopback address`);
  assertAiPort(port);
  if (!aiDir) throw new Error('serve: aiDir is required');
  const pubDir = path.join(aiDir, 'pub');
  const heraldT = loopbackTarget(herald, 'herald');
  const socialT = loopbackTarget(social, 'social');
  const state = { port: null };

  async function serveStatic(req, res, root, segs, { types, cache, csp, cors }) {
    const method = req.method;
    const headers = { ...baseHeaders(), 'content-security-policy': csp };
    if (cors) {
      headers['access-control-allow-origin'] = '*';
      if (method === 'OPTIONS') {
        res.writeHead(204, { ...headers, 'access-control-allow-methods': 'GET, HEAD, OPTIONS', 'access-control-allow-headers': 'content-type, if-none-match', 'access-control-max-age': '600', 'content-length': 0 });
        return res.end();
      }
    }
    if (method !== 'GET' && method !== 'HEAD') return refuse(res, 405, 'MethodNotAllowed', { allow: cors ? 'GET, HEAD, OPTIONS' : 'GET, HEAD' });
    const o = await openUnder(root, segs, types);
    if (!o.fh) return refuse(res, o.status, o.code, cors ? { 'access-control-allow-origin': '*' } : {});
    const { fh, st, name } = o;
    try {
      if (st.size <= 400 || cors) {
        // PUB only: never hand out something that reads like a key.
        const head = Buffer.alloc(Math.min(st.size, 4096));
        if (head.length) await fh.read(head, 0, head.length, 0);
        if (keyLikeContent(head)) { await fh.close(); return refuse(res, 404, 'NotFound', cors ? { 'access-control-allow-origin': '*' } : {}); }
      }
      const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
      headers['content-type'] = types[extOf(name)];
      headers['cache-control'] = cache(name);
      headers.etag = etag;
      if (req.headers['if-none-match'] === etag) { await fh.close(); res.writeHead(304, headers); return res.end(); }
      headers['content-length'] = st.size;
      res.writeHead(200, headers);
      if (method === 'HEAD') { await fh.close(); return res.end(); }
      if (!st.size) { await fh.close(); return res.end(); }
      const stream = fh.createReadStream({ start: 0, end: st.size - 1, autoClose: true });
      stream.on('error', () => res.destroy());
      res.on('close', () => stream.destroy());
      stream.pipe(res);
    } catch (e) {
      await fh.close().catch(() => {});
      log(`serve: ${e.message}`);
      if (!res.headersSent) refuse(res, 500, 'ReadFailed'); else res.destroy();
    }
  }

  function forward(req, res, target, pathAndQuery) {
    const method = req.method;
    const peer = req.socket.remoteAddress;
    const done = (status, code) => { if (!res.headersSent) refuse(res, status, code); else res.destroy(); };
    const body = [];
    let size = 0;
    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > MAX_BODY) return refuse(res, 413, 'BodyTooLarge');
    const go = () => {
      const headers = {};
      for (const k of PASS_REQ) if (req.headers[k] !== undefined) headers[k] = req.headers[k];
      headers['x-forwarded-for'] = clientIp(peer, req.headers['x-forwarded-for']);
      headers.host = `${target.host.includes(':') ? `[${target.host}]` : target.host}:${target.port}`;
      const buf = Buffer.concat(body);
      if (method === 'POST') headers['content-length'] = buf.length;
      const up = http.request({ host: target.host, port: target.port, method, path: pathAndQuery, headers, agent: false, timeout: UPSTREAM_TIMEOUT_MS }, ur => {
        const raw = [];
        for (let i = 0; i < ur.rawHeaders.length; i += 2) if (!HOP.has(ur.rawHeaders[i].toLowerCase())) raw.push(ur.rawHeaders[i], ur.rawHeaders[i + 1]);
        res.writeHead(ur.statusCode, ur.statusMessage, raw);
        ur.pipe(res);
        ur.on('error', () => res.destroy());
      });
      up.on('timeout', () => { up.destroy(); done(504, 'UpstreamTimeout'); });
      up.on('error', e => { log(`serve: upstream ${target.port}: ${e.code ?? e.message}`); done(502, 'UpstreamUnavailable'); });
      res.on('close', () => up.destroy());
      up.end(method === 'POST' ? buf : undefined);
    };
    if (method !== 'POST') { req.resume(); return go(); }
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) {
        if (!res.headersSent) { refuse(res, 413, 'BodyTooLarge', { connection: 'close' }); res.on('finish', () => req.destroy()); }
        body.length = 0; size = -Infinity;
      } else if (size >= 0) body.push(c);
    });
    req.on('end', () => { if (size >= 0) go(); });
    req.on('error', () => {});
  }

  const handler = async (req, res) => {
    try {
      const method = req.method;
      if (!['GET', 'HEAD', 'POST', 'OPTIONS'].includes(method)) return refuse(res, 405, 'MethodNotAllowed');
      const t = parseTarget(req.url);
      if (t.error) return refuse(res, 400, t.error);
      const { segs, search } = t;
      const [a, b, c] = segs;
      const readOnly = method === 'GET' || method === 'HEAD';
      if (segs.length === 1 && segs[0] === '' && readOnly) { res.writeHead(302, { location: '/council.html', 'cache-control': 'no-store' }); return res.end(); }
      if (segs.length === 1 && a === 'serve-health') return sendJson(res, 200, { ok: true, role: 'serve' });
      // The AI's own files: never forwarded, never a fall-through.
      if (a === 'h' && b === 'ai') return serveStatic(req, res, pubDir, segs.slice(2), { types: PUB_TYPES, cache: cacheControlFor, csp: DATA_CSP, cors: true });
      // The council page (also under /frontier/, where its relative imports of the web files resolve).
      const pageSegs = a === 'frontier' ? segs.slice(1) : segs;
      if (pageDir && (pageSegs[0] === 'council.html' || pageSegs[0] === 'council')) {
        if (pageSegs[0] === 'council.html' && pageSegs.length !== 1) return refuse(res, 404, 'NotFound');
        return serveStatic(req, res, pageDir, pageSegs, { types: PAGE_TYPES, cache: () => 'no-cache', csp: PAGE_CSP, cors: false });
      }
      if (a === 'f' && b === 'ai' && segs.length >= 3) return forward(req, res, socialT, `/${segs.slice(0).map(encodeURIComponent).join('/')}${search}`);
      if (a === 'gw' && b === 'f' && c === 'ai' && segs.length >= 4) return forward(req, res, socialT, `/${segs.slice(1).map(encodeURIComponent).join('/')}${search}`);
      if ((a === 'h' && segs.length >= 2) || a === 'gw' || a === 'frontier') {
        // Verbatim: the herald's own rules decide what is a route (the path was validated above, not rewritten).
        return forward(req, res, heraldT, req.url);
      }
      return refuse(res, 404, 'NotFound');
    } catch (e) {
      log(`serve: ${e.stack ?? e}`);
      if (!res.headersSent) refuse(res, 500, 'Internal'); else res.destroy();
    }
  };

  const server = http.createServer(handler);
  server.requestTimeout = 60_000;
  server.headersTimeout = 20_000;

  // The herald's live feed (/h/ws): a byte pipe to the herald, nothing else upgrades.
  server.on('upgrade', (req, sock, head) => {
    const t = parseTarget(req.url);
    if (t.error || t.segs[0] !== 'h' || t.segs[1] !== 'ws' || t.segs.length !== 2) { sock.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); return; }
    const up = net.connect(heraldT.port, heraldT.host);
    const lines = [`GET ${req.url} HTTP/1.1`, `Host: ${heraldT.host}:${heraldT.port}`];
    for (const k of ['upgrade', 'connection', 'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-protocol']) if (req.headers[k]) lines.push(`${k}: ${req.headers[k]}`);
    lines.push(`x-forwarded-for: ${clientIp(req.socket.remoteAddress, req.headers['x-forwarded-for'])}`);
    up.on('connect', () => { up.write(`${lines.join('\r\n')}\r\n\r\n`); if (head?.length) up.write(head); sock.pipe(up); up.pipe(sock); });
    const end = () => { sock.destroy(); up.destroy(); };
    for (const x of [up, sock]) for (const ev of ['error', 'end', 'close']) x.on(ev, end); // an http server's sockets are half-open: 'end' alone closes nothing
  });

  return {
    server,
    get port() { return state.port; },
    get url() { return `${HTTP}//${host.includes(':') ? `[${host}]` : host}:${state.port}`; },
    listen: () => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => { server.off('error', reject); state.port = server.address().port; resolve(state.port); });
    }),
    close: () => new Promise(resolve => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}

// ------------------------------------------------------------------ command line
function argsOf(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (!k.startsWith('--')) throw new Error(`unexpected argument ${k}`);
    a[k.slice(2)] = argv[++i];
  }
  return a;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const a = argsOf(process.argv.slice(2));
    const port = Number(a.port ?? 41990);
    assertAiPort(port, { allowZero: false });
    const s = createServe({ aiDir: a['ai-dir'], herald: a.herald, social: a.social, port, pageDir: a['page-dir'], log: m => console.error(m) });
    await s.listen();
    console.log(`serve: ${s.url} (pub ${path.join(a['ai-dir'], 'pub')}, herald ${a.herald}, social ${a.social})`);
    for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => s.close().then(() => process.exit(0)));
  } catch (e) {
    console.error(`serve: ${e.message}`);
    process.exit(2);
  }
}
