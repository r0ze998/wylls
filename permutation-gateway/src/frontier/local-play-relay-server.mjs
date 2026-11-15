// LOCAL-PLAY ONLY: the loopback HTTP listener of local-play-relay.mjs, meant
// to sit behind the herald's `/gw/*` (`frontier-herald … --relay 127.0.0.1:PORT`).
//
//   node permutation-gateway/src/frontier/local-play-relay-server.mjs --local-play \
//     --listen-port <41000-41999> --rpc http://127.0.0.1:<runner RPC> \
//     --program <[0x45;32] base58> --season <Season PDA> --wallet <player public key> \
//     --ruleset-hash <RULESET_HASH_V3 hex> --prepare-bin <abs path of frontier-experimental-expedition-depart-prepare> \
//     --cu-limit <n> --loaded-limit <n>
//
// Binds 127.0.0.1 only, answers loopback peers only, bodies ≤ 16 KiB of JSON.
// Holds no key. Prints one public line when listening.
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { createLocalPlayRelay, errorAnswer, LOCAL_PLAY_REFUSED_PORT, ROUTES } from './local-play-relay.mjs';

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
      if (size > MAX_BODY) return reject(Object.assign(new Error('too large'), { status: 413 }));
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(Object.assign(new Error('invalid JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

/** Serve `relay` on 127.0.0.1:`port` (0 only for tests). Resolves `{server, port, close}`. */
export function serveLocalPlayRelay(relay, port) {
  if (port !== 0 && (!(port >= 41_000 && port <= 41_999) || port === LOCAL_PLAY_REFUSED_PORT)) throw new Error('listen port must be 41000-41999 and not 41970');
  const handlers = {
    [ROUTES.info]: async () => relay.info(),
    [ROUTES.prepare]: async (body, signal) => relay.prepare(body, { signal }),
    [ROUTES.submit]: async body => relay.submit(body),
    [ROUTES.status]: async body => relay.status(body),
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
      if (e?.status === 413 || e?.status === 400) return json(res, e.status, { error: e.message, code: e.status === 413 ? 'BodyTooLarge' : 'InvalidJson' });
      const a = errorAnswer(e); json(res, a.status, a.body);
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port, close: () => new Promise(r => { relay.close(); server.close(() => r()); }) }));
  });
}

const FLAGS = { '--rpc': 'rpc', '--program': 'program', '--season': 'season', '--wallet': 'wallet', '--ruleset-hash': 'rulesetHash',
  '--prepare-bin': 'prepareBin', '--cu-limit': 'cuLimit', '--loaded-limit': 'loadedLimit', '--listen-port': 'port' };
/** The command line: `--local-play` and each flag exactly once. */
export function parseArgs(argv) {
  const cfg = {}; let localPlay = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--local-play') { if (localPlay) throw new Error('--local-play twice'); localPlay = true; continue; }
    const k = FLAGS[argv[i]];
    if (!k || i + 1 >= argv.length || Object.hasOwn(cfg, k)) throw new Error(`bad argument ${argv[i]}`);
    cfg[k] = argv[++i];
  }
  if (Object.keys(cfg).length !== Object.keys(FLAGS).length) throw new Error('every flag is required: ' + Object.keys(FLAGS).join(' '));
  const port = Number(cfg.port); delete cfg.port;
  if (String(port) !== String(Number.parseInt(port, 10))) throw new Error('--listen-port');
  return { port, cfg: { localPlay, ...cfg } };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const { port, cfg } = parseArgs(process.argv.slice(2));
    const relay = createLocalPlayRelay({ cfg });
    const s = await serveLocalPlayRelay(relay, port);
    console.log(JSON.stringify({ schema: 'frontier-local-play-relay-v1', listen: `127.0.0.1:${s.port}`, ...relay.info() }));
    const stop = () => s.close().then(() => process.exit(0));
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
  } catch (e) {
    console.error('local-play relay: ' + e.message);
    process.exit(2);
  }
}
