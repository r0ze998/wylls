// The screenshot suite's fixture server (web design §13.2): node `http` on
// 127.0.0.1, port 0. It serves `permutation-server/web/` as the herald does
// (the Frontier pages under /frontier/ with the page CSP of web design §12),
// a fake herald from world.mjs under /h/*, and a fake relay under /gw/*
// that answers the reads the page makes (GET /f/relay, /f/quota) and
// refuses every write with 503 (the smoke never sends a transaction).
// Nothing touches a chain or a fixed port.
//
// `live(true)` (UX design 12.4, 14.5; liveworld.mjs) switches the same
// server to a sample world that keeps going under the M1 rules: its clock
// runs (a turn every 20 s by default, the whole game clock scaled with it)
// from the page's first /h/season, the fake relay takes every order a
// village owner has and refuses what the program refuses, and the fake
// herald shows what the turns resolve. With it off (the default) every
// answer is what it was before.
//
// `live(true, {claims: true})` also plays the LABELLED PROTOTYPE of the
// banner rule in that world: a design, not a rule of the program
// (claims.mjs, claimsworld.mjs). It adds POST /gw/f/proto/land, GET
// /h/proto/standings, GET /h/proto/preview and a `proto` field on the
// season, province and viewer records. Off by default; with it off none of
// these exists and every record is what it was before the prototype.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as W from './world.mjs';
import { createLive } from './liveworld.mjs';

export const WEB_ROOT = fileURLToPath(new URL('../../permutation-server/web/', import.meta.url));
export const CSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; frame-ancestors 'none'";
const TYPES = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.wasm': 'application/wasm', '.sha256': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2' };

/**
 * Start the server: `{url, port, stage(name), live(on, opts), advance(), pause(on), world(), requests, close()}`.
 * `stage` sets the viewer stage /h/me answers (none | joined | ticket | provisional | holding; world.mjs STAGES);
 * `requests` logs every path served, with its status.
 *
 * `live(on = true, {turn, delay, landMs, seed, neighbours, paused, stores, wall, claims})` starts a new sample world for the
 * stage (or, with false, goes back to the still one) and returns it: the clock starts at the page's next /h/season
 * and the first turn ends `delay` wall seconds later (default 8); a turn lasts `turn` wall seconds (default 20).
 * The viewer has a village to order in the stages `holding` (a town with hosts) and `provisional` (a hamlet just
 * founded); a change of stage starts the world anew. `claims` (true, or `{threat: 'auto' | 'pole' | 'border' | 'none'}`)
 * turns on the banner rule's prototype in that world (off by default; a village is needed). `advance()` steps to the next turn at once (a page already
 * open learns it at its next season poll), `pause(on)` stops and restarts the clock; `world()` is the live world
 * (its `orders`, `summary()`, `now()`, `turn()`), or null.
 */
