// Manual QA of the ORIGINAL game page with recorded test data and a wallet that cannot sign.
//
// What this is: a read-only local file server. It serves permutation-server/web unchanged, answers the herald's
// `/h/*` reads from one stage of an existing golden record, and adds to the player page (as it is served, never on
// disk) one same-origin script: the keyless test wallet and key guard of screens/ws07/nokey-page.mjs, a clock held at
// the record's time, and a strip that says what the page is.
//
// What this is not: a herald, a relay, a keeper or a chain. Nothing is signed, sealed or sent. Every request that
// is not GET or HEAD is refused and counted. The server opens no outbound connection and listens on 127.0.0.1 only.
// It reads the web directory and the golden record given to it, nothing else: no wallet, seed, session or env secret.
//
// It registers no test and starts nothing when imported: `createQaServer` returns a server that is not yet listening.
// Run:  node permutation-gateway/screens/claude-manual-qa/server.mjs [--port 0] [--web DIR] [--golden FILE] [--stage grown] [--clock fixed|real]
import { createServer } from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as NK from '../ws07/nokey-page.mjs';

export const BIND = '127.0.0.1';
/** The policy of screens/codex-route-preview.screen.mjs, unchanged: same-origin scripts and styles only, no worker. */
export const CSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'none'; connect-src 'self'; img-src 'self' data:; style-src 'self'; frame-ancestors 'none'";
export const PLAYER_PAGE = '/frontier/index.html';
/** The page's own switch: on a loopback origin it would otherwise offer its dev wallet, which makes a key. */
export const DEV_WALLET_OFF = 'devWallet=off';
export const APP_TAG = '<script type="module" src="app.mjs"></script>';
export const QA_TAGS = '<link rel="stylesheet" href="/__qa/qa.css"><script type="module" src="/__qa/client.mjs"></script>';
export const LABEL = { ja: 'QA：保存済みの試験データ・送信無効・ライブではありません', en: 'QA: recorded test data. Sending is disabled. Not live.' };

