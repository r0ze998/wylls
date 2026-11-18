// LOCAL PLAY, TEST-ONLY — workstream 01's co-op board for each world of the local-play launcher (B13, loop-play2).
//
// ①'s board (workstreams/01-national-strategy/coop/board.mjs) is meant to stand on the game's own origin: the game
// probes `/coop/config` there (hud/coopboard.mjs) and ①'s page signs its records with a wallet of that origin. A
// local-play page is served by the LAUNCHER (its origin), and each world is reached through that world's proxy
// (createWorldProxy) on another port. So the launcher, when started with `--coop-board ws01-board-v1`, keeps one board
// per world IN ITS OWN PROCESS (①'s createBoard, its records in the world's own directory) and serves it on the
// launcher's origin under the world's mount:
//
//   /coop-world/<world proxy port>/coop/*            ①'s board (answerCoop: config, view, records, read-only rpc)
//   /coop-world/<world proxy port>/ws01/repo/<file>  ①'s page and the web modules it imports (staticFile)
//   /coop-world/<world proxy port>/h/<path>          GET only: that world's public herald reads, through its proxy
//
// The mount is the port of a proxy THIS launcher runs for a live world (a contest pair's two proxies both name the
// one board of their one world). Nothing else is served under it; ①'s page reaches no relay here (`/gw` is not
// passed on), so a caravan cannot be sent from the board's page in local play — requests and answers are records only.
// Same rules as the launcher's other routes: loopback peer and exact Host (checked by the launcher before this is
// asked), a write only from the launcher's own origin as JSON, no credentials passed on, no destination taken from a
// request. The page signs with its own memory-only key, handed to ①'s page window only for ①'s records
// (web/frontier/hud/coopboard-local.mjs); this file never sees a key.
import path from 'node:path';

export const COOP_BOARD_MODE = 'ws01-board-v1';
export const COOP_MOUNT_PREFIX = '/coop-world/';
/** The launcher-origin mount of the board of the world behind proxy `port`. */
export const coopMount = port => `${COOP_MOUNT_PREFIX}${port}`;
const BOARD_MODULE = '../../../workstreams/01-national-strategy/coop/board.mjs';
const CHAIN_MODULE = '../../../workstreams/01-national-strategy/coop/chain.mjs';