export async function startServer({ port: listenPort = 0, bootstrap = false } = {}) {
  const v = await W.viewer();
  let stage = 'none';
  let live = null, liveOpts = {};
  const requests = [];
  const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); return code; };
  const readJson = req => new Promise(resolve => { const parts = []; req.on('data', c => parts.push(c)); req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(parts).toString() || '{}')); } catch { resolve(null); } }); req.on('error', () => resolve(null)); });

  async function herald(path, res) {
    let m;
    if (path === '/h/season') return json(res, 200, W.seasonRecord());
    if ((m = /^\/h\/overview\/(\d+)\/(?:latest|\d+)\.bin$/.exec(path))) {
      const d = Number(m[1]);
      if (d > 2) return json(res, 404, { code: 'NotFound' });
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(W.overview(d));
      return 200;
    }
    if ((m = /^\/h\/roster\/(\d+)\/latest\.bin$/.exec(path))) {
      const d = Number(m[1]);
      if (d > 2) return json(res, 404, { code: 'NotFound' });
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(W.roster(d));
      return 200;
    }
    if ((m = /^\/h\/province\/(-?\d+),(-?\d+)\/(latest|\d+)$/.exec(path))) return json(res, 200, W.provinceEnvelope(Number(m[1]), Number(m[2]), m[3] === 'latest' ? W.BELL : Number(m[3]), stage));
    if ((m = /^\/h\/bell\/(\d+)\/region\/(\d+)$/.exec(path))) return json(res, 200, W.bellRegion(Number(m[1]), Number(m[2])));
    if ((m = /^\/h\/me\/(\w+)$/.exec(path))) return m[1] === v.wallet ? json(res, 200, W.meRecord(v, stage)) : json(res, 200, W.meRecord({ ...v, wallet: m[1] }, 'none'));
    if (path === '/h/events') {
      const list = W.events();
      return json(res, 200, { events: list, next: list[list.length - 1].seq, full: false });
    }
    if ((m = /^\/h\/clash\/(-?\d+),(-?\d+)\/(\d+)$/.exec(path))) {
      if (Number(m[1]) === W.HOME.p && Number(m[2]) === W.HOME.q && Number(m[3]) === W.REPORT_BELL) return json(res, 200, W.clashReport());
      return json(res, 404, { code: 'NotFound' });
    }
    return json(res, 404, { code: 'NotFound' });
  }

  function relay(path, method, res) {
    const quota = { left: 38, resetsAt: W.GENESIS_TS + 86_400, lamportsLeft: '400000000' };
    if (method === 'GET' && path === '/gw/f/quota') return json(res, 200, { ok: true, ...quota });
    if (method === 'GET' && path === '/gw/f/relay') return json(res, 200, { ok: true, feePayer: v.A.season, blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 1000, programId: W.PROGRAM, quota });
    // a refusal in the body, not an HTTP error: the joined page files its first ticket by itself (owner decision V2)
    // and must show its retry, while the smoke counts HTTP errors as failures
    return json(res, 200, { ok: false, code: 'Unavailable', error: 'the screenshot fixture relay sends nothing' });
  }

  async function file(path, res) {
    if (path === '/' || path === '/frontier' || path === '/frontier/') path = '/frontier/index.html';
    const full = normalize(join(WEB_ROOT, decodeURIComponent(path)));
    if (!full.startsWith(WEB_ROOT) || full.includes(`${sep}..${sep}`)) return json(res, 403, { code: 'Forbidden' });
    let body;
    try { body = await readFile(full); } catch { return json(res, 404, { code: 'NotFound' }); }
    const type = TYPES[extname(full)] ?? 'application/octet-stream';
    const headers = { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
    if (type.startsWith('text/html')) Object.assign(headers, { 'Content-Security-Policy': CSP, 'Referrer-Policy': 'no-referrer' });
    res.writeHead(200, headers);
    res.end(body);
    return 200;
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const path = url.pathname;
    let code;
    try {
      if (bootstrap && path === '/start') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': CSP });
        res.end('<!doctype html><html lang="ja"><meta charset="utf-8"><title>Wylls</title><body><p>世界を開いています…</p><script type="module" src="/__setup.mjs"></script></body></html>'); code = 200;
      } else if (bootstrap && path === '/__setup.mjs') {
        const storage = W.storageFor(v, { stage: 'none', lang: 'ja' });
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(`const values=${JSON.stringify(storage)};for(const [k,v] of Object.entries(values))if(localStorage.getItem(k)===null)localStorage.setItem(k,v);location.replace('/frontier/index.html');`); code = 200;
      } else if (path === '/favicon.ico') { res.writeHead(204); res.end(); code = 204; }
      else if (path.startsWith('/h/')) {
        // the live world answers the files it keeps (the clock, the provinces of its rings, the viewer, the log,
        // its clashes); everything else is the still fixture's
        const r = live ? live.herald(path, url) : null;
        code = r ? json(res, r.status, r.body) : await herald(path, res);
      } else if (path.startsWith('/gw/')) {
        // the live relay answers what it plays; everything else gets the fixture's own answer
        const r = live ? await live.relay(req.method, path, req.method === 'POST' ? await readJson(req) : null) : null;
        code = r ? json(res, r.status, r.body) : relay(path, req.method, res);
      }
      else code = await file(path, res);
    } catch (e) {
      code = json(res, 500, { code: 'FixtureError', error: String(e?.message ?? e) });
    }
    requests.push({ method: req.method, path: url.pathname + url.search, code });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(listenPort, '127.0.0.1', resolve); });
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    viewer: v,
    stage: s => { const next = W.STAGES.includes(s) ? s : 'none'; if (live && next !== stage) live = createLive({ viewer: v, ...liveOpts, stage: next }); stage = next; },
    live: (on = true, opts = {}) => { liveOpts = opts; live = on ? createLive({ viewer: v, ...opts, stage }) : null; W.setLiveStorage(!!on); return live; },
    advance: opts => live?.advance(opts) ?? null,
    pause: (on = true) => live?.pause(on) ?? null,
    world: () => live,
    requests,
    close: () => new Promise(r => { server.closeAllConnections?.(); server.close(r); }),
  };
}