const HERE = fileURLToPath(new URL('.', import.meta.url));
const DEFAULT_WEB = fileURLToPath(new URL('../../../permutation-server/web/', import.meta.url));
const DEFAULT_GOLDEN = fileURLToPath(new URL('../../../frontier-node/crates/herald/tests/golden/ws19-map-growth-s1.json', import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2' };
const SESSION_FUNCTIONS = [/export async function keyFromSeed/, /export async function publicKeyOf/];

/**
 * The server (not listening). `web`: the directory served as the site's root; `golden`: a herald golden record
 * `{wallet, stages: {[stage]: {[path]: {status, body}}}}`; `clock`: 'fixed' holds the page's Date at the record's
 * `latestUnix` (as the screen tests do), 'real' leaves it.
 * → `{server, listen(port) → base URL, close(), stats}`; `stats` counts what was asked and what was refused.
 */
export async function createQaServer({ web = DEFAULT_WEB, golden = DEFAULT_GOLDEN, stage = 'grown', clock = 'fixed' } = {}) {
  if (clock !== 'fixed' && clock !== 'real') throw new Error(`clock must be fixed or real: ${clock}`);
  const root = await realpath(resolve(web));
  const record = JSON.parse(readFileSync(resolve(golden), 'utf8'));
  const reads = record?.stages?.[stage];
  if (!reads || typeof reads !== 'object') throw new Error(`the golden record has no stage "${stage}"`);
  if (typeof record.wallet !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(record.wallet)) throw new Error('the golden record names no viewer address');
  const latestUnix = Number(reads['/h/season']?.body?.latestUnix);
  if (clock === 'fixed' && !Number.isFinite(latestUnix)) throw new Error('the stage has no /h/season latestUnix to hold the clock at');
  const fixedMs = clock === 'fixed' ? latestUnix * 1000 + 500 : null;
  const extra = readFileSync(resolve(HERE, 'client-extra.mjs'), 'utf8');
  const css = readFileSync(resolve(HERE, 'qa.css'), 'utf8');
  // The audited page function of ws07, called with the public viewer address: storage (language, intro seen, the
  // wallet's name), the WebCrypto and Worker guard, and a Wallet Standard wallet whose signers refuse.
  const client = `(${NK.init.toString()})(${JSON.stringify(NK.initArg({ wallet: record.wallet }, { lang: 'ja' }))});\n`
    + `const QA = ${JSON.stringify({ fixedMs, stage, label: LABEL, wallet: NK.TEST_WALLET })};\n${extra}`;
  const stats = { started: new Date().toISOString(), stage, clock, requests: 0, heraldReads: 0, refusedWrites: [], refusedHosts: 0, refusedPaths: 0 };

  const server = createServer(async (req, res) => {
    stats.requests++;
    const head = req.method === 'HEAD';
    const send = (status, headers, body = '') => { res.writeHead(status, { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers }); res.end(head ? undefined : body); };
    const json = (status, body) => send(status, { 'content-type': 'application/json' }, JSON.stringify(body));
    try {
      // A page of another origin that resolves its own name to 127.0.0.1 is not this site.
      const port = server.address()?.port;
      if (![`${BIND}:${port}`, `localhost:${port}`].includes(req.headers.host)) { stats.refusedHosts++; return json(421, { ok: false, code: 'QaWrongHost' }); }
      const url = new URL(req.url, `http://${BIND}:${port}`), path = url.pathname;
      if (req.method !== 'GET' && !head) {
        stats.refusedWrites.push(`${req.method} ${path}`);
        req.resume();
        return send(405, { 'content-type': 'application/json', allow: 'GET, HEAD' }, JSON.stringify({ ok: false, code: 'ReadOnlyFixture' }));
      }
      if (path === '/__qa/status') return json(200, { ok: true, readOnly: true, live: false, ...stats });
      if (path === '/__qa/client.mjs') return send(200, { 'content-type': TYPES['.mjs'] }, client);
      if (path === '/__qa/qa.css') return send(200, { 'content-type': TYPES['.css'] }, css);
      if (path.startsWith('/__qa/')) return json(404, { ok: false, code: 'NotFound' });
      if (path.startsWith('/h/')) {
        stats.heraldReads++;
        const a = reads[path];
        if (!a) return json(404, { ok: false, code: 'NotFound' });
        if (a.body?.b64 !== undefined) return send(a.status, { 'content-type': 'application/octet-stream' }, Buffer.from(a.body.b64, 'base64'));
        return json(a.status, a.body);
      }
      // The relay is absent. These three answers are the ones the screen tests give so the page settles; the quota
      // is a placeholder figure, not a relay's.
      if (path === '/gw/f/prize') return json(404, { ok: false, code: 'NoPrizePool' });
      if (path === '/gw/f/quota') return json(200, { ok: true, left: 38 });
      if (path === '/coop/config' || path === '/favicon.ico') return send(204, {});
      if (path.startsWith('/gw/')) return json(404, { ok: false, code: 'NotFound' });
      // The player page is always opened with the dev wallet off, whatever link led to it.
      if (path === '/' || path === '/frontier' || path === '/frontier/' || (path === PLAYER_PAGE && url.searchParams.get('devWallet') !== 'off')) {
        const q = new URLSearchParams(url.searchParams); q.set('devWallet', 'off');
        return send(302, { location: `${PLAYER_PAGE}?${q}` });
      }
      let decoded;
      try { decoded = decodeURIComponent(path); } catch { stats.refusedPaths++; return json(400, { ok: false, code: 'BadPath' }); }
      // (no dot files or directories, no worker: the page makes one only to seal an order, which is not done here)
      if (decoded.includes('\0') || decoded.split('/').some(part => part.startsWith('.')) || /seal-worker\.mjs$/.test(decoded)) { stats.refusedPaths++; return json(403, { ok: false, code: 'Forbidden' }); }
      const wanted = resolve(root, `.${decoded}`);
      if (!wanted.startsWith(root + sep)) { stats.refusedPaths++; return json(403, { ok: false, code: 'Forbidden' }); }
      let full;
      try { full = await realpath(wanted); } catch { return json(404, { ok: false, code: 'NotFound' }); }
      if (!full.startsWith(root + sep)) { stats.refusedPaths++; return json(403, { ok: false, code: 'Forbidden' }); }
      let body;
      try { body = await readFile(full); } catch { return json(404, { ok: false, code: 'NotFound' }); }
      const type = TYPES[extname(full)] ?? 'application/octet-stream';
      const headers = { 'content-type': type };
      if (extname(full) === '.html') headers['content-security-policy'] = CSP;
      if (path === PLAYER_PAGE) {
        const text = body.toString('utf8');
        // (exactly one place to stand before the app; a page that changed is refused rather than served unguarded)
        if (text.split(APP_TAG).length !== 2) return json(500, { ok: false, code: 'QaInjectionPointMissing' });
        body = text.replace(APP_TAG, QA_TAGS + APP_TAG);
      }
      if (/\/session\.mjs$/.test(path)) {
        const text = body.toString('utf8');
        if (!SESSION_FUNCTIONS.every(re => re.test(text))) return json(500, { ok: false, code: 'QaSessionGuardMismatch' });
        body = text + NK.SESSION_GUARD;
      }
      return send(200, headers, body);
    } catch {
      if (!res.headersSent) json(500, { ok: false, code: 'QaServerError' }); else res.end();
    }
  });
  return {
    server, stats, wallet: record.wallet, fixedMs,
    listen: (port = 0) => new Promise((done, fail) => { server.once('error', fail); server.listen(port, BIND, () => done(`http://${BIND}:${server.address().port}`)); }),
    close: () => new Promise(done => { server.closeAllConnections?.(); server.close(() => done()); }),
  };
}

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i], v = argv[i + 1];
    if (!['--port', '--web', '--golden', '--stage', '--clock'].includes(k) || v === undefined) throw new Error(`usage: server.mjs [--port N] [--web DIR] [--golden FILE] [--stage NAME] [--clock fixed|real] (got ${k ?? ''})`);
    out[k.slice(2)] = v;
  }
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const a = args(process.argv.slice(2));
  const port = a.port === undefined ? 0 : Number(a.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`--port ${a.port}`);
  const qa = await createQaServer({ web: a.web, golden: a.golden, stage: a.stage, clock: a.clock });
  const base = await qa.listen(port);
  console.log(`${LABEL.en}\n${LABEL.ja}\nplayer page: ${base}${PLAYER_PAGE}?${DEV_WALLET_OFF}\nstatus:      ${base}/__qa/status\nviewer (public test address, no key): ${qa.wallet}\nclock: ${qa.fixedMs === null ? 'real' : `held at ${new Date(qa.fixedMs).toISOString()}`}`);
}