// ①'s page has its own <style> block and style attributes; scripts are its own modules only.
export const BOARD_PAGE_CSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
const SHIELD = Object.freeze({ 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY' });
const API_CSP = "default-src 'none'; frame-ancestors 'none'";

/**
 * One world's board: ①'s `createBoard` for the world's program and Season (the runner's own first line, `meta`),
 * reading the chain through the world's RPC and the herald through the world's proxy, its records in `<dir>/coop`.
 * → `{board, ports}`: `ports` the proxy ports whose mounts name it.
 */
export async function openWorldBoard({ dir, meta, heraldPort, pairPort = null, deps = {} }) {
  const { createBoard } = deps.createBoard ? deps : await import(BOARD_MODULE);
  const { rpcReader } = deps.rpcReader ? deps : await import(CHAIN_MODULE);
  if (typeof meta?.program !== 'string' || !Number.isSafeInteger(meta?.season_id) || typeof meta?.rpc_url !== 'string' || !/^http:\/\/127\.0\.0\.1:\d{4,5}$/.test(meta.rpc_url)) throw Object.assign(new Error('CoopBoardNotReady'), { code: 'CoopBoardNotReady', status: 503 });
  const board = createBoard({ herald: `http://127.0.0.1:${heraldPort}`, programId: meta.program, seasonId: String(meta.season_id), dataDir: path.join(dir, 'coop'),
    reader: rpcReader(meta.rpc_url), rpc: meta.rpc_url, cluster: 'localnet' });
  return Object.freeze({ board, ports: Object.freeze([heraldPort, ...(pairPort !== null ? [pairPort] : [])]) });
}

const reply = (res, status, body, type = 'application/json; charset=utf-8', csp = API_CSP) => {
  res.writeHead(status, { ...SHIELD, 'content-security-policy': csp, 'content-type': type, 'cache-control': 'no-store' });
  res.end(typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body));
};

/**
 * The request target as `{path, query}` when it is a plain origin-form path — the launcher's `worldTarget` rule (no
 * dot or empty segment, no escape) except that the last segment may be empty (①'s page is a directory: `…/coop/`).
 */
export function coopTarget(url) {
  if (typeof url !== 'string' || url.length > 2048) return null;
  const q = url.indexOf('?'), p = q < 0 ? url : url.slice(0, q), query = q < 0 ? '' : url.slice(q + 1);
  const segs = p.split('/').slice(1);
  if (!/^\/[A-Za-z0-9/_.~,-]*$/.test(p) || segs.some((s, i) => (s === '' && i !== segs.length - 1) || s === '.' || s === '..')) return null;
  return /^[\x21-\x7e]*$/.test(query) && !query.includes('#') ? { path: p, query } : null;
}

/** `/coop-world/<port>/<rest>` → `{port, rest}` (rest starts with '/'), or null. */
export function coopRouteOf(pathname) {
  const m = /^\/coop-world\/(\d{5})(\/.*)?$/.exec(pathname ?? '');
  return m ? { port: Number(m[1]), rest: m[2] ?? '/' } : null;
}

/**
 * Answer one request under a world's mount. `entry` = `openWorldBoard`'s answer for the world behind `port` (or null:
 * no such live world → 404, as an absent board is said to the page). `origin`: the launcher's own origin.
 * `deps.answerCoop` / `deps.staticFile` / `deps.fetch` for tests.
 */
export async function answerWorldBoard(req, res, { entry, port, rest, query = '', origin, deps = {} }) {
  if (!entry) return reply(res, 404, { error: 'NoCoopBoard' });
  const o = req.headers.origin;
  if (o !== undefined && o !== origin) return reply(res, 403, { error: 'OriginDenied' });
  const mount = coopMount(port);
  if (rest.startsWith('/coop/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'POST') return reply(res, 405, { error: 'MethodNotAllowed' });
    if (req.method === 'POST' && (o !== origin || req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json')) return reply(res, 403, { error: 'OriginDenied' });
    const { answerCoop, PAGE } = deps.answerCoop ? deps : await import(BOARD_MODULE);
    const url = new URL(`${rest}${query ? `?${query}` : ''}`, 'http://127.0.0.1');
    const a = await answerCoop(entry.board, req, url);
    if (!a) return reply(res, 404, { error: 'NotFound' });
    // (the board's page is named under THIS mount: the game opens it on the launcher's origin, beside its own page)
    const body = rest === '/coop/config' && a.status === 200 ? { ...a.body, page: `${mount}${PAGE}`, herald: null, mount } : a.body;
    return reply(res, a.status, body);
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return reply(res, 405, { error: 'MethodNotAllowed' });
  if (rest === '/ws01' || rest === '/ws01/') {
    const { PAGE } = deps.answerCoop ? deps : await import(BOARD_MODULE);
    res.writeHead(302, { ...SHIELD, 'content-security-policy': API_CSP, 'cache-control': 'no-store', location: `${mount}${PAGE}` }); return res.end();
  }
  if (rest.startsWith('/ws01/repo/')) {
    const { staticFile } = deps.staticFile ? deps : await import(BOARD_MODULE);
    const f = staticFile(rest.slice('/ws01/repo/'.length));
    return reply(res, f.status, f.body, f.type ?? 'application/json; charset=utf-8', f.status === 200 ? BOARD_PAGE_CSP : API_CSP);
  }
  if (rest.startsWith('/h/')) {
    // (the world's public herald, read through its own proxy: Host 127.0.0.1:<port>, no Origin, no credentials)
    let r;
    try { r = await (deps.fetch ?? globalThis.fetch)(`http://127.0.0.1:${port}${rest}${query ? `?${query}` : ''}`, { redirect: 'error', signal: AbortSignal.timeout(20000) }); } catch { return reply(res, 503, { error: 'WorldNotReady' }); }
    const bytes = new Uint8Array(await r.arrayBuffer());
    return reply(res, r.status, bytes, r.headers.get('content-type') ?? 'application/octet-stream');
  }
  return reply(res, 404, { error: 'NotFound' });
}
