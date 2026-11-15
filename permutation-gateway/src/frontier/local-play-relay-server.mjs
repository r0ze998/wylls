// LOCAL-PLAY ONLY: the loopback HTTP listener of local-play-relay.mjs, meant
// to sit behind the herald's `/gw/*` (`frontier-herald … --relay 127.0.0.1:PORT`).
//
//   node permutation-gateway/src/frontier/local-play-relay-server.mjs --local-play \
//     --listen-port <41000-41999> --rpc http://127.0.0.1:<runner RPC> \
//     --program <[0x45;32] base58> --season <Season PDA> --wallet <player public key> \
//     --ruleset-hash <RULESET_HASH_V3 hex> --prepare-bin <abs path of frontier-experimental-expedition-depart-prepare> \
//     --cu-limit <n> --loaded-limit <n> [--preview-bin <abs path of frontier-original-expedition-preview>]
//
// Binds 127.0.0.1 only, answers loopback peers only, bodies ≤ 16 KiB of JSON.
// Holds no key. Prints one public line when listening.
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { createLocalPlayRelay, errorAnswer, LOCAL_PLAY_REFUSED_PORT, ROUTES } from './local-play-relay.mjs';
import { createLocalPlayReveal, REVEAL_ROUTES } from './local-play-reveal.mjs';
import { createLocalPlayPreview, ExpeditionPreviewError, LOCAL_PLAY_PREVIEW_ROUTE } from './local-play-preview.mjs';

export const MAX_BODY = 16 * 1024;

const json = (res, status, body) => {
  const b = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': b.length, 'cache-control': 'no-store' });
  res.end(b);
};

function readJson(req) {
  return new Promise((resolve, reject) => {
    // Past the limit nothing more is kept (bounded memory); the 413 is answered
    // when the request ends, so the client always receives it.
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if (size <= MAX_BODY) chunks.push(c); });
    req.on('end', () => {
      if (size > MAX_BODY) return reject(Object.assign(new Error('too large'), { status: 413, body: true }));
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(Object.assign(new Error('invalid JSON'), { status: 400, body: true })); }
    });
    req.on('error', reject);
  });
}

/**
 * Serve `relay` on 127.0.0.1:`port` (0 only for tests). Resolves `{server, port, close}`.
 * `reveal` (local-play-reveal.mjs, over the same pins): its three routes are served beside the Depart ones; without
 * it they are not there (404), as before. `preview` (local-play-preview.mjs): the boundary card's read-only
 * `POST /f/expedition/preview`, likewise only when given; a client that goes away cancels its one-shot read, and
 * closing the listener closes it.
 */
export function serveLocalPlayRelay(relay, port, { reveal = null, preview = null } = {}) {
  if (port !== 0 && (!(port >= 41_000 && port <= 41_999) || port === LOCAL_PLAY_REFUSED_PORT)) throw new Error('listen port must be 41000-41999 and not 41970');
  const handlers = {
    [ROUTES.info]: async () => relay.info(),
    [ROUTES.prepare]: async (body, signal) => relay.prepare(body, { signal }),
    [ROUTES.submit]: async body => relay.submit(body),
    [ROUTES.status]: async body => relay.status(body),
    ...(reveal ? {
      [REVEAL_ROUTES.context]: async body => reveal.context(body),
      [REVEAL_ROUTES.submit]: async body => reveal.submit(body),
      [REVEAL_ROUTES.status]: async body => reveal.status(body),
    } : {}),
    ...(preview ? { [LOCAL_PLAY_PREVIEW_ROUTE]: async (body, signal) => preview.inspect(body, { signal }) } : {}),
  };
  const server = http.createServer(async (req, res) => {
    const peer = req.socket.remoteAddress;
    if (peer !== '127.0.0.1' && peer !== '::ffff:127.0.0.1') return json(res, 403, { error: 'loopback only', code: 'LocalPlayLoopbackOnly' });
    const key = `${req.method} ${(req.url ?? '').split('?')[0]}`;
    const handle = handlers[key];
    if (!handle) return json(res, 404, { error: 'not found', code: 'NotFound' });
    try {
      const body = req.method === 'POST' ? await readJson(req) : undefined;
      // A client that goes away before the answer: the response closes
      // without having ended. (A request body completing is not a disconnect.)
      const ac = new AbortController(); res.on('close', () => { if (!res.writableEnded) ac.abort(); });
      json(res, 200, await handle(body, ac.signal));
    } catch (e) {
      // (the preview's own errors carry their own status and code, and nothing of the binary's path or output)
      if (e instanceof ExpeditionPreviewError) return json(res, e.status, { error: e.message, code: e.code });
      // (only the body reader's own two errors: a route's refusal with the same status keeps its own code)
      if (e?.body === true && (e.status === 413 || e.status === 400)) return json(res, e.status, { error: e.message, code: e.status === 413 ? 'BodyTooLarge' : 'InvalidJson' });
      const a = errorAnswer(e); json(res, a.status, a.body);
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port, close: () => new Promise(r => { relay.close(); preview?.close(); server.close(() => r()); }) }));
  });
}

const FLAGS = { '--rpc': 'rpc', '--program': 'program', '--season': 'season', '--wallet': 'wallet', '--ruleset-hash': 'rulesetHash',
  '--prepare-bin': 'prepareBin', '--cu-limit': 'cuLimit', '--loaded-limit': 'loadedLimit', '--listen-port': 'port' };
const OPTIONAL = { '--preview-bin': 'previewBin' };
/** The command line: `--local-play` and each flag exactly once; `--preview-bin` may be left out (then no preview route). */
export function parseArgs(argv) {
  const cfg = {}; let localPlay = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--local-play') { if (localPlay) throw new Error('--local-play twice'); localPlay = true; continue; }
    const k = FLAGS[argv[i]] ?? OPTIONAL[argv[i]];
    if (!k || i + 1 >= argv.length || Object.hasOwn(cfg, k)) throw new Error(`bad argument ${argv[i]}`);
    cfg[k] = argv[++i];
  }
  if (Object.values(FLAGS).some(k => !Object.hasOwn(cfg, k))) throw new Error('every flag is required: ' + Object.keys(FLAGS).join(' '));
  const port = Number(cfg.port); delete cfg.port;
  const previewBin = cfg.previewBin ?? null; delete cfg.previewBin;   // (apart from the relay's closed configuration)
  if (String(port) !== String(Number.parseInt(port, 10))) throw new Error('--listen-port');
  return { port, cfg: { localPlay, ...cfg }, previewBin };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const { port, cfg, previewBin } = parseArgs(process.argv.slice(2));
    const relay = createLocalPlayRelay({ cfg });
    // (the Reveal routes over the same pins: the same wallet, program, Season and loopback runner)
    const reveal = createLocalPlayReveal({ cfg });
    const preview = previewBin === null ? null : createLocalPlayPreview({ cfg, previewBin });
    const s = await serveLocalPlayRelay(relay, port, { reveal, preview });
    console.log(JSON.stringify({ schema: 'frontier-local-play-relay-v1', listen: `127.0.0.1:${s.port}`, ...relay.info() }));
    const stop = () => s.close().then(() => process.exit(0));
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
  } catch (e) {
    console.error('local-play relay: ' + e.message);
    process.exit(2);
  }
}
